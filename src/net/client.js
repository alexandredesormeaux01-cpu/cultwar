/* P2P multiplayer via PeerJS — remplace Colyseus.
   L'hôte crée un peer PeerJS avec ID = 'cultwar-{CODE}'.
   Les invités se connectent à ce peer ID via WebRTC DataChannel.
   Plus besoin de serveur dédié (Fly.io, Colyseus). */

import Peer from 'peerjs';
import { MATCH_DUR } from '../sim/constants.js';

const PEER_PREFIX = 'cultwar-';
const MAX_SLOTS = 5;
const DIFFS = ['easy', 'normal', 'hard'];
const CULTS = [
  { c: 0xff2e7e, sym: '❤' }, { c: 0x00c8ff, sym: '☾' },
  { c: 0xffb300, sym: '☀' }, { c: 0x22dd77, sym: '🌿' },
  { c: 0x8b5cf6, sym: '👁' }, { c: 0xff5533, sym: '🔥' },
];
const BOT_NAMES = ['IA Écarlate', 'IA Sélénie', 'IA Hélion', 'IA Sylvane', 'IA Occule', 'IA Pyrrhée'];
const BOT_LEADERS = ['monk', 'sorcerer', 'nomad', 'amazon', 'alien', 'chief'];
const BIOME_KEYS = ['temperate', 'desert', 'nordic', 'tropical', 'savanna', 'volcanic'];

/**
 * Ordre de succession au salon — fonction PURE, et c'est essentiel.
 *
 * Quand l'hôte disparaît, plus personne ne coordonne : chaque survivant doit
 * désigner LE MÊME successeur, seul, à partir des sièges qu'il connaît. Un
 * tirage au sort les ferait diverger et scinderait le salon en deux. Le calcul
 * ne dépend donc que des sièges, sans hasard ni horloge, et le départage final
 * par ID garantit un ordre total même à seatIndex égal.
 *
 * Exportée pour être testable sans WebRTC (scripts/succession-test.mjs).
 *
 * @param {Array} slots  sièges connus
 * @param {string} hostSid  l'hôte qu'on remplace, exclu du classement
 */
