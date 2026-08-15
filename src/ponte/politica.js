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

  texto = texto.replace(g(RE_URL), (url) => {
    flags.push(linkPermitido(url) ? 'link_fornecedor' : 'link_externo');
    return '[link do fornecedor]';
  });

  // Assuntos que exigem decisão comercial, não só tradução.
  if (/\b(pedido m[íi]nimo|atacado|dep[óo]sito|sinal|adiantamento|sem estoque|indispon[íi]vel|semanas?|feriado)\b/i.test(texto)) {
    flags.push('decisao_comercial');
  }

  return {
    texto: texto.trim(),
    flags,
    precisaRevisao: flags.includes('preco_cny') || flags.includes('decisao_comercial'),
  };
}

module.exports = { paraFornecedor, paraCliente };
