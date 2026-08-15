'use strict';

/**
 * Classificação da resposta do fornecedor.
 *
 * O relay tem exatamente dois desfechos possíveis:
 *
 *   CÓDIGO  — 4 a 8 dígitos, nada mais. Vai direto ao cliente, sem tradução.
 *   PROBLEMA— qualquer outra coisa (quase sempre chinês). Traduz e chama humano.
 *
 * Ser restritivo aqui é o ponto. Um falso positivo entrega ao cliente um número
 * que não é o código dele — número de pedido, quantidade, preço, horário — e ele
 * tenta usar num login de conta de terceiro. Preferimos segurar para revisão a
 * chutar.
 */

/** Código puro: só dígitos, 4 a 8, sem mais nada na mensagem. */
const CODIGO_PURO = /^\s*(\d{4,8})\s*$/;

/**
 * Padrões que PARECEM código mas não são. Checados antes do match para não
 * deixar passar número solto que veio de outro contexto.
 */
const NAO_E_CODIGO = [
  /\d{4}[-/年]\d{1,2}[-/月]\d{1,2}/, // data: 2026-08-14, 2026年8月14
  /\d{1,2}:\d{2}/, // horário: 19:39
  /[¥￥$]/, // valor monetário
  /\d{10,}/, // número de pedido (o do print tem 19 dígitos)
  /元|块|钱/, // moeda em chinês
];

/**
 * @typedef {object} Classificacao
 * @property {'codigo'|'problema'} tipo
 * @property {string|null} codigo  o código, quando tipo==='codigo'
 * @property {string} original
 */

/**
 * @param {string} texto  a mensagem crua do fornecedor
 * @returns {Classificacao}
 */
function classificar(texto) {
  const bruto = String(texto || '').trim();

  if (NAO_E_CODIGO.some((re) => re.test(bruto))) {
    return { tipo: 'problema', codigo: null, original: bruto };
  }

  const m = bruto.match(CODIGO_PURO);
  if (m) {
    return { tipo: 'codigo', codigo: m[1], original: bruto };
  }

  return { tipo: 'problema', codigo: null, original: bruto };
}

/**
 * Valida o usuário que o cliente mandou, antes de repassar ao fornecedor.
 *
 * Mandar lixo para o fornecedor gasta a cota de envios, ocupa a fila serial e
 * ainda irrita o parceiro. Barrar aqui é mais barato que barrar lá.
 *
 * @returns {{valido:boolean, usuario:string|null, motivo:string|null}}
 */
function validarUsuario(texto) {
  const bruto = String(texto || '').trim();

  if (!bruto) {
    return { valido: false, usuario: null, motivo: 'vazio' };
  }
  if (bruto.length > 20) {
    return { valido: false, usuario: null, motivo: 'passa de 20 caracteres' };
  }
  // Usuário é alfanumérico. Espaço, @ ou acento indica que o cliente mandou
  // uma frase ("meu usuario e joao123") em vez do usuário puro.
  if (!/^[A-Za-z0-9._-]+$/.test(bruto)) {
    return { valido: false, usuario: null, motivo: 'tem caractere que não é de usuário' };
  }
  // Só dígitos e curto demais provavelmente é o cliente mandando o código de
  // volta por engano, não o usuário dele.
  if (/^\d{1,8}$/.test(bruto)) {
    return { valido: false, usuario: null, motivo: 'parece um código, não um usuário' };
  }

  return { valido: true, usuario: bruto, motivo: null };
}

/**
 * Tenta extrair o usuário de uma frase solta do cliente.
 * Ex.: "meu usuario e rrrtsr223" -> "rrrtsr223"
 *
 * Aqui o critério é MAIS ESTRITO que em validarUsuario, e de propósito: são
 * trabalhos diferentes. validarUsuario julga algo que o cliente informou como
 * sendo o usuário — pode ser permissivo. Esta função ADIVINHA qual palavra da
 * frase é o usuário, e com o critério permissivo "meu", "usuario" e "e" também
 * passariam, deixando tudo ambíguo.
 *
 * O filtro extra: precisa misturar letra E dígito. É o formato desses usuários
 * (rrrtsr223, ffgg2093) e descarta palavra comum de imediato.
 *
 * Devolve null quando há ambiguidade — melhor perguntar que adivinhar.
 */
function extrairUsuario(frase) {
  const palavras = String(frase || '')
    .split(/[\s,;:]+/)
    .map((p) => p.replace(/[.!?]+$/, ''))
    .filter(Boolean);

  const candidatos = palavras.filter(
    (p) => validarUsuario(p).valido && /[A-Za-z]/.test(p) && /\d/.test(p),
  );

  // Zero candidatos: não dá para adivinhar. Dois ou mais: ambíguo, também não.
  return candidatos.length === 1 ? candidatos[0] : null;
}

module.exports = { classificar, validarUsuario, extrairUsuario, CODIGO_PURO };