export function successionOrder(slots, hostSid) {
  return [...slots]
    .filter(s => s && s.kind === 'human' && !s.gone && s.id !== hostSid)
    .sort((a, b) =>
      (Number(b.inMatch === true) - Number(a.inMatch === true))
      || (a.seatIndex - b.seatIndex)
      || String(a.id).localeCompare(String(b.id)));
}

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
    /* Peer portant l'ID public du salon. Confondu avec `peer` chez l'hôte
       d'origine ; chez un hôte issu d'une bascule, c'est un SECOND peer, ouvert
       en plus du sien pour ne pas changer de sessionId (voir « Bascule
       d'hôte »). */
    hostPeer: null,
    hostConn: null,
    guestConns: new Map(),
    connected: false,
    /* Reprise en cours après perte de l'hôte. Le jeu s'en sert pour patienter
       au lieu de conclure à une partie perdue. */
    migrating: false,
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
    /* Choix de l'hôte dans le salon : une clé de BIOME_KEYS, ou '' pour
       « aléatoire ». Distinct de _biome, qui est le biome RÉSOLU de la partie :
       tant que la manche n'est pas lancée, « aléatoire » n'a pas encore de
       valeur, et l'hôte doit pouvoir revenir sur son choix. */
    _biomePick: '',
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
    onMatchLeft: null,
    onMigrating: null,
    onHostChanged: null,
    onKicked: null,
    kicked: false,
    /* Identité locale, rejouée telle quelle à la reconnexion : le nouvel hôte
       reconnaît le siège à l'ID PeerJS, mais ces champs évitent de repartir sur
       un « Joueur » anonyme si le siège avait été purgé. */
    _myName: 'Joueur',
    _myLeaderKey: 'monk',
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

  /* Le biome voyage avec les sièges plutôt que dans un message à lui : c'est le
     seul état de salon diffusé, et les invités redessinent déjà le lobby à
     chaque slotsUpdate. Un changement de biome par l'hôte se voit donc chez tout
     le monde sans nouveau canal. */
  function broadcastSlots() {
    broadcast({
      type: 'slotsUpdate',
      slots: [...state._slots.values()],
      biomePick: state._biomePick,
    });
  }

  /* ---- HOST : messages reçus d'un invité ---- */
  function onGuestData(conn, msg) {
    switch (msg.type) {
      case 'join': {
        const known = state._slots.get(conn.peer);
        /* Retour d'un siège qu'on connaît déjà : c'est une reconnexion après
           bascule d'hôte, pas une arrivée. L'identité d'un invité est son ID
           PeerJS, et lui n'a pas changé de peer — seul l'hôte en a changé. On
           rebranche donc le siège existant au lieu d'en ouvrir un second, ce
           qui préserve sa couleur, son siège et sa place dans la manche. */
        if (known) {
          known.gone = false;
          state.guestConns.set(conn.peer, conn);
          conn._sid = conn.peer;
          conn.send({
            type: 'joinAccept',
            sessionId: conn.peer,
            slots: [...state._slots.values()],
            hostSessionId: state._hostSessionId,
            phase: state.phase,
            code: state._code,
            seed: state._seed, biome: state._biome,
            matchDur: state._matchDur, elapsed: state._elapsed,
          });
          broadcastSlots();
          notifySlots();
          return;
        }
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
            conn.send({ type: 'joinReject', reason: 'Salon complet (5 joueurs).' });
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
        broadcastSlots();
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
      case 'leaveMatch': {
        const sid = conn._sid;
        if (!sid) return;
        dropFromMatch(sid, 'quit');
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
          // couleur seule : le symbole reste celui du joueur (custom possible)
          if (!slot.cultSym) slot.cultSym = cult.sym;
        }
      }
    }
    if (msg.cultSym && typeof msg.cultSym === 'string') {
      slot.cultSym = msg.cultSym.slice(0, 512);   // laisse la place aux data URIs
    }
    if (msg.name && typeof msg.name === 'string') {
      slot.name = msg.name.slice(0, 20);
    }
    broadcastSlots();
    notifySlots();
  }

  function onGuestDisconnect(conn) {
    const sid = conn._sid;
    if (!sid) return;
    state.guestConns.delete(sid);
    /* En pleine manche, une déconnexion ne retire PAS le siège : il reste dans
       la partie, repris par une IA. Le supprimer ferait disparaître un culte du
       plateau en cours de route, et son nom du podium final. Dans le salon, en
       revanche, le siège est bel et bien libéré. */
    const slot = state._slots.get(sid);
    /* `gone` marque un siège dont la machine n'est plus joignable. Il sert à
       l'élection du prochain hôte : sans lui, tout le monde pourrait désigner
       un successeur déjà déconnecté et le salon se figerait. */
    if (slot) slot.gone = true;
    if (state.phase === 'play') {
      dropFromMatch(sid, 'disconnect');
      return;
    }
    state._slots.delete(sid);
    state._leaders.delete(sid);
    broadcastSlots();
    notifySlots();
  }

  /**
   * Sort un siège de la manche en cours sans le sortir du salon : son culte
   * continue, piloté par l'IA de l'hôte — SAUF s'il ne reste plus aucun humain
   * en jeu : une manche d'IA seules n'a plus de raison d'être, on la coupe.
   *
   * Hôte uniquement — c'est lui qui simule les IA et diffuse leurs positions,
   * donc lui seul peut reprendre un culte abandonné. Les invités n'ont rien à
   * changer : ils lisaient déjà la position de ce siège dans les `tick` de
   * l'hôte, et continueront de le faire. Seule la source change, pas le canal.
   *
   * @param {string} sid  siège concerné
   * @param {'quit'|'disconnect'} reason  départ volontaire ou lien coupé
   */
  function dropFromMatch(sid, reason) {
    if (!state._isHost) return;
    const slot = state._slots.get(sid);
    if (!slot || slot.inMatch === false) return;
    slot.inMatch = false;
    slot.leftReason = reason;
    const aborted = state.phase === 'play' && humansInMatch() === 0;
    broadcast({ type: 'matchLeft', sid, reason, name: slot.name, aborted });
    broadcastSlots();
    notifySlots();
    if (state.onMatchLeft) {
      state.onMatchLeft({ sid, reason, name: slot.name, aborted });
    }
    if (aborted) abortMatchNoHumans();
  }

  /** Humains encore réellement en train de jouer la manche (pas partis, pas coupés). */
  function humansInMatch() {
    let n = 0;
    for (const s of state._slots.values()) {
      if (s.kind === 'human' && s.inMatch === true && !s.gone) n++;
    }
    return n;
  }

  /**
   * Plus aucun joueur humain dans la manche : on ramène tout le monde au salon.
   * Continuer avec uniquement des IA ferait tourner une partie fantôme.
   */
  function abortMatchNoHumans() {
    if (!state._isHost || state.phase !== 'play') return;
    if (state._matchTimer) { clearTimeout(state._matchTimer); state._matchTimer = null; }
    state._leaders = new Map();
    state._allLeaders = [];
    state._elapsed = 0;
    state._tick = 0;
    state._abortReason = 'no-humans';
    for (const s of state._slots.values()) { s.inMatch = false; s.leftReason = null; }
    const slots = [...state._slots.values()];
    broadcast({ type: 'phase', phase: 'lobby', slots, abortReason: 'no-humans' });
    setPhase('lobby');
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
        state._biomePick = msg.biomePick || '';
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
        state._abortReason = msg.abortReason || null;
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
      case 'matchLeft':
        if (state.onMatchLeft) state.onMatchLeft(msg);
        break;
      case 'kicked':
        /* Exclu par l'hôte. On coupe nous-mêmes, ce qui empêche la reprise
           d'hôte de s'enclencher : ce n'est pas une panne, c'est une décision. */
        state.kicked = true;
        leave();
        if (state.onKicked) state.onKicked();
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

  /* ------------------------------------------------------------------------
     Bascule d'hôte
     ------------------------------------------------------------------------
     L'hôte n'est pas qu'un joueur : il détient l'ID PeerJS public du salon
     (`cultwar-CODE`), relaie tous les messages, simule les IA et tient le
     chronomètre. Sa disparition brutale — onglet fermé, réseau coupé — mettait
     fin à la partie de tout le monde. On la remplace ici par une reprise.

     Trois idées portent le mécanisme :

     1. ÉLECTION DÉTERMINISTE, pas aléatoire. Personne ne coordonne plus rien à
        cet instant : chaque survivant doit désigner LE MÊME successeur, seul,
        et le seul moyen est de calculer au lieu de tirer au sort. Tous partent
        du même état de sièges (diffusé par l'ancien hôte), donc du plus petit
        seatIndex parmi les vivants ils tirent tous le même nom.

     2. LE SUCCESSEUR GARDE SON PEER et en ouvre un SECOND pour l'ID du salon.
        Son sessionId est la clé de sa faction chez tous les autres ; en changer
        déferait le lien entre son personnage à l'écran et lui. Il devient donc
        hôte sans changer d'identité.

     3. LES ÉCHECS SE RATTRAPENT. L'ID du salon met un moment à être libéré côté
        serveur de signalisation, d'où les tentatives échelonnées. Et si deux
        survivants se croyaient élus, celui qui perd la course à l'ID bascule
        simplement en invité du gagnant.
  --------------------------------------------------------------------------- */
  const MIGRATE_TRIES = 10;
  const MIGRATE_DELAY = 1400;

  /** Le lien avec l'hôte vient de tomber : on tente la reprise. */
  function handleHostLoss() {
    if (state._isHost || state.migrating || state.phase === 'idle') return;
    state.migrating = true;
    state.connected = false;
    state.hostConn = null;

    const order = successionOrder([...state._slots.values()], state._hostSessionId);
    if (!order.length) {
      // Plus personne : rien à reprendre, on rend la main à l'interface.
      state.migrating = false;
      if (state.onLeft) state.onLeft();
      return;
    }
    if (state.onMigrating) state.onMigrating({ successor: order[0].id, isMe: order[0].id === state.sessionId });
    if (order[0].id === state.sessionId) becomeHost();
    else reconnectToHost(MIGRATE_TRIES);
  }

  /** Réclame l'ID public du salon, laissé libre par l'ancien hôte. */
  function claimRoomPeer(tries) {
    return new Promise((resolve, reject) => {
      const attempt = (n) => {
        const p = new Peer(PEER_PREFIX + state._code);
        let settled = false;
        p.on('open', () => {
          if (settled) return;
          settled = true;
          p.on('connection', handleGuestConn);
          resolve(p);
        });
        p.on('error', (err) => {
          if (settled) return;
          settled = true;
          try { p.destroy(); } catch (_) {}
          if (n <= 1) reject(err);
          else setTimeout(() => attempt(n - 1), MIGRATE_DELAY);
        });
      };
      attempt(tries);
    });
  }

  async function becomeHost() {
    const oldHostSid = state._hostSessionId;
    let room;
    try {
      room = await claimRoomPeer(MIGRATE_TRIES);
    } catch (_) {
      /* Course perdue : un autre survivant tient déjà l'ID. On le rejoint —
         c'est exactement ce qu'il attend de nous. */
      state.migrating = true;
      reconnectToHost(MIGRATE_TRIES);
      return;
    }

    state.hostPeer = room;
    state._isHost = true;
    state._hostSessionId = state.sessionId;
    state.guestConns = new Map();
    state.connected = true;
    state.migrating = false;

    const dead = state._slots.get(oldHostSid);
    if (dead) { dead.isHost = false; dead.gone = true; dead.inMatch = false; dead.leftReason = 'disconnect'; }
    const mine = state._slots.get(state.sessionId);
    if (mine) mine.isHost = true;

    /* Plus aucun humain en manche (l'ancien hôte était le dernier) : on coupe
       plutôt que de faire tourner une partie d'IA orphelines. */
    if (state.phase === 'play' && humansInMatch() === 0) {
      abortMatchNoHumans();
      notifySlots();
      if (state.onHostChanged) state.onHostChanged({ hostSid: state.sessionId, isMe: true, deadSid: oldHostSid });
      return;
    }

    /* Reprise du chronomètre là où l'ancien hôte l'a laissé. `_elapsed` vient
       de ses derniers `tick`, donc au pire on repart quelques dixièmes trop
       tard — préférable à une manche qui ne finirait jamais. */
    if (state.phase === 'play') {
      const left = Math.max(5, (state._matchDur || MATCH_DUR) - (state._elapsed || 0));
      if (state._matchTimer) clearTimeout(state._matchTimer);
      state._matchTimer = setTimeout(() => endMatch(), left * 1000);
    }

    notifySlots();
    if (state.onHostChanged) state.onHostChanged({ hostSid: state.sessionId, isMe: true, deadSid: oldHostSid });
  }

  /** Survivant non élu : on se rebranche sur le nouvel hôte dès qu'il répond. */
  function reconnectToHost(tries) {
    const attempt = (n) => {
      if (state._isHost || !state.peer) return;
      let settled = false;
      const retry = () => {
        if (settled) return;
        settled = true;
        if (n <= 1) {
          state.migrating = false;
          if (state.onLeft) state.onLeft();
        } else {
          setTimeout(() => attempt(n - 1), MIGRATE_DELAY);
        }
      };
      let conn;
      try { conn = state.peer.connect(PEER_PREFIX + state._code, { reliable: true }); }
      catch (_) { retry(); return; }

      conn.on('open', () => {
        conn.send({ type: 'join', name: state._myName, leaderKey: state._myLeaderKey });
      });
      conn.on('data', (msg) => {
        if (msg.type === 'joinAccept') {
          if (settled) return;
          settled = true;
          state.hostConn = conn;
          state._hostSessionId = msg.hostSessionId;
          state._slots = new Map(msg.slots.map(s => [s.id, s]));
          if (msg.seed) state._seed = msg.seed;
          if (msg.biome) state._biome = msg.biome;
          if (msg.matchDur) state._matchDur = msg.matchDur;
          if (typeof msg.elapsed === 'number') state._elapsed = msg.elapsed;
          state.connected = true;
          state.migrating = false;
          notifySlots();
          if (state.onHostChanged) state.onHostChanged({ hostSid: msg.hostSessionId, isMe: false });
        } else if (settled) {
          onHostData(msg);
        }
      });
      conn.on('error', retry);
      conn.on('close', () => {
        if (settled) { handleHostLoss(); return; }
        retry();
      });
      // Pas de joinAccept dans les temps : le nouvel hôte n'est pas encore prêt.
      setTimeout(retry, MIGRATE_DELAY * 2);
    };
    attempt(tries);
  }

  /* ---- Connect ---- */
  async function connect(opts = {}) {
    const mode = opts.mode === 'create' ? 'create' : 'join';
    if (state.peer || state.connected) await leave();

    const code = String(opts.code || '').toUpperCase();
    state._code = code;
    state._myName = String(opts.name || 'Joueur').slice(0, 20);
    state._myLeaderKey = String(opts.leaderKey || 'monk');
    state.migrating = false;
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
        state.hostPeer = peer;   // hôte d'origine : son peer EST celui du salon

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
            if (!resolved) { fail({ message: 'Connexion fermée par l\'hôte' }); return; }
            /* Le salon existe encore dans les autres navigateurs : au lieu de
               rendre la main, on tente la reprise (voir « Bascule d'hôte »).
               handleHostLoss appelle onLeft lui-même s'il n'y a plus personne
               à qui se raccrocher. */
            handleHostLoss();
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
    state.migrating = false;
    state.phase = 'idle';
    state._isHost = false;
    const peer = state.peer;
    /* Deux peers à fermer après une bascule : le sien et celui du salon. Ne
       fermer que `peer` laisserait l'ID public occupé par un onglet parti,
       et le code du salon deviendrait injoignable pour de bon. */
    const roomPeer = (state.hostPeer && state.hostPeer !== peer) ? state.hostPeer : null;
    state.peer = null;
    state.hostPeer = null;
    if (roomPeer) try { roomPeer.destroy(); } catch (_) {}
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
    broadcastSlots();
    notifySlots();
    return id;   // l'appelant y pose le curseur du pad
  }

  function removeBot(slotId) {
    if (!state._isHost || state.phase !== 'lobby') return;
    const slot = state._slots.get(slotId);
    if (!slot || slot.kind !== 'bot') return;
    state._slots.delete(slotId);
    broadcastSlots();
    notifySlots();
  }

  function setBotDiff(slotId, difficulty) {
    if (!state._isHost || state.phase !== 'lobby') return;
    const slot = state._slots.get(slotId);
    if (!slot || slot.kind !== 'bot') return;
    if (DIFFS.includes(difficulty)) slot.difficulty = difficulty;
    broadcastSlots();
    notifySlots();
  }

  /**
   * Expulse un joueur humain du salon. Hôte uniquement, et pas en pleine
   * manche — éjecter quelqu'un d'une partie en cours laisserait son culte sans
   * pilote chez tous les autres.
   *
   * On prévient AVANT de couper : sans ce message, l'exclu verrait une
   * déconnexion et son client tenterait une reprise d'hôte (voir « Bascule
   * d'hôte »), se reconnectant en boucle à un salon qui n'en veut plus.
   */
  function kickPlayer(sid) {
    if (!state._isHost || state.phase !== 'lobby') return;
    if (sid === state.sessionId) return;            // pas soi-même
    const slot = state._slots.get(sid);
    if (!slot || slot.kind !== 'human') return;
    const conn = state.guestConns.get(sid);
    if (conn) {
      try { conn.send({ type: 'kicked' }); } catch (_) {}
      /* Laisser le message partir avant de fermer : un close immédiat le
         perdrait, et on retomberait sur le cas qu'on veut éviter. */
      setTimeout(() => { try { conn.close(); } catch (_) {} }, 120);
    }
    state.guestConns.delete(sid);
    state._slots.delete(sid);
    state._leaders.delete(sid);
    broadcastSlots();
    notifySlots();
  }

  /* Personnage d'une IA. Même garde que la difficulté : l'hôte seul décide, et
     seulement dans le salon — changer de corps en pleine manche laisserait les
     autres clients avec un modèle qui ne correspond plus à ce qu'ils affichent. */
  function setBotLeader(slotId, leaderKey) {
    if (!state._isHost || state.phase !== 'lobby') return;
    const slot = state._slots.get(slotId);
    if (!slot || slot.kind !== 'bot') return;
    if (!leaderKey || typeof leaderKey !== 'string') return;
    slot.leaderKey = leaderKey.slice(0, 16);
    broadcastSlots();
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
    sorted.forEach((s, i) => { s.seatIndex = i; s.inMatch = true; s.leftReason = null; });

    state._seed = (Math.floor(Math.random() * 0xffffffff) >>> 0) || 1;
    // Choix de l'hôte, ou tirage au sort s'il a laissé « Aléatoire ».
    state._biome = BIOME_KEYS.includes(state._biomePick)
      ? state._biomePick
      : BIOME_KEYS[Math.floor(Math.random() * BIOME_KEYS.length)];
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
    /* Nouvelle manche, ardoise nette : celui qui avait abandonné la précédente
       reprend son culte en main s'il est resté dans le salon. */
    for (const s of state._slots.values()) { s.inMatch = false; s.leftReason = null; }
    const slots = [...state._slots.values()];
    broadcast({ type: 'phase', phase: 'lobby', slots });
    setPhase('lobby');
  }

  /**
   * Quitter la manche en cours en RESTANT dans le salon.
   *
   * Le peer n'est jamais détruit ici, et c'est tout l'intérêt : si l'hôte s'en
   * va, il continue de relayer la partie des autres depuis le salon. Sans ça,
   * son départ couperait le lien de tout le monde et mettrait fin au match
   * chez chacun — il faudrait alors élire un nouvel hôte et reconnecter tout le
   * monde à lui, pour un résultat bien plus fragile.
   */
  function leaveMatch() {
    if (!state.connected) return;
    if (state._isHost) dropFromMatch(state.sessionId, 'quit');
    else sendToHost({ type: 'leaveMatch' });
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
    setBotLeader,
    kickPlayer,
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
    getBiomeKeys: () => BIOME_KEYS.slice(),
    /** Biome retenu pour la prochaine manche, '' = aléatoire. */
    getBiomePick: () => state._biomePick || '',
    /** Hôte seulement, et seulement dans le salon : '' remet sur aléatoire. */
    setBiomePick(key) {
      if (!state._isHost || state.phase !== 'lobby') return;
      state._biomePick = BIOME_KEYS.includes(key) ? key : '';
      broadcastSlots();
      notifySlots();
    },
    getMatchDur() { return state._matchDur || MATCH_DUR; },
    getElapsed() { return state._elapsed || 0; },
    onLeadersUpdate: (fn) => { state.onLeadersUpdate = fn; },
    onSlotsUpdate: (fn) => { state.onSlotsUpdate = fn; },
    onPhaseChange: (fn) => { state.onPhaseChange = fn; },
    onJoined: (fn) => { state.onJoined = fn; },
    onLeft: (fn) => { state.onLeft = fn; },
    onMatchLeft: (fn) => { state.onMatchLeft = fn; },
    onMigrating: (fn) => { state.onMigrating = fn; },
    onHostChanged: (fn) => { state.onHostChanged = fn; },
    onKicked: (fn) => { state.onKicked = fn; },
    leaveMatch,
    /** Sièges encore en train de jouer la manche (statut « En jeu » du salon). */
    isInMatch: (sid) => state._slots.get(sid)?.inMatch === true,
  };
}
