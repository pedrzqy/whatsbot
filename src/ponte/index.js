'use strict';

/**
 * Ponte Taobao — relay de código de verificação.
 *
 * O fluxo real é curto:
 *
 *   Cliente manda FOTO + USUÁRIO (ex.: rrrtsr223)
 *     → fila serial (um cliente por vez)
 *     → braço envia foto e usuário no chat da Taobao
 *     → fornecedor responde CÓDIGO de 4-8 dígitos
 *     → código vai direto ao cliente
 *
 * Tradução NÃO está no caminho principal: usuário e código são alfanuméricos,
 * não há o que traduzir. Ela só entra quando o fornecedor responde em chinês —
 * que é sempre caso de problema (conta não existe, aguarde, etc.) e por isso
 * sempre passa por um humano.
 *
 * A fila serial não é só rate limit: todos os clientes dividem o MESMO chat, e
 * o fornecedor não diz a quem responde. Com um atendimento ativo por vez, o
 * código que chega pertence sem ambiguidade a quem está na vez. Entregar código
 * ao cliente errado dá acesso à conta de terceiro — é a falha que não pode
 * acontecer.
 */

const cfg = require('./config');
const fila = require('./fila');
const limites = require('./limites');
const codigo = require('./codigo');
const tradutor = require('./tradutor');
const janela = require('./janela');
const midia = require('./midia');
const { dados, persist, persistAgora, proximoId } = require('./estado');
const sender = require('../sender');

async function alertar(texto, imagem) {
  if (!cfg.operador.numero) {
    console.warn('[ponte] alerta sem destino (defina PONTE_OPERADOR_NUMERO):', texto);
    return;
  }
  try {
    await sender.send(cfg.operador.numero, texto, imagem ? { image: imagem } : {});
  } catch (err) {
    console.error('[ponte] falha ao alertar operador:', err.message);
  }
}

// ============================================================
// SENTIDO 1 — cliente pede o código
// ============================================================

/**
 * Chamado pela ferramenta `pedir_codigo_fornecedor` do ai.js.
 *
 * @param {string} from        número do cliente
 * @param {string} nome        nome do cliente
 * @param {string} usuarioBruto texto que o cliente mandou como usuário
 * @param {string|null} imagemPath  foto do print, se veio
 * @returns {Promise<{aceito:boolean, mensagem:string}>}
 */
async function pedirCodigo(from, nome, usuarioBruto, imagemPath = null) {
  if (!cfg.ativa) {
    return { aceito: false, mensagem: 'O canal com o fornecedor está desativado agora.' };
  }

  const d = limites.disjuntor();
  if (d.estado === 'aberto') {
    await alertar(`⚠️ ${nome} pediu código com a ponte congelada. Fila parada.`);
    return {
      aceito: false,
      mensagem:
        'Nosso canal está passando por uma verificação neste momento. ' +
        'Já estou resolvendo e te mando o código em seguida 🙏',
    };
  }

  // Valida ANTES de gastar cota e ocupar a fila serial. Se o cliente mandou o
  // usuário dentro de uma frase, tenta extrair; se ficar ambíguo, pergunta em
  // vez de adivinhar — mandar usuário errado queima uma vaga na fila à toa.
  const v = codigo.validarUsuario(usuarioBruto);
  const usuario = v.valido ? v.usuario : codigo.extrairUsuario(usuarioBruto);

  if (!usuario) {
    return {
      aceito: false,
      mensagem:
        'Preciso do usuário da conta exatamente como aparece na tela — só ele, ' +
        'sem mais nada junto (algo tipo *rrrtsr223*). Pode mandar?',
    };
  }

  const lim = limites.checarCliente(from);
  if (!lim.permitido) {
    return {
      aceito: false,
      mensagem:
        'Já pedi vários códigos pra você agora há pouco e o fornecedor atende um por vez. ' +
        'Deixa eu esperar os anteriores voltarem 👍',
    };
  }

  const { atendimento, ativo, aFrente } = await fila.entrar(from, nome);
  atendimento.usuario = usuario;
  if (imagemPath) atendimento.imagemPendente = imagemPath;
  persistAgora();

  if (!ativo) {
    return {
      aceito: true,
      mensagem:
        `Anotei! O fornecedor libera um código por vez e tem ${aFrente} ` +
        `${aFrente === 1 ? 'pessoa' : 'pessoas'} na frente. Assim que chegar a sua vez ` +
        `eu peço e te mando 👍`,
    };
  }

  await despachar(atendimento);
  return { aceito: true, mensagem: janela.estado().avisoCliente };
}

