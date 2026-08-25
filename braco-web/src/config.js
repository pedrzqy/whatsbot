'use strict';

require('dotenv').config();

const num = (v, padrao) => (Number.isFinite(Number(v)) ? Number(v) : padrao);

module.exports = {
  // URL do whatsbot. Precisa ser alcançável desta VPS.
  botUrl: (process.env.BOT_URL || 'http://localhost:3000').replace(/\/$/, ''),
  // A MESMA chave que está em PONTE_BRACO_KEY no .env do whatsbot.
  chave: process.env.PONTE_BRACO_KEY || '',

  // Chat web do Wangwang que funciona no Chrome. A conversa precisa JÁ existir
  // (criada pelo app/PC) — este endereço abre a lista, não cria conversa nova.
  chatUrl: process.env.TAOBAO_CHAT_URL || 'https://market.m.taobao.com/app/im/chat/index.html?#/',

  // Porta de entrada do reinício da tela. O braço vai PARA CÁ primeiro e só
  // então clica no atalho do chat — ver Chat.entrarPelaHome().
  //
  // Não é enfeite: a url do chat termina em `#/`, e goto() para uma url que só
  // difere no fragmento é navegação de MESMO DOCUMENTO. A SPA trocava de rota
  // e a página nunca recarregava, então a recarga não curava a aba morta que
  // ela existe para curar.
  homeUrl: process.env.TAOBAO_HOME_URL || 'https://www.taobao.com/',

  // UA do SEU Chrome real. Rode no console do seu navegador:
  //   navigator.userAgent
  // e cole aqui. Quanto mais perto do que a conta já viu, melhor.
  userAgent: process.env.CHROME_USER_AGENT || '',

  // Proxy residencial, se você contratar um. Vazio = sai pelo IP da VPS.
  // Formato: http://usuario:senha@host:porta
  proxy: process.env.PROXY_URL || '',

  // Quanto tempo esperar entre varreduras do chat, em segundos (sorteado).
  lerMinSeg: num(process.env.LER_MIN_SEG, 50),
  lerMaxSeg: num(process.env.LER_MAX_SEG, 110),

  // Teto local de envios por hora. O bot também limita; esta é a segunda trava.
  envioPorHora: num(process.env.ENVIO_POR_HORA, 10),

  // Pasta onde os prints de erro/captcha são gravados.
  prints: process.env.PRINTS_DIR || './prints',
};
