/* Chambre de partie rapide.
   - Jusqu'à 6 joueurs. Match se lance à ≥2 joueurs après 5 s d'attente,
     ou immédiatement si la chambre est pleine.
   - Tick serveur à 20 Hz. Le serveur est l'autorité.
   - v1 MVP : Leaders qui bougent sur un disque circulaire (rayon MAP_R).
     Pas d'île détaillée, pas de foule gérée serveur, pas de conversion.
     La v2 ajoutera : agents gris (spawn + fuite), conversion, siphon, peinture. */

import pkg from 'colyseus';
const { Room } = pkg;
import { QuickplayState, LeaderState } from './schema.js';
import { createRng } from '../src/sim/rng.js';
import {
  MAP_R, MATCH_DUR, V_MAX, V_MIN, N_REF,
  BOOST_MULT, BOOST_DUR, BOOST_CD, LEADER_RESP,
} from '../src/sim/constants.js';

const TICK_HZ = 20;
const TICK_MS = 1000 / TICK_HZ;
const MAX_CLIENTS = 6;
const LOBBY_START_DELAY_MS = 5000;
const CULTS = [
  { c: 0xff2e7e, sym: '❤' }, { c: 0x00c8ff, sym: '☾' },
  { c: 0xffb300, sym: '☀' }, { c: 0x22dd77, sym: '🌿' },
  { c: 0x8b5cf6, sym: '👁' }, { c: 0xff5533, sym: '🔥' },
];

/* Vitesse Leader — copie simplifiée de src/sim/leader.js (sans peinture
   ni skillMods, la v1 serveur n'a pas encore ces systèmes). */
function serverLeaderSpeed(f) {
  const t = Math.min(1, f.count / N_REF);
  let v = V_MAX - (V_MAX - V_MIN) * t;
  if (f.boostT > 0) v *= BOOST_MULT;
  return v;
}

export class QuickplayRoom extends Room {
  onCreate(options) {
    this.maxClients = MAX_CLIENTS;
    // Fly peut être lent au cold-start ; défaut Colyseus = 15 s → trop court
    this.setSeatReservationTime(60);
    this.setState(new QuickplayState());
    this.rng = createRng(Date.now() & 0xffffffff);
    this.inputs = new Map();          // sessionId → { x, z, boost }
    this.lobbyStartT = null;

    this.onMessage('input', (client, msg) => {
      const inp = this.inputs.get(client.sessionId);
      if (!inp) return;
      const mx = Math.max(-1, Math.min(1, +msg.x || 0));
      const mz = Math.max(-1, Math.min(1, +msg.z || 0));
      inp.x = mx; inp.z = mz;
      if (msg.boost) inp.wantBoost = true;
    });

    this.setSimulationInterval(dtMs => this.tick(dtMs / 1000), TICK_MS);
    console.log(`[room ${this.roomId}] created`);
  }

  onJoin(client, options) {
    const idx = this.state.leaders.size;
    const cult = CULTS[idx % CULTS.length];
    const l = new LeaderState();
    l.sessionId = client.sessionId;
    l.playerName = String(options?.name || `Joueur ${idx + 1}`).slice(0, 20);
    l.leaderKey = String(options?.leaderKey || 'monk');
    l.cultColor = cult.c;
    l.cultSym = cult.sym;
    // spawn en cercle autour du centre
    const ang = (idx / MAX_CLIENTS) * Math.PI * 2;
    l.x = Math.cos(ang) * (MAP_R * 0.55);
    l.z = Math.sin(ang) * (MAP_R * 0.55);
    l.face = ang + Math.PI;
    this.state.leaders.set(client.sessionId, l);
    this.inputs.set(client.sessionId, { x: 0, z: 0, wantBoost: false });
    console.log(`[room ${this.roomId}] +${client.sessionId} (${this.state.leaders.size}/${MAX_CLIENTS})`);

    // Démarrage : ≥2 joueurs déclenche le compte à rebours, la salle pleine part direct
    if (this.state.phase === 'lobby') {
      if (this.state.leaders.size >= MAX_CLIENTS) {
        this.startMatch();
      } else if (this.state.leaders.size >= 2 && !this.lobbyStartT) {
        this.lobbyStartT = Date.now() + LOBBY_START_DELAY_MS;
      }
    }
  }

  onLeave(client, consented) {
    this.state.leaders.delete(client.sessionId);
    this.inputs.delete(client.sessionId);
    console.log(`[room ${this.roomId}] -${client.sessionId} (${this.state.leaders.size} left)`);
    if (this.state.phase === 'lobby' && this.state.leaders.size < 2) {
      this.lobbyStartT = null;
    }
    if (this.state.phase === 'play' && this.state.leaders.size === 0) {
      this.state.phase = 'over';
    }
  }

  onDispose() {
    console.log(`[room ${this.roomId}] disposed`);
  }

  startMatch() {
    this.state.phase = 'play';
    this.state.elapsed = 0;
    this.state.tick = 0;
    this.lobbyStartT = null;
    this.lock(); // personne d'autre ne crée une 2ᵉ partie en rejoignant trop tard
    console.log(`[room ${this.roomId}] match started (${this.state.leaders.size} players)`);
  }

  tick(dt) {
    this.state.tick++;
    if (this.state.phase === 'lobby') {
      if (this.lobbyStartT && Date.now() >= this.lobbyStartT) this.startMatch();
      return;
    }
    if (this.state.phase !== 'play') return;

    this.state.elapsed += dt;
    if (this.state.elapsed >= this.state.matchDur) {
      this.state.phase = 'over';
      return;
    }

    // Boucle Leaders : chaque joueur applique son input
    for (const [sid, l] of this.state.leaders) {
      if (!l.alive) continue;
      const inp = this.inputs.get(sid);
      if (!inp) continue;

      if (inp.wantBoost && l.boostT <= 0) {
        l.boostT = BOOST_DUR;
        inp.wantBoost = false;
      }
      l.boostT = Math.max(0, l.boostT - dt);

      const sp = serverLeaderSpeed(l);
      const resp = LEADER_RESP;
      l.dx += (inp.x * sp - l.dx) * Math.min(1, dt * resp);
      l.dz += (inp.z * sp - l.dz) * Math.min(1, dt * resp);
      l.x += l.dx * dt;
      l.z += l.dz * dt;

      // Bord circulaire : clamp au rayon jouable
      const rd = Math.hypot(l.x, l.z);
      if (rd > MAP_R) { l.x *= MAP_R / rd; l.z *= MAP_R / rd; }

      const spd = Math.hypot(l.dx, l.dz);
      if (spd > 0.5) l.face = Math.atan2(l.dx, l.dz);
    }
  }
}
