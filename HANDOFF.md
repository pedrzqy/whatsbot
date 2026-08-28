# Continuação — bot da Phaze Games

Copie este arquivo inteiro na primeira mensagem da próxima janela.

---

Continue o trabalho no bot de atendimento da Phaze Games.

O plano original, já aprovado e **inteiramente executado**, está em:
`C:\Users\pedrz\.claude\plans\faca-um-planejamento-agora-parallel-dolphin.md`

Leia ele se precisar do contexto histórico (os 14 dias de conversa analisados,
as decisões do dono, o que NÃO fazer). O que segue aqui é o suficiente para
trabalhar sem reler nada.

---

## Onde parei

Último commit: **`c5a27f5`**. Working tree limpo, tudo commitado **e no
GitHub** (`pedrzqy/whatsbot`, branch `main`).

As 8 suítes de teste passam: **1100 testes**, todas offline, em segundos.

```bash
npm run teste
```

```bash
cd braco-web && npm run teste
```

### ⚠️ O que provavelmente NÃO está deployado

O dono tem histórico de esquecer o Deploy — isso já custou três rodadas de
investigação nesta sessão. **Antes de investigar qualquer bug que ele relate,
confirme a versão no ar**: o log de partida do `whatsbot` mostra
`build de AAAA-MM-DD HH:MM UTC`.

E confirme que o commit chegou ao GitHub, porque o Easypanel puxa de lá:

```bash
git status -sb
```

Se aparecer `[ahead N]`, **nada do que você fez está no ar**, por mais Deploy
que ele clique. Foi exatamente isso que aconteceu com 17 commits.

---

## O que existe hoje

Dois serviços no Easypanel, **deployados separadamente**:

- **`whatsbot`** (`src/`) — o bot. Quase tudo mora aqui.
- **`braco`** (`braco-web/`) — o navegador que opera o chat do fornecedor.

Sempre diga em qual deployar. Subir só um já causou bug várias vezes.

### O atendimento ao cliente

| | |
|---|---|
| Menu numerado | 8 opções, respostas prontas, sem IA |
| Conversa livre | Claude Opus 5, quando ligada |
| Áudio | transcrito por Whisper (Groq) e vira texto comum |
| Foto | o modelo enxerga; 4 telas de erro conhecidas |
| Pedido | achado pelo telefone do cliente, sem pedir código nem e-mail |
| Venda | fecha na conversa e manda o Pix |
| Entrega | chave sai sozinha no `order.paid` |
| Pós-venda | pergunta se ativou, 3h depois |
| Código de segurança | a ponte com o fornecedor |

### A ponte (relay de código com o fornecedor chinês)

Fila serial, um cliente por vez — é isso que garante de quem é a resposta que
chega. Copiloto por padrão: nada sai sem `#ok`.

### Os arquivos que eu criei nesta sessão

```
src/claude.js       a borda com a Anthropic (conversão de formato)
src/chaves.js       o painel #admin (liga/desliga sem deploy)
src/telas.js        as 4 telas de erro e o conserto de cada uma
src/transcricao.js  áudio → texto (Whisper na Groq)
src/expediente.js   quando existe gente do outro lado
src/posvenda.js     "conseguiu ativar?" e reativação
src/hermes.js       o analista: propõe, nunca aplica
src/ponte/repertorio.js  as frases que o bot manda ao fornecedor
src/ponte/registro.js    o JSONL que alimenta o #casos e o #analisar
MANUAL.md           manual do dono, em português claro
```

---

## Pendências do dono (não são código)

1. **Rotacionar a `ANTHROPIC_API_KEY`.** Ela apareceu num print que ele mandou
   no chat. Se ele ainda não rotacionou, lembre uma vez e siga.
2. **Testar `criar_pedido` de verdade.** O contrato do `createOrder` da Nerix
   não está documentado no repo — montei o payload pelo JSDoc do `nerix.js` e
   **nunca vi uma chamada real dar certo**. A falha é segura (cai no link do
   site), e o console mostra qual campo a API recusou. Se ele mandar essa
   linha, ajuste.
3. **Ligar a conversa livre**: `#admin 2 on`. Hoje está desligada, e é por isso
   que a leitura de imagem não funciona para ele.

---

## Três coisas que mordem, e mordem em silêncio

### 1. A variável de ambiente vence o código

Mudar um padrão em `config.js` ou `ponte/config.js` **não faz nada** se a
variável já existir no Environment do Easypanel. Já se perdeu uma rodada
inteira achando que a mudança tinha entrado.

Ao mexer num padrão, diga a ele o nome exato da variável e que ele precisa
mudá-la (ou apagá-la) no painel.

