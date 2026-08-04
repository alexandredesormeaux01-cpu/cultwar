/* ============================================================================
   Cult.io — Arbre de compétences (campagne)
   Budget mondial : 177 pays × 3 pts = 531
     · Majorité d'un pays : +1
     · Pays à 100 %       : +2
   Coût d'un niveau : 1 (niv. 1–5), 2 (6–10), 3 (11+)
   Capacité totale de l'arbre > 531 → choix de build.
   ========================================================================== */

const SAVE_KEY = 'cultio_progress_v3';

/** Points par pays : majorité + conquête = 3 */
export const PTS_MAJORITY = 1;
export const PTS_CONQUERED = 2;
export const WORLD_SKILL_BUDGET = 531; // 177 × 3

/**
 * Coût pour passer du niveau `from` au niveau `from + 1`.
 * from = niveau actuel (0 → premier achat).
 */
export function upgradeCost(from) {
  if (from < 5) return 1;
  if (from < 10) return 2;
  return 3;
}

/** Coût total pour atteindre `level` depuis 0. */
export function costToReach(level) {
  let t = 0;
  for (let i = 0; i < level; i++) t += upgradeCost(i);
  return t;
}

/**
 * Définition compacte.
 * perLevel : clés de mods (additionnés × niveau) — voir getSkillMods.
 */
function sk(id, branch, name, icon, max, desc, requires, perLevel) {
  return { id, branch, name, icon, max, desc, requires: requires || null, perLevel: perLevel || {} };
}

export const SKILL_BRANCHES = [
  { id: 'attraction', name: 'Attraction', tint: '#ffb300' },
  { id: 'conversion', name: 'Conversion', tint: '#ff2e7e' },
  { id: 'guerre',     name: 'Guerre',     tint: '#ff5533' },
  { id: 'resistance', name: 'Résistance', tint: '#00c8ff' },
  { id: 'chevaliers', name: 'Chevaliers', tint: '#8b5cf6' },
  { id: 'essaim',     name: 'Essaim',     tint: '#22dd77' },
  { id: 'mobilite',   name: 'Mobilité',   tint: '#00ffcc' },
  { id: 'rites',      name: 'Rites',      tint: '#ff7700' },
  { id: 'dominion',   name: 'Dominion',   tint: '#3f51b5' },
];

