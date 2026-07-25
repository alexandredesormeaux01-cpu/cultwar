/* Point d'entrée du serveur Colyseus.
   Local : node server/index.js  →  ws://localhost:2567
   Fly.io : port lu depuis $PORT (Fly injecte). */

import pkg from 'colyseus';
const { Server } = pkg;
import wsPkg from '@colyseus/ws-transport';
const { WebSocketTransport } = wsPkg;
import { createServer } from 'http';
import { existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import express from 'express';
import { QuickplayRoom } from './quickplay-room.js';

const PORT = Number(process.env.PORT || 2567);
const CLIENT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const app = express();

app.get('/health', (_req, res) => res.json({ ok: true, uptime: process.uptime() }));

/* En prod l'image Docker contient le build Vite : le même host sert le jeu
   et les WebSockets. En dev local `dist/` est absent (le client tourne sur Vite). */
if (existsSync(join(CLIENT_DIR, 'index.html'))) {
  app.use(express.static(CLIENT_DIR));
  app.use((_req, res) => res.sendFile(join(CLIENT_DIR, 'index.html')));
} else {
  app.get('/', (_req, res) => {
    res.type('text/plain').send('cult-io server ok\n');
  });
}

const httpServer = createServer(app);
const gameServer = new Server({
  transport: new WebSocketTransport({ server: httpServer }),
});

// filterBy('code') : les joueurs qui donnent le même code partagent le même salon
gameServer.define('quickplay', QuickplayRoom).filterBy(['code']);

gameServer.listen(PORT).then(() => {
  console.log(`cult-io server listening on :${PORT}`);
  console.log(`  → ws://localhost:${PORT}   (rooms: quickplay)`);
}).catch(err => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
