FROM node:22-slim

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY server/ ./server/
COPY src/sim/ ./src/sim/

CMD ["node", "server/index.js"]
