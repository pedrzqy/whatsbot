'use strict';

/**
 * Claude (Anthropic) como cérebro do atendimento.
 *
 * Este módulo NÃO é um provedor a mais na cascata do ai.js. Ele é a primeira
 * camada, e a cascata antiga vira a rede embaixo dele. Quem chama não sabe a
 * diferença: `chat(messages, opts)` recebe e devolve exatamente o mesmo formato
 * do `ai.chat` — mensagens no estilo OpenAI, resposta com `content` e
 * `tool_calls`. A conversão para o formato da Anthropic acontece toda aqui
 * dentro, na borda, e é por isso que `tools.js`, `tradutor.js`, `handlers.js` e
 * `community.js` não mudam uma linha.
 *
 * TRÊS COISAS QUE FAZEM ISTO FALHAR EM 100% DAS CHAMADAS SE FOREM ESQUECIDAS.
 * As três foram descobertas antes de escrever o módulo, e todas são silenciosas
 * no sentido de que o código "parece certo":
 *
 * 1. `temperature` (e `top_p`/`top_k`) foi REMOVIDO do Opus 5. Não é ignorado:
 *    é recusado com 400. O `tradutor.js` manda `temperature: 0.2` em toda
 *    chamada, e o `ai.js` manda a do config. Por isso o `montarParametros`
 *    abaixo ignora essas chaves em vez de repassá-las.
 *
 * 2. O raciocínio conta no `max_tokens`. Com o padrão do bot (600) a resposta
 *    era cortada no meio. E desligar o raciocínio é PIOR que deixá-lo caro:
 *    com `thinking: {type:'disabled'}` o modelo às vezes escreve a chamada de
 *    ferramenta no texto visível — que aqui vira uma mensagem de WhatsApp
 *    dizendo "vou chamar buscar_produtos" para o cliente. Fica adaptativo, com
 *    esforço baixo e teto de tokens folgado.
 *
 * 3. O cache é casamento de PREFIXO. Ver `ai.js` → `marcaDoCliente`.
 */

const Anthropic = require('@anthropic-ai/sdk');

const MODELO = process.env.BOT_CLAUDE_MODELO || 'claude-opus-5';

/**
 * Teto de tokens de saída.
 *
 * 2000 e não os 600 do resto do bot porque o raciocínio do modelo é contado
 * aqui dentro. Com 600, o pensamento consumia a cota e a resposta ao cliente
 * chegava truncada no meio de uma frase — sem erro nenhum, só um texto que
 * termina do nada.
 */
const MAX_TOKENS = Math.max(Number(process.env.BOT_CLAUDE_MAX_TOKENS) || 2000, 2000);

/**
 * Teto diário de chamadas, como freio de emergência da conta.
 *
 * O custo é linear no volume: 30 conversas/dia são cerca de R$ 287/mês, e o
 * dobro do volume é o dobro da fatura. Este número não é o orçamento — é o
 * ponto em que alguma coisa claramente saiu do normal (laço de mensagens,
 * alguém testando em rajada). Estourado, cai na cascata, que já está paga.
 *
 * Em memória de propósito: um reinício zerar o contador é o comportamento certo
 * para um freio contra descontrole, e evita mais um arquivo de estado no disco.
 */
const TETO_DIA = Number(process.env.BOT_CLAUDE_MAX_DIA) || 400;

/**
 * Contadores do dia, incluindo o cache.
 *
 * `cacheLido` e `cacheGravado` estão aqui porque são a ÚNICA prova de que o
 * cache está funcionando, e o orçamento inteiro depende disso: com cache o
 * trecho fixo custa 10%, sem cache custa 100%, e a diferença é R$ 287 contra
 * quase R$ 600 por mês. Um invalidador silencioso (um nome, uma data, uma
 * ferramenta a mais no meio do prefixo) não dá erro nenhum — só zera a leitura.
 * Sem esta linha no painel, a descoberta seria a fatura.
 */
let contador = { dia: null, n: 0, cacheLido: 0, cacheGravado: 0, entrada: 0 };

let cliente = null;
function obterCliente() {
  if (!cliente) cliente = new Anthropic(); // lê ANTHROPIC_API_KEY do ambiente
  return cliente;
}

