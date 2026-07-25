FROM node:22-slim

WORKDIR /app

# Express 5 est en conflit de peer deps avec @colyseus/auth (attend Express 4).
# --legacy-peer-deps évite l'échec silencieux de npm install pendant le build Fly.
COPY package*.json ./
RUN npm install --omit=dev --legacy-peer-deps

COPY server/ ./server/
COPY src/sim/ ./src/sim/

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

CMD ["node", "server/index.js"]
