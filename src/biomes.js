/* ============================================================================
   Cult.io — Biomes : palettes + décors procéduraux (maisons).
   Arbres / rochers / herbe : en pause — on peaufine d’abord le style des tuiles.
   ========================================================================== */

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { makeGLTFLoader } from './gltf.js';
import { applyGroundFollow } from './groundNoise.js';
import { applyHeroCutout } from './heroCutout.js';

/* Taille minimale, en unités monde, pour qu'un décor s'efface devant le joueur.
   Seul ce qui peut RÉELLEMENT le cacher doit disparaître : un arbre (5,7 à 8,8),
   un rocher (2,2 à 5,3), un cactus (2,4 à 4,6). En dessous — touffes d'herbe,
   buissons, fleurs, cailloutis, dalles — le prop ne masque rien, et l'effacer
   ne produit qu'un scintillement de trame qui suit le joueur et attire l'œil
   bien plus que le décor qu'il prétend enlever.
   Le seuil porte sur le HAUT de la fourchette d'échelle : c'est la taille des
   plus grands exemplaires du semis, donc ceux qui gênent. */
const HERO_HIDE_MIN_SCALE = 2.0;
const hidesHero = (scale) => Array.isArray(scale) && (scale[1] || 0) >= HERO_HIDE_MIN_SCALE;

/* Tactile : densités / outlines allégés (mode Belle plus fluide sur téléphone). */
import { IS_MOBILE as _isCoarse } from './device.js';
const GRASS_DENSITY_MOBILE = 0.35;

/* ---------------------------------------------------------------------------
   Rampe toon partagée
   ---------------------------------------------------------------------------
   La « recette standard » à 3 crans durs (90/160/255, filtrage au plus proche)
   est faite pour un objet isolé, où la bande se lit comme un parti pris
   graphique. Étalée sur un décor entier, elle supprime le modelé : chaque
   rocher, chaque touffe devient un aplat, et c'est de là que vient l'aspect
   « maquette ».

   On garde le principe — une réponse à la lumière décidée à la main plutôt que
   physique — mais sur une rampe CONTINUE :
     · `floor` empêche l'ombre de tomber à zéro. Une ombre toon doit rester une
       valeur colorée, jamais un noir ; c'est ce qui garde la matière lisible du
       côté sombre ;
     · la courbe en S (smoothstep) tasse les extrêmes et laisse une « terrasse »
       dans les demi-tons. Une droite pure donnerait l'équivalent d'un lambert :
       correct, mais sans caractère.
--------------------------------------------------------------------------- */
export function makeToonRamp(floor = 0.34, steps = 64) {
  const data = new Uint8Array(steps);
  for (let i = 0; i < steps; i++) {
    const t = i / (steps - 1);
    const s = t * t * (3 - 2 * t);
    data[i] = Math.round(255 * (floor + (1 - floor) * s));
  }
  const tex = new THREE.DataTexture(data, steps, 1, THREE.RedFormat);
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

let _gradientMap = null;
export function getToonGradient() {
  if (_gradientMap) return _gradientMap;
  _gradientMap = makeToonRamp(0.34);
  return _gradientMap;
}

export function createOutlineMaterial(thickness = 0.038, color = 0x080a12) {
  const mat = new THREE.MeshBasicMaterial({
    color: color,
    side: THREE.BackSide,
    // Écrit la profondeur : la peinture transparente ne peut plus « laver » le contour
    depthWrite: true,
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1,
  });
  mat.customProgramCacheKey = () => 'hull-outline-solid-' + thickness.toFixed(4);
  mat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader.replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>
      #ifdef USE_SKINNING
        vec3 _nOut = normal;
        transformed += _nOut * ${thickness.toFixed(4)};
      #else
        transformed += normal * ${thickness.toFixed(4)};
      #endif
      `
    );
  };
  return mat;
}

/**
 * Outline pour cartes alpha (herbe, buissons, fleurs) : même map + alphaTest,
 * teinte noire — silhouette découpée au lieu d'un rectangle plein.
 */
export function createFoliageOutlineMaterial(thickness, map, alphaTest = 0.35, color = 0x080a12) {
  const mat = new THREE.MeshBasicMaterial({
    color,
    map: map || null,
    alphaTest: map ? alphaTest : 0,
    side: THREE.BackSide,
    depthWrite: true,
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1,
  });
  const key = 'hull-outline-foliage-' + thickness.toFixed(4) + (map ? '-map' : '');
  mat.customProgramCacheKey = () => key;
  mat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader.replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>
      transformed += normal * ${thickness.toFixed(4)};
      `,
    );
  };
  return mat;
}

/** True si un hull outline BackSide solide produirait des blobs noirs (cartes alpha / DoubleSide). */
function outlineUnsafeMaterial(mat) {
  if (!mat) return false;
  if (mat.side === THREE.DoubleSide) return true;
  if (mat.alphaTest > 0) return true;
  if (mat.transparent && mat.opacity < 0.99) return true;
  return false;
}

/**
 * Contour cartoon (hull BackSide). Pour InstancedMesh : sibling du mesh (pas enfant).
 * @param {{ foliage?: boolean }} [opts] — foliage:true pour cartes alpha (map + alphaTest).
 */
export function attachCartoonOutline(object, thickness = 0.038, color = 0x080a12, opts = {}) {
  if (!object || object.userData.isOutline) return null;
  const foliage = !!opts.foliage;
  if (object.isInstancedMesh) {
    if (object.userData.outlineMesh) return object.userData.outlineMesh;
    if (!foliage && outlineUnsafeMaterial(object.material)) return null;
    const srcMat = object.material;
    const outlineMat = foliage
      ? createFoliageOutlineMaterial(thickness, srcMat?.map, srcMat?.alphaTest || 0.35, color)
      : createOutlineMaterial(thickness, color);
    const outlineInst = new THREE.InstancedMesh(object.geometry, outlineMat, object.count);
    outlineInst.instanceMatrix = object.instanceMatrix;
    outlineInst.count = object.count;
    outlineInst.frustumCulled = false;
    outlineInst.userData.isOutline = true;
    outlineInst.matrixAutoUpdate = false;
    if (object.parent) object.parent.add(outlineInst);
    else object.add(outlineInst);
    object.userData.outlineMesh = outlineInst;
    return outlineInst;
  }
  if (!foliage && outlineUnsafeMaterial(object.material)) return null;
  object.traverse((child) => {
    if (child.isMesh && !child.userData.isOutline && child.geometry) {
      const childFoliage = foliage || outlineUnsafeMaterial(child.material);
      if (!foliage && outlineUnsafeMaterial(child.material)) return;
      const outlineMat = childFoliage
        ? createFoliageOutlineMaterial(thickness, child.material?.map, child.material?.alphaTest || 0.35, color)
        : createOutlineMaterial(thickness, color);
      let outline;
      if (child.isSkinnedMesh) {
        outline = new THREE.SkinnedMesh(child.geometry, outlineMat);
        outline.bind(child.skeleton, child.bindMatrix);
      } else {
        outline = new THREE.Mesh(child.geometry, outlineMat);
      }
      outline.userData.isOutline = true;
      outline.frustumCulled = false;
      child.add(outline);
    }
  });
  return object;
}

/* ---------------------------------------------------------------------------
   Conditionnement d'albédo
   ---------------------------------------------------------------------------
   Toute la palette du projet a été composée sous le modèle toon, où la sortie
   valait albédo × rampe avec une rampe bornée à 1 : une couleur ne pouvait
   jamais dépasser elle-même, et l'écrire directement à la valeur voulue à
   l'écran était donc la bonne méthode.

   En PBR ces mêmes constantes deviennent des ALBÉDOS, multipliés par une
   irradiance qui, en plein soleil, dépasse largement 1. Un vert d'herbe noté
   0x8EF05A — luminance 0,75, saturation quasi maximale — se retrouve poussé
   hors du gamut : le canal vert clippe, et comme le tone mapping neutre ne
   compresse que les hautes lumières sans toucher la teinte, il reste un néon.
   Aucun albédo naturel ne ressemble à ça : l'herbe réelle est autour de 0,20 de
   luminance pour une saturation modérée.

   Plutôt que de réécrire à la main les quelques centaines de constantes de
   biome — long, et surtout irréversible si la direction change — on les fait
   passer par une projection : plafond et plancher de luminance, saturation
   ramenée. Deux propriétés valent d'être notées :

     · le PLANCHER compte autant que le plafond. La rampe toon relevait toute
       face à l'ombre à 34 % ; le PBR ne le fait pas, et les teintes déjà
       sombres s'effondrent au noir — c'est ce qui transforme les arbres en
       silhouettes découpées ;
     · c'est une projection, pas un écrasement : l'ordre relatif des teintes est
       conservé, la palette garde sa lecture, elle rentre seulement dans un
       domaine où l'éclairage sait la traiter.

   Les trois bornes se règlent en direct par __grade.albedo().
--------------------------------------------------------------------------- */
export const ALBEDO = {
  /* Un albédo diffus réel dépasse rarement 0,80 ; au-delà la surface renvoie
     plus de lumière qu'elle n'en reçoit dès que l'ambiant s'y ajoute. */
  maxL: 0.62,
  /* Sous ce seuil, une surface éclairée seulement par l'ambiant est un trou
     noir à l'écran. Le noir pur n'existe pas non plus dans la nature. */
  minL: 0.09,
  /* Facteur de saturation. Les teintes toon sont posées bien au-dessus de ce
     qu'une matière réelle réfléchit ; les ramener est ce qui fait passer le
     vert de « néon » à « prairie ». */
  sat: 0.62,
};

const _hsl = { h: 0, s: 0, l: 0 };

/**
 * Projette une couleur composée pour le toon dans un domaine d'albédo PBR.
 * Modifie la couleur EN PLACE et la retourne, pour pouvoir s'insérer dans les
 * chaînes existantes sans allouer à chaque appel.
 */
export function conditionAlbedo(color) {
  color.getHSL(_hsl);
  const l = Math.min(ALBEDO.maxL, Math.max(ALBEDO.minL, _hsl.l));
  color.setHSL(_hsl.h, _hsl.s * ALBEDO.sat, l);
  return color;
}

/* Rugosité par défaut du décor. Très haute, et volontairement : à 1.0 la
   spéculaire disparaît, à 0.85 il reste un voile large qui capte le ciel sur les
   arêtes supérieures. C'est ce liseré qui détache une silhouette de son fond
   sans avoir besoin d'un trait noir. Plus bas, la roche prendrait un aspect
   plastique — le défaut classique quand on passe un décor stylisé en PBR. */
const DECOR_ROUGHNESS = 0.85;

/**
 * Matériau standard du décor.
 *
 * Ex-`MeshToonMaterial`. Le toon était un plafond dur : pas de spéculaire, pas
 * d'`envMap`, pas d'`aoMap` — sa seule variable est l'angle de la face au
 * soleil. Un `scene.environment` n'a strictement aucun effet dessus, ce qui
 * rendait la lumière indirecte inatteignable et donnait à tout le décor cet
 * aspect d'aplat non éclairé.
 *
 * `MeshStandardMaterial` coûte plus cher par fragment, mais c'est lui qui ouvre
 * l'éclairage par image : c'est de là que viennent le rebond chaud du sable dans
 * les faces à l'ombre et les ombres bleutées par le ciel.
 *
 * Le nom est conservé : il est appelé depuis six fichiers, et le renommer
 * mélangerait un changement de rendu avec un renommage dans le même diff.
 */
/**
 * Matériau pour un maillage venu d'un .glb, en préservant ce qu'il porte.
 *
 * Les modèles chargés voient leur matériau REMPLACÉ : celui du fichier est un
 * PBR d'exportateur qui ne correspond ni à la palette du jeu ni à sa rugosité.
 * Mais le remplacer à la main perd tout ce que la géométrie transporte —
 * en particulier COLOR_0, où `blender/bake_ao.py` cuit l'occlusion ambiante.
 * Sans `vertexColors`, l'occlusion est présente dans le fichier, chargée en
 * mémoire, et purement et simplement ignorée au rendu.
 *
 * D'où ce passage obligé : il lit ce que porte la géométrie au lieu de le
 * supposer, donc cuire l'occlusion d'un nouveau modèle ne demande aucune
 * modification du code.
 */
export function modelMaterial(child, extra = {}) {
  const src = child.material;
  return toonMaterial({
    map: (src && src.map) || null,
    vertexColors: !!(child.geometry && child.geometry.attributes.color),
    ...extra,
  });
}

export function toonMaterial(opts = {}) {
  /* `gradientMap` n'existe pas sur le matériau standard. Les appelants n'en
     passent pas, mais on le retire par sécurité : une propriété inconnue posée
     sur un matériau Three.js est silencieusement ignorée, donc invisible au
     débogage. */
  const { gradientMap: _ignored, ...rest } = opts;
  const mat = new THREE.MeshStandardMaterial({
    roughness: DECOR_ROUGHNESS,
    metalness: 0,
    ...rest,
  });
  /* Les couleurs passées ici viennent des constantes de biome, composées pour
     le toon : elles doivent traverser le conditionnement comme les autres.
     Exception faite du blanc pur, qui n'est pas une teinte choisie mais le
     neutre par défaut d'un matériau porteur de texture ou de vertexColors — le
     conditionner assombrirait la texture qu'il ne fait que multiplier. */
  if (rest.color !== undefined && !(mat.map || mat.vertexColors)) {
    conditionAlbedo(mat.color);
  }
  return mat;
}

