/** Couleur CSS → rgba avec alpha (pour dégradé de bord). */
function cssAlpha(css, a) {
  if (typeof css === 'string' && css[0] === '#') {
    let h = css.slice(1);
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    const r = parseInt(h.slice(0, 2), 16);
    const g = parseInt(h.slice(2, 4), 16);
    const b = parseInt(h.slice(4, 6), 16);
    return `rgba(${r},${g},${b},${a})`;
  }
  return css;
}

/**
 * Flaque liquide : silhouette en courbes de Bézier + bord adouci (alpha).
 * Pas de satellites (évite de peindre le vide).
 */
function drawOrganicSplat(ctx, cx, cz, r) {
  const n = 10;
  const pts = [];
  for (let i = 0; i < n; i++) {
    const angle = (i / n) * Math.PI * 2;
    const wobble = 0.86 + 0.11 * Math.sin(i * 2.1 + cx * 0.03)
      + 0.05 * Math.sin(i * 4.7 + cz * 0.02);
    pts.push({
      x: cx + Math.cos(angle) * r * wobble,
      y: cz + Math.sin(angle) * r * wobble,
    });
  }

  ctx.beginPath();
  let mx = (pts[n - 1].x + pts[0].x) * 0.5;
  let my = (pts[n - 1].y + pts[0].y) * 0.5;
  ctx.moveTo(mx, my);
  for (let i = 0; i < n; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % n];
    ctx.quadraticCurveTo(p.x, p.y, (p.x + q.x) * 0.5, (p.y + q.y) * 0.5);
  }
  ctx.closePath();

  const css = ctx.fillStyle;
  const grad = ctx.createRadialGradient(cx, cz, r * 0.42, cx, cz, r * 1.02);
  grad.addColorStop(0, cssAlpha(css, 1));
  grad.addColorStop(0.62, cssAlpha(css, 1));
  grad.addColorStop(0.88, cssAlpha(css, 0.55));
  grad.addColorStop(1, cssAlpha(css, 0));
  ctx.fillStyle = grad;
  ctx.fill();
  ctx.fillStyle = css;
}

/** Hex flat-top aux coins en Bézier (Path2D). `soft` = part d’arête absorbée par le coin. */
function addRoundedHex(path, cx, cz, R, soft = 0.38) {
  const s = Math.min(0.46, Math.max(0.18, soft));
  const V = [];
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    V.push([cx + Math.cos(a) * R, cz + Math.sin(a) * R]);
  }
  for (let i = 0; i < 6; i++) {
    const v0 = V[(i + 5) % 6], v1 = V[i], v2 = V[(i + 1) % 6];
    const pinX = v1[0] + (v0[0] - v1[0]) * s;
    const pinY = v1[1] + (v0[1] - v1[1]) * s;
    const poutX = v1[0] + (v2[0] - v1[0]) * s;
    const poutY = v1[1] + (v2[1] - v1[1]) * s;
    if (i === 0) path.moveTo(pinX, pinY);
    else path.lineTo(pinX, pinY);
    path.quadraticCurveTo(v1[0], v1[1], poutX, poutY);
  }
  path.closePath();
}