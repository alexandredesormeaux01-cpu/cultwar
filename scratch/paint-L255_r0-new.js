/**
 * Flaque liquide : Bézier doux, cœur opaque (fusionne les traces),
 * feather très court — évite les encoches de flaques semi-transparentes.
 */
function drawOrganicSplat(ctx, cx, cz, r) {
  const n = 8;
  const pts = [];
  for (let i = 0; i < n; i++) {
    const angle = (i / n) * Math.PI * 2;
    // Peu de wobble : trop d’ondulation = encoches entre stamps
    const wobble = 0.96 + 0.05 * Math.sin(i * 1.7 + cx * 0.02);
    pts.push({
      x: cx + Math.cos(angle) * r * wobble,
      y: cz + Math.sin(angle) * r * wobble,
    });
  }

  ctx.beginPath();
  ctx.moveTo((pts[n - 1].x + pts[0].x) * 0.5, (pts[n - 1].y + pts[0].y) * 0.5);
  for (let i = 0; i < n; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % n];
    ctx.quadraticCurveTo(p.x, p.y, (p.x + q.x) * 0.5, (p.y + q.y) * 0.5);
  }
  ctx.closePath();

  const css = ctx.fillStyle;
  // Cœur plein jusqu’à ~90 %, feather court (fusion propre des chevauchements)
  const grad = ctx.createRadialGradient(cx, cz, r * 0.72, cx, cz, r * 1.0);
  grad.addColorStop(0, cssAlpha(css, 1));
  grad.addColorStop(0.78, cssAlpha(css, 1));
  grad.addColorStop(0.94, cssAlpha(css, 0.85));
  grad.addColorStop(1, cssAlpha(css, 0));
  ctx.fillStyle = grad;
  ctx.fill();
  ctx.fillStyle = css;
}