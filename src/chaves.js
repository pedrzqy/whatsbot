'use strict';

/**
 * As chaves do bot — ligar e desligar pelo WhatsApp, sem deploy.
 *
 * Antes disto, mudar qualquer comportamento significava abrir o Easypanel,
 * achar a variável, editar e dar Deploy — dois minutos de bot fora do ar por
 * causa de um `false` virando `true`. E o dono não é técnico: na prática ele
 * simplesmente não mexia, e as travas de segurança que nasceram desligadas
 * ficavam desligadas para sempre porque ligá-las dava trabalho demais.
 *
 * O padrão já existia em dois lugares — `dados.botLigado` (#atender) e
 * `dados.modo` (#auto), que vencem a variável de ambiente. Aqui ele vira geral:
 *
 *   valor gravado no estado  →  se não houver, o padrão do Environment
 *
 * O estado mora no volume, então a escolha sobrevive a deploy e a restart. E a
 * variável continua sendo o padrão de fábrica: apagar a chave gravada devolve o
 * comportamento configurado no painel.
 *
 * O que NÃO entra aqui: chave de API. Ligar e desligar comportamento é decisão
 * de operação; guardar segredo é outra coisa, e continua no Environment.
 */

const config = require('./config');
const cfgPonte = require('./ponte/config');
const { dados, persistAgora } = require('./ponte/estado');

/**
 * O catálogo. A ORDEM é o número que o operador digita (#admin 3 off), então
 * ela não pode mudar sem avisar — ele decora a posição, não o nome.
 *
 *   id      nome curto, usado no log e no comando por extenso
 *   nome    o que o dono lê
 *   curto   UMA linha, para a lista. Diz o que a função FAZ, nunca o que
 *           acontece se desligar -- na lista cabe o suficiente para ele
 *           reconhecer a função, e o resto está a um `#admin N` de distância.
 *   explica o paragágrafo, para quando ele abre uma
 *   perigoQuando  em que estado esta função merece atenção ('ligada' ou
 *           'desligada'). O painel marca com ⚠️ só quando ela ESTÁ nesse
 *           estado: marcar sempre viraria decoração e ele pararia de ver
 *   padrao  função que devolve o padrão do Environment
 *   risco   'baixo' | 'medio' | 'alto' — o que a confirmação usa
 *   cuidado o que ele precisa saber ANTES de ligar (só nos de risco alto)
 *   impedimento  função que devolve o MOTIVO de esta função não conseguir
 *           rodar mesmo ligada, ou null quando está tudo certo. Ver abaixo.
 *
 * Sobre o `impedimento`: ligada no painel não é o mesmo que FUNCIONANDO. A
 * chave que falta mora no Environment, que é justamente o que este painel não
 * mexe — e o desfecho de uma função ligada-mas-morta é idêntico ao dela
 * desligada. Foi assim que se perdeu uma investigação inteira: o dono ligou a
 * conversa livre, mandou uma foto, recebeu "não entendi, escolhe uma opção",
 * e o painel continuava dizendo ✅ o tempo todo.
 */
