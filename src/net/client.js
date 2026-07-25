/* Wrapper Colyseus — connexion, salon (slots), input, callbacks. */

import { Client } from 'colyseus.js';

const REMOTE_URL = 'wss://cultwar.fly.dev';

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

function slotsToArray(slots) {
  if (!slots) return [];
  const out = [];
  slots.forEach((s, id) => {
    out.push({
      id: s.id || id,
      kind: s.kind,
      sessionId: s.sessionId,
      name: s.name,
      leaderKey: s.leaderKey,
      difficulty: s.difficulty,
      cultColor: s.cultColor,
      cultSym: s.cultSym,
      isHost: !!s.isHost,
    });
  });
  // Ordre stable : hôte d'abord, puis humains, puis IA
  out.sort((a, b) => Number(b.isHost) - Number(a.isHost)
    || (a.kind === 'human' ? 0 : 1) - (b.kind === 'human' ? 0 : 1)
    || String(a.id).localeCompare(String(b.id)));
  return out;
}

export function createNetClient() {
  const state = {
    client: null,
    room: null,
    connected: false,
    sessionId: null,
    phase: 'idle',
    lastError: null,
    onLeadersUpdate: null,
    onSlotsUpdate: null,
    onPhaseChange: null,
    onJoined: null,
    onLeft: null,
    _unsubs: [],
  };

  function notifySlots() {
    if (state.onSlotsUpdate && state.room) {
      state.onSlotsUpdate(slotsToArray(state.room.state.slots));
    }
  }

  function notifyLeaders() {
    if (state.onLeadersUpdate && state.room) {
      state.onLeadersUpdate(state.room.state.leaders);
    }
  }

  function clearUnsubs() {
    for (const u of state._unsubs) {
      try { u(); } catch (_) {}
    }
    state._unsubs = [];
  }

  function wireRoom(room) {
    clearUnsubs();
    // Colyseus 0.15 : onAdd/onRemove sont des MÉTHODES, pas des setters.
    // L'ancien `map.onAdd = fn` ne reçoit jamais les ajouts suivants.
    if (typeof room.state.slots?.onAdd === 'function') {
      state._unsubs.push(room.state.slots.onAdd(() => notifySlots()));
      state._unsubs.push(room.state.slots.onRemove(() => notifySlots()));
      if (typeof room.state.slots.onChange === 'function') {
        state._unsubs.push(room.state.slots.onChange(() => notifySlots()));
      }
    }
    if (typeof room.state.leaders?.onAdd === 'function') {
      state._unsubs.push(room.state.leaders.onAdd(() => notifyLeaders()));
      state._unsubs.push(room.state.leaders.onRemove(() => notifyLeaders()));
      if (typeof room.state.leaders.onChange === 'function') {
        state._unsubs.push(room.state.leaders.onChange(() => notifyLeaders()));
      }
    }
    if (typeof room.state.listen === 'function') {
      state._unsubs.push(room.state.listen('phase', (v) => {
        state.phase = v;
        if (state.onPhaseChange) state.onPhaseChange(v);
      }));
      state._unsubs.push(room.state.listen('hostSessionId', () => notifySlots()));
    }

    // Filet de sécurité : resync le salon pendant le lobby (évite un UI figé)
    const poll = setInterval(() => {
      if (!state.connected || !state.room) { clearInterval(poll); return; }
      if (state.phase === 'lobby') notifySlots();
      else clearInterval(poll);
    }, 500);
    state._unsubs.push(() => clearInterval(poll));

    room.onLeave(() => {
      state.connected = false;
      clearUnsubs();
      if (state.onLeft) state.onLeft();
    });
    room.onError((code, msg) => {
      console.warn('[net] room error', code, msg);
    });
  }

  async function connect(opts = {}) {
    if (state.connected) return state.room;
    const url = opts.url || defaultServerUrl();
    const joinOpts = {
      name: opts.name || 'Anonyme',
      leaderKey: opts.leaderKey || 'monk',
      code: String(opts.code || '').toUpperCase(),
    };
    let lastErr;
    for (let attempt = 1; attempt <= 3; attempt++) {
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
        if (!/seat reservation/i.test(raw) || attempt === 3) break;
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
    wireRoom(state.room);
    notifySlots();
    notifyLeaders();
    if (state.onJoined) state.onJoined(state.room);
    return state.room;
  }

  function send(type, payload = {}) {
    if (!state.connected || !state.room) return;
    state.room.send(type, payload);
  }

  function sendInput(x, z, boost = false) {
    send('input', { x, z, boost });
  }

  async function leave() {
    clearUnsubs();
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
    send,
    sendInput,
    addBot: (difficulty = 'normal') => send('addBot', { difficulty }),
    removeBot: (slotId) => send('removeBot', { slotId }),
    setBotDiff: (slotId, difficulty) => send('setBotDiff', { slotId, difficulty }),
    requestStart: () => send('startMatch'),
    getSlots: () => slotsToArray(state.room?.state?.slots),
    getLeaders() { return state.room?.state.leaders || null; },
    getMyLeader() { return state.room?.state.leaders.get(state.sessionId) || null; },
    isMe(sessionId) { return sessionId === state.sessionId; },
    isHost() { return state.room?.state?.hostSessionId === state.sessionId; },
    getCode() { return state.room?.state?.code || ''; },
    onLeadersUpdate: (fn) => { state.onLeadersUpdate = fn; },
    onSlotsUpdate: (fn) => { state.onSlotsUpdate = fn; },
    onPhaseChange: (fn) => { state.onPhaseChange = fn; },
    onJoined: (fn) => { state.onJoined = fn; },
    onLeft: (fn) => { state.onLeft = fn; },
  };
}
