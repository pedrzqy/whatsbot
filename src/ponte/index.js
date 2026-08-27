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
const repertorio = require('./repertorio');
const tradutor = require('./tradutor');
const janela = require('./janela');
const midia = require('./midia');
const politica = require('./politica');
const marca = require('./marca');
const { dados, persist, persistAgora, proximoId, emTeste, registrarIgnorado } = require('./estado');
const sender = require('../sender');

async function alertar(texto, imagem, nomeArquivo) {
  if (!cfg.operador.numeros.length) {
    console.warn('[ponte] alerta sem destino (defina PONTE_OPERADOR_NUMERO):', texto);
    return;
  }
  // Toda saída passa por aqui, e é de propósito: o alerta vai para o operador
  // mas sai pelo MESMO número comercial que fala com o cliente. Um stack trace
  // do Playwright já saiu por este caminho. Filtrar em cada chamada é o que
  // falhou; filtrar na porta é o que segura.
  const { texto: limpo, limpou } = politica.limparAlerta(texto);
  if (limpou) console.warn('[ponte] alerta continha texto técnico — limpo antes de enviar');

  // Um por vez, e cada um com seu próprio try.
  //
  // Em série porque o sender é humanizado: disparar em paralelo entregaria as
  // duas mensagens no mesmo instante, o que é justamente o padrão que ele
  // existe para não fazer.
  //
  // E o try é por destino, não em volta do laço: com um só, o primeiro número
  // fora do ar (aparelho desconectado, número errado no Environment) engoliria
  // o alerta dos outros. Captcha na tela avisado para ninguém é o pior desfecho
  // possível aqui.
  for (const numero of cfg.operador.numeros) {
    try {
      await sender.send(
        numero,
        limpo,
        imagem ? { image: imagem, fileName: nomeArquivo || 'ponte.png' } : {},
      );
    } catch (err) {
      console.error(`[ponte] falha ao alertar ${numero}:`, err.message);
    }
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
  const testando = cfg.operador.ehOperador(from) && emTeste(from);

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
    // Assinada: fecha uma etapa (o cliente vai esperar), e é uma das que ele
    // relê enquanto aguarda.
    return {
      aceito: true,
      mensagem: marca.assinar(
        `Anotei! Tem ${aFrente} ${aFrente === 1 ? 'pessoa' : 'pessoas'} na sua frente. ` +
          `Já já pego seu código e te mando 👍`,
      ),
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
      // No teste NÃO começa com "Recebi tudo ✅": lido no celular, o certo
      // verde dá a sensação de etapa concluída e o #ok fica esperando. A
      // primeira palavra tem que ser a pendência, não a confirmação.
      //
      // Para cliente de verdade o "Recebi tudo" está certo — ele realmente não
      // tem mais nada a fazer, só esperar.
      mensagem: testando
        ? `⏳ *Aguardando confirmação* — manda *#ok ${tarefa.id}* para o envio sair.`
        : 'Recebi tudo ✅ Já te retorno com o código 👍',
    };
  }

  // Assinada aqui e não dentro de janela.js: o mesmo avisoCliente é embutido
  // em itálico no fim da MSG_PEDE_FOTO (recepcao.js), que já abre com o
  // cabeçalho — marcar na origem deixaria a marca duas vezes na mesma
  // mensagem, uma delas dentro do itálico.
  const j = janela.estado();
  return { aceito: true, mensagem: j.aberta ? j.avisoCliente : marca.assinar(j.avisoCliente) };
}

/**
 * Cria a tarefa do braço.
 *
 * Dois tipos hoje, e o mesmo caminho para os dois:
 *
 *   pedir_codigo         — foto + usuário. O de sempre.
 *   responder_fornecedor — uma linha do repertório, em `textoZh`.
 *
 * Tudo o que vem depois — `agendadaPara` (a janela dele), `tentativas`,
 * `aguardando_aprovacao`, `#ok`/`#nao`, `/proxima`, `/resultado`, `#destravar`
 * — é o mesmo para os dois e não precisou de nada novo. É o motivo de a Fase 5
 * ser pequena aqui dentro: a máquina já existia, faltava o tipo.
 *
 * @param {object} atendimento
 * @param {{tipo?:string, textoZh?:string, semFoto?:boolean}} [opcoes]
 */
