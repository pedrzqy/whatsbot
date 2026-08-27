# Manual do bot — Phaze Games

Tudo aqui se usa pelo **WhatsApp**, do seu número. Não tem painel, não tem
site: você digita o comando na conversa e o bot responde.

Só os números configurados em `PONTE_OPERADOR_NUMERO` mandam no bot. Qualquer
outro número que digitar `#status` é atendido como cliente normal e nem
descobre que esses comandos existem.

---

## O que o bot faz sozinho

Sem você fazer nada:

- **Responde no WhatsApp.** Menu numerado com respostas prontas, e conversa
  livre quando a IA está ligada.
- **Ouve áudio.** O cliente manda mensagem de voz, o bot entende e responde por
  escrito.
- **Enxerga foto.** Print da tela de erro, comprovante, tela de login — ele lê
  o que está escrito na imagem.
- **Consulta pedido pelo telefone.** O cliente pergunta "cadê meu pedido" e o
  bot acha pelo número dele, sem pedir código nem e-mail.
- **Vende.** Mostra o preço, fecha a compra na conversa e manda o Pix.
- **Entrega a chave** assim que o pagamento cai.
- **Pergunta se deu certo** três horas depois de entregar.
- **Cutuca quem gerou Pix e não pagou.**
- **Pega código de segurança** com o outro lado, quando o cliente precisa.

Quando ele não dá conta, chama você — e você recebe um alerta com o nome, o
telefone e o motivo.

---

## Os comandos, por situação

### Ligar e desligar qualquer coisa

Digite **`#admin`**. Ele mostra tudo com uma marca do lado:

```
⚙️ Painel

1. ✅ Atendimento
2. ⛔ Conversa livre
3. ✅ Vender pelo chat
4. ✅ Códigos de segurança
5. ✅ Pedir sua aprovação
6. ⛔ Responder o outro lado sozinho
7. ✅ Perguntar se ativou
8. ⛔ Chamar quem sumiu
```

| Comando | O que faz |
|---|---|
| `#admin` | A lista acima. |
| `#admin 6` | Explica o que a 6 faz, e avisa do risco **antes** de você ligar. |
| `#admin 6 on` | Liga. |
| `#admin 6 off` | Desliga. |
| `#admin 6 padrao` | Volta ao que está configurado no servidor. |

**Vale na hora.** Não precisa mexer no Easypanel, não precisa Deploy, e a sua
escolha sobrevive a deploy e a reinicialização.

> **Antes de ligar a 6 ou a 8**, leia o aviso que o `#admin 6` mostra. São as
> duas que falam para fora sem você ver.

### "Está tudo funcionando?"

| Comando | O que faz |
|---|---|
| `#status` | Testa tudo e diz o que está errado: WhatsApp conectado, loja respondendo, avisos de venda chegando, coleta viva, quem está atendendo. **É o primeiro comando quando algo parece estranho.** |
| `#fila` | Quem está sendo atendido agora, quem espera, o que está esperando você. |
| `#vendas` | Vendas de hoje, faturamento e o que falta entregar. |

### "Quanto trabalho ainda é meu?"

| Comando | O que faz |
|---|---|
| `#casos` | Últimos 7 dias: quantos atendimentos terminaram **sem você**, quantos passaram para você e **por quê**. |
| `#analisar` | Manda um arquivo com o que ainda cai no seu colo e **propostas** de resposta pronta nova. Nada do que ele propõe entra em uso sozinho — é para você ler e decidir. |

### Alguém está esperando você

Quando o bot precisa de você, ele manda um alerta com um número (o *id*). Os
comandos abaixo usam esse número.

| Comando | O que faz |
|---|---|
| `#ok 12` | Libera o envio que estava esperando sua aprovação. |
| `#nao 12` | Descarta. Não sai. |
| `#enviar 12` | Manda a resposta ao cliente, do jeito que está. |
| `#editar 12 texto` | Corrige antes de mandar. Escreve em português. |
| `#responder 12 texto` | Fala com o **outro lado** (o fornecedor). Escreve em **português** — o bot traduz. |

