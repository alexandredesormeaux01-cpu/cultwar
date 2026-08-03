/* ============================================================================
   Élagage des assets pour l'APK Android
   ----------------------------------------------------------------------------
   `modelURL()` (src/gltf.js) redirige TOUS les modèles de LO_AVAILABLE vers
   assets/models/lo/ dès que IS_MOBILE. Un APK n'est jamais lu par autre chose
   qu'un mobile : embarquer aussi les versions haute densité, c'est doubler le
   poids des modèles pour des fichiers que le code n'ouvrira jamais.

   On agit sur dist/ APRÈS le build et AVANT `cap sync`, jamais sur public/ :
   le build web garde ses assets complets.

   La liste vient de src/gltf.js — on la lit plutôt que de la recopier, pour
   qu'un modèle ajouté là ne soit pas oublié ici.

   Usage : node scripts/prune-android-assets.mjs [--dry]
   ========================================================================== */
import fs from 'node:fs';
import path from 'node:path';

const DRY = process.argv.includes('--dry');
const DIST = 'dist';
const MODELS = path.join(DIST, 'assets/models');

if (!fs.existsSync(MODELS)) {
  console.error(`[prune] ${MODELS} absent — lance "vite build" d'abord.`);
  process.exit(1);
}

/* Source de vérité : le Set LO_AVAILABLE de src/gltf.js. */
const gltfSrc = fs.readFileSync('src/gltf.js', 'utf8');
const block = gltfSrc.match(/LO_AVAILABLE\s*=\s*new Set\(\[([\s\S]*?)\]\)/);
if (!block) {
  console.error('[prune] LO_AVAILABLE introuvable dans src/gltf.js — abandon.');
  process.exit(1);
}
const loNames = [...block[1].matchAll(/'([^']+\.glb)'/g)].map((m) => m[1]);

let freed = 0, dropped = 0, missing = 0;
for (const name of loNames) {
  const hi = path.join(MODELS, name);
  const lo = path.join(MODELS, 'lo', name);
  /* Sans la variante lo, supprimer la version hi rendrait le modèle
     introuvable sur mobile : on garde. */
  if (!fs.existsSync(lo)) { missing++; console.warn(`  ! pas de lo/ pour ${name} — conservé`); continue; }
  if (!fs.existsSync(hi)) continue;

  freed += fs.statSync(hi).size;
  dropped++;
  if (!DRY) fs.unlinkSync(hi);
}

console.log(`[prune] ${dropped} modèles hi retirés de l'APK, ${(freed / 1024 / 1024).toFixed(1)} Mo`
  + (missing ? `, ${missing} conservés faute de variante lo` : '')
  + (DRY ? '  (simulation)' : ''));
