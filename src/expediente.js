'use strict';

/**
 * Quando existe GENTE do outro lado.
 *
 * O bot atende 24h e continua atendendo — isto não é um portão, é uma
 * PROMESSA. O `falar_com_atendente` respondia "um atendente humano vai
 * continuar o atendimento em instantes" a qualquer hora, e às 3h da manhã isso
 * é mentira: o cliente fica acordado esperando alguém que só vê a mensagem às
 * 9h. Promessa quebrada custa mais que demora avisada.
 *
 * A ponte já tinha o conceito de janela (a do fornecedor). O atendimento não
 * tinha nenhum, e é o lado em que existe uma pessoa de verdade.
 */

const config = require('./config');

/** Hora em Brasília (UTC-3, sem horário de verão desde 2019). */
function agoraBRT(quando = Date.now()) {
  const d = new Date(quando);
  // Desloca o instante e lê em UTC: `getUTCDay` depois disso já dá o dia certo
  // em Brasília, o que uma leitura local não daria num servidor em outro fuso.
  const brt = new Date(d.getTime() - 3 * 3600_000);
  return { hora: brt.getUTCHours(), minuto: brt.getUTCMinutes(), dia: brt.getUTCDay() };
}

/** Tem alguém para assumir agora? */
function aberto(quando = Date.now()) {
  const cfg = config.atendente;
  const { hora, dia } = agoraBRT(quando);
  if (!cfg.dias.includes(dia)) return false;
  return hora >= cfg.inicioHora && hora < cfg.fimHora;
}

const DIAS = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];

/**
 * Quando o próximo atendente aparece, em palavras que o cliente entende.
 *
 * "amanhã de manhã" e não "em 9 horas": ninguém converte horas de cabeça no
 * meio de um problema, e o que ele quer saber é se dá para dormir.
 */
function quandoVolta(quando = Date.now()) {
  const cfg = config.atendente;
  const { hora, dia } = agoraBRT(quando);

  // Hoje ainda abre.
  if (cfg.dias.includes(dia) && hora < cfg.inicioHora) {
    return `hoje a partir das ${String(cfg.inicioHora).padStart(2, '0')}h`;
  }

  // Procura o próximo dia com atendimento, até uma semana à frente.
  for (let i = 1; i <= 7; i++) {
    const proximo = (dia + i) % 7;
    if (!cfg.dias.includes(proximo)) continue;
    const quandoTxt = i === 1 ? 'amanhã' : `${DIAS[proximo]}`;
    return `${quandoTxt} a partir das ${String(cfg.inicioHora).padStart(2, '0')}h`;
  }

  // Nenhum dia configurado. Não inventa horário que não existe.
  return 'assim que abrirmos';
}

/**
 * A frase que o cliente lê quando pede uma pessoa.
 *
 * Uma só, montada aqui, porque ela sai por três caminhos diferentes (menu,
 * ferramenta da IA, "conta o problema") e antes cada um escrevia a sua — foi
 * assim que os três passaram a prometer coisas diferentes para a mesma
 * situação.
 */
function promessaDeAtendimento(quando = Date.now()) {
  return aberto(quando)
    ? 'Já estou chamando um atendente pra continuar com você 🧑‍💼'
    : `Já anotei tudo aqui 👍 Um atendente te responde ${quandoVolta(quando)}.`;
}

module.exports = { aberto, quandoVolta, promessaDeAtendimento, agoraBRT };
