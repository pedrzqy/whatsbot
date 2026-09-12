'use strict';

/**
 * CICLO DE VENDA — o que acontece depois que o cliente compra.
 *
 * Até aqui o bot cuidava só da porta de entrada: menu, dúvida, código de
 * segurança. Depois do "comprar" ele ficava mudo, e a venda seguia por fora —
 * o operador descobria pelo painel, o cliente ficava sem confirmação, e a
 * chave saía na mão.
 *
 * Este arquivo fecha o ciclo em três frentes, todas disparadas pelo webhook da
 * Nerix (server.js → handlers.onNerixEvent):
 *
 *   order.paid       → avisa o cliente e notifica o operador
 *   order.delivered  → entrega a chave no WhatsApp do cliente
 *   order.cancelled  → registra para o operador não descobrir depois
 *
 * TRÊS COISAS AQUI SÃO IRREVERSÍVEIS e por isso cada uma tem trava própria:
 *
 *  1. Chave enviada é chave gasta. O webhook pode repetir (a Nerix reenvia o
 *     que não recebeu 200 a tempo, e um deploy no meio disso garante isso),
 *     então tudo passa por `jaFeito`/`marcar`, com o estado em disco.
 *  2. Chave no número errado é chave perdida E cliente com acesso ao que não
 *     comprou. O telefone do pedido é normalizado com regra estrita: o que não
 *     encaixa não vira envio, vira alerta.
 *  3. Mensagem ao cliente sai pelo número comercial. Nada aqui inventa prazo,
 *     valor ou promessa — tudo vem do pedido.
 */

const fs = require('fs');
const path = require('path');
const nerix = require('./nerix');
const sender = require('./sender');
const { formatOrder } = require('./tools');

// A lista de operadores mora na config da ponte porque foi lá que ela nasceu.
// Importar de lá é melhor que ter uma segunda lista: duas variáveis com o
// mesmo papel divergem, e aí o alerta de venda vai para um número e o de
// verificação para outro.
const operadorCfg = require('./ponte/config').operador;

// ── Estado: o que já foi feito ───────────────────────────────
//
// Mesma pasta do estado da ponte, e pelo mesmo motivo: é o volume que
// sobrevive ao deploy. PONTE_DATA_DIR existe para o teste escrever noutro
// lugar sem encostar no arquivo de produção.
const DATA_DIR = process.env.PONTE_DATA_DIR || path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'vendas.json');

/** @type {{pedidos: Record<string, {notificado?:number, avisadoPago?:number, entregue?:number, lembradoPix?:number, cancelado?:number, visto:number}>}} */
let dados = { pedidos: {} };

function load() {
  try {
    dados = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (!dados || typeof dados !== 'object') dados = { pedidos: {} };
    if (!dados.pedidos) dados.pedidos = {};
  } catch {
    dados = { pedidos: {} };
  }
}

function persist() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(dados), 'utf8');
  } catch (err) {
    // Não derruba a venda por causa do disco. O pior caso de não persistir é
    // uma notificação repetida depois de um restart — chato, não perigoso.
    // Chave duplicada não passa por aqui: quem grava antes de enviar é
    // entregarChaves(), e ele checa o retorno.
    console.error('[vendas] não consegui gravar o estado:', err.message);
  }
}

// 90 dias. O arquivo guarda uma linha por pedido e nunca é lido em massa, mas
// um processo que fica meses no ar acumularia todo o histórico da loja num
// JSON que é lido inteiro na subida.
const VALIDADE_MS = 90 * 24 * 3600 * 1000;

function limparAntigos() {
  const corte = Date.now() - VALIDADE_MS;
  let removidos = 0;
  for (const [codigo, reg] of Object.entries(dados.pedidos)) {
    if ((reg.visto || 0) < corte) {
      delete dados.pedidos[codigo];
      removidos++;
    }
  }
  return removidos;
}

/** Este passo já foi dado para este pedido? */
function jaFeito(codigo, passo) {
  return Boolean(dados.pedidos[String(codigo)]?.[passo]);
}

/**
 * Marca o passo como feito e grava NA HORA.
 *
 * Devolve false quando já estava marcado — é assim que o chamador descobre que
 * perdeu a corrida. Dois webhooks do mesmo evento chegando juntos passariam
 * os dois por um `if (jaFeito) return`, porque nada entre a checagem e a
 * gravação os separa. Aqui a checagem e a marcação são o mesmo passo.
 */
