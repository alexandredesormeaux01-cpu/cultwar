/* ============================================================================
   Cult.io — Traces de pas des Leaders
   ----------------------------------------------------------------------------
   Le sol est la surface la plus vaste de l'écran et la seule qui ne raconte
   rien : on le traverse sans y laisser de marque. Une trace de pas fait deux
   choses qu'aucun effet lumineux ne fait — elle dit où quelqu'un est passé, et
   elle donne au sol une MATIÈRE. Du sable qui garde l'empreinte n'est pas la
   même chose qu'une pierre qui n'en garde aucune, et c'est la trace qui le dit.

   POURQUOI UN VIVIER D'INSTANCES, ET PAS UNE PEINTURE SUR CANEVAS

   Le jeu possède déjà une surface peinte (paintMesh) où les cultes marquent
   leur territoire. Y ajouter les pas aurait semblé économique. Mais cette
   peinture est une texture de taille fixe étalée sur toute l'île : à cette
   échelle, une empreinte fait moins d'un texel. Elle serait illisible, et la
   monter en résolution coûterait de la mémoire sur toute la carte pour un
   détail qui n'existe qu'autour des personnages.

   Un vivier d'instances a la propriété inverse : le coût ne dépend PAS de la
   taille de la carte, seulement du nombre d'empreintes affichées. Il est
   constant et connu d'avance.

   L'EFFACEMENT SE FAIT HORS CHAMP

   Une trace qui s'efface sous les yeux du joueur se lit comme un défaut
   d'affichage — rien, dans la nature, ne disparaît en trois secondes. Le fondu
   est donc piloté par la DISTANCE À LA CAMÉRA et non par l'âge : tant qu'on
   voit une empreinte, elle reste ; elle ne s'efface qu'une fois qu'on s'en est
   éloigné. Le vivier étant circulaire, les plus anciennes finissent recyclées
   de toute façon — mais toujours loin derrière soi.
   ========================================================================== */
import * as THREE from 'three';
import { applyGroundFollow } from './groundNoise.js';

/* Taille du vivier. À 3,2 unités de foulée et 7 Leaders, 320 empreintes
   couvrent une bonne trentaine de pas chacun — bien au-delà de ce qu'un écran
   montre. Au-delà, on paierait de la mémoire pour des traces déjà effacées. */
const POOL = 320;

/* Distance à la caméra où l'effacement COMMENCE et où il est terminé. Le début
   est calé au-delà de ce qu'un écran de jeu montre : une empreinte n'entame
   jamais son fondu tant qu'elle est visible. */
const FADE_NEAR = 46;
const FADE_FAR = 62;

/* Réglages par défaut d'une matière de sol, quand un biome n'en déclare pas.
   Discret : mieux vaut une trace qu'on remarque à peine qu'une tache noire sur
   un sol où rien ne devrait s'imprimer. */
const DEFAULT_MARK = { color: 0x000000, opacity: 0.18, size: 0.62 };

let mesh = null;
let alphaAttr = null;
let cursor = 0;              // prochaine case du vivier (circulaire)
const alive = [];            // { x, z, alpha } par case, pour le fondu

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);

/**
 * Empreinte peinte sur un canevas.
 *
 * Deux formes selon la matière, et la différence n'est pas cosmétique :
 *
 *   `dimple` — sable, neige. Un creux, donc un fond sombre ET un BOURRELET
 *     clair autour : la matière chassée par le pied s'accumule sur le pourtour
 *     et capte la lumière. C'est ce liseré qui fait lire un creux plutôt qu'une
 *     tache ; sans lui, une empreinte dans la neige ressemble à de la saleté.
 *
 *   `press` — herbe, cendre. Rien n'est chassé, la matière est seulement
 *     couchée : un assombrissement diffus, sans bord ni bourrelet.
 */
