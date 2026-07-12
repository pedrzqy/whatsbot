'use strict';

/**
 * Ferramentas (function calling) que a IA pode chamar para consultar a Nerix.
 *
 * Segurança:
 *  - NÃO existe ferramenta que liste todos os pedidos da loja (a chave é admin
 *    e isso vazaria dados de outros clientes). O cliente só acessa o PRÓPRIO
 *    pedido informando número + e-mail, que a API da Nerix valida.
 *  - Chaves/licenças (product_key) só aparecem após essa validação de e-mail.
 */

const nerix = require('./nerix');
const config = require('./config');
const store = require('./store');

/** Monta o link direto do produto no site (rota /package/:slug da Nerix). */
function productLink(slug) {
  if (!slug || !config.store.url) return null;
  return `${config.store.url}/package/${slug}`;
}

// Esquemas no formato OpenAI/Groq.
const definitions = [
  {
    type: 'function',
    function: {
      name: 'buscar_produtos',
      description: 'Busca produtos por termo (nome). Retorna preço, promoção, link e opções.',
      parameters: {
        type: 'object',
        properties: {
          termo: { type: 'string', description: 'Termo de busca pelo nome do produto (ex.: "minecraft"). Vazio lista os primeiros.' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'consultar_pedido',
      description: 'Status/detalhes de um pedido. Requer numero_pedido (ex.: NX-1054) e email; se faltarem, peça antes.',
      parameters: {
        type: 'object',
        properties: {
          numero_pedido: { type: 'string', description: 'Código do pedido, ex.: NX-1054' },
          email: { type: 'string', description: 'E-mail usado na compra (validado pela API)' },
        },
        required: ['numero_pedido', 'email'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'verificar_pagamento',
      description: 'Confere se o Pix caiu e libera a entrega. Requer numero_pedido e email. Use quando o cliente disser que pagou.',
      parameters: {
        type: 'object',
        properties: {
          numero_pedido: { type: 'string' },
          email: { type: 'string' },
        },
        required: ['numero_pedido', 'email'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'falar_com_atendente',
      description: 'Transfere p/ atendente humano e pausa o bot. OBRIGATÓRIO colete NOME e SOBRENOME antes. Use p/ pedido de atendente OU opção online/perfil próprio. Se só tiver o primeiro nome, peça o sobrenome.',
      parameters: {
        type: 'object',
        properties: {
          nome_completo: { type: 'string', description: 'Nome e sobrenome do cliente (obrigatório)' },
          motivo: { type: 'string', description: 'Motivo resumido (ex.: "opção online/perfil próprio", "dúvida", "pedido")' },
        },
        required: ['nome_completo'],
      },
    },
  },
];

// ─── Formatação segura dos resultados para o modelo ──────────────────

const brl = (n) => (n != null ? `R$ ${Number(n).toFixed(2)}` : null);

/** Preço de venda (menor) e, se houver promoção real, o valor "de" (maior) para riscar. */
function priceParts(price, promo) {
  const nums = [price, promo].map(Number).filter((n) => !Number.isNaN(n) && n > 0);
  if (!nums.length) return {};
  const por = Math.min(...nums);
  const de = Math.max(...nums);
  return de > por ? { por, de } : { por };
}

/** Formata preço para o modelo: { preco, preco_original? } (preco_original = "de" p/ riscar). */
function fmtPrice(parts) {
  if (parts.por == null) return { preco: 'consultar' };
  const out = { preco: brl(parts.por) };
  if (parts.de) out.preco_original = brl(parts.de); // há promoção → riscar este valor
  return out;
}

/** Formata o catálogo para o modelo (nome, preço de/por, opções/variantes, link). */
function formatProducts(list) {
  return list.slice(0, 8).map((p) => {
    const variantes = (p.variants || [])
      .filter((v) => v.is_active !== false)
      .map((v) => ({ nome: v.name, ...fmtPrice(priceParts(v.price, v.promotional_price)) }));

    let parts = priceParts(p.price, p.promotional_price);
    if (parts.por == null && variantes.length) {
      const vals = (p.variants || [])
        .filter((v) => v.is_active !== false)
        .map((v) => priceParts(v.price, v.promotional_price).por)
        .filter((n) => n != null);
      if (vals.length) parts = { por: Math.min(...vals) };
    }

    const out = { nome: p.name, ...fmtPrice(parts), link: productLink(p.slug) };
    if (variantes.length) out.opcoes = variantes;
    return out;
  });
}

function formatOrder(o) {
  return {
    numero_pedido: o.order_number,
    cliente: o.customer_name,
    status: o.status,
    status_pagamento: o.payment_status,
    metodo_pagamento: o.payment_method,
    total: o.total,
    pago_em: o.paid_at || null,
    itens: (o.items || []).map((it) => ({
      produto: it.name,
      quantidade: it.quantity,
      preco: it.price,
      // A chave só chega aqui após validação de e-mail pela API.
      chave: it.product_key || null,
    })),
  };
}

async function execute(name, args = {}, ctx = {}) {
  try {
    if (name === 'falar_com_atendente') {
      const nome = (args.nome_completo || '').trim();
      if (nome.split(/\s+/).length < 2) return { erro: 'falta_sobrenome' };
      if (ctx.from) store.saveContact(ctx.from, { paused: true, name: nome });
      console.log(`[handoff] ${ctx.from} -> atendente (${nome}) | motivo: ${args.motivo || '-'}`);
      return { transferido: true, instrucao: 'Confirme ao cliente, de forma calorosa, que um atendente humano vai continuar o atendimento em instantes.' };
    }

    if (name === 'buscar_produtos') {
      const data = await nerix.listProducts({ search: args.termo || '', limit: 8 });
      const list = data.data || data || [];
      return { total_encontrados: list.length, produtos: formatProducts(list) };
    }

    if (name === 'consultar_pedido') {
      const o = await nerix.getOrder(args.numero_pedido, { email: args.email });
      return formatOrder(o);
    }

    if (name === 'verificar_pagamento') {
      // 1) valida posse pelo e-mail (lança se não confere)
      await nerix.getOrder(args.numero_pedido, { email: args.email });
      // 2) confirma o pagamento junto ao gateway
      const r = await nerix.checkPayment(args.numero_pedido);
      return {
        numero_pedido: r.order_number,
        status_pagamento: r.payment_status,
        status: r.status,
        pagamento_confirmado_agora: !!r.updated,
        chaves_entregues: !!r.keys_delivered,
      };
    }

    return { erro: 'ferramenta_desconhecida' };
  } catch (err) {
    const status = err.response?.status;
    if (status === 404) return { erro: 'pedido_nao_encontrado' };
    if (status === 401 || status === 403) return { erro: 'email_nao_confere' };
    console.error(`[tools] falha em ${name}:`, err.response?.data || err.message);
    return { erro: 'falha_ao_consultar' };
  }
}

module.exports = { definitions, execute };
