/* Salon multijoueur jusqu'à 6 places (humains + IA).
   - Code partagé (filterBy) pour rejoindre le même salon.
   - L'hôte ajoute/retire des IA et règle leur difficulté.
   - Démarrage manuel (bouton hôte), pas de compte à rebours auto.
   - Le serveur fait autorité sur : la graine du monde, le biome, la place de
     chaque siège, le déplacement de TOUS les Leaders (humains distants ET IA)
     et le classement final. */

import pkg from 'colyseus';
const { Room } = pkg;
import { QuickplayState, LeaderState, LobbySlot } from './schema.js';
import { createRng } from '../src/sim/rng.js';
import {
  MAP_R, MATCH_DUR, V_MAX, V_MIN, N_REF,
  BOOST_MULT, BOOST_DUR, LEADER_RESP,
} from '../src/sim/constants.js';

const TICK_HZ = 20;
const TICK_MS = 1000 / TICK_HZ;
const MAX_SLOTS = 6;
const MAX_CLIENTS = 6;
const DIFFS = ['easy', 'normal', 'hard'];
/* Doit rester aligné sur les clés de BIOMES dans src/biomes.js. */
const BIOME_KEYS = ['temperate', 'desert', 'nordic', 'tropical', 'savanna', 'volcanic'];
const CULTS = [
  { c: 0xff2e7e, sym: '❤' }, { c: 0x00c8ff, sym: '☾' },
  { c: 0xffb300, sym: '☀' }, { c: 0x22dd77, sym: '🌿' },
  { c: 0x8b5cf6, sym: '👁' }, { c: 0xff5533, sym: '🔥' },
];
const BOT_NAMES = ['IA Écarlate', 'IA Sélénie', 'IA Hélion', 'IA Sylvane', 'IA Occule', 'IA Pyrrhée'];
const BOT_LEADERS = ['monk', 'sorcerer', 'nomad', 'amazon', 'alien', 'chief'];
/* Délai avant de fermer une room finie : laisse le temps aux clients de lire
   le classement, puis force la déconnexion pour qu'aucun salon zombie ne
   traîne avec ses IA. */
const OVER_LINGER_MS = 20000;

function serverLeaderSpeed(f) {
  const t = Math.min(1, f.count / N_REF);
  let v = V_MAX - (V_MAX - V_MIN) * t;
  if (f.boostT > 0) v *= BOOST_MULT;
  // IA easy un peu plus lente, hard un peu plus vive
  if (f.isBot) {
    if (f.difficulty === 'easy') v *= 0.75;
    else if (f.difficulty === 'hard') v *= 1.15;
  }
  return v;
}

function nextCult(slots) {
  const used = new Set();
  for (const s of slots.values()) used.add(s.cultColor);
  return CULTS.find((c) => !used.has(c.c)) || CULTS[slots.size % CULTS.length];
}

/* Première place libre : deux clients qui rejoignent ne se marchent pas dessus
   et l'index reste stable même après le départ d'un voisin. */
function nextSeatIndex(slots) {
  const used = new Set();
  for (const s of slots.values()) used.add(s.seatIndex);
  for (let i = 0; i < MAX_SLOTS; i++) if (!used.has(i)) return i;
  return 0;
}

export class QuickplayRoom extends Room {
  onCreate(options) {
    this.maxClients = MAX_CLIENTS;
    this.setSeatReservationTime(60);
    this.code = String(options?.code || '').toUpperCase().slice(0, 8);
    this.setMetadata({ code: this.code });
    this.setState(new QuickplayState());
    this.state.code = this.code;
    this.state.matchDur = MATCH_DUR;
    this.rng = createRng(Date.now() & 0xffffffff);
    this.inputs = new Map();
    this.botTargets = new Map(); // sessionId → { x, z, retargetT }
    this.botSeq = 0;
    this.overTimeout = null;

    this.onMessage('input', (client, msg) => {
      if (this.state.phase !== 'play') return;
      const inp = this.inputs.get(client.sessionId);
      if (!inp) return;
      inp.x = Math.max(-1, Math.min(1, +msg.x || 0));
      inp.z = Math.max(-1, Math.min(1, +msg.z || 0));
      if (msg.boost) inp.wantBoost = true;
    });

    /* Score remonté par le client qui simule la faction. Chacun n'a le droit
       que sur son propre Leader ; l'hôte fait autorité pour les IA. */
    this.onMessage('stats', (client, msg) => {
      if (this.state.phase !== 'play') return;
      const sid = String(msg?.sessionId || client.sessionId);
      const l = this.state.leaders.get(sid);
      if (!l) return;
      const mine = sid === client.sessionId;
      const botAsHost = l.isBot && this.isHost(client);
      if (!mine && !botAsHost) return;
      l.count = Math.max(0, Math.min(65535, Math.round(+msg.count || 0)));
      l.grisAbs = Math.max(0, Math.min(65535, Math.round(+msg.grisAbs || 0)));
      l.score = Math.max(0, Math.min(4294967295, Math.round(+msg.score || 0)));
      l.pct = Math.max(0, Math.min(100, +msg.pct || 0));
    });

    this.onMessage('addBot', (client, msg) => {
      if (!this.isHost(client) || this.state.phase !== 'lobby') return;
      if (this.state.slots.size >= MAX_SLOTS) return;
      const diff = DIFFS.includes(msg?.difficulty) ? msg.difficulty : 'normal';
      this.addBotSlot(diff);
    });

    this.onMessage('removeBot', (client, msg) => {
      if (!this.isHost(client) || this.state.phase !== 'lobby') return;
      const id = String(msg?.slotId || '');
      const slot = this.state.slots.get(id);
      if (!slot || slot.kind !== 'bot') return;
      this.state.slots.delete(id);
    });

    this.onMessage('setBotDiff', (client, msg) => {
      if (!this.isHost(client) || this.state.phase !== 'lobby') return;
      const id = String(msg?.slotId || '');
      const slot = this.state.slots.get(id);
      if (!slot || slot.kind !== 'bot') return;
      if (DIFFS.includes(msg?.difficulty)) slot.difficulty = msg.difficulty;
    });

    this.onMessage('startMatch', (client) => {
      if (!this.isHost(client) || this.state.phase !== 'lobby') return;
      if (this.state.slots.size < 2) return;
      this.startMatch();
    });

    this.setSimulationInterval((dtMs) => this.tick(dtMs / 1000), TICK_MS);
    console.log(`[room ${this.roomId}] created code=${this.code}`);
  }

