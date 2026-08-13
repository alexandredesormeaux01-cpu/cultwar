/* L'escorte est une simulation : elle a un état qui se traîne d'une image à
   l'autre, et ses défauts sont des dérives, pas des exceptions. Rien n'y lève
   jamais — on regarde donc ce qu'elle FAIT sur des centaines d'images :

   · elle RATTRAPE un joueur qui court. C'est la seule exigence dure : une
     escorte distancée disparaît de l'écran et la fonctionnalité n'existe plus.
     La longueur des bonds suit la distance à rattraper précisément pour ça, et
     c'est le genre de réglage qu'un ajustement d'humeur casse sans bruit.
   · elle SAUTE vraiment, au lieu de glisser. Une régression qui laisserait la
     parabole à plat passerait totalement inaperçue dans le code.
   · elle SUIT L'INVENTAIRE : une âme posée s'en va, une âme prise arrive.
   · elle reste AU SOL — jamais enterrée, jamais en lévitation entre deux bonds.
   · elle n'apparaît QUE dans le monde des esprits. C'est la règle du GDD que
     cette fonctionnalité aurait pu casser : en chair, elle dirait aux rivaux
     ce que le joueur transporte. */

globalThis.matchMedia = () => ({ matches: false });

import * as THREE from 'three';

let failures = 0;
function check(label, cond, detail = '') {
  if (cond) { console.log(`  ok   ${label}`); return; }
  console.log(`  FAIL ${label}${detail ? ' — ' + detail : ''}`);
  failures++;
}

const { updateSoulEscort, clearSoulEscort, getSoulEscort, TUNE_ESCORT } =
  await import('../src/soulEscort.js');
const { addSoul, consumeSelected, selectSlot, resetSouls } = await import('../src/souls.js');
const { SOULS } = await import('../src/pillars.js');
const { loadFlame } = await import('../src/flame.js');
const { V_MAX } = await import('../src/sim/constants.js');
const { TUNE_SPIRIT } = await import('../src/spiritform.js');

/* La vitesse à tenir n'est pas un chiffre choisi ici : c'est celle du joueur en
   esprit, prise à sa source. Le jour où le Leader accélère, ce test échoue —
   c'est précisément ce qu'on lui demande, puisque l'escorte décrocherait. */
const SPIRIT_RUN = V_MAX * TUNE_SPIRIT.speedMul * 1.20;   // 1.20 = le nomade

await loadFlame();   // hors navigateur : bascule sur le repli géométrique

const scene = new THREE.Scene();
const GROUND = 3.0;                     // sol non nul : piège à « y » oublié
const st = () => ({
  scene, px: player.x, pz: player.z, py: GROUND,
  spiritBlend: 1, groundY: () => GROUND,
});
const player = { x: 0, z: 0 };
const DT = 1 / 60;

/* --- 1. L'escorte suit l'inventaire -------------------------------------- */
console.log('escorte — suit l\'inventaire');
{
  resetSouls();
  clearSoulEscort(scene);
  updateSoulEscort(DT, st());
  check('aucune âme portée, aucune escorte', getSoulEscort().length === 0);

  addSoul(0); addSoul(2);
  updateSoulEscort(DT, st());
  check('deux âmes portées, deux compagnons', getSoulEscort().length === 2,
        `${getSoulEscort().length}`);

  selectSlot(0);
  consumeSelected();
  updateSoulEscort(DT, st());
  check('âme posée, compagnon retiré', getSoulEscort().length === 1,
        `${getSoulEscort().length}`);

  for (let i = 0; i < SOULS.length; i++) addSoul(i);
  updateSoulEscort(DT, st());
  check('quatre âmes portées, quatre compagnons',
        getSoulEscort().length === SOULS.length, `${getSoulEscort().length}`);
}

/* --- 2. Elle bondit, et elle reste au sol --------------------------------- */
console.log('\nescorte — le bond');
{
  let minY = Infinity, maxY = -Infinity, buried = 0;
  for (let f = 0; f < 240; f++) {
    player.x += 2.5 * DT;               // marche tranquille
    updateSoulEscort(DT, st());
    for (const c of getSoulEscort()) {
      const y = c.grp.position.y;
      minY = Math.min(minY, y); maxY = Math.max(maxY, y);
      if (y < GROUND - 1e-6) buried++;
    }
  }
  check('les âmes décollent du sol', maxY > GROUND + 0.15,
        `y max = ${maxY.toFixed(3)} pour un sol à ${GROUND}`);
  check('elles retouchent le sol entre deux bonds',
        Math.abs(minY - GROUND) < 1e-6, `y min = ${minY.toFixed(4)}`);
  check('aucune ne passe sous le sol', buried === 0, `${buried} image(s)`);
}

