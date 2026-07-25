/* Seeded PRNG — mulberry32.
   Utilisé partout où la simulation a besoin d'aléatoire pour rester
   déterministe (rejouable côté serveur, prédictible côté client).
   Le rendu (particules, secousse caméra) peut continuer à utiliser
   Math.random librement — il n'affecte pas l'état partagé. */

export function createRng(seed = 1) {
  let s = (seed >>> 0) || 1;
  const rng = {
    next() {
      s |= 0; s = (s + 0x6D2B79F5) | 0;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    },
    range(min, max) { return min + rng.next() * (max - min); },
    int(minInclusive, maxExclusive) {
      return (minInclusive + rng.next() * (maxExclusive - minInclusive)) | 0;
    },
    pick(arr) { return arr[(rng.next() * arr.length) | 0]; },
    chance(p) { return rng.next() < p; },
    angle() { return rng.next() * Math.PI * 2; },
    /* Sérialisation : le serveur peut envoyer l'état interne du RNG au client
       pour qu'il rejoue la même séquence en prédiction. */
    getState() { return s >>> 0; },
    setState(v) { s = (v >>> 0) || 1; },
  };
  return rng;
}
