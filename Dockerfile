FROM node:20-alpine

WORKDIR /app

# Instala só as dependências de produção (cache eficiente)
COPY package*.json ./
RUN npm ci --omit=dev

# Copia o restante do código
COPY . .

# Porta do servidor do bot (webhooks)
EXPOSE 3000

CMD ["npm", "start"]
