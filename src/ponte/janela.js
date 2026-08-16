'use strict';

/**
 * Janela em que o fornecedor está online.
 *
 * DEFINIDA EM HORÁRIO DE BRASÍLIA, não da China — e isso é proposital. A
 * janela vem de OBSERVAÇÃO do operador ("ele responde das 00h às 15h30, some,
 * e volta 17h15"), não do horário comercial declarado de ninguém. Converter
 * para o fuso da China só adicionaria uma chance de errar a conta.
 *
 * Aceita VÁRIOS intervalos porque a realidade tem buraco no meio. Com um
 * intervalo contíguo só, o braço ficaria parado horas em que ele está online.
 *
 * Para referência: China é UTC+8, Brasília UTC-3 — 11h à nossa frente. A
 * janela 00:00–15:30 daqui é 11:00–02:30 lá.
 */

const cfg = require('./config');

/** "08:30" -> 510 (minutos desde a meia-noite). */
function paraMinutos(hhmm) {
  const [h, m] = String(hhmm).trim().split(':').map(Number);
  return (Number.isFinite(h) ? h : 0) * 60 + (Number.isFinite(m) ? m : 0);
}

/**
 * Converte "00:00-15:30,17:15-23:59" em [{de,ate}] em minutos.
 * Intervalo que cruza a meia-noite é rejeitado — divida em dois.
 */
function intervalos() {
  const bruto = cfg.vendedor.janelas || '';
  const lista = bruto
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      const [de, ate] = p.split('-');
      return { de: paraMinutos(de), ate: paraMinutos(ate) };
    })
    .filter((i) => Number.isFinite(i.de) && Number.isFinite(i.ate) && i.ate > i.de);

  // Sem configuração válida, assume online o dia inteiro: é melhor o braço
  // tentar e o limite de envios segurar do que ficar mudo por erro de digitação.
  return lista.length ? lista.sort((a, b) => a.de - b.de) : [{ de: 0, ate: 1439 }];
}

/** Minuto do dia no fuso configurado. */
function minutoAgora(data) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: cfg.vendedor.tz,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const p = Object.fromEntries(fmt.formatToParts(data).map((x) => [x.type, x.value]));
  // Em alguns fusos o formatador devolve "24" para meia-noite.
  const h = Number(p.hour) % 24;
  return h * 60 + Number(p.minute);
}

function doisDigitos(n) {
  return String(n).padStart(2, '0');
}

function comoHora(minutos) {
  return `${doisDigitos(Math.floor(minutos / 60))}h${doisDigitos(minutos % 60)}`;
}

/**
 * @returns {{aberta:boolean, esperaMinutos:number, proximaAbertura:Date, avisoCliente:string}}
 */
function estado(agora = new Date()) {
  const lista = intervalos();
  const atual = minutoAgora(agora);

  const dentro = lista.some((i) => atual >= i.de && atual <= i.ate);
  if (dentro) {
    return {
      aberta: true,
      esperaMinutos: 0,
      proximaAbertura: agora,
      // O cliente nunca fica sabendo de onde vem o código. Para ele é a Phaze
      // que gera, e é isso que a mensagem diz — sem "canal", sem "parceiro",
      // sem nada que sugira que existe alguém do outro lado.
      //
      // E sem "automaticamente", que estava aqui: descreve o processo como
      // máquina no número comercial, exatamente o que não pode. Passou porque
      // o teste procurava "automatico\b" e a palavra é "automaticamente" —
      // o regex foi corrigido junto.
      avisoCliente: 'Já estou pegando seu código. Só um instante 👍',
    };
  }

  // Próximo início: o primeiro que ainda vem hoje, senão o primeiro de amanhã.
  const proximoHoje = lista.find((i) => i.de > atual);
  const alvo = proximoHoje ? proximoHoje.de : lista[0].de;
  const espera = proximoHoje ? alvo - atual : 1440 - atual + alvo;

  return {
    aberta: false,
    esperaMinutos: espera,
    proximaAbertura: new Date(agora.getTime() + espera * 60 * 1000),
    // Fora da janela também não se explica o motivo: só o horário. "Sistema em
    // manutenção" é verdade suficiente e não abre porta para pergunta nenhuma.
    avisoCliente:
      `Recebi! O sistema de código volta por volta das ${comoHora(alvo)}. ` +
      `Você já está na fila e eu te mando assim que sair 👍`,
  };
}

/** Texto curto para o #fila do operador. */
function resumo(agora = new Date()) {
  const e = estado(agora);
  if (e.aberta) return '🟢 online';
  const h = Math.floor(e.esperaMinutos / 60);
  const m = e.esperaMinutos % 60;
  return `🌙 offline — volta em ${h ? h + 'h' : ''}${m ? doisDigitos(m) : ''}`.trim();
}

module.exports = { estado, resumo, intervalos };
