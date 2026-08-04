/* Boucle de la foule : disciples (chasse + conversion) et gris (fuite + errance
   + rituel de conversion). Extraite telle quelle depuis main.js pour préserver
   toutes les invariants comportementaux — la refonte propre viendra plus tard.

   Toutes les dépendances passent par `ctx` : côté client, main.js branche les
   vraies fonctions Three.js ; côté serveur Node, on passe des no-ops et la sim
   tourne headless. */

import {
  CONV_R, CONV_RITUAL_T, FLEE_R, CONV_BY_PROXIMITY,
  DISC_HUNT_R, DISC_FLEE_R, DISC_DETOUR_T, DISC_SEP_R,
  DISC_BOMB_R, DISC_FUEL_CRITICAL, DISC_FUEL_COMFORT,
  FOLLOWER_FLEE_R, FOLLOWER_SPD, FOLLOWER_WANDER_SPD, DISCIPLE_FORM_SCALE,
  FUEL_MAX,
} from './constants.js';
import { discSpd } from './disciples.js';

export function stepCrowd(state, dt, ctx) {
  const {
    agents, factions, island, elapsed, bombs = [],
    grayPanic = false, zeal = false, discFreeze = false,
  } = state;
  const {
    // physique
    resolveIsland, isSolid, canJumpToward, steerOnIsland,
    islandApproachScore, islandPathBlocked, islandRandomPoint,
    // conversion
    finishConvert,
    // peinture
    // rendu / audio (injectés, no-ops sur serveur)
    setAgentColor, setDiscHalo, hideDiscHalo,
    crowdOf, slotOf, trimCrowdCounts,
    spawnSoulBurst, tone,
    onDiscipleLostFaction, // () → main.js incrémente son grayCount
    onFollowerLostFaction, // (a) → main.js libère le slot follower
    updateFollowerTransform, // (a, mat, spd) → met à jour le mesh follower
    setFollowerColor, // (a, col) → teinte le slot follower
    // buffers réutilisables (main.js les partage — un neuf par tick coûterait cher)
    tmpM, tmpQ, tmpS, tmpP, UP_AXIS, GRAY, _convCol,
    tmpQ2, SIDE_AXIS,   // pose « face au sol » des agents touchés
  } = ctx;

  /* Pose « face au sol » : on bascule le personnage d'un quart de tour autour
     de son axe latéral. Le mesh est instancié, donc tout passe par la matrice —
     il n'y a pas d'animation de chute à jouer. */
  const composeFallen = (a) => {
    tmpQ.setFromAxisAngle(UP_AXIS, a.face || 0);
    if (tmpQ2 && SIDE_AXIS) {
      tmpQ2.setFromAxisAngle(SIDE_AXIS, Math.PI * 0.5);
      tmpQ.multiply(tmpQ2);
    }
    const sc = a.base || 1;
    tmpP.set(a.x, (a.y || 0) + sc * 0.22, a.z);
    tmpS.set(sc, sc, sc);
    tmpM.compose(tmpP, tmpQ, tmpS);
    if (a._followerSlot != null) updateFollowerTransform(a, tmpM, 0);
    else crowdOf(a.id).setMatrixAt(slotOf(a.id), tmpM);
  };

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

    /* ========== À TERRE : touché par une attaque ==========
       L'esprit ne fuit plus, ne plonge plus, ne suit plus personne — il gît
       jusqu'à ce qu'un Leader le ramasse ou qu'il se relève. C'est la fenêtre
       que l'attaque ouvre, et elle doit court-circuiter TOUS les autres
       comportements, y compris le cortège : un esprit arraché d'une file
       repartirait sinon derrière son ancien maître. */
    if (a.downT > 0) {
      a.vx = 0; a.vz = 0;
      resolveIsland(island, a, 0, 0, dt, false);
      composeFallen(a);
      continue;
    }

    /* ========== DISCIPLE : chasse et convertit comme un mini-Leader ========== */
    if ((a.discipleOf ?? -1) >= 0) {
      const f = factions[a.discipleOf];
      if (!f || !f.alive) {
        a.discipleOf = -1;
        a.base = a._origBase || a.base;
        a.discLvl = 1;
        a.discXp = 0;
        hideDiscHalo(a.id);
        onFollowerLostFaction(a); // libère slot Leader + réaffiche le villageois
        onDiscipleLostFaction();
        continue;
      }

      a.vx = a.vx || 0; a.vz = a.vz || 0;
      a._detourT = Math.max(0, (a._detourT || 0) - dt);

      /* Vœu de silence : disciple figé (auréole continue de battre). */
      if (discFreeze) {
        a.vx = 0; a.vz = 0;
        a._bombTarget = null;
        a._huntTarget = null;
        tmpQ.setFromAxisAngle(UP_AXIS, a.face || 0);
        tmpP.set(a.x, a.y || 0, a.z);
        if (a._followerSlot != null) {
          const ds = DISCIPLE_FORM_SCALE;
          tmpS.set(ds, ds, ds);
          tmpM.compose(tmpP, tmpQ, tmpS);
          updateFollowerTransform(a, tmpM, 0);
        } else {
          tmpS.set(0, 0, 0);
          tmpM.compose(tmpP, tmpQ, tmpS);
          const cm = crowdOf(a.id), sl = slotOf(a.id);
          cm.setMatrixAt(sl, tmpM);
        }
        const pulse = 0.5 + 0.5 * Math.sin(elapsed * 5.5 + a.id);
        setDiscHalo(a.id, a.x, a.y || 0, a.z, f.color, pulse, a.base || 1);
        continue;
      }

      if (a.jmp) {
        resolveIsland(island, a, a.vx, a.vz, dt, true);
        const spd = Math.hypot(a.vx, a.vz);
        if (spd > 0.12) a.face = Math.atan2(a.vx, a.vz);
        tmpQ.setFromAxisAngle(UP_AXIS, a.face || 0);
        tmpP.set(a.x, a.y || 0, a.z);
        if (a._followerSlot != null) {
          const ds = DISCIPLE_FORM_SCALE;
          tmpS.set(ds, ds, ds);
          tmpM.compose(tmpP, tmpQ, tmpS);
          updateFollowerTransform(a, tmpM, Math.max(spd, 4));
        } else {
          /* En attente de morph : ne jamais réafficher le villageois. */
          tmpS.set(0, 0, 0);
          tmpM.compose(tmpP, tmpQ, tmpS);
          const cm = crowdOf(a.id), sl = slotOf(a.id);
          cm.setMatrixAt(sl, tmpM);
        }
        const pulse = 0.5 + 0.5 * Math.sin(elapsed * 5.5 + a.id);
        setDiscHalo(a.id, a.x, a.y || 0, a.z, f.color, pulse, a.base || 1);
        continue;
      }

      let prey = null, preyScore = -1e9;
      let bomb = null, bombScore = -1e9;
      if (a._pathBias === undefined) {
        a._pathBias = (Math.random() - 0.5) * 1.4;
        a._pathWobble = 0.55 + Math.random() * 0.7;
        a._pathPhase = Math.random() * Math.PI * 2;
      }
      const claimedPrey = new Set();
      const claimedBombs = new Set();
      for (const other of agents) {
        if (other === a || other.dead || other.discipleOf !== a.discipleOf) continue;
        if (other._huntTarget && !other._huntTarget.dead) claimedPrey.add(other._huntTarget.id);
        if (other._bombTarget) claimedBombs.add(other._bombTarget);
      }

      const fuelR = Math.min(1, Math.max(0, (f.fuel || 0) / FUEL_MAX));
      const fuelUrgent = fuelR < DISC_FUEL_CRITICAL;
      const fuelOk = fuelR >= DISC_FUEL_COMFORT;

      /* Mission #1 : cristaux-bombes → peinture du maître. */
      for (let bi = 0; bi < bombs.length; bi++) {
        const b = bombs[bi];
        if (!b) continue;
        const d = Math.hypot(b.x - a.x, b.z - a.z);
        if (d > DISC_BOMB_R) continue;
        const approach = islandApproachScore(a.x, a.z, b.x, b.z);
        let score = (2.8 / (4 + d)) * (0.35 + Math.max(0, approach));
        score *= 1.15 + (1 - fuelR) * 2.4; // plus le fuel est bas, plus la bombe attire
        if (claimedBombs.has(b)) score *= 0.08;
        if (score > bombScore) { bombScore = score; bomb = b; }
      }

      /* Mission #2 : convertir un maximum de croyants au passage. */
      const candidates = [];
      for (const o of agents) {
        if (o.dead || (o.discipleOf ?? -1) >= 0 || o === a) continue;
        if ((o.followerOf ?? -1) === a.discipleOf) continue;
        const d = Math.hypot(o.x - a.x, o.z - a.z);
        const approach = d <= DISC_HUNT_R
          ? islandApproachScore(a.x, a.z, o.x, o.z)
          : 0.45;
        const nearBonus = d <= DISC_HUNT_R ? 2.2 : 0.55;
        let score = nearBonus / (5 + d) * (0.3 + Math.max(0, approach));
        score *= 0.75 + Math.random() * 0.55;
        if (claimedPrey.has(o.id)) score *= 0.12;
        for (const other of agents) {
          if (other === a || other.dead || other.discipleOf !== a.discipleOf) continue;
          const od = Math.hypot(other.x - o.x, other.z - o.z);
          if (od < DISC_SEP_R) score *= 0.35 + od / DISC_SEP_R * 0.4;
        }
        /* Gris très proches : snack au passage même en route vers une bombe. */
        if (d < CONV_R * 1.35) score *= 1.8;
        if (score > preyScore) { preyScore = score; prey = o; }
        if (score > 0.02) candidates.push({ o, score, d });
      }
      if (candidates.length > 1 && Math.random() < 0.35) {
        candidates.sort((x, y) => y.score - x.score);
        const pick = candidates[1 + ((Math.random() * Math.min(3, candidates.length - 1)) | 0)];
        if (pick) { prey = pick.o; preyScore = pick.score; }
      }

      /* Arbitrage : peinture d'abord, conversion ensuite.
         - fuel critique → bombe sauf gris déjà dans le rituel
         - fuel moyen → bombe si meilleure / plus urgente que la proie
         - fuel confort → chasse, mais dévie vers une bombe proche */
      let goalMode = 'scout'; // 'bomb' | 'prey' | 'scout'
      const preyNear = prey && Math.hypot(prey.x - a.x, prey.z - a.z) < CONV_R * 1.15;
      if (bomb && fuelUrgent && !preyNear) {
        goalMode = 'bomb';
      } else if (bomb && !fuelOk) {
        const preyD = prey ? Math.hypot(prey.x - a.x, prey.z - a.z) : 1e9;
        const bombD = Math.hypot(bomb.x - a.x, bomb.z - a.z);
        if (!prey || bombD < preyD * 1.35 || bombScore > preyScore * 1.1) goalMode = 'bomb';
        else goalMode = 'prey';
      } else if (prey && (!bomb || fuelOk)) {
        goalMode = 'prey';
        if (bomb) {
          const bombD = Math.hypot(bomb.x - a.x, bomb.z - a.z);
          if (bombD < 10 || (bombD < 18 && Math.random() < 0.25)) goalMode = 'bomb';
        }
      } else if (bomb) {
        goalMode = 'bomb';
      }

      let wishX = 0, wishZ = 0, wishSpd = discSpd(a);
      let goalX = a.x, goalZ = a.z;
      if (goalMode === 'bomb' && bomb) {
        goalX = bomb.x; goalZ = bomb.z;
        const d = Math.hypot(bomb.x - a.x, bomb.z - a.z) || 1;
        wishX = (bomb.x - a.x) / d;
        wishZ = (bomb.z - a.z) / d;
        wishSpd = discSpd(a) * (fuelUrgent ? 1.12 : 1.0);
        a._bombTarget = bomb;
        a._huntTarget = null;
      } else if (goalMode === 'prey' && prey) {
        goalX = prey.x; goalZ = prey.z;
        const d = Math.hypot(prey.x - a.x, prey.z - a.z) || 1;
        wishX = (prey.x - a.x) / d;
        wishZ = (prey.z - a.z) / d;
        wishSpd = d < CONV_R ? 1.4 : discSpd(a);
        a._huntTarget = prey;
        a._bombTarget = null;
      } else {
        a._huntTarget = null;
        a._bombTarget = null;
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

      /* Les disciples ne peignent plus non plus : le territoire vient
         exclusivement des sanctuaires. */
      const paintedMove = Math.hypot(a.x - prevX, a.z - prevZ);

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
      tmpP.set(a.x, a.y || 0, a.z);
      if (a._followerSlot != null) {
        const ds = DISCIPLE_FORM_SCALE;
        tmpS.set(ds, ds, ds);
        tmpM.compose(tmpP, tmpQ, tmpS);
        updateFollowerTransform(a, tmpM, spd);
      } else {
        tmpS.set(0, 0, 0);
        tmpM.compose(tmpP, tmpQ, tmpS);
        const cm = crowdOf(a.id), sl = slotOf(a.id);
        cm.setMatrixAt(sl, tmpM);
      }

      const pulse = 0.5 + 0.5 * Math.sin(elapsed * 5.5 + a.id);
      setDiscHalo(a.id, a.x, a.y || 0, a.z, f.color, pulse, a.base || 1);
      continue;
    }

    /* ========== FOLLOWER : erre tranquillement, fuit les ennemis ========== */
    if ((a.followerOf ?? -1) >= 0) {
      const _setFCol = (col) => {
        if (a._followerSlot != null) setFollowerColor(a, col);
        else setAgentColor(a.id, col);
      };
      const f = factions[a.followerOf];
      if (!f || !f.alive) {
        onFollowerLostFaction(a);
        a.followerOf = -1;
        a.base = a._origBase || a.base;
        onDiscipleLostFaction();
        continue;
      }

      let enemyC = null, enemyD = 1e9;
      for (const c of converters) {
        if (c.f.i === a.followerOf) continue;
        const d = Math.hypot(c.x - a.x, c.z - a.z);
        if (d < enemyD) { enemyD = d; enemyC = c; }
      }

      a.vx = a.vx || 0; a.vz = a.vz || 0;

      const inEnemyConvR = CONV_BY_PROXIMITY && enemyC && enemyD < CONV_R;
      if (inEnemyConvR) {
        a.convertingDisc = (enemyC.disc) ? enemyC.disc : null;
        if ((a.converting ?? -1) !== enemyC.f.i) {
          a.converting = enemyC.f.i;
          a.extractProgress = 0;
        }
        a.extractProgress = (a.extractProgress || 0) + dt * (zeal ? 2.35 : 1);
        const ritualNeed = zeal ? CONV_RITUAL_T * 0.55 : CONV_RITUAL_T;
        const u = Math.min(1, a.extractProgress / ritualNeed);
        _convCol.copy(f.color).lerp(enemyC.f.color, Math.min(1, u * 1.35));
        _setFCol(_convCol);
        a.vx *= Math.max(0, 1 - dt * 10);
        a.vz *= Math.max(0, 1 - dt * 10);
        if (a.extractProgress >= ritualNeed) {
          finishConvert(a, enemyC.f, a.convertingDisc);
          continue;
        }
      } else if (enemyC && enemyD < FOLLOWER_FLEE_R) {
        const ax = a.x - enemyC.x, az = a.z - enemyC.z;
        const n = Math.hypot(ax, az) || 1;
        const urgency = 1 - enemyD / FOLLOWER_FLEE_R;
        const spd = FOLLOWER_SPD + urgency * 3.5;
        let tx = (ax / n) * spd, tz = (az / n) * spd;
        const steered = steerOnIsland(a.x, a.z, tx, tz, 2.2);
        if (steered.x * steered.x + steered.z * steered.z > 1e-6) {
          tx = steered.x * spd; tz = steered.z * spd;
        }
        a.vx += (tx - a.vx) * Math.min(1, dt * 6);
        a.vz += (tz - a.vz) * Math.min(1, dt * 6);
        if ((a.extractProgress || 0) > 0) {
          _setFCol({ r: 1, g: 1, b: 1 });
          a.converting = -1;
          a.convertingDisc = null;
          a.extractProgress = 0;
        }
      } else {
        /* Cortège collant : les esprits convertis s'accrochent au Leader.
           - Loin (> 2 u) : sprint à la vitesse du Leader (V_MAX 9.2), plus rapide
             encore au-delà de 5 u pour rattraper les grands écarts.
           - Proche : orbite serrée décalée par agent (id * 0.618) pour éviter
             qu'ils se superposent tous à sa position exacte. */
        const lx = f.leader.x, lz = f.leader.z;
        const dxL = lx - a.x, dzL = lz - a.z;
        const distL = Math.hypot(dxL, dzL) || 1;
        const STICK_R = 2;   // rayon très serré = cortège collé au Leader
        const jitter = ((a.id * 0.6180339) % 1) * 6.28;
        let wx, wz, spdMag;
        if (distL > STICK_R) {
          /* Rattrapage : vitesse ≥ Leader pour ne jamais décrocher. */
          const catchup = distL > 5 ? 11.5 : 9.2;
          const perpX = -dzL / distL, perpZ = dxL / distL;
          const wob = Math.sin(elapsed * 1.1 + jitter) * 0.35;
          wx = (dxL / distL + perpX * wob) * catchup;
          wz = (dzL / distL + perpZ * wob) * catchup;
          spdMag = catchup;
        } else {
          /* Micro-orbite autour du Leader. */
          const orbA = jitter + elapsed * 1.4;
          const orbR = 1.4 + ((a.id * 0.371) % 1) * 0.6;
          const tx = lx + Math.cos(orbA) * orbR;
          const tz = lz + Math.sin(orbA) * orbR;
          const dxT = tx - a.x, dzT = tz - a.z;
          const dT = Math.hypot(dxT, dzT) || 1;
          wx = (dxT / dT) * FOLLOWER_SPD;
          wz = (dzT / dT) * FOLLOWER_SPD;
          spdMag = FOLLOWER_SPD;
        }
        /* Anti-blocage sur bord : si la ligne vers le Leader traverse un trou,
           on demande un saut si canJumpToward valide la direction, sinon on
           dévie latéralement (comme les disciples). */
        const nx = wx / (spdMag || 1), nz = wz / (spdMag || 1);
        const blocked = islandPathBlocked(a.x, a.z, lx, lz, 2.6);
        const jumpReady = blocked && canJumpToward(island, a.x, a.z, nx, nz);
        if (blocked && !jumpReady) {
          const side = (a.id & 1) ? 1 : -1;
          const alongX = -nz * side, alongZ = nx * side;
          const bx = alongX * 0.75 + nx * 0.25;
          const bz = alongZ * 0.75 + nz * 0.25;
          const dv = steerOnIsland(a.x, a.z, bx, bz, 2.6, side);
          if (dv.x * dv.x + dv.z * dv.z > 1e-6) { wx = dv.x * spdMag; wz = dv.z * spdMag; }
        } else {
          const steered = steerOnIsland(a.x, a.z, wx, wz, 2.2);
          if (steered.x * steered.x + steered.z * steered.z > 1e-6) {
            wx = steered.x * spdMag; wz = steered.z * spdMag;
          }
        }
        /* Réponse plus vive (dt * 8) pour que le cortège colle vraiment. */
        a.vx += (wx - a.vx) * Math.min(1, dt * 8);
        a.vz += (wz - a.vz) * Math.min(1, dt * 8);
        if ((a.extractProgress || 0) > 0) {
          _setFCol({ r: 1, g: 1, b: 1 });
          a.converting = -1;
          a.convertingDisc = null;
          a.extractProgress = 0;
        }
      }

      a.x += a.vx * dt; a.z += a.vz * dt;
      /* allowJumps=true : les convertis sautent les trous entre tuiles pour
         suivre le Leader (même physique que les disciples). Sans ça ils
         restent bloqués sur les bords quand le Leader saute d'une île à l'autre. */
      resolveIsland(island, a, a.vx, a.vz, dt, true);
      const spd = Math.hypot(a.vx, a.vz);
      if (spd > 0.12) a.face = Math.atan2(a.vx, a.vz);

      tmpQ.setFromAxisAngle(UP_AXIS, a.face || 0);
      if (a._followerSlot != null) {
        tmpS.set(1, 1, 1);
        tmpP.set(a.x, a.y || 0, a.z);
        tmpM.compose(tmpP, tmpQ, tmpS);
        updateFollowerTransform(a, tmpM, spd);
      } else {
        /* Converti sans mesh Leader : caché, pas de paysan fantôme. */
        tmpS.set(0, 0, 0);
        tmpP.set(a.x, 0, a.z);
        tmpM.compose(tmpP, tmpQ, tmpS);
        const cm = crowdOf(a.id), sl = slotOf(a.id);
        cm.setMatrixAt(sl, tmpM);
      }
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
    /* Distance au LEADER le plus proche, mesurée à part. Les disciples
       escortent leur Leader, donc ils sont presque toujours le converter le
       plus proche : sans cette mesure séparée, l'esprit ne voyait jamais le
       Leader arriver et fuyait à l'allure « disciple », bien trop lente. */
    let leaderD = 1e9;
    for (const c of converters) {
      if (c.disc) continue;
      const d = Math.hypot(c.x - a.x, c.z - a.z);
      if (d < leaderD) leaderD = d;
    }
    let fleeR = fromDisciple ? DISC_FLEE_R : FLEE_R;
    if (grayPanic) fleeR *= 1.4;

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
      let fleeSpd = (fromDisciple
        ? 3.6 + urgency * 2.2
        : 4.8 + urgency * 3.8 + crowdFear * 1.2) * (grayPanic ? 1.28 : 1);
      /* Sprint de panique : sous 3,5 unités, l'esprit passe devant un Leader à
         allure normale (7,3 → 9,2). Une simple course-poursuite ne doit RIEN
         donner — on attrape à la toile, ou en l'acculant. Le boost du Leader
         reste plus rapide : il permet de coincer, ce qui déclenche le plongeon
         souterrain (voir updateSpiritDives). */
      if (leaderD < 4.5) fleeSpd = Math.max(fleeSpd, 10.4);

      /* Bias perso stable : la meute s'éventaille au lieu de tout foncer
         dans le même coin / la même péninsule. */
      const personal = ((a.id * 0.6180339) % 1) * 2 - 1;
      const fan = personal * (0.7 + urgency * 0.55)
        + Math.sin(elapsed * 2.1 + a.id * 0.37) * 0.18;

      /* Score plusieurs directions : fuir la menace + rester à l'intérieur
         des tuiles (pas le long du vide). */
      let bestDx = fx, bestDz = fz, bestSc = -1e9;
      const tryAng = [
        fan, fan + 0.45, fan - 0.45, fan + 0.95, fan - 0.95,
        fan + 1.45, fan - 1.45, fan + 2.1, fan - 2.1,
      ];
      for (let ti = 0; ti < tryAng.length; ti++) {
        const ang = tryAng[ti];
        const c = Math.cos(ang), s = Math.sin(ang);
        const dx = fx * c - fz * s;
        const dz = fx * s + fz * c;
        let inland = 0;
        let blocked = false;
        for (const dist of [1.3, 2.6, 4.0, 5.5]) {
          if (isSolid(island, a.x + dx * dist, a.z + dz * dist)) inland += 1.0;
          else { inland -= (dist < 2.8 ? 3.5 : 1.8); blocked = dist < 2.8; break; }
        }
        if (blocked) continue;
        /* Largeur de corridor : pénalise les bords / langues de terre. */
        const side = 1.6;
        if (isSolid(island, a.x - dz * side, a.z + dx * side)) inland += 0.55;
        else inland -= 1.1;
        if (isSolid(island, a.x + dz * side, a.z - dx * side)) inland += 0.55;
        else inland -= 1.1;
        const away = dx * fx + dz * fz;
        const score = away * 2.2 + inland * 1.35 - Math.abs(ang - fan) * 0.12;
        if (score > bestSc) { bestSc = score; bestDx = dx; bestDz = dz; }
      }

      let tx = bestDx * fleeSpd;
      let tz = bestDz * fleeSpd;
      const steered = steerOnIsland(a.x, a.z, tx, tz, 3.6);
      if (steered.x * steered.x + steered.z * steered.z > 1e-6) {
        /* Si le steer dévie vers le vide proche, retomber sur le meilleur score. */
        const sx = steered.x, sz = steered.z;
        const deepOk = isSolid(island, a.x + sx * 4.0, a.z + sz * 4.0);
        if (deepOk || bestSc < -10) {
          tx = sx * fleeSpd;
          tz = sz * fleeSpd;
        } else {
          tx = bestDx * fleeSpd;
          tz = bestDz * fleeSpd;
        }
      }

      /* Micro-séparation : repousser des voisins gris tout proches pour
         éviter le tas dans un coin. */
      let sepX = 0, sepZ = 0, sepN = 0;
      for (let j = 0; j < agents.length; j++) {
        const o = agents[j];
        if (!o || o === a || o.dead) continue;
        if ((o.discipleOf ?? -1) >= 0 || (o.followerOf ?? -1) >= 0) continue;
        const dx = a.x - o.x, dz = a.z - o.z;
        const d2 = dx * dx + dz * dz;
        if (d2 > 2.8 * 2.8 || d2 < 1e-6) continue;
        const d = Math.sqrt(d2);
        const w = (1 - d / 2.8) / d;
        sepX += dx * w; sepZ += dz * w; sepN++;
        if (sepN >= 6) break;
      }
      if (sepN > 0) {
        tx += sepX * (1.8 + urgency);
        tz += sepZ * (1.8 + urgency);
      }

      /* Le trébuchement donne du charme à la fuite de loin, mais à bout portant
         il offrait l'esprit au Leader : ramené à 25 % de sa vitesse une fois par
         seconde, aucun sprint ne tient. On le coupe sous 4,5 unités — c'est là
         que la poursuite doit être perdue d'avance. */
      if (a.stumbleT <= 0 && urgency > 0.4 && leaderD > 5.5
          && Math.random() < dt * (0.35 + urgency)) {
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
      /* Errance : privilégier l'intérieur des tuiles, pas longer le vide. */
      let wBest = -1e9, wX = wx, wZ = wz;
      for (let k = 0; k < 5; k++) {
        const ang = (a.wander || 0) + (k - 2) * 0.55;
        const dx = Math.cos(ang), dz = Math.sin(ang);
        let sc = 0;
        for (const dist of [1.5, 3.0, 4.5]) {
          if (isSolid(island, a.x + dx * dist, a.z + dz * dist)) sc += 1;
          else { sc -= 2; break; }
        }
        if (sc > wBest) { wBest = sc; wX = dx; wZ = dz; }
      }
      wx = wX * 1.1; wz = wZ * 1.1;
      const steered = steerOnIsland(a.x, a.z, wx, wz, 2.8);
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

    const isElemental = typeof variantOf !== 'undefined' ? variantOf(a.id) >= 3 : true;
    const closestF = (CONV_BY_PROXIMITY && isElemental && nearF && nearD < CONV_R) ? nearF : null;
    let scaleMul = 1;
    if (closestF) {
      a.convertingDisc = (nearC && nearC.disc) ? nearC.disc : null;
      if ((a.converting ?? -1) !== closestF.i) {
        a.converting = closestF.i;
        a.extractProgress = 0;
        if (closestF.i === 0) tone(420, 0.04, 'triangle', 0.02);
      }
      a.extractProgress = (a.extractProgress || 0) + dt * (zeal ? 2.35 : 1);
      const ritualNeed = zeal ? CONV_RITUAL_T * 0.55 : CONV_RITUAL_T;
      const u = Math.min(1, a.extractProgress / ritualNeed);
      _convCol.copy(GRAY).lerp(closestF.color, Math.min(1, u * 1.35));
      setAgentColor(a.id, _convCol);
      scaleMul = u < 0.65
        ? 1 + u * 0.14
        : Math.max(0.12, 1.09 * (1 - (u - 0.65) / 0.35));
      if (a.extractProgress >= ritualNeed) {
        finishConvert(a, closestF, a.convertingDisc);
        if (a.dead) continue;
        scaleMul = 1.12;
      }
    } else {
      if (!isElemental && nearF && nearD < 2.2 && (nearF.count || 0) > 0) {
        a.stealCd = (a.stealCd || 0) - dt;
        if (a.stealCd <= 0) {
          a.stealCd = 3.5;
          if (ctx.stealSpiritFromLeader) ctx.stealSpiritFromLeader(nearF);
        }
      }
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
    tmpP.set(a.x, (a.y || 0) + (a.stumbleT > 0 ? 0.05 : 0), a.z);
    tmpM.compose(tmpP, tmpQ, tmpS);
    const cm = crowdOf(a.id), sl = slotOf(a.id);
    cm.setMatrixAt(sl, tmpM);
    const runSpd = inRitual ? 0.15 : Math.hypot(a.vx, a.vz);
    cm.userData.anim.setY(sl, runSpd);
    cm.userData.anim.needsUpdate = true;
  }

  trimCrowdCounts(agents.length);
}
