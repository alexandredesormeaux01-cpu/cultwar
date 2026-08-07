/* Boucle de la foule : cortèges (fidèles qui suivent leur Leader) et esprits
   libres (fuite, errance, esprits à terre). La conversion elle-même ne vit plus
   ici : elle se joue au tir, dans sim/attacks.js.

   Toutes les dépendances passent par `ctx` : côté client, main.js branche les
   vraies fonctions Three.js ; côté serveur Node, on passe des no-ops et la sim
   tourne headless. */

import {
  FLEE_R,
  FOLLOWER_FLEE_R, FOLLOWER_SPD, FOLLOWER_WANDER_SPD,
  FUEL_MAX,
} from './constants.js';

export function stepCrowd(state, dt, ctx) {
  const {
    agents, factions, island, elapsed, bombs = [],
    grayPanic = false,
  } = state;
  const {
    // physique
    resolveIsland, isSolid, canStep, canJumpToward, steerOnIsland,
    islandApproachScore, islandPathBlocked, islandRandomPoint,
    // rendu / audio (injectés, no-ops sur serveur)
    crowdOf, slotOf, trimCrowdCounts,
    onFreed, // () → main.js recompte un esprit redevenu libre
    onFollowerLostFaction, // (a) → main.js libère le slot follower
    updateFollowerTransform, // (a, mat, spd) → met à jour le mesh follower
    // buffers réutilisables (main.js les partage — un neuf par tick coûterait cher)
    tmpM, tmpQ, tmpS, tmpP, UP_AXIS,
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

  /* « Y a-t-il du sol là-bas, ET peut-on y aller ? »
     `isSolid` seul répond oui des deux côtés d'une falaise : le sol d'en bas est
     bien solide, il est juste inatteignable. Les esprits notaient donc leurs
     directions de fuite avec isSolid pendant que steerOnIsland les filtrait avec
     canStep — au bord d'un à-pic, ils choisissaient le vide, se faisaient
     refuser, et repoussaient dans la falaise à chaque image. C'est exactement le
     tremblement qu'on voyait. Toute décision de déplacement passe désormais par
     ce test-ci, le même que celui du guidage. */
  const reachable = (x0, z0, x1, z1) =>
    isSolid(island, x1, z1) && (!canStep || canStep(island, x0, z0, x1, z1));

  /* Les convertisseurs se réduisent aux Leaders : il n'y a plus de disciples
     pour chasser à leur place. */
  const converters = [];
  for (const f of factions) {
    if (!f.alive) continue;
    /* « Appel du berger » (carte hasard) : les esprits cessent de fuir CE
       Leader. On le retire simplement de la liste des menaces — il devient
       invisible pour le calcul de fuite, sans toucher au reste. */
    if ((f.spiritCallT || 0) > 0) continue;
    converters.push({ f, x: f.leader.x, z: f.leader.z });
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

    /* ========== FOLLOWER : erre tranquillement, fuit les ennemis ========== */
    if ((a.followerOf ?? -1) >= 0) {
      const f = factions[a.followerOf];
      if (!f || !f.alive) {
        onFollowerLostFaction(a);
        a.followerOf = -1;
        a.base = a._origBase || a.base;
        onFreed();
        continue;
      }

      let enemyC = null, enemyD = 1e9;
      for (const c of converters) {
        if (c.f.i === a.followerOf) continue;
        const d = Math.hypot(c.x - a.x, c.z - a.z);
        if (d < enemyD) { enemyD = d; enemyC = c; }
      }

      a.vx = a.vx || 0; a.vz = a.vz || 0;

      /* Plus de vol par simple proximité : un rival qui frôle le cortège ne
         prend rien, il faut lui tirer dessus (voir sim/attacks.js). Le suivant
         n'a donc qu'un comportement face à un ennemi — fuir. */
      if (enemyC && enemyD < FOLLOWER_FLEE_R) {
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
           dévie latéralement. */
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
      }

      a.x += a.vx * dt; a.z += a.vz * dt;
      /* allowJumps=true : les convertis sautent les trous entre tuiles pour
         suivre le Leader. Sans ça ils
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
    /* Tous les convertisseurs sont des Leaders : la distance au plus proche
       suffit désormais, sans mesure séparée. */
    let leaderD = 1e9;
    for (const c of converters) {
      const d = Math.hypot(c.x - a.x, c.z - a.z);
      if (d < leaderD) leaderD = d;
    }
    let fleeR = FLEE_R;
    if (grayPanic) fleeR *= 1.4;

    a.vx = a.vx || 0; a.vz = a.vz || 0;
    a.stumbleT = Math.max(0, (a.stumbleT || 0) - dt);

    if (nearF && nearD < fleeR) {
      const ax = a.x - threatX, az = a.z - threatZ;
      const n = Math.hypot(ax, az) || 1;
      const fx = ax / n, fz = az / n;
      const crowdFear = Math.min(1, (nearF.count || 0) / 35);
      const urgency = Math.min(1, (1 - nearD / fleeR) * (0.75 + crowdFear * 0.45));
      /* Une seule allure de fuite : la variante lente n'existait que face à un
         disciple, dont la poursuite était molle. */
      let fleeSpd = (4.8 + urgency * 3.8 + crowdFear * 1.2) * (grayPanic ? 1.28 : 1);
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
          if (reachable(a.x, a.z, a.x + dx * dist, a.z + dz * dist)) inland += 1.0;
          else { inland -= (dist < 2.8 ? 3.5 : 1.8); blocked = dist < 2.8; break; }
        }
        if (blocked) continue;
        /* Largeur de corridor : pénalise les bords / langues de terre. */
        const side = 1.6;
        if (reachable(a.x, a.z, a.x - dz * side, a.z + dx * side)) inland += 0.55;
        else inland -= 1.1;
        if (reachable(a.x, a.z, a.x + dz * side, a.z - dx * side)) inland += 0.55;
        else inland -= 1.1;
        const away = dx * fx + dz * fz;
        const score = away * 2.2 + inland * 1.35 - Math.abs(ang - fan) * 0.12;
        if (score > bestSc) { bestSc = score; bestDx = dx; bestDz = dz; }
      }

      let tx = bestDx * fleeSpd;
      let tz = bestDz * fleeSpd;
      /* Le guidage a le DERNIER mot. L'ancien code annulait sa correction quand
         elle ne menait pas assez « au large », et réimposait la direction issue
         du scoring — c'est-à-dire précisément celle que le guidage venait de
         juger infranchissable. Au bord d'une falaise, les deux se contredisaient
         à chaque image et l'esprit trépidait sur place. Une direction longeant
         l'à-pic vaut toujours mieux qu'une direction qui n'existe pas. */
      const steered = steerOnIsland(a.x, a.z, tx, tz, 3.6);
      if (steered.x * steered.x + steered.z * steered.z > 1e-6) {
        tx = steered.x * fleeSpd;
        tz = steered.z * fleeSpd;
      }

      /* Micro-séparation : repousser des voisins gris tout proches pour
         éviter le tas dans un coin. */
      let sepX = 0, sepZ = 0, sepN = 0;
      for (let j = 0; j < agents.length; j++) {
        const o = agents[j];
        if (!o || o === a || o.dead) continue;
        if ((o.followerOf ?? -1) >= 0) continue;
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
          if (reachable(a.x, a.z, a.x + dx * dist, a.z + dz * dist)) sc += 1;
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

    /* ---- Anti-blocage ----
       Filet de sécurité, pas la correction principale : celle-ci est en amont,
       dans les directions candidates (voir `reachable`). Il reste des cas qu'un
       scoring ne voit pas — un angle rentrant où toutes les issues longent
       l'à-pic, ou un esprit poussé contre le bord par ses voisins. Sans lui,
       un esprit coincé le reste jusqu'à la fin de la partie et vibre sur place.

       On mesure le déplacement RÉEL : c'est le seul signe fiable. Vouloir avancer
       sans avancer est la définition même d'être coincé, quelle qu'en soit la
       cause — et ça ne demande de comprendre aucune géométrie. */
    a._detourT = Math.max(0, (a._detourT || 0) - dt);
    if (a._detourT > 0) {
      /* Longer l'obstacle au lieu de pousser dedans. On glisse à 90° du cap
         voulu, du côté choisi au moment du blocage. */
      const spd = Math.hypot(a.vx, a.vz) || 2.5;
      const n = spd || 1;
      const nx = a.vx / n, nz = a.vz / n;
      const lat = steerOnIsland(
        a.x, a.z, -nz * a._detourSide, nx * a._detourSide, 3.0, a._detourSide);
      if (lat.x * lat.x + lat.z * lat.z > 1e-6) {
        a.vx = lat.x * spd;
        a.vz = lat.z * spd;
      }
    }

    const prevX = a.x, prevZ = a.z;
    a.x += a.vx * dt; a.z += a.vz * dt;
    resolveIsland(island, a, a.vx, a.vz, dt, false);

    const wanted = Math.hypot(a.vx, a.vz);
    const moved = Math.hypot(a.x - prevX, a.z - prevZ);
    if (wanted > 0.6 && moved < wanted * dt * 0.3) {
      a._stuckT = (a._stuckT || 0) + dt;
      /* 0,35 s : assez long pour ignorer un simple frottement de mur, assez
         court pour que le tremblement ne soit jamais visible à l'œil. */
      if (a._stuckT > 0.35 && a._detourT <= 0) {
        /* Côté du contournement : celui qui est réellement praticable. Si les
           deux le sont, on tranche par l'id — deux esprits côte à côte partent
           alors dans des sens opposés au lieu de se gêner. */
        const n = wanted || 1;
        const nx = a.vx / n, nz = a.vz / n;
        const P = 2.4;
        const leftOk = reachable(a.x, a.z, a.x - nz * P, a.z + nx * P);
        const rightOk = reachable(a.x, a.z, a.x + nz * P, a.z - nx * P);
        a._detourSide = (leftOk && !rightOk) ? 1
          : (rightOk && !leftOk) ? -1
            : ((a.id & 1) ? 1 : -1);
        a._detourT = 0.9;
        a._stuckT = 0;
        /* Repartir de zéro : garder la vitesse qui vient d'échouer ferait
           reprendre le détour dans la direction du mur. */
        a.vx = 0; a.vz = 0;
        /* L'errance repart sur un autre cap, sinon l'esprit revient buter au
           même endroit dès le détour terminé. */
        a.wt = 0;
      }
    } else {
      a._stuckT = 0;
    }

    if (a._lookBack && nearF) {
      a.face = Math.atan2(threatX - a.x, threatZ - a.z);
    } else {
      const spd = Math.hypot(a.vx, a.vz);
      if (spd > 0.12) a.face = Math.atan2(a.vx, a.vz);
    }

    /* Chapardage : les PNJ non élémentaires (paysans, chevaliers) volent un
       esprit au Leader qu'ils croisent. Seul reliquat de l'ancienne conversion
       au contact — la capture, elle, passe par le tir. */
    const isElemental = typeof variantOf !== 'undefined' ? variantOf(a.id) >= 3 : true;
    if (!isElemental && nearF && nearD < 2.2 && (nearF.count || 0) > 0) {
      a.stealCd = (a.stealCd || 0) - dt;
      if (a.stealCd <= 0) {
        a.stealCd = 3.5;
        if (ctx.stealSpiritFromLeader) ctx.stealSpiritFromLeader(nearF);
      }
    }

    tmpQ.setFromAxisAngle(UP_AXIS, a.face || 0);
    const s = a.base * (a.stumbleT > 0 ? 0.92 : 1);
    tmpS.set(s, s, s);
    tmpP.set(a.x, (a.y || 0) + (a.stumbleT > 0 ? 0.05 : 0), a.z);
    tmpM.compose(tmpP, tmpQ, tmpS);
    const cm = crowdOf(a.id), sl = slotOf(a.id);
    cm.setMatrixAt(sl, tmpM);
    const runSpd = Math.hypot(a.vx, a.vz);
    cm.userData.anim.setY(sl, runSpd);
    cm.userData.anim.needsUpdate = true;
  }

  trimCrowdCounts(agents.length);
}
