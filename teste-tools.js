'use strict';

/**
 * Testes das ferramentas que a IA pode chamar (src/tools.js).
 * Roda sem tocar na Nerix: o cliente HTTP é substituído por dublês.
 *
 *   node teste-tools.js
 *
 * O foco é o que dá para errar com consequência: a chave da Nerix é de ADMIN,
 * então uma ferramenta mal fechada lê pedido de qualquer cliente da loja.
 */

process.env.NERIX_API_KEY = 'teste';
process.env.PONTE_OPERADOR_NUMERO = '5541999999999';
process.env.PONTE_BRACO_KEY = 'teste';
process.env.PONTE_DATA_DIR = require('path').join(require('os').tmpdir(), 'phaze-teste-tools');

const fs = require('fs');
fs.rmSync(process.env.PONTE_DATA_DIR, { recursive: true, force: true });

const nerix = require('./src/nerix');
const tools = require('./src/tools');

let falhas = 0;
const t = (nome, ok, extra = '') => {
  if (!ok) falhas++;
  console.log(`  ${ok ? 'ok  ' : 'FALHA'} | ${nome}${extra ? ` -> ${extra}` : ''}`);
};
const bloco = (nome) => console.log(`\n--- ${nome} ---`);

// Registra o que foi chamado, para provar que a consulta NÃO sai quando falta
// argumento — "devolveu erro" não basta, o que importa é não ter ido à rede.
const chamadas = [];
nerix.getOrder = async (codigo, opts) => {
  chamadas.push({ fn: 'getOrder', codigo, opts });
  if (codigo === 'INEXISTENTE') {
    const e = new Error('not found');
    e.response = { status: 404 };
    throw e;
  }
  if (opts?.email !== 'dono@exemplo.com') {
    const e = new Error('forbidden');
    e.response = { status: 403 };
    throw e;
  }
  return {
    data: {
      order_number: codigo,
      status: 'pending',
      total: 49.9,
      created_at: '2026-08-16T10:00:00Z',
      items: [{ product_name: 'Minecraft', quantity: 1 }],
      payment_url: 'https://pay.exemplo/x',
    },
  };
};
nerix.checkPayment = async (codigo) => {
  chamadas.push({ fn: 'checkPayment', codigo });
  return { data: { status: 'paid', items: [{ product_name: 'Minecraft', quantity: 1, product_key: 'AAAA-BBBB' }] } };
};

