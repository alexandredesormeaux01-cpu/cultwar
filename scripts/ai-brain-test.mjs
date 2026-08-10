/**
 * Profils de difficulté de l'IA — garde-fou de conception.
 *
 * On ne teste pas ici si l'IA joue bien : ça se juge manette en main. On teste
 * les deux règles qui structurent la difficulté, et qu'un simple doigt qui ripe
 * sur un chiffre casserait sans rien faire planter :
 *
 *   1. Aucun niveau ne joue de mauvais coups. La difficulté vient des
 *      CAPACITÉS (AI_STATS) et de la PROFONDEUR de réflexion (AI_MIND), jamais
 *      d'erreurs volontaires ni d'un comportement désactivé.
 *   2. Les deux progressent dans le bon sens.
 *
 * Lancer :  node scripts/ai-brain-test.mjs
 */
import { AI_MIND, AI_STATS, AI_TUNING, brainOf, statsOf } from '../src/sim/ai.js';

let failed = 0;
function check(label, cond) {
  console.log(`${cond ? '  ok  ' : ' FAIL '} ${label}`);
  if (!cond) failed++;
}

const LEVELS = ['easy', 'normal', 'hard'];

/* ---- AI_MIND : la profondeur de réflexion ---- */

const DEPTH = ['horizon', 'recaptureBias', 'contestAversion', 'spiritPlan'];
for (const key of DEPTH) {
  const [e, n, h] = LEVELS.map(l => AI_MIND[l][key]);
  check(`${key} : facile ≤ normal ≤ difficile (${e} ≤ ${n} ≤ ${h})`,
    typeof e === 'number' && e <= n && n <= h);
}

/* La règle qu'on ne doit jamais casser en « simplifiant » un niveau : à zéro,
   un coefficient ampute le raisonnement au lieu de le raccourcir, et le bot
   cesse de jouer une partie du jeu. Même le facile reprend ses statues
   perdues et vise les sanctuaires les moins disputés — juste moins finement. */
for (const l of LEVELS) {
  const zeroed = DEPTH.filter(k => AI_MIND[l][k] <= 0);
  check(`${l} : aucun raisonnement supprimé${zeroed.length ? ' — ' + zeroed.join(', ') : ''}`,
    zeroed.length === 0);
}
check('facile : compare au moins un plan', AI_MIND.easy.horizon >= 1);
check('difficile : compare plusieurs plans', AI_MIND.hard.horizon >= 3);

/* ---- AI_STATS : les capacités, d'où vient l'écart ressenti ---- */

check('normal est calé sur le joueur (référence honnête)',
  AI_STATS.normal.boostCd === 1 && AI_STATS.normal.atkCd === 1 && AI_STATS.normal.speed === 1);

{
  const boost = LEVELS.map(l => AI_STATS[l].boostCd);
  check(`recharge de sprint : de plus en plus courte (${boost.join(' > ')})`,
    boost[0] > boost[1] && boost[1] > boost[2]);
  const atk = LEVELS.map(l => AI_STATS[l].atkCd);
  check(`recharge de tir : de plus en plus courte (${atk.join(' > ')})`,
    atk[0] > atk[1] && atk[1] > atk[2]);
  const spd = LEVELS.map(l => AI_STATS[l].speed);
  check(`vitesse : de plus en plus élevée (${spd.join(' < ')})`,
    spd[0] < spd[1] && spd[1] < spd[2]);
}

/* Garde-fou d'équilibrage : un handicap ou un avantage démesuré ne se lit plus
   comme un niveau de difficulté, mais comme de la triche ou un bot cassé. */
for (const l of LEVELS) {
  const s = AI_STATS[l];
  check(`${l} : capacités dans des bornes jouables`,
    s.speed >= 0.8 && s.speed <= 1.15
    && s.boostCd >= 0.6 && s.boostCd <= 2
    && s.atkCd >= 0.7 && s.atkCd <= 2);
}

/* ---- Mécanique (AI_TUNING) : même sens ---- */
{
  const think = LEVELS.map(l => AI_TUNING[l].think[0]);
  check(`réflexion : de plus en plus rapide (${think.join(' > ')})`,
    think[0] > think[1] && think[1] > think[2]);
  const boost = LEVELS.map(l => AI_TUNING[l].boost);
  check(`sprint : de plus en plus utilisé (${boost.join(' < ')})`,
    boost[0] < boost[1] && boost[1] < boost[2]);
}

/* ---- Replis ---- */
check('difficulté inconnue : repli sur normal', brainOf('bogus') === AI_MIND.normal);
check('difficulté absente : repli sur normal', brainOf(undefined) === AI_MIND.normal);
check('capacités inconnues : repli sur normal', statsOf('bogus') === AI_STATS.normal);

console.log(failed ? `\n${failed} échec(s)` : '\nTout passe.');
process.exit(failed ? 1 : 0);
