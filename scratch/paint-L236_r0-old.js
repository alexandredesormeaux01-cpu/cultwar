function drawOrganicSplat(ctx, cx, cz, r) {
  // Disque doux, contenu dans le rayon (pas de satellites hors tuile)
  ctx.beginPath();
  const steps = 20;
  for (let i = 0; i <= steps; i++) {
    const angle = (i / steps) * Math.PI * 2;
    const wobble = 0.92 + Math.sin(i * 1.7 + cx * 0.01) * 0.05;
    const currR = r * wobble;
    const x = cx + Math.cos(angle) * currR;
    const y = cz + Math.sin(angle) * currR;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.fill();
}