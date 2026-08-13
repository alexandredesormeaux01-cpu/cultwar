/* -- Les Piliers d'âmes (GDD §10.4) --

   Source UNIQUE des âmes du jeu. Huit piliers dispersés sur la carte, chacun
   coiffé d'une flamme dont la couleur annonce le type d'âme qu'il délivre.

   Deux règles portent tout le système :

   1. Ils n'existent que dans le monde des esprits. En chair, la carte n'en
      montre rien — basculer les fait apparaître tous d'un coup.
   2. Le type est aléatoire mais ANNONCÉ. Le hasard est dans le monde, pas dans
      la main du joueur : on ne choisit pas la distribution, on la lit et on
      décide quel pilier vaut le déplacement.

   Cycle de vie : au ramassage, la flamme entre dans le joueur, le pilier
   s'enfonce dans le sol, puis ressort ailleurs sur la carte avec un type tiré
   au sort. La carte se redessine donc en permanence, et un pilier qui remonte
   est un rendez-vous que tout le monde a en tête. */

import * as THREE from 'three';

import { createFlame, TUNE_FLAME } from './flame.js';

/* -- Les quatre âmes (GDD §10.6) --
   Couleurs choisies pour rester distinctes entre elles ET des teintes de culte :
   chacune tire vers son élément sans empiéter sur la palette néon des cultes. */
export const SOULS = [
  { key: 'fleuve', nom: 'Fleuve', col: 0x3fb6ff, css: '#3fb6ff', core: '#e0ffff', sym: '🔥' },  // eau  — étendre
  { key: 'cendre', nom: 'Cendre', col: 0xff6a2a, css: '#ff6a2a', core: '#fff0b8', sym: '🔥' },  // feu  — percer
  { key: 'racine', nom: 'Racine', col: 0x7fc25a, css: '#7fc25a', core: '#f2ffcf', sym: '🔥' },  // terre — verrouiller
  { key: 'gardienne', nom: 'Gardienne', col: 0xb06bff, css: '#b06bff', core: '#f6e8ff', sym: '🔥' }, // éther / blanc — protéger
];

export const TUNE_PILLARS = {
  count: 8,
  minFromAltar: 14,   // ne jamais poser un pilier dans la cour d'un autel
  minFromPillar: 18,  // ni deux piliers l'un sur l'autre
  pickR: 2.6,         // rayon de ramassage
  height: 3.4,        // hauteur du modèle une fois mis à l'échelle
  sinkDur: 0.9,       // durée de l'enfoncement
  hiddenDur: 2.2,     // temps passé sous terre avant de ressortir ailleurs
  riseDur: 1.1,       // durée de la remontée
};

let _model = null;      // gabarit chargé du .glb
const pillars = [];
let _scene = null;
let _ctx = null;        // { groundY, randomPoint, altarsOf }

/* -- Flamme --
   La flamme cel-shadée de src/flame.js + une lueur plate au sol. Pas de lumière
   dynamique : six PointLight coûteraient plus cher que tout le reste du système
   réuni.

   Elle remplace le cône tournant qui tenait la place ici. L'ondulation vient
   maintenant du vertex shader, donc update() n'a plus à la faire respirer à la
   main — il ne lui reste que ce que le shader ne peut pas savoir : la teinte
   d'âme et le fondu entre les deux mondes. */
const GLOW_GEO = new THREE.CircleGeometry(1.5, 20);

/* Chaque pilier a SA flamme (et donc son matériau) plutôt qu'une instance d'un
   champ commun : les six annoncent des âmes différentes, apparaissent et
   disparaissent séparément, et six draw calls décoratifs ne pèsent rien à côté
   de la lisibilité qu'on y gagne. */
function makeFlame(col) {
  return createFlame({ color: col, size: 1.6 });
}

/* La lueur au sol est posée SÉPARÉMENT, à même le groupe du pilier, et non sous
   la flamme. Groupée avec elle, elle suivait la flamme au sommet du fût : un
   disque « au sol » qui flottait à trois mètres et demi, en anneau autour du
   feu. Elle marque le pied du pilier — c'est son seul travail. */
