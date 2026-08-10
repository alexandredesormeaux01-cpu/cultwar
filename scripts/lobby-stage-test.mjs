/**
 * Cadrage du salon 3D — vérification headless.
 *
 * Le défaut constaté : les personnages étaient rendus DERRIÈRE le panneau du
 * salon, invisibles. Le cadrage se contentait d'un décalage latéral fixe, qui
 * ne tient plus dès que la taille du panneau change — or elle change avec le
 * nombre de joueurs, la largeur de la fenêtre et le contenu.
 *
 * Le test rejoue de vraies configurations d'écran, projette les socles des
 * deux extrémités et le sommet des personnages, puis vérifie qu'ils tombent
 * TOUS dans la zone laissée libre par le panneau. C'est du pur calcul : trois
 * suffit, pas besoin de WebGL ni de navigateur.
 *
 * Lancer :  node scripts/lobby-stage-test.mjs
 */
import * as THREE from 'three';
import { frameRow, seatPos, PODIUM_R, ROW_H, BACK_MAX } from '../src/lobbyStage.js';

let failed = 0;
function check(label, cond, detail = '') {
  console.log(`${cond ? '  ok  ' : ' FAIL '} ${label}${cond ? '' : '  → ' + detail}`);
  if (!cond) failed++;
}

const FOV = 48;

/**
 * Reproduit lobbyFreeRect() de main.js : la bande entre le bandeau du haut et
 * le quai du bas. Le salon est un cadre, pas une carte centrée.
 */
function freeRect(W, H, headerBottom, dockTop) {
  const pad = 8;
  const y = Math.max(0, headerBottom + pad);
  const h = Math.max(0, dockTop - pad - y);
  if (h < 90) return { x: 0, y: 0, w: W, h: H };
  return { x: 0, y, w: W, h };
}

/** Projette un point monde en pixels écran, comme le fait le moteur. */
function project(cam, x, y, z, W, H) {
  const v = new THREE.Vector3(x, y, z).project(cam);
  return { x: (v.x * 0.5 + 0.5) * W, y: (-v.y * 0.5 + 0.5) * H };
}

function run(name, W, H, headerBottom, dockTop, count) {
  const free = freeRect(W, H, headerBottom, dockTop);
  const cam = new THREE.PerspectiveCamera(FOV, W / H, 0.5, 400);
  const r = frameRow({ count, fov: FOV, aspect: W / H, free, vw: W, vh: H, drift: 0 });
  cam.position.set(r.pos.x, r.pos.y, r.pos.z);
  cam.lookAt(r.target.x, r.target.y, r.target.z);
  cam.updateMatrixWorld(true);
  cam.updateProjectionMatrix();

  const inFree = (p, m = 1) =>
    p.x >= free.x - m && p.x <= free.x + free.w + m
    && p.y >= free.y - m && p.y <= free.y + free.h + m;

  /* La VEDETTE doit tenir ENTIÈREMENT : c'est elle que la vue est censée
     cadrer, et son cadrage ne dépend pas du nombre de joueurs. */
  {
    const p = seatPos(0, r.layout);
    const pts = [
      project(cam, p.x - PODIUM_R * p.scale, p.y, p.z, W, H),
      project(cam, p.x + PODIUM_R * p.scale, p.y, p.z, W, H),
      project(cam, p.x, p.y + ROW_H * p.scale, p.z, W, H),
    ];
    const bad = pts.find(q => !inFree(q));
    check(`${name} — ${count} joueurs : la vedette tient entière`, !bad,
      bad ? `point (${bad.x | 0},${bad.y | 0}) hors de `
        + `[${free.x | 0},${free.y | 0} ${free.w | 0}×${free.h | 0}]` : '');
  }

  /* Le FOND, lui, peut être rogné sur le bord extérieur — c'est le prix d'une
     caméra qui ne recule pas. On exige seulement qu'il reste identifiable :
     son centre et sa tête dans le champ. */
  for (let rank = 1; rank < Math.min(count, BACK_MAX + 1); rank++) {
    const p = seatPos(rank, r.layout);
    const mid = project(cam, p.x, p.y, p.z, W, H);
    const top = project(cam, p.x, p.y + ROW_H * p.scale, p.z, W, H);
    check(`${name} — ${count} joueurs : place ${rank} du fond visible`,
      inFree(mid) && inFree(top),
      `centre (${mid.x | 0},${mid.y | 0})`);
  }

  /* OCCULTATION — le point du cahier des charges : la vedette est au premier
     plan, au centre ; aucun personnage du fond ne doit disparaître derrière
     elle. On compare les empreintes à l'écran : celle de la vedette ne doit
     recouvrir aucune de celles du fond. */
  if (count > 1) {
    const box = (rank) => {
      const p = seatPos(rank, r.layout);
      const a = project(cam, p.x - PODIUM_R * p.scale, p.y, p.z, W, H);
      const b = project(cam, p.x + PODIUM_R * p.scale, p.y, p.z, W, H);
      const top = project(cam, p.x, p.y + ROW_H * p.scale, p.z, W, H);
      return { l: Math.min(a.x, b.x), r: Math.max(a.x, b.x), t: top.y, b: a.y };
    };
    const star = box(0);
    let hidden = null;
    for (let rank = 1; rank < Math.min(count, BACK_MAX + 1); rank++) {
      const bk = box(rank);
      const overlapX = Math.min(star.r, bk.r) - Math.max(star.l, bk.l);
      const overlapY = Math.min(star.b, bk.b) - Math.max(star.t, bk.t);
      if (overlapX > 0 && overlapY > 0) { hidden = { rank, overlapX: overlapX | 0 }; break; }
    }
    check(`${name} — ${count} joueurs : le fond n'est pas masqué par la vedette`,
      !hidden, hidden ? `place ${hidden.rank} recouverte sur ${hidden.overlapX} px` : '');
  }
  return { free, cam, r };
}

