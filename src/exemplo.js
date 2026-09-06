'use strict';

/**
 * As imagens de exemplo que o bot manda junto com uma instrução.
 *
 * POR QUE EXISTE: "manda a foto da tela do console" é claro para quem já sabe
 * qual tela é, e ambíguo para todo o resto. O cliente manda a caixa do jogo, a
 * tela inicial, o menu de contas — e aí o pedido volta pela metade e alguém
 * cobra de novo. Uma foto da tela CERTA responde a pergunta antes de ela ser
 * feita, e não tem como ser mal interpretada.
 *
 * Lida do disco UMA VEZ e guardada em base64: o arquivo não muda em produção,
 * e reler a cada pedido seria I/O por nada. O `undefined` inicial é diferente
 * de `null`: `null` é "já tentei e não deu", e evita tentar de novo em toda
 * mensagem quando o arquivo não está lá.
 *
 * FALHA SEM DOER: sem o arquivo, devolve null e quem chama manda só o texto —
 * que é exatamente o que existia antes desta função. Uma instrução sem foto de
 * exemplo é pior que com, mas é muito melhor que nenhuma instrução.
 */

const fs = require('fs');
const path = require('path');

const PASTA = path.join(__dirname, '..', 'assets');

/** @type {Map<string, string|null>} */
const cache = new Map();

function carregar(arquivo) {
  if (cache.has(arquivo)) return cache.get(arquivo);
  let base64 = null;
  try {
    base64 = fs.readFileSync(path.join(PASTA, arquivo)).toString('base64');
  } catch (err) {
    console.warn(`[exemplo] não achei ${arquivo}: ${err.message}`);
  }
  cache.set(arquivo, base64);
  return base64;
}

/**
 * A tela de confirmação de e-mail do console, que é onde o código é digitado.
 *
 * É a foto que o cliente precisa mandar, e a que ele quase nunca manda de
 * primeira quando a instrução é só escrita.
 */
const telaDoConsole = () => carregar('tela-do-console.jpg');

module.exports = { telaDoConsole };