**Exceção**: as 8 chaves do `#admin` são gravadas no volume e **vencem** a
variável. `#admin N padrao` apaga a escolha e devolve o valor do Environment.

### 2. O shell desta máquina corrompe escapes

`\n` e `\b` dentro de string JavaScript, escritos por script Python/heredoc,
viram **caractere de controle real** no arquivo. Isso já quebrou três coisas
nesta sessão — e uma delas (`\b` virando backspace num regex) fez **todos os
comandos do operador pararem de funcionar de uma vez**, com o arquivo parecendo
correto na leitura.

Para editar código com `\n`, `\b` ou emoji ZWJ: **use a ferramenta Edit**.
Há um teste que barra caractere de controle no `operador.js`.

### 3. Os testes precisam ser trancados contra o ambiente

O `.env` local tem `GEMINI_API_KEY` de verdade. `delete process.env.X` **não
basta**: o `config.js` chama dotenv, que relê o `.env` e repõe qualquer chave
ausente. Use `process.env.X = ''` — a chave existe (dotenv não mexe) e é falsy.

As suítes já fazem isso no topo. Se criar uma nova, copie o bloco.

---

## Regras que não se negociam

1. Nenhuma mensagem de WhatsApp pode conter "fornecedor", "Taobao", "braço",
   "robô", "bot", "automático", "script" nem caractere chinês — **inclusive as
   do operador**, porque saem pelo mesmo número comercial. A lista é única, em
   `politica.js` → `vocabularioProibido()`. O `teste-ponte.js` falha se algo
   escapar. **Ele já me pegou quatro vezes nesta sessão.**
2. **Nada de travessão (`—`)** no que sai. Ninguém digita isso no WhatsApp; é a
   marca mais óbvia de texto gerado, e o dono reclamou disso. A rede está no
   `sender.normalizeWhatsApp`, mas o prompt também não deve usar — o modelo
   imita o estilo que lê.
3. Negrito no WhatsApp é **um** asterisco. Dois é markdown e aparece cru.
4. Erro técnico nunca vira mensagem ao cliente. `politica.motivoNeutro()` é
   catálogo fechado.
5. Nunca resolver captcha automaticamente; nunca ler código por OCR.
6. Preço em yuan nunca chega ao cliente.
7. O cliente nunca vê comando de operador e nunca sabe que existe um fornecedor.
8. Para o fornecedor **só sai chinês**, sempre traduzido. Há trava no
   `despachar`.

---

## Como o dono gosta de trabalhar

- Fale **português**.
- **Não use workflows nem rodadas de refutação** — gasta crédito à toa.
- Comentário no código explica **por que**, não o quê. Vários bugs aqui foram
  descobertos na marra e o motivo precisa ficar registrado.
- Mensagem de commit em **texto puro, sem acento** (o shell quebra).
- Ele **não é técnico**. Explique em português claro o que mudou e o que ele
  precisa fazer no painel. Quando algo depender dele, diga exatamente onde
  clicar.
- **Rode os testes antes de todo commit.** Ele já commitou com a suíte vermelha
  e disse que não deveria ter feito.
- Ele manda print de tela em vez de log. Peça o log do console quando o print
  não bastar — foi o log que resolveu dois bugs que o print escondia.

---

## O padrão que este projeto segue

Vale entender antes de escrever qualquer coisa:

**Regra fixa antes do modelo.** Pedido de código, telas de erro conhecidas e
opções de menu são estereotipados: regex não custa token, não alucina, não muda
de ideia e funciona com a IA fora do ar. O modelo entra só onde a conversa é
mesmo livre.

**Filtrar na porta, não em cada chamada.** Vocabulário proibido, markdown,
travessão e caractere chinês são consertados em um lugar só, na saída. Depender
de cada chamador lembrar da regra é o que já falhou.

**O que nasce perigoso nasce desligado.** Repertório e reativação começam off e
avisam do risco antes de ligar.

**Todo desfecho silencioso vira log ou contador.** Filtro que descarta calado,
comando ignorado, cache que parou de funcionar — cada um desses custou uma
investigação, e cada um agora tem uma linha que aparece.

---

## Se ele relatar um bug

1. **Confira a data do build no log** antes de qualquer coisa.
2. **Reproduza localmente** rodando o caminho de verdade, não lendo o código.
   Metade dos bugs desta sessão eram diferentes do que a leitura sugeria.
3. Quando achar, **escreva o teste que falha** antes de corrigir.
4. Comente o **porquê** no código, com o sintoma que o bug produzia.
