'use strict';

/**
 * NOTÍCIAS de games (Steam/PlayStation/Nintendo) via RSS, para o agente de comunidade.
 *
 * Sem dependência nova: fetch com axios + parser mínimo de RSS/Atom (title/link/data).
 * Defensivo: qualquer falha de rede/parse retorna [] (o gerador só pula, nunca quebra o bot).
 * Fontes configuráveis por env (COMMUNITY_NEWS_FEEDS = "Label|emoji|url ; ...").
 */

const axios = require('axios');

const http = axios.create({
  timeout: 15000,
  headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PhazeGamesBot/1.0)', Accept: 'application/rss+xml, application/xml, text/xml, */*' },
});

// Fontes padrão (RSS). Podem ser trocadas por env sem mexer no código.
const DEFAULT_FEEDS = [
  { source: 'Nintendo', emoji: '🔴', url: 'https://www.nintendolife.com/feeds/latest' },
  { source: 'PlayStation', emoji: '🔵', url: 'https://blog.playstation.com/feed/' },
  { source: 'Steam/PC', emoji: '⚫', url: 'https://www.pcgamer.com/rss/' },
];

// Feeds de REVIEW (o título já traz o veredito — nada de copiar texto).
const DEFAULT_REVIEW_FEEDS = [
  { source: 'Nintendo', emoji: '🔴', url: 'https://www.nintendolife.com/feeds/reviews' },
  { source: 'PlayStation', emoji: '🔵', url: 'https://www.pushsquare.com/feeds/reviews' },
];

/** Lê "Label|emoji|url ; ..." de uma env, ou usa o default informado. */
function parseFeedEnv(raw, fallback) {
  const s = (raw || '').trim();
  if (!s) return fallback;
  const feeds = s.split(';').map((chunk) => {
    const [source, emoji, url] = chunk.split('|').map((x) => (x || '').trim());
    return url ? { source: source || 'Games', emoji: emoji || '📰', url } : null;
  }).filter(Boolean);
  return feeds.length ? feeds : fallback;
}

function loadFeeds() { return parseFeedEnv(process.env.COMMUNITY_NEWS_FEEDS, DEFAULT_FEEDS); }
function loadReviewFeeds() { return parseFeedEnv(process.env.COMMUNITY_REVIEW_FEEDS, DEFAULT_REVIEW_FEEDS); }

/** Limpa CDATA, tags e entidades HTML de um texto de RSS. */
function clean(s) {
  return String(s || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;|&apos;|&#x27;/gi, "'").replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Extrai itens de um XML de RSS (<item>) ou Atom (<entry>). */
function parseFeed(xml) {
  const tag = /<item[\s>]/i.test(xml) ? 'item' : 'entry';
  const blocks = xml.split(new RegExp(`<${tag}[\\s>]`, 'i')).slice(1);
  const items = [];
  for (const b of blocks) {
    const title = (b.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1];
    let link = (b.match(/<link[^>]*>([\s\S]*?)<\/link>/i) || [])[1];
    if (!link || /^\s*$/.test(link)) {
      const m = b.match(/<link[^>]*href="([^"]+)"/i); // Atom
      if (m) link = m[1];
    }
    const dateRaw = (b.match(/<pubDate>([\s\S]*?)<\/pubDate>/i) || [])[1]
      || (b.match(/<updated>([\s\S]*?)<\/updated>/i) || [])[1]
      || (b.match(/<published>([\s\S]*?)<\/published>/i) || [])[1];
    const t = clean(title);
    const l = clean(link);
    if (t && /^https?:\/\//i.test(l)) {
      items.push({ title: t, link: l, ts: dateRaw ? (Date.parse(dateRaw) || 0) : 0 });
    }
  }
  return items;
}

/** Busca a manchete mais recente de cada fonte. Retorna [{source, emoji, title, link, ts}]. */
async function fetchLatestPerSource() {
  const feeds = loadFeeds();
  const results = await Promise.all(feeds.map(async (f) => {
    try {
      const { data } = await http.get(f.url);
      const items = parseFeed(String(data));
      if (!items.length) return null;
      // Ordena por data desc (itens sem data mantêm a ordem do feed).
      items.sort((a, b) => b.ts - a.ts);
      const top = items[0];
      return { source: f.source, emoji: f.emoji, title: top.title, link: top.link, ts: top.ts };
    } catch (err) {
      console.error(`[news] falha em ${f.source}:`, err.response?.status || err.code || err.message);
      return null;
    }
  }));
  return results.filter(Boolean);
}

/** Busca reviews recentes das fontes (vários por fonte), achatado e ordenado por data desc. */
async function fetchLatestReviews(perFeed = 5) {
  const feeds = loadReviewFeeds();
  const lists = await Promise.all(feeds.map(async (f) => {
    try {
      const { data } = await http.get(f.url);
      const items = parseFeed(String(data)).slice(0, perFeed);
      return items.map((it) => ({ source: f.source, emoji: f.emoji, ...it }));
    } catch (err) {
      console.error(`[news] review ${f.source} falhou:`, err.response?.status || err.code || err.message);
      return [];
    }
  }));
  return lists.flat().sort((a, b) => b.ts - a.ts);
}

module.exports = { fetchLatestPerSource, fetchLatestReviews, parseFeed, loadFeeds, loadReviewFeeds };
