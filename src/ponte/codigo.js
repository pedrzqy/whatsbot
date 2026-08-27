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
 * Mensagens que NÃO pedem decisão nenhuma.
 *
 * São 8% do que chega — e cada uma virava uma aprovação no WhatsApp do
 * operador, com tradução paga, esperando um #enviar ou #nao que não muda nada.
 *
 * Vem do estudo de 14 dias do chat: card de produto que a loja dispara sozinha,
 * pesquisa de satisfação automática, e o "ok" que fecha uma troca já resolvida.
 *
 * Checado ANTES de NAO_E_CODIGO de propósito: o card de produto carrega preço
 * (`¥8.00起`, `元`), então cairia em "problema" e viraria decisão — que é
 * exatamente o que ele não é.
 */
const RUIDO = [
  /为您推荐|亲，为您推荐/, // card de produto disparado pela loja
  /满意吗/, // "está satisfeito com o atendimento?" — pesquisa automática
  /^(好的?|是的?|可以|有|收到|嗯+)[。！!\s]*$/, // confirmação seca, sozinha
];

/**
 * Senha de conta: alfanumérico com letra E dígito, sozinho na mensagem.
 *
 * O `密码` do pacote é o que dá certeza; aqui, solto, é inferência — e ela tem
 * um limite conhecido: um LOGIN tem exatamente a mesma cara (`rrtt9255` é login,
 * `z23trzqx` é senha). O que separa os dois é quem escreveu, não o formato.
 *
 * Como só classificamos o que VEM dele, e login é o que NÓS mandamos, na
 * prática o alfanumérico que chega é senha. Mas por isso ela não é entregue
 * sozinha ao cliente — vai para o operador com o texto pronto (ver
 * ponte/index.js). Errar aqui custaria mandar um login no lugar de uma senha.
 */
const SENHA_SOLTA = /^\s*(?=[a-z0-9]{6,14}\s*$)(?=[a-z0-9]*[a-z])(?=[a-z0-9]*\d)([a-z0-9]+)\s*$/i;

/**
 * O pacote completo, o formato mais comum de entrega dele:
 *
 *   rrtt9321  密码  pdmtm5fk  耀西与不可思议的图鉴
 *   ↑ conta         ↑ senha   ↑ nome do jogo
 *
 * 密码 = "senha". É o marcador que torna isto inequívoco — sem inferência
 * nenhuma, diferente da senha solta acima.
 *
 * Uma mensagem pode trazer VÁRIOS pacotes (ele mandou 100 contas de uma vez em
 * 19/08), então a extração devolve lista.
 */
function extrairPacotes(texto) {
  const fora = [];
  // Conta e senha são alfanuméricos; o que vem depois, até a próxima conta ou o
  // fim, é o nome do jogo. `[^\s]` nos dois campos porque a Taobao separa com
  // tabulação, não espaço.
  const re = /([a-z0-9]{4,20})\s*密码\s*([a-z0-9]{4,20})\s*([^\n]*?)(?=[a-z0-9]{4,20}\s*密码|$)/gi;
  let m;
  while ((m = re.exec(texto)) !== null) {
    fora.push({
      conta: m[1],
      senha: m[2],
      jogo: (m[3] || '').trim(),
    });
  }
  return fora;
}

/**
 * @typedef {object} Classificacao
 * @property {'codigo'|'senha'|'pacote'|'ignorar'|'problema'} tipo
 * @property {string|null} codigo  o código, quando tipo==='codigo'
 * @property {string|null} senha   a senha, quando tipo==='senha'
 * @property {Array<{conta:string,senha:string,jogo:string}>} [pacotes]  quando tipo==='pacote'
 * @property {string} original
 */

/**
 * @param {string} texto  a mensagem crua do fornecedor
 * @returns {Classificacao}
 *
 * A ORDEM DOS TESTES É A REGRA. Cada passo só é alcançado porque o anterior
 * não casou, e trocar dois de lugar muda o resultado:
 *
 *  1. RUÍDO primeiro. O card de produto carrega `¥8.00起` e `元`, então se
 *     NAO_E_CODIGO viesse antes ele viraria "problema" — uma decisão para o
 *     operador sobre um anúncio que a loja disparou sozinha.
 *  2. NAO_E_CODIGO antes de tudo que extrai. É o que impede data, horário,
 *     preço e número de pedido de 19 dígitos de virarem código.
 *  3. Pacote antes de senha solta. O pacote CONTÉM uma senha; sem esta ordem,
 *     a linha inteira nunca casaria com nada e cairia em "problema".
 */
function classificar(texto) {
  const bruto = String(texto || '').trim();
  const base = { codigo: null, senha: null, original: bruto };

  if (RUIDO.some((re) => re.test(bruto))) {
    return { ...base, tipo: 'ignorar' };
  }

  const pacotes = extrairPacotes(bruto);
  if (pacotes.length) {
    return { ...base, tipo: 'pacote', pacotes };
  }

  if (NAO_E_CODIGO.some((re) => re.test(bruto))) {
    return { ...base, tipo: 'problema' };
  }

  const m = bruto.match(CODIGO_PURO);
  if (m) {
    return { ...base, tipo: 'codigo', codigo: m[1] };
  }

  const s = bruto.match(SENHA_SOLTA);
  if (s) {
    return { ...base, tipo: 'senha', senha: s[1] };
  }

  return { ...base, tipo: 'problema' };
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