async function despachar(atendimento, opcoes = {}) {
  const tipo = opcoes.tipo || 'pedir_codigo';
  const respondendo = tipo === 'responder_fornecedor';

  if (!respondendo && !atendimento.usuario) {
    await alertar(`⚠️ Atendimento de *${atendimento.nome}* sem usuário definido. Pulei.`);
    return;
  }

  // Filtro de SAÍDA, no texto que de fato vai sair.
  //
  // Até a Fase 4 o único texto que atravessava era o usuário alfanumérico, e o
  // filtro foi ligado ali justamente para já estar no caminho quando saísse
  // texto de verdade. Agora sai: `textoZh` é uma linha do repertório com o
  // usuário ou o nome do jogo preenchidos, e é exatamente aí que um telefone ou
  // um preço em real entrariam por descuido de quem editar o repertório.
  const bruto = respondendo ? String(opcoes.textoZh || '') : atendimento.usuario;
  if (!bruto.trim()) {
    await alertar(`⚠️ Ia mandar uma resposta vazia para o outro lado. Não mandei.`);
    return;
  }

  const saida = politica.paraFornecedor(bruto);
  if (saida.texto !== bruto || saida.flags.length) {
    await alertar(
      `⚠️ Não mandei nada no atendimento de *${atendimento.nome}*: o texto tinha dado que não ` +
        `pode sair daqui.\n\nConfere e refaz.`,
    );
    console.warn(`[ponte] envio barrado por política: ${saida.flags.join(', ')}`);
    return;
  }

  const tarefa = {
    id: proximoId(),
    atendimentoId: atendimento.id,
    tipo,
    usuario: atendimento.usuario,
    // `textoZh` estava no typedef desde o começo e nunca tinha sido usado.
    textoZh: respondendo ? saida.texto : null,
    // Resposta não leva foto: a foto é do print da tela do cliente e só faz
    // sentido no pedido de código. Mandá-la de novo aqui seria o mesmo print
    // pela segunda vez no chat dele.
    imagemPath: respondendo ? null : atendimento.imagemPendente || null,
    estado: modoAtual() === 'copiloto' ? 'aguardando_aprovacao' : 'pendente',
    agendadaPara: janela.estado().proximaAbertura.getTime(),
    tentativas: 0,
    ultimoErro: null,
  };

  dados.tarefas.push(tarefa);
  if (!respondendo) atendimento.imagemPendente = null;

  // O lado do cliente no histórico. Sem os dois lados, o contexto que o
  // tradutor recebe é meia conversa — e meia conversa às vezes é pior que
  // nenhuma, porque parece completa.
  fila.registrar(atendimento.id, 'cliente', bruto, bruto);

  persistAgora();

  if (modoAtual() === 'copiloto') {
    // A aprovação de uma RESPOSTA precisa dizer o que vai sair, em português.
    // Chinês não pode aparecer aqui (sai pelo número comercial) e o operador
    // não teria como conferir mesmo. O rótulo da linha do repertório é o que
    // ele lê para decidir.
    await alertar(
      respondendo
        ? `📋 *Ponte — liberar resposta*\n\n` +
            `Cliente: *${atendimento.nome}*\n` +
            `Vou responder: _${opcoes.rotulo || 'resposta do repertório'}_\n\n` +
            `*#ok ${tarefa.id}* para mandar · *#nao ${tarefa.id}* para descartar`
        : `📋 *Ponte — liberar envio*\n\n` +
            `Cliente: *${atendimento.nome}*\n` +
            `Usuário: \`${tarefa.usuario}\`\n` +
            `Foto: ${tarefa.imagemPath ? 'sim' : 'NÃO'}\n\n` +
            // "ao sistema" e não a outra palavra. O limparAlerta já trocava
            // isto na saída — dava para ver no WhatsApp — mas depender do
            // filtro para uma string fixa que a gente escreve é usar a rede de
            // segurança como se fosse o piso.
            `*#ok ${tarefa.id}* para mandar ao sistema · *#nao ${tarefa.id}* para descartar`,
    );
  }

  // Quem chama precisa saber se ficou esperando o #ok: é isso que decide o que
  // o CLIENTE ouve agora.
  return tarefa;
}

