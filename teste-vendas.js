'use strict';

/**
 * Testes do CICLO DE VENDA e do MENU EM LISTA.
 *
 * O que este arquivo protege, em ordem de quanto custa errar:
 *
 *  1. CHAVE ENVIADA DUAS VEZES. Webhook repete — a Nerix reenvia o que não
 *     recebeu 200 a tempo, e um deploy no meio garante isso. Chave é dinheiro.
 *  2. CHAVE NO NÚMERO ERRADO. O telefone do checkout é digitado por gente e
 *     chega de toda forma. Adivinhar o que falta entrega a compra de um
 *     cliente para o telefone de outro.
 *  3. MENU QUE NÃO RESPONDE. Se o toque na lista não resolver, o cliente toca
 *     e recebe o menu de novo — a porta de entrada inteira parece quebrada.
 *
 * Não abre navegador nem fala com a Nerix: sender e API são dublês.
 *
 *   node teste-vendas.js
 */

const os = require('os');
const pathMod = require('path');
const fsMod = require('fs');

// Estado em pasta descartável, ANTES de qualquer require — igual ao
// teste-ponte: rodar isto no servidor não pode encostar no vendas.json real,
// que é quem sabe qual chave já foi entregue.
const DATA_TESTE = pathMod.join(os.tmpdir(), 'phaze-teste-vendas');
fsMod.rmSync(DATA_TESTE, { recursive: true, force: true });
process.env.PONTE_DATA_DIR = DATA_TESTE;

process.env.PONTE_ATIVA = 'true';
process.env.PONTE_OPERADOR_NUMERO = '5541999999999';
process.env.PONTE_SELLER_CHAT_TITLE = 'loja';

const sender = require('./src/sender');
const nerix = require('./src/nerix');

// Tudo que sai fica aqui em vez de ir para o WhatsApp.
let enviadas = [];
sender.send = async (para, texto, opts = {}) => {
  enviadas.push({ para, texto, opts });
  return true;
};

// A "loja": o pedido que getOrder devolve em cada cenário.
let pedidoFalso = null;
nerix.getOrder = async () => ({ data: pedidoFalso });
nerix.listOrders = async () => ({ data: listaFalsa });
let listaFalsa = [];

const vendas = require('./src/vendas');
const menu = require('./src/menu');

let falhas = 0;
const t = (nome, cond, extra = '') => {
  console.log((cond ? '  ok  ' : 'FALHA') + ' | ' + nome + (extra ? ' -> ' + extra : ''));
  if (!cond) falhas++;
};
const bloco = (nome) => console.log('\n--- ' + nome + ' ---');

const pedido = (over = {}) => ({
  order_number: 'ped-1',
  status: 'paid',
  total: 49.9,
  customer_name: 'Maria Souza',
  customer_email: 'maria@exemplo.com',
  customer_phone: '(41) 99999-8888',
  items: [{ product_name: 'Hollow Knight', quantity: 1, product_key: 'ABC-123-XYZ' }],
  ...over,
});

const OP = '5541999999999';
const CLI = '5541999998888';

