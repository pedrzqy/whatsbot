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

// A suite inteira roda SEM REDE, e isto e o que garante.
//
// Sem apagar a chave aqui, uma maquina com ANTHROPIC_API_KEY definida faria os
// testes chamarem a API DE VERDADE -- cobrada, lenta e dependente de internet.
// E o esforco e fixado porque CLAUDE_EFFORT ja existe no ambiente de algumas
// maquinas: o teste passava ou falhava conforme QUEM estava rodando, que e o
// mesmo defeito do relogio que decidia o resultado do teste-ponte.
// Vazio, e nao `delete`. O config.js chama dotenv, que RE-LE o .env e repoe
// qualquer chave que nao esteja em process.env -- entao apagar aqui e ser
// sobrescrito um require depois. Definida como string vazia, a chave existe
// (dotenv nao mexe) e e falsy (nenhum provedor nasce).
process.env.ANTHROPIC_API_KEY = '';
process.env.BOT_CLAUDE_ESFORCO = 'low';

process.env.NERIX_API_KEY = 'teste';
process.env.PONTE_OPERADOR_NUMERO = '5541999999999';
process.env.PONTE_BRACO_KEY = 'teste';
process.env.PONTE_DATA_DIR = require('path').join(require('os').tmpdir(), 'phaze-teste-tools');

// Duble do fetch, instalado ANTES de requerer o ai.js.
//
// A cascata de seis provedores foi removida -- ela custava ate 40s por provedor
// fora do ar, e o log de producao mostrava dois ja mortos (503 e 402). Sobrou
// uma camada so (Claude) e o menu embaixo, entao o que se testa aqui e o PRAZO:
// que ele desiste na hora certa em vez de deixar o cliente esperando.
const fs = require('fs');
fs.rmSync(process.env.PONTE_DATA_DIR, { recursive: true, force: true });