/**
 * Cliente saiu do atendimento sozinho e quer uma pessoa. Avisa o operador.
 *
 * Existe porque havia TRÊS caminhos de handoff e cada um decidia sozinho se
 * avisava alguém: o menu não avisava, a ferramenta da IA não avisava, e só o
 * caminho de "conta o problema" avisava. O sintoma é sempre o mesmo e sempre
 * mudo — o contato fica `paused`, o bot cala a boca, e o cliente espera um
 * atendente que ninguém chamou.
 *
 * O formato é o dos outros alertas: quem é em cima, o que quer embaixo. O
 * telefone vai junto porque é por ele que o operador responde.
 *
 * @param {{nome?:string, from:string, motivo?:string, contato?:string}} p
 */
async function alertarHandoff({ nome, from, motivo, contato }) {
  // O motivo pode vir do MODELO (args.motivo do falar_com_atendente), então é
  // texto de terceiro indo para o WhatsApp. O limparAlerta cuida do vocabulário;
  // o corte aqui cuida do tamanho, para uma resposta longa não empurrar o
  // telefone para fora da tela do celular.
  const porque = String(motivo || '').replace(/\s+/g, ' ').trim().slice(0, 160);

  const linhas = [
    `Cliente: *${nome || 'sem nome'}* · ${String(from).replace(/@.*/, '')}`,
    `🧑‍💼 Pediu atendimento${porque ? ` — ${porque}` : ''}`,
  ];
  if (contato) linhas.push(`📞 contato que ele deixou: ${contato}`);

  await alertar(linhas.join('\n'));
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

  // Ruído: card de produto, pesquisa de satisfação, "ok" solto. Não é resposta
  // ao pedido de ninguém — some sem alerta, sem aprovação e SEM mexer na fila.
  //
  // Não mexer na fila é o ponto: o cliente da vez continua esperando, porque
  // ninguém respondeu a ele. Concluir aqui entregaria a vez ao próximo por causa
  // de um anúncio que a loja disparou sozinha.
  if (c.tipo === 'ignorar') {
    registrarIgnorado();
    console.log(`[ponte] descartado como ruído: ${entrada.texto.slice(0, 60)}`);
    return;
  }

  // Pacote (conta + senha + jogo) e senha solta SÃO entrega — 13% do que ele
  // manda. Antes disto caíam em "problema": viravam uma aprovação parada no
  // WhatsApp, e a fila só destravava com o timeout de 4h. O cliente seguinte
  // esperava essas 4h por nada.
  //
  // Vão para o OPERADOR, não para o cliente. O código sai sozinho porque a fila
  // serial garante de quem ele é; uma conta inteira não tem essa garantia — a
  // atribuição aqui é inferência, e senha entregue ao cliente errado é
  // exatamente a falha que a fila serial existe para impedir (fila.js:9-14).
  if (c.tipo === 'pacote') {
    await entregarPacote(at, c.pacotes);
    return;
  }

  if (c.tipo === 'senha') {
    // Ele repetiu de volta o usuário que MANDAMOS. Não é senha — é o formato
    // idêntico dos dois (codigo.js: `rrtt9255` é login, `z23trzqx` é senha) se
    // fazendo passar por entrega. Cai no caminho de problema, que é humano.
    const eco = at.usuario && String(c.senha).toLowerCase() === String(at.usuario).toLowerCase();
    if (!eco) {
      await entregarSenha(at, c.senha);
      return;
    }
  }

  // ── O repertório ────────────────────────────────────────
  //
  // Antes de traduzir e chamar uma pessoa: dá para responder isto sozinho,
  // com uma linha que o dono escreveu e aprovou? A tentativa vem cedo porque
  // as perguntas dele são repetitivas — "manda o usuário", "o aparelho está
  // aí?" — e cada uma dessas virava uma decisão no WhatsApp do operador.
  //
  // O que decide NÃO responder é o freio de turnos: passou do teto, o
  // ping-pong provavelmente travou, e mais uma resposta automática só afunda.
  const respondeu = await tentarResponder(at, entrada.texto);
  if (respondeu) return;

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

  // Filtra ANTES de o operador ler, e não só na saída.
  //
  // `politica.paraCliente` existia e nunca era chamada em src/. Nada vazava por
  // acaso: o único texto que saía era um alfanumérico. Mas o que o operador
  // lia era a tradução CRUA — com `¥70` e link da loja de origem dentro — e o
  // #enviar mandava exatamente aquilo. Ele aprovava sem ter como saber que
  // estava aprovando o preço de custo.
  //
  // Filtrando aqui, o que ele lê é o que o cliente vai ler. O original fica em
  // `origem` para depurar tradução ruim.
  const seguro = politica.paraCliente(traduzido);

  const aprovacao = {
    id: proximoId(),
    atendimentoId: at.id,
    cliente: at.nome,
    from: at.from,
    origem: entrada.texto,
    texto: seguro.texto,
    flags: seguro.flags,
    precisaRevisao: seguro.precisaRevisao,
    criadoEm: Date.now(),
  };
  dados.aprovacoes.push(aprovacao);

  // Histórico: o tradutor sabe consumir e ninguém alimentava.
  //
  // `fila.registrar` estava escrito, testado e nunca chamado, então
  // `at.historico` era sempre [] e o tradutor traduzia cada mensagem sozinha,
  // sem saber do que a conversa tratava. É a diferença entre traduzir "有货" e
  // traduzir "有货" sabendo que a pergunta foi sobre estoque.
  fila.registrar(at.id, 'vendedor', entrada.texto, seguro.texto);

  // Turno contado, que também estava morto: `at.turnos` era sempre 0, o
  // PONTE_MAX_TURNOS era config sem efeito, e o #destravar dizia "atendimento
  // parado" para todo atendimento, inclusive os que estavam indo bem.
  const turno = fila.contarTurno(at.id);

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
  //
  // `seguro.texto` e não `traduzido`: o operador tem que ler EXATAMENTE o que o
  // cliente leria com um #enviar. Mostrar a tradução crua aqui e filtrar só na
  // saída faria ele aprovar uma coisa e o cliente receber outra.
  const avisos = [];
  if (seguro.precisaRevisao) {
    // O que ele precisa saber ANTES de digitar #enviar, em português de gente.
    // A flag crua ("preco_cny") não diz nada a quem está no celular.
    if (seguro.flags.includes('preco_cny')) avisos.push('Tinha um valor aqui — conferir antes.');
    if (seguro.flags.includes('decisao_comercial')) avisos.push('Isso é decisão sua, não só tradução.');
    if (seguro.flags.includes('sobrou_original')) avisos.push('A tradução ficou incompleta.');
  }
  // Passou do teto de idas e vindas: provavelmente travou e continuar mandando
  // não resolve. É o freio que o PONTE_MAX_TURNOS prometia e nunca aplicou.
  if (turno.estourou) {
    avisos.push(`Já são ${turno.turnos} idas e vindas — talvez seja hora de você assumir.`);
  }

  await alertar(
    `Cliente: *${at.nome}* · usuário \`${at.usuario}\`\n💬 ${seguro.texto}` +
      (avisos.length ? `\n\n⚠️ ${avisos.join(' ')}` : ''),
    entrada.printPath,
  );
}