function marcar(codigo, passo) {
  const chave = String(codigo);
  const reg = dados.pedidos[chave] || (dados.pedidos[chave] = { visto: Date.now() });
  if (reg[passo]) return false;
  reg[passo] = Date.now();
  reg.visto = Date.now();
  persist();
  return true;
}

// ── Telefone ─────────────────────────────────────────────────

/**
 * Telefone do pedido → número de WhatsApp, ou null.
 *
 * Estrito de propósito. O campo é preenchido por gente no checkout, então
 * chega de tudo: com máscara, sem DDD, com +55, com 9 a mais, com texto junto.
 * Adivinhar o que falta é o caminho para mandar a chave de um cliente para o
 * telefone de outro — e nesse ponto não há desfazer.
 *
 * Aceita só o que é inequívoco:
 *   10 ou 11 dígitos  → número BR sem código do país, prefixa 55
 *   12 ou 13 com 55   → já está pronto
 * Qualquer outra coisa devolve null, e quem chama trata como "entrega manual".
 */
function paraWhatsApp(telefone) {
  const so = String(telefone || '').replace(/\D/g, '');
  if (!so) return null;

  if (so.length === 10 || so.length === 11) return `55${so}`;
  if ((so.length === 12 || so.length === 13) && so.startsWith('55')) return so;

  return null;
}

// ── Leitura do pedido ────────────────────────────────────────

/**
 * O pedido inteiro, a partir do que o webhook trouxe.
 *
 * O webhook manda o essencial, mas o formato varia por evento e por versão da
 * API. Em vez de depender do payload, buscamos o pedido pelo código: uma
 * requisição a mais, e o resto do arquivo passa a ler sempre a mesma forma.
 *
 * Sem e-mail na chamada de propósito: a validação de e-mail existe para provar
 * que QUEM PERGUNTA é o dono. Aqui quem pergunta é a loja, sobre um evento que
 * a própria loja emitiu.
 */
async function carregar(evento) {
  const dataEvento = evento?.data || evento || {};
  const codigo = dataEvento.order_number || dataEvento.code || dataEvento.id;
  if (!codigo) return null;

  let cru = dataEvento;
  try {
    const resp = await nerix.getOrder(codigo);
    cru = resp?.data || resp || dataEvento;
  } catch (err) {
    // Segue com o que o webhook trouxe. Perder a notificação porque a API
    // piscou é pior que notificar com menos detalhe.
    console.warn(`[vendas] não consegui buscar ${codigo}: ${err.response?.status || err.message}`);
  }

  const fmt = formatOrder(cru);
  return {
    codigo: fmt.codigo || codigo,
    status: fmt.status,
    total: fmt.total,
    pago: fmt.pago,
    itens: fmt.itens || [],
    link_pagamento: fmt.link_pagamento,
    pix: fmt.pix_copia_e_cola,
    nome: cru.customer_name || cru.customer?.name || cru.name || '',
    email: cru.customer_email || cru.customer?.email || '',
    telefone: cru.customer_phone || cru.customer?.phone || cru.phone || '',
  };
}

/** Primeiro nome, capitalizado. Vazio quando não dá para saber. */
function primeiroNome(nome) {
  const p = String(nome || '').trim().split(/\s+/)[0] || '';
  return p ? p.charAt(0).toUpperCase() + p.slice(1).toLowerCase() : '';
}

/** As chaves que saíram, e os itens que ficaram sem. */
function separarPorChave(itens) {
  const comChave = itens.filter((i) => i.chave);
  const semChave = itens.filter((i) => !i.chave);
  return { comChave, semChave };
}

// ── Alerta ao operador ───────────────────────────────────────

/**
 * Manda para TODOS os operadores, um por vez.
 *
 * Em série porque o sender é humanizado; um try por destino porque um número
 * fora do ar não pode engolir o aviso dos outros. Mesma forma do alertar() da
 * ponte, e pelos mesmos motivos.
 */
async function avisarOperador(texto, opts = {}) {
  const numeros = operadorCfg.numeros || [];
  if (!numeros.length) {
    console.warn('[vendas] sem operador configurado (PONTE_OPERADOR_NUMERO):', texto);
    return;
  }
  for (const numero of numeros) {
    try {
      await sender.send(numero, texto, opts);
    } catch (err) {
      console.error(`[vendas] falha ao avisar ${numero}:`, err.message);
    }
  }
}

