'use strict';

const express = require('express');
const config = require('./config');
const handlers = require('./handlers');
const recovery = require('./recovery');
const community = require('./community');
const evolution = require('./evolution');
const ponte = require('./ponte');
const bracoRouter = require('./ponte/braco');

const app = express();
// 12mb: a foto do cliente chega em base64 pela rota do braço, e base64 infla ~33%.
app.use(express.json({ limit: '12mb' }));

// Health check (Square Cloud / uptime)
app.get('/', (_req, res) => res.json({ ok: true, service: 'whatsbot' }));

// Rotas consumidas pelo braço Python que opera o app da Taobao.
app.use('/ponte/braco', bracoRouter);

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

    // Ignora status/transmissões e newsletters.
    const remoteJid = key.remoteJid || '';
    if (/@broadcast$|@newsletter$/i.test(remoteJid)) return;

    const message = data.message || {};
    const text =
      message.conversation ||
      message.extendedTextMessage?.text ||
      // Foto com legenda: o texto do cliente vem no caption, não em conversation.
      message.imageMessage?.caption ||
      '';

    // GRUPOS: o agente de comunidade (Fase 2) decide se responde. Ele só age se as
    // respostas estiverem ligadas e for o grupo certo; senão, ignora. (Por padrão a
    // Evolution nem entrega msgs de grupo — groupsIgnore=true.) O fluxo 1-a-1 fica intacto.
    if (/@g\.us$/i.test(remoteJid)) {
      const ctx = message.extendedTextMessage?.contextInfo || {};
      await community.handleGroupMessage({
        groupJid: remoteJid,
        participant: (key.participant || '').replace('@s.whatsapp.net', ''),
        text,
        pushName: data.pushName,
        mentionedJids: ctx.mentionedJid || [],
      });
      return;
    }

    // IMAGEM (só no 1-a-1, depois do desvio de grupos): a Evolution entrega
    // apenas os metadados no webhook e o binário é baixado sob demanda. Só
    // baixamos com a ponte ativa — não vale pagar o download em toda foto que
    // chega no atendimento normal de vendas.
    let imagem = null;
    if (message.imageMessage && ponte.ativa()) {
      try {
        const midia = await evolution.getBase64FromMediaMessage(data);
        imagem = await ponte.salvarImagem(midia.base64, midia.mimetype);
      } catch (err) {
        console.error('[webhooks/evolution] falha ao baixar imagem:', err.response?.status || err.message);
      }
    }

    await handlers.onIncomingMessage({
      from: (key.remoteJid || '').replace('@s.whatsapp.net', ''),
      text,
      imagem,
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

const server = app.listen(config.port, () => {
  console.log(`whatsbot rodando na porta ${config.port}`);
  if (!config.autoReply) console.log('[bot] AUTO-RESPOSTA DESLIGADA (BOT_AUTOREPLY=false) — não responde no 1-a-1');
  recovery.start(); // recuperação de venda: cutuca quem sumiu no meio da conversa
  community.start(); // agente de comunidade: posta conteúdo no grupo (Fase 1: só saída)
  ponte.iniciar(); // ponte com o fornecedor da Taobao (fila serial + braço robô)
});

// Socket ocioso vive 65s, não os 5s do padrão.
//
// O braço faz long-poll no /ponte/braco/proxima e trabalha entre uma chamada e
// outra: abrir a conversa, clicar, conferir o título. Com 5s o servidor
// descartava o socket nesse intervalo e a chamada seguinte morria com "socket
// hang up" — o braço nunca recebia tarefa e ficava reabrindo a conversa em
// laço, sem nada no log além do aviso.
//
// headersTimeout precisa ser MAIOR que keepAliveTimeout: se for menor, o Node
// derruba a conexão enquanto ainda espera os cabeçalhos e o problema volta com
// outra cara.
server.keepAliveTimeout = 65_000;
server.headersTimeout = 70_000;