/**
 * O jogo do pedido, em chinês, para a linha `qual_jogo` do repertório.
 *
 * Devolve null com facilidade, e isso é o certo: sem o nome do jogo a linha
 * não fica disponível, o repertório não casa e o operador assume. Chutar um
 * jogo para o fornecedor é pedir a conta errada.
 *
 * @returns {Promise<string|null>}
 */
async function jogoDoPedido(atendimento) {
  try {
    // require aqui dentro: vendas → tools → ponte fecharia um ciclo no topo.
    const pedidos = await require('../vendas').pedidosDoTelefone(atendimento.from);
    const itens = pedidos[0]?.items || pedidos[0]?.order_items || [];
    const nome = itens[0]?.product_name || itens[0]?.name || itens[0]?.product?.name;
    if (!nome) return null;

    // `tradutor.paraFornecedor` estava pronto, testado, com glossário
    // comercial, e nunca tinha sido chamado — era a direção de ida que
    // faltava. Aqui ele traduz UM nome de produto, não uma frase livre.
    const { traducao, confianca } = await tradutor.paraFornecedor(nome, atendimento.historico || []);
    const zh = String(traducao || '').trim();

    // Confiança baixa não sai. Nome de jogo traduzido errado faz o fornecedor
    // separar outro título, e isso só aparece quando o cliente reclama.
    if (!zh || confianca === 'baixa') return null;
    return zh;
  } catch (err) {
    console.warn('[ponte] não consegui identificar o jogo do pedido:', err.message);
    return null;
  }
}