// ── Pedido em aberto: o Pix vai AGORA ────────────────────────

/**
 * Manda o Pix no instante em que o pedido aparece, e não horas depois.
 *
 * O que existia era só a varredura de hora em hora (lembrarPixPendente), e ela
 * começa a olhar o pedido com DUAS HORAS de idade. Isso foi desenhado como
 * cutucada em quem desistiu — e virou, sem querer, o único caminho para quem
 * fez o pedido no site: a pessoa gerava o Pix, fechava a página, e a primeira
 * mensagem da loja chegava quando a vontade de comprar já tinha passado.
 *
 * Quem fecha a compra PELA CONVERSA nunca teve esse problema: ali o Pix sai na
 * mesma resposta. A diferença não era decisão de ninguém, era um evento que não
 * tinha tratamento.
 *
 * Em DUAS mensagens, e isso não é capricho: o Pix vai sozinho na segunda,
 * sem texto em volta, porque é assim que ele é copiado de uma vez no celular.
 * Texto colado junto faz a pessoa selecionar na mão e errar o código.
 */
async function mandarPixNaHora(pedido) {
  if (pedido.pago) return;
  const pix = pedido.pix;
  if (!pix && !pedido.link_pagamento) return;

  const numero = paraWhatsApp(pedido.telefone);
  if (!numero) return; // sem telefone confiável não há a quem mandar

  // Marca antes de mandar, como no resto do arquivo: falha de envio não pode
  // virar duas cobranças. Uma perdida é melhor que uma repetida — e a varredura
  // de duas horas ainda passa por aqui depois.
  if (!marcar(pedido.codigo, 'pixNaHora')) return;

  const nome = primeiroNome(pedido.nome);
  await sender.send(
    numero,
    `${nome ? `Oi, ${nome}! ` : 'Oi! '}Recebi seu pedido 😊\n\n` +
      `*${pedido.codigo}*${pedido.total ? ` — ${pedido.total}` : ''}\n\n` +
      (pix
        ? 'Te mando o Pix copia e cola na mensagem seguinte. Assim que o pagamento cair, eu te aviso por aqui.'
        : `Para pagar: ${pedido.link_pagamento}\n\nAssim que cair, eu te aviso por aqui.`),
  );

  if (pix) await sender.send(numero, pix);
  console.log(`[vendas] Pix mandado na hora — pedido ${pedido.codigo}`);
}

// ── order.paid ───────────────────────────────────────────────

/**
 * Venda paga: notifica o operador e confirma para o cliente.
 *
 * A notificação diz, em uma tela: quem comprou, o telefone para responder, o
 * que levou, quanto pagou e — o que mais importa no dia a dia — SE A CHAVE
 * SAIU. Produto de conta vem com product_key null, e isso significa que
 * alguém precisa preparar a entrega na mão. Antes, esse caso não gerava
 * nada: o pedido ficava esperando o operador lembrar que existia.
 */
async function notificarVenda(pedido) {
  if (!marcar(pedido.codigo, 'notificado')) return;

  const { comChave, semChave } = separarPorChave(pedido.itens);
  const linhas = [`💰 *Venda paga* — ${pedido.total || 'valor não informado'}`, ''];

  if (pedido.nome) linhas.push(`*${pedido.nome}*`);
  if (pedido.telefone) linhas.push(pedido.telefone);
  if (pedido.email) linhas.push(pedido.email);

  if (pedido.itens.length) {
    linhas.push('');
    for (const i of pedido.itens) {
      linhas.push(`• ${i.nome}${i.quantidade > 1 ? ` (${i.quantidade}x)` : ''}`);
    }
  }

  linhas.push('');
  if (semChave.length && comChave.length) {
    linhas.push(`⚠️ *${semChave.length} item(ns) sem chave* — precisa preparar a entrega.`);
  } else if (semChave.length) {
    linhas.push('⚠️ *Sem chave em estoque* — a entrega é na mão.');
  } else if (comChave.length) {
    // "entrega automática" era o que estava escrito aqui, e "automática" é
    // palavra barrada — sai pelo mesmo número comercial que fala com o cliente,
    // e a regra vale também para o que chega em VOCÊ. O aviso não perdeu nada:
    // o que interessa nesta linha é se sobra trabalho, e é isso que ela diz.
    linhas.push('✅ Chave em estoque — não precisa preparar nada.');
  }

  linhas.push('', `_Pedido ${pedido.codigo}_`);
  await avisarOperador(linhas.join('\n'));
}

