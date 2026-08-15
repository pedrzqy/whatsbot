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
const sender = require('../sender');
const { dados, persistAgora } = require('./estado');

const AJUDA = [
  '*Comandos da ponte*',
  '',
  '*#fila* — quem está sendo atendido e quem espera',
  '*#liberar* — destrava depois de resolver a verificação da Taobao',
  '*#taobao 123456* — repassa o código SMS que a Taobao te mandou',
  '*#ok <id>* — aprova o envio de uma pergunta ao fornecedor',
  '*#enviar <id>* — manda a resposta do fornecedor ao cliente',
  '*#editar <id> <texto>* — corrige antes de mandar',
  '*#nao <id>* — descarta',
  '*#pular* — encerra o atendimento atual e chama o próximo',
  '*#teste* — vira cliente por 30 min, para testar o fluxo do seu número',
].join('\n');

/** Quanto tempo o operador fica valendo como cliente depois do #teste. */
const TESTE_MS = 30 * 60 * 1000;

const min = (ms) => Math.round(ms / 60000);

/** É comando de operador? */
function ehComando(from, texto) {
  if (!cfg.ativa || !cfg.operador.numero) return false;
  if (from !== cfg.operador.numero) return false;
  return /^#(fila|liberar|ok|enviar|editar|nao|não|pular|ajuda|taobao|teste)\b/i.test(
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
    return (
      '🧪 *Modo teste ligado por 30 min.*\n\n' +
      'Agora suas mensagens normais entram como se fossem de um cliente. ' +
      'Manda *preciso do código* e segue o passo a passo.\n\n' +
      '_Os #comandos continuam funcionando. Nada vai ao fornecedor sem #ok. ' +
      'Mande #teste de novo para desligar antes da hora._'
    );
  }

  // ── #taobao <codigo> ───────────────────────────────────
  // Código SMS que a Taobao mandou para o celular do operador. Fica guardado
  // até o braço buscar no próximo ciclo (≤1 min). Não é bypass de segurança:
  // é o dono da conta repassando o código que só ele recebeu.
  if (cmd === 'taobao') {
    const codigo = (id || '').replace(/\D/g, '');
    if (!codigo) return 'Manda assim: *#taobao 123456*';
    if (codigo.length < 4 || codigo.length > 8) {
      return `"${codigo}" não parece um código de SMS (espero 4 a 8 dígitos).`;
    }
    dados.smsTaobao = { codigo, em: Date.now() };
    persistAgora();
    return `✅ Código guardado. O braço vai usar no próximo ciclo (até 1 min).`;
  }

  // ── #fila ──────────────────────────────────────────────
  if (cmd === 'fila') {
    const s = fila.situacao();
    const d = limites.disjuntor();
    const j = janela.estado();
    const lim = limites.painel();

    const linhas = [
      `*Ponte* — modo ${cfg.modo}`,
      d.estado === 'aberto' ? `🛑 CONGELADA: ${d.motivo}` : '✅ operando',
      janela.resumo(),
      `Cota: ${lim.hora.usado}/${lim.hora.teto} nesta hora · ${lim.dia.usado}/${lim.dia.teto} hoje`,
      '',
    ];

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

    const pend = dados.tarefas.filter((t) => t.estado === 'aguardando_aprovacao').length + dados.aprovacoes.length;
    if (pend) linhas.push('', `⏳ ${pend} item(ns) esperando sua aprovação`);

    return linhas.join('\n');
  }

  // ── #liberar ───────────────────────────────────────────
  if (cmd === 'liberar') {
    const d = limites.disjuntor();
    if (d.estado !== 'aberto') return 'A ponte já está operando — nada a liberar.';
    limites.fechar('operador');
    await ponte.tick();
    return '✅ Ponte liberada. O braço volta a operar no próximo ciclo (até 1 min).';
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
    if (t.estado !== 'aguardando_aprovacao') return `Essa tarefa já está como *${t.estado}*.`;
    t.estado = 'pendente';
    persistAgora();
    return janela.estado().aberta
      ? '✅ Aprovado. O braço envia no próximo ciclo.'
      : `✅ Aprovado. Sai quando o fornecedor abrir (em ${Math.round(janela.estado().esperaMinutos / 60)}h).`;
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
      return 'Pergunta descartada — não vai para o fornecedor.';
    }
    return `Não achei nada com o id \`${id}\`.`;
  }

  return AJUDA;
}

module.exports = { ehComando, executar, AJUDA };
