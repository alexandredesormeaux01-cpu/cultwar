/* Vérifie le contrat de la carte à relief sur un grand nombre de graines :
   toute tuile doit être atteignable à pied depuis le centre, et le relief
   doit rester dans ses bornes. Un seul plateau isolé = un bot ou un joueur
   piégé pour la partie, donc c'est un échec dur. */
/* hexmap tire biomes.js, qui tire device.js : celui-ci interroge matchMedia dès
   l'import. On le neutralise avant de charger le module — le test ne porte que
   sur la génération, pas sur le rendu. */
globalThis.matchMedia = () => ({ matches: false });
const { generateIsland, STEP_H } = await import('../src/hexmap.js');

const DIRS = [[1, -1], [1, 0], [0, 1], [-1, 1], [-1, 0], [0, -1]];
const key = (q, r) => (q + 1000) * 10000 + (r + 1000);
const CLIMB = 1;
const N = Number(process.argv[2] || 300);

let fails = 0, tilesTotal = 0, levelHist = {}, cliffs = 0, ramps = 0, jumpOnly = 0, minT = 1e9, maxT = 0;

for (let s = 0; s < N; s++) {
  const island = generateIsland({ biomeKey: 'temperate', maxR: 60, seed: s });
  const { byKey, tiles } = island;
  tilesTotal += tiles.length;
  minT = Math.min(minT, tiles.length);
  maxT = Math.max(maxT, tiles.length);

  /* BFS strictement pédestre depuis la tuile la plus centrale. */
  let start = tiles[0];
  for (const t of tiles) if (t.d < start.d) start = t;
  const seen = new Set([key(start.q, start.r)]);
  const stack = [start];
  while (stack.length) {
    const t = stack.pop();
    for (const [dq, dr] of DIRS) {
      /* À pied d'abord. Le bond n'est admis que là où la silhouette ne laisse
         pas le choix : une tuile isolée au milieu d'une fosse (jumpOnly). */
      const nb = byKey.get(key(t.q + dq, t.r + dr));
      if (nb) {
        if (Math.abs(nb.level - t.level) > CLIMB) continue;
        const k = key(nb.q, nb.r);
        if (!seen.has(k)) { seen.add(k); stack.push(nb); }
        continue;
      }
      const far = byKey.get(key(t.q + dq * 2, t.r + dr * 2));
      if (far && far.jumpOnly && far.level - t.level <= CLIMB + 1) {
        const k = key(far.q, far.r);
        if (!seen.has(k)) { seen.add(k); stack.push(far); }
      }
    }
  }

  const orphans = tiles.filter((t) => !seen.has(key(t.q, t.r)));
  if (orphans.length) {
    fails++;
    console.log(`  ÉCHEC graine ${s} : ${orphans.length}/${tiles.length} tuiles inatteignables`);
  }

  for (const t of tiles) {
    levelHist[t.level] = (levelHist[t.level] || 0) + 1;
    if (Math.abs(t.h - t.level * STEP_H) > 1e-9) { fails++; console.log(`  ÉCHEC graine ${s} : h désynchronisé de level`); break; }
    if (t.ramp) ramps++;
    if (t.jumpOnly) jumpOnly++;
    for (let i = 0; i < 6; i++) if ((t.wall || 0) & (1 << i)) cliffs++;
  }
}

const dist = Object.keys(levelHist).sort().map((k) => `n${k}:${(levelHist[k] / tilesTotal * 100).toFixed(0)}%`).join('  ');
console.log(`\n${N} cartes — tuiles ${minT}–${maxT} (moy ${(tilesTotal / N).toFixed(0)})`);
console.log(`niveaux : ${dist}`);
console.log(`falaises : ${(cliffs / N).toFixed(1)} arêtes/carte  |  rampes : ${(ramps / N).toFixed(1)}  |  îlots au saut : ${(jumpOnly / N).toFixed(2)}`);
console.log(fails ? `\n${fails} ÉCHECS` : '\nOK — toutes les tuiles atteignables à pied sur toutes les graines');
process.exit(fails ? 1 : 0);
