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
const sender = require('./sender');
const variator = require('./variator');

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

async function genPromo() {
  const prods = await nerix.listProducts();
  const list = Array.isArray(prods) ? prods : (prods.data || []);
  const deals = [];
  for (const p of list) {
    // melhor desconto entre o produto e suas variantes.
    // Na Nerix: price = preço de VENDA (menor); promotional_price = preço "de" (maior).
    // Usamos por=min, de=max (robusto p/ qualquer ordem) — igual a tools.js priceParts.
    const cand = [{ price: p.price, promo: p.promotional_price }, ...(p.variants || []).map((v) => ({ price: v.price, promo: v.promotional_price }))];
    let best = null;
    for (const c of cand) {
      const nums = [Number(c.price), Number(c.promo)].filter((n) => n > 0);
      if (nums.length < 2) continue;
      const por = Math.min(...nums);
      const de = Math.max(...nums);
      if (de > por) {
        const pct = Math.round((1 - por / de) * 100);
        if (!best || pct > best.pct) best = { de, por, pct };
      }
    }
    if (best) deals.push({ nome: cleanName(p.name), slug: p.slug, ...best });
  }
  if (!deals.length) return null;
  deals.sort((a, b) => b.pct - a.pct);
  const top = deals.slice(0, 3);

  const linhas = top.map((d) => `🎮 ${d.nome}\nde ~${brl(d.de)}~ por *${brl(d.por)}* (${d.pct}% OFF)\n👉 ${productLink(d.slug)}`);
  return (
    `${variator.pick(['💰 *Baixou de preço* na Phaze Games:', '💰 Promoção rolando na Phaze Games:', '🔻 Preço baixo por tempo limitado:'])}\n\n` +
    linhas.join('\n\n') +
    `\n\nEntrega em até 30 min ⚡`
  );
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

// Ordem de rotação dos conteúdos.
const GENERATORS = [
  { key: 'bestsellers', fn: genBestSellers },
  { key: 'promo', fn: genPromo },
  { key: 'coupon', fn: genCoupon },
];

// ─── Envio ───────────────────────────────────────────────────────────
async function publish(text) {
  if (cfg.dryRun) {
    console.log(`[community] (DRY-RUN, não enviado) →\n${text}\n`);
    return;
  }
  await sender.send(cfg.groupJid, text, {
    typing: false, // não simular "digitando" em grupo
    reaction: false,
    ...(cfg.instance ? { instance: cfg.instance } : {}),
  });
  console.log('[community] post publicado no grupo');
}

/**
 * Gera o próximo conteúdo disponível (rotativo, pulando os vazios) e publica.
 * @returns {Promise<string|null>} a chave do conteúdo postado, ou null se nada disponível
 */
async function postNext() {
  for (let i = 0; i < GENERATORS.length; i++) {
    const idx = (state.rotation + i) % GENERATORS.length;
    const g = GENERATORS[idx];
    let text = null;
    try {
      text = await g.fn();
    } catch (err) {
      console.error(`[community] gerador ${g.key} falhou:`, err.response?.status || err.message);
    }
    if (text) {
      await publish(text);
      state.rotation = (idx + 1) % GENERATORS.length;
      saveState();
      return g.key;
    }
  }
  return null; // nenhum conteúdo disponível agora
}

// ─── Agendador ───────────────────────────────────────────────────────
async function tick() {
  if (running || !cfg.enabled || !cfg.groupJid) return;
  running = true;
  try {
    const now = Date.now();
    const { hour, dateKey } = brt(now);
    if (!cfg.postHours.includes(hour)) return; // fora dos horários de post

    const slotKey = `${dateKey}-${hour}`;
    if (state.posts[slotKey]) return; // este slot já postou hoje

    const postedToday = Object.keys(state.posts).filter((k) => k.startsWith(dateKey)).length;
    if (postedToday >= cfg.maxPerDay) return; // teto diário

    // Marca ANTES de publicar (otimista) p/ não duplicar entre ticks/reinícios.
    state.posts[slotKey] = now;
    saveState();

    const key = await postNext();
    if (key) console.log(`[community] slot ${slotKey}: postado "${key}"`);
    else { delete state.posts[slotKey]; saveState(); } // nada p/ postar → libera o slot
  } catch (err) {
    console.error('[community] erro no tick:', err.message);
  } finally {
    running = false;
  }
}

function start() {
  if (!cfg.enabled) { console.log('[community] desligada (COMMUNITY_ENABLED != true)'); return; }
  if (!cfg.groupJid) { console.log('[community] SEM COMMUNITY_GROUP_JID — não vai postar'); return; }
  if (timer) return;
  console.log(
    `[community] ligada — grupo ${cfg.groupJid}${cfg.instance ? ` (instância ${cfg.instance})` : ''}; ` +
    `posta ${cfg.postHours.join('h, ')}h (BRT); máx ${cfg.maxPerDay}/dia; ${cfg.dryRun ? 'DRY-RUN' : 'AO VIVO'}`
  );
  timer = setInterval(tick, cfg.checkIntervalMs);
  if (timer.unref) timer.unref();
}

function stop() { if (timer) { clearInterval(timer); timer = null; } }

module.exports = { start, stop, tick, postNext, genBestSellers, genPromo, genCoupon };
