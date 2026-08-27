'use strict';

/**
 * Comandos do operador, pelo próprio WhatsApp.
 *
 * Não existe painel web de propósito: o operador já vive no WhatsApp o dia
 * inteiro, e quando o disjuntor abre por captcha ele precisa agir em segundos,
 * do celular. Abrir um painel para isso seria fricção onde não pode haver.
 *
 * Só os números em PONTE_OPERADOR_NUMERO são obedecidos — qualquer outro cai
 * no fluxo normal de atendimento e nem descobre que estes comandos existem.
 *
 * A variável aceita vários separados por vírgula, e todos mandam igual: os
 * mesmos comandos, os mesmos alertas. O que NÃO é compartilhado é o #teste —
 * ele vale por número, senão um operador ligando o teste transformaria as
 * mensagens do outro em mensagens de cliente.
 */

const cfg = require('./config');
const fila = require('./fila');
const limites = require('./limites');
const janela = require('./janela');
const ponte = require('./index');
const politica = require('./politica');
const sender = require('../sender');
const nerix = require('../nerix');
const evolution = require('../evolution');
const vendas = require('../vendas');
const tools = require('../tools');
const { dados, persistAgora, emTeste, marcarTeste } = require('./estado');

const AJUDA = [
  '*Comandos*',
  '',
  '*#status* — testa tudo e diz o que está errado',
  '*#fila* — quem está sendo atendido e quem espera',
  '*#vendas* — vendas de hoje, faturamento e o que falta entregar',
  '*#liberar* — destrava depois de resolver a verificação',
  '*#sms 123456* — repassa o código SMS que chegou no seu celular',
  '*#ok <id>* — libera um envio',
  '*#enviar <id>* — manda a resposta ao cliente',
  '*#editar <id> <texto>* — corrige antes de mandar',
  '*#nao <id>* — descarta',
  '*#limpar* — descarta o que espera aprovação',
  '*#limpar fila* — encerra TODOS os atendimentos e avisa cada cliente',
  '*#destravar* — devolve à fila envio que ficou preso',
  '*#pular* — encerra o atendimento atual e chama o próximo',
  '*#teste* — vira cliente por 30 min, para testar o fluxo do seu número',
  '*#atender* — mostra se o atendimento está no ar · *#atender on* / *#atender off*',
  '*#auto on* — envio sai sem #ok · *#auto off* volta a pedir aprovação',
  '*#recarregar* — recarrega a tela e reabre a conversa (para teste)',
  '*#historico* — exporta a conversa da coleta para estudar o padrão',
].join('\n');

/** Quanto tempo o operador fica valendo como cliente depois do #teste. */
const TESTE_MS = 30 * 60 * 1000;

const min = (ms) => Math.round(ms / 60000);

/** É comando de operador? */
function ehComando(from, texto) {
  if (!cfg.ativa || !cfg.operador.numeros.length) return false;
  if (!cfg.operador.ehOperador(from)) return false;
  return /^#(fila|status|vendas|historico|liberar|ok|enviar|editar|nao|não|pular|ajuda|sms|taobao|teste|limpar|destravar|atender|auto|recarregar)\b/i.test(
    String(texto || '').trim(),
  );
}

/**
 * Executa o comando.
 *
 * `de` é QUEM mandou. Antes não existia: com um operador só, dava para assumir
 * cfg.operador.numero lá dentro. Com dois, essa suposição faz o #teste de um
 * despausar o número do outro — e o operador que digitou o comando continua
 * pausado, sem entender por que o bot não responde.
 *
 * @param {string} texto comando cru, com o #
 * @param {string} de    número de quem mandou
 * @returns {Promise<string>} resposta a mandar de volta a quem mandou
 */