export const SKILL_DEFS = [
  /* ---- Attraction (sceptiques) ---- */
  sk('aura',       'attraction', 'Aura sacrée',      '◎', 10, 'Rayon d\'attraction des gris +3,5 % / niv.', null,           { influence: 0.035 }),
  sk('voix',       'attraction', 'Voix du prophète', '📣', 10, 'Attraction des gris +2,5 % / niv.',         { aura: 2 },     { influence: 0.025 }),
  sk('halo',       'attraction', 'Halo fervent',     '✦', 10, 'Attraction des gris +2 % / niv.',            { voix: 2 },     { influence: 0.02 }),
  sk('appel',      'attraction', 'Appel des âmes',   '🕯', 10, 'Contact fidèle→gris plus large +2 % / niv.', { halo: 2 },     { grayContact: 0.02 }),
  sk('moisson',    'attraction', 'Moisson d\'âmes',  '🌾', 10, 'Vitesse de conversion des gris +4 % / niv.', { appel: 2 },    { grayConv: 0.04 }),

  /* ---- Conversion (cultes) ---- */
  sk('zeal',       'conversion', 'Zèle convertisseur', '⚡', 10, 'Conversion des rivaux +3 % / niv.',         null,           { conv: 0.03 }),
  sk('sermon',     'conversion', 'Sermon de guerre',   '📜', 10, 'Conversion des rivaux +2,5 % / niv.',       { zeal: 2 },     { conv: 0.025 }),
  sk('fanatisme',  'conversion', 'Fanatisme',          '🔥', 10, 'Conversion des rivaux +2 % / niv.',         { sermon: 2 },   { conv: 0.02 }),
  sk('heresie',    'conversion', 'Briseur d\'hérésie', '💥', 10, 'Bonus vs foules plus petites +3 % / niv.',  { fanatisme: 2 },{ overwhelm: 0.03 }),
  sk('dogme',      'conversion', 'Dogme absolu',       '📿', 10, 'Conversion des rivaux +1,5 % / niv.',       { heresie: 2 },  { conv: 0.015 }),

  /* ---- Guerre (cadence et puissance de tir) ---- */
  sk('magnet',     'guerre', 'Charisme martial',  '✡', 10, 'Cadence de tir +2,5 % / niv.',                null,            { atkCd: -0.025 }),
  sk('pression',   'guerre', 'Pression divine',   '🌀', 10, 'Cadence de tir +2 % / niv.',                  { magnet: 2 },    { atkCd: -0.02 }),
  sk('front',      'guerre', 'Front sacré',       '⚔', 10, 'Portée des attaques +2,5 % / niv.',           { pression: 2 },  { influence: 0.025 }),
  sk('siege',      'guerre', 'Siège de foi',      '🏰', 10, 'Cadence de tir +1,5 % / niv.',                { front: 2 },     { atkCd: -0.015 }),
  sk('assassin',   'guerre', 'Lame du prophète',  '🗡', 8,  '+1 cristal brisé par tir / 4 niv.',           { siege: 3 },     { atkDmg: 0.25 }),

  /* ---- Résistance (encaisser les tirs) ---- */
  sk('faith',      'resistance', 'Foi inébranlable',   '🛡', 10, 'Chance d\'ignorer un tir +3 % / niv.',   null,            { resist: 0.03 }),
  sk('martyr',     'resistance', 'Martyre fervent',    '✝', 10, 'Chance d\'ignorer un tir +2,5 % / niv.', { faith: 2 },     { resist: 0.025 }),
  sk('rempart',    'resistance', 'Rempart vivant',     '🧱', 10, 'Chance d\'ignorer un tir +2 % / niv.',   { martyr: 2 },    { resist: 0.02 }),
  sk('stoique',    'resistance', 'Stoïcisme sacré',    '🗿', 10, 'Cristaux de départ +1 / 2 niv.',         { rempart: 2 },   { flock: 0.5 }),
  sk('immortel',   'resistance', 'Flamme éternelle',   '🕯', 8,  'Chance d\'ignorer un tir +2 % / niv.',   { stoique: 3 },   { resist: 0.02 }),

  /* ---- Chevaliers ---- */
  sk('knight',     'chevaliers', 'Ordre sacré',       '⚔', 10, 'Puissance des chevaliers +4 % / niv.',      null,            { knight: 0.04 }),
  sk('paladin',    'chevaliers', 'Paladins',          '🛡', 10, 'Puissance des chevaliers +3 % / niv.',      { knight: 2 },    { knight: 0.03 }),
  sk('bastion',    'chevaliers', 'Bastion',           '🏛', 10, 'Portée d\'aura chevalier +3 % / niv.',      { paladin: 2 },   { knightRange: 0.03 }),
  sk('phalange',   'chevaliers', 'Phalange sainte',   '🔷', 8,  'Chevaliers empilables +1 / 4 niv.',         { bastion: 2 },   { knightMax: 0.25 }),
  sk('croises',    'chevaliers', 'Croisés',           '🚩', 8,  'Puissance des chevaliers +5 % / niv.',      { phalange: 2 },  { knight: 0.05 }),

  /* ---- Essaim ---- */
  sk('flock',      'essaim', 'Premier cercle',   '👥', 10, 'Fidèles de départ +1 / niv.',                 null,           { flock: 1 }),
  sk('noyau',      'essaim', 'Noyau dévot',      '⬤', 10, 'Fidèles de départ +1 / niv.',                 { flock: 2 },    { flock: 1 }),
  sk('cohesion',   'essaim', 'Cohésion',         '🔗', 10, 'Formation plus serrée +3 % / niv.',           { noyau: 2 },    { formation: 0.03 }),
  sk('maree',      'essaim', 'Marée humaine',    '🌊', 10, 'Rayon de foule +2 % / niv.',                 { cohesion: 2 }, { crowd: 0.02 }),
  sk('legion',     'essaim', 'Légion fervente',  '🏟', 8,  'Fidèles de départ +2 / niv.',                { maree: 3 },    { flock: 2 }),

  /* ---- Mobilité ---- */
  sk('pas',        'mobilite', 'Pas légers',       '👟', 10, 'Vitesse max +1,5 % / niv.',                 null,          { speedMax: 0.015 }),
  sk('course',     'mobilite', 'Course fervente',  '💨', 10, 'Vitesse max +1,2 % / niv.',                 { pas: 2 },     { speedMax: 0.012 }),
  sk('masse',      'mobilite', 'Masse agile',      '⚖', 10, 'Moins de ralentissement si gros +2 %/niv.', { course: 2 },  { speedMin: 0.02 }),
  sk('reflexe',    'mobilite', 'Réflexes sacrés',  '👁', 8,  'Réactivité du Leader +3 % / niv.',          { masse: 2 },   { leaderResp: 0.03 }),
  sk('vent',       'mobilite', 'Vent prophétique', '🌪', 8,  'Vitesse pendant Sacrifice +3 % / niv.',     { reflexe: 2 }, { boostSpeed: 0.03 }),

  /* ---- Rites (récolte et Ralliement) ---- */
  sk('offrande',   'rites', 'Offrande vive',     '🔥', 10, 'Récolte des sceptiques +3 % / niv.',         null,             { grayConv: 0.03 }),
  sk('extase',     'rites', 'Extase',            '✨', 10, 'Rayon de récolte +2,5 % / niv.',             { offrande: 2 },   { influence: 0.025 }),
  sk('ralliement', 'rites', 'Cri de ralliement', '📢', 10, 'Durée du Ralliement +5 % / niv.',            null,             { rallyDur: 0.05 }),
  sk('discipline', 'rites', 'Discipline',        '⏱', 10, 'Recharge du Ralliement −3 % / niv.',         { ralliement: 2 }, { rallyCd: -0.03 }),
  sk('liturgie',   'rites', 'Liturgie de sang',  '🩸', 8,  'Cadence de tir +2 % / niv.',                 { extase: 2 },     { atkCd: -0.02 }),

  /* ---- Dominion ---- */
  sk('ferveur',    'dominion', 'Ferveur',          '💫', 10, 'Fenêtre de série +4 % / niv.',              null,            { streakWin: 0.04 }),
  sk('triomphe',   'dominion', 'Triomphe',         '🏆', 10, 'Seuil de victoire −0,4 % / niv.',           { ferveur: 2 },   { winShare: -0.004 }),
  sk('presence',   'dominion', 'Présence mondiale','🌍', 10, 'Attraction (tous effets) +1 % / niv.',      { triomphe: 2 },  { influence: 0.01, conv: 0.01 }),
  sk('apotheose',  'dominion', 'Apothéose',        '☀', 8,  'Conversion + résistance +1,5 % / niv.',     { presence: 3 },  { conv: 0.015, resist: 0.015 }),
  sk('empire',     'dominion', 'Empire de foi',    '👑', 8,  'Départ +1 fidèle & conversion +1 % / niv.', { apotheose: 3 }, { flock: 1, conv: 0.01 }),
];

