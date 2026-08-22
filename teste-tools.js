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

  // Toda ferramenta que fala de pedido tem de exigir o e-mail.
  for (const d of tools.definitions) {
    if (!/pedido|order/i.test(d.function.name)) continue;
    const req = d.function.parameters?.required || [];
    t(`${d.function.name} exige e-mail`, req.includes('email'), req.join(','));
  }

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

  console.log('\n' + (falhas ? falhas + ' FALHA(S)' : 'todos os testes passaram'));
  process.exit(falhas ? 1 : 0);
})();
