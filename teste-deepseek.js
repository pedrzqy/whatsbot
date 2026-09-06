'use strict';

/**
 * Testes do cérebro do bot (src/deepseek.js).
 * Roda sem tocar na rede: o fetch é dublado.
 *
 *   node teste-deepseek.js
 *
 * Este arquivo nasceu guardando uma FRONTEIRA: a IA barata podia fazer o
 * bastidor e não podia falar com o cliente. A fronteira acabou — é o mesmo
 * modelo nos dois lados agora — e o que ele guarda passou a ser o que a troca
 * trouxe junto: a foto que não pode virar base64 no corpo, as ferramentas que
 * PRECISAM ir para o atendimento, e o teto do dia.
 *
 * Nenhuma dessas falha em voz alta. Sem ferramenta o modelo responde preço de
 * memória; com a foto no corpo a conta explode calada. Por isso o teste.
 */

const os = require('os');
const path = require('path');
const fs = require('fs');

process.env.PONTE_DATA_DIR = path.join(os.tmpdir(), 'phaze-teste-deepseek');
fs.rmSync(process.env.PONTE_DATA_DIR, { recursive: true, force: true });
process.env.NERIX_API_KEY = 'teste';
process.env.PONTE_OPERADOR_NUMERO = '5541999999999';
process.env.EVOLUTION_API_KEY = 'teste';

// Vazio, e não `delete`: o config.js chama dotenv, que RELÊ o .env e repõe
// qualquer chave ausente — apagar aqui é ser sobrescrito um require depois.
process.env.DEEPSEEK_API_KEY = '';

const deepseek = require('./src/deepseek');

let falhas = 0;
const t = (nome, ok, extra = '') => {
  if (!ok) falhas++;
  console.log(`  ${ok ? 'ok  ' : 'FALHA'} | ${nome}${extra ? ` -> ${extra}` : ''}`);
};
const bloco = (nome) => console.log(`\n--- ${nome} ---`);

// ── O fetch dublado ─────────────────────────────────────────
const fetchReal = globalThis.fetch;
let chamadas = [];
let responder = () => ({ choices: [{ message: { role: 'assistant', content: 'ok' } }], usage: {} });

globalThis.fetch = async (url, init) => {
  const corpo = JSON.parse(init.body);
  chamadas.push({ url: String(url), corpo, headers: init.headers });
  const r = responder(corpo);
  if (r instanceof Error) throw r;
  if (r.status && r.status >= 400) {
    return { ok: false, status: r.status, text: async () => r.texto || '' };
  }
  return { ok: true, status: 200, json: async () => r };
};

const zerar = () => {
  chamadas = [];
  deepseek._zerar();
};