function makeMarkTexture(kind) {
  const S = 64;
  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const g = cv.getContext('2d');
  g.clearRect(0, 0, S, S);

  /* Ovale allongé dans l'axe de la marche, pas un rond : un pied est deux fois
     plus long que large, et c'est cette proportion qui donne la direction. */
  const cx = S / 2, cy = S / 2, rx = S * 0.22, ry = S * 0.40;

  if (kind === 'dimple') {
    /* Bourrelet d'abord, creux par-dessus : peint dans l'autre ordre, le creux
       serait mangé par le halo clair au lieu de s'y détacher. */
    g.save();
    g.translate(cx, cy);
    g.scale(rx / ry, 1);
    const rim = g.createRadialGradient(0, 0, ry * 0.55, 0, 0, ry * 1.5);
    rim.addColorStop(0, 'rgba(255,255,255,0)');
    rim.addColorStop(0.45, 'rgba(255,255,255,0.55)');
    rim.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = rim;
    g.beginPath(); g.arc(0, 0, ry * 1.5, 0, Math.PI * 2); g.fill();
    g.restore();
  }

  g.save();
  g.translate(cx, cy);
  g.scale(rx / ry, 1);
  const hole = g.createRadialGradient(0, 0, 0, 0, 0, ry);
  const core = kind === 'dimple' ? 0.95 : 0.7;
  hole.addColorStop(0, `rgba(0,0,0,${core})`);
  hole.addColorStop(kind === 'dimple' ? 0.65 : 0.35, `rgba(0,0,0,${core * 0.6})`);
  hole.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = hole;
  g.beginPath(); g.arc(0, 0, ry, 0, Math.PI * 2); g.fill();
  g.restore();

  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

let _tex = { dimple: null, press: null };
function markTexture(kind) {
  if (!_tex[kind]) _tex[kind] = makeMarkTexture(kind);
  return _tex[kind];
}

/**
 * Construit le vivier. Une seule fois par session : le maillage est réutilisé
 * d'une carte à l'autre, seuls la texture et la teinte changent de biome.
 */
export function initFootprints(scene) {
  if (mesh) return mesh;

  const geo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
  const mat = new THREE.MeshBasicMaterial({
    transparent: true,
    depthWrite: false,
    /* Le sol est opaque et à la même hauteur : sans décalage de polygone, les
       deux se disputent le tampon de profondeur et l'empreinte clignote quand
       la caméra bouge. Un simple décalage en Y ne suffirait pas — le sol est
       déplacé en shader, sa hauteur réelle n'est pas celle de sa géométrie. */
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });

  /* Opacité PAR INSTANCE : sans elle, toutes les empreintes partageraient
     l'opacité du matériau et s'effaceraient toutes ensemble. Three.js n'expose
     pas d'alpha d'instance, on l'ajoute donc en attribut et on le greffe dans
     le shader — c'est le même procédé que le reste du projet. */
  const alphas = new Float32Array(POOL);
  alphaAttr = new THREE.InstancedBufferAttribute(alphas, 1);
  alphaAttr.setUsage(THREE.DynamicDrawUsage);

  mat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aAlpha;\nvarying float vAlpha;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n  vAlpha = aAlpha;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vAlpha;')
      /* Sur `color_fragment`, donc après la texture et avant tout le reste :
         l'alpha de l'empreinte multiplie celui du dessin au lieu de le
         remplacer, et le bord doux du dégradé est préservé. */
      .replace('#include <color_fragment>', '#include <color_fragment>\n  diffuseColor.a *= vAlpha;');
  };
  mat.customProgramCacheKey = () => 'footprint';
  /* Même déplacement que le décor : le sol est vallonné en shader, une
     empreinte posée à plat le traverserait sur les bosses. */
  applyGroundFollow(mat, 'footprint');

  mesh = new THREE.InstancedMesh(geo, mat, POOL);
  mesh.geometry.setAttribute('aAlpha', alphaAttr);
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.frustumCulled = false;   // les instances bougent, la boîte serait fausse
  mesh.renderOrder = 1;         // sous la peinture de culte (2) et le HUD
  mesh.count = POOL;
  mesh.userData.sharedGeo = true;
  mesh.userData.forceNoShadow = true;

  /* Toutes les cases démarrent invisibles : un vivier neuf ne doit pas afficher
     320 empreintes empilées à l'origine. */
  for (let i = 0; i < POOL; i++) {
    alive.push({ x: 0, z: 0, alpha: 0 });
    _m.makeScale(0, 0, 0);
    mesh.setMatrixAt(i, _m);
  }
  scene.add(mesh);
  return mesh;
}

