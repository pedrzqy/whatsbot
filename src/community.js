'use strict';

/**
 * AGENTE DE COMUNIDADE — posta conteúdo no grupo do WhatsApp.
 *
 * FASE 1 (só SAÍDA, risco baixo): agendador posta, em horários de pico (BRT),
 * um conteúdo rotativo gerado a partir de dados REAIS da Nerix:
 *   - 🏆 Top mais vendidos (products.sales_count)
 *   - 💰 Promoções da loja (promotional_price em produtos/variantes)
 *   - 🎟️ Cupom ativo (coupons públicos, is_active && !is_secret)
 *
 * Segurança: default DESLIGADO + dry-run (loga em vez de enviar). Todo envio passa
 * pela fila anti-ban do sender.js. Não lê mensagens do grupo (isso é Fase 2).
 * Instância/grupo são configuráveis (env) → migrar p/ número dedicado = trocar config.
 */

const fs = require('fs');
const path = require('path');
const config = require('./config');
const nerix = require('./nerix');
const news = require('./news');
const sender = require('./sender');
const variator = require('./variator');
const ai = require('./ai');

const cfg = config.community;
const STORE_URL = config.store.url;

let timer = null;
let running = false;

// ─── Estado persistido (quais slots já postaram + rotação de conteúdo) ───
const DATA_DIR = path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'community.json');
let state = { posts: {}, rotation: 0 };
try {
  if (fs.existsSync(FILE)) state = { posts: {}, rotation: 0, ...JSON.parse(fs.readFileSync(FILE, 'utf8')) };
} catch (err) { console.error('[community] falha ao carregar estado:', err.message); }

function saveState() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(state), 'utf8');
  } catch (err) { console.error('[community] falha ao salvar estado:', err.message); }
}

// ─── Helpers ─────────────────────────────────────────────────────────
const brl = (n) => 'R$ ' + Number(n).toFixed(2).replace('.', ',');

/** Hora atual no fuso de Brasília (UTC-3). */
function brt(now) {
  const d = new Date(now - 3 * 60 * 60 * 1000);
  return { hour: d.getUTCHours(), dateKey: d.toISOString().slice(0, 10) };
}

/** Menor preço válido do produto (considera variantes). */
function lowestPrice(p) {
  const cands = [Number(p.price), ...(p.variants || []).map((v) => Number(v.price))].filter((n) => n > 0);
  return cands.length ? Math.min(...cands) : 0;
}

/** Encurta nomes tipo "Zelda - Mídia Digital - Nintendo Switch" → "Zelda". */
function cleanName(name) {
  return String(name || '')
    .replace(/\s*-\s*m[ií]dia digital.*$/i, '')
    .replace(/\s*-\s*ni?ntendo switch.*$/i, '')
    .trim() || String(name || '').trim();
}

function productLink(slug) {
  return slug && STORE_URL ? `${STORE_URL}/package/${slug}` : STORE_URL;
}

/** URL completa da imagem de um produto da Nerix (caminho relativo → CDN). */
function storeImage(images) {
  const p = Array.isArray(images) ? images[0] : null;
  if (!p) return null;
  return /^https?:\/\//i.test(p) ? p : `https://cdn.nerix.com.br/${String(p).replace(/^\/+/, '')}`;
}

/** Procura o jogo na loja Nerix pelo nome. Retorna { image, link } se achar. */
async function storeMatch(gameName) {
  const nome = (gameName || '').trim();
  if (!nome) return null;
  try {
    const data = await nerix.listProducts({ search: nome, limit: 3 });
    const list = data.data || data || [];
    const hit = list[0];
    if (!hit) return null;
    return { image: storeImage(hit.images), link: productLink(hit.slug) };
  } catch { return null; }
}

