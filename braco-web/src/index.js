'use strict';

/**
 * Laço principal do braço.
 *
 * Ciclo:
 *   1. pergunta ao bot se pode agir (janela do fornecedor + disjuntor fechado)
 *   2. se houver tarefa: abre o chat, MARCA a posição, manda foto + usuário
 *   3. lê o que apareceu DEPOIS da marca e devolve ao bot
 *   4. dorme um intervalo sorteado e repete
 *
 * A marca d'água é o coração da correção: sem ela, os meses de histórico
 * visível no chat virariam centenas de códigos "novos", e códigos repetidos
 * entre clientes seriam descartados como duplicata.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const axios = require('axios');
const cfg = require('./config');
const { abrir } = require('./navegador');
const { Chat, BloqueioDetectado, SeletorNaoEncontrado } = require('./chat');
const humaniza = require('./humaniza');

const api = axios.create({
  baseURL: `${cfg.botUrl}/ponte/braco`,
  timeout: 30000,
  headers: { 'x-braco-key': cfg.chave, 'Content-Type': 'application/json' },
});

let rodando = true;
process.on('SIGTERM', () => { rodando = false; });
process.on('SIGINT', () => { rodando = false; });

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

async function evento(nivel, etapa, detalhe) {
  console.log(`[${nivel}] ${etapa}: ${detalhe}`);
  try {
    await api.post('/evento', { nivel, etapa, detalhe });
  } catch { /* log não pode derrubar o laço */ }
}

/**
 * Manda print para o WhatsApp do operador.
 *
 * É assim que o login acontece: dentro do container não existe tela para
 * escanear o QR da Taobao, então o braço fotografa a tela e o operador
 * escaneia com o iPhone. Sem isto, o braço num container nunca autentica.
 */
async function alertarComPrint(pagina, texto) {
  try {
    // JPEG e não PNG: print de 1440x900 em PNG passa de 1MB depois do base64,
    // tamanho que a Evolution costuma recusar com 400 — e aí o sender cai no
    // fallback de só texto, que para um QR é inútil. Em q90 o QR continua
    // perfeitamente escaneável e o payload cai para ~100KB.
    const jpg = await pagina.screenshot({ type: 'jpeg', quality: 90 });
    const b64 = jpg.toString('base64');
    console.log(`[braço] enviando print (${Math.round(b64.length / 1024)} KB em base64)`);
    await api.post('/alerta', { texto, imagemBase64: b64 });
  } catch (err) {
    console.error('[braço] falha ao mandar print:', err.message);
    await api.post('/alerta', { texto }).catch(() => {});
  }
}

/**
 * Garante sessão logada. Devolve true quando o chat está acessível.
 *
 * Não tenta logar sozinho de propósito: login automatizado numa conta com
 * histórico é o caminho mais rápido para verificação. Quem escaneia é humano.
 */
let smsPedidoEm = 0;

