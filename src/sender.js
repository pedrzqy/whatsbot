'use strict';

/**
 * Envio humanizado (anti-ban). TODA mensagem do bot deve passar por aqui.
 *
 * Garantias:
 *  - Fila serializada: nunca dispara mensagens em paralelo/rajada.
 *  - Atraso de "reação" aleatório antes de começar a digitar (2–6s).
 *  - Simulação de digitação ("digitando...") no ritmo de N letras/seg.
 *  - Espaçamento entre mensagens do mesmo contato (3–10s).
 *  - Espaçamento global entre contatos diferentes (5–15s).
 *
 * Todos os tempos são configuráveis em config.pacing.
 */

const config = require('./config');
const evolution = require('./evolution');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (min, max) => Math.floor(min + Math.random() * (max - min));

/** @type {Array<{number:string,text:string,opts:object,resolve:Function,reject:Function}>} */
const queue = [];
let running = false;
let lastGlobalSendAt = 0;
const lastContactSendAt = new Map();

/** Tempo de digitação proporcional ao tamanho do texto (com limites). */
function typingDurationMs(text) {
  const p = config.pacing;
  const ms = (String(text).length / p.charsPerSecond) * 1000;
  return Math.min(Math.max(ms, p.typingMinMs), p.typingMaxMs);
}

/**
 * Enfileira uma mensagem para envio humanizado.
 * @param {string} number  número do destinatário
 * @param {string} text    texto a enviar
 * @param {{reaction?:boolean, typing?:boolean}} [opts]
 * @returns {Promise<boolean>} resolve quando a mensagem realmente sai
 */
function send(number, text, opts = {}) {
  return new Promise((resolve, reject) => {
    queue.push({ number, text, opts, resolve, reject });
    if (!running) run();
  });
}

async function run() {
  running = true;
  while (queue.length) {
    const job = queue.shift();
    try {
      await processJob(job);
      job.resolve(true);
    } catch (err) {
      job.reject(err);
    }
  }
  running = false;
}

async function processJob(job) {
  const p = config.pacing;
  const { number, text, opts } = job;

  // 1) Espaçamento: respeita o maior entre o gap do mesmo contato e o gap global.
  const now = Date.now();
  const sameContactReady = (lastContactSendAt.get(number) || 0) + rand(p.consecutiveMinMs, p.consecutiveMaxMs);
  const globalReady = lastGlobalSendAt + rand(p.crossContactMinMs, p.crossContactMaxMs);
  const waitUntil = Math.max(sameContactReady, globalReady, now);
  if (waitUntil > now) await sleep(waitUntil - now);

  // 2) "Reação": pausa antes de começar a digitar (após receber a mensagem).
  if (opts.reaction !== false) {
    await sleep(rand(p.reactionMinMs, p.reactionMaxMs));
  }

  // 3) Simulação de digitação.
  if (opts.typing !== false) {
    try { await evolution.sendPresence(number, 'composing'); } catch { /* não bloqueia o envio */ }
    await sleep(typingDurationMs(text));
    try { await evolution.sendPresence(number, 'paused'); } catch { /* idem */ }
  }

  // 4) Envio.
  await evolution.sendText(number, text);

  const t = Date.now();
  lastGlobalSendAt = t;
  lastContactSendAt.set(number, t);
}

module.exports = { send, typingDurationMs };
