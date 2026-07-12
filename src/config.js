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