async function garantirLogin(pagina, chat) {
  try {
    await chat.prender(); // achou o iframe chat-core = está logado
    console.log('[braço] sessão ok (iframe do chat encontrado)');
    smsPedidoEm = 0;
    return true;
  } catch (err) {
    // Diz POR QUE achou que não está logado. Sem isto, o log só informa que
    // um print foi enviado — e a tela pode estar perfeitamente carregada
    // enquanto o problema é outro (frame com outro nome, página errada,
    // aba diferente). Foi exatamente onde a gente ficou cego.
    console.warn(`[braço] sessão NÃO ok: ${err.message}`);
    console.warn(`[braço] URL atual: ${pagina.url()}`);
    for (const f of pagina.frames()) {
      console.warn(`[braço]   frame: ${f.url() || '(sem url)'}`);
    }
  }

  // Caso 1: verificação por SMS. A Taobao manda o código para o telefone do
  // dono da conta; o operador recebe e devolve pelo WhatsApp. O braço só
  // transporta, porque ninguém consegue clicar num navegador dentro de um
  // container.
  if (await chat.emVerificacaoSms()) {
    // Código que o operador já mandou?
    const { data: st } = await api.get('/estado').catch(() => ({ data: {} }));
    if (st.smsTaobao) {
      console.log('[braço] preenchendo código SMS recebido do operador');
      try {
        await chat.preencherSms(st.smsTaobao);
        await api.post('/sms-usado', {});
        smsPedidoEm = 0;
        return false; // próximo ciclo confirma se entrou
      } catch (err) {
        await api.post('/sms-usado', {});
        await alertarComPrint(pagina, `⚠️ Não consegui usar o código: ${err.message}`);
        return false;
      }
    }

    // 15 min entre avisos, não 5. Repetir de mais rebate na Taobao (pedidos de
    // SMS seguidos viram sinal de abuso) e enche o WhatsApp do operador.
    if (Date.now() - smsPedidoEm > 15 * 60 * 1000) {
      const pediu = await chat.pedirSms();
      smsPedidoEm = Date.now();

      // Depois do clique a Taobao costuma exigir o slider ANTES de mandar o
      // SMS. Se não checarmos, a mensagem diz "o código vai chegar" quando na
      // verdade nada foi enviado — e o operador espera um SMS que não vem.
      const bloqueado = await chat.temSlider();

      const oQueFazer = bloqueado
        ? `⚠️ Apareceu o *slider* antes de mandar o SMS. Ele mede o arraste, ` +
          `então só um humano passa — eu não tento.\n\n` +
          `1. Abre a tela do braço (link no alerta de verificação)\n` +
          `2. Arrasta o slider com o mouse, devagar\n` +
          `3. Aí o SMS chega e você responde *#taobao 123456*`
        : pediu
          ? 'Já cliquei em "enviar SMS" — o código deve chegar no seu celular.\n\n' +
            'Quando chegar, responde aqui:\n*#taobao 123456*'
          : 'Não achei o botão de enviar SMS. Abre a tela do braço e clica você.';

      await alertarComPrint(
        pagina,
        `📱 *Taobao pediu verificação*\n\n${oQueFazer}\n\n` +
          `_Isso acontece porque o navegador do servidor é um dispositivo novo ` +
          `para a sua conta. Depois de validar uma vez, o perfil fica salvo._`,
      );
    }
    return false;
  }

  // Caso 2: tela de login normal (QR ou senha).
  await alertarComPrint(
    pagina,
    '🔐 *Braço precisa de login na Taobao*\n\n' +
      'Escaneie o QR desta tela com o app da Taobao no seu iPhone.\n' +
      'Assim que logar, eu continuo sozinho — o perfil fica salvo.',
  );
  return false;
}

/** Baixa a foto do bot (que roda noutra máquina) para um arquivo temporário. */
async function baixarFoto(nome) {
  const r = await api.get(`/midia/${nome}`, { responseType: 'arraybuffer' });
  const destino = path.join(os.tmpdir(), `phaze_${Date.now()}${path.extname(nome) || '.jpg'}`);
  fs.writeFileSync(destino, Buffer.from(r.data));
  return destino;
}

// ------------------------------------------------------------