/* Capacité théorique si tout est maxé (≈ 675) — volontairement > 531. */
export function treeCapacity() {
  return SKILL_DEFS.reduce((n, d) => n + costToReach(d.max), 0);
}

function loadSave() {
  try { return JSON.parse(localStorage.getItem(SAVE_KEY)) || {}; } catch { return {}; }
}
function persist(save) { localStorage.setItem(SAVE_KEY, JSON.stringify(save)); }

function ensureSkills(save) {
  if (typeof save.skillPoints !== 'number') save.skillPoints = 0;
  if (!save.skills || typeof save.skills !== 'object') save.skills = {};
  if (!save.skillMajority || typeof save.skillMajority !== 'object') save.skillMajority = {};
  if (!save.skillFull || typeof save.skillFull !== 'object') save.skillFull = {};
  return save;
}

export function getSkillLevel(save, id) {
  const s = ensureSkills(save || loadSave());
  return Math.max(0, s.skills[id] | 0);
}

export function getSkillPoints(save) {
  return ensureSkills(save || loadSave()).skillPoints | 0;
}

export function isSkillUnlocked(save, def) {
  if (!def.requires) return true;
  for (const [id, min] of Object.entries(def.requires)) {
    if (getSkillLevel(save, id) < min) return false;
  }
  return true;
}

