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
  const { from, text, pushName } = msg;
  const trimmed = (text || '').trim();
  const lower = trimmed.toLowerCase();
  console.log(`[msg] de ${from} (${pushName || '?'}): ${trimmed}`);

  // Auto-resposta DESLIGADA (BOT_AUTOREPLY=false): o bot não RESPONDE no 1-a-1
  // (um humano atende). Mas marca o contato como engajado, pra a RECUPERAÇÃO DE
  // VENDA ainda cutucar quem mandou mensagem e sumiu. Não envia nada agora.
  if (!config.autoReply) {
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
  if (!trimmed) return;

  // ─── 4) Todo o resto → IA (conversa livre; ela transfere p/ atendente se preciso) ───
  try {
    const answer = await ai.reply(from, trimmed, pushName);
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