const CATALOGO = [
  {
    id: 'atendimento',
    curto: 'Responder cliente no WhatsApp',
    nome: 'Atendimento',
    explica: 'Responder mensagem de cliente. Desligado, a mensagem chega e ninguém responde.',
    padrao: () => config.autoReply,
    risco: 'medio',
  },
  {
    id: 'ia',
    curto: 'A IA responde além do menu',
    nome: 'Conversa livre',
    explica:
      'A IA responde o que o menu não cobre, com as palavras dela. ' +
      'Desligada, quem responde é o menu numerado, com texto pronto.',
    padrao: () => config.iaLigada,
    risco: 'medio',
    // Sem a chave da Anthropic TODA chamada morre no mesmo lugar, e o cliente
    // recebe o menu de "não entendi" — exatamente o que ele receberia com esta
    // função desligada. Require aqui dentro para o painel não carregar o SDK.
    impedimento: () =>
      require('./claude').disponivel()
        ? null
        : 'a chave da IA não está no servidor (ANTHROPIC_API_KEY)',
  },
  {
    id: 'vender',
    curto: 'Fecha a compra e manda o Pix aqui',
    nome: 'Vender pelo chat',
    explica:
      'Fechar a compra na conversa e mandar o Pix. Desligado, o cliente recebe o ' +
      'link do site, como antes.',
    padrao: () => config.venderNoChat,
    risco: 'medio',
  },
  {
    id: 'codigos',
    curto: 'Busca o código com o outro lado',
    nome: 'Códigos de segurança',
    explica: 'Buscar o código com o outro lado quando o cliente precisa.',
    padrao: () => cfgPonte.ativa,
    risco: 'medio',
  },
  {
    id: 'aprovacao',
    curto: 'Nada sai sem o seu #ok',
    nome: 'Pedir sua aprovação',
    explica:
      'Nada sai para o outro lado sem o seu #ok. Desligado, sai sozinho.',
    // Ao contrário das outras, esta vem do MODO e não de um booleano: ligada
    // significa copiloto.
    padrao: () => cfgPonte.modo !== 'autopiloto',
    risco: 'alto',
    // O perigo aqui e DESLIGAR: ligada, ela e o freio.
    perigoQuando: 'desligada',
    cuidado:
      'Desligando isso, mensagens saem para o outro lado sem você ver. ' +
      'É o freio principal do sistema.',
  },
  {
    id: 'repertorio',
    curto: 'Usa suas frases prontas com o outro lado',
    nome: 'Responder o outro lado sozinho',
    explica:
      'As perguntas repetidas dele são respondidas com uma frase que você ' +
      'escreveu. Fora da lista, o atendimento chama você.',
    padrao: () => cfgPonte.repertorioLigado,
    risco: 'alto',
    perigoQuando: 'ligada',
    cuidado:
      'É a única parte que escreve para fora. Só ligue depois de olhar o ' +
      '#casos por uns dias.',
  },
  {
    id: 'conferir',
    curto: 'Confere a entrega 3h depois',
    nome: 'Perguntar se ativou',
    explica: 'Três horas depois de entregar a chave, pergunta se deu certo.',
    padrao: () => config.posvenda.conferirLigado,
    risco: 'baixo',
  },
  {
    id: 'reativar',
    curto: 'Chama quem comprou e sumiu faz tempo',
    nome: 'Chamar quem sumiu',
    explica: 'Manda mensagem para quem comprou, gostou e sumiu faz tempo.',
    padrao: () => config.posvenda.reativarLigado,
    risco: 'alto',
    perigoQuando: 'ligada',
    cuidado:
      'É a única coisa que fala com quem não puxou conversa. Mensagem em ' +
      'massa é como se perde o número do WhatsApp.',
  },
  // Entrou no FIM da lista de propósito. A ordem é o número que ele digita, e
  // ele decora a posição — inserir no meio faria o #admin 5 dele virar outra
  // coisa da noite para o dia.
  {
    id: 'barato',
    curto: 'Usa a IA barata no que ninguém vê',
    nome: 'Economia nos bastidores',
    explica:
      'O trabalho de bastidor (a análise, a tradução do que o outro lado ' +
      'escreve, a escolha da resposta pronta) passa a usar uma IA mais barata. ' +
      'A conversa com o cliente NÃO muda: continua na mesma de sempre. ' +
      'Desligado, tudo volta a rodar pela IA cara.',
    padrao: () => config.baratoLigado,
    // Nada aqui fala com cliente nem com o outro lado sem passar por você, e a
    // queda é automática: sem saldo ou fora do ar, o trabalho sai pelo Claude
    // igual. O pior caso é uma tradução um pouco pior no SEU alerta.
    risco: 'baixo',
    // Duas perguntas diferentes, e a segunda é a que o painel já errou antes.
    //
    // Sem chave é o caso óbvio. O caso que engana é a chave PRESENTE e a conta
    // sem saldo: o painel mostraria ✅, o trabalho sairia todo pelo Claude, e a
    // economia simplesmente não aconteceria — sem erro, sem log no WhatsApp,
    // sem nada. É o mesmo desfecho da conversa livre ligada sem
    // ANTHROPIC_API_KEY, que custou uma investigação inteira.
    //
    // O disjuntor do deepseek.js abre depois de três falhas seguidas, e é ele
    // que sabe disso. Aqui só se pergunta.
    impedimento: () => {
      const ds = require('./deepseek');
      if (!ds.temChave()) return 'a chave da IA barata não está no servidor (DEEPSEEK_API_KEY)';
      if (!ds.disponivel()) {
        return 'a IA barata falhou várias vezes seguidas e está parada. O motivo está no log ' +
          '(o mais comum é a conta sem saldo). Enquanto isso o trabalho sai pela cara';
      }
      return null;
    },
  },
];

