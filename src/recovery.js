'use strict';

/**
 * RECUPERAÇÃO DE VENDA — cutuca quem engajou na conversa e sumiu.
 *
 * A cada `checkIntervalMs`, varre os contatos e envia um lembrete leve para
 * quem: (a) já conversou com a IA (contact.engaged), (b) NÃO está com atendente
 * (contact.paused), (c) está em silêncio há tempo suficiente para o próximo
 * estágio e (d) ainda não esgotou as cutucadas. Cliente que responde zera o
 * ciclo (handlers reseta followupCount). Contato sumido há muito tempo
 * (> staleAfterMs) é abandonado sem cutucar.
 *
 * Todo envio passa pela fila anti-ban do sender.js (delays, "digitando...").
 * Não cutuca em horário de silêncio (madrugada, BRT).
 */

const config = require('./config');
const store = require('./store');
const sender = require('./sender');
const variator = require('./variator');

let timer = null;
let running = false;

/** Só o primeiro nome, capitalizado (ou '' se não tiver). */
function firstName(name) {
  const first = String(name || '').trim().split(/\s+/)[0] || '';
  return first ? first.charAt(0).toUpperCase() + first.slice(1) : '';
}

/** Hora atual no fuso de Brasília (UTC-3, sem horário de verão desde 2019). */
function brtHour(now) {
  return (new Date(now).getUTCHours() - 3 + 24) % 24;
}

/** Estamos no intervalo de silêncio (não perturbar de madrugada)? */
function isQuietHour(now) {
  const cfg = config.recovery;
  const h = brtHour(now);
  if (cfg.quietStartHour === cfg.quietEndHour) return false; // sem janela de silêncio
  // Janela que atravessa a meia-noite (ex.: 22h → 8h) vs. janela no mesmo dia.
  return cfg.quietStartHour > cfg.quietEndHour
    ? h >= cfg.quietStartHour || h < cfg.quietEndHour
    : h >= cfg.quietStartHour && h < cfg.quietEndHour;
}

/** Avalia um contato e, se for a hora, enfileira a cutucada (não bloqueia). */
function maybeNudge(id, contact, now) {
  const cfg = config.recovery;
  if (!contact || contact.paused || !contact.engaged) return;

  const count = contact.followupCount || 0;
  if (count >= cfg.stages.length) return; // já esgotou as cutucadas deste ciclo

  const silence = now - (contact.lastSeen || 0);
  if (silence < cfg.stages[count]) return; // ainda não deu o tempo do estágio atual

  if (silence > cfg.staleAfterMs) {
    // Sumiu há tempo demais: desiste do ciclo (marca como esgotado, sem cutucar).
    store.saveContact(id, { followupCount: cfg.stages.length });
    return;
  }

  // Marca ANTES do envio (otimista) para o próximo tick não cutucar de novo.
  store.saveContact(id, { followupCount: count + 1, followupLastAt: now });
  const text = variator.recovery(firstName(contact.name), count);
  sender
    .send(id, text)
    .then(() => console.log(`[recovery] cutucada #${count + 1} enviada para ${id}`))
    .catch((err) => console.error(`[recovery] falha ao cutucar ${id}:`, err.message));
}

function tick() {
  if (running) return; // evita sobreposição de ticks
  running = true;
  try {
    const now = Date.now();
    if (isQuietHour(now)) return; // horário de silêncio: pula o tick inteiro
    for (const [id, contact] of store.allContacts()) {
      try {
        maybeNudge(id, contact, now);
      } catch (err) {
        console.error(`[recovery] erro ao avaliar ${id}:`, err.message);
      }
    }
  } finally {
    running = false;
  }
}

/** Inicia o scheduler (chamado no boot do server). */
function start() {
  const cfg = config.recovery;
  if (!cfg.enabled) {
    console.log('[recovery] desligada (RECOVERY_ENABLED=false)');
    return;
  }
  if (timer) return;
  const stagesMin = cfg.stages.map((ms) => Math.round(ms / 60000)).join('min, ') + 'min';
  console.log(
    `[recovery] ligada — varredura a cada ${Math.round(cfg.checkIntervalMs / 60000)}min; ` +
    `estágios: ${stagesMin}; silêncio ${cfg.quietStartHour}h–${cfg.quietEndHour}h (BRT)`
  );
  timer = setInterval(tick, cfg.checkIntervalMs);
  if (timer.unref) timer.unref(); // não segura o processo vivo à toa
}

function stop() {
  if (timer) { clearInterval(timer); timer = null; }
}

module.exports = { start, stop, tick, isQuietHour };
