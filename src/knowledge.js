'use strict';

/**
 * BASE DE CONHECIMENTO da loja (apenas os FATOS).
 *
 * A IA reescreve estes textos de forma humanizada e DIFERENTE a cada resposta,
 * então aqui você só precisa manter o conteúdo CORRETO — não o "jeito de falar".
 *
 * Regras confirmadas pelo lojista (Phaze Games) em 2026-07-11.
 */

module.exports = {
  prazo_envio:
    'A entrega é 100% digital e automática após a confirmação do pagamento — normalmente em ' +
    'até 30 minutos. Pagamentos via Pix costumam ser aprovados na hora, e os dados de acesso ' +
    'chegam aqui pelo WhatsApp e no e-mail cadastrado na compra.',

  garantia:
    'Os jogos de Nintendo Switch e PlayStation têm garantia VITALÍCIA. As contas de Steam têm ' +
    'garantia de 30 dias. Todos os jogos são originais e contam com suporte: se tiver qualquer ' +
    'problema de acesso dentro da garantia, nossa equipe resolve pra você.',

  pagamento:
    'Aceitamos Pix e cartão de crédito. As compras são feitas exclusivamente pelo nosso site ' +
    'oficial, com checkout seguro.',

  troca:
    'Como se trata de produto digital (os dados de acesso são enviados assim que o pagamento cai), ' +
    'não trabalhamos com troca ou devolução após a entrega dos dados. Mas fique tranquilo: se houver ' +
    'qualquer problema com o acesso, a gente resolve pelo suporte e pela garantia.',

  restricoes:
    'Para manter a garantia e o bom funcionamento do jogo, não é permitido: alterar a senha ou os ' +
    'dados da conta recebida, definir a conta como principal quando a modalidade for secundária, nem ' +
    'revender ou compartilhar os dados com terceiros. Seguindo essas orientações, fica tudo certo!',

  // Método de conta (primária/secundária) — confirmado pelas variantes do catálogo.
  plataforma_playstation:
    'Os jogos de PlayStation são digitais, pelo método de conta, com garantia vitalícia. Duas ' +
    'modalidades: SECUNDÁRIA (mais em conta) — o jogo roda no seu console quando ele está definido ' +
    'como console principal da conta que enviamos, e em geral exige estar online; e PRIMÁRIA — você ' +
    'joga na sua própria conta, funciona offline e é mais flexível. Você recebe os dados de acesso ' +
    'para baixar o jogo direto na PS Store. Todos os jogos são originais.',

  plataforma_nintendo:
    'Os jogos de Nintendo Switch são digitais, com garantia vitalícia. Enviamos um perfil/conta com ' +
    'os dados de acesso para você baixar o jogo direto na eShop oficial da Nintendo, no seu Switch. ' +
    'É tudo original e dentro da loja oficial: você adiciona a conta no console e baixa o jogo desejado.',

  plataforma_steam:
    'Os jogos de Steam são entregues por meio de contas com os dados de acesso para você jogar ' +
    '(geralmente no modo offline). As contas de Steam têm garantia de 30 dias. Você recebe todas as ' +
    'instruções junto com a compra. Todos os jogos são originais.',

  outros:
    'Posso te ajudar com dúvidas sobre os jogos, formas de pagamento, status do seu pedido e suporte. ' +
    'Se precisar de algo específico, é só me contar ou pedir para falar com um atendente.',
};