/** Ancien hook d'outline dans le shader toon — remplacé par attachCartoonOutline (hull). */
export function patchToonOutline(_shader) {}

/* ---------------------------------------------------------------------------
   Utilitaires géométrie
--------------------------------------------------------------------------- */
/** Applique une couleur unie par vertex sur une géométrie. */
function tint(geo, hex) {
  /* Ces teintes de sommet sont multipliées par le matériau puis par
     l'éclairage : ce sont des albédos au même titre que `color`, et elles
     traversent donc le même conditionnement. */
  const c = conditionAlbedo(new THREE.Color(hex));
  const n = geo.attributes.position.count;
  const colors = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    colors[i * 3] = c.r; colors[i * 3 + 1] = c.g; colors[i * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return geo;
}

/** Fusionne des géométries déjà teintées (tout en non-indexé pour compatibilité + flat shading). */
function fuse(list) {
  const flat = list.map((g) => (g.index ? g.toNonIndexed() : g));
  const merged = mergeGeometries(flat, false);
  merged.computeVertexNormals();
  for (const g of list) g.dispose();
  for (const g of flat) if (!list.includes(g)) g.dispose();
  return merged;
}

const cyl = (rt, rb, h, seg = 5) => new THREE.CylinderGeometry(rt, rb, h, seg);
const cone = (r, h, seg = 6) => new THREE.ConeGeometry(r, h, seg);
const ico = (r, d = 0) => new THREE.IcosahedronGeometry(r, d);
const dodeca = (r, d = 0) => new THREE.DodecahedronGeometry(r, d);
const sphere = (r, w = 6, h = 5) => new THREE.SphereGeometry(r, w, h);
const box = (x, y, z) => new THREE.BoxGeometry(x, y, z);

/* ---------------------------------------------------------------------------
   Générateurs de props — chaque fonction retourne UNE géométrie fusionnée,
   base posée sur y=0, hauteur ~1-3 unités (mise à l'échelle par instance).
--------------------------------------------------------------------------- */

/* — Tempéré — */
function makeLeafyTree() {
  const trunk = tint(cyl(0.09, 0.13, 0.7).translate(0, 0.35, 0), 0x8a5a33);
  const c1 = tint(ico(0.55, 0).translate(0, 1.05, 0), 0x4caf50);
  const c2 = tint(ico(0.4, 0).translate(0.3, 0.85, 0.12), 0x66bb6a);
  const c3 = tint(ico(0.35, 0).translate(-0.28, 0.9, -0.1), 0x43a047);
  return fuse([trunk, c1, c2, c3]);
}
function makePine(snow = false) {
  const trunk = tint(cyl(0.07, 0.1, 0.5).translate(0, 0.25, 0), 0x7a4a2a);
  const g1 = tint(cone(0.55, 0.85, 6).translate(0, 0.75, 0), snow ? 0x2e6b4f : 0x2e7d4f);
  const g2 = tint(cone(0.42, 0.7, 6).translate(0, 1.2, 0), snow ? 0x38795c : 0x388e5c);
  const g3 = tint(cone(0.28, 0.55, 6).translate(0, 1.62, 0), snow ? 0x2e6b4f : 0x2e7d4f);
  const parts = [trunk, g1, g2, g3];
  if (snow) {
    parts.push(tint(cone(0.44, 0.22, 6).translate(0, 1.06, 0), 0xf4f8ff));
    parts.push(tint(cone(0.3, 0.18, 6).translate(0, 1.48, 0), 0xf4f8ff));
    parts.push(tint(cone(0.16, 0.3, 6).translate(0, 1.82, 0), 0xffffff));
  }
  return fuse(parts);
}
function makeBush() {
  const b1 = tint(ico(0.35, 0).translate(0, 0.28, 0), 0x558b2f);
  const b2 = tint(ico(0.26, 0).translate(0.25, 0.2, 0.08), 0x689f38);
  const b3 = tint(ico(0.22, 0).translate(-0.22, 0.18, -0.06), 0x4a7c2c);
  return fuse([b1, b2, b3]);
}
function makeFlowerPatch(petal = 0xff5c8a) {
  const parts = [];
  const spots = [[0, 0], [0.28, 0.14], [-0.22, 0.2], [0.1, -0.26]];
  for (const [x, z] of spots) {
    parts.push(tint(cyl(0.012, 0.012, 0.22, 4).translate(x, 0.11, z), 0x4a8c34));
    parts.push(tint(ico(0.07, 0).translate(x, 0.25, z), petal));
    parts.push(tint(sphere(0.03, 5, 4).translate(x, 0.29, z), 0xffe082));
  }
  return fuse(parts);
}
function makeRock(color = 0x8d99a6) {
  const r1 = tint(dodeca(0.5).translate(0, 0.3, 0), color);
  const r2 = tint(dodeca(0.32).translate(0.34, 0.16, 0.16), color);
  const r3 = tint(dodeca(0.26).translate(-0.3, 0.14, -0.1), color);
  return fuse([r1, r2, r3]);
}

/* — Désert — */
function makeCactusSaguaro() {
  const body = tint(cyl(0.16, 0.18, 1.3, 7).translate(0, 0.65, 0), 0x2e9e4f);
  const top = tint(sphere(0.16, 7, 5).translate(0, 1.3, 0), 0x2e9e4f);
  const armL = tint(cyl(0.09, 0.1, 0.5, 6).translate(-0.34, 0.95, 0), 0x37a857);
  const armLh = tint(cyl(0.09, 0.09, 0.35, 6).rotateZ(Math.PI / 2).translate(-0.24, 0.72, 0), 0x37a857);
  const armR = tint(cyl(0.09, 0.1, 0.4, 6).translate(0.34, 0.78, 0), 0x37a857);
  const armRh = tint(cyl(0.09, 0.09, 0.3, 6).rotateZ(Math.PI / 2).translate(0.22, 0.6, 0), 0x37a857);
  const fleur = tint(ico(0.07, 0).translate(0, 1.42, 0), 0xff7fa5);
  return fuse([body, top, armL, armLh, armR, armRh, fleur]);
}
function makeCactusBarrel() {
  const b = tint(sphere(0.32, 8, 6).scale(1, 0.85, 1).translate(0, 0.27, 0), 0x3aa45a);
  const fl = tint(ico(0.08, 0).translate(0, 0.58, 0), 0xffc94d);
  return fuse([b, fl]);
}
function makePalmTree() {
  const trunk1 = tint(cyl(0.08, 0.12, 0.8, 5).rotateZ(0.08).translate(0.04, 0.4, 0), 0x9a6b3f);
  const trunk2 = tint(cyl(0.06, 0.08, 0.7, 5).rotateZ(0.16).translate(0.16, 1.1, 0), 0xa5764a);
  const parts = [trunk1, trunk2];
  const leafG = box(0.9, 0.03, 0.22);
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    const leaf = tint(
      leafG.clone().translate(0.45, 0, 0).rotateZ(-0.45).rotateY(a).translate(0.24, 1.5, 0),
      i % 2 ? 0x43b05c : 0x2f9a4b,
    );
    parts.push(leaf);
  }
  parts.push(tint(sphere(0.09, 5, 4).translate(0.24, 1.44, 0), 0x8a5a33));
  leafG.dispose();
  return fuse(parts);
}
function makeSkull() {
  const cr = tint(sphere(0.24, 7, 6).scale(1, 0.85, 1.05).translate(0, 0.2, 0), 0xf2ede2);
  const jaw = tint(box(0.26, 0.12, 0.2).translate(0, 0.06, 0.1), 0xe8e2d4);
  const eyeL = tint(sphere(0.055, 5, 4).translate(-0.09, 0.24, 0.19), 0x2b2b33);
  const eyeR = tint(sphere(0.055, 5, 4).translate(0.09, 0.24, 0.19), 0x2b2b33);
  return fuse([cr, jaw, eyeL, eyeR]);
}
function makeDryTuft() {
  const parts = [];
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2;
    parts.push(tint(
      cone(0.035, 0.4, 4).rotateX(0.35).rotateY(a).translate(Math.cos(a) * 0.08, 0.18, Math.sin(a) * 0.08),
      i % 2 ? 0xcbb26a : 0xb89d55,
    ));
  }
  return fuse(parts);
}

/* — Nordique — */
function makeBareTree() {
  const trunk = tint(cyl(0.07, 0.11, 1.0, 5).translate(0, 0.5, 0), 0x6b4a33);
  const b1 = tint(cyl(0.04, 0.05, 0.5, 4).rotateZ(0.7).translate(-0.22, 1.1, 0), 0x6b4a33);
  const b2 = tint(cyl(0.035, 0.045, 0.45, 4).rotateZ(-0.6).translate(0.2, 1.2, 0.05), 0x74513a);
  const b3 = tint(cyl(0.03, 0.04, 0.35, 4).rotateX(0.6).translate(0, 1.3, 0.15), 0x6b4a33);
  return fuse([trunk, b1, b2, b3]);
}
function makeSnowman() {
  const b1 = tint(sphere(0.4, 8, 6).translate(0, 0.34, 0), 0xffffff);
  const b2 = tint(sphere(0.28, 8, 6).translate(0, 0.85, 0), 0xf8fbff);
  const b3 = tint(sphere(0.2, 8, 6).translate(0, 1.24, 0), 0xffffff);
  const nose = tint(cone(0.05, 0.22, 5).rotateX(Math.PI / 2).translate(0, 1.26, 0.26), 0xff8c42);
  const eyeL = tint(sphere(0.035, 4, 4).translate(-0.08, 1.32, 0.17), 0x22262e);
  const eyeR = tint(sphere(0.035, 4, 4).translate(0.08, 1.32, 0.17), 0x22262e);
  const hat1 = tint(cyl(0.16, 0.16, 0.2, 8).translate(0, 1.48, 0), 0x37424e);
  const hat2 = tint(cyl(0.24, 0.24, 0.04, 8).translate(0, 1.4, 0), 0x2c353f);
  const armL = tint(cyl(0.025, 0.025, 0.5, 4).rotateZ(1.2).translate(-0.42, 0.95, 0), 0x6b4a33);
  const armR = tint(cyl(0.025, 0.025, 0.5, 4).rotateZ(-1.2).translate(0.42, 0.95, 0), 0x6b4a33);
  return fuse([b1, b2, b3, nose, eyeL, eyeR, hat1, hat2, armL, armR]);
}
function makeIceRock() {
  const r1 = tint(dodeca(0.45).translate(0, 0.28, 0), 0xd7e9f7);
  const r2 = tint(dodeca(0.3).translate(0.3, 0.16, 0.14), 0xbcd9ef);
  const spike = tint(cone(0.14, 0.5, 5).translate(-0.15, 0.6, -0.05), 0xe8f4ff);
  return fuse([r1, r2, spike]);
}

/* — Tropical — */
function makeJungleTree() {
  const trunk = tint(cyl(0.12, 0.17, 1.2, 6).translate(0, 0.6, 0), 0x7a5230);
  const c1 = tint(ico(0.7, 0).scale(1.15, 0.8, 1.15).translate(0, 1.55, 0), 0x1f9e46);
  const c2 = tint(ico(0.5, 0).scale(1.1, 0.75, 1.1).translate(0.45, 1.3, 0.2), 0x27ae56);
  const c3 = tint(ico(0.45, 0).scale(1.05, 0.7, 1.05).translate(-0.4, 1.35, -0.15), 0x18913e);
  return fuse([trunk, c1, c2, c3]);
}
function makeFern() {
  const parts = [];
  for (let i = 0; i < 7; i++) {
    const a = (i / 7) * Math.PI * 2;
    parts.push(tint(
      box(0.5, 0.02, 0.14).translate(0.25, 0, 0).rotateZ(-0.5).rotateY(a).translate(0, 0.15, 0),
      i % 2 ? 0x2fae52 : 0x24923f,
    ));
  }
  return fuse(parts);
}
function makeGiantFlower() {
  const stem = tint(cyl(0.035, 0.045, 0.7, 5).translate(0, 0.35, 0), 0x2f8a3c);
  const parts = [stem];
  const petalG = box(0.3, 0.04, 0.16);
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    parts.push(tint(
      petalG.clone().translate(0.18, 0, 0).rotateZ(0.25).rotateY(a).translate(0, 0.72, 0),
      0xff4f9e,
    ));
  }
  parts.push(tint(sphere(0.1, 6, 5).translate(0, 0.75, 0), 0xffd54f));
  petalG.dispose();
  return fuse(parts);
}
function makeMushroom() {
  const stem = tint(cyl(0.09, 0.12, 0.35, 6).translate(0, 0.17, 0), 0xf2e8d8);
  const cap = tint(sphere(0.28, 8, 5, 0, Math.PI * 2, 0, Math.PI / 2).translate(0, 0.33, 0), 0xe53935);
  const d1 = tint(sphere(0.05, 4, 4).translate(0.12, 0.5, 0.1), 0xffffff);
  const d2 = tint(sphere(0.04, 4, 4).translate(-0.13, 0.47, -0.05), 0xffffff);
  const d3 = tint(sphere(0.035, 4, 4).translate(0.02, 0.55, -0.14), 0xffffff);
  return fuse([stem, cap, d1, d2, d3]);
}

