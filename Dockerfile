FROM node:20-alpine

WORKDIR /app

# Instala só as dependências de produção (cache eficiente)
COPY package*.json ./
RUN npm ci --omit=dev

# Copia o restante do código
COPY . .

# Porta do servidor do bot (webhooks)
EXPOSE 3000

# node direto, NÃO "npm start".
#
# Com npm no meio, quem vira PID 1 é o npm: ele recebe o SIGTERM do Easypanel,
# mata o node por baixo e ainda encerra com código de erro. É de onde vinha o
# "npm error signal SIGTERM / command failed" no log a cada deploy — barulho
# que parecia crash e não era.
#
# Pior que o barulho: o node morria sem rodar o encerramento limpo, e o estado
# da ponte é salvo com debounce de 400ms. Deploy no instante errado levava
# junto a fila de quem estava esperando código.
CMD ["node", "src/server.js"]