> Antes de sair, tudo isso passa por um filtro: valor em yuan, link da loja de
> origem, caractere chinês e dado de cliente são removidos. Se ele tirar
> alguma coisa, avisa você e mostra o que o cliente leu.

### Alguma coisa travou

| Comando | O que faz |
|---|---|
| `#liberar` | Destrava depois de você resolver a verificação na tela. |
| `#sms 123456` | Repassa o código de SMS que chegou no seu celular. (`#taobao 123456` faz a mesma coisa.) |
| `#destravar` | Devolve à fila um envio que ficou preso. |
| `#pular` | Encerra o atendimento atual e chama o próximo da fila. |
| `#limpar` | Descarta tudo que está esperando sua aprovação. |
| `#limpar fila` | Encerra **todos** os atendimentos e avisa cada cliente. |
| `#recarregar` | Recarrega a tela do navegador e reabre a conversa. |

### Atalhos antigos

Continuam funcionando, e fazem a mesma coisa que o `#admin`:

| Atalho | Igual a |
|---|---|
| `#atender on` / `#atender off` | `#admin 1 on` / `#admin 1 off` |
| `#auto off` | `#admin 5 on` (volta a pedir sua aprovação — **é o recomendado**) |
| `#auto on` | `#admin 5 off` (o envio sai sem o seu `#ok`) |

### Testar

| Comando | O que faz |
|---|---|
| `#teste` | Seu número vira **cliente** por 30 minutos. Mande "preciso do código" e siga o passo a passo como um cliente faria. Manda `#teste` de novo para desligar. |
| `#historico` | Exporta a conversa com o outro lado para arquivo. |
| `#historico enviar` | Manda esse arquivo aqui pelo WhatsApp. |
| `#ajuda` | A lista de todos os comandos. |

---

## O que o cliente pode digitar

- **`#menu`** ou **`#inicio`** — volta para o menu principal. Funciona sempre,
  mesmo se ele estiver no meio de uma conversa com a IA.

É a saída de emergência dele. Se algo travar, é isso que você pede para ele
digitar.

---

## O que ainda mora no Easypanel

Quase tudo se liga e desliga pelo **`#admin`**. Só estas exigem o painel do
servidor e **Deploy** depois:

| Variável | Para quê |
|---|---|
| `ANTHROPIC_API_KEY` | A chave da IA. **Sem ela a conversa livre não funciona** e o cliente recebe o menu — que responde na hora e resolve a maior parte. |
| `GROQ_FALLBACK_API_KEY` | Só para o áudio virar texto. Não apague: sem ela, quem manda mensagem de voz deixa de ser entendido. |
| `NERIX_API_KEY` | A chave da loja. |
| `EVOLUTION_API_KEY` | A chave do WhatsApp. |
| `ATENDENTE_INICIO_HORA` / `ATENDENTE_FIM_HORA` | Seu horário. O atendimento roda 24h de qualquer jeito; isso só muda o que ele **promete** — fora do horário ele diz quando você responde, em vez de "em instantes". |
| `PONTE_SELLER_JANELAS` | O horário em que o outro lado costuma responder. |

Segredo continua no painel de propósito: ligar e desligar função é decisão do
dia a dia, guardar chave é outra coisa.

> **Atenção:** se a variável já existe no Environment, o valor dela **vence** o
> que está escrito no código. Mudar só o código não faz nada.

---

## Quando alguma coisa der errado

1. Manda **`#status`**. Ele diz qual peça caiu e o que fazer.
2. Se o cliente estiver travado, peça para ele digitar **`#inicio`**.
3. Se a fila estiver parada, **`#fila`** mostra o porquê e **`#destravar`** ou
   **`#pular`** resolvem.
4. Para desligar tudo rápido: **`#admin 1 off`** (ou `#atender off`).
5. Para desligar só a parte que está dando problema: **`#admin`** e desliga
   o número dela.

O bot nunca diz ao cliente que teve erro, nem que existe um fornecedor, nem que
é um robô. Se você escrever isso num `#editar` ou `#responder`, ele tira antes
de mandar e te avisa.