/* — Savane — */
function makeAcacia() {
  const trunk = tint(cyl(0.09, 0.13, 1.1, 5).rotateZ(0.12).translate(0, 0.55, 0), 0x8a6240);
  const fork = tint(cyl(0.06, 0.08, 0.5, 4).rotateZ(-0.5).translate(0.22, 1.15, 0), 0x8a6240);
  const canopy = tint(cyl(0.95, 0.55, 0.35, 8).translate(0.1, 1.5, 0), 0x7aa83c);
  const canopy2 = tint(cyl(0.6, 0.4, 0.22, 7).translate(-0.25, 1.62, 0.15), 0x8ab84a);
  return fuse([trunk, fork, canopy, canopy2]);
}
function makeTermiteMound() {
  const m1 = tint(cone(0.4, 1.0, 7).translate(0, 0.5, 0), 0xb5793f);
  const m2 = tint(cone(0.25, 0.7, 6).translate(0.25, 0.35, 0.1), 0xc08748);
  const m3 = tint(cone(0.18, 0.5, 5).translate(-0.24, 0.25, -0.08), 0xa96f38);
  return fuse([m1, m2, m3]);
}
function makeTallGrass() {
  const parts = [];
  for (let i = 0; i < 7; i++) {
    const a = Math.random() * Math.PI * 2, r = Math.random() * 0.18;
    parts.push(tint(
      cone(0.03, 0.55 + Math.random() * 0.3, 4).rotateX((Math.random() - 0.5) * 0.4).rotateZ((Math.random() - 0.5) * 0.4)
        .translate(Math.cos(a) * r, 0.28, Math.sin(a) * r),
      i % 2 ? 0xd4b85a : 0xc2a64b,
    ));
  }
  return fuse(parts);
}

/* — Volcanique — */
function makeBasaltSpike() {
  const s1 = tint(cyl(0.12, 0.3, 1.4, 5).translate(0, 0.7, 0), 0x3a3a44);
  const s2 = tint(cyl(0.08, 0.2, 0.9, 5).translate(0.3, 0.45, 0.1), 0x44444f);
  const s3 = tint(cyl(0.06, 0.16, 0.6, 5).translate(-0.26, 0.3, -0.08), 0x32323b);
  return fuse([s1, s2, s3]);
}
function makeLavaCrystal() {
  const c1 = tint(new THREE.OctahedronGeometry(0.3, 0).scale(1, 1.6, 1).translate(0, 0.42, 0), 0xff6d2e);
  const c2 = tint(new THREE.OctahedronGeometry(0.18, 0).scale(1, 1.5, 1).rotateZ(0.4).translate(0.26, 0.24, 0.08), 0xffa040);
  const base = tint(dodeca(0.28).translate(0, 0.1, 0), 0x3a3a44);
  return fuse([c1, c2, base]);
}
function makeDeadTree() {
  const trunk = tint(cyl(0.08, 0.13, 1.1, 5).rotateZ(0.1).translate(0, 0.55, 0), 0x4a3b33);
  const b1 = tint(cyl(0.04, 0.06, 0.6, 4).rotateZ(0.9).translate(-0.28, 1.05, 0), 0x4a3b33);
  const b2 = tint(cyl(0.035, 0.05, 0.5, 4).rotateZ(-0.7).translate(0.24, 1.2, 0.06), 0x554438);
  return fuse([trunk, b1, b2]);
}

/* ---------------------------------------------------------------------------
   Habitations locales

   Un modèle par biome, en cohérence culturelle : chaumière tempérée, tente de
   nomade au désert, cabane en rondins au nord, hutte sur pilotis en jungle,
   rondavel en savane, ruine calcinée sur les terres de cendre. Silhouettes
   simples pour rester lisibles en plongée, empreinte au sol ~1,4 unité pour
   que la foule contourne sans être coincée.
--------------------------------------------------------------------------- */

/* Prairie : maisonnette à colombages, toit de chaume à deux pans */
function makeCottage() {
  const base = tint(box(0.9, 0.55, 0.7).translate(0, 0.28, 0), 0xefe0c4);
  // colombages : quatre poteaux + linteau
  const p1 = tint(box(0.06, 0.55, 0.06).translate(-0.42, 0.28, 0.32), 0x5a3a1e);
  const p2 = tint(box(0.06, 0.55, 0.06).translate(0.42, 0.28, 0.32), 0x5a3a1e);
  const p3 = tint(box(0.06, 0.55, 0.06).translate(-0.42, 0.28, -0.32), 0x5a3a1e);
  const p4 = tint(box(0.06, 0.55, 0.06).translate(0.42, 0.28, -0.32), 0x5a3a1e);
  const lint = tint(box(0.9, 0.06, 0.7).translate(0, 0.55, 0), 0x5a3a1e);
  // toit à deux pans : pans horizontaux inclinés autour de Z (Y = normale par
   // défaut), pas de rotateX qui les redresserait à la verticale. Le corps mesure
   // 0,9×0,7 : chaque pan couvre 0,45 en X, on prend 0,5 pour la marge de bord.
  const roofL = tint(box(0.5, 0.05, 0.78).rotateZ(0.55).translate(-0.22, 0.75, 0), 0xa76c3a);
  const roofR = tint(box(0.5, 0.05, 0.78).rotateZ(-0.55).translate(0.22, 0.75, 0), 0xa76c3a);
  // faîtière et cheminée, calées sur la ligne où les deux pans se rejoignent
  const ridge = tint(box(0.08, 0.08, 0.78).translate(0, 0.9, 0), 0x8a5a2c);
  const chim = tint(box(0.14, 0.32, 0.14).translate(0.28, 0.96, 0.18), 0x6d6d78);
  // porte
  const door = tint(box(0.22, 0.36, 0.02).translate(0, 0.18, 0.36), 0x4a2f18);
  return fuse([base, p1, p2, p3, p4, lint, roofL, roofR, ridge, chim, door]);
}

/* Désert : tente conique de nomade, à toile rayée et piquet central */
function makeNomadTent() {
  // corps conique
  const body = tint(cone(0.55, 0.85, 8).translate(0, 0.42, 0), 0xd8b984);
  // bandes verticales (rayures) suggérées par de fines lamelles
  const parts = [body];
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + 0.4;
    parts.push(tint(
      box(0.04, 0.7, 0.5).rotateY(a).translate(Math.cos(a) * 0.28, 0.4, Math.sin(a) * 0.28),
      0xb08a4c,
    ));
  }
  // piquet central qui dépasse
  parts.push(tint(cyl(0.02, 0.02, 0.35, 4).translate(0, 1.02, 0), 0x5a3a1e));
  // pierres au pied (lestent la toile)
  parts.push(tint(dodeca(0.09).translate(0.48, 0.05, 0.18), 0x9d8562));
  parts.push(tint(dodeca(0.07).translate(-0.42, 0.04, -0.28), 0x8f7654));
  // ouverture (fente sombre à l'avant)
  parts.push(tint(box(0.14, 0.42, 0.02).translate(0, 0.22, 0.5), 0x3a2a18));
  return fuse(parts);
}

/* Toundra : cabane en rondins avec toit enneigé */
function makeLogCabin() {
  const parts = [];
  // quatre rangs de rondins horizontaux, un par mur
  for (let r = 0; r < 4; r++) {
    const y = 0.14 + r * 0.16;
    parts.push(tint(cyl(0.08, 0.08, 0.95, 6).rotateZ(Math.PI / 2).translate(0, y, 0.42), 0x8a5c34));
    parts.push(tint(cyl(0.08, 0.08, 0.95, 6).rotateZ(Math.PI / 2).translate(0, y, -0.42), 0x8a5c34));
    parts.push(tint(cyl(0.08, 0.08, 0.85, 6).rotateX(Math.PI / 2).translate(0.42, y, 0), 0x7a4f2c));
    parts.push(tint(cyl(0.08, 0.08, 0.85, 6).rotateX(Math.PI / 2).translate(-0.42, y, 0), 0x7a4f2c));
  }
  // toit à deux pans
  parts.push(tint(box(0.5, 0.06, 0.95).rotateZ(0.55).translate(-0.22, 0.9, 0), 0x5a3a1e));
  parts.push(tint(box(0.5, 0.06, 0.95).rotateZ(-0.55).translate(0.22, 0.9, 0), 0x5a3a1e));
  // couverture de neige (deux boîtes juste au-dessus du toit)
  parts.push(tint(box(0.5, 0.07, 0.95).rotateZ(0.55).translate(-0.24, 0.98, 0), 0xf4f8ff));
  parts.push(tint(box(0.5, 0.07, 0.95).rotateZ(-0.55).translate(0.24, 0.98, 0), 0xf4f8ff));
  // porte
  parts.push(tint(box(0.22, 0.36, 0.03).translate(0, 0.2, 0.44), 0x3d2818));
  return fuse(parts);
}

/* Jungle : hutte sur pilotis, toit de palmes */
function makeStiltHut() {
  const parts = [];
  // quatre pilotis
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    parts.push(tint(cyl(0.05, 0.06, 0.5, 5).translate(sx * 0.35, 0.25, sz * 0.35), 0x6a4a2e));
  }
  // plancher
  parts.push(tint(box(0.9, 0.06, 0.9).translate(0, 0.55, 0), 0x8a6a3e));
  // corps (mur en bambou)
  parts.push(tint(box(0.75, 0.45, 0.75).translate(0, 0.83, 0), 0xcbb27a));
  // toit de palmes (cône large et plat)
  parts.push(tint(cone(0.75, 0.45, 8).translate(0, 1.28, 0), 0x2f8a3f));
  // échelle vers l'avant
  parts.push(tint(cyl(0.03, 0.03, 0.6, 4).rotateX(0.5).translate(0, 0.32, 0.5), 0x6a4a2e));
  parts.push(tint(cyl(0.03, 0.03, 0.6, 4).rotateX(0.5).translate(0.15, 0.32, 0.5), 0x6a4a2e));
  return fuse(parts);
}

/* Savane : rondavel — cylindre bas d'argile, toit conique de chaume */
function makeRondavel() {
  const wall = tint(cyl(0.55, 0.58, 0.6, 12).translate(0, 0.3, 0), 0xc48a5c);
  const rim = tint(cyl(0.62, 0.62, 0.04, 12).translate(0, 0.62, 0), 0xa5714a);
  const roof = tint(cone(0.68, 0.7, 12).translate(0, 0.95, 0), 0xa76c3a);
  // motif clair sous le toit (bande décorative)
  const band = tint(cyl(0.585, 0.585, 0.06, 12).translate(0, 0.5, 0), 0xe5c896);
  // porte
  const door = tint(box(0.24, 0.36, 0.04).translate(0, 0.2, 0.58), 0x3d2818);
  return fuse([wall, band, rim, roof, door]);
}

/* Terres de cendre : ruine — trois pans de mur, poutre calcinée en travers */
function makeRuin() {
  const parts = [];
  // pans de mur (pierre sombre), un tronqué pour l'aspect ruine
  parts.push(tint(box(0.7, 0.55, 0.14).translate(0, 0.28, -0.35), 0x5a5058));
  parts.push(tint(box(0.14, 0.45, 0.55).translate(-0.35, 0.23, -0.05), 0x504650));
  parts.push(tint(box(0.14, 0.3, 0.3).translate(0.35, 0.15, 0.05), 0x545048));    // mur écroulé
  // poutre effondrée en travers
  parts.push(tint(cyl(0.05, 0.05, 0.75, 5).rotateX(0.9).translate(0, 0.35, 0.1), 0x2a1e18));
  // gravats
  parts.push(tint(dodeca(0.14).translate(0.36, 0.07, 0.35), 0x605258));
  parts.push(tint(dodeca(0.11).translate(-0.05, 0.05, 0.42), 0x555058));
  return fuse(parts);
}

/* Prairie — moulin à vent : tour cylindrique + 4 ailes en croix (grand) */
function makeWindmill() {
  const parts = [];
  parts.push(tint(cyl(0.35, 0.45, 1.0, 10).translate(0, 0.5, 0), 0xd8c9a4));   // tour
  parts.push(tint(cone(0.36, 0.28, 10).translate(0, 1.14, 0), 0x8a5a2c));        // toit conique
  parts.push(tint(box(0.06, 0.06, 0.06).translate(0, 1.05, 0.35), 0x3a2418));   // moyeu
  // ailes en croix (X et Z)
  parts.push(tint(box(1.4, 0.06, 0.16).translate(0, 1.05, 0.42), 0xece5cf));
  parts.push(tint(box(0.16, 0.06, 1.4).rotateX(0.0).translate(0, 1.05, 0.42), 0xece5cf));
  parts.push(tint(box(0.22, 0.34, 0.03).translate(0, 0.22, 0.44), 0x4a2f18));  // porte
  return fuse(parts);
}

/* Prairie — grange à foin (moyen) */
function makeHayBarn() {
  const parts = [];
  parts.push(tint(box(0.95, 0.5, 0.7).translate(0, 0.25, 0), 0xa66a3c));
  parts.push(tint(box(0.5, 0.05, 0.75).rotateZ(0.5).translate(-0.24, 0.6, 0), 0x6d4522));
  parts.push(tint(box(0.5, 0.05, 0.75).rotateZ(-0.5).translate(0.24, 0.6, 0), 0x6d4522));
  parts.push(tint(box(0.08, 0.08, 0.75).translate(0, 0.72, 0), 0x5a3618));
  // porte grande + paille sortant
  parts.push(tint(box(0.4, 0.45, 0.03).translate(0, 0.22, 0.36), 0x3d2410));
  parts.push(tint(ico(0.12, 0).translate(0.35, 0.08, 0.4), 0xdec568));   // botte de foin
  return fuse(parts);
}

