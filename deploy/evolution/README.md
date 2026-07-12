# Subir a Evolution API (Docker)

Guia rápido para colocar a Evolution API v2 no ar com Docker + PostgreSQL (sem Redis).

## 0) Pré-requisitos
- Um host com **Docker** e **Docker Compose**: uma VPS (recomendado, ex.: Contabo,
  Hostinger, DigitalOcean — a partir de ~R$20/mês) ou seu próprio PC (só para testes).
- Um **número de WhatsApp dedicado** (Baileys é não-oficial; não use o pessoal).

## 1) Configurar
```bash
cd deploy/evolution
cp .env.example .env
# edite o .env: SERVER_URL (IP/domínio), AUTHENTICATION_API_KEY e a senha do Postgres
```

## 2) Subir
```bash
docker compose up -d
docker compose logs -f evolution-api   # acompanhe até aparecer que subiu na porta 8080
```
A API fica em `http://SEU_IP:8080`. Teste: `http://SEU_IP:8080` deve responder um JSON.

## 3) Criar a instância (o "número")
```bash
curl -X POST http://SEU_IP:8080/instance/create \
  -H "apikey: SUA_AUTHENTICATION_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"instanceName":"whatsbot","integration":"WHATSAPP-BAILEYS","qrcode":true}'
```
A resposta traz o **QR Code** (campo `qrcode.base64`). Abra esse base64 no navegador
(ou pegue o QR em `GET /instance/connect/whatsbot`) e **escaneie com o número dedicado**
em: WhatsApp → Aparelhos conectados → Conectar aparelho.

> Dica: a Evolution v2 tem um painel web (Manager). Se preferir clicar em vez de curl,
> dá para usar a imagem `evoapicloud/evolution-manager` — mas via curl já resolve.

## 4) Apontar o webhook para o bot
Assim as mensagens recebidas chegam no whatsbot:
```bash
curl -X POST http://SEU_IP:8080/webhook/set/whatsbot \
  -H "apikey: SUA_AUTHENTICATION_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "webhook": {
      "enabled": true,
      "url": "https://SEU-BOT.squareweb.app/webhooks/evolution",
      "events": ["MESSAGES_UPSERT"]
    }
  }'
```

## 5) Ligar o bot à Evolution
No `.env` do whatsbot (projeto principal), preencha:
```
EVOLUTION_API_URL=http://SEU_IP:8080
EVOLUTION_API_KEY=SUA_AUTHENTICATION_API_KEY   # a mesma do passo 1
EVOLUTION_INSTANCE=whatsbot                     # o nome usado no passo 3
```

## Pronto ✅
Mande "oi" para o número conectado → deve chegar a saudação + menu do bot.

---

### Manutenção
- **Reiniciar:** `docker compose restart`
- **Ver logs:** `docker compose logs -f evolution-api`
- **Atualizar:** `docker compose pull && docker compose up -d`
- **Sessão do WhatsApp** fica no volume `evolution_instances` (sobrevive a reinícios).