/**
 * Confirma o pagamento para o cliente.
 *
 * É o momento de maior ansiedade da compra: ele acabou de mandar dinheiro para
 * uma loja pela internet e não tem nada na mão. O silêncio aqui é o que gerava
 * a maior parte dos "oi, caiu meu pix?".
 *
 * Não promete prazo. O que a loja pratica está no knowledge.js e sai pelo
 * menu; inventar um número aqui é criar uma promessa que ninguém prometeu.
 */
async function avisarPagamentoAoCliente(pedido) {
  const numero = paraWhatsApp(pedido.telefone);
  if (!numero) return; // sem telefone confiável não há a quem avisar
  if (!marcar(pedido.codigo, 'avisadoPago')) return;

  const nome = primeiroNome(pedido.nome);
  const { semChave } = separarPorChave(pedido.itens);

  const linhas = [
    `${nome ? `${nome}, p` : 'P'}agamento confirmado ✅`,
    '',
    `Pedido *${pedido.codigo}*${pedido.total ? ` — ${pedido.total}` : ''}`,
  ];

  // Só quando a entrega depende de gente. Para chave em estoque, a entrega
  // chega em seguida pelo order.delivered e um "estou preparando" no meio
  // deixaria o cliente esperando algo que já está a caminho.
  if (semChave.length) {
    linhas.push('', 'Já estou preparando seu pedido e te mando aqui assim que ficar pronto 👍');
  }

  await sender.send(numero, linhas.join('\n'));
  console.log(`[vendas] pagamento de ${pedido.codigo} confirmado ao cliente`);
}

// ── order.delivered ──────────────────────────────────────────

/**
 * Entrega a(s) chave(s) no WhatsApp.
 *
 * MARCA ANTES DE ENVIAR, e isso é deliberado. Se marcasse depois, uma falha no
 * meio do envio deixaria o pedido sem marca e o próximo webhook mandaria tudo
 * de novo — chave duplicada é prejuízo direto. Marcando antes, o pior caso é
 * uma entrega que não saiu, e para esse caso existe o alerta: o operador
 * assume, que é o desfecho que a loja já sabe tratar.
 */
async function entregarChaves(pedido) {
  const { comChave, semChave } = separarPorChave(pedido.itens);
  if (!comChave.length) {
    // Entregue sem chave nenhuma é justamente o produto de conta. Não é erro,
    // é o caso que precisa de gente — e o operador já foi avisado no paid.
    return;
  }

  const numero = paraWhatsApp(pedido.telefone);
  if (!numero) {
    // A CHAVE VAI JUNTO. Sem ela o aviso é só um "vá procurar no painel": o
    // operador está no celular, no meio de outra coisa, e a única razão de
    // existir esta mensagem é ele conseguir resolver sem sair dela.
    await avisarOperador(
      `📦 *Entrega manual* — pedido ${pedido.codigo}\n\n` +
        `${pedido.nome || 'Cliente'} tem chave pronta, mas o telefone do pedido ` +
        `(${pedido.telefone || 'vazio'}) não dá para usar no WhatsApp.\n\n` +
        `Manda por e-mail: ${pedido.email || '(sem e-mail)'}\n\n` +
        comChave.map((i) => `*${i.nome}*\n\`${i.chave}\``).join('\n\n'),
    );
    return;
  }

  if (!marcar(pedido.codigo, 'entregue')) return;

  const nome = primeiroNome(pedido.nome);
  const linhas = [`${nome ? `${nome}, s` : 'S'}eu pedido está pronto 🎮`, ''];

  for (const i of comChave) {
    linhas.push(`*${i.nome}*`, `\`${i.chave}\``, '');
  }

  if (semChave.length) {
    linhas.push('O restante do pedido eu te mando em seguida 👍', '');
  }

  linhas.push('_Qualquer coisa é só chamar aqui. Digite *#menu* para ver as opções._');

  try {
    await sender.send(numero, linhas.join('\n'));
    console.log(`[vendas] ${comChave.length} chave(s) do pedido ${pedido.codigo} entregues`);
  } catch (err) {
    // O pedido continua marcado como entregue de propósito (ver o cabeçalho da
    // função). Quem resolve daqui é gente, com a chave em mãos.
    await avisarOperador(
      `⚠️ *Entrega falhou* — pedido ${pedido.codigo}\n\n` +
        `Não consegui mandar para ${numero}. Precisa entregar na mão.\n\n` +
        comChave.map((i) => `${i.nome}\n\`${i.chave}\``).join('\n\n'),
    );
    console.error(`[vendas] entrega de ${pedido.codigo} falhou:`, err.message);
  }
}