/* Prairie — chapelle basse (petit) */
function makeChapel() {
  const parts = [];
  parts.push(tint(box(0.55, 0.5, 0.9).translate(0, 0.25, 0), 0xefe5d0));
  parts.push(tint(box(0.32, 0.05, 0.95).rotateZ(0.6).translate(-0.15, 0.58, 0), 0x6d3a2a));
  parts.push(tint(box(0.32, 0.05, 0.95).rotateZ(-0.6).translate(0.15, 0.58, 0), 0x6d3a2a));
  // clocher
  parts.push(tint(box(0.22, 0.35, 0.22).translate(0, 0.7, -0.4), 0xefe5d0));
  parts.push(tint(cone(0.16, 0.28, 6).translate(0, 1.02, -0.4), 0x8a3a2a));
  // croix : deux fines boîtes
  parts.push(tint(box(0.03, 0.18, 0.03).translate(0, 1.24, -0.4), 0x2a1e18));
  parts.push(tint(box(0.11, 0.03, 0.03).translate(0, 1.22, -0.4), 0x2a1e18));
  return fuse(parts);
}

/* Désert — tente rectangulaire (moyen) */
function makeSquareTent() {
  const parts = [];
  parts.push(tint(box(0.85, 0.45, 0.7).translate(0, 0.22, 0), 0xd8b984));
  // toit pyramidal (deux triangles)
  parts.push(tint(box(0.5, 0.05, 0.75).rotateZ(0.55).translate(-0.22, 0.55, 0), 0xa87a48));
  parts.push(tint(box(0.5, 0.05, 0.75).rotateZ(-0.55).translate(0.22, 0.55, 0), 0xa87a48));
  // haubans
  parts.push(tint(cyl(0.02, 0.02, 0.42, 4).rotateX(0.55).translate(0.5, 0.15, 0.35), 0x5a3a1e));
  parts.push(tint(cyl(0.02, 0.02, 0.42, 4).rotateX(-0.55).translate(-0.5, 0.15, -0.35), 0x5a3a1e));
  // entrée
  parts.push(tint(box(0.18, 0.35, 0.02).translate(0, 0.18, 0.36), 0x3a2418));
  return fuse(parts);
}

/* Désert — hutte de torchis basse (petit) */
function makeMudHut() {
  const parts = [];
  parts.push(tint(cyl(0.45, 0.5, 0.5, 10).translate(0, 0.25, 0), 0xb08a5c));
  parts.push(tint(cone(0.55, 0.42, 10).translate(0, 0.71, 0), 0x8c6238));
  parts.push(tint(box(0.14, 0.28, 0.03).translate(0, 0.16, 0.5), 0x3a2418));
  return fuse(parts);
}

/* Désert — échoppe à toit plat sur poteaux (moyen) */
function makeMarketStall() {
  const parts = [];
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    parts.push(tint(cyl(0.03, 0.04, 0.7, 4).translate(sx * 0.4, 0.35, sz * 0.35), 0x6a4a2e));
  }
  parts.push(tint(box(0.95, 0.05, 0.8).translate(0, 0.72, 0), 0xcb9a5c));    // toit plat
  parts.push(tint(box(0.7, 0.14, 0.6).translate(0, 0.4, 0), 0xb07a3a));       // comptoir
  parts.push(tint(box(0.14, 0.08, 0.14).translate(0.22, 0.52, 0.15), 0xe6a34a));  // paniers
  parts.push(tint(box(0.14, 0.08, 0.14).translate(-0.15, 0.52, 0.10), 0xd88a3a));
  return fuse(parts);
}

/* Toundra — longue maison (grand) */
function makeLonghouse() {
  const parts = [];
  parts.push(tint(box(0.9, 0.5, 1.6).translate(0, 0.25, 0), 0x8a5c34));
  parts.push(tint(box(0.5, 0.05, 1.7).rotateZ(0.55).translate(-0.22, 0.63, 0), 0x5a3a1e));
  parts.push(tint(box(0.5, 0.05, 1.7).rotateZ(-0.55).translate(0.22, 0.63, 0), 0x5a3a1e));
  // neige sur le toit
  parts.push(tint(box(0.5, 0.05, 1.7).rotateZ(0.55).translate(-0.24, 0.7, 0), 0xf4f8ff));
  parts.push(tint(box(0.5, 0.05, 1.7).rotateZ(-0.55).translate(0.24, 0.7, 0), 0xf4f8ff));
  parts.push(tint(box(0.22, 0.36, 0.03).translate(0, 0.22, 0.82), 0x3a2418));
  return fuse(parts);
}

/* Toundra — igloo (petit) */
function makeIgloo() {
  const parts = [];
  // dôme : demi-sphère
  parts.push(tint(sphere(0.5, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2).translate(0, 0, 0), 0xdae8f7));
  // liseré au sol
  parts.push(tint(cyl(0.52, 0.52, 0.08, 10).translate(0, 0.04, 0), 0xc4d3e2));
  // tunnel d'entrée
  parts.push(tint(sphere(0.22, 8, 5, 0, Math.PI * 2, 0, Math.PI / 2).scale(1, 1, 1.6).translate(0, 0, 0.42), 0xdae8f7));
  // ouverture sombre
  parts.push(tint(box(0.14, 0.16, 0.02).translate(0, 0.09, 0.72), 0x2a2a30));
  return fuse(parts);
}

/* Toundra — dépôt de rondins (moyen) */
function makeStorageHut() {
  const parts = [];
  // 4 pilotis courts
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    parts.push(tint(cyl(0.05, 0.05, 0.3, 5).translate(sx * 0.28, 0.15, sz * 0.28), 0x6a4a2e));
  }
  // caisson en rondins
  for (let r = 0; r < 3; r++) {
    const y = 0.34 + r * 0.14;
    parts.push(tint(cyl(0.07, 0.07, 0.7, 6).rotateZ(Math.PI / 2).translate(0, y, 0.32), 0x7a4f2c));
    parts.push(tint(cyl(0.07, 0.07, 0.7, 6).rotateZ(Math.PI / 2).translate(0, y, -0.32), 0x7a4f2c));
  }
  // toit à une pente et neige
  parts.push(tint(box(0.75, 0.06, 0.75).rotateZ(0.4).translate(0, 0.76, 0), 0x5a3a1e));
  parts.push(tint(box(0.75, 0.05, 0.75).rotateZ(0.4).translate(0, 0.82, 0), 0xf4f8ff));
  return fuse(parts);
}

/* Jungle — dôme de chaume (petit) */
function makeThatchDome() {
  const parts = [];
  parts.push(tint(cyl(0.5, 0.5, 0.35, 10).translate(0, 0.18, 0), 0xcbb27a));
  parts.push(tint(sphere(0.55, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2).scale(1, 1.1, 1).translate(0, 0.35, 0), 0x2f8a3f));
  parts.push(tint(box(0.16, 0.28, 0.02).translate(0, 0.16, 0.5), 0x3d2818));
  return fuse(parts);
}

/* Jungle — cabane arboricole (moyen) */
function makeTreeHut() {
  const parts = [];
  // gros tronc porteur
  parts.push(tint(cyl(0.14, 0.18, 1.4, 6).translate(0, 0.7, 0), 0x7a5230));
  // plancher haut
  parts.push(tint(box(0.9, 0.06, 0.9).translate(0, 1.05, 0), 0x8a6a3e));
  // cabane sur ce plancher
  parts.push(tint(box(0.7, 0.35, 0.7).translate(0, 1.28, 0), 0xcbb27a));
  parts.push(tint(cone(0.68, 0.35, 8).translate(0, 1.63, 0), 0x2f8a3f));
  // échelle contre le tronc
  parts.push(tint(cyl(0.03, 0.03, 1.0, 4).rotateX(0.4).translate(0, 0.55, 0.35), 0x6a4a2e));
  return fuse(parts);
}

/* Jungle — petit sanctuaire de pierre (moyen) */
function makeStoneShrine() {
  const parts = [];
  parts.push(tint(box(0.85, 0.28, 0.85).translate(0, 0.14, 0), 0x7d6e5c));       // socle
  // quatre colonnes
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    parts.push(tint(cyl(0.08, 0.09, 0.55, 6).translate(sx * 0.32, 0.55, sz * 0.32), 0x8a7a68));
  }
  // linteau + toit pyramidal
  parts.push(tint(box(0.9, 0.09, 0.9).translate(0, 0.86, 0), 0x6a5c4c));
  parts.push(tint(cone(0.55, 0.4, 4).translate(0, 1.1, 0), 0x2f8a3f));   // mousse végétale
  // idole au centre
  parts.push(tint(cone(0.12, 0.35, 5).translate(0, 0.45, 0), 0x5a4a3a));
  return fuse(parts);
}

/* Savane — grenier rond sur pilotis (moyen) */
function makeGranary() {
  const parts = [];
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    parts.push(tint(cyl(0.05, 0.05, 0.35, 5).translate(sx * 0.22, 0.17, sz * 0.22), 0x6a4a2e));
  }
  parts.push(tint(cyl(0.45, 0.45, 0.05, 10).translate(0, 0.36, 0), 0x8a6a3e));   // plancher
  parts.push(tint(cyl(0.42, 0.42, 0.4, 10).translate(0, 0.6, 0), 0xc48a5c));      // pot
  parts.push(tint(cone(0.5, 0.45, 10).translate(0, 1.0, 0), 0xa76c3a));          // toit conique
  return fuse(parts);
}

/* Savane — kraal : hutte centrale + palissade circulaire (grand) */
function makeKraal() {
  const parts = [];
  // hutte centrale
  parts.push(tint(cyl(0.35, 0.38, 0.4, 10).translate(0, 0.2, 0), 0xc48a5c));
  parts.push(tint(cone(0.45, 0.35, 10).translate(0, 0.58, 0), 0xa76c3a));
  // palissade en pieux (10 pieux en cercle)
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2;
    parts.push(tint(cyl(0.03, 0.03, 0.4, 4).translate(Math.cos(a) * 0.75, 0.2, Math.sin(a) * 0.75), 0x6a4a2e));
  }
  // ouverture : deux pieux marquant l'entrée
  parts.push(tint(cyl(0.04, 0.04, 0.48, 4).translate(0.75, 0.24, 0), 0x8a6a3e));
  parts.push(tint(cyl(0.04, 0.04, 0.48, 4).translate(-0.75, 0.24, 0), 0x8a6a3e));
  return fuse(parts);
}

/* Savane — tour de guet sur pilotis (petit) */
function makeWatchTower() {
  const parts = [];
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    parts.push(tint(cyl(0.05, 0.06, 1.0, 4).translate(sx * 0.2, 0.5, sz * 0.2), 0x6a4a2e));
  }
  parts.push(tint(box(0.6, 0.06, 0.6).translate(0, 1.02, 0), 0x8a6a3e));   // plancher
  // parapet à claire-voie
  parts.push(tint(box(0.6, 0.15, 0.03).translate(0, 1.13, 0.3), 0x8a6a3e));
  parts.push(tint(box(0.6, 0.15, 0.03).translate(0, 1.13, -0.3), 0x8a6a3e));
  parts.push(tint(box(0.03, 0.15, 0.6).translate(0.3, 1.13, 0), 0x8a6a3e));
  parts.push(tint(box(0.03, 0.15, 0.6).translate(-0.3, 1.13, 0), 0x8a6a3e));
  // toit conique de chaume
  parts.push(tint(cone(0.5, 0.4, 6).translate(0, 1.5, 0), 0xd8bd63));
  return fuse(parts);
}

/* Volcanique — tour éboulée (moyen) */
function makeCollapsedTower() {
  const parts = [];
  // base circulaire complète
  parts.push(tint(cyl(0.4, 0.42, 0.5, 8).translate(0, 0.25, 0), 0x504650));
  // moitié haute tronquée (représentée par un cylindre de moitié de hauteur)
  parts.push(tint(cyl(0.36, 0.4, 0.35, 8).translate(-0.05, 0.68, -0.02), 0x554850));
  // brèche : un gros bloc décalé
  parts.push(tint(box(0.28, 0.28, 0.28).translate(0.42, 0.14, 0.28), 0x605258));
  // gravats
  parts.push(tint(dodeca(0.12).translate(-0.35, 0.06, 0.35), 0x555058));
  parts.push(tint(dodeca(0.09).translate(0.2, 0.05, -0.42), 0x504650));
  return fuse(parts);
}

/* Volcanique — tombeau (petit) */
function makeTomb() {
  const parts = [];
  parts.push(tint(box(0.7, 0.35, 0.5).translate(0, 0.17, 0), 0x504650));
  // couvercle légèrement décalé (comme s'il avait glissé)
  parts.push(tint(box(0.75, 0.08, 0.55).translate(0.05, 0.38, 0), 0x605258));
  // stèle
  parts.push(tint(box(0.16, 0.42, 0.06).translate(-0.32, 0.42, 0), 0x484048));
  return fuse(parts);
}

/* Volcanique — autel de pierre + colonnes brisées (moyen) */
function makeAltar() {
  const parts = [];
  parts.push(tint(box(0.9, 0.14, 0.55).translate(0, 0.07, 0), 0x605258));   // socle rectangulaire
  parts.push(tint(box(0.4, 0.28, 0.35).translate(0, 0.28, 0), 0x484048));   // autel central
  // deux colonnes brisées de hauteurs différentes
  parts.push(tint(cyl(0.08, 0.09, 0.5, 6).translate(-0.36, 0.39, 0.16), 0x8a7a68));
  parts.push(tint(cyl(0.08, 0.09, 0.32, 6).translate(0.36, 0.3, 0.16), 0x847668));
  // braise éteinte sur l'autel (petite gemme sombre)
  parts.push(tint(ico(0.07, 0).translate(0, 0.46, 0), 0x3a2018));
  return fuse(parts);
}