/* --- 3. Elle rattrape un joueur qui court -------------------------------- */
console.log('\nescorte — le rattrapage');
{
  /* Une course franche et longue : c'est là que des bonds trop courts font
     décrocher l'escorte, et le décrochage est progressif — il ne se voit qu'au
     bout de plusieurs secondes. */
  for (let f = 0; f < 600; f++) {
    player.x += SPIRIT_RUN * DT;
    updateSoulEscort(DT, st());
  }
  let worst = 0;
  for (const c of getSoulEscort()) {
    worst = Math.max(worst, Math.hypot(c.x - player.x, c.z - player.z));
  }
  /* Le seuil est une distance de LISIBILITÉ, pas une tolérance mécanique : une
     escorte à plus de huit unités du joueur sort du cadre à cette échelle de
     caméra, et une escorte hors cadre n'existe pas. */
  const limit = 8;
  check(`elles restent à portée d'un joueur lancé (${SPIRIT_RUN.toFixed(1)} u/s)`,
        worst < limit, `plus loin = ${worst.toFixed(2)}, limite ${limit}`);

  /* Et elles ne doivent pas non plus lui grimper dessus quand il s'arrête. */
  for (let f = 0; f < 240; f++) updateSoulEscort(DT, st());
  let nearest = Infinity;
  for (const c of getSoulEscort()) {
    nearest = Math.min(nearest, Math.hypot(c.x - player.x, c.z - player.z));
  }
  check('à l\'arrêt, elles se tiennent derrière et non dans le joueur',
        nearest > 0.5, `plus près = ${nearest.toFixed(2)}`);
}

/* --- 3 bis. Elles ne s'empilent pas -------------------------------------- */
console.log('\nescorte — elles restent distinctes');
{
  /* Quatre âmes empilées se lisent comme une seule, et l'escorte cesse de dire
     ce qu'on porte — c'est-à-dire cesse de servir à quoi que ce soit. Mesuré
     sur la durée et en mouvement : c'est en gambadant qu'elles dérivent l'une
     vers l'autre, jamais à l'arrêt sur la première image. */
  let worstPair = Infinity, tooClose = 0;
  for (let f = 0; f < 900; f++) {
    player.x += Math.cos(f / 90) * 5.0 * DT;
    player.z += Math.sin(f / 90) * 5.0 * DT;
    updateSoulEscort(DT, st());
    const cs = getSoulEscort();
    for (let a = 0; a < cs.length; a++) {
      for (let b = a + 1; b < cs.length; b++) {
        const d = Math.hypot(cs[a].x - cs[b].x, cs[a].z - cs[b].z);
        worstPair = Math.min(worstPair, d);
        if (d < 0.45) tooClose++;
      }
    }
  }
  /* Le seuil est visuel : deux âmes de 0,62 unité à moins de 0,45 l'une de
     l'autre se recouvrent à l'écran. */
  check('deux âmes ne se recouvrent jamais', tooClose === 0,
        `${tooClose} image(s), plus proche = ${worstPair.toFixed(2)}`);
}

/* --- 4. Le monde des esprits, et lui seul -------------------------------- */
console.log('\nescorte — réservée au monde des esprits');
{
  const flesh = { ...st(), spiritBlend: 0 };
  updateSoulEscort(DT, flesh);
  const anyVisible = getSoulEscort().some((c) => c.grp.visible);
  check('invisible en chair — l\'inventaire ne fuite pas', !anyVisible);

  updateSoulEscort(DT, { ...st(), spiritBlend: 1 });
  check('visible en esprit', getSoulEscort().every((c) => c.grp.visible));

  /* À mi-transition, elle doit être en fondu et non déjà pleine : c'est ce qui
     l'accroche au basculement de forme au lieu de la faire claquer. */
  updateSoulEscort(DT, { ...st(), spiritBlend: 0.5 });
  const o = getSoulEscort()[0].fx.material.uniforms.uOpacity.value;
  updateSoulEscort(DT, { ...st(), spiritBlend: 1 });
  const one = getSoulEscort()[0].fx.material.uniforms.uOpacity.value;
  check('l\'opacité suit la transition de forme', o < one && o > 0,
        `moitié = ${o.toFixed(3)}, plein = ${one.toFixed(3)}`);
}

/* --- 5. Purge -------------------------------------------------------------*/
console.log('\nescorte — purge');
{
  clearSoulEscort(scene);
  check('clearSoulEscort vide l\'escorte', getSoulEscort().length === 0);
  const left = scene.children.length;
  check('rien ne reste dans la scène', left === 0, `${left} objet(s)`);
}

console.log(failures ? `\n${failures} échec(s)` : '\nTout est vert.');
process.exit(failures ? 1 : 0);
