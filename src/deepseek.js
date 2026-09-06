'use strict';

/**
 * DeepSeek — o único cérebro do bot.
 *
 * Este arquivo nasceu para o bastidor: o analista (#analisar), a tradução do
 * que o outro lado escreve, a escolha da linha do repertório. Trabalho em que
 * ninguém está esperando na tela e o texto passa por uma pessoa antes de virar
 * qualquer coisa. Ele dizia, em letras grandes, que NÃO entrava na conversa
 * com o cliente — ali era o Claude.
 *
 * O dono trocou. Agora é este modelo nos dois lados, e o Claude saiu.
 *
 * O que isso muda de verdade são três coisas, e todas estão neste arquivo:
 *
 * 1 · FOTO. Ele não enxerga (VE_IMAGEM). O cliente manda print de tela de erro
 *     todo dia, então quem trata isso é o handlers: pede o CÓDIGO do erro, que
 *     o telas.js resolve sozinho sem modelo nenhum. Existe um `-vision-exp` no
 *     catálogo deles, mas "exp" num caminho que o cliente usa todo dia não é
 *     lugar de economizar. Aqui embaixo, o achatarConteudo garante que uma foto
 *     que escape nunca vire base64 mandado como texto.
 *
 * 2 · FERRAMENTA. O bastidor nunca chamou nenhuma; o atendimento chama, e é
 *     assim que ele sabe preço e status de pedido. Ver montarCorpo.
 *
 * 3 · TETO. Bastidor é volume que o operador dispara. Cliente é volume que
 *     ninguém controla. Ver TETO_DIA.
 *
 * FORMATO: a API deles é compatível com a da OpenAI, que é exatamente o
 * formato em que as mensagens já circulam neste projeto ({role, content},
 * tool_calls, role:'tool'). Não tem conversão nenhuma aqui — e é por isso que
 * trocar o cérebro deu menos trabalho do que parecia: a borda que traduzia
 * formato para a Anthropic era um arquivo inteiro, e ela foi embora junto.
 *
 * FALHA: nunca vira mensagem de erro para ninguém. Sem chave, sem saldo, fora
 * do ar, disjuntor aberto ou teto estourado, o chamador cai no MENU — que
 * responde na hora, não custa token e funciona com tudo apagado. Duas camadas,
 * e a de baixo não depende de rede.
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
// é o provedor pendurado: aí cada chamada custa o timeout inteiro ANTES de cair
// no menu, e o cliente vê "digitando..." por um minuto para receber o que o
// menu entrega instantaneamente.
//
// Foi exatamente isso que matou a cascata antiga (Cerebras com a cota vencida,
// Gemini em 503), então a trava vem junto com o provedor, e não depois do
// primeiro susto: três falhas seguidas e ele para de ser tentado por meia hora.
// Um sucesso zera a contagem.
//
// O descanso ENCURTOU de 30 para 10 minutos junto com a troca de cérebro, e o
// motivo é o que está em jogo enquanto ele dorme. Antes era bastidor: meia hora
// sem ele significava um alerta traduzido pior, e ninguém percebia. Agora é o
// atendimento inteiro — meia hora de disjuntor aberto é meia hora de cliente
// recebendo só menu por causa de três falhas que podem ter sido um soluço de
// rede. Dez minutos ainda protege do provedor pendurado (o caso que a trava
// existe para pegar) sem transformar um tropeço em meio expediente.
const FALHAS_ATE_DESISTIR = 3;
const DESCANSO_MS = Number(process.env.DEEPSEEK_DESCANSO_MS) || 10 * 60 * 1000;
let falhasSeguidas = 0;
let dormindoAte = 0;

// ── O teto do dia ───────────────────────────────────────────
//
// Existia no provedor anterior e não aqui, e a diferença fazia sentido enquanto este
// arquivo só atendia bastidor: bastidor é trabalho que o operador dispara, e
// operador não entra em laço. Agora ele responde CLIENTE, que é volume que
// ninguém controla — e o crédito da conta é pequeno de propósito.
//
// O que este teto protege não é a fatura no fim do mês, é a tarde de um dia
// ruim: um cliente em laço, um webhook repetido, um teste que ficou rodando.
// Estourou, cai no menu, que responde na hora e sem token.
//
// 400 é o mesmo número que o Claude usava, e ele é folgado para 30 conversas
// por dia: dá umas 13 chamadas por conversa.
const TETO_DIA = Number(process.env.DEEPSEEK_MAX_DIA) || 400;

/**
 * Contador do dia, para dar para responder "está gastando quanto?".
 *
 * Em memória de propósito: reiniciar zerar é o comportamento certo, e evita
 * mais um arquivo de estado no disco.
 */