  isHost(client) {
    return client.sessionId === this.state.hostSessionId;
  }

  countHumanSlots() {
    let n = 0;
    for (const s of this.state.slots.values()) if (s.kind === 'human') n++;
    return n;
  }

  addBotSlot(difficulty = 'normal') {
    const cult = nextCult(this.state.slots);
    const id = `bot_${++this.botSeq}`;
    const slot = new LobbySlot();
    slot.id = id;
    slot.kind = 'bot';
    slot.sessionId = id;
    slot.name = BOT_NAMES[(this.botSeq - 1) % BOT_NAMES.length];
    slot.leaderKey = BOT_LEADERS[(this.botSeq - 1) % BOT_LEADERS.length];
    slot.difficulty = difficulty;
    slot.cultColor = cult.c;
    slot.cultSym = cult.sym;
    slot.isHost = false;
    slot.seatIndex = nextSeatIndex(this.state.slots);
    this.state.slots.set(id, slot);
    return slot;
  }

  /* Un salon dont tous les humains sont partis ne doit rien garder : sinon les
     IA restent « assises » et la place manque au joueur suivant. */
  purgeBots() {
    for (const [id, s] of [...this.state.slots.entries()]) {
      if (s.kind === 'bot') {
        this.state.slots.delete(id);
        this.state.leaders.delete(id);
        this.inputs.delete(id);
        this.botTargets.delete(id);
      }
    }
  }

  onJoin(client, options) {
    if (this.state.phase !== 'lobby') {
      // Throw ⇒ la promesse join() du client est rejetée avec ce message.
      throw new Error('La partie a déjà commencé dans ce salon.');
    }
    if (this.state.slots.size >= MAX_SLOTS) {
      // libérer une IA pour faire de la place à l'humain
      let freed = false;
      for (const [id, s] of this.state.slots.entries()) {
        if (s.kind === 'bot') {
          this.state.slots.delete(id);
          freed = true;
          break;
        }
      }
      if (!freed) throw new Error('Ce salon est complet (6 joueurs).');
    }

    const cult = nextCult(this.state.slots);
    const slot = new LobbySlot();
    slot.id = client.sessionId;
    slot.kind = 'human';
    slot.sessionId = client.sessionId;
    slot.name = String(options?.name || `Joueur`).slice(0, 20);
    slot.leaderKey = String(options?.leaderKey || 'monk');
    slot.difficulty = 'normal';
    slot.cultColor = cult.c;
    slot.cultSym = cult.sym;
    slot.seatIndex = nextSeatIndex(this.state.slots);

    if (!this.state.hostSessionId) {
      this.state.hostSessionId = client.sessionId;
      slot.isHost = true;
    }

    this.state.slots.set(client.sessionId, slot);
    console.log(`[room ${this.roomId}] +human ${slot.name} (${this.state.slots.size}/${MAX_SLOTS})`);
  }

  onLeave(client) {
    this.state.slots.delete(client.sessionId);
    this.state.leaders.delete(client.sessionId);
    this.inputs.delete(client.sessionId);
    this.botTargets.delete(client.sessionId);

    if (this.state.hostSessionId === client.sessionId) {
      // Transférer l'hôte au prochain humain
      this.state.hostSessionId = '';
      for (const s of this.state.slots.values()) {
        if (s.kind === 'human') {
          this.state.hostSessionId = s.sessionId;
          s.isHost = true;
          break;
        }
      }
    }

    const humans = this.countHumanSlots();
    if (humans === 0) {
      /* Plus personne : on vide les IA et on remet le salon à zéro. La room est
         de toute façon détruite par autoDispose, mais si un client la retrouve
         entre-temps il tombe sur un salon propre, pas sur 5 IA fantômes. */
      this.purgeBots();
      if (this.state.phase === 'play') this.endMatch();
    } else if (this.state.phase === 'play') {
      let humanLeaders = 0;
      for (const l of this.state.leaders.values()) {
        if (!l.isBot) humanLeaders++;
      }
      if (humanLeaders === 0) this.endMatch();
    }
    console.log(`[room ${this.roomId}] -${client.sessionId} slots=${this.state.slots.size}`);
  }

