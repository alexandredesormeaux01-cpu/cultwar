/* Fabriques d'état pur — aucune dépendance Three.js / DOM / audio.
   Retourne uniquement les champs de simulation (positions, vitesses,
   compteurs, timers). Les références visuelles (grp, mesh, ring, halos)
   sont attachées après coup par main.js pendant la phase de transition ;
   elles migreront dans une sidecar map en Phase 1c.

   Règle : si un champ est lu ou écrit par la boucle simulate(), il vit
   ici. Si un champ n'existe que pour le rendu (mesh, matériau), il n'y
   est PAS — main.js l'attache lui-même. */

/* -------------------------------- Agent --------------------------------
   Un agent = un villageois (gris, disciple, ou en cours de conversion).
   Le champ `discipleOf` porte l'appartenance : -1 = gris, sinon index de faction.
   Le champ `converting` porte l'index de faction en cours de rituel sur lui. */
export function createAgent(id, x, z, ang = 0, baseScale = 1) {
  return {
    id,
    x, z, y: 0,
    vx: 0, vz: 0,
    dead: false,
    _safeX: x, _safeZ: z,
    face: ang,
    base: baseScale,
    pop: 0,
    delay: 0,
    wt: 0, wx: x, wz: z,
    pf: -1, pt: 0,
    guardiansSpawned: false,
    cooldown: 0,
    extractProgress: 0,
    converting: -1,
    convertingDisc: null,
    stumbleT: 0,
    discipleOf: -1,
    followerOf: -1,
    discLvl: 1,
    discXp: 0,
    _stuckT: 0,
    _detourT: 0,
    _detourSide: 0,
    jmp: null,
  };
}

/* Remise à zéro d'un agent recyclé (free-list). Réutilise la même forme
   sans réallouer l'objet — préserve l'index dans les InstancedMesh. */
export function resetAgent(a, x, z, ang = 0) {
  a.x = x; a.z = z; a.y = 0;
  a.vx = 0; a.vz = 0;
  a.dead = false;
  a._safeX = x; a._safeZ = z;
  a.face = ang;
  a.pop = 0.001;
  a.delay = 0;
  a.wt = 0; a.wx = x; a.wz = z;
  a.pf = -1; a.pt = 0;
  a.guardiansSpawned = false;
  a.cooldown = 0;
  a.extractProgress = 0;
  a.converting = -1;
  a.convertingDisc = null;
  a.stumbleT = 0;
  a.discipleOf = -1;
  a.followerOf = -1;
  a._followerSlot = null;
  a._followerKey = null;
  a._origBase = undefined;
  a._stuckT = 0;
  a._detourT = 0;
  a._detourSide = 0;
  a.jmp = null;
  a.discLvl = 1;
  a.discXp = 0;
}

/* -------------------------------- Faction ------------------------------
   Une faction = un culte + son Leader jouable (joueur ou IA).
   Champs visuels attachés par main.js après coup : grp, color (THREE.Color).
   La couleur "logique" est portée en hex par `cult.c` ; la THREE.Color est
   juste une commodité de rendu. */
export function createFaction(i, teamIdx, cult, leaderKey, spawnX, spawnZ, opts = {}) {
  return {
    i,
    team: teamIdx,
    leaderKey,
    alive: true,
    cult,
    css: '#' + cult.c.toString(16).padStart(6, '0'),
    frontX: null, frontZ: null,
    everGrew: true,
    leader: {
      x: spawnX, z: spawnZ, y: 0, jmp: null,
      dx: 0, dz: 0,
      _safeX: spawnX, _safeZ: spawnZ,
    },
    isBot: opts.isBot ?? (i !== 0),
    /* Multi : `remote` = position dictée par le serveur (humain distant ou IA
       du salon). `netTarget` porte le dernier état reçu {x, z, dx, dz}. */
    remote: opts.remote ?? false,
    netTarget: null,
    sessionId: opts.sessionId ?? null,
    aggr: opts.aggr ?? 0.5,
    aiT: opts.aiT ?? 0,
    mode: 'farm',
    target: null,
    grayTarget: null,
    slowT: 0,
    boostT: 0,
    boostCd: 0,
    count: 0,
    deposited: 0,
    depositAcc: 0,
    siphonAcc: 0,
    crystals: 0,
    fuel: opts.fuel ?? 100,
    grisAbs: 0,
    discipleCd: 0,
    dist: 0,
    /* Pouvoir actif équipé (Phase 1 — Prêche pour le moine par défaut).
       Piloté par src/sim/powers.js. */
    power: opts.power ?? null,
    powerCd: 0,
  };
}

/* -------------------------------- Team ---------------------------------
   Une équipe = une base (position, porte, couleur). En pratique 1 team =
   1 faction (un Leader par culte). Séparées pour ouvrir un futur 2v2. */
export function createTeam(id, siteX, siteZ, wallR, wallT, gateAng, gateHalf, cult) {
  return {
    id,
    baseX: siteX,
    baseZ: siteZ,
    wallR,
    wallT,
    gateAng,
    gateHalf,
    css: '#' + cult.c.toString(16).padStart(6, '0'),
    name: cult.name,
    sym: cult.sym,
  };
}

/* -------------------------------- House --------------------------------
   Une habitation conquérable. `mesh`/`slot` sont attachés par le générateur
   de décor ; on ne les fabrique pas ici mais on documente les champs sim
   pour le futur split. */
export function initHouseSim(h) {
  h.remaining = h.capacity;
  h.siegeCult = -1;
  h.progress = 0;
  h.alive = true;
  return h;
}

/* -------------------------------- Shrine -------------------------------
   Sanctuaire capturable. Utilisé si buildShrines() est réactivé. */
export function createShrine(x, z) {
  return {
    x, z,
    owner: -1,
    cap: -1,
    progress: 0,
    incomeT: 0,
  };
}

/* -------------------------------- État global -------------------------- */
export function createSimState(seed = 1) {
  return {
    seed,
    tick: 0,
    elapsed: 0,
    agents: [],
    freeAgentIds: [],
    factions: [],
    teams: [],
    houses: [],
    shrines: [],
    grayCount: 0,
    streak: 0,
    streakT: 0,
    rallyCd: 0,
    rallyT: 0,
    fervor: 0,
    ecstasyT: 0,
    duelT: -1,
    slowmoT: 0,
    respawnT: 0,
    winT: 0,
  };
}
