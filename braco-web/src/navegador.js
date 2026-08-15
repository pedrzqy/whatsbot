'use strict';

/**
 * Navegador persistente para o chat web da Taobao.
 *
 * Três decisões que valem mais que qualquer truque de "stealth":
 *
 * 1. PERFIL PERSISTENTE (launchPersistentContext). Cookies, localStorage e os
 *    tokens de device da Taobao (umid, cna) sobrevivem entre execuções. Sem
 *    isso, todo restart pareceria um dispositivo novo — o gatilho mais direto
 *    de verificação numa conta estabelecida.
 *
 * 2. HEADFUL + Xvfb, nunca headless. Headless entrega uma classe inteira de
 *    sinais (UA HeadlessChrome, ausência de plugins, WebGL irreal) que nenhum
 *    patch de JS cobre bem. Rodar headful num display virtual custa ~200MB de
 *    RAM e elimina o problema na raiz.
 *
 * 3. FINGERPRINT ESTÁVEL. O erro comum é rotacionar UA/idioma achando que
 *    disfarça. Numa sessão logada faz o contrário: ambiente que muda sozinho
 *    entre visitas é anomalia. Aqui tudo é fixo e casa com o navegador real
 *    do operador (pt-BR, America/Sao_Paulo).
 *
 * O que isto NÃO resolve: reputação de IP e fingerprint de TLS. Numa VPS o
 * ASN continua sendo de datacenter — nenhum ajuste de browser muda isso.
 */

const path = require('path');
const { chromium } = require('playwright');
const cfg = require('./config');

const PERFIL = path.join(__dirname, '..', 'perfil-chrome');

/**
 * UA do Chrome desktop no Windows.
 *
 * Tem que bater com a VERSÃO REAL do Chrome que o Playwright vai abrir. UA
 * dizendo 131 com engine 151 é inconsistência gritante — o detector compara o
 * UA declarado com o comportamento do motor e a divergência é sinal forte de
 * automação. Por isso o padrão aqui acompanha o Chrome instalado na máquina;
 * se você tiver CHROME_USER_AGENT no .env, ele manda.
 */
const UA =
  cfg.userAgent ||
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36';

async function abrir({ visivel = false } = {}) {
  const contexto = await chromium.launchPersistentContext(PERFIL, {
    headless: false, // sempre headful; no servidor quem esconde é o Xvfb
    channel: 'chrome', // Chrome de verdade, não o Chromium do Playwright
    viewport: { width: 1440, height: 900 },
    userAgent: UA,
    locale: 'pt-BR',
    timezoneId: 'America/Sao_Paulo',
    // Aceita zh-CN também: é o que um brasileiro que compra na China teria.
    extraHTTPHeaders: { 'Accept-Language': 'pt-BR,pt;q=0.9,zh-CN;q=0.8,en;q=0.7' },
    args: [
      // Sem isto o Chrome anuncia que está sob automação já no handshake.
      '--disable-blink-features=AutomationControlled',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-features=IsolateOrigins,site-per-process',
    ],
    ignoreDefaultArgs: ['--enable-automation'],
    ...(cfg.proxy ? { proxy: { server: cfg.proxy } } : {}),
  });

  // Roda ANTES de qualquer script da página. Depois já é tarde: o script de
  // detecção da Taobao lê navigator.webdriver na primeira linha que executa.
  await contexto.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });

    // Chrome real expõe window.chrome; Playwright não.
    if (!window.chrome) {
      window.chrome = { runtime: {}, loadTimes: () => {}, csi: () => {} };
    }

    // navigator.plugins vazio é assinatura clássica de headless.
    if (navigator.plugins.length === 0) {
      Object.defineProperty(navigator, 'plugins', {
        get: () => [1, 2, 3, 4, 5].map(() => ({ name: 'PDF Viewer' })),
      });
    }

    Object.defineProperty(navigator, 'languages', {
      get: () => ['pt-BR', 'pt', 'zh-CN', 'en'],
    });

    // Permissions.query com 'notifications' devolve 'denied' em headless e
    // 'prompt' em Chrome real — checagem barata e muito usada.
    const query = window.navigator.permissions.query;
    window.navigator.permissions.query = (p) =>
      p.name === 'notifications'
        ? Promise.resolve({ state: Notification.permission })
        : query(p);
  });

  const pagina = contexto.pages()[0] || (await contexto.newPage());
  return { contexto, pagina };
}

module.exports = { abrir, PERFIL, UA };