// ─── Geradores de conteúdo (retornam texto ou null se não há conteúdo) ──
async function genBestSellers() {
  const prods = await nerix.listProducts();
  const list = Array.isArray(prods) ? prods : (prods.data || []);
  const top = list
    .filter((p) => Number(p.sales_count) > 0)
    .sort((a, b) => Number(b.sales_count) - Number(a.sales_count))
    .slice(0, 5);
  if (!top.length) return null;

  const medals = ['🥇', '🥈', '🥉', '4️⃣', '5️⃣'];
  const linhas = top.map((p, i) => `${medals[i]} ${cleanName(p.name)} — ${brl(lowestPrice(p))}`);
  return (
    `${variator.pick(['🏆 Os *mais vendidos* da Phaze Games agora:', '🔥 O que tá bombando na Phaze Games:', '🏆 Ranking dos queridinhos da galera:'])}\n\n` +
    linhas.join('\n') +
    `\n\nGaranta o seu em ${STORE_URL} 🎮`
  );
}

/** Menor preço de venda de um produto + o "de" (se tiver desconto). */
function bestPrice(p) {
  const cands = [{ price: p.price, promo: p.promotional_price }, ...(p.variants || []).map((v) => ({ price: v.price, promo: v.promotional_price }))];
  let por = Infinity;
  let de = null;
  for (const c of cands) {
    const nums = [Number(c.price), Number(c.promo)].filter((n) => n > 0);
    if (!nums.length) continue;
    const lo = Math.min(...nums);
    const hi = Math.max(...nums);
    if (lo < por) { por = lo; de = hi > lo ? hi : null; }
  }
  return por === Infinity ? null : { por, de };
}

/** PROMOÇÃO: sorteia um jogo de NINTENDO da loja (com imagem + preço) e faz um card p/ vender. */
async function genPromo() {
  const data = await nerix.listProducts();
  const list = Array.isArray(data) ? data : (data.data || []);
  const recent = new Set(state.promoRecent || []);
  const nintendo = list.filter((p) =>
    /nintendo|switch/i.test(p.name || '') &&
    bestPrice(p) &&
    Array.isArray(p.images) && p.images[0] &&
    p.slug && !recent.has(p.slug)
  );
  // Embaralha (Fisher-Yates) → jogo aleatório.
  for (let i = nintendo.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [nintendo[i], nintendo[j]] = [nintendo[j], nintendo[i]];
  }
  for (const p of nintendo.slice(0, 15)) {
    const image = storeImage(p.images);
    if (!(await news.imageOk(image))) continue; // só posta com imagem que funciona
    // Marca como promovido recentemente (cap 25) p/ não repetir seguido.
    state.promoRecent = [...(state.promoRecent || []).filter((s) => s !== p.slug), p.slug].slice(-25);
    saveState();

    const pr = bestPrice(p);
    const precoLinha = pr.de
      ? `💰 de ~${brl(pr.de)}~ por *${brl(pr.por)}*`
      : `💰 *${brl(pr.por)}*`;
    const text =
      `${variator.pick(['🎮 Destaque do dia na *Phaze Games*', '🔥 Bora jogar?', '🎮 Que tal esse hoje?'])} — Nintendo Switch\n\n` +
      `*${cleanName(p.name)}*\n` +
      `${precoLinha}\n` +
      `✅ 100% original · garantia vitalícia · entrega em até 30 min\n\n` +
      `👉 Garanta o seu: ${productLink(p.slug)}`;
    return { text, image };
  }
  return null;
}

async function genCoupon() {
  const coupons = await nerix.listCoupons();
  const list = (Array.isArray(coupons) ? coupons : (coupons.data || []))
    .filter((c) => c.is_active && !c.is_secret && c.code)
    .filter((c) => !c.valid_until || new Date(c.valid_until).getTime() > Date.now());
  if (!list.length) return null;
  // Preferir o de maior valor percentual.
  list.sort((a, b) => Number(b.value) - Number(a.value));
  const c = list[0];
  const off = c.type === 'percentage' ? `${Number(c.value).toFixed(0).replace(/\.0$/, '')}% OFF` : `${brl(c.value)} OFF`;
  return (
    `${variator.pick(['🎟️ Cupom ativo agora:', '🎁 Solta o cupom!', '🎟️ Bora economizar:'])} *${c.code}*\n\n` +
    `${off} na sua compra em ${STORE_URL}\n` +
    `É só aplicar o código *${c.code}* no checkout 😉`
  );
}

