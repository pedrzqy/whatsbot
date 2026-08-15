'use strict';

/**
 * Janela de atendimento do fornecedor chinês.
 *
 * O fuso é um problema de PRODUTO, não de código. China é UTC+8, Brasília é
 * UTC-3: 11 horas de diferença, a China na frente. Quando é 10h em SP, são 21h
 * em Guangzhou. Quando é 15h aqui, são 2h da madrugada lá.
 *
 * Ou seja: TODA pergunta que chega no horário comercial brasileiro cai na
 * madrugada chinesa. A ponte não conserta isso — ela é honesta com o cliente
 * sobre o prazo e dispara no momento certo.
 *
 * Janela útil do vendedor (09h–22h na China) vista de Brasília: 22h às 11h.
 */

const cfg = require('./config');

/** Hora e minuto atuais no fuso do vendedor, sem depender de biblioteca. */
function agoraNoVendedor(agora) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: cfg.vendedor.tz,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const partes = Object.fromEntries(fmt.formatToParts(agora).map((p) => [p.type, p.value]));
  return { hora: Number(partes.hour), minuto: Number(partes.minute) };
}

/** Hora local do cliente (Brasília), formatada "HHhMM". */
function horaEmBrasilia(data) {
  return new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
    .format(data)
    .replace(':', 'h');
}

function minutosDe(hhmm) {
  const [h, m] = String(hhmm).split(':').map(Number);
  return h * 60 + (m || 0);
}

/**
 * @returns {{aberta:boolean, esperaMinutos:number, proximaAbertura:Date, avisoCliente:string}}
 */
function estado(agora = new Date()) {
  const { hora, minuto } = agoraNoVendedor(agora);
  const atual = hora * 60 + minuto;
  const inicio = minutosDe(cfg.vendedor.inicio);
  const fim = minutosDe(cfg.vendedor.fim);

  if (atual >= inicio && atual <= fim) {
    return {
      aberta: true,
      esperaMinutos: 0,
      proximaAbertura: agora,
      avisoCliente:
        'Já estou falando com o fornecedor na China sobre isso. Assim que ele responder eu te aviso aqui 👍',
    };
  }

  // Minutos até a próxima abertura (hoje se ainda não passou, senão amanhã).
  const espera = atual < inicio ? inicio - atual : 24 * 60 - atual + inicio;
  const proxima = new Date(agora.getTime() + espera * 60 * 1000);

  const mesmoDiaBR =
    new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit' }).format(proxima) ===
    new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit' }).format(agora);

  return {
    aberta: false,
    esperaMinutos: espera,
    proximaAbertura: proxima,
    avisoCliente:
      `Anotado! O fornecedor fica na China (11h na nossa frente) e agora está fora do expediente. ` +
      `Sua pergunta já está na fila e vai pra ele ${mesmoDiaBR ? 'hoje' : 'amanhã'} por volta das ` +
      `${horaEmBrasilia(proxima)} no nosso horário. Te aviso assim que ele responder 👍`,
  };
}

module.exports = { estado, horaEmBrasilia };
