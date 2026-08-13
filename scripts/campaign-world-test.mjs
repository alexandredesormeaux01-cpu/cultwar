/* Vérifie que la CAMPAGNE A DES TERRES : chargement de la carte du monde, semis
   des 10 religions, et accessibilité de proche en proche.

   Pourquoi ce test existe : un nettoyage a un jour emporté ensureShapes,
   subdivide, pointInRing et findCountryAt en supprimant un intervalle de lignes
   en bloc. Le build restait vert — esbuild ne résout pas les identifiants
   globaux — et le jeu affichait « Carte du monde indisponible » avec un globe
   entièrement bleu. Aucun test ne couvrait ce chemin. Maintenant si. */

globalThis.matchMedia = () => ({ matches: false });
const store = {};
globalThis.localStorage = {
  getItem: (k) => (k in store ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); },
  removeItem: (k) => { delete store[k]; },
};

/* Le module charge la carte par fetch : on la sert depuis le disque. */
const { readFileSync } = await import('node:fs');
const { fileURLToPath } = await import('node:url');
const { dirname, join } = await import('node:path');
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
globalThis.fetch = async (url) => {
  const rel = String(url).replace(/^\.?\//, '');
  const disk = join(ROOT, 'public', rel);
  try {
    const body = readFileSync(disk, 'utf8');
    return { ok: true, json: async () => JSON.parse(body) };
  } catch {
    return { ok: false, json: async () => ({}) };
  }
};

const { __faithTest: T } = await import('../src/progression.js');

let fails = 0;
const check = (label, cond, detail = '') => {
  if (!cond) { fails++; console.log(`  ÉCHEC — ${label}${detail ? ` (${detail})` : ''}`); }
  else console.log(`  ok — ${label}`);
};

/* ---- 1. La carte du monde se charge et peuple WORLDS ---- */
let shapes = null;
try {
  shapes = await T.ensureShapes();
} catch (e) {
  check('la carte du monde se charge', false, e.message);
}
check('la carte du monde se charge', !!shapes && shapes.length > 0,
  shapes ? `${shapes.length} formes` : 'aucune');

const worlds = T.worlds().filter((w) => w.iso);
check('le globe a ses terres', worlds.length > 100, `${worlds.length} pays`);
check('chaque pays a une population et des coordonnées',
  worlds.every((w) => w.pop > 0 && Number.isFinite(w.lat) && Number.isFinite(w.lon)));

/* Les gros pays doivent être là : c'est sur eux que se joue la campagne. */
for (const iso of ['CHN', 'IND', 'USA', 'BRA', 'RUS']) {
  check(`${iso} est présent sur la carte`, worlds.some((w) => w.iso === iso));
}

/* ---- 2. Le semis donne un pays à chacune des 10 religions ---- */
localStorage.setItem('cultio_progress_v3', JSON.stringify({
  playerName: 'Test', religionName: 'Testisme', playerColor: '#ff2e7e',
  conq: {}, conqPop: {}, ai: {}, seats: {}, decapAt: {},
  skills: {}, skillPoints: 0, level: 0, xp: 0, worldModel: 3, seeded: false,
}));
await T.seedReligionStarts();
const save = JSON.parse(localStorage.getItem('cultio_progress_v3'));

const owners = new Set(Object.values(save.conq).filter((c) => c && c !== '#8b93a7'));
check('les 10 religions ont un pays de départ', owners.size === 10, `${owners.size} cultes semés`);
check('le joueur a un pays de départ', T.countriesOf(save, '#ff2e7e') === 1);
check('le berceau du joueur est enregistré', save.seats['#ff2e7e'] === save.startIso,
  `${save.seats['#ff2e7e']} vs ${save.startIso}`);
check('tous les autres pays sont des terres barbares',
  Object.values(save.conq).filter((c) => c === '#8b93a7').length > 100);

/* ---- 3. On peut effectivement partir à la conquête ---- */
const reachable = worlds.filter((w) => T.canEnterCountry(save, w.iso));
check('au moins un pays est attaquable au premier tour', reachable.length > 0,
  `${reachable.length} pays`);
check('les pays attaquables touchent bien nos terres',
  reachable.every((w) => T.neighborsOf(w.iso).some((n) => T.ownerOf(save, n) === '#ff2e7e')
    || T.neighborsOf(w.iso).length === 0));
check('on ne peut pas attaquer son propre pays',
  !T.canEnterCountry(save, save.startIso));

/* ---- 4. Les cultes sont espacés : chacun a du gris à convertir ---- */
const seatIsos = Object.values(save.seats);
let touching = 0;
for (const a of seatIsos) {
  for (const b of seatIsos) {
    if (a !== b && T.neighborsOf(a).includes(b)) touching++;
  }
}
check('les berceaux ne sont pas collés les uns aux autres', touching === 0,
  `${touching / 2} paires adjacentes`);

console.log(fails ? `\n${fails} test(s) en échec\n` : '\nTous les tests passent\n');
process.exit(fails ? 1 : 0);
