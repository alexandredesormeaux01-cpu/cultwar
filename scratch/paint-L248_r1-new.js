function rebuildPaintMask() {
  const half = PAINT_N / 2, k = PAINT_N / PAINT_SPAN;
  const path = new Path2D();
  // Légère inflation : les coins Bézier rentrent, on évite les trous aux sommets
  const hr = HEX_R * k * 1.06;
  for (const t of island.tiles) {
    const cx = t.x * k + half, cz = t.z * k + half;
    addRoundedHex(path, cx, cz, hr, 0.40);
  }
  paintClip = path;