async function genNews() {
  const latest = await news.fetchLatestNews();
  const seen = state.newsSeen || {};
  const fresh = latest.filter((n) => !seen[n.link]).sort(nintendoFirst).slice(0, 10);
  for (const n of fresh) {
    if (!(await news.imageOk(n.image))) continue; // SÓ posta com imagem que funciona
    markSeen(n.link);
    const tituloPt = await ai.translate(n.title);
    const text =
      `${variator.pick(['📰 Saiu novidade no mundo', '📰 Fresquinho do mundo', '🎮 Rolou no mundo'])} ${n.source}!\n\n` +
      `${n.emoji} ${tituloPt}\n\n` +
      `👉 ${n.link}`;
    return { text, image: n.image };
  }
  return null; // nada com imagem agora
}

// Ordena colocando Nintendo PRIMEIRO (o grupo é ~97% nintendista), depois por data desc.
function nintendoFirst(a, b) {
  const na = a.source === 'Nintendo' ? 1 : 0;
  const nb = b.source === 'Nintendo' ? 1 : 0;
  return (nb - na) || ((b.ts || 0) - (a.ts || 0));
}

/** Marca um link como visto no estado (compartilhado por news/reviews), com cap de 80. */
function markSeen(link) {
  const seen = state.newsSeen || {};
  seen[link] = Date.now();
  const keys = Object.keys(seen);
  if (keys.length > 80) for (const k of keys.slice(0, keys.length - 80)) delete seen[k];
  state.newsSeen = seen;
  saveState();
}

async function genReviews() {
  const items = await news.fetchLatestReviews();
  const seen = state.newsSeen || {};
  const fresh = items.filter((r) => !seen[r.link]).sort(nintendoFirst).slice(0, 8);
  for (const r of fresh) {
    // Título: "Review: Jogo (Plataforma) - Veredito".
    const m = r.title.match(/^Review:\s*(.+?)\s*\(([^)]+)\)\s*[-–—]\s*(.+)$/i);
    const jogo = (m ? m[1] : r.title.replace(/^Review:\s*/i, '')).trim();
    const plataforma = m ? m[2].trim() : '';
    const veredito = m ? m[3].trim() : '';

    // Imagem: prefere a da LOJA (Nerix, acessível + vira link de compra);
    // a imagem do site é bloqueada por Cloudflare. SÓ posta se a imagem funcionar.
    const loja = await storeMatch(jogo);
    const image = (loja && loja.image) || r.image || null;
    if (!(await news.imageOk(image))) continue; // sem imagem boa → próximo candidato
    markSeen(r.link);

    const veredictoPt = veredito ? await ai.translate(veredito) : '';
    const compra = loja ? `\n🛒 Tá na *Phaze Games*: ${loja.link}` : '';
    const text =
      `⭐ *Avaliação* — ${r.source} ${r.emoji}\n\n` +
      `🎮 *${jogo}*${plataforma ? ` — ${plataforma}` : ''}\n` +
      (veredictoPt ? `\n💬 _${veredictoPt}_\n` : '') +
      compra +
      `\n\n👉 Review completa: ${r.link}`;
    return { text, image };
  }
  return null; // nada com imagem agora
}

/**
 * AVALIAÇÃO: convida quem já comprou a contar a experiência.
 *
 * Reputação é o que faz um desconhecido comprar jogo digital de uma loja
 * pequena, e ela não aparece sozinha — cliente satisfeito some, cliente
 * insatisfeito escreve. Pedir é o que equilibra.
 *
 * NADA de dado de compra aqui. O post é o mesmo para todo mundo e não cita
 * nome, telefone, pedido nem produto comprado: isso é grupo, e o que sai aqui
 * é público para todos os membros. Prova social se faz com quem responde
 * porque quis, não expondo quem comprou.
 *
 * Com imagem porque post com card para de rolar o polegar; sem imagem que
 * funcione, não posta — mesma regra dos outros geradores, e pelo mesmo motivo
 * (imagem quebrada no grupo parece loja abandonada).
 */
const PEDIDOS_AVALIACAO = [
  'Quem já comprou aqui, conta pra gente como foi? 👀',
  'Fala, pessoal! Quem já pegou jogo com a gente, deixa o feedback aí 👇',
  'Comprou com a gente e deu tudo certo? Conta aqui pro pessoal 😄',
  'A opinião de vocês ajuda demais quem tá chegando agora 🙌',
];

