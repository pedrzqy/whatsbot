'use strict';

/**
 * Cadência humana.
 *
 * Não é enfeite: a Taobao olha ritmo. Intervalos idênticos entre ações,
 * digitação instantânea e atividade sem pausa são o que separa um script de
 * uma pessoa. Um braço que age como robô toma verificação em dias; um que
 * respeita cadência dura meses.
 */

const cfg = require('./config');

const rand = (min, max) => Math.floor(min + Math.random() * (max - min));

/** Intervalo genérico entre ações. Nunca use setTimeout fixo no fluxo. */
const ms = (min = 800, max = 2400) => rand(min, max);

/** Pausa curta, para delay de clique. */
const msCurto = () => rand(40, 140);

/** Delay por tecla. 45–140ms cobre a faixa de digitação humana normal. */
const msTecla = () => rand(45, 140);

/**
 * Quebra o texto em pedaços para digitar em etapas.
 *
 * Só faz sentido em texto longo. Um usuário de 8 caracteres digitado em dois
 * pedaços não parece mais humano — parece um campo recebendo texto pela
 * metade, que é justamente onde um <pre contenteditable> costuma engasgar.
 * Abaixo de 20 caracteres (todo usuário e todo código), vai inteiro.
 */
function blocos(texto) {
  if (texto.length <= 20) return [texto];

  const out = [];
  let i = 0;
  while (i < texto.length) {
    const n = rand(6, 14);
    out.push(texto.slice(i, i + n));
    i += n;
  }
  return out;
}

// ── Teto local de envios ─────────────────────────────────────
// O bot já limita do lado dele. Esta é a segunda trava, para o caso de o braço
// entrar em laço por bug e martelar o chat.
const historico = [];

function podeEnviar() {
  const agora = Date.now();
  while (historico.length && agora - historico[0] > 3600_000) historico.shift();

  if (historico.length >= cfg.envioPorHora) {
    const liberaEm = Math.ceil((3600_000 - (agora - historico[0])) / 1000);
    return { pode: false, motivo: `teto local de ${cfg.envioPorHora} envios/hora; libera em ${liberaEm}s` };
  }
  return { pode: true, motivo: '' };
}

const registrarEnvio = () => historico.push(Date.now());

/**
 * Intervalo entre varreduras do chat.
 * Ler de 5 em 5 segundos é comportamento de bot e não ganha nada: o fornecedor
 * responde em minutos ou horas, não em segundos.
 */
const intervaloLeitura = () => rand(cfg.lerMinSeg, cfg.lerMaxSeg) * 1000;

/** Pausa entre tarefas — simula o operador fazendo outra coisa. */
const pausaLonga = () => rand(6000, 18000);

module.exports = {
  ms,
  msCurto,
  msTecla,
  blocos,
  podeEnviar,
  registrarEnvio,
  intervaloLeitura,
  pausaLonga,
};
