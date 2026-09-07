'use strict';

const express = require('express');
const config = require('./config');
const handlers = require('./handlers');
const recovery = require('./recovery');
const community = require('./community');
const evolution = require('./evolution');
const sender = require('./sender');
const ponte = require('./ponte');
const vendas = require('./vendas');
const bracoRouter = require('./ponte/braco');
const transcricao = require('./transcricao');
const posvenda = require('./posvenda');
const chaves = require('./chaves');

const app = express();
// 12mb: a foto do cliente chega em base64 pela rota do braço, e base64 infla ~33%.
app.use(express.json({ limit: '12mb' }));

// Health check (Square Cloud / uptime)
app.get('/', (_req, res) => res.json({ ok: true, service: 'whatsbot' }));

// Rotas consumidas pelo braço Python que opera o app da Taobao.
app.use('/ponte/braco', bracoRouter);

/**
 * Webhook da Evolution API — mensagens recebidas do WhatsApp.
 * Configure na Evolution para POSTar aqui o evento MESSAGES_UPSERT.
 */
app.post('/webhooks/evolution', async (req, res) => {
  res.status(200).send('OK'); // responde já, processa depois

  try {
    const body = req.body || {};
    // A Evolution manda diferentes formatos; tratamos o messages.upsert.
    const data = body.data || body;
    const key = data.key || {};
    // Mensagem saindo do NOSSO número: ou foi o bot, ou foi o operador
    // digitando no celular. Só a segunda interessa — é quando o humano assume
    // a conversa e o bot precisa sair da frente, em vez de continuar
    // respondendo por cima dele.
    if (key.fromMe) {
      const jid = key.remoteJid || '';
      const txt =
        data.message?.conversation ||
        data.message?.extendedTextMessage?.text ||
        '';
      if (txt && !/@g\.us$|@broadcast$|@newsletter$/i.test(jid) && !sender.foiDoBot(txt)) {
        await handlers.onOperadorDigitou({ para: jid, texto: txt }).catch((err) => {
          console.error('[webhooks/evolution] onOperadorDigitou:', err.message);
        });
      }
      return;
    }

    // Ignora status/transmissões e newsletters.
    const remoteJid = key.remoteJid || '';
    if (/@broadcast$|@newsletter$/i.test(remoteJid)) return;

    const message = data.message || {};
    const text =
      message.conversation ||
      message.extendedTextMessage?.text ||
      // Foto com legenda: o texto do cliente vem no caption, não em conversation.
      message.imageMessage?.caption ||
      // Toque numa opção do MENU EM LISTA. Não vem em conversation: o WhatsApp
      // manda uma mensagem de resposta própria, e sem estas linhas o texto
      // chegava vazio — o cliente tocava no menu e o bot não reagia a nada.
      //
      // O rowId vem primeiro porque é o número da opção (ver menu.js), que
      // resolve pelo mesmo caminho de quem digitou. O título é reserva para as
      // versões que não mandam o id.
      message.listResponseMessage?.singleSelectReply?.selectedRowId ||
      message.listResponseMessage?.title ||
      message.buttonsResponseMessage?.selectedButtonId ||
      message.buttonsResponseMessage?.selectedDisplayText ||
      message.templateButtonReplyMessage?.selectedId ||
      '';

    // GRUPO: o bot NÃO responde. Nunca.
    //
    // As únicas mensagens que saem para o grupo são os anúncios que o
    // community.js agenda. Conversa é no privado, e essa é a regra do dono.
    //
    // Aqui havia um desvio para o `handleGroupMessage`, que lia a mensagem e
    // podia responder no grupo se COMMUNITY_REPLY_ENABLED estivesse ligado. O
    // caminho saiu inteiro: um interruptor desligado implementa "até alguém
    // ligar", não "nunca", e quem ligasse daqui a seis meses não saberia que
    // existia uma regra.
    //
    // O `return` fica, e é ele que garante o resto: sem esta linha, mensagem de
    // grupo cairia no fluxo 1-a-1 logo abaixo e a IA responderia lá dentro
    // achando que era conversa privada. (Por padrão a Evolution nem entrega
    // mensagem de grupo, `groupsIgnore=true`, mas isso é configuração de outro
    // serviço e não é onde uma regra desta deve morar.)
    if (/@g\.us$/i.test(remoteJid)) return;

    // IMAGEM (só no 1-a-1, depois do desvio de grupos): a Evolution entrega
    // apenas os metadados no webhook e o binário é baixado sob demanda.
    //
    // Baixa quando a ponte está ativa (o print da tela do cliente) OU quando a
    // IA está ligada (ela ENXERGA a imagem). Antes era só a ponte, e o efeito
    // era o modelo cego: o cliente printava a tela de erro do Steam, a IA
    // respondia no escuro e transferia para o operador — um atendimento inteiro
    // gasto num dado que estava ali e ninguém olhou.
    let imagem = null;
    let imagemBase64 = null;
    if (message.imageMessage && (ponte.ativa() || chaves.ligada('ia'))) {
      try {
        const midia = await evolution.getBase64FromMediaMessage(data);
        // O caminho em disco é o que a ponte manda para o outro lado; o base64
        // é o que o modelo enxerga. São usos diferentes do mesmo download.
        if (ponte.ativa()) imagem = await ponte.salvarImagem(midia.base64, midia.mimetype);
        if (chaves.ligada('ia')) {
          imagemBase64 = { base64: midia.base64, mimetype: midia.mimetype || 'image/jpeg' };
        }
      } catch (err) {
        console.error('[webhooks/evolution] falha ao baixar imagem:', err.response?.status || err.message);
      }
    }

    // ÁUDIO. Este formato não era extraído em lugar nenhum: `text` chegava
    // vazio e o cliente falava com uma parede. Transcrever aqui, na porta, faz
    // o áudio virar uma mensagem de texto comum — e todo o resto do bot (menu,
    // ponte, IA, recepção) funciona sem saber que houve áudio.
    let textoFinal = text;
    let audioFalhou = null;
    const audio = message.audioMessage;
    if (!textoFinal && audio) {
      if (!transcricao.disponivel()) {
        audioFalhou = 'sem_chave';
      } else if (audio.seconds && audio.seconds > transcricao.MAX_SEGUNDOS) {
        // Nem baixa: a duração já vem no webhook, e baixar para descartar é
        // pagar o download à toa.
        audioFalhou = 'longo_demais';
      } else {
        try {
          const midia = await evolution.getBase64FromMediaMessage(data);
          const r = await transcricao.transcrever(midia.base64, midia.mimetype, audio.seconds);
          if (r.texto) textoFinal = r.texto;
          else audioFalhou = r.motivo;
        } catch (err) {
          console.error('[webhooks/evolution] falha ao baixar áudio:', err.response?.status || err.message);
          audioFalhou = 'falhou';
        }
      }
    }

    const de = (key.remoteJid || '').replace('@s.whatsapp.net', '');

    // Não deu para ouvir: o cliente precisa saber, e precisa saber o que fazer.
    // Cair no menu com "não entendi" depois de um áudio é o pior desfecho —
    // ele acha que o bot ignorou.
    if (audioFalhou) {
      console.warn(`[webhooks/evolution] áudio de ${de} não virou texto: ${audioFalhou}`);
      await sender.send(de, transcricao.desculpa(audioFalhou)).catch(() => {});
      return;
    }

    await handlers.onIncomingMessage({
      from: de,
      text: textoFinal,
      imagem,
      imagemBase64,
      // Marca que a mensagem NASCEU como áudio. O bot responde por escrito de
      // qualquer jeito, mas quem lê o log precisa saber de onde veio o texto —
      // transcrição erra, e "o cliente disse isso?" é a primeira pergunta.
      veioDeAudio: Boolean(audio),
      pushName: data.pushName,
      raw: body,
    });
  } catch (err) {
    console.error('[webhooks/evolution] erro:', err.message);
  }
});