const contador = { dia: null, n: 0, entrada: 0, cache: 0, saida: 0 };

function virarODia() {
  const hoje = new Date().toISOString().slice(0, 10);
  if (contador.dia === hoje) return;
  contador.dia = hoje;
  contador.n = 0;
  contador.entrada = 0;
  contador.cache = 0;
  contador.saida = 0;
}

/**
 * Marca mais uma chamada e diz se o teto do dia estourou.
 *
 * Conta ANTES de chamar, e não depois de dar certo, porque o que enche a conta
 * é a tentativa. Uma chamada que falha por timeout já foi cobrada do tempo de
 * todo mundo mesmo que não apareça na fatura.
 */
function contarChamada() {
  virarODia();
  contador.n += 1;
  return { estourou: contador.n > TETO_DIA, n: contador.n };
}

function contarTokens(u = {}) {
  virarODia();
  contador.entrada += u.prompt_tokens || 0;
  // O cache deles é automático e não custa nada para ligar. Aparece separado
  // porque é ele que explica uma conta menor sem menos trabalho feito.
  contador.cache += u.prompt_cache_hit_tokens || 0;
  contador.saida += u.completion_tokens || 0;
}

function uso() {
  return {
    ...contador,
    // `chamadas` e `teto` com estes nomes de propósito: é o que o #status já
    // lia do outro provedor, e trocar o cérebro não deveria obrigar a reescrever
    // a tela que mostra o cérebro.
    chamadas: contador.n,
    teto: TETO_DIA,
    modelo: MODELO,
    dormindo: Date.now() < dormindoAte,
  };
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
 * Uma chamada.
 *
 * @param {Array<{role:string, content:any}>} messages
 * @param {{maxTokens?:number, temperature?:number, deadline?:number, tools?:object[]}} [opts]
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

  // O teto ANTES do disjuntor não seria a mesma coisa: estourar o teto é uma
  // decisão nossa e não conta como falha do provedor. Se contasse, um dia
  // movimentado abriria o disjuntor e a meia hora de castigo cairia por cima
  // de um erro que nunca existiu.
  const { estourou, n } = contarChamada();
  if (estourou) {
    console.warn(`[deepseek] teto diario estourado (${n}/${TETO_DIA}) - o menu assume`);
    throw new Error('teto diário estourado');
  }

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
  contarTokens(dados.usage);
  const u = dados.usage || {};
  console.log(
    `[deepseek] ${n}/${TETO_DIA} · ${MODELO} · entrada ${u.prompt_tokens || 0}` +
      ` (cache ${u.prompt_cache_hit_tokens || 0}) · saída ${u.completion_tokens || 0}`,
  );

  return {
    role: 'assistant',
    content: typeof msg.content === 'string' ? msg.content.trim() || null : null,
    ...(msg.tool_calls?.length ? { tool_calls: msg.tool_calls } : {}),
  };
}

