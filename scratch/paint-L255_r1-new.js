function stampPaint(f) {
  const half = PAINT_N / 2, k = PAINT_N / PAINT_SPAN;
  // Trait plus large : ruban liquide sous la foule
  const r = Math.max(2.1, crowdRadius(f.count, f.i) * 1.32) * k;
  const cx = f.leader.x * k + half, cz = f.leader.z * k + half;
  const gx0 = Math.max(0, Math.floor(cx - r * 1.25)), gx1 = Math.min(PAINT_N - 1, Math.ceil(cx + r * 1.25));
  const gz0 = Math.max(0, Math.floor(cz - r * 1.25)), gz1 = Math.min(PAINT_N - 1, Math.ceil(cz + r * 1.25));
  const r2 = r * r;
  const kw = PAINT_SPAN / PAINT_N;

  let gridChanged = false;
  for (let gz = gz0; gz <= gz1; gz++) {
    for (let gx = gx0; gx <= gx1; gx++) {
      const dx = gx + 0.5 - cx, dz = gz + 0.5 - cz;
      if (dx * dx + dz * dz > r2 * 1.15) continue;