// ── order.cancelled ──────────────────────────────────────────

/** Cancelou/expirou: o operador fica sabendo sem precisar abrir o painel. */
async function avisarCancelamento(pedido) {
  if (!marcar(pedido.codigo, 'cancelado')) return;
  await avisarOperador(
    `🚫 *Pedido ${pedido.status}* — ${pedido.codigo}\n\n` +
      `${pedido.nome || 'Cliente'}${pedido.total ? ` · ${pedido.total}` : ''}`,
  );
}

// ── Pedidos de um telefone ───────────────────────────────────

/**
 * Os pedidos feitos com ESTE telefone, do mais novo para o mais velho.
 *
 * Existe para o cliente não precisar digitar o código do pedido (um UUID) e o
 * e-mail só para perguntar "cadê minha compra". O telefone já prova bastante:
 * ele está falando pelo número que cadastrou no checkout.
 *
 * NÃO substitui a consulta por código + e-mail, e isso é de propósito. Quem
 * comprou de outro número, ou digitou o telefone errado no checkout, continua
 * tendo o caminho de sempre — e é ele que vale quando a prova precisa ser
 * forte (a chave da Nerix é admin, e o e-mail é o que a própria API valida).
 *
 * O filtro é local. `search` vai na chamada porque, se a API souber filtrar,
 * economiza; mas nada aqui confia nisso — o que decide é a comparação do
 * telefone normalizado, feita aqui dentro. Uma API que ignora o parâmetro
 * devolveria a loja inteira, e sem esta comparação o cliente veria pedido de
 * outra pessoa.
 */
async function pedidosDoTelefone(telefone, { limite = 100 } = {}) {
  const alvo = paraWhatsApp(telefone);
  if (!alvo) return [];

  let lista = [];
  try {
    const resp = await nerix.listOrders({ search: alvo.slice(2), limit: limite });
    lista = resp?.data || resp || [];
  } catch (err) {
    console.warn(`[vendas] listOrders falhou: ${err.response?.status || err.message}`);
    return [];
  }
  if (!Array.isArray(lista)) return [];

  const meus = lista.filter((p) => {
    const dele = paraWhatsApp(p.customer_phone || p.customer?.phone || p.phone);
    return dele && dele === alvo;
  });

  // Mais novo primeiro: quem pergunta "cadê meu pedido" quer o último.
  meus.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
  return meus;
}

// ── Pix gerado e não pago ────────────────────────────────────

/**
 * Cutuca UMA vez quem gerou pagamento e não pagou.
 *
 * É o cliente mais quente que existe: escolheu, decidiu e parou no último
 * passo. O recovery.js já cutuca quem conversou e sumiu, mas ele olha a
 * conversa, não a loja — quem entrou pelo site, gerou o Pix e nunca falou com
 * o bot não aparece lá.
 *
 * Regras que existem para isto não virar spam, cada uma por um motivo:
 *  - UMA vez por pedido, para sempre (trava `lembradoPix` no disco).
 *  - Nada antes de 2h: quem acabou de gerar o Pix ainda está pagando, e
 *    "esqueceu algo?" nesse momento atrapalha a compra em vez de ajudar.
 *  - Nada depois de 48h: aí o Pix já expirou e o lembrete manda o cliente
 *    para um link morto.
 *  - Só em horário civil. Cobrança às 3 da manhã é como a loja perde o
 *    cliente e o número de uma vez.
 */
const PIX_MIN_MS = 2 * 3600 * 1000;
const PIX_MAX_MS = 48 * 3600 * 1000;

/** Hora em Brasília, sem depender do fuso do servidor. */
function horaBRT(agora = new Date()) {
  return Number(
    new Intl.DateTimeFormat('pt-BR', {
      timeZone: 'America/Sao_Paulo',
      hour: '2-digit',
      hour12: false,
    }).format(agora),
  );
}