async function executarTarefa(chat, tarefa, titulo) {
  const { pode, motivo } = humaniza.podeEnviar();
  if (!pode) {
    await evento('warn', 'rate_limit_local', motivo);
    await api.post('/resultado', { id: tarefa.id, ok: false, erro: motivo });
    return null; // explícito: sem marca, não há o que ler
  }

  await evento('info', 'executando', `usuário ${tarefa.usuario} (tentativa ${tarefa.tentativa})`);
  await chat.abrirConversa(titulo);

  // MARCA antes de qualquer envio. Tudo além disto é resposta.
  const marca = await chat.marca();

  let temp = null;
  try {
    if (tarefa.imagem) {
      temp = await baixarFoto(tarefa.imagem);
      // Foto primeiro: o fornecedor vê a tela e já lê o usuário embaixo.
      const r = await chat.enviarFoto(temp);
      await evento('info', 'foto', `enviada via ${r.via}`);

      // Saiu como cartão de download em vez de imagem: para o fornecedor é o
      // mesmo que não ter chegado, porque ele não baixa anexo. Ninguém
      // descobriria sozinho — o braço reportaria sucesso e o cliente esperaria
      // à toa até o timeout de 4h.
      if (r.comoArquivo) {
        await evento(
          'warn',
          'foto_como_arquivo',
          'A foto saiu como ARQUIVO, não como imagem — o fornecedor não abre. ' +
            'Manda o print na mão pelo chat da Taobao.',
        );
      }
    }

    await chat.enviarTexto(tarefa.usuario);
    humaniza.registrarEnvio();

    await api.post('/resultado', { id: tarefa.id, ok: true });
    await evento('info', 'enviado', `${tarefa.usuario} — marca ${marca}`);
    return marca;
  } finally {
    if (temp && fs.existsSync(temp)) fs.unlinkSync(temp);
  }
}

async function lerRespostas(chat, marca) {
  const novas = await chat.lerNovas(marca);
  if (!novas.length) return false;

  await evento(
    'info',
    'resposta',
    `${novas.length} nova(s): ${novas.map((m) => JSON.stringify(m.texto)).join(', ')}`,
  );
  await api.post('/entrada', { mensagens: novas.map((m) => ({ texto: m.texto })) });
  return true;
}

// ------------------------------------------------------------

