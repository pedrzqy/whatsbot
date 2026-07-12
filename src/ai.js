'use strict';

/**
 * Integração com a Groq (inferência de LLM, compatível com OpenAI).
 * Docs: https://console.groq.com/docs
 * Base: https://api.groq.com/openai/v1  ·  Auth: Bearer GROQ_API_KEY
 *
 * Responsável pelas respostas inteligentes do bot: mantém um histórico
 * curto por contato e conversa com o cliente na persona da loja.
 */

const axios = require('axios');
const config = require('./config');
const welcome = require('./welcome');
const tools = require('./tools');

const http = axios.create({
  baseURL: config.groq.url,
  timeout: 30000,
  headers: {
    Authorization: `Bearer ${config.groq.apiKey}`,
    'Content-Type': 'application/json',
  },
});

// ─── Histórico de conversa em memória (por contato) ──────────────────
/** @type {Map<string,{messages:Array,updatedAt:number}>} */
const histories = new Map();

function getHistory(from) {
  const entry = histories.get(from);
  if (!entry) return [];
  // Expira o contexto após a janela de sessão (nova conversa = contexto limpo).
  const gapMs = config.welcome.sessionWindowHours * 60 * 60 * 1000;
  if (Date.now() - entry.updatedAt > gapMs) {
    histories.delete(from);
    return [];
  }
  return entry.messages;
}

function pushHistory(from, role, content) {
  const entry = histories.get(from) || { messages: [], updatedAt: Date.now() };
  entry.messages.push({ role, content });
  // Mantém só as últimas N trocas (user+assistant) para não estourar contexto/custo.
  const max = config.groq.maxHistory * 2;
  if (entry.messages.length > max) {
    entry.messages = entry.messages.slice(-max);
  }
  entry.updatedAt = Date.now();
  histories.set(from, entry);
}

function clearHistory(from) {
  histories.delete(from);
}

// ─── Persona / instruções do assistente ──────────────────────────────
async function buildSystemPrompt() {
  const storeName = await welcome.getStoreName();
  const siteUrl = config.store.url;
  return (
    `Você é o assistente virtual de atendimento da loja "${storeName}", ` +
    `especializada em jogos digitais para Nintendo Switch, PlayStation e Steam. ` +
    `Você atende clientes pelo WhatsApp.\n\n` +
    `Fatos da loja:\n` +
    `- Plataformas: apenas Nintendo Switch, PlayStation e Steam (a loja NÃO vende Xbox).\n` +
    `- Entrega: digital e automática, normalmente em até 30 minutos após o pagamento.\n` +
    `- Pagamento: Pix e cartão de crédito.\n` +
    `- Garantia: Nintendo e PlayStation têm garantia VITALÍCIA; contas de Steam, 30 dias.\n` +
    `- COMPRAS: são feitas EXCLUSIVAMENTE pelo site oficial da loja` +
    (siteUrl ? ` (${siteUrl})` : '') +
    `. Você pode consultar preços e disponibilidade, mas NÃO cria pedidos pelo chat. ` +
    `Quando o cliente quiser comprar, mostre o produto e o preço e oriente-o a finalizar no site` +
    (siteUrl ? ` (${siteUrl})` : '') + `.\n\n` +
    `Diretrizes:\n` +
    `- Responda SEMPRE em português do Brasil, de forma amigável, cordial e objetiva.\n` +
    `- Mensagens curtas, adequadas ao WhatsApp. Use no máximo 1 ou 2 emojis por resposta.\n` +
    `- Você tem FERRAMENTAS para consultar dados reais da loja. Use-as sempre que precisar de ` +
    `informação concreta — NUNCA invente preços, produtos, estoque, status ou chaves.\n` +
    `  • buscar_produtos: catálogo, preços, disponibilidade e o LINK direto de cada produto.\n` +
    `  • consultar_pedido: status/detalhes de um pedido. Requer número (ex.: NX-1054) E o e-mail da compra.\n` +
    `  • verificar_pagamento: confere se o Pix caiu e libera a entrega. Requer número E e-mail.\n` +
    `- Quando o cliente demonstrar interesse em um jogo (ex.: "quero o GTA 5", "tem FIFA?"), ` +
    `use buscar_produtos e responda com uma mensagem ANIMADA e persuasiva (bom marketing): ` +
    `destaque o nome e o preço, a garantia (vitalícia p/ Nintendo e PlayStation) e a entrega em até 30 min, ` +
    `e SEMPRE inclua o LINK direto do produto (campo "link" da ferramenta) para ele finalizar a compra no site. ` +
    `Nunca invente links nem preços — use apenas o que a ferramenta retornar. Se houver mais de uma versão ` +
    `(ex.: PS4/PS5/Steam), mostre as opções com seus links. Seja caloroso, mas sem exagerar nos emojis (1 a 2).\n` +
    `- Para qualquer coisa sobre um pedido, você PRECISA do número do pedido e do e-mail usado na compra. ` +
    `Se o cliente não informar os dois, peça educadamente antes de consultar.\n` +
    `- Só entregue chaves/licenças (product_key) que vierem do resultado da ferramenta — nunca invente ` +
    `nem revele dados de pedidos de terceiros.\n` +
    `- Se a ferramenta retornar erro "email_nao_confere", explique que os dados não batem e peça para conferir. ` +
    `Se "pedido_nao_encontrado", peça para revisar o número.\n` +
    `- Se o cliente pedir para falar com uma pessoa, oriente que digite "atendente".\n` +
    `- Não peça nem manipule senhas, dados de cartão ou informações sensíveis de pagamento.\n` +
    `- Seja honesto sobre ser um atendimento automático quando perguntado.`
  );
}

