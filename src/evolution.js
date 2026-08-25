'use strict';

/**
 * Cliente da Evolution API para ENVIAR mensagens ao WhatsApp.
 * Docs: https://docs.evolutionfoundation.com.br/evolution-api
 * Autenticação: header `apikey` (chave global da instância).
 */

const axios = require('axios');
const config = require('./config');

const http = axios.create({
  baseURL: config.evolution.url,
  timeout: 20000,
  headers: {
    apikey: config.evolution.apiKey,
    'Content-Type': 'application/json',
  },
});

/**
 * Normaliza o destino para o formato esperado pela Evolution.
 * - Número BR ("5541999999999" ou "+55 (41) 99999-9999") → só dígitos.
 * - JID (contém "@", ex.: grupo "...@g.us") → usado como veio (NÃO remover dígitos/traços).
 */
function toNumber(raw) {
  const s = String(raw);
  return s.includes('@') ? s : s.replace(/\D/g, '');
}

/** Envia uma mensagem de texto simples. `opts.instance` permite outra instância (ex.: comunidade). */
async function sendText(number, text, opts = {}) {
  const instance = opts.instance || config.evolution.instance;
  const { data } = await http.post(`/message/sendText/${instance}`, {
    number: toNumber(number),
    text,
  });
  return data;
}

/**
 * Define o "presence" da conversa (ex: 'composing' = digitando...).
 * Deixa o atendimento com cara de humano. Valores: 'composing' | 'paused' |
 * 'recording' | 'available' | 'unavailable'.
 */
async function sendPresence(number, presence = 'composing', opts = {}) {
  const instance = opts.instance || config.evolution.instance;
  const { data } = await http.post(`/chat/sendPresence/${instance}`, {
    number: toNumber(number),
    presence,
  });
  return data;
}

/**
 * O WhatsApp está conectado?
 *
 * Devolve o estado cru da instância ('open' = conectado). Serve ao #status: se
 * o aparelho caiu, TODA mensagem some em silêncio — e o sintoma que chega é
 * "o bot parou", que aponta para o lugar errado.
 */
async function estadoInstancia(opts = {}) {
  const instance = opts.instance || config.evolution.instance;
  const { data } = await http.get(`/instance/connectionState/${instance}`);
  return data?.instance?.state || data?.state || '';
}

/**
 * Envia um menu como LISTA nativa do WhatsApp.
 *
 * Lista e não botão: o WhatsApp aceita no máximo 3 botões de resposta, e o
 * menu principal da loja tem 8 opções. Cortar para 3 seria esconder metade do
 * atendimento atrás de um "ver mais".
 *
 * Quem chama precisa estar pronto para isto FALHAR. Lista e botão passam pelo
 * Baileys, que reimplementa um formato não documentado do WhatsApp: o suporte
 * muda entre versões da Evolution e some sem aviso. Por isso nada aqui tem
 * fallback interno — o sender.js decide, e ele cai no menu de texto numerado,
 * que sempre funcionou.
 *
 * `rowId` de cada linha é o NÚMERO da opção. Assim, venha a resposta do
 * WhatsApp como id da linha ou como texto do título, o menu resolve pelo mesmo
 * caminho de quem digitou "3" na mão.
 */
async function sendList(number, { title, description, buttonText, footer, rows }, opts = {}) {
  const instance = opts.instance || config.evolution.instance;
  const { data } = await http.post(`/message/sendList/${instance}`, {
    number: toNumber(number),
    title,
    description,
    buttonText,
    footerText: footer,
    sections: [{ title: buttonText || 'Opções', rows }],
  });
  return data;
}

/** Envia mídia (imagem/documento) por URL. `opts.instance` permite outra instância. */
async function sendMedia(number, { mediatype, media, caption, fileName }, opts = {}) {
  const instance = opts.instance || config.evolution.instance;
  const { data } = await http.post(`/message/sendMedia/${instance}`, {
    number: toNumber(number),
    mediatype, // 'image' | 'document' | 'video'
    media, // URL ou base64
    caption,
    fileName,
  });
  return data;
}

/**
 * Baixa a mídia de uma mensagem RECEBIDA e devolve em base64.
 *
 * O webhook da Evolution entrega só os metadados da imagem (mimetype, tamanho,
 * chaves de criptografia) — o binário fica no servidor do WhatsApp. Esta rota
 * pede à Evolution que baixe e descriptografe por nós.
 *
 * @param {object} rawMessage  o objeto `data` do webhook (precisa ter .key e .message)
 * @param {{instance?:string}} [opts]
 * @returns {Promise<{base64:string, mimetype:string, fileName?:string}>}
 */
async function getBase64FromMediaMessage(rawMessage, opts = {}) {
  const instance = opts.instance || config.evolution.instance;
  const { data } = await http.post(`/chat/getBase64FromMediaMessage/${instance}`, {
    message: rawMessage,
    convertToMp4: false,
  });
  return data;
}

module.exports = {
  http,
  toNumber,
  sendText,
  sendPresence,
  sendMedia,
  sendList,
  estadoInstancia,
  getBase64FromMediaMessage,
};