/* Monuments des tuiles sanctuaire (Lieux Saints, GDD §4.3) : un volume unique
   et lisible au centre de la tuile, choisi pour trancher avec le décor courant. */
export const SANCTUARY_MAKERS = [makeAltar, makeStoneShrine, makeRuin, makeTomb, makeCollapsedTower];

/* ---------------------------------------------------------------------------
   Palettes de biomes
--------------------------------------------------------------------------- */
export const BIOMES = {
  temperate: {
    name: 'Prairie',
    ground: [0x8ef05a, 0x5ed86a, 0xb4f06e],
    /* Herbe : rien n'est chassé, la tige se couche puis se relève. Trace
       basse et courte — c'est le sol qui retient le moins, après la roche. */
    footprint: { kind: 'press', color: 0x2f4a22, opacity: 0.20, size: 0.60 },
    edge: 0x8fa07a,
    sky: 0x9fdcff, fogNear: 70, fogFar: 165,
    fogColor: 0x8ec3eb, fogDensity: 0.0072,
    hemiSky: 0xcfefff, hemiGround: 0x4a7a4f,
    mountainTop: 0xf4f7fc, mountainBase: 0x6b7280,
    accentLight: 0xfff4c2, // Contre-jour doré chaud
    pathColor: 0xa87a4a,   // Sentier de terre ocre
    torchColor: 0xff8c2a,  // Feu orange vif
    grass: { count: 0, color: 0x74c94a, scale: [0.50, 0.85] },
    trees: [],
    props: [],
    nature: [
      { key: 'tree', count: 44, scale: [5.7, 8.1] },
      { key: 'pine', count: 24, scale: [5.9, 8.8] },
      { key: 'bush', count: 42, scale: [0.9, 1.5], kind: 'ground', shadow: false, clump: 3, spread: 1.3 },
      { key: 'bushFlowers', count: 26, scale: [0.9, 1.4], kind: 'ground', shadow: false, clump: 2 },
      { key: 'flowerGroup', count: 96, scale: [0.6, 1.0], kind: 'ground', shadow: false, clump: 4, spread: 1.6 },
      { key: 'flowerSingle', count: 84, scale: [0.5, 0.8], kind: 'ground', shadow: false, clump: 4, spread: 1.6 },
      { key: 'clover', count: 110, scale: [0.5, 0.9], kind: 'ground', shadow: false, clump: 4, spread: 1.6 },
      /* Trois strates d'herbe : une nappe dense en amas, une couche haute plus
         claire par-dessus, un semis clairsemé pour lier les plaques nues.
         Le gros de la densité passe par grassTuft : à 155 triangles la touffe,
         c'est trois fois moins cher que grassWispy pour un rendu équivalent en
         nappe. Les couches chères restent des accents. */
      { key: 'grassTuft', count: 2125, scale: [0.7, 1.2], kind: 'grass', shadow: false, clump: 4, spread: 1.6 },
      /* Fond semé au hasard, sans amas : les paquets créent des trous, et une
         tuile entièrement chauve se relit comme une pièce de maquette. */
      { key: 'grassTuft', count: 1364, scale: [0.5, 0.9], kind: 'grass', shadow: false },
      { key: 'grassTall', count: 950, scale: [0.8, 1.3], kind: 'grass', shadow: false, clump: 4, spread: 1.6 },
      { key: 'grassWispy', count: 240, scale: [0.6, 1.0], kind: 'grass', shadow: false, tint: 0xa8d478, clump: 4 },
      { key: 'mushroom', count: 22, scale: [0.5, 0.9], kind: 'ground', shadow: false, clump: 3, spread: 0.7 },
      { key: 'rock', count: 12, scale: [2.2, 4.2], kind: 'tree' },
      /* Cailloutis : 72 à 124 triangles la pièce, la façon la moins chère de
         meubler un sol. On en met partout, plus des poignées en amas. */
      { key: 'pebbleR', count: 130, scale: [0.35, 0.85], kind: 'ground', shadow: false, clump: 5, spread: 0.9 },
      { key: 'pebbleR', count: 242, scale: [0.25, 0.6], kind: 'ground', shadow: false, tint: 0xbdc2b4 },
      { key: 'pebbleS', count: 120, scale: [0.3, 0.7], kind: 'ground', shadow: false, clump: 4, spread: 0.8, tint: 0xbfc4b8 },
      { key: 'pebbleS', count: 220, scale: [0.2, 0.5], kind: 'ground', shadow: false, tint: 0xa89a86 },
      /* Pierres plates affleurantes : elles cassent le vert continu, comme un
         pré vraiment piétiné. On n'utilise que les galets RONDS du pack —
         les variantes carrées sont des pavés en grille, elles se lisaient
         comme un dallage posé au milieu de la prairie. */
      { key: 'slabRound', count: 80, scale: [0.56, 1.12], kind: 'ground', shadow: false, flat: true, clump: 2, spread: 1.8, tint: 0xa8a49a },
      { key: 'slabRoundThin', count: 60, scale: [0.6, 1.25], kind: 'ground', shadow: false, flat: true, clump: 2, spread: 1.8, tint: 0xb2a891 },
    ],
  },
  desert: {
    name: 'Désert',
    ground: [0xf6d87a, 0xefc45c, 0xffe59a],
    /* Sable : la matière la plus expressive du jeu. Elle se creuse et forme un
       bourrelet clair, très lisible sous un soleil rasant. */
    footprint: { kind: 'dimple', color: 0x8a6a30, opacity: 0.42, size: 0.66 },
    edge: 0xcfa45c,
    /* Pas de groundMatter : le désert garde l'aplat toon des autres biomes.
       La matière cuite (sable + terre craquelée) découpait chaque tuile en
       plaques orangées très contrastées, un motif qui prenait le pas sur la
       lecture de la carte au lieu de l'habiller. Le shader reste en place et
       inerte — sans cette clé, uGroundTexAmt est à zéro. */
    sky: 0xffe3b3, fogNear: 65, fogFar: 155,
    fogColor: 0xebd49e, fogDensity: 0.0082,
    hemiSky: 0xffe9c4, hemiGround: 0x9a7648,
    mountainTop: 0xe8b477, mountainBase: 0xb37c44,
    accentLight: 0xffb347,
    pathColor: 0xc4823a,
    torchColor: 0xff4a0a,
    grass: { count: 0, color: 0xc9a86a, scale: [0.34, 0.58] },
    trees: [],
    props: [],
    nature: [
      { key: 'cactus', count: 44, scale: [2.4, 4.6] },
      { key: 'dead', count: 16, scale: [4.6, 6.6] },
      { key: 'palms', count: 9, scale: [4.2, 5.6], doubleSide: true },
      { key: 'rock', count: 20, scale: [2.2, 4.6], tint: 0xd9b078 },
      /* Le sable seul est le pire des sols plats : tout le relief vient des
         cailloutis, des plaques de roche mise à nu et des touffes sèches. */
      { key: 'pebbleS', count: 200, scale: [0.35, 0.9], kind: 'ground', shadow: false, tint: 0xe8c88a, clump: 4, spread: 1.6 },
      { key: 'pebbleS', count: 352, scale: [0.2, 0.5], kind: 'ground', shadow: false, tint: 0xdcbc86 },
      { key: 'pebbleR', count: 150, scale: [0.3, 0.75], kind: 'ground', shadow: false, tint: 0xd6ae74, clump: 5, spread: 1.0 },
      { key: 'pebbleR', count: 264, scale: [0.22, 0.5], kind: 'ground', shadow: false, tint: 0xc99a68 },
      { key: 'grassWispy', count: 780, scale: [0.6, 1.0], kind: 'grass', shadow: false, tint: 0xd8bd63, clump: 4, spread: 1.6 },
      { key: 'grassTuft', count: 700, scale: [0.5, 0.9], kind: 'grass', shadow: false, tint: 0xc9a95c, clump: 4, spread: 1.6 },
      { key: 'grassTuft', count: 704, scale: [0.4, 0.7], kind: 'grass', shadow: false, tint: 0xbf9e52 },
      { key: 'bush', count: 20, scale: [0.7, 1.2], kind: 'ground', shadow: false, tint: 0xbfa963, clump: 2 },
      { key: 'slabRoundThin', count: 95, scale: [0.62, 1.36], kind: 'ground', shadow: false, flat: true, clump: 2, spread: 1.8, tint: 0xd9b47c },
      { key: 'slabRound', count: 70, scale: [0.6, 1.2], kind: 'ground', shadow: false, flat: true, clump: 2, spread: 1.8, tint: 0xc99a5e },
    ],
  },
  nordic: {
    name: 'Toundra',
    ground: [0xf2f7fd, 0xdde9f5, 0xffffff],
    /* Neige : creuse encore plus franchement que le sable, et l'ombre du creux
       y vire au bleu — c'est le ciel qui l'éclaire, pas le soleil. */
    footprint: { kind: 'dimple', color: 0x6f88ad, opacity: 0.50, size: 0.68 },
    edge: 0xc4d3e2,
    sky: 0xcfe4f7, fogNear: 60, fogFar: 150,
    fogColor: 0xb5d4ee, fogDensity: 0.0088,
    hemiSky: 0xe4f0fc, hemiGround: 0x8fa3b8,
    mountainTop: 0xffffff, mountainBase: 0x9fb2c8,
    accentLight: 0xb0d8ff,
    pathColor: 0x8a9db0,
    torchColor: 0x40c0ff,
    grass: { count: 0, color: 0x9fb3a6, scale: [0.30, 0.50] },
    trees: [],
    props: [],
    nature: [
      { key: 'pineSnow', count: 52, scale: [5.7, 8.8] },
      { key: 'birchSnow', count: 22, scale: [5.3, 7.4] },
      { key: 'deadSnow', count: 12, scale: [4.2, 5.9] },
      { key: 'bushSnow', count: 64, scale: [0.9, 1.5], kind: 'ground', shadow: false, clump: 3, spread: 1.3 },
      { key: 'rockSnow', count: 30, scale: [1.8, 4.2], kind: 'tree' },
      /* Toundra : la neige n'est jamais uniforme. Les touffes gelées et les
         cailloux qui percent la croûte donnent l'échelle et la texture. */
      { key: 'grassWispy', count: 600, scale: [0.5, 0.9], kind: 'grass', shadow: false, tint: 0xb8ccc0, clump: 4, spread: 1.6 },
      { key: 'grassTuft', count: 875, scale: [0.45, 0.8], kind: 'grass', shadow: false, tint: 0xa8bfb2, clump: 4, spread: 1.6 },
      { key: 'grassTuft', count: 748, scale: [0.35, 0.65], kind: 'grass', shadow: false, tint: 0x9db3a8 },
      { key: 'pebbleR', count: 160, scale: [0.35, 0.85], kind: 'ground', shadow: false, tint: 0xdde8f2, clump: 5, spread: 1.0 },
      { key: 'pebbleR', count: 264, scale: [0.22, 0.5], kind: 'ground', shadow: false, tint: 0xcbd8e5 },
      { key: 'pebbleS', count: 120, scale: [0.3, 0.7], kind: 'ground', shadow: false, tint: 0xc0cedb, clump: 4, spread: 0.9 },
      { key: 'pebbleS', count: 198, scale: [0.2, 0.45], kind: 'ground', shadow: false, tint: 0xaebccb },
      { key: 'slabRound', count: 85, scale: [0.62, 1.24], kind: 'ground', shadow: false, flat: true, clump: 2, spread: 1.8, tint: 0xcbdae7 },
      { key: 'slabRoundThin', count: 60, scale: [0.6, 1.25], kind: 'ground', shadow: false, flat: true, clump: 2, spread: 1.8, tint: 0xa9b8c7 },
    ],
  },
  tropical: {
    name: 'Jungle',
    ground: [0x48c86a, 0x36a852, 0x72e07e],
    /* Sous-bois humide : la terre marque plus que l'herbe sèche. */
    footprint: { kind: 'press', color: 0x24381c, opacity: 0.26, size: 0.62 },
    edge: 0x2c7a3e,
    sky: 0xa8ecd8, fogNear: 60, fogFar: 150,
    fogColor: 0x76d8ab, fogDensity: 0.0084,
    hemiSky: 0xd8ffe9, hemiGround: 0x2f6b3a,
    mountainTop: 0x5fae6f, mountainBase: 0x3d7a4a,
    accentLight: 0xc8ffb0,
    pathColor: 0x6a4a2a,
    torchColor: 0x50ff30,
    grass: { count: 0, color: 0x3faa4e, scale: [0.55, 0.95] },
    trees: [],
    props: [],
    nature: [
      { key: 'palms', count: 16, scale: [4.6, 6.2], doubleSide: true },
      { key: 'tree', count: 26, scale: [5.9, 8.8] },
      { key: 'fern', count: 120, scale: [0.9, 1.6], kind: 'ground', shadow: false, clump: 5, spread: 1.2 },
      { key: 'plantBig', count: 54, scale: [1.0, 1.8], kind: 'ground', shadow: false, clump: 3, spread: 1.1 },
      { key: 'plant', count: 80, scale: [0.8, 1.4], kind: 'ground', shadow: false, clump: 4, spread: 1.1 },
      { key: 'flowerPetal', count: 60, scale: [0.6, 1.0], kind: 'ground', shadow: false, clump: 5, spread: 0.9 },
      { key: 'clover', count: 130, scale: [0.6, 1.0], kind: 'ground', shadow: false, clump: 4, spread: 1.6, tint: 0x86dd8a },
      /* Sous-bois de jungle : deux hauteurs d'herbe, sinon le sol reste une
         nappe verte plate sous la canopée. */
      { key: 'grassTall', count: 1400, scale: [0.9, 1.5], kind: 'grass', shadow: false, tint: 0x59c46a, clump: 4, spread: 1.6 },
      { key: 'grassTuft', count: 1438, scale: [0.7, 1.2], kind: 'grass', shadow: false, tint: 0x47b25c, clump: 4, spread: 1.6 },
      { key: 'grassTuft', count: 1232, scale: [0.55, 0.95], kind: 'grass', shadow: false, tint: 0x3fa353 },
      { key: 'mushroomRed', count: 26, scale: [0.5, 1.0], kind: 'ground', shadow: false, clump: 3, spread: 0.7 },
      { key: 'rock', count: 12, scale: [2.2, 3.9], tint: 0x9fbf8a },
      { key: 'pebbleR', count: 110, scale: [0.35, 0.8], kind: 'ground', shadow: false, tint: 0x9cb98c, clump: 5, spread: 0.9 },
      { key: 'pebbleS', count: 198, scale: [0.22, 0.55], kind: 'ground', shadow: false, tint: 0x8aa87c },
      { key: 'slabRound', count: 75, scale: [0.56, 1.12], kind: 'ground', shadow: false, flat: true, clump: 2, spread: 1.8, tint: 0x8ba07a },
      { key: 'slabRoundThin', count: 50, scale: [0.6, 1.2], kind: 'ground', shadow: false, flat: true, clump: 2, spread: 1.8, tint: 0x7a6a4a },
    ],
  },
  savanna: {
    name: 'Savane',
    ground: [0xecd06e, 0xd9bc52, 0xf4e28a],
    /* Herbe sèche sur terre battue : entre la prairie et le sable. */
    footprint: { kind: 'press', color: 0x6a5426, opacity: 0.28, size: 0.62 },
    edge: 0xb59a4d,
    /* Pas de groundMatter, comme le désert (voir plus haut). La savane s'en
       distingue par sa palette de sol, plus verte et plus sourde, et par son
       décor — pas par une matière peinte sur les tuiles. */
    sky: 0xffe8c9, fogNear: 70, fogFar: 165,
    fogColor: 0xebd9a4, fogDensity: 0.0076,
    hemiSky: 0xfff0d4, hemiGround: 0x8a7a42,
    mountainTop: 0xd9b072, mountainBase: 0xa67c48,
    accentLight: 0xff9f40,
    pathColor: 0x9a6a30,
    torchColor: 0xff5500,
    grass: { count: 0, color: 0xd8bd63, scale: [0.55, 0.95] },
    trees: [],
    props: [],
    nature: [
      { key: 'twisted', count: 28, scale: [5.3, 8.1] },
      { key: 'dead', count: 12, scale: [4.6, 6.3] },
      /* Savane : hautes herbes en bouquets serrés, terre nue entre les touffes.
         C'est ce contraste qui donne l'impression de vent et de sécheresse. */
      { key: 'grassWispy', count: 1400, scale: [0.8, 1.4], kind: 'grass', shadow: false, clump: 4, spread: 1.6 },
      { key: 'grassTall', count: 700, scale: [0.7, 1.2], kind: 'grass', shadow: false, tint: 0xd6c070, clump: 4, spread: 1.6 },
      { key: 'grassTuft', count: 1125, scale: [0.5, 0.9], kind: 'grass', shadow: false, tint: 0xc2a64b, clump: 4, spread: 1.6 },
      { key: 'grassTuft', count: 1056, scale: [0.4, 0.75], kind: 'grass', shadow: false, tint: 0xb59642 },
      { key: 'bush', count: 32, scale: [0.9, 1.4], kind: 'ground', shadow: false, tint: 0xc9b45a, clump: 3, spread: 1.2 },
      { key: 'rock', count: 14, scale: [2.2, 4.2], tint: 0xc9a86a },
      { key: 'pebbleS', count: 160, scale: [0.35, 0.8], kind: 'ground', shadow: false, tint: 0xd8bd80, clump: 5, spread: 1.0 },
      { key: 'pebbleS', count: 264, scale: [0.2, 0.5], kind: 'ground', shadow: false, tint: 0xc9ab6c },
      { key: 'pebbleR', count: 120, scale: [0.3, 0.7], kind: 'ground', shadow: false, tint: 0xc4a465, clump: 5, spread: 0.9 },
      { key: 'slabRound', count: 80, scale: [0.6, 1.25], kind: 'ground', shadow: false, flat: true, clump: 2, spread: 1.8, tint: 0xc0954e },
      { key: 'slabRoundThin', count: 60, scale: [0.62, 1.3], kind: 'ground', shadow: false, flat: true, clump: 2, spread: 1.8, tint: 0xa8834a },
    ],
  },
  volcanic: {
    name: 'Terres de Cendre',
    ground: [0x5a4a44, 0x4a3c38, 0x6b5850],
    /* Cendre sur roche nue : une poussière soulevée, presque rien. Un sol qui
       ne garde pas la trace dit quelque chose de lui-même. */
    footprint: { kind: 'press', color: 0x1c1512, opacity: 0.22, size: 0.58 },
    edge: 0x3a2f2c,
    sky: 0xffb08a, fogNear: 55, fogFar: 140,
    fogColor: 0x5a3e36, fogDensity: 0.0098,
    hemiSky: 0xffc9a3, hemiGround: 0x54423c,
    mountainTop: 0xff7043, mountainBase: 0x4a3a38,
    accentLight: 0xff4422,
    pathColor: 0x3a2a28,
    torchColor: 0xff2200,
    grass: { count: 0, color: 0x6d6058, scale: [0.30, 0.52] },
    trees: [],
    props: [],
    nature: [
      { key: 'deadGrove', count: 14, scale: [5.3, 7.7], tint: 0x6a5148 },
      { key: 'dead', count: 20, scale: [4.2, 6.3], tint: 0x5a423a },
      { key: 'twisted', count: 14, scale: [4.9, 7.0], tint: 0x6a4a3a },
      { key: 'rocks', count: 22, scale: [2.8, 5.3], tint: 0x7a5f52 },
      { key: 'rock', count: 22, scale: [2.2, 4.2], tint: 0x64504a },
      /* Terres de cendre : sol de scories. Beaucoup de caillasse, très peu de
         végétation — mais assez de pierres plates pour que la cendre ne soit
         jamais lisse. */
      { key: 'grassWispy', count: 620, scale: [0.6, 1.1], kind: 'grass', shadow: false, tint: 0x7a6a5c, clump: 4, spread: 1.6 },
      { key: 'grassTuft', count: 525, scale: [0.45, 0.85], kind: 'grass', shadow: false, tint: 0x6d6058, clump: 4, spread: 1.6 },
      { key: 'grassTuft', count: 572, scale: [0.35, 0.7], kind: 'grass', shadow: false, tint: 0x5f544d },
      { key: 'pebbleS', count: 220, scale: [0.35, 0.9], kind: 'ground', shadow: false, tint: 0x6a5850, clump: 4, spread: 1.6 },
      { key: 'pebbleS', count: 396, scale: [0.2, 0.5], kind: 'ground', shadow: false, tint: 0x7d6a60 },
      { key: 'pebbleR', count: 170, scale: [0.3, 0.8], kind: 'ground', shadow: false, tint: 0x5a4a44, clump: 5, spread: 1.0 },
      { key: 'pebbleR', count: 286, scale: [0.2, 0.5], kind: 'ground', shadow: false, tint: 0x4e423c },
      { key: 'mushroomRed', count: 24, scale: [0.6, 1.1], kind: 'ground', shadow: false, clump: 3, spread: 0.7 },
      { key: 'slabRoundThin', count: 65, scale: [0.62, 1.30], kind: 'ground', shadow: false, flat: true, clump: 2, spread: 1.8, tint: 0x7a5f52 },
    ],
  },
};

