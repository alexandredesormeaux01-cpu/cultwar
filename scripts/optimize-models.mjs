/* ============================================================================
   Optimisation des modèles glTF — deux passes, zéro perte visible sur desktop
   ----------------------------------------------------------------------------
   Le poids des .glb est à 99 % de la géométrie brute (float32 non compressé) :
   les textures sont déjà en WebP 512. On agit donc sur les buffers, pas sur
   l'apparence.

   Passe 1 — « hi » (toutes plateformes, in-place) :
     dedup + weld + prune + quantification + compression EXT_meshopt.
     La silhouette et les UV sont préservés au bit près à l'échelle du jeu :
     la quantification 16 bits sur une bbox de ~2 unités = 0,03 mm d'erreur.
     Gain typique : 12 Mo → ~1,5 Mo, sans toucher au rendu.

   Passe 2 — « lo » (mobile uniquement, dans models/lo/) :
     idem + simplification meshoptimizer sous contrainte d'erreur.
     Les bords ouverts sont verrouillés (lockBorder) pour que le contour noir
     — un shell BackSide extrudé le long des normales — reste lisse et fermé.
     Les props statiques très denses (sanctuaire 412 k tris, terrier 285 k)
     descendent bien plus bas que les personnages, qui gardent leur silhouette.

   Sur les modèles riggés, la simplification réduit aussi la largeur de la
   texture VAT (une colonne par sommet) : le vrai gain VRAM sur mobile.

   Usage : node scripts/optimize-models.mjs [--dry]
   ========================================================================== */
import { NodeIO, PropertyType } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dedup, prune, weld, join, simplify, meshopt } from '@gltf-transform/functions';
import { MeshoptSimplifier, MeshoptEncoder, MeshoptDecoder } from 'meshoptimizer';
import fs from 'node:fs';
import path from 'node:path';

const SRC = 'public/assets/models';
const LO = path.join(SRC, 'lo');
const DRY = process.argv.includes('--dry');

/* ---- --only=<fichier.glb> ----
   Ce script travaille EN PLACE, et le dossier models/ est sa propre source :
   il n'existe nulle part de version non compressée où repartir. Chaque
   exécution relit donc des données déjà quantifiées et les requantifie. L'écart
   est infime (16 bits sur ~2 unités), mais il s'accumule à chaque passage.

   Après une opération sur UN modèle — une cuisson d'occlusion, par exemple —
   on veut recompresser celui-là et seulement lui. Sans cette option, il
   faudrait refaire passer les vingt autres dans la moulinette pour rien. */
const ONLY = (process.argv.find((a) => a.startsWith('--only=')) || '').slice(7);

/* Ratio de simplification de la variante mobile, par modèle.
   Les props statiques sont vus de loin et très denses → on coupe fort.
   Les personnages sont proches de la caméra → on reste conservateur pour
   que le contour cartoon garde ses courbes. */
const LO_RATIO = {
  'sanctuary_base.glb': 0.18,
  'burrow_hole.glb': 0.20,
  'trees.glb': 0.5,
  _character: 0.55,   // tous les riggés (VAT)
  _default: 0.6,
};

/* Modèles effectivement référencés par le jeu (voir src/main.js). */
const MODELS = [
  'sanctuary_base.glb', 'burrow_hole.glb', 'trees.glb', 'grass.glb', 'paint_crystal.glb',
  'peasant_woman.glb', 'peasant_blocky.glb', 'knight_blocky.glb',
  'monk_rigged.glb', 'sorcerer_rigged.glb', 'nomad_rigged.glb',
  'amazon_rigged.glb', 'alien_rigged.glb', 'chief_rigged.glb',
  'elemental_rigged.glb', 'elemental_air_rigged.glb', 'elemental_earth_rigged.glb',
  'elemental_ether_rigged.glb', 'elemental_light_rigged.glb', 'elemental_water_rigged.glb',
];

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
  'meshopt.encoder': MeshoptEncoder,
  'meshopt.decoder': MeshoptDecoder,   // relire un .glb déjà compressé (idempotence)
});

