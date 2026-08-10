/* ============================================================================
   Cult.io — Attaques à distance
   ---------------------------------------------------------------------------
   Remplace l'aspiration comme geste principal. La boucle tient en trois temps :

     tirer  →  la cible tombe face au sol  →  on la ramasse en passant dessus

   Deux cibles, un même projectile :
     · un ESPRIT touché s'effondre quelques secondes. Il ne fuit plus, et le
       premier Leader qui lui marche dessus l'emporte. C'est ce qui rend la
       chasse nerveuse : on ne tire plus sur la corde, on vise puis on court.
     · un LEADER touché s'effondre aussi et lâche un esprit de son cortège.
       L'esprit lâché tombe au sol comme les autres : celui qui a tiré doit
       encore aller le chercher, donc un bon tir ouvre une occasion, il ne
       vole pas la prise tout seul.

   La visée est ASSISTÉE : le tir part vers la cible la plus proche dans un
   cône devant le Leader. Sur mobile, le jeu se joue au pouce — exiger une
   visée libre rendrait l'attaque inutilisable là où le jeu est joué.

   Module de simulation pur : aucun Three.js. main.js branche les effets
   visuels et sonores par `ctx`.
   ========================================================================== */

export const ATTACK_CD = 0.85;        // recharge entre deux tirs (s)
export const ATTACK_SPEED = 30;       // vitesse du projectile (u/s)
export const ATTACK_RANGE = 20;       // portée avant dissipation (u)
export const ATTACK_HIT_R = 1.15;     // rayon de collision
export const AIM_ARC = 0.75;          // demi-angle du cône de visée (~43°)

/* ---- Pourquoi l'assistance est PARTIELLE ----
   Un tir corrigé à 100 % sur la position de la cible ne rate jamais : le
   projectile devient une tête chercheuse et le geste ne vaut plus rien. On
   applique donc l'essentiel de la correction, jamais la totalité, et on ajoute
   une dispersion qui grandit avec la distance. La cible, elle, continue de se
   déplacer pendant le vol — un esprit qui fuit peut sortir de la trajectoire.
   Résultat : viser reste facile, toucher n'est jamais acquis. */
export const AIM_ASSIST = 0.82;       // part de la correction réellement appliquée
export const AIM_SPREAD = 0.055;      // dispersion à bout portant (rad, ~3°)
export const AIM_SPREAD_FAR = 0.075;  // dispersion ajoutée à portée maximale
export const SPIRIT_DOWN_T = 3.2;     // temps au sol d'un esprit touché (s)
export const LEADER_DOWN_T = 1.5;     // temps au sol d'un Leader touché (s)
export const COLLECT_R = 2.2;         // distance de ramassage d'un esprit à terre

/* Les projectiles vivent dans un tableau que main.js lit pour le rendu. */
export const projectiles = [];

export function clearProjectiles() { projectiles.length = 0; }

/** Cible retenue par la visée assistée, ou null. `ctx` fournit agents,
 *  factions, variantOf et ELEM_FIRST. */
export function pickTarget(f, facing, ctx) {
  const { agents, factions, variantOf, ELEM_FIRST } = ctx;
  const L = f.leader;
  const fx = Math.sin(facing), fz = Math.cos(facing);
  const cosArc = Math.cos(AIM_ARC);

  let best = null, bestD = Infinity;
  const consider = (x, z, obj) => {
    const dx = x - L.x, dz = z - L.z;
    const d = Math.hypot(dx, dz);
    if (d > ATTACK_RANGE || d < 1e-3) return;
    if ((dx / d) * fx + (dz / d) * fz < cosArc) return;
    if (d < bestD) { bestD = d; best = obj; }
  };

  /* Les Leaders adverses passent avant : à distance égale, on préfère
     bousculer un rival — c'est le coup qui rapporte le plus. */
  for (const o of factions) {
    if (!o || !o.alive || o === f || !o.leader) continue;
    if ((o.downT || 0) > 0) continue;                 // déjà à terre
    consider(o.leader.x, o.leader.z, { kind: 'leader', ref: o });
  }
  if (best) return best;

  for (const a of agents) {
    if (!a || a.dead) continue;
    if (variantOf(a.id) < ELEM_FIRST) continue;       // seuls les esprits
    if ((a.followerOf ?? -1) === f.i) continue;       // déjà à nous
    if ((a.downT || 0) > 0) continue;                 // déjà à terre
    consider(a.x, a.z, { kind: 'spirit', ref: a });
  }
  return best;
}