/* ---------------------------------------------------------------------------
   Mapping pays -> biome
--------------------------------------------------------------------------- */
const DESERT_ISO = ['EGY', 'DZA', 'SAU', 'IRQ', 'IRN', 'LBY', 'SDN', 'TCD', 'NER', 'MLI', 'MRT', 'MAR', 'ESH', 'TUN', 'JOR', 'SYR', 'KWT', 'QAT', 'ARE', 'OMN', 'YEM', 'BHR', 'TKM', 'UZB', 'AFG', 'PAK', 'MEX', 'AUS', 'MNG'];
const NORDIC_ISO = ['CAN', 'RUS', 'GRL', 'NOR', 'SWE', 'FIN', 'ISL', 'EST', 'LVA', 'LTU', 'ATA', 'KAZ', 'KGZ', 'TJK', 'NPL', 'BTN', 'CHL', 'ARG'];
const TROPIC_ISO = ['BRA', 'COL', 'IDN', 'THA', 'VNM', 'PHL', 'MYS', 'COD', 'COG', 'GAB', 'CMR', 'GNQ', 'VEN', 'GUY', 'SUR', 'GUF', 'ECU', 'PER', 'BOL', 'LKA', 'BGD', 'MMR', 'LAO', 'KHM', 'PNG', 'SLB', 'VUT', 'FJI', 'CRI', 'PAN', 'NIC', 'HND', 'GTM', 'BLZ', 'CUB', 'HTI', 'DOM', 'JAM', 'SGP', 'BRN', 'TLS', 'MDG'];
const SAVANNA_ISO = ['KEN', 'TZA', 'UGA', 'ETH', 'SOM', 'SSD', 'CAF', 'NGA', 'BEN', 'TGO', 'GHA', 'CIV', 'BFA', 'SEN', 'GMB', 'GNB', 'GIN', 'SLE', 'LBR', 'ZMB', 'ZWE', 'MOZ', 'MWI', 'BWA', 'NAM', 'ZAF', 'AGO', 'SWZ', 'LSO', 'ERI', 'DJI', 'RWA', 'BDI', 'IND'];
const VOLCANIC_ISO = ['ISL', 'JPN', 'NZL', 'PHL', 'IDN', 'ITA'];

export function getBiomeForIso(iso) {
  if (!iso) return 'temperate';
  const c = iso.toUpperCase();
  // Quelques pays volcaniques emblématiques passent en priorité
  if (['JPN', 'NZL', 'ISL'].includes(c)) return 'volcanic';
  if (DESERT_ISO.includes(c)) return 'desert';
  if (NORDIC_ISO.includes(c)) return 'nordic';
  if (TROPIC_ISO.includes(c)) return 'tropical';
  if (SAVANNA_ISO.includes(c)) return 'savanna';
  if (VOLCANIC_ISO.includes(c)) return 'volcanic';
  return 'temperate';
}

export function randomBiomeKey() {
  const keys = Object.keys(BIOMES);
  return keys[Math.floor(Math.random() * keys.length)];
}

/* ---------------------------------------------------------------------------
   Herbes stylisées (modèle externe)

   Le .glb contient trois touffes distinctes (Clump01/02/03) : on les extrait en
   géométries normalisées pour varier les massifs. La texture d'origine est verte ;
   on la désature une fois pour n'en garder que le modelé, et la couleur du biome
   la reteinte ensuite — sinon multiplier du vert par du paille donnerait un olive
   boueux au lieu d'une herbe sèche.
--------------------------------------------------------------------------- */
let grassAsset = null;          // { geos: [BufferGeometry], map: Texture }
const grassWaiting = [];

function desaturate(tex) {
  const img = tex.image;
  const cv = document.createElement('canvas');
  cv.width = img.width; cv.height = img.height;
  const ctx = cv.getContext('2d');
  ctx.drawImage(img, 0, 0);
  const d = ctx.getImageData(0, 0, cv.width, cv.height);
  // luminance perçue, l'alpha (découpe des brins) reste intact
  let sum = 0, n = 0;
  for (let i = 0; i < d.data.length; i += 4) {
    const l = 0.299 * d.data[i] + 0.587 * d.data[i + 1] + 0.114 * d.data[i + 2];
    d.data[i] = d.data[i + 1] = d.data[i + 2] = l;
    if (d.data[i + 3] > 89) { sum += l; n++; }   // seuil de l'alphaTest
  }
  /* La texture d'origine est sombre (moyenne ~0.32) : telle quelle elle écraserait
     la couleur du biome aux deux tiers. On recale la moyenne des brins visibles
     pour que la teinte demandée ressorte, en gardant le modelé. */
  const gain = n ? (0.85 * 255) / (sum / n) : 1;
  for (let i = 0; i < d.data.length; i += 4) {
    const v = Math.min(255, d.data[i] * gain);
    d.data[i] = d.data[i + 1] = d.data[i + 2] = v;
  }
  ctx.putImageData(d, 0, 0);
  const out = new THREE.CanvasTexture(cv);
  out.flipY = tex.flipY;
  out.wrapS = tex.wrapS; out.wrapT = tex.wrapT;
  out.colorSpace = THREE.SRGBColorSpace;
  return out;
}