async function genAvaliacao() {
  let image = cfg.avaliacaoImagem || null;

  if (!image) {
    // Capa de um jogo da loja: imagem que já sabemos que carrega, e que fala
    // do assunto do grupo. Sorteia entre os primeiros para o post não sair
    // sempre com a mesma capa.
    try {
      const data = await nerix.listProducts({ limit: 20 });
      const list = (data.data || data || []).filter((p) => Array.isArray(p.images) && p.images[0]);
      for (const p of list.sort(() => Math.random() - 0.5).slice(0, 5)) {
        const url = storeImage(p.images);
        if (await news.imageOk(url)) { image = url; break; }
      }
    } catch (err) {
      console.warn('[community] avaliação: não achei capa:', err.response?.status || err.message);
    }
  }

  if (!image) return null; // sem imagem boa, não posta

  const linhas = [variator.pick(PEDIDOS_AVALIACAO), ''];
  if (cfg.avaliacaoUrl) {
    linhas.push(`Deixa sua avaliação aqui: ${cfg.avaliacaoUrl}`);
  } else {
    linhas.push('É só responder aqui no grupo — leva 10 segundos e ajuda muita gente 💚');
  }
  linhas.push('', `Ainda não comprou? ${STORE_URL}`);

  return { text: linhas.join('\n'), image };
}

// Geradores por chave (usados pela AGENDA de cadência em config.community.schedule).
const GENERATORS = {
  news: genNews,
  reviews: genReviews,
  promo: genPromo,
  coupon: genCoupon,
  bestsellers: genBestSellers,
  avaliacao: genAvaliacao,
};

// ─── Envio ───────────────────────────────────────────────────────────
async function publish(text, image) {
  if (cfg.dryRun) {
    console.log(`[community] (DRY-RUN, não enviado)${image ? ` [imagem: ${image}]` : ''} →\n${text}\n`);
    return;
  }
  await sender.send(cfg.groupJid, text, {
    typing: false, // não simular "digitando" em grupo
    reaction: false,
    ...(image ? { image, imageOnly: true } : {}), // card com imagem; NÃO cai pra texto
    ...(cfg.instance ? { instance: cfg.instance } : {}),
  });
  console.log(`[community] post publicado no grupo${image ? ' (c/ imagem)' : ''}`);
}

// ─── Agendador (CADÊNCIA por tipo: cada conteúdo tem intervalo e horário) ──
async function tick() {
  if (running || !cfg.enabled || !cfg.groupJid) return;
  running = true;
  try {
    const now = Date.now();
    const { hour, dateKey } = brt(now);
    state.lastPostAt = state.lastPostAt || {};
    state.slots = state.slots || {};

    // Poda slots antigos (mantém o estado enxuto).
    for (const k of Object.keys(state.slots)) {
      if (now - state.slots[k] > 15 * 24 * 60 * 60 * 1000) delete state.slots[k];
    }

    for (const item of cfg.schedule) {
      if (hour !== item.hour) continue;             // cada entrada posta no SEU horário
      const entryId = `${item.key}@${item.hour}`;   // por HORÁRIO → permite 2/dia do mesmo tipo
      const slotKey = `${entryId}-${dateKey}`;      // no máx 1 dessa entrada por dia
      if (state.slots[slotKey]) continue;           // já postou hoje nesse horário
      const last = state.lastPostAt[entryId] || 0;
      const dueMs = (item.everyDays - 0.5) * 24 * 60 * 60 * 1000; // tolerância de meio dia
      if (last && now - last < dueMs) continue;     // ainda não completou a cadência

      const gen = GENERATORS[item.key];
      if (!gen) continue;
      let result = null;
      try { result = await gen(); }
      catch (err) { console.error(`[community] gerador ${item.key} falhou:`, err.response?.status || err.message); }
      const text = typeof result === 'string' ? result : (result && result.text);
      const image = typeof result === 'string' ? null : (result && result.image);
      if (!text) continue; // sem conteúdo agora → tenta no próximo tick/dia

      // Marca ANTES de publicar (otimista) p/ não duplicar entre ticks/reinícios.
      state.slots[slotKey] = now;
      state.lastPostAt[entryId] = now;
      saveState();
      await publish(text, image);
      console.log(`[community] postado "${item.key}" (cada ${item.everyDays}d @${item.hour}h)`);
      break; // um post por tick
    }
  } catch (err) {
    console.error('[community] erro no tick:', err.message);
  } finally {
    running = false;
  }
}