  onDispose() {
    if (this.overTimeout) {
      clearTimeout(this.overTimeout);
      this.overTimeout = null;
    }
    console.log(`[room ${this.roomId}] disposed`);
  }

  startMatch() {
    /* Ordre des sièges = ordre des places, identique pour tous les clients. */
    const slots = [...this.state.slots.values()].sort((a, b) => a.seatIndex - b.seatIndex);
    const n = slots.length;
    this.state.seed = (Math.floor(Math.random() * 0xffffffff) >>> 0) || 1;
    this.state.biome = BIOME_KEYS[this.rng.int(0, BIOME_KEYS.length)] || BIOME_KEYS[0];

    slots.forEach((slot, idx) => {
      slot.seatIndex = idx;   // compacte 0..n-1 : les bases se répartissent bien
      const l = new LeaderState();
      l.sessionId = slot.sessionId;
      l.playerName = slot.name;
      l.leaderKey = slot.leaderKey;
      l.cultColor = slot.cultColor;
      l.cultSym = slot.cultSym;
      l.isBot = slot.kind === 'bot';
      l.difficulty = slot.difficulty;
      l.seatIndex = idx;
      const ang = (idx / n) * Math.PI * 2 - Math.PI / 2;
      l.x = Math.cos(ang) * (MAP_R * 0.55);
      l.z = Math.sin(ang) * (MAP_R * 0.55);
      l.face = ang + Math.PI;
      this.state.leaders.set(slot.sessionId, l);
      this.inputs.set(slot.sessionId, { x: 0, z: 0, wantBoost: false });
      if (l.isBot) {
        this.botTargets.set(slot.sessionId, { x: 0, z: 0, retargetT: 0 });
      }
    });

    this.state.phase = 'play';
    this.state.elapsed = 0;
    this.state.tick = 0;
    this.lock();
    console.log(`[room ${this.roomId}] match started (${n} seats, seed=${this.state.seed}, biome=${this.state.biome})`);
  }

  endMatch() {
    if (this.state.phase === 'over') return;
    this.state.phase = 'over';
    if (!this.overTimeout) {
      this.overTimeout = setTimeout(() => {
        this.overTimeout = null;
        this.disconnect().catch(() => {});
      }, OVER_LINGER_MS);
    }
    console.log(`[room ${this.roomId}] match over`);
  }

  updateBotBrain(sid, l, dt) {
    const rand = () => this.rng.next();
    let t = this.botTargets.get(sid);
    if (!t) {
      t = { x: 0, z: 0, retargetT: 0 };
      this.botTargets.set(sid, t);
    }
    t.retargetT -= dt;
    if (t.retargetT <= 0) {
      const interval = l.difficulty === 'easy' ? 2.2 : l.difficulty === 'hard' ? 0.7 : 1.3;
      t.retargetT = interval * (0.7 + rand() * 0.6);
      // Vise un humain au hasard, sinon point aléatoire
      const humans = [];
      for (const o of this.state.leaders.values()) {
        if (!o.isBot && o.alive) humans.push(o);
      }
      if (humans.length && rand() < 0.65) {
        const h = humans[(rand() * humans.length) | 0];
        t.x = h.x + (rand() - 0.5) * 12;
        t.z = h.z + (rand() - 0.5) * 12;
      } else {
        const ang = rand() * Math.PI * 2;
        const r = rand() * MAP_R * 0.7;
        t.x = Math.cos(ang) * r;
        t.z = Math.sin(ang) * r;
      }
    }
    const dx = t.x - l.x;
    const dz = t.z - l.z;
    const len = Math.hypot(dx, dz) || 1;
    const inp = this.inputs.get(sid);
    if (inp) {
      inp.x = dx / len;
      inp.z = dz / len;
      if (l.difficulty === 'hard' && rand() < 0.01) inp.wantBoost = true;
    }
  }

  tick(dt) {
    this.state.tick++;
    if (this.state.phase !== 'play') return;

    this.state.elapsed += dt;
    if (this.state.elapsed >= this.state.matchDur) {
      this.endMatch();
      return;
    }

    for (const [sid, l] of this.state.leaders.entries()) {
      if (!l.alive) continue;
      if (l.isBot) this.updateBotBrain(sid, l, dt);

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

      const rd = Math.hypot(l.x, l.z);
      if (rd > MAP_R) { l.x *= MAP_R / rd; l.z *= MAP_R / rd; }

      const spd = Math.hypot(l.dx, l.dz);
      if (spd > 0.5) l.face = Math.atan2(l.dx, l.dz);
    }
  }
}
