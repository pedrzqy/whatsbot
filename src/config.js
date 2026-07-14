'use strict';

require('dotenv').config();

function required(name) {
  const value = process.env[name];
  if (!value) {
    console.warn(`[config] Variável de ambiente ausente: ${name}`);
  }
  return value;
}

// Monta um provedor de LLM (compatível com OpenAI). Retorna null se não tiver chave.
function llmProvider(name, url, apiKey, model, reasoningEffort = '') {
  if (!apiKey) return null;
  return { name, url: url.replace(/\/$/, ''), apiKey, model, reasoningEffort };
}

// Converte "12,19" numa lista de horas válidas (0-23); usa fallback se vazio/inválido.
function parseHours(raw, fallback) {
  const src = (raw && String(raw).trim()) || fallback;
  const hs = String(src)
    .split(',')
    .map((n) => parseInt(String(n).trim(), 10))
    .filter((n) => Number.isInteger(n) && n >= 0 && n < 24);
  return hs.length ? hs : String(fallback).split(',').map(Number);
}

// Converte "45,1440" (minutos) num array de estágios em ms; usa fallback se vazio/ inválido.
function parseStagesMin(raw, fallbackMin) {
  const src = (raw && String(raw).trim()) || fallbackMin;
  const mins = String(src)
    .split(',')
    .map((n) => Number(String(n).trim()))
    .filter((n) => Number.isFinite(n) && n > 0);
  return (mins.length ? mins : [Number(fallbackMin)]).map((m) => m * 60 * 1000);
}

