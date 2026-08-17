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
const recepcao = require('./ponte/recepcao');
const ponte = require('./ponte');

// Palavras que reativam o autoatendimento quando o cliente está com um humano.
const RESUME = new Set(['#inicio', '#início', 'inicio', 'início', 'menu', 'voltar', 'atendimento', 'recomecar', 'recomeçar']);

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
  const { from, text, pushName, imagem } = msg;
  const trimmed = (text || '').trim();
  const lower = trimmed.toLowerCase();
  console.log(`[msg] de ${from} (${pushName || '?'}): ${trimmed}${imagem ? ' [+foto]' : ''}`);

  // ─── 0) Comandos do operador da ponte (só do número configurado) ───
  // Vem antes de tudo: quando a Taobao pede verificação, o operador precisa
  // destravar em segundos, e não pode esbarrar em boas-vindas ou pausa.
  if (operador.ehComando(from, trimmed)) {
    try {
      await sender.send(from, await operador.executar(trimmed), { typing: false });
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
  if (!config.autoReply && !ponte.operadorEmTeste(from)) {
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
  if (welcome.shouldWelcome(contact)) {
    ai.clearHistory(from);
    store.saveContact(from, {
      firstSeen: contact?.firstSeen || now,
      greetedAt: now,
      paused: false,
      ...nameFields,
    });
    const greeting = await welcome.buildGreeting(pushName);
    await sender.send(from, greeting);
    return;
  }

  // ─── 2) Palavras de recomeço (#inicio/menu/voltar) — barato, sem IA ───
  if (RESUME.has(lower)) {
    store.saveContact(from, { paused: false, followupCount: 0, ...nameFields });
    await sender.send(from, variator.resumed());
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
  // Foto sem legenda ainda é mensagem: o cliente manda a imagem do produto e
  // pergunta depois. Sem isto, a foto seria descartada antes de chegar na IA.
  if (!trimmed && !imagem) return;

  // ─── 4) Todo o resto → IA (conversa livre; ela transfere p/ atendente se preciso) ───
  try {
    const texto = trimmed || '(o cliente mandou uma foto sem escrever nada)';
    const answer = await ai.reply(from, texto, pushName, { imagem });
    await sender.send(from, answer);
  } catch (err) {
    console.error('[ai] erro ao responder:', err.response?.data || err.message);
    await sender.send(from, variator.error());
  }
}

/**
 * @param {object} event  Payload da Nerix { event, created_at, data }
 */
async function onNerixEvent(event) {
  const { event: name, data } = event;
  console.log(`[nerix] evento ${name} — pedido ${data?.order_number}`);

  switch (name) {
    case 'order.paid':
      // TODO: notificar cliente no WhatsApp que o pagamento foi confirmado
      break;
    case 'order.delivered':
      // TODO: enviar a(s) product_key(s) para o cliente
      break;
    case 'order.cancelled':
      // TODO: avisar cancelamento/expiração
      break;
    default:
      break;
  }
}

module.exports = { onIncomingMessage, onNerixEvent };
