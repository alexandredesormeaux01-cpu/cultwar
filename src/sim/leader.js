/* Helpers purs autour du Leader — calculs sans effet de bord.
   `ctx` porte les données transversales (skillMods, accès grille peinture)
   pour éviter les globales cachées. */

import { V_MAX, V_MIN, N_REF, BOOST_MULT, DISCIPLE_MAX_BASE } from './constants.js';

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
  if (f.boostT > 0) v *= BOOST_MULT;
  if (f.slowT > 0) v *= 0.35;
  const groundOwner = ctx.paintOwnerAt(f.leader.x, f.leader.z);
  if (groundOwner === f.team) v *= 1.22;
  else if (groundOwner >= 0 && groundOwner !== f.team) v *= 0.70;
  return v;
}

/** Plafond de disciples actifs pour une faction (bonus « Apôtres » du joueur). */
export function discipleCap(f, ctx) {
  if (!f) return DISCIPLE_MAX_BASE;
  if (f.i === 0) return DISCIPLE_MAX_BASE + (ctx.skillMods.discipleMaxBonus || 0);
  return DISCIPLE_MAX_BASE;
}

/** Le Leader est-il dans sa propre cour ? */
export function inOwnBase(f, teams) {
  const t = teams[f.team];
  if (!t) return false;
  const dx = f.leader.x - t.baseX, dz = f.leader.z - t.baseZ;
  return Math.hypot(dx, dz) < t.wallR - 0.5;
}
