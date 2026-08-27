'use strict';

/**
 * Testa o reinício da tela — o caminho completo taobao.com → chat → conversa.
 *
 * Os três furos que este teste existe para não deixar voltar:
 *
 *  1. RECARGA QUE NÃO RECARREGA. goto() para a url do chat, estando nela, só
 *     muda o fragmento: a SPA troca de rota e a página continua a mesma. A
 *     recarga logava sucesso e a aba morta seguia morta.
 *  2. ABA NOVA ABANDONADA. O clique na home abre outra aba. Sem adotar a nova
 *     e fechar a velha, o braço opera uma casca enquanto o chat de verdade
 *     está noutra janela — "cliquei e não aconteceu nada".
 *  3. CONVERSA ABERTA NO MEIO DO HISTÓRICO. Abrir não é o mesmo que estar
 *     vendo a última mensagem, e é do fim da lista que sai a marca d'água.
 *
 * Não abre navegador: página e contexto são dublês.
 *
 *   node teste-tela.js
 */

const { Chat, NO_CHAT } = require('./src/chat');
const SEL = require('./seletores.json');

let falhas = 0;
const t = (nome, cond, extra = '') => {
  console.log((cond ? '  ok  ' : 'FALHA') + ' | ' + nome + (extra ? ' -> ' + extra : ''));
  if (!cond) falhas++;
};

const CHAT_URL = 'https://market.m.taobao.com/app/im/chat/index.html?#/';
const HOME_URL = 'https://www.taobao.com/';

/** Página dublê. Guarda o que foi pedido para o teste conferir depois. */
function paginaFalsa(url, { achaAtalho = true, viraChat = false } = {}) {
  const p = {
    _url: url,
    fechada: false,
    gotos: [],
    recargas: 0,
    url: () => p._url,
    goto: async (u) => { p.gotos.push(u); p._url = u; },
    reload: async () => { p.recargas++; },
    waitForTimeout: async () => {},
    waitForLoadState: async () => {},
    // Por padrão a home NÃO navega sozinha: quem leva ao chat é a aba nova.
    // Uma promessa que nunca resolve é o retrato fiel disso — e é o que prova
    // que a adoção da aba nova não depende da ordem em que as duas esperas da
    // corrida por acaso resolverem.
    waitForURL: async () => {
      if (!viraChat) return new Promise(() => {});
      p._url = CHAT_URL;
    },
    close: async () => { p.fechada = true; },
    frames: () => [],
    // Nenhum widget de verificação na tela.
    $: async () => null,
    // Casa pelo data-name, que é como o ícone de mensagens é encontrado de
    // verdade — ele é um <div> sem href.
    $$: async (sel) => (achaAtalho && sel.includes('webww2') ? [elementoFalso(p)] : []),
  };
  return p;
}

function elementoFalso(pagina) {
  return {
    cliques: 0,
    isVisible: async () => true,
    click: async function () { this.cliques++; pagina.clicado = true; },
  };
}

function chatFalso(pagina) {
  const c = Object.create(Chat.prototype);
  c.pagina = pagina;
  c.frame = null;
  return c;
}

// ── 1. Reconhecer a url do chat ───────────────────────────────
console.log('\n--- reconhecer a aba do chat pela url ---');

t('a url do chat é reconhecida', NO_CHAT.test(CHAT_URL));
t('a home não é o chat', !NO_CHAT.test(HOME_URL));
// A armadilha do /g: com a flag, .test() guarda lastIndex e alterna entre
// true e false na mesma string. Aqui isso faria a recarga escolher goto() em
// vez de reload() em uma volta sim, outra não.
t(
  'a resposta não alterna entre chamadas',
  NO_CHAT.test(CHAT_URL) && NO_CHAT.test(CHAT_URL) && NO_CHAT.test(CHAT_URL),
);

// ── 2. O alvo do clique na home ───────────────────────────────
//
// O ícone de mensagens da barra lateral (#tb-toolkit-new, 2º de cima para
// baixo) é um <div> com handler de JS, sem href. A 1ª versão mirava só em
// a[href*=...] — nenhum candidato casava, e o reinício virava um reload seco
// que nunca saía da mesma página. Estes dois testes existem para essa mira
// não voltar a ser só de link.
console.log('\n--- o que o braço procura na home ---');

