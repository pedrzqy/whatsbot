'use strict';

/**
 * Armazenamento simples de contatos, persistido em arquivo JSON.
 * Guarda, por número, quem já foi saudado e quando interagiu pela última vez.
 *
 * Para escala/produção no Square Cloud, dá para trocar por Redis (já provisionado
 * para a Evolution) sem mudar a interface: getContact / saveContact.
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'contacts.json');

/** @type {Record<string, {firstSeen:number,lastSeen:number,greetedAt:number,name?:string}>} */
let contacts = {};
let saveTimer = null;

function load() {
  try {
    if (fs.existsSync(FILE)) {
      contacts = JSON.parse(fs.readFileSync(FILE, 'utf8')) || {};
    }
  } catch (err) {
    console.error('[store] falha ao carregar contatos:', err.message);
    contacts = {};
  }
}

function persist() {
  // Debounce: agrupa gravações em rajada.
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(FILE, JSON.stringify(contacts), 'utf8');
    } catch (err) {
      console.error('[store] falha ao salvar contatos:', err.message);
    }
  }, 500);
}

function getContact(id) {
  return contacts[id] || null;
}

function saveContact(id, patch) {
  contacts[id] = { ...(contacts[id] || {}), ...patch };
  persist();
  return contacts[id];
}

load();

module.exports = { getContact, saveContact };
