import './style.css';

/* ---- Report d'erreur à l'écran ----
   Une exception dans startGame laisse le menu affiché sans le moindre indice,
   et sur téléphone il n'y a pas de console pour aller voir. On l'affiche. */
function showCrash(what, err) {
  try {
    const box = document.getElementById('crash');
    const msg = document.getElementById('crash-msg');
    if (!box || !msg) return;
    msg.textContent = (msg.textContent ? msg.textContent + String.fromCharCode(10, 10) : '')
      + what + ' : ' + (err && err.stack ? err.stack : err);
    box.classList.remove('hidden');
  } catch { /* on ne casse pas le rapport d'erreur */ }
}
window.addEventListener('error', (e) => showCrash('Erreur', e.error || e.message));
window.addEventListener('unhandledrejection', (e) => showCrash('Promesse rejetée', e.reason));

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { gltfLoader, makeGLTFLoader } from './gltf.js';
import { renderSpiritPortrait, getSpiritPortrait } from './spirit-portrait.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import { openProgression, setPlayHandler, setHubHandler, getGlobalStats, formatBelievers, getSpiritsCount, addSpirits, getCountryPortalState, recordPortalVictory } from './progression.js';
import { createPortalMesh, createCentralAltarMesh, createGreatPlanetPortalMesh, updatePortalsSystem, setPortalState } from './portals.js';
import {
  BIOMES, getBiomeForIso, randomBiomeKey, buildBiomeScenery, toonMaterial, patchToonOutline, attachCartoonOutline,
  loadGrass, onGrassReady, buildBiomeGrass,
  loadTrees, onTreesReady, buildBiomeTrees,
  loadNature, onNatureReady, buildBiomeNature,
} from './biomes.js';
import {
  generateIsland, buildIslandMeshes, buildVoid, updateVoid, setVoidDim, disposeVoid,
  makeTilePlacer, resolveIsland, randomPoint as islandRandomPoint, isSolid,
  HEX_R, STEP_H, nearestSolidPoint, canJumpToward, groundHeightAt, canStep, tileAt,
  buildPaintSurface, flatTiles,
  reserveSanctuary,
} from './hexmap.js';
import { initNative } from './cap.js';
import { getSkillMods } from './skills.js';
import {
  initCrystals, updateCrystals, spawnSoulBurst,
  resetCrystals,
} from './crystals.js';
import { IS_MOBILE, describeDevice } from './device.js';
import { bakeVAT, makeVATMaterial, makeVATOutlineMaterial } from './vat.js';
import { soundEngine } from './soundEngine.js';
import {
  MAP_R, DENSITY, AGENT_CAP_MOBILE, AGENT_CAP_DESKTOP,
  START_GRAYS as START_GRAYS_CONST, NB_FACTIONS, WIN_PCT,
  SIEGE_R, SIEGE_R2, SIEGE_RATE,
  BASE_WALL_R, BASE_WALL_T, BASE_WALL_H, BASE_GATE_HALF, BASE_WALL_SEGS, BASE_SPAWN_R,
  DEPOSIT_RATE,
  MATCH_DUR, FUEL_MAX, FUEL_PER_UNIT, FUEL_PER_GRAY,
  SCORE_PER_PCT, SCORE_PER_GRAY, SCORE_PER_DIST, PAINT_TRAIL_R,
  SIPHON_BASE, SIPHON_RATIO_MIN, SIPHON_RATIO_CAP,
  BOOST_MULT, BOOST_DUR, BOOST_CD,
  STREAK_WINDOW, STREAK_PALIERS,
  CONV_R, CONV_RITUAL_T, FLEE_R,
  FOLLOWER_SCALE, FOLLOWER_FLEE_R, FOLLOWER_SPD, FOLLOWER_WANDER_SPD,
  RALLY_CD, RALLY_DUR, GRAY_MIN,
  FERVOR_GAIN, FERVOR_DECAY, ECSTASY_DUR, ECSTASY_RANGE, ECSTASY_CONV,
  SHRINE_R, SHRINE_CAPTURE_T, SHRINE_INCOME_T, SHRINE_INCOME_N,
  CELL, CONTACT_R, CONTACT_R2, SEP_R,
  V_MAX, V_MIN, N_REF, LEADER_RESP, CAM_RESP, CAM_LOOK_RESP,
} from './sim/constants.js';
import { createAgent, resetAgent, createFaction, createTeam } from './sim/state.js';
import { leaderSpeed as _leaderSpeed } from './sim/leader.js';
import { effects } from './sim/effects.js';
import { aiThink as _aiThink, paintMixAround as _paintMixAround } from './sim/ai.js';
import { stepLeaders as _stepLeaders, stepLeaderRepulsion as _stepLeaderRepulsion, playerDir } from './sim/leader-tick.js';
import { initGamepad, pollGamepad } from './gamepad.js';
import { stepCrowd as _stepCrowd } from './sim/crowd-tick.js';
import {
  EVENT_TIMES, EVENT_SPIN_DUR, EVENT_REVEAL_DUR,
  EVENT_DECK, pickEvent, applyEvent,
} from './sim/events.js';
import {
  CARD_PICK_R, CARD_MIN_D,
  pickCard, buildCardSchedule, applyCard, bannerTone,
} from './sim/cards.js';
import { createNetClient } from './net/client.js';
import { createRng } from './sim/rng.js';
import { drawOrb, drawGlow } from './orb-texture.js';
import {
  projectiles, clearProjectiles, pickTarget, fireAttack, stepProjectiles,
  tickDownStates, collectDowned, LEADER_DOWN_T,
} from './sim/attacks.js';

const net = createNetClient();
let multiMode = false;   // true = partie en ligne P2P (WebRTC via PeerJS)

/* Multi : le monde doit être IDENTIQUE sur tous les écrans. L'hôte envoie
   une graine ; on branche Math.random sur un PRNG semé le temps de générer la
   carte et la foule, puis on rend la main au vrai Math.random (les effets
   visuels peuvent rester aléatoires, ils n'affectent rien de partagé). */
function withSeededRandom(seed, fn) {
  const rng = createRng(seed);
  const real = Math.random;
  Math.random = () => rng.next();
  try { return fn(); } finally { Math.random = real; }
}

initNative();

/** Bonus de campagne (rafraîchis à chaque partie). Faction 0 = joueur. */
let skillMods = getSkillMods();

/* ============================== Config ==============================
   Les constantes de gameplay sont désormais dans src/sim/constants.js
   (pour que le futur serveur headless puisse les partager). */
const _isMobile = IS_MOBILE;
const AGENT_CAP = _isMobile ? AGENT_CAP_MOBILE : AGENT_CAP_DESKTOP;
let MAX_AGENTS = AGENT_CAP;
let START_GRAYS = START_GRAYS_CONST;
const CULTS = [
  { c: 0xff2e7e, name: 'Écarlate',  sym: '❤' },
  { c: 0x00c8ff, name: 'Sélénie',   sym: '☾' },
  { c: 0xffb300, name: 'Hélion',    sym: '☀' },
  { c: 0x22dd77, name: 'Sylvane',   sym: '🌿' },
  { c: 0x8b5cf6, name: 'Occule',    sym: '👁' },
  { c: 0xff5533, name: 'Pyrrhée',   sym: '🔥' },
  { c: 0x00ffcc, name: 'Thalasse',  sym: '🌊' },
  { c: 0xff7700, name: 'Aurore',    sym: '✶' },
  { c: 0x3f51b5, name: 'Nyxar',     sym: '☯' },
  { c: 0xff4fd8, name: 'Specula',   sym: '✧' },
];
// Tribus barbares : noms aléatoires quand on joue sur une zone non conquise (grise).
const BARBARIAN_NAMES = [
  'Vandales', 'Huns', 'Goths', 'Pictes', 'Wisigoths', 'Ostrogoths', 'Saxons',
  'Vikings', 'Gaulois', 'Celtes', 'Scythes', 'Alains', 'Suèves', 'Jutes',
  'Angles', 'Francs', 'Berbères', 'Magyars', 'Sarmates', 'Cimbres', 'Teutons',
];
const BARBARIAN_SYMS = ['⚔', '🪓', '🛡️', '🏹', '💀', '🔨'];
const GRAY = new THREE.Color(0x9aa2ad); // Esprits neutres : couleur de base d'origine
const WHITE = new THREE.Color(1, 1, 1);
const SHARED_PARTICLE_GEO = new THREE.DodecahedronGeometry(1, 0);
const _particleMatCache = new Map();   // couleur d'instance neutre du paysan (corps non teinté)
let currentDifficulty = localStorage.getItem('cultio_difficulty') || 'normal';

/* Distance caméra (menu) : multiplie hauteur + recul sans changer l'angle iso. */
const CAM_DIST_MUL = { near: 0.78, mid: 1.0, far: 1.32 };
const CAM_DIST_KEY = 'cultio_cam_dist';
let currentCamDist = localStorage.getItem(CAM_DIST_KEY) || 'mid';
if (!(currentCamDist in CAM_DIST_MUL)) currentCamDist = 'mid';
let camDistMul = CAM_DIST_MUL[currentCamDist];

/* Qualité graphique (menu). Sur tactile : MSAA activé partout — c'est
   quasi-gratuit sur GPU mobiles tile-based (Adreno/Mali/Apple) et supprime
   l'escalier des contours BackSide bien plus efficacement que monter le DPR.
   Le DPR est en contrepartie tenu bas pour garder la charge fillrate ≤ à ce
   qu'on avait avant. Desktop inchangé. */
const isCoarse = IS_MOBILE;
const GRAPHICS = isCoarse ? {
  low:  { maxDpr: 1.0,  aa: true, shadows: false },
  mid:  { maxDpr: 1.1,  aa: true, shadows: false },
  high: { maxDpr: 1.25, aa: true, shadows: true },
} : {
  low:  { maxDpr: 1.0, aa: false, shadows: false },
  mid:  { maxDpr: 1.5, aa: true,  shadows: false },
  high: { maxDpr: 2.0, aa: true,  shadows: true },
};
const GRAPHICS_KEY = 'cultio_graphics';
let currentGraphics = localStorage.getItem(GRAPHICS_KEY) || (isCoarse ? 'low' : 'high');
if (!(currentGraphics in GRAPHICS)) currentGraphics = isCoarse ? 'low' : 'high';
const gfx = () => GRAPHICS[currentGraphics];
const gfxShadows = () => gfx().shadows;

/* ============================== Rendu ============================== */
const renderer = new THREE.WebGLRenderer({
  antialias: gfx().aa,
  /* low-power sur tactile : le navigateur / SoC limite mieux la chauffe. */
  powerPreference: isCoarse ? 'low-power' : 'high-performance',
});
/* L'antialias est figé au contexte WebGL : si l'utilisateur change de palier
   AA, on recharge pour recréer le renderer. */
const _bootGfxAA = gfx().aa;
renderer.shadowMap.type = isCoarse ? THREE.BasicShadowMap : THREE.PCFShadowMap;
/* Coupe locale : sans elle, les `clippingPlanes` posés sur un matériau sont
   purement et simplement ignorés. Seule la levée des statues de sanctuaire s'en
   sert (elles émergent du sol au lieu de le traverser), et la coupe est retirée
   dès l'animation finie — le coût ne porte donc que sur ces deux secondes. */
renderer.localClippingEnabled = true;
/* ---- Tone mapping ----
   NEUTRAL, et non ACES. ACESFilmic est une courbe photographique conçue pour du
   rendu HDR réaliste : elle désature franchement et DÉPLACE les teintes — les
   verts glissent vers le jaune, les oranges vers le rouge. Sur une palette
   cartoon peinte à la main, c'est ce qui donnait cette image délavée dont les
   couleurs n'étaient plus celles des textures.

   `NeutralToneMapping` (Khronos PBR Neutral) ne touche qu'aux hautes lumières :
   il comprime ce qui dépasse 1.0 et laisse le reste intact, teinte comprise. On
   garde donc une protection contre le cramage sans payer la dérive chromatique.

   Conséquence sur l'exposition : ACES multipliait en interne par `exposure/0.6`,
   soit un facteur caché de 1,67. Les valeurs d'exposition ont été redescendues
   d'autant, sinon toute la scène partait en surbrillance. */
renderer.toneMapping = THREE.NeutralToneMapping;
renderer.toneMappingExposure = 1.0;
document.getElementById('app').appendChild(renderer.domElement);

/* ---- Étalonnage global ----
   Saturation, contraste et teinte se règlent par un filtre CSS posé sur le
   canvas. C'est du post-traitement gratuit : le compositeur du navigateur
   l'applique sur le GPU, sans passe de rendu supplémentaire ni cible de rendu
   intermédiaire — là où un EffectComposer coûterait un doublement de la bande
   passante mémoire sur mobile, pour le même résultat visuel.

   Le filtre ne porte que sur le canvas : le HUD, lui, garde ses couleurs
   exactes. C'est voulu — étalonner l'interface avec le décor rendrait les
   couleurs de culte fausses dans les jauges.

   Ces trois valeurs sont le point de départ de la direction artistique. Elles
   se règlent en direct par le panneau d'ambiance (window.__grade). */
const GRADE = {
  saturation: 1.08,   // 1 = neutre. Un cheveu au-dessus : le cartoon respire.
  contrast: 1.04,     // 1 = neutre. Assez pour asseoir les ombres, pas plus.
  hue: 0,             // degrés. 0 = teintes des textures respectées.
  brightness: 1.0,    // 1 = neutre. À ne bouger qu'en dernier recours : la
                      // luminosité appartient à l'exposition, pas au filtre.
};

/* Facteurs correctifs de réglage. Le cycle jour/nuit réécrit l'exposition et les
   intensités à chaque image : sans ces multiplicateurs, toute valeur posée à la
   main serait effacée à l'image suivante et le panneau d'ambiance ne servirait à
   rien. À 1, ils n'ont aucun effet — ils ne changent donc pas le rendu livré. */
const TUNE = { exposure: 1, sun: 1, hemi: 1 };

function applyGrade() {
  const g = GRADE;
  const parts = [];
  if (g.brightness !== 1) parts.push(`brightness(${g.brightness})`);
  if (g.contrast !== 1) parts.push(`contrast(${g.contrast})`);
  if (g.saturation !== 1) parts.push(`saturate(${g.saturation})`);
  if (g.hue !== 0) parts.push(`hue-rotate(${g.hue}deg)`);
  renderer.domElement.style.filter = parts.length ? parts.join(' ') : '';
}
applyGrade();

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x9fdcff);
scene.fog = new THREE.Fog(0x9fdcff, 70, 165);

// Poignée de debug console : window.__cult.info() → draw calls / triangles ;
// window.__cult.toggleNature() → montre/cache le décor pour isoler son coût.
window.__cult = {
  scene, renderer,
  info: () => ({ ...renderer.info.render, programs: renderer.info.programs.length }),
  /* Pourquoi le jeu se croit-il sur mobile ? (contours, plafonds, fps) */
  env: () => ({ ...describeDevice(), graphics: currentGraphics }),
  /* État des contours cartoon : présents ? dessinés ? visibles ? */
  outlines() {
    const rows = [];
    const scan = (label, mesh) => {
      const o = mesh && mesh.userData.outlineMesh;
      rows.push({
        mesh: label,
        instances: mesh ? mesh.count : 0,
        outline: !!o,
        outlineCount: o ? o.count : 0,
        inScene: o ? !!o.parent : false,
        visible: o ? o.visible && o.material.visible : false,
      });
    };
    crowds.forEach((m, i) => scan('crowd[' + i + ']', m));
    for (const k of Object.keys(followerMeshes)) scan('follower:' + k, followerMeshes[k].mesh);
    return rows;
  },
  facs: () => factions,
  toggleNature() {
    let n = 0;
    scene.traverse((o) => { if (o.isInstancedMesh && o.userData.sharedGeo) { o.visible = !o.visible; n++; } });
    return n + ' meshes décor basculés';
  },
};

const camera = new THREE.PerspectiveCamera(48, innerWidth / innerHeight, 0.5, 400);

const hemi = new THREE.HemisphereLight(0xcfefff, 0x4a7a4f, 0.95);
scene.add(hemi);
const sun = new THREE.DirectionalLight(0xfff2d8, 1.6);
sun.castShadow = true;
sun.shadow.bias = -0.0015;
scene.add(sun, sun.target);

/** Résolution + frustum d'ombre : 256 / serré sur tactile, 1024 / large sur desktop. */
function configureSunShadow(enabled) {
  const mobile = isCoarse;
  const size = mobile ? 256 : 1024;
  const half = mobile ? 16 : 28;
  if (sun.shadow.mapSize.x !== size) {
    sun.shadow.mapSize.set(size, size);
    if (sun.shadow.map) {
      sun.shadow.map.dispose();
      sun.shadow.map = null;
    }
  }
  sun.shadow.camera.left = -half;
  sun.shadow.camera.right = half;
  sun.shadow.camera.top = half;
  sun.shadow.camera.bottom = -half;
  sun.shadow.camera.far = mobile ? 70 : 120;
  sun.shadow.camera.updateProjectionMatrix();
  sun.castShadow = !!enabled;
}

/** Applique DPR + ombres (l'AA est figé à la création du contexte WebGL). */
function applyGraphicsQuality() {
  const g = gfx();
  renderer.setPixelRatio(Math.min(devicePixelRatio, g.maxDpr));
  renderer.setSize(innerWidth, innerHeight);
  renderer.shadowMap.enabled = g.shadows;
  configureSunShadow(g.shadows);
  scene.traverse((o) => {
    if (!o.isMesh && !o.isInstancedMesh) return;
    if (o.userData.forceNoShadow) return;
    if (o.userData.shadowable) {
      o.castShadow = g.shadows;
      o.receiveShadow = g.shadows || o.receiveShadow;
    }
  });
}
applyGraphicsQuality();

/* ---- Éclairage personnages (Leaders + foule) ----
   Couche séparée : la pénombre du cycle jour/nuit n'assombrit que le décor.
   Les persos gardent une lumière « jour » constante — lisibles jusqu'au gong. */
const LAYER_WORLD = 0;
const LAYER_CHARS = 1;
camera.layers.enable(LAYER_CHARS);
hemi.layers.set(LAYER_WORLD);
sun.layers.set(LAYER_WORLD);
sun.target.layers.set(LAYER_WORLD);

/* Intensités de référence des lumières « personnages ». Le cycle du jour ne les
   pilote pas — les persos restent lisibles quelle que soit l'heure — mais la
   nuit noire les éteint, et il lui faut une valeur d'origine où revenir. */
const CHAR_HEMI_I = 1.0;
const CHAR_SUN_I = 1.55;
const charHemi = new THREE.HemisphereLight(0xcfefff, 0x5a8a5f, CHAR_HEMI_I);
charHemi.layers.set(LAYER_CHARS);
scene.add(charHemi);
const charSun = new THREE.DirectionalLight(0xfff2d8, CHAR_SUN_I);
charSun.layers.set(LAYER_CHARS);
scene.add(charSun, charSun.target);

function setCharLayer(root) {
  if (!root) return;
  root.layers.set(LAYER_CHARS);
  root.traverse?.((o) => { o.layers.set(LAYER_CHARS); });
}

/* Lanterne du joueur : halo chaud qui n'existe que dans la pénombre (petit
   matin, crépuscule, nuit) — de quoi lire le sol autour de soi sans casser
   l'ambiance. Intensité pilotée par nightK dans la boucle.
   Deux couches : une PointLight adoucie (éclaire les personnages/décor en 3D)
   et un disque-dégradé additif au sol — le rendu toon quantifie la lumière en
   paliers durs, le disque garantit un bord parfaitement diffus. */
const playerLamp = new THREE.PointLight(0xffd9a0, 0, 30, 2.2);
playerLamp.position.y = 2.4;
/* Doit atteindre les DEUX couches. Les personnages vivent sur LAYER_CHARS et
   `layers.set()` est exclusif : une lampe posée sur le seul LAYER_WORLD éclaire
   le sol autour du joueur mais laisse le joueur lui-même dans le noir — soit
   exactement l'inverse de ce qu'une lanterne doit faire. */
playerLamp.layers.set(LAYER_WORLD);
playerLamp.layers.enable(LAYER_CHARS);
scene.add(playerLamp);
const lampGlowTex = (() => {
  const cv = document.createElement('canvas');
  cv.width = cv.height = 128;
  const c = cv.getContext('2d');
  const g = c.createRadialGradient(64, 64, 0, 64, 64, 64);
  g.addColorStop(0.0, 'rgba(255,221,170,0.55)');
  g.addColorStop(0.35, 'rgba(255,205,140,0.30)');
  g.addColorStop(0.7, 'rgba(255,190,120,0.10)');
  g.addColorStop(1.0, 'rgba(255,180,110,0)');
  c.fillStyle = g;
  c.fillRect(0, 0, 128, 128);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
})();
const lampGlow = new THREE.Mesh(
  new THREE.PlaneGeometry(30, 30).rotateX(-Math.PI / 2),
  new THREE.MeshBasicMaterial({
    map: lampGlowTex,
    transparent: true,
    opacity: 0,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  })
);
lampGlow.position.y = 0.06;
lampGlow.renderOrder = 2;
scene.add(lampGlow);

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  applyGraphicsQuality();
});

/* ============================== Carte : archipel hexagonal par biome ============================== */
/* Tous les objets de la carte courante — retirés + disposés à chaque rebuild. */
let mapObjects = [];
let currentBiomeKey = 'temperate';
let playerStepTimer = 0;
/* L'île hexagonale de la partie en cours : silhouette, trous, rôles de tuiles.
   C'est elle qui fait autorité sur « où peut-on marcher ». */
let island = null;
/* Ramène un point sur l'île : centre de la tuile la plus proche s'il tombe dans
   le vide. Utilisé par tous les spawns, qui raisonnent en coordonnées libres. */
function onIsland(x, z) {
  const e = { x, z };
  resolveIsland(island, e, 0, 0, 0, false);
  return e;
}

/* Hauteur du sol sous un point. Tout ce qui se pose sur la carte doit passer
   par là : depuis que les tuiles ont des niveaux, un `position.set(x, 0, z)`
   enterre l'objet dans le premier plateau venu. */
function groundY(x, z) { return groundHeightAt(island, x, z); }

/* Guidage anti-vide : si la direction souhaitée mène hors dalle, on dévie
   vers la meilleure alternative encore solide (sinon on reste collé au mur
   invisible et on pousse dans le néant). Retourne un vecteur unitaire.
   preferSide (±1) biaise le choix vers un côté de contournement. */
const _STEER_ANGLES = [0.4, -0.4, 0.85, -0.85, 1.3, -1.3, 1.8, -1.8, 2.4, -2.4, Math.PI];
function steerOnIsland(x, z, wishX, wishZ, lookAhead = 3.2, preferSide = 0) {
  const wn = Math.hypot(wishX, wishZ);
  if (wn < 1e-5) return { x: 0, z: 0 };
  const wx = wishX / wn, wz = wishZ / wn;

  /* Sonde franchissable : sol présent ET pas de falaise entre ici et là. */
  const probeOk = (dx, dz, dist) => canStep(island, x, z, x + dx * dist, z + dz * dist);

  if (preferSide === 0 && probeOk(wx, wz, lookAhead) && probeOk(wx, wz, lookAhead * 0.45)) {
    return { x: wx, z: wz };
  }

  let bestX = 0, bestZ = 0, bestScore = -1e9;
  for (let i = 0; i < _STEER_ANGLES.length; i++) {
    let ang = _STEER_ANGLES[i];
    /* Pendant un détour, on favorise le côté choisi (angles du même signe). */
    if (preferSide !== 0 && ang * preferSide < 0) ang = -ang;
    const c = Math.cos(ang), s = Math.sin(ang);
    const dx = wx * c - wz * s;
    const dz = wx * s + wz * c;
    if (!probeOk(dx, dz, lookAhead * 0.4)) continue;
    if (!probeOk(dx, dz, lookAhead)) continue;
    const align = dx * wx + dz * wz;
    const deep = probeOk(dx, dz, lookAhead * 1.4) ? 0.25 : 0;
    const sideBias = preferSide !== 0 ? Math.abs(ang) * 0.08 * (ang * preferSide > 0 ? 1 : -0.5) : 0;
    const score = align + deep + sideBias;
    if (score > bestScore) { bestScore = score; bestX = dx; bestZ = dz; }
  }
  if (bestScore > -1e8) return { x: bestX, z: bestZ };

  /* Coin sans issue : se rabattre vers le centre de la tuile sous les pieds. */
  const p = nearestSolidPoint(island, x, z);
  const rdx = p.x - x, rdz = p.z - z;
  const rn = Math.hypot(rdx, rdz);
  if (rn > 0.15) return { x: rdx / rn, z: rdz / rn };
  return { x: 0, z: 0 };
}

/** À quel point on peut encore progresser vers (tx,tz) sans plonger dans le vide. */
function islandApproachScore(x, z, tx, tz) {
  const dx = tx - x, dz = tz - z;
  const d = Math.hypot(dx, dz) || 1;
  const s = steerOnIsland(x, z, dx, dz, Math.min(4, Math.max(1.8, d * 0.4)));
  return s.x * (dx / d) + s.z * (dz / d);
}

/** Le pas suivant vers la cible est-il libre, ou faut-il contourner ? */
function islandPathBlocked(x, z, tx, tz, lookAhead = 3.0) {
  const dx = tx - x, dz = tz - z;
  const d = Math.hypot(dx, dz);
  if (d < 0.8) return false;
  const nx = dx / d, nz = dz / d;
  const dist = Math.min(lookAhead, d);
  return !canStep(island, x, z, x + nx * dist, z + nz * dist)
      || !canStep(island, x, z, x + nx * dist * 0.5, z + nz * dist * 0.5);
}

function disposeMap() {
  disposeVoid();
  for (const obj of mapObjects) {
    // entrées de nettoyage pures (fond de scène…) : pas des Object3D
    if (obj.dispose && !obj.isObject3D) { obj.dispose(); continue; }
    // outline sibling (pas enfant de l'InstancedMesh)
    const outline = obj.userData && obj.userData.outlineMesh;
    if (outline) {
      if (outline.parent) outline.parent.remove(outline);
      if (outline.material) outline.material.dispose();
      obj.userData.outlineMesh = null;
    }
    scene.remove(obj);
    // les touffes d'herbe partagent leur géométrie entre toutes les cartes
    if (obj.geometry && !obj.userData.sharedGeo) obj.geometry.dispose();
    if (obj.material && !obj.userData.sharedMat) {
      if (Array.isArray(obj.material)) obj.material.forEach((mm) => mm.dispose());
      else obj.material.dispose();
    }
  }
  mapObjects = [];
}

function buildMap(biomeKey = 'temperate') {
  // Retire l'île précédente (menu / partie d'avant) — sinon les trous restent
  // « remplis » par la croûte solide d'en dessous.
  disposeMap();

  currentBiomeKey = biomeKey;
  const B = BIOMES[biomeKey] || BIOMES.temperate;

  /* L'île est tirée au sort à chaque partie : silhouette, trous, hameaux et
     sanctuaires changent, le biome reste le même. */
  island = generateIsland({ biomeKey, maxR: MAP_R });
  reserveAltarSites();
  rebuildPaintMask();
  rebuildPaintSurface();   // la nappe doit épouser le relief de CETTE île

  // Ambiance : lumière du biome (ciel et brouillard sont posés par buildVoid)
  hemi.color.set(B.hemiSky);
  hemi.groundColor.set(B.hemiGround);

  // Lumière d'accent directionnelle par biome (contre-jour chaud/froid selon le biome)
  const accent = new THREE.DirectionalLight(B.accentLight || 0xffd580, 0.55);
  accent.position.set(-18, 22, -12);
  scene.add(accent);
  mapObjects.push(accent);

  // Soleil : angle plus rasant pour des ombres longues et dramatiques
  sun.position.set(28, 40, 20);
  sun.target.position.set(0, 0, 0);
  sun.target.updateMatrixWorld();

  // L'île : croûte hexagonale teintée + roche suspendue dessous
  mapObjects.push(...buildIslandMeshes(scene, island));
  // Le vide : dégradé d'abîme, éclats en suspension, poussière lumineuse
  mapObjects.push(...buildVoid(scene, island, biomeKey));

  /* Sanctuaires / maisons / bases : retirés pour l’instant (île nue). */

  /* Torches : une par tuile de bordure, plantée près de l'arête qui donne sur
     le vide. Elles dessinent le contour de l'île au lieu d'un cercle abstrait. */
  const torchColor = B.torchColor || 0xff6a1a;
  const rimTiles = island.tiles.filter((t) => t.edge);
  const TORCH_COUNT = Math.min(28, rimTiles.length);
  const torchStep = Math.max(1, Math.floor(rimTiles.length / TORCH_COUNT));
  const torchGeoBase = new THREE.CylinderGeometry(0.08, 0.12, 0.9, 5);
  const torchGeoHead = new THREE.CylinderGeometry(0.12, 0.10, 0.22, 6);
  const torchMatBase = toonMaterial({ color: 0x6a4220 });
  const torchMatHead = toonMaterial({ color: 0x2a1a0a });
  const flameGeo = new THREE.ConeGeometry(0.14, 0.36, 6);
  const flameMat = toonMaterial({ color: torchColor, emissive: torchColor, emissiveIntensity: 2.0 });
  for (let i = 0; i < TORCH_COUNT; i++) {
    const t = rimTiles[(i * torchStep) % rimTiles.length];
    /* Décalée vers l'extérieur de la tuile, mais assez en retrait pour ne pas
       flotter au-dessus du vide. */
    const a = Math.atan2(t.z, t.x);
    const tx = t.x + Math.cos(a) * HEX_R * 0.55;
    const tz = t.z + Math.sin(a) * HEX_R * 0.55;
    const torchGrp = new THREE.Group();
    // Manche en bois
    const shaft = new THREE.Mesh(torchGeoBase, torchMatBase);
    shaft.position.y = 0.45;
    shaft.castShadow = gfxShadows();
    shaft.userData.shadowable = true;
    torchGrp.add(shaft);
    // Tête de torche (anneau de paille)
    const head = new THREE.Mesh(torchGeoHead, torchMatHead);
    head.position.y = 1.0;
    torchGrp.add(head);
    // Flamme
    const flame = new THREE.Mesh(flameGeo, flameMat);
    flame.position.y = 1.35;
    torchGrp.add(flame);
    torchGrp.position.set(tx, groundY(tx, tz), tz);
    // Légère inclinaison vers le centre
    torchGrp.lookAt(0, 0, 0);
    torchGrp.rotateX(-0.08);
    torchGrp.rotation.y = a + Math.PI;
    attachCartoonOutline(torchGrp, 0.03);
    scene.add(torchGrp);
    mapObjects.push(torchGrp);
  }

  /* Décor procédural du biome. Le placeur remplace le tirage radial : chaque
     prop atterrit sur une tuile dont le rôle l'accepte, à l'écart des arêtes. */
  const placer = makeTilePlacer(island);
  const scenery = buildBiomeScenery(scene, biomeKey, MAP_R, placer);
  mapObjects.push(...scenery.meshes);
  pendingHouses = scenery.houses;
  // Herbes et arbres : modèles externes, sans effet s'ils ne sont pas encore
  // chargés (voir onGrassReady / onTreesReady)
  mapObjects.push(...buildBiomeGrass(scene, biomeKey, MAP_R, placer));
  mapObjects.push(...buildBiomeTrees(scene, biomeKey, MAP_R, placer));
  mapObjects.push(...buildBiomeNature(scene, biomeKey, MAP_R, placer));
}

/* ============================== Meshes des agents ============================== */
/* Fidèle encapuchonné (thème Cult.io) : robe évasée, tête, et une capuche pointue
   inclinée vers l'arrière — silhouette de cultiste lisible d'un coup d'œil. Teinté
   par instance en UNE couleur unie : gris pour les sceptiques, couleur du culte une
   fois converti (GDD §5.1 — « une couleur par camp, lisible à 200 exemplaires »). */
function makeMeeple() {
  // robe : tronc de cône qui s'évase vers le bas
  const robe = new THREE.CylinderGeometry(0.20, 0.44, 0.98, 8).translate(0, 0.49, 0);
  // épaules arrondies pour casser le côté « plot »
  const torso = new THREE.SphereGeometry(0.27, 8, 6).scale(1, 0.8, 1).translate(0, 0.92, 0);
  // tête
  const head = new THREE.SphereGeometry(0.185, 8, 6).translate(0, 1.16, 0.02);
  // capuche pointue, basculée en arrière : le visage dépasse à peine
  const hood = new THREE.ConeGeometry(0.28, 0.6, 8).rotateX(-0.3).translate(0, 1.2, -0.07);
  return mergeGeometries([robe, torso, head, hood]);
}

const meepleGeo = makeMeeple();

/* La foule est faite de trois variantes de villageois (paysan / damoiselle /
   chevalier), un InstancedMesh chacune. La variante d'un agent se déduit de son
   id via un motif de CROWD_CYCLE places : pas de tirage aléatoire à mémoriser, et
   l'emplacement dans le mesh se recalcule à tout moment depuis l'id — donc aucun
   recyclage d'emplacements à gérer. Le meeple chibi sert de fallback jusqu'à ce
   que les .glb soient chargés (voir setupVillager). */
const PEASANT = 0, DAMSEL = 1, KNIGHT = 2;
const FIRE = 3, WATER = 4, AIR = 5, LIGHT = 6, EARTH = 7, ETHER = 8;
const CROWD_VARIANT_COUNT = 9;
const CROWD_CYCLE = 30; // 5 villageois PNJ (1/6) + 25 esprits dorés (5/6) sur 300 agents = 50 villageois + 250 esprits dorés

const CROWD_VARIANT = [];   // place du cycle -> variante
const CROWD_RANK = [];      // place du cycle -> rang parmi les agents de sa variante
const CROWD_PER_CYCLE = new Array(CROWD_VARIANT_COUNT).fill(0);

let elemCounter = 0;
for (let i = 0; i < CROWD_CYCLE; i++) {
  let v;
  if (i === 0) v = PEASANT;
  else if (i === 6) v = DAMSEL;
  else if (i === 12) v = KNIGHT;
  else if (i === 18) v = PEASANT;
  else if (i === 24) v = DAMSEL;
  else {
    v = FIRE + (elemCounter % 6);
    elemCounter++;
  }
  CROWD_VARIANT[i] = v;
  CROWD_RANK[i] = CROWD_PER_CYCLE[v]++;
}
const variantOf = (id) => CROWD_VARIANT[id % CROWD_CYCLE];
const isKnight = (a) => variantOf(a.id) === KNIGHT;
const slotOf = (id) =>
  ((id / CROWD_CYCLE) | 0) * CROWD_PER_CYCLE[variantOf(id)] + CROWD_RANK[id % CROWD_CYCLE];

const crowds = [];
for (let v = 0; v < CROWD_VARIANT_COUNT; v++) {
  const slots = Math.ceil(MAX_AGENTS / CROWD_CYCLE) * CROWD_PER_CYCLE[v];
  const m = new THREE.InstancedMesh(
    meepleGeo,
    toonMaterial({ color: 0xffffff }),
    slots
  );
  m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  m.castShadow = gfxShadows();
  m.userData.shadowable = true;
  m.frustumCulled = false;
  // par instance : x = phase de marche (fixe), y = amplitude de marche (lissée)
  const anim = new THREE.InstancedBufferAttribute(new Float32Array(slots * 2), 2);
  anim.setUsage(THREE.DynamicDrawUsage);
  m.userData.anim = anim;
  m.userData.slots = slots;
  // Villageois neutres : ils gardent leur texture d'origine (couleur d'instance
  // BLANCHE). Plus besoin de couleur de camp — un converti quitte la carte et
  // devient une particule lumineuse en orbite (voir updateCrystals / spawnSoulBurst).
  m.userData.untinted = true;
  scene.add(m);
  setCharLayer(m);
  crowds.push(m);
}
const crowdOf = (id) => crowds[variantOf(id)];

/* Orbites de cristaux + particules d'âme. Le pixelRatio est nécessaire : la
   taille des points est exprimée en pixels du framebuffer. */
initCrystals(scene, renderer.getPixelRatio());


/* Les emplacements libres restent dessinés à l'échelle zéro, mais le vertex shader
   les traite quand même. Comme les ids sont attribués dans l'ordre, les
   emplacements occupés d'une variante forment toujours un préfixe : il suffit de
   ramener count au nombre d'agents de cette variante. */
function trimCrowdCounts(n) {
  const cycles = (n / CROWD_CYCLE) | 0, reste = n % CROWD_CYCLE;
  for (let v = 0; v < crowds.length; v++) {
    let extra = 0;
    for (let i = 0; i < reste; i++) if (CROWD_VARIANT[i] === v) extra++;
    const cnt = Math.min(crowds[v].userData.slots, cycles * CROWD_PER_CYCLE[v] + extra);
    crowds[v].count = cnt;
    if (crowds[v].userData.outlineMesh) crowds[v].userData.outlineMesh.count = cnt;
  }
}
/* Un agent absorbé garde sa place dans l'InstancedMesh (les ids indexent les
   emplacements) : on l'escamote à l'échelle zéro jusqu'à ce qu'un spawn la
   reprenne. */
const ZERO_MATRIX = new THREE.Matrix4().makeScale(0, 0, 0);
function hideAgent(id) {
  const m = crowdOf(id);
  if (!m) return;
  m.setMatrixAt(slotOf(id), ZERO_MATRIX);
  if (m.instanceMatrix) m.instanceMatrix.needsUpdate = true;
  if (m.userData.outlineMesh && m.userData.outlineMesh.instanceMatrix) m.userData.outlineMesh.instanceMatrix.needsUpdate = true;
}

const GOLDEN_SPIRIT_COLOR = new THREE.Color(0xfbbf24);

function setAgentColor(id, col) {
  const m = crowdOf(id);
  if (!m) return;
  const sl = slotOf(id);
  const v = variantOf(id);
  const isElemental = v >= 3;
  const isNeutralCol = !col || col === GRAY || (col.r === GRAY.r && col.g === GRAY.g && col.b === GRAY.b);
  /* Élémentaire au repos : AUCUNE teinte (blanc = texture d'origine). C'est la
     couleur propre de l'élément qui doit se lire, puisque les autels réclament
     un type précis — voir le commentaire des modèles de foule.
     Le doré posé ici auparavant uniformisait les six types, et la capture les
     faisait tous changer de couleur d'un coup : le suivant, lui, a toujours été
     rendu sans teinte. Un esprit d'eau passait de l'or au bleu au moment même
     où on le prenait, ce qui se lisait comme un bug d'attribution. */
  const targetCol = (isElemental && isNeutralCol) ? WHITE : col;

  m.setColorAt(sl, isElemental ? targetCol : (m.userData.untinted ? WHITE : col));
  if (m.userData.hatCol) {
    m.userData.hatCol.setXYZ(sl, targetCol.r, targetCol.g, targetCol.b);
    m.userData.hatCol.needsUpdate = true;
  }
  if (m.instanceColor) m.instanceColor.needsUpdate = true;
}

const ZERO_M = new THREE.Matrix4().makeScale(0, 0, 0);
for (const m of crowds) {
  const hatCol = m.userData.hatCol;   // présent sur le paysan uniquement
  for (let i = 0; i < m.userData.slots; i++) {
    m.setMatrixAt(i, ZERO_M);
    // non teinté (paysan, chevalier) : instance blanche ; autres : instance grise
    m.setColorAt(i, m.userData.untinted ? WHITE : GRAY);
    if (hatCol) hatCol.setXYZ(i, GRAY.r, GRAY.g, GRAY.b);
  }
}
// phase de marche : indexée sur l'id de l'agent, pour rester en phase avec son bob
for (let id = 0; id < MAX_AGENTS; id++) crowdOf(id).userData.anim.setX(slotOf(id), id * 1.7);
trimCrowdCounts(0);   // rien à dessiner tant qu'aucun agent n'existe



function makeLeaderGroup(cult, leaderKey = 'monk') {
  const grp = new THREE.Group();

  // Registre : moine, sorcier, ... ; fallback moine si l'asset demandé n'est
  // pas prêt (chargement asynchrone), fallback chibi si aucun n'est encore là.
  let body;
  let crystalRef = null;
  const asset = leaderAssets[leaderKey] || leaderAssets.monk;

  /* AUCUNE teinte de culte sur le Leader : on affiche la texture d'origine du
     modèle, telle que l'artiste l'a peinte.

     Ce qui existait avant faisait deux choses, et la seconde était la plus
     visible : repeindre la robe du moine, mais SURTOUT poser un émissif de la
     couleur du culte sur tous les Leaders sans exception. Un émissif lave les
     ombres et décale la teinte de l'ensemble du personnage — c'est ce voile
     coloré qu'on voyait sur chacun d'eux.

     L'appartenance au culte se lit ailleurs, et mieux : le cristal au-dessus de
     la tête, l'anneau d'influence au sol, et la peinture du territoire. */

  if (asset && asset.model) {
    body = new THREE.Group();
    const inner = SkeletonUtils.clone(asset.model);
    inner.traverse((child) => {
      if (child.isMesh) {
        child.material = toonMaterial({ map: asset.texture });
        child.castShadow = true;
        child.frustumCulled = false; // les SkinnedMesh clonés ont des bounds faux
      }
    });
    if (asset.clips && asset.clips.length) {
      const mixer = new THREE.AnimationMixer(inner);
      const gaits = MONK_GAITS.map((g) => {
        const clip = THREE.AnimationClip.findByName(asset.clips, g.name);
        if (!clip) return null;
        const action = mixer.clipAction(clip);
        action.play();
        action.setEffectiveWeight(0);
        return { action, ref: g.ref };
      });
      grp.userData.mixer = mixer;
      grp.userData.gaits = gaits;
    }
    // Normalise la hauteur (~2.2 unités) et pose les pieds sur le sol.
    // Les bounds de géométrie ne suivent pas les os : il faut mesurer le mesh
    // dans sa pose skinnée (marche, frame 0), sinon l'échelle est fausse d'un
    // facteur ~100 (squelette Meshy en centimètres) et le moine flotte/disparaît.
    let skinned = null;
    inner.traverse((c) => { if (c.isSkinnedMesh) skinned = c; });
    if (grp.userData.gaits && grp.userData.gaits[0]) {
      grp.userData.gaits[0].action.setEffectiveWeight(1);
      grp.userData.mixer.update(0);
    }
    const monkWorldBox = () => {
      inner.updateMatrixWorld(true);
      if (!skinned) return new THREE.Box3().setFromObject(inner);
      if (skinned.skeleton) skinned.skeleton.update();
      skinned.computeBoundingBox();
      return skinned.boundingBox.clone().applyMatrix4(skinned.matrixWorld);
    };
    // deux passes : la hauteur rendue converge en une itération, la seconde vérifie
    for (let it = 0; it < 2; it++) {
      const bb = monkWorldBox();
      inner.scale.multiplyScalar(2.2 / Math.max(0.001, bb.max.y - bb.min.y));
    }
    inner.position.y -= monkWorldBox().min.y;
    // décale la phase après la mesure, pour des Leaders de taille identique
    // qui ne marchent pas au pas cadencé
    if (grp.userData.gaits) {
      for (const g of grp.userData.gaits) {
        if (g) g.action.time = Math.random() * g.action.getClip().duration;
      }
    }
    body.add(inner);
    attachCartoonOutline(inner, 0.024);
    // Cristal émissif au-dessus de la tête
    crystalRef = new THREE.Mesh(new THREE.OctahedronGeometry(0.11, 0),
      toonMaterial({ color: cult.c, emissive: cult.c, emissiveIntensity: 0.8 }));
    crystalRef.position.set(0, 2.6, 0);
    body.add(crystalRef);
  } else {
    // Fallback : chibi procédural comme avant
    body = new THREE.Group();

  /* Chibi de secours : il n'apparaît que si le .glb n'a pas chargé. Lui garde la
     couleur du culte — il n'a aucune texture d'origine à préserver, et sans
     elle on ne saurait plus qui est qui le temps du chargement. */
  const robeMat = toonMaterial({ color: cult.c, emissive: cult.c, emissiveIntensity: 0.28 });
  const meeple = new THREE.Mesh(meepleGeo, robeMat);
  meeple.castShadow = true;
  body.add(meeple);

  // Grands yeux expressifs
  const eyeMat = toonMaterial({ color: 0xffffff });
  const pupilMat = toonMaterial({ color: 0x1d222b });
  for (const side of [-1, 1]) {
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.075, 8, 6), eyeMat);
    eye.position.set(side * 0.095, 0.8, 0.185);
    body.add(eye);
    const pupil = new THREE.Mesh(new THREE.SphereGeometry(0.034, 6, 5), pupilMat);
    pupil.position.set(side * 0.09, 0.81, 0.245);
    body.add(pupil);
    // Sourcils joyeux (inclinés vers l'extérieur)
    const brow = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.022, 0.02), pupilMat);
    brow.position.set(side * 0.095, 0.9, 0.2);
    brow.rotation.z = side * 0.35;
    body.add(brow);
  }

  // Chapeau pointu de gourou + pompon
  const hatMat = toonMaterial({ color: cult.c });
  const hat = new THREE.Mesh(new THREE.ConeGeometry(0.26, 0.55, 8), hatMat);
  hat.position.set(0, 1.12, -0.02);
  hat.rotation.x = -0.12;
  hat.castShadow = true;
  body.add(hat);
  const brim = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.32, 0.05, 8), hatMat);
  brim.position.set(0, 0.9, -0.02);
  body.add(brim);
  const pompom = new THREE.Mesh(new THREE.SphereGeometry(0.07, 6, 5),
    toonMaterial({ color: 0xffffff, emissive: cult.c, emissiveIntensity: 0.3 }));
  pompom.position.set(0, 1.44, -0.09);
  body.add(pompom);

  // Bâton à cristal
  const staff = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.035, 1.1, 5),
    toonMaterial({ color: 0x5d4037 }));
  staff.position.set(0.34, 0.5, 0.12);
  staff.rotation.z = -0.1;
  staff.castShadow = true;
  body.add(staff);
  crystalRef = new THREE.Mesh(new THREE.OctahedronGeometry(0.11, 0),
    toonMaterial({ color: cult.c, emissive: cult.c, emissiveIntensity: 0.8 }));
  crystalRef.position.set(0.4, 1.1, 0.14);
  body.add(crystalRef);

    body.scale.setScalar(1.9);
    attachCartoonOutline(body, 0.024);
  }

  grp.add(body);

  const ringMat = new THREE.ShaderMaterial({
    uniforms: {
      uColor: { value: new THREE.Color(cult.c) },
      uTime: monkTimeU,
    },
    vertexShader: `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform vec3 uColor;
      uniform float uTime;
      varying vec2 vUv;
      void main() {
        // Conversion en coordonnées polaires pour suivre la courbe du cercle
        vec2 dir = vUv - vec2(0.5);
        float r = length(dir) * 2.0; // Rayon normalisé (~0.8 à 1.0)
        float angle = atan(dir.y, dir.x);
        
        // Normalisation locale du rayon entre 0.0 (interne) et 1.0 (externe)
        float localR = clamp((r - 0.80) / 0.20, 0.0, 1.0);
        
        // Floutage radial pour des bords super lisses
        float radialGlow = sin(localR * 3.14159);
        
        // Bande solide interne (localR < 0.38)
        float isInner = step(localR, 0.38);
        
        // Pointillés externes rotatifs (localR >= 0.38) le long de l'angle
        // 24 segments de tirets autour de la circonférence
        float dash = step(0.1, sin(angle * 24.0 - uTime * 4.0));
        float pattern = mix(dash, 1.0, isInner);
        
        // Pulsation globale
        float pulse = 0.76 + sin(uTime * 4.8) * 0.16;
        
        gl_FragColor = vec4(uColor, radialGlow * pattern * pulse * 0.85);
      }
    `,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide
  });

  const ring = new THREE.Mesh(new THREE.RingGeometry(0.80, 1.0, 64).rotateX(-Math.PI / 2), ringMat);
  ring.position.y = 0.06;
  ring.visible = false; // Désactivé à la demande de l'utilisateur
  grp.add(ring);

  // Bulle 3D du Bouclier Divin
  const shieldGeo = new THREE.SphereGeometry(1.45, 24, 24);
  const shieldMat = new THREE.MeshBasicMaterial({
    color: new THREE.Color(cult.c),
    transparent: true,
    opacity: 0.20,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const shield = new THREE.Mesh(shieldGeo, shieldMat);
  shield.position.y = 1.1; // Centré sur le Leader
  shield.visible = false; // Masqué pour éviter le nuage/halo sous le joueur
  grp.add(shield);

  grp.userData = { body, ring, shield, crystal: crystalRef,
    mixer: grp.userData.mixer || null, gaits: grp.userData.gaits || null };
  scene.add(grp);
  setCharLayer(grp);
  return grp;
}

/* ============================== État du jeu ============================== */
let agents = [];        // { x,z,vx,vz,f, u, ang, base, pop, delay, wt, wx, wz }
let factions = [];      // { i, cult, color, alive, count, leader:{x,z,dx,dz}, grp, isBot, aggr, boostT, target }
let teams = [];         // { id, baseX, baseZ, … } — identité de culte + point d'apparition
let grayCount = 0;
/* Habitations conquérables. buildMap() peut être appelée avant startGame() (menu),
   d'où le tampon pendingHouses qui est adopté par startGame — sinon on garderait
   les maisons du décor de menu et leurs coordonnées incohérentes. */
let houses = [];        // { mesh, slot, x, z, capacity, remaining, siegeCult, progress, alive, baseColor }
let pendingHouses = [];
const HOUSE_BASE = new THREE.Color(1, 1, 1);
const HOUSE_EMPTY = new THREE.Color(0.35, 0.32, 0.3);
const houseColor = new THREE.Color();
let state = 'menu';     // menu | play | over
let paused = false;     // partie suspendue via le bouton pause
let eventFreeze = false; // gel pendant la roulette d'événement
let elapsed = 0, respawnT = 0, hudT = 0, winT = 0;
let conceding = false;   // la dernière IA est en train de se rendre
let lateBellDone = false; // clocher des 30 dernières secondes (une fois / partie)
let netStatsT = 0;        // cadence d'envoi du score au serveur (multi)
let streak = 0, streakT = 0;      // série de conversions en cours
let rallyCd = 0, rallyT = 0;      // Ralliement : recharge et durée restante
let fervor = 0, ecstasyT = 0;     // jauge de Ferveur et durée d'Extase restante
let duelT = -1;                   // duel final : compte à rebours (-1 = inactif)
let judgeR = 999;                 // rayon courant de l'anneau du Jugement
let slowmoT = 0;                  // ralenti dramatique (kill de Leader)
let shrines = [];       // { x, z, owner, cap, progress, incomeT, grp, ring, disc, crystal, beam }
let shocks = [];        // ondes de choc au sol { mesh, t, maxR, dur }
let particles = [];     // particules 3D d'explosion
let activeTotems = [];  // pouvoir Prêche : { grp, life, max, radius, factionIdx, color, tickAcc, tickRate }
let activeShields = []; // pouvoir Sanctuaire : { grp, life, max, radius, factionIdx, x, z, follow }
let activeCurses = [];  // pouvoir Anathème  : { grp, life, max, casterIdx, targetIdx, drainRate }
let territoryIncomeT = 0; // timer du revenu passif de territoire
let stats = { conv: 0, peak: 1, kills: 0, bestStreak: 0 };
let lastRank = 1;
let shake = 0;
const tmpColor = new THREE.Color();
const tmpM = new THREE.Matrix4();
const tmpQ = new THREE.Quaternion();
const tmpS = new THREE.Vector3();
const tmpP = new THREE.Vector3();
const UP_AXIS = new THREE.Vector3(0, 1, 0);

/* ============================== Registre des Leaders ==============================
   Chaque personnage jouable est un .glb riggé avec les MÊMES clips (Walking /
   Running / RunFast) — même squelette humanoïde, seul l'habillage change. On
   ajoute un perso en collant une ligne dans LEADERS + son .glb. */
/* Aucun champ de teinte : les Leaders s'affichent avec leur texture d'origine,
   sans exception. Leur palette est déjà très signée (bronze de l'amazone, coiffe
   du chef, peau grise de l'extraterrestre) et toute recolorisation l'abîmait. */
const LEADERS = {
  monk:     { url: 'assets/models/monk_rigged.glb'     },
  sorcerer: { url: 'assets/models/sorcerer_rigged.glb' },
  nomad:    { url: 'assets/models/nomad_rigged.glb'    },
  amazon:   { url: 'assets/models/amazon_rigged.glb'   },
  alien:    { url: 'assets/models/alien_rigged.glb'    },
  chief:    { url: 'assets/models/chief_rigged.glb'    },
};
/* Chaque Leader a un esprit élémentaire assigné : son cortège prend la
   forme de cet esprit au lieu d'être des copies humanoïdes du Leader. Un esprit
   garde sa couleur d'élément du début à la fin — sauvage comme capturé. C'est
   la seule information qui compte pour alimenter un autel, elle ne doit jamais
   être recouverte par une teinte de culte ni par un halo générique. */
const LEADER_ELEMENT = {
  monk:     'assets/models/elemental_light_rigged.glb',   // lumière — halo, révélation
  sorcerer: 'assets/models/elemental_ether_rigged.glb',   // éther — occulte, void
  nomad:    'assets/models/elemental_earth_rigged.glb',   // terre — voyageur ancré
  amazon:   'assets/models/elemental_rigged.glb',         // feu — guerrière
  alien:    'assets/models/elemental_air_rigged.glb',     // air — flotte, étranger
  chief:    'assets/models/elemental_water_rigged.glb',   // eau — source vitale
};
/* Portrait carré de chaque Leader — lobby, sauvegarde et jauge de course. */
const LEADER_AVATARS = {
  monk: 'assets/monk_avatar.webp',
  sorcerer: 'assets/sorcerer_avatar.webp',
  nomad: 'assets/nomad_avatar.webp',
  amazon: 'assets/amazon_avatar.webp',
  alien: 'assets/alien_avatar.webp',
  chief: 'assets/chief_avatar.webp',
};
/* Élément de chaque Leader, sous forme de clé courte : c'est lui qui donne sa
   couleur et son motif au souffle d'aspiration. */
const LEADER_ELEM_KEY = {
  monk: 'light', sorcerer: 'ether', nomad: 'earth',
  amazon: 'fire', alien: 'air', chief: 'water',
};

const leaderAssets = {};   // key → { model, texture, clips }
const followerMeshes = {}; // leaderKey → { mesh, outline, freeSlots[], color[] }
const FOLLOWER_MESH_CAP = 400;

/* Horloge partagée des shaders de marche (villageois) et des petits mouvements
   secondaires (roulis d'épaules du Leader). */
const monkTimeU = { value: 0 };

/* Le moine est riggé (24 os) : la locomotion est jouée par un AnimationMixer par
   Leader, en fondu enchaîné entre trois clips selon la vitesse au sol. Le repos
   n'a pas de clip dédié : on gèle la marche, ce qui donne une pose neutre. */
const MONK_GAITS = [
  { name: 'Walking', ref: 3.4 },   // vitesse au sol (unités/s) où le clip est joué à 1×
  { name: 'Running', ref: 8.2 },
  { name: 'RunFast', ref: 14.0 },
];
// seuils de vitesse : en dessous → marche, au-dessus du second → sprint (boost)
const MONK_GAIT_SPLITS = [4.5, 11];

/* ---------------------------- Villageois de la foule ----------------------------
   La foule reste instanciée (des centaines d'agents) : pas de squelette par
   villageois. Chaque modèle est aplati en une seule géométrie normalisée (pieds
   au sol, hauteur VILLAGER_H) posée dans un InstancedMesh, et la marche est
   rejouée dans le vertex shader — phase et amplitude par instance via aAnim.
   Les modèles riggés (Meshy) sont figés dans une pose naturelle en bakant une
   frame du clip Walking ; les anciens modèles sans os passent par l'abaissement
   procédural des bras (T-pose). */
const VILLAGER_H = 1.8;
const VILLAGER_POSE_T = 0.25;   // fraction du cycle Walking bakée (pose « passage »)
const VILLAGER_MODELS = [
  // Le paysan garde sa texture d'origine sans aucune teinte de faction.
  // Modèle « Blocky Farmer » (Meshy) optimisé : texture réduite 2048→512 WebP (6,4 Mo → 306 Ko).
  { url: 'assets/models/peasant_blocky.glb' },
  // 2e variante : la paysanne (Meshy). Modèle lourd (13 767 sommets / 26,7 Mo au
  // téléchargement) mais cuit en VAT au chargement → coût runtime = seulement sa
  // texture d'animation, comme les autres.
  { url: 'assets/models/peasant_woman.glb' },
  // Chevalier : garde sa texture d'origine (jamais teinté) et un peu plus grand que les autres.
  // Modèle « Blocky » (Meshy) rigué, texture optimisée 4096→512 WebP (30 Mo → 785 Ko).
  { url: 'assets/models/knight_blocky.glb', scale: 1.18 },
  // Élémentaires : 6 variantes riggées (feu source Meshy + 5 transferts par
  // plus-proche-voisin depuis le squelette du feu). Rétrécis à 0.6× — petit perso.
  // Plus de teinte dorée : c'est la couleur d'origine de chaque élémentaire qui
  // porte l'information, puisque les autels réclament un type précis. Un esprit
  // doit se reconnaître de loin à sa couleur, pas à un halo générique.
  // TODO : optimiser les textures (10–27 Mo → WebP 512 comme les autres villageois).
  { url: 'assets/models/elemental_rigged.glb', scale: 0.6 },        // FIRE
  { url: 'assets/models/elemental_water_rigged.glb', scale: 0.6 },  // WATER
  { url: 'assets/models/elemental_air_rigged.glb', scale: 0.6 },    // AIR
  { url: 'assets/models/elemental_light_rigged.glb', scale: 0.6 },  // LIGHT
  { url: 'assets/models/elemental_earth_rigged.glb', scale: 0.6 },  // EARTH
  { url: 'assets/models/elemental_ether_rigged.glb', scale: 0.6 },  // ETHER
];

// Chapeau : le masque n'est pas fiable par couleur (l'atlas Meshy mêle la paille et la
// peau). On le repère par la hauteur : bande normalisée [lo, hi] du sommet du modèle.
const HAT_BAND = [0.82, 0.90];

/* Masque du vêtement : les atlas sont en aplats, la pièce d'étoffe se reconnaît
   à sa teinte. Le masque isole ces pixels pour que seule l'étoffe prenne la
   couleur du culte — la peau, les cheveux et les bottes restent intacts. */
function garmentMask(tex, h0, h1) {
  if (!tex || !tex.image) return null;
  const img = tex.image;
  const cv = document.createElement('canvas');
  cv.width = img.width; cv.height = img.height;
  const ctx = cv.getContext('2d');
  ctx.drawImage(img, 0, 0);
  const d = ctx.getImageData(0, 0, cv.width, cv.height);
  // Le shader travaille en espace linéaire : la luminance de référence doit y être
  // calculée aussi, sinon la teinte du culte ressort beaucoup trop sombre.
  const toLinear = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  let sum = 0, n = 0;
  for (let i = 0; i < d.data.length; i += 4) {
    const r = d.data[i] / 255, g = d.data[i + 1] / 255, b = d.data[i + 2] / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b), c = max - min;
    const l = (max + min) / 2;
    const sat = c === 0 ? 0 : c / (1 - Math.abs(2 * l - 1));
    let h = 0;
    if (c > 0) {
      if (max === r) h = ((g - b) / c + 6) % 6;
      else if (max === g) h = (b - r) / c + 2;
      else h = (r - g) / c + 4;
      h *= 60;
    }
    // saturation franche : écarte les beiges/crèmes de la chemise, garde l'étoffe.
    // h0 > h1 décrit un intervalle qui enjambe 0° (les rouges du tabard).
    const inHue = h0 <= h1 ? (h >= h0 && h <= h1) : (h >= h0 || h <= h1);
    const on = c > 0.05 && sat > 0.25 && inHue;
    d.data[i] = d.data[i + 1] = d.data[i + 2] = on ? 255 : 0;
    d.data[i + 3] = 255;
    if (on) { sum += 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b); n++; }
  }
  ctx.putImageData(d, 0, 0);
  const m = new THREE.CanvasTexture(cv);
  m.flipY = tex.flipY;
  m.colorSpace = THREE.NoColorSpace;
  // aplats à bords francs : le filtrage nearest évite de teinter la peau en bordure
  m.magFilter = m.minFilter = THREE.NearestFilter;
  m.generateMipmaps = false;
  return { tex: m, lum: n ? sum / n : 0.35 };
}

/* Locomotion des villageois instanciés : deux allures dans le vertex shader,
   mélangées par la vitesse au sol (aAnim.y, en unités/s lissées) — l'équivalent
   sans squelette des gaits Walking/Running du moine. À l'arrêt on fige la pose ;
   la marche donne une foulée calme, la course une cadence plus rapide, une
   enjambée plus ample, un léger rebond et un buste penché en avant. */
const HAT_REF_LUM = 0.5;   // luminance de référence de la paille : garde le tressage sous la teinte
function makeVillagerMaterial(tex, mask, opts = {}) {
  const { tintable = false, hatTint = false, gaitScale = 1 } = opts;
  const useGarment = tintable && !!mask;
  const mat = toonMaterial({ map: tex || null });
  /* IMPORTANT : les trois matériaux villageois ont des paramètres identiques, donc Three.js
     partagerait UN seul programme compilé entre eux et ignorerait nos onBeforeCompile distincts
     (le paysan hériterait du shader d'un autre variant). Une clé de cache par variante force
     une compilation séparée. */
  const variantKey = useGarment ? 'garment' : hatTint ? 'hat' : 'plain';
  mat.customProgramCacheKey = () => 'villager-' + variantKey;
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = monkTimeU;
    // Ralentit/accélère la cadence du pas indépendamment de la vitesse au sol
    // (utile pour les petites créatures dont les jambes battraient sinon trop vite).
    shader.uniforms.uGaitScale = { value: gaitScale };
    if (useGarment) {
      shader.uniforms.uMask = { value: mask.tex };
      shader.uniforms.uGarmentLum = { value: Math.max(0.03, mask.lum) };
    }
    if (hatTint) shader.uniforms.uHatLum = { value: HAT_REF_LUM };
    // --- vertex : locomotion + (paysan) passage de l'attribut chapeau au fragment ---
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>',
        '#include <common>\nuniform float uTime;\nuniform float uGaitScale;\nattribute vec2 aAnim;'
        + (hatTint ? '\nattribute float aHat;\nattribute vec3 aHatCol;\nvarying float vHat;\nvarying vec3 vHatCol;' : ''))
      .replace('#include <begin_vertex>', [
        '#include <begin_vertex>',
        (hatTint ? 'vHat = aHat;\nvHatCol = aHatCol;' : ''),
        'float vSide = position.x > 0.0 ? 1.0 : -1.0;',
        '// aAnim.y = vitesse au sol lissee. Deux seuils : demarrage puis passage a la course.',
        'float vSpeed = aAnim.y;',
        'float vWalk = smoothstep(0.15, 1.2, vSpeed);       // intensite du pas',
        'float vRun  = smoothstep(2.5, 6.5, vSpeed);        // fondu marche -> course',
        '// cadence, enjambee et rebond montent avec la course',
        'float vFreq = mix(8.0, 12.5, vRun) * uGaitScale;',
        'float vSwing = sin(uTime * vFreq + aAnim.x);',
        'float vArmAmp = mix(0.28, 0.46, vRun);',
        'float vLegAmp = mix(0.17, 0.32, vRun);',
        'float vBobAmp = mix(0.03, 0.07, vRun);',
        '// bras : pendule avant/arriere, amplitude croissante vers la main',
        'float vArm = smoothstep(0.15, 0.20, abs(position.x)) * smoothstep(0.66, 0.56, position.y);',
        'transformed.z += vSide * vSwing * vWalk * vArmAmp * vArm * clamp(0.64 - position.y, 0.0, 0.43);',
        '// jambes : pas alterne (oppose au bras du meme cote)',
        'float vLeg = smoothstep(0.26, 0.02, position.y);',
        'transformed.z += -vSide * vSwing * vWalk * vLegAmp * vLeg;',
        '// leger sursaut du bas du corps pendant le pas',
        'transformed.y += abs(vSwing) * vWalk * vBobAmp * vLeg;',
        '// course : buste penche vers l\'avant (le modele regarde le +z local)',
        'transformed.z += vRun * vWalk * smoothstep(0.2, 1.0, position.y) * 0.06;',
      ].join('\n'));
    // --- fragment : où appliquer la couleur d'instance ---
    if (useGarment) {
      // damoiselle/chevalier : la couleur du culte ne teinte que l'etoffe (masque UV).
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform sampler2D uMask;\nuniform float uGarmentLum;')
        .replace('#include <color_fragment>', [
          '#if defined( USE_INSTANCING_COLOR ) && defined( USE_MAP )',
          '  float vGarment = texture2D( uMask, vMapUv ).r;',
          '  float vLum = dot( diffuseColor.rgb, vec3( 0.2126, 0.7152, 0.0722 ) );',
          '  // plancher : on garde les plis de l\'etoffe sans laisser la couleur du culte s\'assombrir',
          '  vec3 vTint = vColor * clamp( vLum / uGarmentLum, 0.55, 1.5 );',
          '  diffuseColor.rgb = mix( diffuseColor.rgb, vTint, vGarment );',
          '#else',
          '  #include <color_fragment>',
          '#endif',
        ].join('\n'));
    } else if (hatTint) {
      // paysan : la couleur du culte ne teinte QUE le chapeau (aHat), le corps reste intact.
      // On remplace le multiply d'instance par defaut (qui teinterait tout le paysan).
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform float uHatLum;\nvarying float vHat;\nvarying vec3 vHatCol;')
        .replace('#include <color_fragment>', [
          // La couleur d'instance (vColor) est BLANCHE pour le paysan → le color_fragment
          // par défaut laisse le corps intact. Le chapeau prend aHatCol (vHatCol).
          '  #include <color_fragment>',
          '  float vLum = dot( diffuseColor.rgb, vec3( 0.2126, 0.7152, 0.0722 ) );',
          '  vec3 vHatTint = vHatCol * clamp( vLum / uHatLum, 0.55, 1.6 );   // garde le tressage de la paille',
          '  diffuseColor.rgb = mix( diffuseColor.rgb, vHatTint, vHat );',
        ].join('\n'));
    }
    patchToonOutline(shader);
  };
  return mat;
}

/* Les deux .glb sont livrés en T-pose (le moine, lui, a sa pose bras baissés bakée
   dans le fichier). Faute d'os, on fait pivoter les sommets du bras autour de
   l'épaule — le fondu près de l'épaule évite de déchirer le maillage. */
const ARM_BLEND = 0.06;  // largeur du fondu à l'épaule
const ARM_DROP = 1.36;   // ~78°, bras le long du corps
const ARM_BAND = 0.22;   // hauteur occupée au-delà de laquelle on est encore dans le corps

/* Repère l'épaule plutôt que de la coder en dur : les trois modèles n'ont pas la
   même carrure (le chevalier a des spallières bien plus larges). On balaie |x| par
   tranches — le corps occupe toute la hauteur, le bras tendu se confine à une bande
   étroite ; l'épaule est la première tranche où la hauteur occupée s'effondre.
   Renvoie null si rien ne ressemble à une T-pose : le maillage est laissé tel quel. */
function findShoulder(geo) {
  const p = geo.attributes.position;
  const BIN = 0.025;
  const bins = [];
  for (let i = 0; i < p.count; i++) {
    const b = Math.floor(Math.abs(p.getX(i)) / BIN);
    const y = p.getY(i);
    const e = bins[b] || (bins[b] = { min: Infinity, max: -Infinity });
    if (y < e.min) e.min = y;
    if (y > e.max) e.max = y;
  }
  for (let b = 1; b < bins.length; b++) {
    const e = bins[b];
    if (e && e.max - e.min < ARM_BAND) return { x: b * BIN, y: (e.min + e.max) / 2 };
  }
  return null;
}

function lowerArms(geo, shoulder) {
  const pos = geo.attributes.position, nrm = geo.attributes.normal;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i);
    const t = THREE.MathUtils.smoothstep(Math.abs(x), shoulder.x, shoulder.x + ARM_BLEND);
    if (t <= 0) continue;
    const side = x > 0 ? 1 : -1;
    const a = -side * ARM_DROP * t;
    const cs = Math.cos(a), sn = Math.sin(a);
    // rotation autour de l'axe Z, pivot à l'épaule du côté concerné
    const px = x - side * shoulder.x, py = y - shoulder.y;
    pos.setXY(i, side * shoulder.x + px * cs - py * sn, shoulder.y + px * sn + py * cs);
    if (nrm) {
      const nx = nrm.getX(i), ny = nrm.getY(i);
      nrm.setXY(i, nx * cs - ny * sn, nx * sn + ny * cs);
    }
  }
  pos.needsUpdate = true;
  if (nrm) nrm.needsUpdate = true;
}

/* Fige un modèle riggé dans la pose d'une frame du clip Walking : le squelette
   est posé par un mixer jetable puis chaque sommet est lu via getVertexPosition
   (position skinnée). Renvoie null si le glTF n'a ni os ni animation. */
function bakeSkinnedPose(gltf) {
  let skinned = null;
  gltf.scene.traverse((c) => { if (c.isSkinnedMesh) skinned = c; });
  if (!skinned || !gltf.animations || !gltf.animations.length) return null;
  const clip = THREE.AnimationClip.findByName(gltf.animations, 'Walking') || gltf.animations[0];
  const mixer = new THREE.AnimationMixer(gltf.scene);
  const action = mixer.clipAction(clip);
  action.play();
  action.time = VILLAGER_POSE_T * clip.duration;
  mixer.update(0);
  gltf.scene.updateMatrixWorld(true);
  if (skinned.skeleton) skinned.skeleton.update();
  const src = skinned.geometry;
  const pos = new THREE.BufferAttribute(new Float32Array(src.attributes.position.count * 3), 3);
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    skinned.getVertexPosition(i, v);       // pose skinnée (espace local du mesh)
    v.applyMatrix4(skinned.matrixWorld);
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', pos);
  if (src.attributes.uv) geo.setAttribute('uv', src.attributes.uv.clone());
  if (src.index) geo.setIndex(src.index.clone());
  geo.computeVertexNormals();
  return geo;
}

/* Marque les sommets du chapeau (partie haute du modèle) : aHat ∈ [0,1], lissé sur la
   bande de hauteur HAT_BAND. Le fragment shader ne teinte que là. Suppose la géométrie
   déjà normalisée (pieds à y = 0, sommet ≈ VILLAGER_H). */
function tagHatVertices(geo) {
  geo.computeBoundingBox();
  const top = geo.boundingBox.max.y || VILLAGER_H;
  const pos = geo.attributes.position;
  const hat = new Float32Array(pos.count);
  for (let i = 0; i < pos.count; i++) {
    const ny = pos.getY(i) / top;   // hauteur normalisée 0..1
    hat[i] = THREE.MathUtils.smoothstep(ny, HAT_BAND[0], HAT_BAND[1]);
  }
  geo.setAttribute('aHat', new THREE.BufferAttribute(hat, 1));
}

function setupVillager(mesh, gltf, opts = {}) {
  const { hue, tintable = false, hatTint = false, scale = 1, gaitScale = 1, wildHalo = false, golden = false } = opts;

  let tex = null;
  gltf.scene.traverse((child) => {
    if (child.isMesh && child.material && child.material.map) tex = child.material.map;
  });

  const vat = bakeVAT(gltf, { scale, targetHeight: VILLAGER_H });
  if (vat) {
    vat.geometry.setAttribute('aAnim', mesh.userData.anim);
    mesh.geometry = vat.geometry;
    mesh.material = makeVATMaterial(tex, vat, monkTimeU, mesh.uuid, { wildHalo, golden });

    // Contour cartoon synchronisé — sauté sur tactile (×2 draw calls foule).
    if (!isCoarse) {
      const outlineMat = makeVATOutlineMaterial(vat, monkTimeU, mesh.uuid, 0.028);
      const outline = new THREE.InstancedMesh(vat.geometry, outlineMat, mesh.userData.slots);
      outline.instanceMatrix = mesh.instanceMatrix;
      outline.count = mesh.count;
      outline.frustumCulled = false;
      outline.userData.isOutline = true;
      outline.matrixAutoUpdate = false;
      outline.renderOrder = 2; // après la peinture (renderOrder 1), avant le HUD
      if (mesh.parent) mesh.parent.add(outline);
      else mesh.add(outline);
      mesh.userData.outlineMesh = outline;
      setCharLayer(outline);
    }
    setCharLayer(mesh);

    console.log('[VAT]', gltf.scene.name || '', 'verts:', vat.vCount, 'frames:', vat.framesPer * vat.clipCount);
    return;
  }
  console.warn('[VAT] échec (pas de squelette/clip) — repli pose figée :', gltf.scene.name);

  // modèle riggé : pose bakée depuis Walking ; sinon aplatissement classique
  const baked = bakeSkinnedPose(gltf);
  let geo = baked;
  if (!geo) {
    const geos = [];
    gltf.scene.updateWorldMatrix(true, true);
    gltf.scene.traverse((child) => {
      if (!child.isMesh) return;
      const g = child.geometry.clone();
      // les attributs de skinning sont inutiles ici (le maillage n'a pas d'os)
      for (const k of Object.keys(g.attributes)) {
        if (k !== 'position' && k !== 'normal' && k !== 'uv') g.deleteAttribute(k);
      }
      g.applyMatrix4(child.matrixWorld);
      geos.push(g);
    });
    if (!geos.length) return;
    geo = geos.length > 1 ? mergeGeometries(geos) : geos[0];
  }
  // normalise : centré en X/Z, pieds à y = 0, hauteur VILLAGER_H
  geo.computeBoundingBox();
  const s = VILLAGER_H / Math.max(0.001, geo.boundingBox.max.y - geo.boundingBox.min.y);
  geo.scale(s, s, s);
  /* scale() recalcule la bounding box en place : la relire donne déjà les valeurs
     mises à l'échelle, il ne faut donc surtout pas les remultiplier par s. */
  geo.computeBoundingBox();
  const bb = geo.boundingBox;
  geo.translate(-(bb.min.x + bb.max.x) * 0.5, -bb.min.y, -(bb.min.z + bb.max.z) * 0.5);
  // la pose bakée a déjà les bras baissés ; la T-pose passe par l'abaissement procédural
  if (!baked) {
    const shoulder = findShoulder(geo);
    if (shoulder) lowerArms(geo, shoulder);
  }
  // grossissement optionnel (ex. chevalier) : appliqué après la mise en pose, autour de
  // l'origine — les pieds restent à y = 0, le modèle grandit vers le haut et en largeur.
  if (scale !== 1) geo.scale(scale, scale, scale);
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  geo.setAttribute('aAnim', mesh.userData.anim);
  // paysan : marque le chapeau (aHat) et branche la couleur d'instance dédiée (aHatCol)
  if (hatTint) {
    tagHatVertices(geo);
    if (mesh.userData.hatCol) geo.setAttribute('aHatCol', mesh.userData.hatCol);
  }
  mesh.geometry = geo;
  // étoffe teintée par le culte (damoiselle/chevalier) ; le paysan n'a pas de masque
  const mask = tintable ? garmentMask(tex, hue[0], hue[1]) : null;
  console.log('[villager]', gltf.scene.name || hue, 'baked:', !!baked, 'tex:', !!tex, tex && tex.image && (tex.image.width + 'x' + tex.image.height), 'tintable:', tintable, 'hatTint:', hatTint, 'mask lum:', mask && mask.lum);
  mesh.material = makeVillagerMaterial(tex, mask, { tintable, hatTint, gaitScale });
  // crowds sont déjà dans la scène → outline en sibling
  const out = attachCartoonOutline(mesh, 0.028);
  if (out) out.renderOrder = 2;
}



function mobileDownscaleTextures(gltf, maxSize = 512) {
  if (!_isMobile) return;
  gltf.scene.traverse((child) => {
    if (!child.isMesh || !child.material) return;
    const mat = child.material;
    const tex = mat.map;
    if (!tex || !tex.image || tex.image.width <= maxSize) return;
    const img = tex.image;
    const ratio = maxSize / Math.max(img.width, img.height);
    const w = Math.round(img.width * ratio);
    const h = Math.round(img.height * ratio);
    const cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    const ctx = cv.getContext('2d');
    ctx.drawImage(img, 0, 0, w, h);
    tex.image = cv;
    tex.needsUpdate = true;
  });
}

/* Chargement séquentiel : la cuisson VAT est lourde (CPU + VRAM) — en parallèle
   elle sature la mémoire des mobiles et fait échouer les modèles suivants. */
{
  let queue = VILLAGER_MODELS.map((v, i) => ({ v, i }));
  function loadNext() {
    if (!queue.length) return;
    const { v, i } = queue.shift();
    gltfLoader.load(v.url, (gltf) => {
      mobileDownscaleTextures(gltf);
      try { setupVillager(crowds[i], gltf, { ...v, variant: i }); }
      catch (e) { console.error('[villager] setup failed', v.url, e); }
      loadNext();
    }, undefined, (err) => {
      console.warn('[villager] failed to load', v.url, err);
      loadNext();
    });
  }
  loadNext();
}

/* Cristal-bombe de peinture : le modèle est normalisé (≈1,7 u de haut, pieds
   au sol) puis cloné à chaque apparition. */
let bombModel = null;
gltfLoader.load('assets/models/paint_crystal.glb', (gltf) => {
  const g = gltf.scene;
  const box = new THREE.Box3().setFromObject(g);
  const h = Math.max(0.001, box.max.y - box.min.y);
  g.scale.setScalar(1.7 / h);
  box.setFromObject(g);
  g.position.y = -box.min.y;
  const wrap = new THREE.Group();
  wrap.add(g);
  attachCartoonOutline(g, 0.028);
  bombModel = wrap;
});

/* Le modèle de Sanctuaire de Base n'est plus chargé : les cours de départ
   ont disparu et il n'avait plus aucun point de pose. Le .glb reste dans
   public/assets/models/ — il ferait un bon corps de sanctuaire maintenant
   qu'ils ont l'emprise d'une cour. */

/* --------------------------- Attaques à distance ---------------------------
   L'aspiration a été remplacée : voir src/sim/attacks.js pour la boucle
   « tirer → la cible tombe → on la ramasse ». Ne subsiste ici que
   l'orientation du Leader, dont la visée assistée a besoin. */

/** Orientation visuelle du Leader — celle que le joueur voit, donc celle sur
    laquelle il vise. Repli sur le vecteur vitesse si le corps n'est pas prêt. */
function leaderFace(f) {
  const body = f.grp && f.grp.userData && f.grp.userData.body;
  if (body) return body.rotation.y;
  return Math.atan2(f.leader.dx || 0, f.leader.dz || 1);
}

/* ---- Rendu des projectiles ----
   Une bille émissive par tir, prise dans un petit bassin réutilisé : les tirs
   sont brefs et nombreux, allouer une géométrie à chaque fois ferait tousser
   le ramasse-miettes en pleine action. La teinte est celle de l'élément du
   Leader — six attaques distinctes sans un seul asset à produire. */
/* Le projectile est une ORBE, pas une bille : un sprite de corps peint au
   canvas (voir orb-texture.js) doublé d'un halo additif derrière lui. Deux
   quads par tir, et le sprite fait face à la caméra tout seul — inutile de
   modéliser une sphère qu'on ne verra jamais que de face.

   Le corps tourne lentement sur lui-même : sans cette rotation, les rubans
   peints figent l'orbe et on voit un autocollant. */
const ORB_KEYS = ['fire', 'water', 'air', 'light', 'earth', 'ether'];
const _orbTex = new Map();       // élément → texture du corps
let _glowTex = null;

function orbTexture(key) {
  let t = _orbTex.get(key);
  if (!t) {
    t = new THREE.CanvasTexture(drawOrb(key));
    t.colorSpace = THREE.SRGBColorSpace;
    t.generateMipmaps = false;
    t.minFilter = THREE.LinearFilter;
    _orbTex.set(key, t);
  }
  return t;
}
function glowTexture() {
  if (!_glowTex) {
    _glowTex = new THREE.CanvasTexture(drawGlow());
    _glowTex.generateMipmaps = false;
    _glowTex.minFilter = THREE.LinearFilter;
  }
  return _glowTex;
}

const _boltPool = [];
const _boltLive = new Map();     // projectile → { grp, body, glow, spin }

function elementKeyOf(f) { return LEADER_ELEM_KEY[f?.leaderKey] || 'ether'; }
function elementColorOf(f) {
  const e = ELEMENTS.find((x) => x.key === elementKeyOf(f)) || ELEMENTS[5];
  return e.col;
}

function acquireBolt(p) {
  let b = _boltPool.pop();
  if (!b) {
    const grp = new THREE.Group();
    const glow = new THREE.Sprite(new THREE.SpriteMaterial({
      map: glowTexture(), transparent: true, depthWrite: false,
      blending: THREE.AdditiveBlending, toneMapped: false,
    }));
    glow.scale.setScalar(3.1);
    const body = new THREE.Sprite(new THREE.SpriteMaterial({
      transparent: true, depthWrite: false, toneMapped: false,
    }));
    body.scale.setScalar(1.5);
    grp.add(glow, body);
    b = { grp, body, glow, spin: 0 };
  }
  const key = elementKeyOf(factions[p.from]);
  b.body.material.map = orbTexture(key);
  b.body.material.needsUpdate = true;
  b.glow.material.color.set(elementColorOf(factions[p.from]));
  b.spin = Math.random() * Math.PI * 2;
  b.grp.position.set(p.x, p.y, p.z);
  b.grp.visible = true;
  scene.add(b.grp);
  _boltLive.set(p, b);
}

function releaseBolt(p) {
  const b = _boltLive.get(p);
  if (!b) return;
  scene.remove(b.grp);
  b.grp.visible = false;
  _boltPool.push(b);
  _boltLive.delete(p);
}

/* ---- Effets de capture ----
   Trois moments à rendre lisibles, dans l'ordre où le joueur les vit :
     · le DÉPART du tir (recul + gerbe au canon),
     · l'IMPACT sur l'esprit (flash blanc + éclats + choc au sol),
     · le RAMASSAGE (trait lumineux qui se résorbe vers le Leader).
   Le milieu — l'esprit à terre — reste volontairement calme : c'est le temps
   mort pendant lequel on court, et le surcharger noierait les deux autres. */

/** Distance au Leader du joueur : sert à doser volume et secousse. Les effets
    des bots doivent exister sans saturer l'écran quand cinq cultes tirent. */
function distToPlayer(x, z) {
  const me = factions[0];
  if (!me || !me.leader) return Infinity;
  return Math.hypot(x - me.leader.x, z - me.leader.z);
}

/** Éclats brefs. Chaque particule a SON matériau : le pool `updateParticles`
    dispose le matériau de la première étincelle éteinte, et un matériau partagé
    emporterait toutes les autres du même jet avec lui. */
function spawnSparks(x, y, z, colorObj, n, opts = {}) {
  const { spread = 5.5, lift = 3.2, dirX = 0, dirZ = 0, push = 0, size = 0.5 } = opts;
  const count = isCoarse ? Math.ceil(n * 0.5) : n;
  for (let i = 0; i < count; i++) {
    const mesh = new THREE.Mesh(
      SHARED_PARTICLE_GEO,
      new THREE.MeshBasicMaterial({ color: colorObj, toneMapped: false }),
    );
    const sc = size * (0.7 + Math.random() * 0.6);
    mesh.scale.setScalar(sc);
    mesh.position.set(x, y, z);
    scene.add(mesh);
    const a = Math.random() * Math.PI * 2;
    const sp = spread * (0.35 + Math.random() * 0.65);
    particles.push({
      mesh,
      vx: Math.cos(a) * sp + dirX * push,
      vy: lift * (0.4 + Math.random() * 0.8),
      vz: Math.sin(a) * sp + dirZ * push,
      scale: sc, isTrail: true, factionIdx: -1,
    });
  }
}

/* -- Flash d'impact --
   L'esprit touché vire au blanc puis retombe sur sa teinte dorée. C'est le seul
   retour qui dise « celui-là est à terre » à l'instant où ça se produit ; sans
   lui, un tir réussi et un tir manqué se ressemblent. */
const HIT_FLASH_T = 0.34;
const _hitFlashes = [];
const _flashCol = new THREE.Color();

function spawnHitFlash(a) {
  if (!a._hitFlash) _hitFlashes.push(a);
  a._hitFlash = HIT_FLASH_T;
}

/* -- Trait de ramassage --
   Le plan est couché dans le sol (rotateX) : son étendue en Z devient la
   longueur du trait, son X sa largeur. */
const LINK_GEO = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
const LINK_DUR = 0.3;
const _links = [];

function spawnCaptureLink(x, z, f) {
  const mesh = new THREE.Mesh(LINK_GEO, new THREE.MeshBasicMaterial({
    color: f.color, transparent: true, opacity: 0.8, depthWrite: false,
    blending: THREE.AdditiveBlending, toneMapped: false, side: THREE.DoubleSide,
  }));
  mesh.renderOrder = 5;
  scene.add(mesh);
  _links.push({ mesh, x0: x, z0: z, f, t: 0 });
}

function updateCaptureFx(dt) {
  for (let i = _links.length - 1; i >= 0; i--) {
    const l = _links[i];
    l.t += dt;
    const k = l.t / LINK_DUR;
    if (k >= 1 || !l.f.alive) {
      scene.remove(l.mesh); l.mesh.material.dispose();
      _links.splice(i, 1);
      continue;
    }
    /* La queue du trait glisse vers le Leader : l'esprit a l'air d'être aspiré,
       et non relié par une corde qui s'efface sur place. */
    const L = l.f.leader;
    const sx = l.x0 + (L.x - l.x0) * k, sz = l.z0 + (L.z - l.z0) * k;
    const dx = L.x - sx, dz = L.z - sz;
    const len = Math.hypot(dx, dz);
    l.mesh.position.set((sx + L.x) * 0.5, (L.y || 0) + 0.95, (sz + L.z) * 0.5);
    l.mesh.rotation.y = Math.atan2(dx, dz);
    l.mesh.scale.set(0.05 + 0.3 * (1 - k), 1, Math.max(0.01, len));
    l.mesh.material.opacity = 0.85 * (1 - k * k);
  }

  for (let i = _hitFlashes.length - 1; i >= 0; i--) {
    const a = _hitFlashes[i];
    a._hitFlash -= dt;
    /* Un esprit ramassé pendant son flash passe sous le contrôle du cortège :
       continuer à le peindre en blanc écraserait la couleur du culte. */
    const gone = a.dead || (a.followerOf ?? -1) >= 0 || a._followerSlot != null;
    if (a._hitFlash <= 0 || gone) {
      a._hitFlash = 0;
      if (!gone) setAgentColor(a.id, GRAY);
      _hitFlashes.splice(i, 1);
      continue;
    }
    /* Surexposition, pas changement de teinte : l'esprit est rendu SANS teinte
       (sa texture porte sa couleur d'élément, qu'on ne doit jamais masquer). Un
       flash coloré le déguiserait en un autre type le temps de l'impact — on se
       contente donc de le suréclairer, la teinte d'instance étant un facteur. */
    const k = a._hitFlash / HIT_FLASH_T;
    const b = 1 + 1.6 * k;
    _flashCol.setRGB(b, b, b);
    setAgentColor(a.id, _flashCol);
  }
}

/** Vide les effets de capture entre deux parties. */
function clearCaptureFx() {
  for (const l of _links) { scene.remove(l.mesh); l.mesh.material.dispose(); }
  _links.length = 0;
  for (const a of _hitFlashes) a._hitFlash = 0;
  _hitFlashes.length = 0;
}

/* Contexte de la simulation d'attaque : recréé une seule fois, ses champs
   pointent sur les valeurs vivantes. */
const _atkCtx = {
  agents: null, factions: null,
  /* ELEM_FIRST et finishConvert sont déclarés plus bas dans le fichier : les
     lire ici, à l'évaluation du littéral, lèverait une ReferenceError de zone
     morte. On les branche au premier tick. */
  variantOf, ELEM_FIRST: 0,
  groundY,
  finishConvert: null,
  releaseFollower: (a) => {
    releaseFollowerSlot(a);
    const prev = factions[a.followerOf];
    if (prev) prev.count = Math.max(0, (prev.count || 0) - 1);
    a.followerOf = -1;
    /* Taille : un suivant est rétréci à FOLLOWER_SCALE par convertToFollower.
       Sans cette restauration, l'esprit arraché d'un cortège redevenait sauvage
       en gardant 55 % de sa taille — d'où les esprits de plus en plus petits
       en cours de partie. */
    if (a._origBase) a.base = a._origBase;
    setAgentColor(a.id, GRAY);
  },
  cancelDive: (a) => { a.base = a._diveBase || a.base; a._dive = null; a._diveMoved = false; },
  dropOneFollower: (o) => {
    for (const a of agents) {
      if (!a || a.dead || (a.followerOf ?? -1) !== o.i) continue;
      _atkCtx.releaseFollower(a);
      return a;
    }
    return null;
  },
  onFire: (f, p) => {
    /* Départ du coup : le Leader se cabre et une gerbe part dans l'axe. Sans
       ce contrecoup, l'orbe semblait naître à un mètre devant lui — le geste
       n'avait pas d'auteur. Le recul est purement visuel : il ne déplace pas
       le Leader, donc il ne peut pas gêner la course qui suit le tir. */
    f._recoil = 0.26;
    const col = new THREE.Color(elementColorOf(f));
    spawnSparks(
      f.leader.x + p.dx * 0.8, (f.leader.y || 0) + 1.15, f.leader.z + p.dz * 0.8,
      col, 7, { spread: 1.6, lift: 1.4, dirX: p.dx, dirZ: p.dz, push: 6.5, size: 0.34 },
    );
    if (f.i === 0) shake = Math.max(shake, 0.1);

    /* Les tirs adverses s'entendent, mais seulement de près et en retrait :
       cinq bots qui tirent au même volume que le joueur transformeraient la
       partie en vacarme, et on ne saurait plus quel coup est le sien. */
    if (f.i === 0) {
      soundEngine.playSFXGroup('fire', { volume: 0.55 });
      return;
    }
    const d = distToPlayer(f.leader.x, f.leader.z);
    if (d > 30) return;
    soundEngine.playSFXGroup('fire', { volume: 0.28 * (1 - d / 30) });
  },
  onImpact: (p) => {
    releaseBolt(p);
    spawnShock(p.x, p.z, new THREE.Color(elementColorOf(factions[p.from])), 1.6, 0.22);
  },
  onSpiritDown: (a, by) => {
    /* Le moment qui compte : c'est ici que le joueur apprend qu'il a touché.
       Flash sur la cible, éclats aux couleurs du tireur, choc au sol — trois
       lectures redondantes, parce qu'une seule se perd dans une mêlée. */
    spawnHitFlash(a);
    const col = by ? new THREE.Color(elementColorOf(by)) : WHITE;
    spawnSparks(a.x, (a.y || 0) + 0.7, a.z, col, 12, { spread: 4.6, lift: 3.4 });
    spawnShock(a.x, a.z, col, 2.4, 0.3);

    const d = distToPlayer(a.x, a.z);
    if (by && by.i === 0) shake = Math.max(shake, 0.2);
    if (d < 34) {
      soundEngine.playSFXGroup('earth', {
        volume: (by && by.i === 0 ? 0.6 : 0.3) * (1 - d / 34),
        rate: 1.25,
      });
    }
  },
  onCollect: (a, f) => {
    /* Ramassage : l'esprit était converti sur place, sans transition — on
       voyait une disparition, pas une prise. Le trait qui se résorbe vers le
       Leader donne la direction du gain, et dit à qui il profite. */
    spawnCaptureLink(a.x, a.z, f);
    spawnSparks(a.x, (a.y || 0) + 0.6, a.z, f.color, 8, { spread: 2.4, lift: 2.6, size: 0.4 });
    if (f.i === 0) shake = Math.max(shake, 0.16);
  },
  onLeaderDown: (o, by) => {
    spawnShock(o.leader.x, o.leader.z, o.color, 3.4, 0.4);
    if (o.i === 0) banner('✖ Vous êtes à terre — un esprit vous échappe !');
    else if (by && by.i === 0) banner('✦ Rival mis à terre !');
  },
};

function bindAtkCtx() {
  _atkCtx.agents = agents;
  _atkCtx.factions = factions;
  _atkCtx.ELEM_FIRST = ELEM_FIRST;
  _atkCtx.finishConvert = finishConvert;
}

/* ---- Marqueur de cible ----
   La visée étant assistée mais faillible, le joueur doit savoir SUR QUOI le
   prochain tir va partir. Sans ce repère, un coup manqué ressemble à un bug
   plutôt qu'à un raté : on croit avoir visé autre chose. L'anneau annonce
   l'intention du tir, jamais son résultat — on peut le voir et rater quand
   même, et c'est exactement ce qu'on veut donner à lire. */
const targetRing = new THREE.Mesh(
  new THREE.RingGeometry(0.95, 1.22, 28).rotateX(-Math.PI / 2),
  new THREE.MeshBasicMaterial({
    color: 0xffffff, transparent: true, opacity: 0.85,
    depthWrite: false, depthTest: false, toneMapped: false, side: THREE.DoubleSide,
  }),
);
targetRing.renderOrder = 6;
targetRing.visible = false;
scene.add(targetRing);

function updateTargetRing() {
  const me = factions[0];
  if (!me || !me.alive || state !== 'play' || (me.downT || 0) > 0) {
    targetRing.visible = false;
    return;
  }
  const t = pickTarget(me, leaderFace(me), _atkCtx);
  if (!t) { targetRing.visible = false; return; }

  const o = t.kind === 'leader' ? t.ref.leader : t.ref;
  targetRing.visible = true;
  targetRing.position.set(o.x, (o.y || 0) + 0.09, o.z);
  /* Battement : un anneau figé se confond avec les disques de sanctuaire. */
  const puls = 1 + Math.sin(elapsed * 7) * 0.06;
  targetRing.scale.setScalar((t.kind === 'leader' ? 1.35 : 1) * puls);
  targetRing.material.color.set(t.kind === 'leader' ? 0xff5a4a : elementColorOf(me));
}

function updateAttacks(dt) {
  bindAtkCtx();
  updateTargetRing();
  tickDownStates(factions, agents, dt);
  botAttacks(dt);
  stepProjectiles(dt, _atkCtx);
  collectDowned(factions, agents, _atkCtx);
  updateCaptureFx(dt);

  /* Les sprites suivent leur projectile ; ceux qui viennent de naître prennent
     une orbe au passage. */
  for (const p of projectiles) {
    let bolt = _boltLive.get(p);
    if (!bolt) { acquireBolt(p); bolt = _boltLive.get(p); bolt.trailT = 0; }
    bolt.grp.position.set(p.x, p.y, p.z);
    /* Rotation du corps et respiration du halo : deux mouvements de vitesses
       différentes, sinon l'ensemble se lit comme une seule image qui tourne. */
    bolt.spin += dt * 2.4;
    bolt.body.material.rotation = bolt.spin;
    bolt.glow.scale.setScalar(3.1 + Math.sin(bolt.spin * 3.1) * 0.22);

    /* Traînée : à 30 u/s, l'orbe traverse l'écran en un souffle et on ne lit
       pas d'où elle vient. Les braises restent une fraction de seconde et
       dessinent la trajectoire APRÈS coup — c'est ce qui rend un tir manqué
       compréhensible. Cadence fixe (et non par image) : le rendu ne doit pas
       dépendre du framerate. */
    bolt.trailT = (bolt.trailT || 0) + dt;
    const step = isCoarse ? 0.05 : 0.025;
    if (bolt.trailT >= step) {
      bolt.trailT = 0;
      spawnSparks(p.x, p.y, p.z, new THREE.Color(elementColorOf(factions[p.from])),
        1, { spread: 0.5, lift: 0.35, size: 0.3 });
    }
  }
}

/** Tir du joueur. Retourne true si le coup est parti (bouton à animer). */
function playerAttack() {
  const f = factions[0];
  if (!f || !f.alive || state !== 'play') return false;
  bindAtkCtx();
  return !!fireAttack(f, leaderFace(f), _atkCtx);
}

/* ---- Les bots tirent aussi ----
   Sans ça l'attaque serait un privilège du joueur et les bots ne ramasseraient
   plus rien : ils chassent des esprits qui fuient plus vite qu'eux. Ils tirent
   dès qu'une cible entre dans leur cône, avec un délai de réaction qui dépend
   de la difficulté — jamais une meilleure portée ni une meilleure cadence. */
const BOT_AIM_DELAY = { easy: 0.75, normal: 0.35, hard: 0.12 };
/* Multiplicateur de dispersion : c'est là que se joue l'écart de niveau, pas
   sur la portée ni la cadence. Un bot facile vise mal, il ne tire pas moins
   loin — les règles restent les mêmes pour tout le monde. */
const BOT_SPREAD = { easy: 2.4, normal: 1.35, hard: 0.85 };

function botAttacks(dt) {
  for (const f of factions) {
    if (!f || !f.alive || f.i === 0 || !f.isBot) continue;
    if ((f.downT || 0) > 0) { f._aimT = 0; continue; }
    if ((f.atkCd || 0) > 0) continue;

    const target = pickTarget(f, leaderFace(f), _atkCtx);
    if (!target) { f._aimT = 0; continue; }

    /* Temps de réaction : un bot qui tire à la frame où la cible entre dans le
       cône est injouable, il ne raterait jamais rien. */
    const delay = BOT_AIM_DELAY[f.aiDifficulty || currentDifficulty] ?? 0.35;
    f._aimT = (f._aimT || 0) + dt;
    if (f._aimT < delay) continue;
    f._aimT = 0;
    _atkCtx.spreadMult = BOT_SPREAD[f.aiDifficulty || currentDifficulty] ?? 1.35;
    fireAttack(f, leaderFace(f), _atkCtx);
    _atkCtx.spreadMult = 1;
  }
}

/* ------------------- Plongeon souterrain des esprits acculés -------------------
   Un esprit ne se laisse jamais prendre à la course : il sprinte dès qu'on
   l'approche. Mais on peut l'acculer — contre le vide, dans un cul-de-sac, ou
   au boost. Plutôt que de le laisser coincé sans issue (frustrant des deux
   côtés), il saute, plonge dans un trou et ressort ailleurs sur la carte.

   « Acculé » se mesure au FAIT, pas à l'intention : un Leader tout près ET un
   esprit qui n'arrive plus à s'éloigner. Un test de distance seul se
   déclencherait pendant une poursuite normale. */
const DIVE_NEAR_R = 3.2;      // distance de Leader qui met la pression
const DIVE_STUCK_T = 0.5;     // durée sans échappatoire avant de plonger
const DIVE_GAIN = 0.35;       // terrain repris par seconde en dessous duquel
                              // on considère qu'il ne s'en sort pas
const DIVE_UP = 0.30;         // temps de saut
const DIVE_DOWN = 0.26;       // temps de plongée
const DIVE_OUT = 0.34;        // temps de résurgence
const DIVE_TOTAL = DIVE_UP + DIVE_DOWN + DIVE_OUT;

/* ---- Terriers : un vrai monticule qui sort du sol ----
   C'était un disque noir posé à plat : lisible, mais on voyait une maquette et
   non un trou. Le .glb de terrier ne peut pas servir — même sa variante
   allégée pèse 57 000 triangles, inclonable à chaque plongeon.

   On en fabrique donc un au tour : un profil tourné autour de l'axe vertical
   donne le bourrelet de terre et le puits sombre en ~130 triangles. Le
   monticule ÉMERGE du sol au lieu d'apparaître, ce qui est tout ce qui
   manquait pour que le geste se lise.

   Le profil va du fond du puits vers l'extérieur :
     centre bas → paroi du puits → lèvre relevée → crête → retour au sol. */
let _holeGeo = null;
const HOLE_R = 1.35;          // rayon extérieur du monticule
const HOLE_RISE = 0.55;       // hauteur dont il sort de terre en émergeant

function makeBurrowGeo() {
  const P = (r, y) => new THREE.Vector2(r, y);
  const profile = [
    P(0.00, -0.62),           // fond du puits, dans le noir
    P(0.30, -0.55),
    P(0.44, -0.20),           // paroi
    P(0.50,  0.06),           // lèvre du trou, légèrement relevée
    P(0.74,  0.30),           // crête du bourrelet
    P(1.00,  0.05),           // retombée
    P(1.00, -0.10),           // jupe qui s'enfonce, évite tout jour au sol
  ];
  const geo = new THREE.LatheGeometry(profile, 16);
  geo.scale(HOLE_R, 1, HOLE_R);

  /* Couleur par sommet : noir au fond, terre sur la crête. Multipliée ensuite
     par la teinte de la tuile, le monticule appartient donc à son sol. */
  const pos = geo.attributes.position;
  const col = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    const k = Math.max(0, Math.min(1, (y + 0.62) / 0.92));   // 0 = fond, 1 = crête
    const shade = 0.06 + Math.pow(k, 1.6) * 1.04;
    col[i * 3] = shade; col[i * 3 + 1] = shade * 0.96; col[i * 3 + 2] = shade * 0.9;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.computeVertexNormals();
  return geo;
}

const holes = [], holePool = [];
function spawnHole(x, z) {
  if (!_holeGeo) _holeGeo = makeBurrowGeo();
  let m = holePool.pop();
  if (!m) {
    /* DoubleSide : vu de dessus, on regarde DANS le puits, donc ses parois
       présentent leur dos à la caméra. Sans ça le trou serait éliminé par le
       culling et on verrait le décor au travers. */
    m = new THREE.Mesh(_holeGeo, toonMaterial({
      color: 0xffffff, vertexColors: true, side: THREE.DoubleSide,
    }));
    m.castShadow = false;
    m.receiveShadow = true;
    scene.add(m);
  }
  /* Teinte du sol sous le trou : la terre remuée est celle de cette tuile. */
  const tile = island ? tileAt(island, x, z) : null;
  if (tile && tile.tint) m.material.color.copy(tile.tint).multiplyScalar(1.15);
  else m.material.color.setHex(0xb08a5e);

  m.visible = true;
  m.userData.baseY = groundY(x, z);
  m.position.set(x, m.userData.baseY - HOLE_RISE, z);   // encore sous terre
  m.scale.set(1, 1, 1);
  m.rotation.y = Math.random() * Math.PI * 2;
  holes.push({ mesh: m, t: 0 });
}

function updateHoles(dt) {
  for (let i = holes.length - 1; i >= 0; i--) {
    const h = holes[i];
    h.t += dt;
    const m = h.mesh;
    const baseY = m.userData.baseY || 0;

    /* Émergence en 0,20 s — plus court que DIVE_UP (0,30 s), donc le trou est
       ouvert quand l'esprit retombe dedans. Puis il se retire lentement. */
    const up = Math.min(1, h.t / 0.20);
    const ease = up * up * (3 - 2 * up);
    const sink = Math.max(0, (h.t - 1.0) / 0.5);
    const back = Math.min(1, sink) ** 2;
    m.position.y = baseY - HOLE_RISE * (1 - ease) - HOLE_RISE * back;
    const s = 0.55 + 0.45 * ease;
    m.scale.set(s, s, s);

    if (h.t > 1.5) {
      m.visible = false;
      holePool.push(m);
      holes.splice(i, 1);
    }
  }
}

function startDive(a) {
  a._dive = 0;
  a._diveBase = a.base;
  a.vx = 0; a.vz = 0;
  a._corner = 0;
  a._diveD = null;   // la mesure de gain repart de zéro à la résurgence
  spawnHole(a.x, a.z);
}

function updateSpiritDives(dt) {
  updateHoles(dt);

  for (const a of agents) {
    if (!a || a.dead) continue;
    if (variantOf(a.id) < 3) continue;            // seuls les esprits plongent

    /* ---- Plongeon en cours ---- */
    if (a._dive != null) {
      a._dive += dt;
      const t = a._dive;
      a.vx = 0; a.vz = 0;
      if (t < DIVE_UP) {
        /* Sursaut : il bondit sur place avant de piquer. */
        a.y = Math.sin((t / DIVE_UP) * Math.PI) * 1.35;
      } else if (t < DIVE_UP + DIVE_DOWN) {
        const u = (t - DIVE_UP) / DIVE_DOWN;
        a.y = -1.6 * u * u;                        // pique vers le sol
        a.base = a._diveBase * Math.max(0, 1 - u); // avalé par le trou
      } else if (t < DIVE_TOTAL) {
        const u = (t - DIVE_UP - DIVE_DOWN) / DIVE_OUT;
        if (!a._diveMoved) {
          /* Résurgence : loin de tout Leader, sinon il ressort dans les bras
             de celui qui vient de l'acculer. */
          a._diveMoved = true;
          let pt = null;
          for (let tries = 0; tries < 12; tries++) {
            const p = islandRandomPoint(island, 4, Infinity);
            if (!p) break;
            const pz = p.z ?? p.y;
            let far = true;
            for (const f of factions) {
              if (!f || !f.alive || !f.leader) continue;
              if (Math.hypot(p.x - f.leader.x, pz - f.leader.z) < 18) { far = false; break; }
            }
            pt = { x: p.x, z: pz };
            if (far) break;
          }
          if (pt) { a.x = pt.x; a.z = pt.z; }
          spawnHole(a.x, a.z);
        }
        a.y = -1.6 * (1 - u) ** 2;
        a.base = a._diveBase * u;
      } else {
        a.y = 0;
        a.base = a._diveBase;
        a._dive = null;
        a._diveMoved = false;
        a._webFree = elapsed + 1.0;   // pas de toile dans la seconde qui suit
      }
      continue;
    }

    /* ---- Détection de l'esprit acculé ---- */
    if (a._web || (a.followerOf ?? -1) >= 0) { a._corner = 0; continue; }

    let nearD = 1e9;
    for (const f of factions) {
      if (!f || !f.alive || !f.leader) continue;
      const d = Math.hypot(a.x - f.leader.x, a.z - f.leader.z);
      if (d < nearD) nearD = d;
    }
    /* « Acculé » = un Leader colle et l'esprit n'arrive pas à REPRENDRE du
       terrain. Tester sa vitesse ne marchait pas : coincé contre un rebord de
       tuile, il glisse le long du bord à pleine allure sans jamais s'éloigner.
       On mesure donc le gain de distance, pas le déplacement. */
    const gain = a._diveD != null ? (nearD - a._diveD) / Math.max(1e-4, dt) : 0;
    a._diveD = nearD;
    if (nearD < DIVE_NEAR_R && gain < DIVE_GAIN) {
      a._corner = (a._corner || 0) + dt;
      if (a._corner >= DIVE_STUCK_T) startDive(a);
    } else {
      a._corner = 0;
    }
  }
}

/** Vide les toiles entre deux parties. */
/** Remet à zéro tout ce qui traîne entre deux parties : trous, plongeons en
    cours et souffles d'aspiration. */
function clearWebs() {
  for (const h of holes) { h.mesh.visible = false; holePool.push(h.mesh); }
  holes.length = 0;
  for (const a of agents) if (a && a._dive != null) { a.base = a._diveBase; a._dive = null; a._diveMoved = false; }
  for (const p of [...projectiles]) releaseBolt(p);
  clearProjectiles();
  clearCaptureFx();
  for (const f of factions) if (f) f._recoil = 0;
  /* Les états « à terre » ne doivent pas survivre à une partie : un Leader
     figé au coup d'envoi serait injouable. */
  for (const f of factions) { if (f) { f.downT = 0; f.atkCd = 0; f._aimT = 0; } }
  for (const a of agents) if (a) a.downT = 0;
}


/* Modèle 3D du Trou de Terrier (Burrow Hole GLB) */
let burrowHoleModel = null;
gltfLoader.load('assets/models/burrow_hole.glb', (gltf) => {
  mobileDownscaleTextures(gltf);
  const g = gltf.scene;
  const box = new THREE.Box3().setFromObject(g);
  const h = Math.max(0.001, box.max.y - box.min.y);
  g.scale.setScalar(2.6 / h);
  box.setFromObject(g);
  g.position.y = -box.min.y;
  g.traverse((c) => {
    if (c.isMesh) {
      c.castShadow = true;
      c.receiveShadow = true;
    }
  });
  const wrap = new THREE.Group();
  wrap.add(g);
  attachCartoonOutline(g, 0.02);
  burrowHoleModel = wrap;
}, undefined, (err) => {
  console.warn('[burrow_hole] Load warning:', err);
});

/* --- Événements d'animation des trous de terrier pour les esprits volés --- */
const activeBurrowEvents = [];

function makeProceduralHoleMesh() {
  const g = new THREE.Group();
  const holeMat = new THREE.MeshBasicMaterial({ color: 0x0a0502, side: THREE.DoubleSide });
  const holeGeo = new THREE.CylinderGeometry(1.5, 1.1, 0.45, 24);
  const m = new THREE.Mesh(holeGeo, holeMat);
  m.position.y = 0.22;
  g.add(m);

  const rimGeo = new THREE.RingGeometry(1.1, 1.55, 32).rotateX(-Math.PI / 2);
  const rimMat = new THREE.MeshBasicMaterial({ color: 0xfbbf24, transparent: true, opacity: 0.95, side: THREE.DoubleSide });
  const rim = new THREE.Mesh(rimGeo, rimMat);
  rim.position.y = 0.46;
  g.add(rim);
  return g;
}

function triggerBurrowRespawn(leader) {
  // Choisir un point valide sur l'île dans un rayon modéré autour du leader pour être bien visible
  let pt = null;
  if (leader) {
    for (let attempts = 0; attempts < 20; attempts++) {
      const ang = Math.random() * Math.PI * 2;
      const dist = 7 + Math.random() * 11;
      const px = leader.x + Math.cos(ang) * dist;
      const pz = leader.z + Math.sin(ang) * dist;
      if (onIsland(px, pz)) { pt = { x: px, z: pz }; break; }
    }
  }
  if (!pt) pt = islandRandomPoint(island, 4, Infinity);
  if (!pt) return;

  const holeMesh = burrowHoleModel ? burrowHoleModel.clone(true) : makeProceduralHoleMesh();
  holeMesh.position.set(pt.x, -1.2, pt.z || pt.y);
  scene.add(holeMesh);

  // Onde dorée éclatante pour signaler l'apparition du trou au joueur
  spawnShock(pt.x, pt.z || pt.y, GOLDEN_SPIRIT_COLOR, 4.0, 1.6);

  activeBurrowEvents.push({
    x: pt.x,
    z: pt.z || pt.y,
    t: 0,
    mesh: holeMesh,
    spawnedSpirit: false,
    agentId: null
  });
}

function stealSpiritFromLeader(f) {
  if (!f) return false;
  const fol = agents.find(a => !a.dead && a.followerOf === f.i);
  if (fol) {
    releaseFollowerSlot(fol);
    fol.dead = true;
    fol.followerOf = -1;
    hideAgent(fol.id);
    freeAgentIds.push(fol.id);
  }
  f.count = Math.max(0, (f.count || 0) - 1);

  if (f.i === 0) {
    soundEngine.playSFX?.('boost');
    banner('⚡ Un villageois vous a volé un esprit !');
  }
  triggerBurrowRespawn(f.leader);
  return true;
}

/* ============================== Sanctuaires ==============================
   Des autels neutres, un par site, disséminés sur la vallée. Chacun réclame un
   nombre d'esprits d'un ÉLÉMENT précis. On les alimente en amenant son cortège
   au pied de l'autel ; une fois comblé, un grand gardien de cet élément s'y
   dresse et le sanctuaire peint sa région en continu à la couleur de son culte.

   Un sanctuaire actif affiche alors le coût de sa rupture : le même nombre
   d'esprits, mais de l'élément OPPOSÉ. Les livrer brise le gardien, le
   remplace par un gardien de l'élément apporté, et fait changer le sanctuaire
   de main. Le territoire ne s'obtient donc plus en marchant mais en tenant des
   points fixes — et aucun n'est définitivement acquis.

   Les six élémentaires sont les variantes 3 à 8 de la foule (voir
   VILLAGER_MODELS) : le type d'un esprit capturé est simplement sa variante. */
const ELEM_FIRST = 3;
/* `img` : portrait détouré de l'élémentaire, servi au HUD comme aux autels.
   Un dessin du personnage lui-même se reconnaît instantanément — bien mieux
   qu'un pictogramme générique de flamme ou de rocher, qui obligeait à traduire
   mentalement « symbole → type d'esprit à chasser ». */
const ELEMENTS = [
  { v: 3, key: 'fire',  nom: 'Feu',     css: '#ff6a2a', col: 0xff6a2a, sym: '🔥', img: 'assets/spirits/fire.webp' },
  { v: 4, key: 'water', nom: 'Eau',     css: '#3fb6ff', col: 0x3fb6ff, sym: '💧', img: 'assets/spirits/water.webp' },
  { v: 5, key: 'air',   nom: 'Air',     css: '#cfe9ff', col: 0xcfe9ff, sym: '🌪', img: 'assets/spirits/air.webp' },
  { v: 6, key: 'light', nom: 'Lumière', css: '#ffd94a', col: 0xffd94a, sym: '☀', img: 'assets/spirits/light.webp' },
  { v: 7, key: 'earth', nom: 'Terre',   css: '#7fc25a', col: 0x7fc25a, sym: '⛰', img: 'assets/spirits/earth.webp' },
  { v: 8, key: 'ether', nom: 'Éther',   css: '#b06bff', col: 0xb06bff, sym: '✦', img: 'assets/spirits/ether.webp' },
];

/* Les vignettes servent aussi de texture aux étiquettes d'autel, dessinées sur
   canvas : on les précharge une fois pour toutes. */
const elemImages = {};
for (const e of ELEMENTS) {
  const im = new Image();
  im.onload = () => { elemImages[e.v] = im; };
  im.src = e.img;
}
/* Trois paires franches : ce sont elles qui rendent la rupture lisible. */
const ELEM_OPPOSITE = { 3: 4, 4: 3, 5: 7, 7: 5, 6: 8, 8: 6 };
const elemOf = (v) => ELEMENTS[v - ELEM_FIRST];

const ALTAR_COUNT = 10;      // assez pour couvrir la vallée, assez peu pour se croiser
/* ---- Coût d'un sanctuaire : croissant ----
   Un coût fixe et élevé rendait chaque autel binaire — soit on rassemblait dix
   esprits du bon type, soit on renonçait. Aucun rebondissement possible.

   Ici le premier éveil ne coûte QU'UN esprit : la carte s'allume vite et la
   partie démarre sur les chapeaux de roue. Mais chaque conquête renchérit la
   suivante d'une unité. Un autel âprement disputé devient donc une forteresse,
   pendant qu'un autel oublié reste à portée du premier venu — la carte garde la
   mémoire de ce qui s'y est joué, et le prix d'une reprise se lit sur place. */
const ALTAR_NEED_START = 1;
const ALTAR_NEED_STEP = 1;
/* Les sanctuaires reprennent l'emprise des anciennes cours de départ
   (BASE_WALL_R) : ce sont désormais les seuls lieux forts de la vallée, ils
   doivent se voir et s'occuper comme des places, pas comme des bornes. */
const ALTAR_R = BASE_WALL_R;   // rayon de livraison — l'emprise d'une cour
const ALTAR_H = 5.6;           // hauteur du sanctuaire une fois mis à l'échelle
/* L'écart minimal doit rester supérieur à deux emprises, sinon deux places se
   chevauchent et on livre aux deux à la fois. Au-delà de ~22 l'île ne peut
   plus en accueillir dix (mesuré sur 200 cartes). */
/* Depuis que l'assise doit être pleine, les places éligibles sont deux fois
   moins nombreuses : à 22 l'île n'en accueillait plus que 8,5 sur 10. À 18 il
   reste 3,6 u entre deux emprises — elles ne se chevauchent pas, donc on ne
   livre jamais à deux sanctuaires à la fois. */
const ALTAR_MIN_GAP = ALTAR_R * 2 + 3.6;
/* Temps de présence avant que la livraison ne parte. La livraison étant tout ou
   rien (voir feedAltar), ce n'est plus une cadence mais un court temps de pose :
   de quoi voir le sanctuaire réagir avant qu'il ne bascule, et de quoi frôler
   son emprise sans déclencher une prise qu'on ne voulait pas. */
const ALTAR_DELIVER_DELAY = 0.28;
const ALTAR_PAINT_PERIOD = 0.22;
const ALTAR_PAINT_R = 13;    // portée finale de la peinture d'un sanctuaire
const ALTAR_GROW_T = 45;     // temps pour atteindre cette portée

const altars = [];

/* ---- Construction visuelle ----
   Socle procédural plutôt que le .glb de sanctuaire : celui-ci pèse 74 k
   triangles, soit 740 k pour dix autels. Un piédestal cel-shadé coûte mille
   fois moins et se lit mieux à petite taille. */
/* Le modèle de sanctuaire du jeu, décimé à ~8 k triangles : à dix exemplaires,
   la version lo/ (74 k) en coûterait 741 k. Chargé une fois, cloné ensuite. */
let altarModel = null;
/* Corps des sanctuaires : le modèle des anciennes cours de départ. Il est
   taillé pour l'emprise que les sanctuaires ont désormais — l'ancien petit
   autel, étiré à ALTAR_H, paraissait fondu et hors d'échelle. */
gltfLoader.load('assets/models/sanctuary_base.glb', (gltf) => {
  mobileDownscaleTextures(gltf);
  const g = gltf.scene;
  g.traverse((c) => {
    if (!c.isMesh) return;
    c.castShadow = true;
    c.material = toonMaterial({ map: c.material && c.material.map });
  });
  const box = new THREE.Box3().setFromObject(g);
  const h = Math.max(0.001, box.max.y - box.min.y);
  g.scale.multiplyScalar(ALTAR_H / h);
  g.updateMatrixWorld(true);
  const box2 = new THREE.Box3().setFromObject(g);
  g.position.y -= box2.min.y;
  const wrap = new THREE.Group();
  wrap.add(g);
  attachCartoonOutline(g, 0.02);
  altarModel = wrap;
  /* Les autels déjà posés (partie en cours) échangent leur socle de repli. */
  for (const a of altars) swapAltarBody(a);
}, undefined, (err) => console.warn('[autel] chargement échoué', err));

/** Remplace le socle provisoire d'un autel par le vrai modèle, une fois chargé. */
function swapAltarBody(a) {
  if (!altarModel || !a || a.grp.userData.hasModel) return;
  const old = a.grp.userData.body;
  if (old) a.grp.remove(old);
  const body = altarModel.clone(true);
  a.grp.add(body);
  a.grp.userData.body = body;
  a.grp.userData.hasModel = true;
}

function makeAltarMesh() {
  const g = new THREE.Group();

  /* Socle de repli : sert seulement tant que le .glb n'est pas arrivé. */
  const body = altarModel ? altarModel.clone(true) : makeFallbackPedestal();
  g.add(body);

  /* Anneau flottant teinté de l'élément demandé : c'est lui qui porte
     l'information de loin, avant même que le compteur soit lisible. */
  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(0.9, 0.11, 8, 20).rotateX(Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false }),
  );
  ring.position.y = ALTAR_H + 0.55;
  g.add(ring);

  /* Disque au sol : marque la zone de livraison. */
  const pad = new THREE.Mesh(
    new THREE.CircleGeometry(ALTAR_R, 28).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({
      color: 0xffffff, transparent: true, opacity: 0.14,
      depthWrite: false, toneMapped: false,
    }),
  );
  pad.position.y = 0.06;
  pad.renderOrder = 2;
  g.add(pad);

  g.userData = { ring, pad, body, hasModel: !!altarModel };
  return g;
}

function makeFallbackPedestal() {
  const grp = new THREE.Group();
  const base = new THREE.Mesh(
    new THREE.CylinderGeometry(1.5, 1.85, 0.45, 12),
    toonMaterial({ color: 0x8e93a8 }),
  );
  base.position.y = 0.22;
  grp.add(base);
  const col = new THREE.Mesh(
    new THREE.CylinderGeometry(0.55, 0.75, 1.15, 10),
    toonMaterial({ color: 0xb9bfd4 }),
  );
  col.position.y = 1.02;
  grp.add(col);
  return grp;
}

/* Étiquette : « 10 ✦ » sur un panneau, redessinée seulement quand le compte
   change — un canvas par frame et par autel coûterait bien trop cher. */
function makeAltarLabel() {
  const cv = document.createElement('canvas');
  cv.width = 256; cv.height = 128;
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  const spr = new THREE.Sprite(new THREE.SpriteMaterial({
    map: tex, transparent: true, depthWrite: false, depthTest: false, toneMapped: false,
  }));
  spr.scale.set(3.4, 1.7, 1);
  spr.renderOrder = 10;
  spr.userData = { cv, tex, sig: '' };
  return spr;
}

/* L'étiquette montre l'ESPRIT demandé puis sa quantité — pas un pictogramme
   d'élément. Le joueur compare directement ce qu'il voit sur l'autel à ce qu'il
   voit dans sa barre de cortège, sans traduction mentale. */
function drawAltarLabel(spr, variant, reste, css, sub) {
  const { cv, tex } = spr.userData;
  const g = cv.getContext('2d');
  g.clearRect(0, 0, cv.width, cv.height);

  const w = cv.width - 14, h = 84, x = 7, y = 6, r = 24;
  g.fillStyle = 'rgba(8, 12, 26, 0.84)';
  g.strokeStyle = css;
  g.lineWidth = 5;
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
  g.fill();
  g.stroke();

  /* Portrait à gauche, chiffre à droite. Si l'image n'est pas encore chargée on
     retombe sur le symbole : l'autel reste lisible dès la première frame. */
  const im = elemImages[variant];
  const pad = 10, ph = h - pad * 2;
  if (im) {
    g.drawImage(im, x + pad, y + pad, ph, ph);
  } else {
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.font = 'bold 52px system-ui, sans-serif';
    g.fillText(elemOf(variant).sym, x + pad + ph / 2, y + h / 2);
  }

  g.textAlign = 'left';
  g.textBaseline = 'middle';
  g.fillStyle = css;
  g.font = 'bold 54px Cinzel, Georgia, serif';
  g.fillText('×' + reste, x + pad + ph + 8, y + h / 2 + 2);

  if (sub) {
    g.textAlign = 'center';
    g.font = 'bold 21px Cinzel, Georgia, serif';
    g.fillStyle = 'rgba(230, 240, 255, 0.92)';
    g.fillText(sub, cv.width / 2, y + h + 18);
  }
  tex.needsUpdate = true;
}

/* Statue du maître des lieux : le Leader qui contrôle le sanctuaire, taillé
   dans la pierre et bien plus grand que nature. Elle remplace l'ancien gardien
   élémentaire — la question qu'un joueur se pose de loin est « à qui est ce
   sanctuaire ? », pas « quel élément le garde ? » (l'anneau et l'étiquette le
   disent déjà). */
const STATUE_H = 5.2;                 // hauteur visée, socle non compris
const STONE_COL = 0x9fa4ac;           // gris pierre
const STONE_DARK = 0x7c818a;

function makeOwnerStatue(f) {
  const g = new THREE.Group();

  /* Socle : la statue doit se lire comme un monument, pas comme un Leader
     géant posé là. */
  const plinth = new THREE.Mesh(
    new THREE.CylinderGeometry(1.35, 1.6, 0.7, 12),
    toonMaterial({ color: STONE_DARK }),
  );
  plinth.position.y = 0.35;
  plinth.castShadow = true;
  g.add(plinth);

  const asset = leaderAssets[(f && f.leaderKey) || 'monk'] || leaderAssets.monk;

  if (asset && asset.model) {
    const inner = SkeletonUtils.clone(asset.model);
    inner.traverse((c) => {
      if (!c.isMesh && !c.isSkinnedMesh) return;
      /* Pierre pleine : ni texture ni émissif, sinon on retombe sur un
         personnage colorié plutôt que sur une sculpture. */
      c.material = toonMaterial({ color: STONE_COL });
      c.castShadow = true;
      c.frustumCulled = false;
    });

    /* Pose figée : on applique la première frame d'une démarche puis on jette
       le mixer. Sans ça le modèle reste en pose de bind (bras en croix). */
    let skinned = null;
    inner.traverse((c) => { if (c.isSkinnedMesh) skinned = c; });
    if (asset.clips && asset.clips.length) {
      const clip = THREE.AnimationClip.findByName(asset.clips, MONK_GAITS[0].name)
        || asset.clips[0];
      if (clip) {
        const mixer = new THREE.AnimationMixer(inner);
        const action = mixer.clipAction(clip);
        action.play();
        mixer.update(0);
      }
    }

    /* Mise à l'échelle sur la pose rendue (le squelette Meshy est en
       centimètres : mesurer la géométrie brute donnerait un facteur ~100 faux). */
    const worldBox = () => {
      inner.updateMatrixWorld(true);
      if (!skinned) return new THREE.Box3().setFromObject(inner);
      if (skinned.skeleton) skinned.skeleton.update();
      skinned.computeBoundingBox();
      return skinned.boundingBox.clone().applyMatrix4(skinned.matrixWorld);
    };
    for (let it = 0; it < 2; it++) {
      const bb = worldBox();
      inner.scale.multiplyScalar(STATUE_H / Math.max(0.001, bb.max.y - bb.min.y));
    }
    inner.position.y -= worldBox().min.y;
    inner.position.y += 0.7;                       // pieds sur le socle
    g.add(inner);
    attachCartoonOutline(inner, 0.024);
  } else {
    /* Repli tant que le .glb n'est pas chargé : un monolithe de pierre. */
    const m = new THREE.Mesh(
      new THREE.CylinderGeometry(0.75, 1.0, STATUE_H, 8),
      toonMaterial({ color: STONE_COL }),
    );
    m.position.y = 0.7 + STATUE_H / 2;
    m.castShadow = true;
    g.add(m);
  }

  return g;
}

/* ---- Cycle de vie ---- */
function clearAltars() {
  /* Les levées en cours pointent sur des statues qu'on retire : les laisser
     tourner ferait piloter des objets sortis de la scène. */
  _statueRises.length = 0;
  for (const a of altars) {
    scene.remove(a.grp);
    if (a.label) scene.remove(a.label);
    if (a.statue) scene.remove(a.statue);
  }
  altars.length = 0;
}

/* ---- Réservation des places de sanctuaire ----
   Appelée par buildMap, donc AVANT que le décor du biome ne soit semé. C'est
   tout l'intérêt : aucun `kind` de ROLE_FOR n'accepte ROLE.SANCTUARY, si bien
   que marquer ces tuiles suffit à interdire herbes, arbres, rochers et maisons
   sur l'emprise d'un sanctuaire. Les placer après le décor, comme avant, les
   faisait pousser au milieu de la place.

   On marque aussi les six voisins : l'emprise (ALTAR_R) déborde largement de
   la tuile centrale, et une touffe plantée à sa lisière ressort au milieu du
   dallage. */
function reserveAltarSites() {
  if (!island) return;
  island.altarSites = [];
  /* Liste calculée UNE fois : chaque tirage refiltrait l'île entière, ce qui
     interdisait d'échantillonner largement. Les places étant devenues rares
     (assise plate ET pleine), il faut chercher plus, pas moins. */
  const pool = flatTiles(island, 7, Infinity);
  const SAMPLES = 90;
  const taken = new Set();

  for (let n = 0; n < ALTAR_COUNT; n++) {
    let best = null, bestD = -1;
    for (let k = 0; k < SAMPLES; k++) {
      const t = pool[(Math.random() * pool.length) | 0];
      if (!t || taken.has(t)) continue;
      let d = Infinity;
      for (const a of island.altarSites) d = Math.min(d, Math.hypot(a.x - t.x, a.z - t.z));
      if (d > bestD) { bestD = d; best = t; }
    }
    if (!best) break;
    /* Saturation : quand elle arrive, elle est franche — relâcher l'écart par
       paliers a été essayé et ne plaçait pas un seul sanctuaire de plus sur
       300 cartes. Les places restantes sont alors toutes collées aux autres. */
    if (island.altarSites.length && bestD < ALTAR_MIN_GAP) break;
    /* Centré sur la tuile, et non tiré au hasard dedans : l'emprise tombe
       ainsi au milieu de la zone plate au lieu d'en mordre le bord. */
    taken.add(best);
    reserveSanctuary(island, best);
    island.altarSites.push({ x: best.x, z: best.z, tile: best });
  }
}

/** Sème les autels sur les places réservées par buildMap. */
function placeAltars() {
  clearAltars();
  /* On mélange les six éléments et on les distribue à tour de rôle : deux
     autels voisins du même type rendraient une région entière monochrome. */
  const bag = [];
  for (let k = 0; k < Math.ceil(ALTAR_COUNT / 6) + 1; k++) {
    const shuffled = ELEMENTS.map((e) => e.v);
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = (Math.random() * (i + 1)) | 0;
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    bag.push(...shuffled);
  }

  /* Les places ont été choisies et vidées de leur décor par buildMap. On se
     contente de les habiller ici — c'est aussi ce qui garantit que le décor
     et les sanctuaires s'accordent, puisqu'ils lisent la même liste. */
  const sites = (island && island.altarSites) || [];
  for (let n = 0; n < sites.length; n++) spawnAltar(sites[n].x, sites[n].z, bag[n]);

  /* Filet : une île minuscule peut ne rien offrir de conforme. Mieux vaut des
     sanctuaires serrés que pas de partie du tout. */
  for (let k = altars.length; k < 4; k++) {
    const p = islandRandomPoint(island, 6, Infinity);
    if (p) spawnAltar(p.x, p.z ?? p.y, bag[k]);
  }
}

function spawnAltar(x, z, variant) {
  const y = groundY(x, z);
  const grp = makeAltarMesh();
  grp.position.set(x, y, z);
  scene.add(grp);
  const label = makeAltarLabel();
  label.position.set(x, y + ALTAR_H + 2.0, z);
  scene.add(label);

  altars.push({
    x, z, y,
    variant,             // élément réclamé actuellement
    need: ALTAR_NEED_START,
    filled: 0,
    owner: -1,           // -1 = dormant
    grp, label,
    statue: null,        // statue de pierre du Leader qui contrôle le lieu
    feedAcc: 0,
    paintAcc: 0,
    age: 0,
    activeT: 0,
  });
  refreshAltarVisual(altars[altars.length - 1]);
}

function refreshAltarVisual(a) {
  const e = elemOf(a.variant);
  a.grp.userData.ring.material.color.setHex(e.col);
  const owner = a.owner >= 0 ? factions[a.owner] : null;
  a.grp.userData.pad.material.color.set(owner ? owner.css : e.css);
  a.grp.userData.pad.material.opacity = owner ? 0.22 : 0.14;

  /* La signature inclut la présence de l'image : l'étiquette doit se redessiner
     une fois la vignette chargée, sinon elle garde son symbole de repli. */
  const sig = `${a.variant}:${a.filled}:${a.owner}:${elemImages[a.variant] ? 1 : 0}`;
  if (a.label.userData.sig === sig) return;
  a.label.userData.sig = sig;
  drawAltarLabel(
    a.label,
    a.variant,
    Math.max(0, a.need - a.filled),
    e.css,
    a.owner >= 0 ? `briser · ${e.nom}` : e.nom,
  );
}

/**
 * Livraison à un sanctuaire — TOUT OU RIEN.
 *
 * On ne consomme un seul esprit que si le cortège en porte assez pour couvrir
 * la demande entière. Auparavant l'autel avalait les esprits au fil du passage :
 * un culte qui n'en avait pas assez les perdait quand même et repartait les
 * mains vides, sans rien avoir pris. Pire, un rival n'avait plus qu'à finir le
 * travail sur un autel à moitié rempli aux frais du premier.
 *
 * Le gain n'est pas seulement d'équité : passer devant un sanctuaire cesse
 * d'être dangereux. On peut traverser la vallée en portant sa cargaison sans
 * craindre de la voir grignotée en chemin, ce qui rend le trajet jouable.
 */
function feedAltar(a, dt) {
  /* Qui peut livrer MAINTENANT : présent dans l'emprise ET porteur du compte
     exact. On cherche d'abord, on agit ensuite — sans ça le temps de pose
     s'accumulerait pendant qu'un culte trop léger campe sur place, et la
     livraison partirait dès qu'il complète son cortège, sans temps de pose. */
  let deliverer = null, held = null;
  for (const f of factions) {
    if (!f || !f.alive || !f.leader) continue;
    if (f.i === a.owner) continue;           // on ne brise pas son propre autel
    if (Math.hypot(f.leader.x - a.x, f.leader.z - a.z) > ALTAR_R) continue;

    const mine = [];
    for (const s of agents) {
      if (!s || s.dead) continue;
      if ((s.followerOf ?? -1) !== f.i) continue;
      if (variantOf(s.id) !== a.variant) continue;
      mine.push(s);
      if (mine.length >= a.need) break;
    }
    if (mine.length < a.need) continue;      // pas de quoi : on ne touche à rien
    deliverer = f; held = mine;
    break;                                   // un seul culte livre par frame
  }

  if (!deliverer) { a.feedAcc = 0; return; }

  a.feedAcc += dt;
  if (a.feedAcc < ALTAR_DELIVER_DELAY) return;
  a.feedAcc = 0;

  for (const s of held) {
    consumeFollower(s, deliverer);
    a.filled++;
  }
  spawnShock(a.x, a.z, elemOf(a.variant).col, 3.2, 0.4);
  if (deliverer.i === 0) soundEngine.playSFX('convert', { volume: 0.6 });
  activateAltar(a, deliverer);
  refreshAltarVisual(a);
}

/** Retire un suivant du cortège : il est absorbé par l'autel. */
function consumeFollower(s, f) {
  releaseFollowerSlot(s);
  s.dead = true;
  s.followerOf = -1;
  hideAgent(s.id);
  freeAgentIds.push(s.id);
  f.count = Math.max(0, (f.count || 0) - 1);
}

/* ---- Levée de la statue ----
   La statue sort du sol pendant que gronde la pierre. On la fait monter depuis
   une position enterrée en la faisant trembler, puis le tremblement s'apaise sur
   la fin : la secousse doit MOURIR avant que le mouvement ne s'arrête, sinon on
   voit une statue posée qui vibre encore, ce qui ressemble à un bug d'affichage.

   Le plan de coupe (`clippingPlanes`) évite de voir la statue traverser le
   dallage par en dessous : tout ce qui est sous le niveau du sanctuaire est
   simplement découpé, donc elle émerge vraiment du sol au lieu de le percer. */
const _statueRises = [];   // { a, t, dur, y0, plane }

function beginStatueRise(a, dur) {
  const y = a.y || 0;
  /* Hauteur enterrée : plus que la statue elle-même n'est haute, sinon un bout
     dépasse déjà au premier tick. */
  const drop = STATUE_H + 1.2;
  const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -y + 0.02);
  a.statue.traverse((c) => {
    if (c.isMesh || c.isSkinnedMesh) {
      c.material = c.material.clone();
      c.material.clippingPlanes = [plane];
      c.material.clipShadows = true;
    }
  });
  a.statue.position.y = y - drop;
  /* Une seule levée par sanctuaire : une reprise éclair pendant l'animation
     précédente laisserait deux entrées à piloter la même statue. */
  for (let i = _statueRises.length - 1; i >= 0; i--) {
    if (_statueRises[i].a === a) _statueRises.splice(i, 1);
  }
  _statueRises.push({ a, t: 0, dur, y0: y, drop, plane });
}

function updateStatueRises(dt) {
  for (let i = _statueRises.length - 1; i >= 0; i--) {
    const r = _statueRises[i];
    if (!r.a.statue) { _statueRises.splice(i, 1); continue; }
    r.t += dt;
    const u = Math.min(1, r.t / r.dur);
    /* Montée qui décélère : la pierre est lourde, elle s'arrache d'un coup puis
       se pose. */
    const ease = 1 - (1 - u) * (1 - u) * (1 - u);
    const y = r.y0 - r.drop * (1 - ease);
    /* Tremblement amorti : fort au départ, éteint bien avant l'arrivée. */
    const q = Math.max(0, 1 - u / 0.8);
    const amp = 0.16 * q * q;
    r.a.statue.position.set(
      r.a.x + (Math.random() - 0.5) * amp,
      y + (Math.random() - 0.5) * amp * 0.7,
      r.a.z + (Math.random() - 0.5) * amp,
    );
    /* Le plan de coupe suit le sol, pas la statue : il reste fixe, c'est la
       statue qui le franchit. */
    if (u >= 1) {
      r.a.statue.position.set(r.a.x, r.y0, r.a.z);
      /* Coupe retirée à l'arrivée : la garder coûterait une passe de clipping
         pour rien pendant toute la partie. */
      r.a.statue.traverse((c) => {
        if (c.isMesh || c.isSkinnedMesh) c.material.clippingPlanes = null;
      });
      _statueRises.splice(i, 1);
    }
  }
}

/* ---- Éclatement de l'ancienne statue ----
   On ne rejoue pas la sculpture en morceaux : on la remplace par une volée de
   blocs de pierre. Découper un maillage riggé à la volée coûterait bien plus
   cher que ce que l'effet rapporte, et à cette distance de caméra la gerbe se
   lit exactement pareil. */
function shatterStatue(a, wasOwner) {
  scene.remove(a.statue);
  disposeGroup(a.statue);
  a.statue = null;

  const col = wasOwner >= 0 && factions[wasOwner] ? factions[wasOwner].color : null;
  const n = isCoarse ? 10 : 26;
  for (let i = 0; i < n; i++) {
    const mesh = new THREE.Mesh(
      SHARED_PARTICLE_GEO,
      new THREE.MeshBasicMaterial({ color: STONE_COL }),
    );
    const s = 0.22 + Math.random() * 0.4;
    mesh.scale.setScalar(s);
    mesh.position.set(
      a.x + (Math.random() - 0.5) * 1.4,
      (a.y || 0) + 0.6 + Math.random() * STATUE_H,
      a.z + (Math.random() - 0.5) * 1.4,
    );
    scene.add(mesh);
    const ang = Math.random() * Math.PI * 2;
    const sp = 3.5 + Math.random() * 7;
    particles.push({
      mesh,
      vx: Math.cos(ang) * sp, vy: 5 + Math.random() * 7, vz: Math.sin(ang) * sp,
      scale: s, factionIdx: -1, noPaint: true,
    });
  }
  spawnShock(a.x, a.z, col || new THREE.Color(STONE_COL), 6, 0.5);
  shake = Math.max(shake, wasOwner === 0 ? 0.45 : 0.25);
}

function activateAltar(a, f) {
  const wasOwner = a.owner;
  a.owner = f.i;
  a.filled = 0;
  /* Chaque prise renchérit la suivante — pour tout le monde, y compris celui
     qui vient de prendre l'autel. L'escalade appartient au lieu, pas au culte. */
  a.need += ALTAR_NEED_STEP;
  a.activeT = 0;
  /* L'ANCIENNE statue vole en éclats. Elle ne disparaît pas : une prise se lit
     comme un renversement, il faut voir tomber ce qui était là avant. */
  if (a.statue) shatterStatue(a, wasOwner);

  /* Le gardien est de l'élément qui vient d'être livré ; l'autel réclame
     désormais son opposé pour être brisé à son tour. */
  a.statue = makeOwnerStatue(f);
  /* Pieds au sol. L'ancien décalage (ALTAR_H * 0.42) posait la statue sur le
     petit autel d'alors ; avec l'emprise actuelle il la laissait planer à
     plus de deux unités au-dessus du dallage. La statue a son propre socle,
     elle n'a besoin d'aucun rehaussement. */
  a.statue.position.set(a.x, a.y || 0, a.z);
  /* Orientation stable, tirée de la position : deux sanctuaires voisins ne
     regardent pas exactement dans la même direction. */
  a.statue.rotation.y = Math.atan2(a.x, a.z) + Math.PI;
  scene.add(a.statue);
  setCharLayer(a.statue);
  /* Grondement de pierre à la levée de la statue. Audible partout : une prise
     de sanctuaire est un événement de partie, pas un détail local — même à
     l'autre bout de la vallée on doit savoir qu'il vient de s'en passer une.
     Un peu plus fort quand c'est le joueur qui vient de prendre le lieu. */
  const sfx = soundEngine.playSFXGroup('earth', { volume: f.i === 0 ? 0.8 : 0.5 });
  /* La levée dure EXACTEMENT le temps du grondement : c'est ce qui fait croire
     que c'est le son qui soulève la pierre, et non deux effets qui se croisent.
     Bornée quand même — un fichier anormalement long figerait la statue sous
     terre une éternité. */
  const rise = Math.min(2.6, Math.max(0.8, soundEngine.sfxDuration(sfx, 1.4)));
  beginStatueRise(a, rise);
  a.variant = ELEM_OPPOSITE[a.variant];

  spawnShock(a.x, a.z, f.color, 9, 1.2);
  if (f.i === 0) {
    banner(wasOwner >= 0 ? '🏛 Sanctuaire repris !' : '🏛 Sanctuaire éveillé !');
    sfxRankUp();
  } else if (wasOwner === 0) {
    banner('⚠ Un rival vous prend un sanctuaire !');
  }
  refreshAltarVisual(a);
}

function updateAltars(dt) {
  updateStatueRises(dt);
  for (const a of altars) {
    a.age += dt;
    a.grp.userData.ring.rotation.z += dt * 0.8;
    a.grp.userData.ring.position.y = ALTAR_H + 0.55 + Math.sin(a.age * 1.6) * 0.09;
    a.label.position.y = (a.y || 0) + ALTAR_H + 2.0 + Math.sin(a.age * 1.3) * 0.12;

    /* Bon marché : la signature coupe court dès que rien n a changé. Nécessaire
       pour que l étiquette se redessine quand la vignette finit de charger. */
    refreshAltarVisual(a);
    feedAltar(a, dt);

    if (a.owner < 0) continue;
    const f = factions[a.owner];
    if (!f || !f.alive) continue;

    a.activeT += dt;
    /* La statue ne bouge pas : c'est de la pierre. */

    /* Peinture : le sanctuaire tache autour de lui, sur un disque qui s'élargit
       avec le temps. On sème des éclaboussures au hasard plutôt que de peindre
       un cercle net — la frontière reste organique, comme le reste du jeu. */
    a.paintAcc += dt;
    if (a.paintAcc >= ALTAR_PAINT_PERIOD) {
      a.paintAcc = 0;
      const grow = Math.min(1, a.activeT / ALTAR_GROW_T);
      const r = ALTAR_PAINT_R * (0.28 + 0.72 * grow);
      const ang = Math.random() * Math.PI * 2;
      const d = Math.sqrt(Math.random()) * r;
      stampPaintAt(f, a.x + Math.cos(ang) * d, a.z + Math.sin(ang) * d, 1.15);
    }
  }
}

function updateBurrowEvents(dt) {
  for (let i = activeBurrowEvents.length - 1; i >= 0; i--) {
    const ev = activeBurrowEvents[i];
    ev.t += dt;

    // Phase 1: Le trou remonte du sol (0.0s -> 0.4s)
    if (ev.t <= 0.4) {
      const k = ev.t / 0.4;
      if (ev.mesh) ev.mesh.position.y = -1.2 + k * 1.2;
    }
    // Phase 2: L'esprit sort en sautant du trou (0.4s -> 1.0s)
    else if (ev.t <= 1.0) {
      if (ev.mesh) ev.mesh.position.y = 0.0;
      if (!ev.spawnedSpirit) {
        ev.spawnedSpirit = true;
        const a = spawnAgent(ev.x, ev.z);
        if (a) {
          ev.agentId = a.id;
          soundEngine.playSFX?.('crystal', { volume: 0.85, rate: 1.4 });
        }
      }
      if (ev.agentId !== null && agents[ev.agentId]) {
        const jumpT = (ev.t - 0.4) / 0.6; // 0.0 à 1.0
        const arcY = Math.sin(jumpT * Math.PI) * 2.8;
        agents[ev.agentId].y = arcY;
      }
    }
    // Phase 3: L'esprit se pose au sol et le trou rentre dans le sol (1.0s -> 1.5s)
    else if (ev.t <= 1.5) {
      if (ev.agentId !== null && agents[ev.agentId]) {
        agents[ev.agentId].y = 0.0;
      }
      const k = (ev.t - 1.0) / 0.5;
      if (ev.mesh) ev.mesh.position.y = 0.0 - k * 1.2;
    }
    // Fin de l'événement : nettoyage du trou
    else {
      if (ev.agentId !== null && agents[ev.agentId]) {
        agents[ev.agentId].y = 0.0;
      }
      if (ev.mesh) {
        scene.remove(ev.mesh);
        disposeGroup(ev.mesh);
      }
      activeBurrowEvents.splice(i, 1);
    }
  }
}

/* Compat : les anciens noms restent utilisés à quelques endroits (avatar HUD,
   texte du menu). Ils pointent maintenant sur les données du moine du registre. */
let monkModel = null, monkTexture = null, monkClips = null;
for (const [key, def] of Object.entries(LEADERS)) {
  gltfLoader.load(def.url, (gltf) => {
    mobileDownscaleTextures(gltf);
    let tex = null;
    gltf.scene.traverse((child) => {
      if (child.isMesh && child.material && child.material.map && !tex) tex = child.material.map;
    });
    leaderAssets[key] = { model: gltf.scene, texture: tex, clips: gltf.animations };
    if (key === 'monk') { monkModel = gltf.scene; monkTexture = tex; monkClips = gltf.animations; }
  }, undefined, (err) => console.warn('[leader] failed to load', def.url, err));
  gltfLoader.load(LEADER_ELEMENT[key], (elGltf) => {
    mobileDownscaleTextures(elGltf);
    let elTex = null;
    elGltf.scene.traverse((c) => { if (c.isMesh && c.material?.map && !elTex) elTex = c.material.map; });
    /* Portrait AVANT bakeVAT : la cuisson laisse la scène figée sur la dernière
       frame de course, bras en pleine foulée — mauvaise pose de portrait. */
    renderSpiritPortrait(renderer, elGltf.scene, key);
    buildFollowerMesh(key, elGltf, elTex);
  }, undefined, (err) => console.warn('[follower] failed to load', LEADER_ELEMENT[key], err));
}

function buildFollowerMesh(key, gltf, tex) {
  const vat = bakeVAT(gltf, { scale: 1, targetHeight: VILLAGER_H * FOLLOWER_SCALE });
  if (!vat) { console.warn('[follower] VAT fail for', key); return; }
  const cap = FOLLOWER_MESH_CAP;
  const anim = new THREE.InstancedBufferAttribute(new Float32Array(cap * 2), 2);
  anim.setUsage(THREE.DynamicDrawUsage);
  vat.geometry.setAttribute('aAnim', anim);

  const mesh = new THREE.InstancedMesh(
    vat.geometry,
    makeVATMaterial(tex, vat, monkTimeU, 'follower-' + key),
    cap,
  );
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.castShadow = gfxShadows();
  mesh.userData.shadowable = true;
  mesh.frustumCulled = false;
  mesh.count = 0;
  mesh.userData.anim = anim;

  /* instanceColor AVANT le 1er rendu — sinon le shader compile sans teinte d'instance. */
  const colAttr = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
  colAttr.setUsage(THREE.DynamicDrawUsage);
  for (let i = 0; i < cap; i++) colAttr.setXYZ(i, 1, 1, 1);
  mesh.instanceColor = colAttr;

  const zeroM = new THREE.Matrix4().makeScale(0, 0, 0);
  for (let i = 0; i < cap; i++) mesh.setMatrixAt(i, zeroM);
  mesh.instanceMatrix.needsUpdate = true;

  scene.add(mesh);
  setCharLayer(mesh);
  let outline = null;
  if (!isCoarse) {
    const outMat = makeVATOutlineMaterial(vat, monkTimeU, 'foll-out-' + key, 0.022);
    outline = new THREE.InstancedMesh(vat.geometry, outMat, cap);
    outline.instanceMatrix = mesh.instanceMatrix;
    outline.count = 0;
    outline.frustumCulled = false;
    outline.userData.isOutline = true;
    outline.matrixAutoUpdate = false;
    outline.renderOrder = 2;
    scene.add(outline);
    setCharLayer(outline);
  }
  mesh.userData.outlineMesh = outline;

  const freeSlots = [];
  for (let i = cap - 1; i >= 0; i--) freeSlots.push(i);

  followerMeshes[key] = { key, mesh, outline, freeSlots, vat, cap };
  console.log('[follower] mesh ready:', key, 'verts:', vat.vCount);
  flushPendingFollowers(key);
}

/* Crédite des croyants portés à un culte : maisons vidées, âmes ramassées,
   sanctuaires activés. Remplace l'ancien gain de cristaux-vie. */
function gainBelievers(f, n = 1) {
  if (!f || !f.alive) return false;
  f.count += n;
  f.everGrew = true;
  if (f.i === 0) {
    tone(660, 0.09, 'triangle', 0.05);
    tone(990, 0.12, 'triangle', 0.04, 0.06);
  }
  spawnShock(f.leader.x, f.leader.z, f.color, 2.4, 0.4);
  return true;
}

/* Rayon de la « masse » d'un culte : sert de repère visuel et de base à
   l'influence. Racine carrée du nombre de croyants, qui n'a pas de plafond. */
function crowdRadius(n, factionI = -1) {
  let r = 1.5 + Math.sqrt(n) * 0.24;
  if (factionI === 0) r *= skillMods.crowdMult;
  return r;
}
/* Zone d'influence : elle récolte les sceptiques ET porte les attaques. Elle
   grandit avec les cristaux, exactement comme elle grandissait avec la foule. */
function influenceRadius(n, factionI = -1) {
  let r = crowdRadius(n, factionI) + 2.6;
  if (factionI >= 0 && factions[factionI] && factions[factionI].leaderKey === 'monk') {
    r *= 1.15;   // Petit Moine : +15% Aura d'attraction étendue
  }
  if (factionI === 0) {
    r *= skillMods.influenceMult;
    if (ecstasyT > 0) r *= ECSTASY_RANGE;   // Extase : le cercle d'influence explose
  }
  return r;
}
/* Contexte des helpers sim : évite les globales cachées dans src/sim/*.
   Recréé une seule fois — pointe sur les valeurs vivantes de main.js. */
const _simCtx = { skillMods, paintOwnerAt: null };
function leaderSpeed(f) { _simCtx.skillMods = skillMods; return _leaderSpeed(f, _simCtx); }
/* Emplacements d'agents libérés par une absorption. Un agent absorbé n'est pas
   retiré du tableau : son `id` indexe sa place dans les InstancedMesh, et tout
   décaler à chaque conversion ferait sauter l'apparence de la moitié de la carte.
   On le marque mort, on le cache, et le prochain spawn reprend sa place. */
const freeAgentIds = [];

function spawnAgent(x, z) {
  /* Un sceptique ne naît jamais au-dessus du vide : les appelants raisonnent en
     coordonnées libres (autour d'un Leader, d'une maison…), c'est ici qu'on
     ramène le point sur la tuile la plus proche. */
  if (island && !isSolid(island, x, z)) { const p = onIsland(x, z); x = p.x; z = p.z; }
  const ang = Math.random() * Math.PI * 2;

  const recycled = freeAgentIds.pop();
  if (recycled !== undefined) {
    const a = agents[recycled];
    resetAgent(a, x, z, ang);
    grayCount++;
    setAgentColor(a.id, GRAY);
    return a;
  }

  if (agents.length >= MAX_AGENTS) return null;
  const id = agents.length;
  const baseScale = 0.88 + Math.random() * 0.22;
  const a = createAgent(id, x, z, ang, baseScale);
  if (isKnight(a)) a.base *= 1.12;   // le chevalier en impose un peu plus
  /* Référence de taille, posée APRÈS le bonus chevalier : c'est elle que
     resetAgent restaure à chaque recyclage. */
  a._spawnBase = a.base;
  agents.push(a);
  grayCount++;
  setAgentColor(a.id, GRAY);
  return a;
}

/* ---- Absorption / conversion d'un gris ----
   Fin du rituel : l'esprit rejoint le cortège du Leader. */
const _convCol = new THREE.Color();
function creditConvert(a, f, opts = {}) {
  f.grisAbs = (f.grisAbs || 0) + 1;

  if (f.i === 0) {
    stats.conv++;
    bumpStreak();
  }

  /* `paintMul` : carte « Empreinte profonde ». Elle agit sur le RAYON de la
     trace, pas sur un score — la carte se voit donc au sol, et ce qu'elle
     rapporte se dispute encore : un rival peut repeindre par-dessus. */
  const fervor = (f.paintMulT || 0) > 0 ? (f.paintMul || 1) : 1;
  const imprintR = (1.5 + (f.i === 0 ? Math.min(1.5, streak * 0.08) : 0.15)) * fervor;
  stampSplash(a.x, a.z, imprintR, f.team, f.css);

  spawnSoulBurst(a.x, a.z, f);
  spawnSoulBurst(
    a.x + (Math.random() - 0.5) * 0.6,
    a.z + (Math.random() - 0.5) * 0.6, f);


  if (f.i === 0) {
    const waveR = 2.1 + Math.min(5.5, streak * 0.24);
    spawnShock(a.x, a.z, f.color, waveR, 0.3 + Math.min(0.28, streak * 0.014));
    spawnShock(f.leader.x, f.leader.z, f.color, 1.5 + Math.min(2.2, streak * 0.09), 0.22);
    {
      soundEngine.playSFX('convert', {
        volume: 0.78,
        rate: 1 + Math.min(0.35, Math.max(0, streak - 1) * 0.035),
      });
    }
    updateHUD();
  } else {
    spawnShock(f.leader.x, f.leader.z, f.color, 2.2, 0.32);
  }
}


function releaseFollowerSlot(a) {
  if (a._followerSlot == null || !a._followerKey) return;
  const fm = followerMeshes[a._followerKey];
  if (fm) {
    fm.freeSlots.push(a._followerSlot);
    const zeroM = new THREE.Matrix4().makeScale(0, 0, 0);
    fm.mesh.setMatrixAt(a._followerSlot, zeroM);
    fm.mesh.instanceMatrix.needsUpdate = true;
  }
  a._followerSlot = null;
  a._followerKey = null;
}

/* Conversions trop tôt / pool plein / Leader sans VAT : fallback moine + retry chaque frame. */
const _pendingFollowers = []; // { a, f }

/* Les six meshes de suivants sont indexés par clé de Leader, mais chacun porte
   en réalité l'élémentaire de ce Leader (voir LEADER_ELEMENT). On peut donc les
   adresser par ÉLÉMENT, ce qui permet à un esprit capturé de garder sa propre
   forme au lieu de prendre celle du culte qui l'a pris. */
const ELEM_TO_LEADER = { 3: 'amazon', 4: 'chief', 5: 'alien', 6: 'monk', 7: 'nomad', 8: 'sorcerer' };

/** Mesh correspondant à l'élément PROPRE de l'esprit. Un esprit capturé doit
    rester reconnaissable : c'est son type, pas son ravisseur, qui décide de son
    apparence — sans quoi on ne sait plus ce qu'on transporte vers un autel. */
function followerMeshFor(f, a) {
  const byElem = a ? ELEM_TO_LEADER[variantOf(a.id)] : null;
  const want = byElem || (f && f.leaderKey) || 'monk';
  return followerMeshes[want] || followerMeshes.monk || null;
}

function assignFollowerSlot(a, f) {
  if (a._followerSlot != null && a._followerKey && followerMeshes[a._followerKey]) {
    hideAgent(a.id);
    return true;
  }
  const fm = followerMeshFor(f, a);
  if (!fm || !fm.freeSlots.length) {
    a._followerSlot = null;
    a._followerKey = null;
    return false;
  }
  releaseFollowerSlot(a);
  const slot = fm.freeSlots.pop();
  const key = fm.key;
  a._followerSlot = slot;
  a._followerKey = key;
  fm.mesh.count = Math.max(fm.mesh.count, slot + 1);
  if (fm.outline) fm.outline.count = fm.mesh.count;
  fm.mesh.instanceColor.setXYZ(slot, 1, 1, 1);
  fm.mesh.instanceColor.needsUpdate = true;
  const anim = fm.mesh.userData.anim;
  anim.setXY(slot, Math.random() * 14, 0);
  anim.needsUpdate = true;
  /* Pose immédiate — sinon invisible jusqu'au prochain crowd-tick. */
  const sc = 1;
  tmpQ.setFromAxisAngle(UP_AXIS, a.face || 0);
  tmpP.set(a.x, a.y || 0, a.z);
  tmpS.set(sc, sc, sc);
  tmpM.compose(tmpP, tmpQ, tmpS);
  fm.mesh.setMatrixAt(slot, tmpM);
  fm.mesh.instanceMatrix.needsUpdate = true;
  hideAgent(a.id);
  return true;
}

function queueFollowerMorph(a, f) {
  if (!a || a.dead || !f) return false;
  if (assignFollowerSlot(a, f)) return true;
  if (!_pendingFollowers.some((p) => p.a === a)) _pendingFollowers.push({ a, f });
  hideAgent(a.id); // ne jamais laisser le paysan visible en attendant
  return false;
}

function flushPendingFollowers(readyKey) {
  if (!_pendingFollowers.length) return;
  for (let i = _pendingFollowers.length - 1; i >= 0; i--) {
    const { a, f } = _pendingFollowers[i];
    if (!a || a.dead) { _pendingFollowers.splice(i, 1); continue; }
    const isConv = (a.followerOf ?? -1) >= 0;
    if (!isConv) { _pendingFollowers.splice(i, 1); continue; }
    const key = (f && f.leaderKey) || 'monk';
    if (readyKey && key !== readyKey && readyKey !== 'monk') continue;
    if (a._followerSlot != null) { _pendingFollowers.splice(i, 1); continue; }
    if (assignFollowerSlot(a, f)) _pendingFollowers.splice(i, 1);
  }
}

/** Chaque frame : tout converti DOIT être en forme Leader (ou caché en attendant). */
function ensureAllFollowerMorphs() {
  for (let i = 0; i < agents.length; i++) {
    const a = agents[i];
    if (!a || a.dead) continue;
    let fi = -1;
    if (fi < 0) fi = a.followerOf ?? -1;
    if (fi < 0) continue;
    const f = factions[fi];
    if (!f || !f.alive) continue;
    if (a._followerSlot == null) queueFollowerMorph(a, f);
    else hideAgent(a.id);
  }
  flushPendingFollowers();
}

function convertToFollower(a, f, byDisc = null) {
  a.dead = false;
  a.extractProgress = 0;
  a.converting = -1;
  a.followerOf = f.i;
  /* En plein plongeon, `base` est une taille intermédiaire (l'esprit est à
     moitié avalé par le trou) : la référence est celle d'avant le plongeon. */
  if (!a._origBase) a._origBase = (a._dive != null && a._diveBase) ? a._diveBase : a.base;
  a.base = a._origBase * FOLLOWER_SCALE;
  a.vx = 0; a.vz = 0;
  grayCount--;
  f.count = (f.count || 0) + 1;
  queueFollowerMorph(a, f);
  creditConvert(a, f);
}

function finishConvert(a, f, byDisc = null) {
  if (a.dead || !f || !f.alive) return;
  if (variantOf(a.id) < 3) return; // Paysans, paysannes et chevaliers PNJ ne sont pas assimilables
  const wasFollower = (a.followerOf ?? -1) >= 0;
  if (wasFollower && a.followerOf === f.i) return;
  /* Sanctuaire : si ce fidèle est protégé par le dôme de son culte actuel,
     le vol par une autre faction est bloqué (petit flash pour le tell). */
  if (wasFollower && a._sanctUntil && a._sanctUntil > elapsed && a.followerOf !== f.i) {
    spawnShock(a.x, a.z, new THREE.Color(0x7cd6ff), 1.1, 0.22);
    return;
  }
  if (wasFollower) {
    const oldF = factions[a.followerOf];
    if (oldF) oldF.count = Math.max(0, (oldF.count || 0) - 1);
    releaseFollowerSlot(a);
    a.followerOf = -1;
    grayCount++;
  }
  /* Tout esprit converti rejoint le cortège. La promotion en disciple a été
     retirée : elle sortait l'esprit du stock livrable aux sanctuaires tout en
     le comptant dans f.count — elle punissait donc la conversion. */
  convertToFollower(a, f);
}

function absorb(a, fi) {
  const f = factions[fi];
  if (!f) return;
  finishConvert(a, f);
}

/* ---- Série de conversions ----
   Chaque conversion prolonge la série ; elle retombe si l'on reste trop longtemps
   sans convertir. La récompense doit être réelle et pas seulement sonore, sinon
   le joueur ne change pas sa façon de jouer : les paliers donnent un sprint. */
function bumpStreak() {
  streak++;
  streakT = STREAK_WINDOW * skillMods.streakWinMult;
  if (streak > stats.bestStreak) stats.bestStreak = streak;
  sfxPop(streak);
  if (STREAK_PALIERS.includes(streak)) {
    banner(`🔥 Ferveur ×${streak} !`);
    factions[0].boostT = Math.max(factions[0].boostT || 0, 1.2);
    shake = Math.max(shake, 0.22 + Math.min(0.2, streak * 0.004));
    sfxRankUp();
  }
}

/* ============================== Livraison & Siphon ==============================
   Plus aucun tir : la partie se joue à la récolte, au portage et au vol de
   foule. Déposer met à l'abri ; porter expose. */

/** Le Leader est-il dans sa propre cour ? */

/* Dépôt : dans sa cour, les croyants portés s'écoulent vers l'autel en un
   filet continu d'âmes. Chaque croyant déposé est définitivement acquis. */
/* Le dépôt en base a disparu avec la règle des 60 : le territoire vient
   désormais des sanctuaires. La fonction est neutralisée plutôt que supprimée
   d'un bloc — elle dévorait le cortège du joueur sans plus rien lui rapporter,
   ce qui punissait le simple fait de rentrer chez soi. */
function updateDeposits() {}


/* ============================== Ondes de choc au sol ============================== */
const SHOCK_GEO = new THREE.RingGeometry(0.92, 1, 48).rotateX(-Math.PI / 2);
function spawnShock(x, z, color, maxR = 6, dur = 0.55) {
  const m = new THREE.Mesh(SHOCK_GEO, new THREE.MeshBasicMaterial({
    color, transparent: true, opacity: 0.55, depthWrite: false }));
  m.position.set(x, 0.3, z);
  scene.add(m);
  shocks.push({ mesh: m, t: 0, maxR, dur });
}
function updateShocks(dt) {
  for (let i = shocks.length - 1; i >= 0; i--) {
    const s = shocks[i];
    s.t += dt;
    const k = s.t / s.dur;
    if (k >= 1) { scene.remove(s.mesh); s.mesh.material.dispose(); shocks.splice(i, 1); continue; }
    s.mesh.scale.setScalar(0.4 + k * s.maxR);
    s.mesh.material.opacity = 0.55 * (1 - k);
  }
}

/** Couleur CSS → rgba avec alpha (pour dégradé de bord). */
function cssAlpha(css, a) {
  if (typeof css === 'string' && css[0] === '#') {
    let h = css.slice(1);
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    const r = parseInt(h.slice(0, 2), 16);
    const g = parseInt(h.slice(2, 4), 16);
    const b = parseInt(h.slice(4, 6), 16);
    return `rgba(${r},${g},${b},${a})`;
  }
  return css;
}

/**
 * Flaque liquide : Bézier doux, cœur opaque (fusionne les traces),
 * feather très court — évite les encoches de flaques semi-transparentes.
 */
function drawOrganicSplat(ctx, cx, cz, r) {
  const n = 12;
  const pts = [];
  for (let i = 0; i < n; i++) {
    const angle = (i / n) * Math.PI * 2;
    // Forme fluide organique avec ondulations naturelles de liquide
    const wobble = 0.88 + 0.16 * Math.sin(i * 2.3 + cx * 0.05 + cz * 0.03);
    pts.push({
      x: cx + Math.cos(angle) * r * wobble,
      y: cz + Math.sin(angle) * r * wobble,
    });
  }

  ctx.beginPath();
  ctx.moveTo((pts[n - 1].x + pts[0].x) * 0.5, (pts[n - 1].y + pts[0].y) * 0.5);
  for (let i = 0; i < n; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % n];
    ctx.quadraticCurveTo(p.x, p.y, (p.x + q.x) * 0.5, (p.y + q.y) * 0.5);
  }
  ctx.closePath();

  const css = ctx.fillStyle;
  // Cœur liquide riche et brillant avec bordure anti-aliasée
  const grad = ctx.createRadialGradient(cx, cz, r * 0.65, cx, cz, r * 1.05);
  grad.addColorStop(0, cssAlpha(css, 1.0));
  grad.addColorStop(0.82, cssAlpha(css, 1.0));
  grad.addColorStop(0.96, cssAlpha(css, 0.85));
  grad.addColorStop(1.0, cssAlpha(css, 0.0));
  ctx.fillStyle = grad;
  ctx.fill();

  // 6 micro-gouttelettes fluides projetées de manière dynamique
  for (let k = 0; k < 6; k++) {
    if (Math.random() < 0.25) continue;
    const a = Math.random() * Math.PI * 2;
    const d = r * (0.95 + Math.random() * 0.50);
    const dr = r * (0.09 + Math.random() * 0.16);
    ctx.beginPath();
    ctx.arc(cx + Math.cos(a) * d, cz + Math.sin(a) * d, dr, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.fillStyle = css;
}

function stampSplash(x, z, radius, factionIdx, colorStr) {
  const half = PAINT_N / 2, k = PAINT_N / PAINT_SPAN;
  const r = radius * k;
  const srcY = groundY(x, z);
  const cx = x * k + half, cz = z * k + half;
  const gx0 = Math.max(0, Math.floor(cx - r)), gx1 = Math.min(PAINT_N - 1, Math.ceil(cx + r));
  const gz0 = Math.max(0, Math.floor(cz - r)), gz1 = Math.min(PAINT_N - 1, Math.ceil(cz + r));
  const r2 = r * r;
  const kw = PAINT_SPAN / PAINT_N;

  let gridChanged = false;
  for (let gz = gz0; gz <= gz1; gz++) {
    for (let gx = gx0; gx <= gx1; gx++) {
      const dx = gx + 0.5 - cx, dz = gz + 0.5 - cz;
      if (dx * dx + dz * dz > r2) continue;
      const wx = (gx + 0.5 - half) * kw, wz = (gz + 0.5 - half) * kw;
      if (!isSolid(island, wx, wz)) continue;
      if (groundY(wx, wz) > srcY + 0.01) continue;   // la peinture ne monte pas
      const idx = gz * PAINT_N + gx;
      if (paintGrid[idx] === factionIdx) continue;
      const old = paintGrid[idx];
      if (old >= 0) paintCounts[old]--;
      paintGrid[idx] = factionIdx;
      paintCounts[factionIdx]++;
      gridChanged = true;
    }
  }

  if (gridChanged) {
    paintCtx.save();
    /* Même coupe que la grille : on n'éclabousse que son niveau et en dessous. */
    if (paintClipAtY(srcY)) paintCtx.clip(paintClipAtY(srcY));
    paintCtx.fillStyle = colorStr;
    drawOrganicSplat(paintCtx, cx, cz, r);
    paintCtx.restore();
    paintNeedsClip = true;
    paintDirty = true;
  }
}

/* Efface toute couleur dans un rayon : la grille repasse à neutre et le canvas
   est troué en destination-out via le splat organique (bord déchiqueté + les
   gouttelettes du spray deviennent des petits trous — trace de pluie crédible). */
function erasePaintAt(x, z, radius) {
  const half = PAINT_N / 2, k = PAINT_N / PAINT_SPAN;
  const r = radius * k;
  const cx = x * k + half, cz = z * k + half;
  const gx0 = Math.max(0, Math.floor(cx - r)), gx1 = Math.min(PAINT_N - 1, Math.ceil(cx + r));
  const gz0 = Math.max(0, Math.floor(cz - r)), gz1 = Math.min(PAINT_N - 1, Math.ceil(cz + r));
  const r2 = r * r;
  for (let gz = gz0; gz <= gz1; gz++) {
    for (let gx = gx0; gx <= gx1; gx++) {
      const dx = gx + 0.5 - cx, dz = gz + 0.5 - cz;
      if (dx * dx + dz * dz > r2) continue;
      const idx = gz * PAINT_N + gx;
      const owner = paintGrid[idx];
      if (owner >= 0) { paintCounts[owner]--; paintGrid[idx] = -1; }
    }
  }
  paintCtx.save();
  paintCtx.globalCompositeOperation = 'destination-out';
  paintCtx.fillStyle = '#000000';
  drawOrganicSplat(paintCtx, cx, cz, r);
  paintCtx.restore();
  paintDirty = true;
}

function explodeShrine(x, z, colorObj, cssStr, factionIdx) {
  const pCount = isCoarse ? 14 : 85;
  const mat = new THREE.MeshBasicMaterial({ color: colorObj });
  for (let i = 0; i < pCount; i++) {
    const size = 0.28 + Math.random() * 0.28;
    const mesh = new THREE.Mesh(SHARED_PARTICLE_GEO, mat);
    mesh.scale.setScalar(size);
    mesh.position.set(x + (Math.random() - 0.5) * 0.4, 2.6, z + (Math.random() - 0.5) * 0.4);
    scene.add(mesh);
    const a = Math.random() * Math.PI * 2;
    const speed = 8.0 + Math.random() * 16.0;
    const vy = 8.0 + Math.random() * 12.0;
    particles.push({
      mesh, vx: Math.cos(a) * speed, vy, vz: Math.sin(a) * speed,
      scale: 1.0, colorCss: cssStr, factionIdx
    });
  }
}

function updateParticles(dt) {
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    p.mesh.position.x += p.vx * dt;
    p.mesh.position.y += p.vy * dt;
    p.mesh.position.z += p.vz * dt;

    /* Goutte de pluie d'orage : chute rectiligne, géométrie/matériau PARTAGÉS
       (pas de dispose — ils resservent à toutes les gouttes). */
    if (p.isRain) {
      if (p.mesh.position.y <= 0.15) { scene.remove(p.mesh); particles.splice(i, 1); }
      continue;
    }

    // Traitement des étincelles de tir
    if (p.isTrail) {
      p.vy -= 4.0 * dt; // Gravité beaucoup plus légère pour des braises flottantes
      p.scale -= dt * 2.8; // Rétrécissement rapide pour laisser une traînée furtive
      if (p.scale <= 0.05 || p.mesh.position.y <= 0.08) {
        scene.remove(p.mesh);
        if (p.mesh.geometry !== SHARED_PARTICLE_GEO) p.mesh.geometry.dispose();
        if (!_particleMatCache.has(p.factionIdx)) p.mesh.material.dispose();
        particles.splice(i, 1);
        continue;
      }
      p.mesh.scale.setScalar(p.scale);
      continue;
    }

    p.vy -= 18.0 * dt;

    p.scale -= dt * 1.1;
    if (p.scale <= 0.05) {
      scene.remove(p.mesh);
      if (p.mesh.geometry !== SHARED_PARTICLE_GEO) p.mesh.geometry.dispose();
      if (!_particleMatCache.has(p.factionIdx)) p.mesh.material.dispose();
      particles.splice(i, 1);
      continue;
    }
    p.mesh.scale.setScalar(p.scale);

    if (p.mesh.position.y <= 0.38 && p.vy < 0) {
      /* `noPaint` : les gravats d'une statue brisée retombent sans rien teindre.
         Sans ce garde-fou ils passeraient ici avec factionIdx -1, ce qui EFFACE
         la peinture au lieu d'en poser — un sanctuaire pris blanchirait les
         alentours de son propre preneur. */
      if (!p.noPaint) {
        stampSplash(p.mesh.position.x, p.mesh.position.z, 1.8 + Math.random() * 2.2, p.factionIdx, p.colorCss);
      }
      scene.remove(p.mesh);
      if (p.mesh.geometry !== SHARED_PARTICLE_GEO) p.mesh.geometry.dispose();
      if (!_particleMatCache.has(p.factionIdx)) p.mesh.material.dispose();
      particles.splice(i, 1);
    }
  }
}

/* ============================== Sanctuaires (Lieux Saints) ==============================
   2-3 points fixes par carte. Un Leader qui reste dans la zone la capture ; le
   propriétaire y voit naître des fidèles à sa couleur jusqu'à recapture. La
   colonne de lumière rend l'enjeu visible à travers toute la vallée. */
const SHRINE_NEUTRAL = new THREE.Color(0xcfd6e2);
function makeShrine(x, z) {
  const grp = new THREE.Group();
  const stone = toonMaterial({ color: 0x8d93a3 });
  const base = new THREE.Mesh(new THREE.CylinderGeometry(1.15, 1.5, 0.5, 8), stone);
  base.position.y = 0.25; base.castShadow = true;
  grp.add(base);
  const pillar = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.4, 1.5, 6), stone);
  pillar.position.y = 1.2; pillar.castShadow = true;
  grp.add(pillar);
  const crystal = new THREE.Mesh(new THREE.OctahedronGeometry(0.5, 0),
    toonMaterial({ color: 0xcfd6e2, emissive: 0xcfd6e2, emissiveIntensity: 0.7 }));
  crystal.position.y = 2.6;
  grp.add(crystal);
  const ring = new THREE.Mesh(new THREE.RingGeometry(SHRINE_R - 0.22, SHRINE_R, 48).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.3, depthWrite: false }));
  ring.position.y = 0.42;
  grp.add(ring);
  // disque de progression : il s'étend du centre vers l'anneau pendant la capture
  const disc = new THREE.Mesh(new THREE.CircleGeometry(1, 40).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.25, depthWrite: false }));
  disc.position.y = 0.4; disc.scale.setScalar(0.001);
  grp.add(disc);
  const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.9, 35, 12, 1, true),
    new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending }));
  beam.position.y = 17.5;
  grp.add(beam);
  grp.position.set(x, groundY(x, z), z);
  attachCartoonOutline(grp, 0.03);
  scene.add(grp);
  return { x, z, owner: -1, cap: -1, progress: 0, incomeT: SHRINE_INCOME_T, grp, ring, disc, crystal, beam };
}
function buildShrines() {
  // Sanctuaires désactivés (île nue)
  shrines = [];
}
const SHRINE_STRIDE = 3;   // cellules à visiter autour d'un sanctuaire (4.4 / CELL 1.7)
function updateShrines(dt) {
  const r2 = SHRINE_R * SHRINE_R;
  for (const sh of shrines) {
    if (sh.owner >= 0 && !factions[sh.owner].alive) sh.owner = -1;
    /* La foule capture (comme le siège des maisons) : envoyer sa masse sur un
       sanctuaire ennemi suffit à le reprendre. Le Leader compte pour plusieurs
       fidèles — y aller en personne accélère, mais expose. */
    _houseCounts.fill(0);
    const gx0 = (((sh.x + 128) / CELL) | 0) - SHRINE_STRIDE;
    const gz0 = (((sh.z + 128) / CELL) | 0) - SHRINE_STRIDE;
    for (let gx = gx0; gx <= gx0 + SHRINE_STRIDE * 2; gx++) {
      for (let gz = gz0; gz <= gz0 + SHRINE_STRIDE * 2; gz++) {
        const arr = cells.get(gx * 512 + gz);
        if (!arr) continue;
        for (const idx of arr) {
          const a = agents[idx];
          if (a.f < 0) continue;
          const dx = a.x - sh.x, dz = a.z - sh.z;
          if (dx * dx + dz * dz < r2) _houseCounts[a.f]++;
        }
      }
    }
    for (const f of factions) {
      if (!f.alive) continue;
      const dx = f.leader.x - sh.x, dz = f.leader.z - sh.z;
      if (dx * dx + dz * dz < r2) _houseCounts[f.i] += 6;
    }
    let dom = -1, domC = 0, second = 0;
    for (let fi = 0; fi < factions.length; fi++) {
      const c = _houseCounts[fi];
      if (c > domC) { second = domC; dom = fi; domC = c; }
      else if (c > second) second = c;
    }
    if (dom >= 0 && domC > second && dom !== sh.owner) {
      if (sh.cap !== dom) { sh.cap = dom; sh.progress = 0; }
      sh.progress += dt / SHRINE_CAPTURE_T;
      if (sh.progress >= 1) {
        const lost = sh.owner === 0;
        sh.owner = dom; sh.cap = -1; sh.progress = 0; sh.incomeT = SHRINE_INCOME_T;
        
        // 1. Gros splash central sous le sanctuaire (correction de la couleur en passant le CSS)
        stampSplash(sh.x, sh.z, SHRINE_R * 2.4, dom, factions[dom].css);
        
        // 2. Explosion de grosses particules 3D de peinture de la bonne couleur
        explodeShrine(sh.x, sh.z, factions[dom].color, factions[dom].css, dom);
        
        // 3. Onde de choc visuelle de capture (plus grande)
        spawnShock(sh.x, sh.z, factions[dom].color, SHRINE_R * 3.8, 1.15);
        // 4. Récompense : activer un sanctuaire rallie des croyants sur-le-champ
        gainBelievers(factions[dom], 4);
        if (dom === 0) {
          banner('⛩ Sanctuaire activé ! +4 croyants — les âmes proches naissent sous votre bannière.');
          sfxRankUp(); shake = Math.max(shake, 0.25);
        } else if (lost) {
          banner(`🚨 Le Culte ${factions[dom].cult.name} vous a pris un Sanctuaire !`);
          tone(220, 0.3, 'sawtooth', 0.05);
        } else banner(`⛩ Le Culte ${factions[dom].cult.name} s'empare d'un Sanctuaire !`);
      }
    } else {
      sh.progress = Math.max(0, sh.progress - dt / (SHRINE_CAPTURE_T * 0.7));
      if (sh.progress === 0) sh.cap = -1;
    }
    // revenu passif : des fidèles naissent directement à la couleur du propriétaire
    if (sh.owner >= 0) {
      sh.incomeT -= dt;
      if (sh.incomeT <= 0) {
        sh.incomeT = SHRINE_INCOME_T;
        for (let k = 0; k < SHRINE_INCOME_N && agents.length < MAX_AGENTS; k++) {
          const a = Math.random() * Math.PI * 2, r = 1.2 + Math.random() * 2.2;
          const na = spawnAgent(sh.x + Math.cos(a) * r, sh.z + Math.sin(a) * r, sh.owner);
          if (na) na.pop = 0.001;
        }
      }
    }
    // visuel : tout parle la couleur du propriétaire ; le disque, celle de l'assaillant
    const col = sh.owner >= 0 ? factions[sh.owner].color : SHRINE_NEUTRAL;
    sh.ring.material.color.copy(col);
    sh.ring.material.opacity = 0.26 + Math.sin(elapsed * 3) * 0.08;
    sh.crystal.material.color.copy(col);
    sh.crystal.material.emissive.copy(col);
    sh.crystal.rotation.y += dt * 1.8;
    sh.crystal.position.y = 2.6 + Math.sin(elapsed * 2.4 + sh.x) * 0.12;
    sh.beam.material.opacity = sh.owner >= 0 ? 0.65 + Math.sin(elapsed * 3.5) * 0.15 : 0;
    if (sh.owner >= 0) sh.beam.material.color.copy(col);
    if (sh.cap >= 0) {
      sh.disc.material.color.copy(factions[sh.cap].color);
      sh.disc.scale.setScalar(Math.max(0.001, sh.progress * SHRINE_R));
    } else sh.disc.scale.setScalar(0.001);
  }
}

/* ============================== Cristaux au sol ==============================
   Des cristaux libres posés sur l'île, qui réapparaissent ailleurs après un
   délai. C'est la source de soin la plus rapide, donc la plus disputée : ils
   créent des points de convergence, et courir en chercher un à 3 cristaux de
   vie est exactement le pari que la partie doit provoquer. */
/* Purge des entités de la partie précédente (sanctuaires, autels, ondes). */
function disposeGroup(grp) {
  grp.traverse((o) => {
    if (o.isMesh) { o.geometry.dispose(); if (o.material.dispose) o.material.dispose(); }
  });
  scene.remove(grp);
}
function clearFx() {
  for (const sh of shrines) disposeGroup(sh.grp);
  for (const s of shocks) { scene.remove(s.mesh); s.mesh.material.dispose(); }
  for (const p of particles) { scene.remove(p.mesh); p.mesh.geometry.dispose(); p.mesh.material.dispose(); }
  
  if (typeof teams !== 'undefined' && teams.length > 0) {
    for (const t of teams) {
    }
  }

  shrines = []; shocks = []; particles = [];
  /* Nettoyage des VFX de pouvoirs entre parties. */
  for (const t of activeTotems) { if (t.grp) { scene.remove(t.grp); disposeGroup(t.grp); } }
  activeTotems = [];
  for (const s of activeShields) { if (s.grp) { scene.remove(s.grp); disposeGroup(s.grp); } }
  activeShields = [];
  for (const c of activeCurses) { if (c.grp) { scene.remove(c.grp); disposeGroup(c.grp); } }
  activeCurses = [];
}

/** Sol praticable devant la porte : la porte regarde le centre de la carte,
    l'approche extérieure doit être solide sinon l'entrée s'ouvre sur le vide. */
function gateApproachSolid(x, z) {
  const d = Math.hypot(x, z) || 1;
  const ux = -x / d, uz = -z / d;                 // axe de la porte (site → centre)
  const px = -uz, pz = ux;                        // perpendiculaire (largeur du seuil)
  const outer = BASE_WALL_R + BASE_WALL_T;
  for (const r of [outer + 0.8, outer + 2.2, outer + 3.8]) {
    for (const s of [-1.6, 0, 1.6]) {
      if (!isSolid(island, x + ux * r + px * s, z + uz * r + pz * s)) return false;
    }
  }
  return true;
}

/** Trouve un emplacement solide près de l'extrémité pour une base fortifiée. */
function findBaseSite(ang) {
  /* Deux passes : la première exige aussi un seuil solide devant la porte ;
     si aucun site ne l'offre, la seconde retombe sur le critère intérieur seul. */
  for (const needGate of [true, false]) {
    for (let k = 0.86; k >= 0.48; k -= 0.025) {
      const x = Math.cos(ang) * MAP_R * k;
      const z = Math.sin(ang) * MAP_R * k;
      if (!isSolid(island, x, z)) continue;
      /* Les places de sanctuaire sont réservées avant tout le reste : c'est
         donc au point d'apparition de s'en écarter. Naître sur une place
         reviendrait à la prendre à la première seconde. */
      let onAltar = false;
      for (const s of (island.altarSites || [])) {
        if (Math.hypot(s.x - x, s.z - z) < ALTAR_R + 10) { onAltar = true; break; }
      }
      if (onAltar) continue;
      let ok = 0, flat = 0;
      const y0 = groundY(x, z);
      for (let a = 0; a < 8; a++) {
        const px = x + Math.cos((a / 8) * Math.PI * 2) * (BASE_WALL_R * 0.65);
        const pz = z + Math.sin((a / 8) * Math.PI * 2) * (BASE_WALL_R * 0.65);
        if (isSolid(island, px, pz)) ok++;
        if (Math.abs(groundY(px, pz) - y0) < 0.01) flat++;
      }
      /* La passe stricte exige aussi un terrain de niveau : la cour de départ
         est un disque plat, à cheval sur une falaise elle traverserait le
         flanc du plateau. La passe de repli s'en contente si l'île est ingrate. */
      if (ok >= 6 && (!needGate || (flat >= 7 && gateApproachSolid(x, z)))) return { x, z };
    }
  }
  return onIsland(Math.cos(ang) * MAP_R * 0.7, Math.sin(ang) * MAP_R * 0.7);
}


/** Collision contre les remparts des bases (désactivée : plus de murs). */
function resolveBaseWalls(_e) {
  return;
}


/** Dégage une entité coincée dans l'épaisseur d'un mur (désactivé). */
function unstickIfInWall(_e) {
  return false;
}

/** Point de spawn / respawn à l'intérieur de la cour de faction. */
function spawnInFactionBase(team, memberIndex) {
  const memberAng = (memberIndex / 3) * Math.PI * 2 + 0.4;
  let x = team.baseX + Math.cos(memberAng) * BASE_SPAWN_R;
  let z = team.baseZ + Math.sin(memberAng) * BASE_SPAWN_R;
  if (!isSolid(island, x, z)) {
    x = team.baseX;
    z = team.baseZ;
  }
  if (!isSolid(island, x, z)) {
    const p = onIsland(team.baseX, team.baseZ);
    x = p.x; z = p.z;
  }
  // rester strictement dans la cour (loin du mur)
  const dx = x - team.baseX, dz = z - team.baseZ;
  const d = Math.hypot(dx, dz);
  const maxR = BASE_WALL_R - 1.8;
  if (d > maxR) {
    const k = maxR / (d || 1);
    x = team.baseX + dx * k;
    z = team.baseZ + dz * k;
  }
  return { x, z };
}

/* ============================== Traînées de couleur ==============================
   Chaque culte peint le sol en se déplaçant (largeur = rayon de sa foule) ; le
   dernier passé gagne la cellule. Un gris qui marche sur une couleur s'y
   convertit en ~2,5 s : la traînée travaille pour son culte, mais lentement.
   La grille sert aussi de score : % de la vallée à sa couleur. */
const PAINT_N = 192;                       // résolution de la grille (cellule ≈ 0,65 u)
const PAINT_SPAN = (MAP_R + 2) * 2;        // largeur du monde couverte
const PAINT_CONVERT_T = 2.5;               // gris sur une couleur : converti en ~2,5 s
const paintGrid = new Int8Array(PAINT_N * PAINT_N).fill(-1);
const PAINT_SLOTS = 8;   // bornes de paintGrid : jusqu'à 8 cultes
const paintCounts = new Int32Array(PAINT_SLOTS);
let paintTotal = 1;                        // cellules peignables (dessus des tuiles)
/* Masque de découpe : Path2D des hex (état avant les essais de coupe horizontale). */
let paintClip = null;
/* Minimap : cellule de peinture → index de tuile, et nombre de cellules par
   tuile. Reconstruits par rebuildPaintMask à chaque nouvelle île. */
let _cellTile = null, _tileCells = null, _tileTally = null;
let paintClipByLevel = null;   // masque cumulatif par altitude (voir rebuildPaintMask)

/** Masque de découpe correspondant à une altitude de source. */
function paintClipAtY(y) {
  if (!paintClipByLevel || !paintClipByLevel.length) return paintClip;
  const lv = Math.round(y / STEP_H);
  return paintClipByLevel[Math.max(0, Math.min(paintClipByLevel.length - 1, lv))];
}

function rebuildPaintMask() {
  const half = PAINT_N / 2, k = PAINT_N / PAINT_SPAN;
  const path = new Path2D();
  const hr = HEX_R * k * 1.02;
  /* Un masque par altitude, CUMULATIF : niveau n = toutes les tuiles au
     niveau n et en dessous. Le canvas doit être coupé exactement comme la
     grille logique, sinon la couleur paraîtrait escalader un plateau que le
     score, lui, ne compte pas. */
  const byLevel = [];
  const hexInto = (p, t) => {
    const cx = t.x * k + half, cz = t.z * k + half;
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      const px = cx + Math.cos(a) * hr, pz = cz + Math.sin(a) * hr;
      if (i === 0) p.moveTo(px, pz); else p.lineTo(px, pz);
    }
    p.closePath();
  };

  let maxLevel = 0;
  for (const t of island.tiles) maxLevel = Math.max(maxLevel, t.level || 0);
  for (let lv = 0; lv <= maxLevel; lv++) {
    const p = new Path2D();
    for (const t of island.tiles) if ((t.level || 0) <= lv) hexInto(p, t);
    byLevel.push(p);
  }
  paintClipByLevel = byLevel;

  for (const t of island.tiles) hexInto(path, t);
  paintClip = path;

  /* Correspondance cellule de peinture → tuile, calculée UNE fois par île.
     La minimap colorie chaque hexagone selon la peinture majoritaire dessus :
     sans cette table il faudrait relocaliser 36 864 cellules à chaque
     rafraîchissement. Ici c'est un simple parcours de tableau. */
  for (let i = 0; i < island.tiles.length; i++) island.tiles[i]._idx = i;
  _cellTile = new Int16Array(PAINT_N * PAINT_N).fill(-1);
  _tileCells = new Int32Array(island.tiles.length);

  let n = 0;
  const kw = PAINT_SPAN / PAINT_N;
  for (let gz = 0; gz < PAINT_N; gz++) {
    for (let gx = 0; gx < PAINT_N; gx++) {
      const x = (gx + 0.5 - half) * kw, z = (gz + 0.5 - half) * kw;
      if (!isSolid(island, x, z)) continue;
      n++;
      const t = tileAt(island, x, z);
      if (!t) continue;
      _cellTile[gz * PAINT_N + gx] = t._idx;
      _tileCells[t._idx]++;
    }
  }
  paintTotal = Math.max(1, n);
}

/** Coupe les pixels hors île via le Path2D des tuiles. */
function clipPaintToIsland() {
  if (!paintClip) return;
  paintCtx.save();
  paintCtx.globalCompositeOperation = 'destination-in';
  paintCtx.fillStyle = '#ffffff';
  paintCtx.fill(paintClip);
  paintCtx.restore();
}
/* Le canvas visuel est suréchantillonné ×2 par rapport à la grille logique :
   bords d'encre nets et emblèmes lisibles, sans toucher au coût de la grille.
   Tout le code dessine en « pixels grille » grâce au setTransform. */
const PAINT_RES = 2;
const paintCv = document.createElement('canvas');
paintCv.width = paintCv.height = PAINT_N * PAINT_RES;
const paintCtx = paintCv.getContext('2d');
paintCtx.setTransform(PAINT_RES, 0, 0, PAINT_RES, 0, 0);
const paintTex = new THREE.CanvasTexture(paintCv);
paintTex.colorSpace = THREE.SRGBColorSpace;
paintTex.minFilter = THREE.LinearFilter;
paintTex.magFilter = THREE.LinearFilter;
paintTex.generateMipmaps = false;
paintTex.flipY = true;
/* Peinture « gel / eau » : volume (dôme + ombre de contact), nervures Voronoi. */
const paintMat = new THREE.MeshBasicMaterial({
  map: paintTex,
  transparent: true,
  opacity: 0.90,
  depthWrite: false,
  blending: THREE.NormalBlending,
});
/* Le rendu « gel liquide » de la peinture est branché ici plutôt que collé à un
   seul matériau : le mur de peinture des portails du Hub réutilise exactement
   le même shader, pour que ce soit visiblement la MÊME matière qu'au sol. */
function applyPaintShader(paintMat) {
paintMat.onBeforeCompile = (shader) => {
  paintMat.userData.shader = shader;
  shader.uniforms.uTime = monkTimeU;
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', `#include <common>
uniform float uTime;

vec2 paintHash2(vec2 p) {
  p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)));
  return fract(sin(p) * 43758.5453);
}

// Returns vec3(d1, d2, edge_distance)
vec3 paintVoronoi(vec2 uv, float time) {
  vec2 n = floor(uv);
  vec2 f = fract(uv);
  float md1 = 8.0;
  float md2 = 8.0;
  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      vec2 g = vec2(float(i), float(j));
      vec2 o = paintHash2(n + g);
      o = 0.5 + 0.45 * sin(time * 1.5 + 6.283185 * o);
      vec2 r = g + o - f;
      float d = dot(r, r);
      if (d < md1) {
        md2 = md1;
        md1 = d;
      } else if (d < md2) {
        md2 = d;
      }
    }
  }
  return vec3(sqrt(md1), sqrt(md2), sqrt(md2) - sqrt(md1));
}
`)
    .replace('#include <map_fragment>', `
      #ifdef USE_MAP
        vec2 uv = vMapUv;
        float t = uTime;
        float px = 0.003125;

        vec4 tex = texture2D(map, uv);
        float a = tex.a;
        if (a < 0.15) discard;
        float aa = fwidth(a) * 1.5;
        float cover = smoothstep(0.15, 0.15 + max(aa, 0.08), a);

        vec3 baseColor = tex.rgb;
        float luma = dot(baseColor, vec3(0.299, 0.587, 0.114));
        baseColor = clamp(mix(vec3(luma), baseColor, 1.32), 0.0, 1.0);

        float height = pow(smoothstep(0.18, 0.95, a), 0.75);
        float rim = smoothstep(0.16, 0.35, a) * (1.0 - smoothstep(0.40, 0.85, a));

        float hL = texture2D(map, uv - vec2(px * 2.5, 0.0)).a;
        float hR = texture2D(map, uv + vec2(px * 2.5, 0.0)).a;
        float hD = texture2D(map, uv - vec2(0.0, px * 2.5)).a;
        float hU = texture2D(map, uv + vec2(0.0, px * 2.5)).a;
        vec3 nrm = normalize(vec3((hL - hR) * 3.2, (hD - hU) * 3.2, 0.35 + height * 0.45));

        // --- NERVURES D'EAU / Voronoi Caustics ---
        vec2 p = uv * 55.0;
        vec2 fluidWarp = vec2(
          sin(uv.y * 38.0 + t * 0.95) + cos(uv.x * 30.0 - t * 0.7),
          cos(uv.x * 42.0 + t * 0.85) + sin(uv.y * 32.0 - t * 1.1)
        ) * 0.32;

        vec3 v1 = paintVoronoi(p + fluidWarp, t * 0.7);
        vec3 v2 = paintVoronoi(uv * 75.0 - fluidWarp * 0.7 + vec2(t * 0.25, -t * 0.35), t * 0.9);

        // Nervures lumineuses (caustiques de surface d'eau)
        float vein1 = 1.0 - smoothstep(0.01, 0.18, v1.z);
        float vein2 = 1.0 - smoothstep(0.01, 0.14, v2.z);
        float veinNet = max(vein1, vein2 * 0.6);
        float veinGlow = (1.0 - smoothstep(0.0, 0.32, v1.z)) * 0.4;
        float causticIntensity = clamp(veinNet + veinGlow, 0.0, 1.0);

        // Ombrage interne des cellules (effet cuvette de liquide)
        float cellCenter = smoothstep(0.05, 0.48, v1.x);

        vec3 lightDir = normalize(vec3(0.55, 0.75, 1.0));
        float ndl = max(0.0, dot(nrm, lightDir));
        float wrap = ndl * 0.32 + 0.68;
        float ao = mix(0.88, 1.0, height);

        // Base couleur avec relief de cellule
        vec3 col = baseColor * wrap * ao;
        col = mix(col, col * 0.78, cellCenter * 0.35);

        // Ajout des nervures blanches/brillantes fluides
        vec3 brightVein = mix(vec3(1.0), baseColor * 1.4, 0.2);
        col = mix(col, brightVein, causticIntensity * 0.7 * height);
        col += baseColor * causticIntensity * 0.25 * height;

        // Spéculaire mouillé réactif sur les nervures
        vec3 causticNrm = normalize(nrm + vec3((v1.z - v2.z) * 0.35, sin(t * 1.8 + uv.x * 40.0) * 0.12, 0.0));
        float spec = pow(max(0.0, dot(causticNrm, lightDir)), 14.0) * (0.35 + 0.45 * height);
        col += vec3(spec * 0.42);

        // Liseré brillant de contour d'encre
        col = mix(col, mix(baseColor, vec3(1.0), 0.35), rim * 0.28);

        diffuseColor.rgb = col;
        diffuseColor.a *= cover * (0.90 + 0.10 * height);
      #endif
    `);
};
paintMat.customProgramCacheKey = () => 'paint-water-gel-v19';
paintMat.needsUpdate = true;
return paintMat;
}
applyPaintShader(paintMat);

/* Mur de peinture d'un portail conquis : même shader que la nappe au sol, mais
   alimenté par un aplat plein de la couleur du culte au lieu du canevas de
   peinture du match. Résultat : l'espace vide de l'arche est rempli par la
   MÊME matière liquide, à la verticale. */
function makePortalPaintMaterial(cultColor) {
  const cv = document.createElement('canvas');
  cv.width = cv.height = 4;
  const c = cv.getContext('2d');
  c.fillStyle = cultColor;
  c.fillRect(0, 0, 4, 4);

  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = paintTex.colorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  /* Le shader dessine ses cellules de Voronoï en espace UV. La répétition
     règle donc leur taille apparente : réglée pour ~3 cellules en travers de
     l'arche, soit la même échelle de motif qu'au sol. */
  tex.repeat.set(0.055, 0.055);

  const mat = new THREE.MeshBasicMaterial({
    map: tex,
    transparent: true,
    opacity: 0.95,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  return applyPaintShader(mat);
}
/* ---- Nappe de peinture ----
   C'était un simple quad posé à y = 0.04. Depuis que les tuiles ont des
   niveaux, toute peinture sur un plateau se retrouvait ENTERRÉE dans la
   croûte : un sanctuaire en hauteur peignait, mais on ne voyait rien.

   La nappe est donc subdivisée et chaque sommet est remonté à la hauteur du
   sol sous lui. Deux effets pour un : la peinture apparaît sur les plateaux,
   et entre deux niveaux les sommets voisins interpolent le long de la
   falaise — la couleur descend sur la tuile basse en épousant le bord, au
   lieu de s'arrêter net à l'arête.

   La subdivision est plus fine qu'une tuile (HEX_R = 4.1) pour que chaque
   dalle porte plusieurs sommets, sinon un plateau étroit serait raboté par
   l'interpolation. */
const paintMesh = new THREE.Mesh(new THREE.BufferGeometry(), paintMat);
paintMesh.position.y = 0;
paintMesh.renderOrder = 1;
scene.add(paintMesh);

/** Reconstruit la nappe pour l'île courante (capes + coulées). */
function rebuildPaintSurface() {
  if (!island) return;
  if (paintMesh.geometry) paintMesh.geometry.dispose();
  paintMesh.geometry = buildPaintSurface(island, { span: PAINT_SPAN, lift: 0.04 });
}

let paintDirty = false, paintUploadT = 0, paintNeedsClip = false;

/* Tampon d'emblème : la silhouette blanche du symbole du culte, prête à être
   estampillée en filigrane dans l'encre. Emoji ou image (données du joueur). */
function makeIconStamp(sym) {
  const cv = document.createElement('canvas');
  cv.width = cv.height = 48;
  const c = cv.getContext('2d');
  /* Silhouette sombre : sur le gel clair (nervures blanches), un tampon blanc
     se camoufle — l'encre foncée se lit sur toutes les couleurs de culte. */
  const whiten = () => {
    c.globalCompositeOperation = 'source-in';
    c.fillStyle = '#221238';
    c.fillRect(0, 0, 48, 48);
    c.globalCompositeOperation = 'source-over';
  };
  if (sym && (sym.startsWith('data:') || sym.startsWith('http'))) {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => { c.clearRect(0, 0, 48, 48); c.drawImage(img, 4, 4, 40, 40); whiten(); };
    img.src = sym;
    // en attendant le chargement : une étoile neutre
    c.font = '36px serif'; c.textAlign = 'center'; c.textBaseline = 'middle';
    c.fillText('✦', 24, 26); whiten();
  } else {
    c.font = '38px serif'; c.textAlign = 'center'; c.textBaseline = 'middle';
    c.fillText(sym || '✦', 24, 26); whiten();
  }
  return cv;
}

/* Estampille l'emblème du culte dans l'encre, un peu derrière le Leader (pour
   que le pinceau ne repasse pas dessus). source-atop : le tampon n'existe QUE
   sur l'encre déjà posée — jamais de fantôme sur l'herbe nue. */
function stampIcon(f) {
  const t = teams[f.team];
  if (!t || !t.iconStamp) return;
  const half = PAINT_N / 2, k = PAINT_N / PAINT_SPAN;
  const n = Math.hypot(f.leader.dx, f.leader.dz) || 1;
  const bx = f.leader.x - (f.leader.dx / n) * 3.2;
  const bz = f.leader.z - (f.leader.dz / n) * 3.2;
  const s = 2.1 * k;   // demi-taille : l'emblème tient dans le ruban d'encre
  paintCtx.save();
  if (paintClip) paintCtx.clip(paintClip);
  paintCtx.globalCompositeOperation = 'source-atop';
  paintCtx.globalAlpha = 0.42;
  paintCtx.translate(bx * k + half, bz * k + half);
  paintCtx.rotate((Math.random() - 0.5) * 0.6);
  paintCtx.drawImage(t.iconStamp, -s, -s, s * 2, s * 2);
  paintCtx.restore();
  paintDirty = true;
}

function stampPaintAt(f, x, z, radiusScale = 1) {
  const half = PAINT_N / 2, k = PAINT_N / PAINT_SPAN;
  // Ruban liquide — Amazone / combo uniquement pour le Leader (radiusScale gère le reste)
  const rMult = (f.leaderKey === 'amazon' && radiusScale >= 1) ? 1.18 : 1.0;
  const streakWiden = (f.i === 0 && streak >= 3 && radiusScale >= 1)
    ? 1 + Math.min(0.5, (streak - 2) * 0.035)
    : 1;
  const r = PAINT_TRAIL_R * k * rMult * streakWiden * radiusScale;
  const cx = x * k + half, cz = z * k + half;
  const gx0 = Math.max(0, Math.floor(cx - r * 1.25)), gx1 = Math.min(PAINT_N - 1, Math.ceil(cx + r * 1.25));
  const gz0 = Math.max(0, Math.floor(cz - r * 1.25)), gz1 = Math.min(PAINT_N - 1, Math.ceil(cz + r * 1.25));
  const r2 = r * r;
  const kw = PAINT_SPAN / PAINT_N;
  /* La peinture COULE : elle gagne son niveau et tout ce qui est en dessous,
     jamais au-dessus. Une falaise arrête donc la couleur par le bas, et un
     sanctuaire perché arrose tout son versant. Sans cette règle, la teinture
     escaladait les plateaux et le relief ne pesait sur rien. */
  const srcY = groundY(x, z);

  let gridChanged = false;
  for (let gz = gz0; gz <= gz1; gz++) {
    for (let gx = gx0; gx <= gx1; gx++) {
      const dx = gx + 0.5 - cx, dz = gz + 0.5 - cz;
      if (dx * dx + dz * dz > r2 * 1.15) continue;
      const wx = (gx + 0.5 - half) * kw, wz = (gz + 0.5 - half) * kw;
      if (!isSolid(island, wx, wz)) continue;
      if (groundY(wx, wz) > srcY + 0.01) continue;
      const idx = gz * PAINT_N + gx;
      if (paintGrid[idx] === f.team) continue;
      const old = paintGrid[idx];
      if (old >= 0) paintCounts[old]--;
      paintGrid[idx] = f.team;
      paintCounts[f.team]++;
      gridChanged = true;
    }
  }
  if (gridChanged && f.i === 0 && radiusScale >= 1 && Math.random() < 0.25) {
    soundEngine.playSFX('paint_stamp');
  }

  if (gridChanged) {
    paintCtx.save();
    /* Même coupe que la grille : on n'éclabousse que son niveau et en dessous. */
    if (paintClipAtY(srcY)) paintCtx.clip(paintClipAtY(srcY));
    paintCtx.fillStyle = f.css;
    paintCtx.globalAlpha = 1;
    drawOrganicSplat(paintCtx, cx, cz, r);
    paintCtx.restore();
    paintNeedsClip = true;
    paintDirty = true;
  }
  return gridChanged;
}

function stampPaint(f) {
  return stampPaintAt(f, f.leader.x, f.leader.z, 1);
}
function paintOwnerAt(x, z) {
  const half = PAINT_N / 2, k = PAINT_N / PAINT_SPAN;
  const gx = (x * k + half) | 0, gz = (z * k + half) | 0;
  if (gx < 0 || gz < 0 || gx >= PAINT_N || gz >= PAINT_N) return -1;
  return paintGrid[gz * PAINT_N + gx];
}
_simCtx.paintOwnerAt = paintOwnerAt;

/* Contexte partagé du leader-tick — évite d'allouer un objet neuf chaque frame. */
const _leaderTickCtx = {
  leaderSpeed: null, aiThink: null,
  steerOnIsland, resolveIsland, isSolid, nearestSolidPoint,
  resolveBaseWalls, unstickIfInWall,
  skillMods: null,
};
const _leaderTickState = { factions: null, island: null, judgeR: 999, elapsed: 0 };
const _leaderTickInput = { x: 0, z: 0, keys: null };


/* Contexte partagé de la boucle crowd — set une fois, mis à jour par référence. */
const _crowdTickState = { agents: null, factions: null, island: null, elapsed: 0, bombs: null };
const _crowdTickCtx = {
  resolveIsland, isSolid, canStep, canJumpToward, steerOnIsland,
  islandApproachScore, islandPathBlocked, islandRandomPoint,
  finishConvert: null,   // défini plus tard (déclaration circulaire)
  stampPaintAt: null,
  setAgentColor: null,
  onFreed: () => { grayCount++; },
  crowdOf: null, slotOf: null, trimCrowdCounts: null,
  spawnSoulBurst: null, tone: null,
  onFollowerLostFaction: (a) => {
    releaseFollowerSlot(a);
    setAgentColor(a.id, GRAY);
    const cm = crowdOf(a.id), sl = slotOf(a.id);
    const m = new THREE.Matrix4();
    m.compose(
      new THREE.Vector3(a.x, 0, a.z),
      new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), a.face || 0),
      new THREE.Vector3(a.base, a.base, a.base),
    );
    cm.setMatrixAt(sl, m);
    cm.instanceMatrix.needsUpdate = true;
  },
  updateFollowerTransform: (a, mat, spd) => {
    if (a._followerSlot == null || !a._followerKey) return;
    const fm = followerMeshes[a._followerKey];
    if (!fm) return;
    fm.mesh.setMatrixAt(a._followerSlot, mat);
    fm.mesh.instanceMatrix.needsUpdate = true;
    if (fm.mesh.userData.anim) {
      fm.mesh.userData.anim.setY(a._followerSlot, spd);
      fm.mesh.userData.anim.needsUpdate = true;
    }
  },
  /* Pas de teinte de suivant : un esprit capturé garde la couleur de son
     élément, c'est elle qui dit à quel autel il peut servir. Sa teinte
     d'instance est posée à blanc une fois pour toutes (assignFollowerSlot). */
  tmpM, tmpQ, tmpS, tmpP, UP_AXIS, GRAY,
  /* Bascule « face au sol » des agents touchés par une attaque. */
  tmpQ2: new THREE.Quaternion(),
  SIDE_AXIS: new THREE.Vector3(1, 0, 0),
  _convCol: null,
};
function clearPaint() {
  paintGrid.fill(-1);
  paintCounts.fill(0);
  paintCtx.clearRect(0, 0, PAINT_N, PAINT_N);
  paintTex.needsUpdate = true;
  paintDirty = false;
}
function playerInfluencePct() {
  return Math.min(100, Math.round((paintCounts[0] / paintTotal) * 100));
}

/* ============================== L'anneau du Jugement ============================== */
const judgeMesh = new THREE.Mesh(
  new THREE.CylinderGeometry(1, 1, 7, 64, 1, true),
  new THREE.MeshBasicMaterial({ color: 0xff6a3d, transparent: true, opacity: 0.25, side: THREE.DoubleSide, depthWrite: false }));
judgeMesh.position.y = 3.5;
judgeMesh.visible = false;
scene.add(judgeMesh);

/* ============================== Extase ============================== */
function triggerEcstasy() {
  ecstasyT = ECSTASY_DUR;
  fervor = 0;
  banner('✨ EXTASE ! Votre parole embrase la vallée !');
  shake = Math.max(shake, 0.4);
  spawnShock(factions[0].leader.x, factions[0].leader.z, new THREE.Color(0xffe259), 14, 0.9);
  [523, 659, 784, 988, 1319].forEach((fq, k) => tone(fq, 0.5, 'triangle', 0.06, k * 0.06));
}

/* ============================== Audio ============================== */
let lastPop = 0;
let _audioReady = false;
function audioInit() {
  if (_audioReady) {
    soundEngine.ensureContext();
    return;
  }
  _audioReady = true;
  soundEngine.init();
  soundEngine.bindUIClicks();
  soundEngine.ensureContext();
  const unlock = () => {
    soundEngine.ensureContext();
    window.removeEventListener('pointerdown', unlock);
    window.removeEventListener('keydown', unlock);
  };
  window.addEventListener('pointerdown', unlock, { once: true });
  window.addEventListener('keydown', unlock, { once: true });
}
function tone() {}

function sfxPop() {}
function sfxKill() {}
function sfxDeath() {
  soundEngine.playSFX('defeat', { volume: 0.72 });
}
function sfxRankUp() {}

/* ============================== HUD ============================== */
const $ = (id) => document.getElementById(id);
const lbEl = null, rankEl = $('rank-val'), bannerEl = $('banner');
const streakEl = $('streak');
const duelEl = $('duel');
const pctValEl = $('pct-val');
const timeValEl = $('time-val');
const netBtnEl = $('net-btn');
const netCdEl = netBtnEl && netBtnEl.querySelector('.net-cd');
const boostBtn = $('boost-btn'), boostOverlay = $('boost-cooldown-overlay');
/* Boule de verre : niveau de peinture. N'écrit dans le DOM que si le % change. */
let fervorPct = -1;

/* ---- Course au territoire (bord gauche) ----
   Une jauge 0 → WIN_PCT le long de laquelle chaque culte est posé à sa part de
   vallée. Le rang se lit à la position, le chiffre dans le cadre le confirme.
   Le culte du joueur passe toujours devant les autres. */
const raceEl = $('hud-race');
const raceGoalEl = raceEl && raceEl.querySelector('.race-goal');
const raceMarks = new Map();   // index de faction → élément, réutilisé entre frames
let raceSig = '';

/* Chaque cadre est posé à sa hauteur de progression réelle, sans correction :
   à égalité ils se superposent, et c'est voulu. En début de partie les trois
   cultes sont à zéro, donc empilés au pied de la jauge — seul celui du joueur
   est apparent, les autres se dévoilent au fur et à mesure qu'ils décollent.
   L'ordre de profondeur suit le rang : le meneur devant les suiveurs, le joueur
   devant tout le monde. */

function updateRaceUI() {
  if (!raceEl) return;

  const rows = factions
    .map((f) => ({
      i: f.i,
      key: f.leaderKey || 'monk',
      css: f.css || '#7cf',
      name: (f.cult && f.cult.name) || 'Culte',
      alive: !!f.alive,
      done: paintPct(f),
      p: Math.max(0, Math.min(1, paintPct(f) / WIN_PCT)),
    }))
    .sort((a, b) => b.done - a.done || a.i - b.i);

  const sig = rows.map((r) => `${r.i}:${r.done.toFixed(1)}:${r.alive ? 1 : 0}`).join('|');
  if (sig === raceSig) return;
  raceSig = sig;

  if (raceGoalEl) raceGoalEl.textContent = `🏁 ${WIN_PCT}%`;

  for (const [i, el] of raceMarks) {
    if (!factions.some((f) => f.i === i)) { el.remove(); raceMarks.delete(i); }
  }

  for (let n = 0; n < rows.length; n++) {
    const r = rows[n];
    let el = raceMarks.get(r.i);
    if (!el) {
      el = document.createElement('div');
      el.className = 'race-mark';
      const img = document.createElement('img');
      img.alt = '';
      img.draggable = false;
      const rank = document.createElement('span');
      rank.className = 'race-rank';
      el.append(img, rank);
      raceEl.appendChild(el);
      raceMarks.set(r.i, el);
    }

    const src = LEADER_AVATARS[r.key] || LEADER_AVATARS.monk;
    const img = el.querySelector('img');
    if (!img.getAttribute('src') || !img.getAttribute('src').endsWith(src)) img.src = src;

    el.style.setProperty('--p', String(r.p));
    el.style.setProperty('--race-ring', r.css);
    /* Le meneur passe devant les suiveurs ; le joueur garde son z-index CSS. */
    el.style.zIndex = r.i === 0 ? '' : String(2 + (rows.length - n));
    el.classList.toggle('me', r.i === 0);
    el.classList.toggle('lead', n === 0 && r.done > 0);
    el.classList.toggle('dead', !r.alive);
    el.querySelector('.race-rank').textContent = String(n + 1);
    el.title = `${r.i === 0 ? 'Votre culte' : 'Culte ' + r.name} — ${n + 1}ᵉ, ${r.done.toFixed(1)} % de la vallée`;
  }

  /* Le cadre du joueur repasse en dernier enfant : il gagne alors la pile même
     si un rival partage son z-index, quel que soit l'ordre de création. */
  const mine = raceMarks.get(0);
  if (mine && mine !== raceEl.lastElementChild) raceEl.appendChild(mine);
}

/* ---- Cycle jour/nuit : l'horloge silencieuse de la partie ----
   t = 0 aube pénombre → plein jour → 1 soirée. 2 minutes = une journée.
   Exposition, soleil, hémisphère et brouillard racontent l'heure sans HUD. */
/* Expositions calibrées pour NeutralToneMapping (voir le réglage du renderer).
   Elles valent ~0,62× les anciennes, qui compensaient le facteur 1/0,6 caché
   dans ACES. Repère : `exp` 1.0 = restitution neutre, la texture sort à l'écran
   telle qu'elle est peinte. */
const DAY_KEYS = [
  { t: 0.00, exp: 0.34, sun: 0xffb078, sunI: 0.55, hemiI: 0.42, fogK: 0.55 },  // aube — pénombre chaude
  { t: 0.08, exp: 0.44, sun: 0xffc090, sunI: 0.78, hemiI: 0.55, fogK: 0.65 },  // premier soleil
  { t: 0.18, exp: 0.58, sun: 0xffe0b8, sunI: 1.05, hemiI: 0.72, fogK: 0.80 },  // matin
  { t: 0.32, exp: 0.72, sun: 0xfff4e0, sunI: 1.40, hemiI: 0.90, fogK: 0.95 },  // montée
  { t: 0.48, exp: 0.78, sun: 0xfff8ea, sunI: 1.65, hemiI: 0.98, fogK: 1.00 },  // plein jour
  { t: 0.68, exp: 0.75, sun: 0xfff0d8, sunI: 1.45, hemiI: 0.92, fogK: 0.96 },  // après-midi
  { t: 0.82, exp: 0.61, sun: 0xffb888, sunI: 1.05, hemiI: 0.70, fogK: 0.78 },  // doré du soir
  { t: 0.92, exp: 0.44, sun: 0xc078a8, sunI: 0.70, hemiI: 0.48, fogK: 0.58 },  // crépuscule
  { t: 1.00, exp: 0.31, sun: 0x6a78c0, sunI: 0.42, hemiI: 0.36, fogK: 0.45 },  // soir — fin de partie
];
const fogBase = new THREE.Color(0x9fdcff);
let fogBaseNear = 70;
let fogBaseFar = 165;
function captureDayBase() {
  if (scene.fog) {
    fogBase.copy(scene.fog.color);
    fogBaseNear = scene.fog.near;
    fogBaseFar = scene.fog.far;
  }
}
const _dayCol = new THREE.Color();
let nightK = 0;   // 0 = plein jour, 1 = obscurité maximale
/* Heure figée de la vallée : plein jour légèrement décalé vers l'après-midi. */
const DAY_FIXED = 0.42;

function applyDayCycle(t) {
  t = Math.min(1, Math.max(0, t));
  let a = DAY_KEYS[0], b = DAY_KEYS[DAY_KEYS.length - 1];
  for (let i = 0; i < DAY_KEYS.length - 1; i++) {
    if (t >= DAY_KEYS[i].t && t <= DAY_KEYS[i + 1].t) { a = DAY_KEYS[i]; b = DAY_KEYS[i + 1]; break; }
  }
  const k = (t - a.t) / Math.max(1e-5, b.t - a.t);
  let exp = a.exp + (b.exp - a.exp) * k;
  let sunI = a.sunI + (b.sunI - a.sunI) * k;
  let hemiI = a.hemiI + (b.hemiI - a.hemiI) * k;
  let fogK = a.fogK + (b.fogK - a.fogK) * k;

  /* ---- « Nuit sans lune » (carte hasard) ----
     TOUT s'éteint : les tuiles, mais aussi le ciel, l'abîme et les personnages.
     Seule reste la lanterne du joueur (voir la fin de updateWorld).

     Éteindre par les seules lumières ne suffisait pas, et c'est ce qui faisait
     échouer l'effet — trois choses y échappent complètement :
       · le FOND est une texture d'environnement, pas un objet éclairé. On le
         baisse par `backgroundIntensity` ;
       · le VIDE (poussière, halo bas) est peint par un shader qui n'inclut ni
         éclairage ni tone mapping. Il a son propre crochet, `setVoidDim` ;
       · les PERSONNAGES vivent sur leur propre couche, éclairée par charSun /
         charHemi, que le cycle du jour ne touche jamais. Sans les baisser, tous
         les Leaders de la carte restaient en plein jour.

     Fondu de 0,9 s aux deux bouts : une bascule sèche se lit comme un plantage
     d'affichage. */
  const BO_FADE = 0.9;
  const boIn = (worldMods.blackoutMax || 0) - worldMods.blackoutT;   // temps écoulé depuis le début
  /* Conditionné à l'état « play » : une partie qui se termine en pleine nuit
     laisserait sinon le menu dans le noir jusqu'à la partie suivante. */
  const bo = (state === 'play' && worldMods.blackoutT > 0)
    ? Math.max(0, Math.min(1, boIn / BO_FADE, worldMods.blackoutT / BO_FADE))
    : 0;
  if (bo > 0) {
    exp *= 1 - 0.60 * bo;
    sunI *= 1 - 0.94 * bo;
    hemiI *= 1 - 0.92 * bo;
    fogK *= 1 - 0.92 * bo;
    if (scene.fog) {
      scene.fog.near = 4 + (fogBaseNear - 4) * (1 - bo);
      scene.fog.far = 22 + (fogBaseFar - 22) * (1 - bo);
    }
  } else if (scene.fog) {
    scene.fog.near = fogBaseNear;
    scene.fog.far = fogBaseFar;
  }
  /* Fond, vide et personnages. Écrits à chaque image plutôt qu'aux transitions :
     le fond est reconstruit à chaque changement de biome, et une valeur posée
     une seule fois serait perdue au chargement de la carte suivante. */
  scene.backgroundIntensity = 1 - 0.93 * bo;
  setVoidDim(0.95 * bo);
  charSun.intensity = CHAR_SUN_I * (1 - 0.93 * bo);
  charHemi.intensity = CHAR_HEMI_I * (1 - 0.9 * bo);

  renderer.toneMappingExposure = exp * TUNE.exposure;
  /* Bornes calées sur DAY_KEYS : plein jour 0.78, plus sombre 0.31. Elles ont
     suivi le passage à NeutralToneMapping — laissées à l'ancienne échelle,
     `nightK` serait resté collé à 1 et tout ce qui s'allume à la nuit (lampes,
     fenêtres) serait resté allumé en plein midi. */
  nightK = Math.min(1, Math.max(0, (0.78 - exp) / (0.78 - 0.31)));
  sun.intensity = sunI * TUNE.sun;
  sun.color.set(a.sun).lerp(_dayCol.set(b.sun), k);
  hemi.intensity = hemiI * TUNE.hemi;
  if (scene.fog) scene.fog.color.copy(fogBase).multiplyScalar(fogK);
}

/* Pas de lampe pour les rivaux pendant la nuit noire : ils restent dans le
   noir, et c'est tout l'enjeu de la carte — on ne sait plus où ils sont, on ne
   les découvre qu'en entrant dans leur zone ou en lisant leur peinture au sol.
   Une lampe par Leader annulait l'effet : la vallée s'éteignait, mais six
   projecteurs continuaient à désigner tout le monde.
   La seule source restante est la lanterne du joueur (voir updateWorld). */
/* Cadran du Boost : le tir étant automatique, le seul bouton restant est le
   sprint. Sa recharge est fixe, donc le cadran se lit toujours pareil. */
let playerBoostCharge = 1.0;
let lastAtkPct = -1;
function updateAttackUI() {
  if (!boostBtn || !boostOverlay) return;
  const pct = Math.round(playerBoostCharge * 100);
  if (pct === lastAtkPct) return;
  lastAtkPct = pct;
  boostOverlay.style.setProperty('--cooldown-deg', Math.round((1 - playerBoostCharge) * 360) + 'deg');
  boostBtn.classList.toggle('ready', pct >= 100);
}

/* Sprint. Aucun coût en croyants et aucun palier de compétence : juste une
   recharge. C'est l'outil d'esquive face aux météorites. */
function doBoost(f) {
  if (!f || !f.alive) return;
  /* Hub Overworld : exactement le même boost qu'en partie (même durée, même
     multiplicateur, même inertie), mais sans charge à remplir ni cooldown —
     on explore, il n'y a rien à rationner. Relançable même en pleine poussée. */
  if (state === 'overworld') {
    f.boostT = BOOST_DUR;
    soundEngine.playSFX('boost');
    return;
  }
  if (f.boostT > 0) return;
  if (f.i === 0) {
    if (playerBoostCharge < 1.0) return;
    playerBoostCharge = 0.0;
    soundEngine.playSFX('boost');
  } else {
    if ((f.boostCd || 0) > 0) return;
    f.boostCd = BOOST_CD;
  }
  f.boostT = BOOST_DUR;
}
let bannerQ = [], bannerT = 0;
function banner(msg) { bannerQ.push(msg); }
function updateBanner(dt) {
  bannerT -= dt;
  if (bannerT <= 0) {
    if (bannerQ.length) {
      bannerEl.textContent = bannerQ.shift();
      bannerEl.classList.add('show');
      bannerT = 2.4;
    } else bannerEl.classList.remove('show');
  }
}
/* La série change vite : on n'écrit dans le DOM que quand la valeur bouge. */
let streakAffiche = -1;
function showStreak() {
  if (streak === streakAffiche) return;
  streakAffiche = streak;
  if (streak < 2) { streakEl.classList.remove('show'); return; }
  streakEl.textContent = `×${streak}`;
  streakEl.classList.add('show', 'pulse');
  setTimeout(() => streakEl.classList.remove('pulse'), 120);
}

function updateHUD() {
  if (typeof teams === 'undefined' || teams.length === 0) return;

  /* -- Multi : rang/couverture depuis le classement réseau (hôte authoritatif).
        Sans ça, chaque client calcule sur SA propre texture de peinture — chacun
        se voit 1er car il peint sur son écran ce que l'autre peint sur le sien. -- */
  let rank = 1, pct = 0;
  if (multiMode && net.state.connected) {
    const list = net.getLeaderList();
    if (list && list.length) {
      const myIdx = list.findIndex((l) => net.isMe(l.sessionId));
      if (myIdx >= 0) {
        rank = myIdx + 1;
        pct = list[myIdx].pct || 0;
      }
    } else {
      const local = factionScore(factions[0]);
      pct = local.pct;
    }
  } else {
    const sorted = factions.map(f => ({
      ...factionScore(f),
      t: teams[f.team],
      isPlayer: f.i === 0,
    })).sort((a, b) => b.total - a.total);
    const mine = sorted.find(st => st.isPlayer);
    if (!mine) return;
    rank = sorted.indexOf(mine) + 1;
    pct = mine.pct;
  }
  rankEl.textContent = `${rank}ᵉ`;
  pctValEl.textContent = `${pct.toFixed(1)}%`;
  const depositValEl = $('deposit-val');
  if (depositValEl) {
    const me = factions[0];
    depositValEl.textContent = `${paintPct(me).toFixed(0)}/${WIN_PCT}%`;
  }
  /* Chrono : la seconde sortie de partie doit se lire en permanence. */
  if (timeValEl) {
    const left = Math.max(0, MATCH_DUR - elapsed);
    const m = Math.floor(left / 60), sec = Math.floor(left % 60);
    timeValEl.textContent = `${m}:${String(sec).padStart(2, '0')}`;
    timeValEl.classList.toggle('urgent', left < 30);
  }

  if (rank < lastRank) { sfxRankUp(); rankEl.classList.add('pulse'); setTimeout(() => rankEl.classList.remove('pulse'), 220); }
  lastRank = rank;
}

/* ============================== Mini-map ============================== */
const mapCv = $('map'), mctx = mapCv.getContext('2d');
const GRAY_CSS = 'rgba(230,236,245,.85)';
let miniGrad = null, miniGradW = 0;
function drawMinimap() {
  if (!mapCv || !mctx) return;
  const W = mapCv.width, c = W / 2, k = W / 150, s = (c - 6 * k) / MAP_R;
  mctx.clearRect(0, 0, W, W);

  // --- Disque de fond façon radar (clip circulaire) ---
  mctx.save();
  mctx.beginPath(); mctx.arc(c, c, c - 2 * k, 0, 7); mctx.clip();

  if (!miniGrad || miniGradW !== W) {
    const g = mctx.createRadialGradient(c, c, 0, c, c, c);
    g.addColorStop(0, 'rgba(36,58,92,.98)');
    g.addColorStop(0.55, 'rgba(18,32,58,.98)');
    g.addColorStop(1, 'rgba(8,14,28,.99)');
    miniGrad = g; miniGradW = W;
  }
  mctx.fillStyle = miniGrad; mctx.fillRect(0, 0, W, W);

  /* --- Territoire : chaque tuile prend la couleur du culte qui la peint
         MAJORITAIREMENT. Une tuile disputée ou à peine effleurée reste neutre,
         si bien que la minimap dit qui tient quoi au lieu de refléter chaque
         éclaboussure — c'est une carte, pas une réduction de l'écran. --- */
  if (island) {
    const hr = HEX_R * s;
    mctx.strokeStyle = 'rgba(170,210,255,.42)';
    mctx.lineWidth = 1.1 * k;

    /* Comptage : un seul parcours de la grille de peinture, réparti sur les
       tuiles via la table pré-calculée. */
    /* 8 emplacements comme paintCounts, et non NB_FACTIONS : en multi le
       nombre de cultes d'une partie n'est pas celui de la constante, et une
       couleur au-delà de la borne serait silencieusement ignorée. */
    const nT = island.tiles.length;
    if (!_tileTally || _tileTally.length < nT * PAINT_SLOTS) {
      _tileTally = new Int32Array(nT * PAINT_SLOTS);
    } else {
      _tileTally.fill(0);
    }
    if (_cellTile) {
      for (let i = 0; i < _cellTile.length; i++) {
        const ti = _cellTile[i];
        if (ti < 0) continue;
        const o = paintGrid[i];
        if (o < 0 || o >= PAINT_SLOTS) continue;
        _tileTally[ti * PAINT_SLOTS + o]++;
      }
    }

    for (let ti = 0; ti < nT; ti++) {
      const t = island.tiles[ti];
      const tx = c + t.x * s, tz = c + t.z * s;
      mctx.beginPath();
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2;
        const px = tx + Math.cos(a) * hr, pz = tz + Math.sin(a) * hr;
        if (i === 0) mctx.moveTo(px, pz); else mctx.lineTo(px, pz);
      }
      mctx.closePath();

      /* Majorité stricte : plus de la moitié des cellules de la tuile. */
      let best = -1, bestN = 0;
      if (_cellTile) {
        for (let o = 0; o < PAINT_SLOTS; o++) {
          const v = _tileTally[ti * PAINT_SLOTS + o];
          if (v > bestN) { bestN = v; best = o; }
        }
      }
      const cells = _tileCells ? _tileCells[ti] : 0;
      const owned = best >= 0 && cells > 0 && bestN * 2 > cells && factions[best];

      mctx.fillStyle = owned ? factions[best].css : 'rgba(130,185,235,.38)';
      mctx.globalAlpha = owned ? 0.88 : 1;
      mctx.fill();
      mctx.globalAlpha = 1;
      mctx.stroke();
    }
  }

  // balayage radar (léger, tournant)
  const sweep = (elapsed * 0.8) % (Math.PI * 2);
  const sg = mctx.createRadialGradient(c, c, 0, c, c, c);
  sg.addColorStop(0, 'rgba(160,220,255,.22)');
  sg.addColorStop(1, 'rgba(130,200,255,0)');
  mctx.fillStyle = sg;
  mctx.beginPath(); mctx.moveTo(c, c); mctx.arc(c, c, c, sweep, sweep + 0.55); mctx.closePath(); mctx.fill();

  // --- Cristaux-bombes : losanges cyan pulsants, visibles de tous ---
  for (const b of bombs) {
    const x = c + b.x * s, z = c + b.z * s;
    const pu = 3.6 + Math.sin(elapsed * 5 + b.bob) * 1.2;
    mctx.save();
    mctx.translate(x, z);
    mctx.rotate(Math.PI / 4);
    mctx.fillStyle = '#b8f0ff';
    mctx.shadowColor = '#8fe0ff'; mctx.shadowBlur = 8 * k;
    mctx.fillRect(-pu * k / 2, -pu * k / 2, pu * k, pu * k);
    mctx.restore();
  }
  // --- Orage : disque bleuté qui avance ---
  if (storm) {
    mctx.beginPath();
    mctx.arc(c + storm.x * s, c + storm.z * s, 5.2 * s, 0, 7);
    mctx.fillStyle = 'rgba(140,175,240,.45)';
    mctx.strokeStyle = 'rgba(190,220,255,.75)';
    mctx.lineWidth = 1.2 * k;
    mctx.fill(); mctx.stroke();
  }

  // --- Leaders : pastilles lumineuses ---
  for (const f of factions) {
    if (!f.alive) continue;
    const x = c + f.leader.x * s, z = c + f.leader.z * s;
    const me = f.i === 0;
    mctx.beginPath(); mctx.arc(x, z, (me ? 6.2 : 4.6) * k, 0, 7);
    mctx.fillStyle = f.css;
    mctx.shadowColor = f.css; mctx.shadowBlur = (me ? 12 : 7) * k;
    mctx.fill();
    mctx.shadowBlur = 0;
    mctx.lineWidth = 1.8 * k; mctx.strokeStyle = '#fff'; mctx.stroke();
  }
  // anneau pulsant autour de notre Leader
  const meF = factions[0];
  if (meF && meF.alive) {
    const x = c + meF.leader.x * s, z = c + meF.leader.z * s;
    const pulse = 0.5 + 0.5 * Math.sin(elapsed * 4);
    mctx.beginPath(); mctx.arc(x, z, (8 + pulse * 3.5) * k, 0, 7);
    mctx.strokeStyle = `rgba(255,255,255,${0.55 - pulse * 0.28})`;
    mctx.lineWidth = 1.6 * k; mctx.stroke();
  }
  mctx.restore();

  // --- Bordures extérieures (double anneau) ---
  mctx.beginPath(); mctx.arc(c, c, c - 4.5 * k, 0, 7);
  mctx.lineWidth = 1.2 * k; mctx.strokeStyle = 'rgba(160,210,255,.55)'; mctx.stroke();
  mctx.beginPath(); mctx.arc(c, c, c - 2 * k, 0, 7);
  mctx.lineWidth = 2.8 * k; mctx.strokeStyle = 'rgba(255,255,255,.7)'; mctx.stroke();
}

/* ============================== Contrôles ============================== */
const input = { x: 0, z: 0 };
const keys = {};
addEventListener('keydown', e => {
  if (e.code === 'Space') {
    e.preventDefault();
    // Espace = boost, en partie COMME dans le Hub. L'interaction du Hub est sur
    // E : lui laisser Espace revenait à supprimer le boost à l'exploration.
    if (!keys.Space && (state === 'play' || state === 'overworld')) doBoost(factions[0]);
  }
  /* Touches déjà prises : Espace (boost), E et F (pouvoirs), WASD et flèches
     (déplacement, voir playerDir). Le filet prend KeyQ — code physique, donc la
     touche voisine du déplacement aussi bien en QWERTY qu'en AZERTY. */
  if (e.code === 'KeyQ' && !keys.KeyQ && state === 'play') {
    playerAttack();
  }
  keys[e.code] = true;
});
addEventListener('keyup', (e) => {
  keys[e.code] = false;
});

const joyEl = $('joy'), stickEl = $('stick');
let joyId = null, joyOx = 0, joyOy = 0;
let lastTap = 0;
function onDown(e) {
  audioInit();
  // Le Hub se pilote comme une partie : même joystick, même double-tap.
  if (state !== 'play' && state !== 'overworld') return;
  if (e.target.closest('button') || e.target.closest('#hud-top-bar')) return;

  // double-tap sur l'écran = sprint, sans occuper de bouton au pouce
  const now = performance.now();
  if (now - lastTap < 300) doBoost(factions[0]);
  lastTap = now;

  if (joyId !== null) return;
  joyId = e.pointerId; joyOx = e.clientX; joyOy = e.clientY;
  joyEl.style.display = 'block';
  joyEl.style.left = (joyOx - 55) + 'px';
  joyEl.style.top = (joyOy - 55) + 'px';
  stickEl.style.transform = 'translate(0,0)';
}
function onMove(e) {
  if (e.pointerId !== joyId) return;
  let dx = e.clientX - joyOx, dy = e.clientY - joyOy;
  const len = Math.hypot(dx, dy);
  const cl = Math.min(len, 48);
  if (len > 0) { dx /= len; dy /= len; }
  stickEl.style.transform = `translate(${dx * cl}px,${dy * cl}px)`;
  const dead = Math.min(1, Math.max(0, (len - 8) / 34));
  input.x = dx * dead; input.z = dy * dead;
}
function onUp(e) {
  if (e.pointerId !== joyId) return;
  joyId = null; joyEl.style.display = 'none';
  input.x = 0; input.z = 0;
}
addEventListener('pointerdown', onDown);
addEventListener('pointermove', onMove);
addEventListener('pointerup', onUp);
addEventListener('pointercancel', onUp);

boostBtn.addEventListener('pointerdown', (e) => {
  e.stopPropagation();
  // Dans le Hub : poussée d'élan, relançable sans limite.
  doBoost(factions[0]);
});

/* Manette Xbox : mêmes actions que le tactile, branchées sur les mêmes fonctions.
   Le polling se fait dans frame() (la Gamepad API n'émet pas d'événements). */
initGamepad({
  input,
  getState: () => state,
  isTouchActive: () => joyId !== null,
  onBoost: () => { audioInit(); if (state === 'play') doBoost(factions[0]); },
  onAttack: () => {
    if (state !== 'play') return false;
    audioInit();
    const fired = playerAttack();
    if (fired && netBtnEl) {
      netBtnEl.classList.add('swinging');
      setTimeout(() => netBtnEl.classList.remove('swinging'), 160);
    }
    return fired;
  },
});

/* Attaque : un appui = un tir. pointerdown plutôt que click — sur tactile,
   attendre le click coûterait ~120 ms sur l'action centrale du jeu. */
if (netBtnEl) {
  netBtnEl.addEventListener('pointerdown', (e) => {
    e.stopPropagation();
    e.preventDefault();
    if (state !== 'play') return;
    if (playerAttack()) {
      netBtnEl.classList.add('swinging');
      setTimeout(() => netBtnEl.classList.remove('swinging'), 160);
    }
  });
}

/* ============================== IA ==============================
   IA utilitaire : chaque bot poursuit exactement le même score que le joueur
   et arbitre en continu entre trois envies —
   · RECHARGER : chasser un gris (le carburant, sans lequel rien ne se peint) ;
   · ÉTENDRE   : aller peindre là où ça rapporte (neutre OU couleur adverse) ;
   · RAIDER    : viser spécifiquement la couleur du rival en tête pour le faire
                 reculer, d'autant plus fort que la fin approche.
   Un gris qui passe à portée est toujours croqué au passage (chasser ET
   peindre en même temps). La difficulté joue sur la cadence de réflexion, la
   qualité d'échantillonnage et le bruit de décision — jamais sur des stats
   cachées : les bots obéissent aux mêmes règles que le joueur. */

/* Contexte partagé pour l'IA — recréé une seule fois, ses champs pointent
   sur les valeurs vivantes (agents, factions, etc. sont let/const stables). */
/* ---- Objectif d'un bot : chasser puis livrer ----
   L'IA d'origine arbitrait entre cristaux, expansion et raids — trois notions
   qui n'existent plus. Sans ça les bots erraient sans jamais toucher un autel.

   La décision tient en une question : « ai-je déjà de quoi prendre un
   sanctuaire ? ». Si oui on y va, sinon on chasse l'élément qui en rapproche le
   plus. On vise le manque le plus petit, pas l'autel le plus proche : c'est ce
   qui fait converger le bot vers un objectif au lieu de papillonner. */
const _botCarry = new Int32Array(9);

function botAltarGoal(f) {
  if (!f || !altars.length) return null;

  _botCarry.fill(0);
  for (const ag of agents) {
    if (!ag || ag.dead || (ag.followerOf ?? -1) !== f.i) continue;
    const v = variantOf(ag.id);
    if (v >= ELEM_FIRST) _botCarry[v]++;
  }

  /* a) Un sanctuaire à portée de bourse : on livre. */
  let goAltar = null, goD = Infinity;
  for (const al of altars) {
    if (al.owner === f.i) continue;
    if (_botCarry[al.variant] < al.need - al.filled) continue;
    const d = Math.hypot(al.x - f.leader.x, al.z - f.leader.z);
    if (d < goD) { goD = d; goAltar = al; }
  }
  if (goAltar) return { mode: 'altar', pt: { x: goAltar.x, z: goAltar.z } };

  /* b) Sinon : quel élément me rapproche le plus d'une prise ? On pondère le
        manque par la distance, sinon le bot traverse la carte pour un autel à
        peine moins cher que celui qu'il a sous le nez. */
  let wantVar = -1, bestCost = Infinity;
  for (const al of altars) {
    if (al.owner === f.i) continue;
    const manque = (al.need - al.filled) - _botCarry[al.variant];
    if (manque <= 0) continue;
    const d = Math.hypot(al.x - f.leader.x, al.z - f.leader.z);
    const cost = manque * 12 + d;
    if (cost < bestCost) { bestCost = cost; wantVar = al.variant; }
  }

  /* c) Cap sur l'esprit voulu. À défaut, n'importe quel esprit libre fera
        l'affaire — il servira forcément à un autel tôt ou tard.

     On ne prend PAS bêtement le plus proche : un esprit fuit, et celui qui est
     déjà collé à un rival est perdu d'avance. Le coût mélange donc la distance,
     la direction de fuite (courir derrière un fuyard coûte plus cher que le
     couper), et la concurrence. Un esprit banni (poursuite qui n'aboutissait
     pas, cf. anti-blocage) est ignoré le temps du bannissement. */
  const banned = (f._banT || 0) > elapsed ? f._banSpirit : null;

  let best = null, bestScore = Infinity;
  for (const ag of agents) {
    if (!ag || ag.dead || ag === banned) continue;
    const v = variantOf(ag.id);
    if (v < ELEM_FIRST) continue;
    if ((ag.followerOf ?? -1) === f.i) continue;
    if (ag._dive != null && !(ag.downT > 0)) continue;

    const dx = ag.x - f.leader.x, dz = ag.z - f.leader.z;
    const d = Math.hypot(dx, dz) || 1e-3;

    /* Fuyard : si sa vitesse pointe à l'opposé de nous, la poursuite s'allonge. */
    const flee = (ag.vx || 0) * (dx / d) + (ag.vz || 0) * (dz / d);
    let cost = d + Math.max(0, flee) * 2.2;

    /* Concurrence : un rival plus près l'aura avant nous. */
    for (const o of factions) {
      if (!o || !o.alive || o === f || !o.leader) continue;
      const od = Math.hypot(ag.x - o.leader.x, ag.z - o.leader.z);
      if (od < d) cost += (d - od) * 1.4;
    }

    const wanted = v === wantVar;
    if (!wanted) cost += 26;                      // utile, mais pas prioritaire
    if ((ag.followerOf ?? -1) >= 0) cost += 10;   // vol possible, mais plus dur
    /* Un esprit à terre ne fuit plus : c'est une prise offerte, et elle
       expire. Un bot qui l'ignorerait pour courir après un fuyard jouerait
       nettement moins bien qu'un joueur. */
    if (ag.downT > 0) cost -= 40;

    if (cost < bestScore) { bestScore = cost; best = ag; }
  }

  if (best) return { mode: 'hunt', pt: aimAhead(f, best), spirit: best };

  /* d) Aucun esprit disponible : plutôt que de rendre la main à l'ancienne IA
        (cristaux/expansion, notions mortes) qui laissait le bot errer, on se
        poste près de l'autel le moins cher — c'est là que la partie se joue et
        que les esprits repopulent. Un bot n'est donc JAMAIS sans objectif. */
  let post = null, postCost = Infinity;
  for (const al of altars) {
    if (al.owner === f.i) continue;
    const c = (al.need - al.filled) * 8 + Math.hypot(al.x - f.leader.x, al.z - f.leader.z);
    if (c < postCost) { postCost = c; post = al; }
  }
  if (!post) return null;
  const ang = (f.i * 2.1) + elapsed * 0.15;
  return {
    mode: 'roam',
    pt: { x: post.x + Math.cos(ang) * 9, z: post.z + Math.sin(ang) * 9 },
  };
}

/* Point d'interception : viser là où l'esprit SERA, pas où il est. Sans ça un
   bot court éternellement dans le dos d'un fuyard de vitesse comparable. */
function aimAhead(f, ag) {
  const d = Math.hypot(ag.x - f.leader.x, ag.z - f.leader.z);
  const sp = Math.max(1e-3, leaderSpeed(f));
  const lead = Math.min(1.1, d / sp);   // temps de vol estimé, borné
  return { x: ag.x + (ag.vx || 0) * lead, z: ag.z + (ag.vz || 0) * lead };
}

const _aiCtx = {
  agents: null, factions: null, bombs: null, island: null,
  altarGoal: botAltarGoal,
  paintGrid: null, PAINT_N, PAINT_SPAN,
  elapsed: 0, difficulty: 'normal',
  paintOwnerAt: null, factionScore: null, islandApproachScore: null,
  isSolid, nearestSolidPoint, doBoost: null,
};
function paintMixAround(x, z, r, myTeam) {
  _aiCtx.paintGrid = paintGrid;
  _aiCtx.island = island;
  return _paintMixAround(x, z, r, myTeam, _aiCtx);
}

function aiThink(f, dt) {
  _aiCtx.agents = agents;
  _aiCtx.factions = factions;
  _aiCtx.bombs = bombs;
  _aiCtx.island = island;
  _aiCtx.paintGrid = paintGrid;
  _aiCtx.elapsed = elapsed;
  _aiCtx.difficulty = f.aiDifficulty || currentDifficulty;
  _aiCtx.paintOwnerAt = paintOwnerAt;
  _aiCtx.factionScore = factionScore;
  _aiCtx.islandApproachScore = islandApproachScore;
  _aiCtx.doBoost = doBoost;
  _aiThink(f, dt, _aiCtx);
}

/* ============================== Grille spatiale ============================== */
const cells = new Map();
function cellKey(x, z) { return (((x + 128) / CELL) | 0) * 512 + (((z + 128) / CELL) | 0); }
/* Siège des habitations.

   Une maison sous siège appartient à un culte tant qu'il a plus d'agents autour
   d'elle que ses rivaux ; sa jauge avance à une cadence proportionnelle à cet
   avantage. Si un autre culte devient majoritaire, la jauge redescend d'abord
   avant de repartir dans son sens — pas de propriété partagée, pas de trois
   jauges parallèles, on reste lisible pour le joueur. */
const HOUSE_STRIDE = 2;    // cellules à visiter autour d'une maison (rayon 3.5 / CELL 1.7)
const _houseCounts = new Int16Array(16);   // Supporte jusqu'à 9 factions + marge
function updateHouses(dt) {
  if (import.meta.env.DEV) window.__houses = () => houses;
  if (!houses.length) return;
  for (const h of houses) {
    if (!h.alive) continue;
    /* 1. Sans foule, c'est le Leader lui-même qui assiège : il faut rester
       planté devant la porte, à découvert et à portée de tir des rivaux.
       Assiéger devient donc une vraie prise de risque. */
    _houseCounts.fill(0);
    let total = 0;
    for (const f of factions) {
      if (!f.alive) continue;
      const dx = f.leader.x - h.x, dz = f.leader.z - h.z;
      if (dx * dx + dz * dz > SIEGE_R2) continue;
      _houseCounts[f.team] = 1; // par équipe
      total++;
    }
    if (total === 0) continue;
    // 2. culte dominant : un seul assiégeant progresse, deux se neutralisent
    let dom = -1;
    for (let t = 0; t < 3; t++) if (_houseCounts[t]) { dom = t; break; }
    const edge = total === 1 ? 2 : 0;
    // 3. jauge : appartient au dominant, on redescend si un rival prend la main
    if (dom === h.siegeCult) {
      h.progress += dt * SIEGE_RATE * Math.min(8, edge);
    } else {
      h.progress -= dt * SIEGE_RATE * 3;   // reprise trois fois plus rapide qu'un siège solo
      if (h.progress <= 0) { h.siegeCult = dom; h.progress = 0; }
    }
    // 4. teinte visuelle : blanc = intacte, couleur du culte = complètement acquise
    if (h.siegeCult >= 0) {
      houseColor.copy(HOUSE_BASE).lerp(teams[h.siegeCult].color, Math.min(1, h.progress) * 0.85);
      h.mesh.setColorAt(h.slot, houseColor);
      h.mesh.instanceColor.needsUpdate = true;
    }
    // 5. un habitant se rend quand la jauge est pleine : il part en cristal
    while (h.progress >= 1 && h.alive) {
      h.progress -= 1;
      
      // Trouver le leader de l'équipe assiégeante le plus proche de la maison
      let sf = null;
      let minD = 1e9;
      for (const f of factions) {
        if (f.alive && f.team === h.siegeCult) {
          const d = Math.hypot(f.leader.x - h.x, f.leader.z - h.z);
          if (d < minD) { minD = d; sf = f; }
        }
      }
      
      if (sf && sf.alive) {
        const a = Math.random() * Math.PI * 2, r = 0.6 + Math.random() * 0.4;
        sf.count++; sf.everGrew = true;
        spawnSoulBurst(h.x + Math.cos(a) * r, h.z + Math.sin(a) * r, sf);
      }
      h.remaining--;
      if (h.remaining <= 0) {
        h.alive = false;
        h.mesh.setColorAt(h.slot, HOUSE_EMPTY);
        h.mesh.instanceColor.needsUpdate = true;
        /* Fouiller une maison jusqu'au bout rallie ses derniers occupants :
           la récompense de patience, il faut y rester planté. */
        if (sf && sf.alive) {
          gainBelievers(sf, 2);
          if (sf.i === 0) banner('🏚 Maison fouillée — +2 cristaux');
        }
        break;
      }
    }
  }
}

function rebuildGrid() {
  for (const arr of cells.values()) arr.length = 0;
  for (let i = 0; i < agents.length; i++) {
    const a = agents[i];
    const k = cellKey(a.x, a.z);
    let arr = cells.get(k);
    if (!arr) { arr = []; cells.set(k, arr); }
    arr.push(i);
  }
}

/* ============================== Init / Reset ============================== */
let playerCultIdx = 0;
let playerLeaderKey = 'monk';   // choix du perso jouable : cf. LEADERS
let conquest = null;   // contexte de partie lancée depuis la carte de conquête

/* ============================== MODE OVERWORLD 3D ============================== */
let overworldPortals = [];
let overworldSpirits = [];
let overworldVillagers = [];
let overworldCtx = null;
let activeOverworldTrigger = null;
let conquestPortalIdx = 0;

/** Nombre de zones (portails) du pays courant : une par province réelle. */
let OVERWORLD_ZONES = 8;

/* Allure de base dans le Hub : celle d'un Leader sans foule en partie (V_MAX),
   pour que le déplacement et le boost aient exactement le même toucher ici et
   en match. Le boost applique BOOST_MULT par-dessus, sans charge ni cooldown. */
const OVERWORLD_WALK_SPD = V_MAX;

/* Teinte de la peinture d'un portail non gagné : le même gris que les
   sceptiques de la foule, pour que « pas encore à moi » se lise pareil ici et
   en partie. */
const PORTAL_IDLE_PAINT = '#8c93a3';

/** Nombre de villageois qui peuplent le Hub. */
const HUB_VILLAGERS = 16;

/** Libellé de la touche d'interaction, selon la plateforme. */
const ACTION_HINT = IS_MOBILE ? 'Avancez pour entrer' : 'Avancez, ou E, pour entrer';

/** Portails de niveau indexés par id (hors autel / grand portail). */
let overworldZonePortals = [];

/**
 * Victoire en attente d'être célébrée au retour dans le Hub.
 * { portalIndex, spirits } — posé par endGame(), consommé par openOverworldHub().
 */
let pendingHubVictory = null;

/**
 * Trouve un point posé sur du sol solide dans la direction (dx,dz), en partant
 * du rayon voulu et en se rapprochant du centre si l'île est trouée à cet
 * endroit. Sans ça, portails et villageois flottent au-dessus du vide.
 */
function findSolidSpot(dx, dz, radius, clearance = 0) {
  const len = Math.hypot(dx, dz) || 1;
  const a0 = Math.atan2(dx, dz);

  /* Un point solide ne suffit pas pour un portail : il tient 4 unités de large
     et le joueur doit pouvoir le traverser. On exige donc que TOUT son
     empreinte tienne sur la terre ferme, sinon l'arche se retrouve à cheval sur
     un trou (le vide qu'on voyait sous l'arche). */
  /* `isSolid` tolère jusqu'à 4,4 du centre d'une tuile (filet anti-faux-vide aux
     jointures) alors qu'un hexagone n'en fait que 4,1 : s'en contenter laissait
     l'arche déborder légèrement dans le vide. Pour un placement on exige donc
     d'être franchement DANS la tuile. */
  const wellInside = (x, z) => {
    const t = tileAt(island, x, z);
    return !!t && Math.hypot(x - t.x, z - t.z) <= HEX_R * 0.92;
  };

  const fits = (x, z) => {
    if (!wellInside(x, z)) return false;
    if (clearance <= 0) return true;
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      if (!wellInside(x + Math.cos(a) * clearance, z + Math.sin(a) * clearance)) return false;
    }
    return true;
  };

  /* On balaie en rayon ET en angle : si la direction voulue tombe pile sur une
     brèche, glisser de quelques degrés de côté vaut mieux que se rabattre au
     centre, où tous les portails finiraient empilés. */
  for (let r = radius; r >= 4; r -= 1.2) {
    for (const da of [0, 0.12, -0.12, 0.25, -0.25, 0.4, -0.4]) {
      const a = a0 + da;
      const x = Math.sin(a) * r, z = Math.cos(a) * r;
      if (fits(x, z)) return { x, z };
    }
  }
  // Dernier recours : le meilleur point solide, quitte à renoncer au dégagement.
  for (let r = radius; r >= 3; r -= 1.2) {
    const x = Math.sin(a0) * r, z = Math.cos(a0) * r;
    if (isSolid(island, x, z)) return { x, z };
  }
  return { x: 0, z: 0 };
}

/** Repositionne un esprit sauvage sur une tuile solide, à l'écart du centre. */
function respawnWildSpirit(mesh) {
  const ang = Math.random() * Math.PI * 2;
  const p = findSolidSpot(Math.cos(ang), Math.sin(ang), 8 + Math.random() * 14);
  mesh.position.set(p.x, (groundY(p.x, p.z) || 0) + 1.2, p.z);
  mesh.userData.baseY = mesh.position.y;
}

/** Affiche (ou masque) l'invite contextuelle du Hub. */
function setOverworldPrompt(title, hint, locked = false) {
  const el = $('overworld-prompt');
  if (!el) return;
  if (!title) {
    el.classList.remove('show');
    return;
  }
  const html = `<span class="owp-title">${title}</span>`
    + (hint ? `<span class="owp-hint">${hint}</span>` : '');
  if (el.dataset.html !== html) {
    el.innerHTML = html;
    el.dataset.html = html;
  }
  el.classList.remove('hidden');
  el.classList.toggle('locked', locked);
  el.classList.add('show');
}

function openOverworldHub(ctx) {
  overworldCtx = ctx || overworldCtx;
  if (!overworldCtx) return;
  // Le Hub n'est pas une partie : on relâche le contexte de match précédent.
  conquest = null;
  state = 'overworld';

  // Purge des leaders/foules du match précédent : sans ça, les cultes rivaux
  // restent plantés dans le Hub à chaque retour de partie.
  for (const f of factions) if (f.grp) scene.remove(f.grp);
  factions = [];
  agents = [];

  $('start').classList.add('hidden');
  $('end').classList.add('hidden');
  $('hud').classList.remove('hidden');
  $('hud').classList.add('overworld-mode');
  boostBtn.classList.add('ready');   // sprint toujours disponible dans le Hub

  /* Aucune peinture dans le Hub. La nappe du match précédent restait affichée
     et donnait l'impression que le territoire se conquiert ici — or ce n'est
     qu'un choix de niveaux : la progression se lit sur les portails. */
  clearPaint();
  paintMesh.visible = false;

  OVERWORLD_ZONES = Math.max(1, overworldCtx.zonesCount || overworldCtx.regions?.length || 8);

  const iso = overworldCtx.world?.iso || 'FRA';
  const biomeKey = getBiomeForIso(iso);
  buildMap(biomeKey);

  const colorStr = overworldCtx.playerColor || overworldCtx.world?.color || '#ff2e7e';
  const hex = parseInt(colorStr.replace('#', ''), 16);
  const ci = CULTS.findIndex((c) => c.c === hex);
  if (ci >= 0) playerCultIdx = ci;

  // Leader unique du joueur
  const cultObj = CULTS[playerCultIdx] || CULTS[0];
  // On apparaît DEVANT l'autel, pas dedans : ses marches font ~4.3 de rayon.
  const spawn = findSolidSpot(0, 1, 8);
  const pLeader = createFaction(0, 0, cultObj, playerLeaderKey, spawn.x, spawn.z);
  pLeader.color = new THREE.Color(cultObj.c);
  pLeader.grp = makeLeaderGroup(cultObj, playerLeaderKey);
  pLeader.grp.position.set(spawn.x, groundY(spawn.x, spawn.z) || 0, spawn.z);
  pLeader.leader.spd = 0;
  // L'anneau d'influence et la bulle de bouclier appartiennent au match : dans
  // le Hub ils n'ont aucun sens et polluent le sol.
  if (pLeader.grp.userData.ring) pLeader.grp.userData.ring.visible = false;
  if (pLeader.grp.userData.shield) pLeader.grp.userData.shield.visible = false;
  scene.add(pLeader.grp);
  factions = [pLeader];
  agents = [pLeader.leader];

  overworldPortals = [];
  overworldSpirits = [];
  overworldVillagers = [];

  // 1. Autel Central des Compétences (0, 0)
  const altarMesh = createCentralAltarMesh();
  altarMesh.position.y = groundY(0, 0) || 0;
  scene.add(altarMesh);
  mapObjects.push(altarMesh);
  overworldPortals.push(altarMesh);

  // 2. Grand Portail de la Planète, adossé à l'autel
  // Assez loin pour ne pas chevaucher les marches de l'autel (rayon ~4.3).
  const gp = findSolidSpot(0, -1, 13, 3.6);   // arche dorée : 4,8 de large
  const planetPortalMesh = createGreatPlanetPortalMesh(gp.x, gp.z);
  planetPortalMesh.position.y = groundY(gp.x, gp.z) || 0;
  scene.add(planetPortalMesh);
  mapObjects.push(planetPortalMesh);
  overworldPortals.push(planetPortalMesh);

  // 3. Un portail par province du pays. Au-delà de PER_RING, on ouvre un
  //    nouvel anneau plus large : un seul arc deviendrait illisible sur les
  //    pays à 30 provinces.
  const zonesCount = OVERWORLD_ZONES;
  const PER_RING = 10;
  overworldZonePortals = [];

  // Si on rentre d'une victoire, on construit le portail conquis (et le suivant)
  // dans leur état d'AVANT, pour pouvoir jouer la transition sous les yeux du joueur.
  const vic = pendingHubVictory;
  const rewindIdx = vic && vic.replayPaint ? vic.portalIndex : -1;
  const nextIdx = vic && vic.replayUnlock ? vic.portalIndex + 1 : -1;

  for (let i = 0; i < zonesCount; i++) {
    const ring = Math.floor(i / PER_RING);
    const inRing = i % PER_RING;
    const ringSize = Math.min(PER_RING, zonesCount - ring * PER_RING);
    const radius = 20 + ring * 12;
    // Anneaux décalés d'un demi-pas : les portails du fond ne sont pas masqués
    // par ceux du premier rang.
    const ang = (inRing / ringSize) * Math.PI * 2 + (ring % 2 ? Math.PI / ringSize : 0);
    // L'île est tirée au sort : le rayon nominal peut tomber dans un trou ou
    // hors silhouette. On se rapproche du centre jusqu'à trouver du sol.
    // 3.2 de dégagement : la largeur de l'arche (3,9) plus de quoi la franchir.
    const spot = findSolidSpot(Math.sin(ang), Math.cos(ang), radius, 3.2);
    const px = spot.x, pz = spot.z;

    let pState = getCountryPortalState(iso, i);
    if (i === rewindIdx) pState = 'unlocked';
    else if (i === nextIdx && pState === 'unlocked') pState = 'locked';

    const pMesh = createPortalMesh({
      id: i,
      x: px,
      z: pz,
      state: pState,
      biomeKey,
      cultColor: colorStr,
      label: overworldCtx.regions?.[i]?.name || `Zone ${i + 1}`,
      /* Un jeu de matériaux par portail : chacun anime sa propre montée de
         peinture au moment de sa conquête. */
      paintWallMat: makePortalPaintMaterial(colorStr),
      paintWallIdleMat: makePortalPaintMaterial(PORTAL_IDLE_PAINT),
    });
    // Posé sur le relief, et tourné vers le centre du Hub : on voit l'arche de
    // face en arrivant depuis l'autel.
    pMesh.position.y = groundY(px, pz) || 0;
    pMesh.rotation.y = Math.atan2(-px, -pz);
    scene.add(pMesh);
    mapObjects.push(pMesh);
    overworldPortals.push(pMesh);
    overworldZonePortals[i] = pMesh;
  }

  // 4. Esprits sauvages récoltables
  const spiritMat = new THREE.MeshStandardMaterial({
    color: 0xffea77,
    emissive: 0xffaa00,
    emissiveIntensity: 0.8,
    roughness: 0.2,
  });
  const sGeo = new THREE.SphereGeometry(0.35, 12, 8);
  for (let i = 0; i < 5; i++) {
    const sMesh = new THREE.Mesh(sGeo, spiritMat);
    respawnWildSpirit(sMesh);
    scene.add(sMesh);
    mapObjects.push(sMesh);
    overworldSpirits.push(sMesh);
  }

  // 5. Villageois pacifiques : les VRAIS modèles de la foule (paysan, paysanne,
  //    chevalier), pris dans les InstancedMesh VAT déjà chargés — donc animés,
  //    contourés et gratuits en draw calls. On leur réserve des ids dont la
  //    variante est un villageois PNJ (cf. CROWD_VARIANT).
  for (const m of crowds) {
    for (let i = 0; i < m.userData.slots; i++) m.setMatrixAt(i, ZERO_M);
    if (m.instanceMatrix) m.instanceMatrix.needsUpdate = true;
  }

  const HUB_VILLAGER_SLOTS = [0, 6, 12, 18, 24];   // places PNJ d'un cycle
  let maxVillagerId = 0;
  for (let i = 0; i < HUB_VILLAGERS; i++) {
    const id = Math.floor(i / HUB_VILLAGER_SLOTS.length) * CROWD_CYCLE
      + HUB_VILLAGER_SLOTS[i % HUB_VILLAGER_SLOTS.length];
    maxVillagerId = Math.max(maxVillagerId, id);
    const ang = Math.random() * Math.PI * 2;
    const p = findSolidSpot(Math.cos(ang), Math.sin(ang), 6 + Math.random() * 18);
    overworldVillagers.push({
      id, x: p.x, z: p.z, face: Math.random() * Math.PI * 2,
      tx: p.x, tz: p.z, spd: 0,
      speed: 1.3 + Math.random() * 1.1,
      pause: Math.random() * 4,
    });
    setAgentColor(id, GRAY);   // untinted → texture d'origine du modèle
  }
  trimCrowdCounts(maxVillagerId + 1);

  const leader = factions[0].leader;

  // Au retour d'une victoire, on réapparaît DEVANT le portail qu'on vient de
  // conquérir : le joueur voit sa peinture s'étaler au lieu de la découvrir.
  if (pendingHubVictory) {
    const conquered = overworldZonePortals[pendingHubVictory.portalIndex];
    if (conquered) {
      const toCenter = Math.hypot(conquered.position.x, conquered.position.z) || 1;
      leader.x = conquered.position.x * (1 - 6 / toCenter);
      leader.z = conquered.position.z * (1 - 6 / toCenter);
      leader.face = Math.atan2(conquered.position.x - leader.x, conquered.position.z - leader.z);
      f_placeLeaderMesh(factions[0], leader);
    }
  }

  camera.position.set(leader.x, 18, leader.z + 24);
  camera.lookAt(leader.x, 1, leader.z);

  updateOverworldHud(iso);

  if (pendingHubVictory) {
    scheduleVictoryCelebration(pendingHubVictory, colorStr, iso);
    pendingHubVictory = null;
  } else {
    banner(`🚩 Hub Overworld : ${overworldCtx.world?.name || 'Vallée'}`);
  }
}

/** Positionne le mesh du leader sur le terrain (partagé hub / célébration). */
function f_placeLeaderMesh(f, leader) {
  if (!f.grp) return;
  f.grp.position.set(leader.x, groundY(leader.x, leader.z) || 0, leader.z);
  f.grp.rotation.y = leader.face || 0;
}

/**
 * Enchaîne la séquence de conquête : peinture du portail gagné, puis
 * effondrement de l'obstacle du portail suivant.
 */
function scheduleVictoryCelebration(vic, cultColor, iso) {
  const conquered = overworldZonePortals[vic.portalIndex];
  const next = overworldZonePortals[vic.portalIndex + 1];

  banner(`🎨 Zone ${vic.portalIndex + 1} conquise ! +${vic.spirits} esprits`);

  if (vic.replayPaint) {
    setTimeout(() => {
      if (state !== 'overworld') return;
      if (conquered) setPortalState(conquered, 'won', { animate: true, cultColor });
      soundEngine.playSFX('boost');
      updateOverworldHud(iso);
    }, 600);
  }

  setTimeout(() => {
    if (state !== 'overworld') return;
    if (vic.replayUnlock && next && next.userData.state === 'locked') {
      setPortalState(next, 'unlocked', { animate: true, cultColor });
      soundEngine.playSFX('boost');
      banner(`🔓 Zone ${vic.portalIndex + 2} déverrouillée !`);
    } else if (!next) {
      banner(`👑 Toutes les zones de ${overworldCtx?.world?.name || 'ce pays'} sont conquises !`);
    }
  }, 1900);
}

/** Bandeau permanent du Hub : zones conquises + esprits. */
function updateOverworldHud(iso) {
  const el = $('overworld-hud');
  if (!el) return;
  const isoKey = iso || overworldCtx?.world?.iso || 'FRA';
  let won = 0;
  for (let i = 0; i < OVERWORLD_ZONES; i++) {
    if (getCountryPortalState(isoKey, i) === 'won') won++;
  }
  el.innerHTML =
    `<span class="ow-region">${overworldCtx?.world?.name || 'Hub'}</span>`
    + `<span class="ow-sep"></span>`
    + `<span class="ow-stat">✨ <b>${getSpiritsCount()}</b></span>`
    + `<span class="ow-sep"></span>`
    + `<span class="ow-stat">🚩 <b>${won}</b>/${OVERWORLD_ZONES}</span>`;
  el.classList.remove('hidden');
}

function updateOverworld(dt) {
  if (state !== 'overworld' || !factions.length || !factions[0].leader) return;

  // `elapsed` n'avance que dans update() : sans ça, orbes, anneaux et colonnes
  // de lumière des portails restaient figés dans le Hub.
  elapsed += dt;

  applyDayCycle(DAY_FIXED);
  const f = factions[0];
  const leader = f.leader;

  // Déplacement du Leader
  let dx = input.x, dz = input.z;
  if (keys.KeyW || keys.ArrowUp) dz -= 1;
  if (keys.KeyS || keys.ArrowDown) dz += 1;
  if (keys.KeyA || keys.ArrowLeft) dx -= 1;
  if (keys.KeyD || keys.ArrowRight) dx += 1;

  const len = Math.hypot(dx, dz);
  if (len > 1) { dx /= len; dz /= len; }

  /* Boost : rigoureusement le même modèle qu'en partie — `boostT` décompté ici,
     multiplicateur BOOST_MULT sur la vitesse cible, et surtout la MÊME inertie
     (dx/dz lissés à LEADER_RESP) qui donne le coup de reins. Maj le maintient
     tant qu'elle est enfoncée ; le bouton relance la poussée à volonté. */
  f.boostT = Math.max(0, (f.boostT || 0) - dt);
  if (keys.ShiftLeft || keys.ShiftRight) f.boostT = Math.max(f.boostT, dt * 2);
  const boosting = f.boostT > 0;
  boostBtn.classList.toggle('boosting', boosting);

  const sp = OVERWORLD_WALK_SPD * (boosting ? BOOST_MULT : 1);

  leader.dx += (dx * sp - leader.dx) * Math.min(1, dt * LEADER_RESP);
  leader.dz += (dz * sp - leader.dz) * Math.min(1, dt * LEADER_RESP);

  leader.x += leader.dx * dt;
  leader.z += leader.dz * dt;

  /* Bords et trous : on délègue au MÊME solveur que la partie. Le test
     « ce point est-il solide ? » que le Hub utilisait avant ne regardait que le
     centre du perso, ce qui le laissait marcher au-dessus du vide dès qu'il
     dépassait l'arête d'une tuile. resolveIsland tient compte du rayon, ramène
     au dernier point sûr, et gère le saut de brèche. */
  resolveIsland(island, leader, leader.dx, leader.dz, dt, true);

  // Vitesse au sol réelle : c'est elle qui pilote le fondu des gaits.
  leader.spd = Math.hypot(leader.dx, leader.dz);

  if (len > 0) {
    // Rotation amortie sur le plus court chemin : le perso pivote au lieu de
    // claquer d'un cap à l'autre.
    const want = Math.atan2(dx, dz);
    let d = want - (leader.face || 0);
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    leader.face = (leader.face || 0) + d * Math.min(1, dt * 12);
  }

  // Placement mesh Leader — `leader.y` vient de resolveIsland : il porte le
  // relief ET l'arc d'un éventuel saut de brèche.
  if (f.grp) {
    f.grp.position.set(leader.x, leader.y || 0, leader.z);
    f.grp.rotation.y = leader.face || 0;

    // Locomotion riggée : même fondu marche / course / sprint qu'en match, la
    // cadence du clip étant calée sur la vitesse au sol.
    const g = f.grp;
    if (g.userData.gaits && g.userData.mixer) {
      const sp = leader.spd || 0;
      const gi = sp < MONK_GAIT_SPLITS[0] ? 0 : sp < MONK_GAIT_SPLITS[1] ? 1 : 2;
      const k = Math.min(1, dt * 6);
      for (let i = 0; i < g.userData.gaits.length; i++) {
        const gait = g.userData.gaits[i];
        if (!gait) continue;
        const w = gait.action.getEffectiveWeight();
        gait.action.setEffectiveWeight(w + ((i === gi ? 1 : 0) - w) * k);
        gait.action.timeScale = Math.min(1.6, sp / gait.ref);
      }
      g.userData.mixer.update(dt);
    }
    // Cristal du culte au-dessus de la tête : il tourne aussi dans le Hub.
    if (g.userData.crystal) {
      g.userData.crystal.rotation.y += dt * 2.5;
      g.userData.crystal.position.y = 1.1 + Math.sin(elapsed * 4) * 0.05;
    }
  }

  // Caméra suit le personnage en 3D
  camera.position.set(leader.x, 18, leader.z + 22);
  camera.lookAt(leader.x, 1.2, leader.z);

  // Villageois pacifiques : marche vers un point, pause, puis nouveau point.
  // Ils ne fuient personne — c'est un village, pas une partie.
  for (const v of overworldVillagers) {
    let moving = false;
    if (v.pause > 0) {
      v.pause -= dt;
    } else {
      const vdx = v.tx - v.x, vdz = v.tz - v.z;
      const d = Math.hypot(vdx, vdz);
      if (d < 0.4) {
        // Nouvelle flânerie : un point solide tiré ailleurs sur l'île.
        const ang = Math.random() * Math.PI * 2;
        const p = findSolidSpot(Math.cos(ang), Math.sin(ang), 5 + Math.random() * 18);
        v.tx = p.x; v.tz = p.z;
        v.pause = 1 + Math.random() * 3.5;
      } else {
        const step = Math.min(d, v.speed * dt);
        const nvx = v.x + (vdx / d) * step;
        const nvz = v.z + (vdz / d) * step;
        /* La ligne droite vers la destination peut traverser un trou : on
           refuse le pas et on choisit une autre flânerie plutôt que de laisser
           le villageois marcher au-dessus du vide. */
        if (!isSolid(island, nvx, nvz)) {
          const ang = Math.random() * Math.PI * 2;
          const p = findSolidSpot(Math.cos(ang), Math.sin(ang), 5 + Math.random() * 18);
          v.tx = p.x; v.tz = p.z;
          v.pause = 0.4 + Math.random();
          continue;
        }
        v.x = nvx;
        v.z = nvz;
        // Pivot amorti, sinon le villageois claque d'un cap à l'autre au
        // moment où il choisit sa prochaine destination.
        let da = Math.atan2(vdx, vdz) - v.face;
        while (da > Math.PI) da -= Math.PI * 2;
        while (da < -Math.PI) da += Math.PI * 2;
        v.face += da * Math.min(1, dt * 8);
        moving = true;
      }
    }
    // La vitesse pilote le cycle de marche du VAT (Y de l'attribut d'anim).
    v.spd += ((moving ? v.speed : 0) - v.spd) * Math.min(1, dt * 8);

    const cm = crowdOf(v.id), sl = slotOf(v.id);
    if (!cm) continue;
    tmpQ.setFromAxisAngle(UP_AXIS, v.face);
    tmpS.set(1, 1, 1);
    tmpP.set(v.x, groundY(v.x, v.z) || 0, v.z);
    tmpM.compose(tmpP, tmpQ, tmpS);
    cm.setMatrixAt(sl, tmpM);
    cm.instanceMatrix.needsUpdate = true;
    if (cm.userData.anim) {
      cm.userData.anim.setY(sl, v.spd);
      cm.userData.anim.needsUpdate = true;
    }
  }

  // Portails & Détections
  activeOverworldTrigger = updatePortalsSystem(overworldPortals, dt, elapsed, leader);

  // Esprits sauvages récoltables au contact
  for (let i = 0; i < overworldSpirits.length; i++) {
    const s = overworldSpirits[i];
    s.rotation.y += dt * 2;
    s.position.y = (s.userData.baseY || 1.2) + Math.sin(elapsed * 3 + i) * 0.25;

    const dist = Math.hypot(leader.x - s.position.x, leader.z - s.position.z);
    if (dist < 1.4) {
      addSpirits(1);
      soundEngine.playSFX('boost');
      updateOverworldHud();
      respawnWildSpirit(s);
    }
  }

  // Invite contextuelle : rien à l'écran tant qu'on n'est pas à portée.
  if (!activeOverworldTrigger) {
    setOverworldPrompt(null);
  } else {
    if (activeOverworldTrigger.isAltar) {
      setOverworldPrompt('🏛️ Autel des Compétences', ACTION_HINT);
      if (keys.KeyE || keys.KeyF) {
        keys.KeyE = keys.KeyF = false;
        audioInit();
        closeOverworldHud();
        openProgression({ view: 'skills' });
      }
    } else if (activeOverworldTrigger.isPlanetPortal) {
      setOverworldPrompt('🌍 Grand Portail', ACTION_HINT + ' — Vue Planète');
      if (keys.KeyE || keys.KeyF) {
        keys.KeyE = keys.KeyF = false;
        audioInit();
        closeOverworldHud();
        openProgression({ view: 'globe' });
      }
    } else if (activeOverworldTrigger.id != null) {
      const pId = activeOverworldTrigger.id;
      const pState = activeOverworldTrigger.state;
      const pName = activeOverworldTrigger.label || `Zone ${pId + 1}`;
      if (pState === 'locked') {
        setOverworldPrompt(`🔒 ${pName}`, 'Conquérez la zone précédente pour briser le sceau', true);
      } else if (pState === 'unlocked' || pState === 'won') {
        setOverworldPrompt(
          `${pState === 'won' ? '🎨' : '✨'} ${pName}${pState === 'won' ? ' — conquise' : ''}`,
          ACTION_HINT,
        );
        /* Franchir l'arche lance la partie : c'est le geste du concept — on
           entre dans le portail, on n'appuie pas sur un bouton devant. E reste
           disponible pour ceux qui préfèrent valider explicitement. */
        const pm = overworldZonePortals[pId];
        const inGate = pm && Math.hypot(leader.x - pm.position.x, leader.z - pm.position.z) < 1.5;
        if (inGate || keys.KeyE || keys.KeyF) {
          keys.KeyE = keys.KeyF = false;
          launchPortalMatch(pId);
        }
      }
    }
  }
}

function launchPortalMatch(portalIndex) {
  conquestPortalIdx = portalIndex;
  audioInit();
  closeOverworldHud();
  $('start').classList.add('hidden');
  $('end').classList.add('hidden');
  // Le portail EST le choix de zone : on demande à la progression de monter le
  // contexte de la province correspondante, ce qui rappelle setPlayHandler().
  if (overworldCtx?.launchZone) overworldCtx.launchZone(portalIndex);
  else startGame();
}

/** Rend le HUD de match : on quitte le mode Hub. */
function closeOverworldHud() {
  const el = $('overworld-hud');
  if (el) el.classList.add('hidden');
  const p = $('overworld-prompt');
  if (p) { p.classList.remove('show'); p.classList.add('hidden'); p.dataset.html = ''; }
  boostBtn.classList.remove('boosting');
  $('hud').classList.remove('overworld-mode');
}

function resetGame() {
  skillMods = getSkillMods();
  // purge
  for (const f of factions) if (f.grp) scene.remove(f.grp);
  agents = []; factions = []; grayCount = 0;
  freeAgentIds.length = 0;
  resetCrystals();
  for (const a of agents) releaseFollowerSlot(a);
  _pendingFollowers.length = 0;
  for (const fm of Object.values(followerMeshes)) {
    fm.mesh.count = 0;
    if (fm.outline) fm.outline.count = 0;
    fm.freeSlots.length = 0;
    for (let i = fm.cap - 1; i >= 0; i--) fm.freeSlots.push(i);
  }
  // adoption des habitations construites par buildMap : chacune reçoit son état
  // de départ (pleine, non assiégée). On repeint aussi les instances au cas où
  // une partie précédente les avait teintées.
  houses = pendingHouses;
  for (const h of houses) {
    h.remaining = h.capacity;
    h.siegeCult = -1;
    h.progress = 0;
    h.alive = true;
    h.mesh.setColorAt(h.slot, HOUSE_BASE);
    h.mesh.instanceColor.needsUpdate = true;
  }
  elapsed = 0; respawnT = 0; hudT = 0; winT = 0;
  conceding = false;
  lateBellDone = false;
  eventFreeze = false;
  eventsFired.clear();
  endEventCard(true);
  worldMods.fuelLockT = 0;
  worldMods.bombSurgeT = 0;
  worldMods.bombCapMul = 1;
  worldMods.bombDroughtT = 0;
  worldMods.grayPanicT = 0;
  worldMods.zealT = 0;
  worldMods.timeRushT = 0;
  worldMods.timeRushMul = 1;
  worldMods.blackoutT = 0;
  worldMods.blackoutMax = 0;
  resetHazardCards();
  netStatsT = 0;
  stats = { conv: 0, peak: 1, kills: 0, bestStreak: 0 };
  streak = 0; streakT = 0; rallyCd = 0; rallyT = 0;
  fervor = 0; ecstasyT = 0; fervorPct = -1; slowmoT = 0;
  lastAtkPct = -1;
  territoryIncomeT = 0;
  duelT = -1; judgeR = 999; judgeMesh.visible = false;
  duelEl.classList.add('hidden'); duelEl.classList.remove('urgent');
  fervorPct = -1;
  /* Les cultes changent de leader d'une partie à l'autre : on repart de zéro
     plutôt que de garder des cadres au mauvais avatar. */
  raceSig = '';
  for (const el of raceMarks.values()) el.remove();
  raceMarks.clear();
  clearWebs();
  clearFx();
  clearPaint();
  paintMesh.visible = true;   // le Hub la masque : une partie la remet en jeu
  for (const b of bombs) scene.remove(b.grp);
  bombs.length = 0;
  bombT = 1;   // le stock permanent se remplit dès les premières secondes
  if (storm) { scene.remove(storm.grp); storm = null; }
  stormT = 45 + Math.random() * 40;
  buildShrines();
  lastRank = 1; bannerQ = []; bannerT = 0;
  for (const m of crowds) {
    for (let i = 0; i < m.userData.slots; i++) m.setMatrixAt(i, ZERO_M);
    m.instanceMatrix.needsUpdate = true;
  }
  trimCrowdCounts(0);

  // factions : solo = joueur + IA ; multi = sièges du salon (humains + IA)
  const save = JSON.parse(localStorage.getItem('cultio_progress_v3') || '{}');
  if (save.playerColor) {
    const hex = parseInt(save.playerColor.replace('#', ''), 16);
    const ci = CULTS.findIndex(c => c.c === hex);
    if (ci >= 0) playerCultIdx = ci;
  }
  if (save.playerLeader && LEADERS[save.playerLeader]) playerLeaderKey = save.playerLeader;

  const multiSeats = [];
  if (multiMode) {
    const lobbySlots = net.getSlots();
    if (lobbySlots.length) {
      // Moi d'abord, puis les autres (humains puis IA)
      const mine = lobbySlots.filter((s) => s.kind === 'human' && net.isMe(s.sessionId));
      const others = lobbySlots.filter((s) => !(s.kind === 'human' && net.isMe(s.sessionId)));
      for (const s of [...mine, ...others]) {
        multiSeats.push({
          sid: s.sessionId,
          seatIndex: s.seatIndex | 0,
          isMe: s.kind === 'human' && net.isMe(s.sessionId),
          isBot: s.kind === 'bot',
          difficulty: s.difficulty || 'normal',
          name: s.name,
          leaderKey: s.leaderKey,
          cultColor: s.cultColor,
          cultSym: s.cultSym,
          rl: net.getLeaders()?.get(s.sessionId) || null,
        });
      }
    }
  }

  const factionCount = multiSeats.length
    ? Math.max(2, Math.min(6, multiSeats.length))
    : NB_FACTIONS;

  const pool = CULTS.map(c => ({ ...c })).filter((_, i) => i !== playerCultIdx);
  const picks = [];

  if (multiSeats.length) {
    for (let i = 0; i < factionCount; i++) {
      const seat = multiSeats[i];
      if (seat?.isMe) {
        const base = { ...CULTS[playerCultIdx] };
        if (save.playerName) {
          base.name = save.religionName || base.name;
          base.sym = save.religionIcon || base.sym;
          if (save.playerColor) base.c = parseInt(save.playerColor.replace('#', ''), 16);
        }
        // Couleur assignée par le salon si dispo
        if (seat.cultColor) base.c = (seat.cultColor >>> 0) & 0xffffff;
        if (seat.cultSym) base.sym = seat.cultSym;
        picks.push(base);
      } else if (seat) {
        picks.push({
          c: (seat.cultColor >>> 0) & 0xffffff,
          name: seat.name || (seat.isBot ? `IA ${i + 1}` : `Joueur ${i + 1}`),
          sym: seat.cultSym || '⚔',
        });
      } else {
        picks.push(pool.splice((Math.random() * pool.length) | 0, 1)[0]);
      }
    }
  } else {
    picks.push({ ...CULTS[playerCultIdx] });
    if (save.playerName) {
      picks[0].name = save.religionName || picks[0].name;
      picks[0].sym = save.religionIcon || picks[0].sym;
      if (save.playerColor) {
        picks[0].c = parseInt(save.playerColor.replace('#', ''), 16);
      }
    }
    if (conquest && conquest.touchingOwners && Array.isArray(conquest.touchingOwners)) {
      for (const ownerColor of conquest.touchingOwners) {
        if (picks.length >= 3) break;
        const ownerHex = parseInt(ownerColor.replace('#', ''), 16);
        const idx = pool.findIndex(c => c.c === ownerHex);
        if (idx >= 0) picks.push(pool.splice(idx, 1)[0]);
      }
    }
    while (picks.length < 3) picks.push(pool.splice((Math.random() * pool.length) | 0, 1)[0]);
  }

  if (!multiMode && conquest && conquest.barbarian) {
    const names = BARBARIAN_NAMES.slice();
    for (let i = 1; i < picks.length; i++) {
      const pickColorStr = '#' + picks[i].c.toString(16).padStart(6, '0').toLowerCase();
      const isTouching = conquest.touchingOwners && conquest.touchingOwners.some(c => c.toLowerCase() === pickColorStr);
      if (!isTouching) {
        const ni = (Math.random() * names.length) | 0;
        picks[i].name = names.splice(ni, 1)[0] || 'Barbares';
        picks[i].sym = BARBARIAN_SYMS[(Math.random() * BARBARIAN_SYMS.length) | 0];
      }
    }
  }

  /* En multi, chaque client se met à l'index 0 (c'est « moi »), mais la base
     doit rester au même endroit pour tout le monde : l'angle vient donc de la
     place réseau (seatIndex), pas de l'index local. */
  const seatAngle = (t) => {
    const idx = multiSeats.length ? (multiSeats[t]?.seatIndex ?? t) : t;
    return (idx / factionCount) * Math.PI * 2 - Math.PI / 2;
  };

  /* Plus de cours de départ : les sanctuaires sont désormais les seuls lieux
     forts de la vallée. `teams` ne garde qu'une identité de culte et un POINT
     D'APPARITION (baseX/baseZ) — aucune construction, aucun rempart, aucun
     dépôt. Les champs gardent leur nom pour ne pas remuer tout le fichier. */
  teams = [];
  for (let t = 0; t < factionCount; t++) {
    const site = findBaseSite(seatAngle(t));
    const teamColor = new THREE.Color(picks[t].c);
    const team = createTeam(t, site.x, site.z, BASE_WALL_R, BASE_WALL_T,
      Math.atan2(-site.z, -site.x), BASE_GATE_HALF, picks[t]);
    team.color = teamColor;
    team.iconStamp = makeIconStamp(picks[t].sym);
    teams.push(team);
  }

  /* Sanctuaires : semés une fois l'île et les points d'apparition en place. */
  placeAltars();

  const rosterPool = Object.keys(LEADERS).filter((k) => k !== playerLeaderKey);
  for (let s = rosterPool.length - 1; s > 0; s--) {
    const j = (Math.random() * (s + 1)) | 0;
    [rosterPool[s], rosterPool[j]] = [rosterPool[j], rosterPool[s]];
  }
  const factionLeaderKey = (i) => {
    const seat = multiSeats[i];
    if (seat?.leaderKey && LEADERS[seat.leaderKey]) return seat.leaderKey;
    if (seat?.rl?.leaderKey && LEADERS[seat.rl.leaderKey]) return seat.rl.leaderKey;
    if (i === 0) return playerLeaderKey;
    return rosterPool.length ? rosterPool[(i - 1) % rosterPool.length] : 'monk';
  };

  for (let i = 0; i < factionCount; i++) {
    const teamIdx = i;
    const seat = multiSeats[i];
    /* P2P : l'hôte simule les IA localement (pas de serveur). Les invités
       reçoivent les positions via le DataChannel. */
    const hostRunsBot = multiMode && net.isHost() && !!seat?.isBot;
    const isRemote = !!(seat && !seat.isMe && !hostRunsBot);
    const isLocalBot = (!multiMode && i !== 0) || hostRunsBot;
    const spawnPos = (seat?.rl)
      ? { x: seat.rl.x, z: seat.rl.z }
      : spawnInFactionBase(teams[teamIdx], 0);

    let botAggr = 0.35 + Math.random() * 0.65;
    let botAiT = Math.random() * 0.3;
    const seatDiff = seat?.difficulty || currentDifficulty;
    if (isLocalBot) {
      if (seatDiff === 'easy') {
        botAggr = 0.10 + Math.random() * 0.25;
        botAiT = Math.random() * 0.6;
      } else if (seatDiff === 'hard') {
        botAggr = 0.60 + Math.random() * 0.40;
        botAiT = Math.random() * 0.15;
      } else {
        botAggr = 0.30 + Math.random() * 0.40;
        botAiT = Math.random() * 0.3;
      }
    }
    const leaderKey = factionLeaderKey(i);
    const f = createFaction(i, teamIdx, picks[teamIdx], leaderKey, spawnPos.x, spawnPos.z, {
      // Solo : joueur en 0, IA locales ensuite.
      // Multi : invités = remote ; IA = locales chez l'hôte, remote chez l'invité.
      isBot: isLocalBot,
      remote: isRemote,
      sessionId: seat?.sid || null,
      aggr: botAggr,
      aiT: botAiT,
      fuel: FUEL_MAX,
      /* Kit de départ du perso — 2 slots. Tout le monde teste Prêche +
         Sanctuaire pour l'instant ; les kits par perso arriveront quand le
         pool sera plus fourni. */
    });
    if (isRemote) {
      f.netTarget = { x: spawnPos.x, z: spawnPos.z, dx: 0, dz: 0 };
    }
    f.aiDifficulty = seatDiff;
    f.seatIndex = seat?.seatIndex ?? i;
    f.color = new THREE.Color(picks[teamIdx].c);
    f.grp = makeLeaderGroup(picks[teamIdx], leaderKey);
    f.grp.position.set(spawnPos.x, groundY(spawnPos.x, spawnPos.z), spawnPos.z);
    factions.push(f);
  }

  // PNJ et esprits dorés en grappes
  let placed = 0;
  let attempts = 0;
  while (placed < START_GRAYS && attempts < 5000) {
    attempts++;
    const { x: cx, z: cz } = islandRandomPoint(island, 4, Infinity);
    const n = 3 + ((Math.random() * 5) | 0);
    for (let k = 0; k < n && placed < START_GRAYS; k++) {
      const a = spawnAgent(cx + (Math.random() - 0.5) * 4, cz + (Math.random() - 0.5) * 4);
      if (a) placed++;
    }
  }
  updateHUD();
  snapCameraToPlayer();
}

/* ============================== Fin de partie ============================== */
/* Score d'une faction : la couverture pèse le plus lourd, la chasse aux gris
   ensuite, la distance parcourue en appoint. Ventilé pour l'écran de fin. */
/** Part de la vallée peinte par un culte, en pourcentage. C'est le score du
    jeu : tout le reste (sanctuaires, esprits, toiles) n'existe que pour le
    faire monter. */
function paintPct(f) {
  if (!f) return 0;
  return (paintCounts[f.team] / paintTotal) * 100;
}

function factionScore(f) {
  const pct = (paintCounts[f.team] / paintTotal) * 100;
  const sPct = Math.round(pct * SCORE_PER_PCT);
  const sGris = Math.round((f.grisAbs || 0) * SCORE_PER_GRAY);
  const sDist = Math.round((f.dist || 0) * SCORE_PER_DIST);
  return { f, pct, sPct, sGris, sDist, total: sPct + sGris + sDist };
}

let lastVictory = false;   // lu par le bouton « Rejouer » (fiable, pas le DOM)

/* Fin au gong (sans argument) ou abandon : endGame(false). Le classement se
   fait toujours au score total. */
function endGame(forced) {
  state = 'over';
  soundEngine.stopBiomeAmbient();
  $('hud').classList.add('hidden');

  // Classement final par pourcentage de territoire conquis (% de peinture)
  const scores = factions.map(factionScore).sort((a, b) => b.pct - a.pct);
  const mine = scores.find(s => s.f.i === 0);

  const netRank = multiMode ? net.getLeaderList() : null;
  const useNet = !!(netRank && netRank.length);

  const victory = (forced === false || forced === 'concede') ? false : (mine && scores[0] === mine);
  lastVictory = victory;
  const winner = scores[0].f;
  const winnerName = useNet ? (netRank[0]?.name || '—') : winner.cult.name;

  const isCamp = (conquest !== null);
  const btnBack = $('btn-end-back');
  const btnRetry = $('retry');
  $('btn-end-lobby').classList.add('hidden');

  if (forced === 'concede' || forced === false) {
    $('endTitle').textContent = 'Défaite';
    $('endSub').textContent = 'Vous avez cédé la partie aux cultes rivaux.';
    btnRetry.textContent = 'Nouvelle Chasse';
    btnBack.classList.add('hidden');
  } else if (multiMode) {
    $('endTitle').textContent = victory ? 'Victoire !' : 'Défaite';
    $('endSub').textContent = victory
      ? 'Vous avez déposé 60 esprits au sanctuaire de votre base !'
      : `${winnerName} a déposé 60 esprits au sanctuaire avant vous.`;
    btnRetry.textContent = 'Quitter la session';
    btnBack.classList.add('hidden');
  } else if (isCamp) {
    const spiritsEarned = Math.max(5, Math.round((mine ? mine.pct : 10) * 0.4));
    if (victory) {
      const campIso = conquest.world?.iso || 'FRA';
      // On relève l'état AVANT enregistrement : c'est lui qu'on rejouera dans le
      // Hub, pour ne pas re-verrouiller une zone déjà conquise lors d'un rejeu.
      const wasFirstWin = getCountryPortalState(campIso, conquestPortalIdx) !== 'won';
      const nextWasLocked = getCountryPortalState(campIso, conquestPortalIdx + 1) === 'locked';
      recordPortalVictory(campIso, conquestPortalIdx, spiritsEarned);
      // Consommée au retour dans le Hub pour jouer la séquence de conquête.
      pendingHubVictory = {
        portalIndex: conquestPortalIdx,
        spirits: spiritsEarned,
        replayPaint: wasFirstWin,
        replayUnlock: nextWasLocked,
      };
    }
    $('endTitle').textContent = victory ? 'Zone Conquise !' : 'Défaite';
    $('endSub').textContent = victory
      ? `Votre sanctuaire s'empare du portail ! (+${spiritsEarned} esprits)`
      : `Le Culte « ${winnerName} » s'est imposé sur la zone.`;
    btnRetry.textContent = 'Retour au Hub 3D';
    btnBack.classList.add('hidden');
  } else {
    $('endTitle').textContent = victory ? 'Victoire !' : 'Défaite';
    $('endSub').textContent = victory
      ? 'Vous avez déposé 60 esprits au sanctuaire de votre base !'
      : `Le Culte ${winnerName} a déposé 60 esprits au sanctuaire avant vous.`;
    btnRetry.textContent = 'Nouvelle Chasse';
    btnBack.classList.add('hidden');
  }

  $('endTitle').style.background = victory
    ? 'linear-gradient(90deg,#ffe259,#ffa751)' : 'linear-gradient(90deg,#ff5f6d,#a44fff)';
  $('endTitle').style.webkitBackgroundClip = 'text';
  $('endTitle').style.backgroundClip = 'text';
  $('endTitle').style.color = 'transparent';

  /* Classement des factions uniquement par % de territoire. */
  const podiumRows = useNet
    ? netRank.map((l) => ({
      css: '#' + ((l.cultColor >>> 0) & 0xffffff).toString(16).padStart(6, '0'),
      label: `${l.name}${l.isBot ? ' (IA)' : ''}`,
      me: net.isMe(l.sessionId),
      pct: l.pct,
    }))
    : scores.map((s) => ({
      css: s.f.css, label: s.f.cult.name, me: s.f.i === 0, pct: s.pct,
    }));
  const podium = podiumRows.map((r, i) => `<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;
        padding:5px 8px;border-radius:6px;${r.me ? 'background:rgba(255,255,255,.12);border:1px solid rgba(255,255,255,.2);' : ''}">
      <span style="display:flex;align-items:center;gap:6px;min-width:0;">
        <b>${i + 1}.</b>
        <span style="width:10px;height:10px;border-radius:50%;background:${r.css};flex:none;"></span>
        <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${r.label}${r.me ? ' (Vous)' : ''}</span>
      </span>
      <span style="flex:none;font-weight:700;">${r.pct.toFixed(1)} %</span>
    </div>`).join('');

  const playerPaintPct = mine ? mine.pct : 0;
  let rankGrade = 'C';
  let rankColor = '#94a3b8';
  if (playerPaintPct >= 40) { rankGrade = 'S'; rankColor = '#fbbf24'; }
  else if (playerPaintPct >= 25) { rankGrade = 'A'; rankColor = '#a855f7'; }
  else if (playerPaintPct >= 15) { rankGrade = 'B'; rankColor = '#38bdf8'; }
  else { rankGrade = 'C'; rankColor = '#94a3b8'; }

  // Le badge de rang n'est affiché qu'en cas de Victoire
  const rankBadgeHtml = victory ? `<div class="cell full-width" style="text-align:center;padding:12px;background:rgba(15,23,42,0.95);border:2px solid ${rankColor};border-radius:10px;box-shadow:0 0 20px ${rankColor}66;">
    <div style="font-family:'Cinzel',serif;font-size:2.4rem;font-weight:900;color:${rankColor};text-shadow:0 0 14px ${rankColor};">RANG ${rankGrade}</div>
    <div style="font-size:0.9rem;color:#e2e8f0;margin-top:2px;">${playerPaintPct.toFixed(1)}% Territoire Conquis</div>
  </div>` : '';

  $('stats').innerHTML = rankBadgeHtml
    + `<div class="cell full-width"><div class="v">${mine ? mine.pct.toFixed(1) : 0} %</div><div class="k">Vallée conquise</div></div>`
    + `<div class="cell full-width" style="text-align:left;font-size:0.9rem;padding:10px;">`
    + `<div style="font-size:0.85rem;color:#94a3b8;margin-bottom:6px;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;">Classement Territoire</div>`
    + `${podium}</div>`;

  $('end').classList.remove('hidden');
  if (victory) sfxKill(); else sfxDeath();
}

/* ============================== Cristaux-bombes ==============================
   Un cristal apparaît de temps en temps sur l'île. Le premier Leader qui le
   touche déclenche une explosion de SA couleur : grosse flaque gratuite +
   pluie de gouttes qui tachent en retombant. Visible de tous → course. */
const bombs = [];        // { grp, x, z, bob }
const BOMB_MIN = 12;     // stock permanent de cristaux-bombes
const BOMB_MAX = 20;
const BOMB_FUEL = 18;
let bombT = 1;

/* Modificateurs temporaires posés par les cartes événement. */
const worldMods = {
  fuelLockT: 0,
  bombSurgeT: 0,
  bombCapMul: 1,
  bombDroughtT: 0,
  grayPanicT: 0,
  zealT: 0,
  /* Cartes hasard — effets de monde */
  timeRushT: 0,
  timeRushMul: 1,
  blackoutT: 0,
  blackoutMax: 0,
};

function bombCapNow() {
  return Math.round(BOMB_MAX * (worldMods.bombSurgeT > 0 ? worldMods.bombCapMul : 1));
}
function bombMinNow() {
  return Math.round(BOMB_MIN * (worldMods.bombSurgeT > 0 ? worldMods.bombCapMul : 1));
}

function spawnBombAt(x, z) {
  if (!bombModel || bombs.length >= bombCapNow()) return null;
  const grp = bombModel.clone();
  grp.position.set(x, groundY(x, z), z);
  const glow = new THREE.Mesh(
    new THREE.PlaneGeometry(7, 7).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({
      map: lampGlowTex, color: 0x7fd0ff, transparent: true, opacity: 0.9,
      blending: THREE.AdditiveBlending, depthWrite: false,
    }));
  glow.position.y = 0.07;
  glow.renderOrder = 2;
  grp.add(glow);
  scene.add(grp);
  const b = { grp, x, z, bob: Math.random() * 6.28 };
  bombs.push(b);
  return b;
}

function updateBombs(dt) {
  /* Les cristaux de peinture ne réapparaissent plus : ils rechargeaient une
     jauge de carburant qui n'existe plus. La boucle de ramassage ci-dessous
     reste en place — l'IA lit encore `bombs`, et un
     tableau vide traverse ces chemins sans rien casser. */
  bombT -= dt;
  for (let i = bombs.length - 1; i >= 0; i--) {
    const b = bombs[i];
    b.bob += dt * 2.2;
    b.grp.position.y = 0.22 + Math.sin(b.bob) * 0.16;
    b.grp.rotation.y += dt * 1.4;
    let taker = null;
    for (const f of factions) {
      if (!f.alive) continue;
      if (Math.hypot(f.leader.x - b.x, f.leader.z - b.z) < 2.3) { taker = f; break; }
    }
    if (!taker) continue;
    scene.remove(b.grp);
    bombs.splice(i, 1);
    if (worldMods.fuelLockT <= 0) {
      taker.fuel = Math.min(FUEL_MAX, (taker.fuel || 0) + BOMB_FUEL);
    }
    stampSplash(b.x, b.z, 8.5, taker.team, taker.css);
    explodeShrine(b.x, b.z, taker.color, taker.css, taker.team);
    spawnShock(b.x, b.z, taker.color, 13, 0.9);
    soundEngine.playSFX('crystal', { volume: taker.i === 0 ? 0.88 : 0.65 });
    if (taker.i === 0) {
      banner('💥 Explosion de peinture !');
      shake = Math.max(shake, 0.5);
      [392, 523, 659, 784].forEach((fq, k) => tone(fq, 0.3, 'triangle', 0.06, k * 0.05));
    } else {
      banner(`💥 Le Culte ${taker.cult.name} fait exploser un cristal !`);
      tone(392, 0.3, 'triangle', 0.04);
    }
  }
}

/* ============================== Cartes hasard ==============================
   Une carte tourne sur elle-même sur la carte ; le premier Leader qui la touche
   déclenche un effet inconnu. Voir sim/cards.js pour le deck et le rythme.

   La carte est VISIBLE DE LOIN (colonne de lumière + halo au sol) : elle ne doit
   jamais se gagner par hasard en passant à côté. Tout l'intérêt est que les six
   cultes la voient en même temps et décident, chacun, si le détour vaut le
   risque — c'est ce qui en fait un point de rendez-vous conflictuel. */

let hazardCard = null;      // { x, z, grp, spin, bob, beam, glow }
let cardSchedule = [];      // créneaux d'apparition (s depuis le coup d'envoi)
let cardNext = 0;           // index du prochain créneau
const cardHistory = [];     // ids déjà sortis, pour dépondérer les répétitions

/* Face de la carte : dessinée au canvas, pas d'asset à produire. Un « ? » sur un
   fond violet — même dos pour toutes, puisque le contenu doit rester secret. */
let _cardTex = null;
function cardTexture() {
  if (_cardTex) return _cardTex;
  const cv = document.createElement('canvas');
  cv.width = 256; cv.height = 360;
  const c = cv.getContext('2d');
  const g = c.createLinearGradient(0, 0, 0, 360);
  g.addColorStop(0, '#3b1d6e');
  g.addColorStop(0.5, '#6d28d9');
  g.addColorStop(1, '#2e1065');
  c.fillStyle = g;
  c.fillRect(0, 0, 256, 360);
  c.strokeStyle = '#fbbf24';
  c.lineWidth = 10;
  c.strokeRect(14, 14, 228, 332);
  c.font = 'bold 190px system-ui, sans-serif';
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  c.fillStyle = 'rgba(0,0,0,0.35)';
  c.fillText('?', 132, 192);
  c.fillStyle = '#fde68a';
  c.fillText('?', 128, 186);
  _cardTex = new THREE.CanvasTexture(cv);
  _cardTex.colorSpace = THREE.SRGBColorSpace;
  return _cardTex;
}

function spawnHazardCard() {
  if (hazardCard || !island) return false;

  /* Loin de tout Leader : une carte qui naît sous les pieds de quelqu'un lui est
     offerte, alors qu'elle doit se disputer. */
  let pt = null;
  for (let tries = 0; tries < 20; tries++) {
    const p = islandRandomPoint(island, 6, Infinity);
    if (!p) break;
    const pz = p.z ?? p.y;
    let far = true;
    for (const f of factions) {
      if (!f || !f.alive || !f.leader) continue;
      if (Math.hypot(p.x - f.leader.x, pz - f.leader.z) < CARD_MIN_D) { far = false; break; }
    }
    pt = { x: p.x, z: pz };
    if (far) break;
  }
  if (!pt) return false;

  const y = groundY(pt.x, pt.z);
  const grp = new THREE.Group();
  grp.position.set(pt.x, y, pt.z);

  const tex = cardTexture();
  const face = new THREE.Mesh(
    new THREE.BoxGeometry(1.5, 2.1, 0.09),
    [
      new THREE.MeshBasicMaterial({ color: 0x4c1d95 }),  // tranches
      new THREE.MeshBasicMaterial({ color: 0x4c1d95 }),
      new THREE.MeshBasicMaterial({ color: 0x4c1d95 }),
      new THREE.MeshBasicMaterial({ color: 0x4c1d95 }),
      new THREE.MeshBasicMaterial({ map: tex, toneMapped: false }),
      new THREE.MeshBasicMaterial({ map: tex, toneMapped: false }),
    ],
  );
  face.position.y = 1.9;
  grp.add(face);

  /* Colonne de lumière : même code visuel que les sanctuaires, parce que c'est
     la même promesse — « il se passe quelque chose ici ». */
  const beam = new THREE.Mesh(
    new THREE.CylinderGeometry(0.5, 0.95, 30, 12, 1, true),
    new THREE.MeshBasicMaterial({
      color: 0xa78bfa, transparent: true, opacity: 0.4, depthWrite: false,
      side: THREE.DoubleSide, blending: THREE.AdditiveBlending, toneMapped: false,
    }));
  beam.position.y = 15;
  grp.add(beam);

  const glow = new THREE.Mesh(
    new THREE.PlaneGeometry(8, 8).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({
      map: lampGlowTex, color: 0xc4b5fd, transparent: true, opacity: 0.85,
      blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
    }));
  glow.position.y = 0.08;
  glow.renderOrder = 2;
  grp.add(glow);

  scene.add(grp);
  hazardCard = { x: pt.x, z: pt.z, grp, face, beam, glow, spin: 0, age: 0 };

  banner('❓ Une carte mystère est apparue !');
  spawnShock(pt.x, pt.z, new THREE.Color(0xa78bfa), 7, 1.1);
  soundEngine.playSFX('bell', { volume: 0.6 });
  return true;
}

function removeHazardCard() {
  if (!hazardCard) return;
  scene.remove(hazardCard.grp);
  disposeGroup(hazardCard.grp);
  hazardCard = null;
}

/** Remise à zéro entre deux parties : nouveau calendrier, nouveau jitter. */
function resetHazardCards() {
  removeHazardCard();
  hideCardBanner();
  cardSchedule = buildCardSchedule();
  cardNext = 0;
  cardHistory.length = 0;
}

/* ---- Envol de la carte ----
   Le ramassage n'applique RIEN tout de suite : la carte s'arrache du sol, part
   en vrille de plus en plus vite et monte, puis éclate. C'est seulement à
   l'éclatement que l'effet tombe et que le bandeau s'affiche.

   Ce délai est le cœur de l'effet : il crée la seconde de suspense qui manquait
   — on a pris la carte, on ne sait pas encore ce qu'on a pris — et il donne au
   joueur un point de fixation, de sorte que le bandeau ne surgit pas de nulle
   part. Un tiers de seconde de plus, et ce serait une attente ; ici c'est une
   respiration. */
const CARD_FLIGHT_T = 0.85;

function takeHazardCard(f) {
  /* Le tirage se fait MAINTENANT, pour que les prises soient impossibles à
     départager après coup, mais il reste secret jusqu'à l'éclatement. */
  const c = pickCard(Math.random, cardHistory);
  cardHistory.push(c.id);
  hazardCard.taking = { t: 0, card: c, f };
  hazardCard.beam.visible = false;
  soundEngine.playSFX('bell', { volume: 0.5, rate: 1.4 });
}

/** Fin de l'envol : l'effet tombe et le bandeau l'annonce. */
function resolveHazardCard() {
  const { card: c, f } = hazardCard.taking;
  const x = hazardCard.x, z = hazardCard.z;
  removeHazardCard();

  spawnShock(x, z, f.color, 11, 0.9);
  explodeShrine(x, z, f.color, f.css, f.team);
  shake = Math.max(shake, f.i === 0 ? 0.45 : 0.2);

  applyCard(c, cardCtx, f);

  /* SEUL cas où la partie s'arrête : une conséquence COLLECTIVE. Tout le monde
     la subit, donc tout le monde doit avoir le temps de la lire — cinq à six
     secondes, carte plein écran. Un effet individuel, lui, ne concerne qu'un
     joueur : figer les cinq autres pour le lui annoncer leur volerait du temps
     de jeu sans rien leur apprendre d'utile. Ceux-là passent par le bandeau,
     qui se lit d'un coup d'œil sans rien interrompre. */
  if (c.scope === 'all') {
    beginEventCard(c, { instant: true, dur: c.major ? 6 : 5 });
    shake = Math.max(shake, c.major ? 0.5 : 0.35);
  } else {
    showCardBanner(c, f);
    soundEngine.playEventReveal?.(c.tone);
  }
}

/* ---- Bandeau d'annonce (effets INDIVIDUELS uniquement) ----
   Gros titre + une ligne d'explication, la couleur donnant le verdict avant même
   la lecture. Il ne met rien en pause : un effet qui ne touche qu'un joueur ne
   justifie pas d'immobiliser les autres. Les conséquences collectives, elles,
   passent par la carte plein écran — voir resolveHazardCard. */
const cardBannerEl = () => $('card-banner');
let cardBannerT = 0;

function showCardBanner(c, f) {
  const el = cardBannerEl();
  if (!el) return;
  const mine = f.i === 0;

  /* Le bandeau annonce ce que ça fait AU JOUEUR, pas la nature de la carte dans
     l'absolu (voir bannerTone). */
  const tone = bannerTone(c, mine);

  const titleEl = $('card-banner-title');
  const textEl = $('card-banner-text');
  if (titleEl) titleEl.textContent = `${c.icon} ${c.title}`;
  if (textEl) textEl.textContent = mine ? c.blurb : `Culte ${f.cult.name} — ${c.blurb}`;

  el.classList.remove('hidden', 'tone-good', 'tone-bad', 'tone-chaos', 'show');
  el.classList.add('tone-' + tone);
  /* Forcer un reflow : sans ça, retirer puis remettre `show` dans le même tick
     ne rejoue pas la transition, et deux cartes rapprochées n'en animeraient
     qu'une. */
  void el.offsetWidth;
  el.classList.add('show');
  /* Assez pour lire deux lignes sans quitter l'action des yeux : le jeu continue
     pendant ce temps, la durée est donc un compromis, pas un confort. */
  cardBannerT = 2.8;
}

function updateCardBanner(dt) {
  if (cardBannerT <= 0) return;
  cardBannerT -= dt;
  if (cardBannerT > 0) return;
  const el = cardBannerEl();
  if (el) el.classList.remove('show');
}

function hideCardBanner() {
  cardBannerT = 0;
  const el = cardBannerEl();
  if (el) el.classList.remove('show');
}

function updateHazardCards(dt) {
  updateCardBanner(dt);

  if (hazardCard) {
    const h = hazardCard;
    h.age += dt;

    /* -- Envol : vrille accélérée + montée, puis éclatement -- */
    if (h.taking) {
      h.taking.t += dt;
      const u = Math.min(1, h.taking.t / CARD_FLIGHT_T);
      /* Vitesse de rotation en u² : le départ reste lisible, la fin part en
         toupie. Une accélération linéaire se lit comme un objet qui glisse. */
      h.spin += dt * (5 + 46 * u * u);
      h.face.rotation.y = h.spin;
      h.face.rotation.z = u * u * 1.5;
      /* Montée franche qui décélère : la carte semble jetée en l'air, pas
         soulevée par un ascenseur. */
      h.face.position.y = 1.9 + (1 - (1 - u) * (1 - u)) * 7.5;
      h.face.scale.setScalar(1 + u * 0.5);
      h.glow.material.opacity = 0.85 * (1 - u);
      if (h.taking.t >= CARD_FLIGHT_T) resolveHazardCard();
      return;
    }

    h.spin += dt * 1.15;
    h.face.rotation.y = h.spin;
    /* Flottement et respiration du halo : une carte parfaitement immobile se
       lit comme un élément de décor. */
    h.face.position.y = 1.9 + Math.sin(h.age * 1.9) * 0.22;
    h.glow.material.opacity = 0.6 + Math.sin(h.age * 3.1) * 0.25;
    h.beam.material.opacity = 0.3 + Math.sin(h.age * 2.2) * 0.12;

    for (const f of factions) {
      if (!f || !f.alive || !f.leader) continue;
      if (Math.hypot(f.leader.x - h.x, f.leader.z - h.z) > CARD_PICK_R) continue;
      takeHazardCard(f);
      break;
    }
    /* Une carte non ramassée bloque la suivante : il n'y en a jamais deux à la
       fois. Le créneau manqué n'est pas perdu pour autant — la carte suivante
       sortira dès que celle-ci aura trouvé preneur. */
    return;
  }

  if (cardNext >= cardSchedule.length) return;
  if (elapsed < cardSchedule[cardNext]) return;
  /* Le créneau est consommé même si la pose échoue faute de point valable :
     `spawnHazardCard` réessaiera au tick suivant tant que l'index n'avance pas. */
  if (spawnHazardCard()) cardNext++;
}

/* ============================== Cartes événement ============================== */
const eventsFired = new Set();
let eventShow = null; // { phase, t, pick, flashAcc }
const eventOverlayEl = () => $('event-overlay');
const eventCardEl = () => $('event-card');
const eventArtEl = () => $('event-art');
const eventIconEl = () => $('event-icon');
const eventTitleEl = () => $('event-title');
const eventBlurbEl = () => $('event-blurb');
const eventRibbonTextEl = () => $('event-ribbon-text');
const eventTimerBarEl = () => $('event-timer-bar');
const eventShockwaveEl = () => $('event-shockwave');

function paintEventCard(ev) {
  const card = eventCardEl();
  if (!card || !ev) return;
  const tone = ev.tone || 'chaos';
  card.classList.remove('tone-good', 'tone-bad', 'tone-chaos');
  card.classList.add('tone-' + tone);

  const ribbonEl = eventRibbonTextEl();
  if (ribbonEl) {
    if (tone === 'good') ribbonEl.textContent = '✦ BÉNÉDICTION ✦';
    else if (tone === 'bad') ribbonEl.textContent = '⚠️ MALÉDICTION ⚠️';
    else ribbonEl.textContent = '⚡ ANARCHIE & CHAOS ⚡';
  }

  const artEl = eventArtEl();
  const artFrame = artEl?.parentElement;
  const src = ev.art || (ev.id ? `assets/events/${ev.id}.webp` : '');
  if (artEl && src) {
    if (artEl.getAttribute('src') !== src) artEl.src = src;
    artEl.alt = ev.title || '';
    artFrame?.classList.add('has-art');
    artEl.onerror = () => {
      artFrame?.classList.remove('has-art');
      const iconEl = eventIconEl();
      if (iconEl) iconEl.textContent = ev.icon || '✦';
    };
  } else {
    artFrame?.classList.remove('has-art');
  }
  const iconEl = eventIconEl();
  if (iconEl) iconEl.textContent = ev.icon || '✦';
  const titleEl = eventTitleEl();
  if (titleEl) titleEl.textContent = ev.title || '';
  const blurbEl = eventBlurbEl();
  if (blurbEl) blurbEl.textContent = ev.blurb || '';
}

/**
 * Ouvre la carte plein écran, jeu en pause.
 *
 * `opts.instant` : saute la roulette et affiche directement le résultat. C'est
 * le mode des cartes hasard COLLECTIVES — l'effet est déjà appliqué quand on
 * arrive ici, la carte ne fait que l'annoncer. Faire tourner une roulette après
 * coup mentirait sur le moment où le sort a été joué.
 * `opts.dur` : durée de la pause.
 */
function beginEventCard(ev, opts = {}) {
  const instant = !!opts.instant;
  eventFreeze = true;
  eventShow = {
    phase: instant ? 'reveal' : 'spin',
    t: 0, pick: ev, flashAcc: 0,
    /* En mode instant, l'appelant a déjà appliqué l'effet : la phase reveal ne
       doit pas le rejouer. */
    applied: instant,
    revealDur: opts.dur || EVENT_REVEAL_DUR,
  };
  const overlay = eventOverlayEl();
  const card = eventCardEl();
  const shockwave = eventShockwaveEl();
  const timerBar = eventTimerBarEl();

  if (shockwave) shockwave.classList.remove('trigger');
  if (timerBar) timerBar.style.transform = 'scaleX(1)';

  if (overlay) overlay.classList.remove('hidden');
  if (card) {
    card.classList.remove('is-spinning', 'is-landing', 'is-reveal');
    card.classList.add(instant ? 'is-reveal' : 'is-spinning');
  }
  paintEventCard(instant ? ev : EVENT_DECK[Math.floor(Math.random() * EVENT_DECK.length)]);
  if (instant) {
    if (shockwave) shockwave.classList.add('trigger');
    soundEngine.playEventReveal?.(ev.tone);
  } else {
    soundEngine.playSFX('convert', { volume: 0.35, rate: 0.7 });
  }
}

function endEventCard(silent = false) {
  eventFreeze = false;
  eventShow = null;
  const overlay = eventOverlayEl();
  const card = eventCardEl();
  const shockwave = eventShockwaveEl();

  if (overlay) overlay.classList.add('hidden');
  if (shockwave) shockwave.classList.remove('trigger');
  if (card) card.classList.remove('is-spinning', 'is-landing', 'is-reveal');
  if (!silent) banner('▶ La partie reprend !');
}

const eventCtx = {
  swapFactionColors() {
    const alive = factions.filter((f) => f && f.alive);
    if (alive.length < 2) return;
    const snap = alive.map((f) => ({
      color: f.color.clone(),
      css: f.css,
      c: f.cult.c,
    }));
    for (let i = 0; i < alive.length; i++) {
      const src = snap[(i + 1) % alive.length];
      const f = alive[i];
      f.color.copy(src.color);
      f.css = src.css;
      f.cult = { ...f.cult, c: src.c };
    }
  },
  drainAllFuel(dur = 10) {
    worldMods.fuelLockT = Math.max(worldMods.fuelLockT, dur);
    for (const f of factions) {
      if (f && f.alive) f.fuel = 0;
    }
  },
  surgeBombs(dur = 30, mul = 1.5) {
    worldMods.bombSurgeT = Math.max(worldMods.bombSurgeT, dur);
    worldMods.bombCapMul = Math.max(worldMods.bombCapMul, mul);
    const want = Math.min(bombCapNow(), bombs.length + Math.ceil(BOMB_MIN * (mul - 1)) + 4);
    let guard = 24;
    while (bombs.length < want && guard-- > 0) {
      const pt = islandRandomPoint(island, 6, Infinity);
      spawnBombAt(pt.x, pt.z);
    }
  },
  boostAllLeaders(dur = 2.5) {
    for (const f of factions) {
      if (!f || !f.alive) continue;
      f.boostT = Math.max(f.boostT || 0, dur);
    }
  },
  slowAllLeaders(dur = 4) {
    for (const f of factions) {
      if (!f || !f.alive) continue;
      f.slowT = Math.max(f.slowT || 0, dur);
    }
  },
  panicGrays(dur = 8) {
    worldMods.grayPanicT = Math.max(worldMods.grayPanicT, dur);
  },
  fillAllFuel() {
    worldMods.fuelLockT = 0;
    for (const f of factions) {
      if (f && f.alive) f.fuel = FUEL_MAX;
    }
  },
  washAllPaint() {
    clearPaint();
    shake = Math.max(shake, 0.45);
  },
  splashAllLeaders(r = 7.5) {
    for (const f of factions) {
      if (!f || !f.alive) continue;
      stampSplash(f.leader.x, f.leader.z, r, f.team, f.css);
      spawnShock(f.leader.x, f.leader.z, f.color, r * 0.9, 0.45);
    }
  },
  droughtBombs(dur = 20) {
    worldMods.bombDroughtT = Math.max(worldMods.bombDroughtT, dur);
    worldMods.bombSurgeT = 0;
    worldMods.bombCapMul = 1;
    for (let i = bombs.length - 1; i >= 0; i--) {
      scene.remove(bombs[i].grp);
    }
    bombs.length = 0;
  },
  spawnPilgrims(n = 28) {
    let left = n;
    let guard = n * 3;
    while (left > 0 && guard-- > 0) {
      const pt = islandRandomPoint(island, 4, Infinity);
      if (spawnAgent(pt.x, pt.z)) left--;
    }
  },
  scrambleLeaders() {
    for (const f of factions) {
      if (!f || !f.alive) continue;
      const pt = islandRandomPoint(island, 8, Infinity);
      f.leader.x = pt.x;
      f.leader.z = pt.z;
      f.leader.y = groundY(pt.x, pt.z);
      f.leader.dx = 0;
      f.leader.dz = 0;
      if (f.grp) f.grp.position.set(pt.x, f.leader.y, pt.z);
    }
    shake = Math.max(shake, 0.5);
  },
  zealAura(dur = 12) {
    worldMods.zealT = Math.max(worldMods.zealT, dur);
  },
  swapTwoLeaders() {
    const alive = factions.filter((f) => f && f.alive);
    if (alive.length < 2) return;
    const i = (Math.random() * alive.length) | 0;
    let j = (Math.random() * (alive.length - 1)) | 0;
    if (j >= i) j++;
    const A = alive[i], B = alive[j];
    const ax = A.leader.x, az = A.leader.z;
    A.leader.x = B.leader.x; A.leader.z = B.leader.z;
    B.leader.x = ax; B.leader.z = az;
    if (A.grp) A.grp.position.set(A.leader.x, A.leader.y || 0, A.leader.z);
    if (B.grp) B.grp.position.set(B.leader.x, B.leader.y || 0, B.leader.z);
    shake = Math.max(shake, 0.35);
  },
  grantBelieversAll(n = 6) {
    for (const f of factions) {
      if (!f || !f.alive) continue;
      f.count = (f.count || 0) + n;
      f.everGrew = true;
      spawnSoulBurst(f.leader.x, f.leader.z, f);
    }
  },
  quake(dur = 5) {
    shake = Math.max(shake, 0.85);
    worldMods.grayPanicT = Math.max(worldMods.grayPanicT, dur);
    for (const f of factions) {
      if (!f || !f.alive) continue;
      f.slowT = Math.max(f.slowT || 0, dur);
    }
    for (const a of agents) {
      if (!a || a.dead) continue;
      if ((a.followerOf ?? -1) >= 0) continue;
      a.stumbleT = Math.max(a.stumbleT || 0, 0.6 + Math.random() * 0.5);
      a.vx *= 0.2; a.vz *= 0.2;
    }
  },
};

/* ---- Effets propres aux cartes hasard ----
   Le contexte des cartes ÉTEND celui des événements : la moitié des effets
   collectifs (zèle, panique, téléportation, lessivage…) existaient déjà et sont
   repris tels quels. Seuls les effets individuels — ceux qui frappent le
   ramasseur et lui seul — sont nouveaux ; c'est eux qui font du ramassage un
   pari, puisqu'ils peuvent aussi bien lui coûter son cortège. */
const cardCtx = {
  ...eventCtx,

  /* -- Individuel : bénéfique -- */
  giftSpirits(f, n = 5) {
    /* De VRAIS esprits, convertis sur place : gonfler `count` donnerait un
       cortège fantôme, invisible et non livrable à un autel. */
    let born = 0, guard = n * 6;
    while (born < n && guard-- > 0) {
      const a = Math.random() * Math.PI * 2;
      const r = 2.5 + Math.random() * 3.5;
      const ag = spawnAgent(f.leader.x + Math.cos(a) * r, f.leader.z + Math.sin(a) * r);
      if (!ag) break;
      finishConvert(ag, f);
      born++;
    }
    spawnSoulBurst(f.leader.x, f.leader.z, f);
  },
  grantAltar(f) {
    /* Le plus proche qui ne soit pas déjà à lui : offrir un autel qu'il tient
       déjà ne serait pas un cadeau. */
    let best = null, bestD = Infinity;
    for (const a of altars) {
      if (a.owner === f.i) continue;
      const d = Math.hypot(a.x - f.leader.x, a.z - f.leader.z);
      if (d < bestD) { bestD = d; best = a; }
    }
    if (!best) { cardCtx.giftSpirits(f, 4); return; }   // repli : aucun autel libre
    activateAltar(best, f);
  },
  paintFervor(f, dur = 25, mul = 2) {
    f.paintMulT = Math.max(f.paintMulT || 0, dur);
    f.paintMul = Math.max(f.paintMul || 1, mul);
  },
  boostLeader(f, dur = 10) {
    f.boostT = Math.max(f.boostT || 0, dur);
  },
  rapidFire(f, dur = 20, mul = 0.5) {
    f.atkCdT = Math.max(f.atkCdT || 0, dur);
    f.atkCdMul = Math.min(f.atkCdMul ?? 1, mul);
  },
  spiritCall(f, dur = 12) {
    f.spiritCallT = Math.max(f.spiritCallT || 0, dur);
  },
  splashLeader(f, r = 14) {
    stampSplash(f.leader.x, f.leader.z, r, f.team, f.css);
    spawnShock(f.leader.x, f.leader.z, f.color, r * 0.9, 0.6);
  },
  stealAltarFromBest(f) {
    /* Vise le culte qui tient le plus d'autels — la carte la plus agressive du
       deck, et la seule qui frappe précisément le meneur. */
    const held = new Map();
    for (const a of altars) {
      if (a.owner < 0 || a.owner === f.i) continue;
      held.set(a.owner, (held.get(a.owner) || 0) + 1);
    }
    let victim = -1, most = 0;
    for (const [owner, n] of held) if (n > most) { most = n; victim = owner; }
    if (victim < 0) { cardCtx.grantAltar(f); return; }
    let best = null, bestD = Infinity;
    for (const a of altars) {
      if (a.owner !== victim) continue;
      const d = Math.hypot(a.x - f.leader.x, a.z - f.leader.z);
      if (d < bestD) { bestD = d; best = a; }
    }
    if (best) activateAltar(best, f);
  },

  /* -- Individuel : néfaste -- */
  loseAllSpirits(f) {
    /* Ils redeviennent sauvages là où ils sont : le cortège se défait sous les
       yeux du joueur, et ses rivaux peuvent le lui reprendre. Bien plus lisible
       qu'une disparition sèche. */
    let n = 0;
    for (const a of agents) {
      if (!a || a.dead || (a.followerOf ?? -1) !== f.i) continue;
      _atkCtx.releaseFollower(a);
      a.downT = Math.max(a.downT || 0, 0.6);
      n++;
    }
    if (n) {
      spawnShock(f.leader.x, f.leader.z, f.color, 12, 0.8);
      shake = Math.max(shake, f.i === 0 ? 0.55 : 0.2);
    }
  },
  loseAltar(f) {
    const mine = altars.filter((a) => a.owner === f.i);
    if (!mine.length) { cardCtx.loseAllSpirits(f); return; }   // repli : rien à perdre ici
    const a = mine[(Math.random() * mine.length) | 0];
    /* Même image que la reprise par un rival : la statue vole en éclats. Ce qui
       change ici, c'est que personne ne la remplace. */
    if (a.statue) shatterStatue(a, a.owner);
    a.owner = -1;
    a.filled = 0;
    a.activeT = 0;
    spawnShock(a.x, a.z, new THREE.Color(0x9aa2ad), 9, 1.0);
    refreshAltarVisual(a);
  },
  stumbleLeader(f, dur = 6) {
    f.downT = Math.max(f.downT || 0, 1.2);
    f.slowT = Math.max(f.slowT || 0, dur);
  },
  wipePaintAround(f, r = 16) {
    erasePaintAt(f.leader.x, f.leader.z, r);
    spawnShock(f.leader.x, f.leader.z, new THREE.Color(0x9aa2ad), r, 0.7);
  },
  exileLeader(f) {
    const pt = islandRandomPoint(island, 8, Infinity);
    if (!pt) return;
    const pz = pt.z ?? pt.y;
    f.leader.x = pt.x; f.leader.z = pz;
    f.leader.y = groundY(pt.x, pz);
    f.leader.dx = 0; f.leader.dz = 0;
    if (f.grp) f.grp.position.set(pt.x, f.leader.y, pz);
    spawnShock(pt.x, pz, f.color, 8, 0.7);
  },
  doubleOrNothing(f) {
    const mine = agents.filter((a) => a && !a.dead && (a.followerOf ?? -1) === f.i);
    if (Math.random() < 0.5) {
      cardCtx.giftSpirits(f, Math.max(3, mine.length));
      banner(f.i === 0 ? '🎲 Double ! Votre cortège enfle.' : `🎲 Culte ${f.cult.name} : double !`);
    } else {
      cardCtx.loseAllSpirits(f);
      banner(f.i === 0 ? '🎲 Perdu ! Votre cortège s\'évapore.' : `🎲 Culte ${f.cult.name} : tout perdu !`);
    }
  },

  /* -- Collectif -- */
  swapAllLeaders() {
    const alive = factions.filter((f) => f && f.alive);
    if (alive.length < 2) return;
    const pos = alive.map((f) => ({ x: f.leader.x, z: f.leader.z }));
    for (let i = 0; i < alive.length; i++) {
      const src = pos[(i + 1) % alive.length];
      const f = alive[i];
      f.leader.x = src.x; f.leader.z = src.z;
      f.leader.y = groundY(src.x, src.z);
      f.leader.dx = 0; f.leader.dz = 0;
      if (f.grp) f.grp.position.set(src.x, f.leader.y, src.z);
      spawnShock(src.x, src.z, f.color, 6, 0.6);
    }
    shake = Math.max(shake, 0.5);
  },
  timeRush(dur = 30, mul = 2) {
    worldMods.timeRushT = Math.max(worldMods.timeRushT, dur);
    worldMods.timeRushMul = Math.max(worldMods.timeRushMul, mul);
  },
  blackout(dur = 18) {
    worldMods.blackoutT = Math.max(worldMods.blackoutT, dur);
    worldMods.blackoutMax = worldMods.blackoutT;
  },
};

function updateEventCard(dt) {
  if (!eventShow) return;
  eventShow.t += dt;
  const card = eventCardEl();
  const shockwave = eventShockwaveEl();
  const timerBar = eventTimerBarEl();

  if (eventShow.phase === 'spin') {
    const u = Math.min(1, eventShow.t / EVENT_SPIN_DUR);
    /* Ralentit franchement : on lit les titres qui défilent, puis on pose. */
    const interval = 0.14 + u * u * 0.55;
    eventShow.flashAcc += dt;
    if (eventShow.flashAcc >= interval) {
      eventShow.flashAcc = 0;
      const flash = EVENT_DECK[Math.floor(Math.random() * EVENT_DECK.length)];
      paintEventCard(flash);
      soundEngine.playEventSpinTick();
    }
    if (eventShow.t >= EVENT_SPIN_DUR) {
      eventShow.phase = 'land';
      eventShow.t = 0;
      paintEventCard(eventShow.pick);
      if (card) {
        card.classList.remove('is-spinning');
        card.classList.add('is-landing');
      }
      if (shockwave) {
        shockwave.classList.remove('trigger');
        void shockwave.offsetWidth; // Force reflow pour re-déclencher l'animation
        shockwave.classList.add('trigger');
      }
      shake = Math.max(shake, 0.4);
      soundEngine.playEventSlam();
    }
  } else if (eventShow.phase === 'land') {
    if (eventShow.t >= 0.8) {
      eventShow.phase = 'reveal';
      eventShow.t = 0;
      if (card) {
        card.classList.remove('is-landing');
        card.classList.add('is-reveal');
      }
      if (!eventShow.applied) {
        applyEvent(eventShow.pick, eventCtx);
        eventShow.applied = true;
      }
      banner(`${eventShow.pick.icon} ${eventShow.pick.title}`);
      shake = Math.max(shake, 0.3);
      soundEngine.playEventReveal(eventShow.pick?.tone);
    }
  } else if (eventShow.phase === 'reveal') {
    /* La barre se vide sur toute la pause : elle dit combien de temps il reste
       pour lire, ce qui évite l'impression d'un jeu qui s'est figé. */
    const dur = eventShow.revealDur || EVENT_REVEAL_DUR;
    const progress = Math.max(0, 1 - eventShow.t / dur);
    if (timerBar) {
      timerBar.style.transform = `scaleX(${progress})`;
    }
    if (eventShow.t >= dur) endEventCard();
  }
}

function tryTriggerMatchEvent() {
  if (eventFreeze || eventShow) return;
  for (const t of EVENT_TIMES) {
    if (elapsed >= t && !eventsFired.has(t)) {
      eventsFired.add(t);
      beginEventCard(pickEvent());
      return;
    }
  }
}

function tickWorldMods(dt) {
  if (worldMods.fuelLockT > 0) {
    worldMods.fuelLockT = Math.max(0, worldMods.fuelLockT - dt);
    for (const f of factions) {
      if (f && f.alive) f.fuel = 0;
    }
  }
  if (worldMods.bombSurgeT > 0) {
    worldMods.bombSurgeT = Math.max(0, worldMods.bombSurgeT - dt);
    if (worldMods.bombSurgeT <= 0) worldMods.bombCapMul = 1;
  }
  if (worldMods.bombDroughtT > 0) {
    worldMods.bombDroughtT = Math.max(0, worldMods.bombDroughtT - dt);
  }
  if (worldMods.grayPanicT > 0) {
    worldMods.grayPanicT = Math.max(0, worldMods.grayPanicT - dt);
  }
  if (worldMods.zealT > 0) {
    worldMods.zealT = Math.max(0, worldMods.zealT - dt);
  }
  /* ---- Cartes hasard ---- */
  if (worldMods.timeRushT > 0) {
    worldMods.timeRushT = Math.max(0, worldMods.timeRushT - dt);
    if (worldMods.timeRushT <= 0) {
      worldMods.timeRushMul = 1;
      banner('⏱ Le temps reprend son cours normal.');
    }
  }
  if (worldMods.blackoutT > 0) {
    worldMods.blackoutT = Math.max(0, worldMods.blackoutT - dt);
    if (worldMods.blackoutT <= 0) banner('☀ La lumière revient.');
  }
  /* Modificateurs individuels. Regroupés ici plutôt que dispersés : un effet de
     carte qui ne redescend jamais serait invisible en lecture et permanent en
     jeu — le pire des bugs d'équilibrage. */
  for (const f of factions) {
    if (!f) continue;
    if (f.paintMulT > 0) {
      f.paintMulT = Math.max(0, f.paintMulT - dt);
      if (f.paintMulT <= 0) f.paintMul = 1;
    }
    if (f.atkCdT > 0) {
      f.atkCdT = Math.max(0, f.atkCdT - dt);
      if (f.atkCdT <= 0) f.atkCdMul = 1;
    }
    if (f.spiritCallT > 0) f.spiritCallT = Math.max(0, f.spiritCallT - dt);
  }
}

/* ============================== Orage effaceur ==============================
   Un nuage noir traverse la vallée en ligne droite et lessive TOUTE la
   peinture sur son sillage. Personne n'est visé : tout le monde subit, tout le
   monde s'adapte — et le terrain redevient à prendre derrière lui. */
let storm = null;        // { grp, x, z, dx, dz, life, flashT }
let stormT = 50;
const RAIN_GEO = new THREE.BoxGeometry(0.05, 0.75, 0.05);
const RAIN_MAT = new THREE.MeshBasicMaterial({ color: 0xa8cce8, transparent: true, opacity: 0.55 });

function makeStormCloud() {
  const grp = new THREE.Group();
  const mat = new THREE.MeshBasicMaterial({ color: 0x2a2f42, transparent: true, opacity: 0.9 });
  for (let i = 0; i < 6; i++) {
    const s = 2.1 + Math.random() * 2.6;
    const m = new THREE.Mesh(new THREE.SphereGeometry(s, 10, 8), mat);
    m.position.set((Math.random() - 0.5) * 7.5, (Math.random() - 0.5) * 1.4, (Math.random() - 0.5) * 5);
    m.scale.y = 0.55;
    grp.add(m);
  }
  // ombre portée au sol : télégraphie la zone lessivée
  const shadow = new THREE.Mesh(
    new THREE.PlaneGeometry(15, 15).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ map: lampGlowTex, color: 0x000000, transparent: true, opacity: 0.4, depthWrite: false }));
  shadow.position.y = -14.93;
  shadow.renderOrder = 2;
  grp.add(shadow);
  return grp;
}

function updateStorm(dt) {
  stormT -= dt;
  if (stormT <= 0 && !storm) {
    const ang = Math.random() * Math.PI * 2;
    const sx = Math.cos(ang) * (MAP_R + 14), sz = Math.sin(ang) * (MAP_R + 14);
    const tx = -sx + (Math.random() - 0.5) * 30, tz = -sz + (Math.random() - 0.5) * 30;
    const n = Math.hypot(tx - sx, tz - sz) || 1;
    const speed = 7;
    const grp = makeStormCloud();
    grp.position.set(sx, 15, sz);
    scene.add(grp);
    storm = { grp, x: sx, z: sz, dx: (tx - sx) / n * speed, dz: (tz - sz) / n * speed, life: (n + 24) / speed, flashT: 0.8 };
    banner('⛈ Un orage balaye la vallée — il lessive la peinture !');
    tone(90, 0.7, 'sawtooth', 0.06); tone(60, 0.9, 'sawtooth', 0.05, 0.2);
  }
  if (!storm) return;
  storm.life -= dt;
  storm.x += storm.dx * dt; storm.z += storm.dz * dt;
  storm.grp.position.set(storm.x, 15, storm.z);
  if (isSolid(island, storm.x, storm.z)) erasePaintAt(storm.x, storm.z, 5.2);
  const rainCount = isCoarse ? 0 : 3;
  for (let k = 0; k < rainCount; k++) {
    const a = Math.random() * Math.PI * 2, rr = Math.random() * 5.2;
    const mesh = new THREE.Mesh(RAIN_GEO, RAIN_MAT);
    mesh.position.set(storm.x + Math.cos(a) * rr, 13 - Math.random() * 3, storm.z + Math.sin(a) * rr);
    scene.add(mesh);
    particles.push({ mesh, vx: storm.dx * 0.4, vy: -26, vz: storm.dz * 0.4, scale: 1, isRain: true });
  }
  // éclairs : onde blanche + grondement
  storm.flashT -= dt;
  if (storm.flashT <= 0) {
    storm.flashT = 1.2 + Math.random() * 2.4;
    spawnShock(storm.x, storm.z, new THREE.Color(0xdfe8ff), 9, 0.35);
    tone(65 + Math.random() * 45, 0.45, 'sawtooth', 0.05);
  }
  if (storm.life <= 0) {
    scene.remove(storm.grp);
    storm = null;
    stormT = 55 + Math.random() * 50;
  }
}

/* ============================== Boucle principale ============================== */
const camPos = new THREE.Vector3(0, 30, 24);
const camLook = new THREE.Vector3();
const _camTarget = new THREE.Vector3();
const _camLookTarget = new THREE.Vector3();
const _cloudDecomp = new THREE.Vector3();
const _cloudM = new THREE.Matrix4();
const _cloudQ = new THREE.Quaternion();
const _cloudS = new THREE.Vector3();

/** Place immédiatement la caméra sur le Leader joueur (évite de démarrer sur
    le centre de carte / une base adverse après l'orbite du menu). */
function snapCameraToPlayer() {
  const me = factions[0];
  if (!me?.leader) return;
  const zoom = Math.min(26 + Math.sqrt(me.count || 1) * 0.8, 44) * camDistMul;
  camPos.set(me.leader.x, zoom * 0.88, me.leader.z + zoom * 0.68);
  camLook.set(me.leader.x, 0, me.leader.z);
  camera.position.copy(camPos);
  camera.lookAt(camLook);
}

/* ============================== Pouvoirs actifs ==============================
   Registry dans src/sim/powers.js. Chaque faction équipe 2 slots ; les VFX
   (totem, dôme…) et la sim (conversion en zone, immunité) vivent ici. */

/* Kit de départ par perso — 2 slots choisis dans le pool {preche, sanctuaire,
   anatheme}. Assignations qui collent à l'archétype de chaque Leader ;
   les persos sans kit propre héritent d'un pair "polyvalent". */

/* Texture procédurale : grille d'hexagones (traits blancs sur transparent),
   posée sur la sphère du dôme en additive blending. */
let _hexTex = null;
function getHexTexture() {
  if (_hexTex) return _hexTex;
  const s = 512;
  const cv = document.createElement('canvas');
  cv.width = cv.height = s;
  const c = cv.getContext('2d');
  c.clearRect(0, 0, s, s);
  c.strokeStyle = 'rgba(255,255,255,0.92)';
  c.lineWidth = 2.2;
  const R = 34;           // rayon hex en px
  const W = R * Math.sqrt(3);
  const H = R * 1.5;
  for (let row = -1; row * H < s + R; row++) {
    for (let col = -1; col * W < s + W; col++) {
      const cx = col * W + ((row & 1) ? W / 2 : 0);
      const cy = row * H;
      c.beginPath();
      for (let i = 0; i < 6; i++) {
        const a = Math.PI / 3 * i - Math.PI / 2;
        const px = cx + Math.cos(a) * R;
        const py = cy + Math.sin(a) * R;
        if (i === 0) c.moveTo(px, py); else c.lineTo(px, py);
      }
      c.closePath();
      c.stroke();
    }
  }
  _hexTex = new THREE.CanvasTexture(cv);
  _hexTex.colorSpace = THREE.SRGBColorSpace;
  _hexTex.wrapS = _hexTex.wrapT = THREE.RepeatWrapping;
  return _hexTex;
}

/** Instancie le mesh d'un dôme Sanctuaire : sphère hex + halo doux + anneau. */
function makeShieldGroup(x, z, color, radius) {
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  const col = new THREE.Color(color);
  const tex = getHexTexture();
  /* Sphère principale texturée : donne le motif alvéolé. */
  const sphereGeo = new THREE.SphereGeometry(radius, 32, 24);
  const sphereMat = new THREE.MeshBasicMaterial({
    color: col, map: tex,
    transparent: true, opacity: 0.62,
    depthWrite: false, side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
  });
  const sphere = new THREE.Mesh(sphereGeo, sphereMat);
  sphere.position.y = radius * 0.55;   // demi-sphère plutôt qu'orbe flottant
  g.add(sphere);
  /* Halo intérieur diffus. */
  const glowGeo = new THREE.SphereGeometry(radius * 0.96, 20, 14);
  const glowMat = new THREE.MeshBasicMaterial({
    color: col, transparent: true, opacity: 0.10,
    depthWrite: false, blending: THREE.AdditiveBlending,
  });
  const glow = new THREE.Mesh(glowGeo, glowMat);
  glow.position.y = radius * 0.55;
  g.add(glow);
  /* Anneau au sol : ancre visuelle. */
  const ringGeo = new THREE.RingGeometry(radius * 0.94, radius * 1.02, 48).rotateX(-Math.PI / 2);
  const ring = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({
    color: col, transparent: true, opacity: 0.85,
    depthWrite: false, blending: THREE.AdditiveBlending,
  }));
  ring.position.y = 0.06;
  g.add(ring);
  g.userData = { sphere, glow, ring, radius };
  return g;
}

/** Tick des dômes : suit le Leader, marque les fidèles immunisés, anime. */
function updateShields(dt) {
  for (let i = activeShields.length - 1; i >= 0; i--) {
    const s = activeShields[i];
    s.life -= dt;
    if (s.life <= 0) {
      scene.remove(s.grp);
      disposeGroup(s.grp);
      activeShields.splice(i, 1);
      continue;
    }
    /* Suit le Leader s'il bouge. */
    if (s.follow) {
      const f = factions[s.factionIdx];
      if (f?.leader && f.alive) {
        s.x = f.leader.x; s.z = f.leader.z;
        s.grp.position.set(s.x, f.leader.y || 0, s.z);
      }
    }
    /* Marque les fidèles propres dans le rayon comme immunisés
       jusqu'à un peu après ce tick (le check se fait par timestamp). */
    const r2 = s.radius * s.radius;
    const until = elapsed + 0.12;
    for (let j = 0; j < agents.length; j++) {
      const a = agents[j];
      if (!a || a.dead) continue;
      const owner = (a.followerOf ?? -1);
      if (owner !== s.factionIdx) continue;
      const dx = a.x - s.x, dz = a.z - s.z;
      if (dx * dx + dz * dz > r2) continue;
      a._sanctUntil = until;
    }
    /* Anim douce : pulse d'opacité + légère rotation du motif hex. */
    const k = 1 - Math.max(0, s.life) / s.max;
    const ud = s.grp.userData;
    if (ud) {
      const pulse = 0.85 + 0.15 * Math.sin(elapsed * 5);
      ud.sphere.material.opacity = 0.62 * (1 - k * 0.4) * pulse;
      ud.glow.material.opacity = 0.10 * (1 - k * 0.3);
      ud.ring.material.opacity = 0.85 * (1 - k * 0.35) * pulse;
      ud.sphere.rotation.y += dt * 0.35;
    }
  }
}

/** Instancie le mesh d'Anathème : anneau rouge tournant au-dessus de la tête
    + petite sphère noire pulsante. Le groupe suit le Leader ciblé via update. */
function makeCurseGroup(color) {
  const g = new THREE.Group();
  g.visible = false; // Désactivé à la demande de l'utilisateur (suppression de la boule noire et des anneaux)
  return g;
}

/** Tick des malédictions : suit la cible, draine le fuel, anime, expire. */
function updateCurses(dt) {
  for (let i = activeCurses.length - 1; i >= 0; i--) {
    const c = activeCurses[i];
    c.life -= dt;
    const target = factions[c.targetIdx];
    /* Cible morte / disparue → on ferme la malédiction proprement. */
    if (!target || !target.alive) c.life = 0;
    if (c.life <= 0) {
      scene.remove(c.grp);
      disposeGroup(c.grp);
      activeCurses.splice(i, 1);
      continue;
    }
    /* Suit la tête de la cible. */
    if (target.leader) {
      c.grp.position.set(target.leader.x, target.leader.y || 0, target.leader.z);
    }
    /* Drain de fuel — s'arrête à 0, ne descend pas dans le négatif. */
    target.fuel = Math.max(0, (target.fuel || 0) - c.drainRate * dt);
    /* Anim des runes. */
    const ud = c.grp.userData;
    if (ud && ud.ring) {
      ud.ring.rotation.y += dt * 2.2;
      ud.ring2.rotation.y -= dt * 3.0;
      const pulse = 0.85 + 0.15 * Math.sin(elapsed * 7);
      ud.ring.material.opacity = 0.9 * pulse;
      ud.ring2.material.opacity = 0.75 * pulse;
      ud.orb.scale.setScalar(0.9 + 0.15 * Math.sin(elapsed * 8));
    }
  }
}

/** Instancie le mesh d'un totem à (x,z) : bougie + halo bas + rayon vertical. */
function makeTotemGroup(x, z, color, radius) {
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  const col = new THREE.Color(color);
  /* Base : anneau rayon = portée de conversion, pulsera avec le temps. */
  const ringGeo = new THREE.RingGeometry(radius * 0.94, radius, 48).rotateX(-Math.PI / 2);
  const ring = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({
    color: col, transparent: true, opacity: 0.72, depthWrite: false,
    blending: THREE.AdditiveBlending,
  }));
  ring.position.y = 0.06;
  ring.renderOrder = 2;
  g.add(ring);
  /* Disc plein légèrement plus petit — donne le "sol chaud". */
  const discGeo = new THREE.CircleGeometry(radius, 40).rotateX(-Math.PI / 2);
  const disc = new THREE.Mesh(discGeo, new THREE.MeshBasicMaterial({
    color: col, transparent: true, opacity: 0.10, depthWrite: false,
    blending: THREE.AdditiveBlending,
  }));
  disc.position.y = 0.05;
  disc.renderOrder = 1;
  g.add(disc);
  /* Faisceau vertical : pilier de lumière au-dessus du totem. */
  const beamGeo = new THREE.CylinderGeometry(0.32, 0.55, 5.2, 10, 1, true).translate(0, 2.6, 0);
  const beam = new THREE.Mesh(beamGeo, new THREE.MeshBasicMaterial({
    color: col, transparent: true, opacity: 0.55, depthWrite: false,
    side: THREE.DoubleSide, blending: THREE.AdditiveBlending,
  }));
  g.add(beam);
  /* Petite sphère brillante au sommet — accent visuel. */
  const orbGeo = new THREE.SphereGeometry(0.32, 12, 8);
  const orb = new THREE.Mesh(orbGeo, new THREE.MeshBasicMaterial({
    color: col, transparent: true, opacity: 0.95, depthWrite: false,
  }));
  orb.position.y = 2.7;
  g.add(orb);
  g.userData = { ring, disc, beam, orb };
  return g;
}

/** Convertit jusqu'à `maxAgents` gris dans un rayon (une "vague" de Prêche). */
function totemConvertWave(t, maxAgents = 3) {
  const f = factions[t.factionIdx];
  if (!f || !f.alive) return;
  const r2 = t.radius * t.radius;
  let taken = 0;
  for (let i = 0; i < agents.length && taken < maxAgents; i++) {
    const a = agents[i];
    if (!a || a.dead) continue;
    if ((a.followerOf ?? -1) === f.i) continue;   // déjà à nous
    const dx = a.x - t.x, dz = a.z - t.z;
    if (dx * dx + dz * dz > r2) continue;
    finishConvert(a, f);
    /* Petit flash au sol pour raconter la conversion. */
    spawnShock(a.x, a.z, f.color, 1.6, 0.28);
    taken++;
  }
}


/** Tick tous les totems : décroit la vie, joue les vagues, anime le mesh. */
function updateTotems(dt) {
  for (let i = activeTotems.length - 1; i >= 0; i--) {
    const t = activeTotems[i];
    t.life -= dt;
    t.tickAcc += dt;
    if (t.tickAcc >= t.tickRate) {
      t.tickAcc = 0;
      totemConvertWave(t, 3);
    }
    const k = 1 - Math.max(0, t.life) / t.max; // 0 = frais, 1 = fin
    const ud = t.grp?.userData;
    if (ud) {
      const pulse = 0.85 + 0.15 * Math.sin(elapsed * 6);
      ud.ring.material.opacity = 0.72 * (1 - k * 0.5) * pulse;
      ud.disc.material.opacity = 0.10 * (1 - k);
      ud.beam.material.opacity = 0.55 * (1 - k * 0.6) * pulse;
      ud.orb.material.opacity = 0.95 * (1 - k * 0.35);
      ud.orb.position.y = 2.7 + Math.sin(elapsed * 4) * 0.08;
    }
    if (t.life <= 0) {
      scene.remove(t.grp);
      disposeGroup(t.grp);
      activeTotems.splice(i, 1);
    }
  }
}


/* Le Sanctuaire de Base ne collecte plus rien : le territoire vient des
   sanctuaires de la vallée. Neutralisé plutôt que supprimé — en l'état il
   dévorait tout le cortège dès qu'on approchait de sa propre cour. */
function checkBaseDeposits() {}

/* ---------------------- Repeuplement en esprits ----------------------
   La vallée ne se vide plus : on maintient en permanence un nombre d'esprits
   SAUVAGES proportionnel au nombre de cultes. Ce qui compte pour le rythme,
   ce n'est pas le stock total mais ce qui reste à chasser — un esprit dans le
   cortège d'un rival n'est disponible pour personne.

   Le repeuplement est TYPÉ, et c'est le point important : un autel réclame dix
   esprits d'un seul élément. Si un type tombait sous ce seuil, l'autel
   deviendrait tout simplement infaisable. On fait donc toujours réapparaître
   l'élément le plus rare.

   Contrainte technique : l'élément d'un esprit est déterminé par son id
   (`variantOf(id) = CROWD_VARIANT[id % 30]`). On ne peut donc pas choisir
   librement le type d'un nouvel agent — il faut piocher dans les ids libérés
   celui qui porte le bon élément. */
const SPIRITS_PER_PLAYER = 40;   // 3 cultes → 120 esprits, ~20 par élément,
                                 // soit le double de ce qu'un autel demande
const SPIRIT_RESPAWN_RATE = 1.6; // apparitions par seconde au maximum
const SPIRIT_SPAWN_MIN_D = 16;   // distance minimale à tout Leader

let respawnAcc = 0;
const _wildByElem = new Int32Array(9);

function spiritTarget() {
  return SPIRITS_PER_PLAYER * Math.max(1, factions.length);
}

/** Fait réapparaître un esprit de l'élément voulu en recyclant un id libre.
    @returns true si un esprit est né */
function respawnSpirit(variant) {
  let idx = -1;
  for (let i = freeAgentIds.length - 1; i >= 0; i--) {
    if (variantOf(freeAgentIds[i]) === variant) { idx = i; break; }
  }
  if (idx < 0) return false;

  /* Loin des Leaders : un esprit qui naît sous le nez d'un culte serait cueilli
     avant d'avoir couru, et le repeuplement récompenserait le camping. */
  let pt = null;
  for (let tries = 0; tries < 14; tries++) {
    const p = islandRandomPoint(island, 5, Infinity);
    if (!p) break;
    const pz = p.z ?? p.y;
    let far = true;
    for (const f of factions) {
      if (!f || !f.alive || !f.leader) continue;
      if (Math.hypot(p.x - f.leader.x, pz - f.leader.z) < SPIRIT_SPAWN_MIN_D) { far = false; break; }
    }
    pt = { x: p.x, z: pz };
    if (far) break;
  }
  if (!pt) return false;

  /* On retire l'id choisi puis on laisse spawnAgent le recycler : il dépile la
     fin de la liste, donc on y remet notre id en dernier. */
  const id = freeAgentIds.splice(idx, 1)[0];
  freeAgentIds.push(id);
  const a = spawnAgent(pt.x, pt.z);
  if (!a) return false;
  a._webFree = elapsed + 1.0;   // pas englué à la seconde même où il apparaît
  return true;
}

function updateSpiritRespawn(dt) {
  _wildByElem.fill(0);
  let wild = 0;
  for (const a of agents) {
    if (!a || a.dead) continue;
    const v = variantOf(a.id);
    if (v < ELEM_FIRST) continue;
    if ((a.followerOf ?? -1) >= 0) continue;
    _wildByElem[v]++;
    wild++;
  }

  const target = spiritTarget();
  if (wild >= target) { respawnAcc = 0; return; }

  respawnAcc += dt * SPIRIT_RESPAWN_RATE;
  let n = respawnAcc | 0;
  if (n <= 0) return;
  respawnAcc -= n;

  while (n-- > 0 && wild < target) {
    /* Toujours l'élément le plus rare : c'est ce qui garantit qu'aucun autel
       ne devient impossible à alimenter. */
    let scarcest = ELEM_FIRST, min = 1e9;
    for (let v = ELEM_FIRST; v < ELEM_FIRST + 6; v++) {
      if (_wildByElem[v] < min) { min = _wildByElem[v]; scarcest = v; }
    }
    if (!respawnSpirit(scarcest)) break;
    _wildByElem[scarcest]++;
    wild++;
  }
}


/* ---- Inventaire du cortège ----
   Les six éléments et ce qu'on en porte. C'est la lecture qu'on fait en
   marchant vers un autel — « ai-je de quoi l'alimenter ? » — donc elle doit
   tenir en un coup d'œil. On ne compte que les suivants VIVANTS du joueur :
   c'est exactement ce qui pourra être déposé.

   Les vignettes sont cuites depuis les modèles élémentaires eux-mêmes, via le
   même rendu hors-écran que les portraits. Aucune image à
   maintenir en parallèle des .glb. */
const spiritBarEl = $('hud-spirits');
const spiritChips = new Map();   // variante → { el, img, n, val }

function buildSpiritChips() {
  if (!spiritBarEl || spiritChips.size) return;
  for (const e of ELEMENTS) {
    const el = document.createElement('div');
    el.className = 'spirit-chip vide';
    el.style.setProperty('--elem', e.css);
    el.title = e.nom;
    const img = document.createElement('img');
    img.alt = '';
    img.draggable = false;
    img.src = e.img;
    el.classList.add('has-img');
    const sym = document.createElement('span');
    sym.className = 'sym';
    sym.textContent = e.sym;   // repli si l'image manque
    const n = document.createElement('span');
    n.className = 'n';
    n.textContent = '0';
    el.append(img, sym, n);
    spiritBarEl.appendChild(el);
    spiritChips.set(e.v, { el, img, n, val: -1 });
  }
}

const _spiritCounts = new Int32Array(9);

function updateSpiritsUI() {
  if (!spiritBarEl) return;
  buildSpiritChips();

  _spiritCounts.fill(0);
  for (const a of agents) {
    if (!a || a.dead || (a.followerOf ?? -1) !== 0) continue;
    const v = variantOf(a.id);
    if (v >= ELEM_FIRST) _spiritCounts[v]++;
  }
  for (const e of ELEMENTS) {
    const chip = spiritChips.get(e.v);
    if (!chip) continue;
    const n = _spiritCounts[e.v];
    if (n === chip.val) continue;
    chip.val = n;
    chip.n.textContent = String(n);
    chip.el.classList.toggle('vide', n === 0);
    /* « Plein » = de quoi éveiller un autel d'un seul passage. */
    /* « Plein » = de quoi prendre le sanctuaire le moins cher qui réclame cet
       élément. Le seuil suit donc l'escalade au lieu d'être figé. */
    let cheapest = Infinity;
    for (const alt of altars) if (alt.variant === e.v) cheapest = Math.min(cheapest, alt.need - alt.filled);
    chip.el.classList.toggle('plein', cheapest !== Infinity && n >= cheapest);
  }
}

function update(dt) {
  /* « Le temps s'emballe » (carte hasard) : on accélère la SEULE horloge de
     partie, pas le pas de simulation. Multiplier `dt` accélérerait aussi les
     déplacements et les collisions — le jeu deviendrait injouable et la
     physique franchirait les murs. Ici, seul le chrono court plus vite : la fin
     de partie se rapproche, ce qui est exactement ce que la carte promet. */
  elapsed += dt * (worldMods.timeRushT > 0 ? worldMods.timeRushMul : 1);
  checkBaseDeposits(dt);
  tickWorldMods(dt);
  updateHazardCards(dt);

  // recharge du sprint (cadence fixe, identique pour tous)
  if (factions[0] && factions[0].alive) {
    playerBoostCharge = Math.min(1, playerBoostCharge + dt / BOOST_CD);
  }
  /* Cooldowns des pouvoirs (tous slots) + tick des VFX actifs. */
  updateShields(dt);
  updateTotems(dt);
  updateCurses(dt);
  updateAttackUI();

  /* -- Jugement désactivé : plus d'anneau qui referme la vallée -- */
  judgeR = 999;
  judgeMesh.visible = false;
  if (duelT >= 0) {
    duelT = -1;
    duelEl.classList.add('hidden');
    duelEl.classList.remove('urgent');
  }

  /* -- Leaders : direction & déplacement (extrait dans src/sim/leader-tick.js) -- */
  _leaderTickCtx.leaderSpeed = leaderSpeed;
  _leaderTickCtx.aiThink = aiThink;
  _leaderTickCtx.skillMods = skillMods;
  _leaderTickCtx.teams = teams;
  _leaderTickState.factions = factions;
  _leaderTickState.island = island;
  _leaderTickState.judgeR = judgeR;
  _leaderTickState.elapsed = elapsed;
  _leaderTickInput.x = input.x; _leaderTickInput.z = input.z;
  _leaderTickInput.keys = keys;

  /* -- Multi : plus de connexion P2P = plus de match. -- */
  if (multiMode && !net.state.connected) {
    banner('⚠ Connexion P2P perdue');
    endGame();
    return;
  }

  /* -- Multi : rafraîchir la cible réseau des adversaires AVANT leur tick, pour
        qu'ils peignent bien leur traînée le long du chemin P2P. -- */
  if (multiMode && net.state.connected) {
    const remoteLeaders = net.getLeaders();
    if (remoteLeaders) {
      for (const f of factions) {
        if (!f.remote || !f.sessionId) continue;
        const rl = remoteLeaders.get(f.sessionId);
        if (!rl) continue;
        f.alive = !!rl.alive;
        f.netTarget = { x: rl.x, z: rl.z, dx: rl.dx, dz: rl.dz };
      }
    }
  }

  _stepLeaders(_leaderTickState, _leaderTickInput, dt, _leaderTickCtx);

  /* -- P2P : l'hôte diffuse toutes les positions à 20 Hz ; l'invité envoie
        sa propre position et ses stats à l'hôte. -- */
  if (multiMode && net.state.connected) {
    netStatsT -= dt;
    if (net.isHost()) {
      /* -- Hôte : refléter les stats reçues des invités dans leurs factions
            locales AVANT de calculer et diffuser le classement. Sinon
            grisAbs/count restent à 0 côté hôte et le podium diverge. -- */
      const remoteStats = net.getLeaders();
      if (remoteStats) {
        for (const f of factions) {
          if (!f.remote || !f.sessionId) continue;
          const rs = remoteStats.get(f.sessionId);
          if (!rs) continue;
          if (typeof rs.grisAbs === 'number') f.grisAbs = rs.grisAbs;
          if (typeof rs.count === 'number') f.count = rs.count;
        }
      }
      if (netStatsT <= 0) {
        netStatsT = 1 / 20;
        const data = factions.filter(f => f.sessionId).map(f => {
          const s = factionScore(f);
          return {
            sid: f.sessionId,
            x: f.leader.x, z: f.leader.z,
            dx: f.leader.dx, dz: f.leader.dz,
            alive: f.alive,
            score: s.total, pct: s.pct,
            grisAbs: f.grisAbs | 0, count: f.count | 0,
            playerName: f.cult.name, cultColor: f.cult.c, cultSym: f.cult.sym,
            isBot: f.isBot, seatIndex: f.seatIndex ?? 0,
          };
        });
        net.broadcastLeaders(data, elapsed);
      }
    } else {
      const me = factions[0];
      if (me) net.sendPos(me.leader.x, me.leader.z, me.leader.dx, me.leader.dz);
      if (netStatsT <= 0) {
        /* Envoi plus rapproché (4 Hz au lieu de 2 Hz) : réduit le décalage
           des grisAbs/count côté hôte lors du calcul du podium final. */
        netStatsT = 0.25;
        const s = factionScore(me);
        net.sendStats(me.sessionId, {
          count: me.count | 0, grisAbs: me.grisAbs | 0,
          score: s.total, pct: s.pct,
        });
      }
    }
    /* -- Fin de match : l'hôte reste seul maître du signal. Quand il touche
          MATCH_DUR, il diffuse UN dernier snapshot frais (pour que le podium
          reflète bien les toutes dernières peintures) PUIS déclenche `over`.
          L'invité attend ce message : c'est la seule façon d'avoir un
          classement identique sur les deux écrans (chacun lisait sinon sa
          propre snapshot décalée de quelques centaines de ms). -- */
    if (net.state.phase === 'over') { endGame(); return; }
  }
  // la texture de peinture n'est renvoyée au GPU que ~8 fois par seconde
  paintUploadT -= dt;
  if (paintDirty && paintUploadT <= 0) {
    if (paintNeedsClip) { clipPaintToIsland(); paintNeedsClip = false; }
    paintTex.needsUpdate = true;
    paintDirty = false;
    paintUploadT = 0.12;
  }

  /* -- Leaders : répulsion douce (extrait dans src/sim/leader-tick.js) -- */
  _stepLeaderRepulsion(_leaderTickState, dt, _leaderTickCtx);

  /* Éclairage diurne agréable et fixe (le jour ne passe plus vers la nuit) —
     seule la carte « Nuit sans lune » vient l'assombrir temporairement. */
  applyDayCycle(DAY_FIXED);
  soundEngine.setMusicIntensity(0.5);
  soundEngine.updateMusic(dt);

  /* -- Intégration + rendu instancié de la foule : extrait dans
        src/sim/crowd-tick.js. La boucle est identique, mais toutes les
        dépendances passent par ctx — le sim tournera headless côté serveur. */
  _crowdTickState.agents = agents;
  _crowdTickState.factions = factions;
  _crowdTickState.island = island;
  _crowdTickState.elapsed = elapsed;
  _crowdTickState.bombs = bombs;
  _crowdTickState.grayPanic = worldMods.grayPanicT > 0;
  _crowdTickState.zeal = worldMods.zealT > 0;
  if (!_crowdTickCtx.finishConvert) {
    // câblage tardif : ces fonctions sont définies plus haut mais on installe
    // les références au premier appel, une fois pour toutes.
    _crowdTickCtx.finishConvert = finishConvert;
    _crowdTickCtx.stampPaintAt = stampPaintAt;
    _crowdTickCtx.setAgentColor = setAgentColor;
    _crowdTickCtx.crowdOf = crowdOf;
    _crowdTickCtx.slotOf = slotOf;
    _crowdTickCtx.trimCrowdCounts = trimCrowdCounts;
    _crowdTickCtx.spawnSoulBurst = spawnSoulBurst;
    _crowdTickCtx.tone = tone;
    _crowdTickCtx._convCol = _convCol;
    _crowdTickCtx.stealSpiritFromLeader = stealSpiritFromLeader;
  }
  _stepCrowd(_crowdTickState, dt, _crowdTickCtx);
  updateBurrowEvents(dt);

  for (const m of crowds) { m.instanceMatrix.needsUpdate = true; }

  /* -- Morph Leader : tous les convertis ; cristaux orbitaux OFF ; âmes OK -- */
  ensureAllFollowerMorphs();
  updateCrystals(dt, elapsed, factions);
  /* -- Leaders : visuel -- */
  for (const f of factions) {
    if (!f.alive) continue;

    const g = f.grp;
    // seul le franchissement d'une brèche soulève le Leader du sol
    g.position.set(f.leader.x, f.leader.y || 0, f.leader.z);
    const sp = Math.hypot(f.leader.dx, f.leader.dz);
    if (sp > 0.5) g.userData.body.rotation.y = Math.atan2(f.leader.dx, f.leader.dz);

    // --- Bruits de pas dynamiques selon la surface (Joueur) ---
    if (f.i === 0 && sp > 0.8) {
      playerStepTimer = (playerStepTimer || 0) + dt * (sp / 4.5);
      if (playerStepTimer >= 0.28) {
        playerStepTimer = 0;
        const owner = paintOwnerAt(f.leader.x, f.leader.z);
        let surf = 'dirt';
        if (owner >= 0) {
          surf = 'paint';
        } else if (currentBiomeKey === 'snow') {
          surf = 'snow';
        } else if (currentBiomeKey === 'desert') {
          surf = 'sand';
        }
        soundEngine.playFootstep(surf, sp > 10 ? 1.2 : 0.95);
      }
    }
    // léger roulis d'épaules sur le pas, calé sur l'horloge du shader
    const walk = Math.min(1, sp / 4);
    g.userData.body.rotation.z = 0;
    /* À terre : le corps bascule face au sol. Le relevé se fait en fondu sur
       la fin du décompte, pour qu'on voie le Leader se remettre debout au lieu
       de le voir claquer d'une pose à l'autre. */
    const down = f.downT || 0;
    /* Recul du tir : le buste se cabre en arrière et revient. Il vit sur le
       même axe que la chute — la chute l'emporte, un Leader à terre ne tire
       pas. Amorti vite (×5) : c'est un contrecoup, pas une animation. */
    f._recoil = Math.max(0, (f._recoil || 0) - dt * 5);
    g.userData.body.rotation.x = down > 0
      ? -Math.PI * 0.5 * Math.min(1, down / (LEADER_DOWN_T * 0.45))
      : f._recoil;
    /* Locomotion du moine riggé : fondu enchaîné marche / course / sprint selon
       la vitesse au sol, cadence du clip calée sur cette vitesse (à l'arrêt le
       clip gèle en douceur, la direction étant déjà lissée par l'inertie). */
    if (g.userData.crystal) {
      g.userData.crystal.rotation.y += dt * 2.5;
      g.userData.crystal.position.y = 1.1 + Math.sin(elapsed * 4 + f.i) * 0.05;
    }

    // Plus de combat : la bulle de bouclier reste éteinte
    if (g.userData.shield) g.userData.shield.visible = false;

    if (g.userData.gaits) {
      const gi = sp < MONK_GAIT_SPLITS[0] ? 0 : sp < MONK_GAIT_SPLITS[1] ? 1 : 2;
      const k = Math.min(1, dt * 6);
      for (let i = 0; i < g.userData.gaits.length; i++) {
        const gait = g.userData.gaits[i];
        if (!gait) continue;
        const w = gait.action.getEffectiveWeight();
        gait.action.setEffectiveWeight(w + ((i === gi ? 1 : 0) - w) * k);
        gait.action.timeScale = Math.min(1.6, sp / gait.ref);
      }
      g.userData.mixer.update(dt);
    }
    const ir = influenceRadius(f.count, f.i);
    const ringMesh = g.userData.ring;
    ringMesh.scale.setScalar(ir);
    // hauteur constante, au-dessus des ondulations du sol (±0.35)
    ringMesh.position.y = 0.45;
    // Extase : l'anneau du joueur vire à l'or et flamboie
    if (f.i === 0 && ecstasyT > 0) {
      ringMesh.material.uniforms.uColor.value.set(0xffe259);
    } else {
      ringMesh.material.uniforms.uColor.value.copy(f.color);
    }
    if (g.userData.crystal) {
      g.userData.crystal.rotation.y += dt * 2.5;
      g.userData.crystal.position.y = 1.1 + Math.sin(elapsed * 4 + f.i) * 0.05;
    }
  }

  /* -- Série et Ralliement : décomptes -- */
  if (streak > 0) {
    streakT -= dt;
    if (streakT <= 0) streak = 0;
  }
  showStreak();
  rallyCd = Math.max(0, rallyCd - dt);
  rallyT = Math.max(0, rallyT - dt);

  /* -- Jauge de peinture (remplace la Ferveur dans la barre du HUD) -- */
  updateRaceUI();
  updateAttacks(dt);
  updateAltars(dt);
  updateSpiritsUI();
  updateSpiritRespawn(dt);
  updateSpiritDives(dt);

  updateShocks(dt);
  updateParticles(dt);
  updateBombs(dt);
  updateStorm(dt);

  /* -- Plus aucune réapparition : les gris de départ sont tout le carburant de
        la partie. Quand le dernier est absorbé, le gong sonne immédiatement. -- */
  /* La vallée ne peut plus se vider : les esprits se repeuplent en continu
     (updateSpiritRespawn). L'ancienne fin « plus un seul gris » aurait donné
     une conclusion bâtarde bien avant le gong. */

  /* -- Victoire -- Deux sorties possibles, vérifiées deux fois par seconde :
        un culte franchit WIN_PCT de la vallée, ou le chrono de MATCH_DUR
        s'achève et le plus grand territoire l'emporte. Le décompte du temps
        vit dans elapsed, déjà avancé par la boucle. */
  winT -= dt;
  if (winT <= 0) {
    winT = 0.5;
    let best = null, bestPct = -1;
    for (const f of factions) {
      if (!f || !f.alive) continue;
      const p = paintPct(f);
      if (p > bestPct) { bestPct = p; best = f; }
    }
    if (best && bestPct >= WIN_PCT) {
      banner(best.i === 0
        ? `🏆 La vallée est vôtre — ${bestPct.toFixed(0)} % !`
        : `💀 Le Culte ${best.cult.name} domine la vallée…`);
      endGame();
      return;
    }
    if (elapsed >= MATCH_DUR) {
      banner('⏳ Le temps est écoulé !');
      endGame();
      return;
    }
  }

  /* -- HUD -- */
  hudT -= dt;
  if (hudT <= 0) { hudT = 0.25; updateHUD(); drawMinimap(); }
  updateBanner(dt);

  /* -- Caméra (vue isométrique claire et équilibrée). Le facteur `camDistMul`
        vient du réglage utilisateur (Proche/Standard/Éloignée) : il multiplie
        à la fois la hauteur et le recul, préservant l'angle iso. -- */
  const me = factions[0];
  const zoom = Math.min(26 + Math.sqrt(me.count) * 0.8, 44) * camDistMul;
  _camTarget.set(me.leader.x, zoom * 0.88, me.leader.z + zoom * 0.68);
  camPos.lerp(_camTarget, Math.min(1, dt * CAM_RESP));
  shake = Math.max(0, shake - dt);
  const sh = shake * 0.6;
  camera.position.set(
    camPos.x + (Math.random() - 0.5) * sh,
    camPos.y + (Math.random() - 0.5) * sh,
    camPos.z + (Math.random() - 0.5) * sh);
  _camLookTarget.set(me.leader.x, 0, me.leader.z);
  camLook.lerp(_camLookTarget, Math.min(1, dt * CAM_LOOK_RESP));
  camera.lookAt(camLook);

  /* -- Soleil --
     Le cycle jour/nuit a été figé à DAY_FIXED (voir applyDayCycle plus haut),
     mais ce bloc lisait encore `dayT`, une variable qui n'existe nulle part :
     il levait donc une ReferenceError à chaque frame, ce qui interrompait
     silencieusement la fin de update() — soleil, lanterne et tout ce qui suit
     ne s'exécutaient jamais. */
  const az = Math.PI * (0.12 + 0.76 * DAY_FIXED);
  const arc = Math.min(1, Math.max(0, (DAY_FIXED - 0.04) / 0.88));
  const el = 5 + 42 * Math.sin(Math.PI * arc);
  sun.position.set(me.leader.x + Math.cos(az) * 34, el, me.leader.z + 18);
  sun.target.position.set(me.leader.x, 0, me.leader.z);
  /* Même direction pour l'éclairage personnages (intensité fixe, hors pénombre). */
  charSun.position.copy(sun.position);
  charSun.target.position.copy(sun.target.position);
  charSun.target.updateMatrixWorld();

  /* ---- Lanterne du joueur ----
     Pilotée par `nightK`, la pénombre RÉELLE de l'image.

     Elle lisait auparavant `DAY_FIXED`, une constante figée à 0,42 : le calcul
     `(0.42 - 0.78) / 0.22` rendait toujours un négatif, donc zéro. La lanterne
     n'a jamais éclairé quoi que ce soit depuis que le cycle du jour a été figé,
     et le commentaire qui la disait « pilotée par nightK » décrivait une
     intention, pas le code. C'est pour ça qu'une nuit noire laissait le joueur
     sans halo.

     `nightK` monte aussi bien au crépuscule que sous la carte « Nuit sans
     lune » : la lanterne sert donc les deux cas sans traitement particulier. */
  /* Zone morte : l'heure figée de la vallée laisse `nightK` à ~0,05 en plein
     jour. Sans ce seuil, un halo pâle traînerait en permanence sous le joueur
     et l'effet de nuit n'aurait plus rien de remarquable quand il arrive. */
  const lamp = Math.max(0, (nightK - 0.15) / 0.85);
  playerLamp.position.set(me.leader.x, (me.leader.y || 0) + 2.4, me.leader.z);
  playerLamp.intensity = lamp * 22;
  /* Portée élargie dans le noir complet : c'est la « zone de lumière » dans
     laquelle on joue, elle doit contenir le personnage et de quoi lire le sol
     devant lui. */
  playerLamp.distance = 18 + lamp * 16;

  lampGlow.visible = lamp > 0.02;
  if (lampGlow.visible) {
    lampGlow.position.set(me.leader.x, (me.leader.y || 0) + 0.06, me.leader.z);
    /* Le disque au sol fait le gros du travail : le rendu toon quantifie la
       lumière en paliers durs, seul un dégradé peint donne un bord diffus. */
    lampGlow.material.opacity = 0.1 + lamp * 0.75;
    const s = 0.8 + lamp * 0.7;
    lampGlow.scale.set(s, 1, s);
  }

  /* -- Le vide : éclats en suspension, brume et poussière lumineuse -- */
  updateVoid(dt, elapsed);
}

/* ============================== Menu ============================== */
const diffContainer = $('difficulty');
if (diffContainer) {
  diffContainer.querySelectorAll('.diff-btn').forEach(btn => {
    if (btn.dataset.diff === currentDifficulty) {
      btn.classList.add('sel');
    } else {
      btn.classList.remove('sel');
    }
    btn.addEventListener('pointerdown', () => {
      audioInit();
      soundEngine.playUIClick();
      currentDifficulty = btn.dataset.diff;
      localStorage.setItem('cultio_difficulty', currentDifficulty);
      diffContainer.querySelectorAll('.diff-btn').forEach(b => b.classList.remove('sel'));
      btn.classList.add('sel');
    });
  });
}

/* Réglage vue caméra (Proche / Standard / Éloignée) — persistant, appliqué
   dès la prochaine frame de partie via `camDistMul`. */
const camDistPicker = $('cam-dist-picker');
if (camDistPicker) {
  const syncCamDistUI = () => {
    camDistPicker.querySelectorAll('.cam-dist-btn').forEach((btn) => {
      btn.classList.toggle('is-selected', btn.dataset.dist === currentCamDist);
    });
  };
  syncCamDistUI();
  camDistPicker.querySelectorAll('.cam-dist-btn').forEach((btn) => {
    btn.addEventListener('pointerdown', () => {
      const key = btn.dataset.dist;
      if (!(key in CAM_DIST_MUL)) return;
      audioInit();
      soundEngine.playUIClick();
      currentCamDist = key;
      camDistMul = CAM_DIST_MUL[key];
      localStorage.setItem(CAM_DIST_KEY, key);
      syncCamDistUI();
    });
  });
}

/* Qualité graphique (Perf. / Équilibré / Belle). DPR + ombres tout de suite ;
   changement d'antialias → reload (contrainte WebGL). */
const gfxPicker = $('gfx-picker');
if (gfxPicker) {
  const syncGfxUI = () => {
    gfxPicker.querySelectorAll('.cam-dist-btn').forEach((btn) => {
      btn.classList.toggle('is-selected', btn.dataset.gfx === currentGraphics);
    });
  };
  syncGfxUI();
  gfxPicker.querySelectorAll('.cam-dist-btn').forEach((btn) => {
    btn.addEventListener('pointerdown', () => {
      const key = btn.dataset.gfx;
      if (!(key in GRAPHICS)) return;
      audioInit();
      soundEngine.playUIClick();
      currentGraphics = key;
      localStorage.setItem(GRAPHICS_KEY, key);
      syncGfxUI();
      if (GRAPHICS[key].aa !== _bootGfxAA) {
        location.reload();
        return;
      }
      applyGraphicsQuality();
    });
  });
}

function updateMainMenu() {
  const save = JSON.parse(localStorage.getItem('cultio_progress_v3') || '{}');
  const statusEl = $('campaign-status');
  const btnContinue = $('btn-continue');
  const btnNewGame = $('btn-new-game');
  const btnDelete = $('btn-delete-game');

  if (save.playerName) {
    btnDelete && btnDelete.classList.remove('hidden');
    statusEl.classList.remove('hidden');
    
    const leaderAvatarEl = $('save-leader-avatar');
    if (leaderAvatarEl) {
      const AVATARS = LEADER_AVATARS;
      const src = AVATARS[save.playerLeader || 'monk'];
      leaderAvatarEl.style.backgroundImage = src ? `url('${src}')` : 'none';
    }

    const iconEl = $('save-icon');
    iconEl.style.backgroundColor = save.playerColor || '#5b6472';
    if (save.religionIcon && (save.religionIcon.startsWith('data:') || save.religionIcon.startsWith('http'))) {
      iconEl.style.backgroundImage = `url(${save.religionIcon})`;
      iconEl.textContent = '';
    } else {
      iconEl.style.backgroundImage = 'none';
      iconEl.textContent = save.religionIcon || '✦';
    }
    
    $('save-rel-name').textContent = save.religionName || 'Sans Nom';
    $('save-prophet-name').textContent = save.playerName;

    const stats = getGlobalStats();
    $('save-progress-stats').textContent = `Foi mondiale : ${stats.pct}% | ${formatBelievers(stats.believers)} fidèles`;

    btnContinue.classList.remove('hidden');
    btnNewGame.className = 'btn-secondary';
    btnNewGame.textContent = 'Nouvelle Campagne';
  } else {
    statusEl.classList.add('hidden');
    btnContinue.classList.add('hidden');
    btnDelete && btnDelete.classList.add('hidden');
    btnNewGame.className = 'big';
    btnNewGame.textContent = 'Lancer la Croisade';
  }
}

/* Enveloppe de diagnostic : une exception ici laissait le menu affiché sans
   aucun indice — le symptôme exact d'un « le jeu ne se lance pas ». */
function startGame() {
  try { startGameInner(); }
  catch (e) { showCrash('Lancement de partie', e); throw e; }
}

function startGameInner() {
  audioInit();
  // Relit la difficulté (modifiable depuis les paramètres de la carte de conquête).
  currentDifficulty = localStorage.getItem('cultio_difficulty') || currentDifficulty;
  paused = false;
  input.x = 0; input.z = 0;
  for (const k in keys) keys[k] = false;
  joyId = null; joyEl.style.display = 'none';
  if (!conquest) {
    MAX_AGENTS = AGENT_CAP;
  }
  /* 5 villageois pour 25 esprits dans le cycle de la foule : on remonte donc
     la population totale depuis la cible en esprits. */
  START_GRAYS = Math.round(SPIRITS_PER_PLAYER * NB_FACTIONS * (CROWD_CYCLE / 25));
  /* Multi : biome et graine viennent de l'hôte P2P — même vallée pour tout le monde. */
  const netSeed = multiMode ? net.getSeed() : 0;
  const biomeKey = conquest
    ? getBiomeForIso(conquest.world.iso)
    : ((multiMode && BIOMES[net.getBiome()]) ? net.getBiome() : randomBiomeKey());
  if (multiMode) withSeededRandom(netSeed, () => buildMap(biomeKey));
  else buildMap(biomeKey);
  soundEngine.startBiomeAmbient(biomeKey);
  captureDayBase();          // teinte de brouillard du biome = référence plein jour
  applyDayCycle(0);          // la partie s'ouvre à l'aube
  // ^ 0x9e3779b9 : décale la séquence pour que la foule ne rejoue pas celle du décor
  if (multiMode) withSeededRandom((netSeed ^ 0x9e3779b9) >>> 0, () => resetGame());
  else resetGame();
  $('start').classList.add('hidden');
  $('end').classList.add('hidden');
  $('hud').classList.remove('hidden');
  state = 'play';
}
/* Multi P2P : connecte via PeerJS, attend le début du match, puis démarre la
   partie en mode « multiMode » où les Leaders adverses sont pilotés par le réseau. */
async function startMultiGame(opts = {}) {
  audioInit();
  const onStatus = typeof opts.onStatus === 'function' ? opts.onStatus : () => {};
  const onLobby = typeof opts.onLobby === 'function' ? opts.onLobby : () => {};
  const code = String(opts.code || '').toUpperCase();
  const mode = opts.mode === 'create' ? 'create' : 'join';

  // Toute session précédente est fermée : pas de salon zombie ni d'IA fantôme.
  multiMode = false;
  await net.leave();

  // Enregistrer les callbacks AVANT connect pour ne rater aucun onAdd
  net.onSlotsUpdate((slots) => onLobby(slots));
  onStatus('Connexion P2P…');

  try {
    await Promise.race([
      net.connect({
        mode,
        name: opts.name || (() => {
          try {
            return JSON.parse(localStorage.getItem('cultio_progress_v3') || '{}').playerName || 'Joueur';
          } catch (_) { return 'Joueur'; }
        })(),
        leaderKey: playerLeaderKey,
        code,
      }),
      new Promise((_, rej) => setTimeout(
        () => rej(new Error('Délai dépassé — connexion P2P impossible')),
        25000,
      )),
    ]);
  } catch (e) {
    // Code introuvable / salon complet : message sec dans le panneau, pas un
    // « serveur injoignable » trompeur.
    onStatus(`⚠ ${e?.message || e}`);
    return false;
  }

  /* Synchronise immédiatement les choix pré-remplis (perso, couleur, symbole,
     nom) depuis la campagne locale vers l'hôte. Les invités s'auto-envoient
     leur config ; l'hôte l'applique aussi à son propre siège. */
  {
    const save = (() => {
      try { return JSON.parse(localStorage.getItem('cultio_progress_v3') || '{}'); }
      catch (_) { return {}; }
    })();
    const choice = {};
    if (save.playerLeader && LEADERS[save.playerLeader]) choice.leaderKey = save.playerLeader;
    if (save.playerColor) {
      const hex = parseInt(save.playerColor.replace('#', ''), 16);
      if (!isNaN(hex)) choice.cultColor = hex;
    }
    if (save.religionIcon) choice.cultSym = save.religionIcon;
    if (save.playerName) choice.name = save.playerName;
    if (Object.keys(choice).length) net.setChoice(choice);
  }

  onLobby(net.getSlots());

  /* Listener persistant : gère la partie initiale, mais aussi les rematches
     (retour lobby → nouveau start) et le retour au salon après un match. */
  let onFirstPlay;
  const firstStart = new Promise((res) => {
    onFirstPlay = res;
    net.onLeft(() => res(false));
  });
  net.onPhaseChange((p) => {
    if (p === 'play') {
      if (state === 'menu' && onFirstPlay) {
        const fn = onFirstPlay; onFirstPlay = null; fn(true);
        return;
      }
      // Rematch : l'hôte a relancé depuis le lobby post-partie.
      multiMode = true;
      conquest = null;
      $('multi-panel').classList.add('hidden');
      $('end').classList.add('hidden');
      startGame();
      banner('⚔ Nouveau match !');
    } else if (p === 'lobby' && (state === 'over' || state === 'play')) {
      goBackToMultiLobby();
    }
  });

  const started = net.state.phase === 'play' ? true : await firstStart;
  if (!started) {
    onStatus(null);
    return false;
  }
  if (net.getSlots().length < 2) {
    banner('⚠ Pas assez de places dans le salon');
    await net.leave();
    onStatus(null);
    return false;
  }
  multiMode = true;
  conquest = null;
  onStatus(null);
  startGame();
  banner('⚔ Match en cours !');
  return true;
}
if (typeof window !== 'undefined') window.__multi = startMultiGame;

// raccourcis de test : lancer une partie libre, inspecter la scène et l'état
if (import.meta.env.DEV) {
  window.__play = () => { conquest = null; startGame(); };
  // essai rapide d'un perso : __leader('sorcerer') puis __play()
  window.__leader = (k) => { if (LEADERS[k]) { playerLeaderKey = k; return k; } return 'inconnu'; };
  window.__dbg = () => ({ scene, camera, factions, teams, island, agents, shrines, houses });
  window.__foll = () => Object.fromEntries(Object.entries(followerMeshes).map(([k, v]) => [k, { count: v.mesh.count, cap: v.cap, freeSlots: v.freeSlots.length }]));
  window.__ag = () => agents.map((a) => ({ id: a.id, v: variantOf(a.id), foll: a._followerSlot, disc: a._followerKey })).filter((a) => a.foll != null || a.disc);
  // inspection du multi : __net.getSlots(), __net.getLeaderList(), __net.state…
  window.__net = net;
  window.__ctl = () => ({ input, keys, multiMode, state, dir: playerDir(input, keys) });
  // avance le chrono de partie (test de l'écran de score) : __ff(160)
  window.__ff = (s) => { elapsed += s; };

  /* ---- Réglage d'ambiance en direct ----
     Chercher une direction artistique en recompilant à chaque essai est
     intenable : on perd la comparaison entre deux valeurs proches. Ce panneau
     déplace tout à chaud, puis `__grade.dump()` rend les constantes à recopier
     dans le code — c'est le passage du tâtonnement au réglage définitif qui
     compte, pas le panneau lui-même.

     Réservé au mode DEV : rien de tout ceci n'existe dans le build livré. */
  window.__grade = {
    /* Étalonnage : saturation, contraste, teinte, luminosité. */
    set(patch) { Object.assign(GRADE, patch); applyGrade(); return { ...GRADE }; },
    get() { return { ...GRADE }; },
    /* Exposition : facteur appliqué PAR-DESSUS la courbe du jour. 1 = valeurs
       de DAY_KEYS telles quelles. Multiplier la valeur trouvée par les `exp` du
       tableau donne les nouvelles constantes. */
    exposure(v) {
      if (v == null) return TUNE.exposure;
      TUNE.exposure = v;
      return v;
    },
    /* Lumières. `sun` et `hemi` sont des facteurs (le cycle du jour les pilote),
       ceux des personnages sont des valeurs absolues (il ne les touche pas). */
    lights(p = {}) {
      if (p.sun != null) TUNE.sun = p.sun;
      if (p.hemi != null) TUNE.hemi = p.hemi;
      if (p.charSun != null) charSun.intensity = p.charSun;
      if (p.charHemi != null) charHemi.intensity = p.charHemi;
      return {
        sunMul: TUNE.sun, hemiMul: TUNE.hemi,
        charSun: charSun.intensity, charHemi: charHemi.intensity,
      };
    },
    /* Brouillard : couleur et distances. C'est lui qui donne la profondeur. */
    fog(p = {}) {
      if (!scene.fog) return null;
      if (p.color != null) {
        fogBase.set(p.color);
        scene.fog.color.copy(fogBase);
      }
      if (p.near != null) {
        fogBaseNear = p.near;
        scene.fog.near = p.near;
      }
      if (p.far != null) {
        fogBaseFar = p.far;
        scene.fog.far = p.far;
      }
      return { color: '#' + fogBase.getHexString(), near: fogBaseNear, far: fogBaseFar };
    },
    /* Bascule le tone mapping pour comparer côte à côte. */
    TONES: {
      neutral: THREE.NeutralToneMapping,
      aces: THREE.ACESFilmicToneMapping,
      agx: THREE.AgXToneMapping,
      reinhard: THREE.ReinhardToneMapping,
      none: THREE.NoToneMapping,
    },
    toneName() {
      const e = Object.entries(this.TONES).find(([, v]) => v === renderer.toneMapping);
      return e ? e[0] : 'neutral';
    },
    tone(name) {
      const map = this.TONES;
      if (map[name] === undefined) return Object.keys(map);
      renderer.toneMapping = map[name];
      /* Chaque matériau embarque la courbe dans son shader : sans recompilation
         le changement resterait invisible. */
      scene.traverse((o) => { if (o.material) {
        for (const m of (Array.isArray(o.material) ? o.material : [o.material])) m.needsUpdate = true;
      } });
      return name;
    },
    /* Rend les valeurs courantes, prêtes à recopier dans le code. */
    dump() {
      const out = {
        GRADE: { ...GRADE },
        /* Facteurs à répercuter dans DAY_KEYS : chaque `exp` × exposureMul,
           chaque `sunI` × sunMul, chaque `hemiI` × hemiMul. */
        exposureMul: +TUNE.exposure.toFixed(3),
        sunMul: +TUNE.sun.toFixed(3),
        hemiMul: +TUNE.hemi.toFixed(3),
        lights: {
          charSun: +charSun.intensity.toFixed(2), charHemi: +charHemi.intensity.toFixed(2),
        },
        fog: scene.fog ? {
          color: '#' + fogBase.getHexString(),
          near: +fogBaseNear.toFixed(1), far: +fogBaseFar.toFixed(1),
        } : null,
      };
      console.log(JSON.stringify(out, null, 2));
      return out;
    },
  };

  /* ---- Panneau de développement ----
     Import DYNAMIQUE : `import.meta.env.DEV` est remplacé par `false` au build,
     la branche entière disparaît et devpanel.js n'est jamais téléchargé. Un
     import statique aurait été empaqueté dans le bundle livré même mort.

     Le panneau ne connaît rien au jeu : on lui décrit des contrôles. Ajouter un
     réglage se fait donc ici, en une ligne, sans toucher au module. */
  import('./devpanel.js').then(({ createDevPanel }) => {
    const G = window.__grade;
    const slider = (key, label, min, max, step, get, set) =>
      ({ key, label, min, max, step, get, set });

    window.__devpanel = createDevPanel({
      hotkey: 'F9',
      groups: [
        {
          title: 'Rendu',
          controls: [
            {
              key: 'tone', label: 'courbe', options: Object.keys(G.TONES),
              get: () => G.toneName(), set: (v) => G.tone(v),
            },
            slider('exposure', 'exposition', 0.3, 2.2, 0.01,
              () => G.exposure(), (v) => G.exposure(v)),
          ],
        },
        {
          title: 'Étalonnage',
          controls: [
            slider('saturation', 'saturation', 0, 2, 0.01,
              () => GRADE.saturation, (v) => G.set({ saturation: v })),
            slider('contrast', 'contraste', 0.5, 1.8, 0.01,
              () => GRADE.contrast, (v) => G.set({ contrast: v })),
            slider('hue', 'teinte °', -30, 30, 1,
              () => GRADE.hue, (v) => G.set({ hue: v })),
            slider('brightness', 'luminosité', 0.4, 1.8, 0.01,
              () => GRADE.brightness, (v) => G.set({ brightness: v })),
          ],
        },
        {
          title: 'Lumières',
          controls: [
            slider('sun', 'soleil ×', 0, 2.5, 0.01,
              () => TUNE.sun, (v) => G.lights({ sun: v })),
            slider('hemi', 'ciel ×', 0, 2.5, 0.01,
              () => TUNE.hemi, (v) => G.lights({ hemi: v })),
            slider('charSun', 'soleil persos', 0, 3, 0.01,
              () => charSun.intensity, (v) => G.lights({ charSun: v })),
            slider('charHemi', 'ciel persos', 0, 3, 0.01,
              () => charHemi.intensity, (v) => G.lights({ charHemi: v })),
          ],
        },
        {
          title: 'Brouillard',
          controls: [
            {
              key: 'fogColor', label: 'couleur', color: true,
              get: () => '#' + fogBase.getHexString(),
              set: (v) => G.fog({ color: v }),
            },
            slider('fogNear', 'début', 0, 160, 1,
              () => fogBaseNear, (v) => G.fog({ near: v })),
            slider('fogFar', 'fin', 20, 400, 1,
              () => fogBaseFar, (v) => G.fog({ far: v })),
          ],
        },
      ],
      actions: [
        { label: '▶ partie', run: () => { conquest = null; startGame(); } },
        { label: '⏩ +60 s', run: () => { elapsed += 60; } },
        { label: '❓ carte', run: () => { removeHazardCard(); spawnHazardCard(); } },
        { label: '🌑 nuit', run: () => cardCtx.blackout(18) },
        {
          label: '↺ réinitialiser', wide: true,
          run: (refresh) => {
            G.set({ saturation: 1.08, contrast: 1.04, hue: 0, brightness: 1 });
            G.exposure(1); G.lights({ sun: 1, hemi: 1, charSun: 1.55, charHemi: 1 });
            G.fog({ color: '#9fdcff', near: 70, far: 165 });
            G.tone('neutral');
            refresh();
          },
        },
        {
          label: '📋 copier les constantes', wide: true,
          run: () => {
            const txt = JSON.stringify(G.dump(), null, 2);
            navigator.clipboard?.writeText(txt).catch(() => {});
          },
        },
      ],
    });
  });
  // inspecte le canvas d'encre : histogramme grossier des pixels non vides
  window.__paintInfo = () => {
    const d = paintCtx.getImageData(0, 0, paintCv.width, paintCv.height).data;
    const hist = {};
    let filled = 0;
    for (let i = 0; i < d.length; i += 64) {
      if (d[i + 3] < 20) continue;
      filled++;
      const key = `${d[i] >> 5}-${d[i + 1] >> 5}-${d[i + 2] >> 5}`;
      hist[key] = (hist[key] || 0) + 1;
    }
    return { size: paintCv.width, filled, hist };
  };
  // pompe la simulation à la main (test headless quand la page est cachée)
  window.__tick = (n = 60, dt = 1 / 30) => {
    for (let i = 0; i < n && state === 'play'; i++) update(dt);
    return { state, elapsed: Math.round(elapsed) };
  };
}

$('btn-continue').addEventListener('click', () => {
  audioInit();
  openProgression({
    onClose() {
      conquest = null; overworldCtx = null; state = 'menu';
      $('hud').classList.add('hidden');
      $('end').classList.add('hidden');
      $('start').classList.remove('hidden');
      updateMainMenu();
    },
  });
});

$('btn-new-game').addEventListener('click', () => {
  const save = JSON.parse(localStorage.getItem('cultio_progress_v3') || '{}');
  if (save.playerName) {
    if (!confirm("Voulez-vous vraiment commencer une nouvelle campagne ? Toute votre progression actuelle sera perdue.")) {
      return;
    }
    localStorage.removeItem('cultio_progress_v3');
  }
  audioInit();
  openProgression({
    onClose() {
      conquest = null; overworldCtx = null; state = 'menu';
      $('hud').classList.add('hidden');
      $('end').classList.add('hidden');
      $('start').classList.remove('hidden');
      updateMainMenu();
    },
  });
});

/* ---- Multijoueur par code : salon jusqu'à 6 (humains + IA) ---- */
function genRoomCode() {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let c = '';
  for (let i = 0; i < 4; i++) c += chars[(Math.random() * chars.length) | 0];
  return c;
}

function setMultiStatus(msg) {
  const el = $('multi-status');
  if (!msg) { el.classList.add('hidden'); el.textContent = ''; return; }
  el.classList.remove('hidden');
  el.textContent = msg;
}

function setMultiButtonsEnabled(on) {
  $('btn-multi-create').disabled = !on;
  $('btn-multi-join').disabled = !on;
}

function showMultiGate() {
  $('multi-gate').classList.remove('hidden');
  $('multi-lobby').classList.add('hidden');
}

function showMultiLobby() {
  $('multi-gate').classList.add('hidden');
  $('multi-lobby').classList.remove('hidden');
}

const DIFF_LABEL = { easy: 'Facile', normal: 'Normal', hard: 'Difficile' };
const DIFF_CYCLE = ['easy', 'normal', 'hard'];
const LOBBY_AVATARS = LEADER_AVATARS;
const LOBBY_PORTRAITS = {
  monk: 'assets/monk_leader.webp',
  sorcerer: 'assets/sorcerer_leader.webp',
  nomad: 'assets/nomad_leader.webp',
  amazon: 'assets/amazon_leader.webp',
  alien: 'assets/alien_leader.webp',
  chief: 'assets/chief_leader.webp',
};
const LOBBY_LEADER_NAMES = {
  monk: 'Petit Moine', sorcerer: 'Sombre Sorcier', nomad: 'Nomade',
  amazon: 'Amazone', alien: 'Extraterrestre', chief: 'Chef des Nations',
};
const LOBBY_LEADER_ORDER = ['monk', 'sorcerer', 'nomad', 'amazon', 'alien', 'chief'];
const LOBBY_SYMBOLS = ['✝', '☪', '🕉', '☸', '✡', '⛩', '☯', '☬', '🔥', '👁', '🔱', '👑', '☀', '✦'];

/* Données perso pour le carrousel du lobby : nom, archétype, perk, palette.
   Mêmes valeurs que le créateur de campagne (voir progression.js LEADERS). */
const LOBBY_LEADER_INFO = {
  monk:     { name: 'Petit Moine',       archetype: 'Guide Spirituel',    perk: '✨ Aura d\'attraction étendue (+15%)',   color: '#ffe259', bg: 'linear-gradient(135deg, rgba(255,226,89,0.22), rgba(255,179,0,0.08))', desc: 'Un humble guide spirituel qui convertit par la paix, l\'empathie et la ferveur.' },
  sorcerer: { name: 'Sombre Sorcier',    archetype: 'Maître des Ombrages', perk: '🔮 Siphon de peinture accru (+20%)',    color: '#c084fc', bg: 'linear-gradient(135deg, rgba(192,132,252,0.22), rgba(126,34,206,0.08))', desc: 'Un mystique encapuchonné dont la peinture violacée hante et souille la vallée.' },
  nomad:    { name: 'Nomade du Désert',  archetype: 'Traqueur des Dunes',  perk: '⚡ Agilité du désert (+20% Vitesse)',   color: '#f97316', bg: 'linear-gradient(135deg, rgba(249,115,22,0.22), rgba(194,65,12,0.08))', desc: 'Un voyageur aguerri qui fend le sable et marque son territoire à vitesse fulgurante.' },
  amazon:   { name: 'Guerrière Amazone', archetype: 'Conquérante',         perk: '🛡️ Impulsion de foule (+15% Ferveur)',  color: '#06b6d4', bg: 'linear-gradient(135deg, rgba(6,182,212,0.22), rgba(14,116,144,0.08))', desc: 'Une combattante indomptable qui revendique la vallée d\'un pas altier et impérieux.' },
  alien:    { name: 'Extraterrestre',    archetype: 'Visiteur des Étoiles', perk: '👽 Aura psychique (+10% Toutes stats)', color: '#a3e635', bg: 'linear-gradient(135deg, rgba(163,230,53,0.22), rgba(77,124,15,0.08))', desc: 'Un voyageur venu d\'ailleurs, son passage laisse une empreinte étrange et déroutante.' },
  chief:    { name: 'Chef des Nations',  archetype: 'Gardien des Ancêtres', perk: '🪶 Bénédiction ancestrale (+15% Conv.)', color: '#d97706', bg: 'linear-gradient(135deg, rgba(217,119,6,0.22), rgba(146,64,14,0.08))', desc: 'Un chef vénéré des Premières Nations, sa présence sacrée honore la terre qu\'il foule.' },
};

/* Rendu du panneau « Ton choix » : perso, couleur, nom. Les couleurs prises par
   les autres sièges sont grisées pour éviter les collisions ; le perso peut être
   choisi librement (les doublons de leader sont autorisés). */
/* État du carrousel perso : conservé entre les rerenders pour éviter que la
   carte revienne à la première position à chaque broadcast. */
let lobbyCarouselIdx = 0;

function renderMeCard(slots) {
  const mySid = net.state.sessionId;
  const me = (slots || []).find(s => s.sessionId === mySid) || null;
  if (!me) return;

  const nameEl = $('lobby-me-name');
  if (nameEl && document.activeElement !== nameEl) nameEl.value = me.name || '';

  // Aligne l'index carrousel avec le perso en cours (au premier rendu ou après
  // choix externe). On ne réinitialise pas si le joueur navigue déjà.
  const meIdx = LOBBY_LEADER_ORDER.indexOf(me.leaderKey || 'monk');
  if (meIdx >= 0 && LOBBY_LEADER_ORDER[lobbyCarouselIdx] !== me.leaderKey) {
    lobbyCarouselIdx = meIdx;
  }
  renderLobbyCarouselCard();

  // Pastille couleur : swatch + fond
  const hex = '#' + ((me.cultColor >>> 0) & 0xffffff).toString(16).padStart(6, '0');
  const csw = $('lobby-pastille-color-swatch');
  csw.style.background = hex;
  csw.style.color = hex;
  csw.textContent = '';

  // Pastille symbole : soit texte, soit image (data URI custom)
  const sw = $('lobby-pastille-sym-swatch');
  const symStr = me.cultSym || '✦';
  if (symStr.startsWith('data:') || symStr.startsWith('http')) {
    sw.style.backgroundImage = `url(${symStr})`;
    sw.textContent = '';
  } else {
    sw.style.backgroundImage = '';
    sw.textContent = symStr;
  }
}

/* Dessine la carte du perso courant dans le carrousel avec ses infos et
   points d'orientation. Réutilisé à chaque changement de leader. */
function renderLobbyCarouselCard() {
  const k = LOBBY_LEADER_ORDER[lobbyCarouselIdx] || 'monk';
  const info = LOBBY_LEADER_INFO[k];
  const card = $('lobby-card-3d');
  if (!card || !info) return;
  card.style.setProperty('--card-bg', info.bg);
  card.style.setProperty('--card-color', info.color);
  card.style.background = info.bg;
  card.innerHTML = `
    <div class="lobby-card-archetype">‹ ${info.archetype} ›</div>
    <div class="lobby-card-portrait" style="background-image:url('${LOBBY_PORTRAITS[k]}');"></div>
    <div class="lobby-card-name">${info.name}</div>
    <div class="lobby-card-perk">${info.perk}</div>
    <div class="lobby-card-desc">${info.desc}</div>
  `;

  const dots = $('lobby-carousel-dots');
  dots.replaceChildren();
  LOBBY_LEADER_ORDER.forEach((_, i) => {
    const d = document.createElement('button');
    d.type = 'button';
    d.className = 'dot' + (i === lobbyCarouselIdx ? ' sel' : '');
    d.addEventListener('click', () => {
      if (i === lobbyCarouselIdx) return;
      lobbyCarouselIdx = i;
      commitLobbyLeaderChoice();
    });
    dots.append(d);
  });
}

/* Sauvegarde le leader courant du carrousel + diffuse au réseau. */
function commitLobbyLeaderChoice() {
  const k = LOBBY_LEADER_ORDER[lobbyCarouselIdx];
  if (!k) return;
  playerLeaderKey = k;
  persistSave({ playerLeader: k });
  renderLobbyCarouselCard();
  net.setChoice({ leaderKey: k });
}

/* Ouvre le modal de sélection couleur ou symbole. `kind` = 'color' | 'sym'. */
function openLobbyPicker(kind) {
  const modal = $('lobby-picker-modal');
  const title = $('lobby-modal-title');
  const grid = $('lobby-modal-grid');
  const mySid = net.state.sessionId;
  const me = net.getSlots().find(s => s.sessionId === mySid);
  if (!me) return;

  grid.className = 'lobby-modal-grid';
  grid.replaceChildren();
  if (kind === 'color') {
    title.textContent = 'Couleur divine';
    const cults = net.availableCults();
    const taken = net.takenColors(mySid);
    for (const c of cults) {
      const hex = '#' + ((c.c >>> 0) & 0xffffff).toString(16).padStart(6, '0');
      const isTaken = taken.has(c.c);
      const isMine = me.cultColor === c.c;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'lobby-modal-cell'
        + (isMine ? ' is-selected' : '')
        + (isTaken && !isMine ? ' is-taken' : '');
      btn.style.background = hex;
      btn.style.borderRadius = '50%';
      if (!isTaken || isMine) {
        btn.addEventListener('click', () => {
          const ci = CULTS.findIndex(x => x.c === c.c);
          if (ci >= 0) playerCultIdx = ci;
          persistSave({ playerColor: hex });
          net.setChoice({ cultColor: c.c });
          closeLobbyPicker();
        });
      } else {
        btn.disabled = true;
      }
      grid.append(btn);
    }
  } else {
    title.textContent = 'Symbole de religion';
    const cur = me.cultSym || '';
    for (const sym of LOBBY_SYMBOLS) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'lobby-modal-cell' + (cur === sym ? ' is-selected' : '');
      btn.textContent = sym;
      btn.style.borderRadius = '50%';
      btn.addEventListener('click', () => {
        persistSave({ religionIcon: sym });
        net.setChoice({ cultSym: sym });
        closeLobbyPicker();
      });
      grid.append(btn);
    }
  }
  modal.classList.remove('hidden');
}

function closeLobbyPicker() {
  $('lobby-picker-modal').classList.add('hidden');
}

/* Vue de gestion d'un bot (hôte uniquement) : grand portrait, sélecteur de
   difficulté et bouton pour retirer l'IA. Ouvert en tapant sur son avatar. */
function openLobbyBotDetail(botId) {
  const bot = net.getSlots().find(s => s.id === botId);
  if (!bot) return;
  const key = (bot.leaderKey && LOBBY_AVATARS[bot.leaderKey]) ? bot.leaderKey : 'monk';
  const hex = '#' + ((bot.cultColor >>> 0) & 0xffffff).toString(16).padStart(6, '0');
  const modal = $('lobby-picker-modal');
  const title = $('lobby-modal-title');
  const grid = $('lobby-modal-grid');
  title.textContent = bot.name || 'IA';
  grid.className = 'lobby-modal-grid is-detail';
  grid.replaceChildren();

  const portrait = document.createElement('div');
  portrait.className = 'lobby-bot-portrait';
  portrait.style.borderColor = hex;
  portrait.style.boxShadow = `0 0 18px ${hex}55`;
  portrait.style.backgroundImage = `url('${LOBBY_PORTRAITS[key] || LOBBY_AVATARS[key]}')`;
  grid.append(portrait);

  const sub = document.createElement('div');
  sub.className = 'lobby-bot-sub';
  sub.textContent = LOBBY_LEADER_NAMES[key] || key;
  grid.append(sub);

  const diffLabel = document.createElement('div');
  diffLabel.className = 'lobby-bot-section-label';
  diffLabel.textContent = 'Difficulté';
  grid.append(diffLabel);

  const diffRow = document.createElement('div');
  diffRow.className = 'lobby-bot-diff-row';
  for (const d of DIFF_CYCLE) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'lobby-bot-diff' + (bot.difficulty === d ? ' is-selected' : '');
    b.textContent = DIFF_LABEL[d];
    b.addEventListener('click', () => {
      net.setBotDiff(botId, d);
      // Rafraîchit l'état sélectionné dans le modal ouvert
      diffRow.querySelectorAll('button').forEach(x => x.classList.remove('is-selected'));
      b.classList.add('is-selected');
    });
    diffRow.append(b);
  }
  grid.append(diffRow);

  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'lobby-bot-remove';
  remove.textContent = '✕  Retirer cette IA';
  remove.addEventListener('click', () => {
    net.removeBot(botId);
    closeLobbyPicker();
  });
  grid.append(remove);

  modal.classList.remove('hidden');
}

/* Utilitaire : fusionner quelques champs dans le save local sans écraser le reste. */
function persistSave(patch) {
  try {
    const save = JSON.parse(localStorage.getItem('cultio_progress_v3') || '{}');
    Object.assign(save, patch);
    localStorage.setItem('cultio_progress_v3', JSON.stringify(save));
  } catch (_) {}
}

function renderLobbySlots(slots) {
  const strip = $('lobby-strip-slots');
  const code = net.getCode() || '····';
  $('lobby-code').textContent = code;
  const host = net.isHost();
  $('lobby-host-actions').classList.toggle('hidden', !host);
  $('lobby-guest-hint').classList.toggle('hidden', host);
  $('lobby-hint').textContent = host
    ? `Partage le code ${code}, ajoute des IA ou attends d'autres joueurs.`
    : `En attente que l'hôte lance la partie.`;

  const ordered = [...(slots || [])];
  const n = ordered.length;
  $('lobby-players-count').textContent = `${n}/5`;

  strip.replaceChildren();
  for (const s of ordered) {
    const key = (s.leaderKey && LOBBY_AVATARS[s.leaderKey]) ? s.leaderKey : 'monk';
    const hex = `#${((s.cultColor >>> 0) & 0xffffff).toString(16).padStart(6, '0')}`;

    const cell = document.createElement('div');
    cell.className = 'lobby-strip-slot';
    cell.style.setProperty('--slot-color', hex);

    const av = document.createElement('button');
    av.type = 'button';
    av.className = 'lobby-strip-avatar' + (s.isHost ? ' is-host' : '');
    av.style.backgroundImage = `url('${LOBBY_AVATARS[key]}')`;

    // Pastille symbole de religion en bas à droite
    const sym = document.createElement('div');
    sym.className = 'lobby-strip-sym';
    sym.style.backgroundColor = hex;
    const symStr = s.cultSym || '';
    if (symStr.startsWith('data:') || symStr.startsWith('http')) {
      sym.style.backgroundImage = `url(${symStr})`;
    } else {
      sym.textContent = symStr || '✦';
    }
    av.append(sym);

    // Pastille « IA » discrète pour distinguer bots et humains sans encombrer
    if (s.kind === 'bot') {
      const iaBadge = document.createElement('div');
      iaBadge.className = 'lobby-strip-ia-badge';
      iaBadge.textContent = 'IA';
      av.append(iaBadge);
    }

    // Sur un tap : ouvrir la vue de gestion (hôte + bots uniquement)
    if (host && s.kind === 'bot') {
      av.classList.add('is-clickable');
      av.title = 'Gérer cette IA';
      av.addEventListener('click', () => openLobbyBotDetail(s.id));
    }

    cell.append(av);

    const nm = document.createElement('div');
    nm.className = 'lobby-strip-name';
    nm.textContent = s.name || 'Joueur';
    cell.append(nm);

    strip.append(cell);
  }

  if (host && n < 5) {
    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'lobby-strip-add';
    add.textContent = '+';
    add.title = 'Ajouter une IA';
    add.addEventListener('click', () => net.addBot('normal'));
    strip.append(add);
  }

  renderMeCard(ordered);

  $('btn-lobby-start').disabled = n < 2;
  $('btn-lobby-start').textContent = n < 2
    ? 'Il faut au moins 2 joueurs'
    : `Lancer la partie (${n}/5)`;
}

$('btn-multi').addEventListener('click', () => {
  $('start').classList.add('hidden');
  $('multi-panel').classList.remove('hidden');
  showMultiGate();
  setMultiStatus(null);
});

async function leaveMultiToMenu() {
  multiMode = false;
  await net.leave();
  $('multi-panel').classList.add('hidden');
  showMultiGate();
  $('start').classList.remove('hidden');
  setMultiStatus(null);
  setMultiButtonsEnabled(true);
}

/* Retour au salon multi post-partie : on garde la session P2P, on remet l'UI
   dans l'état lobby. Utilisé quand l'hôte appelle net.returnToLobby() ou quand
   un invité reçoit phase:'lobby' de l'hôte. */
function goBackToMultiLobby() {
  state = 'menu';
  multiMode = true;
  $('end').classList.add('hidden');
  $('hud').classList.add('hidden');
  $('start').classList.add('hidden');
  $('multi-panel').classList.remove('hidden');
  showMultiLobby();
  renderLobbySlots(net.getSlots());
  setMultiStatus(null);
  setMultiButtonsEnabled(true);
}

/* Sortie d'un match en ligne (fin de partie ou abandon) : couper le réseau,
   sortir de multiMode, revenir au menu principal. Sans ça, la partie suivante
   réutiliserait la room précédente et ses IA. */
async function exitMultiToMenu() {
  multiMode = false;
  state = 'menu';
  await net.leave();
  $('end').classList.add('hidden');
  $('hud').classList.add('hidden');
  $('multi-panel').classList.add('hidden');
  showMultiGate();
  setMultiStatus(null);
  setMultiButtonsEnabled(true);
  $('start').classList.remove('hidden');
  updateMainMenu();
}

$('btn-multi-back').addEventListener('click', leaveMultiToMenu);
$('btn-lobby-leave').addEventListener('click', leaveMultiToMenu);

/* Le bouton « + Ajouter une IA » est désormais rendu inline dans la bande des
   joueurs (renderLobbySlots), pas dans un panneau d'actions séparé. */
$('btn-lobby-start').addEventListener('click', () => net.requestStart());

/* Navigation carrousel perso + pastilles ouvrant le modal de sélection. */
$('lobby-nav-prev').addEventListener('click', () => {
  lobbyCarouselIdx = (lobbyCarouselIdx - 1 + LOBBY_LEADER_ORDER.length) % LOBBY_LEADER_ORDER.length;
  commitLobbyLeaderChoice();
});
$('lobby-nav-next').addEventListener('click', () => {
  lobbyCarouselIdx = (lobbyCarouselIdx + 1) % LOBBY_LEADER_ORDER.length;
  commitLobbyLeaderChoice();
});
$('lobby-pastille-color').addEventListener('click', () => openLobbyPicker('color'));
$('lobby-pastille-sym').addEventListener('click', () => openLobbyPicker('sym'));
$('lobby-modal-close').addEventListener('click', closeLobbyPicker);
$('lobby-picker-modal').addEventListener('click', (e) => {
  if (e.target.id === 'lobby-picker-modal') closeLobbyPicker();
});

/* Édition du nom : on n'envoie qu'à la sortie du champ ou après une courte
   pause, pour éviter un spam de messages à chaque touche. */
{
  const nameEl = $('lobby-me-name');
  let debounceT = 0;
  const flush = () => {
    const v = (nameEl.value || '').trim().slice(0, 20);
    if (v) {
      persistSave({ playerName: v });
      net.setChoice({ name: v });
    }
  };
  nameEl.addEventListener('input', () => {
    clearTimeout(debounceT);
    debounceT = setTimeout(flush, 400);
  });
  nameEl.addEventListener('blur', flush);
}

async function launchMulti(code, mode) {
  setMultiButtonsEnabled(false);
  setMultiStatus(mode === 'create' ? 'Création du salon…' : 'Recherche du salon…');
  try {
    const ok = await startMultiGame({
      code,
      mode,
      onStatus: setMultiStatus,
      onLobby: (slots) => {
        showMultiLobby();
        renderLobbySlots(slots);
        setMultiStatus(null);
      },
    });
    if (ok) {
      $('multi-panel').classList.add('hidden');
    } else {
      showMultiGate();
      setMultiButtonsEnabled(true);
    }
  } catch (e) {
    setMultiStatus(`⚠ ${e?.message || e}`);
    showMultiGate();
    setMultiButtonsEnabled(true);
  }
}

$('btn-multi-create').addEventListener('click', () => launchMulti(genRoomCode(), 'create'));
$('btn-multi-join').addEventListener('click', () => {
  const code = ($('multi-code-input').value || '').trim().toUpperCase();
  if (code.length !== 4) { setMultiStatus('Entre le code à 4 caractères'); return; }
  launchMulti(code, 'join');
});

$('btn-delete-game').addEventListener('click', () => {
  $('confirm-delete').classList.remove('hidden');
});
$('btn-delete-cancel').addEventListener('click', () => {
  $('confirm-delete').classList.add('hidden');
});
$('btn-delete-confirm').addEventListener('click', () => {
  localStorage.removeItem('cultio_progress_v3');
  $('confirm-delete').classList.add('hidden');
  updateMainMenu();
});

/* ============================== Écran Splash Mobile ============================== */
/* Le dismiss est branché en inline dans index.html (indépendant de Three.js). */
const splashEl = $('splash-screen');
if (splashEl && !splashEl.dataset.ready) {
  const dismissSplash = () => {
    audioInit();
    splashEl.classList.add('fade-out');
    setTimeout(() => {
      splashEl.classList.add('hidden');
    }, 500);
  };
  splashEl.addEventListener('click', dismissSplash);
}



$('retry').addEventListener('click', () => {
  if (multiMode) {
    // Fin d'un match en ligne : on quitte VRAIMENT le salon avant de revenir au
    // menu, sinon la prochaine partie hériterait de cette room (et de ses IA).
    exitMultiToMenu();
    return;
  }
  if (overworldCtx) {
    // Fin d'un match de campagne : on retourne au Hub d'exploration du pays.
    $('end').classList.add('hidden');
    openOverworldHub(overworldCtx);
  } else {
    conquest = null;
    startGame();
  }
});

/* Post-partie multi : l'hôte renvoie tout le monde dans le salon pour relancer
   une manche. Les invités écoutent phase:'lobby' (voir onPhaseChange plus bas). */
$('btn-end-lobby').addEventListener('click', () => {
  if (!multiMode || !net.isHost()) return;
  net.returnToLobby();
  goBackToMultiLobby();
});

$('btn-end-back').addEventListener('click', () => {
  if (conquest) {
    const c = conquest; conquest = null; overworldCtx = null;
    $('end').classList.add('hidden');

    // Vainqueur = culte adverse au meilleur score de peinture
    let winnerF = null, maxScore = -1;
    for (const f of factions) {
      if (f.i === 0) continue;
      const s = factionScore(f).total;
      if (s > maxScore) { maxScore = s; winnerF = f; }
    }
    const winnerColor = winnerF ? winnerF.css : null;
    c.onResult({ win: false, winnerColor: winnerColor });
  }
});

/* ------------------------------- Céder la victoire ------------------------------- */
$('btn-concede').addEventListener('click', () => {
  if (state === 'play') {
    endGame('concede');
  }
});

updateMainMenu();
audioInit();

// Entrer dans un pays : on atterrit directement dans le Hub Overworld 3D.
setHubHandler((ctx) => {
  openOverworldHub(ctx);
});

// Zone choisie (en franchissant un portail) : la partie démarre pour de bon.
setPlayHandler((ctx) => {
  conquest = ctx;
  startGame();
});

/* ============================== Animation ============================== */
let last = performance.now();
let menuOrbit = 0;
let appActive = true;
addEventListener('cultio:visibility', (e) => {
  appActive = e.detail.active;
  if (appActive) last = performance.now();
});
document.addEventListener('visibilitychange', () => {
  appActive = !document.hidden;
  if (appActive) last = performance.now();
});
/* Cap FPS : 30 sur tactile (chaleur), ~62 sur desktop. */
const FRAME_MIN_MS = 1000 / (isCoarse ? 30 : 62);
function frame(now) {
  requestAnimationFrame(frame);
  if (!appActive) return;
  const elapsed_ms = now - last;
  if (elapsed_ms < FRAME_MIN_MS) return;
  let dt = Math.min(0.05, elapsed_ms / 1000);
  last = now;
  pollGamepad(dt);
  monkTimeU.value = now / 1000;
  if (state === 'play') {
    // ralenti dramatique (kill de Leader) : le temps s'étire un court instant
    if (slowmoT > 0) { slowmoT -= dt; dt *= 0.3; }
    if (eventFreeze) updateEventCard(dt);
    else if (!paused) {
      try {
        update(dt);
      } catch (err) {
        console.error('[game loop error]', err);
      }
    }
  } else if (state === 'overworld') {
    updateOverworld(dt);
  } else {
    // Vue d'attente du menu : magnifique orbite cinématographique au-dessus de la vallée
    applyDayCycle(0.42);
    menuOrbit += dt * 0.085;
    const radius = 42;
    const camY = 24 + Math.sin(menuOrbit * 0.5) * 3.5;
    camera.position.set(Math.sin(menuOrbit) * radius, camY, Math.cos(menuOrbit) * radius);
    camera.lookAt(0, 1.2, 0);
  }
  renderer.render(scene, camera);
}

/* Démarrage : vallée tempérée en fond de menu, boucle lancée direct */
loadGrass('assets/models/grass.glb');
loadTrees('assets/models/trees.glb');
// la carte du menu est bâtie avant l'arrivée des modèles : on les y pose après coup
/* Les modèles d'herbe et d'arbres arrivent parfois après la construction de la
   carte : on les repose alors sur les tuiles de l'île courante. */
onGrassReady(() => {
  if (!island) return;
  mapObjects.push(...buildBiomeGrass(scene, currentBiomeKey, MAP_R, makeTilePlacer(island)));
});
onTreesReady(() => {
  if (!island) return;
  mapObjects.push(...buildBiomeTrees(scene, currentBiomeKey, MAP_R, makeTilePlacer(island)));
});
loadNature();
onNatureReady(() => {
  if (!island) return;
  mapObjects.push(...buildBiomeNature(scene, currentBiomeKey, MAP_R, makeTilePlacer(island)));
});
buildMap('temperate');
captureDayBase();
camera.position.set(0, 34, 42);
camera.lookAt(0, 0, 0);

/* Installation des effets — la sim appelle effects.*(...) au lieu des fonctions
   locales. Sur serveur Node, cet install n'a pas lieu → tout reste no-op. */
effects.install({
  agentColor: (id, colorHex) => {
    tmpColor.setHex(colorHex);
    setAgentColor(id, tmpColor);
  },
  hideAgent: (id) => hideAgent(id),
  shock: (x, z, colorHex, maxR, dur) => {
    tmpColor.setHex(colorHex);
    spawnShock(x, z, tmpColor, maxR, dur);
  },
  soulBurst: (x, z, factionIdx) => {
    const f = factions[factionIdx];
    if (f) spawnSoulBurst(x, z, f);
  },
  splash: (x, z, r, teamIdx, css) => stampSplash(x, z, r, teamIdx, css),
  sound: (name, opts) => soundEngine.playSFX(name, opts),
  banner: (text) => banner(text),
  hudDirty: () => updateHUD(),
  shake: (amount) => { shake = Math.max(shake, amount); },
  slowmo: (dur) => { slowmoT = Math.max(slowmoT, dur); },
  endGame: (forced) => endGame(forced),
});

requestAnimationFrame(frame);
