'use strict';

/**
 * Recepção do pedido de código — sem passar pela IA.
 *
 * POR QUE NÃO USAR A IA: com BOT_AUTOREPLY=false o handlers retorna antes de
 * chamar ai.reply(), então a ferramenta pedir_codigo_fornecedor nunca seria
 * invocada e a ponte ficaria inerte — sem erro, sem log, só silêncio.
 *
 * E, mesmo com autoreply ligado, detectar aqui é melhor: o pedido é
 * estereotipado (foto + usuário), então não há julgamento a fazer. Regra
 * determinística não custa token, não alucina e não muda de ideia.
 *
 * ── O FLUXO GUIADO ──────────────────────────────────────────
 *
 *   cliente: preciso do código
 *   bot:     manda a foto da tela do console na página de verificação
 *   cliente: [foto]
 *   bot:     agora o login/usuário
 *   cliente: rsd32
 *   bot:     [dispara o pedido ao fornecedor]
 *
 * Uma coisa de cada vez, de propósito: pedir as duas juntas faz o cliente
 * mandar uma e esquecer a outra, e aí alguém tem que cobrar do mesmo jeito.
 *
 * O fluxo LIVRE continua valendo em paralelo — quem já conhece manda a foto e
 * o usuário direto, sem passar pelo tutorial, e isso funciona igual.
 *
 * O GATILHO É ESTREITO DE PROPÓSITO. Fora do fluxo guiado, só dispara com algo
 * que se parece de verdade com usuário de conta: mistura letra e dígito, até 20
 * caracteres. "oi", "obrigado" ou "quero um jogo" não disparam.
 */

const codigo = require('./codigo');
const cfg = require('./config');
const janela = require('./janela');
const marca = require('./marca');
const { dados, persist, emTeste } = require('./estado');

/** Quanto tempo uma metade do pedido espera pela outra. */
const VALIDADE_MS = 10 * 60 * 1000;

/**
 * Intervalo mínimo para repetir a mesma instrução.
 *
 * Cliente confuso manda "codigo" cinco vezes seguidas; sem isto ele recebe
 * cinco tutoriais idênticos e acha que está falando com um robô quebrado.
 */
const REPETIR_APOS_MS = 30 * 1000;

function pendentes() {
  if (!dados.pendentes) dados.pendentes = {};
  return dados.pendentes;
}

function limparVencidos() {
  const p = pendentes();
  const agora = Date.now();
  let mudou = false;
  for (const [from, item] of Object.entries(p)) {
    if (agora - item.em > VALIDADE_MS) {
      delete p[from];
      mudou = true;
    }
  }
  if (mudou) persist();
}

