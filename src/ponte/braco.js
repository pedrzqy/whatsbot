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
const fs = require('fs');
const path = require('path');
const { dados, persist } = require('./estado');

// Mesma pasta do estado da ponte: e o volume que sobrevive ao deploy.
const DATA_DIR = process.env.PONTE_DATA_DIR || path.join(__dirname, '..', '..', 'data');

const router = express.Router();

/** Toda rota do braço exige a chave. Sem isso, é endpoint aberto para qualquer um. */
router.use((req, res, next) => {
  if (!cfg.bracoApiKey) {
    return res.status(503).json({ erro: 'PONTE_BRACO_KEY não configurada no servidor' });
  }
  if (req.get('x-braco-key') !== cfg.bracoApiKey) {
    // Registra a batida RECUSADA, separada da batida boa.
    //
    // Sem isto, chave errada e serviço fora do ar davam o mesmo "nunca
    // conectou" no #fila — e as duas causas não têm nada em comum: uma se
    // conserta no Environment do painel, a outra é o container que não subiu.
    // Chegar aqui já prova que a rede entre os dois serviços funciona.
    dados.coletaChaveRuimEm = Date.now();
    console.warn('[ponte/braco] chave recusada — PONTE_BRACO_KEY diferente entre os dois serviços?');
    return res.status(401).json({ erro: 'chave inválida' });
  }

  // Marca de vida em QUALQUER rota autenticada, não só no long-poll.
  //
  // Carimbar só /proxima dava falso negativo: na subida o outro serviço fala
  // primeiro com /estado e só depois começa a pedir tarefa — e enquanto o
  // Chrome abre (~30s, mais na primeira vez) o #fila dizia "nunca conectou"
  // com ele perfeitamente conectado. Passar por aqui já é prova de contato:
  // alcançou a rede e a chave bate.
  dados.coletaVistaEm = Date.now();
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
    // O operador pediu para recarregar a tela agora (#recarregar).
    recarregarPedido: Boolean(dados.recarregarPedido),
    // O operador pediu o historico da conversa (#historico). Numero = quantas
    // rolagens para tras; 0/ausente = nao pediu.
    historicoPedido: Number(dados.historicoPedido) || 0,
  });
});

/** O braço avisa que recarregou — limpa o pedido para não repetir em laço. */
router.post('/recarga-feita', (_req, res) => {
  dados.recarregarPedido = false;
  persist();
  res.json({ ok: true });
});

/**
 * O braço entrega o histórico que o operador pediu com #historico.
 *
 * Grava em disco e manda um resumo ao operador. O arquivo inteiro NÃO vai pelo
 * WhatsApp: um mês de conversa passa de qualquer limite de mensagem, e o que o
 * operador precisa saber na hora é só se deu certo e quanto veio.
 *
 * O conteúdo é chinês cru, e é por isso que ele fica em arquivo e não em
 * mensagem: caractere chinês saindo pelo número comercial entrega a origem do
 * código igual à palavra "fornecedor" (ver politica.js).
 */
router.post('/historico', async (req, res) => {
  const mensagens = Array.isArray(req.body?.mensagens) ? req.body.mensagens : [];
  const erro = req.body?.erro ? String(req.body.erro) : '';

  dados.historicoPedido = false;
  persist();

  if (erro || !mensagens.length) {
    await ponte.alertar(
      '📚 *Exportação do histórico falhou.*\n\n' +
        'Não consegui ler a conversa. Tenta de novo mais tarde.',
    );
    console.warn(`[ponte/braco] histórico falhou: ${erro || 'veio vazio'}`);
    return res.json({ ok: false });
  }

  // Nome NEUTRO de propósito. Com 'fornecedor' no nome, o limparAlerta()
  // reescrevia a palavra na mensagem e mandava o operador procurar um
  // arquivo que não existe — o filtro fez o trabalho dele e a mensagem
  // passou a mentir sobre o caminho.
  const arquivo = path.join(DATA_DIR, 'historico-coleta.json');
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(arquivo, JSON.stringify(mensagens, null, 2), 'utf8');
  } catch (err) {
    console.error('[ponte/braco] não gravei o histórico:', err.message);
    await ponte.alertar('📚 Li a conversa mas não consegui gravar o arquivo.');
    return res.json({ ok: false });
  }

  const nossas = mensagens.filter((m) => m.de === 'nos').length;
  const datas = mensagens.map((m) => m.quando).filter(Boolean).sort();
  const periodo =
    datas.length >= 2 ? `${datas[0].slice(0, 10)} a ${datas[datas.length - 1].slice(0, 10)}` : '—';

  console.log(`[ponte/braco] histórico gravado: ${mensagens.length} mensagens em ${arquivo}`);

  await ponte.alertar(
    `📚 *Histórico exportado.*\n\n` +
      `${mensagens.length} mensagens · ${nossas} suas\n` +
      `Período: ${periodo}\n\n` +
      `_Está salvo no servidor, em data/historico-coleta.json._`,
  );

  res.json({ ok: true, gravadas: mensagens.length });
});

/** O braço avisa que consumiu o código — evita reusar um já gasto. */
router.post('/sms-usado', (_req, res) => {
  if (dados.smsTaobao) {
    delete dados.smsTaobao;
    persist();
  }
  res.json({ ok: true });
});

/**
 * Próxima tarefa de envio. 204 quando não há nada a fazer.
 *
 * ATENDE EM LONG-POLLING: com ?espera=25 a resposta fica pendurada até 25s
 * esperando surgir tarefa, e volta no instante em que o operador dá #ok.
 *
 * Antes o braço perguntava e dormia até 110s, então um #ok podia levar quase
 * dois minutos só para ser NOTADO. Segurar aqui não custa risco nenhum: esta
 * conversa é entre o bot e o braço, a Taobao não vê nada dela. O ritmo humano
 * que importa é o das ações no navegador, e esse continua igual.
 */
router.get('/proxima', async (req, res) => {
  const pegar = () => {
    if (limites.disjuntor().estado === 'aberto') return null;
    if (!janela.estado().aberta) return null;
    return ponte.proximaTarefa();
  };

  const espera = Math.min(Math.max(Number(req.query.espera) || 0, 0), 30) * 1000;
  const limite = Date.now() + espera;

  // Se o braço desistir no meio, para de segurar em vez de escrever no vazio.
  let vivo = true;
  req.on('close', () => { vivo = false; });

  for (;;) {
    if (!vivo) break;

    const t = pegar();
    if (t) {
      // proximaTarefa() já marcou 'executando'. Se a conexão morreu no meio
      // do caminho, a tarefa ficaria com dono nenhum para sempre — devolve.
      if (!vivo) { ponte.devolverTarefa(t.id); break; }
      return res.json(t);
    }

    if (Date.now() >= limite) break;
    await new Promise((r) => setTimeout(r, 500));
  }

  if (vivo) res.status(204).end();
});

/** Resultado de um envio. */
router.post('/resultado', async (req, res) => {
  const { id, ok, erro, printPath, fatal } = req.body || {};
  if (!id) return res.status(400).json({ erro: 'id obrigatório' });
  const r = await ponte.resultadoTarefa(id, Boolean(ok), erro, printPath, Boolean(fatal));
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
