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

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
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

load();

module.exports = { dados, persist, persistAgora, proximoId };
