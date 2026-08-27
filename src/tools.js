'use strict';

/**
 * Ferramentas (function calling) que a IA pode chamar para consultar a Nerix.
 *
 * Segurança:
 *  - NÃO existe ferramenta que liste todos os pedidos da loja (a chave é admin
 *    e isso vazaria dados de outros clientes).
 *  - O cliente chega ao PRÓPRIO pedido por dois caminhos, e cada um tem a sua
 *    prova de que o pedido é dele:
 *      meus_pedidos    → o número de WhatsApp de quem está falando. Vem do
 *                        `ctx`, nunca de argumento: o remetente é autenticado
 *                        pelo próprio WhatsApp e o modelo não tem como forjá-lo.
 *      consultar_pedido→ código + e-mail, validados pela API da Nerix. É o
 *                        caminho de quem comprou informando outro telefone.
 *  - Chaves/licenças (product_key) só aparecem depois de uma dessas duas provas.
 */

const nerix = require('./nerix');
const config = require('./config');
const store = require('./store');
const ponte = require('./ponte');

/**
 * vendas.js é carregado SOB DEMANDA, não no topo, para quebrar um ciclo:
 *   tools.js → vendas.js → tools.js
 * `vendas.js` importa `formatOrder` daqui. Com o require no topo, carregar
 * tools.js primeiro entregaria a vendas.js um `tools` ainda vazio e o
 * `formatOrder` de lá viraria undefined — quebrando o aviso de venda, que não
 * tem nada a ver com esta ferramenta. Mesma solução do carregarAi() no tradutor.
 */
const carregarVendas = () => require('./vendas');

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
      name: 'meus_pedidos',
      description:
        'Lista os pedidos do cliente com quem você está falando AGORA, pelo número de WhatsApp dele. ' +
        'Não pede nada: nem código, nem e-mail. É a PRIMEIRA coisa a usar em "cadê meu pedido", ' +
        '"não recebi o jogo", "meu Pix caiu?", "já aprovou?", "quero minha chave". ' +
        'Só use consultar_pedido se esta não achar nada — aí sim o cliente comprou de outro número ' +
        'e você precisa do código E do e-mail.',
      parameters: { type: 'object', properties: {}, required: [] },
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
      // menuNode e modoIA saem junto com o paused, igual ao handoff do menu
      // (handlers.js). Sem limpar, o cliente que volta com #inicio cai direto
      // na IA de novo — a mesma que ele acabou de pedir para trocar por gente.
      if (ctx.from) {
        store.saveContact(ctx.from, {
          paused: true,
          menuNode: null,
          modoIA: false,
          name: nome,
          ...(contato ? { pedidoContato: contato } : {}),
        });
      }
      console.log(`[handoff] ${ctx.from} -> atendente (${nome})${contato ? ` | contato: ${contato}` : ''} | motivo: ${args.motivo || '-'}`);

      // O alerta é o que faltava. Sem ele isto gravava `paused:true` e um
      // console.log: o bot ficava mudo, ninguém era chamado, e o cliente
      // esperava por um atendente que não sabia que existia um cliente.
      await ponte.alertarHandoff({ nome, from: ctx.from, motivo: args.motivo, contato });

      // O denominador de "quanto saiu do meu colo", com o MOTIVO junto: e a
      // lista do que ainda cai no operador, que e onde vale escrever resposta
      // pronta nova. Sem o motivo, o numero diz que ha trabalho sobrando e nao
      // diz de que tipo.
      require('./ponte/registro').anotar('ia_handoff', {
        motivo: String(args.motivo || '').replace(/\s+/g, ' ').trim().slice(0, 120) || null,
      });

      // A instrução muda com a hora. "Em instantes" às 3h da manhã é mentira: o
      // cliente fica acordado esperando alguém que só vê a mensagem às 9h, e o
      // modelo não tem como saber que horas são nem quando a loja abre.
      const exp = require('./expediente');
      const temGente = exp.aberto();
      return {
        transferido: true,
        atendente_disponivel_agora: temGente,
        instrucao: temGente
          ? 'Confirme ao cliente, de forma calorosa, que um atendente humano vai continuar o atendimento em instantes.'
          : `Confirme com calor que anotou tudo e diga que um atendente responde ${exp.quandoVolta()}. ` +
            'NÃO prometa retorno imediato nem diga "em instantes".',
      };
    }

    if (name === 'meus_pedidos') {
      // O telefone vem do ctx, NUNCA de args.
      //
      // É essa a diferença entre esta ferramenta e a consultar_pedido. O
      // remetente do WhatsApp é autenticado pelo próprio WhatsApp: o modelo não
      // tem como forjá-lo, e um cliente não tem como pedir o pedido de outro.
      // Aceitar um telefone por argumento devolveria exatamente o buraco que o
      // e-mail obrigatório existe para fechar — com a agravante de o argumento
      // poder ser alucinado.
      //
      // Por isso o schema não tem propriedade nenhuma: não há o que preencher.
      if (!ctx.from) return { erro: 'sem_telefone' };

      const pedidos = await carregarVendas().pedidosDoTelefone(ctx.from);
      if (!pedidos.length) {
        return {
          total: 0,
          instrucao:
            'Nenhum pedido neste número. Provavelmente ele comprou informando outro telefone. ' +
            'Peça o código do pedido E o e-mail da compra e use consultar_pedido.',
        };
      }

      // Os mais novos primeiro (pedidosDoTelefone já ordena). Três bastam:
      // quem pergunta "cadê meu pedido" quer o último, e a lista inteira de um
      // cliente antigo só gasta contexto e dá ao modelo mais chance de misturar
      // um pedido com outro na resposta.
      const out = pedidos.slice(0, 3).map(formatOrder);
      console.log(`[tools] ${ctx.from} tem ${pedidos.length} pedido(s) — devolvi ${out.length}`);
      return { total: pedidos.length, pedidos: out };
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

// formatOrder sai daqui para o vendas.js reusar o mapeamento de campos da
// Nerix. Ele foi descoberto na marra (product_key vem null em produto de
// conta, o Pix mora em payment.pix_qr_code) e ter duas leituras do mesmo
// payload seria garantir que uma delas ficaria para trás.
module.exports = { definitions, execute, formatOrder };
