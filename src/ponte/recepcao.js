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
const { dados, persist } = require('./estado');

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

const MSG_PEDE_FOTO =
  'Pra pegar o código eu preciso de *2 coisas*, uma de cada vez 👇\n\n' +
  '1️⃣ Manda a *foto da tela do console*, na página onde ele está pedindo o ' +
  'código de verificação.';

const MSG_PEDE_USUARIO =
  'Foto recebida ✅\n\n' +
  '2️⃣ Agora manda o *login/usuário* da conta — só o usuário, *nunca a senha*.';

const MSG_USUARIO_INVALIDO =
  'Não consegui entender o usuário 🤔\n\n' +
  'Manda ele *sozinho*, numa mensagem só — por exemplo: `rrrtsr223`';

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
  if (from === cfg.operador.numero && !(dados.testeOperador?.ate > Date.now())) {
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

  const responder = (aviso, mensagem, estado) => {
    p[from] = {
      ...(p[from] || {}),
      ...estado,
      em: Date.now(),
      avisadoEm: Date.now(),
      ultimoAviso: aviso,
    };
    persist();
    return { acao: 'responder', mensagem };
  };

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
        'peço o código pro fornecedor 👍',
      { usuario, imagem: null, etapa: 'foto' }
    );
  }

  // ── Caso 6: "preciso do código" — abre o fluxo guiado ───────
  if (!imagem && pedeCodigo(bruto)) {
    // Se ele já mandou a foto antes de pedir, pula direto para o usuário.
    if (guardado?.imagem) {
      if (repetiuAgora(guardado, 'usuario')) return { acao: 'ignorar' };
      return responder('usuario', MSG_PEDE_USUARIO, { etapa: 'usuario' });
    }
    if (repetiuAgora(guardado, 'foto')) return { acao: 'ignorar' };

    // Fornecedor offline: avisa ANTES de o cliente juntar print e login, em vez
    // de deixá-lo cumprir as duas etapas para só então descobrir que vai esperar.
    const j = janela.estado();
    const msg = j.aberta ? MSG_PEDE_FOTO : `${MSG_PEDE_FOTO}\n\n_${j.avisoCliente}_`;
    return responder('foto', msg, { usuario: null, imagem: null, etapa: 'foto' });
  }

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
    if (repetiuAgora(guardado, 'invalido')) return { acao: 'ignorar' };
    return responder('invalido', MSG_USUARIO_INVALIDO, {});
  }

  return { acao: 'ignorar' };
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

module.exports = { avaliar, abrirJanela, emEspera, pedeCodigo, VALIDADE_MS };
