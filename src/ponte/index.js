'use strict';

/**
 * Ponte Taobao — relay de código de verificação.
 *
 * O fluxo real é curto:
 *
 *   Cliente manda FOTO + USUÁRIO (ex.: rrrtsr223)
 *     → fila serial (um cliente por vez)
 *     → braço envia foto e usuário no chat da Taobao
 *     → fornecedor responde CÓDIGO de 4-8 dígitos
 *     → código vai direto ao cliente
 *
 * Tradução NÃO está no caminho principal: usuário e código são alfanuméricos,
 * não há o que traduzir. Ela só entra quando o fornecedor responde em chinês —
 * que é sempre caso de problema (conta não existe, aguarde, etc.) e por isso
 * sempre passa por um humano.
 *
 * A fila serial não é só rate limit: todos os clientes dividem o MESMO chat, e
 * o fornecedor não diz a quem responde. Com um atendimento ativo por vez, o
 * código que chega pertence sem ambiguidade a quem está na vez. Entregar código
 * ao cliente errado dá acesso à conta de terceiro — é a falha que não pode
 * acontecer.
 */

const cfg = require('./config');
const fila = require('./fila');
const limites = require('./limites');
const codigo = require('./codigo');
const tradutor = require('./tradutor');
const janela = require('./janela');
const midia = require('./midia');
const politica = require('./politica');
const { dados, persist, persistAgora, proximoId } = require('./estado');
const sender = require('../sender');

async function alertar(texto, imagem, nomeArquivo) {
  if (!cfg.operador.numero) {
    console.warn('[ponte] alerta sem destino (defina PONTE_OPERADOR_NUMERO):', texto);
    return;
  }
  // Toda saída passa por aqui, e é de propósito: o alerta vai para o operador
  // mas sai pelo MESMO número comercial que fala com o cliente. Um stack trace
  // do Playwright já saiu por este caminho. Filtrar em cada chamada é o que
  // falhou; filtrar na porta é o que segura.
  const { texto: limpo, limpou } = politica.limparAlerta(texto);
  if (limpou) console.warn('[ponte] alerta continha texto técnico — limpo antes de enviar');

  try {
    await sender.send(
      cfg.operador.numero,
      limpo,
      imagem ? { image: imagem, fileName: nomeArquivo || 'ponte.png' } : {},
    );
  } catch (err) {
    console.error('[ponte] falha ao alertar operador:', err.message);
  }
}

// ============================================================
// SENTIDO 1 — cliente pede o código
// ============================================================

/**
 * Chamado pela ferramenta `pedir_codigo_fornecedor` do ai.js.
 *
 * @param {string} from        número do cliente
 * @param {string} nome        nome do cliente
 * @param {string} usuarioBruto texto que o cliente mandou como usuário
 * @param {string|null} imagemPath  foto do print, se veio
 * @returns {Promise<{aceito:boolean, mensagem:string}>}
 */