// ─── FASE 2: responder no grupo quando marcarem o bot (@) ou usarem gatilho ──
let lastGroupReplyAt = 0;

/**
 * Trata uma mensagem recebida no grupo da comunidade (chamado pelo server só p/ grupos).
 * Só responde se: replies ligados, é o NOSSO grupo, e o bot foi marcado (@) OU citaram o gatilho.
 * @param {{groupJid:string, participant:string, text:string, pushName?:string, mentionedJids?:string[]}} m
 */
async function handleGroupMessage(m) {
  if (!cfg.replyEnabled || !cfg.groupJid) return;
  if (!m || m.groupJid !== cfg.groupJid) return; // só o grupo da comunidade
  const text = (m.text || '').trim();
  if (!text) return;

  const mentioned = cfg.botNumber && (m.mentionedJids || []).some((j) => String(j).replace(/\D/g, '').startsWith(cfg.botNumber));
  const lower = text.toLowerCase();
  const triggered = cfg.trigger && lower.includes(cfg.trigger);
  if (!mentioned && !triggered) return; // só responde se chamarem o bot

  const now = Date.now();
  if (now - lastGroupReplyAt < cfg.replyCooldownMs) return; // anti-spam (cooldown)
  lastGroupReplyAt = now;

  // Remove a menção/gatilho do texto pra deixar só a pergunta.
  let question = text.replace(new RegExp(`@?${cfg.trigger}`, 'ig'), '').replace(/@\d+/g, '').trim();
  if (!question) question = text;

  try {
    const key = m.participant || m.groupJid; // histórico por membro
    const answer = await ai.reply(key, question, m.pushName);
    await publish(answer); // respeita dry-run; publica no grupo
    console.log(`[community] respondeu no grupo (${m.participant || '?'})`);
  } catch (err) {
    console.error('[community] erro ao responder no grupo:', err.response?.data || err.message);
  }
}

function start() {
  if (!cfg.enabled) { console.log('[community] desligada (COMMUNITY_ENABLED != true)'); return; }
  if (!cfg.groupJid) { console.log('[community] SEM COMMUNITY_GROUP_JID — não vai postar'); return; }
  if (timer) return;
  const agenda = cfg.schedule.map((s) => `${s.key} a cada ${s.everyDays}d @${s.hour}h`).join(', ') || '(vazia)';
  console.log(
    `[community] ligada — grupo ${cfg.groupJid}${cfg.instance ? ` (instância ${cfg.instance})` : ''}; ` +
    `agenda: ${agenda} (BRT); ${cfg.dryRun ? 'DRY-RUN' : 'AO VIVO'}`
  );
  timer = setInterval(tick, cfg.checkIntervalMs);
  if (timer.unref) timer.unref();

  // Force-post imediato (uma vez), p/ teste: COMMUNITY_FORCE_NOW="reviews,news".
  // Ignora cadência/slot (mas respeita dry-run). Remova a env depois de usar.
  const force = String(process.env.COMMUNITY_FORCE_NOW || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (force.length) {
    (async () => {
      for (const key of force) {
        const gen = GENERATORS[key];
        if (!gen) { console.warn(`[community] FORCE: gerador "${key}" não existe`); continue; }
        try {
          const result = await gen();
          const text = typeof result === 'string' ? result : (result && result.text);
          const image = typeof result === 'string' ? null : (result && result.image);
          if (text) { await publish(text, image); console.log(`[community] FORCE post "${key}"`); }
          else console.warn(`[community] FORCE: "${key}" sem conteúdo`);
        } catch (err) { console.error(`[community] FORCE "${key}" falhou:`, err.message); }
      }
    })();
  }
}

function stop() { if (timer) { clearInterval(timer); timer = null; } }

module.exports = { start, stop, tick, handleGroupMessage, genBestSellers, genPromo, genCoupon, genNews, genReviews, genAvaliacao };
