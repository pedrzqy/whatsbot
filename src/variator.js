'use strict';

/**
 * Variação de mensagens (anti-ban): evita enviar sempre o mesmo texto.
 *
 * Para mensagens FIXAS (boas-vindas, erros, handoff) usamos variação por
 * template — trocamos saudação, emojis e fechamento, mas mantemos as
 * palavras-chave do menu (catálogo/comprar/pedido/atendente) estáveis para o
 * bot continuar reconhecendo os comandos.
 *
 * As respostas conversacionais já são geradas pela IA (naturalmente únicas).
 */

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const chance = (p) => Math.random() < p;

// ─── Saudação (estilo atendimento) ───────────────────────────────────
const GREETINGS = ['Olá', 'Oi', 'Opa', 'Olá, tudo bem', 'Oi, tudo bom', 'E aí, tudo certo'];
const WAVE = ['👋', '😊', '🙌', '✨', ''];
const WELCOME_INTRO = [
  (loja) => `É um prazer te atender aqui na *${loja}*.`,
  (loja) => `Seja muito bem-vindo(a) à *${loja}*!`,
  (loja) => `Que bom te ver por aqui na *${loja}*.`,
  (loja) => `Bem-vindo(a) à *${loja}*, estou aqui pra te ajudar.`,
];
const INVITE = [
  'Pode me perguntar o que quiser — qual jogo você procura, preço, como funciona, status do seu pedido... eu te ajudo com tudo por aqui. 😊 O que você tá precisando?',
  'Me conta o que você tá procurando! Posso te ajudar com jogos e preços, como funciona a entrega, seu pedido e mais. É só perguntar. 🎮',
  'Manda sua pergunta que eu já te respondo: jogos, preços, como funciona, pagamento, seu pedido... o que precisar. 👍 O que você quer saber?',
  'Tô aqui pra te ajudar! Pergunta à vontade sobre qualquer jogo, preço, como funciona ou seu pedido. O que você procura? 😉',
];

/** Saudação personalizada que convida o cliente a perguntar (sem menu). */
function greeting(firstName, storeName) {
  const g = pick(GREETINGS);
  const wave = pick(WAVE);
  const nome = firstName ? ` ${firstName}` : '';
  const hi = `${g}${nome}!${wave ? ' ' + wave : ''}`;
  return `${hi} ${pick(WELCOME_INTRO)(storeName)}\n\n${pick(INVITE)}`;
}

// ─── Mensagens de erro / fallback ────────────────────────────────────
const ERROR = [
  'Tive um probleminha para responder agora 😕. Pode tentar de novo em instantes ou digitar *#inicio*.',
  'Ops, algo deu errado por aqui 🙈. Tenta mais uma vez, por favor — ou digite *#inicio*.',
  'Desculpe, não consegui processar agora 😔. Pode repetir? Se preferir, digite *#inicio*.',
];
function error() {
  return pick(ERROR);
}

// ─── Navegação / ações do menu ───────────────────────────────────────
const INVALID = [
  'Hmm, não encontrei essa opção. 🤔 Responde com o *número* de uma das opções, por favor.',
  'Ops, essa opção não existe. Escolhe um dos *números* da lista. 😉',
  'Não entendi essa opção. Digite o *número* correspondente ou *#inicio* para recomeçar.',
];
const HANDOFF = [
  'Beleza! Já vou chamar um atendente pra continuar seu atendimento. Aguarde só um pouquinho, por favor. 🧑‍💼\n\n(Digite *#inicio* para voltar ao autoatendimento.)',
  'Combinado! Um de nossos atendentes vai te responder em instantes. 🙌\n\n(Se quiser voltar ao autoatendimento, digite *#inicio*.)',
  'Perfeito, vou te transferir para um atendente humano. Só um momento! 😊\n\n(Digite *#inicio* para voltar ao autoatendimento.)',
];
const ASK_ORDER = [
  'Claro! Me passa o *número do pedido* (ex.: NX-1054) e o *e-mail* usado na compra que eu já verifico pra você. 🔎',
  'Sem problemas! Para consultar, preciso do *número do pedido* (NX-...) e do *e-mail* da compra. Pode mandar? 😊',
  'Boa! Me envia o *número do pedido* e o *e-mail* da compra que eu confiro o status na hora. 📦',
];
const ASK_PRODUCT = [
  'Show! Qual jogo você está procurando? Me diz o nome que eu vejo preço e disponibilidade pra você. 🎮 (A compra é finalizada no nosso site.)',
  'Boa! Me fala o nome do jogo que você quer que eu consulto o preço aqui. 😉 (As compras são feitas pelo site.)',
  'Perfeito! Qual título você quer? Manda o nome que eu pesquiso. 🕹️ (Depois é só finalizar no site.)',
];
const RESUMED = [
  'Prontinho, voltei pra te ajudar! 😊 O que você precisa?',
  'Voltamos ao atendimento automático! Pode perguntar o que quiser. 👍',
  'Tô de volta! Me conta como posso te ajudar. 🙂',
];

const invalidOption = () => pick(INVALID);
const handoff = () => pick(HANDOFF);
const askOrder = () => pick(ASK_ORDER);
const askProduct = () => pick(ASK_PRODUCT);
const resumed = () => pick(RESUMED);

module.exports = { pick, chance, greeting, error, invalidOption, handoff, askOrder, askProduct, resumed };
