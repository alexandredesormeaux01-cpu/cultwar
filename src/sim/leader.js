/* Helpers purs autour du Leader — calculs sans effet de bord.
   `ctx` porte les données transversales (skillMods, accès grille peinture)
   pour éviter les globales cachées. */

import { V_MAX, V_MIN, N_REF, BOOST_MULT } from './constants.js';

/** Vitesse courante du Leader d'une faction, tenant compte de la foule portée,
 *  du perso, du boost, du ralenti, et du bonus/malus de territoire.
 *  @param {object} f faction
 *  @param {{skillMods:object, paintOwnerAt:(x:number,z:number)=>number}} ctx */
export function leaderSpeed(f, ctx) {
  const t = Math.min(1, f.count / N_REF);
  let vMax = V_MAX, vMin = V_MIN;
  if (f.i === 0) {
    vMax *= ctx.skillMods.speedMaxMult;
    vMin *= ctx.skillMods.speedMinMult;
  }
  let v = vMax - (vMax - vMin) * t;
  if (f.leaderKey === 'nomad') v *= 1.20;
  /* `spdMul` : allure du niveau de difficulté d'un bot (voir AI_STATS). Absent
     chez le joueur, qui passe par skillMods juste au-dessus. */
  if (f.spdMul) v *= f.spdMul;
  if (f.boostT > 0) v *= BOOST_MULT;
  return v;
}

/** Le Leader est-il dans sa propre cour ? */
export function inOwnBase(f, teams) {
  const t = teams[f.team];
  if (!t) return false;
  const dx = f.leader.x - t.baseX, dz = f.leader.z - t.baseZ;
  return Math.hypot(dx, dz) < t.wallR - 0.5;
}
