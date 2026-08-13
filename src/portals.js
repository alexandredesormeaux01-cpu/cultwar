/* ============================================================================
   Cult.io — Module des Portails 3D & Autel Central (Mode Overworld)
   ========================================================================== */

import * as THREE from 'three';
import { makeGLTFLoader, modelURL } from './gltf.js';
import { toonMaterial, modelMaterial, attachCartoonOutline } from './biomes.js';

/* ---------------------------------------------------------------------------
   Arche modélisée des portails de niveau

   L'arche était bâtie en primitives (deux cylindres, un linteau, une clé de
   voûte). Elle est remplacée par un modèle, mais l'ancienne construction reste
   en REPLI : le .glb arrive de façon asynchrone, alors que le Hub peut être bâti
   avant. Sans repli, un joueur qui entre dans le Hub au premier chargement
   verrait des portails sans arche — juste un mur de peinture flottant.

   Le modèle est chargé une fois, puis chaque portail en clone les meshes : la
   géométrie et le matériau restent partagés.
--------------------------------------------------------------------------- */
const FRAME_URL = 'assets/models/portal_frame.glb';
/* Hauteur voulue en unités monde. L'ancienne arche culminait à ~4,4 et son
   ouverture accueillait un mur de peinture de 2,7 × 3,6 : on cale le modèle sur
   la même enveloppe pour que le mur, l'obstacle et le rayon d'interaction
   restent valables sans être retouchés. */
const FRAME_H = 4.6;

let frameTemplate = null;
const frameWaiting = [];

let cachedArchPortalGeo = null;

/** Crée la géométrie sur-mesure de la nappe de peinture pour qu'elle épouse parfaitement la voûte du portail sans aucun jour. */
function getArchPortalGeometry() {
  if (!cachedArchPortalGeo) {
    const shape = new THREE.Shape();
    const r = 1.22;       // Rayon du demi-cercle supérieur (largeur totale = 2.44, s'encastre dans les piliers)
    const yBase = 0.4;    // Bas de la nappe (caché sous le socle)
    const yArch = 2.95;   // Naissance de la voûte (sommet atteint Y = 4.17, encastré dans la clé de voûte)

    shape.moveTo(-r, yBase);
    shape.lineTo(-r, yArch);
    shape.absarc(0, yArch, r, Math.PI, 0, true);
    shape.lineTo(r, yBase);
    shape.closePath();

    cachedArchPortalGeo = new THREE.ShapeGeometry(shape, 24);
  }
  return cachedArchPortalGeo;
}

export function loadPortalFrame() {
  makeGLTFLoader().load(modelURL(FRAME_URL), (gltf) => {
    const scene = gltf.scene;
    scene.updateMatrixWorld(true);

    scene.traverse((c) => {
      if (!c.isMesh) return;
      c.castShadow = true;
      c.receiveShadow = true;
      c.material = modelMaterial(c);
    });

    const box = new THREE.Box3().setFromObject(scene);
    const h = Math.max(0.001, box.max.y - box.min.y);
    const scale = FRAME_H / h;
    scene.scale.set(scale, scale, scale);
    scene.updateMatrixWorld(true);

    const box2 = new THREE.Box3().setFromObject(scene);
    const cx = (box2.min.x + box2.max.x) * 0.5;
    const cz = (box2.min.z + box2.max.z) * 0.5;
    scene.position.set(-cx, -box2.min.y, -cz);

    const template = new THREE.Group();
    template.add(scene);

    frameTemplate = template;
    while (frameWaiting.length) frameWaiting.pop()();
  });
}

export function onPortalFrameReady(cb) {
  if (frameTemplate) cb(); else frameWaiting.push(cb);
}

/** Remplit le groupe d'arche d'un portail avec le modèle, s'il est chargé. */
function fillArch(archGroup) {
  if (!frameTemplate || !archGroup) return false;
  for (const child of [...archGroup.children]) archGroup.remove(child);
  const cloned = frameTemplate.clone(true);
  archGroup.add(cloned);
  return true;
}

/** Repose l'arche modélisée sur un portail déjà construit (appelé à l'arrivée
 *  du .glb, quand le Hub a été bâti avant la fin du chargement). */
export function applyPortalFrame(portal) {
  if (!portal || !portal.userData) return;
  fillArch(portal.userData.archGroup);
}

