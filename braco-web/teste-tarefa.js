'use strict';

/**
 * Testa a EXECUÇÃO das tarefas — qual sequência sai para cada tipo.
 *
 *   node teste-tarefa.js
 *
 * Existe por causa de uma diferença que não aparece no código: os dois
 * serviços são deployados separado. Uma tarefa criada por uma versão nova do
 * bot pode chegar num braço antigo, e uma tarefa antiga pode chegar num braço
 * novo — os dois casos têm que sair, e nenhum pode mandar a coisa errada.
 *
 * Não abre navegador: chat e API são dublês.
 */

process.env.PONTE_BRACO_KEY = 'teste';
process.env.BOT_URL = 'http://localhost:0';

// Dublê do cliente HTTP, instalado ANTES de requerer o módulo: o `api` do braço
// é criado uma vez, na carga, e trocar depois não alcança a instância que ele
// já guardou. Com o require primeiro, o teste sai para a rede de verdade.
const axios = require('axios');
const reportado = [];
const criarReal = axios.create;
axios.create = () => ({
  post: async (url, corpo) => { reportado.push({ url, corpo }); return { data: {} }; },
  get: async () => ({ data: {} }),
});

const { executarTarefa } = require('./src/index');
axios.create = criarReal;

let falhas = 0;
const t = (nome, cond, extra = '') => {
  console.log((cond ? '  ok  ' : 'FALHA') + ' | ' + nome + (extra ? ' -> ' + extra : ''));
  if (!cond) falhas++;
};
const bloco = (nome) => console.log('\n--- ' + nome + ' ---');

/** Chat dublê: registra a sequência de ações, na ordem. */
function chatFalso() {
  const feito = [];
  return {
    feito,
    abrirConversa: async (titulo) => { feito.push(`abrirConversa:${titulo}`); },
    marca: async () => { feito.push('marca'); return { ate: '2026-08-27', chaves: [] }; },
    enviarFoto: async () => { feito.push('enviarFoto'); return { via: 'clipboard' }; },
    irParaOFim: async () => { feito.push('irParaOFim'); },
    enviarTexto: async (txt) => { feito.push(`enviarTexto:${txt}`); },
  };
}

(async () => {
  // ── Tipo novo: responder ao outro lado ──────────────────
  bloco('responder_fornecedor');

  const chat1 = chatFalso();
  reportado.length = 0;
  const marca1 = await executarTarefa(
    chat1,
    { id: '1', tipo: 'responder_fornecedor', textoZh: '账号：rrtt9321', tentativa: 1 },
    '山王电玩',
  );

  t('abre a conversa antes de tudo', chat1.feito[0]?.startsWith('abrirConversa'), chat1.feito[0]);
  // A marca vem ANTES do envio: é dela que sai o corte do "o que é novo". Sem
  // isso, a própria mensagem que acabou de sair seria lida como resposta dele.
  t('  marca ANTES de mandar', chat1.feito.indexOf('marca') < chat1.feito.findIndex((f) => f.startsWith('enviarTexto')),
    chat1.feito.join(' → '));
  t('  manda o texto que veio pronto', chat1.feito.includes('enviarTexto:账号：rrtt9321'),
    chat1.feito.join(' → '));
  // Sem foto: a foto é o print da tela do CLIENTE e só faz sentido no pedido de
  // código. Mandá-la aqui seria o mesmo print pela segunda vez no chat dele.
  t('  e NÃO manda foto', !chat1.feito.includes('enviarFoto'), chat1.feito.join(' → '));
  t('  reporta sucesso', reportado.some((r) => r.url === '/resultado' && r.corpo.ok === true),
    JSON.stringify(reportado.map((r) => r.url)));
  t('  e devolve a marca para ler a resposta dele', Boolean(marca1 && marca1.ate), JSON.stringify(marca1));

  // ── Resposta sem texto: falha, não sucesso silencioso ────
  //
  // Reportar sucesso aqui deixaria o cliente esperando as 4h do timeout por uma
  // mensagem que nunca foi digitada.
  bloco('resposta sem texto');

  const chat2 = chatFalso();
  reportado.length = 0;
  const marca2 = await executarTarefa(chat2, { id: '2', tipo: 'responder_fornecedor', textoZh: '  ', tentativa: 1 }, 'x');

  t('não manda nada', !chat2.feito.some((f) => f.startsWith('enviarTexto')), chat2.feito.join(' → '));
  t('  reporta FALHA', reportado.some((r) => r.url === '/resultado' && r.corpo.ok === false),
    JSON.stringify(reportado.filter((r) => r.url === '/resultado').map((r) => r.corpo)));
  t('  marcada como fatal, para não repetir sem texto',
    reportado.some((r) => r.url === '/resultado' && r.corpo.fatal === true));
  t('  e sem marca', marca2 === null, String(marca2));

  // ── Tipo antigo continua funcionando ────────────────────
  //
  // O bot e o braço são deployados separado. Uma tarefa sem `tipo`, criada por
  // uma versão anterior, tem que sair igual — cair no switch e não fazer nada
  // deixaria o cliente esperando sem ninguém saber.
  bloco('pedir_codigo (o de sempre)');

  const chat3 = chatFalso();
  reportado.length = 0;
  await executarTarefa(chat3, { id: '3', tipo: 'pedir_codigo', usuario: 'rrtt9321', tentativa: 1 }, 'x');
  t('manda o usuário', chat3.feito.includes('enviarTexto:rrtt9321'), chat3.feito.join(' → '));
  t('  e reporta sucesso', reportado.some((r) => r.url === '/resultado' && r.corpo.ok === true));

  const chat4 = chatFalso();
  reportado.length = 0;
  await executarTarefa(chat4, { id: '4', usuario: 'ffgg2093', tentativa: 1 }, 'x');
  t('tarefa SEM tipo cai no fluxo antigo', chat4.feito.includes('enviarTexto:ffgg2093'),
    chat4.feito.join(' → '));

  // Tipo desconhecido, vindo de uma versão futura do bot: também cai no fluxo
  // antigo em vez de sumir. Não é o ideal, mas é o desfecho visível — o
  // operador vê o envio errado; um envio que nunca acontece ninguém vê.
  const chat5 = chatFalso();
  await executarTarefa(chat5, { id: '5', tipo: 'algo_que_nao_existe', usuario: 'zzz1111', tentativa: 1 }, 'x');
  t('tipo desconhecido não some em silêncio',
    chat5.feito.some((f) => f.startsWith('enviarTexto')), chat5.feito.join(' → '));

  console.log('');
  if (falhas) {
    console.log(`${falhas} falha(s).`);
    process.exit(1);
  }
  console.log('todos passaram');
})();
