'use strict';

require('dotenv').config();

function required(name) {
  const value = process.env[name];
  if (!value) {
    console.warn(`[config] Variável de ambiente ausente: ${name}`);
  }
  return value;
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

  // Provedor de LLM (compatível com OpenAI). Padrão: Google Gemini (grátis, limites altos).
  // Env override: GROQ_API_URL / GROQ_API_KEY / GROQ_MODEL (nomes GROQ_* mantidos por compatibilidade).
  // Para voltar ao Groq: GROQ_API_URL=https://api.groq.com/openai/v1, GROQ_MODEL=llama-3.1-8b-instant, GROQ_REASONING_EFFORT=(vazio).
  groq: {
    url: (process.env.GROQ_API_URL || 'https://generativelanguage.googleapis.com/v1beta/openai').replace(/\/$/, ''),
    apiKey: required('GROQ_API_KEY'),
    model: process.env.GROQ_MODEL || 'gemini-flash-latest',
    // Gemini 3.x "pensa" por padrão (gasta tokens e trunca). 'none' desliga → resposta limpa e rápida.
    reasoningEffort: process.env.GROQ_REASONING_EFFORT ?? 'none',
    temperature: Number(process.env.GROQ_TEMPERATURE || 0.6),
    maxTokens: Number(process.env.GROQ_MAX_TOKENS || 600),
    // Nº de trocas (par usuário+assistente) mantidas no histórico por contato.
    maxHistory: Number(process.env.GROQ_MAX_HISTORY || 4),
  },

  // Provedor de RESERVA (fallback): usado automaticamente quando o primário (Gemini)
  // trava por rate limit. Padrão: Groq (llama-3.1-8b-instant). Defina FALLBACK_API_KEY
  // com a chave do Groq para ativar. Vazio = sem reserva.
  fallback: {
    url: (process.env.FALLBACK_API_URL || 'https://api.groq.com/openai/v1').replace(/\/$/, ''),
    apiKey: process.env.FALLBACK_API_KEY || '',
    model: process.env.FALLBACK_MODEL || 'llama-3.1-8b-instant',
    reasoningEffort: process.env.FALLBACK_REASONING_EFFORT || '',
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
