'use strict';

/**
 * Fila serial de atendimento — "um cliente por vez".
 *
 * Regra: no máximo UM atendimento 'ativo'. Enquanto ele está ativo, nenhuma
 * outra conversa fala com o fornecedor.
 *
 * Isso não é só rate limit — é o que torna o roteamento da resposta CORRETO.
 * Todos os clientes dividem o MESMO chat na Taobao, e o fornecedor responde
 * sem dizer a quem. Com atendimento serial, a resposta que chega pertence,
 * sem ambiguidade, ao cliente do atendimento ativo. Sem serialização seria um
 * chute — e chutar aqui significa mandar o preço de um cliente para outro.
 *
 * Concorrência: o bot roda em processo único (Square Cloud), então basta a
 * mesma corrente de promessas que o handlers.js já usa. Não há duas réplicas
 * disputando a fila.
 */

const { dados, persist, persistAgora, proximoId } = require('./estado');
const cfg = require('./config');

/** Serializa as operações da fila para não haver leitura-e-escrita entrelaçada. */
let corrente = Promise.resolve();
function comLock(fn) {
  const proxima = corrente.then(fn, fn);
  corrente = proxima.catch(() => {});
  return proxima;
}

const ativos = () => dados.atendimentos.filter((a) => a.estado === 'ativo');
const aguardando = () =>
  dados.atendimentos.filter((a) => a.estado === 'aguardando').sort((a, b) => a.posicao - b.posicao);

/** O atendimento em curso, se houver. */
function ativo() {
  return ativos()[0] || null;
}

function porId(id) {
  return dados.atendimentos.find((a) => a.id === id) || null;
}

/** Atendimento aberto (aguardando ou ativo) de um cliente. */
function doCliente(from) {
  return dados.atendimentos.find(
    (a) => a.from === from && (a.estado === 'aguardando' || a.estado === 'ativo')
  ) || null;
}

function ativar(at) {
  at.estado = 'ativo';
  at.iniciadoEm = Date.now();
  at.expiraEm = Date.now() + cfg.fila.timeoutMinutos * 60 * 1000;
  persistAgora();
  return at;
}

/**
 * Coloca o cliente na fila (ou reaproveita o lugar dele) e promove se puder.
 *
 * Idempotente: cliente que manda três perguntas seguidas não vira três
 * atendimentos — continua no mesmo lugar, com as perguntas acumuladas.
 *
 * @returns {Promise<{atendimento:object, ativo:boolean, aFrente:number}>}
 */
function entrar(from, nome) {
  return comLock(() => {
    let at = doCliente(from);

    if (!at) {
      at = {
        id: proximoId(),
        from,
        nome: nome || from,
        estado: 'aguardando',
        posicao: (dados.atendimentos.at(-1)?.posicao ?? 0) + 1,
        turnos: 0,
        criadoEm: Date.now(),
        iniciadoEm: null,
        expiraEm: null,
        historico: [],
        imagemPendente: null,
      };
      dados.atendimentos.push(at);
    }

    if (at.estado === 'ativo') {
      return { atendimento: at, ativo: true, aFrente: 0 };
    }

    if (!ativo()) {
      ativar(at);
      console.log(`[ponte/fila] ${from} promovido direto (fila vazia)`);
      return { atendimento: at, ativo: true, aFrente: 0 };
    }

    const aFrente = aguardando().filter((a) => a.posicao < at.posicao).length + 1;
    persist();
    console.log(`[ponte/fila] ${from} na espera — ${aFrente} na frente`);
    return { atendimento: at, ativo: false, aFrente };
  });
}

/**
 * Encerra o atendimento e promove o próximo.
 * @returns {Promise<object|null>} o atendimento promovido, ou null se a fila esvaziou
 */
function concluir(id, motivo) {
  return comLock(() => {
    const at = porId(id);
    if (!at || at.estado === 'concluido' || at.estado === 'expirado') return null;

    at.estado = motivo === 'expirado' ? 'expirado' : 'concluido';
    at.concluidoEm = Date.now();
    at.motivoFim = motivo;

    const proximo = aguardando()[0];
    if (!proximo) {
      persistAgora();
      console.log(`[ponte/fila] ${at.from} concluído (${motivo}) — fila vazia`);
      return null;
    }

    ativar(proximo);
    console.log(`[ponte/fila] ${at.from} concluído (${motivo}) → ${proximo.from} promovido`);
    return proximo;
  });
}

/** Soma um turno. Estourou o teto, o operador assume — provavelmente travou. */
function contarTurno(id) {
  const at = porId(id);
  if (!at) return { estourou: false, turnos: 0 };
  at.turnos += 1;
  persist();
  return { estourou: at.turnos >= cfg.fila.maxTurnos, turnos: at.turnos };
}

/** Registra uma troca no histórico do atendimento (contexto para o tradutor). */
function registrar(id, papel, origem, traduzido) {
  const at = porId(id);
  if (!at) return;
  at.historico.push({ papel, origem, traduzido, em: Date.now() });
  if (at.historico.length > 20) at.historico = at.historico.slice(-20);
  persist();
}

/**
 * Libera atendimentos vencidos. Sem isto, um fornecedor que simplesmente
 * ignora uma pergunta trava a fila inteira para sempre.
 * @returns {Promise<object[]>} atendimentos que venceram
 */
function expirarVencidos() {
  return comLock(async () => {
    const agora = Date.now();
    const vencidos = ativos().filter((a) => a.expiraEm && a.expiraEm < agora);
    return vencidos;
  }).then(async (vencidos) => {
    for (const v of vencidos) await concluir(v.id, 'expirado');
    return vencidos;
  });
}

/** Foto da fila, para o painel e para o comando do operador. */
function situacao() {
  const a = ativo();
  return {
    ativo: a && {
      id: a.id,
      cliente: a.nome,
      from: a.from,
      turnos: a.turnos,
      desde: a.iniciadoEm,
      expiraEm: a.expiraEm,
    },
    aguardando: aguardando().map((x, i) => ({
      id: x.id,
      posicao: i + 1,
      cliente: x.nome,
      from: x.from,
      desde: x.criadoEm,
    })),
  };
}

module.exports = {
  entrar,
  concluir,
  contarTurno,
  registrar,
  expirarVencidos,
  situacao,
  ativo,
  porId,
  doCliente,
};
