/* Esprits au bord d'une falaise.

   Le bug : un esprit acculé contre un à-pic se mettait à trépider sur place.
   Deux causes qui se renforçaient —
     1. les directions de fuite étaient notées avec `isSolid` (« y a-t-il du sol
        là-bas ? »), alors que le guidage filtrait avec `canStep` (« peut-on y
        aller ? »). Le sol au pied d'une falaise étant bien solide, le scoring
        choisissait le vide ;
     2. quand le guidage corrigeait, crowd-tick ANNULAIT la correction et
        réimposait la direction du scoring. Les deux se contredisaient à chaque
        image, d'où la vibration.
   Et aucun anti-blocage n'existait pour les esprits — seulement pour les Leaders.

   On rejoue donc `stepCrowd` sur un monde synthétique coupé par une falaise
   infranchissable, avec un Leader qui pousse l'esprit dedans.

   Les fonctions d'île sont des doublures : les vraies vivent dans main.js
   (Three.js) et hexmap.js (maillage hexagonal complet). Elles reproduisent la
   SÉMANTIQUE qui compte ici — isSolid ignore le dénivelé, canStep non — ce qui
   est exactement la confusion à l'origine du bug. Ce qui est testé, c'est la
   logique de décision de crowd-tick, pas la géométrie de l'île. */
import { createAgent, createFaction } from '../src/sim/state.js';
import { stepCrowd } from '../src/sim/crowd-tick.js';

let pass = 0, fail = 0;
const ok = (label, cond) => {
  if (cond) { pass++; console.log('  ok  ' + label); }
  else { fail++; console.log('  ÉCHEC  ' + label); }
};

/* ---- Monde : plateau pour x < 0, fond de vallée pour x >= 0.
   La marche est trop haute pour être descendue : la ligne x = 0 est un mur
   invisible, alors que le sol existe des deux côtés. ---- */
const BOUND = 40;
const levelAt = (x) => (x < 0 ? 3 : 0);
const isSolid = (_island, x, z) => Math.abs(x) < BOUND && Math.abs(z) < BOUND;
const canStep = (_island, x0, z0, x1, z1) => {
  if (!isSolid(null, x1, z1)) return false;
  return Math.abs(levelAt(x1) - levelAt(x0)) <= 1;
};

/* Guidage : même forme que le vrai (sondes canStep, repli par écartement
   croissant), en plus court. */
const ANGLES = [0.4, -0.4, 0.85, -0.85, 1.3, -1.3, 1.8, -1.8, 2.4, -2.4, Math.PI];
function steerOnIsland(x, z, wishX, wishZ, lookAhead = 3.2, preferSide = 0) {
  const wn = Math.hypot(wishX, wishZ);
  if (wn < 1e-5) return { x: 0, z: 0 };
  const wx = wishX / wn, wz = wishZ / wn;
  const probe = (dx, dz, d) => canStep(null, x, z, x + dx * d, z + dz * d);
  if (preferSide === 0 && probe(wx, wz, lookAhead) && probe(wx, wz, lookAhead * 0.45)) {
    return { x: wx, z: wz };
  }
  let bx = 0, bz = 0, best = -1e9;
  for (let i = 0; i < ANGLES.length; i++) {
    let ang = ANGLES[i];
    if (preferSide !== 0 && ang * preferSide < 0) ang = -ang;
    const c = Math.cos(ang), s = Math.sin(ang);
    const dx = wx * c - wz * s, dz = wx * s + wz * c;
    if (!probe(dx, dz, lookAhead * 0.4) || !probe(dx, dz, lookAhead)) continue;
    const score = dx * wx + dz * wz;
    if (score > best) { best = score; bx = dx; bz = dz; }
  }
  return best > -1e8 ? { x: bx, z: bz } : { x: 0, z: 0 };
}

/* Collision : on refuse tout pas qui franchit la falaise ou sort du monde.
   C'est CE refus qui produit le blocage — l'esprit garde sa vitesse et la
   repousse contre le mur à chaque image. */
function resolveIsland(_island, e, _vx, _vz, _dt, _jump) {
  if (!isSolid(null, e.x, e.z) || levelAt(e.x) !== levelAt(e._safeX ?? e.x)) {
    e.x = e._safeX ?? 0;
    e.z = e._safeZ ?? 0;
    return false;
  }
  e._safeX = e.x; e._safeZ = e.z;
  e.y = levelAt(e.x);
  return false;
}

const noop = () => {};
const q = { setFromAxisAngle: noop, multiply: noop };
const v = { set: noop, setScalar: noop };
const mesh = { setMatrixAt: noop, userData: { anim: { setY: noop, setXY: noop, needsUpdate: false } } };

