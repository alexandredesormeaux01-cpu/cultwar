FROM node:22-alpine

WORKDIR /app

# Copier package*.json et installer dépendances
COPY package*.json ./
RUN npm ci --legacy-peer-deps

# Copier le code serveur et sim modules
COPY server/ ./server/
COPY src/sim/ ./src/sim/

# Port Fly.io injecte via $PORT
EXPOSE 8080

# Démarrer le serveur
CMD ["node", "server/index.js"]
