/* Interface d'effets — le pont entre la simulation pure et le rendu.

   La simulation ne connaît ni Three.js, ni le DOM, ni l'audio. Quand elle
   veut déclencher un effet observable (changer la couleur d'un agent, jouer
   un son, montrer une bannière), elle appelle une méthode de `effects`.

   Côté client, main.js installe des vraies implémentations qui poussent
   dans Three.js/DOM/soundEngine. Côté serveur, on garde les no-ops par
   défaut — la sim tourne headless sans rien changer.

   Deux styles cohabitent :
   1. Actions "en direct" (setAgentColor, hideAgent, sound) — l'implémentation
      est un simple callback qu'on appelle immédiatement.
   2. Événements bufferisés (via emit/drain) — utile quand le serveur veut
      envoyer un batch au client pour synchro. Non utilisé au démarrage,
      mais l'API est prête pour Phase 2/3. */

export function createEffects() {
  const listeners = new Map();
  const buffer = [];   // événements collectés pour un tick, drainables

  const noop = () => {};

  const eff = {
    /* --- Actions "en direct" : par défaut no-op, main.js installe les vraies --- */
    agentColor: noop,       // (agentId, colorHex) : recolorer une instance foule
    hideAgent: noop,        // (agentId) : cacher (mort/absorbé)
    shock: noop,            // (x, z, colorHex, maxR, dur)
    soulBurst: noop,        // (x, z, factionIdx)
    splash: noop,           // (x, z, r, teamIdx, css)
    particle: noop,         // (x, y, z, colorHex, opts)
    sound: noop,            // (name, opts)
    footstep: noop,         // (x, z, kind)
    banner: noop,           // (text)
    streakBump: noop,       // (streak, palier)
    hudDirty: noop,         // () — marquer HUD à recomposer
    shake: noop,            // (amount)
    slowmo: noop,           // (dur)
    endGame: noop,          // (forced)

    /* --- Événements bufferisés (Phase 2+, réseau) --- */
    emit(type, data) {
      buffer.push({ type, data });
      const ls = listeners.get(type);
      if (ls) for (const fn of ls) fn(data);
    },
    on(type, fn) {
      let ls = listeners.get(type);
      if (!ls) { ls = []; listeners.set(type, ls); }
      ls.push(fn);
    },
    drain() {
      const out = buffer.slice();
      buffer.length = 0;
      return out;
    },

    /* Installer les vraies implémentations depuis main.js.
       Appel unique après création des systèmes de rendu. */
    install(impls) {
      for (const k of Object.keys(impls)) {
        if (typeof impls[k] === 'function') eff[k] = impls[k];
      }
    },
  };

  return eff;
}

/* Instance partagée par toute la sim. main.js l'installe après le boot du
   rendu ; le futur serveur Node l'importe sans jamais appeler install(). */
export const effects = createEffects();