async function lembrarPixPendente() {
  const hora = horaBRT();
  if (hora < 9 || hora >= 21) return 0;

  let lista = [];
  try {
    const resp = await nerix.listOrders({ status: 'pending', limit: 50 });
    lista = resp?.data || resp || [];
  } catch (err) {
    console.warn(`[vendas] varredura de Pix falhou: ${err.response?.status || err.message}`);
    return 0;
  }
  if (!Array.isArray(lista)) return 0;

  let mandados = 0;
  const agora = Date.now();

  // UMA MENSAGEM POR PESSOA, e não por pedido.
  //
  // O laço mandava uma cutucada para cada pedido em aberto, e a trava de "não
  // repetir" era por CÓDIGO. Quem tentou fechar quatro vezes tinha quatro
  // pedidos parados, então recebeu quatro mensagens seguidas, todas iguais
  // menos pelo código.
  //
  // E não eram quatro compras: eram quatro tentativas da mesma. Os valores se
  // repetiam dois a dois. Do lado de lá isso não parece cobrança, parece
  // defeito, e chega num momento em que a pessoa ainda está decidindo.
  //
  // Agrupar por telefone é o conserto, e ele também responde "e se ele tiver
  // dois pedidos de verdade?": a mensagem fala do MAIS RECENTE, que é o que a
  // pessoa tentou por último, e os outros são marcados junto para não voltarem
  // um a um na próxima volta.
  const porPessoa = new Map();

  for (const cru of lista) {
    const fmt = formatOrder(cru);
    if (fmt.pago) continue; // o status da lista pode estar velho

    const criadoEm = new Date(cru.created_at || 0).getTime();
    const idade = agora - criadoEm;
    if (!(idade > PIX_MIN_MS && idade < PIX_MAX_MS)) continue;

    const numero = paraWhatsApp(cru.customer_phone || cru.customer?.phone);
    if (!numero) continue;
    if (jaFeito(fmt.codigo, 'lembradoPix')) continue;

    const grupo = porPessoa.get(numero) || { itens: [] };
    grupo.itens.push({ cru, fmt, criadoEm });
    porPessoa.set(numero, grupo);
  }

  for (const [numero, grupo] of porPessoa) {
    // O mais recente é o que ela tentou por último, e o único que interessa.
    grupo.itens.sort((a, b) => b.criadoEm - a.criadoEm);
    const { cru, fmt } = grupo.itens[0];

    // Marca TODOS antes de mandar. Os outros pedidos da mesma pessoa não podem
    // virar mensagem na volta seguinte, senão a enxurrada só fica mais lenta.
    // E marcar antes de enviar é a regra do arquivo: falha de envio vira uma
    // cobrança perdida, nunca uma repetida.
    let primeiro = false;
    for (const item of grupo.itens) {
      if (marcar(item.fmt.codigo, 'lembradoPix')) primeiro = true;
    }
    if (!primeiro) continue;

    const nome = primeiroNome(cru.customer_name || cru.customer?.name);
    const linhas = [
      `${nome ? `Oi, ${nome}! ` : 'Oi! '}Vi que seu pedido ficou aguardando pagamento 😊`,
      '',
      `*${fmt.codigo}*${fmt.total ? ` — ${fmt.total}` : ''}`,
    ];
    if (fmt.pix_copia_e_cola) {
      linhas.push('', '💠 *Pix copia e cola:*', `\`${fmt.pix_copia_e_cola}\``);
    } else if (fmt.link_pagamento) {
      linhas.push('', `💳 Pagar: ${fmt.link_pagamento}`);
    }
    linhas.push('', '_Se já pagou ou mudou de ideia, pode ignorar 👍_');

    try {
      await sender.send(numero, linhas.join('\n'));
      mandados++;
    } catch (err) {
      console.warn(`[vendas] lembrete de ${fmt.codigo} não saiu: ${err.message}`);
    }
  }

  if (mandados) console.log(`[vendas] ${mandados} lembrete(s) de pagamento enviados`);
  return mandados;
}

// ── Porta de entrada ─────────────────────────────────────────

