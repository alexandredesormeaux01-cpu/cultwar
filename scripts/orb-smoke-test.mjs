/* Les orbes sont peintes au canvas 2D, qu'on ne peut pas rasteriser ici. On
   vérifie donc ce qui est vérifiable sans pixels — et qui casse pour de vrai :

   · l'état du contexte est RENDU PROPRE. Sortir de drawOrb en laissant
     globalCompositeOperation à 'lighter' ou globalAlpha à 0,4 saboterait tous
     les dessins suivants sur le même contexte, très loin d'ici et de façon
     incompréhensible. C'est le bug que ce test existe pour attraper.
   · le tracé est DÉTERMINISTE : deux appels doivent produire la même orbe,
     sinon un rechargement changerait l'aspect des projectiles.
   · chaque élément produit bien sa texture, aux bonnes dimensions. */

/* Faux canvas : il enregistre les appels au lieu de peindre. */
function stubCanvas() {
  const calls = [];
  const state = { globalAlpha: 1, globalCompositeOperation: 'source-over', fillStyle: '', strokeStyle: '', lineWidth: 1, lineCap: 'butt' };
  const rec = (name, ...args) => calls.push({ name, args });
  const ctx = new Proxy({
    createRadialGradient: (...a) => { rec('createRadialGradient', ...a); return { addColorStop: (o, c) => rec('addColorStop', o, c) }; },
    beginPath: () => rec('beginPath'),
    closePath: () => rec('closePath'),
    moveTo: (...a) => rec('moveTo', ...a),
    lineTo: (...a) => rec('lineTo', ...a),
    arc: (...a) => rec('arc', ...a),
    ellipse: (...a) => rec('ellipse', ...a),
    fill: () => rec('fill'),
    stroke: () => rec('stroke'),
    fillRect: (...a) => rec('fillRect', ...a),
  }, {
    get: (t, k) => (k in t ? t[k] : state[k]),
    set: (t, k, v) => { state[k] = v; calls.push({ name: 'set:' + String(k), args: [v] }); return true; },
  });
  return { ctx, calls, state, width: 0, height: 0, getContext: () => ctx };
}

const canvases = [];
globalThis.document = {
  createElement: () => {
    const c = stubCanvas();
    canvases.push(c);
    return c;
  },
};

const { drawOrb, drawGlow } = await import('../src/orb-texture.js');

let pass = 0, fail = 0;
const ok = (label, cond) => { if (cond) { pass++; console.log('  ok  ' + label); } else { fail++; console.log('  ÉCHEC  ' + label); } };

const KEYS = ['fire', 'water', 'air', 'light', 'earth', 'ether'];

console.log('\n== les six orbes ==');
for (const key of KEYS) {
  canvases.length = 0;
  const cv = drawOrb(key);
  const c = canvases[0];
  const strokes = c.calls.filter((x) => x.name === 'stroke').length;
  const fills = c.calls.filter((x) => x.name === 'fill').length;
  console.log(`  ${key.padEnd(6)} ${cv.width}×${cv.height}  ${strokes} rubans  ${fills} remplissages`);
  ok(`${key} : dimensions posées`, cv.width === 160 && cv.height === 160);
  ok(`${key} : des rubans sont tracés`, strokes >= 5);
  ok(`${key} : corps + éclat + étincelles remplis`, fills >= 17);
  ok(`${key} : contexte rendu propre (composite)`, c.state.globalCompositeOperation === 'source-over');
  ok(`${key} : contexte rendu propre (alpha)`, c.state.globalAlpha === 1);
}

console.log('\n== déterminisme ==');
{
  canvases.length = 0;
  drawOrb('fire');
  const a = JSON.stringify(canvases[0].calls);
  canvases.length = 0;
  drawOrb('fire');
  const b = JSON.stringify(canvases[0].calls);
  ok('deux tracés identiques', a === b);

  canvases.length = 0;
  drawOrb('water');
  const w = JSON.stringify(canvases[0].calls);
  ok('deux éléments diffèrent', a !== w);
}

console.log('\n== halo ==');
{
  canvases.length = 0;
  const cv = drawGlow(128);
  const c = canvases[0];
  ok('dimensions posées', cv.width === 128 && cv.height === 128);
  ok('dégradé radial créé', c.calls.some((x) => x.name === 'createRadialGradient'));
  ok('quatre paliers de dégradé', c.calls.filter((x) => x.name === 'addColorStop').length === 4);
}

console.log(`\n${pass} réussis, ${fail} échoués`);
process.exit(fail ? 1 : 0);
