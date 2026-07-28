/* Boucle des Leaders : lecture d'entrée (joueur / IA), lissage d'inertie,
   déplacement, collision avec l'île et les remparts, répulsion Leader ↔ Leader,
   traînée de peinture. Zéro effet visuel/audio direct — les côtés vue
   (upload de texture, sons de pas, banner) restent dans main.js. */

import { LEADER_RESP, FUEL_PER_UNIT, BOOST_CD } from './constants.js';

/** Direction voulue par le joueur local : joystick/souris + clavier, normalisée.
 *  Utilisée par le tick local ET par l'envoi réseau — les deux doivent lire
 *  exactement la même chose, sinon le serveur ignore les déplacements clavier
 *  et les autres joueurs vous voient immobile. */
export function playerDir(input, keys) {
  let dx = input?.x || 0;
  let dz = input?.z || 0;
  const k = keys || {};
  if (k.KeyW || k.ArrowUp) dz -= 1;
  if (k.KeyS || k.ArrowDown) dz += 1;
  if (k.KeyA || k.ArrowLeft) dx -= 1;
  if (k.KeyD || k.ArrowRight) dx += 1;
  const n = Math.hypot(dx, dz);
  if (n > 1) { dx /= n; dz /= n; }
  return { x: dx, z: dz };
}

/** Un tick de tous les Leaders.
 *  @param {object} state {factions, island, elapsed, judgeR}
 *  @param {object} input {x, z, keys:{KeyW,KeyS,KeyA,KeyD,ArrowUp,ArrowDown,ArrowLeft,ArrowRight}}
 *  @param {number} dt
 *  @param {object} ctx dépendances injectées : leaderSpeed, aiThink,
 *    steerOnIsland, resolveIsland, isSolid, nearestSolidPoint,
 *    resolveBaseWalls, unstickIfInWall, stampPaint, stampIcon, skillMods */
export function stepLeaders(state, input, dt, ctx) {
  const { factions, island, judgeR } = state;
  const { leaderSpeed, aiThink, steerOnIsland, resolveIsland, isSolid,
    nearestSolidPoint, resolveBaseWalls, unstickIfInWall, stampPaint, stampIcon,
    skillMods } = ctx;

  for (const f of factions) {
    if (!f.alive) continue;
    f.boostT = Math.max(0, (f.boostT || 0) - dt);
    f.boostCd = Math.max(0, (f.boostCd || 0) - dt);
    f.discipleCd = Math.max(0, (f.discipleCd || 0) - dt);
    f.slowT = Math.max(0, f.slowT - dt);

    const prevX = f.leader.x, prevZ = f.leader.z;

    /* Multi : faction pilotée par le serveur (humain distant OU IA du salon).
       On ne lit ni l'input local ni l'IA locale — sinon chaque client
       simulerait sa propre version du même adversaire. */
    if (f.remote) {
      const t = f.netTarget;
      if (t) {
        const k = Math.min(1, dt * 12);
        f.leader.x += (t.x - f.leader.x) * k;
        f.leader.z += (t.z - f.leader.z) * k;
        f.leader.dx = t.dx;
        f.leader.dz = t.dz;
      }
      finishLeaderStep(f, prevX, prevZ, dt, state, ctx);
      continue;
    }

    let dx = 0, dz = 0;
    if (f.isBot) {
      /* Escape lock : après un blocage détecté, on force une cible d'évasion
         pour ~1.5 s en ignorant aiThink — sinon l'IA repointe immédiatement
         vers l'obstacle et l'anti-stuck ne sert à rien. */
      if (f.leader._escapeT && f.leader._escapeT > 0) {
        f.leader._escapeT -= dt;
        aiThink(f, dt);
        f.target = f.leader._escapeTarget;
      } else {
        aiThink(f, dt);
      }
      if (f.target) {
        dx = f.target.x - f.leader.x; dz = f.target.z - f.leader.z;
        const n = Math.hypot(dx, dz);
        if (n > 0.5) {
          const nx = dx / n, nz = dz / n;
          const steered = steerOnIsland(f.leader.x, f.leader.z, dx, dz, 3.4);
          if (steered.x * steered.x + steered.z * steered.z > 1e-6) {
            dx = steered.x; dz = steered.z;
          } else {
            /* Direction directe bloquée : essaie les deux côtés, garde le
               meilleur ; si les deux échouent, garde la direction directe
               brute — resolveIsland(true) déclenchera un saut si canJumpToward
               valide. Sans ça le bot se bloque indéfiniment sur le bord. */
            const side = (f.i & 1) ? 1 : -1;
            const aA = steerOnIsland(f.leader.x, f.leader.z, -dz * side, dx * side, 3.2);
            const aB = steerOnIsland(f.leader.x, f.leader.z,  dz * side, -dx * side, 3.2);
            const scoreA = aA.x * nx + aA.z * nz;
            const scoreB = aB.x * nx + aB.z * nz;
            const pick = scoreB > scoreA ? aB : aA;
            if (pick.x * pick.x + pick.z * pick.z > 1e-6) {
              dx = pick.x; dz = pick.z;
            } else { dx = nx; dz = nz; }
          }
        } else { dx = 0; dz = 0; }
      }
      if (!isSolid(island, f.leader.x, f.leader.z)) {
        const p = nearestSolidPoint(island, f.leader.x, f.leader.z);
        f.leader.x = f.leader._safeX = p.x;
        f.leader.z = f.leader._safeZ = p.z;
        f.leader.jmp = null;
      }
    } else {
      const d = playerDir(input, input.keys);
      dx = d.x; dz = d.z;
    }

    const sp = leaderSpeed(f);
    const resp = LEADER_RESP * (f.i === 0 ? skillMods.leaderRespMult : 1);
    f.leader.dx += (dx * sp - f.leader.dx) * Math.min(1, dt * resp);
    f.leader.dz += (dz * sp - f.leader.dz) * Math.min(1, dt * resp);
    f.leader.x += f.leader.dx * dt;
    f.leader.z += f.leader.dz * dt;

    finishLeaderStep(f, prevX, prevZ, dt, state, ctx);
  }
}