/** minúsculo e sem acento, para o texto do cliente casar com as regras. */
function normalizar(txt) {
  return String(txt || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // tira os acentos que o NFD separou
    .trim();
}

/**
 * Assuntos em que "código" NÃO é o código de verificação do console.
 * Sem isto, "quanto custa o codigo do fifa" abriria o fluxo do fornecedor.
 */
const OUTRO_CODIGO = /(barras|cupom|desconto|rastrei|promo|nota fiscal|compr|quanto|preco|valor|vende)/;

/** Verbos que confirmam pedido quando a frase é longa demais para ser óbvia. */
const VERBO_DE_PEDIDO = /(precis|quero|queria|manda|envia|passa|cade|aguard|esper|verific|nao chegou|nao veio|falta)/;

/**
 * O cliente está pedindo o código de verificação?
 *
 * Frase curta com "código" já basta — é literalmente o que ele digita ("codigo
 * pfv"). Frase longa precisa de um verbo de pedido, senão qualquer conversa que
 * mencione código de jogo abriria o fluxo.
 *
 * Falso positivo aqui custa barato: o bot pede um print e o cliente diz que não
 * era isso. NADA vai para o fornecedor antes de foto + usuário chegarem.
 */
function pedeCodigo(texto) {
  const t = normalizar(texto);
  if (!/(codigo|code)/.test(t)) return false;
  if (OUTRO_CODIGO.test(t)) return false;
  const palavras = t.split(/\s+/).filter(Boolean).length;
  if (palavras <= 4) return true;
  return VERBO_DE_PEDIDO.test(t);
}

// Curtas de propósito. Cliente no meio de uma compra lê a primeira linha e
// age; parágrafo faz ele parar para entender e perguntar de novo.
// Cabeçalho SÓ aqui: esta é a primeira mensagem do atendimento, a que abre a
// conversa e posiciona quem está falando. As seguintes não repetem — ver
// marca.js para o motivo.
/**
 * O prazo, em minutos, do jeito que o cliente lê.
 *
 * Sai do próprio VALIDADE_MS e não de um número escrito à mão: com dois lugares
 * dizendo a mesma coisa, um deles fica velho quando o prazo muda — e aí a
 * mensagem promete 10 minutos e o sistema esquece em 5.
 */
const MINUTOS = Math.round(VALIDADE_MS / 60000);

// O PRAZO é dito em voz alta.
//
// Ele expirava calado: o cliente lia "manda a foto da tela do console",
// levantava para buscar o console, voltava 12 minutos depois e mandava a foto —
// e a metade guardada já tinha sumido. O fluxo recomeçava do zero sem nada
// explicando por quê, e do lado de lá parecia que o bot tinha esquecido dele.
//
// Dizer o prazo não faz ninguém andar mais rápido, mas transforma "o bot me
// ignorou" em "passou do tempo, mando de novo" — e a segunda frase tem saída.
const MSG_PEDE_FOTO = marca.abertura(
  'Vou pegar seu código! Preciso de *2 coisas* 👇\n\n' +
    '1️⃣ *Foto da tela do console*, na página que está pedindo o código.\n\n' +
    `_Tem ${MINUTOS} minutos para mandar. Se passar, é só escrever *preciso do código* que a gente recomeça._`,
);

// SEMPRE O PRIMEIRO LOGIN, e isso precisa estar escrito.
//
// Quem já comprou mais de uma vez tem vários logins no histórico da conversa, e
// manda o ÚLTIMO — que é o que aparece primeiro quando ele rola para cima, e é
// o errado. Com o login errado o pedido sai, o outro lado responde código de
// outra conta, e o erro só aparece na tela do cliente lá na frente.
const MSG_PEDE_USUARIO =
  'Foto recebida ✅\n\n' +
  '2️⃣ Agora o *login/usuário* da conta — só o usuário, *nunca a senha*.\n\n' +
  'É *sempre o PRIMEIRO login* que você recebeu da gente, igual à imagem.';

const MSG_USUARIO_INVALIDO =
  'Não entendi o usuário 🤔\n\n' +
  'Manda ele *sozinho*, sem mais nada junto, tipo: `rrrtsr223`\n\n' +
  'É o *PRIMEIRO login* que você recebeu, igual à imagem.';

/** Qual imagem acompanha cada instrução. Nome, não bytes: quem lê o disco é o handlers. */
const EXEMPLO_DO_AVISO = {
  foto: 'console',
  usuario: 'login',
  // No erro é onde a imagem mais vale: ele já tentou e errou, então repetir só
  // o texto é repetir o que não funcionou.
  invalido: 'login',
};

/** Quantos erros de login antes de chamar gente. */
const ERROS_ATE_CHAMAR_GENTE = 2;

/**
 * Acabamos de dizer ISTO para este cliente?
 *
 * A comparação é por mensagem, não por "respondi há pouco": o fluxo avança
 * rápido (tutorial → foto → usuário em segundos) e um bloqueio geral engoliria
 * o passo seguinte, deixando o cliente esperando uma instrução que nunca vem.
 * Só a repetição idêntica é ruído.
 */
function repetiuAgora(item, aviso) {
  return (
    !!item?.avisadoEm &&
    item.ultimoAviso === aviso &&
    Date.now() - item.avisadoEm < REPETIR_APOS_MS
  );
}

/**
 * Decide o que fazer com uma mensagem recebida.
 *
 * @param {string} from    número do cliente
 * @param {string} texto   texto da mensagem (pode ser a legenda da foto)
 * @param {string|null} imagem  nome do arquivo salvo, se veio foto
 * @returns {{acao:'ignorar'}
 *          |{acao:'pedir', usuario:string, imagem:string|null}
 *          |{acao:'responder', mensagem:string}}
 */
function avaliar(from, texto, imagem) {
  if (!cfg.ativa) return { acao: 'ignorar' };

  // O operador tem os comandos dele; não entra pelo fluxo de cliente — a não
  // ser que tenha ligado o modo teste com #teste, para conferir o passo a passo
  // do próprio celular. O prazo vence sozinho (ver operador.js).
  if (cfg.operador.ehOperador(from) && !emTeste(from)) {
    return { acao: 'ignorar' };
  }

  limparVencidos();

  const p = pendentes();
  const bruto = String(texto || '').trim();
  const guardado = p[from];

  // O texto é um usuário? Aceita tanto puro ("rrrtsr223") quanto dentro de
  // frase curta ("meu usuario e rrrtsr223").
  const v = codigo.validarUsuario(bruto);
  const temMisturaLetraDigito = /[A-Za-z]/.test(bruto) && /\d/.test(bruto);

  // Dentro do fluxo guiado a exigência cai: a mensagem anterior do bot foi
  // literalmente "manda o usuário", então uma palavra solta e válida É o
  // usuário, mesmo sem dígito. Fora do fluxo continua exigindo a mistura, senão
  // "obrigado" viraria login de conta.
  const guiado = guardado?.etapa === 'usuario';
  const usuario =
    v.valido && (temMisturaLetraDigito || guiado)
      ? v.usuario
      : codigo.extrairUsuario(bruto);

  const responder = fazerResponder(from);

  const disparar = (u, img) => {
    delete p[from];
    persist();
    return { acao: 'pedir', usuario: u, imagem: img };
  };

  // ── Caso 1: veio foto E usuário na mesma mensagem ──────────
  if (imagem && usuario) return disparar(usuario, imagem);

  // ── Caso 2: veio usuário e já havia foto guardada ──────────
  if (usuario && guardado?.imagem) return disparar(usuario, guardado.imagem);

  // ── Caso 3: veio foto e já havia usuário guardado ──────────
  if (imagem && guardado?.usuario) return disparar(guardado.usuario, imagem);

  // ── Caso 4: veio a foto que pedimos no fluxo guiado ────────
  // Só aqui a foto ganha resposta. Fora do fluxo ela é guardada calada (Caso 7).
  if (imagem && guardado?.etapa === 'foto') {
    return responder('usuario', MSG_PEDE_USUARIO, { imagem, etapa: 'usuario' });
  }

  // ── Caso 5: veio só o usuário ──────────────────────────────
  if (usuario) {
    return responder(
      'foto',
      'Anotei o usuário! Manda também o *print da tela de verificação* que eu ' +
        'pego seu código 👍',
      { usuario, imagem: null, etapa: 'foto' }
    );
  }

  // ── Caso 6: "preciso do código" — abre o fluxo guiado ───────
  if (!imagem && pedeCodigo(bruto)) return abrir(from, responder, guardado);

  // ── Caso 7: veio só a foto, sem fluxo aberto ───────────────
  //
  // O fluxo real é FOTO PRIMEIRO, usuário depois. Então guardamos a foto
  // sempre, mesmo sem conversa prévia sobre código — a versão anterior exigia
  // contexto anterior e por isso descartava a primeira metade de todo pedido.
  //
  // Mas guardamos em SILÊNCIO. Assim uma foto solta de quem está só perguntando
  // preço de jogo não recebe um "manda o usuário" sem sentido. Se o usuário
  // chegar em até 10 minutos, o Caso 2 fecha o par; se não chegar, a foto
  // expira e nada aconteceu.
  if (imagem) {
    p[from] = { ...(guardado || {}), imagem, em: Date.now() };
    persist();
    return { acao: 'ignorar' };
  }

  // ── Caso 8: pedimos o usuário e veio outra coisa ───────────
  // Só corrige dentro do fluxo guiado: aqui o bot acabou de pedir o login, então
  // texto curto que não validou é tentativa errada, não papo novo.
  if (guardado?.etapa === 'usuario' && bruto && bruto.length <= 40) {
    const erros = (guardado.errosUsuario || 0) + 1;

    // DOIS erros e alguém de verdade assume.
    //
    // O "não entendi o usuário" repetia sem fim. Quem errou duas vezes não vai
    // acertar na terceira — vai errar de novo, cansar e sumir, levando junto uma
    // venda que já estava paga. E a foto dele já está aqui: o operador olha,
    // vê o login na tela e resolve em dez segundos.
    //
    // A contagem vem ANTES do repetiuAgora de propósito: mandar a MESMA coisa
    // errada duas vezes seguidas é o caso mais claro de alguém travado, e era
    // justamente o que o anti-repetição engolia.
    if (erros >= ERROS_ATE_CHAMAR_GENTE) {
      const tinhaFoto = Boolean(guardado.imagem);
      delete p[from];
      persist();
      return {
        acao: 'humano',
        motivo: `nao conseguiu mandar o login (${erros} tentativas)${tinhaFoto ? ', a foto ja esta aqui' : ''}`,
      };
    }

    if (repetiuAgora(guardado, 'invalido')) return { acao: 'ignorar' };
    return responder('invalido', MSG_USUARIO_INVALIDO, { errosUsuario: erros });
  }

  return { acao: 'ignorar' };
}

/**
 * Grava o passo em que o cliente está e devolve a resposta pronta.
 *
 * Era uma closure dentro do avaliar. Virou função de módulo porque agora tem
 * DOIS jeitos de começar o fluxo — escrever "preciso do código" e tocar na
 * opção do menu — e os dois precisam gravar e responder igual.
 *
 * A IMAGEM DE EXEMPLO acompanha a instrução, uma por etapa. "Manda a foto da
 * tela do console" é claro para quem já sabe qual tela é, e ambíguo para todo o
 * resto: vem a caixa do jogo, a tela inicial, o menu de contas. "Manda o login"
 * tem a mesma ambiguidade de outra forma — quem comprou várias vezes tem vários
 * logins e escolhe o último. A imagem responde antes de a pergunta existir.
 */
function fazerResponder(from) {
  const p = pendentes();
  return (aviso, mensagem, estado) => {
    p[from] = {
      ...(p[from] || {}),
      ...estado,
      em: Date.now(),
      avisadoEm: Date.now(),
      ultimoAviso: aviso,
    };
    persist();
    return { acao: 'responder', mensagem, exemplo: EXEMPLO_DO_AVISO[aviso] || null };
  };
}

/**
 * Abre o passo a passo: pede a foto, ou pula para o login se a foto já veio.
 *
 * Separado porque tem dois jeitos de chegar aqui e os dois têm que dizer a
 * mesma coisa. Dois textos parecidos em dois lugares é como um deles fica velho
 * — foi o que aconteceu com o aviso de horário.
 */
function abrir(from, responder, guardado) {
  // Já mandou a foto antes de pedir? Pula direto para o login.
  if (guardado?.imagem) {
    if (repetiuAgora(guardado, 'usuario')) return { acao: 'ignorar' };
    return responder('usuario', MSG_PEDE_USUARIO, { etapa: 'usuario' });
  }
  if (repetiuAgora(guardado, 'foto')) return { acao: 'ignorar' };

  // HORÁRIO só quando está mesmo fora do ar.
  //
  // Antes ia junto com a janela ABERTA também: um aviso de que o sistema para
  // às 15h e volta às 17h, colado no pedido da foto. A intenção era boa, mas o
  // efeito foi o oposto — muita gente leu o horário como se estivesse fechado
  // AGORA e parou de mandar a foto, ou perguntou se ia demorar duas horas.
  //
  // Quem está sendo atendido dentro do horário não tem o que fazer com o
  // horário. Fechado, o aviso diz quando volta e em quanto tempo, que é a única
  // pergunta que a pessoa tem naquele momento.
  const j = janela.estado();
  const msg = j.aberta ? MSG_PEDE_FOTO : `${MSG_PEDE_FOTO}

_${j.avisoCliente}_`;
  return responder('foto', msg, { usuario: null, imagem: null, etapa: 'foto' });
}

/**
 * Começa o passo a passo sem o cliente precisar digitar a frase.
 *
 * Quem toca em "Preciso de um código de segurança" no menu JÁ DISSE o que quer.
 * Responder pedindo que ele escreva "preciso do código" era fazer a mesma
 * pergunta duas vezes, e ainda por cima de um jeito que dá para errar: a frase
 * tinha que passar pelo reconhecedor, e quem escreve "queria o codgio" fica de
 * fora.
 */
function iniciarFluxo(from) {
  if (!cfg.ativa) return { acao: 'ignorar' };
  limparVencidos();
  return abrir(from, fazerResponder(from), pendentes()[from]);
}

/**
 * Marca que o cliente está no assunto "código", para a foto seguinte valer.
 * Chamado quando o humano/IA identifica o contexto e quer abrir a janela.
 */
function abrirJanela(from) {
  const p = pendentes();
  p[from] = p[from] || { usuario: null, imagem: null };
  p[from].etapa = p[from].etapa || 'foto';
  p[from].em = Date.now();
  persist();
}

/** Quantos pedidos estão pela metade agora (para o #fila). */
function emEspera() {
  limparVencidos();
  return Object.entries(pendentes()).map(([from, i]) => ({
    from,
    tem: i.usuario ? 'usuário' : i.imagem ? 'foto' : 'nada',
    esperando: i.etapa === 'foto' ? 'a foto' : i.etapa === 'usuario' ? 'o usuário' : null,
    desde: i.em,
  }));
}

module.exports = { avaliar, abrirJanela, iniciarFluxo, emEspera, pedeCodigo, VALIDADE_MS };
