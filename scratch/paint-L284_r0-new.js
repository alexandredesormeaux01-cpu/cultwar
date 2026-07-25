/* Masque de découpe : même grille pixel que les tampons (isSolid).
   Pas de texture GPU séparée → évite les coupes horizontales (flipY/UV). */
let paintClipCv = null;

function rebuildPaintMask() {
  const half = PAINT_N / 2;
  const kw = PAINT_SPAN / PAINT_N;
  const solid = new Uint8Array(PAINT_N * PAINT_N);

  let n = 0;
  for (let gz = 0; gz < PAINT_N; gz++) {
    for (let gx = 0; gx < PAINT_N; gx++) {
      const x = (gx + 0.5 - half) * kw, z = (gz + 0.5 - half) * kw;
      if (isSolid(island, x, z)) {
        solid[gz * PAINT_N + gx] = 1;
        n++;
      }
    }
  }
  paintTotal = Math.max(1, n);

  if (!paintClipCv) {
    paintClipCv = document.createElement('canvas');
    paintClipCv.width = paintClipCv.height = PAINT_N;
  }
  const mctx = paintClipCv.getContext('2d');
  const img = mctx.createImageData(PAINT_N, PAINT_N);
  const d = img.data;
  // Feather vers l'intérieur seulement (adoucit les encoches sans déborder le vide)
  const FEATHER = 2.5;
  for (let gz = 0; gz < PAINT_N; gz++) {
    for (let gx = 0; gx < PAINT_N; gx++) {
      const i = gz * PAINT_N + gx;
      const o = i * 4;
      if (!solid[i]) {
        d[o] = d[o + 1] = d[o + 2] = d[o + 3] = 0;
        continue;
      }
      let minD = FEATHER + 1;
      const r0 = Math.ceil(FEATHER);
      for (let dy = -r0; dy <= r0; dy++) {
        for (let dx = -r0; dx <= r0; dx++) {
          const x = gx + dx, y = gz + dy;
          if (x < 0 || y < 0 || x >= PAINT_N || y >= PAINT_N || !solid[y * PAINT_N + x]) {
            const dist = Math.hypot(dx, dy);
            if (dist < minD) minD = dist;
          }
        }
      }
      const a = minD > FEATHER ? 255 : Math.max(0, Math.round(255 * (minD / FEATHER)));
      d[o] = d[o + 1] = d[o + 2] = 255;
      d[o + 3] = a;
    }
  }
  mctx.putImageData(img, 0, 0);
}

/** Coupe les pixels hors île en espace canvas (aligné tampon ↔ masque). */
function clipPaintToIsland() {
  if (!paintClipCv) return;
  paintCtx.save();
  paintCtx.globalCompositeOperation = 'destination-in';
  paintCtx.drawImage(paintClipCv, 0, 0);
  paintCtx.restore();
}