'use strict';

/**
 * Operações no chat web da Taobao.
 *
 * Tudo acontece DENTRO do iframe chat-core (ver frame.js). Seletor aplicado na
 * página externa não acha nada — a casca externa é só a nav da Taobao.
 *
 * A leitura usa MARCA D'ÁGUA, não hash de conteúdo. Antes de enviar registramos
 * quantas mensagens existem; depois, só olhamos o que veio além disso. Duas
 * razões, ambas achadas na marra:
 *
 *  1. O chat tem MESES de histórico visível. Ler tudo entregaria centenas de
 *     códigos antigos como se fossem novos.
 *  2. Código de 6 dígitos repete. Deduplicar por conteúdo faria o segundo
 *     cliente a receber "394860" ficar esperando para sempre, sem erro nenhum.
 */

const fs = require('fs');
const path = require('path');
const frameHelper = require('./frame');
const humaniza = require('./humaniza');

const SEL = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'seletores.json'), 'utf8'),
);

class BloqueioDetectado extends Error {}
class SeletorNaoEncontrado extends Error {}

class Chat {
  constructor(pagina) {
    this.pagina = pagina;
    this.frame = null;
  }

  async prender() {
    this.frame = await frameHelper.doChat(this.pagina);
    return this.frame;
  }

  /** Primeiro seletor da lista que existir. {titulo} é interpolado. */
  async _achar(chave, { titulo = '', timeout = 8000 } = {}) {
    const lista = SEL[chave].candidatos.map((s) => s.replace('{titulo}', titulo));
    const limite = Date.now() + timeout;

    while (Date.now() < limite) {
      for (const sel of lista) {
        const el = await this.frame.$(sel);
        if (el) return { el, sel };
      }
      await this.pagina.waitForTimeout(300);
    }
    throw new SeletorNaoEncontrado(
      `"${chave}" não encontrado. Tentei: ${lista.join(' | ')}. ` +
        `Rode "npm run inspecionar" e atualize o seletores.json.`,
    );
  }

  /**
   * Procura tela de verificação. Chamado antes e depois de cada ação.
   * Nunca tenta resolver: o slider avalia a trajetória do arraste, então
   * script acerta a posição e falha a biometria — e tentativa falha soma
   * sinal de bot na conta.
   */
  async checarBloqueio() {
    for (const sel of SEL.bloqueios.seletores) {
      if (await this.pagina.$(sel)) {
        throw new BloqueioDetectado(`elemento de verificação na tela: ${sel}`);
      }
    }
    const texto = await this.pagina.evaluate(() => document.body.innerText).catch(() => '');
    for (const marcador of SEL.bloqueios.textos) {
      if (texto.includes(marcador)) {
        throw new BloqueioDetectado(`texto de verificação na tela: "${marcador}"`);
      }
    }
  }

  // ----------------------------------------------------------

  async abrirConversa(titulo) {
    await this.prender();
    await this.checarBloqueio();

    const { el } = await this._achar('conversaNaLista', { titulo, timeout: 12000 });
    await el.click({ delay: humaniza.msCurto() });
    await this.pagina.waitForTimeout(humaniza.ms(900, 2000));

    // Confirma que o painel de digitação carregou antes de seguir.
    await this._achar('campoTexto', { timeout: 10000 });
    await this.checarBloqueio();
  }

  /**
   * Marca d'água: as chaves das mensagens do fornecedor visíveis AGORA.
   *
   * Não é contagem nem índice, e isso tem motivo medido: a lista é uma JANELA
   * DESLIZANTE de ~10 mensagens. Duas inspeções com 24h de diferença mostraram
   * sempre 10 itens, mas com uma mensagem nova entrando e a mais antiga saindo.
   * Com marca por índice, eu marcaria em 10, a resposta chegaria no índice 9
   * (porque a lista continua com 10) e seria descartada como "histórico" —
   * o cliente esperaria para sempre, sem erro em log nenhum.
   *
   * A chave é autor + horário + conteúdo. Também resolve o código repetido:
   * "394860" às 18h e "394860" às 19h têm horários diferentes, logo chaves
   * diferentes, logo os dois são detectados.
   *
   * @returns {Promise<string[]>}
   */
  async marca() {
    return this._lerFornecedor().then((ms) => ms.map((m) => m.chave)).catch(() => []);
  }

  // ----------------------------------------------------------

