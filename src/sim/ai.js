/* Cerveau des Leaders IA — utilitaire pur, arbitre entre trois envies :
   RECHARGER (chasser un gris), ÉTENDRE (peindre là où ça rapporte),
   RAIDER (attaquer la couleur du rival en tête).

   Toutes les dépendances externes passent par `ctx` (pas de globales).
   Zéro effet visuel/audio — la seule action side-effect autorisée est
   `ctx.doBoost(f)`, qui pousse un événement de sprint. */

import { FUEL_MAX, MATCH_DUR, MAP_R } from './constants.js';

/* Réglages par difficulté : cadence de réflexion [base, jitter], nombre de
   points/gris évalués, bruit d'utilité, poids du raid, seuil de confort de la
   jauge, probabilité d'oser un sprint. */
export const AI_TUNING = {
  easy:   { think: [0.55, 0.35], samples: 6,  noise: 0.30, raidW: 0.35, refuelAt: 0.30, boost: 0.15 },
  normal: { think: [0.28, 0.15], samples: 12, noise: 0.15, raidW: 0.85, refuelAt: 0.40, boost: 0.50 },
  hard:   { think: [0.14, 0.08], samples: 20, noise: 0.06, raidW: 1.25, refuelAt: 0.50, boost: 0.90 },
};

/* Composition de peinture autour d'un point : {neutral, mine, byTeam[]}
   sur un échantillon 5×5. Utilisé par l'IA pour juger une destination.
   Injecté avec la référence à la grille (constants + Int8Array). */
export function paintMixAround(x, z, r, myTeam, ctx) {
  const { paintGrid, PAINT_N, PAINT_SPAN, island, isSolid } = ctx;
  const half = PAINT_N / 2, k = PAINT_N / PAINT_SPAN;
  let neutral = 0, mine = 0, total = 0;
  const byTeam = [0, 0, 0];
  for (let i = -2; i <= 2; i++) {
    for (let j = -2; j <= 2; j++) {
      const wx = x + (i / 2) * r, wz = z + (j / 2) * r;
      if (!isSolid(island, wx, wz)) continue;
      const gx = (wx * k + half) | 0, gz = (wz * k + half) | 0;
      if (gx < 0 || gz < 0 || gx >= PAINT_N || gz >= PAINT_N) continue;
      total++;
      const o = paintGrid[gz * PAINT_N + gx];
      if (o < 0) neutral++;
      else { byTeam[o]++; if (o === myTeam) mine++; }
    }
  }
  if (!total) return null;
  return {
    neutral: neutral / total,
    mine: mine / total,
    byTeam: [byTeam[0] / total, byTeam[1] / total, byTeam[2] / total],
  };
}

/** Décision utilitaire d'un Leader IA pour un tick.
 *  Mute f.target, f.mode, f.grayTarget, f.aiT. Peut déclencher un boost.
 *  @param {object} f faction (bot)
 *  @param {number} dt secondes
 *  @param {object} ctx {agents, factions, bombs, island, elapsed, difficulty,
 *    paintOwnerAt, factionScore, islandApproachScore, isSolid, nearestSolidPoint,
 *    doBoost, paintGrid, PAINT_N, PAINT_SPAN} */
