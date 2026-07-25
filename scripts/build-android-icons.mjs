/* Génère toutes les icônes Android (ic_launcher, ic_launcher_round,
   ic_launcher_foreground) à partir de public/assets/cult_war_icon.png
   (source carrée 252×252, alpha).
   - ic_launcher / ic_launcher_round : logo pleine taille (padding léger 4%).
   - ic_launcher_foreground : logo réduit dans la « safe area » centrale
     (~66 %), règle Android pour les adaptive icons — sinon les coins du
     splat sont mangés par les masques ronds/squircles des launchers. */

import sharp from 'sharp';
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOGO = path.join(ROOT, 'public/assets/cult_war_icon.png');
const RES = path.join(ROOT, 'android/app/src/main/res');

// Tailles standard Android
const SIZES = { mdpi: 48, hdpi: 72, xhdpi: 96, xxhdpi: 144, xxxhdpi: 192 };
const FG_SIZES = { mdpi: 108, hdpi: 162, xhdpi: 216, xxhdpi: 324, xxxhdpi: 432 };

/* Prépare un logo carré à la taille demandée, avec un padding interne
   proportionnel — 6 % pour l'icône « standard », 25 % pour la version
   foreground (adaptive icon : safe zone centrale de ~66 %). */
async function squareLogo(size, padPct) {
  const inner = Math.round(size * (1 - padPct * 2));
  const buf = await sharp(LOGO)
    .resize({ width: inner, height: inner, fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .toBuffer();
  return sharp({
    create: { width: size, height: size, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .composite([{ input: buf, gravity: 'center' }])
    .png()
    .toBuffer();
}

async function main() {
  for (const [density, size] of Object.entries(SIZES)) {
    const buf = await squareLogo(size, 0.04);
    const dir = path.join(RES, `mipmap-${density}`);
    await fs.writeFile(path.join(dir, 'ic_launcher.png'), buf);
    await fs.writeFile(path.join(dir, 'ic_launcher_round.png'), buf);
    console.log(`✓ mipmap-${density}/ic_launcher(.round).png (${size}px)`);
  }
  for (const [density, size] of Object.entries(FG_SIZES)) {
    const buf = await squareLogo(size, 0.25);
    const dir = path.join(RES, `mipmap-${density}`);
    await fs.writeFile(path.join(dir, 'ic_launcher_foreground.png'), buf);
    console.log(`✓ mipmap-${density}/ic_launcher_foreground.png (${size}px)`);
  }
  // Couleur de fond de l'adaptive icon : violet profond (cf. logo)
  const bgFile = path.join(RES, 'values/ic_launcher_background.xml');
  await fs.writeFile(bgFile,
    `<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">#2A1140</color>\n</resources>\n`);
  console.log('✓ ic_launcher_background couleur violet profond');
}

main().catch((e) => { console.error(e); process.exit(1); });
