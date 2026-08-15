'use strict';

/**
 * Localiza o frame onde o chat realmente vive.
 *
 * A página `market.m.taobao.com/app/im/chat/index.html` é só a casca: barra de
 * navegação da Taobao e um <iframe> de 1440x838. Toda a UI do chat — lista de
 * conversas, balões, campo de digitação, botão 发送 — está dentro de
 * `chat-core/index.html`.
 *
 * Consequência prática: `page.evaluate()`, `page.click()` e `page.fill()` no
 * frame principal não enxergam nada do chat. Tudo tem que passar por aqui.
 *
 * Os dois frames são do mesmo domínio (market.m.taobao.com), então não há
 * barreira de origem cruzada — só é preciso pegar o handle certo.
 */

const MARCA = 'chat-core';

/**
 * Espera o iframe do chat aparecer e devolve o handle dele.
 * @param {import('playwright').Page} pagina
 * @param {number} timeoutMs
 * @returns {Promise<import('playwright').Frame>}
 */
async function doChat(pagina, timeoutMs = 30000) {
  const limite = Date.now() + timeoutMs;

  while (Date.now() < limite) {
    const f = pagina.frames().find((x) => x.url().includes(MARCA));
    // url() já preenchida não garante DOM pronto; confere que há corpo.
    if (f) {
      const pronto = await f.evaluate(() => Boolean(document.body && document.body.children.length))
        .catch(() => false);
      if (pronto) return f;
    }
    await pagina.waitForTimeout(500);
  }

  const urls = pagina.frames().map((f) => f.url());
  throw new Error(
    `Frame do chat ("${MARCA}") não apareceu em ${timeoutMs}ms.\n` +
      `Frames presentes:\n  ${urls.join('\n  ')}\n` +
      `Se a Taobao renomeou o iframe, ajuste a constante MARCA em src/frame.js.`,
  );
}

/** Lista os frames — útil para diagnosticar quando algo muda. */
function listar(pagina) {
  return pagina.frames().map((f) => ({ url: f.url(), nome: f.name() }));
}

module.exports = { doChat, listar, MARCA };
