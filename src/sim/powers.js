/* ============================================================================
   Cult.io — Pouvoirs actifs (Phase 1 : fondations + Prêche)
   ---------------------------------------------------------------------------
   Contrat d'un pouvoir :
     · id, name, icon : identifiants + affichage bouton.
     · category       : 'propagation' | 'offensif' | 'defensif' (info arbre).
     · cost           : coût en points de peinture (fuel) au déclenchement.
     · cooldown       : recharge en secondes.
     · activate(f, ctx) → { kind, ... } ou null si annulé.
       - f       : faction qui invoque.
       - ctx     : { now, spawnEffect(desc) } fournis par main.js.
       - retour  : descripteur d'effet transient (main.js instancie visuel + tick).

   Les descripteurs d'effet sont volontairement plats et sérialisables — utiles
   quand on réseauisera les pouvoirs (Phase multi).
   ========================================================================== */

export const POWER_DEFS = {
  preche: {
    id: 'preche',
    name: 'Prêche',
    icon: '📿',
    category: 'propagation',
    cost: 5,          // points de peinture
    cooldown: 15,     // secondes
    range: 8.5,       // rayon de conversion (mètres)
    duration: 6,      // durée du totem (secondes)
    color: 0xffd166,  // teinte du VFX
    activate(f, ctx) {
      if (!f || !f.alive) return null;
      if ((f.powerCd || 0) > 0) return null;
      if ((f.fuel || 0) < this.cost) return null;
      f.fuel -= this.cost;
      f.powerCd = this.cooldown;
      const lx = f.leader?.x ?? 0;
      const lz = f.leader?.z ?? 0;
      return {
        kind: 'totem',
        power: this.id,
        factionIdx: f.i,
        x: lx,
        z: lz,
        life: this.duration,
        max: this.duration,
        radius: this.range,
        color: this.color,
        tickAcc: 0,      // accumulateur pour la cadence de conversion
        tickRate: 0.35,  // 1 vague de conversion toutes les 0.35s
      };
    },
  },
};

/** Renvoie la définition d'un pouvoir par id, ou null. */
export function getPowerDef(id) {
  return POWER_DEFS[id] || null;
}

/** Décrémente le cooldown d'un pouvoir sur une faction. */
export function tickPowerCd(f, dt) {
  if (!f) return;
  if ((f.powerCd || 0) > 0) {
    f.powerCd = Math.max(0, f.powerCd - dt);
  }
}