/** Cria a tarefa do braço. Sem tradução: usuário é alfanumérico. */
async function despachar(atendimento) {
  if (!atendimento.usuario) {
    await alertar(`⚠️ Atendimento de *${atendimento.nome}* sem usuário definido. Pulei.`);
    return;
  }

  const tarefa = {
    id: proximoId(),
    atendimentoId: atendimento.id,
    tipo: 'pedir_codigo',
    usuario: atendimento.usuario,
    imagemPath: atendimento.imagemPendente || null,
    estado: cfg.modo === 'copiloto' ? 'aguardando_aprovacao' : 'pendente',
    agendadaPara: janela.estado().proximaAbertura.getTime(),
    tentativas: 0,
    ultimoErro: null,
  };

  dados.tarefas.push(tarefa);
  atendimento.imagemPendente = null;
  persistAgora();

  if (cfg.modo === 'copiloto') {
    await alertar(
      `📋 *Ponte — liberar envio*\n\n` +
        `Cliente: *${atendimento.nome}*\n` +
        `Usuário: \`${tarefa.usuario}\`\n` +
        `Foto: ${tarefa.imagemPath ? 'sim' : 'NÃO'}\n\n` +
        `*#ok ${tarefa.id}* para mandar ao fornecedor · *#nao ${tarefa.id}* para descartar`,
    );
  }
}

// ============================================================
// SENTIDO 2 — fornecedor responde
// ============================================================

/**
 * Chamado pelo braço com uma mensagem NOVA do fornecedor.
 *
 * O braço só reporta o que veio DEPOIS da marca d'água registrada no envio —
 * nunca varre o histórico. Sem isso, os meses de conversa antiga na tela
 * virariam centenas de "códigos novos" na primeira execução.
 */
async function receberDoFornecedor(entrada) {
  const at = fila.ativo();
  if (!at) {
    await alertar(
      `📨 Fornecedor mandou algo sem ninguém na vez:\n\n"${entrada.texto}"\n\n` +
        `Provavelmente resposta atrasada. Não entreguei a ninguém.`,
    );
    return;
  }

  const c = codigo.classificar(entrada.texto);

  if (c.tipo === 'codigo') {
    await entregarCodigo(at, c.codigo);
    return;
  }

  // Não é código: é problema. Traduz só para o operador entender e decidir.
  let traduzido = entrada.texto;
  try {
    const t = await tradutor.paraCliente(entrada.texto, at.historico || []);
    traduzido = t.traducao;
  } catch {
    traduzido = '(não consegui traduzir)';
  }

  const aprovacao = {
    id: proximoId(),
    atendimentoId: at.id,
    cliente: at.nome,
    from: at.from,
    origem: entrada.texto,
    texto: traduzido,
    criadoEm: Date.now(),
  };
  dados.aprovacoes.push(aprovacao);
  persistAgora();

  await alertar(
    `⚠️ *Fornecedor não mandou código*\n\n` +
      `Cliente: *${at.nome}* · usuário \`${at.usuario}\`\n\n` +
      `*Ele disse:* ${entrada.texto}\n` +
      `*Tradução:* ${traduzido}\n\n` +
      `*#enviar ${aprovacao.id}* manda essa explicação ao cliente\n` +
      `*#editar ${aprovacao.id} <texto>* · *#nao ${aprovacao.id}* descarta`,
    entrada.printPath,
  );
}

/** Entrega o código ao cliente, encerra a vez e chama o próximo. */
async function entregarCodigo(atendimento, cod) {
  await sender.send(
    atendimento.from,
    `Chegou o código da sua conta:\n\n*${cod}*\n\n` +
      `Digita ele na tela de verificação. Se der erro ou expirar, me avisa que peço outro 👍`,
  );

  console.log(`[ponte] código ${cod} entregue a ${atendimento.from} (${atendimento.usuario})`);
  limites.registrarSucesso();

  await fila.concluir(atendimento.id, 'codigo_entregue');
  await promoverProximo();
}

/** Depois que a fila anda, despacha a vez do próximo. */
async function promoverProximo() {
  const at = fila.ativo();
  if (!at || !at.usuario) return;

  await sender.send(at.from, 'Chegou sua vez! Já estou pedindo o código ao fornecedor 👍');
  await despachar(at);
}