const porId = (id) => CATALOGO.find((c) => c.id === id) || null;

/** Aceita o número do menu (1-based) ou o nome. Devolve a chave ou null. */
function achar(alvo) {
  const bruto = String(alvo || '').trim().toLowerCase();
  if (!bruto) return null;
  if (/^\d+$/.test(bruto)) return CATALOGO[Number(bruto) - 1] || null;
  return porId(bruto);
}

/**
 * Está ligada?
 *
 * O gravado vence o padrão, e só quando é booleano de verdade: `undefined` e
 * `null` significam "nunca mexeram nisso", que é diferente de "desligado".
 * Foi assim que o `atendimentoLigado` já fazia, e é o que permite apagar a
 * escolha para voltar ao padrão do painel.
 */
function ligada(id) {
  const c = porId(id);
  if (!c) return false;
  const gravado = (dados.chaves || {})[id];
  return typeof gravado === 'boolean' ? gravado : Boolean(c.padrao());
}

/** Alguém já mexeu nesta chave pelo WhatsApp? */
function foiMexida(id) {
  return typeof (dados.chaves || {})[id] === 'boolean';
}

/**
 * Liga ou desliga. `null` apaga a escolha e volta ao padrão do Environment.
 * @returns {{ok:boolean, chave?:object, ligada?:boolean, erro?:string}}
 */
function definir(alvo, valor) {
  const c = achar(alvo);
  if (!c) return { ok: false, erro: 'nao_achei' };

  if (!dados.chaves) dados.chaves = {};
  if (valor === null) delete dados.chaves[c.id];
  else dados.chaves[c.id] = Boolean(valor);

  // persistAgora e não persist: isto é uma decisão do operador, e um deploy
  // logo depois não pode perdê-la no debounce de 400ms.
  persistAgora();

  const agora = ligada(c.id);
  console.log(`[chaves] ${c.id} = ${agora}${valor === null ? ' (voltou ao padrão)' : ''}`);
  return { ok: true, chave: c, ligada: agora };
}

/** Foto de todas, para o painel. */
function situacao() {
  return CATALOGO.map((c, i) => ({
    numero: i + 1,
    id: c.id,
    nome: c.nome,
    curto: c.curto,
    explica: c.explica,
    risco: c.risco,
    cuidado: c.cuidado || null,
    ligada: ligada(c.id),
    // Marca so quando ela ESTA no estado que merece atencao.
    atencao: Boolean(c.perigoQuando) && c.perigoQuando === (ligada(c.id) ? 'ligada' : 'desligada'),
    mexida: foiMexida(c.id),
    // So interessa quando ela esta LIGADA: desligada, nao conseguir rodar nao
    // e novidade nenhuma -- e avisar dos dois jeitos viraria decoracao.
    impedida: ligada(c.id) ? impedimentoDe(c) : null,
  }));
}

/** O motivo de `c` não conseguir rodar, ou null. Nunca deixa erro escapar. */
function impedimentoDe(c) {
  if (typeof c.impedimento !== 'function') return null;
  try {
    return c.impedimento() || null;
  } catch (err) {
    // Um impedimento quebrado não pode derrubar o painel: ele é justamente o
    // comando que o dono usa quando alguma coisa já está errada.
    console.warn(`[chaves] impedimento de ${c.id} falhou: ${err.message}`);
    return null;
  }
}

module.exports = { CATALOGO, ligada, definir, achar, situacao, foiMexida, impedimentoDe };
