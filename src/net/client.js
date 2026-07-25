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
    state.client = new Client(url);
    try {
      state.room = await state.client.joinOrCreate('quickplay', {
        name: opts.name || 'Anonyme',
        leaderKey: opts.leaderKey || 'monk',
      });
    } catch (e) {
      state.phase = 'error';
      state.lastError = String(e?.message || e);
      throw e;
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
