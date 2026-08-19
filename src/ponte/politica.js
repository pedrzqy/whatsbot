'use strict';

/**
 * Política da ponte — o que impede o relay de queimar o negócio.
 *
 * Dois riscos concretos, em direções opostas:
 *
 *  1. SAINDO (cliente → fornecedor): dado pessoal do cliente e preço em BRL
 *     não podem chegar ao fornecedor.
 *  2. VOLTANDO (fornecedor → cliente): o preço de CUSTO em CNY não pode chegar
 *     ao cliente. Se chegar, ele calcula a margem da Phaze em dez segundos.
 *
 * Nada aqui é bloqueio silencioso: tudo vira flag e, quando grave, segura a
 * mensagem para um humano decidir.
 */

const cfg = require('./config');

// Sem flag /g: regex global guarda lastIndex entre chamadas e .test() alterna
// true/false na mesma entrada. Onde precisa de global, cria-se na hora do uso.
const RE_TELEFONE = /(?:\+?55\s?)?\(?\d{2}\)?\s?9?\d{4}[-.\s]?\d{4}/;
const RE_EMAIL = /[\w.+-]+@[\w-]+\.[\w.]+/;
const RE_CPF = /\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/;
const RE_CEP = /\b\d{5}-?\d{3}\b/;
const RE_BRL = /R\$\s?\d[\d.,]*/i;
const RE_CNY = /(?:¥|￥|CNY|RMB)\s?\d[\d.,]*|\d[\d.,]*\s?(?:元|块钱|块|人民币)/i;
const RE_URL = /https?:\/\/\S+/i;

const g = (re) => new RegExp(re.source, re.flags.includes('i') ? 'gi' : 'g');

/** Só link do próprio ecossistema Taobao é útil ao fornecedor; o resto é ruído ou risco. */
const DOMINIOS_OK = ['taobao.com', 'tmall.com', '1688.com', 'm.tb.cn'];

function linkPermitido(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return DOMINIOS_OK.some((d) => host === d || host.endsWith(`.${d}`));
  } catch {
    return false;
  }
}

/**
 * Cliente → fornecedor. Remove PII e sinal de revenda em BRL.
 * @returns {{texto:string, flags:string[], precisaRevisao:boolean}}
 */
function paraFornecedor(original) {
  let texto = String(original || '');
  const flags = [];

  if (RE_TELEFONE.test(texto)) { flags.push('telefone_cliente'); texto = texto.replace(g(RE_TELEFONE), '[contato removido]'); }
  if (RE_EMAIL.test(texto))    { flags.push('email_cliente');    texto = texto.replace(g(RE_EMAIL), '[email removido]'); }
  if (RE_CPF.test(texto))      { flags.push('cpf_cliente');      texto = texto.replace(g(RE_CPF), '[documento removido]'); }
  if (RE_CEP.test(texto))      { flags.push('endereco_cliente'); texto = texto.replace(g(RE_CEP), '[CEP removido]'); }

  // Preço em BRL entrega a margem ao fornecedor na hora.
  if (RE_BRL.test(texto))      { flags.push('preco_brl');        texto = texto.replace(g(RE_BRL), '[valor removido]'); }

  texto = texto.replace(g(RE_URL), (url) => {
    if (linkPermitido(url)) return url;
    flags.push('link_externo');
    return '[link removido]';
  });

  // Cliente tentando pular a Phaze e falar direto com a fábrica.
  const contatoDireto = /\b(whats|whatsapp|zap|wechat|weixin|telegram|meu n[úu]mero|me chama|instagram)\b/i.test(original);
  if (contatoDireto) flags.push('tentativa_contato_direto');

  return { texto: texto.trim(), flags, precisaRevisao: contatoDireto };
}

/**
 * Fornecedor → cliente. O ponto crítico: nunca deixar o custo em CNY vazar.
 * @returns {{texto:string, flags:string[], precisaRevisao:boolean}}
 */