export function nextUpgradeCost(save, id) {
  const def = SKILL_DEFS.find((d) => d.id === id);
  if (!def) return Infinity;
  const lv = getSkillLevel(save, id);
  if (lv >= def.max) return Infinity;
  return upgradeCost(lv);
}

export function canUpgradeSkill(save, id) {
  const s = ensureSkills(save || loadSave());
  const def = SKILL_DEFS.find((d) => d.id === id);
  if (!def) return false;
  const cost = nextUpgradeCost(s, id);
  if (!Number.isFinite(cost)) return false;
  if ((s.skillPoints | 0) < cost) return false;
  return isSkillUnlocked(s, def);
}

export function upgradeSkill(id) {
  const s = ensureSkills(loadSave());
  if (!canUpgradeSkill(s, id)) return false;
  const cost = nextUpgradeCost(s, id);
  s.skills[id] = (s.skills[id] | 0) + 1;
  s.skillPoints -= cost;
  persist(s);
  return true;
}

/**
 * Après conquête d'une zone : +1 majorité, +2 à 100 %.
 * @returns {{ majority: boolean, full: boolean, gained: number, points: number }}
 */
export function awardConquestSkills({ iso, wasMajority, isMajority, isFull }) {
  const s = ensureSkills(loadSave());
  let gained = 0;
  let majority = false;
  let full = false;

  if (isMajority && !wasMajority && !s.skillMajority[iso]) {
    s.skillMajority[iso] = true;
    s.skillPoints = (s.skillPoints | 0) + PTS_MAJORITY;
    gained += PTS_MAJORITY;
    majority = true;
  }
  if (isFull && !s.skillMajority[iso]) {
    s.skillMajority[iso] = true;
    s.skillPoints = (s.skillPoints | 0) + PTS_MAJORITY;
    gained += PTS_MAJORITY;
    majority = true;
  }
  if (isFull && !s.skillFull[iso]) {
    s.skillFull[iso] = true;
    s.skillPoints = (s.skillPoints | 0) + PTS_CONQUERED;
    gained += PTS_CONQUERED;
    full = true;
  }

  if (gained > 0) persist(s);
  return { majority, full, gained, points: s.skillPoints | 0 };
}

function sumPerLevelSkills(skills, key) {
  let n = 0;
  for (const def of SKILL_DEFS) {
    const v = def.perLevel[key];
    if (!v) continue;
    n += skillLevelIn(skills, def.id) * v;
  }
  return n;
}

