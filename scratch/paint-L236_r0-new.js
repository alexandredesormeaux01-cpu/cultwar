function drawOrganicSplat(ctx, cx, cz, r) {
  // Forme organique douce, sans satellites (évite le vide)
  ctx.beginPath();
  const steps = 24;
  for (let i = 0; i <= steps; i++) {
    const angle = (i / steps) * Math.PI * 2;
    const wobble = 0.88 + 0.10 * Math.sin(i * 2.3 + cx * 0.03) + 0.04 * Math.sin(i * 5.1);
    const currR = r * wobble;
    const x = cx + Math.cos(angle) * currR;
    const y = cz + Math.sin(angle) * currR;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.fill();
}