function paraCliente(traduzido) {
  let texto = String(traduzido || '');
  const flags = [];

  if (RE_CNY.test(texto)) {
    flags.push('preco_cny');

    if (cfg.comercial.markup > 0) {
      // Converte custo → preço de venda e reescreve em BRL.
      texto = texto.replace(g(RE_CNY), (achado) => {
        const bruto = achado.replace(/[^\d.,]/g, '');
        // "1.234,56" (BR) vs "1,234.56" (US): a última pontuação manda.
        const normalizado = bruto.lastIndexOf(',') > bruto.lastIndexOf('.')
          ? bruto.replace(/\./g, '').replace(',', '.')
          : bruto.replace(/,/g, '');
        const n = Number(normalizado);
        if (!Number.isFinite(n) || n <= 0) return '[valor]';
        const brl = n * cfg.comercial.cnyBrl * cfg.comercial.markup;
        return `R$ ${brl.toFixed(2).replace('.', ',')}`;
      });
      flags.push('preco_convertido');
    } else {
      // markup=0 → nunca mostrar preço. Sempre passa pelo operador.
      texto = texto.replace(g(RE_CNY), '[valor — confirmar com a Phaze]');
    }
  }

  // O texto substituído VAI PARA O CLIENTE (pelo #enviar), então ele não pode
  // denunciar a origem. A flag continua dizendo tudo ao operador; só o que o
  // cliente lê fica neutro.
  texto = texto.replace(g(RE_URL), (url) => {
    flags.push(linkPermitido(url) ? 'link_fornecedor' : 'link_externo');
    return '[link removido]';
  });

  // Assuntos que exigem decisão comercial, não só tradução.
  if (/\b(pedido m[íi]nimo|atacado|dep[óo]sito|sinal|adiantamento|sem estoque|indispon[íi]vel|semanas?|feriado)\b/i.test(texto)) {
    flags.push('decisao_comercial');
  }

  // O que chega aqui já passou pelo tradutor. Se sobrou caractere chinês, a
  // tradução falhou naquele trecho — e mandar isso ao cliente entrega a origem
  // tão bem quanto escrever "fornecedor". Sai, e a flag avisa o operador.
  // temCJK() e não RE_CJK.test(): RE_CJK tem /g, e .test() com global guarda
  // lastIndex entre chamadas — alternaria true/false na mesma entrada. É a
  // armadilha que o comentário lá em cima já documenta para os outros regex.
  if (temCJK(texto)) {
    flags.push('sobrou_original');
    texto = texto.replace(RE_CJK, '').replace(/[ \t]{2,}/g, ' ');
  }

  return {
    texto: texto.trim(),
    flags,
    precisaRevisao:
      flags.includes('preco_cny') ||
      flags.includes('decisao_comercial') ||
      flags.includes('sobrou_original'),
  };
}

// ============================================================
// ERRO TÉCNICO NUNCA VIRA MENSAGEM DE WHATSAPP
// ============================================================

/**
 * Catálogo FECHADO de motivos. Nada aqui é montado com o texto do erro.
 *
 * É whitelist de propósito. A tentativa anterior era repassar `err.message` no
 * alerta, e um dia saiu isto pelo número comercial:
 *
 *   elementHandle.click: Timeout 30000ms exceeded.
 *   - retrying click action / waiting for element to be visible
 *
 * Ou seja: o log do Playwright inteiro num WhatsApp de loja. Blacklist não
 * resolve — a mensagem de erro é texto de terceiro, muda a cada versão da
 * biblioteca, e um padrão novo passa direto. Com catálogo fechado o pior caso
 * é um motivo genérico, nunca um vazamento.
 *
 * Nenhuma frase pode conter "fornecedor", "Taobao", "braço", "robô" ou "bot":
 * o alerta sai pelo MESMO número comercial que fala com o cliente.
 */
const MOTIVOS = [
  [/timeout|exceeded|timed out|esgotou/i, 'o passo passou do tempo e eu parei no meio'],
  [/not visible|not stable|not enabled|not attached|waiting for element|elementhandle|locator/i,
    'o campo não apareceu onde eu esperava'],
  // Antes de "seletor": a janela sobreposta é caso próprio e tem ação clara
  // para o operador — abrir a tela remota e fechar. Cair no genérico "a tela
  // mudou de lugar" mandaria ele procurar seletor quebrado, que não é o caso.
  [/janela aberta|overlay|intercepts pointer/i,
    'tem uma janela aberta na tela que eu não consegui fechar'],
  [/seletornaoencontrado|selector|não encontrei o seletor/i, 'a tela mudou de lugar'],
  [/bloqueiodetectado|verifica|安全验证|滑块/i, 'apareceu um pedido de verificação na tela'],
  [/net::|econnrefused|enotfound|etimedout|socket hang up|network|navigation/i,
    'a conexão caiu no meio'],
  [/upload|arquivo|file|imagem|image/i, 'a foto não subiu'],
];