process.env.ANTHROPIC_API_KEY = 'chave-de-mentira';
const chamadasAoModelo = [];
const fetchReal = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  chamadasAoModelo.push({ url: String(url), init });
  return new Response(JSON.stringify({ type: 'error', error: { message: 'fora do ar' } }), {
    status: 503,
    headers: { 'content-type': 'application/json' },
  });
};
require('./src/ai');

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
  t('nem o Pix copia-e-cola', ok.pix_copia_e_cola === undefined, ok.pix_copia_e_cola);

  // ── Pendente leva o Pix para o cliente pagar ────────────────
  // Nomes conferidos num pedido real: payment.pix_qr_code é o copia-e-cola,
  // e o _base64 ao lado é a imagem do QR (8 mil chars) — esse não pode entrar
  // no retorno, estouraria o contexto do modelo.
  bloco('pendente leva o Pix, sem a imagem');
  const getOrderOriginal = nerix.getOrder;
  const checkOriginal = nerix.checkPayment;
  nerix.getOrder = async () => ({
    data: {
      order_number: 'PEND1',
      status: 'pending',
      total: 10,
      payment: { pix_qr_code: '00020126...COPIA', pix_qr_code_base64: 'x'.repeat(8000) },
    },
  });
  nerix.checkPayment = async () => ({ data: { status: 'pending' } });

  const pendente = await tools.execute('consultar_pedido', {
    codigo: 'PEND1',
    email: 'dono@exemplo.com',
  });
  nerix.getOrder = getOrderOriginal;
  nerix.checkPayment = checkOriginal;

  t('pendente traz o copia-e-cola', pendente.pix_copia_e_cola === '00020126...COPIA', pendente.pix_copia_e_cola);
  t('e NÃO traz a imagem base64',
    !JSON.stringify(pendente).includes('xxxxxxxxxx'), `${JSON.stringify(pendente).length} chars`);

  // ── Nenhuma ferramenta de admin exposta ─────────────────────
  bloco('nada de admin exposto à IA');
  const nomes = tools.definitions.map((d) => d.function.name);
  // listOrders devolve a loja INTEIRA — o próprio nerix.js marca "não expor ao
  // cliente". Uma ferramenta com esse nome seria vazamento de dado de terceiro.
  t('não existe ferramenta de listar pedidos',
    !nomes.some((n) => /listar_pedidos|todos_pedidos|list_orders/i.test(n)), nomes.join(', '));

  // Toda ferramenta que fala de pedido precisa de UMA PROVA de que o pedido é
  // de quem está perguntando. Só existem duas provas aceitas, e a regra aqui é
  // que não pode existir uma terceira:
  //
  //   1. o e-mail obrigatório, que a Nerix confere contra o pedido; ou
  //   2. o telefone do remetente do WhatsApp — e aí a ferramenta não pode ter
  //      parâmetro NENHUM, porque qualquer campo de identidade no schema seria
  //      preenchível pelo modelo, e um argumento alucinado leria o pedido de
  //      outra pessoa.
  //
  // Antes esta checagem era só "exige e-mail". Ela estava certa quando havia um
  // caminho só; o que ela protege é a prova, não o campo.
  //
  // `criar_pedido` fica FORA desta lista, e o motivo importa: ela nao LE pedido
  // de ninguem, ela cria um novo. O e-mail ali e o destino da chave, nao prova
  // de posse de nada -- deixar ela passar por "tem email no required" seria a
  // checagem passando pelo motivo errado. O que a protege e outra coisa: o
  // telefone vem do ctx, e o bloco abaixo cobre isso.
  const LEEM_PEDIDO = ['consultar_pedido', 'meus_pedidos'];
  for (const d of tools.definitions) {
    if (!LEEM_PEDIDO.includes(d.function.name)) continue;
    const req = d.function.parameters?.required || [];
    const props = Object.keys(d.function.parameters?.properties || {});
    const porEmail = req.includes('email');
    const porRemetente = props.length === 0;
    t(`${d.function.name} tem prova de posse`, porEmail || porRemetente,
      porEmail ? 'e-mail' : `campos: ${props.join(',') || 'nenhum'}`);
  }

  // Ferramenta nova que fale de pedido tem que entrar conscientemente num dos
  // dois grupos. Sem isto, a proxima nasce sem checagem nenhuma e ninguem ve.
  const CRIAM_PEDIDO = ['criar_pedido'];
  const orfas = tools.definitions
    .map((d) => d.function.name)
    .filter((n) => /pedido|order/i.test(n))
    .filter((n) => !LEEM_PEDIDO.includes(n) && !CRIAM_PEDIDO.includes(n));
  t('nenhuma ferramenta de pedido sem grupo', orfas.length === 0, orfas.join(',') || 'nenhuma');

  // ── Menu: resposta pronta, IA só num ramo ───────────────────
  bloco('menu responde sem IA');
  const menu = require('./src/menu');

  // Toda opção tem que levar a ALGUMA coisa. Uma opção com topic sem fato no
  // knowledge cai na IA em silêncio — o cliente escolhe o número, espera, e
  // recebe texto gerado onde devia haver fato da loja.
  for (const [nodeId, node] of Object.entries(menu.NODES)) {
    for (const [i, o] of node.options.entries()) {
      const destino = o.goto || o.topic || o.action;
      t(`${nodeId}[${i + 1}] tem destino`, Boolean(destino), o.label);
      if (o.topic) {
        t(`${nodeId}[${i + 1}] tem fato pronto`, Boolean(menu.resposta(o.topic)), o.topic);
      }
      if (o.goto) {
        t(`${nodeId}[${i + 1}] aponta para nó existente`, Boolean(menu.NODES[o.goto]), o.goto);
      }
    }
  }

  // A IA custa segundos e token por mensagem. Se mais de um ramo a acordasse,
  // o menu deixaria de ser a economia que ele existe para ser.
  const comIA = Object.values(menu.NODES)
    .flatMap((n) => n.options)
    .filter((o) => o.action === 'ia');
  t('só UM ramo do menu acorda a IA', comIA.length === 1, comIA.map((o) => o.label).join(', '));

  // Número inválido não pode virar escolha silenciosa.
  t('opção 99 não resolve', menu.resolve('main', '99') === null);
  t('opção 0 não resolve', menu.resolve('main', '0') === null);
  t('texto não resolve', menu.resolve('main', 'oi') === null);
  t('opção 1 resolve', Boolean(menu.resolve('main', '1')));

  // ── Consulta de pedido sem IA ───────────────────────────────
  bloco('extrai pedido da frase, sem IA');
  const handlers = require('./src/handlers');
  const { extrairPedido, respostaDePedido } = handlers;

  const frase = extrairPedido(
    'comprei e nao recebi, meu pedido e 01a00ba2-da37-7c72-a16e-ef6db7862985 e meu email e laureano@gmail.com',
  );
  t('acha UUID e e-mail na frase solta',
    frase?.codigo === '01a00ba2-da37-7c72-a16e-ef6db7862985' && frase?.email === 'laureano@gmail.com',
    JSON.stringify(frase));

  t('aceita código curto também',
    extrairPedido('pedido ABC123XYZ email joao@teste.com')?.codigo === 'ABC123XYZ');

  // Sem os DOIS não consulta: o e-mail é o que prova que o pedido é do
  // cliente, e a chave da Nerix é admin.
  t('só e-mail não basta', extrairPedido('meu email é joao@teste.com') === null);
  t('só código não basta',
    extrairPedido('pedido 01a00ba2-da37-7c72-a16e-ef6db7862985') === null);
  t('frase sem nada disso', extrairPedido('oi tudo bem') === null);

  // O trecho antes do @ não pode virar "código".
  const soEmail = extrairPedido('joaosilva123@teste.com');
  t('não confunde o começo do e-mail com código', soEmail === null, JSON.stringify(soEmail));

  bloco('resposta do pedido é texto pronto');
  const pago = respostaDePedido(
    { codigo: 'X1', status: 'entregue', total: 'R$ 94.90', pago: true, itens: [{ nome: 'Mario', quantidade: 1 }] },
    { codigo: 'X1' },
  );
  t('mostra status e item', /entregue/.test(pago) && /Mario/.test(pago));
  t('e não oferece pagamento a quem pagou', !/Pix copia|Pagar:/.test(pago));

  const naoPago = respostaDePedido(
    { codigo: 'X2', status: 'aguardando pagamento', pago: false, pix_copia_e_cola: '00020126ABC' },
    { codigo: 'X2' },
  );
  t('pendente recebe o Pix', /00020126ABC/.test(naoPago));

  // Problema NOSSO não vira culpa do cliente — o 401 já fez isso uma vez.
  const nosso = respostaDePedido({ erro: 'sistema_indisponivel' }, { codigo: 'X3' });
  t('erro do sistema não culpa o cliente',
    !/e-mail|email|código está/i.test(nosso) && /atendente/i.test(nosso), nosso);

  const emailErrado = respostaDePedido({ erro: 'email_nao_confere' }, { codigo: 'X4' });
  t('e-mail errado explica o que fazer', /e-mail/i.test(emailErrado));

  // ── O laço do menu ──────────────────────────────────────────
  // Bug real (17/08): o cliente escolhia 6 ou 7, ficava com modoIA:true, e o
  // fallback repunha só o menuNode. Como a condição do menu exige !modoIA,
  // TODA escolha seguinte voltava para o fallback — o mesmo menu de 8 opções,
  // sem fim. E como a escolha nunca era executada, "falar com um atendente"
  // também não rodava: quem pedia humano continuava preso no laço.
  bloco('não prende o cliente no laço do menu');

  const senderMod = require('./src/sender');
  const storeMod = require('./src/store');
  const enviadas = [];
  const sendOriginal = senderMod.send;
  senderMod.send = async (para, texto) => { enviadas.push(String(texto)); };

  const CLI_LOOP = '5511977776666@s.whatsapp.net';
  // greetedAt E lastSeen: o shouldWelcome sauda de novo quando o cliente some
  // por mais que a janela de sessão, e sem o lastSeen recente ele trataria
  // este contato como quem voltou depois de dias.
  storeMod.saveContact(CLI_LOOP, {
    greetedAt: Date.now(),
    lastSeen: Date.now(),
    menuNode: 'main',
    modoIA: false,
    paused: false,
  });

  const manda = async (texto) => {
    enviadas.length = 0;
    await handlers.onIncomingMessage({ from: CLI_LOOP, text: texto, pushName: 'Teste' });
    return enviadas.join('\n');
  };

  // 6 = "Meu pedido / financeiro" — era ele que ligava o modoIA.
  const apos6 = await manda('6');
  t('opção 6 pede código e e-mail', /código do pedido/i.test(apos6), apos6.slice(0, 50));

  // A escolha SEGUINTE tem que funcionar. Com o bug, voltava o menu.
  const apos4 = await manda('4');
  t('e a opção 4 ainda funciona depois dela',
    /nome do jogo/i.test(apos4), apos4.slice(0, 60));
  t('não devolveu o menu de novo', !/Tenho dúvidas sobre os jogos/.test(apos4));

  // O caminho do atendente: escolher 8 tem que PAUSAR de verdade.
  storeMod.saveContact(CLI_LOOP, { menuNode: 'main', modoIA: false, aguardandoJogo: false });
  const apos8 = await manda('8');
  t('opção 8 chama o atendente', /atendente/i.test(apos8), apos8.slice(0, 40));
  t('e pausa o contato', storeMod.getContact(CLI_LOOP)?.paused === true);

  // Pausado = silêncio. Sem isso o cliente que pediu humano segue conversando
  // com o menu enquanto espera.
  const aposPausa = await manda('4');
  t('pausado, o bot fica calado', aposPausa === '', JSON.stringify(aposPausa.slice(0, 40)));

  // E o #inicio tira da pausa.
  const aposInicio = await manda('#inicio');
  t('#inicio despausa e traz o menu', /Tenho dúvidas sobre os jogos/.test(aposInicio));
  t('e o contato sai da pausa', storeMod.getContact(CLI_LOOP)?.paused === false);

  senderMod.send = sendOriginal;

  // ── Operador assume a conversa ──────────────────────────────
  bloco('operador digitando pausa o bot');

  const CLI_HO = '5511988887777';
  const enviadasHO = [];
  const sendAntes = senderMod.send;
  senderMod.send = async (para, texto) => {
    senderMod.registrarEnvioDoBot(texto);
    enviadasHO.push(String(texto));
  };

  storeMod.saveContact(CLI_HO, { greetedAt: Date.now(), lastSeen: Date.now(), paused: false });
  await handlers.onOperadorDigitou({ para: `${CLI_HO}@s.whatsapp.net`, texto: 'oi, aqui é o Pedro' });

  t('pausa o contato', storeMod.getContact(CLI_HO)?.paused === true);
  t('e avisa o cliente uma vez', /suporte/i.test(enviadasHO.join('')), enviadasHO[0]?.slice(0, 40));
  t('dizendo como voltar', /#inicio/.test(enviadasHO.join('')));

  // O operador manda três, quatro mensagens seguidas. Avisar em cada uma seria
  // pior que o problema.
  enviadasHO.length = 0;
  await handlers.onOperadorDigitou({ para: `${CLI_HO}@s.whatsapp.net`, texto: 'segunda mensagem' });
  t('não repete o aviso nas seguintes', enviadasHO.length === 0, enviadasHO.join(''));

  // O operador falando consigo mesmo (os #comandos) não é atendimento.
  enviadasHO.length = 0;
  await handlers.onOperadorDigitou({ para: '5541999999999@s.whatsapp.net', texto: '#fila' });
  t('ignora o próprio número do operador', enviadasHO.length === 0);

  // O ECO: o que o bot manda volta no webhook como fromMe. Se isso contasse
  // como "operador digitou", toda resposta do bot pausaria o próprio bot.
  senderMod.registrarEnvioDoBot('Foto recebida ✅');
  t('reconhece o eco do próprio bot', senderMod.foiDoBot('Foto recebida ✅') === true);
  t('e não confunde com texto de gente', senderMod.foiDoBot('oi, tudo bem?') === false);

  // ── A pausa não pode vazar ──────────────────────────────────
  // Dois furos reais: o bot "voltava sozinho depois de um tempo" (as
  // boas-vindas zeravam o paused quando o cliente sumia e voltava) e
  // "preciso do código" atravessava o atendimento humano (a recepção da ponte
  // roda antes do check de pausa, para furar o autoreply desligado — e furava
  // a pausa junto).
  bloco('pausa não vaza');

  const CLI_P = '5511900002222';
  const recebidas = [];
  senderMod.send = async (para, texto) => {
    senderMod.registrarEnvioDoBot(texto);
    recebidas.push({ para, texto: String(texto) });
  };
  const doCliente = () => recebidas.filter((r) => r.para === CLI_P);

  // Pausado e sumido há 3 dias: passa da janela de sessão do welcome.
  storeMod.saveContact(CLI_P, {
    greetedAt: Date.now() - 3 * 864e5,
    lastSeen: Date.now() - 3 * 864e5,
    paused: true,
  });

  recebidas.length = 0;
  await handlers.onIncomingMessage({ from: CLI_P, text: 'oi', pushName: 'C' });
  t('cliente que volta depois de dias segue em silêncio', doCliente().length === 0,
    doCliente().map((r) => r.texto.slice(0, 30)).join(' | '));
  t('e continua pausado', storeMod.getContact(CLI_P)?.paused === true);

  recebidas.length = 0;
  await handlers.onIncomingMessage({ from: CLI_P, text: 'preciso do codigo', pushName: 'C' });
  t('"preciso do código" não atravessa o atendimento', doCliente().length === 0,
    doCliente().map((r) => r.texto.slice(0, 30)).join(' | '));
  t('mas o operador é avisado', recebidas.some((r) => r.para !== CLI_P));

  // #inicio é a ÚNICA saída, e está escrita no aviso que o cliente recebe.
  // Sem esta exceção o bloco acima o prenderia em silêncio para sempre.
  recebidas.length = 0;
  await handlers.onIncomingMessage({ from: CLI_P, text: '#inicio', pushName: 'C' });
  t('#inicio ainda tira da pausa', storeMod.getContact(CLI_P)?.paused === false);
  t('e responde ao cliente', doCliente().length > 0);

  senderMod.send = sendAntes;

  // ── Pedir jogo ──────────────────────────────────────────────
  bloco('pedir jogo');
  const nerixMod = require('./src/nerix');
  const listOriginal = nerixMod.listProducts;

  // Jogo que a loja TEM: o cliente recebe o link e compra na hora. Encaminhar
  // ao operador um título que já está à venda perde uma venda pronta e faz o
  // cliente esperar resposta manual por algo que estava a um clique.
  nerixMod.listProducts = async () => ({
    data: [{ name: 'Hollow Knight', slug: 'hollow-knight', price: 49.9 }],
  });
  const naLoja = await tools.execute('buscar_produtos', { termo: 'hollow knight' });
  t('acha o jogo que a loja tem', naLoja.produtos?.length === 1, JSON.stringify(naLoja.produtos));
  t('e traz o link para comprar', Boolean(naLoja.produtos?.[0]?.link));

  nerixMod.listProducts = async () => ({ data: [] });
  const foraDaLoja = await tools.execute('buscar_produtos', { termo: 'jogo que nao existe xyz' });
  t('não acha o que a loja não tem', foraDaLoja.produtos?.length === 0);
  nerixMod.listProducts = listOriginal;

  // O nome do jogo pode ser SÓ dígitos — "1080 Snowboarding", "Fifa 23".
  // Se o passo do pedido não vier ANTES do menu numerado, a resposta vira
  // escolha de opção e o cliente nunca consegue pedir esses títulos.
  t('“3” seria opção de menu válida', Boolean(menu.resolve('main', '3')));
  t('e “23” não resolve como opção', menu.resolve('main', '23') === null);

  // ── Fechar a compra na conversa ─────────────────────────────
  //
  // Até aqui toda conversa terminava em "compra no site": o cliente saía do
  // WhatsApp e quem não voltava era venda perdida. Este é o ÚNICO caminho do
  // bot que movimenta dinheiro, e por isso cada trava aqui falha para o lado de
  // NÃO criar o pedido.
  bloco('criar_pedido — as travas');

  const nerixV = require('./src/nerix');
  const listProdutosAntes = nerixV.listProducts;
  const createOrderAntes = nerixV.createOrder;
  const listOrdersAntes = nerixV.listOrders;

  const CATALOGO = {
    'hollow knight': [{ id: 'p1', name: 'Hollow Knight', slug: 'hollow-knight', price: 49.9 }],
    zelda: [{
      id: 'p2', name: 'Zelda', slug: 'zelda',
      variants: [
        { id: 'v1', name: 'Switch 1', price: 199.9 },
        { id: 'v2', name: 'Switch 2', price: 299.9 },
      ],
    }],
    ambiguo: [
      { id: 'p3', name: 'Ambiguo', slug: 'a1', price: 10 },
      { id: 'p4', name: 'Ambiguo', slug: 'a2', price: 20 },
    ],
  };
  nerixV.listProducts = async ({ search }) => ({ data: CATALOGO[String(search).toLowerCase()] || [] });
  nerixV.listOrders = async () => ({ data: [] });

  const criados = [];
  nerixV.createOrder = async (payload) => {
    criados.push(payload);
    return {
      data: {
        order_number: 'NOVO-1',
        status: 'pending',
        total: 49.9,
        created_at: '2026-08-27T17:00:00Z',
        items: [{ product_name: 'Hollow Knight', quantity: 1 }],
        payment: { pix_qr_code: '00020126...PIX' },
      },
    };
  };

  const COMPRADOR = '5541955550001';
  const bom = {
    produto: 'Hollow Knight',
    preco_informado: 'R$ 49.90',
    nome_completo: 'Ana Silva',
    email: 'ana@exemplo.com',
  };

  // O caminho feliz primeiro, para as travas terem um contraste.
  criados.length = 0;
  const vendeu = await tools.execute('criar_pedido', bom, { from: COMPRADOR });
  t('fecha a compra', vendeu.codigo === 'NOVO-1', JSON.stringify(vendeu.erro || vendeu.codigo));
  t('  e devolve o Pix', vendeu.pix_copia_e_cola === '00020126...PIX', vendeu.pix_copia_e_cola);
  // O Pix tem que ir sozinho numa mensagem: é assim que o cliente copia de uma
  // vez no celular.
  t('  mandando o Pix ir sozinho', /SEPARADA|sozinho/i.test(vendeu.instrucao || ''), vendeu.instrucao);

  // O TELEFONE vem do ctx, nunca de argumento — é ele que vai receber a chave.
  t('o telefone vai do contexto', criados[0]?.customer?.phone === COMPRADOR,
    criados[0]?.customer?.phone);
  const telefoneForjado = await tools.execute(
    'criar_pedido',
    { ...bom, telefone: '5541999999999', phone: '5541999999999' },
    { from: COMPRADOR },
  );
  t('  e argumento de telefone é ignorado',
    criados[1]?.customer?.phone === COMPRADOR, criados[1]?.customer?.phone);
  t('sem telefone no contexto não cria nada',
    (await tools.execute('criar_pedido', bom, {})).erro === 'sem_telefone');

  // ── O preço prometido tem que bater ──
  //
  // É a trava que impede o cliente de pagar diferente do combinado: ele já leu
  // o valor na tela dele.
  criados.length = 0;
  const precoErrado = await tools.execute(
    'criar_pedido', { ...bom, preco_informado: 'R$ 29.90' }, { from: COMPRADOR },
  );
  t('preço divergente NÃO cria pedido', criados.length === 0, `${criados.length} pedido(s)`);
  t('  e diz qual é o certo', precoErrado.preco_correto === 'R$ 49.90', precoErrado.preco_correto);
  t('  mandando confirmar com o cliente', /confirme/i.test(precoErrado.instrucao || ''),
    precoErrado.instrucao);
  // Centavos, não float: 49.90 escrito de outro jeito continua sendo o mesmo.
  const mesmoPreco = await tools.execute(
    'criar_pedido', { ...bom, preco_informado: 'R$ 49,90' }, { from: COMPRADOR },
  );
  t('vírgula ou ponto dá no mesmo', !mesmoPreco.erro, mesmoPreco.erro);

  // ── Produto: resolvido no catálogo REAL, pelo nome ──
  //
  // O modelo não passa id de propósito: um id alucinado que por acaso existe
  // criaria um pedido do produto errado com o preço errado.
  criados.length = 0;
  const foraDoCatalogo = await tools.execute(
    'criar_pedido', { ...bom, produto: 'Jogo Que Nao Existe' }, { from: COMPRADOR },
  );
  t('produto fora do catálogo não vira pedido', criados.length === 0);
  t('  e manda buscar de novo', /buscar_produtos/.test(foraDoCatalogo.instrucao || ''),
    foraDoCatalogo.erro);

  const ambiguo = await tools.execute(
    'criar_pedido', { ...bom, produto: 'Ambiguo', preco_informado: 'R$ 10.00' },
    { from: COMPRADOR },
  );
  t('nome ambíguo não vira pedido', ambiguo.erro === 'produto_nao_encontrado', ambiguo.erro);

  // ── Opção obrigatória quando o produto tem variantes ──
  //
  // Chutar aqui vende Switch 1 para quem quer Switch 2.
  criados.length = 0;
  const semOpcao = await tools.execute(
    'criar_pedido', { ...bom, produto: 'Zelda', preco_informado: 'R$ 199.90' },
    { from: COMPRADOR },
  );
  t('produto com opções exige a escolha', semOpcao.erro === 'falta_opcao', semOpcao.erro);
  t('  sem criar nada', criados.length === 0);
  t('  e devolve as opções para o cliente escolher',
    semOpcao.opcoes?.length === 2, JSON.stringify(semOpcao.opcoes));

  const comOpcao = await tools.execute(
    'criar_pedido',
    { ...bom, produto: 'Zelda', opcao: 'Switch 2', preco_informado: 'R$ 299.90' },
    { from: COMPRADOR },
  );
  t('com a opção certa, fecha', !comOpcao.erro, comOpcao.erro);
  t('  mandando a variante escolhida', criados.at(-1)?.items?.[0]?.variant_id === 'v2',
    criados.at(-1)?.items?.[0]?.variant_id);
  // O preço conferido é o DA VARIANTE, não o do produto.
  const opcaoPrecoErrado = await tools.execute(
    'criar_pedido',
    { ...bom, produto: 'Zelda', opcao: 'Switch 2', preco_informado: 'R$ 199.90' },
    { from: COMPRADOR },
  );
  t('o preço conferido é o da opção', opcaoPrecoErrado.erro === 'preco_divergente',
    opcaoPrecoErrado.preco_correto);

  // ── Dados do cliente ──
  criados.length = 0;
  t('sem sobrenome não fecha',
    (await tools.execute('criar_pedido', { ...bom, nome_completo: 'Ana' }, { from: COMPRADOR }))
      .erro === 'falta_sobrenome');
  // O e-mail é para onde a chave vai: um errado entrega a compra no vazio, e o
  // cliente descobre depois de pagar.
  for (const ruim of ['ana', 'ana@', 'ana@exemplo', '@exemplo.com', '']) {
    t(`e-mail "${ruim}" não passa`,
      (await tools.execute('criar_pedido', { ...bom, email: ruim }, { from: COMPRADOR }))
        .erro === 'email_invalido');
  }
  t('  e nada foi criado no caminho', criados.length === 0, `${criados.length} pedido(s)`);

  // ── Duplo toque não vira dois Pix ──
  //
  // Cliente confuso manda "quero sim" duas vezes, e o modelo pode repetir a
  // chamada depois de um erro de rede. Sem isto ele recebe dois Pix, paga um, e
  // o outro fica pendurado cobrando lembrete.
  nerixV.listOrders = async () => ({
    data: [{
      order_number: 'JA-EXISTE',
      status: 'pending',
      total: 49.9,
      customer_phone: COMPRADOR,
      created_at: new Date().toISOString(),
      items: [{ product_name: 'Hollow Knight', quantity: 1 }],
      payment: { pix_qr_code: '00020126...ANTIGO' },
    }],
  });
  criados.length = 0;
  const pedidoRepetido = await tools.execute('criar_pedido', bom, { from: COMPRADOR });
  t('pedido repetido NÃO cria outro', criados.length === 0, `${criados.length} pedido(s)`);
  t('  e devolve o que já existia', pedidoRepetido.codigo === 'JA-EXISTE' && pedidoRepetido.ja_existia === true,
    pedidoRepetido.codigo);
  t('  com o Pix do original', pedidoRepetido.pix_copia_e_cola === '00020126...ANTIGO',
    pedidoRepetido.pix_copia_e_cola);
  nerixV.listOrders = async () => ({ data: [] });

  // ── A API recusando o formato: cai no site, não em erro ──
  //
  // Um 400 aqui quase sempre é o FORMATO do que mandamos, não o cliente. O
  // desfecho seguro é o comportamento de sempre: mandar o link.
  nerixV.createOrder = async () => {
    const e = new Error('bad request');
    e.response = { status: 400, data: { message: 'items.0.product_id is required' } };
    throw e;
  };
  const recusado = await tools.execute('criar_pedido', bom, { from: COMPRADOR });
  t('API recusando não vira "pedido não encontrado"',
    recusado.erro === 'nao_consegui_fechar', recusado.erro);
  t('  e manda o cliente para o site', /LINK|site/i.test(recusado.instrucao || ''),
    recusado.instrucao);
  t('  sem admitir defeito ao cliente', /sem falar em erro/i.test(recusado.instrucao || ''));

  nerixV.listProducts = listProdutosAntes;
  nerixV.createOrder = createOrderAntes;
  nerixV.listOrders = listOrdersAntes;

  // ── Consulta pelo telefone de quem está falando ─────────────
  //
  // O cliente está falando PELO número que cadastrou no checkout: o dado já
  // está na mão. Exigir código + e-mail de quem já se identificou pelo WhatsApp
  // era mandar ele procurar um UUID no e-mail antes de saber se o Pix caiu.
  //
  // A prova de posse aqui é o remetente do WhatsApp, autenticado pelo próprio
  // WhatsApp. É por isso que ela não pode vir por argumento.
  bloco('meus_pedidos — o telefone é a prova');

  const nerixMod2 = require('./src/nerix');
  const listOrdersReal = nerixMod2.listOrders;
  const buscas = [];

  const PEDIDO_DELE = {
    order_number: 'PED-1',
    status: 'paid',
    total: 49.9,
    customer_phone: '5541988887777',
    created_at: '2026-08-20T10:00:00Z',
    items: [{ product_name: 'Hollow Knight', quantity: 1, product_key: 'CHAVE-DELE' }],
  };
  const PEDIDO_DE_OUTRO = {
    order_number: 'PED-2',
    status: 'paid',
    total: 99.9,
    customer_phone: '5541977776666',
    created_at: '2026-08-21T10:00:00Z',
    items: [{ product_name: 'Zelda', quantity: 1, product_key: 'CHAVE-DE-OUTRO' }],
  };

  // A API devolve os DOIS de propósito: o filtro que vale é o local
  // (vendas.js), não o `search` mandado na chamada. Uma API que ignorasse o
  // parâmetro devolveria a loja inteira, e sem o filtro local o cliente leria
  // o pedido, o valor e a CHAVE de outra pessoa.
  nerixMod2.listOrders = async (params) => {
    buscas.push(params);
    return { data: [PEDIDO_DELE, PEDIDO_DE_OUTRO] };
  };

  const meus = await tools.execute('meus_pedidos', {}, { from: '5541988887777' });
  t('acha o pedido pelo telefone', meus.total === 1, JSON.stringify(meus.total));
  t('  e é o pedido certo', meus.pedidos?.[0]?.codigo === 'PED-1', meus.pedidos?.[0]?.codigo);
  t('  com a chave dele', /CHAVE-DELE/.test(JSON.stringify(meus)));
  // O teste que importa: a chave de OUTRO cliente não pode aparecer.
  t('  e NUNCA o pedido de outro cliente',
    !JSON.stringify(meus).includes('CHAVE-DE-OUTRO') && !JSON.stringify(meus).includes('PED-2'),
    JSON.stringify(meus));

  // O modelo pode alucinar qualquer argumento. Se um telefone por argumento
  // valesse, bastaria ele inventar um para ler o pedido de outra pessoa.
  const forjado = await tools.execute(
    'meus_pedidos',
    { telefone: '5541977776666', from: '5541977776666' },
    { from: '5541988887777' },
  );
  t('argumento de telefone é ignorado', forjado.pedidos?.[0]?.codigo === 'PED-1',
    forjado.pedidos?.[0]?.codigo);
  t('  e o schema nem tem onde recebê-lo',
    Object.keys(tools.definitions.find((d) => d.function.name === 'meus_pedidos')
      .function.parameters.properties).length === 0);

  // Sem ctx.from não há prova nenhuma — não pode cair no caminho de listar.
  const semCtx = await tools.execute('meus_pedidos', {}, {});
  t('sem telefone no contexto não consulta', semCtx.erro === 'sem_telefone', JSON.stringify(semCtx));

  // Quem comprou informando outro telefone continua tendo caminho: o antigo.
  const semNada = await tools.execute('meus_pedidos', {}, { from: '5541911110000' });
  t('não achou nada devolve total 0', semNada.total === 0, JSON.stringify(semNada.total));
  t('  e manda pedir código e e-mail', /consultar_pedido/.test(semNada.instrucao || ''),
    semNada.instrucao);

  nerixMod2.listOrders = listOrdersReal;

  // ── O handoff tem que chamar alguém ─────────────────────────
  //
  // Gravava `paused:true` e um console.log. Só. O bot ficava mudo, ninguém era
  // avisado, e o cliente esperava um atendente que não sabia que existia um
  // cliente. O caminho do menu (handlers.js) fazia a mesma coisa.
  bloco('falar_com_atendente avisa o operador');

  const sendReal = senderMod.send;
  const alertas = [];
  senderMod.send = async (para, texto) => { alertas.push({ para, texto: String(texto) }); };

  const CLI = '5541966665555';
  storeMod.saveContact(CLI, { menuNode: 'main', modoIA: true });

  const handoff = await tools.execute(
    'falar_com_atendente',
    { nome_completo: 'Ana Silva', motivo: 'a chave nao funcionou', contato: 'ana@exemplo.com' },
    { from: CLI },
  );
  senderMod.send = sendReal;

  t('transfere', handoff.transferido === true);
  t('  e alerta o operador', alertas.some((a) => a.para === '5541999999999'),
    JSON.stringify(alertas.map((a) => a.para)));

  const alerta = alertas.map((a) => a.texto).join('\n');
  t('  com o nome do cliente', /Ana Silva/.test(alerta), alerta);
  t('  com o telefone dele', new RegExp(CLI).test(alerta));
  t('  e com o motivo', /chave nao funcionou/.test(alerta));
  // Regra 1: o alerta sai pelo mesmo número comercial que fala com o cliente.
  t('  sem vocabulário proibido',
    !/\bbra[çc]o|rob[ôo]|\bbots?\b|autom[aá]tic\w*|taobao|fornecedor/i.test(alerta),
    alerta);

  // Sem limpar os dois, o cliente que volta com #inicio cai direto na IA de
  // novo — a mesma que ele acabou de pedir para trocar por gente.
  const depois = storeMod.getContact(CLI);
  t('  e pausa o contato', depois?.paused === true);
  t('  limpando o menuNode', !depois?.menuNode, String(depois?.menuNode));
  t('  e o modoIA', depois?.modoIA === false, String(depois?.modoIA));

  // Motivo é texto do MODELO indo para o WhatsApp: não pode virar parede.
  senderMod.send = async (para, texto) => { alertas.push({ para, texto: String(texto) }); };
  alertas.length = 0;
  await tools.execute(
    'falar_com_atendente',
    { nome_completo: 'Beto Souza', motivo: 'x'.repeat(900) },
    { from: '5541966664444' },
  );
  senderMod.send = sendReal;
  t('motivo enorme é cortado', (alertas[0]?.texto || '').length < 400,
    String((alertas[0]?.texto || '').length) + ' caracteres');

  // ── A cascata desiste no prazo ──────────────────────────────
  //
  // 6 provedores × 40s de timeout × 4 passos de ferramenta = minutos de
  // "digitando..." antes de o cliente receber qualquer coisa. E nenhum desses
  // minutos aparece em lugar nenhum: quem desiste é o cliente, calado.
  bloco('a IA desiste no prazo, nao em minutos');

  const ai = require('./src/ai');

  // Prazo ja vencido: NEM TENTA. E o caso do ultimo passo de ferramenta, que
  // comeca quando o orcamento de tempo ja acabou -- e uma tentativa que vai
  // levar 40s para dar no mesmo lugar (o menu) e so espera somada.
  chamadasAoModelo.length = 0;
  let erroPrazo = null;
  try {
    await ai.chat([{ role: 'user', content: 'oi' }], { deadline: Date.now() - 1 });
  } catch (err) {
    erroPrazo = err;
  }
  t('prazo vencido nem chama o modelo', chamadasAoModelo.length === 0,
    String(chamadasAoModelo.length));
  t('  e o erro diz que foi prazo', erroPrazo?.prazoEsgotado === true, erroPrazo?.name);

  // Com prazo, tenta -- e UMA vez so.
  //
  // E a trava que este bloco existe para manter: modelo fora do ar nao pode
  // virar uma FILA de tentativas. Era assim que o cliente esperava minutos por
  // uma resposta que ia acabar sendo o menu de qualquer jeito.
  chamadasAoModelo.length = 0;
  let erroFalha = null;
  try {
    await ai.chat([{ role: 'user', content: 'oi' }], { deadline: Date.now() + 60000 });
  } catch (err) {
    erroFalha = err;
  }
  t('com prazo, tenta o modelo', chamadasAoModelo.length >= 1,
    `${chamadasAoModelo.length} chamada(s)`);
  // No maximo DUAS: a chamada e uma repeticao.
  //
  // O padrao do SDK e 2 repeticoes -- tres chamadas, com espera entre elas --,
  // e isso e a mesma doenca da cascata que foi removida: o cliente olhando
  // "digitando..." enquanto o sistema insiste sozinho, para entregar o menu do
  // mesmo jeito. Uma repeticao cobre a piscada de verdade; a segunda e espera
  // pura.
  t('  e insiste no maximo uma vez', chamadasAoModelo.length <= 2,
    `${chamadasAoModelo.length} chamada(s)`);
  t('  o erro sobe para o handlers cair no menu', Boolean(erroFalha), erroFalha?.name);

  // Sem chave nenhuma: falha na hora, sem nem abrir conexao.
  const chaveAntes = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = '';
  chamadasAoModelo.length = 0;
  let erroSemChave = null;
  try {
    await ai.chat([{ role: 'user', content: 'oi' }], { deadline: Date.now() + 60000 });
  } catch (err) {
    erroSemChave = err;
  }
  t('sem chave nao vai a rede', chamadasAoModelo.length === 0, String(chamadasAoModelo.length));
  t('  e falha na hora', Boolean(erroSemChave), erroSemChave?.message);
  process.env.ANTHROPIC_API_KEY = chaveAntes;

  globalThis.fetch = fetchReal;

  console.log('\n' + (falhas ? falhas + ' FALHA(S)' : 'todos os testes passaram'));
  process.exit(falhas ? 1 : 0);
})();
