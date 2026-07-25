const fs = require('fs');
const hist = fs.readFileSync('C:/Cult.io/scratch/hist-8lUA.js-drawMinimap.js', 'utf8');
const oldBlock = `  // --- Sceptiques : la ressource à récolter, tous gris ---
  const dot = 1.7 * k;
  mctx.fillStyle = GRAY_CSS;
  mctx.globalAlpha = 0.65;
  for (const a of agents) {
    if (a.dead) continue;
    mctx.fillRect(c + a.x * s - dot / 2, c + a.z * s - dot / 2, dot, dot);
  }
  mctx.globalAlpha = 1;`;
const newBlock = `  // --- Sceptiques (gris) + disciples (couleur de culte) ---
  const dot = 1.7 * k;
  for (const a of agents) {
    if (a.dead) continue;
    const fi = a.discipleOf ?? -1;
    if (fi >= 0 && factions[fi]) {
      mctx.fillStyle = factions[fi].css;
      mctx.globalAlpha = 0.9;
    } else {
      mctx.fillStyle = GRAY_CSS;
      mctx.globalAlpha = 0.65;
    }
    mctx.fillRect(c + a.x * s - dot / 2, c + a.z * s - dot / 2, dot, dot);
  }
  mctx.globalAlpha = 1;`;
if (!hist.includes(oldBlock)) {
  console.log('OLD BLOCK NOT FOUND');
  const i = hist.indexOf('Sceptiques');
  console.log(JSON.stringify(hist.slice(i, i+200)));
  process.exit(1);
}
const patched = hist.replace(oldBlock, newBlock);
fs.writeFileSync('C:/Cult.io/scratch/recovered-drawMinimap-FINAL.js', patched);
console.log('ok', patched.length);
