FROM node:22-alpine

WORKDIR /app

# Copier package*.json et installer dépendances
COPY package*.json ./
RUN npm install --legacy-peer-deps --production

# Copier le code serveur et sim modules
COPY server/ ./server/
COPY src/sim/ ./src/sim/

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:8080/health', (r) => {if (r.statusCode !== 200) throw new Error(r.statusCode)})"

# Démarrer le serveur
CMD ["node", "server/index.js"]
