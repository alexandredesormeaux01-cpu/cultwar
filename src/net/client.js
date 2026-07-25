/* P2P multiplayer via PeerJS — remplace Colyseus.
   L'hôte crée un peer PeerJS avec ID = 'cultwar-{CODE}'.
   Les invités se connectent à ce peer ID via WebRTC DataChannel.
   Plus besoin de serveur dédié (Fly.io, Colyseus). */

import Peer from 'peerjs';
import { MATCH_DUR } from '../sim/constants.js';

const PEER_PREFIX = 'cultwar-';
const MAX_SLOTS = 6;
const DIFFS = ['easy', 'normal', 'hard'];
const CULTS = [
  { c: 0xff2e7e, sym: '❤' }, { c: 0x00c8ff, sym: '☾' },
  { c: 0xffb300, sym: '☀' }, { c: 0x22dd77, sym: '🌿' },
  { c: 0x8b5cf6, sym: '👁' }, { c: 0xff5533, sym: '🔥' },
];
const BOT_NAMES = ['IA Écarlate', 'IA Sélénie', 'IA Hélion', 'IA Sylvane', 'IA Occule', 'IA Pyrrhée'];
const BOT_LEADERS = ['monk', 'sorcerer', 'nomad', 'amazon', 'alien', 'chief'];
const BIOME_KEYS = ['temperate', 'desert', 'nordic', 'tropical', 'savanna', 'volcanic'];

function nextCult(slots) {
  const used = new Set();
  for (const s of slots.values()) used.add(s.cultColor);
  return CULTS.find(c => !used.has(c.c)) || CULTS[slots.size % CULTS.length];
}

function nextSeatIndex(slots) {
  const used = new Set();
  for (const s of slots.values()) used.add(s.seatIndex);
  for (let i = 0; i < MAX_SLOTS; i++) if (!used.has(i)) return i;
  return 0;
}

function slotsToArray(slots) {
  if (!slots || !slots.size) return [];
  const out = [];
  for (const [id, s] of slots) out.push({ ...s, id: s.id || id });
  out.sort((a, b) => Number(b.isHost) - Number(a.isHost)
    || (a.kind === 'human' ? 0 : 1) - (b.kind === 'human' ? 0 : 1)
    || String(a.id).localeCompare(String(b.id)));
  return out;
}

function friendlyPeerError(err, mode) {
  const msg = String(err?.message || err?.type || err || '');
  if (/unavailable/i.test(msg) || /peer-unavailable/i.test(msg)) {
    return 'Aucun salon ouvert avec ce code.';
  }
  if (/taken/i.test(msg) || /unavailable-id/i.test(msg)) {
    return 'Ce code est déjà utilisé — réessaie.';
  }
  if (/disconnected/i.test(msg) || /network/i.test(msg)) {
    return 'Connexion au réseau impossible.';
  }
  return msg || 'Connexion impossible';
}

