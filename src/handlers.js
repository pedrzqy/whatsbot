'use strict';

/**
 * Aqui mora a LÓGICA DO BOT — é onde suas funções vão ser encaixadas.
 *
 * - onIncomingMessage:  chamado a cada mensagem recebida no WhatsApp.
 * - onNerixEvent:       chamado a cada webhook da Nerix (pedido pago, etc).
 *
 * Por enquanto são só esboços. Conforme você me mandar as funções
 * (ex: "mostrar catálogo", "criar pedido pelo chat", "entregar chave"),
 * a implementação entra aqui.
 */

const config = require('./config');
const store = require('./store');
const welcome = require('./welcome');
const ai = require('./ai');
const sender = require('./sender');
const variator = require('./variator');
const operador = require('./ponte/operador');
const vendas = require('./vendas');
const recepcao = require('./ponte/recepcao');
const ponte = require('./ponte');
const menu = require('./menu');
const tools = require('./tools');
const expediente = require('./expediente');
// O mesmo registro da ponte: o arquivo e "o que o bot fez", e quem for
// analisar quer os dois lados juntos -- quanto o atendimento resolveu e
// quanto a ponte resolveu. Dois arquivos seriam duas analises pela metade.
const registro = require('./ponte/registro');

// E-mail e código de pedido dentro de uma frase solta.
//
// O cliente escreve "meu pedido é 01a00ba2-... e o email é fulano@x.com", tudo
// numa linha. Antes quem separava isso era a IA; agora é regex, que responde
// na hora e não inventa argumento.
const RE_EMAIL = /[\w.+-]+@[\w-]+\.[\w.-]+/;
// UUID é o formato que a Nerix usa no order_number (confirmado em pedido real).
// O segundo padrão cobre código curto, caso a loja passe a emitir um.
const RE_UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const RE_CODIGO_CURTO = /\b[A-Z0-9]{6,20}\b/;

/**
 * Acha código do pedido + e-mail numa mensagem livre.
 * Só devolve quando tem os DOIS — sem e-mail a consulta não sai (é ele que
 * prova que o pedido é do cliente).
 */
function extrairPedido(texto) {
  const t = String(texto || '');
  const email = (t.match(RE_EMAIL) || [])[0];
  if (!email) return null;

  // Tira o e-mail antes de procurar o código: senão o trecho antes do @ pode
  // casar com o padrão de código curto.
  const semEmail = t.replace(RE_EMAIL, ' ');
  const codigo = (semEmail.match(RE_UUID) || semEmail.match(RE_CODIGO_CURTO) || [])[0];
  if (!codigo) return null;

  return { codigo, email };
}

/**
 * Manda o menu de um nó, nas DUAS formas de uma vez.
 *
 * O corpo é o menu numerado de sempre; a lista nativa vai em `opts.list`. Quem
 * decide é o sender: se a lista falhar — e ela passa pelo Baileys, que muda o
 * formato sem aviso — o texto sai e o cliente nem percebe que existiam duas.
 * Quebrar o menu quebra a porta de entrada inteira, e nenhum ganho de toque
 * paga isso.
 *
 * `antes` é a frase que abre o menu ("não achei essa opção"). Vai nas duas,
 * senão quem recebe a lista perde o contexto que quem recebe o texto tem.
 */
async function enviarMenu(from, nodeId, antes = '') {
  const corpo = menu.render(nodeId);
  const texto = antes ? `${antes}\n\n${corpo}` : corpo;
  await sender.send(from, texto, { list: menu.lista(nodeId, antes) });
}

/**
 * Cliente pediu um jogo pelo nome.
 *
 * Procura na loja ANTES de encaminhar. Se o jogo já está no catálogo, mandar o
 * pedido para o operador seria perder uma venda que estava pronta: o cliente
 * esperaria uma resposta manual por algo que ele podia comprar naquele
 * segundo. Só o que a loja não tem vira solicitação.
 *
 * A busca é a API da Nerix, não IA — resposta na hora e sem inventar título.
 */
