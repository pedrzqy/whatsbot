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

  // As redes de vocabulario, da FONTE UNICA (politica.js). Copiar a lista em
  // cada arquivo de teste e como "script" escapou uma vez: as copias divergem
  // e cada teste passa a provar coisa diferente.
  const AUTOMACAO = require('./src/ponte/politica').vocabularioProibido();
  const PROIBIDO = /fornecedor|taobao|chin[êe]s|vendedor|parceiro/i;
  const REPASSE = /encaminh\w*|repass\w*|terceir\w*|nosso\s+parceir\w*/i;

  // ── Depois da entrega ──────────────────────────────────────
  //
  // O bot entregava a chave e calava. Se ela não ativou, quem descobria era o
  // cliente, sozinho — e a primeira notícia disso chegava como reclamação,
  // quase sempre depois de ele já ter desistido.
  bloco('conferir a entrega');

  const posvenda = require('./src/posvenda');
  const vendasMod = require('./src/vendas');
  const cfgPV = require('./src/config');
  const storePV = require('./src/store');
  const senderPV = require('./src/sender');

  const HORA_PV = 3600_000;
  const CLI_PV = '5541977770001';

  // Hora fixa, e o pedido datado a partir DELA.
  //
  // Misturar um `agora` fixo com um `entregue` vindo de Date.now() faz a idade
  // do pedido sair negativa -- o mesmo defeito do relogio decidindo o
  // resultado, so que ao contrario: nunca passava, em vez de as vezes.
  const AGORA_PV = Date.UTC(2026, 7, 27, 17, 0); // 14h BRT, quinta

  /** Monta um pedido entregue ha N horas e roda a varredura. */
  async function varrer(horasAtras, extra = {}) {
    const d = vendasMod._dados();
    d.pedidos = {};
    d.pedidos.PED_PV = {
      visto: AGORA_PV,
      entregue: AGORA_PV - horasAtras * HORA_PV,
      telefone: CLI_PV,
      nome: 'Ana Silva',
      ...extra,
    };
    const enviadas = [];
    const antes = senderPV.send;
    senderPV.send = async (para, txt) => { enviadas.push({ para, texto: String(txt) }); };
    try {
      // Hora fixa dentro do expediente: sem isto o teste passa de manha e
      // falha de madrugada, que e o defeito do relogio decidindo o resultado.
      await posvenda.conferirEntregas(AGORA_PV);
    } finally {
      senderPV.send = antes;
    }
    return { enviadas, registro: vendasMod._dados().pedidos.PED_PV };
  }

  // Cedo demais: o cliente compra e abre o jogo quando dá. Perguntar em
  // seguida só interrompe.
  const cedo = await varrer(1);
  t('1h depois ainda não pergunta', cedo.enviadas.length === 0, String(cedo.enviadas.length));
  t('  e não marca como conferido', !cedo.registro.conferido);

  const naHora = await varrer(4);
  t('4h depois pergunta', naHora.enviadas.length === 1, String(naHora.enviadas.length));
  t('  para o cliente certo', naHora.enviadas[0]?.para === CLI_PV, naHora.enviadas[0]?.para);
  // Pergunta ABERTA: "tudo certo?" convida a um "sim" automático de quem nem
  // tentou, e o silêncio depois disso parece confirmação.
  t('  perguntando da ativação', /ativa[çc][ãa]o/i.test(naHora.enviadas[0]?.texto || ''),
    naHora.enviadas[0]?.texto);
  t('  e abrindo caminho para responder', /me conta|resolvo/i.test(naHora.enviadas[0]?.texto || ''));
  t('  sem entregar a origem nem admitir defeito',
    !PROIBIDO.test(naHora.enviadas[0]?.texto || '') &&
      !AUTOMACAO.test(naHora.enviadas[0]?.texto || '') &&
      !/erro|falha|problema/i.test(naHora.enviadas[0]?.texto || ''),
    naHora.enviadas[0]?.texto);

  // Marca ANTES de enviar: uma falha no meio faria a pergunta sair de novo na
  // varredura seguinte, e de novo, e de novo.
  t('  e marca para não repetir', Boolean(naHora.registro.conferido));

  const jaConferido = await varrer(4, { conferido: AGORA_PV });
  t('não pergunta duas vezes', jaConferido.enviadas.length === 0, String(jaConferido.enviadas.length));

  // Velho demais: a pergunta soa estranha, mas ele precisa sair da fila de
  // avaliação — senão é reavaliado em toda varredura para sempre.
  const velho = await varrer(24 * 5);
  t('pedido velho não recebe a pergunta', velho.enviadas.length === 0);
  t('  mas sai da fila de avaliação', Boolean(velho.registro.conferido));

  // Cliente com atendente humano NÃO recebe: ele está no meio de um problema,
  // e a pergunta do bot atropela quem está resolvendo.
  storePV.saveContact(CLI_PV, { paused: true });
  const comAtendente = await varrer(4);
  t('quem está com atendente não é interrompido', comAtendente.enviadas.length === 0);
  storePV.saveContact(CLI_PV, { paused: false });

  // Sem telefone utilizável não dá para perguntar — e também não pode ficar
  // rodando para sempre.
  const semTelefone = await varrer(4, { telefone: '' });
  t('sem telefone não tenta', semTelefone.enviadas.length === 0);
  t('  e sai da fila', Boolean(semTelefone.registro.conferido));

  // Desligado é desligado.
  const conferirAntes = cfgPV.posvenda.conferirLigado;
  cfgPV.posvenda.conferirLigado = false;
  const desligadoPV = await varrer(4);
  t('desligado não pergunta nada', desligadoPV.enviadas.length === 0);
  cfgPV.posvenda.conferirLigado = conferirAntes;

  // ── Reativar quem sumiu ────────────────────────────────────
  //
  // É a única coisa do bot que fala com quem NÃO puxou conversa. Mensagem em
  // massa partindo de um número comercial é o padrão que faz o WhatsApp
  // derrubar o número — e derrubar o número custa o atendimento inteiro.
  bloco('reativar quem sumiu');

  t('nasce DESLIGADO', cfgPV.posvenda.reativarLigado === false);

  const reativarAntes = { ...cfgPV.posvenda };
  cfgPV.posvenda.reativarLigado = true;
  cfgPV.posvenda.reativarDias = 45;
  cfgPV.posvenda.reativarPorDia = 2;
  cfgPV.posvenda.reativarIntervaloDias = 120;

  const DIA_PV = 24 * HORA_PV;
  const agoraPV = Date.UTC(2026, 7, 27, 17, 0);

  // Quatro perfis diferentes, um por regra.
  storePV.saveContact('5541977771111', { engaged: true, lastSeen: agoraPV - 60 * DIA_PV });
  storePV.saveContact('5541977772222', { engaged: true, lastSeen: agoraPV - 50 * DIA_PV });
  storePV.saveContact('5541977773333', { engaged: true, lastSeen: agoraPV - 90 * DIA_PV });
  // Nunca conversou com o bot: para ele isto seria mensagem fria.
  storePV.saveContact('5541977774444', { engaged: false, lastSeen: agoraPV - 90 * DIA_PV });
  // Está com atendente.
  storePV.saveContact('5541977775555', { engaged: true, paused: true, lastSeen: agoraPV - 90 * DIA_PV });
  // Sumiu há pouco.
  storePV.saveContact('5541977776666', { engaged: true, lastSeen: agoraPV - 10 * DIA_PV });
  // Já foi reativado faz pouco tempo.
  storePV.saveContact('5541977777777', {
    engaged: true, lastSeen: agoraPV - 90 * DIA_PV, reativadoEm: agoraPV - 30 * DIA_PV,
  });

  const reativadas = [];
  const sendAntesRe = senderPV.send;
  senderPV.send = async (para, txt) => { reativadas.push({ para, texto: String(txt) }); };
  await posvenda.reativar(agoraPV);
  senderPV.send = sendAntesRe;

  const alvosReativados = reativadas.map((r) => r.para);
  t('respeita o teto por dia', reativadas.length === 2, String(reativadas.length));
  // Os mais RECENTES primeiro: quem sumiu há 50 dias ainda lembra da loja;
  // quem sumiu há dois anos é quase mensagem fria de novo.
  t('  começando pelos que sumiram há menos tempo',
    alvosReativados.includes('5541977772222') && alvosReativados.includes('5541977771111'), alvosReativados.join(','));

  for (const [regra, numero] of [
    ['quem nunca conversou', '5541977774444'],
    ['quem está com atendente', '5541977775555'],
    ['quem sumiu há pouco', '5541977776666'],
    ['quem já foi reativado', '5541977777777'],
  ]) {
    t(`NÃO fala com ${regra}`, !alvosReativados.includes(numero), numero);
  }

  // Marca antes de enviar, mesmo motivo da conferência.
  t('marca quem foi reativado', Boolean(storePV.getContact('5541977772222')?.reativadoEm));

  const textoRe = reativadas[0]?.texto || '';
  // Uma porta aberta, não um anúncio: texto de propaganda é o que faz a pessoa
  // denunciar como spam, e denúncia é o caminho mais rápido para o número cair.
  t('o texto não é propaganda',
    !/promo[çc][ãa]o|desconto|imperd[íi]vel|oferta|[úu]ltima chance|R\$/i.test(textoRe), textoRe);
  t('  nem inventa urgência', !/corre|agora|hoje|acaba|s[óo] hoje/i.test(textoRe), textoRe);
  t('  e não entrega a origem',
    !PROIBIDO.test(textoRe) && !AUTOMACAO.test(textoRe) && !REPASSE.test(textoRe), textoRe);

  Object.assign(cfgPV.posvenda, reativarAntes);

  // ── O menu tem que aceitar o que a pessoa digita ───────────
  //
  // Sete das oito opções pararam de funcionar em produção e ninguém entendeu
  // por quê: o `resolve` exigia SÓ dígitos (`/^\d+$/`), e o cliente copiava o
  // número da lista com o ponto junto ("2."). Só o oitavo, digitado solto,
  // respondia.
  //
  // Da tela dele: o menu está ali, ele responde certo, e o bot devolve o mesmo
  // menu. Nada no log, nenhum erro, nada para investigar.
  bloco('o menu aceita o número do jeito que a pessoa manda');

  const menuMod = require('./src/menu');

  // TODA opção, em TODA forma. Uma por uma, porque foi exatamente uma opção
  // específica que continuou funcionando e escondeu o problema das outras.
  for (let i = 1; i <= menuMod.NODES.main.options.length; i++) {
    const formas = [`${i}`, `${i}.`, `${i})`, ` ${i} `, `${i} -`, `opcao ${i}`, `${i}\u{fe0f}\u{20e3}`];
    const todas = formas.every((f) => menuMod.resolve('main', f) === menuMod.NODES.main.options[i - 1]);
    t(`opção ${i} resolve em todas as formas`, todas,
      formas.filter((f) => !menuMod.resolve('main', f)).map((f) => JSON.stringify(f)).join(' ') || 'todas');
  }

  // E o que NÃO pode virar escolha de menu continua não virando.
  //
  // Nome de jogo pode ser só dígitos ("1080 Snowboarding", "Fifa 23"): casar
  // isso com uma opção mandaria o cliente para um ramo que ele não escolheu.
  for (const solto of ['23', '1080', '1080 Snowboarding', 'fifa 23', '0', '99', '2 3', 'suporte', '']) {
    t(`"${solto || '(vazio)'}" não vira opção`, menuMod.resolve('main', solto) === null,
      menuMod.resolve('main', solto)?.label);
  }

  // ── A lista nativa ──
  //
  // O título de cada linha tem limite de 24 no WhatsApp, e o corte cru
  // produzia "Tenho dúvidas sobre o" e "Pedir um": frases que terminam no meio
  // e parecem defeito.
  const linhas = menuMod.lista('main', '').rows;
  t('a lista tem uma linha por opção', linhas.length === menuMod.NODES.main.options.length,
    String(linhas.length));
  for (const r of linhas) {
    t(`linha ${r.rowId} cabe no limite do WhatsApp`, r.title.length <= 24,
      `${r.title.length}: ${r.title}`);
    // Terminar em preposição ou artigo é a assinatura do corte no meio.
    // A ÚLTIMA PALAVRA, separada por espaço, e não `\b`.
    //
    // Em JavaScript o `\b` só conhece [A-Za-z0-9_], então "ç" conta como
    // separador: "segurança" parecia terminar na palavra "a" e o teste acusava
    // um corte que não existia. Acento e cedilha são o normal aqui.
    const ultima = r.title.split(/\s+/).pop().toLowerCase();
    t(`  e não termina cortada`,
      !['o', 'a', 'os', 'as', 'de', 'da', 'do', 'com', 'que', 'um', 'uma', 'em', 'no', 'na', 'pra', 'para']
        .includes(ultima),
      `termina em "${ultima}"`);
    // Tocar na linha tem que resolver: algumas versões devolvem o TÍTULO em vez
    // do id, e sem isto o cliente toca no menu e recebe o menu de volta.
    t(`  e o título dela resolve`, Boolean(menuMod.resolve('main', r.title)), r.title);
    t(`  o id dela também`, Boolean(menuMod.resolve('main', r.rowId)), r.rowId);
  }

  // ── O caminho inteiro: cada opção faz alguma coisa ─────────
  //
  // Resolver não basta. Uma opção pode resolver e a ação não existir, e o
  // cliente cairia no "não entendi" do mesmo jeito.
  bloco('cada opção do menu faz alguma coisa');

  const handlersM = require('./src/handlers');
  const storeM = require('./src/store');
  const senderM = require('./src/sender');
  const cfgM = require('./src/config');
  const sendMAntes = senderM.send;

  const autoAntesM = cfgM.autoReply;
  cfgM.autoReply = true;
  require('./src/chaves').definir('atendimento', true);

  for (let i = 1; i <= 8; i++) {
    const CLI = `55419000${i}555`;
    storeM.saveContact(CLI, {
      greetedAt: Date.now(), lastSeen: Date.now(), paused: false,
      menuNode: 'main', modoIA: false, aguardandoJogo: false, aguardandoProblema: false,
    });

    const recebidas = [];
    senderM.send = async (para, txt) => { recebidas.push({ para, texto: String(txt) }); };
    try {
      // Com o PONTO, que é a forma que quebrava.
      await handlersM.onIncomingMessage({ from: CLI, text: `${i}.`, pushName: 'Marco' });
    } finally {
      senderM.send = sendMAntes;
    }

    const aoCliente = recebidas.filter((r) => r.para === CLI).map((r) => r.texto).join('\n');
    t(`opção ${i} responde alguma coisa`, aoCliente.trim().length > 0, '(silêncio)');
    // O sintoma exato do defeito: escolher uma opção e receber o menu de volta.
    t(`  e não devolve "não entendi"`,
      !/n[ãa]o entendi|deixa eu te ajudar melhor|te atender mais r[áa]pido/i.test(aoCliente),
      aoCliente.split('\n')[0]);
  }

  cfgM.autoReply = autoAntesM;


  console.log('\n' + (falhas ? falhas + ' FALHA(S)' : 'todos os testes passaram'));
  process.exit(falhas ? 1 : 0);
})();
