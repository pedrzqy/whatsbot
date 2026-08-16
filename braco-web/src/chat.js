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
const os = require('os');
const path = require('path');
const { execFile, spawn } = require('child_process');
const frameHelper = require('./frame');
const humaniza = require('./humaniza');

const rodar = (cmd, args) =>
  new Promise((ok, erro) =>
    // timeout obrigatório: sem ele, um binário que trava trava o braço junto,
    // sem log e sem fim — foi o que aconteceu no envio que ficou mudo.
    execFile(cmd, args, { timeout: 10_000 }, (e, stdout, stderr) =>
      e ? erro(new Error(stderr || e.message)) : ok(stdout),
    ),
  );

/**
 * Corta uma promessa que demora demais.
 *
 * Todo passo do envio precisa de teto. Um passo sem teto não falha: ele PARA, e
 * parar é o pior estado possível aqui — o braço não avança nem cai, o cliente
 * espera, e o log fica na última linha para sempre.
 */
const comLimite = (promessa, ms, oQue) =>
  Promise.race([
    promessa,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`${oQue} passou de ${ms}ms`)), ms)),
  ]);

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

    // Procura o primeiro VISÍVEL, não o primeiro do DOM.
    //
    // Esta é a origem do "element is not visible" que derrubou o envio do
    // usuário depois da foto já ter saído. `frame.$()` devolve o primeiro nó
    // que casa, visível ou não — e este chat é uma SPA com a lista de
    // conversas ao lado, então existe mais de um contenteditable/pre.edit no
    // documento. O braço pegava um oculto e o Playwright ficava os 8s inteiros
    // esperando ele aparecer, coisa que nunca ia acontecer.
    //
    // Um elemento que não fica visível em 8s não está lento, está errado.
    let achadosOcultos = 0;

    while (Date.now() < limite) {
      achadosOcultos = 0;
      for (const sel of lista) {
        for (const el of await this.frame.$$(sel).catch(() => [])) {
          if (await el.isVisible().catch(() => false)) return { el, sel };
          achadosOcultos++;
        }
      }
      await this.pagina.waitForTimeout(300);
    }

    // Distingue "não existe" de "existe escondido". São problemas diferentes:
    // o primeiro é seletor desatualizado (conserta no seletores.json), o
    // segundo é a tela em outro estado — modal por cima, conversa não aberta,
    // painel ainda montando. Antes os dois davam a mesma mensagem, e o custo
    // era 8s de clique cego antes de descobrir qual era.
    if (achadosOcultos) {
      throw new SeletorNaoEncontrado(
        `"${chave}": ${achadosOcultos} elemento(s) casaram mas NENHUM está visível. ` +
          `A tela provavelmente está noutro estado (modal aberto, conversa não aberta).`,
      );
    }

    throw new SeletorNaoEncontrado(
      `"${chave}" não encontrado. Tentei: ${lista.join(' | ')}. ` +
        `Rode "npm run inspecionar" e atualize o seletores.json.`,
    );
  }

  /**
   * Clica com TETO DE TEMPO. Todo clique do braço passa por aqui.
   *
   * O `.click()` do Playwright sem `timeout` usa 30 SEGUNDOS. Era o buraco no
   * teto de tempo que a gente achou que tinha fechado: `_achar` limita o tempo
   * de ACHAR o elemento, mas o clique seguinte ficava com o default. Daí saiu
   * o "elementHandle.click: Timeout 30000ms exceeded" que congelou os envios —
   * meio minuto parado por clique, em cada tentativa, até estourar tudo.
   *
   * O "element is not stable" do mesmo log é a lista ainda rolando: o
   * Playwright espera o elemento parar de se mexer antes de clicar, e a
   * rolagem que corrigimos em _irParaOFim() mantinha a tela em movimento.
   * scrollIntoViewIfNeeded resolve o par dele, "element is not visible".
   *
   * 8s é folga grande para clicar em algo já encontrado. Passou disso não é
   * lentidão, é a tela em outro estado — e falhar rápido avisa o operador
   * enquanto o cliente ainda está na conversa.
   */
  async _clicar(el, { timeout = 8000 } = {}) {
    await el.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
    await el.click({ delay: humaniza.msCurto(), timeout });
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
        // Primeiro VISÍVEL, mesmo motivo do _achar: `$()` devolve o primeiro nó
        // do DOM ainda que oculto, e o clique seguinte queima o timeout inteiro
        // esperando ele aparecer. Aqui isso é pior que no envio — este caminho
        // é o do SMS, e SMS que não entra derruba a sessão da conta.
        for (const el of await this.pagina.$$(sel).catch(() => [])) {
          if (await el.isVisible().catch(() => false)) return el;
        }
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
    await this._clicar(botao);
    await this.pagina.waitForTimeout(humaniza.ms(1000, 2000));
    return true;
  }

  /** Preenche o código que o operador mandou e confirma. */
  async preencherSms(codigo) {
    const campo = await this._acharNaPagina(SEL.verificacaoSms.campoCodigo);
    if (!campo) throw new SeletorNaoEncontrado('campo do código SMS não encontrado');

    await this._clicar(campo);
    await campo.type(String(codigo), { delay: humaniza.msTecla(), timeout: 15_000 });
    await this.pagina.waitForTimeout(humaniza.ms(500, 1200));

    const confirmar = await this._acharNaPagina(SEL.verificacaoSms.botaoConfirmar);
    if (!confirmar) throw new SeletorNaoEncontrado('botão 确定 não encontrado');

    await this._clicar(confirmar);
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
    await this._clicar(primeiro.el, { timeout: 10000 });
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
  /**
   * Rola a lista de mensagens até o fim.
   *
   * Sem isto a marca d'água mente. Ela é um retrato do que está RENDERIZADO, e
   * o chat só renderiza a janela visível: se a página estiver rolada para cima
   * — coisa que o diálogo de imagem faz sozinho — mensagens de meses atrás
   * aparecem no DOM, ficam de fora da marca, e na leitura seguinte passam por
   * "resposta nova". Foi assim que conversa de outro dia chegou na fila de
   * aprovação como se fosse a resposta do cliente da vez.
   *
   * É rolagem local: não gera clique nem requisição, a Taobao não vê nada.
   */
  async _irParaOFim() {
    // 1) O caminho da própria Taobao. Ela mostra 回到底部 quando a lista não
    //    está no fim, então a presença do botão já é o diagnóstico e o clique
    //    é a cura — sem adivinhar qual elemento rola. Busca curta e sem espera:
    //    botão ausente quer dizer "já está no fim", não "ainda vai aparecer".
    //    Procurado no iframe E na página: o botão apareceu na tela com a
    //    lista rolada no meio enquanto o braço seguia adiante, o que só
    //    acontece se a busca não o alcança. _cancelarDialogoImagem() já busca
    //    nas duas raízes pelo mesmo motivo — nem tudo deste chat mora dentro
    //    do chat-core.
    const raizes = [this.frame, this.pagina];

    for (const raiz of raizes) {
      for (const sel of SEL.voltarAoFundo.candidatos) {
        // VISÍVEL, não só presente. A Taobao mantém o botão no DOM e apenas o
        // esconde quando a lista já está no fim — clicar no oculto queimaria os
        // 4s do teto a cada descida, inclusive nas que não precisavam de nada.
        // E é a visibilidade dele, não a existência, que significa "não estou
        // no fim".
        const candidatos = await raiz.$$(sel).catch(() => []);
        let botao = null;
        for (const c of candidatos) {
          if (await c.isVisible().catch(() => false)) { botao = c; break; }
        }
        if (!botao) continue;

        // Só considera resolvido se o clique DEU CERTO. Engolir a falha e sair
        // deixava a lista onde estava e ainda pulava a rolagem de reserva — o
        // pior dos dois mundos, e silencioso.
        try {
          await this._clicar(botao, { timeout: 4000 });
          await this.pagina.waitForTimeout(humaniza.ms(400, 900));
          console.log(`[chat] desci pelo botão nativo (${sel})`);
          return;
        } catch (err) {
          console.warn(`[chat] botão "${sel}" existe mas não clicou: ${err.message}`);
        }
      }
    }

    // 2) Reserva: rolagem manual, também nas duas raízes.
    //
    // Ela LOGA o que fez. Sem isso, "a lista não desceu" e "a função nem
    // rodou" ficavam idênticos daqui, e foi o que travou o diagnóstico: dava
    // para ver a barra de rolagem no meio, mas não onde a descida se perdeu.
    let desceu = '';
    for (const raiz of raizes) {
      const r = await raiz
        .evaluate((cands) => {
        // Parte da ÚLTIMA mensagem, não da primeira. A versão anterior pegava
        // querySelector('.message-item') — a mais ANTIGA — e subia a partir
        // dela, o que ancorava a rolagem no topo do histórico.
        let ultima = null;
        for (const s of cands) {
          const els = document.querySelectorAll(s);
          if (els.length) { ultima = els[els.length - 1]; break; }
        }
        if (!ultima) return '';

        // Sobe até o primeiro ancestral que realmente rola, mas PARA no body.
        // Sem esse limite o laço chegava em <html> quando a lista ainda não
        // tinha altura suficiente para rolar, e "ir para o fim" virava rolar a
        // página inteira — que é o que fazia a tela do chat saltar.
        let el = ultima.parentElement;
        let caixa = null;
        while (el && el !== document.body && el !== document.documentElement) {
          const estilo = getComputedStyle(el);
          const rola = /auto|scroll|overlay/.test(estilo.overflowY);
          if (rola && el.scrollHeight > el.clientHeight) { caixa = el; break; }
          el = el.parentElement;
        }

        if (caixa) {
          const antes = caixa.scrollTop;
          caixa.scrollTop = caixa.scrollHeight;
          // Diz se MEXEU de verdade. "Rolei" sem deslocamento nenhum é o mesmo
          // que não ter rolado, e era indistinguível no log.
          return `container ${caixa.className || caixa.tagName} ${antes}->${caixa.scrollTop}`;
        }

        // Nenhum container próprio: leva a mensagem à vista com o MÍNIMO de
        // deslocamento. 'nearest' de propósito — 'end'/'start' mexem em todos
        // os ancestrais e devolvem o salto de página que a gente acabou de tirar.
        ultima.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        return 'scrollIntoView';
        }, SEL.mensagem.candidatos)
        .catch(() => '');
      if (r) desceu = r;
    }

    if (desceu) {
      console.log(`[chat] desci rolando — ${desceu}`);
    } else {
      // Alto de propósito: daqui em diante todo clique tem chance de bater em
      // elemento fora da área visível, que é o "element is not visible" do log.
      console.warn('[chat] NÃO consegui descer a lista — nem botão nativo nem container rolável');
    }

    await this.pagina.waitForTimeout(humaniza.ms(400, 900));
  }

  /**
   * Retrato do chat antes de enviar. Tudo além disto é resposta.
   *
   * Guarda DUAS coisas, e as duas fazem falta:
   *
   *  - `chaves`: as mensagens que já estavam lá. Sozinho isso não basta, pelo
   *    motivo explicado em _irParaOFim().
   *  - `ate`: o horário da mensagem mais recente. Este é o corte de verdade —
   *    mensagem com horário anterior é passado, apareça ela no DOM quando
   *    aparecer. Rolagem e virtualização não mexem no relógio.
   */
  /**
   * Desce a conversa até o fim. Público porque o fluxo de envio precisa dele
   * ENTRE os passos, não só antes de ler: depois de confirmar o print a lista
   * fica rolada para cima (o diálogo de imagem faz isso sozinho), e é dali que
   * vem tanto a tela saltando quanto o clique que erra o alvo por estar fora
   * da área visível.
   */
  async irParaOFim() {
    await this._irParaOFim();
  }

  async marca() {
    await this._irParaOFim();

    let ms;
    try {
      ms = await this._lerFornecedor();
    } catch (err) {
      // Marca que NÃO PÔDE ser tirada não é marca vazia. O `.catch(() => [])`
      // daqui tratava as duas igual, e aí lerNovas() enxergava um chat zerado:
      // sem chaves e sem corte de horário, o histórico inteiro passava por
      // "resposta nova" e o primeiro número de meses atrás ia para o cliente
      // da vez. É o erro mais caro possível — código de outro atendimento
      // entra na conta de quem está esperando agora.
      console.warn(`[chat] não consegui tirar a marca: ${err.message}`);
      return { chaves: [], ate: '', confiavel: false };
    }

    const ate = ms.map((m) => m.quando).filter(Boolean).sort().pop() || '';
    return { chaves: ms.map((m) => m.chave), ate, confiavel: true };
  }

  // ----------------------------------------------------------

  /**
   * Digita e envia texto — e CONFIRMA que saiu.
   *
   * A confirmação não é zelo excessivo: quando o diálogo de imagem fica aberto,
   * ele engole o clique no campo e no 发送, e a função terminava "com sucesso"
   * sem nada ter sido enviado. O fornecedor recebia a foto sem o usuário
   * embaixo — inútil para ele — e o cliente esperava as 4h do timeout.
   */
  async enviarTexto(texto) {
    await this.checarBloqueio();

    // Modal aberto engole clique. Cancela antes de tentar digitar.
    await this._cancelarDialogoImagem();

    // E desce ANTES de procurar o campo. Cancelar o diálogo devolve a lista
    // rolada para o meio, e é dali que sai o "element is not visible" do
    // clique seguinte. O executarTarefa já desce depois da foto, mas este
    // caminho também é usado sozinho (reenvio, tentativa 2) — descer nos dois
    // lugares custa uma rolagem local e fecha o buraco.
    await this._irParaOFim();

    for (let tentativa = 1; tentativa <= 2; tentativa++) {
      const { el } = await this._achar('campoTexto');
      await this._clicar(el);
      await this.pagina.waitForTimeout(humaniza.ms(300, 800));

      // Limpa o campo — SEM Ctrl+A.
      //
      // Ctrl+A aqui foi um desastre: o atalho escapou do <pre> e selecionou a
      // PÁGINA inteira (tudo azul na tela), o Delete não apagou nada porque o
      // documento não é editável, e o texto digitado depois não entrou em lugar
      // nenhum. O envio saía com o campo vazio e a Taobao respondia
      // "请输入内容~" — digite algum conteúdo.
      //
      // Mexer no nó direto não tem como vazar para fora dele.
      await el.evaluate((node) => {
        node.textContent = '';
        node.dispatchEvent(new Event('input', { bubbles: true }));
        const sel = node.ownerDocument.getSelection();
        if (sel) sel.removeAllRanges(); // limpa seleção de tentativa anterior
      });
      await this._clicar(el);

      // COLAR primeiro, digitar só se a colagem não pegar.
      //
      // A ordem é essa por causa do 请输入内容~: com type(), o texto aparecia
      // na tela mas o framework da Taobao não o via como conteúdo, e o envio
      // saía vazio. A colagem dispara o evento `paste` nativo, que é o caminho
      // que o chat escuta de verdade.
      //
      // O type() fica atrás porque depende só do Playwright — se o xclip não
      // estiver na imagem, ou o clipboard do X não assumir, ele ainda salva o
      // envio.
      let colou = false;
      try {
        await comLimite(this._ctrlVTexto(texto), 15_000, 'Ctrl+V de texto');
        const agora = await el.evaluate((node) => node.innerText || node.textContent || '');
        colou = agora.includes(texto);
        if (!colou) console.warn('[chat] colagem do texto não pegou — vou digitar');
      } catch (err) {
        console.warn(`[chat] Ctrl+V de texto falhou: ${err.message} — vou digitar`);
      }

      if (!colou) {
        // É um <pre contenteditable>, não um input: fill() não funciona.
        // type() com delay por tecla produz cadência de digitação humana.
        for (const bloco of humaniza.blocos(texto)) {
          // timeout explícito: type() também cai no default de 30s do Playwright
          // se o campo perder a condição de editável no meio da digitação.
          await el.type(bloco, { delay: humaniza.msTecla(), timeout: 15_000 });
          await this.pagina.waitForTimeout(humaniza.ms(150, 500));
        }
      }

      await this.pagina.waitForTimeout(humaniza.ms(400, 1100));

      // O texto ENTROU mesmo no campo?
      //
      // Clicar em enviar com o campo vazio não é inofensivo: a Taobao responde
      // com o aviso amarelo, e aviso é atrito registrado na conta. Se não
      // entrou, nem tenta — vai para a próxima tentativa.
      const noCampo = await el.evaluate((node) => node.innerText || node.textContent || '');
      if (!noCampo.includes(texto)) {
        console.warn(`[chat] campo ficou com "${noCampo.trim()}" — não cliquei em enviar`);
        await this.pagina.waitForTimeout(humaniza.ms(4000, 7000));
        continue;
      }

      // Botão em vez de Enter: dentro de um <pre>, Enter pode inserir quebra de
      // linha em vez de enviar, dependendo da versão.
      const botao = await this._achar('botaoEnviar');
      await this._clicar(botao.el);

      await this.pagina.waitForTimeout(humaniza.ms(1500, 2600));

      if (await this._ultimaMinhaTem(texto)) {
        await this.checarBloqueio();
        return;
      }

      // A Taobao recusa envio rápido demais com um aviso amarelo e engole a
      // mensagem. Esperar mais que na primeira vez faz a segunda tentativa
      // pegar — insistir no mesmo ritmo só levaria o mesmo aviso.
      const aviso = await this._lerAviso();
      console.warn(
        `[chat] "${texto}" não saiu na tentativa ${tentativa}` +
          (aviso ? ` — a Taobao avisou: "${aviso}"` : ''),
      );
      await this._cancelarDialogoImagem();
      await this.pagina.waitForTimeout(humaniza.ms(6000, 9000));
    }

    // Falhar alto aqui é melhor que seguir calado: a foto já foi, e foto sem
    // usuário não serve para nada. O operador precisa saber para mandar na mão.
    throw new SeletorNaoEncontrado(
      `digitei "${texto}" duas vezes e a mensagem não saiu — a foto já foi enviada, ` +
        `manda o usuário na mão pelo chat`,
    );
  }

  /**
   * O texto aparece numa das últimas mensagens NOSSAS?
   *
   * Confirmar por CONTAGEM não serve para texto: o balão da foto entra no DOM
   * com atraso, então a contagem sobe enquanto o texto ainda está sendo
   * digitado — e o braço dava por enviado um usuário que a Taobao recusou.
   * Foi assim que o fornecedor recebeu print sem usuário e ninguém percebeu.
   *
   * Usuário é alfanumérico e único, então procurar o texto em si não dá falso
   * positivo. Olha as 3 últimas porque a foto pode ter entrado depois dele.
   */
  async _ultimaMinhaTem(texto) {
    const classeSelf = SEL.minhaMensagem.classe;
    return this.frame
      .evaluate(
        ({ c, t }) => {
          const meus = document.querySelectorAll(`.message-item.${c}`);
          for (let i = meus.length - 1; i >= 0 && i >= meus.length - 3; i--) {
            if ((meus[i].innerText || '').includes(t)) return true;
          }
          return false;
        },
        { c: classeSelf, t: texto },
      )
      .catch(() => false);
  }

  /**
   * O aviso amarelo que a Taobao mostra quando recusa um envio.
   *
   * Não é bloqueio nem captcha — é um toast que some sozinho, e a mensagem
   * simplesmente não sai. Sem capturar o texto, o log só diz "não saiu" e a
   * causa fica em aberto entre ritmo, conteúdo e sessão. Com ele, o motivo
   * chega escrito pela própria Taobao.
   */
  async _lerAviso() {
    // 请输入内容 = "digite algum conteúdo": campo vazio na hora do envio.
    const PISTAS = /频繁|太快|稍后|发送失败|请勿|限制|敏感|请输入/;
    for (const raiz of [this.frame, this.pagina]) {
      const txt = await raiz.evaluate(() => document.body.innerText || '').catch(() => '');
      const linha = txt.split('\n').map((l) => l.trim()).find((l) => l && PISTAS.test(l));
      if (linha) return linha.slice(0, 120);
    }
    return '';
  }

  /**
   * O campo de digitação tem algo dentro?
   *
   * Conta imagem também: print colado entra como <img> no <pre>, sem texto
   * nenhum — olhar só o innerText diria "vazio" justamente quando há uma foto
   * esperando o 发送.
   */
  async _campoTemConteudo() {
    const seletores = SEL.campoTexto.candidatos;
    return this.frame
      .evaluate((sels) => {
        const el = sels.map((s) => document.querySelector(s)).find(Boolean);
        if (!el) return false;
        return Boolean((el.innerText || '').trim()) || Boolean(el.querySelector('img'));
      }, seletores)
      .catch(() => false);
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
   *   1. Ctrl+V de verdade — print no clipboard do X, tecla apertada no
   *      navegador. É o que um humano faz, e colagem nunca vira anexo;
   *   2. colagem forjada (evento de paste), se faltar xclip no container;
   *   3. input com accept de imagem — o uploader de imagem se declarando;
   *   4. primeiro input que aceitar — melhor mandar como arquivo do que nada.
   *
   * Cada passo só entra se o anterior não tiver posto nada no chat, conferido
   * pela contagem de mensagens nossas. Assim tentativa frustrada não deixa
   * lixo no chat do fornecedor nem manda a mesma foto duas vezes.
   *
   * @returns {Promise<{via:string, comoArquivo:boolean}>}
   */
  async enviarFoto(caminhoLocal) {
    await this.checarBloqueio();

    // Sobrou diálogo de imagem aberto de uma tentativa anterior? CANCELA.
    // Confirmar mandaria a foto de outro cliente — ou pior, alguma imagem que
    // nem sabemos de onde veio — para a conversa. Cancelar sempre é seguro:
    // no pior caso o nosso próprio print é recolado logo abaixo.
    await this._cancelarDialogoImagem();

    const mapa = await this._mapearInputs();
    console.log(`[chat] ${mapa.length} input[type=file]: ${JSON.stringify(mapa)}`);

    const antes = await this._quantasMinhas();
    let via = null;

    // ── 1. Ctrl+V de verdade ──────────────────────────────────
    //
    // É o que uma pessoa faz, e colagem NUNCA vira anexo: ela entra pelo
    // caminho de imagem do próprio chat, com a prévia e o 确定. O input, mesmo
    // o que se declara de imagem, é upload de arquivo por baixo — e foi de lá
    // que saiu o cartão "下载文件" que o outro lado não abre.
    //
    // Já esteve em segundo lugar, atrás do input de imagem, por ser o caminho
    // mais curto. Voltou para a frente porque curto não vale nada se a foto
    // chega de um jeito que ninguém abre.
    if (!via) {
      try {
        console.log('[chat] tentando Ctrl+V');
        if (await this._tentar(() => comLimite(this._ctrlV(caminhoLocal), 30_000, 'Ctrl+V'), antes)) {
          via = 'Ctrl+V';
        }
      } catch (err) {
        console.warn(`[chat] Ctrl+V falhou: ${err.message}`);
      }
    }

    // ── 2. Uploader que se declara de imagem ──────────────────
    //
    // Reserva para quando o clipboard do X não estiver disponível (xclip fora
    // da imagem, seleção não assumida). O log de produção confirmou que este
    // input existe e se identifica sozinho: accept=".jpg,.jpeg,.gif,.png,.bmp"
    // com pai "moxie-shim". O outro, accept vazio e name="file" dentro de
    // "next-upload-inner", é o de ARQUIVO e não entra aqui.
    const i = mapa.findIndex((m) => /image|jpg|jpeg|png|gif|bmp/i.test(m.accept));
    if (!via && i !== -1) {
      const inputs = await this.frame.$$("input[type='file']");
      try {
        console.log(`[chat] tentando input de imagem #${i} (${mapa[i].accept})`);
        await comLimite(inputs[i].setInputFiles(caminhoLocal), 20_000, 'setInputFiles');
        if (await this._tentar(async () => {}, antes)) via = `accept "${mapa[i].accept}"`;
      } catch (err) {
        console.warn(`[chat] input de imagem recusou: ${err.message}`);
      }
    }

    // ── 3. Colagem forjada ────────────────────────────────────
    if (!via) {
      try {
        console.log('[chat] tentando colagem forjada');
        if (await this._tentar(() => this._colarForjado(caminhoLocal), antes)) via = 'colagem';
      } catch (err) {
        console.warn(`[chat] colagem forjada falhou: ${err.message}`);
      }
    }

    // ── 4. Último recurso: qualquer input ─────────────────────
    if (!via && (await this._quantasMinhas()) === antes) {
      const inputs = await this.frame.$$("input[type='file']");
      if (!inputs.length) {
        throw new SeletorNaoEncontrado('nenhum input[type=file] no frame do chat');
      }
      let anexou = false;
      for (const input of inputs) {
        try {
          // comLimite igual ao do caminho principal (linha ~590): sem ele cada
          // input escondido pode segurar 30s no default do Playwright, e a
          // página costuma ter vários — o laço inteiro passava de minuto.
          await comLimite(input.setInputFiles(caminhoLocal), 20_000, 'setInputFiles (fallback)');
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
   * Roda uma tentativa de colagem e confirma que a foto SAIU.
   *
   * Colar não envia: a imagem fica na caixa de texto esperando o 发送, igual
   * ao que acontece quando a gente cola um print. Por isso o clique no botão
   * faz parte da tentativa — sem ele a foto some no próximo envio de texto.
   */
  async _tentar(acao, antes) {
    await acao();
    await this.pagina.waitForTimeout(humaniza.ms(1200, 2200));

    // Colar abre o diálogo 发送图片 com a prévia. Enquanto ele estiver na tela
    // nada foi enviado — e o 发送 lá atrás nem está clicável.
    if (await this._confirmarEnvioImagem()) {
      await this.pagina.waitForTimeout(humaniza.ms(1500, 2800));
    }

    if ((await this._quantasMinhas()) > antes) return true; // enviou sozinho

    // Só clica em enviar se HÁ o que enviar. Clicar com o campo vazio rende o
    // aviso amarelo "请输入内容~", e aviso é atrito registrado na conta — não
    // vale gastar isso para descobrir que a tentativa não pegou.
    if (!(await this._campoTemConteudo())) return false;

    try {
      const botao = await this._achar('botaoEnviar', { timeout: 5000 });
      await this._clicar(botao.el);
    } catch {
      // sem botão visível: se a colagem não pegou, não há o que enviar
    }
    await this.pagina.waitForTimeout(humaniza.ms(1200, 2200));
    return (await this._quantasMinhas()) > antes;
  }

  /**
   * Fecha o diálogo 发送图片 clicando em 确定.
   *
   * A Taobao não envia imagem colada direto: abre uma prévia e pede
   * confirmação. Sem o clique, a foto fica parada nesse diálogo — e como o
   * balão nunca aparece, o braço concluía "a colagem não funcionou" e partia
   * para o próximo caminho, empilhando tentativa em cima de um diálogo aberto.
   *
   * Confere o TEXTO do diálogo antes de clicar: 确定 sozinho é o "OK" de
   * qualquer confirmação da Taobao, inclusive de coisas que não queremos aceitar.
   */
  /**
   * Cancela um diálogo de imagem que ficou aberto de antes.
   *
   * Nunca confirma nessa situação: a prévia pode ser a foto de outro cliente,
   * ou uma imagem que a gente nem sabe de onde veio. Cancelar é sempre seguro —
   * no pior caso o nosso print é recolado logo em seguida.
   */
  async _cancelarDialogoImagem() {
    for (const raiz of [this.frame, this.pagina]) {
      const txt = await raiz.evaluate(() => document.body.innerText || '').catch(() => '');
      if (!SEL.confirmarImagem.deteccao.some((m) => txt.includes(m))) continue;

      for (const sel of SEL.confirmarImagem.botaoCancelar) {
        const el = await raiz.$(sel).catch(() => null);
        if (!el) continue;
        await this._clicar(el).catch(() => {});
        console.log('[chat] diálogo de imagem antigo cancelado');
        await this.pagina.waitForTimeout(humaniza.ms(600, 1200));
        return true;
      }
    }
    return false;
  }

  async _confirmarEnvioImagem() {
    const raizes = [this.frame, this.pagina];

    for (const raiz of raizes) {
      const txt = await raiz.evaluate(() => document.body.innerText || '').catch(() => '');
      if (!SEL.confirmarImagem.deteccao.some((m) => txt.includes(m))) continue;

      for (const sel of SEL.confirmarImagem.botaoConfirmar) {
        const el = await raiz.$(sel).catch(() => null);
        if (!el) continue;
        await this._clicar(el).catch(() => {});
        console.log('[chat] diálogo 发送图片 confirmado');
        return true;
      }

      console.warn('[chat] diálogo 发送图片 na tela mas não achei o 确定');
    }
    return false;
  }

  /**
   * Ctrl+V de TEXTO: põe o usuário no clipboard do X e cola no campo.
   *
   * Por que colar em vez de digitar: `type()` escreve caractere a caractere no
   * <pre contenteditable>, e o framework da Taobao nem sempre registra isso
   * como conteúdo. O sintoma é o aviso amarelo 请输入内容~ ("digite algum
   * conteúdo") no clique em 发送, com o texto visível na tela — a mensagem
   * some, a foto já foi, e o cliente espera o timeout inteiro.
   *
   * A colagem dispara o evento `paste` nativo, que é o caminho que o próprio
   * chat espera. Mesmo mecanismo do print, só muda o alvo do clipboard.
   */
  async _ctrlVTexto(texto) {
    const xclip = spawn('xclip', ['-selection', 'clipboard', '-t', 'text/plain'], {
      detached: true,
      stdio: ['pipe', 'ignore', 'ignore'],
    });
    // Mesmo motivo do _ctrlV: sem handler, xclip ausente vira 'error' sem
    // ouvinte, e no Node isso derruba o processo inteiro em vez de só falhar
    // este caminho.
    xclip.on('error', (e) => console.warn(`[chat] xclip não rodou: ${e.message}`));
    xclip.stdin.on('error', () => {}); // EPIPE se o xclip morreu antes de ler
    xclip.stdin.end(texto);
    xclip.unref();

    try {
      await this.pagina.waitForTimeout(600); // o xclip precisa assumir a seleção
      const campo = await this._achar('campoTexto', { timeout: 8000 });
      await this._clicar(campo.el);
      await this.pagina.keyboard.press('Control+V');
      await this.pagina.waitForTimeout(humaniza.ms(600, 1200));
    } finally {
      setTimeout(() => {
        try { process.kill(xclip.pid); } catch { /* já saiu sozinho */ }
      }, 1500);
    }
  }

  /**
   * Ctrl+V real: põe o print no clipboard do X e aperta a tecla no navegador.
   *
   * Converte para PNG antes porque o Chromium lê o clipboard do X pelo alvo
   * image/png — um JPEG oferecido como image/jpeg ele ignora, e o Ctrl+V não
   * cola nada, sem erro nenhum.
   *
   * O xclip precisa continuar vivo enquanto o Chrome pede o conteúdo: quem
   * anuncia a seleção no X é o processo dono, não o sistema. Por isso ele fica
   * em segundo plano e só morre depois da colagem.
   */
  async _ctrlV(caminhoLocal) {
    let png = caminhoLocal;
    let temporario = null;

    if (!/\.png$/i.test(caminhoLocal)) {
      temporario = path.join(os.tmpdir(), `clip_${Date.now()}.png`);
      await rodar('convert', [caminhoLocal, temporario]);
      png = temporario;
    }

    const xclip = spawn('xclip', ['-selection', 'clipboard', '-t', 'image/png', '-i', png], {
      detached: true,
      stdio: 'ignore',
    });
    // SEM este handler, xclip ausente vira evento 'error' sem ouvinte — e no
    // Node isso é exceção não capturada, que derruba o braço inteiro em vez de
    // apenas pular para o próximo caminho de envio.
    xclip.on('error', (e) => console.warn(`[chat] xclip não rodou: ${e.message}`));
    xclip.unref();

    try {
      await this.pagina.waitForTimeout(600); // o xclip precisa assumir a seleção
      const campo = await this._achar('campoTexto', { timeout: 8000 });
      await this._clicar(campo.el);
      await this.pagina.keyboard.press('Control+V');
      await this.pagina.waitForTimeout(humaniza.ms(800, 1500));
    } finally {
      // Solta a seleção só no fim: matar antes deixaria o Chrome colando vazio.
      setTimeout(() => {
        try { process.kill(xclip.pid); } catch { /* já saiu sozinho */ }
        if (temporario) try { fs.unlinkSync(temporario); } catch { /* já sumiu */ }
      }, 4000);
    }
  }

  /**
   * Colagem forjada, para quando o container não tem xclip.
   *
   * Menos fiel que o Ctrl+V — o evento não é confiável (isTrusted=false) e um
   * chat pode ignorá-lo —, mas não depende de clipboard nem de binário externo.
   */
  async _colarForjado(caminhoLocal) {
    const b64 = fs.readFileSync(caminhoLocal).toString('base64');
    const nome = path.basename(caminhoLocal);
    const seletores = SEL.campoTexto.candidatos;

    // dispatchEvent devolve FALSE quando a página chamou preventDefault — ou
    // seja, quando ela TRATOU a colagem. Ler isso como falha era o inverso da
    // verdade: o log dizia "campo de texto não aceitou a colagem" justamente
    // nas vezes em que a Taobao tinha aceitado. Aqui só interessa se o campo
    // existe; quem julga o resultado é a contagem de mensagens, em _tentar().
    const achouCampo = await this.frame.evaluate(
      ({ b64, nome, seletores }) => {
        const alvo = seletores.map((s) => document.querySelector(s)).find(Boolean);
        if (!alvo) return false;

        const bin = atob(b64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);

        const dt = new DataTransfer();
        dt.items.add(new File([bytes], nome, { type: 'image/jpeg' }));

        alvo.focus();
        alvo.dispatchEvent(
          new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }),
        );
        return true;
      },
      { b64, nome, seletores },
    );

    if (!achouCampo) throw new SeletorNaoEncontrado('campo de texto não encontrado para colar');
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
        const nickDe = (el) => ((el.innerText || '').split('\n')[0] || '').trim();

        // Nicks que já apareceram numa mensagem NOSSA.
        //
        // A classe .self é a checagem principal, mas ela falha justamente no
        // balão de imagem colada — e aí a nossa própria foto vira "resposta do
        // fornecedor". O nick é o mesmo em toda mensagem da mesma conta, então
        // ele conserta o que a classe deixou passar, sem precisar configurar
        // nada: quem é nosso se identifica sozinho na primeira mensagem de texto.
        const meusNicks = new Set();
        for (const el of els) {
          if (el.classList.contains(classeSelf)) meusNicks.add(nickDe(el));
        }
        meusNicks.delete('');

        for (const el of els) {
          if (el.classList.contains(classeSelf)) continue; // mensagem nossa
          if (meusNicks.has(nickDe(el))) continue; // nossa também — a classe falhou

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

          // Balão SEM TEXTO é DESCARTADO — inclusive quando tem imagem.
          //
          // A versão anterior reportava "[respondeu com uma imagem]", e isso
          // virava um alerta pedindo decisão do operador. Só que, na prática,
          // esse balão quase sempre era a NOSSA foto lida como se fosse dele:
          // um alarme falso a cada envio, pedindo ação sobre nada.
          //
          // E mesmo quando a imagem é de verdade dele, não há o que fazer com
          // ela: código lido por OCR não tem confiança para ser entregue (trocar
          // 8 por 3 faz o cliente digitar código inválido na conta de terceiro),
          // então o alerta não traz decisão nenhuma — só ruído.
          //
          // O caso real não fica perdido: o atendimento vence no timeout e o
          // operador é avisado, com a tela do chat a um clique.
          if (!limpo) continue;

          // O innerText do balão traz "nick\nAAAA-MM-DD HH:MM:SS\nconteúdo".
          const bruto = el.innerText || '';
          const mData = bruto.match(/\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}/);
          const quando = mData ? mData[0] : '';
          const nick = nickDe(el);

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
    // Aceita a marca antiga (só a lista de chaves) para não perder o
    // atendimento em curso quando o container reinicia no meio dele.
    const chaves = Array.isArray(marca) ? marca : marca?.chaves || [];
    const ate = Array.isArray(marca) ? '' : marca?.ate || '';
    // Marca legada (array puro) segue valendo: ela existe para o atendimento
    // em curso sobreviver ao restart do container. O que não vale é marca que
    // falhou ao ser tirada — ver marca().
    const confiavel = Array.isArray(marca) ? true : marca?.confiavel !== false;

    if (!confiavel) {
      // Sem retrato válido do "antes", NADA aqui pode ser chamado de resposta.
      // Não entregar tem conserto: o atendimento vence no timeout e o operador
      // assume. Entregar o código errado não tem.
      console.warn('[chat] marca não confiável — nenhuma mensagem tratada como resposta');
      return [];
    }

    await this._irParaOFim();

    const conhecidas = new Set(chaves);
    const todas = await this._lerFornecedor();
    const novas = [];
    let antigas = 0;

    for (const m of todas) {
      if (conhecidas.has(m.chave)) continue;

      // O horário manda. Mensagem sem data não é aceita: pode ser histórico
      // que entrou no DOM por rolagem, e entregar código velho ao cliente é
      // pior do que não entregar nada — o que já tem timeout e alerta.
      if (ate && (!m.quando || m.quando <= ate)) {
        antigas++;
        continue;
      }

      novas.push({ texto: m.texto, quando: m.quando });
    }

    // Uma linha por leitura, e só quando o número muda. A leitura roda a cada
    // 6s enquanto alguém espera; logar cada mensagem descartada enchia o log
    // de dezenas de linhas por minuto e enterrava qualquer aviso de verdade.
    if (antigas && this._antigasLogadas !== antigas) {
      console.log(`[chat] ${antigas} mensagem(ns) antiga(s) ignorada(s) — corte ${ate}`);
      this._antigasLogadas = antigas;
    }

    return novas;
  }
}

module.exports = { Chat, BloqueioDetectado, SeletorNaoEncontrado };
