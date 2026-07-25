/* Point d'entrée du serveur Colyseus.
   Local : node server/index.js  →  ws://localhost:2567
   Fly.io : port lu depuis $PORT (Fly injecte). */

import pkg from 'colyseus';
const { Server } = pkg;
import wsPkg from '@colyseus/ws-transport';
const { WebSocketTransport } = wsPkg;
import { createServer } from 'http';
import express from 'express';
import { QuickplayRoom } from './quickplay-room.js';

const PORT = Number(process.env.PORT || 2567);
const app = express();

app.get('/', (req, res) => {
  res.type('text/plain').send('cult-io server ok\n');
});
app.get('/health', (_req, res) => res.json({ ok: true, uptime: process.uptime() }));

const httpServer = createServer(app);
const gameServer = new Server({
  transport: new WebSocketTransport({ server: httpServer }),
});

gameServer.define('quickplay', QuickplayRoom);

gameServer.listen(PORT).then(() => {
  console.log(`cult-io server listening on :${PORT}`);
  console.log(`  → ws://localhost:${PORT}   (rooms: quickplay)`);
}).catch(err => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