async function pedirJogo(from, nomeJogo, pushName) {
  let achados = [];
  try {
    const r = await tools.execute('buscar_produtos', { termo: nomeJogo }, { from });
    achados = r.produtos || [];
  } catch (err) {
    // Busca fora do ar não pode travar o pedido: segue como se não houvesse na
    // loja, que é o caminho que termina com um humano olhando.
    console.warn('[pedirjogo] busca falhou, encaminhando mesmo assim:', err.message);
  }

  if (achados.length) {
    const linhas = ['🎉 Achei na nossa loja:', ''];
    for (const p of achados.slice(0, 3)) {
      linhas.push(`• *${p.nome}*${p.por ? ` — ${p.por}` : ''}`);
      if (p.link) linhas.push(`  ${p.link}`);
    }
    linhas.push('', '_Não era esse? Digite *#menu* e peça de novo com o nome completo._');
    await sender.send(from, linhas.join('\n'));
    console.log(`[pedirjogo] ${from} pediu "${nomeJogo}" — achou ${achados.length} na loja`);
    return;
  }

  // Não tem na loja: vira solicitação para o operador.
  //
  // Mesmo formato do alerta de resposta sem código: duas linhas, quem é em
  // cima e o que ele quer embaixo. O operador lê isso no celular, no meio de
  // outra coisa — cabeçalho e rótulo ("Pedido de jogo", "Telefone:", "Quer:")
  // eram moldura ocupando a tela sem dizer nada que as duas linhas não digam.
  //
  // O telefone vai junto porque é por ele que o operador responde — sem isso
  // ele teria a pergunta e nenhum jeito de achar quem perguntou.
  const nome = store.getContact(from)?.name || pushName || 'cliente';
  await ponte.alertar(
    `Cliente: *${nome}* · ${from.replace(/@.*/, '')}\n🎯 Quer *${nomeJogo}* — não temos no site.`,
  );
  console.log(`[pedirjogo] ${from} pediu "${nomeJogo}" — NÃO achou, avisei o operador`);

  await sender.send(
    from,
    `Anotei seu pedido de *${nomeJogo}* ✅\n\n` +
      `Vou verificar a disponibilidade e te retorno aqui mesmo 👍\n\n` +
      `_Digite *#menu* para ver as outras opções._`,
  );
}

/**
 * O que cada opção de AÇÃO do menu faz. Retorna true se já respondeu.
 *
 * Tudo aqui é texto pronto — a única ação que acorda a IA é 'ia', e ela só
 * marca o contato e devolve o convite para escrever. Assim o custo de LLM
 * aparece uma vez, no ramo onde a conversa é realmente livre, em vez de em
 * toda pergunta de prazo e garantia.
 */