export function loadGrass(url) {
  makeGLTFLoader().load(url, (gltf) => {
    gltf.scene.updateWorldMatrix(true, true);
    let map = null;
    const geos = [];
    /* Les trois massifs du modèle (l'auteur a orthographié deux d'entre eux
       « Ckump »). On cherche par suffixe : le GLTFLoader assainit les noms de
       nœuds et retire les deux-points, donc « Grass:Clump01GRP » arrive ici
       sous la forme « GrassClump01GRP ». */
    for (const name of ['Clump01GRP', 'Ckump02GRP', 'Ckump03GRP']) {
      let grp = null;
      gltf.scene.traverse((o) => { if (!grp && o.name.endsWith(name)) grp = o; });
      if (!grp) continue;
      const parts = [];
      grp.updateWorldMatrix(true, true);
      grp.traverse((child) => {
        if (!child.isMesh) return;
        const g = child.geometry.clone();
        for (const k of Object.keys(g.attributes)) {
          if (k !== 'position' && k !== 'normal' && k !== 'uv') g.deleteAttribute(k);
        }
        g.applyMatrix4(child.matrixWorld);
        parts.push(g);
        if (!map && child.material && child.material.map) map = child.material.map;
      });
      if (!parts.length) continue;
      const geo = parts.length > 1 ? mergeGeometries(parts) : parts[0];
      // normalise : centré en X/Z, pied à y = 0, hauteur 1 (la mise à l'échelle
      // se fait ensuite par biome)
      geo.computeBoundingBox();
      const sc = 1 / Math.max(0.001, geo.boundingBox.max.y - geo.boundingBox.min.y);
      geo.scale(sc, sc, sc);
      /* scale() recalcule la bounding box en place : la relire donne déjà les
         valeurs mises à l'échelle, il ne faut pas les remultiplier par sc. */
      geo.computeBoundingBox();
      const bb = geo.boundingBox;
      geo.translate(-(bb.min.x + bb.max.x) * 0.5, -bb.min.y, -(bb.min.z + bb.max.z) * 0.5);
      geo.computeBoundingBox();
      geo.computeBoundingSphere();
      geos.push(geo);
    }
    if (!geos.length || !map) return;
    grassAsset = { geos, map: desaturate(map) };
    while (grassWaiting.length) grassWaiting.pop()();
  });
}

export function onGrassReady(cb) {
  if (grassAsset) cb(); else grassWaiting.push(cb);
}

/* ---------------------------------------------------------------------------
   Arbres modélisés (modèle externe)

   Le .glb regroupe 12 arbres + 1 rocher, chacun avec sa propre texture : on ne
   peut donc pas les fondre dans un seul InstancedMesh, il en faut un par essence.
   Les indices utilisés par les biomes sont ceux de l'inventaire :
     0,1 sapins   2,3,5,6 feuillus   4,7 bouleaux   8 arbre mort
     9 souche     10,11 petits pins  12 rocher
--------------------------------------------------------------------------- */
let treeAssets = null;          // [{ geo, map }] indexé comme ci-dessus
const treesWaiting = [];

export function loadTrees(url) {
  makeGLTFLoader().load(url, (gltf) => {
    gltf.scene.updateWorldMatrix(true, true);
    const out = [];
    gltf.scene.traverse((child) => {
      if (!child.isMesh) return;
      const geo = child.geometry.clone();
      for (const k of Object.keys(geo.attributes)) {
        if (k !== 'position' && k !== 'normal' && k !== 'uv') geo.deleteAttribute(k);
      }
      geo.applyMatrix4(child.matrixWorld);
      // normalise : centré en X/Z, pied à y = 0, hauteur 1 (échelle par biome ensuite)
      geo.computeBoundingBox();
      const sc = 1 / Math.max(0.001, geo.boundingBox.max.y - geo.boundingBox.min.y);
      geo.scale(sc, sc, sc);
      geo.computeBoundingBox();
      const bb = geo.boundingBox;
      geo.translate(-(bb.min.x + bb.max.x) * 0.5, -bb.min.y, -(bb.min.z + bb.max.z) * 0.5);
      geo.computeBoundingBox();
      geo.computeBoundingSphere();
      out.push({ geo, map: child.material ? child.material.map : null });
    });
    if (!out.length) return;
    treeAssets = out;
    while (treesWaiting.length) treesWaiting.pop()();
  });
}

export function onTreesReady(cb) {
  if (treeAssets) cb(); else treesWaiting.push(cb);
}

/* ---------------------------------------------------------------------------
   Décor nature (packs Quaternius, CC0) — un GLB par essence.

   Contrairement à trees.glb (un fichier, 13 meshes), chaque essence vit dans
   son propre fichier. Un modèle peut être fait de plusieurs primitives (tronc
   + feuillage avec des textures différentes) : on garde chaque partie séparée,
   et buildBiomeNature crée un InstancedMesh par partie en leur donnant les
   MÊMES matrices d'instance — l'arbre reste entier.
--------------------------------------------------------------------------- */
const NATURE_DIR = 'assets/models/nature/';
const NATURE_FILES = {
  tree: 'Tree', pine: 'Pine', twisted: 'Twisted_Tree',
  dead: 'Dead_Tree', deadGrove: 'Dead_Trees', palms: 'Palm_Trees',
  bush: 'Bush', bushFlowers: 'Bush_with_Flowers',
  fern: 'Fern', plant: 'Plant', plantBig: 'Plant_Big',
  flowerGroup: 'Flower_Group', flowerSingle: 'Flower_Single', flowerPetal: 'Flower_Petal',
  clover: 'Clover', grassTuft: 'Grass', grassTall: 'Tall_Grass', grassWispy: 'Grass_Wispy',
  mushroom: 'Mushroom', mushroomRed: 'Mushroom_Laetiporus',
  rock: 'Rock_Medium', rocks: 'Rocks', pebbleR: 'Pebble_Round', pebbleS: 'Pebble_Square',
  cactus: 'Cactus_Flowers',
  pineSnow: 'Pine_Tree_with_Snow', birchSnow: 'Birch_Tree_with_Snow',
  deadSnow: 'Dead_Tree_with_Snow', bushSnow: 'Bush_Snow', rockSnow: 'Rock_Snow',
  /* Liaisons du terrain (Kenney Nature Kit, CC0). Ces pièces ne sont PAS posées
     par buildBiomeNature : elles doivent s'aligner sur une arête de tuile
     précise, pas atterrir au hasard avec un lacet aléatoire. Elles sont posées
     par buildRampStairs dans hexmap.js, qui lit l'asset via
     getNatureAsset(). Elles sont enregistrées ici uniquement pour bénéficier du
     chargement, du nettoyage d'attributs et de la normalisation existants.

     Les volées font 1×1×1,05 dans le fichier : une marche qui monte exactement
     une unité sur une unité d'avancée. C'est ce qui permet de les caler sur
     STEP_H par une simple mise à l'échelle. */
  stairsStone: 'cliff_steps_stone', stairsRock: 'cliff_steps_rock',
  /* Galets plats : la litière du sol, ce qui affleure entre les touffes.
     Le pack fournit aussi des variantes carrées (Rock_Path_Square_*) : ce sont
     des pavés en grille régulière, essayées puis écartées — au milieu d'une
     prairie elles se lisaient comme un dallage de place de village. */
  slabRound: 'Rock_Path_Round_Small', slabRoundThin: 'Rock_Path_Round_Thin',
};
/* Fichiers « collection » : chaque mesh du .glb est un modèle indépendant
   (5 palmiers, 5 rochers…) à instancier séparément — PAS les parties d'un même
   objet. Les instancier en bloc posait des troncs hors tuile, flottant sur le
   vide. */
const NATURE_SPLIT = new Set(['palms', 'deadGrove', 'rocks']);
/** Volumes solides (pas de cartes alpha) — outlines cartoon + FrontSide. */
const NATURE_SOLID = new Set([
  'rock', 'rocks', 'rockSnow', 'pebbleR', 'pebbleS', 'cactus',
  'mushroom', 'mushroomRed',
  'slabRound', 'slabRoundThin',
  'stairsStone', 'stairsRock',
]);
/** Modèles plus larges que hauts : à normaliser sur l'empreinte, pas la hauteur.
 *  Une dalle de 1 × 0,08 ramenée à une hauteur de 1 deviendrait un plateau de
 *  12 unités de large — l'échelle demandée par le biome ne veut plus rien dire. */
const NATURE_FLAT = new Set([
  'slabRound', 'slabRoundThin',
  'pebbleR', 'pebbleS',
]);
/** Épaisseur d'outline souhaitée en unités monde (compensée par le scale d'instance). */
const OUTLINE_WORLD = 0.042;
const OUTLINE_WORLD_FOLIAGE = 0.032; // un peu plus fin sur herbe / fleurs
function localOutlineThickness(scaleRange, world = OUTLINE_WORLD) {
  const avg = (scaleRange[0] + scaleRange[1]) * 0.5;
  return world / Math.max(0.4, avg);
}
let natureAssets = null;      // { key: [variante][partie] → { geo, map, color, vc } }
const natureWaiting = [];

/* Ramène une liste de parties à : pieds au sol, centré en X/Z, hauteur 1
   (ou emprise au sol 1 pour les modèles plats — voir NATURE_FLAT). */
function normalizeParts(parts, flat = false) {
  const box = new THREE.Box3();
  for (const p of parts) { p.geo.computeBoundingBox(); box.union(p.geo.boundingBox); }
  const ref = flat
    ? Math.max(box.max.x - box.min.x, box.max.z - box.min.z)
    : box.max.y - box.min.y;
  const sc = 1 / Math.max(0.001, ref);
  const cx = (box.min.x + box.max.x) * 0.5, cz = (box.min.z + box.max.z) * 0.5;
  for (const p of parts) {
    p.geo.translate(-cx, -box.min.y, -cz);
    p.geo.scale(sc, sc, sc);
    p.geo.computeBoundingBox();
    p.geo.computeBoundingSphere();
  }
  return parts;
}

export function loadNature() {
  const loader = makeGLTFLoader();
  const acc = {};
  let pending = Object.keys(NATURE_FILES).length;
  const done = () => {
    if (--pending > 0) return;
    natureAssets = acc;
    while (natureWaiting.length) natureWaiting.pop()();
  };
  for (const [key, file] of Object.entries(NATURE_FILES)) {
    loader.load(NATURE_DIR + file + '.glb', (gltf) => {
      gltf.scene.updateWorldMatrix(true, true);
      const parts = [];
      gltf.scene.traverse((child) => {
        if (!child.isMesh) return;
        const geo = child.geometry.clone();
        /* Certains modèles (cactus, fleurs) n'ont pas de texture : leur teinte
           vient des couleurs par vertex et/ou de la couleur du matériau — il
           faut les préserver, sinon le modèle sort blanc. */
        for (const k of Object.keys(geo.attributes)) {
          if (k !== 'position' && k !== 'normal' && k !== 'uv' && k !== 'color') geo.deleteAttribute(k);
        }
        geo.applyMatrix4(child.matrixWorld);
        const mat = child.material || {};
        parts.push({
          geo,
          map: mat.map || null,
          color: mat.color ? mat.color.clone() : null,
          vc: !!geo.attributes.color,
          /* Nom du matériau source. Les pièces Kenney découpent un même modèle en
             primitives nommées (« stone », « grass » pour une volée de marches) :
             c'est le seul moyen de les reteinter séparément, leur palette d'origine
             — un vert turquoise — ne collant à aucun biome du jeu. */
          matName: mat.name || '',
          /* Un mesh glTF multi-primitives (tronc + palmes) arrive en Group de
             plusieurs Mesh : le parent identifie le modèle d'origine. */
          node: child.parent && child.parent !== gltf.scene ? child.parent.uuid : child.uuid,
        });
      });
      if (!parts.length) return done();
      if (NATURE_SPLIT.has(key)) {
        /* Fichier collection : une variante par nœud source — les primitives
           d'un même palmier restent soudées, les palmiers se séparent. */
        const groups = new Map();
        for (const p of parts) {
          if (!groups.has(p.node)) groups.set(p.node, []);
          groups.get(p.node).push(p);
        }
        acc[key] = [...groups.values()].map((g) => normalizeParts(g, NATURE_FLAT.has(key)));
      } else {
        /* Modèle simple : une seule variante, toutes parties normalisées
           ensemble pour que rien ne glisse. */
        acc[key] = [normalizeParts(parts, NATURE_FLAT.has(key))];
      }
      done();
    }, undefined, () => done());   // un fichier manquant ne bloque pas les autres
  }
}

/**
 * Asset nature brut, pour les poseurs qui ont besoin d'un placement EXACT.
 * buildBiomeNature convient au semis aléatoire ; une volée de marches ou un pavé
 * de chemin doivent au contraire s'aligner sur une arête ou sur un tracé, avec
 * leur propre matrice. Ces poseurs vivent dans hexmap.js (topologie des tuiles)
 * et lisent l'asset par ici.
 * @returns {Array<Array<{geo, map, color, vc, matName}>>|null} variantes → parties
 */
export function getNatureAsset(key) {
  return natureAssets ? (natureAssets[key] || null) : null;
}

export function onNatureReady(cb) {
  if (natureAssets) cb(); else natureWaiting.push(cb);
}

/* Peuple la carte avec le décor nature du biome.
   Spec : { key, count, scale:[min,max], kind:'tree'|'grass'|'ground',
            shadow:bool, tint:0xRRGGBB (multiplie la texture),
            clump:n, spread:r (semis en amas — voir makeTilePlacer),
            flat:true (dalle posée à plat : pas de contour, léger décalage en Y
            pour ne pas z-fighter avec la tuile) } */
