'use strict';

/**
 * Tradução PT-BR ⇄ ZH-CN para a ponte com o fornecedor.
 *
 * Usa a MESMA cascata de provedores do ai.js (Gemini → Cerebras → Groq →
 * Mistral → Cohere → OpenRouter). Não introduz provedor novo: se um cai, o
 * próximo assume, e o bot já paga por essas chaves.
 *
 * O glossário existe porque tradução genérica erra feio no vocabulário de
 * e-commerce chinês de games: 全新 vira "totalmente novo" em vez de "lacrado",
 * 拍下 vira "fotografar" em vez de "fechar o pedido", 亲 vira "querido".
 * Errar isso não é deselegante — é fechar pedido errado.
 */

/**
 * ai.js é carregado SOB DEMANDA, não no topo, para quebrar um ciclo de require:
 *   tools.js → ponte/index.js → ponte/tradutor.js → ai.js → tools.js
 * Em CommonJS, o último elo receberia um `tools` ainda vazio e o function
 * calling do bot pararia de funcionar inteiro. Requerendo aqui dentro, o ciclo
 * só se fecha em tempo de execução, quando todos os módulos já existem.
 */
const carregarAi = () => require('../ai');

const GLOSSARIO = `
GLOSSÁRIO — games e eletrônicos
手柄=controle · 主机=console · 掌机=portátil/handheld · 模拟器=emulador
摇杆=analógico · 十字键=direcional · 屏幕=tela · 电池=bateria
充电器=carregador · 数据线=cabo · 内存卡=cartão de memória · 固件=firmware
改装=modificado · 破解=desbloqueado · 越狱=jailbreak · 芯片=chip
主板=placa-mãe · 外壳=carcaça · 散热=dissipação · 震动=vibração
霍尔摇杆=analógico hall effect · 漂移=drift do analógico

GLOSSÁRIO — comércio (o que mais dá prejuízo se errar)
全新=novo/lacrado · 二手=usado · 九成新=seminovo · 现货=em estoque
缺货/没货=sem estoque · 补货=reposição · 预售=pré-venda · 包邮=frete grátis
运费=frete · 发货=despacho/envio · 快递=transportadora · 物流=logística
单号=código de rastreio · 拍下=fechar o pedido · 链接=link do produto
库存=estoque · 颜色分类=variação de cor · 尺寸=tamanho · 规格=especificação
保修=garantia · 退货=devolução · 换货=troca · 质量问题=defeito de fábrica
批发=atacado · 零售=varejo · 起订量=pedido mínimo · 优惠=desconto · 议价=negociar

TRATAMENTO
Vendedor chinês chama o comprador de 亲 ("querido"). Ao traduzir ZH→PT,
troque por nada ou por "oi" — NUNCA por "querido".
`.trim();

const BASE =
  'Você é o tradutor da Phaze Games, loja brasileira que importa games, consoles e ' +
  'portáteis retrô de fornecedores da Taobao.\n\n' +
  'REGRAS\n' +
  '1. Traduza a INTENÇÃO, não palavra por palavra. O cliente escreve como fala, com gíria e erro de digitação.\n' +
  '2. Preserve números, códigos, SKUs, modelos e links EXATAMENTE como estão.\n' +
  '3. Nunca invente informação que não estava na origem. Se está ambíguo, mantenha a ambiguidade.\n' +
  '4. Responda SOMENTE com o JSON pedido. Sem comentário, sem markdown, sem cerca de código.\n\n' +
  GLOSSARIO;

/** Extrai JSON mesmo quando o modelo embrulha em ```json ... ```. */
function extrairJson(bruto) {
  const texto = String(bruto || '').trim();
  const semCerca = texto.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  const inicio = semCerca.indexOf('{');
  const fim = semCerca.lastIndexOf('}');
  if (inicio === -1 || fim <= inicio) return null;
  try {
    return JSON.parse(semCerca.slice(inicio, fim + 1));
  } catch {
    return null;
  }
}

/**
 * @param {'pt_para_zh'|'zh_para_pt'} direcao
 * @param {string} texto
 * @param {Array<{papel:string, origem:string}>} historico  últimas trocas, para contexto
 * @returns {Promise<{traducao:string, resumo:string, confianca:'alta'|'media'|'baixa'}>}
 */
async function traduzir(direcao, texto, historico = []) {
  const origem = String(texto || '').trim();
  if (!origem) {
    return { traducao: '', resumo: '', confianca: 'baixa' };
  }

  const instrucao =
    direcao === 'pt_para_zh'
      ? 'Traduza a mensagem do CLIENTE BRASILEIRO para CHINÊS SIMPLIFICADO, pronta para colar no chat da Taobao. ' +
        'Use o registro comercial padrão do Taobao: educado, direto, sem floreio.'
      : 'Traduza a mensagem do FORNECEDOR CHINÊS para PORTUGUÊS DO BRASIL, pronta para mandar no WhatsApp. ' +
        'Escreva como atendente brasileiro escreve: claro, curto, sem formalidade. Não use "prezado".';

  const contexto = historico
    .slice(-6)
    .map((h) => `[${h.papel === 'cliente' ? 'CLIENTE' : 'FORNECEDOR'}] ${h.origem}`)
    .join('\n');

  const messages = [
    { role: 'system', content: BASE },
    {
      role: 'user',
      content:
        (contexto ? `Conversa até aqui:\n${contexto}\n\n` : '') +
        `${instrucao}\n\n` +
        `Responda em JSON com exatamente estas chaves:\n` +
        `{"traducao":"<só a tradução>","resumo":"<uma linha em português do que a mensagem diz>",` +
        `"confianca":"alta|media|baixa"}\n\n` +
        `Use confianca "baixa" se a origem estiver truncada, ambígua ou cheia de gíria intraduzível.\n\n` +
        `---\n${origem}`,
    },
  ];

  try {
    // temperatura baixa: tradução comercial não é lugar para criatividade.
    //
    // `barato: true`: quem lê esta tradução é o OPERADOR, num alerta, e ele
    // decide o que fazer com ela — nada sai daqui direto para o cliente sem o
    // #enviar. É a definição de trabalho de bastidor. E chinês comercial curto
    // é justamente onde um modelo chinês barato não fica devendo nada.
    const msg = await carregarAi().chat(messages, {
      temperature: 0.2,
      maxTokens: 800,
      barato: true,
    });
    const json = extrairJson(msg.content);

    if (json && json.traducao) {
      return {
        traducao: String(json.traducao).trim(),
        resumo: String(json.resumo || '').trim(),
        confianca: ['alta', 'media', 'baixa'].includes(json.confianca) ? json.confianca : 'media',
      };
    }

    // O modelo respondeu, mas fora do formato. Aproveita o texto e marca baixa
    // confiança — melhor um humano revisar do que descartar a resposta.
    const cru = String(msg.content || '').trim();
    if (cru) return { traducao: cru, resumo: '', confianca: 'baixa' };

    throw new Error('resposta vazia do modelo');
  } catch (err) {
    console.error('[ponte/tradutor] falhou:', err.response?.status || err.message);
    throw err;
  }
}

const paraFornecedor = (texto, historico) => traduzir('pt_para_zh', texto, historico);
const paraCliente = (texto, historico) => traduzir('zh_para_pt', texto, historico);

module.exports = { paraFornecedor, paraCliente };