async function pedirCodigo(from, nome, usuarioBruto, imagemPath = null) {
  // NADA do que sai daqui para o cliente cita a origem do código.
  // Para ele, quem gera é a Phaze — e essa é a única versão que existe.
  if (!cfg.ativa) {
    return { aceito: false, mensagem: 'O sistema de código está em manutenção. Já te aviso 🙏' };
  }

  const d = limites.disjuntor();
  if (d.estado === 'aberto') {
    // O alerta tem que trazer a AÇÃO, não só o aviso. Sem o comando junto, o
    // aviso chega, o operador vê "fila parada" e o pedido fica parado enquanto
    // ele procura qual dos comandos destrava.
    await alertar(
      `⚠️ *${nome}* pediu código com os envios congelados.\n\n` +
        `A fila está parada e o pedido dele NÃO entrou.\n` +
        `Responde *#liberar* para destravar — depois peça para ele mandar de novo.`,
    );
    return {
      aceito: false,
      // Não admite defeito. "Estou resolvendo uma coisa aqui no sistema" é
      // irmã do "Deu um problema aqui no sistema" que já saiu daqui: numa
      // conversa de compra, admitir problema derruba a confiança e leva a
      // venda junto. O cliente acabou de mandar foto e usuário, então algum
      // retorno ele precisa — só que neutro, de espera, não de falha.
      // Mesma frase do pedido que espera aprovação, e pelo mesmo motivo: aqui
      // o pedido NÃO entrou (a fila está parada), então prometer que já está
      // pegando é prometer o que não começou.
      mensagem: 'Recebi tudo ✅ Já te retorno com o código 👍',
    };
  }

  // Valida ANTES de gastar cota e ocupar a fila serial. Se o cliente mandou o
  // usuário dentro de uma frase, tenta extrair; se ficar ambíguo, pergunta em
  // vez de adivinhar — mandar usuário errado queima uma vaga na fila à toa.
  const v = codigo.validarUsuario(usuarioBruto);
  const usuario = v.valido ? v.usuario : codigo.extrairUsuario(usuarioBruto);

  if (!usuario) {
    return {
      aceito: false,
      mensagem:
        'Preciso do usuário da conta exatamente como aparece na tela — só ele, ' +
        'sem mais nada junto (algo tipo *rrrtsr223*). Pode mandar?',
    };
  }

  // O modo teste do operador não consome cota de cliente.
  //
  // Esse limite existe para um cliente não inundar a fila — e testar é
  // exatamente repetir o fluxo, então ele travava justo quem precisa repetir.
  // Os limites do FORNECEDOR (10/h, 60/dia) continuam valendo normalmente:
  // são esses que protegem a conta da Taobao, e nenhum teste passa por cima.
  const testando =
    from === cfg.operador.numero && dados.testeOperador?.ate > Date.now();

  const lim = testando ? { permitido: true } : limites.checarCliente(from);
  if (!lim.permitido) {
    return {
      aceito: false,
      mensagem: 'Você já pediu vários códigos agora há pouco. Deixa os anteriores chegarem primeiro 👍',
    };
  }

  const { atendimento, ativo, aFrente } = await fila.entrar(from, nome);
  atendimento.usuario = usuario;
  if (imagemPath) atendimento.imagemPendente = imagemPath;
  persistAgora();

  if (!ativo) {
    return {
      aceito: true,
      mensagem:
        `Anotei! Tem ${aFrente} ${aFrente === 1 ? 'pessoa' : 'pessoas'} na sua frente. ` +
        `Já já pego seu código e te mando 👍`,
    };
  }

  const tarefa = await despachar(atendimento);

  // No copiloto NADA foi mandado ainda — a tarefa está parada esperando o #ok.
  // Dizer "já estou pegando seu código" aqui é prometer uma ação que só
  // acontece se o operador aprovar, e que pode nunca acontecer (#nao). O
  // cliente confirma que chegou; a promessa sai no #ok, quando vira verdade.
  if (tarefa && tarefa.estado === 'aguardando_aprovacao') {
    // No #teste o operador é o cliente, e as duas mensagens caem no mesmo
    // número. "Recebi tudo, já te retorno" lido ali parece o fim do fluxo, e o
    // #ok ficava esquecido esperando um envio que nunca ia sair sozinho.
    //
    // SÓ no teste. Para cliente de verdade, "#ok 45" é comando de operador
    // vazando para quem não pode nem saber que existe um do outro lado.
    return {
      aceito: true,
      mensagem: testando
        ? `Recebi tudo ✅\n\n🧪 *Modo teste* — manda *#ok ${tarefa.id}* para o envio sair.`
        : 'Recebi tudo ✅ Já te retorno com o código 👍',
    };
  }

  return { aceito: true, mensagem: janela.estado().avisoCliente };
}

/** Cria a tarefa do braço. Sem tradução: usuário é alfanumérico. */
async function despachar(atendimento) {
  if (!atendimento.usuario) {
    await alertar(`⚠️ Atendimento de *${atendimento.nome}* sem usuário definido. Pulei.`);
    return;
  }

  const tarefa = {
    id: proximoId(),
    atendimentoId: atendimento.id,
    tipo: 'pedir_codigo',
    usuario: atendimento.usuario,
    imagemPath: atendimento.imagemPendente || null,
    estado: cfg.modo === 'copiloto' ? 'aguardando_aprovacao' : 'pendente',
    agendadaPara: janela.estado().proximaAbertura.getTime(),
    tentativas: 0,
    ultimoErro: null,
  };

  dados.tarefas.push(tarefa);
  atendimento.imagemPendente = null;
  persistAgora();

  if (cfg.modo === 'copiloto') {
    await alertar(
      `📋 *Ponte — liberar envio*\n\n` +
        `Cliente: *${atendimento.nome}*\n` +
        `Usuário: \`${tarefa.usuario}\`\n` +
        `Foto: ${tarefa.imagemPath ? 'sim' : 'NÃO'}\n\n` +
        // "ao sistema" e não a outra palavra. O limparAlerta já trocava isto na
        // saída — dava para ver no WhatsApp — mas depender do filtro para uma
        // string fixa que a gente escreve é usar a rede de segurança como se
        // fosse o piso.
        `*#ok ${tarefa.id}* para mandar ao sistema · *#nao ${tarefa.id}* para descartar`,
    );
  }

  // Quem chama precisa saber se ficou esperando o #ok: é isso que decide o que
  // o CLIENTE ouve agora.
  return tarefa;
}

