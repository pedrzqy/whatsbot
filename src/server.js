'use strict';

const express = require('express');
const config = require('./config');
const handlers = require('./handlers');
const recovery = require('./recovery');
const community = require('./community');

const app = express();
app.use(express.json({ limit: '2mb' }));

// Health check (Square Cloud / uptime)
app.get('/', (_req, res) => res.json({ ok: true, service: 'whatsbot' }));

/**
 * Webhook da Evolution API — mensagens recebidas do WhatsApp.
 * Configure na Evolution para POSTar aqui o evento MESSAGES_UPSERT.
 */
app.post('/webhooks/evolution', async (req, res) => {
  res.status(200).send('OK'); // responde já, processa depois

  try {
    const body = req.body || {};
    // A Evolution manda diferentes formatos; tratamos o messages.upsert.
    const data = body.data || body;
    const key = data.key || {};
    if (key.fromMe) return; // ignora mensagens enviadas pelo próprio bot

    // Só atende conversa INDIVIDUAL. Ignora grupos, status/transmissões e newsletters
    // (senão o bot responde grupo e gasta a cota à toa).
    const remoteJid = key.remoteJid || '';
    if (/@g\.us$|@broadcast$|@newsletter$/i.test(remoteJid)) return;

    const message = data.message || {};
    const text =
      message.conversation ||
      message.extendedTextMessage?.text ||
      '';

    await handlers.onIncomingMessage({
      from: (key.remoteJid || '').replace('@s.whatsapp.net', ''),
      text,
      pushName: data.pushName,
      raw: body,
    });
  } catch (err) {
    console.error('[webhooks/evolution] erro:', err.message);
  }
});

/**
 * Webhook da Nerix — eventos de pedido (order.paid, order.delivered, ...).
 * Configure no painel da Nerix com ?secret=SEU_TOKEN.
 */
app.post('/webhooks/nerix', async (req, res) => {
  const { secret } = req.query;
  if (config.webhook.nerixSecret && secret !== config.webhook.nerixSecret) {
    return res.status(401).json({ error: 'Assinatura inválida' });
  }

  res.status(200).send('OK'); // responde em < 5s conforme exigido

  try {
    await handlers.onNerixEvent(req.body || {});
  } catch (err) {
    console.error('[webhooks/nerix] erro:', err.message);
  }
});

app.listen(config.port, () => {
  console.log(`whatsbot rodando na porta ${config.port}`);
  recovery.start(); // recuperação de venda: cutuca quem sumiu no meio da conversa
  community.start(); // agente de comunidade: posta conteúdo no grupo (Fase 1: só saída)
});
