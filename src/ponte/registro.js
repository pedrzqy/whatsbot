'use strict';

/**
 * Registro estruturado dos casos da ponte, uma linha JSON por evento.
 *
 * O sistema hoje guarda que HOUVE um problema — não qual problema, nem o que
 * resolveu. `at.historico` some quando o atendimento é podado (7 dias), o
 * console do painel corta a saída, e o WhatsApp do operador não guarda nada
 * consultável. Sem este arquivo não há o que analisar: nem para propor linha
 * nova de repertório, nem para saber se uma linha existente está resolvendo.
 *
 * JSONL e não JSON: cada linha é independente, então gravar é um append que
 * não pode corromper o que já está lá, e ler é `cat` no console do painel.
 *
 * O QUE NÃO ENTRA AQUI: nome, telefone e e-mail do cliente. Este arquivo
 * existe para ser lido por um analista — e num analista, dado de cliente é
 * peso sem uso. O `atendimentoId` amarra os eventos de um mesmo caso, que é
 * tudo de que a análise precisa.
 *
 * O texto do fornecedor entra em CHINÊS, cru. Aqui pode: é arquivo, não é
 * mensagem de WhatsApp. É justamente o dado que a análise precisa ver.
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.PONTE_DATA_DIR || path.join(__dirname, '..', '..', 'data');
const FILE = path.join(DATA_DIR, 'casos-ponte.jsonl');

/**
 * Tamanho a partir do qual o arquivo é rotacionado.
 *
 * O volume medido é de ~18 mensagens/dia, então isto leva anos para encher —
 * e é exatamente por isso que a rotação existe: ninguém vai lembrar de olhar,
 * e um disco cheio no Square Cloud derruba o bot inteiro por causa de um
 * arquivo de análise.
 */
const MAX_BYTES = 5 * 1024 * 1024;

function rotacionarSePreciso() {
  try {
    if (!fs.existsSync(FILE)) return;
    if (fs.statSync(FILE).size < MAX_BYTES) return;
    // Um anterior só. Guardar mais seria guardar o que ninguém vai ler.
    fs.renameSync(FILE, `${FILE}.1`);
  } catch (err) {
    console.warn('[ponte/registro] falha ao rotacionar:', err.message);
  }
}

/**
 * Anota um evento.
 *
 * Nunca lança. Um registro que derruba o atendimento seria o oposto do que ele
 * existe para fazer: o caso que mais interessa analisar é justamente o que deu
 * errado, e ele não pode dar errado por causa da anotação.
 *
 * @param {string} tipo  'recebido' | 'respondido' | 'encerrado'
 * @param {object} campos
 */
function anotar(tipo, campos = {}) {
  try {
    rotacionarSePreciso();
    fs.mkdirSync(DATA_DIR, { recursive: true });
    // `em` primeiro e ISO: é o campo pelo qual qualquer leitura vai ordenar, e
    // ISO ordena igual como texto e como data — um `sort` no console basta.
    const linha = JSON.stringify({ em: new Date().toISOString(), tipo, ...campos });
    fs.appendFileSync(FILE, linha + '\n', 'utf8');
  } catch (err) {
    console.warn('[ponte/registro] não anotei:', err.message);
  }
}

/**
 * Lê as últimas N linhas, já como objeto. Para o comando do operador.
 *
 * Lê o arquivo inteiro de propósito: com o teto de 5 MB isso é barato, e
 * qualquer leitura parcial de JSONL precisaria lidar com linha cortada ao
 * meio — complexidade que este volume não justifica.
 */
function ultimos(n = 50) {
  try {
    if (!fs.existsSync(FILE)) return [];
    return fs
      .readFileSync(FILE, 'utf8')
      .split('\n')
      .filter(Boolean)
      .slice(-n)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null; // linha truncada por queda no meio do append
        }
      })
      .filter(Boolean);
  } catch (err) {
    console.warn('[ponte/registro] não consegui ler:', err.message);
    return [];
  }
}

/**
 * Resumo dos últimos dias, para o operador saber se vale abrir o arquivo.
 *
 * O que ele quer saber numa linha: quanto está sendo resolvido sem ele, e o
 * que está caindo no colo dele mais do que devia.
 */
function resumo(dias = 7) {
  const corte = Date.now() - dias * 24 * 60 * 60 * 1000;
  const linhas = ultimos(5000).filter((l) => new Date(l.em).getTime() > corte);

  const porClasse = {};
  const porDesfecho = {};
  for (const l of linhas) {
    if (l.tipo === 'recebido') porClasse[l.classe] = (porClasse[l.classe] || 0) + 1;
    if (l.tipo === 'encerrado') porDesfecho[l.motivo] = (porDesfecho[l.motivo] || 0) + 1;
  }

  return { dias, eventos: linhas.length, porClasse, porDesfecho, arquivo: FILE };
}

module.exports = { anotar, ultimos, resumo, FILE };