// ============================================================
// SENTIDO 2 — fornecedor responde
// ============================================================

/**
 * Chamado pelo braço com uma mensagem NOVA do fornecedor.
 *
 * O braço só reporta o que veio DEPOIS da marca d'água registrada no envio —
 * nunca varre o histórico. Sem isso, os meses de conversa antiga na tela
 * virariam centenas de "códigos novos" na primeira execução.
 */
async function receberDoFornecedor(entrada) {
  const at = fila.ativo();
  if (!at) {
    await alertar(
      `📨 Fornecedor mandou algo sem ninguém na vez:\n\n"${entrada.texto}"\n\n` +
        `Provavelmente resposta atrasada. Não entreguei a ninguém.`,
    );
    return;
  }

  const c = codigo.classificar(entrada.texto);

  if (c.tipo === 'codigo') {
    await entregarCodigo(at, c.codigo);
    return;
  }

  // Não é código: é problema. Traduz só para o operador entender e decidir.
  //
  // Marcador sintético do braço ("respondeu com uma imagem") já vem em
  // português — mandar para o tradutor gastaria chamada de LLM para traduzir
  // português em português.
  const jaEmPortugues = entrada.texto.startsWith('[respondeu com');
  let traduzido = entrada.texto;
  if (!jaEmPortugues) {
    try {
      const t = await tradutor.paraCliente(entrada.texto, at.historico || []);
      traduzido = t.traducao;
    } catch {
      traduzido = '(não consegui traduzir)';
    }
  }

  const aprovacao = {
    id: proximoId(),
    atendimentoId: at.id,
    cliente: at.nome,
    from: at.from,
    origem: entrada.texto,
    texto: traduzido,
    criadoEm: Date.now(),
  };
  dados.aprovacoes.push(aprovacao);
  persistAgora();

  // SEM o texto original.
  //
  // Ele vinha logo acima da tradução, em chinês, e isso é duas coisas ruins de
  // uma vez. A primeira é prática: para decidir entre #enviar e #nao, o
  // operador lê o português — o chinês é ruído que ele não consegue conferir.
  // A segunda é a regra: caractere chinês no número comercial ENTREGA A ORIGEM
  // igual à palavra "fornecedor", e sai pelo mesmo número que fala com o
  // cliente.
  //
  // O original continua guardado em `aprovacao.origem`, que é onde ele serve —
  // depurar tradução ruim sem passar pelo WhatsApp.
  // Duas linhas, sem cabeçalho e sem a lista de comandos. O operador lê isto
  // no celular, no meio de um atendimento: o que importa é de quem é e o que o
  // outro lado disse.
  //
  // O id sai daqui mas não some — o #fila lista toda aprovação pendente com o
  // *#enviar <id>* ao lado. Era o único lugar que exibia o id, e é por isso
  // que o #fila passa a ser o caminho para responder.
  await alertar(
    `Cliente: *${at.nome}* · usuário \`${at.usuario}\`\n💬 ${traduzido}`,
    entrada.printPath,
  );
}

/** Entrega o código ao cliente, encerra a vez e chama o próximo. */
async function entregarCodigo(atendimento, cod) {
  await sender.send(
    atendimento.from,
    `Chegou o código da sua conta:\n\n*${cod}*\n\n` +
      `Digita ele na tela de verificação. Se der erro ou expirar, me avisa que peço outro 👍`,
  );

  console.log(`[ponte] código ${cod} entregue a ${atendimento.from} (${atendimento.usuario})`);
  limites.registrarSucesso();

  await fila.concluir(atendimento.id, 'codigo_entregue');
  await promoverProximo();
}

