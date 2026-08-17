'use strict';

/**
 * Aqui mora a LÓGICA DO BOT — é onde suas funções vão ser encaixadas.
 *
 * - onIncomingMessage:  chamado a cada mensagem recebida no WhatsApp.
 * - onNerixEvent:       chamado a cada webhook da Nerix (pedido pago, etc).
 *
 * Por enquanto são só esboços. Conforme você me mandar as funções
 * (ex: "mostrar catálogo", "criar pedido pelo chat", "entregar chave"),
 * a implementação entra aqui.
 */

const config = require('./config');
const store = require('./store');
const welcome = require('./welcome');
const ai = require('./ai');
const sender = require('./sender');
const variator = require('./variator');
const operador = require('./ponte/operador');
const recepcao = require('./ponte/recepcao');
const ponte = require('./ponte');
const menu = require('./menu');

/**
 * O que cada opção de AÇÃO do menu faz. Retorna true se já respondeu.
 *
 * Tudo aqui é texto pronto — a única ação que acorda a IA é 'ia', e ela só
 * marca o contato e devolve o convite para escrever. Assim o custo de LLM
 * aparece uma vez, no ramo onde a conversa é realmente livre, em vez de em
 * toda pergunta de prazo e garantia.
 */
async function acaoDoMenu(acao, { from, pushName }) {
  if (acao === 'ia') {
    // A partir daqui a conversa é livre: sai do menu e entra na IA, que tem as
    // ferramentas (consultar pedido, buscar produto, chamar atendente).
    store.saveContact(from, { modoIA: true, menuNode: null });
    await sender.send(
      from,
      'Sem problema, vou te ajudar 👍\n\n' +
        'Me conta *o que aconteceu* com sua compra. Se puder, manda também o ' +
        '*código do pedido* e o *e-mail* que você usou — assim eu já consulto aqui.',
    );
    return true;
  }

  if (acao === 'pedido') {
    // Também pronto: pede os dois dados de uma vez e deixa a IA consultar
    // quando eles chegarem. Pedir os dois juntos evita a ida e volta de "qual
    // o código?" / "qual o e-mail?" — e sem os dois a consulta nem sai.
    store.saveContact(from, { modoIA: true, menuNode: null });
    await sender.send(
      from,
      '📦 Para consultar seu pedido eu preciso de *2 coisas*:\n\n' +
        '1️⃣ O *código do pedido*\n' +
        '2️⃣ O *e-mail* usado na compra\n\n' +
        'Pode mandar os dois na mesma mensagem 👍',
    );
    return true;
  }

  if (acao === 'codigo') {
    // Não chama a ponte aqui: quem detecta o pedido de código é a recepcao.js,
    // sem IA, e ela já conduz o passo a passo (foto → usuário). Aqui só se
    // manda o cliente começar esse fluxo do jeito que a recepção reconhece.
    store.saveContact(from, { menuNode: null });
    await sender.send(
      from,
      '🔑 Beleza! Me manda a mensagem *preciso do código* que eu já começo o ' +
        'passo a passo com você.',
    );
    return true;
  }

  if (acao === 'atendente') {
    store.saveContact(from, { paused: true, menuNode: null, modoIA: false });
    console.log(`[handoff] ${from} -> atendente (pelo menu)`);
    await sender.send(
      from,
      'Certo! Já estou chamando um atendente pra continuar com você 🧑‍💼\n\n' +
        '_Se quiser voltar ao atendimento automático, digite *#inicio*._',
    );
    return true;
  }

  return false;
}

// Palavras que reativam o autoatendimento quando o cliente está com um humano.
const RESUME = new Set(['#inicio', '#início', 'inicio', 'início', 'menu', 'voltar', 'atendimento', 'recomecar', 'recomeçar']);

// Serializa o processamento das mensagens de um MESMO contato, para não
// re-saudar nem trocar a ordem quando várias mensagens chegam em sequência.
const contactLocks = new Map();

/**
 * @param {object} msg  Mensagem normalizada { from, text, pushName, raw }
 */
function onIncomingMessage(msg) {
  const from = msg && msg.from;
  if (!from) return Promise.resolve();
  const prev = contactLocks.get(from) || Promise.resolve();
  const next = prev
    .then(() => handleMessage(msg))
    .catch((err) => console.error('[handler] erro:', err.message));
  contactLocks.set(
    from,
    next.finally(() => { if (contactLocks.get(from) === next) contactLocks.delete(from); })
  );
  return next;
}

