/* Vérifie ce qui casse pour de vrai dans le système de flammes, et qui ne se
   voit pas autrement qu'à l'œil, tard, en jeu :

   · le CONTRAT ENTRE BLENDER ET LE SHADER. flame.glb est un binaire commité,
     produit par blender/flame.py. Si un recuit perd les uv ou renverse la
     flamme, rien ne proteste : on obtient une flamme noire, immobile ou la
     tête en bas, et il faut remonter jusqu'à Blender pour comprendre.
   · l'INDÉPENDANCE DES CHAMPS instanciés. aPhase se pose sur la géométrie, or
     la géométrie est un gabarit partagé par toutes les flammes du jeu. Un
     champ qui l'écrirait en place volerait ses phases au précédent — et le
     symptôme (des flammes qui se resynchronisent) n'apparaît qu'à partir de
     deux champs, donc jamais pendant le développement du premier.
   · le PLACEMENT sur les piliers : la flamme au sommet, la lueur au SOL. Elles
     ont vécu dans le même groupe, et la lueur suivait la flamme en l'air. */

/* pillars.js tire flame.js, qui tire gltf.js, qui tire device.js : celui-ci
   interroge matchMedia dès l'import. */
globalThis.matchMedia = () => ({ matches: false });

import fs from 'node:fs';
import * as THREE from 'three';

let failures = 0;
function check(label, cond, detail = '') {
  if (cond) { console.log(`  ok   ${label}`); return; }
  console.log(`  FAIL ${label}${detail ? ' — ' + detail : ''}`);
  failures++;
}

/* --- 1. Le .glb tient-il le contrat annoncé par blender/flame.py ? --------- */
console.log('flame.glb — contrat avec le shader');
{
  const buf = fs.readFileSync('public/assets/models/flame.glb');
  const jsonLen = buf.readUInt32LE(12);
  const gltf = JSON.parse(buf.subarray(20, 20 + jsonLen).toString());
  const prim = gltf.meshes[0].primitives[0];

  check('TEXCOORD_0 présent (uv.x hauteur, uv.y rang de coque)',
        prim.attributes.TEXCOORD_0 !== undefined);
  check('POSITION présent', prim.attributes.POSITION !== undefined);

  /* Les accesseurs portent min/max : la hauteur se vérifie sans décoder le
     tampon. En Y-up (export_yup), la hauteur est la composante 1. */
  const pos = gltf.accessors[prim.attributes.POSITION];
  check('base de la flamme à l\'origine', Math.abs(pos.min[1]) < 1e-4,
        `y min = ${pos.min[1]}`);
  check('hauteur totale de 1 unité', Math.abs(pos.max[1] - 1) < 1e-4,
        `y max = ${pos.max[1]}`);

  /* glTF n'impose min/max que sur POSITION : les uv, il faut les décoder. Le
     chunk BIN suit le chunk JSON, chacun précédé de sa longueur et de son type
     sur 8 octets, le tout aligné sur 4. */
  const binOff = 20 + jsonLen + 8;
  const readUV = () => {
    const acc = gltf.accessors[prim.attributes.TEXCOORD_0];
    const bv = gltf.bufferViews[acc.bufferView];
    const start = binOff + (bv.byteOffset || 0) + (acc.byteOffset || 0);
    const out = [];
    for (let i = 0; i < acc.count; i++) {
      out.push([buf.readFloatLE(start + i * 8), buf.readFloatLE(start + i * 8 + 4)]);
    }
    return out;
  };
  const uvs = readUV();
  const us = uvs.map((v) => v[0]);
  const vs = uvs.map((v) => v[1]);
  check('uv.x couvre toute la hauteur, de 0 à 1',
        Math.abs(Math.min(...us)) < 1e-4 && Math.abs(Math.max(...us) - 1) < 1e-4,
        `[${Math.min(...us)}, ${Math.max(...us)}]`);
  check('uv.y strictement dans ]0,1[ (rangs de coque centrés)',
        Math.min(...vs) > 0 && Math.max(...vs) < 1,
        `[${Math.min(...vs)}, ${Math.max(...vs)}]`);
  /* Autant de rangs distincts que de coques : c'est ce qui déphase les coques
     entre elles. Un maillage aplati en une seule coque passerait les autres
     contrôles sans rien animer de visible. */
  const rangs = new Set(vs.map((v) => v.toFixed(4))).size;
  check('plusieurs rangs de coque distincts', rangs >= 3, `${rangs} rang(s)`);
}

