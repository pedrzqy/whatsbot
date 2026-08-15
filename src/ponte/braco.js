'use strict';

/**
 * Rotas HTTP que o braço Python consome.
 *
 * O braço roda em outro processo (e provavelmente em outra máquina — a VPS com
 * ADB para o cloud phone), então a comunicação é por polling HTTP simples. Não
 * há WebSocket nem fila externa de propósito: o braço faz uma ação a cada
 * dezenas de segundos, e polling nesse ritmo é mais simples de operar e de
 * depurar do que qualquer coisa persistente.
 */

const express = require('express');
const cfg = require('./config');
const ponte = require('./index');
const fila = require('./fila');
const limites = require('./limites');
const janela = require('./janela');
const midia = require('./midia');
const { dados, persist } = require('./estado');

const router = express.Router();

/** Toda rota do braço exige a chave. Sem isso, é endpoint aberto para qualquer um. */
router.use((req, res, next) => {
  if (!cfg.bracoApiKey) {
    return res.status(503).json({ erro: 'PONTE_BRACO_KEY não configurada no servidor' });
  }
  if (req.get('x-braco-key') !== cfg.bracoApiKey) {
    return res.status(401).json({ erro: 'chave inválida' });
  }
  next();
});

/**
 * O braço pergunta se pode agir agora. Junta três respostas numa chamada só
 * para o braço não precisar de três round-trips a cada ciclo.
 */
router.get('/estado', (_req, res) => {
  const j = janela.estado();
  const d = limites.disjuntor();
  res.json({
    podeAgir: j.aberta && d.estado === 'fechado',
    janelaAberta: j.aberta,
    esperaMinutos: j.esperaMinutos,
    disjuntor: d.estado,
    motivoDisjuntor: d.motivo,
    chatTitulo: cfg.vendedor.chatTitulo,
    // Só faz sentido ler o chat se alguém está esperando resposta.
    temAtendimentoAtivo: Boolean(fila.ativo()),
    // Código SMS que o operador mandou com #taobao, aguardando o braço usar.
    smsTaobao: dados.smsTaobao?.codigo || null,
  });
});

/** O braço avisa que consumiu o código — evita reusar um já gasto. */
router.post('/sms-usado', (_req, res) => {
  if (dados.smsTaobao) {
    delete dados.smsTaobao;
    persist();
  }
  res.json({ ok: true });
});

/** Próxima tarefa de envio. 204 quando não há nada a fazer. */
router.get('/proxima', (_req, res) => {
  const d = limites.disjuntor();
  if (d.estado === 'aberto') return res.status(204).end();
  if (!janela.estado().aberta) return res.status(204).end();

  const t = ponte.proximaTarefa();
  if (!t) return res.status(204).end();

  res.json(t);
});

/** Resultado de um envio. */
router.post('/resultado', async (req, res) => {
  const { id, ok, erro, printPath } = req.body || {};
  if (!id) return res.status(400).json({ erro: 'id obrigatório' });
  const r = await ponte.resultadoTarefa(id, Boolean(ok), erro, printPath);
  res.json(r);
});

/**
 * Mensagens NOVAS do fornecedor.
 *
 * O braço só manda o que veio DEPOIS da marca d'água registrada no envio. Ele
 * nunca varre o histórico: o chat tem meses de conversa visível, e ler tudo
 * viraria centenas de "códigos novos" na primeira execução.
 */
router.post('/entrada', async (req, res) => {
  const mensagens = Array.isArray(req.body?.mensagens) ? req.body.mensagens : [];
  res.json({ ok: true, recebidas: mensagens.length }); // responde já, processa depois

  for (const m of mensagens) {
    const texto = String(m?.texto || '').trim();
    if (!texto) continue;
    try {
      await ponte.receberDoFornecedor({ texto, printPath: m.printPath });
    } catch (err) {
      console.error('[ponte/braco] falha ao processar entrada:', err.message);
    }
  }
});

/**
 * Alerta com imagem vinda do braço (print de tela).
 *
 * Existe por um motivo concreto: dentro do container não há tela para escanear
 * o QR do login da Taobao. O braço tira o print e manda para o operador, que
 * escaneia com o iPhone. Mesmo caminho serve para print de erro e de captcha.
 *
 * A Evolution aceita base64 direto no campo `media`, então não precisa
 * hospedar arquivo em lugar nenhum.
 */
router.post('/alerta', async (req, res) => {
  const { texto, imagemBase64 } = req.body || {};
  res.json({ ok: true });
  if (!texto) return;

  // Base64 PURO, sem prefixo data:. A Evolution rejeita o data URI com 400 —
  // foi o que derrubou o primeiro envio do QR e fez o sender cair no fallback
  // de só texto, que para um QR é inútil.
  const imagem = imagemBase64
    ? String(imagemBase64).replace(/^data:[^;]+;base64,/, '')
    : undefined;

  await ponte.alertar(texto, imagem, 'ponte.jpg');
});

/** O braço viu captcha / logout / conta sinalizada. Congela tudo. */
router.post('/bloqueio', async (req, res) => {
  const { motivo, imagemBase64 } = req.body || {};
  res.json({ ok: true });

  const imagem = imagemBase64
    ? String(imagemBase64).replace(/^data:[^;]+;base64,/, '')
    : undefined;

  await ponte.bloqueioDetectado(motivo || 'verificação anti-bot detectada', imagem);
});

/**
 * Serve a foto do cliente para o braço baixar.
 *
 * O braço roda noutra máquina (a VPS com ADB), então não enxerga o disco do
 * bot: ele pega a imagem por aqui, empurra para a galeria do celular e anexa
 * no chat.
 */
router.get('/midia/:nome', (req, res) => {
  const { nome } = req.params;
  if (!midia.existe(nome)) return res.status(404).json({ erro: 'arquivo não encontrado' });
  res.sendFile(midia.caminho(nome));
});

/** Log estruturado do braço — é aqui que se descobre que a Taobao mudou a UI. */
router.post('/evento', (req, res) => {
  const { nivel, etapa, detalhe } = req.body || {};
  const linha = `[braço/${nivel || 'info'}] ${etapa}: ${detalhe}`;
  if (nivel === 'error') console.error(linha);
  else if (nivel === 'warn') console.warn(linha);
  else console.log(linha);
  res.json({ ok: true });
});

module.exports = router;