// ─── Recuperação do bug "tool_use_failed" do Groq/Llama ──────────────
// Às vezes o modelo emite a chamada de função como texto no formato
// <function=nome{...json...}</function> em vez do tool_calls estruturado.
// Recuperamos essa chamada para não quebrar o atendimento.
function recoverToolCalls(err) {
  const gen = err.response?.data?.error?.failed_generation;
  if (!gen) return null;
  const re = /<function=([a-zA-Z0-9_]+)\s*(\{[\s\S]*?\})\s*<\/function>/g;
  const calls = [];
  let m;
  let i = 0;
  while ((m = re.exec(gen))) {
    calls.push({ id: `rec_${i++}`, type: 'function', function: { name: m[1], arguments: m[2] } });
  }
  return calls.length ? calls : null;
}

/** Chama o modelo com ferramentas, recuperando o bug tool_use_failed. */
async function callWithTools(messages) {
  try {
    return await chat(messages, { tools: tools.definitions });
  } catch (err) {
    if (err.response?.data?.error?.code === 'tool_use_failed') {
      const recovered = recoverToolCalls(err);
      if (recovered) return { role: 'assistant', content: null, tool_calls: recovered };
      return await chat(messages); // sem ferramentas, ao menos responde
    }
    throw err;
  }
}

// ─── Chamada de baixo nível ao Groq ──────────────────────────────────
async function chat(messages, opts = {}) {
  const { data } = await http.post('/chat/completions', {
    model: opts.model || config.groq.model,
    messages,
    temperature: opts.temperature ?? config.groq.temperature,
    max_tokens: opts.maxTokens ?? config.groq.maxTokens,
    ...(opts.tools ? { tools: opts.tools, tool_choice: opts.toolChoice || 'auto' } : {}),
  });
  return data.choices?.[0]?.message || { content: '' };
}

/**
 * Responde uma mensagem do cliente usando a IA, com histórico e ferramentas.
 * A IA pode chamar ferramentas (consultar a Nerix) antes de responder.
 * @returns {Promise<string>} texto da resposta
 */
async function reply(from, userText, pushName) {
  const system = await buildSystemPrompt();
  const history = getHistory(from);

  const messages = [
    { role: 'system', content: system },
    ...history,
    { role: 'user', content: userText },
  ];

  let content = '';
  // Loop de ferramentas: a IA pode consultar a Nerix e então responder.
  for (let step = 0; step < 4; step++) {
    const msg = await callWithTools(messages);

    if (msg.tool_calls && msg.tool_calls.length) {
      messages.push(msg); // mensagem do assistente com as chamadas
      for (const call of msg.tool_calls) {
        let args = {};
        try { args = JSON.parse(call.function.arguments || '{}'); } catch { /* ignore */ }
        console.log(`[ai] ferramenta ${call.function.name}(${call.function.arguments || ''})`);
        const result = await tools.execute(call.function.name, args);
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: JSON.stringify(result),
        });
      }
      continue; // volta pro modelo com os resultados
    }

    content = (msg.content || '').trim();
    break;
  }

  if (!content) content = 'Desculpe, não consegui responder agora. Pode repetir? 🙏';

  // Persiste só a troca visível (pergunta do cliente + resposta final).
  pushHistory(from, 'user', userText);
  pushHistory(from, 'assistant', content);
  return content;
}

/**
 * Reescreve um fato/roteiro da base de conhecimento de forma HUMANIZADA e
 * DIFERENTE a cada chamada, sem alterar os fatos. Usado nas respostas do menu.
 * @returns {Promise<string>}
 */
async function humanizeAnswer(fact) {
  const storeName = await welcome.getStoreName();
  const messages = [
    {
      role: 'system',
      content:
        `Você é um atendente simpático e humano da loja "${storeName}" no WhatsApp. ` +
        `Reescreva a informação a seguir como se estivesse conversando naturalmente com o cliente.\n` +
        `Regras obrigatórias:\n` +
        `- Mantenha TODOS os fatos, valores e regras exatamente como estão. NÃO invente nada novo.\n` +
        `- Varie o jeito de escrever — nunca use as mesmas frases de sempre.\n` +
        `- Português do Brasil, tom acolhedor. Mensagem curta a média, adequada ao WhatsApp.\n` +
        `- No máximo 2 emojis. Pode usar *negrito* do WhatsApp para destacar pontos importantes.\n` +
        `- Não invente prazos, garantias ou preços que não estejam no texto.`,
    },
    { role: 'user', content: `Informação para transmitir ao cliente:\n\n${fact}` },
  ];
  const msg = await chat(messages, { temperature: 0.95, maxTokens: 400 });
  return (msg.content || '').trim() || fact;
}

module.exports = { chat, reply, humanizeAnswer, clearHistory, buildSystemPrompt };
