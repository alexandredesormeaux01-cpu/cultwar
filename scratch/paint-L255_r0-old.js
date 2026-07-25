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