const mb = (n) => (n / 1e6).toFixed(2) + ' Mo';

function stats(doc) {
  let v = 0, tri = 0;
  for (const m of doc.getRoot().listMeshes()) {
    for (const p of m.listPrimitives()) {
      v += p.getAttribute('POSITION').getCount();
      const idx = p.getIndices();
      tri += (idx ? idx.getCount() : p.getAttribute('POSITION').getCount()) / 3;
    }
  }
  return { v, tri: Math.round(tri) };
}

/* join() fusionne les primitives — interdit sur les modèles riggés (il casse
   l'association squelette/primitive) et sur ceux dont on lit les sous-meshes. */
function isSkinned(doc) {
  return doc.getRoot().listSkins().length > 0;
}

/* prune() par défaut jette le Skin et les Animations des modèles riggés (il les
   croit orphelins) — ce qui ferait retourner null à bakeVAT, donc plus aucun
   personnage à l'écran. On ne nettoie que ce qui est sûrement inerte. */
const SAFE_PRUNE = {
  propertyTypes: [
    PropertyType.NODE, PropertyType.MESH, PropertyType.MATERIAL,
    PropertyType.TEXTURE, PropertyType.ACCESSOR, PropertyType.BUFFER,
  ],
  keepAttributes: false,
  keepLeaves: false,
};

await MeshoptSimplifier.ready;
await MeshoptEncoder.ready;
await MeshoptDecoder.ready;

if (!DRY) fs.mkdirSync(LO, { recursive: true });

let hiBefore = 0, hiAfter = 0, loAfter = 0;

const TARGETS = ONLY ? MODELS.filter((f) => f === ONLY) : MODELS;
if (ONLY && !TARGETS.length) {
  console.error(`--only=${ONLY} : absent de la liste MODELS`);
  process.exit(1);
}

for (const file of TARGETS) {
  const src = path.join(SRC, file);
  if (!fs.existsSync(src)) { console.warn(`  ⚠ absent : ${file}`); continue; }
  const before = fs.statSync(src).size;
  hiBefore += before;

  /* ---------- passe 1 : hi ---------- */
  const doc = await io.read(src);
  const skinned = isSkinned(doc);
  const s0 = stats(doc);

  await doc.transform(
    dedup(),
    weld(),
    ...(skinned ? [] : [join()]),
    prune(SAFE_PRUNE),
    meshopt({ encoder: MeshoptEncoder, level: 'high' }),
  );
  const hiBuf = await io.writeBinary(doc);
  hiAfter += hiBuf.byteLength;
  if (!DRY) fs.writeFileSync(src, hiBuf);

  /* ---------- passe 2 : lo (mobile) ---------- */
  const ratio = LO_RATIO[file] ?? (skinned ? LO_RATIO._character : LO_RATIO._default);
  const lodDoc = await io.read(src);
  await lodDoc.transform(
    weld(),
    simplify({ simplifier: MeshoptSimplifier, ratio, error: 0.002, lockBorder: true }),
    prune(SAFE_PRUNE),
    meshopt({ encoder: MeshoptEncoder, level: 'high' }),
  );
  const s1 = stats(lodDoc);
  const loBuf = await io.writeBinary(lodDoc);
  loAfter += loBuf.byteLength;
  if (!DRY) fs.writeFileSync(path.join(LO, file), loBuf);

  console.log(
    `${file.padEnd(30)} ${mb(before).padStart(9)} → hi ${mb(hiBuf.byteLength).padStart(9)}`
    + ` | lo ${mb(loBuf.byteLength).padStart(9)}  tris ${s0.tri} → ${s1.tri}`,
  );
}

console.log(`\nTotal : ${mb(hiBefore)} → hi ${mb(hiAfter)} (+ lo ${mb(loAfter)} pour mobile)`);
if (DRY) console.log('(--dry : aucun fichier écrit)');