/** Depois que a fila anda, despacha a vez do próximo. */
async function promoverProximo() {
  const at = fila.ativo();
  if (!at || !at.usuario) return;

  // Despacha ANTES de falar, porque é o estado da tarefa que decide o que
  // dizer. No copiloto ela nasce esperando o #ok e nada saiu ainda — prometer
  // "já estou pegando" aqui repetiria o defeito que já corrigimos no pedido:
  // promessa de uma ação que depende do operador e que o #nao pode cancelar.
  const tarefa = await despachar(at);

  await sender.send(
    at.from,
    tarefa && tarefa.estado === 'aguardando_aprovacao'
      ? 'Chegou sua vez! Já te retorno com o código 👍'
      : 'Chegou sua vez! Já estou pegando seu código 👍',
  );
}

// ============================================================
// Fila de tarefas do braço
// ============================================================

/** Tempo máximo que um envio pode ficar em 'executando' antes de ser dado por perdido. */
const EXECUTANDO_MAX_MS = 5 * 60 * 1000;

/**
 * Devolve à fila as tarefas que ficaram presas em 'executando'.
 *
 * Uma tarefa entra em 'executando' quando o braço a pega, e só sai quando ele
 * reporta o resultado. Se ele morrer no meio — deploy, OOM, container
 * reiniciado — ninguém reporta nada e a tarefa fica presa PARA SEMPRE: o
 * /proxima só entrega 'pendente', então o braço novo sobe, pergunta, não recebe
 * nada e fica parado achando que não há trabalho.
 *
 * Antes isso se escondia atrás do restart do bot, que faz esse mesmo conserto
 * ao carregar o estado. Só que os dois serviços são deployados separado: reiniciar
 * o braço sozinho deixava o envio travado sem nada no log, e o cliente esperava
 * as 4h do timeout.
 *
 * Não conta como tentativa: o braço não chegou a falhar, ele sumiu.
 */
function recuperarTravadas() {
  const limite = Date.now() - EXECUTANDO_MAX_MS;
  let mudou = false;
  for (const t of dados.tarefas) {
    if (t.estado === 'executando' && (t.pegaEm || 0) < limite) {
      t.estado = 'pendente';
      t.tentativas = Math.max(0, t.tentativas - 1);
      mudou = true;
      console.warn(`[ponte] tarefa ${t.id} travada em executando — devolvida à fila`);
    }
  }
  if (mudou) persistAgora();
}

function proximaTarefa() {
  recuperarTravadas();

  const agora = Date.now();
  const t = dados.tarefas.find((x) => x.estado === 'pendente' && x.agendadaPara <= agora);
  if (!t) return null;
  t.pegaEm = agora;
  t.estado = 'executando';
  t.tentativas += 1;
  persistAgora();

  // O braço precisa da URL da foto, não do nome do arquivo: ele roda noutra máquina.
  return {
    id: t.id,
    tipo: t.tipo,
    usuario: t.usuario,
    imagem: t.imagemPath || null,
    tentativa: t.tentativas,
  };
}

/**
 * Devolve à fila uma tarefa que foi pega mas não chegou ao braço.
 *
 * Faz falta por causa do long-polling: proximaTarefa() já marca 'executando' e
 * conta tentativa, e agora a conexão fica pendurada até 25s — tempo de sobra
 * para o braço cair, reiniciar ou estourar timeout entre o "peguei" e o
 * "recebi". Sem isto a tarefa ficaria 'executando' sem dono, invisível para
 * todo mundo, até o próximo restart do bot — e o cliente esperaria as 4h do
 * timeout por um envio que ninguém ia fazer.
 */
function devolverTarefa(id) {
  const t = dados.tarefas.find((x) => x.id === id);
  if (!t || t.estado !== 'executando') return;
  t.estado = 'pendente';
  t.tentativas = Math.max(0, t.tentativas - 1); // não foi tentativa de verdade
  persistAgora();
}

/**
 * @param {boolean} fatal  não tente de novo, aconteça o que acontecer.
 *   Usado quando repetir causaria dano: se a foto já saiu e só o usuário
 *   falhou, uma nova tentativa manda o MESMO print outra vez e o fornecedor
 *   fica com dois prints e nenhum usuário.
 */