(async () => {
  // ── O corpo do POST ───────────────────────────────────────
  bloco('o corpo que sai');

  const corpo = deepseek.montarCorpo(
    [
      { role: 'system', content: 'você traduz' },
      { role: 'user', content: 'oi' },
    ],
    { maxTokens: 800 },
  );

  // O modelo TEM que existir no catálogo deles. Um nome errado dá 400 em 100%
  // das chamadas, e o desfecho é o cliente recebendo menu o dia inteiro sem
  // nada no WhatsApp dizendo por quê — o disjuntor abre e fecha em silêncio.
  const CATALOGO = ['deepseek-v4-flash', 'deepseek-v4-pro', 'deepseek-v4-flash-vision-exp'];
  t('o modelo é um que existe na API deles', CATALOGO.includes(deepseek.MODELO), deepseek.MODELO);
  t('  e é o flash, não o pro', /flash/.test(deepseek.MODELO), deepseek.MODELO);

  // Aqui temperature EXISTE (o Opus a rejeitava com 400) e o padrão é 1.0 —
  // alto demais para agrupar, traduzir e classificar, que é tudo o que se faz
  // por aqui. Deixar o padrão passar seria pagar por variação que ninguém quer.
  t('temperature vai baixa, não no padrão 1.0', corpo.temperature <= 0.3, String(corpo.temperature));
  t('max_tokens é respeitado', corpo.max_tokens === 800, String(corpo.max_tokens));
  t('não pede streaming', corpo.stream === false);

  // O system fica NO ARRAY. Na API da Anthropic ele saía para um parâmetro do
  // topo, e um port que copiasse aquela conversão para cá perderia a instrução
  // inteira — o modelo responderia sem saber a tarefa.
  t('o system continua dentro das mensagens',
    corpo.messages[0].role === 'system', JSON.stringify(corpo.messages.map((m) => m.role)));
  t('  e nada vira parâmetro do topo', corpo.system === undefined);

  // ── Sem chave, nem tenta ──────────────────────────────────
  bloco('sem chave');
  zerar();
  t('não está disponível sem chave', deepseek.disponivel() === false);
  t('  e temChave também diz não', deepseek.temChave() === false);
  await deepseek.chat([{ role: 'user', content: 'x' }]).then(
    () => t('chamar sem chave falha', false, 'não falhou'),
    (e) => t('chamar sem chave falha na hora', /DEEPSEEK_API_KEY/.test(e.message), e.message),
  );
  t('  sem tocar na rede', chamadas.length === 0, `${chamadas.length} chamada(s)`);

  // ── Uma chamada de verdade ────────────────────────────────
  bloco('a chamada');
  process.env.DEEPSEEK_API_KEY = 'chave-de-mentira';
  zerar();

  responder = () => ({
    choices: [{ message: { role: 'assistant', content: '  traduzido  ' } }],
    usage: { prompt_tokens: 100, prompt_cache_hit_tokens: 80, completion_tokens: 20 },
  });

  const msg = await deepseek.chat([{ role: 'user', content: 'traduz' }]);
  t('devolve no formato do bot', msg.role === 'assistant' && msg.content === 'traduzido', msg.content);
  t('bate no endereço certo', chamadas[0].url === 'https://api.deepseek.com/chat/completions',
    chamadas[0].url);
  t('  com a chave no header', /^Bearer /.test(chamadas[0].headers.Authorization));

  const u = deepseek.uso();
  t('conta o que gastou', u.n === 1 && u.entrada === 100, JSON.stringify(u));
  // O cache deles é automático. Aparece separado porque é ele que explica uma
  // conta menor sem menos trabalho feito — sem esta linha, "está economizando?"
  // não tem resposta.
  t('  e separa o que veio do cache', u.cache === 80, String(u.cache));

  // ── O disjuntor ───────────────────────────────────────────
  //
  // Chave sem saldo é o caso REAL: a conta do dono estava zerada no dia em que
  // isto entrou, e a API responde 402 na hora. O caso ruim é o provedor
  // pendurado — aí cada tentativa custa o timeout inteiro ANTES de cair no
  // menu, e foi assim que a cascata antiga passou a atrasar tudo em vez de
  // proteger.
  bloco('o disjuntor');
  zerar();
  responder = () => ({ status: 402, texto: '{"error":{"message":"Insufficient Balance"}}' });

  for (let i = 0; i < 3; i++) {
    await deepseek.chat([{ role: 'user', content: 'x' }]).catch((e) => {
      if (i === 0) {
        t('402 vira mensagem que o dono entende', /sem saldo/i.test(e.message), e.message);
        t('  dizendo onde resolver', /platform\.deepseek\.com/.test(e.message), e.message);
      }
    });
  }

  t('três falhas seguidas abrem o disjuntor', deepseek.disponivel() === false);
  t('  mas a chave continua lá', deepseek.temChave() === true);
  // A quarta NEM SAI PELA REDE. É isso que impede o provedor morto de custar
  // tempo: sem a trava, cada mensagem pagaria o timeout inteiro antes de cair
  // no menu, e o cliente esperaria um minuto para receber o que o menu entrega
  // na hora.
  const antesDoQuarto = chamadas.length;
  await deepseek.chat([{ role: 'user', content: 'x' }]).then(
    () => t('  e a quarta nem tenta', false, 'passou como se nada tivesse acontecido'),
    (e) => t('  e a quarta nem tenta', /descanso/i.test(e.message), e.message),
  );
  t('  sem tocar na rede', chamadas.length === antesDoQuarto,
    `${chamadas.length - antesDoQuarto} chamada(s) a mais`);

  // ── O CAMINHO DO CLIENTE ──────────────────────────────────
  //
  // Este é o bloco que importa. O resto acima é encanamento; aqui está o que
  // mudou quando este arquivo deixou de ser o barato do bastidor e virou o
  // único cérebro do bot.
  bloco('o cliente passa por aqui agora');
  zerar();
  process.env.DEEPSEEK_API_KEY = 'chave-de-mentira';
  responder = () => ({ choices: [{ message: { role: 'assistant', content: 'oi!' } }], usage: {} });

  const ai = require('./src/ai');
  const ferramentas = require('./src/tools');

  const resposta = await ai.chat([{ role: 'user', content: 'oi' }], { tools: ferramentas.definitions });
  t('a conversa com o cliente sai daqui', resposta.content === 'oi!', String(resposta.content));

  // A REGRESSÃO QUE QUASE PASSOU: o montarCorpo ignorava `opts.tools`.
  //
  // Fazia sentido enquanto isto era só bastidor — traduzir e resumir é texto
  // entra, texto sai, sem ferramenta nenhuma. No atendimento, sem elas o modelo
  // responde preço e status de pedido DE MEMÓRIA, que é exatamente o motivo de
  // a conversa livre ter sido desligada da primeira vez. E não daria erro:
  // daria uma resposta confiante e errada.
  t('  e as ferramentas vão junto',
    chamadas[0]?.corpo?.tools?.length === ferramentas.definitions.length,
    String(chamadas[0]?.corpo?.tools?.length ?? 'nenhuma'));
  t('  no formato que já circula no projeto',
    chamadas[0]?.corpo?.tools?.[0]?.type === 'function',
    JSON.stringify(chamadas[0]?.corpo?.tools?.[0] || {}).slice(0, 60));

  // Bastidor não manda ferramenta, e isso não é economia de byte: é o campo
  // não existir quando não faz sentido.
  chamadas = [];
  await ai.chat([{ role: 'user', content: 'traduz isto' }], { barato: true });
  t('bastidor não manda ferramenta', chamadas[0]?.corpo?.tools === undefined,
    String(chamadas[0]?.corpo?.tools?.length));

  // ── A FOTO NUNCA VIRA BASE64 NO CORPO ─────────────────────
  //
  // A armadilha mais cara do arquivo, e silenciosa. O turno de quem manda foto
  // é um ARRAY com a imagem inteira em data URI, e o `JSON.stringify` de antes
  // mandava isso como se fosse a pergunta do cliente. Uma foto de celular passa
  // de 500 KB. A chamada NÃO falha: só custa uma fortuna e o modelo responde
  // sobre uma parede de base64.
  bloco('a foto do cliente nunca vira base64 no corpo');
  const base64Falso = 'A'.repeat(4000);
  const corpoComFoto = deepseek.montarCorpo([
    {
      role: 'user',
      content: [
        { type: 'text', text: 'olha o erro que deu' },
        { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${base64Falso}` } },
      ],
    },
  ], {});
  const saiu = JSON.stringify(corpoComFoto);
  t('o base64 não aparece no corpo', !saiu.includes(base64Falso.slice(0, 200)),
    `${saiu.length} caracteres no corpo`);
  t('  e o corpo inteiro continua do tamanho de uma mensagem', saiu.length < 1000,
    `${saiu.length} caracteres`);
  t('  o texto dele continua lá', /olha o erro que deu/.test(corpoComFoto.messages[0].content),
    corpoComFoto.messages[0].content);
  t('  e o modelo fica sabendo que houve foto', /foto/.test(corpoComFoto.messages[0].content),
    corpoComFoto.messages[0].content);

  // ── Quem não enxerga não finge que enxerga ────────────────
  //
  // Dizer "você ENXERGA a imagem" para um modelo que não enxerga é pior que não
  // dizer nada: ele responde sobre a foto assim mesmo, com confiança, inventando
  // o que estaria escrito nela.
  bloco('quem não enxerga não finge que enxerga');
  t('o cérebro de hoje não vê imagem', ai.veImagem() === false, String(ai.veImagem()));
  const fonteDoAi = fs.readFileSync('src/ai.js', 'utf8');
  t('  e a instrução de FOTO acompanha o modelo', /veImagem\(\)\s*\n?\s*\?/.test(fonteDoAi));
  t('  dizendo que não vê', /NÃO consegue ver imagem/.test(fonteDoAi));
  t('  e mandando pedir o código do erro', /CÓDIGO DO ERRO/.test(fonteDoAi));
  const fonteDoHandlers = fs.readFileSync('src/handlers.js', 'utf8');
  t('  e a foto sem legenda nem chega ao modelo', /ai\.veImagem\(\)/.test(fonteDoHandlers));

  // ── O TETO DO DIA ─────────────────────────────────────────
  //
  // Não existia aqui, e não precisava: bastidor é trabalho que o operador
  // dispara, e operador não entra em laço. Cliente é volume que ninguém
  // controla, e o crédito da conta é pequeno de propósito.
  bloco('o teto do dia manda o cliente para o menu');
  zerar();
  responder = () => ({ choices: [{ message: { role: 'assistant', content: 'ok' } }], usage: {} });
  for (let i = 0; i < deepseek.TETO_DIA; i++) await deepseek.chat([{ role: 'user', content: 'x' }]);
  t(`as ${deepseek.TETO_DIA} do dia passam`, deepseek.uso().chamadas === deepseek.TETO_DIA,
    String(deepseek.uso().chamadas));
  const antesDoTeto = chamadas.length;
  await deepseek.chat([{ role: 'user', content: 'x' }]).then(
    () => t('  e a seguinte não sai', false, 'saiu como se nada tivesse acontecido'),
    (e) => t('  e a seguinte não sai', /teto/i.test(e.message), e.message),
  );
  t('  sem tocar na rede', chamadas.length === antesDoTeto,
    `${chamadas.length - antesDoTeto} chamada(s) a mais`);
  // Estourar o teto é decisão nossa, não falha do provedor. Se contasse como
  // falha, um dia movimentado abriria o disjuntor por cima de um erro que nunca
  // existiu — e a meia hora de castigo cairia em cima de um dia bom.
  t('  e o disjuntor continua fechado', deepseek.disponivel() === true);
  deepseek._zerar();

  // ── Quem declara que ninguém está esperando ───────────────
  //
  // `barato` não escolhe mais provedor: só existe um. Ele agora significa
  // PRAZO — um minuto em vez de 25 segundos, porque o analista lê um mês de
  // conversa de uma vez e desistir no meio joga fora o token já gasto.
  //
  // Lê o código-fonte de propósito. Um teste de comportamento cobriria os três
  // de hoje; este cobre o QUARTO, escrito daqui a três meses por alguém que
  // copiou a linha de cima sem ler este arquivo. Se a porta do cliente passar a
  // declarar isso, quem espera o minuto olhando "digitando..." é o cliente.
  bloco('quem declara que ninguém está esperando');

  const fontes = {
    'src/hermes.js': true,
    'src/ponte/tradutor.js': true,
    'src/ponte/index.js': true,
    'src/handlers.js': false, // o caminho do cliente
  };
  for (const [arq, deveTer] of Object.entries(fontes)) {
    const tem = /barato:\s*true/.test(fs.readFileSync(arq, 'utf8'));
    t(`${arq} ${deveTer ? 'pede' : 'NÃO pede'} o barato`, tem === deveTer, tem ? 'pede' : 'não pede');
  }

  // callWithTools é a porta do cliente. Se um dia ela passar `barato`, a
  // conversa inteira muda de modelo sem ninguém decidir isso.
  const fonteAi = fs.readFileSync('src/ai.js', 'utf8');
  const portaDoCliente = fonteAi.slice(
    fonteAi.indexOf('function callWithTools'),
    fonteAi.indexOf('function callWithTools') + 200,
  );
  t('a porta do cliente não pede barato', !/barato/.test(portaDoCliente), portaDoCliente.slice(0, 90));

  // ── O painel ──────────────────────────────────────────────
  //
  // A ordem do catálogo é o número que o dono digita, e ele decora a POSIÇÃO,
  // não o nome. Uma chave inserida no meio faria o "#admin 5" dele virar outra
  // função da noite para o dia — com as de risco alto na lista, isso é ligar a
  // coisa errada achando que ligou outra.
  bloco('tirar a chave velha não mexeu nas outras');
  const chavesMod = require('./src/chaves');
  const ORDEM = ['atendimento', 'ia', 'vender', 'codigos', 'aprovacao', 'repertorio', 'conferir', 'reativar'];
  ORDEM.forEach((id, i) => {
    t(`#admin ${i + 1} continua sendo ${id}`, chavesMod.CATALOGO[i].id === id,
      chavesMod.CATALOGO[i].id);
  });
  // "Economia nos bastidores" era a 9ª e saiu: com um modelo só nos dois lados,
  // ela não tinha mais o que escolher. Era a ÚLTIMA, então nenhum número mudou
  // — e é isso que este teste guarda, porque o dono decora a POSIÇÃO.
  t('e a 9 não existe mais', chavesMod.CATALOGO.length === 8,
    `${chavesMod.CATALOGO.length} chaves`);

  // Daqui para baixo é a chave 2, "Conversa livre". Ela passou a perguntar pelo
  // DeepSeek em vez do provedor antigo — e continua tendo que fazer as DUAS
  // perguntas, porque a segunda é a que o painel já errou antes.
  //
  // Sem a chave no servidor, ligada no painel é ligada-e-parada. É a lição do
  // dia em que a conversa livre aparecia ✅ sem chave nenhuma e uma investigação
  // inteira foi gasta procurando bug no atendimento.
  const chaveIA = chavesMod.CATALOGO[1];
  process.env.DEEPSEEK_API_KEY = '';
  t('sem a chave, o painel avisa em vez de mentir',
    /DEEPSEEK_API_KEY/.test(chaveIA.impedimento() || ''),
    String(chaveIA.impedimento()));
  process.env.DEEPSEEK_API_KEY = 'chave-de-mentira';
  deepseek._zerar();
  t('  e com a chave não sobra aviso', chaveIA.impedimento() === null,
    String(chaveIA.impedimento()));

  // O caso que ENGANA, e que este projeto já pagou uma vez para aprender: a
  // chave está lá e a conta está sem saldo. Ligada no painel, ✅ na tela, e todo
  // cliente caindo no menu sem erro nenhum aparecendo.
  zerar();
  responder = () => ({ status: 402, texto: 'Insufficient Balance' });
  for (let i = 0; i < 3; i++) await deepseek.chat([{ role: 'user', content: 'x' }]).catch(() => {});
  t('ligada mas parada NÃO aparece como ✅',
    /falhou várias vezes/.test(chaveIA.impedimento() || ''),
    String(chaveIA.impedimento()));
  t('  e o painel diz quem está respondendo enquanto isso',
    /menu/.test(chaveIA.impedimento() || ''),
    String(chaveIA.impedimento()));
  deepseek._zerar();

  // ── A chave não pode estar no repositório ─────────────────
  //
  // O dono já expôs uma chave num print, e mandou esta por mensagem. Ela mora
  // no Environment do painel e em lugar nenhum mais: um segredo commitado é
  // público para sempre, mesmo depois de apagado, porque o histórico fica.
  bloco('nenhum segredo no código');
  for (const arq of ['src/deepseek.js', 'src/ai.js', 'src/config.js', 'src/chaves.js']) {
    const texto = fs.readFileSync(arq, 'utf8');
    t(`${arq} não tem chave escrita dentro`, !/sk-[a-f0-9]{20,}/i.test(texto),
      (texto.match(/sk-[a-f0-9]{8}/i) || [''])[0] || 'limpo');
  }

  globalThis.fetch = fetchReal;
  console.log('\n' + (falhas ? falhas + ' FALHA(S)' : 'todos os testes passaram'));
  process.exit(falhas ? 1 : 0);
})();
