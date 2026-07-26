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
    activate(f, slot) {
      if (!f || !f.alive) return null;
      if ((f.powerCds?.[slot] || 0) > 0) return null;
      if ((f.fuel || 0) < this.cost) return null;
      f.fuel -= this.cost;
      f.powerCds[slot] = this.cooldown;
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

  sanctuaire: {
    id: 'sanctuaire',
    name: 'Sanctuaire',
    icon: '⬢',
    category: 'defensif',
    cost: 4,
    cooldown: 18,
    range: 5.2,       // rayon du dôme (mètres)
    duration: 4,      // durée d'immunité (secondes)
    color: 0x7cd6ff,  // bleu cyan — se distingue du doré du Prêche
    activate(f, slot) {
      if (!f || !f.alive) return null;
      if ((f.powerCds?.[slot] || 0) > 0) return null;
      if ((f.fuel || 0) < this.cost) return null;
      f.fuel -= this.cost;
      f.powerCds[slot] = this.cooldown;
      const lx = f.leader?.x ?? 0;
      const lz = f.leader?.z ?? 0;
      return {
        kind: 'shield',
        power: this.id,
        factionIdx: f.i,
        x: lx,
        z: lz,
        life: this.duration,
        max: this.duration,
        radius: this.range,
        color: this.color,
        follow: true,   // suit le Leader plutôt que de rester posé
      };
    },
  },

  anatheme: {
    id: 'anatheme',
    name: 'Anathème',
    icon: '☠',
    category: 'offensif',
    cost: 6,
    cooldown: 22,
    range: 25,         // portée de verrouillage sur un Leader adverse (mètres)
    duration: 8,       // durée du drain (secondes)
    drainRate: 2,      // fuel/s soutirés à la cible
    color: 0xff3355,   // rouge sang — signature offensive
    activate(f, slot, ctx) {
      if (!f || !f.alive) return null;
      if ((f.powerCds?.[slot] || 0) > 0) return null;
      if ((f.fuel || 0) < this.cost) return null;
      const factions = ctx?.factions;
      if (!factions) return null;
      /* Auto-lock sur le Leader adverse le plus proche dans la portée. */
      const lx = f.leader?.x ?? 0;
      const lz = f.leader?.z ?? 0;
      const r2 = this.range * this.range;
      let bestIdx = -1, bestD2 = Infinity;
      for (const other of factions) {
        if (!other || !other.alive || other.i === f.i) continue;
        if (!other.leader) continue;
        const dx = other.leader.x - lx, dz = other.leader.z - lz;
        const d2 = dx * dx + dz * dz;
        if (d2 > r2 || d2 > bestD2) continue;
        bestIdx = other.i; bestD2 = d2;
      }
      if (bestIdx < 0) return null;   // rien à portée → n'entame ni cd ni coût
      f.fuel -= this.cost;
      f.powerCds[slot] = this.cooldown;
      return {
        kind: 'curse',
        power: this.id,
        casterIdx: f.i,
        targetIdx: bestIdx,
        life: this.duration,
        max: this.duration,
        drainRate: this.drainRate,
        color: this.color,
      };
    },
  },
};

/** Renvoie la définition d'un pouvoir par id, ou null. */
export function getPowerDef(id) {
  return POWER_DEFS[id] || null;
}

/** Décrémente les cooldowns de tous les slots d'une faction. */
export function tickPowerCds(f, dt) {
  if (!f || !f.powerCds) return;
  for (let i = 0; i < f.powerCds.length; i++) {
    if (f.powerCds[i] > 0) f.powerCds[i] = Math.max(0, f.powerCds[i] - dt);
  }
}