async function resultadoTarefa(id, ok, erro, printPath, fatal = false) {
  const t = dados.tarefas.find((x) => x.id === id);
  if (!t) return { ok: false, motivo: 'tarefa desconhecida' };

  if (ok) {
    t.estado = 'concluida';
    limites.registrarSucesso();
    persistAgora();
    return { ok: true };
  }

  const desistir = fatal || t.tentativas >= 3;
  t.estado = desistir ? 'falhou' : 'pendente';
  t.ultimoErro = erro || 'sem detalhe';
  persistAgora();

  // O erro cru fica no log do servidor, que é onde ele serve. Para o WhatsApp
  // vai só o motivo do catálogo — ver politica.motivoNeutro().
  if (erro) console.error(`[ponte] tarefa ${id} falhou:`, erro);
  const motivo = politica.motivoNeutro(erro);

  const { abriu } = limites.registrarFalha(erro || 'falha no envio', printPath);
  if (abriu) {
    await alertar(
      `🛑 *Envios congelados*\n\nFalhou várias vezes seguidas.\n` +
        `Motivo: ${motivo}\n\nVê o que houve e responde *#liberar*.`,
      printPath,
    );
  } else if (desistir) {
    // O cliente NÃO recebe aviso de falha. Ele não tem o que fazer com essa
    // informação, e "deu problema no sistema" numa conversa de compra derruba
    // a confiança na hora — some com a venda junto. Quem assume é o operador,
    // pelo alerta abaixo, com o id em mãos para responder na conversa.
    const at = fila.porId(t.atendimentoId);
    await alertar(
      (fatal
        ? `⚠️ *Envio pela metade* — ${motivo}\n\nNão repeti de propósito: repetir mandaria o print de novo.`
        : `⚠️ Desisti de um envio após 3 tentativas — ${motivo}.`) +
        (at ? `\n\n👤 Cliente *${at.id}* está esperando e não foi avisado. Assume a conversa.` : ''),
      printPath,
    );
  }

  return { ok: true, desistiu: desistir };
}

/**
 * O braço viu tela de verificação. Congela e chama humano.
 *
 * Sem tentativa automática de propósito: o slider da Taobao avalia a trajetória
 * do arraste, não só a posição final. Script acerta a posição e falha a
 * biometria — e tentativa falha é sinal de bot somado à conta.
 */
async function bloqueioDetectado(motivo, printPath) {
  if (!limites.abrir(motivo, printPath)) return; // já estava aberto

  const esperando = fila.situacao().aguardando.length;

  // O slider mede a trajetória do arraste, então não há código para repassar
  // como no SMS: só um arraste humano de verdade passa. Por isso o caminho é
  // a tela remota, não uma instrução de "resolve no seu navegador" — o
  // navegador que precisa ser resolvido é o do container.
  const comoResolver = cfg.vncUrl
    ? `1. Abre a tela: ${cfg.vncUrl}\n` +
      `2. Arrasta o slider você mesmo (com o mouse, devagar)\n` +
      `3. Responde *#liberar*`
    : `1. Configure PONTE_VNC_URL para conseguir ver a tela\n` +
      `   (sem isso não há como resolver: o navegador está dentro do container)\n` +
      `2. Depois de resolver, responde *#liberar*`;

  await alertar(
    `🛑 *Verificação na tela*\n\n${motivo}\n\n` +
      `Envios congelados. ${esperando} cliente(s) na fila.\n\n${comoResolver}`,
    printPath,
  );
}

// ============================================================
// Manutenção
// ============================================================

async function tick() {
  try {
    const vencidos = await fila.expirarVencidos();
    for (const v of vencidos) {
      await sender.send(
        v.from,
        'Seu código está demorando mais que o normal. Já estou vendo isso — ' +
          'se preferir, posso te passar pra um atendente 👍',
      );
      await alertar(`⏱️ Atendimento de *${v.nome}* (\`${v.usuario}\`) expirou sem código.`);
    }
    if (vencidos.length) await promoverProximo();
  } catch (err) {
    console.error('[ponte/tick] erro:', err.message);
  }
}

function iniciar() {
  if (!cfg.ativa) {
    console.log('[ponte] desativada (PONTE_ATIVA != true)');
    return;
  }
  if (!cfg.vendedor.chatTitulo) {
    console.warn('[ponte] PONTE_SELLER_CHAT_TITLE vazio — o braço não acha o chat.');
  }
  console.log(`[ponte] ativa · modo ${cfg.modo} · fornecedor ${cfg.vendedor.chatTitulo}`);
  setInterval(tick, 60 * 1000).unref();
}

const ativa = () => cfg.ativa;
const salvarImagem = (base64, mimetype) => midia.salvar(base64, mimetype);

module.exports = {
  pedirCodigo,
  receberDoFornecedor,
  entregarCodigo,
  proximaTarefa,
  devolverTarefa,
  resultadoTarefa,
  bloqueioDetectado,
  promoverProximo,
  alertar,
  iniciar,
  tick,
  ativa,
  salvarImagem,
};
