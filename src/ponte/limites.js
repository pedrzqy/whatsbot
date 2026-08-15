'use strict';

/**
 * Limites e disjuntor.
 *
 * Quatro camadas independentes. Cada uma protege de uma coisa diferente, e
 * qualquer uma sozinha barra o envio:
 *
 *   1. POR CLIENTE   — cliente floodando não consome a cota do fornecedor.
 *   2. POR FORNECEDOR— teto de ações/hora no chat da Taobao. É a camada que de
 *                      fato reduz risco de banimento da conta.
 *   3. DIÁRIO        — teto absoluto do dia. Rede de segurança contra bug em loop.
 *   4. DISJUNTOR     — congela tudo quando aparece verificação anti-bot.
 *
 * Os contadores vivem no arquivo de estado, não em memória: reinício do
 * container não pode zerar o limite e liberar uma rajada logo após incidente.
 */

const { dados, persist } = require('./estado');
const cfg = require('./config');

/** Incrementa um contador de janela e diz se estourou. */
function consumir(chave, teto, janelaMs) {
  const agora = Date.now();
  const atual = dados.limites[chave];

  if (!atual || agora - atual.inicio >= janelaMs) {
    dados.limites[chave] = { n: 1, inicio: agora };
    persist();
    return { permitido: true };
  }

  if (atual.n >= teto) {
    return {
      permitido: false,
      motivo: `limite "${chave}" atingido (${atual.n}/${teto})`,
      liberaEmSeg: Math.max(1, Math.ceil((atual.inicio + janelaMs - agora) / 1000)),
    };
  }

  atual.n += 1;
  persist();
  return { permitido: true };
}

/** Consulta sem consumir — para mostrar no painel/comando. */
function espiar(chave, teto, janelaMs) {
  const atual = dados.limites[chave];
  const valido = atual && Date.now() - atual.inicio < janelaMs;
  return { usado: valido ? atual.n : 0, teto };
}

const HORA = 60 * 60 * 1000;
const DIA = 24 * HORA;

// ── Camada 1 — por cliente ──────────────────────────────────────────

function checarCliente(from) {
  return consumir(`cliente:${from}`, cfg.limites.clientePorHora, HORA);
}

// ── Camadas 2 e 3 — fornecedor e teto diário ────────────────────────

/**
 * Cota de envio ao chat da Taobao. Chamar SÓ na hora de despachar de verdade:
 * consumir aqui e desistir depois desperdiça cota.
 */
function checarEnvio() {
  const d = disjuntor();
  if (d.estado === 'aberto') {
    return { permitido: false, motivo: `disjuntor aberto: ${d.motivo || 'verificação anti-bot pendente'}` };
  }

  const hora = consumir(`fornecedor:hora`, cfg.limites.vendedorPorHora, HORA);
  if (!hora.permitido) return hora;

  const hoje = new Date().toISOString().slice(0, 10);
  return consumir(`fornecedor:dia:${hoje}`, cfg.limites.vendedorPorDia, DIA);
}

function painel() {
  const hoje = new Date().toISOString().slice(0, 10);
  return {
    hora: espiar('fornecedor:hora', cfg.limites.vendedorPorHora, HORA),
    dia: espiar(`fornecedor:dia:${hoje}`, cfg.limites.vendedorPorDia, DIA),
  };
}

// ── Camada 4 — disjuntor ────────────────────────────────────────────

function disjuntor() {
  return dados.disjuntor;
}

/**
 * Congela a operação. Chamado quando o braço vê tela de verificação, ou
 * quando acumula falhas seguidas.
 *
 * Congelar é a resposta certa a captcha. Resolver por script acerta a posição
 * do slider e erra a biometria da trajetória (velocidade, aceleração, tremor)
 * — e cada tentativa falha é sinal de bot somado à conta. Parar e chamar um
 * humano custa 30 segundos; insistir custa a conta.
 *
 * @returns {boolean} true se ACABOU de abrir (para disparar o alerta uma vez só)
 */
function abrir(motivo, printPath) {
  const d = dados.disjuntor;
  if (d.estado === 'aberto') return false;

  d.estado = 'aberto';
  d.motivo = motivo;
  d.printPath = printPath || null;
  d.abertoEm = Date.now();
  persist();
  console.warn(`[ponte/disjuntor] ABERTO — ${motivo}`);
  return true;
}

/** Só um humano fecha, depois de resolver na mão no cloud phone. */
function fechar(quem) {
  const d = dados.disjuntor;
  d.estado = 'fechado';
  d.motivo = null;
  d.printPath = null;
  d.falhasSeguidas = 0;
  d.fechadoEm = Date.now();
  d.liberadoPor = quem || 'operador';
  persist();
  console.log(`[ponte/disjuntor] fechado por ${d.liberadoPor}`);
}

/**
 * Falha do braço. Depois de N seguidas, abre o disjuntor sozinho — falha em
 * série normalmente significa UI mudada ou conta sinalizada, e nos dois casos
 * continuar tentando piora.
 * @returns {{falhas:number, abriu:boolean}}
 */
function registrarFalha(detalhe, printPath) {
  const d = dados.disjuntor;
  d.falhasSeguidas = (d.falhasSeguidas || 0) + 1;
  persist();

  if (d.falhasSeguidas >= cfg.limites.falhasParaAbrir) {
    const abriu = abrir(`${d.falhasSeguidas} falhas seguidas do braço. Última: ${detalhe}`, printPath);
    return { falhas: d.falhasSeguidas, abriu };
  }
  return { falhas: d.falhasSeguidas, abriu: false };
}

function registrarSucesso() {
  if (dados.disjuntor.falhasSeguidas) {
    dados.disjuntor.falhasSeguidas = 0;
    persist();
  }
}

module.exports = {
  checarCliente,
  checarEnvio,
  painel,
  disjuntor,
  abrir,
  fechar,
  registrarFalha,
  registrarSucesso,
};
