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
      seatIndex: s.seatIndex | 0,
    });
  });
  // Ordre stable : hôte d'abord, puis humains, puis IA
  out.sort((a, b) => Number(b.isHost) - Number(a.isHost)
    || (a.kind === 'human' ? 0 : 1) - (b.kind === 'human' ? 0 : 1)
    || String(a.id).localeCompare(String(b.id)));
  return out;
}

/* Traduit les erreurs de matchmaking en message lisible dans le salon. */
function friendlyJoinError(e, mode) {
  const raw = String(e?.message || e || '');
  if (/seat reservation/i.test(raw)) {
    return 'Connexion multi interrompue (souvent 2 machines Fly). Lance: fly scale count 1 -a cultwar --yes';
  }
  if (mode === 'join' && (e?.code === 4212 || /no rooms|not found|matchmake/i.test(raw))) {
    // Un salon dont la partie est lancée est verrouillé : le matchmaker ne le
    // propose plus, on retombe donc ici aussi dans ce cas.
    return 'Aucun salon ouvert avec ce code (mauvais code, salon fermé, ou partie déjà lancée).';
  }
  return raw || 'Connexion impossible';
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

  /* mode 'create' : toujours un salon neuf (jamais de reprise d'un salon zombie).
     mode 'join'   : exige un salon existant portant ce code — sinon erreur
                     explicite. C'est ce qui garantit que deux joueurs avec le
                     même code finissent dans LA MÊME room. */
  async function connect(opts = {}) {
    const mode = opts.mode === 'create' ? 'create' : 'join';
    // Toute connexion résiduelle est larguée : sinon on hériterait de l'ancien
    // salon (et de ses IA) au lieu d'en ouvrir un propre.
    if (state.room || state.connected) await leave();

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
        state.room = mode === 'create'
          ? await state.client.create('quickplay', joinOpts)
          : await state.client.join('quickplay', joinOpts);
        lastErr = null;
        break;
      } catch (e) {
        lastErr = friendlyJoinError(e, mode);
        if (!/seat reservation/i.test(String(e?.message || e)) || attempt === 3) break;
        await sleep(400 * attempt);
      }
    }
    if (lastErr) {
      state.room = null;
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
    try { state.room.send(type, payload); } catch (_) {}
  }

  function sendInput(x, z, boost = false) {
    send('input', { x, z, boost });
  }

  async function leave() {
    clearUnsubs();
    const room = state.room;
    // On coupe les callbacks AVANT de quitter : un onLeft en vol ferait réagir
    // l'écran de salon alors qu'on est déjà passé à autre chose.
    state.connected = false;
    state.room = null;
    state.phase = 'idle';
    if (room) {
      try { await room.leave(); } catch (_) {}
    }
  }

  function leaderList() {
    const out = [];
    state.room?.state?.leaders?.forEach((l, sid) => {
      out.push({
        sessionId: l.sessionId || sid,
        name: l.playerName,
        cultColor: l.cultColor,
        cultSym: l.cultSym,
        isBot: !!l.isBot,
        seatIndex: l.seatIndex | 0,
        score: l.score | 0,
        pct: +l.pct || 0,
        grisAbs: l.grisAbs | 0,
      });
    });
    out.sort((a, b) => b.score - a.score || a.seatIndex - b.seatIndex);
    return out;
  }

  return {
    state,
    connect,
    create: (opts = {}) => connect({ ...opts, mode: 'create' }),
    join: (opts = {}) => connect({ ...opts, mode: 'join' }),
    leave,
    send,
    sendInput,
    sendStats: (sessionId, s) => send('stats', { sessionId, ...s }),
    addBot: (difficulty = 'normal') => send('addBot', { difficulty }),
    removeBot: (slotId) => send('removeBot', { slotId }),
    setBotDiff: (slotId, difficulty) => send('setBotDiff', { slotId, difficulty }),
    requestStart: () => send('startMatch'),
    getSlots: () => slotsToArray(state.room?.state?.slots),
    getLeaders() { return state.room?.state.leaders || null; },
    getLeaderList: leaderList,
    getMyLeader() { return state.room?.state.leaders.get(state.sessionId) || null; },
    isMe(sessionId) { return sessionId === state.sessionId; },
    isHost() { return state.room?.state?.hostSessionId === state.sessionId; },
    getCode() { return state.room?.state?.code || ''; },
    getSeed() { return (state.room?.state?.seed >>> 0) || 1; },
    getBiome() { return state.room?.state?.biome || ''; },
    getMatchDur() { return +state.room?.state?.matchDur || 0; },
    getElapsed() { return +state.room?.state?.elapsed || 0; },
    onLeadersUpdate: (fn) => { state.onLeadersUpdate = fn; },
    onSlotsUpdate: (fn) => { state.onSlotsUpdate = fn; },
    onPhaseChange: (fn) => { state.onPhaseChange = fn; },
    onJoined: (fn) => { state.onJoined = fn; },
    onLeft: (fn) => { state.onLeft = fn; },
  };
}