/**
 * Construit un portail 3D complet avec son arche, son intérieur (lumière/peinture),
 * et son obstacle de biome (si verrouillé).
 *
 * @param {object} spec
 * @param {number} spec.id           Index du portail (0 à N-1)
 * @param {number} spec.x, spec.z    Position sur le sol
 * @param {string} spec.state        'locked' | 'unlocked' | 'won'
 * @param {string} spec.biomeKey     'temperate' | 'desert' | 'nordic' | 'tropical' | 'volcanic' | 'savanna'
 * @param {string} spec.cultColor    Couleur hex du culte (ex: '#ff2e7e')
 * @param {string} spec.label        Libellé du niveau (ex: 'Zone 1')
 */
export function createPortalMesh(spec) {
  const { id = 0, x = 0, z = 0, state = 'locked', biomeKey = 'temperate', cultColor = '#ff2e7e', label = '' } = spec;

  const group = new THREE.Group();
  group.position.set(x, 0, z);
  group.userData = { id, state, label, interactRadius: 2.8 };

  // --- 1. Structure de l'arche en pierre ---
  const archMat = new THREE.MeshStandardMaterial({
    color: 0x4a4f5d,
    roughness: 0.85,
    metalness: 0.15,
  });

  /* L'arche vit dans son propre groupe : c'est ce qui permet de la remplacer
     d'un bloc quand le modèle arrive après la construction du Hub. */
  const archGroup = new THREE.Group();
  group.add(archGroup);
  group.userData.archGroup = archGroup;

  if (!fillArch(archGroup)) {
    /* Repli en primitives, tant que le .glb n'est pas chargé. Conservé tel quel :
       c'est ce que voit un joueur qui entre dans le Hub au tout premier
       chargement, avant que le modèle n'arrive. */
    const pillarL = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.42, 4.2, 8), archMat);
    pillarL.position.set(-1.6, 2.1, 0);
    pillarL.castShadow = true;

    const pillarR = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.42, 4.2, 8), archMat);
    pillarR.position.set(1.6, 2.1, 0);
    pillarR.castShadow = true;

    const lintel = new THREE.Mesh(new THREE.BoxGeometry(3.9, 0.6, 0.9), archMat);
    lintel.position.set(0, 4.1, 0);
    lintel.castShadow = true;

    // KeyStone au sommet
    const keystone = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.85, 1.05), archMat);
    keystone.position.set(0, 4.25, 0);

    archGroup.add(pillarL, pillarR, lintel, keystone);
  }

  // --- 2. Intérieur du Portail (Nappe d'énergie / Lumière / Peinture) ---
  const portalGeo = getArchPortalGeometry();

  // Matériau intérieur dynamique
  const playerColor = new THREE.Color(cultColor);
  const portalMat = new THREE.MeshBasicMaterial({
    color: state === 'won' ? playerColor : 0x77d6ff,
    transparent: true,
    opacity: state === 'locked' ? 0.2 : 0.85,
    side: THREE.DoubleSide,
  });

  /* L'arche est TOUJOURS remplie d'un mur de peinture — le matériau liquide du
     sol de partie, dressé à la verticale. Seule sa teinte dit l'état du niveau :
     grise tant qu'il n'est pas gagné, aux couleurs du culte une fois conquis.
     Les deux matériaux sont fournis par main.js, qui possède le shader. */
  const paintWallMat = spec.paintWallMat || null;
  const paintWallIdleMat = spec.paintWallIdleMat || null;

  const wallFor = (st) => (st === 'won' ? paintWallMat : paintWallIdleMat) || portalMat;

  const portalMesh = new THREE.Mesh(portalGeo, wallFor(state));
  portalMesh.position.set(0, 0, 0);
  group.add(portalMesh);
  group.userData.portalMesh = portalMesh;
  group.userData.portalMat = portalMat;
  group.userData.paintWallMat = paintWallMat;
  group.userData.paintWallIdleMat = paintWallIdleMat;
  // Scellé : la peinture grise est là mais sourde, derrière l'obstacle.
  if (paintWallIdleMat) paintWallIdleMat.opacity = state === 'locked' ? 0.45 : 0.92;

  /* Aucune colonne de lumière : la seule chose qui remplit l'arche est le mur
     de peinture. L'état du niveau se lit à sa teinte (grise / couleur du culte)
     et à la présence de l'obstacle de biome. */

  /* Ni disque au sol, ni halo de culte : le Hub n'est pas un terrain à
     conquérir, c'est un menu de niveaux. La colonne de lumière ne sert QU'À
     désigner le prochain défi (état `unlocked`) ; l'état « conquis » se lit
     uniquement sur la nappe intérieure de l'arche. */

  // --- 4. Obstacle selon le Biome (si Verrouillé) ---
  const obstacleGroup = new THREE.Group();
  obstacleGroup.visible = (state === 'locked');
  group.add(obstacleGroup);
  group.userData.obstacleGroup = obstacleGroup;

  buildBiomeObstacle(obstacleGroup, biomeKey);

  // Mémorise ce qu'il faut pour muter l'état plus tard (sans reconstruire).
  group.userData.biomeKey = biomeKey;
  group.userData.cultColor = cultColor;
  group.userData.anim = null; // { kind, t, dur }

  return group;
}

