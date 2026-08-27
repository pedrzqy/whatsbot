'use strict';

/**
 * O que acontece DEPOIS da entrega.
 *
 * Duas varreduras, as duas de hora em hora, as duas penduradas no ciclo que o
 * vendas.js já roda:
 *
 *  1. CONFERIR — algumas horas depois de entregar a chave, perguntar se deu
 *     certo. O bot entregava e calava: se a chave não ativou, quem descobria
 *     era o cliente, sozinho, e a primeira notícia disso chegava como
 *     reclamação — quase sempre depois de ele já ter desistido.
 *
 *  2. REATIVAR — quem comprou, gostou e sumiu. Nasce DESLIGADO de propósito:
 *     é a única coisa aqui que fala com quem não puxou conversa, e mensagem em
 *     massa no número comercial é como se perde o número. Ver `reativar`.
 *
 * Nada aqui fala de madrugada: reusa a janela de silêncio do recovery.js, que
 * é a mesma regra e o mesmo horário.
 */

const config = require('./config');
const store = require('./store');
const sender = require('./sender');
const vendas = require('./vendas');
const recovery = require('./recovery');
const marca = require('./ponte/marca');
const chaves = require('./chaves');

const HORA = 3600_000;
const DIA = 24 * HORA;

// ============================================================
// 1 · Conferir a entrega
// ============================================================

/**
 * Quanto esperar antes de perguntar se deu certo.
 *
 * Três horas, e não trinta minutos: o cliente compra, abre o jogo quando dá, e
 * perguntar cedo demais só interrompe. Também não é um dia — se a chave não
 * funcionou, um dia é tempo de sobra para ele abrir reclamação em outro canal
 * ou simplesmente desistir da loja.
 */
const ESPERA_MS = Number(process.env.POSVENDA_ESPERA_HORAS || 3) * HORA;

/** Depois disto não pergunta mais: o pedido é velho e a pergunta soa estranha. */
const VALIDADE_MS = 3 * DIA;

/**
 * Uma pergunta aberta, e não "está tudo certo?".
 *
 * "Tudo certo?" convida a um "sim" automático de quem nem tentou ainda , e o
 * silêncio depois disso parece confirmação. "Conseguiu ativar" é específico o
 * bastante para quem travou responder na hora.
 */
function textoDaConferencia(nome) {
  const primeiro = vendas.primeiroNome(nome);
  return marca.assinar(
    `${primeiro ? `${primeiro}, t` : 'T'}udo certo com a ativação? 🎮\n\n` +
      `Se travou em alguma etapa, me conta aqui que eu resolvo com você.`,
  );
}

/**
 * Varre os pedidos entregues e pergunta como foi.
 *
 * @returns {Promise<number>} quantos foram perguntados
 */
async function conferirEntregas(agora = Date.now()) {
  if (!chaves.ligada('conferir')) return 0;
  if (recovery.isQuietHour(agora)) return 0;

  const pedidos = vendas._dados().pedidos || {};
  let feitos = 0;

  for (const [codigo, reg] of Object.entries(pedidos)) {
    if (!reg.entregue) continue;
    if (reg.conferido) continue;
    const idade = agora - reg.entregue;
    if (idade < ESPERA_MS) continue;

    // Velho demais: marca como conferido sem perguntar, senão ele fica sendo
    // reavaliado em toda varredura para sempre.
    if (idade > VALIDADE_MS) {
      vendas.marcar(codigo, 'conferido');
      continue;
    }

    // Cliente com atendente humano NÃO recebe: ele está no meio de um problema,
    // e "tudo certo com a ativação?" no meio disso é o bot atropelando a
    // conversa de quem está resolvendo.
    const numero = vendas.paraWhatsApp(reg.telefone);
    if (!numero) {
      vendas.marcar(codigo, 'conferido');
      continue;
    }
    if (store.getContact(numero)?.paused) {
      vendas.marcar(codigo, 'conferido');
      continue;
    }

    // Marca ANTES de enviar. Se o envio falhar, o pior caso é uma pergunta que
    // não foi feita; se marcasse depois, uma falha no meio faria a pergunta
    // sair de novo na varredura seguinte , e de novo, e de novo.
    if (!vendas.marcar(codigo, 'conferido')) continue;

    try {
      await sender.send(numero, textoDaConferencia(reg.nome));
      feitos += 1;
      console.log(`[posvenda] perguntei da ativação do pedido ${codigo}`);
    } catch (err) {
      console.error(`[posvenda] não perguntei do ${codigo}:`, err.message);
    }
  }

  return feitos;
}

