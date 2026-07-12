'use strict';

/**
 * Menu numerado (estilo atendimento). A ESTRUTURA e os números são fixos
 * (para o cliente navegar de forma confiável); apenas o texto de moldura
 * (título/rodapé) varia. As RESPOSTAS dos tópicos são geradas pela IA de
 * forma humanizada e diferente a cada vez (ver handlers + knowledge).
 */

const variator = require('./variator');

const NODES = {
  main: {
    title: [
      'Selecione a opção desejada respondendo com o *número*:',
      'Me diz em que posso ajudar — responda com o *número* da opção:',
      'Como posso te ajudar hoje? Responda com o *número*:',
      'Escolha uma opção abaixo (é só responder com o *número*):',
    ],
    options: [
      { label: '🤔 Tenho dúvidas sobre os jogos', goto: 'duvidas' },
      { label: '🎮 Suporte PlayStation', topic: 'plataforma_playstation' },
      { label: '🕹️ Suporte Nintendo Switch', topic: 'plataforma_nintendo' },
      { label: '💨 Suporte Steam', topic: 'plataforma_steam' },
      { label: '💰 Financeiro / meu pedido', action: 'pedido' },
      { label: '🛒 Ver jogos / comprar', action: 'comprar' },
      { label: '🧑‍💼 Falar com um atendente', action: 'atendente' },
    ],
  },
  duvidas: {
    title: [
      'Escolha uma das dúvidas abaixo (responda com o *número*):',
      'Sobre o que você quer saber? Responda com o *número*:',
      'Selecione sua dúvida respondendo com o *número*:',
    ],
    options: [
      { label: 'Qual é o prazo de envio?', topic: 'prazo_envio' },
      { label: 'Como funcionam os jogos de *Nintendo Switch*?', topic: 'plataforma_nintendo' },
      { label: 'Como funcionam os jogos de *PlayStation*?', topic: 'plataforma_playstation' },
      { label: 'Como funcionam os jogos de *Steam*?', topic: 'plataforma_steam' },
      { label: 'Qual é o prazo de garantia?', topic: 'garantia' },
      { label: 'Quais são as formas de pagamento?', topic: 'pagamento' },
      { label: 'Posso trocar ou devolver o jogo?', topic: 'troca' },
      { label: 'O que *NÃO* pode ser feito?', topic: 'restricoes' },
      { label: 'Outras dúvidas — falar com atendente', action: 'atendente' },
    ],
  },
};

const FOOTERS = [
  'Ou digite *#inicio* para voltar ao menu principal.',
  'Digite *#inicio* a qualquer momento para recomeçar.',
  'Se preferir, é só escrever sua dúvida que eu te respondo. 😉',
];

/** Renderiza o menu de um nó (título variado + opções numeradas + rodapé). */
function render(nodeId) {
  const node = NODES[nodeId];
  if (!node) return null;
  const title = variator.pick(node.title);
  const lines = node.options.map((o, i) => `*${i + 1}.* ${o.label}`);
  const footer = variator.pick(FOOTERS);
  return `${title}\n\n${lines.join('\n')}\n\n${footer}`;
}

/** Resolve a opção escolhida (por número) dentro de um nó. */
function resolve(nodeId, input) {
  const node = NODES[nodeId];
  if (!node) return null;
  const n = parseInt(String(input).trim(), 10);
  if (!Number.isInteger(n) || n < 1 || n > node.options.length) return null;
  return node.options[n - 1];
}

module.exports = { NODES, render, resolve };