/** Multiplicateurs / bonus appliqués en match, calculés depuis une carte de skills. */
export function getSkillModsForSkills(skills) {
  const g = (k) => sumPerLevelSkills(skills || {}, k);

  const influenceAdd = g('influence');
  const convAdd = g('conv');
  const contactAdd = g('contact') + g('grayContact');
  const resistAdd = g('resist');
  const knightAdd = g('knight');
  const knightRangeAdd = g('knightRange');
  const knightMaxAdd = g('knightMax');
  const flockAdd = g('flock');
  const formationAdd = g('formation');
  const crowdAdd = g('crowd');
  const speedMaxAdd = g('speedMax');
  const speedMinAdd = g('speedMin');
  const leaderRespAdd = g('leaderResp');
  const boostSpeedAdd = g('boostSpeed');
  const boostDurAdd = g('boostDur');
  const boostPowAdd = g('boostPow');
  const rallyDurAdd = g('rallyDur');
  const rallyCdAdd = g('rallyCd');
  const sacCostAdd = g('sacCost');
  const streakWinAdd = g('streakWin');
  const winShareAdd = g('winShare');
  const grayConvAdd = g('grayConv');
  const overwhelmAdd = g('overwhelm');
  const pushAdd = g('push');
  /* Combat par cristaux : cadence de tir et dégâts encaissés.
     `resist` sert désormais de probabilité d'ignorer un tir (voir damageFaction),
     et non plus de diviseur de vitesse de conversion. */
  const atkCdAdd = g('atkCd');
  const atkDmgAdd = g('atkDmg');

  return {
    influenceMult: 1 + influenceAdd,
    convMult: 1 + convAdd,
    contactMult: 1 + contactAdd,
    resistMult: 1 / (1 + Math.max(0, resistAdd)),
    knightMult: 1 + knightAdd,
    knightRangeMult: 1 + knightRangeAdd,
    knightMaxBonus: Math.floor(knightMaxAdd),
    extraFlock: Math.round(flockAdd),
    formationMult: 1 + formationAdd,
    crowdMult: 1 + crowdAdd,
    speedMaxMult: 1 + speedMaxAdd,
    speedMinMult: 1 + speedMinAdd,
    leaderRespMult: 1 + leaderRespAdd,
    boostSpeedMult: 1 + boostSpeedAdd,
    boostDurMult: 1 + boostDurAdd,
    boostPowMult: 1 + boostPowAdd,
    rallyDurMult: 1 + rallyDurAdd,
    rallyCdMult: Math.max(0.45, 1 + rallyCdAdd),
    sacCostMult: Math.max(0.35, 1 + sacCostAdd),
    streakWinMult: 1 + streakWinAdd,
    winShareAdd, // négatif = seuil de victoire plus bas
    grayConvMult: 1 + grayConvAdd,
    overwhelmMult: 1 + overwhelmAdd,
    pushMult: 1 + pushAdd,
    // plancher à 0,45 : au-delà la cadence deviendrait une mitraille illisible
    atkCdMult: Math.max(0.45, 1 + atkCdAdd),
    atkDmgBonus: Math.floor(atkDmgAdd),
  };
}

/** Multiplicateurs / bonus appliqués en match (faction joueur). */
export function getSkillMods(save) {
  const s = ensureSkills(save || loadSave());
  return getSkillModsForSkills(s.skills);
}

/* ============================================================================
   Système de niveaux (joueur + IA)
   XP gagnée en conquérant des zones ; chaque niveau donne des points à dépenser.
   ========================================================================== */
export const POINTS_PER_LEVEL = 3;

/** XP nécessaire pour passer de `level` à `level + 1`. */
export function xpToNext(level) {
  return 4 + Math.max(0, level) * 3;
}

/** Garantit les champs de niveau sur un état {level, xp, skillPoints, skills}. */
export function ensureLevelState(state) {
  if (!state || typeof state !== 'object') state = {};
  if (typeof state.level !== 'number') state.level = 0;
  if (typeof state.xp !== 'number') state.xp = 0;
  if (typeof state.skillPoints !== 'number') state.skillPoints = 0;
  if (!state.skills || typeof state.skills !== 'object') state.skills = {};
  return state;
}

/** Ajoute de l'XP, gère les montées de niveau, renvoie les points gagnés. */
export function addXp(state, amount) {
  ensureLevelState(state);
  state.xp += Math.max(0, amount | 0);
  let pointsGained = 0;
  let guard = 500;
  while (state.xp >= xpToNext(state.level) && guard-- > 0) {
    state.xp -= xpToNext(state.level);
    state.level += 1;
    state.skillPoints += POINTS_PER_LEVEL;
    pointsGained += POINTS_PER_LEVEL;
  }
  return pointsGained;
}