(async () => {
  // ── O e-mail é o que prova que o pedido é do cliente ────────
  bloco('sem e-mail não consulta');

  chamadas.length = 0;
  const semEmail = await tools.execute('consultar_pedido', { codigo: 'ABC123' });
  t('recusa sem e-mail', semEmail.erro === 'falta_email', JSON.stringify(semEmail));
  // O ponto principal: não foi à API. A chave é admin, e ir sem o e-mail
  // leria o pedido de outra pessoa.
  t('e NÃO chamou a Nerix', chamadas.length === 0, JSON.stringify(chamadas));

  chamadas.length = 0;
  const semCodigo = await tools.execute('consultar_pedido', { email: 'dono@exemplo.com' });
  t('recusa sem código', semCodigo.erro === 'falta_codigo', JSON.stringify(semCodigo));
  t('e também não chamou a Nerix', chamadas.length === 0, JSON.stringify(chamadas));

  // Espaço em branco não vale como argumento preenchido.
  const soEspaco = await tools.execute('consultar_pedido', { codigo: '  ', email: '  ' });
  t('espaço em branco não passa por código', soEspaco.erro === 'falta_codigo', JSON.stringify(soEspaco));

  // ── E-mail de outra pessoa ──────────────────────────────────
  bloco('e-mail que não é do pedido');
  const outroDono = await tools.execute('consultar_pedido', {
    codigo: 'ABC123',
    email: 'intruso@exemplo.com',
  });
  t('403 da Nerix vira email_nao_confere', outroDono.erro === 'email_nao_confere', JSON.stringify(outroDono));
  t('e nenhum dado do pedido vaza no erro',
    !JSON.stringify(outroDono).includes('Minecraft') && !JSON.stringify(outroDono).includes('49'),
    JSON.stringify(outroDono));

  const inexistente = await tools.execute('consultar_pedido', {
    codigo: 'INEXISTENTE',
    email: 'dono@exemplo.com',
  });
  t('404 vira pedido_nao_encontrado', inexistente.erro === 'pedido_nao_encontrado');

  // ── Problema NOSSO não vira culpa do cliente ────────────────
  // 401 e 403 estavam no mesmo if, e com a chave da loja inativa o cliente
  // ouvia "seu e-mail não confere" — ficaria tentando outros e-mails por um
  // defeito que não é dele. E o log apontaria para o lugar errado.
  bloco('401 é a nossa chave, não o e-mail do cliente');
  const getOrderBom = nerix.getOrder;
  nerix.getOrder = async () => {
    const e = new Error('unauthorized');
    e.response = { status: 401 };
    throw e;
  };
  const chaveRuim = await tools.execute('consultar_pedido', {
    codigo: 'ABC123',
    email: 'dono@exemplo.com',
  });
  nerix.getOrder = getOrderBom;

  t('401 NÃO culpa o e-mail do cliente', chaveRuim.erro !== 'email_nao_confere', JSON.stringify(chaveRuim));
  t('e sinaliza problema nosso', chaveRuim.erro === 'sistema_indisponivel', chaveRuim.erro);
  t('e manda a IA não culpar o cliente',
    /NÃO diga que o e-mail/i.test(chaveRuim.instrucao || ''), chaveRuim.instrucao);

  // ── Consulta boa ────────────────────────────────────────────
  bloco('consulta com código e e-mail certos');

  chamadas.length = 0;
  const ok = await tools.execute('consultar_pedido', {
    codigo: 'ABC123',
    email: 'dono@exemplo.com',
  });

  t('o e-mail é repassado à Nerix para validação',
    chamadas[0]?.opts?.email === 'dono@exemplo.com', JSON.stringify(chamadas[0]));

  // Pendente: confere o pagamento em tempo real. O Pix cai em segundos e o
  // estado salvo pode estar velho — é literalmente a pergunta do cliente.
  t('pedido pendente dispara o check-payment',
    chamadas.some((c) => c.fn === 'checkPayment'), JSON.stringify(chamadas.map((c) => c.fn)));
  t('e o status volta atualizado', ok.status === 'pago' && ok.pago === true, JSON.stringify(ok));
  t('status em português', ok.status === 'pago', ok.status);
  t('total formatado em real', ok.total === 'R$ 49.90', ok.total);
  t('a chave do produto chega junto',
    ok.itens?.[0]?.chave === 'AAAA-BBBB', JSON.stringify(ok.itens));
  // Mandar "pague aqui" para quem já pagou faz o cliente achar que a compra
  // não passou — e, na pior das hipóteses, pagar de novo.
  t('pedido pago não leva link de pagamento', ok.link_pagamento === undefined, ok.link_pagamento);

  // ── Nenhuma ferramenta de admin exposta ─────────────────────
  bloco('nada de admin exposto à IA');
  const nomes = tools.definitions.map((d) => d.function.name);
  // listOrders devolve a loja INTEIRA — o próprio nerix.js marca "não expor ao
  // cliente". Uma ferramenta com esse nome seria vazamento de dado de terceiro.
  t('não existe ferramenta de listar pedidos',
    !nomes.some((n) => /listar_pedidos|todos_pedidos|list_orders/i.test(n)), nomes.join(', '));

  // Toda ferramenta que fala de pedido tem de exigir o e-mail.
  for (const d of tools.definitions) {
    if (!/pedido|order/i.test(d.function.name)) continue;
    const req = d.function.parameters?.required || [];
    t(`${d.function.name} exige e-mail`, req.includes('email'), req.join(','));
  }

  console.log('\n' + (falhas ? falhas + ' FALHA(S)' : 'todos os testes passaram'));
  process.exit(falhas ? 1 : 0);
})();
