'use strict';

/**
 * Comandos do operador, pelo próprio WhatsApp.
 *
 * Não existe painel web de propósito: o operador já vive no WhatsApp o dia
 * inteiro, e quando o disjuntor abre por captcha ele precisa agir em segundos,
 * do celular. Abrir um painel para isso seria fricção onde não pode haver.
 *
 * Só o número em PONTE_OPERADOR_NUMERO é obedecido — qualquer outro cai no
 * fluxo normal de atendimento e nem descobre que estes comandos existem.
 */

const cfg = require('./config');
const fila = require('./fila');
const limites = require('./limites');
const janela = require('./janela');
const ponte = require('./index');
const politica = require('./politica');
const sender = require('../sender');
const { dados, persistAgora } = require('./estado');

const AJUDA = [
  '*Comandos*',
  '',
  '*#fila* — quem está sendo atendido e quem espera',
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
].join('\n');

/** Quanto tempo o operador fica valendo como cliente depois do #teste. */
const TESTE_MS = 30 * 60 * 1000;

const min = (ms) => Math.round(ms / 60000);

/** É comando de operador? */
function ehComando(from, texto) {
  if (!cfg.ativa || !cfg.operador.numero) return false;
  if (from !== cfg.operador.numero) return false;
  return /^#(fila|liberar|ok|enviar|editar|nao|não|pular|ajuda|sms|taobao|teste|limpar|destravar|atender|auto|recarregar)\b/i.test(
    String(texto || '').trim(),
  );
}

/**
 * Executa o comando.
 * @returns {Promise<string>} resposta a mandar de volta ao operador
 */
async function executar(texto) {
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
    const ligado = dados.testeOperador?.ate > Date.now();
    if (ligado || /^(off|fim|parar|nao|não)$/i.test(id || '')) {
      dados.testeOperador = null;
      persistAgora();
      return '🔕 Modo teste desligado. Seu número voltou a ser só operador.';
    }
    dados.testeOperador = { ate: Date.now() + TESTE_MS };
    persistAgora();

    // DESPAUSA o próprio número antes de prometer que ele vira cliente.
    //
    // `paused` é o estado que o falar_com_atendente liga para um humano
    // assumir, e handlers.js:134 devolve SILÊNCIO TOTAL nesse caso — sem
    // resposta e sem log. Com o número pausado, o #teste dizia "suas mensagens
    // entram como se fossem de um cliente" e depois nada acontecia: "ola",
    // "oi", nada. Parece bot quebrado e é só o estado anterior sobrevivendo.
    let estavaPausado = false;
    try {
      // O operador é sempre este número — executar() nem recebe o remetente,
      // porque ehComando() já garantiu que só ele chega aqui.
      const numero = cfg.operador.numero;
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
        : 'A tela recarrega no próximo ciclo, em até ~30s.') +
      '\n\n_Ela abre o site, entra no chat e reabre a conversa._'
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