  async enviarTexto(texto) {
    await this.checarBloqueio();

    const { el } = await this._achar('campoTexto');
    await el.click();
    await this.pagina.waitForTimeout(humaniza.ms(300, 800));

    // É um <pre contenteditable>, não um input: fill() não funciona.
    // type() com delay por tecla também produz cadência de digitação humana.
    for (const bloco of humaniza.blocos(texto)) {
      await el.type(bloco, { delay: humaniza.msTecla() });
      await this.pagina.waitForTimeout(humaniza.ms(150, 500));
    }

    await this.pagina.waitForTimeout(humaniza.ms(400, 1100));

    // Botão em vez de Enter: dentro de um <pre>, Enter pode inserir quebra de
    // linha em vez de enviar, dependendo da versão.
    const botao = await this._achar('botaoEnviar');
    await botao.el.click({ delay: humaniza.msCurto() });

    await this.pagina.waitForTimeout(humaniza.ms(1000, 2200));
    await this.checarBloqueio();
  }

  /**
   * Anexa uma imagem.
   *
   * Os ids html5_* dos inputs são gerados pelo plupload a CADA carregamento —
   * usar id aqui quebraria na próxima sessão. Por isso pegamos todos os
   * input[type=file] e tentamos um por um até algum aceitar.
   */
  async enviarFoto(caminhoLocal) {
    await this.checarBloqueio();

    const inputs = await this.frame.$$(SEL.inputArquivo.candidatos[0]);
    if (!inputs.length) {
      throw new SeletorNaoEncontrado('nenhum input[type=file] no frame do chat');
    }

    let anexou = false;
    for (const input of inputs) {
      try {
        await input.setInputFiles(caminhoLocal);
        anexou = true;
        break;
      } catch {
        // input escondido/desconectado — tenta o próximo
      }
    }
    if (!anexou) {
      throw new SeletorNaoEncontrado(
        `nenhum dos ${inputs.length} input[type=file] aceitou o arquivo`,
      );
    }

    // O upload precisa terminar antes de mandar o texto, senão a foto chega
    // depois da pergunta e o fornecedor responde "qual foto?".
    await this.pagina.waitForTimeout(humaniza.ms(2500, 5000));
    await this.checarBloqueio();
  }

  // ----------------------------------------------------------

  /**
   * Todas as mensagens do FORNECEDOR visíveis, com chave de identidade.
   * Uso interno: marca() e lerNovas() partem daqui.
   * @returns {Promise<{chave:string, texto:string, quando:string}[]>}
   */
  async _lerFornecedor() {
    await this.prender();

    const selMensagem = SEL.mensagem.candidatos[0];
    const classeSelf = SEL.minhaMensagem.classe;
    const selConteudo = SEL.conteudoDaMensagem.candidatos;
    const ruido = SEL.ruido.textos;

    return this.frame.$$eval(
      selMensagem,
      (els, args) => {
        const { classeSelf, selConteudo, ruido } = args;
        const saida = [];

        for (const el of els) {
          if (el.classList.contains(classeSelf)) continue; // mensagem nossa

          // .content tem que ser buscado DENTRO do balão: a mesma classe é
          // usada nos itens da lista lateral e traria nome de loja.
          let texto = '';
          for (const s of selConteudo) {
            const alvo = el.querySelector(s);
            if (alvo && alvo.innerText.trim()) {
              texto = alvo.innerText.trim();
              break;
            }
          }
          if (!texto) continue;

          const limpo = texto
            .split('\n')
            .map((l) => l.trim())
            .filter((l) => l && !ruido.includes(l))
            .join(' ')
            .trim();
          if (!limpo) continue;

          // O innerText do balão traz "nick\nAAAA-MM-DD HH:MM:SS\nconteúdo".
          const bruto = el.innerText || '';
          const mData = bruto.match(/\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}/);
          const quando = mData ? mData[0] : '';
          const nick = (bruto.split('\n')[0] || '').trim();

          saida.push({ chave: `${nick}|${quando}|${limpo}`, texto: limpo, quando });
        }

        return saida;
      },
      { classeSelf, selConteudo, ruido },
    );
  }

  /**
   * Mensagens do fornecedor que NÃO estavam na marca — ou seja, chegaram
   * depois do nosso envio.
   * @param {string[]} marca  retorno de marca() feito antes de enviar
   * @returns {Promise<{texto:string, quando:string}[]>}
   */
  async lerNovas(marca) {
    const conhecidas = new Set(marca || []);
    const todas = await this._lerFornecedor();
    return todas
      .filter((m) => !conhecidas.has(m.chave))
      .map(({ texto, quando }) => ({ texto, quando }));
  }
}

module.exports = { Chat, BloqueioDetectado, SeletorNaoEncontrado };
