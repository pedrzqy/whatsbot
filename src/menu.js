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

/**
 * O mesmo menu como LISTA nativa do WhatsApp.
 *
 * O `rowId` é o número da opção, de propósito. Quando o cliente toca numa
 * linha, o WhatsApp devolve ora o id da linha, ora o título — depende da
 * versão do app e do caminho que a Evolution usa. Com o id sendo "3", os dois
 * casos caem no mesmo `resolve` de quem digitou 3 na mão, e não existe um
 * segundo mapa de opções para manter em dia.
 *
 * O rótulo perde o negrito e o emoji do começo: dentro da lista o WhatsApp não
 * formata, e os asteriscos apareceriam crus.
 */
function lista(nodeId, antes = '') {
  const node = NODES[nodeId];
  if (!node) return null;
  // O `antes` é a frase que acompanha o menu no caminho de texto ("não achei
  // essa opção", "voltamos de onde paramos"). Sem ela aqui, quem recebe a
  // lista perderia o contexto que quem recebe o texto tem.
  const chamada = variator.pick(node.title).replace(/ respondendo com o \*número\*| com o \*número\*/i, '');
  return {
    title: 'Phaze Games',
    description: antes ? `${antes}

${chamada}`.replace(/\*/g, '') : chamada.replace(/\*/g, ''),
    buttonText: 'Ver opções',
    footer: 'Você também pode digitar o número da opção.',
    rows: node.options.map((o, i) => ({
      rowId: String(i + 1),
      title: tituloDaLinha(o.label),
      description: '',
    })),
  };
}

/**
 * O rótulo como ele aparece DENTRO da lista.
 *
 * 24 caracteres é o limite do WhatsApp para o título de uma linha; o que passa
 * disso é cortado por ele. Cortamos aqui para o resolve() saber exatamente que
 * texto vai voltar — se o corte fosse só do lado do WhatsApp, a comparação
 * seria contra um texto que nunca existiu deste lado.
 */
const tituloDaLinha = (label) => String(label).replace(/\*/g, '').slice(0, 24).trim();

/**
 * Resolve a opção escolhida dentro de um nó.
 *
 * Aceita as TRÊS formas que a escolha pode chegar, e isso não é excesso de
 * zelo: quem digita manda "3"; quem toca numa linha da lista manda o rowId
 * (que também é "3"); e algumas versões entregam só o título da linha, sem o
 * id. Sem o casamento por título, o cliente tocaria no menu e o bot devolveria
 * o menu de novo — parecendo travado justamente para quem usou o caminho novo.
 */
const semAcento = (t) =>
  String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '');

/** Rótulo comparável: sem emoji, sem negrito, sem acento, minúsculo. */
const normalizar = (t) =>
  semAcento(t)
    .replace(/\*/g, '')
    .replace(/[^\p{L}\p{N} ]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

function resolve(nodeId, input) {
  const node = NODES[nodeId];
  if (!node) return null;

  const bruto = String(input ?? '').trim();

  const n = parseInt(bruto, 10);
  if (Number.isInteger(n) && n >= 1 && n <= node.options.length && /^\d+$/.test(bruto)) {
    return node.options[n - 1];
  }

  // Título da linha, comparado por IGUALDADE — nunca por prefixo.
  //
  // Prefixo parecia mais tolerante e era uma armadilha: "suporte" digitado
  // solto casaria com "Suporte Nintendo Switch" e mandaria o cliente para um
  // ramo que ele não escolheu. Texto livre tem que continuar caindo no
  // fallback, que devolve o menu.
  //
  // Duas formas contam como igual porque as duas chegam na prática: o título
  // cortado em 24 (o que a lista exibiu) e o rótulo inteiro.
  const alvo = normalizar(bruto);
  if (!alvo) return null;
  return (
    node.options.find(
      (o) => normalizar(tituloDaLinha(o.label)) === alvo || normalizar(o.label) === alvo,
    ) || null
  );
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

module.exports = { NODES, render, lista, resolve, resposta };
