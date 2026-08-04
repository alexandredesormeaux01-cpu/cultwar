/* Un agent absorbé par un sanctuaire est RECYCLÉ pour un nouvel esprit : le
   même objet resert, en gardant sa place dans les InstancedMesh.

   Le piège : convertToFollower calcule `base = _origBase * FOLLOWER_SCALE` en
   posant `_origBase` à la taille courante s'il est vide. Si le recyclage ne
   restaure pas la taille, chaque vie repart de la taille réduite de la
   précédente et la remultiplie par 0,55 — les esprits rapetissent tout au long
   de la partie, sans que rien ne signale l'erreur.

   On simule donc plusieurs cycles vie → conversion → absorption → recyclage. */
import { createAgent, resetAgent } from '../src/sim/state.js';
import { FOLLOWER_SCALE } from '../src/sim/constants.js';

let pass = 0, fail = 0;
const ok = (label, cond) => { if (cond) { pass++; console.log('  ok  ' + label); } else { fail++; console.log('  ÉCHEC  ' + label); } };

/* Reproduit convertToFollower côté main.js. */
function convert(a) {
  if (!a._origBase) a._origBase = a.base;
  a.base = a._origBase * FOLLOWER_SCALE;
}

console.log('\n== taille au fil des recyclages ==');
{
  const SPAWN = 0.97;
  const a = createAgent(0, 0, 0, 0, SPAWN);
  a._spawnBase = a.base;          // posé par spawnAgent après le bonus chevalier

  const enCortege = [];
  for (let vie = 1; vie <= 8; vie++) {
    ok(`vie ${vie} : taille au spawn intacte`, Math.abs(a.base - SPAWN) < 1e-9);
    convert(a);
    enCortege.push(a.base);
    resetAgent(a, 0, 0, 0);       // absorbé par l'autel, puis recyclé
  }

  const first = enCortege[0], last = enCortege[enCortege.length - 1];
  console.log(`  taille en cortège : ${first.toFixed(3)} → ${last.toFixed(3)} sur 8 vies`);
  ok('la taille en cortège ne dérive pas', Math.abs(first - last) < 1e-9);
  ok('elle vaut bien le spawn × FOLLOWER_SCALE', Math.abs(first - SPAWN * FOLLOWER_SCALE) < 1e-9);
}

console.log('\n== recyclage en plein plongeon ==');
{
  const a = createAgent(1, 0, 0, 0, 1.0);
  a._spawnBase = a.base;
  a._dive = 0.2;                  // plongeon en cours
  a._diveMoved = true;
  a.base = 0.3;                   // à moitié avalé par le trou
  resetAgent(a, 0, 0, 0);
  ok('la taille est restaurée', Math.abs(a.base - 1.0) < 1e-9);
  ok('le plongeon est annulé', a._dive === null && a._diveMoved === false);
}

console.log(`\n${pass} réussis, ${fail} échoués`);
process.exit(fail ? 1 : 0);
