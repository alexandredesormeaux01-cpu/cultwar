/* Vérifie que le hub d'un pays est un LIEU, pas un tirage.
   Deux chargements du hub d'un même pays doivent donner exactement la même
   île ; deux pays différents doivent en donner de différentes. C'est ce qui
   permet d'ancrer des visuels de quête à des coordonnées connues — sans ça,
   un repère posé sur « la colline nord » désigne un endroit qui n'existe plus
   au chargement suivant. */
globalThis.matchMedia = () => ({ matches: false });
const { generateIsland } = await import('../src/hexmap.js');
const { isoSeed } = await import('../src/sim/rng.js');

/* Signature d'une île : tout ce qui se voit. Position et hauteur suffisent à
   attraper une silhouette ou un relief qui aurait bougé ; on ajoute rampes et
   falaises, qui sont la lecture du terrain. */
function signature(island) {
  return island.tiles
    .map((t) => `${t.q},${t.r},${t.level},${t.ramp ? 1 : 0},${t.wall || 0},${t.open || 0}`)
    .join('|');
}

const ISOS = ['FRA', 'JPN', 'PER', 'EGY', 'CAN', 'BRA', 'NOR', 'IND', 'AUS', 'MEX'];
let fails = 0;

/* 1. Reproductibilité : même pays, même hub. */
const sigs = new Map();
for (const iso of ISOS) {
  const a = signature(generateIsland({ maxR: 60, seed: isoSeed(iso) }));
  const b = signature(generateIsland({ maxR: 60, seed: isoSeed(iso) }));
  if (a !== b) {
    fails++;
    console.log(`  ÉCHEC ${iso} : deux générations diffèrent`);
  }
  sigs.set(iso, a);
}

/* 2. Distinction : deux pays ne doivent pas partager leur hub. Une collision
      passerait inaperçue en jeu jusqu'à ce qu'un joueur remarque que deux
      pays ont la même vallée. */
const seen = new Map();
for (const [iso, sig] of sigs) {
  if (seen.has(sig)) {
    fails++;
    console.log(`  ÉCHEC : ${iso} et ${seen.get(sig)} ont le même hub`);
  }
  seen.set(sig, iso);
}

/* 3. La graine elle-même ne doit pas dériver : ces valeurs sont gravées dans
      les hubs existants. Si elles changent, tous les hubs sont redessinés et
      les repères de quête déjà posés tombent à côté. */
const PINNED = { FRA: 1051869328, JPN: 1753121147, PER: 4026601156 };
for (const [iso, want] of Object.entries(PINNED)) {
  const got = isoSeed(iso);
  if (got !== want) {
    fails++;
    console.log(`  ÉCHEC graine ${iso} : ${got} au lieu de ${want}`);
  }
}

console.log(`\n${ISOS.length} pays testés — ${sigs.size} hubs distincts`);
console.log(fails ? `\n${fails} ÉCHECS` : '\nOK — chaque pays a son hub, stable d’un chargement à l’autre');
process.exit(fails ? 1 : 0);