/* ---- Helpers génériques opérant sur une carte de skills (pour l'IA) ---- */
export function skillLevelIn(skills, id) { return Math.max(0, (skills && skills[id]) | 0); }
export function isUnlockedInSkills(skills, def) {
  if (!def.requires) return true;
  for (const [id, min] of Object.entries(def.requires)) {
    if (skillLevelIn(skills, id) < min) return false;
  }
  return true;
}
export function nextCostInSkills(skills, id) {
  const def = SKILL_DEFS.find((d) => d.id === id);
  if (!def) return Infinity;
  const lv = skillLevelIn(skills, id);
  if (lv >= def.max) return Infinity;
  return upgradeCost(lv);
}

/**
 * Préférences de branche des IA selon la difficulté.
 * Facile : branches utilitaires/défensives (moins menaçantes).
 * Difficile : branches offensives et d'expansion (conversion, guerre, dominion…).
 */
export const AI_BRANCH_PREF = {
  easy:   { attraction: 1.0, conversion: 0.6, guerre: 0.5, resistance: 1.3, chevaliers: 0.6, essaim: 1.4, mobilite: 1.3, rites: 1.2, dominion: 0.5 },
  normal: { attraction: 1.0, conversion: 1.0, guerre: 1.0, resistance: 1.0, chevaliers: 1.0, essaim: 1.0, mobilite: 1.0, rites: 1.0, dominion: 1.0 },
  hard:   { attraction: 1.3, conversion: 1.7, guerre: 1.4, resistance: 1.1, chevaliers: 1.3, essaim: 0.8, mobilite: 0.8, rites: 0.9, dominion: 1.6 },
};

/**
 * L'IA dépense tous ses points disponibles, avec des préférences de branche
 * selon la difficulté et sa branche favorite individuelle (state.favBranch).
 */
export function aiSpendSkillPoints(state, difficulty = 'normal') {
  ensureLevelState(state);
  const pref = AI_BRANCH_PREF[difficulty] || AI_BRANCH_PREF.normal;
  const fav = state.favBranch;
  let guard = 300;
  while (guard-- > 0) {
    const cands = SKILL_DEFS.filter((d) => {
      if (skillLevelIn(state.skills, d.id) >= d.max) return false;
      if (!isUnlockedInSkills(state.skills, d)) return false;
      return nextCostInSkills(state.skills, d.id) <= state.skillPoints;
    });
    if (!cands.length) break;
    const weighted = [];
    for (const d of cands) {
      let w = 1 + skillLevelIn(state.skills, d.id);   // spécialisation (déjà entamé)
      w *= (pref[d.branch] || 1);                      // préférence de difficulté
      if (fav && d.branch === fav) w *= 1.8;           // branche favorite de l'IA
      const n = Math.max(1, Math.round(w * 2));
      for (let k = 0; k < n; k++) weighted.push(d);
    }
    const pick = weighted[(Math.random() * weighted.length) | 0];
    const cost = nextCostInSkills(state.skills, pick.id);
    state.skills[pick.id] = skillLevelIn(state.skills, pick.id) + 1;
    state.skillPoints -= cost;
  }
}

/** Puissance d'expansion d'une religion IA (niveau + effets de compétences). */
export function aiExpansionPower(state) {
  ensureLevelState(state);
  const m = getSkillModsForSkills(state.skills);
  const boost =
    (m.convMult - 1) +
    (m.influenceMult - 1) +
    (m.grayConvMult - 1) +
    (m.overwhelmMult - 1) +
    Math.max(0, 1 - m.resistMult);
  return 1 + state.level * 0.14 + boost;
}

export function spentSkillPoints(save) {
  const s = ensureSkills(save || loadSave());
  let n = 0;
  for (const def of SKILL_DEFS) n += costToReach(getSkillLevel(s, def.id));
  return n;
}