const MOTIVO_PADRAO = 'não consegui concluir o passo';

/**
 * Erro cru → frase curta e segura para o WhatsApp.
 *
 * O detalhe técnico NÃO se perde: quem chama continua logando `err.message` no
 * console do servidor, que é onde ele serve para depurar. O que muda é que ele
 * para de viajar pelo WhatsApp.
 *
 * @param {unknown} erro  Error, string, o que vier.
 * @returns {string} frase do catálogo, sempre.
 */
function motivoNeutro(erro) {
  const cru = String((erro && erro.message) || erro || '');
  if (!cru.trim()) return MOTIVO_PADRAO;
  for (const [re, frase] of MOTIVOS) if (re.test(cru)) return frase;
  return MOTIVO_PADRAO;
}

// Última rede antes do sender. Cobre o texto que a gente mesmo escreve nos
// alertas — inclusive o que alguém venha a interpolar ali no futuro sem
// lembrar desta regra.
// Sufixo aberto em autom[aá]tic\w*: "automaticamente" escapava de
// autom[aá]tic[oa]s?, e foi essa palavra exata que chegou ao cliente.
const RE_AUTOMACAO = /\bbra[çc]o|rob[ôo]|\bbots?\b|autom[aá]tic\w*|automatiza\w*|taobao|fornecedor|playwright|chrome|selenium|puppeteer/gi;
// Cara de stack trace: "algo.algo:", "at Objeto.func", caminho de arquivo, ms.
const RE_TECNICO = /\b\w+\.\w+:\s|\bat\s+\w+[.:]|\/[\w./-]+\.js\b|\b\d+ms\b|\bTypeError\b|\bError:/g;

// Han, hiragana, katakana e o título de loja. Caractere chinês no número
// comercial entrega a origem exatamente como a palavra "fornecedor" — e não
// adianta para o operador, que decide lendo o português.
const RE_CJK = /[　-〿぀-ヿ㐀-䶿一-鿿豈-﫿＀-￯]+/g;

/**
 * Sobrou algum caractere chinês/japonês? Usado pelo teste e pela limpeza.
 */
function temCJK(texto) {
  return new RegExp(RE_CJK.source).test(String(texto || ''));
}

/**
 * Limpa QUALQUER texto que vá para o WhatsApp pelo canal de alerta.
 * @returns {{texto:string, limpou:boolean}}
 */
function limparAlerta(original) {
  const antes = String(original || '');

  // Truncar vem ANTES de substituir, e é o que de fato salva. Trocar palavra
  // por palavra num dump de log deixa passar o resto ("Timeout exceeded / Call
  // log: / attempting click action") — sem nome proibido nenhum, e ainda assim
  // inconfundivelmente saída de máquina numa conversa de loja. Do marcador em
  // diante não há nada que o operador precise ler no WhatsApp: está no log do
  // servidor inteiro.
  // O corte tem que pegar a PRIMEIRA linha técnica, não o "Call log:" lá
  // embaixo: a assinatura da falha ("elementHandle.click: Timeout 30000ms
  // exceeded") vem antes dele, e cortar só no marcador deixava justamente ela
  // passar. `\w+\.\w+:\s` exige espaço depois dos dois pontos para não comer
  // a URL do VNC, que aparece legitimamente nos alertas de bloqueio.
  let texto = antes;
  const corte = texto.search(
    /\n?\s*(?:Call log:|Stack:|at\s+\w+[.(]|\bwaiting for\b|\battempting\b|\w+\.\w+:\s|\bTimeout\b|\bexceeded\b|\bTypeError\b|\bError:)/i,
  );
  if (corte > 0) texto = texto.slice(0, corte);

  texto = texto
    .replace(RE_TECNICO, ' ')
    .replace(RE_AUTOMACAO, 'sistema')
    // Chinês some. Última rede: o texto do outro lado só deve sair daqui já
    // traduzido, e se sobrou caractere original é porque a tradução falhou em
    // algum caminho — melhor a linha ficar curta do que sair em chinês pelo
    // número comercial.
    .replace(RE_CJK, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return { texto, limpou: texto !== antes.trim() };
}

module.exports = { paraFornecedor, paraCliente, motivoNeutro, limparAlerta, temCJK };
