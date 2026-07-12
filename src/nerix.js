'use strict';

/**
 * Cliente da API pública da Nerix.
 * Docs: https://docs.nerix.com.br
 * Autenticação: header `X-nerixkey` (ver autenticacao.md).
 * Base: https://api.nerix.com.br/api/public
 */

const axios = require('axios');
const config = require('./config');

const http = axios.create({
  baseURL: config.nerix.url,
  timeout: 15000,
  headers: {
    'X-nerixkey': config.nerix.apiKey,
    'Content-Type': 'application/json',
  },
});

// ─── Produtos ────────────────────────────────────────────────────────
async function listProducts(params = {}) {
  const { data } = await http.get('/products', { params });
  return data;
}

async function getProduct(productId) {
  const { data } = await http.get(`/products/${productId}`);
  return data;
}

// ─── Pedidos ─────────────────────────────────────────────────────────
/**
 * Cria um pedido. Retorna o pedido com link de pagamento (Pix/Cartão).
 * @param {{items: Array, customer: object, coupon_code?: string, affiliate_code?: string}} payload
 */
async function createOrder(payload) {
  const { data } = await http.post('/orders', payload);
  return data;
}

/**
 * Busca um pedido pelo código. Se `email` for informado, a API valida que
 * ele corresponde ao pedido antes de retornar (usar sempre no bot).
 */
async function getOrder(orderCode, opts = {}) {
  const params = {};
  if (opts.email) params.email = opts.email;
  const { data } = await http.get(`/orders/${encodeURIComponent(orderCode)}`, { params });
  return data;
}

/** Lista pedidos da loja (ADMIN — retorna dados de toda a loja; não expor ao cliente). */
async function listOrders(params = {}) {
  const { data } = await http.get('/orders', { params });
  return data;
}

/**
 * Verifica e atualiza o status de pagamento em tempo real (POST).
 * Se pago, dispara entrega de chaves e webhooks.
 */
async function checkPayment(orderCode) {
  const { data } = await http.post(`/orders/${encodeURIComponent(orderCode)}/check-payment`);
  return data;
}

// ─── Loja ────────────────────────────────────────────────────────────
async function getStore() {
  const { data } = await http.get('/store');
  return data;
}

module.exports = {
  http,
  listProducts,
  getProduct,
  createOrder,
  getOrder,
  listOrders,
  checkPayment,
  getStore,
};