/**
 * Webhook da Nerix — eventos de pedido (order.paid, order.delivered, ...).
 * Configure no painel da Nerix com ?secret=SEU_TOKEN.
 */
// Dá para abrir no navegador e ver se o endereço existe.
//
// "Configurei tudo certinho e não chega" tem duas causas muito diferentes: a
// loja não está chamando, ou está chamando e sendo recusada. Sem uma forma de
// separar as duas, a investigação vira chute — e foi exatamente onde a de hoje
// travou. Abrir a URL no navegador responde a primeira metade em dois segundos.
//
// Não revela nada: só diz que o caminho existe e se há um token configurado,
// nunca qual é.
app.get('/webhooks/nerix', (req, res) => {
  res.type('text/plain').send(
    'Webhook de vendas no ar.\n' +
      `Token exigido: ${config.webhook.nerixSecret ? 'SIM' : 'NAO (aceita qualquer chamada)'}\n` +
      'Se voce esta vendo isto no navegador, o endereco esta certo e alcancavel.\n',
  );
});

app.post('/webhooks/nerix', async (req, res) => {
  const { secret } = req.query;

  // A RECUSA PRECISA APARECER NO LOG.
  //
  // Ela devolvia 401 e ia embora calada. Do lado de fora o desfecho é idêntico
  // ao de um webhook que nunca foi cadastrado: nenhuma venda avisada, nenhuma
  // linha no log, nada para investigar. A armadilha mais provável é o token da
  // URL e o do Environment serem coisas diferentes, e é justamente a que não
  // deixava rastro.
  if (config.webhook.nerixSecret && secret !== config.webhook.nerixSecret) {
    console.warn(
      '[webhooks/nerix] RECUSADO: o token da URL nao bate com o NERIX_WEBHOOK_SECRET. ' +
        `Veio ${secret ? `um token de ${String(secret).length} caracteres` : 'NENHUM token'}; ` +
        `o servidor espera um de ${config.webhook.nerixSecret.length}. ` +
        'Corrija na loja ou no Environment, os dois tem que ser iguais.',
    );
    return res.status(401).json({ error: 'Assinatura inválida' });
  }

  // E a ACEITAÇÃO também: sem esta linha, "chegou e eu ignorei o evento" fica
  // igual a "não chegou". O nome do evento é o que diz qual dos dois é.
  console.log(`[webhooks/nerix] recebido: ${req.body?.event || req.body?.type || 'evento sem nome'}`);

  res.status(200).send('OK'); // responde em < 5s conforme exigido

  try {
    await handlers.onNerixEvent(req.body || {});
  } catch (err) {
    console.error('[webhooks/nerix] erro:', err.message);
  }
});

