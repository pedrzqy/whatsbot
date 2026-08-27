'use strict';

/**
 * Testes da borda entre o bot e a Anthropic (src/claude.js).
 * Roda sem tocar na API: só a conversão de formato e o que ela protege.
 *
 *   node teste-claude.js
 *
 * O foco é o que dá 400 na primeira chamada de verdade. Todo erro aqui é
 * silencioso até o dia do deploy: o código compila, os testes de negócio
 * passam, e a API recusa 100% das chamadas.
 */

process.env.PONTE_DATA_DIR = require('path').join(require('os').tmpdir(), 'phaze-teste-claude');
require('fs').rmSync(process.env.PONTE_DATA_DIR, { recursive: true, force: true });
process.env.NERIX_API_KEY = 'teste';
process.env.PONTE_OPERADOR_NUMERO = '5541999999999';

const claude = require('./src/claude');

let falhas = 0;
const t = (nome, ok, extra = '') => {
  if (!ok) falhas++;
  console.log(`  ${ok ? 'ok  ' : 'FALHA'} | ${nome}${extra ? ` -> ${extra}` : ''}`);
};
const bloco = (nome) => console.log(`\n--- ${nome} ---`);

// ── Os três parâmetros que derrubam a chamada ───────────────
//
// Estes não são detalhe de estilo: cada um recusa 100% das chamadas ou entrega
// texto quebrado ao cliente. Um port que preserve a assinatura antiga de
// callProvider erra os três de uma vez.
bloco('os parâmetros que dão 400');

const p = claude.montarParametros(
  [
    { role: 'system', content: 'Você é vendedor.' },
    { role: 'user', content: 'oi' },
  ],
  { temperature: 0.2, maxTokens: 600, tools: [] },
);

// temperature/top_p/top_k foram REMOVIDOS do modelo. Recusados, não ignorados.
// O tradutor.js manda temperature: 0.2 em toda chamada até hoje.
t('temperature não é repassada', p.temperature === undefined, String(p.temperature));
t('top_p não é repassado', p.top_p === undefined);
t('top_k não é repassado', p.top_k === undefined);

// O raciocínio conta no max_tokens: com os 600 do bot, a resposta ao cliente
// chegava cortada no meio de uma frase, sem erro nenhum.
t('max_tokens não obedece um teto baixo demais', p.max_tokens >= 2000, String(p.max_tokens));

// Desligar o raciocínio é pior que pagá-lo: sem ele o modelo às vezes escreve a
// chamada de ferramenta no texto visível — que aqui é uma mensagem de WhatsApp.
t('raciocínio fica adaptativo', p.thinking?.type === 'adaptive', JSON.stringify(p.thinking));
t('  e nunca desligado', p.thinking?.type !== 'disabled');
t('  nem com budget_tokens (removido do modelo)', p.thinking?.budget_tokens === undefined);
t('esforço baixo para segurar o custo', p.output_config?.effort === 'low', JSON.stringify(p.output_config));

// ── O cache, que é a diferença entre R$ 287 e R$ 600 ────────
bloco('o prefixo cacheado');

t('o system vai como bloco marcado para cache',
  p.system?.[0]?.cache_control?.type === 'ephemeral', JSON.stringify(p.system?.[0]?.cache_control));
t('  e o system sai do array de mensagens',
  !p.messages.some((m) => m.role === 'system'), JSON.stringify(p.messages.map((m) => m.role)));

