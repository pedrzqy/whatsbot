'use strict';

/**
 * Testes da IA barata (src/deepseek.js) e de QUEM pode usá-la.
 * Roda sem tocar na rede: o fetch é dublado.
 *
 *   node teste-deepseek.js
 *
 * O que este arquivo protege não é o provedor, é a FRONTEIRA. Trocar o modelo
 * de um trabalho de bastidor é decisão de custo; trocar o da conversa com o
 * cliente é a cascata de seis provedores voltando pela porta dos fundos — e
 * aquela custava até 40 segundos de "digitando..." por provedor fora do ar.
 * Nada aqui quebra em voz alta se essa linha for cruzada: o bot continua
 * respondendo, só que devagar e com outro modelo. Por isso o teste.
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
process.env.ANTHROPIC_API_KEY = '';
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
  // das chamadas, e aqui isso é invisível: cai no Claude e tudo funciona igual,
  // só que a economia nunca acontece e nada no WhatsApp diz por quê.
  const CATALOGO = ['deepseek-v4-flash', 'deepseek-v4-pro', 'deepseek-v4-flash-vision-exp'];
  t('o modelo é um que existe na API deles', CATALOGO.includes(deepseek.MODELO), deepseek.MODELO);
  t('  e é o flash, não o pro', /flash/.test(deepseek.MODELO), deepseek.MODELO);

  // Ao contrário do Claude, aqui temperature EXISTE e o padrão da casa é 1.0 —
  // alto demais para agrupar, traduzir e classificar, que é tudo o que se faz
  // por aqui. Deixar o padrão passar seria pagar por variação que ninguém quer.
  t('temperature vai baixa, não no padrão 1.0', corpo.temperature <= 0.3, String(corpo.temperature));
  t('max_tokens é respeitado', corpo.max_tokens === 800, String(corpo.max_tokens));
  t('não pede streaming', corpo.stream === false);

  // O system fica NO ARRAY, e isso é o oposto do claude.js — lá ele sai para um
  // parâmetro do topo. Um port que copiasse a conversão do Claude para cá
  // perderia a instrução inteira, e o modelo responderia sem saber a tarefa.
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
  // Claude, e foi assim que a cascata antiga passou a atrasar tudo em vez de
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
  // tempo: sem a trava, cada trabalho pagaria o timeout inteiro antes de cair
  // no Claude, e o bastidor passaria a demorar o dobro para dar no mesmo.
  const antesDoQuarto = chamadas.length;
  await deepseek.chat([{ role: 'user', content: 'x' }]).then(
    () => t('  e a quarta nem tenta', false, 'passou como se nada tivesse acontecido'),
    (e) => t('  e a quarta nem tenta', /descanso/i.test(e.message), e.message),
  );
  t('  sem tocar na rede', chamadas.length === antesDoQuarto,
    `${chamadas.length - antesDoQuarto} chamada(s) a mais`);

  // ── A FRONTEIRA: quem pode usar o barato ──────────────────
  //
  // Este é o bloco que importa. O resto acima é encanamento; aqui está a regra
  // que não pode ser quebrada por descuido de quem editar o ai.js depois.
  bloco('o cliente NUNCA passa pelo barato');
  process.env.ANTHROPIC_API_KEY = 'chave-claude-de-mentira';
  zerar();
  responder = () => ({ choices: [{ message: { role: 'assistant', content: 'do barato' } }], usage: {} });

  const ai = require('./src/ai');
  const claude = require('./src/claude');
  const claudeReal = claude.chat;
  let foiNoClaude = 0;
  claude.chat = async () => { foiNoClaude++; return { role: 'assistant', content: 'do claude' }; };

  try {
    // Sem `barato`, é o caminho do cliente. Tem que ir no Claude mesmo com a
    // chave do DeepSeek configurada e o provedor respondendo bem.
    const semBarato = await ai.chat([{ role: 'user', content: 'oi' }]);
    t('chamada normal vai no Claude', semBarato.content === 'do claude', semBarato.content);
    t('  e nem encosta no barato', chamadas.length === 0, `${chamadas.length} chamada(s)`);

    // Com `barato`, vai no DeepSeek.
    const comBarato = await ai.chat([{ role: 'user', content: 'oi' }], { barato: true });
    t('trabalho de bastidor vai no barato', comBarato.content === 'do barato', comBarato.content);
    t('  e o Claude não é chamado', foiNoClaude === 1, `${foiNoClaude} chamada(s) ao Claude`);

    // E quando o barato falha, o trabalho SAI IGUAL. Quem chamou pediu uma
    // análise, não um provedor: se ele visse o erro, o #analisar responderia
    // "não consegui" com o Claude pago e disponível do lado.
    responder = () => ({ status: 500, texto: 'boom' });
    const caiu = await ai.chat([{ role: 'user', content: 'oi' }], { barato: true });
    t('barato fora do ar cai no Claude sem reclamar', caiu.content === 'do claude', caiu.content);
    t('  e o chamador não vê erro nenhum', foiNoClaude === 2, String(foiNoClaude));

    // O interruptor do painel manda. Desligado, o barato não é tentado mesmo
    // com chave boa — senão seria interruptor decorativo, que é pior que
    // interruptor nenhum.
    const chaves = require('./src/chaves');
    responder = () => ({ choices: [{ message: { role: 'assistant', content: 'do barato' } }], usage: {} });
    deepseek._zerar();
    chamadas = [];
    chaves.definir('barato', false);
    const desligado = await ai.chat([{ role: 'user', content: 'oi' }], { barato: true });
    t('desligado no painel, o barato não é tentado', chamadas.length === 0,
      `${chamadas.length} chamada(s)`);
    t('  e o trabalho sai pelo Claude', desligado.content === 'do claude', desligado.content);
    chaves.definir('barato', null);
  } finally {
    claude.chat = claudeReal;
  }

  // ── Os três de bastidor pedem barato, e só eles ───────────
  //
  // Lê o código-fonte de propósito. Um teste de comportamento cobriria os três
  // de hoje; este cobre o QUARTO, escrito daqui a três meses por alguém que
  // copiou a linha de cima sem ler este arquivo.
  bloco('quem declara barato');

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
  bloco('a chave nova não mexeu nas antigas');
  const chavesMod = require('./src/chaves');
  const ORDEM = ['atendimento', 'ia', 'vender', 'codigos', 'aprovacao', 'repertorio', 'conferir', 'reativar'];
  ORDEM.forEach((id, i) => {
    t(`#admin ${i + 1} continua sendo ${id}`, chavesMod.CATALOGO[i].id === id,
      chavesMod.CATALOGO[i].id);
  });
  t('e a nova é a 9', chavesMod.CATALOGO[8]?.id === 'barato', chavesMod.CATALOGO[8]?.id);

  // Sem a chave no servidor, ligada no painel é ligada-e-parada. É a mesma
  // lição do dia em que a conversa livre aparecia ✅ sem ANTHROPIC_API_KEY e
  // uma investigação inteira foi gasta procurando bug no atendimento.
  process.env.DEEPSEEK_API_KEY = '';
  t('sem a chave, o painel avisa em vez de mentir',
    /DEEPSEEK_API_KEY/.test(chavesMod.CATALOGO[8].impedimento() || ''),
    String(chavesMod.CATALOGO[8].impedimento()));
  process.env.DEEPSEEK_API_KEY = 'chave-de-mentira';
  deepseek._zerar();
  t('  e com a chave não sobra aviso', chavesMod.CATALOGO[8].impedimento() === null,
    String(chavesMod.CATALOGO[8].impedimento()));

  // O caso que ENGANA, e que este projeto já pagou uma vez para aprender: a
  // chave está lá e a conta está sem saldo. Ligada no painel, ✅ na tela, e o
  // trabalho saindo todo pelo Claude sem erro nenhum aparecendo. Era assim que
  // a conversa livre ficava ✅ sem ANTHROPIC_API_KEY.
  zerar();
  responder = () => ({ status: 402, texto: 'Insufficient Balance' });
  for (let i = 0; i < 3; i++) await deepseek.chat([{ role: 'user', content: 'x' }]).catch(() => {});
  t('ligada mas parada NÃO aparece como ✅',
    /falhou várias vezes/.test(chavesMod.CATALOGO[8].impedimento() || ''),
    String(chavesMod.CATALOGO[8].impedimento()));
  t('  e o painel diz que o trabalho continua saindo',
    /sai pela cara/.test(chavesMod.CATALOGO[8].impedimento() || ''),
    String(chavesMod.CATALOGO[8].impedimento()));
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