/**
 * Tenta responder ao fornecedor com uma linha do repertório.
 *
 * @returns {Promise<boolean>} true se resolveu (respondeu ou decidiu não
 *   responder de propósito). false devolve o caso ao caminho humano.
 *
 * A ordem das travas é a regra:
 *
 *  1. O freio de turnos vem PRIMEIRO. Passou do teto, nada automático sai —
 *     nem uma linha do repertório. Seis idas e vindas sem resolver significa
 *     que a conversa saiu do trilho, e é aí que a resposta automática mais
 *     atrapalha.
 *  2. Padrão determinístico antes do modelo. O que ele já escreveu antes casa
 *     de graça, sem token e sem alucinação.
 *  3. Slot que não dá para preencher derruba a linha. Melhor congelar do que
 *     mandar `{jogo}` literal.
 *  4. `politica.paraFornecedor` na saída, dentro do despachar.
 */
async function tentarResponder(atendimento, textoDele) {
  if (!cfg.repertorioLigado) return false;

  // 1. O freio.
  if ((atendimento.turnos || 0) >= cfg.fila.maxTurnos) {
    console.log(`[ponte] ${atendimento.turnos} turnos — não respondo mais sozinho`);
    return false;
  }

  // 2. Escolhe a linha. Padrão primeiro; o modelo só para o que sobrou.
  let linha = repertorio.porPadrao(textoDele);
  if (!linha) {
    linha = await escolherComModelo(textoDele);
    if (!linha) return false; // fora do repertório: congela e chama o operador
  }

  // Linha que existe para NÃO responder. O "稍等" dele não pede resposta —
  // pede que o cliente saiba que está andando.
  if (linha.resposta === null) {
    if (linha.avisarCliente) {
      try {
        await sender.send(atendimento.from, linha.avisarCliente);
      } catch (err) {
        console.error('[ponte] não avisei o cliente:', err.message);
      }
    }
    fila.registrar(atendimento.id, 'vendedor', textoDele, `(${linha.id})`);
    console.log(`[ponte] repertório: ${linha.id} — não respondo, avisei o cliente`);
    return true;
  }

  // 3. Preenche os marcadores. Falta um, a linha não vale.
  const contexto = { usuario: atendimento.usuario };
  if ((linha.precisa || []).includes('jogo')) {
    contexto.jogo = await jogoDoPedido(atendimento);
  }

  const { texto, faltou } = repertorio.preencher(linha, contexto);
  if (!texto) {
    console.log(`[ponte] repertório: ${linha.id} sem ${faltou.join(', ')} — deixo para o operador`);
    return false;
  }

  fila.registrar(atendimento.id, 'vendedor', textoDele, `(${linha.id})`);
  await despachar(atendimento, {
    tipo: 'responder_fornecedor',
    textoZh: texto,
    rotulo: linha.situacao,
  });
  console.log(`[ponte] repertório: respondendo com "${linha.id}"`);
  return true;
}

/**
 * Pergunta ao modelo qual linha do repertório descreve a mensagem dele.
 *
 * O modelo devolve UM NÚMERO e nada mais. Não existe caminho por onde algo
 * gerado chegue ao fornecedor: o que sai é sempre uma linha de repertorio.js.
 *
 * E o prompt não recebe NADA do cliente — nem nome, nem telefone, nem e-mail,
 * nem o pedido. Só a mensagem dele e a lista de situações. É a trava mais
 * barata que existe: dado que não entra não vaza.
 */
