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

/**
 * Ajusta a formatação pro padrão do WhatsApp.
 *
 * Duas coisas, e as duas são a mesma ideia: consertar na PORTA o que o modelo
 * escreve por hábito, em vez de torcer para que ele lembre da regra.
 *
 * 1. Negrito é UM asterisco (*assim*), não dois. Modelo solta **markdown** e
 *    ele aparece literal no chat.
 *
 * 2. TRAVESSÃO. Ninguém digita "—" no WhatsApp: não está no teclado do
 *    celular. Ele é a assinatura mais óbvia de texto gerado, e o cliente
 *    percebe antes de saber por quê. Vira vírgula, que é o que uma pessoa
 *    escreveria no mesmo lugar — em português a pausa do travessão é quase
 *    sempre apositiva, e a vírgula ocupa o mesmo papel sem chamar atenção.
 *
 * O travessão no COMEÇO da linha é outro caso: ali ele é marca de fala, e o
 * que uma pessoa faria é simplesmente não usar. Some.
 */
function normalizeWhatsApp(text) {
  return String(text == null ? '' : text)
    .replace(/\*{2,}/g, '*')
    // Começo de linha: some junto com o espaço que vem depois.
    .replace(/^[ \t]*[—–][ \t]*/gm, '')
    // No meio da frase: vira vírgula. O espaço antes some para não ficar " ,".
    .replace(/\s*[—–]\s*/g, ', ')
    // "R$ 49,90, , o link" acontece quando já havia vírgula antes do travessão.
    .replace(/,\s*,/g, ',');
}

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
  const normalizado = normalizeWhatsApp(text);
  // Registra ANTES de enfileirar: o webhook do próprio envio pode voltar antes
  // de a promessa resolver, e aí o bot leria a própria mensagem como se fosse
  // o operador digitando.
  registrarEnvioDoBot(normalizado);
  return new Promise((resolve, reject) => {
    queue.push({ number, text: normalizado, opts, resolve, reject });
    if (!running) run();
  });
}

// ── Quem digitou: o bot ou uma pessoa? ──────────────────────────────
//
// Toda mensagem que sai do nosso número volta no webhook com fromMe=true, e
// pelo evento não dá para saber se foi o bot ou o operador digitando no
// celular. A diferença importa: quando é gente, o bot precisa sair da frente.
//
// Guardamos o TEXTO do que o bot manda, por pouco tempo. Comparar texto basta
// aqui — a chance de o operador digitar, no mesmo minuto, exatamente a frase
// que o bot acabou de enviar é nula, e o pior caso desse erro seria não pausar
// uma vez.
//
// Guardar o id da mensagem seria mais exato, mas send() devolve boolean e o id
// só existe dentro do cliente da Evolution: mudança bem maior para o mesmo
// resultado prático.
const JANELA_ECO_MS = Number(process.env.SENDER_ECO_MS || 120_000);
const enviadosPeloBot = new Map();

const chaveEco = (texto) => String(texto || '').trim().slice(0, 160);

function registrarEnvioDoBot(texto) {
  const agora = Date.now();
  enviadosPeloBot.set(chaveEco(texto), agora);
  // Limpa o que envelheceu: sem isto o Map cresce para sempre num processo que
  // fica semanas no ar.
  for (const [k, t] of enviadosPeloBot) {
    if (agora - t > JANELA_ECO_MS) enviadosPeloBot.delete(k);
  }
}