async function acaoDoMenu(acao, { from, pushName }) {
  if (acao === 'ia') {
    // Com a IA DESLIGADA (o padrão), quem atende é gente.
    //
    // Antes esta opção marcava modoIA e convidava o cliente a escrever — mas
    // sem IA não havia ninguém para ler, e a mensagem seguinte caía no
    // fallback. O cliente contava o problema e recebia o menu de volta.
    if (!config.iaLigada) {
      store.saveContact(from, { aguardandoProblema: true, menuNode: null, modoIA: false });
      await sender.send(
        from,
        'Sem problema, vou te ajudar 👍\n\n' +
          'Me conta *o que aconteceu* — se puder, manda o *código do pedido* e o ' +
          '*e-mail* da compra junto.',
      );
      return true;
    }

    // Conversa livre com a IA, que tem as ferramentas (consultar pedido,
    // buscar produto, chamar atendente).
    store.saveContact(from, { modoIA: true, menuNode: null });
    await sender.send(
      from,
      'Sem problema, vou te ajudar 👍\n\n' +
        'Me conta *o que aconteceu* com sua compra. Se puder, manda também o ' +
        '*código do pedido* e o *e-mail* que você usou — assim eu já consulto aqui.',
    );
    return true;
  }

  if (acao === 'pedido') {
    // NÃO marca modoIA: quem lê a resposta é a regex de extrairPedido(), que
    // roda antes do fallback e independe disso. Marcar aqui era o que prendia
    // o cliente no laço do menu quando ele mandava outra coisa.
    store.saveContact(from, { menuNode: 'main', modoIA: false });

    // Tenta pelo TELEFONE antes de pedir qualquer coisa.
    //
    // O cliente está falando pelo número que cadastrou no checkout — o dado
    // que a consulta precisa já está na mão. Exigir um UUID e o e-mail antes
    // de olhar era pedir ao cliente que provasse o que a conversa já provava,
    // e é onde a maioria desistia e chamava atendente.
    //
    // O caminho por código + e-mail continua logo abaixo, para quem comprou de
    // outro número ou digitou o telefone errado no checkout.
    try {
      const meus = await vendas.pedidosDoTelefone(from);
      if (meus.length) {
        const r = tools.formatOrder(meus[0]);
        await sender.send(from, respostaDePedido(r, { codigo: r.codigo }));
        if (meus.length > 1) {
          await sender.send(
            from,
            `_Você tem ${meus.length} pedidos neste número. Esse é o mais recente — ` +
              `para ver outro, manda o *código* e o *e-mail* da compra._`,
          );
        }
        console.log(`[pedido] ${from} consultado pelo telefone — ${meus.length} pedido(s)`);
        return true;
      }
    } catch (err) {
      // Busca fora do ar cai no caminho manual, que sempre funcionou.
      console.warn('[pedido] busca por telefone falhou:', err.message);
    }

    // Pede os dois dados de uma vez: sem os dois a consulta nem sai, então
    // perguntar separado seria ida e volta à toa.
    await sender.send(
      from,
      '📦 Não achei pedido feito com este número.\n\n' +
        'Para consultar eu preciso de *2 coisas*:\n\n' +
        '1️⃣ O *código do pedido*\n' +
        '2️⃣ O *e-mail* usado na compra\n\n' +
        'Pode mandar os dois na mesma mensagem 👍',
    );
    return true;
  }

  if (acao === 'pedirjogo') {
    // Marca que a PRÓXIMA mensagem é o nome do jogo. Sem isso, o cliente
    // responderia o título e cairia no fallback do menu, que devolveria as
    // opções de novo — e ele repetiria achando que o bot não leu.
    store.saveContact(from, { aguardandoJogo: true, menuNode: null });
    await sender.send(
      from,
      '🎯 Me diz o *nome do jogo* que você procura.\n\n' +
        'Manda só o título, tipo: *Hollow Knight Silksong*.',
    );
    return true;
  }

  if (acao === 'codigo') {
    // Não chama a ponte aqui: quem detecta o pedido de código é a recepcao.js,
    // sem IA, e ela já conduz o passo a passo (foto → usuário). Aqui só se
    // manda o cliente começar esse fluxo do jeito que a recepção reconhece.
    store.saveContact(from, { menuNode: null });
    await sender.send(
      from,
      '🔑 Beleza! Me manda a mensagem *preciso do código* que eu já começo o ' +
        'passo a passo com você.',
    );
    return true;
  }

  if (acao === 'atendente') {
    store.saveContact(from, { paused: true, menuNode: null, modoIA: false });
    console.log(`[handoff] ${from} -> atendente (pelo menu)`);

    // Este caminho está no ar HOJE e era mudo: gravava `paused` e mandava
    // "já estou chamando um atendente" sem chamar atendente nenhum. O cliente
    // lia a promessa e ficava esperando alguém que não foi avisado.
    await ponte.alertarHandoff({
      nome: store.getContact(from)?.name || pushName || 'cliente',
      from,
      motivo: 'escolheu falar com atendente no menu',
    });

    await sender.send(
      from,
      // A promessa vem do expediente, e não está escrita aqui: as três portas
      // de handoff escreviam cada uma a sua, e foi assim que passaram a
      // prometer coisas diferentes para a mesma situação — todas as três
      // dizendo "em instantes" também às 3h da manhã, quando não há ninguém.
      `Certo! ${expediente.promessaDeAtendimento()}\n\n` +
        '_Se quiser voltar ao atendimento automático, digite *#inicio*._',
    );
    return true;
  }

  return false;
}

// Palavras que reativam o autoatendimento quando o cliente está com um humano.
// Com e SEM "#": o cliente digita "#menu" tanto quanto "menu", e a versão com
// cerquilha caía fora da lista — ia parar na conversa livre e voltava um menu
// inventado, diferente a cada vez. Quem lê "digite #inicio" no rodapé tende a
// digitar #menu também.
const RESUME = new Set([
  '#inicio', '#início', 'inicio', 'início',
  '#menu', 'menu', '#voltar', 'voltar',
  'atendimento', 'recomecar', 'recomeçar', '#recomecar',
  'opcoes', 'opções', '#opcoes', '#opções',
]);

// Serializa o processamento das mensagens de um MESMO contato, para não
// re-saudar nem trocar a ordem quando várias mensagens chegam em sequência.
const contactLocks = new Map();

/**
 * @param {object} msg  Mensagem normalizada { from, text, pushName, raw }
 */
