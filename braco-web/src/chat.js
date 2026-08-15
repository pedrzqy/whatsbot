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
  // Verificação por SMS
  //
  // Diferente dos bloqueios: aqui a Taobao pede o código que ELA manda para o
  // telefone do dono da conta. Não é anti-bot a ser contornado, é identidade a
  // ser comprovada — e quem comprova é o operador, que recebe o SMS e devolve
  // o número. O braço só faz o transporte, porque o navegador está num
  // container onde ninguém consegue clicar.
  // ----------------------------------------------------------

  /** Estamos na tela de verificação por SMS? */
  async emVerificacaoSms() {
    const texto = await this.pagina.evaluate(() => document.body.innerText).catch(() => '');
    return SEL.verificacaoSms.deteccao.some((m) => texto.includes(m));
  }

  /** Primeiro que existir, direto na página (esta tela não tem iframe). */
  async _acharNaPagina(lista, timeout = 6000) {
    const limite = Date.now() + timeout;
    while (Date.now() < limite) {
      for (const sel of lista) {
        const el = await this.pagina.$(sel);
        if (el) return el;
      }
      await this.pagina.waitForTimeout(300);
    }
    return null;
  }

  /**
   * Tem slider de verificação na tela? Diferente de checarBloqueio(): este
   * só olha e responde, sem lançar. Serve para descrever a situação ao
   * operador em vez de congelar tudo — na tela de login, slider é etapa
   * normal, não incidente.
   */
  async temSlider() {
    for (const sel of SEL.bloqueios.seletores) {
      if (await this.pagina.$(sel)) return true;
    }
    const texto = await this.pagina.evaluate(() => document.body.innerText).catch(() => '');
    return /滑块|滑动验证|拖动/.test(texto);
  }

  /** Clica em 获取短信校验码 para a Taobao disparar o SMS. */
  async pedirSms() {
    const botao = await this._acharNaPagina(SEL.verificacaoSms.botaoEnviarSms);
    if (!botao) return false;
    await botao.click({ delay: humaniza.msCurto() });
    await this.pagina.waitForTimeout(humaniza.ms(1000, 2000));
    return true;
  }

  /** Preenche o código que o operador mandou e confirma. */
  async preencherSms(codigo) {
    const campo = await this._acharNaPagina(SEL.verificacaoSms.campoCodigo);
    if (!campo) throw new SeletorNaoEncontrado('campo do código SMS não encontrado');

    await campo.click();
    await campo.type(String(codigo), { delay: humaniza.msTecla() });
    await this.pagina.waitForTimeout(humaniza.ms(500, 1200));

    const confirmar = await this._acharNaPagina(SEL.verificacaoSms.botaoConfirmar);
    if (!confirmar) throw new SeletorNaoEncontrado('botão 确定 não encontrado');

    await confirmar.click({ delay: humaniza.msCurto() });
    await this.pagina.waitForTimeout(humaniza.ms(3000, 5000));
  }

  // ----------------------------------------------------------

  /**
   * Abre a conversa do fornecedor.
   *
   * O chat é uma SPA: trocar de conversa não muda a URL, então não dá para
   * navegar direto — tem que clicar no item da lista.
   *
   * Clica no PRIMEIRO da lista, não no que casa com o título. O fornecedor
   * fica sempre no topo por ser a conversa mais recente, e clicar por posição
   * não depende de casar texto chinês (que quebra se a loja mudar de nome ou
   * o seletor `:has-text` falhar).
   *
   * MAS confere o título depois de abrir. Se outro fornecedor mandar mensagem,
   * ele pula para o topo — e sem essa conferência o braço mandaria o usuário
   * de um cliente para a loja errada. Posição para clicar, título para
   * confirmar.
   */
  async abrirConversa(titulo) {
    await this.prender();
    await this.checarBloqueio();

    const primeiro = await this._achar('conversaNaLista', { timeout: 12000 });
    await primeiro.el.click({ delay: humaniza.msCurto() });
    await this.pagina.waitForTimeout(humaniza.ms(900, 2000));

    // Painel de digitação carregado = conversa aberta de verdade.
    await this._achar('campoTexto', { timeout: 10000 });

    if (titulo) {
      const abriu = await this.frame
        .evaluate(() => document.body.innerText || '')
        .catch(() => '');
      if (!abriu.includes(titulo)) {
        throw new SeletorNaoEncontrado(
          `Abri a primeira conversa da lista, mas ela não é "${titulo}". ` +
            `Provavelmente outro fornecedor mandou mensagem e subiu para o topo. ` +
            `NÃO enviei nada para não escrever na loja errada.`,
        );
      }
    }

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

  /** Quantas mensagens NOSSAS existem agora. Serve para saber se algo saiu. */
  async _quantasMinhas() {
    const classeSelf = SEL.minhaMensagem.classe;
    return this.frame
      .evaluate((c) => document.querySelectorAll(`.message-item.${c}`).length, classeSelf)
      .catch(() => 0);
  }

  /**
   * Descreve cada input[type=file] do chat.
   *
   * Vai para o log a cada envio de propósito: os ids html5_* mudam a cada
   * carregamento, então não dá para fixar seletor — mas o log conta como o DOM
   * estava NA HORA em que a foto saiu errada, sem precisar de outra inspeção.
   */
  async _mapearInputs() {
    return this.frame
      .$$eval("input[type='file']", (els) =>
        els.map((el) => ({
          accept: el.getAttribute('accept') || '',
          nome: el.getAttribute('name') || '',
          classe: el.className || '',
          paiClasse: el.parentElement ? el.parentElement.className || '' : '',
          paiTitulo: el.parentElement ? el.parentElement.getAttribute('title') || '' : '',
        })),
      )
      .catch(() => []);
  }

  /**
   * Anexa uma imagem — como IMAGEM, não como arquivo.
   *
   * Esta distinção é o ponto todo. O chat da Taobao tem dois uploaders: 图片
   * (imagem, aparece inline no balão) e 文件 (arquivo, aparece como cartão com
   * "下载文件"). Pegar o input errado manda um cartão que o fornecedor teria de
   * baixar — e ele simplesmente não baixa. A foto chega e é como se não tivesse
   * chegado.
   *
   * Os ids html5_* são gerados pelo plupload a CADA carregamento, então a
   * escolha não pode ser por id nem por posição. Vamos por ordem de confiança:
   *
   *   1. input com accept de imagem — é o uploader de imagem se declarando;
   *   2. colar a imagem no campo de texto, como um humano faz com print;
   *   3. primeiro input que aceitar — melhor mandar como arquivo do que nada.
   *
   * O passo 2 só entra se o 1 falhar, e só avança para o 3 se nada tiver saído:
   * assim uma tentativa frustrada não deixa lixo no chat do fornecedor.
   *
   * @returns {Promise<{via:string, comoArquivo:boolean}>}
   */
  async enviarFoto(caminhoLocal) {
    await this.checarBloqueio();

    const mapa = await this._mapearInputs();
    console.log(`[chat] ${mapa.length} input[type=file]: ${JSON.stringify(mapa)}`);

    const antes = await this._quantasMinhas();
    let via = null;

    // ── 1. O uploader de imagem se declara pelo accept ────────
    const iImagem = mapa.findIndex((m) => /image|jpg|jpeg|png|gif|bmp/i.test(m.accept));
    if (iImagem !== -1) {
      const inputs = await this.frame.$$("input[type='file']");
      try {
        await inputs[iImagem].setInputFiles(caminhoLocal);
        via = `accept "${mapa[iImagem].accept}"`;
      } catch (err) {
        console.warn(`[chat] input de imagem recusou: ${err.message}`);
      }
    }

    // ── 2. Colar, como quem dá Ctrl+V num print ───────────────
    if (!via) {
      try {
        await this._colarImagem(caminhoLocal);
        via = 'colagem';
      } catch (err) {
        console.warn(`[chat] colagem falhou: ${err.message}`);
      }
    }

    await this.pagina.waitForTimeout(humaniza.ms(2500, 5000));

    // ── 3. Último recurso: só se NADA saiu ────────────────────
    // A checagem evita mandar a mesma foto duas vezes quando a colagem
    // funcionou mas demorou a aparecer.
    if ((await this._quantasMinhas()) === antes) {
      const inputs = await this.frame.$$("input[type='file']");
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
      via = 'input genérico (fallback)';
      await this.pagina.waitForTimeout(humaniza.ms(2500, 5000));
    }

    await this.checarBloqueio();

    const comoArquivo = await this._ultimaSaiuComoArquivo();
    console.log(`[chat] foto enviada via ${via}${comoArquivo ? ' — SAIU COMO ARQUIVO' : ''}`);
    return { via: via || 'desconhecida', comoArquivo };
  }

  /**
   * Cola a imagem no campo de texto.
   *
   * É o caminho que um humano usa para mandar print: recorta e dá Ctrl+V. O
   * chat trata a colagem como imagem, nunca como anexo — por isso ela serve de
   * plano B quando não dá para identificar o uploader de imagem pelo accept.
   */
  async _colarImagem(caminhoLocal) {
    const b64 = fs.readFileSync(caminhoLocal).toString('base64');
    const nome = path.basename(caminhoLocal);
    const seletores = SEL.campoTexto.candidatos;

    const ok = await this.frame.evaluate(
      ({ b64, nome, seletores }) => {
        const alvo = seletores.map((s) => document.querySelector(s)).find(Boolean);
        if (!alvo) return false;

        const bin = atob(b64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);

        const dt = new DataTransfer();
        dt.items.add(new File([bytes], nome, { type: 'image/jpeg' }));

        alvo.focus();
        return alvo.dispatchEvent(
          new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }),
        );
      },
      { b64, nome, seletores },
    );

    if (!ok) throw new SeletorNaoEncontrado('campo de texto não aceitou a colagem');
  }

  /**
   * A última mensagem nossa virou cartão de arquivo em vez de imagem?
   *
   * Precisa ser conferido: quando dá errado, o envio "funciona" — a mensagem
   * sai, o braço reporta sucesso, e só o fornecedor descobre que recebeu um
   * anexo que não vai abrir. Sem esta checagem ninguém fica sabendo.
   */
  async _ultimaSaiuComoArquivo() {
    const classeSelf = SEL.minhaMensagem.classe;
    return this.frame
      .evaluate((c) => {
        const meus = document.querySelectorAll(`.message-item.${c}`);
        const ultimo = meus[meus.length - 1];
        if (!ultimo) return false;
        if (ultimo.querySelector('img')) return false; // imagem de verdade
        return /下载文件|下載檔案|未读文件/.test(ultimo.innerText || '');
      }, classeSelf)
      .catch(() => false);
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
          const limpo = texto
            .split('\n')
            .map((l) => l.trim())
            .filter((l) => l && !ruido.includes(l))
            .join(' ')
            .trim();

          // Balão SEM texto mas COM imagem: o fornecedor respondeu mandando um
          // print em vez de digitar. Sem este ramo a mensagem seria descartada
          // em silêncio e o cliente esperaria até o timeout de 4h sem ninguém
          // saber por quê. Marcamos para o operador olhar — ler código de
          // dentro de imagem por OCR não tem confiança suficiente para
          // entregar sozinho (trocar 8 por 3 num código é prejuízo).
          const temImagem = Boolean(
            el.querySelector('img, [class*="image"], [class*="picture"]'),
          );
          if (!limpo && !temImagem) continue;

          // O innerText do balão traz "nick\nAAAA-MM-DD HH:MM:SS\nconteúdo".
          const bruto = el.innerText || '';
          const mData = bruto.match(/\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}/);
          const quando = mData ? mData[0] : '';
          const nick = (bruto.split('\n')[0] || '').trim();

          const conteudo = limpo || '[o fornecedor respondeu com uma imagem]';
          saida.push({ chave: `${nick}|${quando}|${conteudo}`, texto: conteudo, quando });
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
