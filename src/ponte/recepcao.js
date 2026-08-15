'use strict';

/**
 * Recepção do pedido de código — sem passar pela IA.
 *
 * POR QUE NÃO USAR A IA: com BOT_AUTOREPLY=false o handlers retorna antes de
 * chamar ai.reply(), então a ferramenta pedir_codigo_fornecedor nunca seria
 * invocada e a ponte ficaria inerte — sem erro, sem log, só silêncio.
 *
 * E, mesmo com autoreply ligado, detectar aqui é melhor: o pedido é
 * estereotipado (foto + usuário), então não há julgamento a fazer. Regra
 * determinística não custa token, não alucina e não muda de ideia.
 *
 * O GATILHO É ESTREITO DE PROPÓSITO. Só dispara com algo que se parece de
 * verdade com usuário de conta: mistura letra e dígito, até 20 caracteres,
 * sozinho na mensagem. "oi", "obrigado" ou "quero um jogo" não disparam.
 *
 * PAREAMENTO: cliente costuma mandar a foto numa mensagem e o usuário na
 * seguinte (ou o contrário). Guardamos o que chegou primeiro por alguns
 * minutos esperando o par.
 */

const codigo = require('./codigo');
const cfg = require('./config');
const { dados, persist } = require('./estado');

/** Quanto tempo uma metade do pedido espera pela outra. */
const VALIDADE_MS = 10 * 60 * 1000;

function pendentes() {
  if (!dados.pendentes) dados.pendentes = {};
  return dados.pendentes;
}

function limparVencidos() {
  const p = pendentes();
  const agora = Date.now();
  let mudou = false;
  for (const [from, item] of Object.entries(p)) {
    if (agora - item.em > VALIDADE_MS) {
      delete p[from];
      mudou = true;
    }
  }
  if (mudou) persist();
}

/**
 * Decide o que fazer com uma mensagem recebida.
 *
 * @param {string} from    número do cliente
 * @param {string} texto   texto da mensagem (pode ser a legenda da foto)
 * @param {string|null} imagem  nome do arquivo salvo, se veio foto
 * @returns {{acao:'ignorar'}
 *          |{acao:'pedir', usuario:string, imagem:string|null}
 *          |{acao:'responder', mensagem:string}}
 */
function avaliar(from, texto, imagem) {
  if (!cfg.ativa) return { acao: 'ignorar' };
  // O operador tem os comandos dele; não entra pelo fluxo de cliente.
  if (from === cfg.operador.numero) return { acao: 'ignorar' };

  limparVencidos();

  const p = pendentes();
  const bruto = String(texto || '').trim();

  // O texto é um usuário? Aceita tanto puro ("rrrtsr223") quanto dentro de
  // frase curta ("meu usuario e rrrtsr223").
  const v = codigo.validarUsuario(bruto);
  const temMisturaLetraDigito = /[A-Za-z]/.test(bruto) && /\d/.test(bruto);
  const usuario = v.valido && temMisturaLetraDigito ? v.usuario : codigo.extrairUsuario(bruto);

  const guardado = p[from];

  // ── Caso 1: veio foto E usuário na mesma mensagem ──────────
  if (imagem && usuario) {
    delete p[from];
    persist();
    return { acao: 'pedir', usuario, imagem };
  }

  // ── Caso 2: veio usuário e já havia foto guardada ──────────
  if (usuario && guardado?.imagem) {
    delete p[from];
    persist();
    return { acao: 'pedir', usuario, imagem: guardado.imagem };
  }

  // ── Caso 3: veio foto e já havia usuário guardado ──────────
  if (imagem && guardado?.usuario) {
    const u = guardado.usuario;
    delete p[from];
    persist();
    return { acao: 'pedir', usuario: u, imagem };
  }

  // ── Caso 4: veio só o usuário ──────────────────────────────
  if (usuario) {
    p[from] = { usuario, imagem: null, em: Date.now() };
    persist();
    return {
      acao: 'responder',
      mensagem:
        'Anotei o usuário! Manda também o *print da tela de verificação* que eu ' +
        'peço o código pro fornecedor 👍',
    };
  }

  // ── Caso 5: veio só a foto ─────────────────────────────────
  // Só trata como pedido se o cliente já estava nesse assunto — foto solta de
  // quem está perguntando preço de jogo não é pedido de código.
  if (imagem && guardado) {
    p[from] = { usuario: guardado.usuario, imagem, em: Date.now() };
    persist();
    return {
      acao: 'responder',
      mensagem: 'Recebi o print! Agora me manda o *usuário da conta* (ex.: rrrtsr223).',
    };
  }

  return { acao: 'ignorar' };
}

/**
 * Marca que o cliente está no assunto "código", para o Caso 5 passar a valer.
 * Chamado quando o humano/IA identifica o contexto e quer abrir a janela.
 */
function abrirJanela(from) {
  const p = pendentes();
  p[from] = p[from] || { usuario: null, imagem: null, em: Date.now() };
  p[from].em = Date.now();
  persist();
}

/** Quantos pedidos estão pela metade agora (para o #fila). */
function emEspera() {
  limparVencidos();
  return Object.entries(pendentes()).map(([from, i]) => ({
    from,
    tem: i.usuario ? 'usuário' : i.imagem ? 'foto' : 'nada',
    desde: i.em,
  }));
}

module.exports = { avaliar, abrirJanela, emEspera, VALIDADE_MS };
