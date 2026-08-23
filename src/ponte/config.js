'use strict';

/**
 * Configuração da Ponte Taobao. Segue o padrão do src/config.js do bot:
 * tudo por variável de ambiente, com padrão seguro quando ausente.
 */

const num = (v, padrao) => (Number.isFinite(Number(v)) ? Number(v) : padrao);

module.exports = {
  // Liga/desliga a ponte inteira sem mexer no resto do bot.
  ativa: process.env.PONTE_ATIVA === 'true',

  // copiloto = tudo passa por aprovação humana antes de sair
  // autopiloto = envia sozinho, segura só o que a política marcar
  modo: process.env.PONTE_MODO === 'autopiloto' ? 'autopiloto' : 'copiloto',

  vendedor: {
    id: process.env.PONTE_SELLER_ID || 'vendedor-principal',
    // Título EXATO da conversa como aparece na lista de mensagens do app da Taobao.
    chatTitulo: process.env.PONTE_SELLER_CHAT_TITLE || '',
    // Fuso em que as janelas abaixo estão escritas. Brasília por padrão: a
    // janela vem da OBSERVAÇÃO do operador, e observar em fuso próprio evita
    // uma conversão a mais para errar.
    tz: process.env.PONTE_SELLER_TZ || 'America/Sao_Paulo',
    // Intervalos "HH:MM-HH:MM" separados por vírgula. Aceita mais de um porque
    // o fornecedor some no meio do dia. Intervalo não pode cruzar meia-noite —
    // divida em dois (ex.: "22:00-23:59,00:00-02:00").
    janelas:
      process.env.PONTE_SELLER_JANELAS ||
      // Compatibilidade com a config antiga de intervalo único.
      (process.env.PONTE_SELLER_INICIO && process.env.PONTE_SELLER_FIM
        ? `${process.env.PONTE_SELLER_INICIO}-${process.env.PONTE_SELLER_FIM}`
        // Para às 15:00 e volta às 17:30 (horário observado do fornecedor).
        // ATENÇÃO: se PONTE_SELLER_JANELAS estiver definida no Environment do
        // serviço, ela VENCE isto — mudar aqui não basta.
        : '00:00-15:00,17:30-23:59'),
  },

  fila: {
    // Atendimento sem resposta do fornecedor é liberado para o próximo da fila.
    // Sem isso, um vendedor que ignora uma pergunta trava a fila para sempre.
    timeoutMinutos: num(process.env.PONTE_TIMEOUT_MIN, 240),
    // Idas e vindas antes de o operador assumir. Passou disso, provavelmente travou.
    maxTurnos: num(process.env.PONTE_MAX_TURNOS, 6),
  },

  limites: {
    // Camada 1 — anti-flood por cliente.
    clientePorHora: num(process.env.PONTE_LIM_CLIENTE_HORA, 5),
    // Camada 2 — a que de fato reduz risco de banimento da conta Taobao.
    vendedorPorHora: num(process.env.PONTE_LIM_VENDEDOR_HORA, 10),
    // Camada 3 — teto absoluto do dia, rede de segurança contra bug em loop.
    vendedorPorDia: num(process.env.PONTE_LIM_VENDEDOR_DIA, 60),
    // Falhas seguidas do braço até abrir o disjuntor sozinho.
    falhasParaAbrir: num(process.env.PONTE_FALHAS_ABRIR, 3),
  },

  // Chave que o braço usa para autenticar nas rotas /ponte/braco/*.
  bracoApiKey: process.env.PONTE_BRACO_KEY || '',

  // URL do noVNC do braço. Vai junto no alerta de verificação: quando a
  // Taobao pede o slider não existe código para repassar (ela mede a
  // trajetória do arraste), então o operador precisa arrastar ele mesmo.
  vncUrl: process.env.PONTE_VNC_URL || '',

  operador: {
    // Número (só dígitos) que recebe alertas de captcha e fila travada.
    // Sem isto, o disjuntor abre e ninguém fica sabendo.
    numero: (process.env.PONTE_OPERADOR_NUMERO || '').replace(/\D/g, ''),
  },

  comercial: {
    // Multiplicador aplicado a preço em CNY antes de mostrar ao cliente.
    // 0 = NUNCA mostrar preço (padrão seguro — ver politica.js).
    markup: num(process.env.PONTE_MARKUP, 0),
    cnyBrl: num(process.env.PONTE_CNY_BRL, 0.78),
  },
};