const config = {
  port: Number(process.env.PORT || 3000),

  evolution: {
    url: (process.env.EVOLUTION_API_URL || 'http://localhost:8080').replace(/\/$/, ''),
    apiKey: required('EVOLUTION_API_KEY'),
    instance: process.env.EVOLUTION_INSTANCE || 'whatsbot',
  },

  nerix: {
    url: (process.env.NERIX_API_URL || 'https://api.nerix.com.br/api/public').replace(/\/$/, ''),
    apiKey: required('NERIX_API_KEY'),
  },

  store: {
    // URL do site oficial (as compras são feitas apenas por lá).
    url: process.env.STORE_URL || 'https://phazegames.com',
    // Grupo do WhatsApp (convidar o cliente).
    groupUrl: process.env.STORE_GROUP_URL || 'https://chat.whatsapp.com/KxQ7jybE7fL4N31C7kpKYp',
    // Site onde o cliente resgata o código de verificação da conta (ao entrar).
    codeUrl: process.env.STORE_CODE_URL || 'https://codigons.online/',
  },

  // ── LLM: COMBO de provedores em CASCATA (todos compatíveis com OpenAI) ──
  // Ordem = melhor qualidade/velocidade primeiro; rede de segurança por último.
  // Se um trava (rate limit / erro), cai automaticamente no próximo. Só entram os que têm chave.
  // (Nomes GROQ_*/FALLBACK_* antigos mantidos por compatibilidade.)
  llm: {
    temperature: Number(process.env.LLM_TEMPERATURE || 0.6),
    maxTokens: Number(process.env.LLM_MAX_TOKENS || 600),
    // Nº de trocas (usuário+assistente) mantidas no histórico por contato.
    maxHistory: Number(process.env.LLM_MAX_HISTORY || 4),
    providers: [
      llmProvider('Gemini',
        process.env.GEMINI_API_URL || 'https://generativelanguage.googleapis.com/v1beta/openai',
        process.env.GEMINI_API_KEY || process.env.GROQ_API_KEY,
        process.env.GEMINI_MODEL || 'gemini-flash-latest',
        process.env.GEMINI_REASONING_EFFORT ?? process.env.GROQ_REASONING_EFFORT ?? 'none'),
      llmProvider('Cerebras', 'https://api.cerebras.ai/v1',
        process.env.CEREBRAS_API_KEY, process.env.CEREBRAS_MODEL || 'gpt-oss-120b'),
      llmProvider('Groq', 'https://api.groq.com/openai/v1',
        process.env.GROQ_FALLBACK_API_KEY || process.env.FALLBACK_API_KEY,
        process.env.GROQ_FALLBACK_MODEL || process.env.FALLBACK_MODEL || 'llama-3.1-8b-instant'),
      llmProvider('Mistral', 'https://api.mistral.ai/v1',
        process.env.MISTRAL_API_KEY, process.env.MISTRAL_MODEL || 'mistral-small-latest'),
      llmProvider('Cohere', 'https://api.cohere.ai/compatibility/v1',
        process.env.COHERE_API_KEY, process.env.COHERE_MODEL || 'command-r-08-2024'),
      llmProvider('OpenRouter', 'https://openrouter.ai/api/v1',
        process.env.OPENROUTER_API_KEY, process.env.OPENROUTER_MODEL || 'tencent/hy3:free'),
    ].filter(Boolean),
  },

  webhook: {
    nerixSecret: process.env.NERIX_WEBHOOK_SECRET || '',
  },

  // ── Recuperação de venda: cutuca quem engajou na conversa e sumiu ──
  // Só cutuca contato que JÁ conversou com a IA (engaged) e não está com atendente (paused).
  // Cliente que responde zera o ciclo. Passa pela fila anti-ban do sender.js e respeita horário.
  recovery: {
    enabled: process.env.RECOVERY_ENABLED !== 'false', // ligado por padrão
    // De quanto em quanto tempo o scheduler varre os contatos.
    checkIntervalMs: Number(process.env.RECOVERY_CHECK_INTERVAL_MS || 5 * 60 * 1000),
    // Minutos de SILÊNCIO necessários para cada cutucada. Nº de estágios = nº de cutucadas.
    // Padrão: 1 cutucada após 45 min. Ex.: RECOVERY_STAGES_MIN="45,1440" = 2 (45min e 24h).
    stages: parseStagesMin(process.env.RECOVERY_STAGES_MIN, 45),
    // Se o cliente já sumiu há mais que isto, desiste do ciclo (não cutuca gente antiga).
    staleAfterMs: Number(process.env.RECOVERY_STALE_AFTER_MS || 12 * 60 * 60 * 1000),
    // Horário de silêncio (BRT, UTC-3): não cutuca de madrugada. Padrão 22h–8h.
    quietStartHour: Number(process.env.RECOVERY_QUIET_START_HOUR || 22),
    quietEndHour: Number(process.env.RECOVERY_QUIET_END_HOUR || 8),
  },

  // ── Agente de COMUNIDADE: posta conteúdo no grupo (notícias/promo/top/cupom) ──
  // Fase 1 = só SAÍDA (posts agendados), sem ler mensagens do grupo. Passa pela
  // fila anti-ban do sender.js. Default DESLIGADO + dry-run (loga em vez de enviar).
  community: {
    enabled: process.env.COMMUNITY_ENABLED === 'true', // opt-in explícito
    dryRun: process.env.COMMUNITY_DRY_RUN !== 'false',  // padrão: só loga, não envia
    // JID do grupo destino (ex.: "1203630...@g.us"). Sem isto, não posta.
    groupJid: process.env.COMMUNITY_GROUP_JID || '',
    // Instância da Evolution p/ postar. Vazio = mesma do bot (mesmo número).
    // Ao migrar p/ número dedicado, basta setar COMMUNITY_INSTANCE.
    instance: process.env.COMMUNITY_INSTANCE || '',
    // Varredura do agendador.
    checkIntervalMs: Number(process.env.COMMUNITY_CHECK_INTERVAL_MS || 5 * 60 * 1000),
    // AGENDA por tipo de conteúdo: cada um tem sua CADÊNCIA (a cada N dias) e HORÁRIO (BRT).
    // Padrão: 1 review por dia (12h) e 1 notícia a cada 2 dias (19h). everyDays=0 desativa o tipo.
    schedule: [
      { key: 'reviews', everyDays: Number(process.env.COMMUNITY_REVIEWS_EVERY_DAYS ?? 1), hour: Number(process.env.COMMUNITY_REVIEWS_HOUR ?? 12) },
      { key: 'news', everyDays: Number(process.env.COMMUNITY_NEWS_EVERY_DAYS ?? 2), hour: Number(process.env.COMMUNITY_NEWS_HOUR ?? 19) },
      { key: 'promo', everyDays: Number(process.env.COMMUNITY_PROMO_EVERY_DAYS ?? 0), hour: Number(process.env.COMMUNITY_PROMO_HOUR ?? 15) },
      { key: 'coupon', everyDays: Number(process.env.COMMUNITY_COUPON_EVERY_DAYS ?? 0), hour: Number(process.env.COMMUNITY_COUPON_HOUR ?? 17) },
    ].filter((s) => s.everyDays > 0 && s.hour >= 0 && s.hour < 24),

    // ── FASE 2 (interativo): responder no grupo quando marcarem o bot (@) ou usarem gatilho ──
    // Default OFF. Além disto, a Evolution só entrega msgs de grupo se groupsIgnore=false.
    replyEnabled: process.env.COMMUNITY_REPLY_ENABLED === 'true',
    // Número do próprio bot (só dígitos) p/ detectar menção (@). Ex.: 5541999999999.
    botNumber: (process.env.COMMUNITY_BOT_NUMBER || '').replace(/\D/g, ''),
    // Palavra-gatilho alternativa (se não marcarem, mas começarem/citarem isto).
    trigger: (process.env.COMMUNITY_TRIGGER || 'phaze').toLowerCase(),
    // Intervalo mínimo entre respostas no grupo (anti-spam).
    replyCooldownMs: Number(process.env.COMMUNITY_REPLY_COOLDOWN_MS || 15000),
  },

  // Ritmo humanizado de envio (anti-ban). Todos os valores em milissegundos.
  // Ajustado para respostas RÁPIDAS, mantendo um mínimo de comportamento natural.
  pacing: {
    // "Pensar" antes de começar a digitar após receber uma mensagem.
    reactionMinMs: Number(process.env.PACING_REACTION_MIN_MS || 600),
    reactionMaxMs: Number(process.env.PACING_REACTION_MAX_MS || 1600),
    // Intervalo entre mensagens consecutivas para o MESMO contato.
    consecutiveMinMs: Number(process.env.PACING_CONSECUTIVE_MIN_MS || 1000),
    consecutiveMaxMs: Number(process.env.PACING_CONSECUTIVE_MAX_MS || 2500),
    // Intervalo entre envios para contatos DIFERENTES (throttle global).
    crossContactMinMs: Number(process.env.PACING_CROSS_MIN_MS || 1200),
    crossContactMaxMs: Number(process.env.PACING_CROSS_MAX_MS || 3500),
    // Velocidade de digitação: letras por segundo (define o tempo "digitando...").
    charsPerSecond: Number(process.env.PACING_CHARS_PER_SECOND || 25),
    // Limites do tempo de digitação (para não travar em textos muito longos).
    typingMinMs: Number(process.env.PACING_TYPING_MIN_MS || 400),
    typingMaxMs: Number(process.env.PACING_TYPING_MAX_MS || 3000),
  },

  welcome: {
    // Override total da mensagem (se vazio, usa o texto padrão personalizado).
    message: process.env.WELCOME_MESSAGE || '',
    // Nome da loja usado se a Nerix não retornar (fallback).
    storeName: process.env.STORE_NAME || '',
    // Após quantas horas de inatividade tratar como nova conversa e re-saudar.
    sessionWindowHours: Number(process.env.SESSION_WINDOW_HOURS || 6),
  },
};

module.exports = config;
