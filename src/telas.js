'use strict';

/**
 * As telas de erro que o cliente fotografa, e o que fazer em cada uma.
 *
 * São quatro, e juntas cobrem quase tudo que chega. Cada uma tem uma solução
 * conhecida, escrita por quem atende — não é o modelo que inventa o conserto,
 * ele só reconhece a tela e entrega o texto certo.
 *
 * O reconhecimento tem DOIS caminhos, e a ordem importa:
 *
 *  1. PELO TEXTO, determinístico. O cliente digita "erro 2819-0042" e a
 *     resposta sai na hora, sem token e sem chance de alucinação. É o mesmo
 *     argumento que mantém o pedido de código fora da IA.
 *  2. PELA FOTO, com o modelo. O cliente quase sempre manda o print sem
 *     escrever nada, e aí só quem enxerga resolve. O que o modelo faz é
 *     ESCOLHER uma destas telas — o texto da solução continua vindo daqui.
 *
 * Nada aqui pode citar a origem do produto. O cliente nunca sabe que existe
 * alguém do outro lado; para ele quem resolve é a Phaze.
 */

/**
 * @typedef {object} Tela
 * @property {string} id
 * @property {string} oQueE          para o operador e para o modelo entenderem
 * @property {RegExp[]} sinais       o que identifica a tela num texto
 * @property {string} resposta       o que o CLIENTE lê. Já pronto.
 * @property {'nenhuma'|'codigo'|'operador'} depois  o que acontece em seguida
 * @property {string} [seInsistir]   quando a solução já foi tentada e não valeu
 */

/** @type {Tela[]} */
const TELAS = [
  {
    id: 'jogo_em_outro_console',
    oQueE:
      'Erro 2819-0042. O console diz que o jogo está sendo usado em outro ' +
      'aparelho ao mesmo tempo, e suspende a partida.',
    // Casa se QUALQUER destes conjuntos estiver todo presente no texto.
    sinais: [
      [/2819[\s-]?0042/],
      [/outro console/, /(jogo|cartao|game)/],
      [/cartao de jogo virtual/],
    ],
    // Entrar PRIMEIRO e só então cortar a rede: o console checa a licença ao
    // abrir. Cortando antes, ele nem deixa entrar.
    resposta:
      'Isso resolve rápido 👍\n\n' +
      '1. Abre o jogo normalmente\n' +
      // UM asterisco. Dois é markdown e aparece cru na tela do cliente — o
      // próprio prompt do bot avisa isso, e eu errei aqui na primeira escrita.
      '2. *Assim que ele abrir*, liga o *modo avião* do console\n' +
      '3. Pode jogar tranquilo\n\n' +
      'A ordem importa: tem que ser depois de entrar no jogo, não antes.',
    depois: 'nenhuma',
  },

  {
    id: 'sessao_expirada',
    oQueE: 'A conta pede para iniciar a sessão de novo. É só relogar.',
    // "sessao" sozinho e ambiguo; junto de "nintendo", "conta" ou "de novo"
    // vira inequivoco. Cobre "inicie a sessao novamente", "inicie nova
    // sessao", "pede pra logar de novo" e o que mais a pessoa inventar.
    sinais: [
      [/(sessao|session)/, /(nintendo|conta|novamente|nova|de novo|outra vez)/],
      [/(logar|login|entrar)/, /(de novo|novamente|outra vez)/, /(conta|nintendo)/],
    ],
    resposta:
      'É só entrar de novo com a *senha da conta* que você recebeu 👍\n\n' +
      'Depois disso volta ao normal.',
    depois: 'nenhuma',
  },

  {
    id: 'software_indisponivel',
    oQueE:
      'Software não pode ser usado agora. Na prática é o servidor da Nintendo ' +
      'reiniciando; volta sozinho.',
    sinais: [
      [/software/, /(nao pode ser usado|nao posso usar|indisponivel|bloqueado)/],
      [/vinculada a outro console/],
      [/conecte o outro console/],
    ],
    // Prazo REAL, e não "já já": duas horas é o que costuma levar, e um prazo
    // curto demais faz ele voltar irritado antes de o problema ter chance de
    // se resolver sozinho.
    resposta:
      'Esse é do lado da Nintendo: os servidores estão reiniciando 🔧\n\n' +
      'Costuma voltar sozinho em até *2 horas*. Tenta de novo depois desse ' +
      'tempo que deve estar funcionando 👍',
    depois: 'nenhuma',
    // Se já passou dias, aí não é mais o servidor. Vai para quem resolve, com
    // o usuário do perfil — que é o dado que a ponte precisa.
    seInsistir:
      'Se já está assim há mais de um dia, me manda o *usuário do perfil* que ' +
      'eu resolvo isso pra você.',
  },

  {
    id: 'pediu_codigo',
    oQueE:
      'A tela pede o código de confirmação enviado por e-mail. É o fluxo do ' +
      'código de verificação.',
    sinais: [
      [/codigo de confirmacao/],
      [/confirmacao do endereco de e-?mail/],
      [/codigo/, /(enviado|chegou) (por|no) e-?mail/],
    ],
    // Não responde nada aqui: quem conduz é a recepção da ponte, que já pede
    // foto e usuário no passo certo. Duas mensagens diferentes sobre a mesma
    // coisa confundiriam mais do que ajudariam.
    resposta: null,
    depois: 'codigo',
  },
];

