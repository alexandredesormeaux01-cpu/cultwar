/* Boucle de la foule : disciples (chasse + conversion) et gris (fuite + errance
   + rituel de conversion). Extraite telle quelle depuis main.js pour préserver
   toutes les invariants comportementaux — la refonte propre viendra plus tard.

   Toutes les dépendances passent par `ctx` : côté client, main.js branche les
   vraies fonctions Three.js ; côté serveur Node, on passe des no-ops et la sim
   tourne headless. */

import {
  CONV_R, CONV_RITUAL_T, FLEE_R,
  DISC_HUNT_R, DISC_FLEE_R, DISC_DETOUR_T, DISC_PAINT_R, DISC_SEP_R,
} from './constants.js';
import { discSpd, discPaintMul } from './disciples.js';

export function stepCrowd(state, dt, ctx) {
  const { agents, factions, island, elapsed } = state;
  const {
    // physique
    resolveIsland, isSolid, canJumpToward, steerOnIsland,
    islandApproachScore, islandPathBlocked, islandRandomPoint,
    // conversion
    finishConvert,
    // peinture
    stampPaintAt,
    // rendu / audio (injectés, no-ops sur serveur)
    setAgentColor, setDiscHalo, hideDiscHalo,
    crowdOf, slotOf, trimCrowdCounts,
    spawnSoulBurst, tone,
    onDiscipleLostFaction, // () → main.js incrémente son grayCount
    // buffers réutilisables (main.js les partage — un neuf par tick coûterait cher)
    tmpM, tmpQ, tmpS, tmpP, UP_AXIS, GRAY, _convCol,
  } = ctx;

  const converters = [];
  for (const f of factions) {
    if (!f.alive) continue;
    converters.push({ f, x: f.leader.x, z: f.leader.z, disc: null });
  }
  for (const d of agents) {
    if (d.dead || (d.discipleOf ?? -1) < 0) continue;
    const f = factions[d.discipleOf];
    if (!f || !f.alive) continue;
    converters.push({ f, x: d.x, z: d.z, disc: d });
  }

  for (const a of agents) {
    if (a.dead) continue;

    /* ========== DISCIPLE : chasse et convertit comme un mini-Leader ========== */
    if ((a.discipleOf ?? -1) >= 0) {
      const f = factions[a.discipleOf];
      if (!f || !f.alive) {
        a.discipleOf = -1;
        a.discLvl = 1;
        a.discXp = 0;
        setAgentColor(a.id, GRAY);
        hideDiscHalo(a.id);
        onDiscipleLostFaction();
        continue;
      }

      a.vx = a.vx || 0; a.vz = a.vz || 0;
      a._detourT = Math.max(0, (a._detourT || 0) - dt);

      if (a.jmp) {
        resolveIsland(island, a, a.vx, a.vz, dt, true);
        const spd = Math.hypot(a.vx, a.vz);
        if (spd > 0.12) a.face = Math.atan2(a.vx, a.vz);
        tmpQ.setFromAxisAngle(UP_AXIS, a.face || 0);
        const s = a.base * 1.04;
        tmpS.set(s, s, s);
        tmpP.set(a.x, a.y || 0, a.z);
        tmpM.compose(tmpP, tmpQ, tmpS);
        const cm = crowdOf(a.id), sl = slotOf(a.id);
        cm.setMatrixAt(sl, tmpM);
        cm.userData.anim.setY(sl, Math.max(spd, 4));
        cm.userData.anim.needsUpdate = true;
        const pulse = 0.5 + 0.5 * Math.sin(elapsed * 5.5 + a.id);
        setDiscHalo(a.id, a.x, a.y || 0, a.z, f.color, pulse, a.base || 1);
        continue;
      }

      let prey = null, preyScore = -1e9;
      if (a._pathBias === undefined) {
        a._pathBias = (Math.random() - 0.5) * 1.4;
        a._pathWobble = 0.55 + Math.random() * 0.7;
        a._pathPhase = Math.random() * Math.PI * 2;
      }
      const claimed = new Set();
      for (const other of agents) {
        if (other === a || other.dead || other.discipleOf !== a.discipleOf) continue;
        if (other._huntTarget && !other._huntTarget.dead) claimed.add(other._huntTarget.id);
      }

      const candidates = [];
      for (const o of agents) {
        if (o.dead || (o.discipleOf ?? -1) >= 0 || o === a) continue;
        const d = Math.hypot(o.x - a.x, o.z - a.z);
        const approach = d <= DISC_HUNT_R
          ? islandApproachScore(a.x, a.z, o.x, o.z)
          : 0.45;
        const nearBonus = d <= DISC_HUNT_R ? 2.2 : 0.55;
        let score = nearBonus / (5 + d) * (0.3 + Math.max(0, approach));
        score *= 0.75 + Math.random() * 0.55;
        if (claimed.has(o.id)) score *= 0.12;
        for (const other of agents) {
          if (other === a || other.dead || other.discipleOf !== a.discipleOf) continue;
          const od = Math.hypot(other.x - o.x, other.z - o.z);
          if (od < DISC_SEP_R) score *= 0.35 + od / DISC_SEP_R * 0.4;
        }
        if (score > preyScore) { preyScore = score; prey = o; }
        if (score > 0.02) candidates.push({ o, score });
      }
      if (candidates.length > 1 && Math.random() < 0.35) {
        candidates.sort((x, y) => y.score - x.score);
        const pick = candidates[1 + ((Math.random() * Math.min(3, candidates.length - 1)) | 0)];
        if (pick) prey = pick.o;
      }

      let wishX = 0, wishZ = 0, wishSpd = discSpd(a);
      let goalX = a.x, goalZ = a.z;
      if (prey) {
        goalX = prey.x; goalZ = prey.z;
        const d = Math.hypot(prey.x - a.x, prey.z - a.z) || 1;
        wishX = (prey.x - a.x) / d;
        wishZ = (prey.z - a.z) / d;
        wishSpd = d < CONV_R ? 1.4 : discSpd(a);
        a._huntTarget = prey;
      } else {
        a._huntTarget = null;
        a.wt = (a.wt || 0) - dt;
        if (a.wt <= 0 || !a._scoutX) {
          a.wt = 1.8 + Math.random() * 2.8;
          const p = islandRandomPoint(island, 2, Infinity);
          a._scoutX = p.x; a._scoutZ = p.z;
        }
        goalX = a._scoutX; goalZ = a._scoutZ;
        const dx = goalX - a.x, dz = goalZ - a.z;
        const dist = Math.hypot(dx, dz) || 1;
        if (dist < 2.5) { a.wt = 0; }
        wishX = dx / dist; wishZ = dz / dist;
        wishSpd = discSpd(a) * (0.7 + Math.random() * 0.25);
      }

      {
        const wob = Math.sin(elapsed * a._pathWobble + a._pathPhase) * 0.55;
        const ang = a._pathBias + wob;
        const c = Math.cos(ang), s = Math.sin(ang);
        const rx = wishX * c - wishZ * s;
        const rz = wishX * s + wishZ * c;
        wishX = rx; wishZ = rz;
      }

      const blocked = islandPathBlocked(a.x, a.z, goalX, goalZ, 3.2);
      const jumpReady = blocked && canJumpToward(island, a.x, a.z, wishX, wishZ);

      if (jumpReady) {
        a._detourT = 0;
        const push = steerOnIsland(a.x, a.z, wishX, wishZ, 1.6);
        let sx = wishX * 0.75 + push.x * 0.25;
        let sz = wishZ * 0.75 + push.z * 0.25;
        const sn = Math.hypot(sx, sz) || 1;
        sx /= sn; sz /= sn;
        a.vx += (sx * wishSpd - a.vx) * Math.min(1, dt * 10);
        a.vz += (sz * wishSpd - a.vz) * Math.min(1, dt * 10);
      } else {
        if (blocked && (a._detourT || 0) <= 0) {
          const sideTry = (a._detourSide || ((a.id & 1) ? 1 : -1));
          const testA = steerOnIsland(a.x, a.z, wishX, wishZ, 3.2, sideTry);
          const testB = steerOnIsland(a.x, a.z, wishX, wishZ, 3.2, -sideTry);
          const scoreSide = (s) => (s.x * wishX + s.z * wishZ);
          a._detourSide = scoreSide(testB) > scoreSide(testA) + 0.05 ? -sideTry : sideTry;
          a._detourT = DISC_DETOUR_T;
        }
        if (!blocked && (a._detourT || 0) > 0 && islandApproachScore(a.x, a.z, goalX, goalZ) > 0.55) {
          a._detourT = 0;
        }

        const preferSide = (a._detourT || 0) > 0 ? (a._detourSide || 1) : 0;
        let sx, sz;
        if (preferSide !== 0) {
          const alongX = -wishZ * preferSide, alongZ = wishX * preferSide;
          const blendX = alongX * 0.82 + wishX * 0.18;
          const blendZ = alongZ * 0.82 + wishZ * 0.18;
          const steered = steerOnIsland(a.x, a.z, blendX, blendZ, 3.4, preferSide);
          sx = steered.x; sz = steered.z;
          if (sx * sx + sz * sz < 1e-6) {
            a._detourSide = -preferSide;
            const flip = steerOnIsland(a.x, a.z, -alongX, -alongZ, 3.4, a._detourSide);
            sx = flip.x; sz = flip.z;
            a._detourT = DISC_DETOUR_T;
          }
        } else {
          const steered = steerOnIsland(a.x, a.z, wishX, wishZ, 3.2);
          sx = steered.x; sz = steered.z;
          if (sx * sx + sz * sz < 1e-6 && (wishX || wishZ)) {
            a._detourSide = (a.id & 1) ? 1 : -1;
            a._detourT = DISC_DETOUR_T;
            const along = steerOnIsland(a.x, a.z, -wishZ * a._detourSide, wishX * a._detourSide, 3.2, a._detourSide);
            sx = along.x; sz = along.z;
          }
        }

        a.vx += (sx * wishSpd - a.vx) * Math.min(1, dt * 8);
        a.vz += (sz * wishSpd - a.vz) * Math.min(1, dt * 8);
      }

      const prevX = a.x, prevZ = a.z;
      a.x += a.vx * dt; a.z += a.vz * dt;
      resolveIsland(island, a, a.vx, a.vz, dt, true);

      const paintedMove = Math.hypot(a.x - prevX, a.z - prevZ);
      a._paintAcc = (a._paintAcc || 0) + paintedMove;
      if (!a.jmp && a._paintAcc > 0.35) {
        stampPaintAt(f, a.x, a.z, DISC_PAINT_R * discPaintMul(a));
        a._paintAcc = 0;
      }

      if (!a.jmp) {
        const moved = paintedMove;
        const intent = Math.hypot(a.vx, a.vz);
        if (intent > 2.0 && moved < intent * dt * 0.22) {
          a._stuckT = (a._stuckT || 0) + dt;
          if (moved > 1e-5) {
            const nx = (a.x - prevX) / moved, nz = (a.z - prevZ) / moved;
            const along = a.vx * nx + a.vz * nz;
            a.vx = nx * Math.max(along, intent * 0.35);
            a.vz = nz * Math.max(along, intent * 0.35);
          }
          if (a._stuckT > 0.1) {
            a._detourSide = -(a._detourSide || ((a.id & 1) ? 1 : -1));
            a._detourT = DISC_DETOUR_T;
            const kick = steerOnIsland(a.x, a.z, -wishZ * a._detourSide, wishX * a._detourSide, 3.6, a._detourSide);
            a.vx = kick.x * discSpd(a);
            a.vz = kick.z * discSpd(a);
            a._stuckT = 0;
          }
        } else {
          a._stuckT = 0;
        }
      }

      const spd = Math.hypot(a.vx, a.vz);
      if (spd > 0.12) a.face = Math.atan2(a.vx, a.vz);

      tmpQ.setFromAxisAngle(UP_AXIS, a.face || 0);
      const s = a.base * 1.04;
      tmpS.set(s, s, s);
      tmpP.set(a.x, a.y || 0, a.z);
      tmpM.compose(tmpP, tmpQ, tmpS);
      const cm = crowdOf(a.id), sl = slotOf(a.id);
      cm.setMatrixAt(sl, tmpM);
      cm.userData.anim.setY(sl, spd);
      cm.userData.anim.needsUpdate = true;

      const pulse = 0.5 + 0.5 * Math.sin(elapsed * 5.5 + a.id);
      setDiscHalo(a.id, a.x, a.y || 0, a.z, f.color, pulse, a.base || 1);
      continue;
    }

    /* ========== GRIS : fuite / errance / rituel ========== */
    let nearC = null, nearD = 1e9;
    for (const c of converters) {
      const d = Math.hypot(c.x - a.x, c.z - a.z);
      if (d < nearD) { nearD = d; nearC = c; }
    }
    const nearF = nearC ? nearC.f : null;
    const threatX = nearC ? nearC.x : 0;
    const threatZ = nearC ? nearC.z : 0;
    const fromDisciple = !!(nearC && nearC.disc);
    const fleeR = fromDisciple ? DISC_FLEE_R : FLEE_R;

    a.vx = a.vx || 0; a.vz = a.vz || 0;
    a.stumbleT = Math.max(0, (a.stumbleT || 0) - dt);
    const inRitual = (a.extractProgress || 0) > 0.05 && nearF && nearD < CONV_R;

    if (inRitual) {
      a.vx *= Math.max(0, 1 - dt * 10);
      a.vz *= Math.max(0, 1 - dt * 10);
    } else if (nearF && nearD < fleeR) {
      const ax = a.x - threatX, az = a.z - threatZ;
      const n = Math.hypot(ax, az) || 1;
      const fx = ax / n, fz = az / n;
      const crowdFear = Math.min(1, (nearF.count || 0) / 35);
      const urgency = Math.min(1, (1 - nearD / fleeR) * (0.75 + crowdFear * 0.45));
      const fleeSpd = fromDisciple
        ? 3.6 + urgency * 2.2
        : 4.8 + urgency * 3.8 + crowdFear * 1.2;
      const zig = Math.sin(elapsed * (7 + urgency * 9) + a.id * 1.7) * urgency * (1.8 + crowdFear);
      const px = -fz, pz = fx;
      let tx = fx * fleeSpd + px * zig;
      let tz = fz * fleeSpd + pz * zig;
      const steered = steerOnIsland(a.x, a.z, tx, tz, 2.4);
      if (steered.x * steered.x + steered.z * steered.z > 1e-6) {
        const sn = Math.hypot(tx, tz) || fleeSpd;
        tx = steered.x * sn;
        tz = steered.z * sn;
      }
      if (a.stumbleT <= 0 && urgency > 0.4 && Math.random() < dt * (0.35 + urgency)) {
        a.stumbleT = 0.18 + Math.random() * 0.16;
      }
      if (a.stumbleT > 0) { tx *= 0.25; tz *= 0.25; }
      a.vx += (tx - a.vx) * Math.min(1, dt * (5 + urgency * 4));
      a.vz += (tz - a.vz) * Math.min(1, dt * (5 + urgency * 4));
      a._fleeUrgency = urgency;
      a._lookBack = urgency > 0.5 && Math.sin(elapsed * 2.8 + a.id) > 0.55;
    } else {
      a.wt = (a.wt || 0) - dt;
      if (a.wt <= 0) { a.wt = 2 + Math.random() * 3; a.wander = Math.random() * 6.28; }
      let wx = Math.cos(a.wander || 0) * 1.1, wz = Math.sin(a.wander || 0) * 1.1;
      const steered = steerOnIsland(a.x, a.z, wx, wz, 2.2);
      if (steered.x * steered.x + steered.z * steered.z > 1e-6) {
        wx = steered.x * 1.1; wz = steered.z * 1.1;
      } else {
        a.wander += 1.2;
        wx = Math.cos(a.wander) * 1.1; wz = Math.sin(a.wander) * 1.1;
      }
      a.vx += (wx - a.vx) * Math.min(1, dt * 2);
      a.vz += (wz - a.vz) * Math.min(1, dt * 2);
      a._fleeUrgency = 0;
      a._lookBack = false;
    }
    a.x += a.vx * dt; a.z += a.vz * dt;
    resolveIsland(island, a, a.vx, a.vz, dt, false);

    if (inRitual && nearF) {
      a.face = Math.atan2(threatX - a.x, threatZ - a.z);
    } else if (a._lookBack && nearF) {
      a.face = Math.atan2(threatX - a.x, threatZ - a.z);
    } else {
      const spd = Math.hypot(a.vx, a.vz);
      if (spd > 0.12) a.face = Math.atan2(a.vx, a.vz);
    }

    const closestF = (nearF && nearD < CONV_R) ? nearF : null;
    let scaleMul = 1;
    if (closestF) {
      a.convertingDisc = (nearC && nearC.disc) ? nearC.disc : null;
      if ((a.converting ?? -1) !== closestF.i) {
        a.converting = closestF.i;
        a.extractProgress = 0;
        if (closestF.i === 0) tone(420, 0.04, 'triangle', 0.02);
      }
      a.extractProgress = (a.extractProgress || 0) + dt;
      const u = Math.min(1, a.extractProgress / CONV_RITUAL_T);
      _convCol.copy(GRAY).lerp(closestF.color, Math.min(1, u * 1.35));
      setAgentColor(a.id, _convCol);
      scaleMul = u < 0.65
        ? 1 + u * 0.14
        : Math.max(0.12, 1.09 * (1 - (u - 0.65) / 0.35));
      if (Math.random() < 0.12 + u * 0.55) spawnSoulBurst(a.x, a.z, closestF);
      if (a.extractProgress >= CONV_RITUAL_T) {
        finishConvert(a, closestF, a.convertingDisc);
        if (a.dead) continue;
        scaleMul = 1.12;
      }
    } else {
      if ((a.extractProgress || 0) > 0 || (a.converting ?? -1) >= 0) {
        setAgentColor(a.id, GRAY);
      }
      a.converting = -1;
      a.convertingDisc = null;
      a.extractProgress = Math.max(0, (a.extractProgress || 0) - dt * 2.2);
    }

    tmpQ.setFromAxisAngle(UP_AXIS, a.face || 0);
    const s = a.base * scaleMul * (a.stumbleT > 0 ? 0.92 : 1);
    tmpS.set(s, s, s);
    tmpP.set(a.x, a.stumbleT > 0 ? 0.05 : 0, a.z);
    tmpM.compose(tmpP, tmpQ, tmpS);
    const cm = crowdOf(a.id), sl = slotOf(a.id);
    cm.setMatrixAt(sl, tmpM);
    const runSpd = inRitual ? 0.15 : Math.hypot(a.vx, a.vz);
    cm.userData.anim.setY(sl, runSpd);
    cm.userData.anim.needsUpdate = true;
  }

  trimCrowdCounts(agents.length);
}
