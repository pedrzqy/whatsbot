'use strict';

/**
 * BASE DE CONHECIMENTO da loja (FATOS enxutos — a IA reescreve com naturalidade).
 * Enquadramento Phaze Games: sempre positivo, sem termos técnicos, nada como desvantagem.
 */

module.exports = {
  prazo_envio:
    'Entrega digital e automática após o pagamento, normalmente em até 30 min. Pix cai na hora; ' +
    'os dados chegam no WhatsApp e no e-mail da compra.',

  garantia:
    'Nintendo Switch tem garantia VITALÍCIA (joga sem interrupção). Steam: 30 dias. Tudo 100% original, com suporte.',

  pagamento: 'Pix e cartão, no site oficial (checkout seguro).',

  troca:
    'Produto digital: sem troca/devolução após a entrega. Qualquer problema de acesso, a equipe resolve na garantia.',

  restricoes: 'Não alterar senha/dados da conta recebida nem repassar a terceiros.',

  // PlayStation saiu do catálogo (17/08/2026). O fato foi removido de
  // propósito, e não só escondido do menu: enquanto ele existisse aqui, a IA
  // (quando ligada por BOT_IA=true) continuaria oferecendo PlayStation, porque
  // o prompt monta a lista de plataformas a partir deste arquivo.

  plataforma_nintendo:
    'Nintendo Switch: jogo 100% ORIGINAL, com garantia VITALÍCIA. Você baixa e joga no seu próprio console, ' +
    'sem interrupção nenhuma. Simples e tranquilo.',

  plataforma_steam:
    'Steam entregue em conta, pronto pra jogar. Garantia de 30 dias. 100% original.',

  online_perfil_proprio:
    'Opção de jogar online / no próprio perfil: +40% a 50% do valor, fechada só com atendente (colete nome e sobrenome).',
};