/**
 * Reconhece a tela pelo TEXTO que o cliente escreveu.
 *
 * Determinístico de propósito: "erro 2819-0042" é estereotipado, e resposta
 * fixa não custa token, não alucina e funciona com o modelo fora do ar.
 *
 * @returns {Tela|null}
 */
/**
 * Sem acento, sem pontuacao, minusculo, espaco unico.
 *
 * O cliente digita no celular, com pressa, e quase nunca copia a tela: escreve
 * "sessao" sem til, "nao" sem circunflexo, e erra o espaco. Comparar contra o
 * texto cru so reconheceria quem copiasse e colasse -- que e justamente quem
 * nao precisa de ajuda.
 */
const normalizar = (t) =>
  String(t || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s-]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

function porTexto(texto) {
  const alvo = normalizar(texto);
  if (!alvo) return null;

  // Cada `sinal` e um CONJUNTO de padroes que precisam estar todos presentes,
  // em qualquer ordem. Era uma frase inteira, exata, e por isso so reconhecia
  // quem colasse a tela: "inicie nova sessao com sua conta nintendo" nao casava
  // com /inicie a sessao novamente/, porque a pessoa trocou duas palavras de
  // lugar. Exigir palavras, e nao a frase, e o que sobrevive ao jeito de gente
  // escrever.
  return (
    TELAS.find((t) => t.sinais.some((conjunto) => conjunto.every((re) => re.test(alvo)))) || null
  );
}

const porId = (id) => TELAS.find((t) => t.id === id) || null;

/**
 * O trecho que entra no prompt, para o modelo reconhecer a tela na FOTO.
 *
 * Ele recebe a descrição e o texto pronto: o conserto não é gerado, é
 * escolhido. Um modelo inventando solução de console manda o cliente mexer em
 * configuração que não existe, e isso volta como reclamação.
 */
function paraOPrompt() {
  const linhas = TELAS.filter((t) => t.resposta).map(
    (t) => `- ${t.oQueE}\n  RESPONDA: "${t.resposta.replace(/\n+/g, ' ')}"${
      t.seInsistir ? `\n  SE ELE DISSER QUE JÁ FAZ DIAS: "${t.seInsistir}"` : ''
    }`,
  );

  const pedeCodigo = TELAS.find((t) => t.depois === 'codigo');

  return (
    'TELAS DE ERRO QUE O CLIENTE FOTOGRAFA. Você conhece estas, e a resposta ' +
    'de cada uma já está pronta. Use o texto indicado, com as suas palavras, ' +
    'mas SEM mudar o passo a passo nem inventar solução nova:\n' +
    linhas.join('\n') +
    (pedeCodigo
      ? `\n- ${pedeCodigo.oQueE}\n  Aí NÃO é problema: peça o USUÁRIO da conta e use pedir_codigo_fornecedor.`
      : '') +
    '\nSe a foto for de uma tela que não está nesta lista, NÃO invente conserto: ' +
    'diga o que está vendo e chame um atendente.'
  );
}

module.exports = { TELAS, porTexto, porId, paraOPrompt };
