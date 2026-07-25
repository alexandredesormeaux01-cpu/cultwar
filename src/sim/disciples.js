/* Helpers purs pour les disciples (villageois convertis qui chassent et
   convertissent à leur tour). Toutes les fonctions ici sont sans effet
   de bord et sans dépendance externe — safe pour Node et navigateur. */

import { DISC_XP_TO_NEXT, DISC_LVL_MAX, DISC_SPD } from './constants.js';

export function discXpNeed(lvl) {
  return DISC_XP_TO_NEXT[lvl] || 0;
}

export function discSpeedMul(a) {
  const l = a.discLvl || 1;
  if (l >= 3) return 1.1 * 1.2;
  if (l >= 2) return 1.1;
  return 1;
}

export function discPaintMul(a) {
  return discSpeedMul(a);
}

export function discSpd(a) {
  return DISC_SPD * discSpeedMul(a);
}

export function discXpFrac(a) {
  const lvl = a.discLvl || 1;
  if (lvl >= DISC_LVL_MAX) return 1;
  const need = discXpNeed(lvl);
  return need > 0 ? Math.min(1, (a.discXp || 0) / need) : 1;
}