/* --- 2. Deux champs instanciés ne doivent pas partager leurs phases -------- */
console.log('\ncreateFlameField — indépendance des champs');
{
  const { createFlameField, loadFlame } = await import('../src/flame.js');

  /* Hors navigateur le .glb n'est pas chargeable : loadFlame() bascule sur son
     repli géométrique, ce qui suffit — c'est le partage du gabarit qu'on teste,
     pas sa provenance. */
  await loadFlame();

  const a = createFlameField(8, { color: 0xff6a2a });
  const b = createFlameField(8, { color: 0x3fb6ff });

  const pa = a.geometry.getAttribute('aPhase');
  const pb = b.geometry.getAttribute('aPhase');
  check('chaque champ a son propre attribut aPhase', pa !== pb);
  check('les phases diffèrent d\'un champ à l\'autre',
        pa && pb && [...pa.array].some((v, i) => v !== pb.array[i]));
  check('les phases diffèrent au sein d\'un champ',
        pa && new Set(pa.array).size > 1);

  const solo = (await import('../src/flame.js')).createFlame({});
  check('une flamme isolée ne traîne pas d\'aPhase',
        !solo.geometry.getAttribute('aPhase'));
}

/* --- 3. Piliers : la flamme en haut, la lueur au sol ---------------------- */
console.log('\npillars — placement de la flamme et de la lueur');
{
  const { placePillars, clearPillars, getPillars, TUNE_PILLARS } =
    await import('../src/pillars.js');

  const scene = new THREE.Scene();
  placePillars(scene, {
    groundY: () => 0,
    randomPoint: () => ({ x: (Math.random() - 0.5) * 200, z: (Math.random() - 0.5) * 200 }),
    altarsOf: () => [],
  });

  const ps = getPillars();
  check(`${TUNE_PILLARS.count} piliers posés`, ps.length === TUNE_PILLARS.count);

  let flameOK = 0, glowOK = 0, tinted = 0;
  for (const p of ps) {
    const ud = p.grp.userData;
    if (ud.flame && ud.flame.position.y > TUNE_PILLARS.height) flameOK++;
    /* La lueur est le seul enfant couché à plat. C'est elle qu'on veut au ras
       du sol : plus haut, elle cesse de marquer le pied du pilier. */
    const glow = p.grp.children.find((c) => c.isMesh && Math.abs(c.rotation.x + Math.PI / 2) < 1e-6);
    if (glow && glow.position.y < 0.3) glowOK++;
    /* La teinte d'âme doit avoir atteint la flamme ET la lueur. */
    if (ud.fx && ud.glowMat
        && ud.glowMat.color.getHex() === p.soul.col
        && ud.fx.material.uniforms.uHot.value.getHex() === p.soul.col) tinted++;
  }
  check('flamme au sommet du fût', flameOK === ps.length, `${flameOK}/${ps.length}`);
  check('lueur au ras du sol', glowOK === ps.length, `${glowOK}/${ps.length}`);
  check('teinte d\'âme portée par la flamme et la lueur', tinted === ps.length,
        `${tinted}/${ps.length}`);

  clearPillars(scene);
  check('clearPillars vide la liste', getPillars().length === 0);
}

console.log(failures ? `\n${failures} échec(s)` : '\nTout est vert.');
process.exit(failures ? 1 : 0);