function onIncomingMessage(msg) {
  const from = msg && msg.from;
  if (!from) return Promise.resolve();
  const prev = contactLocks.get(from) || Promise.resolve();
  const next = prev
    .then(() => handleMessage(msg))
    .catch((err) => console.error('[handler] erro:', err.message));
  contactLocks.set(
    from,
    next.finally(() => { if (contactLocks.get(from) === next) contactLocks.delete(from); })
  );
  return next;
}

async function handleMessage(msg) {
  const { from, text, pushName, imagem, imagemBase64, veioDeAudio } = msg;
  const trimmed = (text || '').trim();
  const lower = trimmed.toLowerCase();
  // O log diz de ONDE veio o texto. Transcricao erra, e quando algo sai
  // estranho a primeira pergunta e sempre "o cliente disse isso mesmo?" -- sem
  // esta marca nao ha como saber que a frase veio de um audio.
  console.log(
    `[msg] de ${from} (${pushName || '?'}): ${trimmed}` +
      `${imagem || imagemBase64 ? ' [+foto]' : ''}${veioDeAudio ? ' [audio]' : ''}`,
  );

  // ─── 0) Comandos do operador da ponte (só do número configurado) ───
  // Vem antes de tudo: quando a Taobao pede verificação, o operador precisa
  // destravar em segundos, e não pode esbarrar em boas-vindas ou pausa.
  if (operador.ehComando(from, trimmed)) {
    try {
      // Resposta VAZIA significa "já respondi por outro caminho" — é o caso do
      // comando que manda um arquivo como anexo. Enviar a string vazia aqui
      // colocaria uma mensagem em branco no chat logo abaixo do anexo.
      const resposta = await operador.executar(trimmed, from);
      if (resposta) await sender.send(from, resposta, { typing: false });
    } catch (err) {
      console.error('[ponte/operador] erro:', err.message);
      await sender.send(from, `Falhou: ${err.message}`, { typing: false });
    }
    return;
  }

  // ─── 0.1) Pedido de código ao fornecedor (ponte) ───
  //
  // Vem ANTES do check de autoReply de propósito. Com BOT_AUTOREPLY=false o
  // fluxo abaixo retorna sem chamar a IA, e a ferramenta pedir_codigo_fornecedor
  // nunca seria invocada — a ponte ficaria inerte, sem erro e sem log.
  //
  // O gatilho é estreito (foto + algo com cara de usuário de conta), então
  // conversa normal de vendas não cai aqui. ATENÇÃO: neste caminho o bot
  // RESPONDE ao cliente mesmo com autoreply desligado — é o único jeito de
  // pedir a metade que falta e de entregar o código depois.
  // Em atendimento humano, a ponte NÃO toma a conversa de volta.
  //
  // Este bloco roda antes do check de `paused` lá embaixo — de propósito, para
  // furar o autoreply desligado. Só que ele furava a PAUSA também: o cliente
  // estava falando com o operador, escrevia "preciso do código", e o bot
  // atravessava a conversa pedindo foto e usuário.
  //
  // Quem decide é o humano que já está lá: o pedido vira alerta com o número
  // do cliente, e o operador toca do jeito que fizer sentido.
  // `#inicio` e as outras palavras de recomeço passam direto: é a ÚNICA saída
  // que o cliente tem da pausa, e está escrita no aviso que ele recebe.
  // Interceptar aqui prenderia ele em silêncio para sempre.
  const pausadoAgora = store.getContact(from)?.paused && !RESUME.has(lower);
  if (pausadoAgora && ponte.ativa()) {
    const r = recepcao.avaliar(from, trimmed, imagem);
    if (r.acao === 'responder' || r.acao === 'pedir') {
      const nome = store.getContact(from)?.name || pushName || 'cliente';
      await ponte.alertar(
        `Cliente: *${nome}* · ${from.replace(/@.*/, '')}\n🔑 Pediu código, mas você está no chat com ele.`,
      );
      console.log(`[ponte] ${from} pediu código durante atendimento humano — só avisei`);
    }
    store.saveContact(from, { lastSeen: Date.now(), name: pushName || store.getContact(from)?.name });
    return;
  }

  if (ponte.ativa()) {
    const r = recepcao.avaliar(from, trimmed, imagem);

    if (r.acao === 'responder') {
      store.saveContact(from, { lastSeen: Date.now(), name: pushName || store.getContact(from)?.name });
      await sender.send(from, r.mensagem);
      return;
    }

    if (r.acao === 'pedir') {
      store.saveContact(from, { lastSeen: Date.now(), name: pushName || store.getContact(from)?.name });
      const nome = store.getContact(from)?.name || pushName || from;
      const res = await ponte.pedirCodigo(from, nome, r.usuario, r.imagem);
      await sender.send(from, res.mensagem);
      return;
    }
  }

  // Auto-resposta DESLIGADA (BOT_AUTOREPLY=false): o bot não RESPONDE no 1-a-1
  // (um humano atende). Mas marca o contato como engajado, pra a RECUPERAÇÃO DE
  // VENDA ainda cutucar quem mandou mensagem e sumiu. Não envia nada agora.
  //
  // EXCEÇÃO: o operador com #teste ligado.
  //
  // O #teste diz "agora suas mensagens normais entram como se fossem de um
  // cliente" — e com o autoreply desligado isso era falso: o retorno acontecia
  // aqui, antes até do #inicio, então nem "ola" nem "#inicio" recebiam
  // resposta. Só os #comandos da ponte respondiam, porque eles são tratados
  // acima. O sintoma (bot mudo logo depois de confirmar o modo teste) aponta
  // para todos os lugares errados.
  //
  // A alternativa seria ligar BOT_AUTOREPLY para testar — o que faria o bot
  // responder a loja INTEIRA só para o operador conferir um fluxo. Este furo
  // vale exatamente para um número, o dele, e por 30 minutos.
  // O #bot do operador VENCE a variável de ambiente: ele muda na hora, sem
  // deploy, e é o que serve quando o bot começa a responder errado com cliente
  // na linha. A env fica valendo enquanto ninguém tiver usado o comando.
  if (!ponte.atendimentoLigado() && !ponte.operadorEmTeste(from)) {
    store.saveContact(from, {
      lastSeen: Date.now(),
      name: pushName || store.getContact(from)?.name,
      engaged: true,
      followupCount: 0,
    });
    return;
  }

  const contact = store.getContact(from);
  const now = Date.now();
  const nameFields = { lastSeen: now, name: pushName || contact?.name };

  // ─── 1) Boas-vindas / primeiro contato (convida a perguntar, sem menu) ───
  //
  // NÃO sauda quem está em atendimento humano.
  //
  // O shouldWelcome dispara quando o cliente fica quieto mais que a janela de
  // sessão e volta — e o bloco abaixo zerava `paused`. Era isso que fazia o bot
  // "voltar sozinho depois de um tempo" no meio de um atendimento do operador:
  // o cliente demorava para responder, voltava, e levava boas-vindas + menu de
  // um bot que devia estar calado.
  //
  // Quem tira da pausa é o cliente com #inicio (está escrito no aviso que ele
  // recebe) ou o operador. Silêncio não expira sozinho.
  if (welcome.shouldWelcome(contact) && !contact?.paused) {
    ai.clearHistory(from);
    store.saveContact(from, {
      firstSeen: contact?.firstSeen || now,
      greetedAt: now,
      paused: false,
      ...nameFields,
    });
    const greeting = await welcome.buildGreeting(pushName);
    await sender.send(from, greeting);
    // O menu vem junto — o buildGreeting já dizia "(o menu é enviado logo
    // depois)" e isso nunca acontecia: menu.js não era importado por ninguém.
    // Sem ele, toda pergunta caía na IA, inclusive as de resposta fixa.
    store.saveContact(from, { menuNode: 'main', modoIA: false });
    await enviarMenu(from, 'main');
    return;
  }

  // ─── 2) Palavras de recomeço (#inicio/menu/voltar) — barato, sem IA ───
  if (RESUME.has(lower)) {
    store.saveContact(from, {
      paused: false,
      followupCount: 0,
      menuNode: 'main',
      modoIA: false, // volta ao menu = sai da conversa livre
      ...nameFields,
    });
    await enviarMenu(from, 'main', variator.resumed());
    return;
  }

  // ─── 3) Atendimento humano em andamento → silêncio (um humano atende) ───
  if (contact?.paused) {
    store.saveContact(from, nameFields);
    return;
  }

  // Cliente entrou na conversa (não é só boas-vindas): vira candidato à recuperação
  // e, por estar ativo agora, zera qualquer ciclo de cutucada pendente.
  store.saveContact(from, { ...nameFields, engaged: true, followupCount: 0 });

  // ─── 3.05) Nome do jogo pedido ───
  //
  // Vem ANTES do menu numerado: se o jogo se chama "1080 Snowboarding" ou
  // "Fifa 23", a mensagem é só dígitos e seria lida como escolha de opção.
  if (contact?.aguardandoJogo && trimmed) {
    store.saveContact(from, { aguardandoJogo: false, menuNode: 'main' });
    await pedirJogo(from, trimmed, pushName);
    return;
  }

  // ─── 3.06) Problema com a compra, com a IA desligada ───
  //
  // O cliente acabou de contar o que houve. Sem IA não há quem leia, então vai
  // para o operador — e o cliente é PAUSADO, senão continuaria conversando com
  // o menu enquanto espera atendimento humano.
  //
  // ISTO NÃO É CÓDIGO MORTO COM A IA LIGADA, e a condição não é acidental.
  // Quem MARCA o `aguardandoProblema` é a opção 7 do menu, e essa sim só marca
  // com a IA desligada. O tratamento aqui não é condicionado por dois motivos:
  //
  //  1. Quem já estava com o flag marcado no instante em que BOT_IA virou true
  //     continua com ele em disco. Sem esta drenagem, esse cliente contaria o
  //     problema e cairia na IA sem ninguém ser avisado — depois de ter lido
  //     "me conta o que aconteceu" e esperar uma pessoa.
  //  2. BOT_IA=false é o caminho de volta documentado, e é uma variável no
  //     painel, sem deploy. Apagar este bloco faria o rollback deixar de ser
  //     rollback: a opção 7 voltaria a marcar o flag e ninguém o leria.
  if (contact?.aguardandoProblema && trimmed) {
    const nome = store.getContact(from)?.name || pushName || 'cliente';
    store.saveContact(from, { aguardandoProblema: false, paused: true, menuNode: null });

    await ponte.alertar(
      `Cliente: *${nome}* · ${from.replace(/@.*/, '')}\n🛠️ ${trimmed}`,
    );
    console.log(`[problema] ${from}: ${trimmed}`);

    await sender.send(
      from,
      `Anotei ✅ ${expediente.promessaDeAtendimento()}\n\n` +
        '_Se quiser voltar ao menu, digite *#inicio*._',
    );
    return;
  }

  // ─── 3.1) Menu numerado — resposta PRONTA, sem IA ───
  //
  // Vem antes da IA de propósito. "Qual é o prazo de envio?" tem a MESMA
  // resposta todo dia: gastar uma chamada de LLM nela custa segundos de espera
  // por mensagem, tokens, e abre a chance de o modelo inventar prazo ou
  // garantia que a loja não pratica.
  //
  // Só entra enquanto o cliente está navegando o menu (menuNode) e ainda não
  // pediu conversa livre (modoIA). Depois que ele escolhe "problema com a
  // compra", tudo passa direto para a IA.
  //
  // Aceita também o TOQUE numa linha do menu em lista. O que volta do WhatsApp
  // é o número da opção (o rowId) ou o título exato da linha — nunca uma frase
  // do cliente, porque menu.resolve() casa título por igualdade e não por
  // prefixo. Sem isto, quem tocasse no menu receberia o menu de novo, e o
  // caminho novo pareceria quebrado justamente para quem o usou.
  const porToque = contact?.menuNode && !contact?.modoIA ? menu.resolve(contact.menuNode, trimmed) : null;

  if (contact?.menuNode && !contact?.modoIA && (/^\d{1,2}$/.test(trimmed) || porToque)) {
    const escolha = porToque || menu.resolve(contact.menuNode, trimmed);

    if (!escolha) {
      await enviarMenu(from, contact.menuNode, 'Não achei essa opção 🤔');
      return;
    }

    // Submenu: só troca de nó e mostra as opções de lá.
    if (escolha.goto) {
      store.saveContact(from, { menuNode: escolha.goto });
      await enviarMenu(from, escolha.goto);
      return;
    }

    // Tópico: fato do knowledge, na hora.
    if (escolha.topic) {
      const texto = menu.resposta(escolha.topic);
      if (texto) {
        await sender.send(from, texto);
        return;
      }
      // Tópico sem fato cadastrado cai na IA em vez de deixar o cliente no
      // vazio — mas avisa no log, porque é buraco no knowledge.js.
      console.warn(`[menu] tópico "${escolha.topic}" não existe no knowledge.js`);
    }

    if (escolha.action) {
      const feito = await acaoDoMenu(escolha.action, { from, pushName });
      if (feito) return;
      // ação desconhecida: segue para a IA
    }
  }
  // Foto sem legenda ainda é mensagem: o cliente manda a imagem do produto e
  // pergunta depois.
  if (!trimmed && !imagem && !imagemBase64) return;

  // ─── 3.2) Código do pedido + e-mail na mensagem → consulta DIRETA ───
  //
  // Sem IA. Antes quem separava "meu pedido é X e o email é Y" era o modelo;
  // agora é regex, que responde na hora, não inventa argumento e não custa
  // token. Só dispara com os DOIS presentes — o e-mail é o que prova que o
  // pedido é do cliente, e a Nerix valida isso do lado dela.
  const achado = trimmed && extrairPedido(trimmed);
  if (achado) {
    const r = await tools.execute('consultar_pedido', achado, { from });
    await sender.send(from, respostaDePedido(r, achado));
    return;
  }

  // ─── 4) Não reconhecido ───
  //
  // Com a IA desligada (BOT_IA=false, o padrão) NADA é gerado: o cliente
  // recebe o menu de volta em vez de uma frase inventada. Trocar isso por uma
  // resposta de LLM foi o que fazia o mesmo "#menu" voltar diferente a cada
  // envio — e o que abria espaço para prometer prazo e garantia que a loja não
  // pratica.
  if (!config.iaLigada) {
    // LIMPA o modoIA junto — este era o bug que prendia o cliente em laço.
    //
    // As opções 6 e 7 marcavam modoIA:true para a conversa seguir livre. Com a
    // IA desligada, a mensagem seguinte caía aqui... e aqui só o menuNode era
    // reposto. Resultado: modoIA ficava true para sempre, a condição do menu
    // (que exige !modoIA) nunca mais passava, e TODA escolha numérica voltava
    // para cá — o mesmo menu de 8 opções, sem fim.
    //
    // Pior: como a escolha nunca era executada, "falar com um atendente"
    // também não rodava, e o cliente que pediu humano continuava no laço.
    store.saveContact(from, { menuNode: 'main', modoIA: false });
    await enviarMenu(from, 'main', variator.pick(NAO_ENTENDI));
    return;
  }

  // IA só quando ligada de propósito (BOT_IA=true).
  try {
    // A foto sem legenda é foto de verdade — só que agora o modelo a enxerga.
    // Antes esta frase era mandada também para ÁUDIO, que não era extraído:
    // a IA respondia sobre uma foto que não existia.
    const texto = trimmed || '(o cliente mandou uma foto sem escrever nada)';
    const answer = await ai.reply(from, texto, pushName, { imagem, imagemBase64 });
    await sender.send(from, answer);

    // Uma linha por resposta da IA. É o numerador de "quanto saiu do meu colo":
    // sem ele, o dono só sabia quantos handoffs chegaram — nunca quantas
    // conversas terminaram sem ele. Um número sem o outro não diz nada.
    registro.anotar('ia_respondeu', { de: 'cliente', veioDeAudio: Boolean(veioDeAudio), comFoto: Boolean(imagemBase64) });
  } catch (err) {
    console.error('[ai] erro ao responder:', err.response?.data || err.message);
    registro.anotar('ia_caiu', { motivo: err.tetoDoCliente ? 'teto_do_cliente' : err.prazoEsgotado ? 'prazo' : 'falha' });

    // O menu é a REDE, não uma mensagem de desculpa.
    //
    // `variator.error()` deixava o cliente sem saída: ele lia "tive um
    // probleminha", mandava a mesma coisa de novo, e caía no mesmo erro. Com o
    // menu ele tem oito caminhos que funcionam sem LLM nenhuma — e é justamente
    // quando a IA cai que ele mais precisa deles.
    //
    // modoIA:false junto, senão a mensagem seguinte pula o menu e volta para a
    // IA que acabou de falhar.
    store.saveContact(from, { menuNode: 'main', modoIA: false });
    await enviarMenu(from, 'main', variator.pick(NAO_ENTENDI));
  }
}