/** Déclenche un tir. Retourne le projectile créé, ou null si en recharge. */
export function fireAttack(f, facing, ctx) {
  if (!f || !f.alive) return null;
  if ((f.atkCd || 0) > 0) return null;
  if ((f.downT || 0) > 0) return null;               // à terre : on ne tire pas
  /* Deux multiplicateurs, et il faut les garder séparés :
     · `atkCdMul`  temporaire, posé par la carte « Main leste », remis à 1 à
                   l'expiration ;
     · `atkCdBase` permanent, la cadence du niveau de difficulté d'un bot
                   (voir AI_STATS).
     Les confondre ferait effacer le second à la fin de la carte, et un bot
     facile se retrouverait avec la cadence du joueur pour le reste du match. */
  f.atkCd = ATTACK_CD * (f.atkCdMul ?? 1) * (f.atkCdBase ?? 1);

  /* Visée assistée : on se rapproche de la cible sans jamais l'épouser.
     Tirer dans le vide reste permis — sans ça le bouton semblerait cassé
     quand rien n'est en vue. */
  const rng = ctx.rng || Math.random;
  const target = pickTarget(f, facing, ctx);
  let angle = facing;
  let spread = AIM_SPREAD;

  if (target) {
    const t = target.kind === 'leader' ? target.ref.leader : target.ref;
    const ax = t.x - f.leader.x, az = t.z - f.leader.z;
    const d = Math.hypot(ax, az) || 1;
    const want = Math.atan2(ax, az);
    /* Écart ramené dans [-π, π] : sans ça un tir vers l'arrière corrigerait
       dans le mauvais sens en passant par le grand tour. */
    let diff = want - facing;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    angle = facing + diff * AIM_ASSIST;
    spread += AIM_SPREAD_FAR * Math.min(1, d / ATTACK_RANGE);
  }

  /* Dispersion : deux tirages moyennés, donc des écarts groupés autour du
     centre plutôt qu'uniformes — on rate de peu bien plus souvent que de
     beaucoup, ce qui se lit comme une main qui tremble et non comme un
     hasard arbitraire. */
  const jitter = ((rng() + rng()) - 1) * spread * (ctx.spreadMult ?? 1);
  angle += jitter;
  const dx = Math.sin(angle), dz = Math.cos(angle);

  const p = {
    x: f.leader.x, z: f.leader.z, y: (f.leader.y || 0) + 1.15,
    dx, dz,
    from: f.i,
    life: ATTACK_RANGE / ATTACK_SPEED,
    dead: false,
  };
  projectiles.push(p);
  if (ctx.onFire) ctx.onFire(f, p);
  return p;
}