async function escolherComModelo(textoDele) {
  try {
    const msg = await require('../ai').chat(
      [{ role: 'user', content: repertorio.montarPrompt(textoDele) }],
      { maxTokens: 2000 },
    );
    const linha = repertorio.lerEscolha(msg.content);
    if (!linha) console.log('[ponte] repertório: nada casou — deixo para o operador');
    return linha;
  } catch (err) {
    // Modelo fora do ar não pode virar resposta errada ao fornecedor. Sem
    // escolha, o caso segue para o humano, que é o comportamento de sempre.
    console.warn('[ponte] repertório: não consegui classificar:', err.message);
    return null;
  }
}

/** Entrega o código ao cliente, encerra a vez e chama o próximo. */
async function entregarCodigo(atendimento, cod) {
  // Assinada: é a mensagem que o cliente guarda e printa, o momento de maior
  // valor percebido do atendimento inteiro.
  await sender.send(
    atendimento.from,
    marca.assinar(
      `Chegou o código da sua conta:\n\n*${cod}*\n\n` +
        `Digita ele na tela de verificação. Se der erro ou expirar, me avisa que peço outro 👍`,
    ),
  );

  console.log(`[ponte] código ${cod} entregue a ${atendimento.from} (${atendimento.usuario})`);
  limites.registrarSucesso();

  await fila.concluir(atendimento.id, 'codigo_entregue');
  await promoverProximo();
}

/**
 * Nome do jogo em português, ou null.
 *
 * O nome vem em chinês, e chinês no número comercial entrega a origem igual à
 * palavra "fornecedor" — o limparAlerta apagaria os caracteres na saída e o
 * operador leria "Jogo:" seguido de nada. Por isso a tradução acontece aqui, e
 * o que não traduz some junto com o rótulo.
 *
 * Falhou o tradutor, ou sobrou caractere original, devolve null: uma linha a
 * menos é melhor que uma linha que não diz nada.
 */
async function nomeDoJogo(bruto) {
  const original = String(bruto || '').trim();
  if (!original) return null;
  if (!politica.temCJK(original)) return original; // já veio em alfabeto latino

  try {
    const { traducao } = await tradutor.paraCliente(original, []);
    const limpo = String(traducao || '').trim();
    return limpo && !politica.temCJK(limpo) ? limpo : null;
  } catch {
    return null;
  }
}

/** Quantos pacotes cabem num alerta de WhatsApp sem virar parede de texto. */
const PACOTES_NO_ALERTA = 3;

/**
 * Conta + senha + jogo: a entrega completa, o formato mais comum dele.
 *
 * Libera a vez ANTES do operador agir, de propósito. A resposta chegou — o que
 * falta é conferência humana, e prender a fila nisso faria o próximo cliente
 * esperar por uma pessoa em vez de esperar pelo fornecedor. O cliente da vez
 * não fica no escuro: recebe o aviso de que já chegou.
 */
async function entregarPacote(atendimento, pacotes) {
  const lista = Array.isArray(pacotes) ? pacotes : [];
  if (!lista.length) return;

  const mostrar = lista.slice(0, PACOTES_NO_ALERTA);
  const jogos = await Promise.all(mostrar.map((p) => nomeDoJogo(p.jogo)));

  const linhas = [`📦 Entrega recebida — cliente *${atendimento.nome}*`, ''];

  if (lista.length === 1) {
    linhas.push(`Conta: \`${mostrar[0].conta}\``, `Senha: \`${mostrar[0].senha}\``);
    if (jogos[0]) linhas.push(`Jogo: ${jogos[0]}`);
  } else {
    // Ele já mandou 100 contas de uma vez (19/08). Nesse caso a mensagem NÃO é
    // resposta para quem está na vez, e o operador precisa ver isso na primeira
    // linha — não descobrir depois de mandar a conta errada para alguém.
    linhas.push(`Vieram *${lista.length}* contas de uma vez:`, '');
    mostrar.forEach((p, i) => {
      linhas.push(`${i + 1}) \`${p.conta}\` · senha \`${p.senha}\`${jogos[i] ? ` — ${jogos[i]}` : ''}`);
    });
    if (lista.length > mostrar.length) {
      linhas.push(`_(mostrando as ${mostrar.length} primeiras de ${lista.length})_`);
    }
  }

  linhas.push(
    '',
    lista.length === 1
      ? 'Confere e manda para o cliente.'
      : 'Confere qual é a do pedido e manda para o cliente.',
    '_Já liberei a vez para o próximo._',
  );

  await alertar(linhas.join('\n'));
  await encerrarComEntrega(atendimento);
}