/**
 * O conteúdo de um turno, sempre como TEXTO.
 *
 * Aqui morava a armadilha mais cara do arquivo: qualquer conteúdo que não
 * fosse string virava `JSON.stringify`. O turno de quem manda foto é um ARRAY
 * no formato OpenAI, e dentro dele a imagem inteira vai como data URI — uma
 * foto de celular passa de 500 KB, o que dá mais de cem mil tokens de base64
 * mandados como se fossem a pergunta da pessoa.
 *
 * O pior nem é o preço: a chamada não falha. Ela custa caro, o modelo recebe
 * uma parede de base64 no lugar da pergunta, e responde qualquer coisa. Não
 * tem erro no log, não tem alerta, não tem sintoma além da conta no fim do mês
 * e de uma resposta estranha que ninguém liga à foto.
 *
 * Este modelo não enxerga imagem (ver VE_IMAGEM), então o que sobra é a MARCA
 * de que houve uma foto — exatamente o que o histórico do ai.js já grava. Quem
 * evita chegar aqui com foto é o handlers, que pede o código do erro; isto é a
 * rede embaixo daquilo, para o dia em que um chamador novo esquecer.
 */
function achatarConteudo(conteudo) {
  if (typeof conteudo === 'string') return conteudo;
  if (!Array.isArray(conteudo)) return JSON.stringify(conteudo ?? '');

  const partes = [];
  let temImagem = false;
  for (const b of conteudo) {
    if (typeof b === 'string') partes.push(b);
    else if (b?.type === 'text') partes.push(String(b.text || ''));
    else if (b?.type === 'image_url' || b?.type === 'image') temImagem = true;
  }
  if (temImagem) partes.push('[a pessoa mandou uma foto aqui]');
  return partes.join('\n').trim();
}

/** Ele enxerga foto? Não — e é por isso que existe o achatarConteudo. */
const VE_IMAGEM = false;

/**
 * O corpo do POST.
 *
 * `temperature` VAI aqui: o Opus a rejeita com 400, este modelo não. O padrão
 * dele é 1.0, alto para o que se faz neste projeto — agrupar, traduzir,
 * classificar e responder sobre preço são tarefas em que variar a resposta é
 * defeito, não criatividade.
 *
 * `tools` passou a ir junto, e essa é a diferença entre bastidor e atendimento.
 * O bastidor nunca chamou ferramenta: traduzir e resumir é texto entra, texto
 * sai. O atendimento chama — é assim que ele sabe o preço de um jogo e o status
 * de um pedido. Sem esta linha o modelo responderia sobre a loja de memória, e
 * memória de modelo sobre preço é justamente o que fez a conversa livre ser
 * desligada da primeira vez.
 */
function montarCorpo(messages, opts) {
  return {
    model: MODELO,
    messages: messages.map((m) => ({
      role: m.role,
      content: achatarConteudo(m.content),
      ...(m.tool_calls ? { tool_calls: m.tool_calls } : {}),
      ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}),
    })),
    // O formato do tools.js já é o desta API. Não tem conversão nenhuma aqui,
    // ao contrário da borda que existia para a Anthropic.
    ...(opts.tools?.length ? { tools: opts.tools } : {}),
    max_tokens: opts.maxTokens || 2000,
    temperature: typeof opts.temperature === 'number' ? opts.temperature : 0.2,
    stream: false,
  };
}

/**
 * O que o dono resolve sozinho, em português.
 *
 * O corpo cru da API no log já custou uma investigação inteira no provedor
 * anterior: um 400 de chave e um 400 de pedido malformado ficam idênticos
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
        `O cliente continua atendido, pelo menu.`,
    );
  }
}

/** Só para o teste: volta ao estado de recém-carregado. */
function _zerar() {
  falhasSeguidas = 0;
  dormindoAte = 0;
  contador.dia = null;
}

module.exports = {
  chat, disponivel, temChave, uso, montarCorpo, explicar, MODELO, BASE, _zerar,
  // Exportados para o teste e para quem decide o caminho da foto: sem alcançar
  // o achatarConteudo, o teste da armadilha do base64 dublaria justamente a
  // função que deveria estar medindo.
  achatarConteudo, VE_IMAGEM, TETO_DIA,
};
