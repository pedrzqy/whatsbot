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
/**
 * A tela de reconectar o WhatsApp, para abrir no navegador do celular.
 *
 * QUANDO O NÚMERO CAI, o bot fica mudo e não consegue avisar ninguém: o único
 * canal que ele tem é justamente o que caiu. E o painel da Evolution mora num
 * endereço interno do Easypanel (`servico_evolution-api:8080`), que só resolve
 * de dentro da rede dos containers — o navegador de fora dá erro de DNS.
 *
 * Sobrava abrir o console do container e digitar um comando comprido, no
 * celular, com a loja parada. É o pior momento possível para exigir isso.
 *
 * Este endereço o dono salva nos favoritos uma vez. Nos próximos tombos são
 * dois toques.
 *
 * PROTEGIDA DE VERDADE, e não por hábito: o que ela devolve é um código de
 * pareamento, e quem tem um código de pareamento liga o PRÓPRIO WhatsApp no
 * número da loja. Sem `ADMIN_TOKEN` configurado ela responde 404, como se não
 * existisse.
 */
app.get('/conectar', async (req, res) => {
  if (!config.adminToken) return res.status(404).send('Não encontrado');

  if (req.query.token !== config.adminToken) {
    console.warn('[conectar] tentativa com token errado');
    return res.status(401).send('Token inválido');
  }

  const pagina = (corpo) =>
    res.type('html').send(
      '<meta name="viewport" content="width=device-width,initial-scale=1">' +
        '<style>body{font-family:system-ui;background:#111;color:#eee;text-align:center;padding:24px}' +
        'h1{font-size:18px;font-weight:600}code{font-size:34px;letter-spacing:3px;display:block;' +
        'margin:18px 0;color:#7ef}img{max-width:min(88vw,360px);background:#fff;padding:10px;border-radius:8px}' +
        'p{color:#aaa;font-size:14px;line-height:1.5}</style>' +
        corpo,
    );

  try {
    const estado = await evolution.estadoInstancia().catch(() => '');
    if (estado === 'open') {
      return pagina('<h1>✅ Ja esta conectado</h1><p>Nao precisa fazer nada.</p>');
    }

    const { pairingCode, qrBase64 } = await evolution.conectarInstancia();
    console.log('[conectar] codigo de pareamento gerado');

    // O código vem PRIMEIRO, e o QR embaixo: quem abre isto está no celular, e
    // no celular não dá para apontar a câmera para a própria tela.
    return pagina(
      '<h1>Conectar o WhatsApp</h1>' +
        (pairingCode
          ? `<p>No celular: WhatsApp, Dispositivos conectados, Conectar com numero de telefone. ` +
            `Digite:</p><code>${pairingCode}</code>`
          : '<p>Esta versao nao devolveu codigo. Use o QR abaixo.</p>') +
        (qrBase64 ? `<p>Ou aponte a camera de outro aparelho:</p><img src="${qrBase64}">` : '') +
        '<p>Expira rapido. Se falhar, recarregue esta pagina para gerar outro.</p>',
    );
  } catch (err) {
    // O motivo REAL na tela, e não "algo deu errado". Quem abre isto está
    // resolvendo um problema, e a mensagem é a única pista que ele tem.
    const motivo = err.response?.status
      ? `A Evolution respondeu ${err.response.status}.`
      : `Nao consegui falar com a Evolution: ${err.code || err.message}.`;
    console.error('[conectar] falhou:', err.response?.status || err.message);
    return pagina(
      `<h1>Nao deu para gerar o codigo</h1><p>${motivo}</p>` +
        '<p>Confira se o servico da Evolution esta no ar e se a EVOLUTION_API_KEY do whatsbot ' +
        'e igual a AUTHENTICATION_API_KEY dela.</p>',
    );
  }
});

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
    const detalhe =
      `${secret ? `veio um token de ${String(secret).length} caracteres` : 'nao veio token nenhum'}, ` +
      `e o servidor espera um de ${config.webhook.nerixSecret.length}`;
    console.warn(
      `[webhooks/nerix] RECUSADO: o token da URL nao bate com o NERIX_WEBHOOK_SECRET (${detalhe}). ` +
        'Corrija na loja ou no Environment, os dois tem que ser iguais.',
    );
    // Guarda para o #status. O log do painel é o lugar mais difícil de olhar
    // para quem opera do celular, e esta é exatamente a informação que separa
    // "a loja não está chamando" de "a loja chamou e eu recusei".
    vendas.registrarRecusaWebhook(detalhe);
    return res.status(401).json({ error: 'Assinatura inválida' });
  }

  // E a ACEITAÇÃO também: sem esta linha, "chegou e eu ignorei o evento" fica
  // igual a "não chegou". O nome do evento é o que diz qual dos dois é.
  const nomeDoEvento = req.body?.event || req.body?.type || 'evento sem nome';
  const dadosDoEvento = req.body?.data || {};
  console.log(
    `[webhooks/nerix] recebido: ${nomeDoEvento} | campos em data: ${Object.keys(dadosDoEvento).join(',') || '(vazio)'}`,
  );

  // Guarda para o #status, porque o 200 que a loja vê sai ANTES disto e não
  // prova nada sobre o que aconteceu depois. Só os NOMES dos campos: o payload
  // tem dado de cliente e isto vai parar numa mensagem de WhatsApp.
  vendas.registrarChamadaWebhook({
    evento: String(nomeDoEvento).slice(0, 40),
    pedido: dadosDoEvento.order_number || dadosDoEvento.code || dadosDoEvento.id || null,
    campos: Object.keys(dadosDoEvento).join(',').slice(0, 200),
  });

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