function makeCtx() {
  return {
    resolveIsland, isSolid, canStep, steerOnIsland,
    canJumpToward: () => false,
    islandApproachScore: () => 1,
    islandPathBlocked: () => false,
    islandRandomPoint: () => ({ x: -10, z: 0 }),
    crowdOf: () => mesh,
    slotOf: () => 0,
    trimCrowdCounts: noop,
    onFreed: noop,
    onFollowerLostFaction: noop,
    updateFollowerTransform: noop,
    variantOf: () => 3,          // élémentaire
    tmpM: { compose: noop }, tmpQ: q, tmpS: v, tmpP: v,
    tmpQ2: q, SIDE_AXIS: {}, UP_AXIS: {},
  };
}

/**
 * Acculé contre la falaise. Le Leader se tient côté vallée, l'esprit est coincé
 * entre lui et l'à-pic : la seule issue est de LONGER le bord.
 * Rend la trace du déplacement image par image.
 */
function run(ticks = 400, dt = 1 / 60) {
  const f = createFaction(0, 0, { c: 0xff0000, name: 'T' }, 'monk', 6, 0);
  f.alive = true;
  f.count = 0;
  const a = createAgent(1, 0.9, 0, 0, 1);
  a._safeX = a.x; a._safeZ = a.z;

  const state = { agents: [a], factions: [f], island: {}, elapsed: 0, bombs: [] };
  const ctx = makeCtx();

  const steps = [];
  for (let i = 0; i < ticks; i++) {
    /* Le Leader colle l'esprit en restant entre lui et le large. */
    f.leader.x = a.x + 2.6;
    f.leader.z = a.z;
    const px = a.x, pz = a.z;
    state.elapsed += dt;
    stepCrowd(state, dt, ctx);
    steps.push({ moved: Math.hypot(a.x - px, a.z - pz), x: a.x, z: a.z });
  }
  return { a, steps };
}

console.log('\n== esprit acculé contre une falaise ==');
{
  const { a, steps } = run();

  /* Le symptôme visible : de longues séries d'images sans déplacement réel,
     alors que l'esprit veut fuir de toutes ses forces. */
  let worst = 0, cur = 0;
  for (const s of steps) {
    if (s.moved < 0.004) { cur++; worst = Math.max(worst, cur); } else cur = 0;
  }
  const total = steps.reduce((sum, s) => sum + s.moved, 0);
  const frozen = steps.filter((s) => s.moved < 0.004).length;

  console.log(`  distance parcourue : ${total.toFixed(1)} u sur ${steps.length} images`);
  console.log(`  images figées : ${frozen} (${(frozen / steps.length * 100).toFixed(0)} %)`);
  console.log(`  plus longue série figée : ${worst} images (${(worst / 60).toFixed(2)} s)`);

  ok('il finit par s\'échapper le long du bord', total > 12);
  /* Le seuil dit la chose telle qu'on la voit : au-delà d'une demi-seconde
     immobile en pleine fuite, l'œil lit un bug, pas une hésitation. */
  ok('jamais figé plus d\'une demi-seconde', worst < 30);
  ok('il ne passe pas la majorité du temps bloqué', frozen < steps.length * 0.5);

  /* La falaise reste une falaise : la corriger ne doit pas la rendre
     franchissable. */
  ok('il n\'a jamais traversé l\'à-pic', steps.every((s) => s.x >= 0));
  ok('il est resté dans le monde', Math.abs(a.x) < 40 && Math.abs(a.z) < 40);
}

console.log('\n== l\'anti-blocage se désarme tout seul ==');
{
  /* Un esprit au large ne doit jamais partir en détour : le filet de sécurité
     ne doit pas se déclencher sur un simple frottement. */
  const f = createFaction(0, 0, { c: 0xff0000, name: 'T' }, 'monk', 30, 30);
  f.alive = true; f.count = 0;
  const a = createAgent(1, 10, 0, 0, 1);
  a._safeX = a.x; a._safeZ = a.z;
  const state = { agents: [a], factions: [f], island: {}, elapsed: 0, bombs: [] };
  const ctx = makeCtx();
  let detours = 0;
  for (let i = 0; i < 400; i++) {
    state.elapsed += 1 / 60;
    stepCrowd(state, 1 / 60, ctx);
    if ((a._detourT || 0) > 0) detours++;
  }
  console.log(`  images en détour, loin de tout obstacle : ${detours}`);
  ok('aucun détour déclenché en terrain libre', detours === 0);
  ok('l\'esprit a bien erré', Math.hypot(a.x - 10, a.z) > 1);
}

console.log(`\n${pass} réussis, ${fail} échoués`);
process.exit(fail ? 1 : 0);
