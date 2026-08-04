/* Vérifie la boucle d'attaque de bout en bout, sans rendu :
   tirer → la cible tombe → on la ramasse. Et le cas Leader : tombe + lâche
   un esprit. Ce sont les trois promesses faites au joueur ; si l'une saute,
   l'attaque ne vaut rien. */
import {
  projectiles, clearProjectiles, fireAttack, stepProjectiles, pickTarget,
  tickDownStates, collectDowned, ATTACK_CD, SPIRIT_DOWN_T, LEADER_DOWN_T,
} from '../src/sim/attacks.js';

const ELEM_FIRST = 3;
let pass = 0, fail = 0;
const ok = (label, cond) => { if (cond) { pass++; console.log('  ok  ' + label); } else { fail++; console.log('  ÉCHEC  ' + label); } };

function mkSpirit(id, x, z) {
  return { id, x, z, vx: 0, vz: 0, dead: false, downT: 0, followerOf: -1 };
}
function mkFaction(i, x, z) {
  return { i, alive: true, count: 0, downT: 0, atkCd: 0, leader: { x, z, y: 0, dx: 0, dz: 0 } };
}
function mkCtx(agents, factions, extra = {}) {
  return {
    agents, factions,
    variantOf: (id) => (id === 0 ? 0 : ELEM_FIRST),   // id 0 = villageois, le reste = esprits
    ELEM_FIRST,
    finishConvert: (a, f) => { a.followerOf = f.i; f.count++; },
    /* Aléa neutralisé : la dispersion est testée à part, les cas de base
       doivent rester déterministes. */
    rng: () => 0.5,
    releaseFollower: (a) => { a.followerOf = -1; },
    dropOneFollower: (o) => agents.find((a) => a.followerOf === o.i) || null,
    ...extra,
  };
}

console.log('\n== tir sur un esprit ==');
{
  clearProjectiles();
  const spirit = mkSpirit(1, 0, 10);
  const f = mkFaction(0, 0, 0);
  const agents = [spirit], factions = [f];
  const ctx = mkCtx(agents, factions);

  ok('une cible droit devant est retenue', pickTarget(f, 0, ctx)?.ref === spirit);
  ok('le tir part', !!fireAttack(f, 0, ctx));
  ok('recharge armée', f.atkCd === ATTACK_CD);
  ok('second tir refusé pendant la recharge', fireAttack(f, 0, ctx) === null);

  let frames = 0;
  while (projectiles.length && frames++ < 200) stepProjectiles(1 / 60, ctx);
  ok('le projectile atteint sa cible', spirit.downT > 0);
  ok('durée au sol correcte', Math.abs(spirit.downT - SPIRIT_DOWN_T) < 1e-9);
  ok('le projectile est consommé', projectiles.length === 0);
}

console.log('\n== ramassage ==');
{
  const spirit = mkSpirit(1, 0, 1.5);
  spirit.downT = SPIRIT_DOWN_T;
  const f = mkFaction(0, 0, 0);
  const agents = [spirit], factions = [f];
  const ctx = mkCtx(agents, factions);
  collectDowned(factions, agents, ctx);
  ok('un esprit à terre à portée est récolté', spirit.followerOf === 0 && f.count === 1);

  const far = mkSpirit(2, 0, 40);
  far.downT = SPIRIT_DOWN_T;
  const ctx2 = mkCtx([far], factions);
  collectDowned(factions, [far], ctx2);
  ok('hors de portée, rien n\'est récolté', far.followerOf === -1);
}

console.log('\n== tir sur un Leader ==');
{
  clearProjectiles();
  const shooter = mkFaction(0, 0, 0);
  const victim = mkFaction(1, 0, 10);
  const stolen = mkSpirit(1, 0, 11);
  stolen.followerOf = 1;
  victim.count = 1;
  const agents = [stolen], factions = [shooter, victim];
  const ctx = mkCtx(agents, factions);

  ok('un Leader adverse est prioritaire sur un esprit', pickTarget(shooter, 0, ctx)?.kind === 'leader');
  fireAttack(shooter, 0, ctx);
  let frames = 0;
  while (projectiles.length && frames++ < 200) stepProjectiles(1 / 60, ctx);

  ok('le Leader touché tombe', victim.downT === LEADER_DOWN_T);
  ok('il lâche un esprit', stolen.followerOf === -1);
  ok('l\'esprit lâché est au sol', stolen.downT > 0);
  ok('le tireur ne récolte pas automatiquement', stolen.followerOf === -1);
}

console.log('\n== décomptes ==');
{
  const f = mkFaction(0, 0, 0);
  f.downT = 1.0; f.atkCd = 0.5;
  const a = mkSpirit(1, 0, 0); a.downT = 1.0;
  for (let i = 0; i < 70; i++) tickDownStates([f], [a], 1 / 60);
  ok('l\'état à terre du Leader expire', f.downT === 0);
  ok('la recharge revient à zéro', f.atkCd === 0);
  ok('l\'esprit se relève', a.downT === 0);
}

console.log('\n== on ne tire pas à terre ==');
{
  clearProjectiles();
  const f = mkFaction(0, 0, 0);
  f.downT = 1.0;
  const spirit = mkSpirit(1, 0, 10);
  const ctx = mkCtx([spirit], [f]);
  ok('un Leader à terre ne peut pas tirer', fireAttack(f, 0, ctx) === null);
}

/* La dispersion est le cœur du réglage : un tir qui ne rate jamais rend le
   geste gratuit, un tir qui rate souvent rend le jeu pénible. On mesure donc
   le taux de touche réel sur cible IMMOBILE, à deux distances. */
console.log('\n== dispersion : on peut rater ==');
{
  const rate = (dist, shots = 600) => {
    let hits = 0;
    for (let n = 0; n < shots; n++) {
      clearProjectiles();
      const spirit = mkSpirit(1, 0, dist);
      const f = mkFaction(0, 0, 0);
      const ctx = mkCtx([spirit], [f], { rng: Math.random });
      fireAttack(f, 0, ctx);
      let frames = 0;
      while (projectiles.length && frames++ < 300) stepProjectiles(1 / 60, ctx);
      if (spirit.downT > 0) hits++;
    }
    return hits / shots;
  };

  const near = rate(6), far = rate(17);
  console.log(`  touche à 6 u  : ${(near * 100).toFixed(0)} %`);
  console.log(`  touche à 17 u : ${(far * 100).toFixed(0)} %`);
  ok('à bout portant on touche presque toujours', near > 0.9);
  ok('à longue portée on rate parfois', far < 0.9);
  ok('à longue portée on touche quand même souvent', far > 0.45);
  ok('la portée dégrade la précision', far < near);
}

console.log(`\n${pass} réussis, ${fail} échoués`);
process.exit(fail ? 1 : 0);