(async () => {
  // ── Telefone ───────────────────────────────────────────────
  //
  // O campo é preenchido por gente no checkout e chega de tudo. O que não for
  // inequívoco tem que virar null: entregar no número errado não tem desfazer.
  bloco('telefone do checkout vira número de WhatsApp');

  t('com máscara', vendas.paraWhatsApp('(41) 99999-8888') === '5541999998888');
  t('só dígitos, 11', vendas.paraWhatsApp('41999998888') === '5541999998888');
  t('fixo, 10 dígitos', vendas.paraWhatsApp('4133334444') === '554133334444');
  t('já com 55', vendas.paraWhatsApp('5541999998888') === '5541999998888');
  t('com +55 e espaços', vendas.paraWhatsApp('+55 41 99999-8888') === '5541999998888');
  t('vazio não vira número', vendas.paraWhatsApp('') === null);
  t('curto demais não vira número', vendas.paraWhatsApp('99998888') === null);
  // Este é o que importa: um número internacional ou digitado errado não pode
  // ganhar um 55 na frente e virar o telefone de outra pessoa no Brasil.
  t('longo demais não vira número', vendas.paraWhatsApp('123456789012345') === null);
  t('estrangeiro não ganha 55', vendas.paraWhatsApp('351912345678') === null);

  // ── order.paid ─────────────────────────────────────────────
  bloco('venda paga avisa operador e cliente');

  enviadas = [];
  pedidoFalso = pedido();
  await vendas.onEvento({ event: 'order.paid', data: { order_number: 'ped-1' } });

  const aoOperador = enviadas.find((e) => e.para === OP);
  const aoCliente = enviadas.find((e) => e.para === CLI);

  t('o operador é avisado', Boolean(aoOperador));
  t('com o telefone do cliente', aoOperador?.texto.includes('99999-8888'), aoOperador?.texto.split('\n')[3]);
  t('e o valor', aoOperador?.texto.includes('49.90') || aoOperador?.texto.includes('49,90'));
  t('e diz que a chave saiu', /chave em estoque/i.test(aoOperador?.texto || ''));
  t('o cliente recebe confirmação', Boolean(aoCliente));
  t('pelo primeiro nome', aoCliente?.texto.startsWith('Maria'), aoCliente?.texto.split('\n')[0]);
  // Chave em estoque: a entrega chega em seguida pelo delivered, e um "estou
  // preparando" no meio deixaria o cliente esperando o que já vem.
  t('sem prometer preparo quando há chave', !/preparando/i.test(aoCliente?.texto || ''));

  bloco('o mesmo evento de novo não repete nada');
  enviadas = [];
  await vendas.onEvento({ event: 'order.paid', data: { order_number: 'ped-1' } });
  t('nada é reenviado', enviadas.length === 0, JSON.stringify(enviadas.map((e) => e.para)));

  // ── Sem chave = trabalho para alguém ───────────────────────
  bloco('pedido sem chave vira tarefa, não silêncio');

  enviadas = [];
  pedidoFalso = pedido({
    order_number: 'ped-2',
    items: [{ product_name: 'Conta Steam', quantity: 1, product_key: null }],
  });
  await vendas.onEvento({ event: 'order.paid', data: { order_number: 'ped-2' } });

  const semChave = enviadas.find((e) => e.para === OP);
  t('o operador é avisado', Boolean(semChave));
  t('e o aviso diz que é na mão', /sem chave/i.test(semChave?.texto || ''), semChave?.texto.split('\n').pop());
  const cli2 = enviadas.find((e) => e.para === CLI);
  t('o cliente é avisado que está sendo preparado', /preparando/i.test(cli2?.texto || ''));

  // ── order.delivered ────────────────────────────────────────
  bloco('entrega da chave');

  enviadas = [];
  pedidoFalso = pedido({ order_number: 'ped-3', status: 'delivered' });
  await vendas.onEvento({ event: 'order.delivered', data: { order_number: 'ped-3' } });

  const entrega = enviadas.find((e) => e.para === CLI && e.texto.includes('ABC-123-XYZ'));
  t('a chave chega no cliente', Boolean(entrega));
  t('com o nome do jogo', entrega?.texto.includes('Hollow Knight'));

  bloco('a chave NÃO sai duas vezes');
  enviadas = [];
  await vendas.onEvento({ event: 'order.delivered', data: { order_number: 'ped-3' } });
  t('segundo webhook não reenvia', !enviadas.some((e) => e.texto.includes('ABC-123-XYZ')),
    JSON.stringify(enviadas.map((e) => e.para)));

  bloco('telefone impossível não vira envio às cegas');
  enviadas = [];
  pedidoFalso = pedido({
    order_number: 'ped-4',
    status: 'delivered',
    customer_phone: '123',
    items: [{ product_name: 'Celeste', quantity: 1, product_key: 'ZZZ-999' }],
  });
  await vendas.onEvento({ event: 'order.delivered', data: { order_number: 'ped-4' } });

  t('nada foi mandado para um número inventado',
    !enviadas.some((e) => e.para !== OP), JSON.stringify(enviadas.map((e) => e.para)));
  // Procura pelo CONTEÚDO: no delivered o operador recebe duas mensagens (a
  // venda e a entrega manual), e pegar "a primeira do operador" testaria a
  // errada.
  const manual = enviadas.find((e) => e.para === OP && /entrega manual/i.test(e.texto));
  t('o operador recebe a entrega manual', Boolean(manual));
  t('com o e-mail para onde mandar', Boolean(manual?.texto.includes('maria@exemplo.com')));
  t('e a chave vai junto, para ele copiar', Boolean(manual?.texto.includes('ZZZ-999')));

  // ── Lembrete de Pix ────────────────────────────────────────
  bloco('lembrete de pagamento pendente');

  const agora = Date.now();
  const horas = (h) => new Date(agora - h * 3600_000).toISOString();
  listaFalsa = [
    // Novo demais: quem acabou de gerar o Pix ainda está pagando.
    { order_number: 'novo', status: 'pending', total: 10, created_at: horas(1), customer_phone: '41999990001', customer_name: 'Ana' },
    // No ponto.
    { order_number: 'certo', status: 'pending', total: 20, created_at: horas(5), customer_phone: '41999990002', customer_name: 'Bruno' },
    // Velho demais: o Pix já expirou e o link está morto.
    { order_number: 'velho', status: 'pending', total: 30, created_at: horas(72), customer_phone: '41999990003', customer_name: 'Carla' },
    // Sem telefone utilizável.
    { order_number: 'semtel', status: 'pending', total: 40, created_at: horas(5), customer_phone: '', customer_name: 'Davi' },
    // Já pago: o status da lista pode estar velho, mas este não está.
    { order_number: 'pago', status: 'paid', total: 50, created_at: horas(5), customer_phone: '41999990005', customer_name: 'Eva' },
  ];

  enviadas = [];
  await vendas.lembrarPixPendente();
  const alvos = enviadas.map((e) => e.para);

  // A varredura só roda em horário civil. Fora dele o certo é não mandar nada,
  // e o teste não pode falhar por causa da hora em que foi rodado.
  const horaBRT = Number(
    new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', hour12: false })
      .format(new Date()),
  );
  const civil = horaBRT >= 9 && horaBRT < 21;

  if (civil) {
    t('só o pedido na janela é cutucado', alvos.length === 1, JSON.stringify(alvos));
    t('e é o certo', alvos[0] === '5541999990002', alvos[0]);
    t('o recém-criado não é cutucado', !alvos.includes('5541999990001'));
    t('o expirado não é cutucado', !alvos.includes('5541999990003'));
    t('o já pago não é cutucado', !alvos.includes('5541999990005'));

    enviadas = [];
    await vendas.lembrarPixPendente();
    t('e ninguém é cutucado duas vezes', enviadas.length === 0, JSON.stringify(enviadas.map((e) => e.para)));
  } else {
    t('fora do horário civil não cutuca ninguém', enviadas.length === 0, `${horaBRT}h BRT`);
  }

  // ── Pedidos pelo telefone ──────────────────────────────────
  bloco('consulta de pedido pelo telefone');

  listaFalsa = [
    { order_number: 'meu-antigo', customer_phone: '41999998888', created_at: horas(48), status: 'paid' },
    { order_number: 'de-outro', customer_phone: '11955554444', created_at: horas(2), status: 'paid' },
    { order_number: 'meu-novo', customer_phone: '(41) 99999-8888', created_at: horas(1), status: 'paid' },
  ];

  const meus = await vendas.pedidosDoTelefone(CLI);
  t('acha os pedidos do número', meus.length === 2, `${meus.length}`);
  // O filtro é LOCAL de propósito: uma API que ignore o parâmetro `search`
  // devolveria a loja inteira, e sem esta comparação o cliente veria pedido de
  // outra pessoa.
  t('e NÃO traz o de outro cliente', !meus.some((p) => p.order_number === 'de-outro'),
    JSON.stringify(meus.map((p) => p.order_number)));
  t('o mais recente vem primeiro', meus[0].order_number === 'meu-novo', meus[0].order_number);
  t('telefone que não normaliza não busca nada', (await vendas.pedidosDoTelefone('123')).length === 0);

  // ── Menu em lista ──────────────────────────────────────────
  bloco('menu em lista');

  const l = menu.lista('main');
  t('tem uma linha por opção', l.rows.length === menu.NODES.main.options.length);
  t('todo título cabe no limite do WhatsApp', l.rows.every((r) => r.title.length <= 24));
  t('o rowId é o número da opção', l.rows.map((r) => r.rowId).join(',') === '1,2,3,4,5,6,7,8');
  t('o rodapé lembra que dá para digitar', /digitar o n[úu]mero/i.test(l.footer));

  t('número resolve', menu.resolve('main', '3')?.topic === 'plataforma_steam');
  t('rowId resolve igual', menu.resolve('main', l.rows[2].rowId)?.topic === 'plataforma_steam');
  t('título exibido resolve', menu.resolve('main', l.rows[2].title)?.topic === 'plataforma_steam', l.rows[2].title);
  t('rótulo inteiro resolve', menu.resolve('main', menu.NODES.main.options[4].label)?.action === 'codigo');

  // O casamento por título é por IGUALDADE. Prefixo parecia mais tolerante e
  // era armadilha: "suporte" mandaria o cliente para o ramo do Nintendo sem
  // ele ter escolhido nada.
  t('texto livre continua caindo no fallback', menu.resolve('main', 'suporte') === null);
  t('outra palavra solta também', menu.resolve('main', 'problema') === null);
  t('opção inexistente não resolve', menu.resolve('main', '99') === null);
  t('vazio não resolve', menu.resolve('main', '') === null);

  const ld = menu.lista('duvidas', 'Não achei essa opção');
  t('o prefixo entra na descrição da lista', ld.description.startsWith('Não achei essa opção'));
  t('e a descrição não leva asterisco cru', !ld.description.includes('*'), ld.description);

  console.log('\n' + (falhas ? falhas + ' FALHA(S)' : 'todos os testes passaram'));
  process.exit(falhas ? 1 : 0);
})();