/** Sem chave, o módulo inteiro se desliga e o bot segue na cascata antiga. */
function disponivel() {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

function diaDeHoje() {
  return new Date().toISOString().slice(0, 10);
}

/** @returns {{estourou:boolean, n:number}} */
function contarChamada() {
  const hoje = diaDeHoje();
  if (contador.dia !== hoje) contador = { dia: hoje, n: 0, cacheLido: 0, cacheGravado: 0, entrada: 0 };
  contador.n += 1;
  return { estourou: contador.n > TETO_DIA, n: contador.n };
}

/**
 * Para o painel do operador.
 *
 * `cachePct` é a fração do que ENTROU que veio do cache. Abaixo de uns 50% em
 * uso normal, alguma coisa está variando no prefixo e a conta está subindo em
 * silêncio.
 */
function uso() {
  const total = contador.cacheLido + contador.entrada;
  return {
    dia: contador.dia,
    chamadas: contador.n,
    teto: TETO_DIA,
    modelo: MODELO,
    cacheLido: contador.cacheLido,
    cacheGravado: contador.cacheGravado,
    cachePct: total ? Math.round((contador.cacheLido / total) * 100) : null,
  };
}

// ============================================================
// Conversão de formato — a borda
// ============================================================

/**
 * Ferramentas do formato OpenAI para o da Anthropic.
 *
 *   OpenAI:    { type:'function', function:{ name, description, parameters } }
 *   Anthropic: { name, description, input_schema }
 *
 * A ORDEM tem que ser preservada. As ferramentas são renderizadas ANTES do
 * system prompt no que o modelo recebe, então elas fazem parte do prefixo
 * cacheado: reordenar a lista entre duas chamadas invalida o cache das duas.
 * Por isso aqui é um `map` puro, sem filtro nem ordenação.
 */
function converterFerramentas(definicoes) {
  if (!Array.isArray(definicoes) || !definicoes.length) return undefined;
  return definicoes.map((d) => ({
    name: d.function.name,
    description: d.function.description,
    input_schema: d.function.parameters || { type: 'object', properties: {} },
  }));
}

/** JSON dos argumentos de ferramenta, tolerante ao que o modelo escrever. */
function lerArgumentos(bruto) {
  if (bruto && typeof bruto === 'object') return bruto;
  try {
    return JSON.parse(bruto || '{}');
  } catch {
    return {};
  }
}

/**
 * Mensagens do formato OpenAI para o da Anthropic.
 *
 * Três diferenças que dão 400 se passarem batidas:
 *
 *  - O system NÃO é uma mensagem, é um parâmetro no topo. Sai do array.
 *  - Resultado de ferramenta não tem papel próprio: é um bloco `tool_result`
 *    dentro de uma mensagem de USUÁRIO. E todos os resultados de um mesmo turno
 *    do assistente precisam vir na MESMA mensagem — separá-los é recusado.
 *  - A conversa tem que COMEÇAR com o usuário. Um histórico podado no lugar
 *    errado pode começar com o assistente.
 *
 * @returns {{system:string, messages:object[]}}
 */
function converterMensagens(entrada) {
  let system = '';
  const fora = [];

  // Ids de ferramenta que o assistente realmente pediu.
  //
  // Um `tool_result` cujo id não aparece em nenhum `tool_use` anterior é
  // recusado com 400 — e como o histórico fica em disco, um desses gravado por
  // engano quebraria TODA conversa seguinte daquele contato, para sempre.
  // Descartar o órfão é feio; deixar o cliente sem atendimento é pior.
  const pedidos = new Set();

  for (const m of entrada) {
    if (m.role === 'system') {
      // Concatena em vez de sobrescrever: se um dia houver dois blocos de
      // system, perder o segundo em silêncio seria pior que juntá-los.
      system += (system ? '\n\n' : '') + String(m.content || '');
      continue;
    }

    if (m.role === 'tool') {
      if (!pedidos.has(m.tool_call_id)) continue;
      const bloco = {
        type: 'tool_result',
        tool_use_id: m.tool_call_id,
        content: String(m.content ?? ''),
      };
      // Cola no bloco de resultados anterior, se ele for o último — é assim que
      // os vários resultados de um turno chegam juntos.
      const ultima = fora[fora.length - 1];
      if (ultima && ultima.role === 'user' && Array.isArray(ultima.content)) {
        ultima.content.push(bloco);
      } else {
        fora.push({ role: 'user', content: [bloco] });
      }
      continue;
    }

    if (m.role === 'assistant') {
      // Se a resposta veio do próprio Claude nesta mesma conversa, o conteúdo
      // ORIGINAL foi guardado de lado. Reaproveitar é o que preserva os blocos
      // de raciocínio entre uma ida de ferramenta e a seguinte — reconstruir a
      // partir do texto os perderia, e o modelo voltaria sem saber por que
      // tinha chamado a ferramenta.
      if (Array.isArray(m._claude) && m._claude.length) {
        for (const b of m._claude) if (b.type === 'tool_use') pedidos.add(b.id);
        fora.push({ role: 'assistant', content: m._claude });
        continue;
      }

      const blocos = [];
      const texto = String(m.content || '').trim();
      if (texto) blocos.push({ type: 'text', text: texto });
      for (const c of m.tool_calls || []) {
        pedidos.add(c.id);
        blocos.push({
          type: 'tool_use',
          id: c.id,
          name: c.function.name,
          input: lerArgumentos(c.function.arguments),
        });
      }
      // Mensagem vazia é recusada. Sem texto e sem chamada não há o que mandar.
      if (blocos.length) fora.push({ role: 'assistant', content: blocos });
      continue;
    }

    // Turno do cliente. Pode ser texto puro ou texto + foto.
    //
    // A foto chega no formato OpenAI (`image_url` com data URI), que é o do
    // resto do bot, e vira o bloco `image` da Anthropic aqui — é o mesmo
    // trabalho de borda que as ferramentas já fazem. Sem esta conversão, um
    // `String(m.content)` num array daria "[object Object]": o modelo receberia
    // isso como a mensagem do cliente e responderia a respeito.
    if (Array.isArray(m.content)) {
      const blocos = [];
      for (const b of m.content) {
        if (b.type === 'text' && String(b.text || '').trim()) {
          blocos.push({ type: 'text', text: b.text });
        } else if (b.type === 'image_url') {
          const url = String(b.image_url?.url || '');
          const casou = url.match(/^data:([^;]+);base64,(.+)$/s);
          // Só data URI. Link externo seria a Anthropic buscando uma URL que
          // veio de fora — e aqui a única fonte de imagem é o download que o
          // próprio bot fez da Evolution.
          if (casou) {
            blocos.push({
              type: 'image',
              source: { type: 'base64', media_type: casou[1], data: casou[2] },
            });
          }
        }
      }
      if (blocos.length) fora.push({ role: 'user', content: blocos });
      continue;
    }

    const texto = String(m.content || '').trim();
    if (texto) fora.push({ role: 'user', content: texto });
  }

  // A conversa tem que abrir com o usuário.
  while (fora.length && fora[0].role !== 'user') fora.shift();

  return { system, messages: fora };
}

/**
 * Resposta da Anthropic de volta para o formato que o `ai.reply` já entende.
 *
 * O conteúdo cru vai junto em `_claude`, NÃO enumerável de propósito: o
 * histórico é gravado com JSON.stringify em disco, e uma propriedade não
 * enumerável não é serializada. Assim o laço de ferramentas em memória tem os
 * blocos originais e o arquivo em disco continua pequeno e legível.
 */
function converterResposta(resposta) {
  const textos = [];
  const chamadas = [];

  for (const b of resposta.content || []) {
    if (b.type === 'text') textos.push(b.text);
    else if (b.type === 'tool_use') {
      chamadas.push({
        id: b.id,
        type: 'function',
        function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
      });
    }
  }

  const msg = {
    role: 'assistant',
    content: textos.join('\n').trim() || null,
    ...(chamadas.length ? { tool_calls: chamadas } : {}),
  };

  Object.defineProperty(msg, '_claude', { value: resposta.content, enumerable: false });
  return msg;
}

// ============================================================
// A chamada
// ============================================================

function montarParametros(messages, opts) {
  const { system, messages: convertidas } = converterMensagens(messages);

  return {
    model: opts.model || MODELO,
    // O raciocínio conta aqui dentro. Ver o cabeçalho do arquivo.
    max_tokens: Math.max(Number(opts.maxTokens) || 0, MAX_TOKENS),

    // Adaptativo, não desligado: com o raciocínio desligado o modelo às vezes
    // escreve a chamada de ferramenta no texto visível, e aqui texto visível é
    // uma mensagem de WhatsApp para o cliente.
    thinking: { type: 'adaptive' },
    // Esforço baixo: atendimento de loja é conversa curta com fatos vindos de
    // ferramenta, não raciocínio longo. É o que segura o custo sem piorar a
    // resposta.
    output_config: { effort: process.env.BOT_CLAUDE_ESFORCO || 'low' },

    // O breakpoint vai no system, e cobre as FERRAMENTAS junto: a ordem de
    // renderização é ferramentas → system → mensagens, então uma marca no fim
    // do system cacheia os dois blocos, que somam ~3100 tokens fixos em toda
    // chamada. Sem isto o custo mensal quase dobra.
    ...(system
      ? { system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }] }
      : {}),

    ...(opts.tools ? { tools: converterFerramentas(opts.tools) } : {}),
    messages: convertidas,

    // temperature / top_p / top_k NÃO entram. Foram removidos do modelo e são
    // recusados com 400 — não ignorados. Quem chama continua mandando
    // `temperature` (o tradutor manda 0.2); a chave morre aqui.
  };
}

