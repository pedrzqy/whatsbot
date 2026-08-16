'use strict';

/**
 * A marca da Phaze nas mensagens do cliente.
 *
 * Existe como módulo próprio para a identidade não virar string solta
 * espalhada por recepcao/index/janela: mudar o nome, o emoji ou o formato tem
 * que ser um lugar só, senão metade das mensagens fica com a marca velha.
 *
 * ONDE APLICA — e onde NÃO:
 *
 *  - `abertura()` só na PRIMEIRA mensagem do atendimento. Cabeçalho repetido a
 *    cada resposta numa conversa de 5 mensagens vira ruído e empurra o que
 *    importa para baixo, justamente com o cliente lendo com pressa no meio de
 *    uma compra.
 *  - `assinar()` nas mensagens que fecham algo: o código entregue, a espera, a
 *    posição na fila.
 *  - Nas intermediárias curtas ("Foto recebida", "Não entendi o usuário") não
 *    vai nada. São passos da mesma conversa; marca ali só afasta a instrução
 *    do olho.
 *
 * NUNCA em alerta de operador. Ele lê no meio do atendimento e precisa do
 * dado, não da moldura — e é o mesmo número comercial, então cada linha a mais
 * é uma linha a mais para conferir.
 */

const NOME = 'PHAZE GAMES';
const EMOJI = '🎮';

const CABECALHO = `${EMOJI} *${NOME}*`;
const ASSINATURA = `_Phaze Games_ ${EMOJI}`;

/** Cabeçalho + texto. Só na mensagem que abre o atendimento. */
function abertura(texto) {
  return `${CABECALHO}\n\n${String(texto || '').trim()}`;
}

/** Texto + assinatura. Para as mensagens que fecham uma etapa. */
function assinar(texto) {
  return `${String(texto || '').trim()}\n\n${ASSINATURA}`;
}

module.exports = { abertura, assinar, NOME, EMOJI, CABECALHO, ASSINATURA };
