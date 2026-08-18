'use strict';

/**
 * Menu numerado (estilo atendimento). A ESTRUTURA e os números são fixos,
 * para o cliente navegar de forma confiável; só o texto de moldura varia.
 *
 * AS RESPOSTAS SÃO PRONTAS, NÃO GERADAS.
 *
 * Antes a ideia era a IA reescrever cada tópico "de forma humanizada". Na
 * prática isso custava uma chamada de LLM para responder "qual é o prazo de
 * envio", cuja resposta é a MESMA todo dia — segundos de espera, tokens
 * gastos, e a chance de o modelo inventar prazo ou garantia que a loja não
 * pratica. Fato de loja não se improvisa.
 *
 * A IA fica para UM ramo: problema com a compra. Ali cada caso é diferente,
 * o cliente escreve livre, e vale ter alguém que entende a frase.
 */

const variator = require('./variator');
const knowledge = require('./knowledge');

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
      { label: '🕹️ Suporte Nintendo Switch', topic: 'plataforma_nintendo' },
      { label: '💨 Suporte Steam', topic: 'plataforma_steam' },
      { label: '🎯 Pedir um jogo que não achei', action: 'pedirjogo' },
      { label: '🔑 Preciso de um código de segurança', action: 'codigo' },
      { label: '💰 Meu pedido / financeiro', action: 'pedido' },
      // O ÚNICO ramo que acorda a IA. Aqui o cliente escreve livre, cada caso
      // é diferente, e não há resposta pronta que sirva.
      { label: '🛠️ Problema com a compra', action: 'ia' },
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

/**
 * Resposta PRONTA de um tópico. Sem IA, sem espera, sem token.
 *
 * O fato vem do knowledge.js e sai como está — só a moldura varia, para duas
 * pessoas na fila não receberem texto idêntico. O que a loja pratica (prazo,
 * garantia, o que não pode) é fato, e fato não se reescreve a cada envio: era
 * por aí que entrava a chance do modelo prometer garantia que não existe.
 */
const FECHOS = [
  'Posso ajudar em mais alguma coisa? Digite *#inicio* para ver as opções.',
  'Qualquer outra dúvida é só chamar. *#inicio* volta ao menu.',
  'Se precisar de mais alguma coisa, digite *#inicio*.',
];

function resposta(topic) {
  const fato = knowledge[topic];
  if (!fato) return null;
  return `${fato}\n\n_${variator.pick(FECHOS)}_`;
}

module.exports = { NODES, render, resolve, resposta };