function makeGlow(col) {
  const mat = new THREE.MeshBasicMaterial({
    color: col, transparent: true, opacity: 0.35,
    blending: THREE.AdditiveBlending, depthWrite: false,
    /* La flamme appartient au monde des esprits : ni brume ni exposition ne
       doivent l'atteindre, c'est elle qui annonce le type d'âme à distance. */
    toneMapped: false, fog: false,
  });
  const glow = new THREE.Mesh(GLOW_GEO, mat);
  glow.rotation.x = -Math.PI / 2;
  glow.position.y = 0.05;
  glow.userData.mat = mat;
  return glow;
}

/** Socle de repli tant que le .glb n'est pas arrivé. */
function makeFallbackPillar() {
  const g = new THREE.Group();
  const m = new THREE.Mesh(
    new THREE.CylinderGeometry(0.5, 0.66, TUNE_PILLARS.height, 8),
    new THREE.MeshLambertMaterial({ color: 0x8d93a6 }),
  );
  m.position.y = TUNE_PILLARS.height / 2;
  g.add(m);
  return g;
}

/** Enregistre le modèle chargé et rhabille les piliers déjà posés. */
export function setPillarModel(gltfScene, toonMaterial) {
  const g = gltfScene;
  g.traverse((c) => {
    if (!c.isMesh) return;
    c.castShadow = true;
    if (toonMaterial) c.material = toonMaterial({ map: c.material && c.material.map });
  });
  const box = new THREE.Box3().setFromObject(g);
  const h = Math.max(0.001, box.max.y - box.min.y);
  g.scale.multiplyScalar(TUNE_PILLARS.height / h);
  g.updateMatrixWorld(true);
  const box2 = new THREE.Box3().setFromObject(g);
  g.position.y -= box2.min.y;
  const wrap = new THREE.Group();
  wrap.add(g);
  _model = wrap;
  for (const p of pillars) swapBody(p);
}

function swapBody(p) {
  if (!_model || p.grp.userData.hasModel) return;
  const old = p.grp.userData.body;
  if (old) p.grp.remove(old);
  const body = _model.clone(true);
  p.grp.add(body);
  p.grp.userData.body = body;
  p.grp.userData.hasModel = true;
}

function randomSoul() {
  return SOULS[(Math.random() * SOULS.length) | 0];
}

/** Cherche un point valide : sur l'île, loin des autels et des autres piliers. */
function findSpot(skipPillar) {
  for (let tries = 0; tries < 60; tries++) {
    const p = _ctx.randomPoint();
    if (!p) continue;
    const x = p.x, z = p.z ?? p.y;
    let ok = true;
    for (const a of _ctx.altarsOf()) {
      if (Math.hypot(a.x - x, a.z - z) < TUNE_PILLARS.minFromAltar) { ok = false; break; }
    }
    if (!ok) continue;
    for (const q of pillars) {
      if (q === skipPillar || q.state === 'hidden') continue;
      if (Math.hypot(q.x - x, q.z - z) < TUNE_PILLARS.minFromPillar) { ok = false; break; }
    }
    if (!ok) continue;
    return { x, z };
  }
  /* Filet : une île serrée peut ne rien offrir de conforme. Mieux vaut des
     piliers rapprochés que pas d'âmes du tout. */
  const p = _ctx.randomPoint();
  return p ? { x: p.x, z: p.z ?? p.y } : null;
}

function placeAt(p, x, z, soul) {
  p.x = x; p.z = z;
  p.y = _ctx.groundY(x, z);
  p.soul = soul;
  p.grp.position.set(x, p.y, z);
  const ud = p.grp.userData;
  ud.fx.setColor(soul.col);
  ud.glowMat.color.setHex(soul.col);
}

/** (Re)construit les piliers. À appeler après placeAltars(). */
export function placePillars(scene, ctx) {
  clearPillars(scene);
  _scene = scene;
  _ctx = ctx;
  for (let i = 0; i < TUNE_PILLARS.count; i++) {
    const grp = new THREE.Group();
    grp.add(_model ? _model.clone(true) : makeFallbackPillar());
    grp.userData.hasModel = !!_model;
    grp.userData.body = grp.children[0];
    const flame = makeFlame(0xffffff);
    flame.position.y = TUNE_PILLARS.height + 0.15;
    grp.add(flame);
    const glow = makeGlow(0xffffff);
    grp.add(glow);
    grp.userData.flame = flame;
    grp.userData.fx = flame.userData.flame;
    grp.userData.glowMat = glow.userData.mat;
    grp.visible = false;   // invisible en chair ; l'opacité prend le relais
    scene.add(grp);

    const p = { x: 0, z: 0, y: 0, soul: SOULS[0], grp, state: 'idle', t: 0, sink: 0 };
    pillars.push(p);
    const spot = findSpot(p) || { x: 0, z: 0 };
    placeAt(p, spot.x, spot.z, randomSoul());
  }
}