// ============================================================
// Fila de tarefas do braço
// ============================================================

function proximaTarefa() {
  const agora = Date.now();
  const t = dados.tarefas.find((x) => x.estado === 'pendente' && x.agendadaPara <= agora);
  if (!t) return null;
  t.estado = 'executando';
  t.tentativas += 1;
  persistAgora();

  // O braço precisa da URL da foto, não do nome do arquivo: ele roda noutra máquina.
  return {
    id: t.id,
    tipo: t.tipo,
    usuario: t.usuario,
    imagem: t.imagemPath || null,
    tentativa: t.tentativas,
  };
}

async function resultadoTarefa(id, ok, erro, printPath) {
  const t = dados.tarefas.find((x) => x.id === id);
  if (!t) return { ok: false, motivo: 'tarefa desconhecida' };

  if (ok) {
    t.estado = 'concluida';
    limites.registrarSucesso();
    persistAgora();
    return { ok: true };
  }

  const desistir = t.tentativas >= 3;
  t.estado = desistir ? 'falhou' : 'pendente';
  t.ultimoErro = erro || 'sem detalhe';
  persistAgora();

  const { abriu } = limites.registrarFalha(erro || 'falha no envio', printPath);
  if (abriu) {
    await alertar(
      `🛑 *Ponte congelada*\n\nO braço falhou várias vezes seguidas.\n` +
        `Último erro: ${erro}\n\nVê o que houve e responde *#liberar*.`,
      printPath,
    );
  } else if (desistir) {
    const at = fila.porId(t.atendimentoId);
    if (at) {
      await sender.send(
        at.from,
        'Não consegui falar com o fornecedor agora. Já avisei nossa equipe e te retorno 🙏',
      );
    }
    await alertar(`⚠️ Desisti de um envio após 3 tentativas.\nErro: ${erro}`, printPath);
  }

  return { ok: true, desistiu: desistir };
}

/**
 * O braço viu tela de verificação. Congela e chama humano.
 *
 * Sem tentativa automática de propósito: o slider da Taobao avalia a trajetória
 * do arraste, não só a posição final. Script acerta a posição e falha a
 * biometria — e tentativa falha é sinal de bot somado à conta.
 */
async function bloqueioDetectado(motivo, printPath) {
  if (!limites.abrir(motivo, printPath)) return; // já estava aberto

  const esperando = fila.situacao().aguardando.length;
  await alertar(
    `🛑 *Verificação da Taobao*\n\n${motivo}\n\n` +
      `Ponte congelada. ${esperando} cliente(s) na fila.\n\n` +
      `1. Abre o chat da Taobao\n2. Resolve a verificação na mão\n3. Responde *#liberar*`,
    printPath,
  );
}

// ============================================================
// Manutenção
// ============================================================

async function tick() {
  try {
    const vencidos = await fila.expirarVencidos();
    for (const v of vencidos) {
      await sender.send(
        v.from,
        'O fornecedor ainda não devolveu seu código. Já cobrei de novo — ' +
          'se preferir, posso te passar pra um atendente 👍',
      );
      await alertar(`⏱️ Atendimento de *${v.nome}* (\`${v.usuario}\`) expirou sem código.`);
    }
    if (vencidos.length) await promoverProximo();
  } catch (err) {
    console.error('[ponte/tick] erro:', err.message);
  }
}

function iniciar() {
  if (!cfg.ativa) {
    console.log('[ponte] desativada (PONTE_ATIVA != true)');
    return;
  }
  if (!cfg.vendedor.chatTitulo) {
    console.warn('[ponte] PONTE_SELLER_CHAT_TITLE vazio — o braço não acha o chat.');
  }
  console.log(`[ponte] ativa · modo ${cfg.modo} · fornecedor ${cfg.vendedor.chatTitulo}`);
  setInterval(tick, 60 * 1000).unref();
}

const ativa = () => cfg.ativa;
const salvarImagem = (base64, mimetype) => midia.salvar(base64, mimetype);

module.exports = {
  pedirCodigo,
  receberDoFornecedor,
  entregarCodigo,
  proximaTarefa,
  resultadoTarefa,
  bloqueioDetectado,
  promoverProximo,
  alertar,
  iniciar,
  tick,
  ativa,
  salvarImagem,
};
