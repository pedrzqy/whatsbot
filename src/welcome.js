'use strict';

/**
 * Sistema de boas-vindas / primeiro contato.
 *
 * Regras:
 *  - Cliente novo (nunca visto)         → envia boas-vindas.
 *  - Cliente que sumiu por um tempo      → re-saúda (nova conversa).
 *  - Caso contrário                      → não repete a saudação.
 */

const config = require('./config');
const nerix = require('./nerix');
const variator = require('./variator');

// Cache do nome da loja (puxado da Nerix uma vez).
let storeNameCache = null;
async function getStoreName() {
  if (storeNameCache !== null) return storeNameCache;
  try {
    const store = await nerix.getStore();
    storeNameCache = store?.name || store?.data?.name || config.welcome.storeName || 'nossa loja';
  } catch {
    storeNameCache = config.welcome.storeName || 'nossa loja';
  }
  return storeNameCache;
}

/**
 * Decide se deve saudar este contato agora.
 * @param {object|null} contact  registro do store (ou null se novo)
 */
function shouldWelcome(contact) {
  if (!contact || !contact.greetedAt) return true; // nunca saudado
  const gapMs = config.welcome.sessionWindowHours * 60 * 60 * 1000;
  return Date.now() - (contact.lastSeen || 0) > gapMs; // voltou depois do intervalo
}

/** Só o primeiro nome, capitalizado. */
function firstName(pushName) {
  if (!pushName) return null;
  const first = String(pushName).trim().split(/\s+/)[0];
  if (!first) return null;
  return first.charAt(0).toUpperCase() + first.slice(1);
}

/** Monta a saudação personalizada (o menu é enviado logo depois). */
async function buildGreeting(pushName) {
  if (config.welcome.message) return config.welcome.message; // override total via env

  const nome = firstName(pushName);
  const loja = await getStoreName();
  return variator.greeting(nome, loja);
}

module.exports = { shouldWelcome, buildGreeting, getStoreName };