/* ---------------------------------------------------------------------------
   Mutation d'état à chaud
   ------------------------------------------------------------------------- */

/**
 * Change l'état visuel d'un portail déjà construit.
 * @param {THREE.Group} portal   Groupe renvoyé par createPortalMesh
 * @param {string} newState      'locked' | 'unlocked' | 'won'
 * @param {object} [opts]
 * @param {boolean} [opts.animate=false]  Joue la transition (effondrement / peinture)
 * @param {string}  [opts.cultColor]      Écrase la couleur du culte
 */
export function setPortalState(portal, newState, opts = {}) {
  if (!portal || !portal.userData) return;
  const ud = portal.userData;
  const animate = !!opts.animate;
  if (opts.cultColor) ud.cultColor = opts.cultColor;

  const prev = ud.state;
  ud.state = newState;

  const playerColor = new THREE.Color(ud.cultColor || '#ff2e7e');

  /* Nappe intérieure : peinture grise tant que la zone n'est pas gagnée,
     peinture du culte une fois conquise. */
  const wall = ((newState === 'won' ? ud.paintWallMat : ud.paintWallIdleMat) || ud.portalMat);
  if (ud.portalMesh && wall) ud.portalMesh.material = wall;
  if (ud.paintWallIdleMat) ud.paintWallIdleMat.opacity = newState === 'locked' ? 0.45 : 0.92;
  if (ud.portalMat) {
    ud.portalMat.color.copy(newState === 'won' ? playerColor : new THREE.Color(0x77d6ff));
    ud.portalMat.opacity = newState === 'locked' ? 0.2 : 0.85;
  }

  /* Conquête : la peinture monte dans l'arche au lieu d'apparaître d'un coup.
     Rien ne déborde au sol — le Hub reste un menu de niveaux. */
  if (animate && newState === 'won' && prev !== 'won' && wall) {
    ud.fillMat = wall;
    wall.opacity = 0;
    ud.anim = { kind: 'fill', t: 0, dur: 1.1 };
  }

  // --- Obstacle de biome ---
  if (ud.obstacleGroup) {
    if (newState === 'locked') {
      ud.obstacleGroup.visible = true;
      ud.obstacleGroup.scale.set(1, 1, 1);
      resetObstacleChildren(ud.obstacleGroup);
    } else if (animate && prev === 'locked') {
      // L'obstacle s'effondre au lieu de disparaître d'un coup.
      ud.obstacleGroup.visible = true;
      captureObstacleRest(ud.obstacleGroup);
      ud.anim = { kind: 'crumble', t: 0, dur: 0.9 };
    } else {
      ud.obstacleGroup.visible = false;
    }
  }
}

/** Sauvegarde la pose de repos des morceaux d'obstacle (pour rejouer/annuler). */
function captureObstacleRest(group) {
  for (const c of group.children) {
    if (!c.userData.restY) {
      c.userData.restY = c.position.y;
      c.userData.restRotZ = c.rotation.z;
      c.userData.fallDir = (Math.random() - 0.5) * 2;
    }
  }
}

function resetObstacleChildren(group) {
  for (const c of group.children) {
    if (c.userData.restY != null) {
      c.position.y = c.userData.restY;
      c.rotation.z = c.userData.restRotZ || 0;
    }
    c.scale.set(1, 1, 1);
    if (c.material) c.material.opacity = c.material.opacity ?? 1;
  }
}

/** Fait avancer l'animation de transition d'un portail. */
function tickPortalAnim(portal, dt) {
  const ud = portal.userData;
  const a = ud.anim;
  if (!a) return;

  a.t += dt;
  const k = Math.min(1, a.t / a.dur);

  if (a.kind === 'fill' && ud.fillMat) {
    // ease-out : la peinture envahit l'arche, vite puis en douceur
    const e = 1 - Math.pow(1 - k, 3);
    ud.fillMat.opacity = 0.95 * e;
  } else if (a.kind === 'crumble' && ud.obstacleGroup) {
    const e = k * k; // accélération type chute
    for (const c of ud.obstacleGroup.children) {
      const base = c.userData.restY != null ? c.userData.restY : c.position.y;
      c.position.y = base - e * 3.2;
      c.rotation.z = (c.userData.restRotZ || 0) + (c.userData.fallDir || 1) * e * 1.4;
      const s = Math.max(0.01, 1 - e);
      c.scale.set(s, s, s);
    }
    if (k >= 1) ud.obstacleGroup.visible = false;
  }

  if (k >= 1) ud.anim = null;
}