const NAO_ENTENDI = [
  'Não entendi bem 🤔 Escolhe uma opção abaixo:',
  'Deixa eu te ajudar melhor — escolhe pelo número:',
  'Pra te atender mais rápido, escolhe uma das opções:',
];

/**
 * Texto PRONTO para cada resultado da consulta de pedido.
 *
 * Cada erro tem uma saída diferente, e nenhuma delas culpa o cliente por
 * problema nosso — foi o que o 401 fazia quando estava junto do 403.
 */
function respostaDePedido(r, { codigo }) {
  if (r.erro === 'pedido_nao_encontrado') {
    return (
      `Não achei o pedido \`${codigo}\` 🤔\n\n` +
      'Confere se o código está completo. Ele fica no e-mail da compra e na sua ' +
      'conta no site.\n\n_Digite *#menu* para ver as opções._'
    );
  }
  if (r.erro === 'email_nao_confere') {
    return (
      'Achei o pedido, mas esse e-mail não é o que foi usado na compra 🤔\n\n' +
      'Manda o e-mail que recebeu a confirmação.\n\n_Digite *#menu* para ver as opções._'
    );
  }
  if (r.erro) {
    // Inclui sistema_indisponivel (nossa chave) — problema nosso, atendente
    // assume. NÃO dizer que o dado do cliente está errado.
    return (
      `Não consegui consultar agora 🙏 ${expediente.promessaDeAtendimento()}`
    );
  }

  const linhas = [`📦 *Pedido ${r.codigo}*`, `Status: *${r.status}*`];
  if (r.total) linhas.push(`Total: ${r.total}`);

  if (r.itens?.length) {
    linhas.push('', '*Itens:*');
    for (const i of r.itens) {
      linhas.push(`• ${i.nome}${i.quantidade > 1 ? ` (${i.quantidade}x)` : ''}`);
      // A chave só chega aqui depois de a Nerix validar o e-mail — mesmo gate
      // do site. É o que o cliente veio buscar.
      if (i.chave) linhas.push(`  🔑 \`${i.chave}\``);
    }
  }

  if (!r.pago && r.pix_copia_e_cola) {
    linhas.push('', '💠 *Pix copia e cola:*', `\`${r.pix_copia_e_cola}\``);
  } else if (!r.pago && r.link_pagamento) {
    linhas.push('', `💳 Pagar: ${r.link_pagamento}`);
  }

  linhas.push('', '_Digite *#menu* para ver as opções._');
  return linhas.join('\n');
}