// ============================================================
// 2 · Reativar quem sumiu
// ============================================================

/**
 * Nasce DESLIGADO, e a decisão é essa mesmo.
 *
 * É a única coisa do bot que fala com quem NÃO puxou conversa. Mensagem em
 * massa partindo de um número comercial é exatamente o padrão que faz o
 * WhatsApp derrubar o número , e derrubar o número custa o atendimento
 * inteiro, não só a campanha.
 *
 * Por isso, mesmo ligado, ele é conservador em quatro eixos ao mesmo tempo:
 *
 *  - só quem JÁ conversou com o bot (`engaged`). Quem comprou pelo site e
 *    nunca falou aqui não é reativado: para ele, isso é mensagem fria.
 *  - só uma vez por contato, com meses de intervalo.
 *  - teto baixo por dia, para nunca virar rajada.
 *  - nunca de madrugada, nunca em quem está com atendente.
 */
async function reativar(agora = Date.now()) {
  const cfg = config.posvenda;
  if (!chaves.ligada('reativar')) return 0;
  if (recovery.isQuietHour(agora)) return 0;

  const sumidoHa = cfg.reativarDias * DIA;
  const intervalo = cfg.reativarIntervaloDias * DIA;

  // `allContacts()` já devolve PARES [numero, contato] — envolver em
  // Object.entries daria pares de índice e par, e o laço rodaria sobre lixo.
  const candidatos = [];
  for (const [numero, c] of store.allContacts()) {
    if (!c || c.paused || !c.engaged) continue;
    if (!c.lastSeen || agora - c.lastSeen < sumidoHa) continue;
    if (c.reativadoEm && agora - c.reativadoEm < intervalo) continue;
    candidatos.push({ numero, contato: c });
  }

  // Os que sumiram há MAIS tempo primeiro? Não: os mais recentes.
  //
  // Quem sumiu há 40 dias ainda lembra da loja; quem sumiu há dois anos é
  // quase mensagem fria de novo. Com teto por dia, a ordem decide quem é
  // alcançado , e alcançar os mais quentes primeiro é o que faz diferença.
  candidatos.sort((a, b) => b.contato.lastSeen - a.contato.lastSeen);

  let feitos = 0;
  for (const { numero, contato } of candidatos.slice(0, cfg.reativarPorDia)) {
    // Marca antes de enviar, mesmo motivo da conferência.
    store.saveContact(numero, { reativadoEm: agora });
    try {
      await sender.send(numero, textoDeReativacao(contato.name));
      feitos += 1;
      console.log(`[posvenda] reativei ${numero}`);
    } catch (err) {
      console.error(`[posvenda] não reativei ${numero}:`, err.message);
    }
  }

  if (feitos) console.log(`[posvenda] ${feitos} reativação(ões) de ${candidatos.length} candidatos`);
  return feitos;
}

/**
 * Uma porta aberta, não um anúncio.
 *
 * Sem preço, sem "promoção imperdível", sem urgência inventada: quem sumiu há
 * dois meses não volta por causa de um desconto numa mensagem que não pediu, e
 * o texto de propaganda é o que faz a pessoa denunciar como spam , que é o
 * caminho mais rápido para o número cair.
 */
function textoDeReativacao(nome) {
  const primeiro = vendas.primeiroNome(nome);
  return marca.assinar(
    `${primeiro ? `Oi, ${primeiro}!` : 'Oi!'} Faz um tempo 😄\n\n` +
      `Chegou bastante coisa nova por aqui. Se quiser ver o que tem, é só me dizer ` +
      `o jogo ou o console que eu procuro pra você.`,
  );
}

// ============================================================
// Ciclo
// ============================================================

let timer = null;

function iniciar({ intervaloMs = HORA } = {}) {
  if (timer) return;
  if (!config.posvenda.conferirLigado && !config.posvenda.reativarLigado) {
    console.log('[posvenda] desligado');
    return;
  }
  timer = setInterval(() => {
    conferirEntregas().catch((err) => console.error('[posvenda] conferência:', err.message));
    reativar().catch((err) => console.error('[posvenda] reativação:', err.message));
  }, intervaloMs);
  // unref: não segura o processo no SIGTERM, igual ao ciclo do vendas.js.
  timer.unref();
  console.log(
    `[posvenda] ligado , conferir: ${config.posvenda.conferirLigado}, ` +
      `reativar: ${config.posvenda.reativarLigado}`,
  );
}

function parar() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = {
  iniciar,
  parar,
  conferirEntregas,
  reativar,
  textoDaConferencia,
  textoDeReativacao,
};