/**
 * Construit un obstacle thématique spécifique au biome pour bloquer l'entrée d'un portail fermé.
 */
function buildBiomeObstacle(group, biomeKey) {
  if (biomeKey === 'nordic') {
    // --- Glace / Cristal d'hiver ---
    const iceMat = new THREE.MeshStandardMaterial({
      color: 0xaee3ff,
      roughness: 0.1,
      transmission: 0.6,
      transparent: true,
      opacity: 0.85,
    });
    for (let i = 0; i < 5; i++) {
      const crystal = new THREE.Mesh(new THREE.ConeGeometry(0.5 + Math.random() * 0.3, 3 + Math.random(), 5), iceMat);
      crystal.position.set((i - 2) * 0.65, 1.5, (Math.random() - 0.5) * 0.4);
      crystal.rotation.z = (Math.random() - 0.5) * 0.4;
      crystal.rotation.x = (Math.random() - 0.5) * 0.3;
      group.add(crystal);
    }
  } else if (biomeKey === 'desert' || biomeKey === 'savanna') {
    // --- Dune / Pile de Sable ocre ---
    const sandMat = new THREE.MeshStandardMaterial({ color: 0xd9a45c, roughness: 0.9 });
    const dune = new THREE.Mesh(new THREE.SphereGeometry(1.6, 12, 8), sandMat);
    dune.scale.set(1.1, 0.75, 0.7);
    dune.position.set(0, 0.9, 0);
    group.add(dune);
  } else if (biomeKey === 'tropical') {
    // --- Ronces et Pierres Anciennes ---
    const vineMat = new THREE.MeshStandardMaterial({ color: 0x1e5a2b, roughness: 0.8 });
    const stoneMat = new THREE.MeshStandardMaterial({ color: 0x5a655d, roughness: 0.9 });
    const stone = new THREE.Mesh(new THREE.DodecahedronGeometry(1.2), stoneMat);
    stone.position.set(0, 1.1, 0);
    group.add(stone);

    for (let i = 0; i < 4; i++) {
      const vine = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.15, 3.8, 6), vineMat);
      vine.position.set((i - 1.5) * 0.7, 1.8, 0);
      vine.rotation.z = (i % 2 === 0 ? 0.35 : -0.35);
      group.add(vine);
    }
  } else {
    // --- Prairie / Volcan / Defaut : Rocher et Barrière magique de pierre ---
    const rockMat = new THREE.MeshStandardMaterial({ color: 0x3d434a, roughness: 0.9 });
    const rockL = new THREE.Mesh(new THREE.DodecahedronGeometry(1.0), rockMat);
    rockL.position.set(-0.7, 1.0, 0);
    const rockR = new THREE.Mesh(new THREE.DodecahedronGeometry(1.1), rockMat);
    rockR.position.set(0.7, 1.1, 0.1);
    group.add(rockL, rockR);
  }
}

/**
 * Construit l'Autel Central des Compétences (placé au centre du Hub Overworld).
 */
export function createCentralAltarMesh() {
  const group = new THREE.Group();
  group.position.set(0, 0, 0);
  group.userData = { isAltar: true, interactRadius: 3.5 };

  const stoneMat = new THREE.MeshStandardMaterial({ color: 0x3a3f4d, roughness: 0.8 });
  const goldMat = new THREE.MeshStandardMaterial({ color: 0xffd700, roughness: 0.3, metalness: 0.8 });

  // Base à 3 marches octogonales
  for (let i = 0; i < 3; i++) {
    const step = new THREE.Mesh(new THREE.CylinderGeometry(4 - i * 0.8, 4.3 - i * 0.8, 0.4, 8), stoneMat);
    step.position.y = 0.2 + i * 0.4;
    step.receiveShadow = true;
    group.add(step);
  }

  // Piliers d'angle
  for (let i = 0; i < 4; i++) {
    const ang = (i / 4) * Math.PI * 2 + Math.PI / 4;
    const px = Math.cos(ang) * 2.2, pz = Math.sin(ang) * 2.2;
    const col = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.35, 2.5, 6), stoneMat);
    col.position.set(px, 2.2, pz);
    col.castShadow = true;
    group.add(col);
  }

  // Gemme / Orbe centrale flottante (Orbe de puissance)
  const orbGeo = new THREE.OctahedronGeometry(0.75, 2);
  const orbMat = new THREE.MeshStandardMaterial({
    color: 0xffd700,
    emissive: 0xffaa00,
    emissiveIntensity: 0.6,
    roughness: 0.2,
  });
  const orbMesh = new THREE.Mesh(orbGeo, orbMat);
  orbMesh.position.set(0, 2.6, 0);
  group.add(orbMesh);
  group.userData.orbMesh = orbMesh;

  // Anneau doré tournant
  const ringGeo = new THREE.TorusGeometry(1.2, 0.08, 8, 24);
  const ringMesh = new THREE.Mesh(ringGeo, goldMat);
  ringMesh.position.set(0, 2.6, 0);
  ringMesh.rotation.x = Math.PI / 3;
  group.add(ringMesh);
  group.userData.ringMesh = ringMesh;

  return group;
}