export function aiThink(f, dt, ctx) {
  const { agents, factions, bombs, island, elapsed, difficulty,
    paintOwnerAt, factionScore, islandApproachScore, isSolid, nearestSolidPoint, doBoost } = ctx;

  /* Suivi continu : un gris ciblé fuit, on colle à sa position réelle entre
     deux réflexions — sinon le bot court vers un point où le gris n'est plus. */
  if (f.mode === 'refuel' && f.grayTarget && !f.grayTarget.dead) {
    f.target = { x: f.grayTarget.x, z: f.grayTarget.z };
  }
  f.aiT -= dt;
  if (f.aiT > 0) return;
  const T = AI_TUNING[difficulty] || AI_TUNING.normal;
  f.aiT = T.think[0] + Math.random() * T.think[1];

  const L = f.leader;
  const fuelR = (f.fuel || 0) / FUEL_MAX;
  const matchLeft = Math.max(0, MATCH_DUR - elapsed);
  const lateGame = 1 - Math.min(1, matchLeft / MATCH_DUR);

  let bestRival = null, bestRivalScore = -1, myScore = 0;
  for (const o of factions) {
    if (!o.alive) continue;
    const s = factionScore(o).total;
    if (o === f) { myScore = s; continue; }
    if (s > bestRivalScore) { bestRivalScore = s; bestRival = o; }
  }

  /* Candidat RECHARGER : le gris le plus rentable de l'échantillon. */
  let gBest = null, gScore = -1;
  let snack = null, snackD = 1e9;
  for (let k = 0; k < T.samples + 8; k++) {
    const a = agents[(Math.random() * agents.length) | 0];
    if (!a || a.dead || (a.discipleOf ?? -1) >= 0) continue;
    const d = Math.hypot(a.x - L.x, a.z - L.z);
    if (d < snackD) { snackD = d; snack = a; }
    const owner = paintOwnerAt(a.x, a.z);
    const approach = islandApproachScore(L.x, L.z, a.x, a.z);
    if (approach < 0.05 && d > 5) continue;
    const s = 1 / (6 + d) * (owner >= 0 && owner !== f.team ? 1.25 : 1) * (0.45 + Math.max(0, approach));
    if (s > gScore) { gScore = s; gBest = a; }
  }

  /* Candidats ÉTENDRE / RAIDER : points échantillonnés autour de soi. */
  let eBest = null, eScore = -1;
  let rBest = null, rScore = -1;
  const rivalTeam = bestRival ? bestRival.team : -1;
  for (let k = 0; k < T.samples; k++) {
    const ang = Math.random() * Math.PI * 2;
    const rad = 8 + Math.random() * 30;
    const x = L.x + Math.cos(ang) * rad, z = L.z + Math.sin(ang) * rad;
    if (!isSolid(island, x, z)) continue;
    const mix = paintMixAround(x, z, 5, f.team, ctx);
    if (!mix) continue;
    const dPen = 1 - Math.min(1, rad / 55) * 0.5;
    const foe = Math.max(0, 1 - mix.neutral - mix.mine);
    const es = (mix.neutral + foe * 0.9) * dPen;
    if (es > eScore) { eScore = es; eBest = { x, z }; }
    if (rivalTeam >= 0) {
      const rs = mix.byTeam[rivalTeam] * dPen;
      if (rs > rScore) { rScore = rs; rBest = { x, z }; }
    }
  }

  /* Candidat CRISTAL : bombe la plus proche à portée raisonnable. */
  let bBomb = null, dBomb = 1e9;
  for (const b of bombs) {
    const d = Math.hypot(b.x - L.x, b.z - L.z);
    if (d < dBomb) { dBomb = d; bBomb = b; }
  }

  /* Utilités : trois envies, une décision. */
  const noise = () => (Math.random() * 2 - 1) * T.noise;
  let uRefuel = gBest
    ? Math.pow(1 - fuelR, 1.6) * 1.35 + (fuelR < T.refuelAt ? 0.55 : 0) + noise()
    : -1;
  const uExpand = eBest ? fuelR * eScore * 1.5 + noise() : -1;
  const pressure = (bestRival && bestRivalScore > myScore)
    ? Math.min(1, (bestRivalScore - myScore) / 1200) : 0.15;
  const uRaid = rBest ? fuelR * rScore * T.raidW * (0.5 + pressure + lateGame * 0.6) + noise() : -1;
  if (matchLeft < 25) uRefuel *= 0.55;
  const uBomb = bBomb && dBomb < 34 ? (1.15 - dBomb / 34) * 1.6 + noise() : -1;

  if (uBomb > uRefuel && uBomb > uExpand && uBomb > uRaid && bBomb) {
    f.target = { x: bBomb.x, z: bBomb.z };
    f.mode = 'bomb';
    f.grayTarget = null;
  } else if (uRefuel >= uExpand && uRefuel >= uRaid && gBest) {
    f.grayTarget = gBest;
    f.target = { x: gBest.x, z: gBest.z };
    f.mode = 'refuel';
  } else if (uRaid > uExpand && rBest) {
    f.target = rBest;
    f.mode = 'raid';
    f.grayTarget = null;
  } else if (eBest) {
    f.target = eBest;
    f.mode = 'expand';
    f.grayTarget = null;
  } else if (gBest) {
    f.grayTarget = gBest;
    f.target = { x: gBest.x, z: gBest.z };
    f.mode = 'refuel';
  }

  /* Chasser ET peindre : un gris à portée est croqué au passage. */
  if (f.mode !== 'refuel' && f.mode !== 'bomb' && snack && snackD < 8 && fuelR < 0.9) {
    f.grayTarget = snack;
    f.target = { x: snack.x, z: snack.z };
    f.mode = 'refuel';
  }

  /* Sprint : gris fuyard, traversée, ou rush final. */
  if (f.target) {
    const dT = Math.hypot(f.target.x - L.x, f.target.z - L.z);
    const wantBoost =
      (f.mode === 'refuel' && dT > 6 && dT < 16) ||
      dT > 20 ||
      (matchLeft < 20 && f.mode !== 'refuel');
    if (wantBoost && Math.random() < T.boost) doBoost(f);
  }

  /* Rester dans la vallée + sur une dalle solide. */
  if (f.target) {
    const tLim = MAP_R - 4;
    const dc = Math.hypot(f.target.x, f.target.z);
    if (dc > tLim) { f.target.x *= (tLim - 2) / dc; f.target.z *= (tLim - 2) / dc; }
    if (!isSolid(island, f.target.x, f.target.z)) {
      const p = nearestSolidPoint(island, f.target.x, f.target.z);
      f.target.x = p.x; f.target.z = p.z;
    }
  }
}
