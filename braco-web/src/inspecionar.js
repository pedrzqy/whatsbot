'use strict';

/**
 * Descobridor de seletores.
 *
 * Abre o Chrome no perfil do braço, espera você chegar na conversa do
 * fornecedor, e despeja tudo que eu preciso para preencher o seletores.json:
 * o HTML da região do chat e uma lista de candidatos já ranqueados.
 *
 *   npm run inspecionar
 *
 * Não envia mensagem, não clica em nada. Só lê.
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { abrir } = require('./navegador');
const frameHelper = require('./frame');
const cfg = require('./config');

const SAIDA = path.join(__dirname, '..', 'inspecao');

function esperarEnter(msg) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((r) => rl.question(msg, () => { rl.close(); r(); }));
}

(async () => {
  fs.mkdirSync(SAIDA, { recursive: true });

  const { contexto, pagina } = await abrir({ visivel: true });
  await pagina.goto(cfg.chatUrl, { waitUntil: 'domcontentloaded' });

  console.log('\n=================================================');
  console.log(' 1. Se pedir login, escaneie o QR com o iPhone.');
  console.log(' 2. Abra a conversa do fornecedor (山王电玩).');
  console.log(' 3. Volte aqui e aperte ENTER.');
  console.log('=================================================\n');
  await esperarEnter('Pronto? ENTER para inspecionar... ');

  // ── Atalho do chat na home ────────────────────────────────────
  //
  // É por onde o reinício da tela passa: taobao.com → clique → chat (ver
  // Chat.entrarPelaHome). O seletor mora em "entradaDoChat" no seletores.json
  // e é o ÚNICO que não vive dentro do iframe.
  //
  // Numa ABA NOVA de propósito: a aba do chat fica como está, para o resto da
  // inspeção continuar valendo. E só DEPOIS do ENTER, porque deslogado a home
  // não mostra atalho nenhum.
  const abaHome = await contexto.newPage();
  let links = [];
  try {
    await abaHome.goto(cfg.homeUrl, { waitUntil: 'domcontentloaded' });
    await abaHome.waitForTimeout(3000);
    links = await abaHome.evaluate(() => {
      // NÃO filtra por <a>. O ícone de mensagens da barra lateral é um <div>
      // com handler de JS — procurar só por link foi o que fez a primeira
      // versão não achar nada e cair no reload seco.
      const alvos = [
        ...document.querySelectorAll(
          '#tb-toolkit-new *, [class*="toolkit-item"], [data-name], [data-label], a',
        ),
      ];
      const vistos = new Set();
      return alvos
        .filter((el) => {
          const marca = `${el.getAttribute('data-name') || ''} ${el.getAttribute('data-label') || ''} ${el.href || ''} ${el.className}`;
          return /im\/chat|chat\/index|wangwang|amos|webww|im-entry|消息|旺旺/.test(marca);
        })
        .map((el) => {
          const r = el.getBoundingClientRect();
          return {
            tag: el.tagName.toLowerCase(),
            href: el.href || null,
            nome: el.getAttribute('data-name') || null,
            rotulo: el.getAttribute('data-label') || null,
            classes: (el.className || '').toString().trim().split(/\s+/).slice(0, 4),
            novaAba: el.target === '_blank',
            // Visível é o que importa: o braço só clica no que aparece, e o
            // link do menu do topo vive num dropdown com display:none.
            visivel: r.width > 0 && r.height > 0,
            y: Math.round(r.y),
          };
        })
        .filter((c) => {
          const chave = `${c.tag}|${c.nome}|${c.rotulo}|${c.href}|${c.classes.join('.')}`;
          if (vistos.has(chave)) return false;
          vistos.add(chave);
          return true;
        })
        .sort((a, b) => a.y - b.y);
    });
  } catch (e) {
    console.warn(`\nnão consegui ler a home: ${e.message}`);
  }
  await abaHome.close().catch(() => {});
  console.log(`\nAtalhos do chat na home: ${links.length}`);
  for (const l of links.slice(0, 12)) {
    const seletor = l.nome
      ? `[data-name='${l.nome}']`
      : l.classes[0]
        ? `.${l.classes[0]}`
        : l.tag;
    console.log(
      `  ${l.visivel ? 'visível' : ' oculto'} ${String(l.rotulo || '').padEnd(6)} ${seletor}` +
        (l.href ? ` -> ${l.href}` : ' (sem href: clique via JS)'),
    );
  }
  console.log('  ^ o "oculto" NÃO serve: o braço só clica no que está visível.');

  // O chat vive num iframe (chat-core). Inspecionar a página externa só
  // devolve a barra de navegação da Taobao — foi o que aconteceu na 1ª versão.
  console.log('\nFrames na página:');
  for (const f of frameHelper.listar(pagina)) console.log('  ' + f.url);

  const frame = await frameHelper.doChat(pagina);
  console.log(`\nInspecionando o frame do chat: ${frame.url()}\n`);

  const relatorio = await frame.evaluate(() => {
    const desc = (el) => {
      if (!el) return null;
      const cls = (el.className || '').toString().trim().split(/\s+/).filter(Boolean);
      return {
        tag: el.tagName.toLowerCase(),
        id: el.id || null,
        classes: cls.slice(0, 6),
        // Seletor que provavelmente sobrevive a mudança de build: prefere id,
        // depois data-*, depois a classe menos numérica (classe com hash tipo
        // "msg-a3f9" muda a cada deploy).
        sugestao: el.id
          ? `#${el.id}`
          : (() => {
              const dataAttr = [...el.attributes].find((a) => a.name.startsWith('data-'));
              if (dataAttr) return `[${dataAttr.name}]`;
              const estavel = cls.find((c) => !/\d{3,}|[a-f0-9]{6,}/i.test(c));
              return estavel ? `.${estavel}` : el.tagName.toLowerCase();
            })(),
        texto: (el.innerText || '').slice(0, 60),
        rect: (() => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width) }; })(),
      };
    };

    // Campo de digitação: contenteditable ou textarea visível.
    const editaveis = [...document.querySelectorAll('[contenteditable="true"], textarea')]
      .filter((e) => e.getBoundingClientRect().width > 100);

    // input[type=file] costuma estar escondido — é o caminho limpo p/ anexar foto.
    const inputsArquivo = [...document.querySelectorAll('input[type="file"]')];

    // Botão de enviar: procura pelo texto chinês 发送.
    const botoes = [...document.querySelectorAll('button, [role="button"], a')]
      .filter((b) => /发送|send/i.test(b.innerText || ''));

    // Balões: elementos com texto curto repetidos muitas vezes na coluna central.
    const meio = window.innerWidth / 2;
    const candidatosBalao = {};
    for (const el of document.querySelectorAll('div, li, section')) {
      const txt = (el.innerText || '').trim();
      if (!txt || txt.length > 200) continue;
      if (el.children.length > 3) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 40 || r.width > 600 || r.height < 15) continue;
      const cls = (el.className || '').toString().trim().split(/\s+/).filter(Boolean).join('.');
      if (!cls) continue;
      candidatosBalao[cls] = candidatosBalao[cls] || { classe: cls, n: 0, exemplos: [], esquerda: 0, direita: 0 };
      const c = candidatosBalao[cls];
      c.n++;
      if (c.exemplos.length < 4) c.exemplos.push(txt.slice(0, 40));
      if (r.x + r.width / 2 < meio) c.esquerda++; else c.direita++;
    }

    return {
      url: location.href,
      largura: window.innerWidth,
      editaveis: editaveis.map(desc),
      inputsArquivo: inputsArquivo.map(desc),
      botoesEnviar: botoes.map(desc),
      // Só grupos que se repetem: balão de verdade aparece muitas vezes.
      balaoCandidatos: Object.values(candidatosBalao)
        .filter((c) => c.n >= 3)
        .sort((a, b) => b.n - a.n)
        .slice(0, 15),
    };
  });

  relatorio.frameUrl = frame.url();
  // Vai junto no candidatos.json: sem isto, o seletor da home ficava só no
  // terminal e se perdia com a rolagem.
  relatorio.atalhosDaHome = links;

  fs.writeFileSync(path.join(SAIDA, 'candidatos.json'), JSON.stringify(relatorio, null, 2), 'utf8');
  // HTML do FRAME, não da casca externa — é onde estão os seletores que importam.
  fs.writeFileSync(
    path.join(SAIDA, 'chat.html'),
    await frame.evaluate(() => document.documentElement.outerHTML),
    'utf8',
  );
  await pagina.screenshot({ path: path.join(SAIDA, 'tela.png'), fullPage: false });

  console.log('\nGerado em braco-web/inspecao/:');
  console.log('  candidatos.json  <- me manda ESTE');
  console.log('  chat.html');
  console.log('  tela.png');
  console.log('\nResumo:');
  console.log(`  campos de digitação: ${relatorio.editaveis.length}`);
  console.log(`  inputs de arquivo:   ${relatorio.inputsArquivo.length}`);
  console.log(`  botões de enviar:    ${relatorio.botoesEnviar.length}`);
  console.log(`  grupos de balão:     ${relatorio.balaoCandidatos.length}`);

  await contexto.close();
  process.exit(0);
})().catch((e) => {
  console.error('falhou:', e.message);
  process.exit(1);
});