/**
 * Accorde les traces à la matière du biome.
 *
 * `B.footprint` décrit ce que le sol GARDE d'un pas. C'est une propriété de
 * matière, pas de décor : le sable et la neige creusent, l'herbe se couche, la
 * roche ne retient rien.
 */
export function setFootprintBiome(B) {
  if (!mesh) return;
  const f = (B && B.footprint) || DEFAULT_MARK;
  mesh.material.map = markTexture(f.kind === 'dimple' ? 'dimple' : 'press');
  mesh.material.color.set(f.color !== undefined ? f.color : DEFAULT_MARK.color);
  mesh.material.opacity = f.opacity !== undefined ? f.opacity : DEFAULT_MARK.opacity;
  mesh.material.needsUpdate = true;
  mesh.userData.size = f.size || DEFAULT_MARK.size;
  /* Un sol qui ne retient rien : on éteint le maillage entier plutôt que de
     dessiner 320 quads transparents. */
  mesh.visible = (f.opacity === undefined ? DEFAULT_MARK.opacity : f.opacity) > 0.01;
}

/** Efface toutes les traces — changement de carte. */
export function clearFootprints() {
  if (!mesh) return;
  for (let i = 0; i < POOL; i++) {
    alive[i].alpha = 0;
    alphaAttr.array[i] = 0;
    _m.makeScale(0, 0, 0);
    mesh.setMatrixAt(i, _m);
  }
  alphaAttr.needsUpdate = true;
  mesh.instanceMatrix.needsUpdate = true;
  cursor = 0;
}

/**
 * Pose une empreinte.
 *
 * @param {number} x @param {number} y @param {number} z  point d'appui
 * @param {number} ang  cap de marche, en radians
 * @param {number} side -1 ou +1 : le pied gauche ou le droit. Sans ce décalage
 *   les traces s'alignent sur un fil et se lisent comme une piste de vélo.
 * @param {number} scale  échelle du personnage
 */
export function addFootprint(x, y, z, ang, side, scale = 1) {
  if (!mesh || !mesh.visible) return;
  const size = (mesh.userData.size || DEFAULT_MARK.size) * scale;
  /* Décalage latéral : perpendiculaire au cap. */
  const off = 0.26 * scale * side;
  const px = x + Math.cos(ang) * off;
  const pz = z - Math.sin(ang) * off;

  const i = cursor;
  cursor = (cursor + 1) % POOL;

  _p.set(px, y + 0.02, pz);
  _q.setFromAxisAngle(_up, ang);
  _s.set(size, 1, size * 1.35);
  _m.compose(_p, _q, _s);
  mesh.setMatrixAt(i, _m);
  mesh.instanceMatrix.needsUpdate = true;

  const a = alive[i];
  a.x = px; a.z = pz; a.alpha = 1;
  alphaAttr.array[i] = 1;
  alphaAttr.needsUpdate = true;
}

/**
 * Fondu par la distance à la caméra.
 *
 * Recalculé à chaque image plutôt que mémorisé : la caméra suit le joueur, donc
 * une empreinte peut se rapprocher après s'être éloignée. Un fondu à sens
 * unique ferait disparaître définitivement une trace qu'on revient voir.
 */
export function updateFootprints(camera) {
  if (!mesh || !mesh.visible) return;
  const cx = camera.position.x, cz = camera.position.z;
  let dirty = false;
  for (let i = 0; i < POOL; i++) {
    const a = alive[i];
    if (a.alpha <= 0) continue;
    const d = Math.hypot(a.x - cx, a.z - cz);
    const v = d <= FADE_NEAR ? 1
      : d >= FADE_FAR ? 0
        : 1 - (d - FADE_NEAR) / (FADE_FAR - FADE_NEAR);
    if (alphaAttr.array[i] !== v) { alphaAttr.array[i] = v; dirty = true; }
  }
  if (dirty) alphaAttr.needsUpdate = true;
}
