'use strict';

/**
 * DeepSeek — o modelo barato, e só para o trabalho de bastidor.
 *
 * ONDE ELE ENTRA E ONDE NÃO ENTRA
 *
 * Entra: o analista (#analisar), a tradução do que o outro lado escreve, e a
 * escolha da linha do repertório. Os três têm a mesma forma — ninguém está
 * esperando na tela, o texto vai para uma pessoa ler antes de virar qualquer
 * coisa, e o volume de token é alto porque a entrada é grande.
 *
 * NÃO entra na conversa com o cliente. Isso não é preferência de modelo, é a
 * lição que já custou caro aqui: existia uma cascata de seis provedores no
 * caminho do atendimento, e cada um fora do ar somava até 40 segundos de
 * "digitando..." antes de o próximo ser tentado. Ela foi removida de propósito
 * (ver ai.js). Botar um provedor novo ali seria refazer o mesmo erro com outro
 * nome. No atendimento continua só o Claude, e a rede embaixo dele é o menu.
 *
 * O SEGUNDO MOTIVO é a foto: o cliente manda print de tela de erro o tempo
 * todo, e o modelo de texto não enxerga. Existe um `-vision-exp` no catálogo
 * deles, mas "exp" no nome de um caminho que o cliente usa todo dia não é
 * lugar de economizar.
 *
 * FORMATO: a API deles é compatível com a da OpenAI, que é exatamente o
 * formato em que as mensagens já circulam neste projeto ({role, content},
 * tool_calls, role:'tool'). Então aqui não tem conversão nenhuma — ao
 * contrário do claude.js, que existe quase inteiro para traduzir formato. É por
 * isso que este arquivo é curto.
 *
 * FALHA: nunca propaga como problema. Sem chave, sem saldo ou fora do ar, o
 * chamador cai no Claude e o desfecho é idêntico ao de antes deste arquivo
 * existir. O que muda é só a conta no fim do mês.
 */

const BASE = (process.env.DEEPSEEK_URL || 'https://api.deepseek.com').replace(/\/+$/, '');

/**
 * O modelo. `flash` e não `pro`: o trabalho daqui é resumir, agrupar e
 * traduzir — nada que precise do modelo caro. Trocar é variável de ambiente,
 * sem deploy.
 */
const MODELO = process.env.DEEPSEEK_MODELO || 'deepseek-v4-flash';

/** Teto de tempo. Nenhum destes trabalhos tem gente esperando na tela. */
const TIMEOUT_MS = Number(process.env.DEEPSEEK_TIMEOUT_MS) || 60_000;

// ── O disjuntor ─────────────────────────────────────────────
//
// Chave sem saldo responde 402 na hora, e isso já é o melhor caso. O caso ruim
// é o provedor pendurado: aí cada chamada custa o timeout inteiro ANTES de
// cair no Claude, e o trabalho passa a demorar o dobro para dar no mesmo.
//
// Foi exatamente isso que matou a cascata antiga (Cerebras com a cota vencida,
// Gemini em 503), então a trava vem junto com o provedor, e não depois do
// primeiro susto: três falhas seguidas e ele para de ser tentado por meia hora.
// Um sucesso zera a contagem.
const FALHAS_ATE_DESISTIR = 3;
const DESCANSO_MS = 30 * 60 * 1000;
let falhasSeguidas = 0;
let dormindoAte = 0;

/**
 * Contador do dia, para dar para responder "está economizando mesmo?".
 *
 * Em memória de propósito, igual ao do claude.js: reiniciar zerar é o
 * comportamento certo, e evita mais um arquivo de estado no disco.
 */
const contador = { dia: null, n: 0, entrada: 0, cache: 0, saida: 0 };

function contarChamada(u = {}) {
  const hoje = new Date().toISOString().slice(0, 10);
  if (contador.dia !== hoje) {
    contador.dia = hoje;
    contador.n = 0;
    contador.entrada = 0;
    contador.cache = 0;
    contador.saida = 0;
  }
  contador.n += 1;
  contador.entrada += u.prompt_tokens || 0;
  // O cache deles é automático e não custa nada para ligar. Aparece separado
  // porque é ele que explica uma conta menor sem menos trabalho feito.
  contador.cache += u.prompt_cache_hit_tokens || 0;
  contador.saida += u.completion_tokens || 0;
}

function uso() {
  return { ...contador, modelo: MODELO, dormindo: Date.now() < dormindoAte };
}

/** Tem chave configurada? */
function temChave() {
  return Boolean(process.env.DEEPSEEK_API_KEY);
}

/**
 * Dá para usar AGORA?
 *
 * Separado de `temChave` porque as duas perguntas têm respostas diferentes: a
 * chave pode estar lá e o provedor estar de castigo. Quem decide se tenta é o
 * ai.js, e ele precisa da segunda.
 */
function disponivel() {
  return temChave() && Date.now() >= dormindoAte;
}

/**
 * Uma chamada. Mesma assinatura do claude.chat, de propósito: o ai.js escolhe
 * entre os dois sem saber a diferença.
 *
 * @param {Array<{role:string, content:any}>} messages
 * @param {{maxTokens?:number, temperature?:number, deadline?:number}} [opts]
 * @returns {Promise<{role:'assistant', content:string|null, tool_calls?:object[]}>}
 */
