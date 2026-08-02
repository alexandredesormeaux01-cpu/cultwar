/* ============================================================================
   Portraits d'esprits pour le HUD — rendu hors-écran du GLB déjà chargé
   ----------------------------------------------------------------------------
   Les cadres de disciples affichent l'esprit élémentaire du leader. Plutôt que
   de maintenir six PNG en parallèle des modèles, on cuit le portrait depuis le
   .glb lui-même : l'image reste automatiquement fidèle au modèle.

   On réutilise le renderer principal via un WebGLRenderTarget — créer un second
   contexte WebGL juste pour une vignette est un luxe que les mobiles paient
   cher (limite de contextes, drivers capricieux à la libération).

   Le résultat est un data: URL PNG mis en cache par clé de leader.
   ========================================================================== */
import * as THREE from 'three';

const cache = new Map();

/* Cadrage buste : l'esprit est vu de trois quarts, légèrement en plongée, avec
   la tête dans le tiers supérieur — la même grammaire qu'un portrait de RPG. */
const FRAME = { yaw: Math.PI * 0.18, pitch: 0.12, headBias: 0.62, fill: 1.35 };

/**
 * Cuit un portrait carré depuis une scène glTF.
 * @param {THREE.WebGLRenderer} renderer  le renderer du jeu
 * @param {THREE.Object3D} source         gltf.scene de l'esprit
 * @param {string} key                    clé de cache (leaderKey)
 * @param {number} size                   côté de la vignette, en pixels
 * @returns {string|null} data: URL PNG, ou null si le rendu a échoué
 */
export function renderSpiritPortrait(renderer, source, key, size = 192) {
  if (cache.has(key)) return cache.get(key);
  if (!renderer || !source) return null;

  const scene = new THREE.Scene();
  const model = source.clone(true);
  model.traverse((o) => {
    if (o.isMesh || o.isSkinnedMesh) { o.castShadow = false; o.receiveShadow = false; o.frustumCulled = false; }
  });
  scene.add(model);

  /* Éclairage de studio : une clé chaude en haut à droite, un remplissage froid
     à gauche pour détacher la silhouette du fond sombre du cadre. */
  scene.add(new THREE.AmbientLight(0xffffff, 1.5));
  const keyLight = new THREE.DirectionalLight(0xfff0d0, 2.6);
  keyLight.position.set(1.4, 2.2, 1.8);
  scene.add(keyLight);
  const fill = new THREE.DirectionalLight(0x9fc6ff, 1.1);
  fill.position.set(-1.8, 0.4, 0.6);
  scene.add(fill);

  const box = new THREE.Box3().setFromObject(model);
  if (box.isEmpty()) return null;
  const sphere = box.getBoundingSphere(new THREE.Sphere());
  const c = sphere.center;
  /* On vise le haut du corps, pas le centre géométrique : sinon le cadre rond
     rogne la tête et garde les pieds. */
  const target = new THREE.Vector3(c.x, box.min.y + (box.max.y - box.min.y) * FRAME.headBias, c.z);

  const camera = new THREE.PerspectiveCamera(30, 1, 0.01, 100);
  const dist = (sphere.radius / FRAME.fill) / Math.tan((camera.fov * Math.PI) / 360);
  camera.position.set(
    target.x + Math.sin(FRAME.yaw) * dist,
    target.y + Math.sin(FRAME.pitch) * dist,
    target.z + Math.cos(FRAME.yaw) * dist,
  );
  camera.lookAt(target);

  const rt = new THREE.WebGLRenderTarget(size, size, {
    format: THREE.RGBAFormat,
    type: THREE.UnsignedByteType,
    colorSpace: THREE.SRGBColorSpace,
  });

  /* On sauve puis restaure l'état du renderer : ce rendu s'intercale au milieu
     de la boucle de jeu et ne doit rien laisser derrière lui. */
  const prevTarget = renderer.getRenderTarget();
  const prevClearAlpha = renderer.getClearAlpha();

  let url = null;
  try {
    renderer.setRenderTarget(rt);
    renderer.setClearAlpha(0);
    renderer.clear(true, true, true);
    renderer.render(scene, camera);

    const px = new Uint8Array(size * size * 4);
    renderer.readRenderTargetPixels(rt, 0, 0, size, size, px);

    const cv = document.createElement('canvas');
    cv.width = size; cv.height = size;
    const ctx = cv.getContext('2d');
    const img = ctx.createImageData(size, size);
    /* WebGL lit de bas en haut, le canvas 2D écrit de haut en bas. */
    for (let y = 0; y < size; y++) {
      const src = (size - 1 - y) * size * 4;
      img.data.set(px.subarray(src, src + size * 4), y * size * 4);
    }
    ctx.putImageData(img, 0, 0);
    url = cv.toDataURL('image/png');
  } catch (e) {
    console.warn('[portrait] rendu échoué pour', key, e);
  } finally {
    renderer.setRenderTarget(prevTarget);
    renderer.setClearAlpha(prevClearAlpha);
    rt.dispose();
    scene.clear();
  }

  if (url) cache.set(key, url);
  return url;
}

export function getSpiritPortrait(key) {
  return cache.get(key) || null;
}
