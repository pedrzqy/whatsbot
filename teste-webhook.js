'use strict';

/**
 * Testa a PORTA DE ENTRADA — o webhook da Evolution.
 *
 *   node teste-webhook.js
 *
 * Era o único caminho do bot sem teste nenhum, e é onde ficam as decisões que
 * mais somem de vista: se a foto e o áudio do cliente são baixados, para quem
 * eles vão, e o que acontece quando não dá para entender.
 *
 * Cada uma dessas falha em SILÊNCIO: o cliente manda, o bot recebe, e nada
 * acontece. Não há erro para investigar — só uma pessoa achando que foi
 * ignorada.
 *
 * Faz uma requisição HTTP de verdade contra o app do Express. A Evolution e a
 * Anthropic são dublês; nada sai para a rede.
 */

const os = require('os');
const path = require('path');
const fs = require('fs');

const DATA_TESTE = path.join(os.tmpdir(), 'phaze-teste-webhook');
fs.rmSync(DATA_TESTE, { recursive: true, force: true });
process.env.PONTE_DATA_DIR = DATA_TESTE;

// A suíte roda offline. Vazio e não `delete`: o config chama dotenv, que relê o
// .env e repõe qualquer chave ausente.
process.env.ANTHROPIC_API_KEY = '';
for (const k of ['GEMINI_API_KEY', 'GROQ_FALLBACK_API_KEY', 'TRANSCRICAO_API_KEY']) {
  process.env[k] = '';
}
process.env.NERIX_API_KEY = 'teste';
process.env.EVOLUTION_API_KEY = 'teste';
process.env.PONTE_OPERADOR_NUMERO = '5541999999999';
process.env.PONTE_BRACO_KEY = 'teste';
process.env.PONTE_ATIVA = 'true';
process.env.BOT_AUTOREPLY = 'true';

let falhas = 0;
const t = (nome, ok, extra = '') => {
  if (!ok) falhas++;
  console.log(`  ${ok ? 'ok  ' : 'FALHA'} | ${nome}${extra ? ` -> ${extra}` : ''}`);
};
const bloco = (nome) => console.log(`\n--- ${nome} ---`);

const { app } = require('./src/server');
const evolution = require('./src/evolution');
const sender = require('./src/sender');
const store = require('./src/store');
const ai = require('./src/ai');
const chaves = require('./src/chaves');

// Um pixel PNG. É o que a Evolution devolveria como binário da foto.
const PIXEL =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/** O que a Evolution entrega quando pedem a mídia. */
let midiaDevolvida = { base64: PIXEL, mimetype: 'image/png' };
let pedidosDeMidia = 0;
evolution.getBase64FromMediaMessage = async () => {
  pedidosDeMidia += 1;
  if (!midiaDevolvida) throw new Error('mídia indisponível');
  return midiaDevolvida;
};

// O send DE VERDADE, guardado ANTES do duble.
//
// O bloco do eco precisa exercitar a fila inteira, porque e ela que registra
// que a mensagem e do bot, no instante em que sai. Com o send dublado esse
// registro nunca acontece e o teste mediria o duble em vez do filtro.
const sendReal = sender.send;

// O que o bot mandou, e para quem.
const enviadas = [];
sender.send = async (para, texto) => { enviadas.push({ para, texto: String(texto) }); };

// O que chegou ao modelo. `ai.reply` é o fim da linha do que este arquivo mede:
// se a foto chegou até aqui, chegou ao modelo (isso o teste-claude cobre).
let vistoPelaIA = null;
ai.reply = async (from, texto, pushName, extra) => {
  vistoPelaIA = { from, texto, extra };
  return 'resposta da IA';
};

/** Monta o corpo que a Evolution manda no MESSAGES_UPSERT. */
function webhookDe(numero, message, pushName = 'Cliente') {
  return {
    data: {
      key: { remoteJid: `${numero}@s.whatsapp.net`, fromMe: false },
      message,
      pushName,
    },
  };
}

