/* Wrapper Colyseus — connexion serveur, join room, envoi d'input, écoute
   des changements d'état. Le reste du code passe par les callbacks
   qu'on installe (onLeadersUpdate, onPhaseChange, etc.). */

import { Client } from 'colyseus.js';

const REMOTE_URL = 'wss://cultwar.fly.dev';

/* URL du serveur : dev = Vite en local, web = même origine que la page,
   mobile = serveur distant (Capacitor sert le bundle depuis localhost). */
function defaultServerUrl() {
  if (import.meta.env.DEV) return `ws://${location.hostname}:2567`;
  const { protocol, host, hostname } = location;
  if (hostname === 'localhost' || hostname === '127.0.0.1') return REMOTE_URL;
  if (protocol !== 'http:' && protocol !== 'https:') return REMOTE_URL;
  return `${protocol === 'https:' ? 'wss:' : 'ws:'}//${host}`;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export function createNetClient() {
  const state = {
    client: null,
    room: null,
    connected: false,
    sessionId: null,
    phase: 'idle',   // idle | lobby | play | over | error
    lastError: null,
    onLeadersUpdate: null,  // (leadersMap) → void, appelé à chaque changement
    onPhaseChange: null,    // (phase) → void
    onJoined: null,         // (room) → void quand la connexion réussit
    onLeft: null,           // () → void quand la connexion se ferme
  };

  async function connect(opts = {}) {
    if (state.connected) return state.room;
    const url = opts.url || defaultServerUrl();
    const joinOpts = {
      name: opts.name || 'Anonyme',
      leaderKey: opts.leaderKey || 'monk',
      // même code = même salon (filterBy côté serveur)
      code: String(opts.code || '').toUpperCase(),
    };
    const maxAttempts = 3;
    let lastErr;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      state.client = new Client(url);
      try {
        state.room = await state.client.joinOrCreate('quickplay', joinOpts);
        lastErr = null;
        break;
      } catch (e) {
        const raw = String(e?.message || e);
        lastErr = /seat reservation/i.test(raw)
          ? 'Connexion multi interrompue (souvent 2 machines Fly). Lance: fly scale count 1 -a cultwar --yes'
          : raw;
        if (!/seat reservation/i.test(raw) || attempt === maxAttempts) break;
        await sleep(400 * attempt);
      }
    }
    if (lastErr) {
      state.phase = 'error';
      state.lastError = lastErr;
      throw new Error(lastErr);
    }
    state.connected = true;
    state.sessionId = state.room.sessionId;
    state.phase = state.room.state.phase || 'lobby';

    state.room.state.leaders.onAdd = () => notifyLeaders();
    state.room.state.leaders.onRemove = () => notifyLeaders();
    state.room.state.leaders.onChange = () => notifyLeaders();
    state.room.state.listen('phase', (v) => {
      state.phase = v;
      if (state.onPhaseChange) state.onPhaseChange(v);
    });
    state.room.onLeave(() => {
      state.connected = false;
      if (state.onLeft) state.onLeft();
    });
    state.room.onError((code, msg) => {
      console.warn('[net] room error', code, msg);
    });

    notifyLeaders();
    if (state.onJoined) state.onJoined(state.room);
    return state.room;
  }

  function notifyLeaders() {
    if (state.onLeadersUpdate && state.room) {
      state.onLeadersUpdate(state.room.state.leaders);
    }
  }

  function sendInput(x, z, boost = false) {
    if (!state.connected || !state.room) return;
    state.room.send('input', { x, z, boost });
  }

  async function leave() {
    if (state.room) {
      try { await state.room.leave(); } catch (_) {}
    }
    state.connected = false;
    state.room = null;
    state.phase = 'idle';
  }

  return {
    state,
    connect,
    leave,
    sendInput,
    getLeaders() { return state.room?.state.leaders || null; },
    getMyLeader() { return state.room?.state.leaders.get(state.sessionId) || null; },
    isMe(sessionId) { return sessionId === state.sessionId; },
    onLeadersUpdate: (fn) => { state.onLeadersUpdate = fn; },
    onPhaseChange: (fn) => { state.onPhaseChange = fn; },
    onJoined: (fn) => { state.onJoined = fn; },
    onLeft: (fn) => { state.onLeft = fn; },
  };
}
