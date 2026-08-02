/* ============================================================================
   Chargeur glTF partagé — décompression meshopt + variantes mobiles
   ----------------------------------------------------------------------------
   Les .glb sont compressés avec EXT_meshopt_compression (voir
   scripts/optimize-models.mjs) : sans le décodeur, GLTFLoader échoue. Tout
   chargeur du projet doit donc passer par ici.

   `modelURL()` redirige vers assets/models/lo/ sur mobile : mêmes modèles,
   maillage simplifié (silhouette et contour noir préservés — bords verrouillés
   à la simplification). Sur desktop on garde la pleine densité.
   ========================================================================== */
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';

const IS_MOBILE = matchMedia('(pointer: coarse)').matches;

/* Modèles dont une variante allégée existe dans assets/models/lo/.
   Doit rester aligné sur MODELS dans scripts/optimize-models.mjs. */
const LO_AVAILABLE = new Set([
  'sanctuary_base.glb', 'burrow_hole.glb', 'trees.glb', 'grass.glb', 'paint_crystal.glb',
  'peasant_woman.glb', 'peasant_blocky.glb', 'knight_blocky.glb',
  'monk_rigged.glb', 'sorcerer_rigged.glb', 'nomad_rigged.glb',
  'amazon_rigged.glb', 'alien_rigged.glb', 'chief_rigged.glb',
  'elemental_rigged.glb', 'elemental_air_rigged.glb', 'elemental_earth_rigged.glb',
  'elemental_ether_rigged.glb', 'elemental_light_rigged.glb', 'elemental_water_rigged.glb',
]);

export function modelURL(url) {
  if (!IS_MOBILE) return url;
  const i = url.lastIndexOf('/');
  const dir = url.slice(0, i + 1);
  const file = url.slice(i + 1);
  return LO_AVAILABLE.has(file) ? `${dir}lo/${file}` : url;
}

export function makeGLTFLoader() {
  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder);
  /* Redirection transparente : les appelants gardent leurs chemins d'origine. */
  const load = loader.load.bind(loader);
  loader.load = (url, ...rest) => load(modelURL(url), ...rest);
  return loader;
}

export const gltfLoader = makeGLTFLoader();