async function chat(messages, opts = {}) {
  if (!temChave()) throw new Error('DEEPSEEK_API_KEY não configurada');

  // O disjuntor também na porta, e não só no ai.js.
  //
  // Quem chama hoje consulta `disponivel()` antes, então esta linha nunca
  // dispara. Ela existe para o segundo chamador — o que vier depois, copiando
  // a linha do primeiro sem saber que existe um disjuntor. A trava que depende
  // de cada chamador lembrar dela é a que já falhou aqui, mais de uma vez.
  if (Date.now() < dormindoAte) {
    throw new Error('DeepSeek em descanso depois de falhar várias vezes');
  }

  const resta = opts.deadline ? opts.deadline - Date.now() : TIMEOUT_MS;
  if (resta < 2000) throw new Error('prazo curto demais para o DeepSeek');

  // AbortController e não só o timeout do axios: sem ele uma conexão pendurada
  // segura o processo depois de o chamador já ter desistido.
  const corte = new AbortController();
  const relogio = setTimeout(() => corte.abort(), Math.min(resta, TIMEOUT_MS));

  let dados;
  try {
    const r = await fetch(`${BASE}/chat/completions`, {
      method: 'POST',
      signal: corte.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`,
      },
      body: JSON.stringify(montarCorpo(messages, opts)),
    });

    if (!r.ok) {
      const corpo = await r.text().catch(() => '');
      throw new Error(`HTTP ${r.status} ${explicar(r.status, corpo)}`);
    }
    dados = await r.json();
  } catch (err) {
    registrarFalha(err);
    throw err;
  } finally {
    clearTimeout(relogio);
  }

  const msg = dados?.choices?.[0]?.message;
  if (!msg) {
    // 200 sem mensagem é resposta inútil, e tratar como sucesso faria o
    // chamador gravar um relatório vazio achando que analisou.
    const vazio = new Error('resposta sem conteúdo');
    registrarFalha(vazio);
    throw vazio;
  }

  falhasSeguidas = 0;
  contarChamada(dados.usage);
  const u = dados.usage || {};
  console.log(
    `[deepseek] ${MODELO} · entrada ${u.prompt_tokens || 0}` +
      ` (cache ${u.prompt_cache_hit_tokens || 0}) · saída ${u.completion_tokens || 0}`,
  );

  return {
    role: 'assistant',
    content: typeof msg.content === 'string' ? msg.content.trim() || null : null,
    ...(msg.tool_calls?.length ? { tool_calls: msg.tool_calls } : {}),
  };
}

/**
 * O corpo do POST.
 *
 * `temperature` VAI aqui, ao contrário do claude.js — lá ela foi removida do
 * modelo e derruba a chamada com 400. Aqui ela existe e o padrão é 1.0, que é
 * alto para o que se faz neste projeto: agrupar, traduzir e classificar são
 * tarefas em que variar a resposta é defeito, não criatividade.
 */
function montarCorpo(messages, opts) {
  return {
    model: MODELO,
    messages: messages.map((m) => ({
      role: m.role,
      content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? ''),
      ...(m.tool_calls ? { tool_calls: m.tool_calls } : {}),
      ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}),
    })),
    max_tokens: opts.maxTokens || 2000,
    temperature: typeof opts.temperature === 'number' ? opts.temperature : 0.2,
    stream: false,
  };
}

/**
 * O que o dono resolve sozinho, em português.
 *
 * O corpo cru da API no log é o que fez uma investigação inteira ser gasta com
 * o Claude: um 400 de chave e um 400 de pedido malformado ficam idênticos
 * assim, e o desfecho é o mesmo nos dois casos.
 */
function explicar(status, corpo) {
  if (status === 402) return '— a conta do DeepSeek está sem saldo. Põe crédito em platform.deepseek.com';
  if (status === 401) return '— a DEEPSEEK_API_KEY está errada ou foi revogada';
  if (status === 429) return '— passou do limite de chamadas por minuto';
  if (status >= 500) return '— o DeepSeek está fora do ar';
  return String(corpo || '').slice(0, 200);
}

function registrarFalha(err) {
  falhasSeguidas += 1;
  console.warn(`[deepseek] falhou (${falhasSeguidas}/${FALHAS_ATE_DESISTIR}): ${err.message}`);
  if (falhasSeguidas >= FALHAS_ATE_DESISTIR) {
    dormindoAte = Date.now() + DESCANSO_MS;
    falhasSeguidas = 0;
    console.warn(
      `[deepseek] três falhas seguidas — parado por ${DESCANSO_MS / 60000} min. ` +
        `O trabalho continua, só que pelo Claude.`,
    );
  }
}

/** Só para o teste: volta ao estado de recém-carregado. */
function _zerar() {
  falhasSeguidas = 0;
  dormindoAte = 0;
  contador.dia = null;
}

module.exports = { chat, disponivel, temChave, uso, montarCorpo, explicar, MODELO, BASE, _zerar };
