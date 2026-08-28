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
  // Antes da PRIMEIRA chamada de proposito: o cliente do SDK e criado uma vez
  // so, e os cabecalhos padrao sao fixados nesse instante. Definir depois nao
  // alcancaria nada -- e o teste passaria medindo um cliente sem cabecalho.
  process.env.ANTHROPIC_WORKSPACE_ID = 'wrkspc_de_mentira';

  // UM duble so para o arquivo inteiro, com o comportamento trocavel.
  //
  // O SDK da Anthropic captura o `fetch` no momento em que o cliente e criado,
  // e o cliente e criado uma vez so. Instalar um duble novo depois disso nao
  // alcanca nada: as chamadas continuam indo para o primeiro, e o bloco seguinte
  // media o array errado -- que foi exatamente o que aconteceu aqui.
  const fetchReal = globalThis.fetch;
  let responder = null;
  globalThis.fetch = async (url, init) => responder(url, init);

  const requisicoes = [];
  let rodada = 0;

  responder = async (url, init) => {
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

  // ── O cabeçalho do workspace, NA REDE ──
  //
  // A Anthropic tem dois tipos de chave, e a "identity-linked" recusa TODA
  // chamada com 400 se este cabeçalho não for junto. Aconteceu de verdade: o
  // dono rotacionou a chave, criou uma desse tipo, e o bot passou a responder
  // o menu de "não entendi" a tudo -- sem nada no atendimento ter mudado.
  //
  // O SDK lê ANTHROPIC_WORKSPACE_ID sozinho, mas só no caminho de login
  // federado; com chave de API comum ele nunca manda. Por isso o teste é na
  // REDE e não na função: o que importa é o cabeçalho ter saído.
  const cab = requisicoes[0].headers;
  const pego = typeof cab?.get === 'function'
    ? cab.get('anthropic-workspace-id')
    : cab?.['anthropic-workspace-id'] || cab?.['Anthropic-Workspace-Id'];
  t('  o workspace vai no cabeçalho', pego === 'wrkspc_de_mentira', String(pego));

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

  // Vazio, e nao `delete`. O config.js chama dotenv, que RE-LE o .env e repoe
// qualquer chave que nao esteja em process.env -- entao apagar aqui e ser
// sobrescrito um require depois. Definida como string vazia, a chave existe
// (dotenv nao mexe) e e falsy (nenhum provedor nasce).
process.env.ANTHROPIC_API_KEY = '';

  // ── O cliente manda foto: o modelo ENXERGA ─────────────────
  //
  // Antes a imagem só existia para a ponte — o modelo nunca via nada. O cliente
  // printava a tela de erro, a IA respondia no escuro e transferia para o
  // operador: um atendimento inteiro gasto num dado que estava ali.
  bloco('a foto chega ao modelo');

  const PIXEL =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

  const comFoto = claude.converterMensagens([
    { role: 'system', content: 'sys' },
    {
      role: 'user',
      content: [
        { type: 'text', text: '(cliente: Ana)\nolha o erro que deu' },
        { type: 'image_url', image_url: { url: `data:image/png;base64,${PIXEL}` } },
      ],
    },
  ]);

  const blocos = comFoto.messages[0].content;
  t('o turno do cliente vira blocos', Array.isArray(blocos), typeof blocos);
  t('  com o texto', blocos?.[0]?.type === 'text' && /olha o erro/.test(blocos[0].text),
    JSON.stringify(blocos?.[0]).slice(0, 60));
  t('  e a imagem no formato da Anthropic',
    blocos?.[1]?.type === 'image' && blocos[1].source?.type === 'base64',
    JSON.stringify(blocos?.[1]?.source?.media_type));
  t('  com o media_type lido do data URI', blocos?.[1]?.source?.media_type === 'image/png',
    blocos?.[1]?.source?.media_type);
  t('  e o base64 sem o prefixo', blocos?.[1]?.source?.data === PIXEL,
    String(blocos?.[1]?.source?.data).slice(0, 20));

  // Sem esta conversão, String(content) num array daria "[object Object]" — o
  // modelo receberia isso como a mensagem do cliente e responderia a respeito.
  t('nunca vira "[object Object]"',
    !JSON.stringify(comFoto.messages).includes('object Object'),
    JSON.stringify(comFoto.messages).slice(0, 80));

  // Link externo NÃO passa: a única fonte de imagem aqui é o download que o
  // próprio bot fez, e buscar URL de fora seria outra coisa.
  const comLinkExterno = claude.converterMensagens([
    { role: 'system', content: 'sys' },
    {
      role: 'user',
      content: [
        { type: 'text', text: 'olha' },
        { type: 'image_url', image_url: { url: 'https://algum-site.com/foto.png' } },
      ],
    },
  ]);
  t('link externo de imagem é descartado',
    !JSON.stringify(comLinkExterno.messages).includes('algum-site'),
    JSON.stringify(comLinkExterno.messages));
  t('  mas o texto do cliente sobrevive',
    comLinkExterno.messages[0].content.some((b) => b.type === 'text'));

  // ── A foto NÃO pode ficar no histórico em disco ──
  //
  // Foto de celular em base64 passa de 500 KB. Guardada, ela seria REENVIADA em
  // toda mensagem seguinte daquele contato, depois do trecho cacheado, no preço
  // cheio. Uma conversa de cinco turnos custaria cinco fotos.
  bloco('a foto não fica no histórico');

  const aiFoto = require('./src/ai');
  aiFoto.clearHistory('5541977770001');

  process.env.ANTHROPIC_API_KEY = 'chave-de-mentira';
  const corposEnviados = [];
  responder = async (url, init) => {
    corposEnviados.push(JSON.parse(init.body));
    return new Response(
      JSON.stringify({
        id: 'm', type: 'message', role: 'assistant', model: 'claude-opus-5',
        content: [{ type: 'text', text: 'Vi aqui, e um erro de ativacao 👍' }],
        stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  };

  await aiFoto.reply('5541977770001', 'olha o erro', 'Ana', {
    imagemBase64: { base64: PIXEL, mimetype: 'image/png' },
  });
  // Segunda mensagem, sem foto: é aqui que o custo se repetiria.
  await aiFoto.reply('5541977770001', 'e agora?', 'Ana');
  delete process.env.ANTHROPIC_API_KEY;

  t('a 1ª chamada leva a foto',
    JSON.stringify(corposEnviados[0]).includes(PIXEL), 'foto enviada');
  t('a 2ª chamada NÃO releva a foto',
    !JSON.stringify(corposEnviados[1]).includes(PIXEL),
    corposEnviados[1] ? 'sem a foto' : 'nao houve 2a chamada');
  t('  mas o modelo lembra que houve uma',
    /mandou uma foto/.test(JSON.stringify(corposEnviados[1])),
    JSON.stringify(corposEnviados[1]?.messages?.[0]).slice(0, 90));

  const histFoto = require('path').join(process.env.PONTE_DATA_DIR, 'histories.json');
  const conteudoHist = require('fs').existsSync(histFoto)
    ? require('fs').readFileSync(histFoto, 'utf8') : '';
  t('e o disco não guarda o base64', !conteudoHist.includes(PIXEL),
    `${Math.round(conteudoHist.length / 1024)} KB de histórico`);

  // ── Áudio vira texto ───────────────────────────────────────
  //
  // audioMessage não era extraído em lugar nenhum: `text` chegava vazio e o
  // cliente falava com uma parede. Com a IA ligada era pior — o bot mandava ao
  // modelo "(o cliente mandou uma foto sem escrever nada)" e a IA respondia
  // sobre uma foto que não existe.
  bloco('áudio vira texto');

  const transcricao = require('./src/transcricao');

  t('sem chave configurada, não tenta', transcricao.disponivel() === false);
  const semChaveAudio = await transcricao.transcrever('AAAA', 'audio/ogg', 5);
  t('  e devolve motivo em vez de estourar', semChaveAudio.motivo === 'sem_chave',
    JSON.stringify(semChaveAudio));

  process.env.TRANSCRICAO_API_KEY = 'chave-falsa';
  t('com chave, fica disponível', transcricao.disponivel() === true);

  // Áudio comprido nem é baixado: a duração já vem no webhook, e baixar para
  // descartar é pagar o download à toa.
  const comprido = await transcricao.transcrever('AAAA', 'audio/ogg', 9999);
  t('áudio comprido é recusado antes de sair', comprido.motivo === 'longo_demais',
    JSON.stringify(comprido));

  const respondedorAntes = responder;
  let enviadoAoWhisper = null;
  responder = async (url, init) => {
    enviadoAoWhisper = { url: String(url), form: init.body };
    return new Response(JSON.stringify({ text: 'oi, comprei ontem e nao chegou' }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  };
  const ouvido = await transcricao.transcrever(
    Buffer.from('audio-de-mentira').toString('base64'), 'audio/ogg; codecs=opus', 6,
  );
  responder = respondedorAntes;

  t('transcreve', ouvido.texto === 'oi, comprei ontem e nao chegou', ouvido.texto);
  t('  usando a chave que já está paga na cascata',
    /groq\.com/.test(enviadoAoWhisper?.url || ''), enviadoAoWhisper?.url);
  // O nome do arquivo importa: o Whisper decide o decodificador pela extensão,
  // e o áudio do WhatsApp é sempre opus dentro de ogg.
  const arquivo = enviadoAoWhisper?.form?.get('file');
  t('  com a extensão certa no nome', String(arquivo?.name || '').endsWith('.ogg'), arquivo?.name);
  t('  e em português fixo', enviadoAoWhisper?.form?.get('language') === 'pt');

  // API fora do ar não pode virar exceção: exceção não tem saída, o motivo tem.
  responder = async () => new Response('rate limited', { status: 429 });
  const recusado = await transcricao.transcrever(Buffer.from('x').toString('base64'), 'audio/ogg', 3);
  responder = respondedorAntes;
  t('API recusando não estoura', recusado.texto === null && recusado.motivo === 'api_recusou',
    JSON.stringify(recusado));

  // O que o cliente lê quando não deu para ouvir. Ele precisa saber o que
  // fazer — cair no menu com "não entendi" depois de um áudio faz ele achar
  // que o bot ignorou.
  for (const motivo of ['sem_chave', 'longo_demais', 'api_recusou', 'falhou']) {
    const d = transcricao.desculpa(motivo);
    t(`a desculpa de "${motivo}" pede por escrito`, /escrev|palavras/i.test(d), d);
    // A lista de vocabulario proibido vem do politica.js, que e a fonte unica.
    t(`  e não admite defeito nem entrega a origem`,
      !/erro|falha|sistema|problema/i.test(d) &&
        !/fornecedor|taobao|vendedor/i.test(d) &&
        !require('./src/ponte/politica').vocabularioProibido().test(d),
      d);
  }
  delete process.env.TRANSCRICAO_API_KEY;

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

  // ── O tipo da chave ───────────────────────────────────────
  //
  // Chave comum nao quer o cabecalho do workspace, e mandar um vazio seria
  // pior do que nao mandar. So a "identity-linked" precisa dele.
  bloco('o tipo da chave');

  const wsAntes = process.env.ANTHROPIC_WORKSPACE_ID;
  process.env.ANTHROPIC_WORKSPACE_ID = '';
  t('sem workspace, nenhum cabeçalho extra',
    Object.keys(claude.cabecalhosDaChave()).length === 0,
    JSON.stringify(claude.cabecalhosDaChave()));

  // Espaco em branco no painel e um classico: colar o id com um espaco atras
  // mandaria " wrkspc_1" e a API recusaria igual.
  process.env.ANTHROPIC_WORKSPACE_ID = '  wrkspc_1  ';
  t('com workspace, o cabeçalho aparece limpo',
    claude.cabecalhosDaChave()['anthropic-workspace-id'] === 'wrkspc_1',
    JSON.stringify(claude.cabecalhosDaChave()));
  process.env.ANTHROPIC_WORKSPACE_ID = wsAntes || '';

  // ── O erro de chave vira instrucao ────────────────────────
  //
  // O que chegava ao log era o JSON cru da API, e um 400 de chave ficava
  // igual a um 400 de pedido malformado. Custou uma rodada inteira de
  // investigacao no atendimento quando o problema era o tipo da chave.
  const ditos = [];
  const errReal = console.error;
  console.error = (...a) => ditos.push(a.join(' '));

  claude.explicarErroDeChave({
    status: 400,
    message: '400 {"type":"error","error":{"type":"invalid_request_error","message":' +
      '"anthropic-workspace-id is required when authenticating with an identity-linked API key"}}',
  });
  t('o erro do workspace vira instrução', /ANTHROPIC_WORKSPACE_ID/.test(ditos.join(' ')),
    ditos[0] || '(calado)');
  t('  dizendo tambem a saída mais simples', /dentro de um workspace/i.test(ditos.join(' ')),
    ditos.join(' ').slice(-60));

  ditos.length = 0;
  claude.explicarErroDeChave({ status: 401, message: '401 invalid x-api-key' });
  t('chave recusada diz onde colar a nova', /ANTHROPIC_API_KEY/.test(ditos.join(' ')),
    ditos[0] || '(calado)');

  // Erro desconhecido segue cru: inventar explicacao e pior do que mostrar o
  // erro de verdade, porque manda o dono consertar a coisa errada.
  ditos.length = 0;
  claude.explicarErroDeChave({ status: 500, message: 'internal server error' });
  t('erro desconhecido não ganha explicação inventada', ditos.length === 0, ditos.join(' '));
  console.error = errReal;

  console.log('\n' + (falhas ? falhas + ' FALHA(S)' : 'todos os testes passaram'));
  process.exit(falhas ? 1 : 0);
})();