/**
 * Mesma assinatura e mesmo retorno do `ai.chat`.
 *
 * @param {object[]} messages  formato OpenAI, com o system na posição 0
 * @param {{tools?:object[], maxTokens?:number, deadline?:number, model?:string}} opts
 * @returns {Promise<{role:string, content:string|null, tool_calls?:object[]}>}
 */
async function chat(messages, opts = {}) {
  if (!disponivel()) throw new Error('ANTHROPIC_API_KEY não configurada');

  const resta = opts.deadline ? opts.deadline - Date.now() : 40000;
  if (resta < 2000) throw new Error('prazo curto demais para o Claude');

  const { estourou, n } = contarChamada();
  if (estourou) {
    // Não é silencioso: some do log e a conta some junto do orçamento.
    console.warn(`[claude] teto diário estourado (${n}/${TETO_DIA}) — caindo na cascata`);
    throw new Error('teto diário do Claude estourado');
  }

  const resposta = await obterCliente().messages.create(montarParametros(messages, opts), {
    timeout: Math.min(resta, 40000),
  });

  // Recusa por política: chega como 200, com stop_reason 'refusal' e sem
  // conteúdo útil. Vira erro de propósito, para o bot cair na cascata — que é a
  // mesma coisa que um fallback do lado do servidor faria, usando as chaves que
  // já estão pagas.
  if (resposta.stop_reason === 'refusal') {
    console.warn(`[claude] recusa (${resposta.stop_details?.category || 'sem categoria'})`);
    throw new Error('resposta recusada pelo modelo');
  }

  const u = resposta.usage || {};
  contador.entrada += u.input_tokens || 0;
  contador.cacheLido += u.cache_read_input_tokens || 0;
  contador.cacheGravado += u.cache_creation_input_tokens || 0;

  console.log(
    `[claude] ${n}/${TETO_DIA} · entrada ${u.input_tokens || 0}` +
      ` · cache lido ${u.cache_read_input_tokens || 0} · gravado ${u.cache_creation_input_tokens || 0}` +
      ` · saída ${u.output_tokens || 0}`,
  );

  return converterResposta(resposta);
}

module.exports = {
  chat,
  disponivel,
  uso,
  MODELO,
  // Exportados para o teste: são eles que dão 400 quando erram, e errar aqui é
  // silencioso até a primeira chamada de verdade.
  converterFerramentas,
  converterMensagens,
  converterResposta,
  montarParametros,
};