/** Este texto foi o próprio bot que mandou agora há pouco? */
function foiDoBot(texto) {
  const t = enviadosPeloBot.get(chaveEco(texto));
  return Boolean(t && Date.now() - t <= JANELA_ECO_MS);
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

  const evoOpts = opts.instance ? { instance: opts.instance } : {};

  // 3) Simulação de digitação.
  if (opts.typing !== false) {
    try { await evolution.sendPresence(number, 'composing', evoOpts); } catch { /* não bloqueia o envio */ }
    await sleep(typingDurationMs(text));
    try { await evolution.sendPresence(number, 'paused', evoOpts); } catch { /* idem */ }
  }

  // 4) Envio.

  // REGISTRA DE NOVO, no instante em que a mensagem vai sair.
  //
  // Ela ja foi registrada no send(), e aquilo continua necessario: o eco do
  // WhatsApp pode voltar antes de a promessa resolver. O problema e que o
  // relogio da janela de 2 minutos comecava a correr ali, na hora de ENTRAR NA
  // FILA -- e a fila e lenta de proposito (ritmo humanizado: espera, reacao,
  // "digitando..."). No pior caso sao ~33s por mensagem, entao da QUARTA em
  // diante o registro ja tinha vencido quando o envio acontecia.
  //
  // O sintoma era exatamente este: o bot mandava a boas-vindas, o menu e mais
  // uma, e ao ver o eco da ultima nao se reconhecia. Concluia que o operador
  // tinha digitado, PAUSAVA o contato e mandava "Nosso suporte entrou no chat"
  // sem ninguem ter entrado. O cliente ficava esperando um atendente que nao
  // existia, e o bot calado.
  //
  // Registrando aqui, os 2 minutos passam a contar do envio, que e o unico
  // instante de que o eco depende.
  registrarEnvioDoBot(text);

  //
  // LISTA primeiro, quando pedida. Ela passa pelo Baileys, que reimplementa um
  // formato não documentado do WhatsApp — o suporte muda entre versões da
  // Evolution e some sem aviso. Por isso a falha aqui NUNCA propaga: cai no
  // texto numerado, que é o menu que sempre funcionou, e o cliente nem percebe
  // que existiam duas formas. Quebrar o menu quebra a porta de entrada
  // inteira, e nenhum ganho de conversão paga isso.
  if (opts.list) {
    try {
      await evolution.sendList(number, opts.list, evoOpts);
      const tl = Date.now();
      lastGlobalSendAt = tl;
      lastContactSendAt.set(number, tl);
      return;
    } catch (err) {
      console.warn(`[sender] lista falhou (${err.response?.status || '?'}) — mandando o menu em texto`);
    }
  }

  // ARQUIVO → documento. Sempre lança quando falha, sem cair para texto.
  //
  // Quem manda arquivo quer o arquivo. Cair para texto aqui entregaria uma
  // mensagem solta no lugar do anexo, e quem pediu ficaria achando que
  // recebeu — pior que o erro, porque some silenciosamente.
  if (opts.document) {
    await evolution.sendMedia(
      number,
      {
        mediatype: 'document',
        media: opts.document,
        caption: text,
        fileName: opts.fileName || 'arquivo',
      },
      evoOpts,
    );
    const td = Date.now();
    lastGlobalSendAt = td;
    lastContactSendAt.set(number, td);
    return;
  }

  // Com imagem → card de mídia. Se opts.imageOnly, NÃO cai pra texto (lança).
  if (opts.image) {
    try {
      await evolution.sendMedia(
        number,
        { mediatype: 'image', media: opts.image, caption: text, fileName: opts.fileName },
        evoOpts,
      );
    } catch (err) {
      if (opts.imageOnly) throw err; // só imagem: se falhar, não manda texto
      // Loga o corpo do erro, não só o status: com base64 o motivo do 400 vem
      // no payload da Evolution, e sem ele o diagnóstico vira adivinhação.
      const detalhe = err.response?.data
        ? JSON.stringify(err.response.data).slice(0, 300)
        : err.message;
      console.warn(`[sender] mídia falhou (${err.response?.status || '?'}): ${detalhe}`);
      await evolution.sendText(number, text, evoOpts);
    }
  } else {
    await evolution.sendText(number, text, evoOpts);
  }

  const t = Date.now();
  lastGlobalSendAt = t;
  lastContactSendAt.set(number, t);
}

module.exports = { send, typingDurationMs, registrarEnvioDoBot, foiDoBot,
  // Exportada para o teste: e ela que tira o travessao e o markdown do
  // que sai, e sem alcanca-la o teste dublaria justamente a funcao que
  // deveria estar medindo.
  normalizeWhatsApp,
};
