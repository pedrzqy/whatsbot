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
  },

  groq: {
    url: (process.env.GROQ_API_URL || 'https://api.groq.com/openai/v1').replace(/\/$/, ''),
    apiKey: required('GROQ_API_KEY'),
    model: process.env.GROQ_MODEL || 'llama-3.3-70b-versatile',
    temperature: Number(process.env.GROQ_TEMPERATURE || 0.6),
    maxTokens: Number(process.env.GROQ_MAX_TOKENS || 500),
    // Nº de trocas (par usuário+assistente) mantidas no histórico por contato.
    maxHistory: Number(process.env.GROQ_MAX_HISTORY || 8),
  },

  webhook: {
    nerixSecret: process.env.NERIX_WEBHOOK_SECRET || '',
  },

  // Ritmo humanizado de envio (anti-ban). Todos os valores em milissegundos.
  pacing: {
    // "Pensar" antes de começar a digitar após receber uma mensagem.
    reactionMinMs: Number(process.env.PACING_REACTION_MIN_MS || 2000),
    reactionMaxMs: Number(process.env.PACING_REACTION_MAX_MS || 6000),
    // Intervalo entre mensagens consecutivas para o MESMO contato.
    consecutiveMinMs: Number(process.env.PACING_CONSECUTIVE_MIN_MS || 3000),
    consecutiveMaxMs: Number(process.env.PACING_CONSECUTIVE_MAX_MS || 10000),
    // Intervalo entre envios para contatos DIFERENTES (throttle global).
    crossContactMinMs: Number(process.env.PACING_CROSS_MIN_MS || 5000),
    crossContactMaxMs: Number(process.env.PACING_CROSS_MAX_MS || 15000),
    // Velocidade de digitação: letras por segundo (define o tempo "digitando...").
    charsPerSecond: Number(process.env.PACING_CHARS_PER_SECOND || 3),
    // Limites do tempo de digitação (para não travar em textos muito longos).
    typingMinMs: Number(process.env.PACING_TYPING_MIN_MS || 1500),
    typingMaxMs: Number(process.env.PACING_TYPING_MAX_MS || 12000),
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
