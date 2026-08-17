'use strict';

/**
 * Ferramentas (function calling) que a IA pode chamar para consultar a Nerix.
 *
 * Segurança:
 *  - NÃO existe ferramenta que liste todos os pedidos da loja (a chave é admin
 *    e isso vazaria dados de outros clientes). O cliente só acessa o PRÓPRIO
 *    pedido informando número + e-mail, que a API da Nerix valida.
 *  - Chaves/licenças (product_key) só aparecem após essa validação de e-mail.
 */

const nerix = require('./nerix');
const config = require('./config');
const store = require('./store');
const ponte = require('./ponte');

/** Monta o link direto do produto no site (rota /package/:slug da Nerix). */
function productLink(slug) {
  if (!slug || !config.store.url) return null;
  return `${config.store.url}/package/${slug}`;
}

// Esquemas no formato OpenAI/Groq.
const definitions = [
  {
    type: 'function',
    function: {
      name: 'buscar_produtos',
      description: 'Busca produtos por termo (nome). Retorna preço, promoção, link e opções.',
      parameters: {
        type: 'object',
        properties: {
          termo: { type: 'string', description: 'Termo de busca pelo nome do produto (ex.: "minecraft"). Vazio lista os primeiros.' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'pedir_codigo_fornecedor',
      description:
        'Pede ao FORNECEDOR o código de verificação da conta do cliente e entrega o código a ele. ' +
        'Use quando o cliente estiver travado na tela de verificação e o site de código não resolver: ' +
        'ele precisa mandar o USUÁRIO da conta (algo como "rrrtsr223") e, de preferência, a FOTO da tela. ' +
        'Se ele ainda não mandou o usuário, PEÇA antes de chamar esta ferramenta — sem o usuário o fornecedor ' +
        'não consegue achar a conta. O fornecedor atende um cliente por vez e fica 11h à nossa frente, ' +
        'então pode demorar; a ferramenta já devolve o que dizer sobre o prazo.',
      parameters: {
        type: 'object',
        properties: {
          usuario: {
            type: 'string',
            description:
              'O usuário da conta, EXATAMENTE como o cliente mandou. Só o usuário, sem frase em volta. ' +
              'Alfanumérico, até 20 caracteres. Ex.: "rrrtsr223".',
          },
        },
        required: ['usuario'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'consultar_pedido',
      description:
        'Consulta um pedido da loja e o status do pagamento em tempo real. ' +
        'Use para "cadê meu pedido", "meu Pix caiu?", "já aprovou?", "não recebeu o jogo". ' +
        'EXIGE o código do pedido E o e-mail da compra: a Nerix confere se o e-mail é dono ' +
        'daquele pedido antes de responder qualquer coisa. Se o cliente não informou os dois, ' +
        'PEÇA o que faltar antes de chamar — chamar sem os dois só devolve erro. ' +
        'Nunca invente nem adivinhe código ou e-mail.',
      parameters: {
        type: 'object',
        properties: {
          codigo: {
            type: 'string',
            description: 'Código/número do pedido, exatamente como o cliente informou.',
          },
          email: {
            type: 'string',
            description: 'E-mail usado na compra. Obrigatório — é ele que prova que o pedido é dele.',
          },
        },
        required: ['codigo', 'email'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'falar_com_atendente',
      description: 'Transfere p/ atendente humano e pausa o bot. OBRIGATÓRIO colete NOME e SOBRENOME antes. Use p/ qualquer questão de PEDIDO (cliente disse que comprou, quer receber o jogo/login, entrega não chegou, dúvida/problema de pedido), opção online/perfil próprio, ou pedido de atendente. Se só tiver o primeiro nome, peça o sobrenome. Se o cliente tiver informado, passe também o e-mail OU o código da compra em "contato".',
      parameters: {
        type: 'object',
        properties: {
          nome_completo: { type: 'string', description: 'Nome e sobrenome do cliente (obrigatório)' },
          contato: { type: 'string', description: 'E-mail OU código da compra informado pelo cliente (se houver), pra facilitar o atendente.' },
          motivo: { type: 'string', description: 'Motivo resumido (ex.: "recebimento de pedido", "opção online/perfil próprio", "dúvida")' },
        },
        required: ['nome_completo'],
      },
    },
  },
];

// ─── Formatação segura dos resultados para o modelo ──────────────────

const brl = (n) => (n != null ? `R$ ${Number(n).toFixed(2)}` : null);

/** Preço de venda (menor) e, se houver promoção real, o valor "de" (maior) para riscar. */
function priceParts(price, promo) {
  const nums = [price, promo].map(Number).filter((n) => !Number.isNaN(n) && n > 0);
  if (!nums.length) return {};
  const por = Math.min(...nums);
  const de = Math.max(...nums);
  return de > por ? { por, de } : { por };
}

/** Formata preço para o modelo: { preco, preco_original? } (preco_original = "de" p/ riscar). */
function fmtPrice(parts) {
  if (parts.por == null) return { preco: 'consultar' };
  const out = { preco: brl(parts.por) };
  if (parts.de) out.preco_original = brl(parts.de); // há promoção → riscar este valor
  return out;
}

/** Formata o catálogo para o modelo (nome, preço de/por, opções/variantes, link). */
function formatProducts(list) {
  return list.slice(0, 8).map((p) => {
    const variantes = (p.variants || [])
      .filter((v) => v.is_active !== false)
      .map((v) => ({ nome: v.name, ...fmtPrice(priceParts(v.price, v.promotional_price)) }));

    let parts = priceParts(p.price, p.promotional_price);
    if (parts.por == null && variantes.length) {
      const vals = (p.variants || [])
        .filter((v) => v.is_active !== false)
        .map((v) => priceParts(v.price, v.promotional_price).por)
        .filter((n) => n != null);
      if (vals.length) parts = { por: Math.min(...vals) };
    }

    const out = { nome: p.name, ...fmtPrice(parts), link: productLink(p.slug) };
    if (variantes.length) out.opcoes = variantes;
    return out;
  });
}

/**
 * Status da Nerix → palavra que o cliente entende.
 *
 * O valor cru vai junto em `status_bruto`: se a Nerix criar um status novo, o
 * bot ainda tem o que dizer em vez de responder "undefined" — e o log mostra o
 * nome novo para adicionar aqui depois.
 */
const STATUS = {
  pending: 'aguardando pagamento',
  waiting_payment: 'aguardando pagamento',
  paid: 'pago',
  approved: 'pago',
  completed: 'concluído',
  delivered: 'entregue',
  processing: 'em processamento',
  cancelled: 'cancelado',
  canceled: 'cancelado',
  refunded: 'reembolsado',
  expired: 'expirado',
  failed: 'falhou',
};

const ESPERANDO_PAGAMENTO = new Set(['pending', 'waiting_payment', 'processing']);

/**
 * O que o modelo recebe sobre um pedido.
 *
 * Defensivo de propósito: a forma exata da resposta da Nerix pode variar entre
 * endpoints e versões, então cada campo é opcional e some quando não vier, em
 * vez de virar "undefined" na conversa com o cliente.
 */
function formatOrder(p) {
  if (!p) return { erro: 'pedido_nao_encontrado' };

  const bruto = String(p.status || p.payment_status || '').toLowerCase();
  const itens = (p.items || p.order_items || []).map((i) => {
    const item = {
      nome: i.product_name || i.name || i.product?.name,
      quantidade: i.quantity || 1,
    };
    // A chave/licença só chega aqui porque a Nerix já validou o e-mail contra
    // o pedido — é o mesmo gate que o site usa. Entregar no WhatsApp é o que o
    // cliente veio buscar; segurar exigiria um segundo canal para a mesma
    // prova de identidade.
    const chave = i.product_key || i.key || i.license;
    if (chave) item.chave = chave;
    return item;
  });

  const pago = ['paid', 'approved', 'completed', 'delivered'].includes(bruto);

  return {
    codigo: p.order_number || p.code || p.id,
    status: STATUS[bruto] || bruto || 'desconhecido',
    status_bruto: bruto || null,
    total: brl(p.total ?? p.amount),
    criado_em: p.created_at || p.createdAt || null,
    pago,
    itens: itens.length ? itens : undefined,
    // Link de pagamento SÓ enquanto falta pagar. Mandar "pague aqui" para quem
    // já pagou faz o cliente achar que a compra não passou e, na pior das
    // hipóteses, pagar de novo.
    link_pagamento: pago ? undefined : p.payment_url || p.checkout_url || undefined,

    // Pix copia-e-cola, também só enquanto falta pagar.
    //
    // Vem em p.payment.pix_qr_code (confirmado num pedido real). É a resposta
    // direta para "não consegui pagar" / "perdi o código do Pix", sem o
    // cliente ter que voltar ao site. O _base64 do mesmo objeto é a IMAGEM do
    // QR, com 8 mil caracteres — fora daqui de propósito: estouraria o
    // contexto do modelo e ele não tem como mandar imagem por este caminho.
    pix_copia_e_cola: pago ? undefined : p.payment?.pix_qr_code || p.payment?.qr_code || undefined,
  };
}

async function execute(name, args = {}, ctx = {}) {
  try {
    if (name === 'pedir_codigo_fornecedor') {
      const usuario = (args.usuario || '').trim();
      if (!usuario) return { erro: 'usuario_vazio' };

      const contato = ctx.from ? store.getContact(ctx.from) : null;
      // ctx.imagem vem do handlers quando o cliente mandou foto nesta mensagem.
      const r = await ponte.pedirCodigo(
        ctx.from,
        contato?.name || ctx.pushName || ctx.from,
        usuario,
        ctx.imagem || null,
      );

      console.log(`[ponte] ${ctx.from} pediu código para "${usuario}"${ctx.imagem ? ' (+foto)' : ''}`);
      return {
        aceito: r.aceito,
        // A IA repassa isto ao cliente com as palavras dela. NÃO invente prazo
        // diferente do que vem aqui — ele considera o fuso da China.
        instrucao_para_o_cliente: r.mensagem,
      };
    }

    if (name === 'falar_com_atendente') {
      const nome = (args.nome_completo || '').trim();
      if (nome.split(/\s+/).length < 2) return { erro: 'falta_sobrenome' };
      const contato = (args.contato || '').trim();
      if (ctx.from) store.saveContact(ctx.from, { paused: true, name: nome, ...(contato ? { pedidoContato: contato } : {}) });
      console.log(`[handoff] ${ctx.from} -> atendente (${nome})${contato ? ` | contato: ${contato}` : ''} | motivo: ${args.motivo || '-'}`);
      return { transferido: true, instrucao: 'Confirme ao cliente, de forma calorosa, que um atendente humano vai continuar o atendimento em instantes.' };
    }

    if (name === 'consultar_pedido') {
      const codigo = String(args.codigo || '').trim();
      const email = String(args.email || '').trim();

      // Os DOIS são obrigatórios, e a checagem é aqui e não só no schema.
      //
      // A chave da Nerix é de ADMIN: com ela dá para ler qualquer pedido da
      // loja. O e-mail é o que prova que quem pergunta é o dono — sem ele,
      // qualquer pessoa com um número de pedido leria o nome, o valor e a
      // licença de outro cliente. O modelo pode alucinar um argumento; o
      // schema não impede.
      if (!codigo) return { erro: 'falta_codigo', instrucao: 'Peça o código do pedido ao cliente.' };
      if (!email) {
        return {
          erro: 'falta_email',
          instrucao: 'Peça o e-mail usado na compra — sem ele a consulta não é feita.',
        };
      }

      const resp = await nerix.getOrder(codigo, { email });
      let pedido = resp?.data || resp;

      // Ainda esperando pagamento: confere em tempo real antes de responder.
      //
      // É exatamente a pergunta do cliente ("meu Pix caiu?"), e o estado salvo
      // pode estar velho — o Pix cai em segundos e o webhook pode atrasar.
      // checkPayment é POST e, se estiver pago, a própria Nerix dispara a
      // entrega das chaves. Falha aqui não derruba a consulta: o pior caso é
      // responder com o status que já tínhamos.
      const bruto = String(pedido?.status || pedido?.payment_status || '').toLowerCase();
      if (ESPERANDO_PAGAMENTO.has(bruto)) {
        try {
          const check = await nerix.checkPayment(codigo);
          const atualizado = check?.data || check;
          if (atualizado && (atualizado.status || atualizado.payment_status)) {
            pedido = { ...pedido, ...atualizado };
          }
        } catch (err) {
          console.warn(`[tools] check-payment de ${codigo} falhou: ${err.response?.status || err.message}`);
        }
      }

      const out = formatOrder(pedido);
      console.log(`[tools] pedido ${codigo} consultado por ${ctx.from || '?'} — status ${out.status}`);
      return out;
    }

    if (name === 'buscar_produtos') {
      const data = await nerix.listProducts({ search: args.termo || '', limit: 8 });
      const list = data.data || data || [];
      return { total_encontrados: list.length, produtos: formatProducts(list) };
    }

    return { erro: 'ferramenta_desconhecida' };
  } catch (err) {
    const status = err.response?.status;
    if (status === 404) return { erro: 'pedido_nao_encontrado' };

    // 403 é o CLIENTE: o e-mail não é o dono daquele pedido.
    if (status === 403) return { erro: 'email_nao_confere' };

    // 401 é a LOJA: a Nerix recusou a NOSSA chave.
    //
    // Estavam juntos, e isso fazia o cliente ouvir "seu e-mail não confere"
    // quando a NERIX_API_KEY estava inválida ou inativa — ele ficaria tentando
    // outros e-mails por um problema que não é dele e que não tem como
    // resolver. E o defeito ficaria invisível: o log diria "email errado" e
    // todo mundo procuraria no lugar errado.
    if (status === 401) {
      console.error(
        '[tools] a Nerix recusou NOSSA chave (401) — NERIX_API_KEY inválida ou inativa. ' +
          'Gere outra no painel e atualize o Environment do serviço.',
      );
      return {
        erro: 'sistema_indisponivel',
        instrucao:
          'A consulta está fora do ar por um problema NOSSO, não do cliente. ' +
          'NÃO diga que o e-mail ou o código dele está errado. Peça desculpa pela demora ' +
          'e passe para um atendente humano.',
      };
    }
    console.error(`[tools] falha em ${name}:`, err.response?.data || err.message);
    return { erro: 'falha_ao_consultar' };
  }
}

module.exports = { definitions, execute };
