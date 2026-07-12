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

const store = require('./store');
const welcome = require('./welcome');
const ai = require('./ai');
const sender = require('./sender');
const variator = require('./variator');
const menu = require('./menu');
const knowledge = require('./knowledge');

// Palavras que voltam ao menu principal / recomeçam o autoatendimento.
const RESET = new Set(['#inicio', '#início', 'inicio', 'início', 'menu', '#menu', 'voltar']);

/**
 * @param {object} msg  Mensagem normalizada { from, text, pushName, raw }
 */
async function onIncomingMessage(msg) {
  const { from, text, pushName } = msg;
  if (!from) return;
  const trimmed = (text || '').trim();
  const lower = trimmed.toLowerCase();
  console.log(`[msg] de ${from} (${pushName || '?'}): ${trimmed}`);

  const contact = store.getContact(from);
  const now = Date.now();
  const nameFields = { lastSeen: now, name: pushName || contact?.name };

  // ─── 1) Boas-vindas / primeiro contato (saudação + menu) ───
  if (welcome.shouldWelcome(contact)) {
    ai.clearHistory(from);
    const greeting = await welcome.buildGreeting(pushName);
    await sender.send(from, greeting);
    await sender.send(from, menu.render('main'));
    store.saveContact(from, {
      firstSeen: contact?.firstSeen || now,
      greetedAt: now,
      menuNode: 'main',
      paused: false,
      ...nameFields,
    });
    return;
  }

  // ─── 2) Voltar ao menu principal ───
  if (RESET.has(lower)) {
    ai.clearHistory(from);
    await sender.send(from, menu.render('main'));
    store.saveContact(from, { menuNode: 'main', paused: false, ...nameFields });
    return;
  }

  // ─── 3) Atendimento humano em andamento → bot fica em silêncio ───
  if (contact?.paused) {
    store.saveContact(from, nameFields);
    return;
  }

  store.saveContact(from, nameFields);
  if (!trimmed) return;

  // ─── 4) Seleção no menu por número ───
  const node = contact?.menuNode;
  if (node && /^\d{1,2}$/.test(trimmed)) {
    const opt = menu.resolve(node, trimmed);
    if (!opt) {
      await sender.send(from, variator.invalidOption());
      await sender.send(from, menu.render(node));
      return;
    }
    if (opt.goto) {
      store.saveContact(from, { menuNode: opt.goto });
      await sender.send(from, menu.render(opt.goto));
      return;
    }
    if (opt.topic) {
      const fact = knowledge[opt.topic];
      const answer = fact ? await ai.humanizeAnswer(fact) : variator.error();
      await sender.send(from, answer);
      return;
    }
    if (opt.action) {
      await handleAction(from, opt.action);
      return;
    }
  }

  // ─── 5) Texto livre → IA com ferramentas (catálogo, pedidos...) ───
  try {
    const answer = await ai.reply(from, trimmed, pushName);
    await sender.send(from, answer);
  } catch (err) {
    console.error('[ai] erro ao responder:', err.response?.data || err.message);
    await sender.send(from, variator.error());
  }
}

/** Executa uma ação do menu (atendente, pedido, comprar). */
async function handleAction(from, action) {
  if (action === 'atendente') {
    store.saveContact(from, { paused: true });
    await sender.send(from, variator.handoff());
    return;
  }
  if (action === 'pedido') {
    await sender.send(from, variator.askOrder());
    return;
  }
  if (action === 'comprar') {
    await sender.send(from, variator.askProduct());
    return;
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