const CAND = SEL.entradaDoChat.candidatos;
t('mira o data-name do ícone de mensagens primeiro', CAND[0].includes('webww2'), CAND[0]);
t(
  'há candidato que não depende de href',
  CAND.some((c) => !c.includes('href')),
);
// Posição é armadilha: logado a barra ganha item no topo e o "segundo ícone"
// deixa de ser o chat.
t('nenhum candidato mira por posição', !CAND.some((c) => /nth-child|nth-of-type/.test(c)));

// ── 3. Entrada pela home ──────────────────────────────────────
(async () => {
  console.log('\n--- entrada pela home, com aba nova ---');

  const home = paginaFalsa(HOME_URL);
  const nova = paginaFalsa(CHAT_URL);
  const contexto = { waitForEvent: async () => nova };
  const chat = chatFalso(home);

  const ok = await chat.entrarPelaHome(contexto, { homeUrl: HOME_URL });

  t('entrou pela home', ok === true);
  t('passou pela home antes', home.gotos[0] === HOME_URL, String(home.gotos[0]));
  t('clicou no atalho', home.clicado === true);
  t('adotou a aba nova', chat.pagina === nova);
  t('largou o iframe antigo', chat.frame === null);
  t('fechou a aba da home', home.fechada === true);
  t('não fechou a aba do chat', nova.fechada === false);

  console.log('\n--- entrada pela home, sem aba nova ---');

  // Link sem target=_blank: a própria aba navega. Não pode ficar pendurada
  // esperando uma aba que nunca vem.
  const mesmaAba = paginaFalsa(HOME_URL, { viraChat: true });
  const chatMesmaAba = chatFalso(mesmaAba);
  const okMesmaAba = await chatMesmaAba.entrarPelaHome(
    { waitForEvent: async () => new Promise(() => {}) },
    { homeUrl: HOME_URL },
  );

  t('entrou pelo chat na mesma aba', okMesmaAba === true);
  t('continua na mesma página', chatMesmaAba.pagina === mesmaAba);
  t('e não fechou a própria aba', mesmaAba.fechada === false);

  console.log('\n--- entrada pela home sem atalho na tela ---');

  const semAtalho = paginaFalsa(HOME_URL, { achaAtalho: false });
  const chat2 = chatFalso(semAtalho);
  const ok2 = await chat2.entrarPelaHome(
    { waitForEvent: async () => null },
    { homeUrl: HOME_URL, timeoutAtalho: 200 }, // curto: o teste não espera 8s por algo que não existe
  );

  t('devolve false em vez de lançar', ok2 === false);
  t('e não clica em nada', semAtalho.clicado !== true);
  // Quem entra pela url é o index.js. O que não pode é ficar preso na home.
  t('a home foi carregada mesmo assim', semAtalho.gotos[0] === HOME_URL);

  console.log('\n--- verificação na tela da home ---');

  const comBloqueio = paginaFalsa(HOME_URL);
  comBloqueio.$ = async (sel) => (sel === '.nc_wrapper' ? {} : null);
  const chat3 = chatFalso(comBloqueio);
  const ok3 = await chat3.entrarPelaHome(
    { waitForEvent: async () => null },
    { homeUrl: HOME_URL, timeoutAtalho: 200 }, // curto: o teste não espera 8s por algo que não existe
  );

  // Não lança: quem congela é o checarBloqueio() da conversa, um passo adiante.
  t('não clica com verificação na tela', ok3 === false && comBloqueio.clicado !== true);

  // ── 3. Abrir a conversa termina no fim da lista ──────────────
  console.log('\n--- abrir a conversa desce até a última mensagem ---');

  const desceu = { n: 0, depoisDoTitulo: false };
  let tituloConferido = false;

  const chat4 = chatFalso(paginaFalsa(CHAT_URL));
  chat4.prender = async () => {};
  chat4.checarBloqueio = async () => {};
  chat4._achar = async () => ({ el: elementoFalso(chat4.pagina) });
  chat4._clicar = async () => {};
  chat4.frame = {
    evaluate: async () => {
      tituloConferido = true;
      return 'conversa com 山王电玩 aberta';
    },
  };
  chat4._irParaOFim = async () => {
    desceu.n++;
    desceu.depoisDoTitulo = tituloConferido;
  };

  await chat4.abrirConversa('山王电玩');

  t('desceu a conversa uma vez', desceu.n === 1, `desceu ${desceu.n}x`);
  t('desceu DEPOIS de confirmar o fornecedor', desceu.depoisDoTitulo === true);

  console.log('\n--- conversa errada no topo ---');

  const desceu2 = { n: 0 };
  const chat5 = chatFalso(paginaFalsa(CHAT_URL));
  chat5.prender = async () => {};
  chat5.checarBloqueio = async () => {};
  chat5._achar = async () => ({ el: elementoFalso(chat5.pagina) });
  chat5._clicar = async () => {};
  chat5.frame = { evaluate: async () => 'outra loja qualquer' };
  chat5._irParaOFim = async () => { desceu2.n++; };

  let lancou = false;
  await chat5.abrirConversa('山王电玩').catch(() => { lancou = true; });

  t('para quando a loja do topo não é a nossa', lancou === true);
  // Descer numa conversa que vamos abandonar é rolagem à toa na tela de outro
  // fornecedor — atividade que ninguém pediu, na conversa errada.
  t('e não desce a conversa errada', desceu2.n === 0);

  // ── A caixa certa é a que CONTÉM mensagens ─────────────────
  //
  // `.rc-scrollbars-view` existe mais de uma vez nesta tela: a lista de
  // CONVERSAS, na lateral, também rola e também é rc-scrollbars. Pegar "o
  // primeiro que rola" pegava ela, e o braço rolava a lista de contatos
  // enquanto a conversa ficava parada — rolagem acontecendo, scrollTop
  // mudando, zero mensagem nova. Exatamente o que a exportação mostrou.
  //
  // Este teste roda a função de escolha DE VERDADE, com dois roláveis na tela.
  console.log('\n--- escolher entre duas caixas que rolam ---');

  // Reproduz a lógica do evaluate() do _rolarUmaTela: dado o DOM, qual caixa.
  // Fora do navegador não há getComputedStyle, então o dublê representa cada
  // caixa pelo que a escolha realmente usa: rola? contém mensagem?
  const escolher = (caixas, cands) => {
    for (const s of cands) {
      for (const c of caixas) {
        if (!c.seletores.includes(s)) continue;
        if (!c.rola) continue;
        if (!c.temMensagem) continue;
        return c;
      }
    }
    return null;
  };

  const LATERAL = { nome: 'conversas', seletores: ['.rc-scrollbars-view'], rola: true, temMensagem: false };
  const MENSAGENS = { nome: 'mensagens', seletores: ['.rc-scrollbars-view'], rola: true, temMensagem: true };
  const CANDS = SEL.listaRolavel.candidatos;

  // A lateral vem PRIMEIRO no DOM — é a ordem que causou o bug.
  const escolhida = escolher([LATERAL, MENSAGENS], CANDS);
  t('pula a lista de conversas', escolhida?.nome === 'mensagens', escolhida?.nome || 'nenhuma');

  // E continua funcionando quando só existe uma.
  t('acha quando só há a de mensagens', escolher([MENSAGENS], CANDS)?.nome === 'mensagens');
  t('não inventa caixa quando nenhuma tem mensagem', escolher([LATERAL], CANDS) === null);

  // O seletor tem que ser genérico o bastante para achar as duas — é a busca
  // que separa, não o seletor. Se o seletor já excluísse a lateral, o dia em
  // que a Taobao trocasse a classe voltaria a quebrar em silêncio.
  t(
    'o seletor conhecido está na lista',
    CANDS.includes('.rc-scrollbars-view'),
    CANDS[0],
  );

  // ── Histórico numa lista VIRTUALIZADA ──────────────────────
  //
  // O furo da primeira versão: o chat recicla os nós do DOM em vez de
  // acumular. Rolar não aumenta a contagem de balões — ela fica parada em ~20.
  // A versão que contava nós para saber se ainda vinha coisa nova via o número
  // não mudar e parava na segunda rolagem, sempre com o mesmo dia na mão.
  //
  // Este dublê é uma lista virtualizada de verdade: 100 mensagens no total,
  // mas só 20 visíveis por vez, e a janela anda conforme a rolagem.
  console.log('\n--- histórico numa lista que recicla os nós ---');

  const TOTAL = 100;
  const JANELA = 20;
  const todas = Array.from({ length: TOTAL }, (_, i) => ({
    id: `m${i}`,
    de: i % 3 === 0 ? 'nos' : 'coleta',
    quando: `2026-08-${String(1 + Math.floor(i / 5)).padStart(2, '0')} 10:00:0${i % 10}`,
    texto: `mensagem ${i}`,
  }));

  function chatVirtualizado({ alturaTela = 500 } = {}) {
    const c = chatFalso(paginaFalsa(CHAT_URL));
    c.prender = async () => {};
    c.checarBloqueio = async () => {};
    c._retratoDaLista = async () => {};
    c._rolarComRoda = async () => false;

    // Posição em "mensagens a partir do fim". 0 = fundo da lista.
    let offset = 0;
    c._rolarUmaTela = async () => {
      const maximo = TOTAL - JANELA;
      const noTopo = offset >= maximo;
      if (!noTopo) offset = Math.min(maximo, offset + JANELA / 2); // meia tela por vez
      return {
        ok: true,
        antes: noTopo ? 0 : alturaTela,
        depois: offset >= maximo ? 0 : alturaTela,
        altura: alturaTela,
        total: alturaTela * 5,
        baloes: JANELA,
        candidatas: 2, // a lateral de conversas também rola
        classe: 'rc-scrollbars-view',
      };
    };
    // SEMPRE 20 itens — é isto que a versão antiga interpretava como "acabou".
    c._coletarVisiveis = async () => {
      const fim = TOTAL - offset;
      return todas.slice(Math.max(0, fim - JANELA), fim);
    };
    return c;
  }

  const chatV = chatVirtualizado();
  const { mensagens: hist, rolagens: nRolagens } = await chatV.lerHistorico({ maxRolagens: 40 });

  t('acumula além da janela visível', hist.length === TOTAL, `${hist.length} de ${TOTAL}`);
  t('não para na segunda rolagem', hist.length > JANELA * 2, `${hist.length}`);
  t('traz os dois lados', hist.some((m) => m.de === 'nos') && hist.some((m) => m.de === 'coleta'));
  t('sem duplicata', new Set(hist.map((m) => m.id)).size === hist.length);

  // Ordem cronológica: as leituras vieram de trás para frente, então sem
  // ordenar a conversa sai em blocos invertidos e não dá para seguir o fio.
  const datas = hist.map((m) => m.quando);
  t(
    'em ordem cronológica',
    datas.every((d, i) => i === 0 || datas[i - 1] <= d),
    `${datas[0]} … ${datas[datas.length - 1]}`,
  );

  // ── No topo, quem destrava é o GESTO ───────────────────────
  //
  // O caso real: a área rolável tem ~900px e a tela 360px, então em três
  // rolagens o scrollTop chega a zero. Daí em diante escrever scrollTop=0 de
  // novo não é evento nenhum para o componente — ele já está lá — e o "carregar
  // mais" nunca dispara. Quem dispara é a pessoa continuar rolando contra o
  // topo, e isso é a roda do mouse.
  //
  // A roda antes só era tentada quando o scrollTop NÃO mexia. Aqui ele mexe
  // (vai a zero direitinho), então o gesto nunca era usado justamente onde é o
  // único que funciona. Foi assim que a exportação morreu em 20 mensagens,
  // três rodadas seguidas.
  console.log('\n--- no topo, a roda carrega o bloco anterior ---');

  const BLOCO = 10;
  let carregados = BLOCO; // o chat começa com um bloco na tela
  let rodadas = 0;

  const chatTopo = chatFalso(paginaFalsa(CHAT_URL));
  chatTopo.prender = async () => {};
  chatTopo.checarBloqueio = async () => {};
  chatTopo._retratoDaLista = async () => {};

  // scrollTop sempre chega a zero: a área rolável é curta, como no chat real.
  chatTopo._rolarUmaTela = async () => ({
    ok: true, antes: 360, depois: 0, altura: 360, total: 896,
    baloes: BLOCO, candidatas: 1, classe: 'rc-scrollbars-view',
  });

  // O bloco anterior só chega quando a RODA é usada — é o gesto que o
  // componente escuta.
  chatTopo._rolarComRoda = async () => {
    rodadas++;
    if (carregados < TOTAL) carregados = Math.min(TOTAL, carregados + BLOCO);
    return true;
  };
  chatTopo._coletarVisiveis = async () => todas.slice(0, carregados);

  const { mensagens: comRoda } = await chatTopo.lerHistorico({ maxRolagens: 40 });

  t('a roda foi usada no topo', rodadas > 0, `${rodadas} vez(es)`);
  t('e trouxe o histórico inteiro', comRoda.length === TOTAL, `${comRoda.length} de ${TOTAL}`);
  t('não parou no primeiro bloco', comRoda.length > BLOCO * 2, `${comRoda.length}`);

  console.log('\n--- topo de verdade: para de insistir ---');

  let rodadasVazias = 0;
  const chatFim = chatFalso(paginaFalsa(CHAT_URL));
  chatFim.prender = async () => {};
  chatFim.checarBloqueio = async () => {};
  chatFim._retratoDaLista = async () => {};
  chatFim._rolarUmaTela = async () => ({
    ok: true, antes: 0, depois: 0, altura: 360, total: 400,
    baloes: BLOCO, candidatas: 1, classe: 'rc-scrollbars-view',
  });
  chatFim._rolarComRoda = async () => { rodadasVazias++; return true; };
  chatFim._coletarVisiveis = async () => todas.slice(0, BLOCO); // nunca cresce

  await chatFim.lerHistorico({ maxRolagens: 40 });

  // Insistir para sempre contra um topo que acabou seria rolagem repetida no
  // chat de outra pessoa — o oposto da cadência que a pausa existe para manter.
  // O teto e 5 rolagens vazias seguidas (SECAS_ATE_DESISTIR). O que o teste
  // exige e que ele DESISTA, nao o numero exato — subir ou descer o teto e
  // ajuste de cadencia, nao regressao.
  t('desiste em vez de insistir para sempre', rodadasVazias <= 6, `${rodadasVazias} tentativa(s)`);
  console.log('\n--- histórico quando o chat não rola ---');

  const chatSemRolagem = chatVirtualizado();
  chatSemRolagem._rolarUmaTela = async () => ({ ok: false, motivo: 'sem container rolável' });
  const { mensagens: so20 } = await chatSemRolagem.lerHistorico({ maxRolagens: 40 });
  // Sem container não há o que fazer, mas o que estava na tela tem que voltar:
  // devolver vazio perderia a única coisa que dava para ler.
  t('devolve pelo menos o que estava visível', so20.length === JANELA, `${so20.length}`);

  console.log('\n--- histórico que chega ao fim sozinho ---');

  const chatCurto = chatVirtualizado();
  let voltas = 0;
  chatCurto._rolarUmaTela = async () => {
    voltas++;
    return { ok: true, antes: 0, depois: 0, altura: 500, total: 500, baloes: 20, candidatas: 1, classe: 'x' };
  };
  chatCurto._coletarVisiveis = async () => todas.slice(0, JANELA); // nunca muda
  await chatCurto.lerHistorico({ maxRolagens: 40 });
  // Topo + nada novo tem que parar rápido. Sem isso o braço rolaria 40 vezes
  // uma lista que acabou — 40 requisições à Taobao por nada.
  t('para cedo quando não vem mais nada', voltas <= 6, `${voltas} rolagem(ns)`);


  console.log('');
  if (falhas) {
    console.log(`${falhas} falha(s).`);
    process.exit(1);
  }
  console.log('todos passaram');
})();