/**
 * Um evento da Nerix.
 *
 * Cada passo é independente e cada um tem a própria trava, então a ordem aqui
 * é só de prioridade: o operador primeiro, porque é quem age quando algo
 * precisa de gente.
 */
async function onEvento(evento) {
  const nome = evento?.event || evento?.type || '';
  const pedido = await carregar(evento);

  if (!pedido) {
    console.warn('[vendas] evento sem número de pedido:', nome);
    return;
  }

  console.log(`[vendas] ${nome} — pedido ${pedido.codigo} (${pedido.itens.length} item(ns))`);

  // Carimba a chegada. É a única prova de que o webhook da loja está mesmo
  // cadastrado e chegando aqui — sem ela, "nunca vendeu nada hoje" e "o
  // webhook não está configurado" ficam idênticos para quem olha de fora.
  dados.ultimoEventoEm = Date.now();
  persist();

  switch (nome) {
    // Pedido nasceu esperando pagamento. Os três nomes porque a Nerix pode
    // chamar de um jeito ou de outro, e descobrir qual é custaria uma venda.
    case 'order.created':
    case 'order.pending':
    case 'order.awaiting_payment':
      await mandarPixNaHora(pedido);
      break;

    case 'order.paid':
    case 'order.approved':
      await notificarVenda(pedido);
      await avisarPagamentoAoCliente(pedido);
      break;

    case 'order.delivered':
    case 'order.completed':
      // Pedido que já nasce entregue (chave em estoque, pagamento aprovado na
      // hora) pode não passar pelo paid — a Nerix entrega e emite os dois
      // quase juntos. As travas deixam chamar os dois sem risco de repetir.
      await notificarVenda(pedido);
      await entregarChaves(pedido);
      break;

    case 'order.cancelled':
    case 'order.canceled':
    case 'order.expired':
    case 'order.refunded':
      await avisarCancelamento(pedido);
      break;

    default:
      // Evento novo da Nerix não é erro: é aviso de que existe algo a tratar.
      console.log(`[vendas] evento sem tratamento: ${nome}`);

      // E o nome desconhecido não pode custar a venda.
      //
      // Os três `case` acima são um palpite sobre como a loja chama "pedido
      // criado". Se ela chamar de outra coisa, o pedido cairia aqui e a pessoa
      // esperaria as duas horas da varredura de novo — o defeito consertado
      // voltando por um nome diferente.
      //
      // Aqui a pergunta não é o nome do evento, é o estado do pedido: em
      // aberto e com Pix, ele vai. A trava de uma vez só cuida do resto, e um
      // evento de pedido já pago sai na primeira linha do mandarPixNaHora.
      await mandarPixNaHora(pedido);
  }
}

load();
const limpos = limparAntigos();
if (limpos) {
  persist();
  console.log(`[vendas] ${limpos} pedido(s) antigo(s) esquecido(s) do estado`);
}

/**
 * Liga a varredura de Pix pendente.
 *
 * De hora em hora, e não de minuto em minuto: o que muda no intervalo é a
 * idade de um pedido, e a menor janela que importa aqui é de 2 horas. Varrer
 * mais é gastar chamada de API para reler a mesma lista.
 *
 * `unref` para não segurar o processo no SIGTERM — o encerramento limpo do
 * server.js precisa poder terminar.
 */
let timerPix = null;

function iniciar({ intervaloMs = 3600_000 } = {}) {
  if (timerPix) return;
  timerPix = setInterval(() => {
    lembrarPixPendente().catch((err) => console.error('[vendas] varredura:', err.message));
  }, intervaloMs);
  timerPix.unref();
  console.log('[vendas] ciclo de venda ligado (lembrete de pagamento de hora em hora)');
}

function parar() {
  if (timerPix) clearInterval(timerPix);
  timerPix = null;
}

module.exports = {
  onEvento,
  iniciar,
  parar,
  pedidosDoTelefone,
  lembrarPixPendente,
  // Exportados para teste e para o lembrete de Pix (lembretes.js): entregar
  // chave e mandar para o número errado são as duas falhas caras deste
  // arquivo, e as duas moram nestas funções.
  paraWhatsApp,
  /** Quando chegou o último evento da loja. 0 = nunca chegou nenhum. */
  ultimoEventoEm: () => dados.ultimoEventoEm || 0,
  carregar,
  avisarOperador,
  jaFeito,
  marcar,
  primeiroNome,
  _dados: () => dados,
};