/**
 * O operador digitou na conversa de um cliente — o humano assumiu.
 *
 * Pausa o bot e avisa o cliente UMA vez. Sem isto o bot continuava
 * respondendo por cima do atendimento humano: o cliente escrevia, recebia o
 * menu de 8 opções e a resposta do operador ao mesmo tempo, e não sabia com
 * quem estava falando.
 *
 * O aviso sai só na PRIMEIRA mensagem da pausa. Repetir a cada linha que o
 * operador digita seria pior que o problema — ele costuma mandar três, quatro
 * mensagens seguidas.
 */
async function onOperadorDigitou({ para, texto }) {
  const from = String(para || '').replace('@s.whatsapp.net', '');
  if (!from) return;

  // O operador falando com ele mesmo (os #comandos, os alertas) não é
  // atendimento de ninguém.
  if (require('./ponte/config').operador.ehOperador(from)) return;

  const contato = store.getContact(from);
  if (contato?.paused) return; // já assumido: não avisa de novo

  store.saveContact(from, { paused: true, menuNode: null, modoIA: false, aguardandoJogo: false });
  console.log(`[handoff] ${from} -> operador assumiu (digitou na conversa)`);

  await sender.send(
    from,
    '👤 Nosso *suporte* entrou no chat e vai continuar com você por aqui.\n\n' +
      '_Quando quiser voltar ao menu, é só digitar *#inicio*._',
  );
}

/**
 * @param {object} event  Payload da Nerix { event, created_at, data }
 */
async function onNerixEvent(event) {
  const { event: name, data } = event;
  console.log(`[nerix] evento ${name} — pedido ${data?.order_number}`);

  // O que fazer com cada evento mora no vendas.js. Aqui só a ponte entre o
  // webhook e ele: entrega de chave tem trava de idempotência e estado em
  // disco, e isso não cabia no meio dos handlers de mensagem.
  await vendas.onEvento(event);
}

// extrairPedido e respostaDePedido exportados para teste: são eles que
// substituíram a IA no caminho de consulta, e um erro ali entrega dado de
// pedido errado ou deixa o cliente sem resposta.
module.exports = { onIncomingMessage, onNerixEvent, onOperadorDigitou, extrairPedido, respostaDePedido };