/* Commun à tous les Leaders (local, IA locale, réseau) : collisions, anneau de
   jugement, distance parcourue et traînée de peinture. */
function finishLeaderStep(f, prevX, prevZ, dt, state, ctx) {
  const { island, judgeR } = state;
  const { resolveIsland, isSolid, resolveBaseWalls, unstickIfInWall,
    stampPaint, stampIcon } = ctx;

  resolveIsland(island, f.leader, f.leader.dx, f.leader.dz, dt, true);
  resolveBaseWalls(f.leader);
  unstickIfInWall(f.leader);

  if (judgeR < 999) {
    const dc = Math.hypot(f.leader.x, f.leader.z);
    if (dc > judgeR) {
      f.leader.x *= judgeR / dc; f.leader.z *= judgeR / dc;
      if (!isSolid(island, f.leader.x, f.leader.z)) resolveIsland(island, f.leader, 0, 0, dt, false);
      resolveBaseWalls(f.leader);
      unstickIfInWall(f.leader);
    }
  }

  const moved = Math.hypot(f.leader.x - prevX, f.leader.z - prevZ);
  f.dist = (f.dist || 0) + moved;

  /* Anti-blocage :
     - 0.6 s coincé → verrouille une cible d'évasion (point sol aléatoire à
       6–10 u autour), l'IA ignore ses objectifs pendant 1.5 s le temps de
       s'en sortir par un chemin latéral.
     - 2.5 s coincé quand même (l'évasion elle-même échoue) → téléportation
       vers le point solide le plus proche à ≥ 4 u : garantit qu'aucun bot
       ne peut rester bloqué pour la partie. */
  if (f.isBot) {
    const wanted = Math.hypot(f.leader.dx, f.leader.dz);
    if ((wanted > 0.5 || f.target) && moved < 0.05) {
      f.leader._stuckT = (f.leader._stuckT || 0) + dt;
      if (f.leader._stuckT > 2.5) {
        /* Téléport de dernier recours. */
        for (let tries = 0; tries < 8; tries++) {
          const ang = Math.random() * Math.PI * 2;
          const dist = 4 + Math.random() * 4;
          const tx = f.leader.x + Math.cos(ang) * dist;
          const tz = f.leader.z + Math.sin(ang) * dist;
          if (isSolid(island, tx, tz)) {
            f.leader.x = f.leader._safeX = tx;
            f.leader.z = f.leader._safeZ = tz;
            f.leader.dx = 0; f.leader.dz = 0;
            f.leader.jmp = null;
            f.leader._escapeT = 0;
            f.leader._escapeTarget = null;
            break;
          }
        }
        f.leader._stuckT = 0;
      } else if (f.leader._stuckT > 0.6 && !(f.leader._escapeT > 0)) {
        /* Choix d'un point d'évasion solide à distance moyenne. */
        for (let tries = 0; tries < 6; tries++) {
          const ang = Math.random() * Math.PI * 2;
          const dist = 6 + Math.random() * 4;
          const tx = f.leader.x + Math.cos(ang) * dist;
          const tz = f.leader.z + Math.sin(ang) * dist;
          if (isSolid(island, tx, tz)) {
            f.leader._escapeTarget = { x: tx, z: tz };
            f.leader._escapeT = 1.5;
            break;
          }
        }
      }
    } else {
      f.leader._stuckT = 0;
    }
  }
  if (f.fuel > 0) {
    const painted = stampPaint(f);
    if (painted) {
      f.fuel = Math.max(0, f.fuel - moved * FUEL_PER_UNIT);
      f.iconD = (f.iconD || 0) + moved;
      if (f.iconD > 9) { f.iconD = 0; stampIcon(f); }
    }
  }
}

/** Répulsion douce Leader ↔ Leader — deux Leaders ne se traversent pas. */
export function stepLeaderRepulsion(state, dt, ctx) {
  const { factions, island } = state;
  const { resolveIsland } = ctx;
  for (let i = 0; i < factions.length; i++) {
    const A = factions[i];
    if (!A.alive) continue;
    for (let j = i + 1; j < factions.length; j++) {
      const B = factions[j];
      if (!B.alive) continue;
      const dx = A.leader.x - B.leader.x, dz = A.leader.z - B.leader.z;
      const d2 = dx * dx + dz * dz;
      if (d2 < 2.2 * 2.2) {
        const n = Math.sqrt(d2) || 1;
        const p = (2.2 - n) * dt * 6;
        A.leader.x += (dx / n) * p; A.leader.z += (dz / n) * p;
        B.leader.x -= (dx / n) * p; B.leader.z -= (dz / n) * p;
        resolveIsland(island, A.leader, 0, 0, dt, false);
        resolveIsland(island, B.leader, 0, 0, dt, false);
      }
    }
  }
}

/** Recharge du sprint joueur (cadence fixe, indépendante des skills). */
export function updateBoostCharge(f, currentCharge, dt) {
  if (!f || !f.alive) return currentCharge;
  return Math.min(1, currentCharge + dt / BOOST_CD);
}