// O nome do cliente NÃO pode estar no system: cache é casamento de prefixo, e
// um nome ali dá a cada contato um prefixo próprio — nada é aproveitado.
const ai = require('./src/ai');
(async () => {
  const system = await ai.buildSystemPrompt();
  t('o system prompt não é montado por cliente', ai.buildSystemPrompt.length === 0,
    `${ai.buildSystemPrompt.length} argumento(s)`);
  t('  e sai igual em duas chamadas seguidas',
    system === (await ai.buildSystemPrompt()), 'prefixo estável');
  t('  sem nome de cliente interpolado',
    !/O cliente se chama/.test(system), (system.match(/O cliente se chama \w+/) || [''])[0] || 'limpo');

  // ── Ferramentas: nome, schema e ORDEM ─────────────────────
  bloco('conversão das ferramentas');

  const tools = require('./src/tools');
  const conv = claude.converterFerramentas(tools.definitions);

  t('todas as ferramentas atravessam', conv.length === tools.definitions.length,
    `${conv.length} de ${tools.definitions.length}`);
  t('  com o schema no campo certo', conv.every((c) => c.input_schema && !c.parameters),
    JSON.stringify(Object.keys(conv[0])));
  t('  e o nome no topo, não aninhado', conv.every((c) => typeof c.name === 'string' && !c.function));

  // A ordem faz parte do prefixo cacheado: as ferramentas são renderizadas
  // ANTES do system. Reordenar entre duas chamadas invalida o cache das duas.
  t('  na MESMA ordem da origem',
    conv.map((c) => c.name).join(',') === tools.definitions.map((d) => d.function.name).join(','),
    conv.map((c) => c.name).join(','));

  // ── O laço de ferramentas ida e volta ─────────────────────
  //
  // É aqui que mora o 400 mais caro: resultado de ferramenta não tem papel
  // próprio na Anthropic, vira bloco dentro de uma mensagem de USUÁRIO, e os
  // vários resultados de um mesmo turno têm que vir juntos.
  bloco('ida e volta de ferramenta');

  const comFerramenta = claude.converterMensagens([
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'quanto custa zelda?' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [
        { id: 'c1', type: 'function', function: { name: 'buscar_produtos', arguments: '{"termo":"zelda"}' } },
        { id: 'c2', type: 'function', function: { name: 'meus_pedidos', arguments: '{}' } },
      ],
    },
    { role: 'tool', tool_call_id: 'c1', content: '{"total":1}' },
    { role: 'tool', tool_call_id: 'c2', content: '{"total":0}' },
    { role: 'assistant', content: 'Custa R$ 49,90' },
  ]);

  t('o system sai para o parâmetro do topo', comFerramenta.system === 'sys', comFerramenta.system);

  const papeis = comFerramenta.messages.map((m) => m.role).join(',');
  t('a conversa alterna certo', papeis === 'user,assistant,user,assistant', papeis);

  const chamada = comFerramenta.messages[1].content;
  t('tool_calls viram blocos tool_use', chamada.every((b) => b.type === 'tool_use'),
    JSON.stringify(chamada.map((b) => b.type)));
  t('  com o input já em objeto, não string',
    typeof chamada[0].input === 'object' && chamada[0].input.termo === 'zelda',
    JSON.stringify(chamada[0].input));

  // Os DOIS resultados na MESMA mensagem. Separá-los é recusado com 400.
  const resultados = comFerramenta.messages[2].content;
  t('os dois resultados vêm na mesma mensagem', resultados.length === 2, String(resultados.length));
  t('  como tool_result', resultados.every((b) => b.type === 'tool_result'));
  t('  amarrados pelo tool_use_id',
    resultados[0].tool_use_id === 'c1' && resultados[1].tool_use_id === 'c2',
    resultados.map((r) => r.tool_use_id).join(','));

  // ── O que quebraria a conversa de um contato PARA SEMPRE ──
  //
  // O histórico fica em disco. Uma mensagem malformada gravada ali seria
  // reenviada em toda chamada seguinte daquele contato, e a API recusaria todas.
  bloco('o que não pode chegar à API');

  const orfao = claude.converterMensagens([
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'oi' },
    { role: 'tool', tool_call_id: 'perdido', content: '{}' },
  ]);
  t('resultado sem a chamada correspondente é descartado',
    !JSON.stringify(orfao.messages).includes('perdido'), JSON.stringify(orfao.messages));

  const comecaErrado = claude.converterMensagens([
    { role: 'system', content: 'sys' },
    { role: 'assistant', content: 'oi, tudo bem?' },
    { role: 'user', content: 'quanto custa?' },
  ]);
  t('conversa que começa no assistente é corrigida',
    comecaErrado.messages[0]?.role === 'user', comecaErrado.messages[0]?.role);

  const vazias = claude.converterMensagens([
    { role: 'system', content: 'sys' },
    { role: 'user', content: '   ' },
    { role: 'user', content: 'oi' },
    { role: 'assistant', content: '' },
  ]);
  t('mensagem vazia não é enviada',
    vazias.messages.length === 1 && vazias.messages[0].content === 'oi',
    JSON.stringify(vazias.messages));

  // ── A volta: resposta da Anthropic no formato do bot ──────
  bloco('resposta de volta no formato antigo');

  const respostaTexto = claude.converterResposta({
    content: [{ type: 'thinking', thinking: 'deixa eu ver' }, { type: 'text', text: 'Custa R$ 49,90' }],
    stop_reason: 'end_turn',
  });
  t('o texto volta em content', respostaTexto.content === 'Custa R$ 49,90', respostaTexto.content);
  t('  e o raciocínio NÃO vaza para o cliente',
    !/deixa eu ver/.test(respostaTexto.content || ''), respostaTexto.content);
  t('  sem tool_calls quando não houve', respostaTexto.tool_calls === undefined);

  const respostaFerramenta = claude.converterResposta({
    content: [{ type: 'tool_use', id: 'x1', name: 'buscar_produtos', input: { termo: 'mario' } }],
    stop_reason: 'tool_use',
  });
  t('tool_use volta como tool_calls',
    respostaFerramenta.tool_calls?.[0]?.function?.name === 'buscar_produtos',
    JSON.stringify(respostaFerramenta.tool_calls));
  t('  com arguments em string, como o laço espera',
    typeof respostaFerramenta.tool_calls[0].function.arguments === 'string',
    typeof respostaFerramenta.tool_calls[0].function.arguments);

  // O conteúdo cru viaja junto para preservar o raciocínio entre uma ida de
  // ferramenta e a seguinte — mas NÃO pode inchar o histórico em disco.
  t('o conteúdo original viaja junto na memória',
    Array.isArray(respostaFerramenta._claude), typeof respostaFerramenta._claude);
  t('  e não é gravado no histórico',
    !JSON.stringify(respostaFerramenta).includes('_claude'), JSON.stringify(respostaFerramenta));

  // Reaproveitado na volta: sem isto o modelo perde o próprio raciocínio no
  // meio do laço de ferramentas.
  const reenvio = claude.converterMensagens([
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'oi' },
    respostaFerramenta,
    { role: 'tool', tool_call_id: 'x1', content: '{"total":1}' },
  ]);
  t('o conteúdo original é reenviado inteiro',
    reenvio.messages[1].content.some((b) => b.type === 'tool_use' && b.id === 'x1'),
    JSON.stringify(reenvio.messages[1].content.map((b) => b.type)));

  // ── O laço inteiro, com a requisição de verdade ────────────
  //
  // Os testes acima conferem a conversão em memória. Este confere o que sai NA
  // REDE: o SDK serializa o que montamos, e um campo com o nome errado só
  // aparece aí. É o teste que substitui "descobrir no primeiro deploy".
  bloco('a chamada de verdade, com o fetch dublado');

  process.env.ANTHROPIC_API_KEY = 'chave-de-mentira';
  const fetchReal = globalThis.fetch;
  const requisicoes = [];
  let rodada = 0;

  globalThis.fetch = async (url, init) => {
    const corpo = JSON.parse(init.body);
    requisicoes.push({ url: String(url), corpo, headers: init.headers });
    rodada += 1;

    // 1ª volta: pede a ferramenta. 2ª: responde ao cliente.
    const content =
      rodada === 1
        ? [
            { type: 'thinking', thinking: 'preciso ver o preco' },
            { type: 'tool_use', id: 'tu_1', name: 'buscar_produtos', input: { termo: 'zelda' } },
          ]
        : [{ type: 'text', text: 'O Zelda ta R$ 49,90 👍' }];

    return new Response(
      JSON.stringify({
        id: 'msg_teste',
        type: 'message',
        role: 'assistant',
        model: 'claude-opus-5',
        content,
        stop_reason: rodada === 1 ? 'tool_use' : 'end_turn',
        usage: { input_tokens: 3100, output_tokens: 40, cache_read_input_tokens: 3100 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  };

  const nerixE2E = require('./src/nerix');
  const listProdutosReal = nerixE2E.listProducts;
  nerixE2E.listProducts = async () => ({
    data: [{ name: 'Zelda', slug: 'zelda', price: 49.9 }],
  });

  const resposta = await ai.reply('5541900002222', 'quanto custa zelda?', 'Ana');

  nerixE2E.listProducts = listProdutosReal;
  globalThis.fetch = fetchReal;

  t('a resposta chega ao cliente', resposta === 'O Zelda ta R$ 49,90 👍', resposta);
  t('  e foram duas voltas (ferramenta + resposta)', requisicoes.length === 2, String(requisicoes.length));

  const req1 = requisicoes[0].corpo;
  t('foi para a Anthropic', /api\.anthropic\.com|\/v1\/messages/.test(requisicoes[0].url),
    requisicoes[0].url);
  t('  com o modelo certo', req1.model === 'claude-opus-5', req1.model);
  // Os três que dão 400. Aqui é o JSON real que sai pela rede, não o objeto.
  t('  sem temperature no corpo', !('temperature' in req1), JSON.stringify(Object.keys(req1)));
  t('  com raciocínio adaptativo', req1.thinking?.type === 'adaptive');
  t('  e teto de tokens folgado', req1.max_tokens >= 2000, String(req1.max_tokens));

  // O cache: sem a marca, a conta quase dobra.
  t('  o system marcado para cache', req1.system?.[0]?.cache_control?.type === 'ephemeral');
  t('  as ferramentas no formato da Anthropic',
    req1.tools?.[0]?.input_schema && !req1.tools?.[0]?.function,
    JSON.stringify(Object.keys(req1.tools?.[0] || {})));

  // O nome do cliente vai no TURNO, depois do trecho cacheado. No system ele
  // daria a cada contato um prefixo próprio e o cache nunca seria lido.
  t('  o nome do cliente vai no turno de usuário',
    /\(cliente: Ana\)/.test(JSON.stringify(req1.messages)),
    JSON.stringify(req1.messages[0]).slice(0, 80));
  t('  e NÃO no system', !/\(cliente: Ana\)|Ana/.test(JSON.stringify(req1.system)));

  // A 2ª volta é a que mais dá 400: leva o resultado da ferramenta de volta.
  const req2 = requisicoes[1].corpo;
  const papeis2 = req2.messages.map((m) => m.role).join(',');
  t('a 2ª volta manda o resultado de volta', papeis2 === 'user,assistant,user', papeis2);
  t('  como tool_result amarrado ao id',
    req2.messages[2].content[0]?.tool_use_id === 'tu_1',
    JSON.stringify(req2.messages[2].content[0]?.type));
  // Sem isto o modelo volta sem saber por que tinha chamado a ferramenta.
  t('  preservando o raciocínio da 1ª volta',
    req2.messages[1].content.some((b) => b.type === 'thinking'),
    JSON.stringify(req2.messages[1].content.map((b) => b.type)));
  // E o prefixo tem que ser IDÊNTICO, senão o cache da 1ª volta não é lido.
  t('  com o mesmo prefixo cacheado da 1ª',
    JSON.stringify(req2.system) === JSON.stringify(req1.system) &&
      JSON.stringify(req2.tools) === JSON.stringify(req1.tools),
    'prefixo estável entre as voltas');

  // O histórico em disco não pode carregar o conteúdo cru da Anthropic.
  const histFile = require('path').join(process.env.PONTE_DATA_DIR, 'histories.json');
  const hist = require('fs').existsSync(histFile)
    ? require('fs').readFileSync(histFile, 'utf8')
    : '';
  t('o raciocínio não é gravado em disco', !hist.includes('preciso ver o preco'),
    hist.slice(0, 120) || '(vazio)');

  delete process.env.ANTHROPIC_API_KEY;

  // ── Sem chave, o módulo se desliga ────────────────────────
  //
  // O bot tem que continuar atendendo pela cascata antiga enquanto a chave não
  // estiver no painel. Estourar aqui deixaria o cliente sem resposta.
  bloco('sem chave, cai na cascata');
  const chaveAntes = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  t('disponivel() diz que não', claude.disponivel() === false);
  let erro = null;
  try {
    await claude.chat([{ role: 'user', content: 'oi' }]);
  } catch (e) {
    erro = e;
  }
  t('  e chat() falha em vez de travar', Boolean(erro), erro?.message);
  if (chaveAntes) process.env.ANTHROPIC_API_KEY = chaveAntes;

  console.log('\n' + (falhas ? falhas + ' FALHA(S)' : 'todos os testes passaram'));
  process.exit(falhas ? 1 : 0);
})();
