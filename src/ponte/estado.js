'use strict';

/**
 * Estado da ponte, persistido em arquivo JSON — mesma abordagem do store.js.
 *
 * Não entra Postgres aqui de propósito: o volume é de dezenas de atendimentos
 * por dia, o deploy é Square Cloud com volume em /app/data, e trocar a infra
 * inteira por causa de uma fila pequena seria pagar caro por nada.
 *
 * Guarda: fila de atendimentos, contadores de limite e estado do disjuntor.
 */

const fs = require('fs');
const path = require('path');

// PONTE_DATA_DIR existe para o teste NÃO escrever no estado de verdade.
//
// Sem ela, teste-ponte.js gravava no mesmo data/ponte.json da produção: rodar
// o teste no servidor apagaria a fila de quem está esperando código. E mesmo
// na máquina local ele herdava o que a execução anterior deixou — os
// contadores de limite sobreviviam à limpeza do teste, e daí um cenário
// passava ou falhava conforme a ordem em que as coisas rodaram.
const DATA_DIR = process.env.PONTE_DATA_DIR || path.join(__dirname, '..', '..', 'data');
const FILE = path.join(DATA_DIR, 'ponte.json');

/**
 * @typedef {object} Atendimento
 * @property {string} id
 * @property {string} from          número do cliente (só dígitos)
 * @property {string} nome
 * @property {'aguardando'|'ativo'|'concluido'|'expirado'} estado
 * @property {number} posicao       ordem de chegada
 * @property {number} turnos        idas e vindas já feitas
 * @property {number} criadoEm
 * @property {number|null} iniciadoEm
 * @property {number|null} expiraEm
 * @property {Array<{papel:'cliente'|'vendedor', origem:string, traduzido:string, em:number}>} historico
 * @property {string|null} imagemPendente  caminho da foto ainda não enviada
 */

/**
 * @typedef {object} Tarefa
 * @property {string} id
 * @property {string} atendimentoId
 * @property {'enviar_texto'|'enviar_texto_e_foto'} tipo
 * @property {string} textoZh
 * @property {string|null} imagemPath
 * @property {'pendente'|'executando'|'concluida'|'falhou'} estado
 * @property {number} agendadaPara   não executar antes disto (janela do fornecedor)
 * @property {number} tentativas
 * @property {string|null} ultimoErro
 */

/** @type {{atendimentos:Atendimento[], tarefas:Tarefa[], limites:Record<string,{n:number,inicio:number}>, disjuntor:object, seq:number}} */
let dados = {
  atendimentos: [],
  tarefas: [],
  /** Respostas do fornecedor seguradas para revisão humana antes de ir ao cliente. */
  aprovacoes: [],
  /**
   * Quando cada mensagem foi descartada como ruído (só os timestamps).
   *
   * Existe para o descarte não ser invisível. Um classificador que come a coisa
   * errada CALADO não deixa rastro nenhum: a mensagem some, ninguém é avisado, e
   * o único sintoma é um cliente que espera para sempre. O #fila mostra o número,
   * e um salto nele é o que faz alguém desconfiar da regra.
   *
   * Só o horário, sem o texto: o que é descartado vem em chinês, e guardar para
   * exibir depois seria guardar algo que não pode sair no WhatsApp.
   */
  ignorados: [],
  limites: {},
  disjuntor: { estado: 'fechado', motivo: null, printPath: null, falhasSeguidas: 0, abertoEm: null },
  seq: 0,
};

let saveTimer = null;

function load() {
  try {
    if (fs.existsSync(FILE)) {
      const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
      if (raw && typeof raw === 'object') {
        dados = { ...dados, ...raw };
        // Poda atendimentos velhos para o arquivo não crescer sem fim.
        const limite = Date.now() - 7 * 24 * 60 * 60 * 1000;
        dados.atendimentos = dados.atendimentos.filter(
          (a) => a.estado === 'aguardando' || a.estado === 'ativo' || a.criadoEm > limite
        );
        // Tarefa que ficou 'executando' num restart nunca teria dono: o braço
        // que a pegou morreu junto. Devolve para a fila em vez de perder o envio.
        dados.tarefas = (dados.tarefas || []).filter((t) => t.estado === 'pendente' || t.estado === 'executando');
        for (const t of dados.tarefas) if (t.estado === 'executando') t.estado = 'pendente';
      }
      console.log(`[ponte] estado carregado: ${dados.atendimentos.length} atendimento(s)`);
    }
  } catch (err) {
    console.error('[ponte] falha ao carregar estado:', err.message);
  }
}