async function main() {
  // Diagnóstico ANTES de qualquer coisa que possa travar. A primeira versão ia
  // direto para abrir(), então quando o navegador não subia o container ficava
  // mudo — sem uma linha dizendo onde parou.
  console.log('[braço] iniciando');
  console.log(`[braço] BOT_URL = ${cfg.botUrl}`);
  console.log(`[braço] chave   = ${cfg.chave ? 'definida' : 'AUSENTE'}`);
  console.log(`[braço] DISPLAY = ${process.env.DISPLAY || '(vazio — xvfb não exportou)'}`);

  if (!cfg.chave) {
    console.error('[fatal] PONTE_BRACO_KEY vazia. Preencha no Environment do serviço.');
    process.exit(2);
  }

  // Fala com o bot ANTES de abrir o navegador: se a rede interna estiver
  // errada, melhor descobrir agora do que depois de esperar o Chrome subir.
  try {
    const { data } = await api.get('/estado');
    console.log(
      `[braço] bot ok — janela ${data.janelaAberta ? 'aberta' : 'fechada'}, disjuntor ${data.disjuntor}`,
    );
  } catch (err) {
    console.error(`[fatal] não falei com o bot em ${cfg.botUrl}: ${err.message}`);
    console.error('        Se for ECONNREFUSED, o whatsbot escuta noutra porta — tente :3000.');
    process.exit(3);
  }

  console.log('[braço] abrindo o Chrome (pode levar ~30s na primeira vez)…');
  let contexto;
  let pagina;
  try {
    ({ contexto, pagina } = await abrir());
    console.log('[braço] Chrome aberto');
  } catch (err) {
    console.error(`[fatal] não abri o Chrome: ${err.message}`);
    console.error(err.stack || '');
    process.exit(4);
  }

  const chat = new Chat(pagina);
  console.log(`[braço] carregando ${cfg.chatUrl}`);
  await pagina.goto(cfg.chatUrl, { waitUntil: 'domcontentloaded' });
  console.log('[braço] página carregada — entrando no laço');

  // Marca do atendimento em curso. null = ninguém esperando resposta.
  let marcaAtual = null;
  // Conversa do fornecedor está aberta na tela? Volta a false quando algo dá
  // errado, para o próximo ciclo reabrir em vez de escrever no vazio.
  let conversaAberta = false;

  while (rodando) {
    try {
      const { data: st } = await api.get('/estado');

      if (!st.podeAgir) {
        if (st.disjuntor === 'aberto') {
          console.log(`[braço] congelado: ${st.motivoDisjuntor}`);
        }
        await dormir(300_000);
        continue;
      }

      const titulo = st.chatTitulo;
      if (!titulo) {
        await evento('error', 'config', 'PONTE_SELLER_CHAT_TITLE vazio no bot');
        await dormir(300_000);
        continue;
      }

      // Sessão caiu ou é a primeira subida: manda o QR e espera o humano.
      // 3 min entre tentativas para não encher o WhatsApp do operador de print.
      if (!(await garantirLogin(pagina, chat))) {
        conversaAberta = false; // o reload abaixo joga a conversa fora
        await dormir(180_000);
        await pagina.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
        continue;
      }

      // Mantém a conversa do fornecedor ABERTA, mesmo sem tarefa.
      //
      // A versão anterior só abria quando havia trabalho, e o braço ficava
      // parado na tela "您尚未选择联系人" — impossível saber pelo VNC se estava
      // vivo. Além disso, humano que conversa com um fornecedor deixa o chat
      // dele aberto; abrir só na hora de escrever é padrão de robô.
      if (!conversaAberta) {
        try {
          await chat.abrirConversa(titulo);
          conversaAberta = true;
          console.log(`[braço] conversa de "${titulo}" aberta`);
        } catch (err) {
          console.warn(`[braço] não abri a conversa: ${err.message}`);
          await evento('warn', 'abrir_conversa', err.message);
          await dormir(120_000);
          continue;
        }
      }

      // 1) Tarefa pendente?
      const resp = await api.get('/proxima', { validateStatus: (s) => s === 200 || s === 204 });
      if (resp.status === 200) {
        marcaAtual = await executarTarefa(chat, resp.data, titulo);
        await dormir(humaniza.pausaLonga());
        continue;
      }

      // 2) Alguém esperando resposta? Só então vale ler.
      //
      // Array.isArray e não `!== null`: se executarTarefa sair cedo devolvendo
      // undefined, `undefined !== null` passaria, a marca viraria conjunto
      // vazio e TODO o histórico seria lido como novo — justamente o que a
      // marca existe para impedir.
      if (st.temAtendimentoAtivo && Array.isArray(marcaAtual)) {
        await chat.abrirConversa(titulo);
        const achou = await lerRespostas(chat, marcaAtual);
        if (achou) marcaAtual = null; // vez encerrada; o bot promove o próximo
      }

      await dormir(humaniza.intervaloLeitura());
    } catch (err) {
      // Qualquer erro pode ter deixado a tela noutro estado — força reabrir
      // a conversa no próximo ciclo em vez de escrever achando que está lá.
      conversaAberta = false;

      if (err instanceof BloqueioDetectado) {
        // NÃO tentamos resolver. Manda o print junto: sem ver a tela, o
        // operador não sabe se é slider, SMS ou logout, e cada um pede uma
        // ação diferente.
        const png = await pagina.screenshot({ type: 'jpeg', quality: 90 }).catch(() => null);
        await api
          .post('/bloqueio', {
            motivo: String(err.message),
            imagemBase64: png ? png.toString('base64') : undefined,
          })
          .catch(() => {});
        await evento('error', 'bloqueio', `${err.message} — aguardando liberação`);
        await dormir(600_000);
      } else if (err instanceof SeletorNaoEncontrado) {
        await evento('error', 'seletor', err.message);
        await dormir(120_000);
      } else if (err.response || err.code) {
        await evento('warn', 'bot_indisponivel', err.message);
        await dormir(30_000);
      } else {
        await evento('error', 'inesperado', `${err.name}: ${err.message}`);
        await dormir(60_000);
      }
    }
  }

  await contexto.close();
  console.log('[braço] encerrado.');
}

main().catch((e) => {
  console.error('[fatal]', e);
  process.exit(1);
});