/**
 * Construit le Grand Portail vers la vue Planète (Globe terrestre).
 */
export function createGreatPlanetPortalMesh(x = 0, z = -7) {
  const group = new THREE.Group();
  group.position.set(x, 0, z);
  group.userData = { isPlanetPortal: true, interactRadius: 3.5 };

  const goldMat = new THREE.MeshStandardMaterial({ color: 0xdda036, roughness: 0.3, metalness: 0.7 });

  // Piliers dorés doubles
  const pillarL = new THREE.Mesh(new THREE.CylinderGeometry(0.45, 0.55, 5.5, 10), goldMat);
  pillarL.position.set(-2.4, 2.75, 0);
  pillarL.castShadow = true;

  const pillarR = new THREE.Mesh(new THREE.CylinderGeometry(0.45, 0.55, 5.5, 10), goldMat);
  pillarR.position.set(2.4, 2.75, 0);
  pillarR.castShadow = true;

  const archTop = new THREE.Mesh(new THREE.TorusGeometry(2.4, 0.4, 8, 24, Math.PI), goldMat);
  archTop.position.set(0, 5.2, 0);

  group.add(pillarL, pillarR, archTop);

  // Intérieur cosmique bleu nuit / doré
  const innerGeo = new THREE.CircleGeometry(2.3, 24);
  const innerMat = new THREE.MeshBasicMaterial({
    color: 0x1a408a,
    side: THREE.DoubleSide,
    transparent: true,
    opacity: 0.85,
  });
  const innerMesh = new THREE.Mesh(innerGeo, innerMat);
  innerMesh.position.set(0, 3.2, 0);
  group.add(innerMesh);

  // Globe miniature tournant au centre du Grand Portail
  const miniGlobeGeo = new THREE.SphereGeometry(0.75, 16, 12);
  const miniGlobeMat = new THREE.MeshStandardMaterial({ color: 0x4896ff, roughness: 0.4, emissive: 0x002266 });
  const miniGlobe = new THREE.Mesh(miniGlobeGeo, miniGlobeMat);
  miniGlobe.position.set(0, 3.2, 0);
  group.add(miniGlobe);
  group.userData.miniGlobe = miniGlobe;

  return group;
}

/**
 * Met à jour les animations des portails et vérifie la proximité du joueur.
 */
export function updatePortalsSystem(portalsList, dt, elapsed, playerPos) {
  let activeTrigger = null;

  for (const portal of portalsList) {
    // Transitions d'état en cours (effondrement d'obstacle, peinture qui s'étale)
    if (portal.userData.anim) tickPortalAnim(portal, dt);

    // Rotation/Animation des éléments
    if (portal.userData.orbMesh) {
      portal.userData.orbMesh.rotation.y = elapsed * 1.2;
      portal.userData.orbMesh.position.y = 2.6 + Math.sin(elapsed * 2) * 0.15;
    }
    if (portal.userData.ringMesh) {
      portal.userData.ringMesh.rotation.z = -elapsed * 0.8;
    }
    if (portal.userData.miniGlobe) {
      portal.userData.miniGlobe.rotation.y = elapsed * 0.6;
    }
    // Détection de proximité
    if (playerPos) {
      const dx = playerPos.x - portal.position.x;
      const dz = playerPos.z - portal.position.z;
      const dist = Math.hypot(dx, dz);
      const radius = portal.userData.interactRadius || 2.5;

      if (dist < radius) {
        activeTrigger = portal.userData;
      }
    }
  }

  return activeTrigger;
}