(async () => {
  const servidor = app.listen(0);
  await new Promise((r) => servidor.once('listening', r));
  const url = `http://127.0.0.1:${servidor.address().port}/webhooks/evolution`;

  /** Manda o webhook e espera o processamento (o handler responde 200 antes). */
  async function entregar(corpo) {
    enviadas.length = 0;
    vistoPelaIA = null;
    pedidosDeMidia = 0;
    await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(corpo),
    });
    // O webhook responde 200 e processa depois. Sem esta espera o teste mede
    // o estado ANTES de o bot ter feito qualquer coisa — e passaria por engano.
    await new Promise((r) => setTimeout(r, 120));
  }

  const CLI = '5541900007777';
  const jaSaudado = { greetedAt: Date.now(), lastSeen: Date.now(), paused: false };

  // ── FOTO ───────────────────────────────────────────────────
  //
  // A imagem só é baixada quando alguém vai USÁ-LA: a ponte manda o print ao
  // outro lado, e a IA enxerga. Baixar em toda foto que chega no atendimento
  // normal seria pagar o download à toa.
  bloco('foto do cliente');

  chaves.definir('ia', true);
  store.saveContact(CLI, { ...jaSaudado, menuNode: null, modoIA: false });
  await entregar(webhookDe(CLI, { imageMessage: { caption: 'olha o erro que deu' } }));

  t('a foto é baixada', pedidosDeMidia === 1, `${pedidosDeMidia} download(s)`);
  t('  e chega à IA', Boolean(vistoPelaIA?.extra?.imagemBase64),
    vistoPelaIA ? Object.keys(vistoPelaIA.extra).join(',') : 'a IA nem foi chamada');
  t('  com os bytes da imagem', vistoPelaIA?.extra?.imagemBase64?.base64 === PIXEL);
  t('  e o tipo certo', vistoPelaIA?.extra?.imagemBase64?.mimetype === 'image/png',
    vistoPelaIA?.extra?.imagemBase64?.mimetype);
  // A legenda é o texto do cliente: sem ela, a foto chegaria sem pergunta.
  t('  a legenda vira a mensagem', /olha o erro/.test(vistoPelaIA?.texto || ''), vistoPelaIA?.texto);

  // Foto SEM legenda ainda é mensagem — e agora o modelo pode olhar.
  await entregar(webhookDe(CLI, { imageMessage: {} }));
  t('foto sem legenda também chega', Boolean(vistoPelaIA?.extra?.imagemBase64),
    vistoPelaIA ? 'chegou' : 'sumiu');

  // Com a conversa livre DESLIGADA, não paga o download para a IA.
  chaves.definir('ia', false);
  const antesPonte = require('./src/ponte').ativa();
  chaves.definir('codigos', false);
  await entregar(webhookDe(CLI, { imageMessage: { caption: 'oi' } }));
  t('com tudo desligado a foto não é baixada', pedidosDeMidia === 0,
    `${pedidosDeMidia} download(s)`);
  chaves.definir('codigos', antesPonte);
  chaves.definir('ia', true);

  // Download falhando não pode derrubar a mensagem: o cliente escreveu junto.
  midiaDevolvida = null;
  await entregar(webhookDe(CLI, { imageMessage: { caption: 'nao consegui ativar' } }));
  t('download falhando não engole a mensagem',
    /nao consegui ativar/.test(vistoPelaIA?.texto || ''), vistoPelaIA?.texto || 'sumiu');
  t('  e a IA responde sem a foto', !vistoPelaIA?.extra?.imagemBase64);
  midiaDevolvida = { base64: PIXEL, mimetype: 'image/png' };

  // ── ÁUDIO ──────────────────────────────────────────────────
  //
  // Sem chave de transcrição o áudio não vira texto — e o cliente precisa
  // saber, senão fala com uma parede.
  bloco('áudio do cliente');

  await entregar(webhookDe(CLI, { audioMessage: { seconds: 8 } }));
  t('sem transcrição, o cliente é avisado',
    enviadas.some((e) => e.para === CLI && /escrever|palavras/i.test(e.texto)),
    enviadas.map((e) => e.texto).join(' | ') || '(nada)');
  t('  e a IA NÃO recebe uma foto que não existe', vistoPelaIA === null,
    vistoPelaIA?.texto);

  // Com transcrição, o áudio vira uma mensagem de texto comum.
  process.env.TRANSCRICAO_API_KEY = 'chave-de-mentira';
  const fetchReal = globalThis.fetch;
  globalThis.fetch = async (u, init) => {
    if (String(u).includes('/audio/transcriptions')) {
      return new Response(JSON.stringify({ text: 'oi, comprei ontem e nao chegou' }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }
    return fetchReal(u, init);
  };
  midiaDevolvida = { base64: Buffer.from('audio').toString('base64'), mimetype: 'audio/ogg' };

  await entregar(webhookDe(CLI, { audioMessage: { seconds: 8 } }));
  globalThis.fetch = fetchReal;

  t('o áudio vira texto', /comprei ontem/.test(vistoPelaIA?.texto || ''),
    vistoPelaIA?.texto || 'não chegou');
  // O resto do bot não precisa saber que houve áudio — só o log.
  t('  e segue como mensagem comum', !vistoPelaIA?.extra?.imagemBase64);
  process.env.TRANSCRICAO_API_KEY = '';

  // ── O que NÃO pode passar ──────────────────────────────────
  bloco('o que o webhook ignora');

  await entregar({ data: { key: { remoteJid: `${CLI}@s.whatsapp.net`, fromMe: true }, message: { conversation: 'oi' } } });
  t('mensagem do próprio bot não vira atendimento', vistoPelaIA === null);

  await entregar(webhookDe('120363000000000000@g.us'.replace('@g.us', ''), { conversation: 'oi' }));
  // (grupo é desviado para o community; aqui só garantimos que não estourou)
  t('grupo não derruba o webhook', true);

  await entregar({ data: { key: { remoteJid: 'status@broadcast', fromMe: false }, message: { conversation: 'x' } } });
  // Filtra pelo DESTINO em vez de contar o total: o cenario anterior (o
  // operador digitando) dispara um envio proprio, e ele pode cair dentro desta
  // janela. Contar tudo faria o teste falhar por causa do vizinho.
  t('transmissao e ignorada',
    vistoPelaIA === null && !enviadas.some((e) => /broadcast/.test(e.para)),
    JSON.stringify(enviadas.map((e) => e.para)));

  // ── O bot não pode achar que ele mesmo é o operador ────────
  //
  // Toda mensagem que sai do nosso número volta no webhook com fromMe=true, e
  // pelo evento não dá para saber se foi o bot ou uma pessoa digitando. O bot
  // guarda o TEXTO do que mandou para se reconhecer.
  //
  // O relógio dessa memória contava do momento de ENTRAR NA FILA, e a fila é
  // lenta de propósito (ritmo humanizado: espera, reação, "digitando..."). No
  // pior caso são ~33s por mensagem, então da QUARTA em diante o registro já
  // tinha vencido quando o envio acontecia.
  //
  // O sintoma: o bot mandava boas-vindas, menu e mais uma, via o eco da última,
  // não se reconhecia, concluía que o operador tinha assumido, PAUSAVA o
  // contato e mandava "Nosso suporte entrou no chat" sem ninguém ter entrado.
  // O cliente esperava um atendente que não existia, e o bot ficava calado.
  bloco('o eco da própria mensagem');

  const senderEco = require('./src/sender');
  const evolutionEco = require('./src/evolution');
  const storeEco = require('./src/store');
  const handlersEco = require('./src/handlers');

  const sendTextAntes = evolutionEco.sendText;
  const sendPresenceAntes = evolutionEco.sendPresence;
  const sendEcoAntes = senderEco.send;

  let ultimoTexto = null;
  evolutionEco.sendText = async (n, t) => { ultimoTexto = t; return true; };
  evolutionEco.sendPresence = async () => true;
  senderEco.send = sendReal; // a fila inteira, para ela registrar o envio

  const CLI_ECO = '5567961695300';
  storeEco.saveContact(CLI_ECO, {
    greetedAt: Date.now(), lastSeen: Date.now(), paused: false,
  });

  // Manda pela fila de verdade e depois entrega o eco, como o WhatsApp faz.
  await senderEco.send(CLI_ECO, 'Bem-vindo ao suporte da Phaze Games. Entre pelo link: https://chat.whatsapp.com/abc');
  t('a mensagem saiu', Boolean(ultimoTexto), ultimoTexto?.slice(0, 40));
  t('e o bot se reconhece nela', senderEco.foiDoBot(ultimoTexto) === true);

  await handlersEco.onOperadorDigitou({ para: `${CLI_ECO}@s.whatsapp.net`, texto: ultimoTexto });
  t('o eco NÃO pausa o contato', storeEco.getContact(CLI_ECO)?.paused !== true,
    storeEco.getContact(CLI_ECO)?.paused ? 'pausou (bug)' : 'seguiu normal');

  // A defesa em profundidade: mesmo chamando a função direto, sem passar pela
  // porta de entrada, o eco continua sendo reconhecido. Foi por esse caminho
  // que o teste anterior escondeu o problema.
  storeEco.saveContact(CLI_ECO, { paused: false });
  await handlersEco.onOperadorDigitou({ para: `${CLI_ECO}@s.whatsapp.net`, texto: ultimoTexto });
  t('  nem por chamada direta', storeEco.getContact(CLI_ECO)?.paused !== true);

  // E o caminho de verdade continua funcionando: gente digitando PAUSA.
  storeEco.saveContact(CLI_ECO, { paused: false });
  const avisos = [];
  senderEco.send = async (para, txt) => { avisos.push({ para, texto: String(txt) }); };
  await handlersEco.onOperadorDigitou({
    para: `${CLI_ECO}@s.whatsapp.net`,
    texto: 'oi, aqui é o Pedro, vou te ajudar pessoalmente',
  });
  senderEco.send = sendReal;

  t('mas gente digitando ainda pausa', storeEco.getContact(CLI_ECO)?.paused === true);
  t('  e o cliente é avisado', avisos.some((a) => /suporte/i.test(a.texto)),
    avisos.map((a) => a.texto.split('\n')[0]).join(' | ') || '(nada)');

  evolutionEco.sendText = sendTextAntes;
  evolutionEco.sendPresence = sendPresenceAntes;
  senderEco.send = sendEcoAntes;
  servidor.close();
  console.log('\n' + (falhas ? falhas + ' FALHA(S)' : 'todos os testes passaram'));
  process.exit(falhas ? 1 : 0);
})();