async function handleMessage(msg) {
  const { from, text, pushName, imagem } = msg;
  const trimmed = (text || '').trim();
  const lower = trimmed.toLowerCase();
  console.log(`[msg] de ${from} (${pushName || '?'}): ${trimmed}${imagem ? ' [+foto]' : ''}`);

  // ─── 0) Comandos do operador da ponte (só do número configurado) ───
  // Vem antes de tudo: quando a Taobao pede verificação, o operador precisa
  // destravar em segundos, e não pode esbarrar em boas-vindas ou pausa.
  if (operador.ehComando(from, trimmed)) {
    try {
      await sender.send(from, await operador.executar(trimmed), { typing: false });
    } catch (err) {
      console.error('[ponte/operador] erro:', err.message);
      await sender.send(from, `Falhou: ${err.message}`, { typing: false });
    }
    return;
  }

  // ─── 0.1) Pedido de código ao fornecedor (ponte) ───
  //
  // Vem ANTES do check de autoReply de propósito. Com BOT_AUTOREPLY=false o
  // fluxo abaixo retorna sem chamar a IA, e a ferramenta pedir_codigo_fornecedor
  // nunca seria invocada — a ponte ficaria inerte, sem erro e sem log.
  //
  // O gatilho é estreito (foto + algo com cara de usuário de conta), então
  // conversa normal de vendas não cai aqui. ATENÇÃO: neste caminho o bot
  // RESPONDE ao cliente mesmo com autoreply desligado — é o único jeito de
  // pedir a metade que falta e de entregar o código depois.
  if (ponte.ativa()) {
    const r = recepcao.avaliar(from, trimmed, imagem);

    if (r.acao === 'responder') {
      store.saveContact(from, { lastSeen: Date.now(), name: pushName || store.getContact(from)?.name });
      await sender.send(from, r.mensagem);
      return;
    }

    if (r.acao === 'pedir') {
      store.saveContact(from, { lastSeen: Date.now(), name: pushName || store.getContact(from)?.name });
      const nome = store.getContact(from)?.name || pushName || from;
      const res = await ponte.pedirCodigo(from, nome, r.usuario, r.imagem);
      await sender.send(from, res.mensagem);
      return;
    }
  }

  // Auto-resposta DESLIGADA (BOT_AUTOREPLY=false): o bot não RESPONDE no 1-a-1
  // (um humano atende). Mas marca o contato como engajado, pra a RECUPERAÇÃO DE
  // VENDA ainda cutucar quem mandou mensagem e sumiu. Não envia nada agora.
  //
  // EXCEÇÃO: o operador com #teste ligado.
  //
  // O #teste diz "agora suas mensagens normais entram como se fossem de um
  // cliente" — e com o autoreply desligado isso era falso: o retorno acontecia
  // aqui, antes até do #inicio, então nem "ola" nem "#inicio" recebiam
  // resposta. Só os #comandos da ponte respondiam, porque eles são tratados
  // acima. O sintoma (bot mudo logo depois de confirmar o modo teste) aponta
  // para todos os lugares errados.
  //
  // A alternativa seria ligar BOT_AUTOREPLY para testar — o que faria o bot
  // responder a loja INTEIRA só para o operador conferir um fluxo. Este furo
  // vale exatamente para um número, o dele, e por 30 minutos.
  if (!config.autoReply && !ponte.operadorEmTeste(from)) {
    store.saveContact(from, {
      lastSeen: Date.now(),
      name: pushName || store.getContact(from)?.name,
      engaged: true,
      followupCount: 0,
    });
    return;
  }

  const contact = store.getContact(from);
  const now = Date.now();
  const nameFields = { lastSeen: now, name: pushName || contact?.name };

  // ─── 1) Boas-vindas / primeiro contato (convida a perguntar, sem menu) ───
  if (welcome.shouldWelcome(contact)) {
    ai.clearHistory(from);
    store.saveContact(from, {
      firstSeen: contact?.firstSeen || now,
      greetedAt: now,
      paused: false,
      ...nameFields,
    });
    const greeting = await welcome.buildGreeting(pushName);
    await sender.send(from, greeting);
    // O menu vem junto — o buildGreeting já dizia "(o menu é enviado logo
    // depois)" e isso nunca acontecia: menu.js não era importado por ninguém.
    // Sem ele, toda pergunta caía na IA, inclusive as de resposta fixa.
    store.saveContact(from, { menuNode: 'main', modoIA: false });
    await sender.send(from, menu.render('main'));
    return;
  }

  // ─── 2) Palavras de recomeço (#inicio/menu/voltar) — barato, sem IA ───
  if (RESUME.has(lower)) {
    store.saveContact(from, {
      paused: false,
      followupCount: 0,
      menuNode: 'main',
      modoIA: false, // volta ao menu = sai da conversa livre
      ...nameFields,
    });
    await sender.send(from, `${variator.resumed()}\n\n${menu.render('main')}`);
    return;
  }

  // ─── 3) Atendimento humano em andamento → silêncio (um humano atende) ───
  if (contact?.paused) {
    store.saveContact(from, nameFields);
    return;
  }

  // Cliente entrou na conversa (não é só boas-vindas): vira candidato à recuperação
  // e, por estar ativo agora, zera qualquer ciclo de cutucada pendente.
  store.saveContact(from, { ...nameFields, engaged: true, followupCount: 0 });

  // ─── 3.1) Menu numerado — resposta PRONTA, sem IA ───
  //
  // Vem antes da IA de propósito. "Qual é o prazo de envio?" tem a MESMA
  // resposta todo dia: gastar uma chamada de LLM nela custa segundos de espera
  // por mensagem, tokens, e abre a chance de o modelo inventar prazo ou
  // garantia que a loja não pratica.
  //
  // Só entra enquanto o cliente está navegando o menu (menuNode) e ainda não
  // pediu conversa livre (modoIA). Depois que ele escolhe "problema com a
  // compra", tudo passa direto para a IA.
  if (contact?.menuNode && !contact?.modoIA && /^\d{1,2}$/.test(trimmed)) {
    const escolha = menu.resolve(contact.menuNode, trimmed);

    if (!escolha) {
      await sender.send(
        from,
        `Não achei essa opção 🤔\n\n${menu.render(contact.menuNode)}`,
      );
      return;
    }

    // Submenu: só troca de nó e mostra as opções de lá.
    if (escolha.goto) {
      store.saveContact(from, { menuNode: escolha.goto });
      await sender.send(from, menu.render(escolha.goto));
      return;
    }

    // Tópico: fato do knowledge, na hora.
    if (escolha.topic) {
      const texto = menu.resposta(escolha.topic);
      if (texto) {
        await sender.send(from, texto);
        return;
      }
      // Tópico sem fato cadastrado cai na IA em vez de deixar o cliente no
      // vazio — mas avisa no log, porque é buraco no knowledge.js.
      console.warn(`[menu] tópico "${escolha.topic}" não existe no knowledge.js`);
    }

    if (escolha.action) {
      const feito = await acaoDoMenu(escolha.action, { from, pushName });
      if (feito) return;
      // ação desconhecida: segue para a IA
    }
  }
  // Foto sem legenda ainda é mensagem: o cliente manda a imagem do produto e
  // pergunta depois. Sem isto, a foto seria descartada antes de chegar na IA.
  if (!trimmed && !imagem) return;

  // ─── 4) Todo o resto → IA (conversa livre; ela transfere p/ atendente se preciso) ───
  try {
    const texto = trimmed || '(o cliente mandou uma foto sem escrever nada)';
    const answer = await ai.reply(from, texto, pushName, { imagem });
    await sender.send(from, answer);
  } catch (err) {
    console.error('[ai] erro ao responder:', err.response?.data || err.message);
    await sender.send(from, variator.error());
  }
}

/**
 * @param {object} event  Payload da Nerix { event, created_at, data }
 */
async function onNerixEvent(event) {
  const { event: name, data } = event;
  console.log(`[nerix] evento ${name} — pedido ${data?.order_number}`);

  switch (name) {
    case 'order.paid':
      // TODO: notificar cliente no WhatsApp que o pagamento foi confirmado
      break;
    case 'order.delivered':
      // TODO: enviar a(s) product_key(s) para o cliente
      break;
    case 'order.cancelled':
      // TODO: avisar cancelamento/expiração
      break;
    default:
      break;
  }
}

module.exports = { onIncomingMessage, onNerixEvent };