export function buildBiomeNature(scene, biomeKey, mapR, placer = null) {
  const biome = BIOMES[biomeKey] || BIOMES.temperate;
  if (!natureAssets || !biome.nature) return [];
  const created = [];
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3();
  const UP = new THREE.Vector3(0, 1, 0);

  for (const spec of biome.nature) {
    const variants = natureAssets[spec.key];
    if (!variants || !variants.length) continue;
    /* Le double-face n'est utile que pour les plans alpha (herbe, palmes
       découpées) : les volumes fermés en front-face coûtent moitié moins.
       Les rochers / cailloux restent solides même si kind === 'ground'. */
    const solid = NATURE_SOLID.has(spec.key);
    /* Palmiers (doubleSide) = cartes alpha comme l'herbe : alphaTest + outline
       feuillage, sinon le fond noir de la texture reste visible. */
    const foliage = !solid && (
      spec.kind === 'grass'
      || spec.kind === 'ground'
      || !!spec.doubleSide
    );
    const kind = spec.kind || 'tree';
    const outlineThick = localOutlineThickness(
      spec.scale || [1, 1],
      foliage ? OUTLINE_WORLD_FOLIAGE : OUTLINE_WORLD,
    );
    /* Mobile : moitié d'herbe + sol fleuri allégé pour limiter draw calls. */
    let specCount = spec.count;
    if (_isCoarse && (kind === 'grass' || kind === 'ground')) {
      const dens = kind === 'grass' ? GRASS_DENSITY_MOBILE : 0.45;
      specCount = Math.max(8, Math.round(spec.count * dens));
    }
    const base = Math.floor(specCount / variants.length);
    let extra = specCount % variants.length;

    for (const parts of variants) {
      const count = base + (extra-- > 0 ? 1 : 0);
      if (count <= 0) continue;
      const insts = parts.map((part) => {
        /* Teinte finale : tint du biome × couleur du matériau source. Les
           modèles sans texture comptent sur cette couleur (sinon : blanc). */
        const color = new THREE.Color(spec.tint !== undefined ? spec.tint : 0xffffff);
        if (spec.tint !== undefined) conditionAlbedo(color);
        if (part.color) color.multiply(part.color);
        /* Le prop suit le relief du sol. Il est placé sur le plan LOGIQUE de la
           tuile, qui reste plat : sans ce décalage un caillou posé sur une bosse
           est à moitié enterré, et le même caillou dans un creux flotte. C'est
           exactement ce qui interdisait de donner au sol une amplitude visible. */
        const mat = applyGroundFollow(toonMaterial({
          map: part.map,
          color,
          // couleurs par vertex si le modèle en porte (cactus, fleurs…)
          ...(part.vc ? { vertexColors: true } : {}),
          /* alphaTest seulement sur les cartes de feuillage, pas sur les
             volumes texturés (rochers, troncs) — sinon pas d'outline cartoon */
          ...(part.map && foliage ? { alphaTest: 0.35 } : {}),
          side: foliage || spec.doubleSide ? THREE.DoubleSide : THREE.FrontSide,
        }), spec.key);
        /* S'efface quand il passe devant le joueur. */
        applyHeroCutout(mat, 'nat-' + spec.key);
        const inst = new THREE.InstancedMesh(
          part.geo,
          mat,
          count,
        );
        /* Ombres : gros volumes seulement. Herbe/fleurs = trop cher pour rien. */
        inst.castShadow = !foliage && spec.shadow !== false;
        inst.receiveShadow = !foliage;
        inst.userData.sharedGeo = true;
        // décor immobile : pas de recalcul de matrice monde à chaque frame
        inst.matrixAutoUpdate = false;
        return inst;
      });
      /* Amas : on répartit le compte du spec sur des paquets, et chaque paquet
         se pose au même endroit à un rayon près. Sans ça, l'herbe couvre le sol
         de façon parfaitement homogène — d'où l'aspect moquette. */
      const clumpOpts = spec.clump > 1
        ? { clump: Math.max(2, Math.round(spec.clump)), spread: spec.spread || 1.1 }
        : null;
      /* Une dalle posée à plat partage exactement le plan de la tuile : sans
         ce décalage, le z-buffer tranche au hasard et la plaque clignote. */
      const yLift = spec.flat ? 0.02 : 0;
      for (let i = 0; i < count; i++) {
        const sc = spec.scale[0] + Math.random() * (spec.scale[1] - spec.scale[0]);
        if (placer) {
          const pt = placer(kind, clumpOpts);
          p.set(pt.x, (pt.y || 0) + yLift, pt.z);
        } else {
          const a = Math.random() * Math.PI * 2;
          const r = Math.sqrt(Math.random()) * (mapR - 2);
          p.set(Math.cos(a) * r, yLift, Math.sin(a) * r);
        }
        q.setFromAxisAngle(UP, Math.random() * Math.PI * 2);
        /* Les dalles gardent leur épaisseur : les étirer en Y ferait des
           marches là où on veut une plaque affleurante. */
        s.set(sc, spec.flat ? sc : sc * (0.9 + Math.random() * 0.25), sc);
        m.compose(p, q, s);
        for (const inst of insts) inst.setMatrixAt(i, m);
      }
      for (const inst of insts) {
        scene.add(inst);
        // Contours feuillage : désactivés sur tactile (×2 draw calls alpha).
        // Les dalles plates n'en prennent jamais : le hull BackSide d'un volume
        // aplati sort du sol et se lit comme une flaque noire.
        if (!spec.flat && !(foliage && _isCoarse)) {
          const ol = attachCartoonOutline(inst, outlineThick, 0x080a12, { foliage });
          /* Le contour est un mesh FRÈRE partageant les matrices d'instance, pas
             un enfant : il ne suit donc pas automatiquement le décalage appliqué
             au prop. Sans ça la silhouette noire reste à l'ancienne hauteur et
             se décolle de l'objet. */
          if (ol && ol.isInstancedMesh) {
            applyGroundFollow(ol.material, 'ol-' + spec.key);
            /* Le contour doit s'effacer AVEC son objet : sans ça un arbre
               transparent laisse sa silhouette noire pleine devant le joueur,
               ce qui le cache autant que l'arbre. */
            applyHeroCutout(ol.material, 'nat-ol-' + spec.key);
          }
        }
        created.push(inst);
      }
    }
  }
  return created;
}

/* Arbres modélisés d'un biome — même logique asynchrone que l'herbe.
   `placer` (optionnel) remplace le tirage radial : voir makeTilePlacer(). */
export function buildBiomeTrees(scene, biomeKey, mapR, placer = null) {
  const biome = BIOMES[biomeKey] || BIOMES.temperate;
  if (!treeAssets || !biome.trees) return [];
  const created = [];
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3();
  const UP = new THREE.Vector3(0, 1, 0);

  for (const spec of biome.trees) {
    const asset = treeAssets[spec.i];
    if (!asset) continue;
    const inst = new THREE.InstancedMesh(
      asset.geo,
      applyGroundFollow(toonMaterial({ map: asset.map }), 'tree' + spec.i),
      spec.count,
    );
    inst.castShadow = true;
    inst.receiveShadow = true;
    inst.userData.sharedGeo = true;
    for (let i = 0; i < spec.count; i++) {
      const sc = spec.scale[0] + Math.random() * (spec.scale[1] - spec.scale[0]);
      if (placer) {
        const pt = placer('tree');
        p.set(pt.x, pt.y || 0, pt.z);
      } else {
        const a = Math.random() * Math.PI * 2;
        const minR = spec.minR || 0;
        const r = minR + Math.sqrt(Math.random()) * (mapR - minR - 2);
        p.set(Math.cos(a) * r, 0, Math.sin(a) * r);
      }
      q.setFromAxisAngle(UP, Math.random() * Math.PI * 2);
      s.set(sc, sc * (0.9 + Math.random() * 0.25), sc);
      m.compose(p, q, s);
      inst.setMatrixAt(i, m);
    }
    scene.add(inst);
    applyHeroCutout(inst.material, 'tree' + spec.i);
    const olT = attachCartoonOutline(inst, localOutlineThickness(spec.scale || [1, 1]));
    if (olT && olT.isInstancedMesh) applyHeroCutout(olT.material, 'tree-ol' + spec.i);
    created.push(inst);
  }
  return created;
}

/* Massifs d'herbe d'un biome — séparé de buildBiomeScenery car le modèle arrive
   de façon asynchrone : la carte peut être bâtie avant que l'herbe soit prête. */
export function buildBiomeGrass(scene, biomeKey, mapR, placer = null) {
  const biome = BIOMES[biomeKey] || BIOMES.temperate;
  if (!grassAsset || !biome.grass || !biome.grass.count) return [];
  const { color, scale } = biome.grass;
  let count = biome.grass.count;
  if (_isCoarse) count = Math.max(8, Math.round(count * GRASS_DENSITY_MOBILE));
  const created = [];
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3();
  const UP = new THREE.Vector3(0, 1, 0);
  const per = Math.ceil(count / grassAsset.geos.length);

  for (const geo of grassAsset.geos) {
    const mat = toonMaterial({
      map: grassAsset.map,
      color,
      // alphaTest plutôt que transparence : pas de tri à faire sur des centaines
      // de massifs, et pas d'artefacts de recouvrement entre brins
      alphaTest: 0.35,
      side: THREE.DoubleSide,
    });
    applyGroundFollow(mat, 'grass');
    const inst = new THREE.InstancedMesh(geo, mat, per);
    inst.castShadow = false;      // découpe alpha : l'ombre coûterait cher pour rien
    inst.receiveShadow = false;   // receive sur herbe = fillrate inutile
    inst.userData.sharedGeo = true;   // géométrie réutilisée : à ne pas disposer
    for (let i = 0; i < per; i++) {
      const sc = scale[0] + Math.random() * (scale[1] - scale[0]);
      if (placer) {
        const pt = placer('grass');
        p.set(pt.x, pt.y || 0, pt.z);
      } else {
        const a = Math.random() * Math.PI * 2;
        const r = Math.sqrt(Math.random()) * (mapR - 2);
        p.set(Math.cos(a) * r, 0, Math.sin(a) * r);
      }
      q.setFromAxisAngle(UP, Math.random() * Math.PI * 2);
      s.set(sc, sc * (0.85 + Math.random() * 0.35), sc);
      m.compose(p, q, s);
      inst.setMatrixAt(i, m);
    }
    scene.add(inst);
    applyHeroCutout(mat, 'grass');
    if (!_isCoarse) {
      const olG = attachCartoonOutline(
        inst,
        localOutlineThickness(scale || [1, 1], OUTLINE_WORLD_FOLIAGE),
        0x080a12,
        { foliage: true },
      );
      if (olG && olG.isInstancedMesh) applyHeroCutout(olG.material, 'grass-ol');
    }
    created.push(inst);
  }
  return created;
}

/* ---------------------------------------------------------------------------
   Construction du décor d'un biome — retourne les objets ajoutés à la scène
   (à retirer + disposer entre deux parties).
--------------------------------------------------------------------------- */
/* Type de tuile qui doit accueillir un prop, déduit de sa description.
   Les habitations vont au hameau, les gros volumes au bosquet/caillasse, et
   tout ce qui ne porte pas d'ombre (fleurs, touffes) se pose n'importe où. */
function propKind(prop) {
  if (prop.kind) return prop.kind;
  if (prop.house) return 'house';
  return prop.shadow ? 'tree' : 'ground';
}

export function buildBiomeScenery(scene, biomeKey, mapR, placer = null) {
  const biome = BIOMES[biomeKey] || BIOMES.temperate;
  const meshes = [];
  const houses = [];
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3();
  const UP = new THREE.Vector3(0, 1, 0);

  for (const prop of biome.props) {
    if (!prop.make) continue;
    const geo = prop.make();
    const mat = toonMaterial({
      vertexColors: true,
      ...(prop.emissive ? { emissive: prop.emissive, emissiveIntensity: 0.55 } : {}),
    });
    const inst = new THREE.InstancedMesh(geo, mat, prop.count);
    inst.castShadow = !!prop.shadow;
    inst.receiveShadow = !!prop.shadow; // pas d'ombre reçue sur fleurs / touffes
    const kind = propKind(prop);
    for (let i = 0; i < prop.count; i++) {
      const sc = prop.scale[0] + Math.random() * (prop.scale[1] - prop.scale[0]);
      let x, z, y = 0;
      if (placer) {
        const pt = placer(kind);
        x = pt.x; z = pt.z; y = pt.y || 0;
      } else {
        const a = Math.random() * Math.PI * 2;
        const r = prop.minR + Math.sqrt(Math.random()) * (mapR - prop.minR - 2);
        x = Math.cos(a) * r; z = Math.sin(a) * r;
      }
      p.set(x, y, z);
      q.setFromAxisAngle(UP, Math.random() * Math.PI * 2);
      s.set(sc, sc, sc);
      m.compose(p, q, s);
      inst.setMatrixAt(i, m);
      if (prop.house) {
        const [lo, hi] = prop.house.capacity;
        houses.push({
          mesh: inst, slot: i, x, z,
          capacity: lo + ((Math.random() * (hi - lo + 1)) | 0),
        });
      }
    }
    scene.add(inst);
    applyHeroCutout(mat, 'prop');
    const olP = attachCartoonOutline(inst, localOutlineThickness(prop.scale || [1, 1], 0.038));
    if (olP && olP.isInstancedMesh) applyHeroCutout(olP.material, 'prop-ol');
    meshes.push(inst);
  }
  return { meshes, houses };
}
