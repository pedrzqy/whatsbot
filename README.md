# whatsbot

Bot de automação de WhatsApp usando **Evolution API** integrado à plataforma de vendas **Nerix**, hospedado no **Square Cloud**.

## Arquitetura

```
Cliente WhatsApp ──▶ Evolution API ──(webhook)──▶ whatsbot (este projeto) ──▶ Nerix API
                          ▲                            │
                          └──────(enviar msg)──────────┘
Nerix ──(webhook order.paid/delivered)──▶ whatsbot ──▶ Evolution (avisa o cliente)
```

- **Evolution API**: gateway do WhatsApp (conexão via Baileys / QR Code). Precisa de PostgreSQL + Redis.
- **whatsbot**: o cérebro. Recebe mensagens, fala com a Nerix, responde no WhatsApp.
- **Nerix**: loja/vendas. Base `https://api.nerix.com.br/api/public`, auth via header `X-nerixkey`.

## Estrutura

| Arquivo | Papel |
| --- | --- |
| `src/server.js` | Servidor Express com os 2 webhooks (`/webhooks/evolution`, `/webhooks/nerix`) |
| `src/handlers.js` | **Lógica do bot** — onde as funções são encaixadas |
| `src/nerix.js` | Cliente da API da Nerix |
| `src/evolution.js` | Cliente da Evolution (enviar mensagens) |
| `src/ai.js` | Integração com a Groq (IA) — respostas + histórico + tool-calling |
| `src/tools.js` | Ferramentas que a IA usa para consultar a Nerix (pedidos/catálogo) |
| `src/sender.js` | **Envio humanizado (anti-ban)** — fila, delays, "digitando..." |
| `src/variator.js` | Variação de mensagens fixas (nunca envia texto idêntico) |
| `src/menu.js` | Menu numerado (estrutura/navegação) |
| `src/knowledge.js` | **Base de conhecimento editável** (fatos da loja p/ o FAQ) |
| `src/welcome.js` | Saudação / primeiro contato |
| `src/store.js` | Registro de contatos (saudação, estado do menu, pausa) |
| `src/config.js` | Configuração via variáveis de ambiente |

## Menu de atendimento (humanizado)

O bot recebe o cliente com **saudação + menu numerado** e ele navega respondendo
com o número da opção. As **respostas dos tópicos são geradas pela IA** a partir de
`src/knowledge.js`, então saem **humanizadas e diferentes a cada vez**.

- **Editar o conteúdo do FAQ:** altere os textos em `src/knowledge.js` (só os fatos;
  a IA cuida do "jeito de falar"). Procure os comentários `AJUSTE:`.
- **Editar as opções/menus:** `src/menu.js` (a numeração é estável para o cliente).
- **Voltar ao menu:** o cliente digita `#inicio` a qualquer momento.
- **Atendente humano:** ao pedir atendente, o bot **pausa** o autoatendimento para
  aquele contato (não fala por cima do humano); `#inicio` reativa.
- Texto livre (fora do menu) cai na IA com as ferramentas da Nerix (catálogo/pedidos).

## Gerenciar pedidos (IA + Nerix)

A IA tem **ferramentas** (`src/tools.js`) e decide sozinha quando consultar a Nerix:

| Ferramenta | O que faz | Requer |
| --- | --- | --- |
| `buscar_produtos` | Busca no catálogo (nome, preço, variantes) | — |
| `consultar_pedido` | Status e detalhes de um pedido | nº do pedido **+ e-mail** |
| `verificar_pagamento` | Confere o Pix em tempo real e libera a entrega | nº do pedido **+ e-mail** |

**Segurança:** consultas de pedido exigem o e-mail da compra (validado pela própria
Nerix), e **não há** ferramenta que liste pedidos de terceiros — a chave da loja é
admin, então evitamos qualquer vazamento de dados de outros clientes. Chaves/licenças
só são reveladas após essa validação.

## Segurança anti-ban

**Toda** mensagem do bot passa por `src/sender.js`, que simula comportamento humano:

- Fila **serializada** — nunca dispara mensagens em rajada/paralelo.
- Atraso de "reação" antes de digitar (2–6s), configurável.
- Simulação de **"digitando..."** proporcional ao texto (3 letras/seg, com limites).
- Espaçamento entre mensagens do mesmo contato (3–10s) e entre contatos diferentes (5–15s).
- Textos **variados** (`src/variator.js` + respostas da IA são naturalmente únicas).

Todos os tempos são ajustáveis via variáveis `PACING_*` no `.env`.
Recomendações adicionais: número **dedicado**, aquecer o chip aos poucos, evitar
enviar para quem nunca falou com você primeiro.

## Configuração local

```bash
npm install
cp .env.example .env   # preencha os valores
npm run dev
```

## Deploy no Square Cloud

1. **Provisionar bancos** no painel do Square Cloud (1 clique): **PostgreSQL** e **Redis**.
2. **Subir a Evolution API** como uma aplicação separada no Square Cloud
   (imagem/repo oficial `evolution-api`), apontando `DATABASE_*` e `REDIS_*`
   para os bancos do passo 1. Anote a `AUTHENTICATION_API_KEY` e a URL.
3. **Subir este projeto** (`whatsbot`): zipar e enviar, ou conectar o GitHub.
   O `squarecloud.config` já define `MAIN`, `MEMORY` e `START`.
4. Definir as **variáveis de ambiente** no painel (não usar arquivo `.env` versionado):
   `EVOLUTION_API_URL`, `EVOLUTION_API_KEY`, `EVOLUTION_INSTANCE`,
   `NERIX_API_KEY`, `NERIX_WEBHOOK_SECRET`.
5. **Conectar o WhatsApp**: criar a instância na Evolution e ler o QR Code
   (use um número **dedicado** — Baileys é não-oficial).
6. **Apontar os webhooks**:
   - Evolution → `https://<seu-app>/webhooks/evolution` (evento `MESSAGES_UPSERT`).
   - Nerix → `https://<seu-app>/webhooks/nerix?secret=SEU_TOKEN`.

## Segurança

- A chave da Nerix é secreta e dá acesso admin à loja. Mantê-la só em variáveis
  de ambiente; **nunca** commitar. Rotacionar no painel se tiver sido exposta.
- Repositório privado é recomendado.
