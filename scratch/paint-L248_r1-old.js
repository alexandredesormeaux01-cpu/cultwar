function rebuildPaintMask() {
  const half = PAINT_N / 2, k = PAINT_N / PAINT_SPAN;
  const path = new Path2D();
  const hr = HEX_R * k;
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