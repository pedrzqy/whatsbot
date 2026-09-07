'use strict';

/**
 * BASE DE CONHECIMENTO da loja (FATOS enxutos — a IA reescreve com naturalidade).
 * Enquadramento Phaze Games: sempre positivo, sem termos técnicos, nada como desvantagem.
 */

module.exports = {
  // "automática" saiu daqui, e a palavra não é detalhe.
  //
  // Este arquivo é a MEMÓRIA da IA sobre a loja: o que está escrito aqui entra
  // no prompt e sai reescrito na conversa com o cliente. Uma palavra barrada
  // aqui não vaza uma vez — vaza toda vez que alguém pergunta o prazo, com a
  // naturalidade de quem aprendeu que pode falar assim.
  prazo_envio:
    'Entrega digital, normalmente em até 30 min depois do pagamento. Pix cai na hora; ' +
    'os dados chegam no WhatsApp e no e-mail da compra.',

  garantia:
    'Nintendo Switch tem garantia VITALÍCIA (joga sem interrupção). Steam: 30 dias. Tudo 100% original, com suporte.',

  pagamento: 'Pix e cartão, no site oficial (checkout seguro).',

  troca:
    'Produto digital: sem troca/devolução após a entrega. Qualquer problema de acesso, a equipe resolve na garantia.',

  restricoes: 'Não alterar senha/dados da conta recebida nem repassar a terceiros.',

  // A PERGUNTA QUE MAIS TRAVA VENDA, segundo o dono.
  //
  // Ela é medo, não curiosidade, e medo não se responde com adjetivo. A ordem
  // aqui é de propósito: primeiro o que dá para verificar (mais de um ano, zero
  // casos), depois o MECANISMO (é o mesmo que um perfil novo, nada muda no
  // console dele), e por último a prova que não depende da nossa palavra.
  //
  // O grupo é o argumento mais forte que a loja tem e é o único que o cliente
  // pode conferir sozinho, agora, sem falar com a gente. Por isso ele fecha a
  // resposta em vez de abrir: quem ainda estiver com medo depois de ler tem
  // para onde ir, e quem já se convenceu não precisa sair da conversa.
  banimento:
    'Risco zero de banimento no seu console. Estamos há mais de 1 ano no mercado e não tivemos ' +
    'um caso sequer. Na prática é o mesmo que adicionar um perfil novo no seu console: nada muda ' +
    'no que já é seu. Quem aparece dizendo que tomou ban nunca consegue mostrar que foi por isso. ' +
    'E você não precisa acreditar só na minha palavra: nosso grupo é aberto, tem mais de 600 clientes, ' +
    `e é lá que eles contam a compra, o que acharam e qualquer problema que tenham tido: ${require('./config').store.groupUrl}`,

  // PlayStation saiu do catálogo (17/08/2026). O fato foi removido de
  // propósito, e não só escondido do menu: enquanto ele existisse aqui, a IA
  // (quando ligada por BOT_IA=true) continuaria oferecendo PlayStation, porque
  // o prompt monta a lista de plataformas a partir deste arquivo.

  // O TUTORIAL fica NESTE fato e em nenhum outro.
  //
  // Ele mostra a tela do Switch: entrar na conta, baixar, jogar. Mandar para
  // quem comprou Steam é entregar um passo a passo de outro aparelho — a pessoa
  // segue, nada bate com a tela dela, e volta achando que recebeu a coisa
  // errada. É um problema criado por uma ajuda.
  //
  // Mesma regra do site do código de verificação (config.store.codeUrl), e a
  // separação vale aqui porque este arquivo é lido em dois lugares: vai
  // literalmente para o menu e entra nos FATOS do prompt da IA.
  plataforma_nintendo:
    'Nintendo Switch: jogo 100% ORIGINAL, com garantia VITALÍCIA. Você baixa e joga no seu próprio console, ' +
    'sem interrupção nenhuma. Simples e tranquilo. ' +
    `Passo a passo de como entrar e baixar: ${require('./config').store.tutorialUrl}`,

  plataforma_steam:
    'Steam entregue em conta, pronto pra jogar. Garantia de 30 dias. 100% original.',

  online_perfil_proprio:
    'Opção de jogar online / no próprio perfil: +40% a 50% do valor, fechada só com atendente (colete nome e sobrenome).',
};