export function clearPillars(scene) {
  for (const p of pillars) (scene || _scene)?.remove(p.grp);
  pillars.length = 0;
}

export function getPillars() { return pillars; }

/** Pas de simulation des piliers.
 *  `spiritBlend` ne concerne QUE l'affichage local : les piliers n'existent
 *  visuellement que dans le monde des esprits du joueur qui regarde. Le
 *  ramassage, lui, est ouvert à toutes les factions en forme d'esprit —
 *  chacune avec ses propres yeux, chacune aux mêmes règles.
 *  @param {number} dt
 *  @param {{spiritBlend:number, elapsed:number,
 *           claimants:Array<{fi:number,x:number,z:number,inSpirit:boolean}>,
 *           onPick:(soul:object,p:object,fi:number)=>boolean}} s */
export function updatePillars(dt, s) {
  const vis = s.spiritBlend;
  for (const p of pillars) {
    /* -- Cycle enfoncement / absence / remontée -- */
    if (p.state === 'sinking') {
      p.t += dt;
      p.sink = Math.min(1, p.t / TUNE_PILLARS.sinkDur);
      if (p.sink >= 1) {
        p.state = 'hidden'; p.t = 0;
        const spot = findSpot(p);
        if (spot) placeAt(p, spot.x, spot.z, randomSoul());
      }
    } else if (p.state === 'hidden') {
      p.t += dt;
      p.sink = 1;
      if (p.t >= TUNE_PILLARS.hiddenDur) { p.state = 'rising'; p.t = 0; }
    } else if (p.state === 'rising') {
      p.t += dt;
      const k = Math.min(1, p.t / TUNE_PILLARS.riseDur);
      /* Sortie de terre avec un léger dépassement : un pilier qui remonte doit
         se remarquer de loin, c'est un rendez-vous. */
      const ease = 1 - Math.pow(1 - k, 3);
      p.sink = 1 - ease;
      if (k >= 1) { p.state = 'idle'; p.sink = 0; p.t = 0; }
    }

    /* -- Ramassage : forme d'esprit uniquement (§10.2) --
       Traité AVANT le rendu, et hors de son test de visibilité : un bot
       continue de chasser même quand le joueur est en chair et ne voit rien.
       Lier la règle à ce que l'écran affiche gèlerait la carte dès que le
       joueur repasse dans le monde matériel. */
    if (p.state === 'idle') {
      for (const c of s.claimants) {
        if (!c.inSpirit) continue;
        if (Math.hypot(p.x - c.x, p.z - c.z) > TUNE_PILLARS.pickR) continue;
        /* Le pilier n'est consommé que si l'âme a trouvé preneur : on porte
           déjà ce type, il reste debout et on peut revenir plus tard. Sans ce
           retour, un porteur au complet rasait la carte en passant dessus. */
        if (s.onPick?.(p.soul, p, c.fi) === false) continue;
        p.state = 'sinking'; p.t = 0;
        break;
      }
    }

    /* -- Rendu -- */
    const buried = p.sink * (TUNE_PILLARS.height + 1.2);
    p.grp.position.y = p.y - buried;
    const shown = vis > 0.01 && p.sink < 0.995;
    p.grp.visible = shown;
    if (!shown) continue;

    const ud = p.grp.userData;
    /* Le shader fait vivre la flamme tout seul ; il ne reste ici que le fondu
       entre les mondes, qu'il ne peut pas connaître. */
    ud.fx.setOpacity(TUNE_FLAME.opacity * vis);
    ud.glowMat.opacity = (0.28 + 0.12 * Math.sin(s.elapsed * 4 + p.x)) * vis;
    const body = p.grp.userData.body;
    if (body) {
      body.traverse((o) => {
        if (!o.isMesh || !o.material) return;
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of mats) { m.transparent = true; m.opacity = vis; m.depthWrite = vis > 0.85; }
      });
    }
  }
}