/* -- 1. La fenêtre étroite de la capture qui ne marchait pas. Bandeau ~64 px,
      quai ~200 px (barre perso + terrain + bouton) : la scène a désormais tout
      le milieu, là où l'ancien panneau lui laissait une lucarne. -- */
for (const n of [2, 3, 5]) {
  run('mobile 460×834', 460, 834, 64, 634, n);
}

/* -- 2. Fiche d'IA ouverte : le quai grandit d'une centaine de pixels et la
      scène doit se recadrer, pas passer dessous. C'est le cas qui casse si
      l'on mesure une seule fois au lieu de chaque image. -- */
run('mobile 460×834, fiche ouverte', 460, 834, 64, 500, 5);

/* -- 3. Bureau large. -- */
for (const n of [2, 5]) {
  run('bureau 1920×1080', 1920, 1080, 70, 880, n);
}

/* -- 4. Paysage écrasé : peu de hauteur, quai proportionnellement énorme. -- */
run('paysage 1280×620', 1280, 620, 58, 430, 4);

/* -- 5. Cas dégénéré : le quai dévore l'écran, il ne reste pas de quoi cadrer.
      On n'exige plus la visibilité, seulement que le cadrage reste sain — pas
      de caméra à l'infini ni de NaN, ce qui ferait tout disparaître. -- */
{
  const W = 500, H = 700;
  const free = freeRect(W, H, 60, 120);
  check('quai démesuré : repli sur tout l\'écran', free.w === W && free.h === H);
  const r = frameRow({ count: 5, fov: FOV, aspect: W / H, free, vw: W, vh: H });
  check('quai démesuré : cadrage fini et raisonnable',
    Number.isFinite(r.dist) && r.dist > 5 && r.dist < 120, `dist=${r.dist}`);
}

/* -- 6. LA règle demandée : la caméra ne bouge JAMAIS avec le nombre de
      joueurs. La vue est toujours celle qu'on aurait à un seul, cadrée sur la
      vedette ; c'est le fond qui se resserre. Un recul réintroduit par
      inadvertance rapetisserait tout le monde dès qu'une IA arrive. -- */
{
  const free = { x: 0, y: 0, w: 1200, h: 700 };
  const args = { fov: FOV, aspect: 12 / 7, free, vw: 1200, vh: 700 };
  const ds = [1, 2, 3, 4, 5].map(n => frameRow({ ...args, count: n }).dist);
  check(`recul constant quel que soit le nombre de joueurs (${ds[0].toFixed(2)})`,
    ds.every(d => Math.abs(d - ds[0]) < 1e-9), ds.map(d => d.toFixed(2)).join(', '));

  /* Et la vedette occupe donc toujours la même place à l'écran. */
  const cam = new THREE.PerspectiveCamera(FOV, 12 / 7, 0.5, 400);
  const shots = [1, 5].map(n => {
    const r = frameRow({ ...args, count: n });
    cam.position.set(r.pos.x, r.pos.y, r.pos.z);
    cam.lookAt(r.target.x, r.target.y, r.target.z);
    cam.updateMatrixWorld(true); cam.updateProjectionMatrix();
    const p = seatPos(0, r.layout);
    const a = project(cam, p.x - PODIUM_R * p.scale, p.y, p.z, 1200, 700);
    const b = project(cam, p.x + PODIUM_R * p.scale, p.y, p.z, 1200, 700);
    return { cx: (a.x + b.x) / 2, w: Math.abs(b.x - a.x) };
  });
  check(`la vedette garde sa taille à 1 comme à 5 joueurs (${shots[0].w | 0} px)`,
    Math.abs(shots[0].w - shots[1].w) < 0.5
    && Math.abs(shots[0].cx - shots[1].cx) < 0.5);
}

/* -- 7. Le fond se resserre quand la place manque, au lieu de sortir du
      champ : c'est la contrepartie d'une caméra fixe. -- */
{
  const wide = frameRow({ count: 5, fov: FOV, aspect: 1.8, free: { x: 0, y: 0, w: 1440, h: 800 }, vw: 1440, vh: 800 });
  const narrow = frameRow({ count: 5, fov: FOV, aspect: 0.55, free: { x: 0, y: 0, w: 460, h: 430 }, vw: 460, vh: 834 });
  check(`écartement plus serré sur écran étroit (${wide.layout.spread.toFixed(1)} > ${narrow.layout.spread.toFixed(1)})`,
    wide.layout.spread > narrow.layout.spread);
  check('le fond reste toujours hors de la silhouette de la vedette',
    narrow.layout.inner > 0 && wide.layout.inner > 0);
}

/* -- 6. Aucun NaN quelle que soit l'entrée : une zone libre vide ou un canvas
      de taille nulle ne doit pas faire disparaître la scène. -- */
{
  const bad = [
    { free: { x: 0, y: 0, w: 0, h: 0 }, vw: 0, vh: 0 },
    { free: { x: 0, y: 0, w: -50, h: -50 }, vw: 800, vh: 600 },
  ];
  for (const b of bad) {
    const r = frameRow({ count: 3, fov: FOV, aspect: 1.33, ...b });
    check(`entrée dégénérée (${b.free.w}×${b.free.h}, canvas ${b.vw}×${b.vh}) : pas de NaN`,
      Number.isFinite(r.pos.x) && Number.isFinite(r.pos.y)
      && Number.isFinite(r.pos.z) && Number.isFinite(r.dist));
  }
}

console.log(failed ? `\n${failed} échec(s)` : '\nTout passe.');
process.exit(failed ? 1 : 0);
