/* ============================================================================
   Optimisation des images — PNG/JPG → WebP
   ----------------------------------------------------------------------------
   Les cartes d'événement et les portraits sortent des outils de génération en
   PNG 24 bits non compressé : ~1,7 Mo pièce pour une vignette qui ne dépasse
   jamais ~600 px à l'écran. C'est le premier poste de poids de l'APK Android,
   très loin devant le code (1 Mo).

   On borne la dimension puis on ré-encode en WebP (qualité 82, alpha conservé).
   Gain typique : 1,7 Mo → 60 Ko, sans différence visible à la taille d'affichage.

   Le PNG d'origine est SUPPRIMÉ : garder les deux doublerait le poids embarqué,
   et l'original reste dans l'historique git si besoin.

   Usage : node scripts/optimize-images.mjs [--dry]
   ========================================================================== */
import sharp from 'sharp';
import fs from 'node:fs';
import path from 'node:path';

const DRY = process.argv.includes('--dry');

/* Chaque cible dit sa taille maximale d'affichage réelle. Une carte
   d'événement occupe au plus la moitié d'un écran mobile ; un avatar de HUD
   quelques dizaines de pixels. */
const TARGETS = [
  { dir: 'public/assets/events', max: 640, quality: 82 },
  { dir: 'public/assets', max: 768, quality: 82, filter: (f) => /_leader\.png$|_avatar\.png$/.test(f) },
];

const KB = (n) => `${(n / 1024).toFixed(0)} Ko`;

let totalBefore = 0, totalAfter = 0, count = 0;

for (const t of TARGETS) {
  if (!fs.existsSync(t.dir)) continue;
  const files = fs.readdirSync(t.dir)
    .filter((f) => /\.(png|jpe?g)$/i.test(f))
    .filter((f) => (t.filter ? t.filter(f) : true));

  for (const file of files) {
    const src = path.join(t.dir, file);
    const out = src.replace(/\.(png|jpe?g)$/i, '.webp');
    const before = fs.statSync(src).size;

    const buf = await sharp(src)
      .resize({ width: t.max, height: t.max, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: t.quality })
      .toBuffer();

    totalBefore += before;
    totalAfter += buf.length;
    count++;
    console.log(`  ${file}  ${KB(before)} → ${KB(buf.length)}`);

    if (!DRY) {
      fs.writeFileSync(out, buf);
      fs.unlinkSync(src);
    }
  }
}

console.log(`\n${count} images : ${(totalBefore / 1024 / 1024).toFixed(1)} Mo → ${(totalAfter / 1024 / 1024).toFixed(1)} Mo`
  + (DRY ? '  (simulation)' : ''));
