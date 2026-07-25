/* Masque de découpe : la peinture s'arrête au bord des tuiles, jamais au-dessus
   du vide. Reconstruit à chaque carte, puisque la silhouette change. */
let paintClip = null;

function rebuildPaintMask() {
  const half = PAINT_N / 2, k = PAINT_N / PAINT_SPAN;
  const path = new Path2D();
  // Hex pleins (pas de coins Bézier) : les arrondis laissaient des trous aux sommets
  const hr = HEX_R * k * 1.02;
  for (const t of island.tiles) {
    const cx = t.x * k + half, cz = t.z * k + half;
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      const px = cx + Math.cos(a) * hr, pz = cz + Math.sin(a) * hr;
      if (i === 0) path.moveTo(px, pz); else path.lineTo(px, pz);
    }
    path.closePath();
  }
  paintClip = path;

  let n = 0;
  const kw = PAINT_SPAN / PAINT_N;
  for (let gz = 0; gz < PAINT_N; gz++) {
    for (let gx = 0; gx < PAINT_N; gx++) {
      const x = (gx + 0.5 - half) * kw, z = (gz + 0.5 - half) * kw;
      if (isSolid(island, x, z)) n++;
    }
  }
  paintTotal = Math.max(1, n);
}

/** Coupe les pixels hors île sans toucher au rendu shader (évite les coupures UV). */
function clipPaintToIsland() {
  if (!paintClip) return;
  paintCtx.save();
  paintCtx.globalCompositeOperation = 'destination-in';
  paintCtx.fillStyle = '#ffffff';
  paintCtx.fill(paintClip);
  paintCtx.restore();
}