/**
 * Senha sozinha na mensagem, sem o 密码 do pacote.
 *
 * Mostra o usuário junto porque é ele que dá sentido à senha — e porque é a
 * conferência que o operador faz de graça: usuário e senha iguais significa que
 * ele devolveu o que mandamos, não que entregou algo.
 */
async function entregarSenha(atendimento, senha) {
  await alertar(
    [
      `🔑 Senha recebida — cliente *${atendimento.nome}*`,
      '',
      `Usuário: \`${atendimento.usuario || '(não registrado)'}\``,
      `Senha: \`${senha}\``,
      '',
      'Confere e manda para o cliente.',
      '_Já liberei a vez para o próximo._',
    ].join('\n'),
  );
  await encerrarComEntrega(atendimento);
}

/**
 * Fecha a vez de quem recebeu uma entrega que ainda passa por humano.
 *
 * O aviso ao cliente não é gentileza: sem ele o atendimento é concluído em
 * silêncio, o próximo da fila recebe "chegou sua vez" e quem estava sendo
 * atendido fica sem nenhum sinal — esperando algo que agora depende de uma
 * pessoa conferir. Não promete prazo, porque quem cumpre o prazo é o operador.
 */
async function encerrarComEntrega(atendimento) {
  try {
    await sender.send(
      atendimento.from,
      'Chegou o retorno da sua conta! Só vou conferir uma coisa aqui e já te mando 👍',
    );
  } catch (err) {
    // O aviso é secundário; a fila destravar é o que não pode falhar.
    console.error('[ponte] não avisei o cliente da entrega:', err.message);
  }

  console.log(`[ponte] entrega recebida para ${atendimento.from} — vez encerrada`);
  limites.registrarSucesso();

  await fila.concluir(atendimento.id, 'entrega_recebida');
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
    // Só no tipo responder_fornecedor. Vai como null nos outros para o braço
    // não ter como mandar texto num fluxo que não pede texto.
    textoZh: t.tipo === 'responder_fornecedor' ? t.textoZh || null : null,
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

// ── Vigia da coleta ───────────────────────────────────────────
//
// O bot já sabia quando o outro serviço falou pela última vez, mas essa
// informação só aparecia se alguém digitasse #fila. Quem some às 3 da manhã
// só era descoberto pelo cliente reclamando — e "trabalhando", "caído" e
// "travado" ficavam idênticos até alguém perguntar.
//
// Estado em memória de propósito: depois de um deploy do bot, o certo é
// esperar o outro serviço aparecer, não herdar um alerta velho de disco.
let coletaMuda = false;

// Qual era o último sinal quando o alerta saiu.
//
// A volta é provada por um carimbo NOVO, não por um limiar de tempo. Com dois
// tetos, comparar idade contra teto fazia o "de volta" sair sem nada ter
// voltado: bastava a fila esvaziar, o teto subir de 2 para 6 min, e a mesma
// idade de 5 min que tinha disparado o alarme passava a contar como saudável.
let coletaMudaEm = 0;

// Dois tetos, e a diferença é o cliente.
//
// Com alguém esperando código, cada minuto parado é um minuto de cliente no
// vácuo: 2 min. Sem ninguém na fila, o silêncio quase sempre é deploy do
// outro serviço — build da imagem mais o Chrome abrindo passa fácil de 3 min,
// e alarme em todo deploy treina o operador a ignorar alarme. Aí 6 min.
//
// O ciclo lá fora bate aqui a cada 25s no ocioso e a cada 6s com cliente
// esperando, então mesmo o teto curto tem folga de sobra.
const SEM_SINAL_OCIOSO_MS = 6 * 60 * 1000;
const SEM_SINAL_COM_FILA_MS = 2 * 60 * 1000;

async function vigiarColeta() {
  const visto = dados.coletaVistaEm || 0;

  // Nunca conectou não é o mesmo que sumiu. Bot recém-subido ainda não viu
  // ninguém, e alertar aqui seria alarme em todo deploy. Quem cobre esse caso
  // é o #fila, que sabe distinguir "nunca conectou" de "chave recusada".
  if (!visto) return;

  const idade = Date.now() - visto;
  const esperando = Boolean(fila.ativo());
  const teto = esperando ? SEM_SINAL_COM_FILA_MS : SEM_SINAL_OCIOSO_MS;

  if (idade > teto && !coletaMuda) {
    coletaMuda = true;
    coletaMudaEm = visto;
    const min = Math.round(idade / 60000);
    const s = fila.situacao();
    await alertar(
      `🔌 *Coleta sem sinal há ${min} min.*\n\n` +
        (s.ativo
          ? `Tem *${s.ativo.cliente}* esperando código agora.`
          : 'Ninguém esperando no momento.') +
        `\n\nConfere o serviço no painel. Enquanto ela não voltar, código não sai.`,
    );
    return;
  }

  // Avisar que VOLTOU importa tanto quanto avisar que caiu: sem isso você fica
  // olhando o painel sem saber se já pode parar. Uma batida nova é a prova —
  // relógio passando não é.
  if (coletaMuda && visto > coletaMudaEm) {
    coletaMuda = false;
    await alertar('🔌 *Coleta de volta.* Os envios seguem normalmente.');
  }
}

async function tick() {
  try {
    await vigiarColeta();

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

/**
 * Este número é o operador COM o modo teste ligado?
 *
 * Exportado para o handlers: o #teste promete que "suas mensagens normais
 * entram como se fossem de um cliente", e com BOT_AUTOREPLY=false isso era
 * falso — o handler retornava antes de qualquer coisa e nem o #inicio era
 * lido. Sem isto, testar o fluxo de vendas obrigaria a ligar a resposta
 * automática para a loja INTEIRA.
 */
function operadorEmTeste(from) {
  return Boolean(from && cfg.operador.ehOperador(from) && emTeste(from));
}

/**
 * O atendimento automático está no ar?
 *
 * `dados.botLigado` (comando #bot) VENCE a variável de ambiente. Enquanto
 * ninguém tiver usado o comando, ele é undefined e vale o BOT_AUTOREPLY — sem
 * isso, um deploy novo desfaria silenciosamente um "#bot off" dado às 22h.
 */
/**
 * Modo em vigor: 'copiloto' (tudo espera #ok) ou 'autopiloto' (sai sozinho).
 *
 * `dados.modo` (comando #auto) VENCE a variável de ambiente, pela mesma razão
 * do #atender: mudar isso no painel exige deploy, e a decisão de parar de
 * aprovar um a um costuma ser tomada no meio de um atendimento.
 */
function modoAtual() {
  return dados.modo === 'autopiloto' || dados.modo === 'copiloto' ? dados.modo : cfg.modo;
}

function atendimentoLigado() {
  if (dados.botLigado === true || dados.botLigado === false) return dados.botLigado;
  // config RAIZ, não o da ponte: `cfg` aqui é ./config (ponte/config.js), que
  // não tem autoReply — usar ele devolvia undefined, e undefined não é false.
  // O bot seguiria respondendo com a variável desligada.
  return require('../config').autoReply;
}

module.exports = {
  modoAtual,
  despachar,
  operadorEmTeste,
  atendimentoLigado,
  pedirCodigo,
  receberDoFornecedor,
  entregarCodigo,
  proximaTarefa,
  devolverTarefa,
  resultadoTarefa,
  bloqueioDetectado,
  promoverProximo,
  alertar,
  alertarHandoff,
  iniciar,
  tick,
  ativa,
  salvarImagem,
};