/** Avance les projectiles, résout les impacts. */
export function stepProjectiles(dt, ctx) {
  const { agents, factions, variantOf, ELEM_FIRST, groundY } = ctx;

  for (let i = projectiles.length - 1; i >= 0; i--) {
    const p = projectiles[i];
    p.life -= dt;
    if (p.life <= 0) { p.dead = true; }

    if (!p.dead) {
      p.x += p.dx * ATTACK_SPEED * dt;
      p.z += p.dz * ATTACK_SPEED * dt;
      /* Le projectile suit le relief : au-dessus d'un plateau il doit rester à
         hauteur de poitrine, sinon il file dans la roche ou passe trop haut. */
      if (groundY) p.y = groundY(p.x, p.z) + 1.15;

      const R2 = ATTACK_HIT_R * ATTACK_HIT_R;

      /* --- Leader adverse --- */
      for (const o of factions) {
        if (!o || !o.alive || o.i === p.from || !o.leader) continue;
        if ((o.downT || 0) > 0) continue;
        const dx = o.leader.x - p.x, dz = o.leader.z - p.z;
        if (dx * dx + dz * dz > R2) continue;
        knockDownLeader(o, factions[p.from], ctx);
        p.dead = true;
        break;
      }
      if (p.dead) { if (ctx.onImpact) ctx.onImpact(p); projectiles.splice(i, 1); continue; }

      /* --- Esprit libre --- */
      for (const a of agents) {
        if (!a || a.dead) continue;
        if (variantOf(a.id) < ELEM_FIRST) continue;
        if ((a.followerOf ?? -1) === p.from) continue;
        if ((a.downT || 0) > 0) continue;
        const dx = a.x - p.x, dz = a.z - p.z;
        if (dx * dx + dz * dz > R2) continue;
        knockDownSpirit(a, ctx, factions[p.from] || null);
        p.dead = true;
        break;
      }
    }

    if (p.dead) {
      if (ctx.onImpact) ctx.onImpact(p);
      projectiles.splice(i, 1);
    }
  }
}

/** Un esprit touché s'effondre : plus de fuite, plus de plongeon.
 *  `by` = la faction qui a tiré, transmise aux effets : l'impact se teinte de
 *  l'élément du tireur, sans quoi on ne lit pas QUI vient de marquer le coup. */
export function knockDownSpirit(a, ctx, by = null) {
  a.downT = SPIRIT_DOWN_T;
  a.vx = 0; a.vz = 0;
  /* Un esprit arraché à un cortège redevient libre — c'est le coup qui punit
     celui qui traîne une longue file derrière lui. */
  if ((a.followerOf ?? -1) >= 0 && ctx.releaseFollower) ctx.releaseFollower(a);
  /* Le plongeon souterrain est une échappatoire : à terre, elle est coupée. */
  if (a._dive != null && ctx.cancelDive) ctx.cancelDive(a);
  if (ctx.onSpiritDown) ctx.onSpiritDown(a, by);
}

/** Un Leader touché s'effondre et lâche un esprit. */
export function knockDownLeader(o, by, ctx) {
  o.downT = LEADER_DOWN_T;
  o.leader.dx = 0; o.leader.dz = 0;
  const lost = ctx.dropOneFollower ? ctx.dropOneFollower(o) : null;
  if (lost) knockDownSpirit(lost, ctx, by);
  if (ctx.onLeaderDown) ctx.onLeaderDown(o, by, lost);
}

/** Décompte des états « à terre » et de la recharge. À appeler chaque tick. */
export function tickDownStates(factions, agents, dt) {
  for (const f of factions) {
    if (!f) continue;
    if (f.atkCd > 0) f.atkCd = Math.max(0, f.atkCd - dt);
    if (f.downT > 0) f.downT = Math.max(0, f.downT - dt);
  }
  for (const a of agents) {
    if (!a || a.dead) continue;
    if (a.downT > 0) a.downT = Math.max(0, a.downT - dt);
  }
}

/** Ramassage : un Leader qui passe sur un esprit à terre l'emporte. */
export function collectDowned(factions, agents, ctx) {
  const { variantOf, ELEM_FIRST, finishConvert } = ctx;
  const R2 = COLLECT_R * COLLECT_R;
  for (const a of agents) {
    if (!a || a.dead || !(a.downT > 0)) continue;
    if (variantOf(a.id) < ELEM_FIRST) continue;

    let best = null, bestD = R2;
    for (const f of factions) {
      if (!f || !f.alive || !f.leader) continue;
      if ((f.downT || 0) > 0) continue;              // à terre, on ne ramasse pas
      if ((a.followerOf ?? -1) === f.i) continue;
      const dx = f.leader.x - a.x, dz = f.leader.z - a.z;
      const d2 = dx * dx + dz * dz;
      if (d2 < bestD) { bestD = d2; best = f; }
    }
    if (!best) continue;
    a.downT = 0;
    finishConvert(a, best);
    if (ctx.onCollect) ctx.onCollect(a, best);
  }
}