export function createNetClient() {
  const state = {
    peer: null,
    hostConn: null,
    guestConns: new Map(),
    connected: false,
    sessionId: null,
    phase: 'idle',
    lastError: null,
    _isHost: false,
    _code: '',
    _hostSessionId: '',
    _slots: new Map(),
    _leaders: new Map(),
    _allLeaders: [],
    _seed: 0,
    _biome: '',
    _matchDur: MATCH_DUR,
    _elapsed: 0,
    _tick: 0,
    _matchTimer: null,
    _botSeq: 0,
    onLeadersUpdate: null,
    onSlotsUpdate: null,
    onPhaseChange: null,
    onJoined: null,
    onLeft: null,
  };

  function notifySlots() {
    if (state.onSlotsUpdate) state.onSlotsUpdate(slotsToArray(state._slots));
  }
  function notifyLeaders() {
    if (state.onLeadersUpdate) state.onLeadersUpdate(state._leaders);
  }
  function setPhase(p) {
    state.phase = p;
    if (state.onPhaseChange) state.onPhaseChange(p);
  }

  function broadcast(msg) {
    for (const conn of state.guestConns.values()) {
      try { if (conn.open) conn.send(msg); } catch (_) {}
    }
  }
  function sendToHost(msg) {
    try { if (state.hostConn?.open) state.hostConn.send(msg); } catch (_) {}
  }

  /* ---- HOST : messages reçus d'un invité ---- */
  function onGuestData(conn, msg) {
    switch (msg.type) {
      case 'join': {
        if (state.phase !== 'lobby') {
          conn.send({ type: 'joinReject', reason: 'Partie déjà lancée' });
          return;
        }
        if (state._slots.size >= MAX_SLOTS) {
          let freed = false;
          for (const [id, s] of state._slots) {
            if (s.kind === 'bot') { state._slots.delete(id); freed = true; break; }
          }
          if (!freed) {
            conn.send({ type: 'joinReject', reason: 'Salon complet (6 joueurs).' });
            return;
          }
        }
        const guestSid = conn.peer;
        const cult = nextCult(state._slots);
        const slot = {
          id: guestSid, kind: 'human', sessionId: guestSid,
          name: String(msg.name || 'Joueur').slice(0, 20),
          leaderKey: String(msg.leaderKey || 'monk'),
          difficulty: 'normal',
          cultColor: cult.c, cultSym: cult.sym,
          isHost: false,
          seatIndex: nextSeatIndex(state._slots),
        };
        state._slots.set(guestSid, slot);
        state.guestConns.set(guestSid, conn);
        conn._sid = guestSid;

        conn.send({
          type: 'joinAccept',
          sessionId: guestSid,
          slots: [...state._slots.values()],
          hostSessionId: state._hostSessionId,
          phase: state.phase,
          code: state._code,
        });
        broadcast({ type: 'slotsUpdate', slots: [...state._slots.values()] });
        notifySlots();
        break;
      }
      case 'pos': {
        const sid = conn._sid;
        if (!sid) return;
        const prev = state._leaders.get(sid) || {};
        state._leaders.set(sid, {
          ...prev,
          x: msg.x, z: msg.z, dx: msg.dx, dz: msg.dz,
          alive: msg.alive !== false,
        });
        break;
      }
      case 'stats': {
        const sid = conn._sid;
        if (!sid) return;
        const l = state._leaders.get(sid) || {};
        l.count = msg.count | 0;
        l.grisAbs = msg.grisAbs | 0;
        l.score = msg.score | 0;
        l.pct = +msg.pct || 0;
        state._leaders.set(sid, l);
        break;
      }
      case 'choice': {
        const sid = conn._sid;
        if (!sid || state.phase !== 'lobby') return;
        applyChoice(sid, msg);
        break;
      }
    }
  }

  /* Application de la sélection perso/couleur : validation puis broadcast.
     La couleur demandée est ignorée si un autre siège l'occupe déjà. */
  function applyChoice(sid, msg) {
    const slot = state._slots.get(sid);
    if (!slot) return;
    if (msg.leaderKey && typeof msg.leaderKey === 'string') {
      slot.leaderKey = msg.leaderKey.slice(0, 16);
    }
    if (typeof msg.cultColor === 'number') {
      const cult = CULTS.find(c => c.c === msg.cultColor);
      if (cult) {
        const taken = [...state._slots.values()].some(s => s.id !== sid && s.cultColor === cult.c);
        if (!taken) {
          slot.cultColor = cult.c;
          slot.cultSym = cult.sym;
        }
      }
    }
    if (msg.name && typeof msg.name === 'string') {
      slot.name = msg.name.slice(0, 20);
    }
    broadcast({ type: 'slotsUpdate', slots: [...state._slots.values()] });
    notifySlots();
  }

  function onGuestDisconnect(conn) {
    const sid = conn._sid;
    if (!sid) return;
    state._slots.delete(sid);
    state._leaders.delete(sid);
    state.guestConns.delete(sid);
    broadcast({ type: 'slotsUpdate', slots: [...state._slots.values()] });
    notifySlots();
  }

  function handleGuestConn(conn) {
    conn.on('data', (msg) => onGuestData(conn, msg));
    conn.on('close', () => onGuestDisconnect(conn));
    conn.on('error', () => onGuestDisconnect(conn));
  }

  /* ---- GUEST : messages reçus de l'hôte ---- */
  function onHostData(msg) {
    switch (msg.type) {
      case 'slotsUpdate':
        state._slots = new Map(msg.slots.map(s => [s.id, s]));
        notifySlots();
        break;
      case 'phase':
        if (msg.seed) state._seed = msg.seed;
        if (msg.biome) state._biome = msg.biome;
        if (msg.matchDur) state._matchDur = msg.matchDur;
        if (msg.slots) {
          state._slots = new Map(msg.slots.map(s => [s.id, s]));
          notifySlots();
        }
        setPhase(msg.phase);
        break;
      case 'tick':
        state._elapsed = msg.elapsed || 0;
        state._tick = msg.tick || 0;
        if (msg.leaders) {
          for (const [sid, data] of Object.entries(msg.leaders)) {
            state._leaders.set(sid, data);
          }
        }
        break;
      case 'over':
        if (msg.leaders) {
          for (const [sid, data] of Object.entries(msg.leaders)) {
            state._leaders.set(sid, data);
          }
        }
        state._allLeaders = msg.leaderList || [];
        setPhase('over');
        break;
    }
  }

  /* ---- Connect ---- */
  async function connect(opts = {}) {
    const mode = opts.mode === 'create' ? 'create' : 'join';
    if (state.peer || state.connected) await leave();

    const code = String(opts.code || '').toUpperCase();
    state._code = code;
    state._isHost = mode === 'create';
    state._botSeq = 0;
    state._slots = new Map();
    state._leaders = new Map();
    state._allLeaders = [];

    return new Promise((resolve, reject) => {
      let resolved = false;
      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          reject(new Error('Délai dépassé — impossible de se connecter'));
          leave();
        }
      }, 15000);

      const fail = (err) => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          reject(new Error(friendlyPeerError(err, mode)));
        }
      };

      if (mode === 'create') {
        const peer = new Peer(PEER_PREFIX + code);
        state.peer = peer;

        peer.on('open', (id) => {
          if (resolved) return;
          resolved = true;
          clearTimeout(timeout);
          state.sessionId = id;
          state._hostSessionId = id;
          state.connected = true;
          state.phase = 'lobby';
          const cult = nextCult(state._slots);
          state._slots.set(id, {
            id, kind: 'human', sessionId: id,
            name: String(opts.name || 'Joueur').slice(0, 20),
            leaderKey: String(opts.leaderKey || 'monk'),
            difficulty: 'normal',
            cultColor: cult.c, cultSym: cult.sym,
            isHost: true, seatIndex: 0,
          });
          notifySlots();
          if (state.onJoined) state.onJoined(null);
          resolve(null);
        });
        peer.on('connection', handleGuestConn);
        peer.on('error', fail);
        peer.on('disconnected', () => {
          state.connected = false;
          if (state.onLeft) state.onLeft();
        });

      } else {
        const peer = new Peer();
        state.peer = peer;

        peer.on('open', (myId) => {
          state.sessionId = myId;
          const conn = peer.connect(PEER_PREFIX + code, { reliable: true });
          state.hostConn = conn;

          conn.on('open', () => {
            conn.send({
              type: 'join',
              name: opts.name || 'Joueur',
              leaderKey: opts.leaderKey || 'monk',
            });
          });

          conn.on('data', (msg) => {
            if (!resolved) {
              if (msg.type === 'joinAccept') {
                resolved = true;
                clearTimeout(timeout);
                state._hostSessionId = msg.hostSessionId;
                state._code = msg.code || code;
                state.phase = msg.phase || 'lobby';
                state._slots = new Map(msg.slots.map(s => [s.id, s]));
                state.connected = true;
                notifySlots();
                if (state.onJoined) state.onJoined(null);
                resolve(null);
              } else if (msg.type === 'joinReject') {
                resolved = true;
                clearTimeout(timeout);
                reject(new Error(msg.reason || 'Rejoindre refusé'));
                leave();
              }
            } else {
              onHostData(msg);
            }
          });

          conn.on('close', () => {
            if (!resolved) fail({ message: 'Connexion fermée par l\'hôte' });
            state.connected = false;
            if (state.onLeft) state.onLeft();
          });
          conn.on('error', fail);
        });
        peer.on('error', fail);
      }
    });
  }

  async function leave() {
    if (state._matchTimer) { clearTimeout(state._matchTimer); state._matchTimer = null; }
    state.connected = false;
    state.phase = 'idle';
    state._isHost = false;
    const peer = state.peer;
    state.peer = null;
    state.hostConn = null;
    state.guestConns = new Map();
    state._slots = new Map();
    state._leaders = new Map();
    state._allLeaders = [];
    if (peer) try { peer.destroy(); } catch (_) {}
  }

  /* ---- Actions du salon (hôte) ---- */
  function addBot(difficulty = 'normal') {
    if (!state._isHost || state.phase !== 'lobby') return;
    if (state._slots.size >= MAX_SLOTS) return;
    const diff = DIFFS.includes(difficulty) ? difficulty : 'normal';
    const cult = nextCult(state._slots);
    const id = `bot_${++state._botSeq}`;
    state._slots.set(id, {
      id, kind: 'bot', sessionId: id,
      name: BOT_NAMES[(state._botSeq - 1) % BOT_NAMES.length],
      leaderKey: BOT_LEADERS[(state._botSeq - 1) % BOT_LEADERS.length],
      difficulty: diff,
      cultColor: cult.c, cultSym: cult.sym,
      isHost: false,
      seatIndex: nextSeatIndex(state._slots),
    });
    broadcast({ type: 'slotsUpdate', slots: [...state._slots.values()] });
    notifySlots();
  }

  function removeBot(slotId) {
    if (!state._isHost || state.phase !== 'lobby') return;
    const slot = state._slots.get(slotId);
    if (!slot || slot.kind !== 'bot') return;
    state._slots.delete(slotId);
    broadcast({ type: 'slotsUpdate', slots: [...state._slots.values()] });
    notifySlots();
  }

  function setBotDiff(slotId, difficulty) {
    if (!state._isHost || state.phase !== 'lobby') return;
    const slot = state._slots.get(slotId);
    if (!slot || slot.kind !== 'bot') return;
    if (DIFFS.includes(difficulty)) slot.difficulty = difficulty;
    broadcast({ type: 'slotsUpdate', slots: [...state._slots.values()] });
    notifySlots();
  }

  /* Client (hôte ou invité) demande à changer perso/couleur. L'hôte applique
     directement ; l'invité envoie au réseau et l'hôte valide/rebroadcast. */
  function setChoice(choice) {
    if (state.phase !== 'lobby') return;
    if (state._isHost) {
      applyChoice(state.sessionId, choice);
    } else {
      sendToHost({ type: 'choice', ...choice });
    }
  }

  /* Liste des couleurs déjà prises (pour griser les swatches côté UI). */
  function takenColors(exceptSid) {
    const out = new Set();
    for (const s of state._slots.values()) {
      if (s.id === exceptSid) continue;
      out.add(s.cultColor);
    }
    return out;
  }

  function requestStart() {
    if (!state._isHost || state.phase !== 'lobby') return;
    if (state._slots.size < 2) return;
    const sorted = [...state._slots.values()].sort((a, b) => a.seatIndex - b.seatIndex);
    sorted.forEach((s, i) => { s.seatIndex = i; });

    state._seed = (Math.floor(Math.random() * 0xffffffff) >>> 0) || 1;
    state._biome = BIOME_KEYS[Math.floor(Math.random() * BIOME_KEYS.length)];
    state._matchDur = MATCH_DUR;
    state._elapsed = 0;
    state._tick = 0;

    broadcast({
      type: 'phase', phase: 'play',
      seed: state._seed, biome: state._biome,
      matchDur: state._matchDur,
      slots: sorted,
    });

    state._matchTimer = setTimeout(() => endMatch(), state._matchDur * 1000);
    setPhase('play');
  }

  function endMatch() {
    if (state.phase === 'over') return;
    if (state._matchTimer) { clearTimeout(state._matchTimer); state._matchTimer = null; }
    if (state._isHost) {
      broadcast({
        type: 'over',
        leaders: Object.fromEntries(state._leaders),
        leaderList: state._allLeaders,
      });
    }
    setPhase('over');
  }

  /* Hôte : ramène tout le monde dans le salon (post-partie) pour relancer un match
     avec les mêmes joueurs. Les invités reçoivent phase:'lobby' et remontent au lobby. */
  function returnToLobby() {
    if (!state._isHost) return;
    if (state._matchTimer) { clearTimeout(state._matchTimer); state._matchTimer = null; }
    state._leaders = new Map();
    state._allLeaders = [];
    state._elapsed = 0;
    state._tick = 0;
    const slots = [...state._slots.values()];
    broadcast({ type: 'phase', phase: 'lobby', slots });
    setPhase('lobby');
  }

  /* ---- Gameplay P2P ---- */
  function sendPos(x, z, dx, dz) {
    if (!state.connected || state._isHost) return;
    sendToHost({ type: 'pos', x, z, dx, dz });
  }

  function broadcastLeaders(leadersData, elapsed) {
    if (!state._isHost || !state.connected) return;
    state._allLeaders = leadersData;
    state._elapsed = elapsed || 0;
    const obj = {};
    for (const d of leadersData) {
      obj[d.sid] = d;
      if (!state.guestConns.has(d.sid)) {
        state._leaders.set(d.sid, d);
      }
    }
    state._tick++;
    broadcast({ type: 'tick', elapsed: state._elapsed, tick: state._tick, leaders: obj });
  }

  function sendStats(sessionId, s) {
    if (!state.connected) return;
    if (state._isHost) {
      const l = state._leaders.get(sessionId) || {};
      Object.assign(l, s);
      state._leaders.set(sessionId, l);
    } else {
      sendToHost({ type: 'stats', sessionId, ...s });
    }
  }

  function leaderList() {
    const source = state._allLeaders.length ? state._allLeaders : [...state._leaders.values()];
    return source.map(l => {
      const sid = l.sid || l.sessionId;
      const slot = state._slots.get(sid);
      return {
        sessionId: sid,
        name: slot?.name || l.playerName || '—',
        cultColor: slot?.cultColor || l.cultColor || 0,
        cultSym: slot?.cultSym || l.cultSym || '⚔',
        isBot: slot?.kind === 'bot' || !!l.isBot,
        seatIndex: slot?.seatIndex ?? l.seatIndex ?? 0,
        score: l.score | 0,
        pct: +l.pct || 0,
        grisAbs: l.grisAbs | 0,
      };
    }).sort((a, b) => b.score - a.score || a.seatIndex - b.seatIndex);
  }

  return {
    state,
    connect,
    create: (opts = {}) => connect({ ...opts, mode: 'create' }),
    join: (opts = {}) => connect({ ...opts, mode: 'join' }),
    leave,
    send: () => {},
    sendInput: () => {},
    sendPos,
    broadcastLeaders,
    sendStats,
    endMatch,
    returnToLobby,
    setChoice,
    takenColors,
    availableCults: () => CULTS.slice(),
    addBot,
    removeBot,
    setBotDiff,
    requestStart,
    getSlots: () => slotsToArray(state._slots),
    getLeaders: () => state._leaders,
    getLeaderList: () => leaderList(),
    getMyLeader() { return state._leaders.get(state.sessionId) || null; },
    isMe(sessionId) { return sessionId === state.sessionId; },
    isHost() { return state._isHost; },
    getCode() { return state._code; },
    getSeed() { return state._seed || 1; },
    getBiome() { return state._biome || ''; },
    getMatchDur() { return state._matchDur || MATCH_DUR; },
    getElapsed() { return state._elapsed || 0; },
    onLeadersUpdate: (fn) => { state.onLeadersUpdate = fn; },
    onSlotsUpdate: (fn) => { state.onSlotsUpdate = fn; },
    onPhaseChange: (fn) => { state.onPhaseChange = fn; },
    onJoined: (fn) => { state.onJoined = fn; },
    onLeft: (fn) => { state.onLeft = fn; },
  };
}
