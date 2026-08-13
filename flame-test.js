/* Banc d'essai de src/flame.js — hors jeu, pour juger la flamme seule.
   Trois flammes isolées aux couleurs d'âme + un champ instancié derrière,
   sur fond noir avec un bloom léger (la flamme est conçue pour en avoir un). */
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';

import { createFlame, createFlameField, updateFlames } from './src/flame.js';
import { updateSoulEscort, getSoulEscort } from './src/soulEscort.js';
import { addSoul } from './src/souls.js';
import { SOULS } from './src/pillars.js';

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(innerWidth, innerHeight);
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0a0a10);
const cam = new THREE.PerspectiveCamera(45, innerWidth / innerHeight, 0.1, 100);
cam.position.set(0, 2.4, 8);
cam.lookAt(0, 1.5, 0);

/* Un sol mat pour donner l'échelle et voir ce que la flamme éclaire (rien :
   pas de lumière dynamique, c'est voulu — cf. le commentaire de pillars.js). */
const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(40, 40),
  new THREE.MeshBasicMaterial({ color: 0x14141c }),
);
ground.rotation.x = -Math.PI / 2;
scene.add(ground);

// Trois flammes isolées, aux couleurs des âmes de pillars.js.
const cols = [0xff6a2a, 0x3fb6ff, 0x7fc25a];
cols.forEach((c, i) => {
  const f = createFlame({ color: c, size: 2.2, intensity: 1.0 });
  f.position.set((i - 1) * 2.6, 0.6, 0);
  scene.add(f);
  // Un fût sommaire, pour lire la flamme posée sur quelque chose.
  const p = new THREE.Mesh(
    new THREE.CylinderGeometry(0.22, 0.3, 0.6, 8),
    new THREE.MeshBasicMaterial({ color: 0x2a2a34 }),
  );
  p.position.set((i - 1) * 2.6, 0.3, 0);
  scene.add(p);
});

// Champ instancié : 24 torches derrière, chacune sa phase.
const field = createFlameField(24, { color: 0xff8a30, size: 1.0 });
const fd = field.userData.flame;
for (let i = 0; i < 24; i++) {
  const a = (i / 24) * Math.PI * 2;
  fd.setAt(i, new THREE.Vector3(Math.cos(a) * 9, 0, Math.sin(a) * 9 - 4), 0.8 + Math.random() * 0.5);
}
fd.commit();
scene.add(field);

/* -- Escorte d'âmes --
   Un faux joueur qui tourne en rond, pour juger la GAMBADE : c'est une
   sensation, et aucun test au sol ne la mesure. */
for (let i = 0; i < SOULS.length; i++) addSoul(i);
const fakePlayer = new THREE.Mesh(
  new THREE.CapsuleGeometry(0.32, 0.9, 4, 8),
  new THREE.MeshBasicMaterial({ color: 0x9fb4d8 }),
);
scene.add(fakePlayer);
const escortState = { scene, px: 0, pz: 0, py: 0, spiritBlend: 1, groundY: () => 0 };
let walkT = 0;
function walkFakePlayer(dt) {
  walkT += dt;
  /* Vitesse variable : c'est en changeant d'allure — et en s'arrêtant — que
     l'élastique du rattrapage se voit vraiment. */
  const speed = 6 + 7 * Math.sin(walkT * 0.35);
  const R = 5.5;
  const a = walkT * (speed / R) * 0.35;
  escortState.px = Math.cos(a) * R;
  escortState.pz = Math.sin(a) * R - 2;
  fakePlayer.position.set(escortState.px, 0.75, escortState.pz);
  updateSoulEscort(dt, escortState);
}

const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, cam));
composer.addPass(new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.35, 0.45, 0.55));

addEventListener('resize', () => {
  cam.aspect = innerWidth / innerHeight; cam.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight); composer.setSize(innerWidth, innerHeight);
});

const clock = new THREE.Clock();
let frames = 0;
renderer.setAnimationLoop(() => {
  const dt = Math.min(clock.getDelta(), 0.05);
  updateFlames(dt);
  composer.render();
  if (++frames === 30) document.getElementById('hud').textContent = 'flame.js — rendu OK';
});

/* Sonde pour la vérification automatisée. step() rend une frame sans passer par
   requestAnimationFrame, qui est suspendu tant que l'onglet n'est pas peint. */
window.__flame = {
  scene, renderer, cam, composer, fakePlayer,
  /* Exposé depuis le banc, et pas ré-importé par la sonde : Vite sert les
     modules avec un jeton de version (?t=…), et un import sans ce jeton donne
     une SECONDE instance du module, avec son propre inventaire vide. */
  escort: () => getSoulEscort(),
  get frames() { return frames; },
  step(dt = 1 / 60, n = 1) {
    for (let i = 0; i < n; i++) { updateFlames(dt); walkFakePlayer(dt); composer.render(); frames++; }
    return frames;
  },
};
