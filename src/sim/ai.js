/* Cerveau des Leaders IA.
   Objectifs (ordre de priorité) :
   1. CRISTAUX-BOMBES — peindre le territoire (fuel = capacité d'expansion).
   2. Croyants en chemin — conversion opportuniste, jamais la mission principale.
   3. Trajectoire stratégique :
      · expand  → privilégier chemins / zones SANS peinture (neutre)
      · raid    → privilégier chemins qui rongent le territoire d'un rival

   Dépendances via `ctx` uniquement. Seul side-effect autorisé : ctx.doBoost(f). */

import { FUEL_MAX, MATCH_DUR, MAP_R } from './constants.js';

export const AI_TUNING = {
  easy:   { think: [0.55, 0.35], samples: 6,  noise: 0.28, raidW: 0.40, refuelAt: 0.28, boost: 0.15, bombRange: 40 },
  normal: { think: [0.26, 0.14], samples: 14, noise: 0.12, raidW: 0.95, refuelAt: 0.38, boost: 0.55, bombRange: 48 },
  hard:   { think: [0.12, 0.07], samples: 22, noise: 0.05, raidW: 1.35, refuelAt: 0.48, boost: 0.92, bombRange: 56 },
};

/** Composition de peinture autour d'un point. */
export function paintMixAround(x, z, r, myTeam, ctx) {
  const { paintGrid, PAINT_N, PAINT_SPAN, island, isSolid } = ctx;
  const half = PAINT_N / 2, k = PAINT_N / PAINT_SPAN;
  let neutral = 0, mine = 0, total = 0;
  const byTeam = [0, 0, 0, 0, 0, 0, 0, 0];
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

/** Qualité d'un trajet A→B selon la stratégie (expand = neutre, raid = ennemi). */
function pathStrategyScore(ax, az, bx, bz, myTeam, rivalTeam, preferRaid, ctx) {
  let neutral = 0, enemy = 0, mine = 0, steps = 0;
  for (let t = 0.15; t <= 0.95; t += 0.2) {
    const x = ax + (bx - ax) * t;
    const z = az + (bz - az) * t;
    const mix = paintMixAround(x, z, 3.5, myTeam, ctx);
    if (!mix) continue;
    steps++;
    neutral += mix.neutral;
    mine += mix.mine;
    if (rivalTeam >= 0) enemy += mix.byTeam[rivalTeam] || 0;
    else enemy += Math.max(0, 1 - mix.neutral - mix.mine);
  }
  if (!steps) return 0.35;
  neutral /= steps; enemy /= steps; mine /= steps;
  if (preferRaid) {
    /* Ronger le rival : ennemi fort, éviter de perdre du temps sur son propre sol. */
    return enemy * 1.55 + neutral * 0.45 - mine * 0.55;
  }
  /* Étendre : terre vierge d'abord, un peu d'ennemi OK, peu d'intérêt à repasser chez soi. */
  return neutral * 1.65 + enemy * 0.55 - mine * 0.7;
}

/** Décision utilitaire d'un Leader IA pour un tick. */
export function aiThink(f, dt, ctx) {
  const { agents, factions, bombs, island, elapsed, difficulty,
    paintOwnerAt, factionScore, islandApproachScore, isSolid, nearestSolidPoint, doBoost } = ctx;

  /* Suivi continu entre deux réflexions. */
  if (f.mode === 'refuel' && f.grayTarget && !f.grayTarget.dead) {
    f.target = { x: f.grayTarget.x, z: f.grayTarget.z };
  }
  if (f.mode === 'bomb' && f.bombTarget) {
    const still = bombs && bombs.includes(f.bombTarget);
    if (still) f.target = { x: f.bombTarget.x, z: f.bombTarget.z };
    else f.bombTarget = null;
  }

  f.aiT -= dt;
  if (f.aiT > 0) return;
  const T = AI_TUNING[difficulty] || AI_TUNING.normal;
  f.aiT = T.think[0] + Math.random() * T.think[1];

  const L = f.leader;
  const fuelR = (f.fuel || 0) / FUEL_MAX;
  const matchLeft = Math.max(0, MATCH_DUR - elapsed);
  const lateGame = 1 - Math.min(1, matchLeft / MATCH_DUR);
  const aggr = Math.min(1, Math.max(0, f.aggr ?? 0.5));

  /* Rival principal + pression de score. */
  let bestRival = null, bestRivalScore = -1, myScore = 0;
  for (const o of factions) {
    if (!o.alive) continue;
    const s = factionScore(o).total;
    if (o === f) { myScore = s; continue; }
    if (s > bestRivalScore) { bestRivalScore = s; bestRival = o; }
  }

  /* ---- 0) Dépôt au Sanctuaire de base si le leader a récolté des esprits ---- */
  const team = ctx.teams && ctx.teams[f.team];
  if (team && (f.count || 0) >= 4) {
    const dBase = Math.hypot(team.baseX - L.x, team.baseZ - L.z);
    const depositNeed = Math.min(3.5, (f.count || 0) * 0.45) * (1 + 12 / (10 + dBase));
    if (depositNeed > 1.0) {
      f.mode = 'deposit';
      f.target = { x: team.baseX, z: team.baseZ };
      return;
    }
  }
  const rivalTeam = bestRival ? bestRival.team : -1;
  const pressure = (bestRival && bestRivalScore > myScore)
    ? Math.min(1, (bestRivalScore - myScore) / 1000)
    : 0.12;
  /* Stratégie du tick : raid si agressif / derrière / fin de partie, sinon expand. */
  const preferRaid = (aggr * 0.55 + pressure * 0.85 + lateGame * 0.45) > 0.72
    || (pressure > 0.35 && Math.random() < 0.55 + aggr * 0.3);

  const noise = () => (Math.random() * 2 - 1) * T.noise;

  /* ---- 1) CRISTAUX : but n°1 (fuel = territoire) ---- */
  let bBest = null, bScore = -1e9;
  const bombRange = T.bombRange || 48;
  if (bombs && bombs.length) {
    for (const b of bombs) {
      const d = Math.hypot(b.x - L.x, b.z - L.z);
      if (d > bombRange) continue;
      const approach = islandApproachScore(L.x, L.z, b.x, b.z);
      if (approach < 0.08 && d > 8) continue;
      const pathQ = pathStrategyScore(L.x, L.z, b.x, b.z, f.team, rivalTeam, preferRaid, ctx);
      /* Fuel bas → cristal encore plus vital ; fuel plein → un peu moins urgent. */
      const fuelNeed = 0.55 + Math.pow(1 - fuelR, 1.35) * 1.8;
      const near = 1.15 / (5 + d);
      let s = near * fuelNeed * (0.4 + Math.max(0, approach)) * (0.75 + pathQ * 0.9);
      s += noise() * 0.15;
      if (s > bScore) { bScore = s; bBest = b; }
    }
  }

  /* ---- 2) Croyants : snack en chemin, pas la mission ---- */
  let gBest = null, gScore = -1;
  let snack = null, snackD = 1e9;
  for (let k = 0; k < T.samples + 10; k++) {
    const a = agents[(Math.random() * agents.length) | 0];
    if (!a || a.dead || (a.discipleOf ?? -1) >= 0) continue;
    if ((a.followerOf ?? -1) === f.i) continue;
    const d = Math.hypot(a.x - L.x, a.z - L.z);
    if (d < snackD) { snackD = d; snack = a; }
    const approach = islandApproachScore(L.x, L.z, a.x, a.z);
    if (approach < 0.05 && d > 6) continue;
    const owner = paintOwnerAt(a.x, a.z);
    /* Gris sur sol neutre / ennemi : plus intéressant (on peint en convertissant). */
    const ground = owner < 0 ? 1.2 : (owner !== f.team ? 1.15 : 0.85);
    const s = 1 / (7 + d) * ground * (0.4 + Math.max(0, approach));
    if (s > gScore) { gScore = s; gBest = a; }
  }

  /* ---- 3) Zones expand / raid ---- */
  let eBest = null, eScore = -1;
  let rBest = null, rScore = -1;
  for (let k = 0; k < T.samples; k++) {
    const ang = Math.random() * Math.PI * 2;
    const rad = 7 + Math.random() * 32;
    const x = L.x + Math.cos(ang) * rad, z = L.z + Math.sin(ang) * rad;
    if (!isSolid(island, x, z)) continue;
    const mix = paintMixAround(x, z, 5.5, f.team, ctx);
    if (!mix) continue;
    const approach = islandApproachScore(L.x, L.z, x, z);
    if (approach < 0.05 && rad > 10) continue;
    const dPen = 1 - Math.min(1, rad / 55) * 0.45;
    const pathQ = pathStrategyScore(L.x, L.z, x, z, f.team, rivalTeam, false, ctx);
    /* Expand : neutre d'abord. */
    const es = (mix.neutral * 1.7 + Math.max(0, 1 - mix.neutral - mix.mine) * 0.55 - mix.mine * 0.65)
      * dPen * (0.55 + Math.max(0, approach) * 0.45) * (0.7 + pathQ * 0.6);
    if (es > eScore) { eScore = es; eBest = { x, z }; }
    if (rivalTeam >= 0) {
      const pathRaid = pathStrategyScore(L.x, L.z, x, z, f.team, rivalTeam, true, ctx);
      const rs = mix.byTeam[rivalTeam] * dPen * (0.55 + Math.max(0, approach) * 0.45)
        * (0.7 + pathRaid * 0.7);
      if (rs > rScore) { rScore = rs; rBest = { x, z }; }
    }
  }

  /* ---- Utilités : cristal >> peinture stratégique >> gris ---- */
  const fuelHungry = fuelR < T.refuelAt;
  const fuelComfort = fuelR >= 0.72;

  let uBomb = bBest ? bScore * 2.35 + (fuelHungry ? 0.85 : 0) + (fuelComfort ? -0.15 : 0.25) : -1;
  /* Même à fuel confortable, un cristal proche reste attractif (stock pour plus tard). */
  if (bBest && Math.hypot(bBest.x - L.x, bBest.z - L.z) < 14) uBomb += 0.55;

  let uExpand = (eBest && fuelR > 0.08) ? fuelR * eScore * 1.35 + noise() : -1;
  let uRaid = (rBest && fuelR > 0.08)
    ? fuelR * rScore * T.raidW * (0.55 + pressure + lateGame * 0.55 + aggr * 0.25) + noise()
    : -1;
  if (preferRaid) { uRaid *= 1.2; uExpand *= 0.82; }
  else { uExpand *= 1.15; uRaid *= 0.88; }

  /* Gris : seulement si fuel vraiment bas ET pas de cristal, ou snack très proche. */
  let uRefuel = gBest
    ? Math.pow(1 - fuelR, 1.85) * 0.55 + (fuelR < 0.18 ? 0.35 : 0) + noise() * 0.5
    : -1;
  if (matchLeft < 22) {
    uBomb *= 0.75;
    uRaid *= 1.2;
  }

  f.bombTarget = null;
  f.grayTarget = null;

  if (uBomb >= uExpand && uBomb >= uRaid && uBomb >= uRefuel && bBest) {
    f.target = { x: bBest.x, z: bBest.z };
    f.mode = 'bomb';
    f.bombTarget = bBest;
  } else if (preferRaid && uRaid >= uExpand && uRaid >= uRefuel && rBest) {
    f.target = rBest;
    f.mode = 'raid';
  } else if (uExpand >= uRaid && uExpand >= uRefuel && eBest) {
    f.target = eBest;
    f.mode = 'expand';
  } else if (uRaid >= uRefuel && rBest) {
    f.target = rBest;
    f.mode = 'raid';
  } else if (eBest) {
    f.target = eBest;
    f.mode = 'expand';
  } else if (gBest) {
    f.grayTarget = gBest;
    f.target = { x: gBest.x, z: gBest.z };
    f.mode = 'refuel';
  }

  /* Conversion en cours de route : détour court vers un gris à portée. */
  if (f.mode !== 'refuel' && snack && snackD < 6.5) {
    const onWay = f.target
      ? (() => {
          const dx = f.target.x - L.x, dz = f.target.z - L.z;
          const len = Math.hypot(dx, dz) || 1;
          const ux = dx / len, uz = dz / len;
          const sx = snack.x - L.x, sz = snack.z - L.z;
          const along = sx * ux + sz * uz;
          const lat = Math.abs(sx * uz - sz * ux);
          return along > -1 && along < len + 2 && lat < 5.5;
        })()
      : true;
    if (onWay || snackD < 3.8) {
      f.grayTarget = snack;
      /* Micro-détour : on vise le gris puis l'IA reprendra le cristal au prochain think. */
      if (snackD < 4.5 || fuelR < 0.55) {
        f.target = { x: snack.x, z: snack.z };
        f.mode = 'refuel';
      }
    }
  }

  /* Sprint : cristaux, raids, longues traversées. */
  if (f.target) {
    const dT = Math.hypot(f.target.x - L.x, f.target.z - L.z);
    const wantBoost =
      (f.mode === 'bomb' && dT > 5 && dT < 28) ||
      (f.mode === 'raid' && dT > 8) ||
      dT > 22 ||
      (matchLeft < 18 && f.mode !== 'refuel');
    if (wantBoost && Math.random() < T.boost) doBoost(f);
  }

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
