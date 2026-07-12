'use strict';

/**
 * BASE DE CONHECIMENTO da loja (apenas os FATOS).
 *
 * A IA reescreve estes textos de forma humanizada e diferente a cada resposta.
 * Enquadramento definido pelo lojista (Phaze Games): falar sempre de forma
 * positiva, sem termos técnicos, sem apresentar nada como desvantagem.
 */

module.exports = {
  prazo_envio:
    'A entrega é 100% digital e automática após a confirmação do pagamento — normalmente em ' +
    'até 30 minutos. No Pix costuma cair na hora, e os dados de acesso chegam aqui pelo WhatsApp ' +
    'e no e-mail cadastrado na compra. Rapidinho e sem complicação.',

  garantia:
    'Os jogos de Nintendo Switch e PlayStation têm garantia VITALÍCIA — é jogar sem interrupção ' +
    'nenhuma, do jeitinho que você comprou, pra sempre. As contas de Steam têm garantia de 30 dias. ' +
    'Tudo 100% original e com suporte de verdade: qualquer coisa, a nossa equipe resolve pra você.',

  pagamento:
    'Aceitamos Pix e cartão de crédito. As compras são feitas pelo nosso site oficial, com ' +
    'checkout seguro — rápido e tranquilo.',

  troca:
    'Como é um produto digital (os dados de acesso são enviados na hora do pagamento), não ' +
    'trabalhamos com troca/devolução depois da entrega. Mas pode ficar tranquilo: qualquer problema ' +
    'de acesso, a gente resolve na hora pelo suporte e pela garantia.',

  restricoes:
    'Pra manter a garantia e tudo funcionando certinho, é só não alterar a senha/dados da conta ' +
    'recebida e não repassar os dados pra terceiros. Seguindo isso, é só aproveitar e jogar.',

  // Enquadramento positivo: "offline", sem termos técnicos. A opção online/perfil próprio é upsell via atendente.
  plataforma_playstation:
    'Os jogos de PlayStation são digitais, 100% originais e com garantia VITALÍCIA — você joga ' +
    'offline no seu console, tranquilo e sem interrupção nenhuma. Chega tudo pronto pra baixar ' +
    'direto na PS Store e começar a jogar. Também existe a opção de jogar ONLINE / no seu próprio ' +
    'perfil, que sai entre 40% e 60% a mais do valor do jogo e é fechada com um atendente.',

  plataforma_nintendo:
    'Os jogos de Nintendo Switch são digitais, 100% originais e com garantia VITALÍCIA — você joga ' +
    'offline no seu próprio Switch, tranquilo e sem interrupção nenhuma. Chega rapidinho, direto da ' +
    'eShop oficial da Nintendo, e é só começar a jogar. Também existe a opção de jogar ONLINE / no ' +
    'seu próprio perfil, que sai entre 40% e 60% a mais do valor do jogo e é fechada com um atendente.',

  plataforma_steam:
    'Os jogos de Steam são entregues em conta, com tudo pronto pra jogar. As contas de Steam têm ' +
    'garantia de 30 dias. Você recebe todas as instruções junto com a compra. Tudo 100% original.',

  online_perfil_proprio:
    'Além do padrão (jogar offline no seu console, com garantia vitalícia), temos a opção de jogar ' +
    'ONLINE e no seu PRÓPRIO perfil. Ela custa entre 40% e 60% a mais do valor do jogo e é fechada ' +
    'diretamente com um atendente. Se o cliente quiser essa opção, colete nome e sobrenome e transfira.',
};