function persist() {
  if (saveTimer) return; // debounce, igual ao store.js
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(FILE, JSON.stringify(dados), 'utf8');
    } catch (err) {
      console.error('[ponte] falha ao salvar estado:', err.message);
    }
  }, 400);
}

/** Grava imediatamente. Usado antes de operações críticas (envio ao fornecedor). */
function persistAgora() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(dados), 'utf8');
  } catch (err) {
    console.error('[ponte] falha ao salvar estado:', err.message);
  }
}

/**
 * Id curto — um número e pronto.
 *
 * O operador digita isto no celular, às vezes com o cliente esperando:
 * `#ok 7` sai numa tacada, `#ok at_msv3a1bf_12` obriga a selecionar e colar,
 * e errar um caractere devolve "não achei a tarefa".
 *
 * O contador é único para atendimento, tarefa e aprovação, então nunca há dois
 * itens com o mesmo número — e ele nunca zera, nem em restart, porque vive no
 * estado persistido junto com as tarefas que o referenciam.
 */
function proximoId() {
  dados.seq += 1;
  persist();
  return String(dados.seq);
}

// ── Contador de descartes ───────────────────────────────────

const DIA = 24 * 60 * 60 * 1000;

/**
 * Anota que uma mensagem foi descartada como ruído.
 *
 * Poda em 7 dias na própria escrita para o arquivo não crescer sem fim. Sete e
 * não trinta porque é a janela em que o número ainda diz alguma coisa: "400
 * descartados desde sempre" não faz ninguém olhar duas vezes, "12 hoje" faz.
 */
function registrarIgnorado(agora = Date.now()) {
  if (!Array.isArray(dados.ignorados)) dados.ignorados = [];
  dados.ignorados.push(agora);
  dados.ignorados = dados.ignorados.filter((ts) => ts > agora - 7 * DIA);
  persist();
}

/** @returns {{hoje:number, semana:number, ultimoEm:number|null}} */
function contarIgnorados(agora = Date.now()) {
  const lista = Array.isArray(dados.ignorados) ? dados.ignorados : [];
  return {
    hoje: lista.filter((ts) => ts > agora - DIA).length,
    semana: lista.length,
    ultimoEm: lista.length ? Math.max(...lista) : null,
  };
}

// ── Modo teste, POR NÚMERO ──────────────────────────────────
//
// Era um objeto só (`{ate}`) porque só existia um operador. Com dois, o global
// vazava: o operador A ligava o #teste e as mensagens normais do operador B
// passavam a entrar como se fossem de cliente — ele perderia os alertas
// achando que o bot enlouqueceu.
//
// Agora é um mapa `{ [numero]: {ate} }`. As três funções abaixo são o único
// caminho de leitura e escrita, para o formato não voltar a ser interpretado
// em quatro arquivos diferentes.

/** Aceita o formato ANTIGO ({ate} solto) sem perder o teste em andamento. */
function testes() {
  const t = dados.testeOperador;
  if (!t) return {};
  // Formato antigo: um {ate} sem número. Some depois de vencer, e vencer leva
  // no máximo 30 min — não vale código de migração, só não estourar aqui.
  if (typeof t.ate === 'number') return { __legado: t };
  return t;
}

/** O modo teste está valendo para ESTE número agora? */
function emTeste(numero) {
  const t = testes();
  const meu = t[String(numero)] || t.__legado;
  return Boolean(meu && meu.ate > Date.now());
}

/** Liga (ms > 0) ou desliga (ms = 0) o modo teste de um número. */
function marcarTeste(numero, ms) {
  const t = { ...testes() };
  delete t.__legado; // qualquer escrita já migra o formato

  if (ms > 0) t[String(numero)] = { ate: Date.now() + ms };
  else delete t[String(numero)];

  dados.testeOperador = Object.keys(t).length ? t : null;
  persistAgora();
}

load();

module.exports = {
  dados,
  persist,
  persistAgora,
  proximoId,
  emTeste,
  marcarTeste,
  registrarIgnorado,
  contarIgnorados,
};