/**
 * Data do código que está rodando de verdade.
 *
 * Os dois serviços sobem SEPARADOS no Easypanel, e deployar só um já causou
 * bug várias vezes — com o log mudo sobre qual versão estava no ar, o tempo ia
 * embora depurando um sintoma que outro deploy já tinha resolvido. Agora a
 * primeira linha responde: se as duas datas não batem, o deploy ficou pela
 * metade.
 */
function dataDoBuild(arquivo) {
  try {
    return require('fs').statSync(arquivo).mtime.toISOString().slice(0, 16).replace('T', ' ');
  } catch {
    return 'desconhecida';
  }
}

// So sobe o servidor quando ESTE arquivo e o programa.
//
// O Dockerfile roda `node src/server.js`, entao em producao nada muda. O que
// muda e que o teste consegue requerer o `app` e fazer uma requisicao de
// verdade no webhook -- que era o unico caminho do bot sem teste nenhum, e
// justamente onde ficam as portas que decidem se a foto e o audio do cliente
// chegam a alguem.
const ehOPrograma = require.main === module;

const server = ehOPrograma && app.listen(config.port, () => {
  console.log(`whatsbot rodando na porta ${config.port} — build de ${dataDoBuild(__filename)} UTC`);
  if (!config.autoReply) console.log('[bot] AUTO-RESPOSTA DESLIGADA (BOT_AUTOREPLY=false) — não responde no 1-a-1');
  recovery.start(); // recuperação de venda: cutuca quem sumiu no meio da conversa
  community.start(); // agente de comunidade: posta conteúdo no grupo (Fase 1: só saída)
  ponte.iniciar(); // ponte com o fornecedor da Taobao (fila serial + braço robô)
  vendas.iniciar(); // ciclo de venda: cutuca quem gerou pagamento e não pagou
  posvenda.iniciar(); // depois da entrega: pergunta se ativou · reativa quem sumiu
});

// Socket ocioso vive 65s, não os 5s do padrão.
//
// O braço faz long-poll no /ponte/braco/proxima e trabalha entre uma chamada e
// outra: abrir a conversa, clicar, conferir o título. Com 5s o servidor
// descartava o socket nesse intervalo e a chamada seguinte morria com "socket
// hang up" — o braço nunca recebia tarefa e ficava reabrindo a conversa em
// laço, sem nada no log além do aviso.
//
// headersTimeout precisa ser MAIOR que keepAliveTimeout: se for menor, o Node
// derruba a conexão enquanto ainda espera os cabeçalhos e o problema volta com
// outra cara.
if (server) server.keepAliveTimeout = 65_000;

// Encerramento limpo: SALVA O ESTADO antes de morrer.
//
// O estado da ponte é gravado com debounce de 400ms (estado.js). Sem isto, o
// SIGTERM de um deploy no instante errado levava junto a fila — quem estava
// esperando código sumia da fila e ficava sem resposta e sem alerta, e o
// operador não tinha como saber que existiu.
//
// Sai com 0 de propósito: encerramento pedido pelo orquestrador não é falha, e
// código de erro aqui polui o log do painel com "crash" que nunca houve.
let encerrando = false;
if (ehOPrograma) for (const sinal of ['SIGTERM', 'SIGINT']) {
  process.on(sinal, () => {
    if (encerrando) return; // segundo sinal não reentra
    encerrando = true;
    console.log(`[whatsbot] ${sinal} recebido — salvando estado e encerrando`);

    try {
      require('./ponte/estado').persistAgora();
      console.log('[whatsbot] estado salvo');
    } catch (err) {
      console.error('[whatsbot] falha ao salvar estado no encerramento:', err.message);
    }

    // Teto: se uma conexão pendurada (o long-poll do braço vive 65s) segurar o
    // close, não dá para ficar esperando — o orquestrador manda SIGKILL e aí o
    // encerramento não termina de qualquer jeito.
    const forcar = setTimeout(() => process.exit(0), 5000);
    forcar.unref();
    server.close(() => process.exit(0));
  });
}
if (server) server.headersTimeout = 70_000;

module.exports = { app };