async function executar(texto, de = '') {
  const bruto = String(texto || '').trim();
  const [, cmdRaw, resto = ''] = bruto.match(/^#(\S+)\s*([\s\S]*)$/) || [];
  const cmd = (cmdRaw || '').toLowerCase();
  const [id, ...palavras] = resto.trim().split(/\s+/);
  const argumento = palavras.join(' ');

  if (cmd === 'ajuda') return AJUDA;

  // ── #teste ─────────────────────────────────────────────
  // O número do operador é ignorado pela recepção de propósito: ele recebe os
  // alertas e responde com #comandos, e não faz sentido pedir código a si
  // mesmo. Só que isso também impede o operador de testar o fluxo do próprio
  // celular — que é justamente o que ele quer fazer antes de confiar no bot.
  //
  // Aqui ele vira cliente por meia hora. Não é perigoso: em copiloto nada sai
  // para o fornecedor sem #ok, os #comandos continuam sendo lidos primeiro
  // (handlers.js), e o prazo vence sozinho para ninguém esquecer ligado.
  if (cmd === 'teste') {
    const ligado = emTeste(de);
    if (ligado || /^(off|fim|parar|nao|não)$/i.test(id || '')) {
      marcarTeste(de, 0);
      return '🔕 Modo teste desligado. Seu número voltou a ser só operador.';
    }
    marcarTeste(de, TESTE_MS);

    // DESPAUSA o próprio número antes de prometer que ele vira cliente.
    //
    // `paused` é o estado que o falar_com_atendente liga para um humano
    // assumir, e handlers.js:134 devolve SILÊNCIO TOTAL nesse caso — sem
    // resposta e sem log. Com o número pausado, o #teste dizia "suas mensagens
    // entram como se fossem de um cliente" e depois nada acontecia: "ola",
    // "oi", nada. Parece bot quebrado e é só o estado anterior sobrevivendo.
    let estavaPausado = false;
    try {
      // O número de QUEM mandou, não o primeiro da lista: quem pediu o teste é
      // quem vira cliente, e despausar o outro deixaria os dois errados.
      const numero = de;
      const store = require('../store');
      estavaPausado = Boolean(store.getContact(numero)?.paused);
      if (estavaPausado) store.saveContact(numero, { paused: false, followupCount: 0 });
    } catch (err) {
      console.warn('[ponte/operador] não consegui despausar o número do teste:', err.message);
    }

    return (
      '🧪 *Modo teste ligado por 30 min.*\n\n' +
      'Agora suas mensagens normais entram como se fossem de um cliente. ' +
      'Manda *preciso do código* e segue o passo a passo.\n\n' +
      (estavaPausado
        ? '_Seu número estava em atendimento humano e voltou a ser respondido._\n\n'
        : '') +
      '_Os #comandos continuam funcionando e o limite de 5 códigos/hora não ' +
      'vale para você agora. Nada sai sem #ok. ' +
      'Mande #teste de novo para desligar antes da hora._'
    );
  }

  // ── #historico [rolagens] ──────────────────────────────
  //
  // Exporta a conversa com a origem da coleta para arquivo, para estudar o
  // padrão: o que costuma travar, o que foi respondido, o que resolveu.
  //
  // NÃO devolve o conteúdo pelo WhatsApp. A conversa é em chinês, e caractere
  // chinês saindo pelo número comercial entrega a origem do código igual à
  // palavra proibida — o arquivo fica no servidor e o WhatsApp recebe só o
  // resumo.
  //
  // Pede, não executa. Quem rola a tela é o outro serviço, no ciclo dele, e só
  // quando ninguém está esperando código: rolar o histórico carrega blocos
  // antigos do servidor da Taobao, e fazer isso no meio de um atendimento
  // atrapalharia a leitura da resposta que está chegando.
  if (cmd === 'historico') {
    const pedido = Math.min(Math.max(parseInt(id, 10) || 40, 5), 120);
    dados.historicoPedido = pedido;
    persistAgora();

    const s = fila.situacao();
    return (
      '📚 *Exportação pedida.*\n\n' +
      (s.ativo
        ? `Tem um atendimento em curso (*${s.ativo.cliente}*), então a leitura começa quando ele terminar.`
        : 'Começa no próximo ciclo. Leva alguns minutos — a rolagem é lenta de propósito.') +
      `\n\n_Vou ler até ${pedido} telas para trás. Te aviso quando terminar._`
    );
  }

  // ── #recarregar ────────────────────────────────────────
  //
  // Força a recarga da tela agora, em vez de esperar a periódica. Existe para
  // teste: sem isso, conferir se a recarga funciona significaria esperar até
  // 24h ou mexer no código.
  //
  // Não recarrega na hora nem aqui nem lá: só marca o pedido. Quem executa é o
  // outro serviço, no ciclo dele, e SÓ quando não há ninguém esperando
  // resposta — recarregar no meio de um envio perderia a marca d'água e o
  // cliente ficaria sem o código.
  if (cmd === 'recarregar') {
    dados.recarregarPedido = true;
    persistAgora();
    const s = fila.situacao();
    return (
      '🔄 *Recarga pedida.*\n\n' +
      (s.ativo
        ? `Tem um atendimento em curso (*${s.ativo.cliente}*), então a recarga acontece assim que ele terminar.`
        : // Fora do horário do fornecedor o ciclo dorme 5 min entre voltas, e a
          // recarga agora acontece lá também. Prometer ~30s de madrugada fazia
          // o comando parecer quebrado justamente na hora de testar.
          'A tela recarrega no próximo ciclo: até ~30s dentro do horário, até ~5 min fora dele.') +
      '\n\n_Ela abre o site, entra no chat, reabre a conversa e desce até a última mensagem._'
    );
  }

  // ── #auto [on|off] ─────────────────────────────────────
  //
  // Liga o autopiloto: o envio sai assim que o cliente manda foto e usuário,
  // sem esperar #ok. Persistido e vence a variável de ambiente, igual ao
  // #atender — trocar isso no painel exigiria deploy, e a decisão de parar (ou
  // voltar) a aprovar um a um costuma ser tomada no meio de um atendimento.
  if (cmd === 'auto') {
    const arg = (id || '').toLowerCase();

    if (/^(on|liga|ligar|sim)$/.test(arg)) {
      dados.modo = 'autopiloto';
      persistAgora();
      return (
        '⚡ *Autopiloto LIGADO.*\n\n' +
        'O envio sai sozinho assim que o cliente manda a foto e o usuário. ' +
        'Você não precisa mais dar *#ok*.\n\n' +
        '_Para voltar a aprovar um a um: *#auto off*._'
      );
    }

    if (/^(off|desliga|desligar|nao|não)$/.test(arg)) {
      dados.modo = 'copiloto';
      persistAgora();
      return (
        '🎛️ *Copiloto LIGADO.*\n\n' +
        'Todo envio volta a esperar seu *#ok* antes de sair.\n\n' +
        '_Para automatizar de novo: *#auto on*._'
      );
    }

    const m = ponte.modoAtual();
    return (
      `${m === 'autopiloto' ? '⚡ *Autopiloto* — envio sai sozinho' : '🎛️ *Copiloto* — cada envio espera seu #ok'}\n\n` +
      `Use *#auto on* ou *#auto off* para mudar agora, sem deploy.`
    );
  }

  // ── #atender [on|off] ──────────────────────────────────
  //
  // Liga/desliga o atendimento NA HORA, sem deploy.
  //
  // Antes o único jeito era mudar BOT_AUTOREPLY no painel e esperar o build.
  // Com cliente real na linha isso é tempo demais: se as respostas saírem
  // erradas às 22h de sábado, o operador precisa de um botão, não de um
  // deploy. O estado é persistido e VENCE a variável de ambiente.
  //
  // O comando NÃO se chama "#bot" de propósito: o nome apareceria no #ajuda e
  // em toda confirmação, e é o mesmo número comercial que fala com o cliente.
  // O teste de vocabulário pegou isso na primeira tentativa.
  if (cmd === 'atender') {
    const arg = (id || '').toLowerCase();

    if (/^(on|liga|ligar|sim)$/.test(arg)) {
      dados.botLigado = true;
      persistAgora();
      return (
        '✅ *Atendimento LIGADO.*\n\n' +
        'Quem mandar mensagem recebe o menu e é atendido na hora.\n\n' +
        '_Para desligar: *#atender off*._'
      );
    }

    if (/^(off|desliga|desligar|nao|não)$/.test(arg)) {
      dados.botLigado = false;
      persistAgora();
      return (
        '🔕 *Atendimento DESLIGADO.*\n\n' +
        'As mensagens continuam chegando, mas ninguém é respondido sozinho — ' +
        'você atende na mão. A ponte de códigos e os #comandos seguem funcionando.\n\n' +
        '_Para ligar de novo: *#atender on*._'
      );
    }

    // Sem argumento: só informa. `botLigado` só existe depois de alguém ter
    // usado o comando; antes disso vale a variável de ambiente.
    const porComando = dados.botLigado === true || dados.botLigado === false;
    const ligado = porComando ? dados.botLigado : require('../config').autoReply;
    return (
      `${ligado ? '✅ Atendimento LIGADO' : '🔕 Atendimento DESLIGADO'}\n` +
      `_Definido ${porComando ? 'por *#atender*' : 'pela configuração do serviço'}._\n\n` +
      `Use *#atender on* ou *#atender off* para mudar agora, sem deploy.`
    );
  }

  // ── #taobao <codigo> ───────────────────────────────────
  // Código SMS que a Taobao mandou para o celular do operador. Fica guardado
  // até o braço buscar no próximo ciclo (≤1 min). Não é bypass de segurança:
  // é o dono da conta repassando o código que só ele recebeu.
  if (cmd === 'sms' || cmd === 'taobao') {
    const codigo = (id || '').replace(/\D/g, '');
    if (!codigo) return 'Manda assim: *#sms 123456*';
    if (codigo.length < 4 || codigo.length > 8) {
      return `"${codigo}" não parece um código de SMS (espero 4 a 8 dígitos).`;
    }
    dados.smsTaobao = { codigo, em: Date.now() };
    persistAgora();
    return '✅ Código guardado. Vai ser usado em até 1 min.';
  }

  // ── #status ────────────────────────────────────────────
  //
  // Confere TODAS as peças de uma vez e diz o que fazer no que estiver errado.
  //
  // Existe porque o sintoma que chega é sempre o mesmo — "o bot parou" — e a
  // causa quase nunca é o bot: o WhatsApp desconectou, a loja está fora do ar,
  // o webhook nunca foi cadastrado. Sem este comando, descobrir qual das
  // quatro coisas era exigia abrir três painéis diferentes.
  //
  // Cada checagem tem o próprio try: uma peça fora do ar não pode impedir o
  // diagnóstico das outras — é justamente quando algo caiu que se usa isto.
  if (cmd === 'status') {
    const linhas = ['🔎 *Teste do sistema*', ''];
    const problemas = [];

    // 1) WhatsApp. Se caiu, nada mais importa: toda mensagem some em silêncio.
    try {
      const estado = await evolution.estadoInstancia();
      if (estado === 'open') {
        linhas.push('✅ WhatsApp conectado');
      } else {
        linhas.push(`🛑 WhatsApp *${estado || 'sem resposta'}*`);
        problemas.push('O WhatsApp desconectou. Leia o QR de novo no painel da Evolution.');
      }
    } catch {
      linhas.push('⚠️ WhatsApp — não consegui conferir');
      problemas.push('Não falei com a Evolution. Confere se o serviço dela está no ar.');
    }

    // 2) Loja. Sem ela não há consulta de pedido, nem busca de jogo, nem venda.
    try {
      await nerix.getStore();
      linhas.push('✅ Loja responde');
    } catch (err) {
      const s = err.response?.status;
      linhas.push(`🛑 Loja *não responde*${s ? ` (${s})` : ''}`);
      problemas.push(
        s === 401
          ? 'A chave da loja foi recusada. Precisa gerar outra e trocar no painel.'
          : 'A loja não respondeu. Pode ser instabilidade — tenta de novo em um minuto.',
      );
    }

    // 3) Avisos de venda. A pergunta real é "o webhook está cadastrado?", e a
    //    única prova disso é ter chegado algum evento algum dia.
    const ultimoEvento = vendas.ultimoEventoEm();
    if (!ultimoEvento) {
      linhas.push('⚠️ Avisos de venda — nenhum recebido ainda');
      problemas.push(
        'Se você já vendeu depois da última atualização, o aviso de venda não ' +
          'está ligado no painel da loja.',
      );
    } else {
      // Em horas depois de 90 min: "último há 2880 min" é um número que
      // ninguém converte de cabeça no meio do atendimento.
      const idadeEvento = Date.now() - ultimoEvento;
      const quando =
        idadeEvento < 90 * 60000
          ? `${min(idadeEvento)} min`
          : idadeEvento < 48 * 3600_000
            ? `${Math.round(idadeEvento / 3600_000)}h`
            : `${Math.round(idadeEvento / (24 * 3600_000))} dias`;
      linhas.push(`✅ Avisos de venda — último há ${quando}`);
    }

    // 4) Coleta (o navegador). O #fila detalha; aqui é só o sim ou não.
    const visto = dados.coletaVistaEm || 0;
    const idade = visto ? Date.now() - visto : Infinity;
    if (!visto) {
      linhas.push('🛑 Coleta — nunca conectou');
      problemas.push('O outro serviço não subiu. Confere ele no painel.');
    } else if (idade > 3 * 60 * 1000) {
      linhas.push(`🛑 Coleta — sem sinal há ${min(idade)} min`);
      problemas.push('A coleta parou. Enquanto isso, código de segurança não sai.');
    } else {
      linhas.push(`✅ Coleta ativa (há ${Math.round(idade / 1000)}s)`);
    }

    // 5) Estado de operação: o que está ligado agora.
    const d = limites.disjuntor();
    if (d.estado === 'aberto') {
      linhas.push('🛑 Envios *congelados*');
      problemas.push('Apareceu verificação na tela. Resolve e responde *#liberar*.');
    } else {
      linhas.push('✅ Envios operando');
    }

    // "Horário" e não "Coleta": a linha de cima já usa essa palavra para o
    // serviço do navegador, e duas linhas dizendo "Coleta" com significados
    // diferentes é pior que não ter nenhuma.
    //
    // E não diz de QUEM é o horário: isto sai pelo mesmo número que fala com o
    // cliente. Escrever "fornecedor" aqui foi o que o teste barrou.
    const j = janela.estado();
    if (j.aberta) {
      linhas.push('✅ Dentro do horário');
    } else {
      const h = Math.floor(j.esperaMinutos / 60);
      const m = j.esperaMinutos % 60;
      linhas.push(`🕒 Fora do horário — volta em ${h ? `${h}h` : ''}${m ? `${m}min` : ''}`.trim());
    }

    linhas.push(
      ponte.atendimentoLigado() ? '✅ Atendimento ligado' : '🔕 Atendimento *desligado* (#atender on)',
    );
    linhas.push(
      ponte.modoAtual() === 'autopiloto'
        ? '⚡ Envio automático ligado (#auto off desliga)'
        : '✅ Envio pede sua aprovação',
    );

    // 6) Configuração. Erro aqui é silencioso: nada quebra, só deixa de
    //    acontecer — e é o pior tipo de defeito para descobrir.
    const quantos = cfg.operador.numeros.length;
    linhas.push(`✅ ${quantos} ${quantos === 1 ? 'número de operador' : 'números de operador'}`);

    if (!cfg.vendedor.chatTitulo) {
      linhas.push('⚠️ Origem da coleta não configurada');
      problemas.push('Falta preencher a origem da coleta no painel — sem isso o código não sai.');
    }

    if (problemas.length) {
      linhas.push('', '*O que fazer:*');
      for (const p of problemas) linhas.push(`• ${p}`);
    } else {
      linhas.push('', '_Está tudo funcionando._');
    }

    return linhas.join('\n');
  }

  // ── #vendas ────────────────────────────────────────────
  //
  // O dia da loja numa mensagem. Existe porque a resposta para "vendi quanto
  // hoje?" morava só no painel do site — e no meio do atendimento, pelo
  // celular, abrir o painel é o suficiente para não olhar.
  //
  // Conta o que PRECISA DE AÇÃO separado do resto: pedido pago sem chave é
  // trabalho parado esperando alguém lembrar, e é o único número aqui que
  // pede uma atitude.
  if (cmd === 'vendas') {
    let lista = [];
    try {
      const resp = await nerix.listOrders({ limit: 100 });
      lista = resp?.data || resp || [];
    } catch (err) {
      console.warn('[operador] #vendas falhou:', err.response?.status || err.message);
      return '📊 Não consegui falar com a loja agora. Tenta de novo em um minuto.';
    }
    if (!Array.isArray(lista)) lista = [];

    // Meia-noite de hoje em Brasília. Comparar com o fuso do servidor daria o
    // dia errado por 3 horas toda madrugada — e é justamente de madrugada que
    // o operador confere o fechamento.
    const hojeBRT = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Sao_Paulo',
      year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date());

    const doDia = lista.filter((p) => {
      const criado = p.created_at || p.createdAt;
      if (!criado) return false;
      return new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/Sao_Paulo',
        year: 'numeric', month: '2-digit', day: '2-digit',
      }).format(new Date(criado)) === hojeBRT;
    });

    let pagos = 0;
    let total = 0;
    let aguardando = 0;
    const semChave = [];

    for (const cru of doDia) {
      const f = tools.formatOrder(cru);
      if (f.pago) {
        pagos++;
        total += Number(cru.total ?? cru.amount ?? 0) || 0;
        // Item sem chave num pedido pago = entrega manual pendente.
        if ((f.itens || []).some((i) => !i.chave)) semChave.push(f.codigo);
      } else {
        aguardando++;
      }
    }

    const brl = (n) => `R$ ${n.toFixed(2).replace('.', ',')}`;
    const linhas = [
      '📊 *Hoje*',
      '',
      `Vendas pagas: *${pagos}*`,
      `Faturado: *${brl(total)}*`,
      `Aguardando pagamento: ${aguardando}`,
    ];

    if (semChave.length) {
      linhas.push(
        '',
        `⚠️ *${semChave.length} pedido(s) pago(s) sem chave* — entrega na mão:`,
        ...semChave.slice(0, 8).map((c) => `• ${c}`),
      );
      if (semChave.length > 8) linhas.push(`_e mais ${semChave.length - 8}._`);
    }

    if (!doDia.length) {
      linhas.push('', '_Nenhum pedido hoje ainda._');
    }

    return linhas.join('\n');
  }

  // ── #fila ──────────────────────────────────────────────
  if (cmd === 'fila') {
    const s = fila.situacao();
    const d = limites.disjuntor();
    const j = janela.estado();
    const lim = limites.painel();

    const linhas = [
      `*Códigos* — modo ${ponte.modoAtual()}`,
      // Motivo NEUTRO e o comando junto. O motivo cru é o erro inteiro com
      // Call log — o limparAlerta truncava na saída, então o operador via um
      // pedaço de log sem começo nem fim e sem dizer como sair. Congelado nada
      // sai, para sempre, até alguém mandar #liberar: essa é a informação que
      // precisa estar na linha.
      d.estado === 'aberto'
        ? `🛑 *CONGELADA* — ${politica.motivoNeutro(d.motivo)}\n   Responde *#liberar* para voltar a operar.`
        : '✅ operando',
      janela.resumo(),
      `Cota: ${lim.hora.usado}/${lim.hora.teto} nesta hora · ${lim.dia.usado}/${lim.dia.teto} hoje`,
      '',
    ];

    // Sinal de vida do outro serviço, e o que ele está fazendo agora.
    //
    // Sem isto, depois do #ok o painel dizia apenas que a tarefa saiu da fila —
    // e "trabalhando", "serviço caído" e "travado" ficavam idênticos daqui.
    // "Coleta" e não a outra palavra: isto sai pelo número comercial.
    const visto = dados.coletaVistaEm || 0;
    const idade = visto ? Date.now() - visto : Infinity;
    const chaveRuim = dados.coletaChaveRuimEm || 0;

    if (!visto && chaveRuim) {
      // Bateu na porta e foi recusado: a rede funciona, o segredo é que não
      // bate. Diagnóstico completamente diferente de "não subiu", e antes os
      // dois apareciam iguais aqui.
      linhas.push(
        '🔌 Coleta: *chave recusada* — a PONTE_BRACO_KEY está diferente entre os dois serviços.',
        '   Copie o mesmo valor no Environment dos dois e faça Deploy.',
      );
    } else if (!visto) {
      linhas.push(
        '🔌 Coleta: *nunca conectou* — o outro serviço não subiu ou não alcança este.',
        '   Confira no painel se ele está rodando e se a BOT_URL dele aponta para cá.',
      );
    } else if (idade > 90_000) {
      linhas.push(`🔌 Coleta: *SEM SINAL há ${min(idade)} min* — o outro serviço parece fora do ar`);
    } else {
      linhas.push(`🔌 Coleta: ativa (há ${Math.round(idade / 1000)}s)`);
    }

    if (s.ativo) {
      linhas.push(
        `*Em atendimento:* ${s.ativo.cliente}`,
        `${s.ativo.turnos} turno(s) · há ${min(Date.now() - s.ativo.desde)} min`
      );
    } else {
      linhas.push('_Ninguém em atendimento_');
    }

    if (s.aguardando.length) {
      linhas.push('', `*Na fila (${s.aguardando.length}):*`);
      for (const a of s.aguardando.slice(0, 10)) {
        linhas.push(`${a.posicao}. ${a.cliente} — há ${min(Date.now() - a.desde)} min`);
      }
    }

    // LISTA os pendentes com id. Só dizer "5 itens" obriga o operador a rolar o
    // WhatsApp atrás do alerta antigo para achar o id — e com vários pendentes
    // é fácil aprovar o errado.
    const aprovar = dados.tarefas.filter((t) => t.estado === 'aguardando_aprovacao');
    if (aprovar.length || dados.aprovacoes.length) {
      linhas.push('', `⏳ *Esperando você (${aprovar.length + dados.aprovacoes.length}):*`);
      for (const t of aprovar.slice(0, 8)) {
        linhas.push(`envio \`${t.usuario}\` — *#ok ${t.id}*`);
      }
      for (const a of dados.aprovacoes.slice(0, 8)) {
        linhas.push(`resposta p/ ${a.cliente} — *#enviar ${a.id}*`);
      }
      if (aprovar.length + dados.aprovacoes.length > 8) linhas.push('_(mostrando os 8 primeiros)_');
      linhas.push('_*#limpar* descarta tudo isso de uma vez_');
    }

    // O que já foi aprovado e está com o braço. Aparece SEMPRE, inclusive
    // zerado: é a linha que separa "o braço está lento" de "não há nada para
    // ele fazer" — e essa dúvida já custou uma investigação inteira. Escondida
    // quando zero, ela não responde nem uma coisa nem outra.
    const naFila = dados.tarefas.filter((t) => t.estado === 'pendente').length;
    const emCurso = dados.tarefas.filter((t) => t.estado === 'executando');
    linhas.push('', `📤 envios: ${naFila} na fila · ${emCurso.length} saindo agora`);

    // HÁ QUANTO TEMPO cada um está saindo. "1 saindo agora" parece progresso
    // tanto no primeiro segundo quanto na segunda hora; o relógio é o que
    // separa lento de travado, e era a pergunta que sobrava depois do #ok.
    for (const t of emCurso.slice(0, 3)) {
      linhas.push(`   \`${t.usuario}\` — começou há ${min(Date.now() - (t.pegaEm || Date.now()))} min`);
    }

    // Por que o último não foi. Motivo neutro: isto sai no WhatsApp.
    const falhou = dados.tarefas.filter((t) => t.estado === 'falhou');
    if (falhou.length) {
      const ultima = falhou[falhou.length - 1];
      linhas.push(
        `❌ ${falhou.length} sem sucesso · último: ${politica.motivoNeutro(ultima.ultimoErro)}`,
      );
    }

    return linhas.join('\n');
  }

  // ── #liberar ───────────────────────────────────────────
  if (cmd === 'liberar') {
    const d = limites.disjuntor();
    if (d.estado !== 'aberto') return 'Já está operando — nada a liberar.';
    limites.fechar('operador');
    await ponte.tick();
    return '✅ Liberado. Volta a operar em até 1 min.';
  }

  // ── #destravar ─────────────────────────────────────────
  // Envio que ficou em 'executando' sem dono — o braço o pegou e morreu antes
  // de reportar (deploy, OOM, timeout). O /proxima só entrega 'pendente',
  // então ele some da vista de todo mundo: o braço fica ocioso achando que não
  // há trabalho e o cliente espera as 4h do timeout. Existe recuperação
  // automática depois de 5 min; isto é o botão para não esperar.
  if (cmd === 'destravar') {
    const presas = dados.tarefas.filter((t) => t.estado === 'executando');
    if (!presas.length) {
      // "Veja o #fila" mandava o operador para uma tela que ele já tinha
      // acabado de ver. Aqui o caso comum é atendimento parado SEM tarefa
      // nenhuma — o pedido morreu antes de virar envio — e o que resolve é
      // #pular ou #limpar fila, não destravar.
      const s = fila.situacao();
      const parado = s.ativo && !s.ativo.turnos;
      if (parado) {
        return (
          `Nenhum envio preso — o que está parado é o *atendimento*.\n\n` +
          `*${s.ativo.cliente}* está na vez há ${min(Date.now() - s.ativo.desde)} min sem nenhum envio criado.\n` +
          `*#pular* passa para o próximo · *#limpar fila* encerra todos.`
        );
      }
      return 'Nenhum envio preso.';
    }
    for (const t of presas) {
      t.estado = 'pendente';
      t.tentativas = Math.max(0, t.tentativas - 1);
    }
    persistAgora();
    return `🔧 ${presas.length} envio(s) de volta na fila. Sai em segundos.`;
  }

  // ── #limpar ────────────────────────────────────────────
  // Existe para teste: cada rodada deixa uma tarefa esperando #ok, e depois de
  // algumas o operador tem uma pilha de lixo que atrapalha ler o #fila.
  // Só descarta o que AINDA não saiu — envio em andamento não é tocado.
  // ── #limpar [fila] ─────────────────────────────────────
  //
  // Sem argumento limpa o que espera APROVAÇÃO. `#limpar fila` vai além e
  // encerra os atendimentos, avisando cada cliente.
  //
  // A separação existe porque as duas coisas têm consequências diferentes:
  // descartar aprovação não afeta ninguém de fora, enquanto encerrar a fila
  // mexe com gente que está esperando — e essa gente precisa ser avisada, ou
  // fica esperando para sempre uma resposta que não vem mais.
  if (cmd === 'limpar') {
    const tudo = /^(fila|tudo|geral|all)$/i.test((id || '').trim());
    const tarefas = dados.tarefas.filter((t) => t.estado === 'aguardando_aprovacao').length;
    const respostas = dados.aprovacoes.length;
    const s = fila.situacao();
    const presos = (s.ativo ? 1 : 0) + s.aguardando.length;

    if (!tudo) {
      if (!tarefas && !respostas) {
        // Mensagem que AJUDA. Antes dizia só "não há nada esperando
        // aprovação" — e com três clientes travados na fila isso é verdade e
        // inútil ao mesmo tempo: o operador via a fila cheia no #fila, o
        // #limpar dizendo que não havia nada, e ficava sem saída.
        return presos
          ? `Não há nada esperando aprovação.\n\n` +
              `Mas tem *${presos}* cliente(s) na fila de atendimento.\n` +
              `*#limpar fila* encerra todos e avisa cada um · *#pular* passa só o da vez.`
          : 'Não há nada esperando aprovação, e a fila está vazia.';
      }

      dados.tarefas = dados.tarefas.filter((t) => t.estado !== 'aguardando_aprovacao');
      dados.aprovacoes = [];
      persistAgora();
      return (
        `🧹 Descartei ${tarefas} envio(s) e ${respostas} resposta(s). Nada saiu.` +
        (presos ? `\n\n_Ainda tem ${presos} cliente(s) na fila. Use *#limpar fila* para encerrar._` : '')
      );
    }

    // ── #limpar fila ──
    if (!presos && !tarefas && !respostas) return 'Já está tudo vazio.';

    const paraAvisar = [s.ativo, ...s.aguardando].filter(Boolean);
    for (const a of paraAvisar) {
      const at = fila.porId(a.id);
      if (!at?.from) continue;
      // Avisa ANTES de encerrar: depois o atendimento não existe mais e o
      // número se perde junto.
      await sender
        .send(
          at.from,
          'Oi! Não consegui concluir seu pedido de código agora 🙏\n\n' +
            'Se ainda precisar, é só me mandar *preciso do código* que eu começo de novo.',
        )
        .catch(() => {});
      await fila.concluir(at.id, 'limpeza_operador');
    }

    dados.tarefas = dados.tarefas.filter(
      (t) => t.estado !== 'aguardando_aprovacao' && t.estado !== 'pendente' && t.estado !== 'executando',
    );
    dados.aprovacoes = [];
    persistAgora();

    return (
      `🧹 *Fila limpa.*\n\n` +
      `${paraAvisar.length} cliente(s) encerrado(s) e avisado(s).\n` +
      `${tarefas} envio(s) e ${respostas} resposta(s) descartados.`
    );
  }

  // ── #pular ─────────────────────────────────────────────
  if (cmd === 'pular') {
    const at = fila.ativo();
    if (!at) return 'Não há atendimento ativo.';
    await fila.concluir(at.id, 'pulado_pelo_operador');
    await ponte.promoverProximo();
    return `Atendimento de *${at.nome}* encerrado. Próximo da fila promovido.`;
  }

  if (!id) return `Faltou o id. Use *#${cmd} <id>*. Veja os pendentes com *#fila*.`;

  // ── #ok — aprova pergunta que ia para o fornecedor ─────
  if (cmd === 'ok') {
    const t = dados.tarefas.find((x) => x.id === id);
    if (!t) return `Não achei a tarefa \`${id}\`.`;

    // 'executando' com o braço sumido é o caso em que o operador MAIS insiste
    // no #ok — e recusar aqui era um beco sem saída: a mensagem dizia "já está
    // executando" enquanto ninguém estava executando nada. Reenfileira.
    if (t.estado === 'executando') {
      t.estado = 'pendente';
      t.tentativas = Math.max(0, t.tentativas - 1);
      persistAgora();
      return '🔧 Esse envio tinha ficado preso sem dono. Devolvi para a fila — sai em segundos.';
    }

    if (t.estado !== 'aguardando_aprovacao') return `Essa tarefa já está como *${t.estado}*.`;
    t.estado = 'pendente';
    persistAgora();

    // SÓ AGORA o cliente ouve que o código está sendo buscado.
    //
    // Antes isso saía no momento do pedido, com a tarefa ainda parada
    // esperando aprovação: o cliente lia "já estou pegando seu código" e nada
    // tinha saído — e se a resposta fosse #nao, a promessa nunca se cumpria.
    // No copiloto quem decide é o operador, então a mensagem acompanha a
    // decisão, não o pedido.
    const at = fila.porId(t.atendimentoId);
    if (at) {
      const j = janela.estado();
      await sender.send(
        at.from,
        j.aberta
          ? 'Já estou pegando seu código. Só um instante 👍'
          : j.avisoCliente,
      );
    }

    return janela.estado().aberta
      ? '✅ Aprovado. Sai em segundos.'
      : `✅ Aprovado. Sai quando reabrir (em ${Math.round(janela.estado().esperaMinutos / 60)}h).`;
  }

  // ── #enviar / #editar — resposta do fornecedor ao cliente ──
  if (cmd === 'enviar' || cmd === 'editar') {
    const idx = dados.aprovacoes.findIndex((a) => a.id === id);
    if (idx === -1) return `Não achei a aprovação \`${id}\`.`;

    const ap = dados.aprovacoes[idx];
    const final = cmd === 'editar' ? argumento.trim() : ap.texto;
    if (cmd === 'editar' && !final) return 'Faltou o texto. Use *#editar <id> <texto corrigido>*.';

    const at = fila.porId(ap.atendimentoId);
    dados.aprovacoes.splice(idx, 1);
    persistAgora();

    if (!at) return 'O atendimento não existe mais — não enviei.';

    // Explicação de problema, não código: manda o texto e encerra a vez, para
    // a fila não travar esperando um código que não vem.
    await sender.send(at.from, final);
    await fila.concluir(at.id, 'problema_explicado');
    await ponte.promoverProximo();
    return `✅ Enviado para *${ap.cliente}*. Vez encerrada, próximo promovido.`;
  }

  // ── #nao — descarta ────────────────────────────────────
  if (cmd === 'nao' || cmd === 'não') {
    const iAp = dados.aprovacoes.findIndex((a) => a.id === id);
    if (iAp !== -1) {
      const [ap] = dados.aprovacoes.splice(iAp, 1);
      persistAgora();
      return `Descartada a resposta para *${ap.cliente}*. O atendimento segue aberto.`;
    }
    const t = dados.tarefas.find((x) => x.id === id);
    if (t) {
      t.estado = 'falhou';
      t.ultimoErro = 'descartada pelo operador';
      persistAgora();
      return 'Envio descartado — não sai.';
    }
    return `Não achei nada com o id \`${id}\`.`;
  }

  return AJUDA;
}

module.exports = { ehComando, executar, AJUDA };
