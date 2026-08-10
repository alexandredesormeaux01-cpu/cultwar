/* ============================== Découpe autour du héros ==============================
   Le décor qui passe DEVANT le joueur s'efface, pour qu'on ne le perde jamais
   de vue derrière un arbre ou un rocher.

   POURQUOI PAS DE VRAIE TRANSPARENCE
   L'approche évidente — lancer un rayon caméra → joueur, trouver l'objet
   masquant, baisser son opacité — ne peut pas marcher ici : le décor est
   instancié. Les 2 000 touffes d'un biome, ses 44 arbres, ses rochers sont
   chacun UN InstancedMesh à matériau unique. Baisser l'opacité du matériau
   effacerait la forêt entière, pas l'arbre gênant. Et rendre le matériau
   `transparent` casserait le tri de profondeur, donc les contours cartoon et
   les ombres, sur toute la scène.

   La découpe se fait donc au FRAGMENT, en espace écran : chaque pixel sait s'il
   est proche du joueur à l'écran et devant lui en profondeur. Aucun objet n'a
   besoin d'être identifié, l'instanciation est indifférente, et un même arbre
   peut être à moitié effacé — seule la partie qui gêne disparaît.

   TRAME PLUTÔT QU'OPACITÉ
   L'effacement se fait par `discard` selon une matrice de Bayer, la « trame de
   moustiquaire ». À faible taux, un pixel sur seize disparaît ; à taux plein,
   tous. L'œil lit un fondu, mais le rendu reste OPAQUE : pas de tri à faire,
   la profondeur reste juste, et les contours et les ombres continuent de
   fonctionner sans un seul cas particulier. C'est ce qui permet de greffer
   l'effet sur des matériaux existants sans rien changer d'autre.

   CE QUE ÇA NE FAIT PAS
   L'ombre portée n'est pas découpée : la passe d'ombres utilise un matériau de
   profondeur distinct, qui ignore ce shader. Un arbre effacé continue donc de
   projeter son ombre. C'est peu visible tant que le soleil ne place pas cette
   ombre exactement sur le joueur ; si ça devient gênant, il faut un
   customDepthMaterial portant la même découpe.
================================================================================ */
import * as THREE from 'three';

/* Uniformes PARTAGÉS par tous les matériaux qui portent la découpe : un seul
   objet, mis à jour une fois par image. Des copies par matériau obligeraient à
   parcourir la scène à chaque image pour les synchroniser. */
export const HERO_CUTOUT_UNIFORMS = {
  /* Position du héros en coordonnées normalisées d'écran (−1..1). */
  uHeroNdc: { value: new THREE.Vector2(0, 0) },
  /* Sa distance à la caméra, le long de l'axe de vue. Seul ce qui est DEVANT
     est effacé : un arbre derrière le joueur ne le cache pas, l'effacer ferait
     un trou dans le paysage sans raison. */
  uHeroDepth: { value: 1e9 },
  /* Rapport largeur/hauteur, pour que la zone reste un disque à l'écran. Sans
     lui elle s'aplatit en ellipse sur un écran large. */
  uHeroAspect: { value: 1 },
  /* Rayon de la zone, en NDC (la hauteur de l'écran vaut 2). */
  uHeroR: { value: 0.17 },
  /* Largeur du dégradé au bord. Un bord net découperait un disque parfait dans
     le tronc, ce qui se remarque bien plus que l'arbre lui-même. */
  uHeroSoft: { value: 0.13 },
  /* Effacement maximal au centre. À 1,0 l'objet disparaît complètement et le
     joueur semble flotter dans un trou ; en laisser un peu garde le contexte. */
  uHeroMax: { value: 0.88 },
  /* 0 désactive tout — hors partie, ou si l'option est coupée. */
  uHeroOn: { value: 0 },
};

const HERO_CUTOUT_VARYINGS = /* glsl */`
  varying vec2 vCutNdc;
  varying float vCutDepth;
`;

const HERO_CUTOUT_VERTEX = /* glsl */`
  /* gl_Position vient d'être calculé par project_vertex. Sa composante w vaut,
     en projection perspective, la distance du sommet au plan de la caméra :
     c'est exactement la profondeur qu'on veut comparer à celle du héros. */
  vCutNdc = gl_Position.xy / gl_Position.w;
  vCutDepth = gl_Position.w;
`;

const HERO_CUTOUT_FRAGMENT = /* glsl */`
  /* Matrice de Bayer 4×4, dépliée. Un seuil ordonné donne un motif régulier et
     stable dans le temps ; un seuil aléatoire ferait grésiller le décor à
     chaque image, ce qui attire l'œil bien plus que l'objet effacé. */
  float heroBayer(vec2 p) {
    vec2 c = floor(mod(p, 4.0));
    float i = c.y * 4.0 + c.x;
    float t = 0.0;
    if (i < 0.5) t = 0.0;      else if (i < 1.5) t = 8.0;   else if (i < 2.5) t = 2.0;
    else if (i < 3.5) t = 10.0; else if (i < 4.5) t = 12.0; else if (i < 5.5) t = 4.0;
    else if (i < 6.5) t = 14.0; else if (i < 7.5) t = 6.0;  else if (i < 8.5) t = 3.0;
    else if (i < 9.5) t = 11.0; else if (i < 10.5) t = 1.0; else if (i < 11.5) t = 9.0;
    else if (i < 12.5) t = 15.0; else if (i < 13.5) t = 7.0; else if (i < 14.5) t = 13.0;
    else t = 5.0;
    return (t + 0.5) / 16.0;
  }
`;

const HERO_CUTOUT_TEST = /* glsl */`
  if (uHeroOn > 0.5) {
    vec2 dv = vCutNdc - uHeroNdc;
    dv.x *= uHeroAspect;
    float dist = length(dv);
    /* Marge de 0,35 unité monde : sans elle, le décor posé au pied du joueur —
       l'herbe qu'il piétine — clignote entre effacé et visible au moindre pas,
       parce que sa profondeur oscille autour de celle du héros. */
    float front = 1.0 - step(uHeroDepth - 0.35, vCutDepth);
    float cut = front * uHeroMax
              * (1.0 - smoothstep(uHeroR, uHeroR + uHeroSoft, dist));
    if (cut > heroBayer(gl_FragCoord.xy)) discard;
  }
`;

/**
 * Greffe la découpe sur un matériau.
 *
 * @param {THREE.Material} mat
 * @param {string} key  suffixe de cache de programme. Les matériaux du décor
 *   sont souvent partagés et déjà greffés par ailleurs (applyGroundFollow) :
 *   sans clé distincte, deux variantes de programme se confondraient et l'une
 *   afficherait le shader de l'autre.
 */
export function applyHeroCutout(mat, key = '') {
  if (!mat || mat.userData.heroCutout) return mat;
  mat.userData.heroCutout = true;

  const prevKey = mat.customProgramCacheKey ? mat.customProgramCacheKey() : '';
  mat.customProgramCacheKey = () => 'hero-cutout-' + key + '-' + prevKey;

  /* On CHAÎNE le hook au lieu de l'écraser : le décor passe déjà par
     applyGroundFollow, qui décale les props sur le relief. Écraser son
     onBeforeCompile ferait flotter tout le décor — un bug d'autant plus
     déroutant qu'il n'aurait aucun rapport apparent avec la transparence. */
  const prevHook = mat.onBeforeCompile;
  mat.onBeforeCompile = (shader, renderer) => {
    if (prevHook) prevHook(shader, renderer);
    Object.assign(shader.uniforms, HERO_CUTOUT_UNIFORMS);

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${HERO_CUTOUT_VARYINGS}`)
      .replace('#include <project_vertex>', `#include <project_vertex>\n${HERO_CUTOUT_VERTEX}`);

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
${HERO_CUTOUT_VARYINGS}
      uniform vec2 uHeroNdc;
      uniform float uHeroDepth;
      uniform float uHeroAspect;
      uniform float uHeroR;
      uniform float uHeroSoft;
      uniform float uHeroMax;
      uniform float uHeroOn;
${HERO_CUTOUT_FRAGMENT}`)
      /* Le test est placé AVANT tout calcul d'éclairage : un fragment écarté
         ne doit rien coûter. C'est aussi la seule position correcte — un
         discard après coup laisserait des écritures de profondeur derrière lui
         sur certaines implémentations. */
      .replace('#include <clipping_planes_fragment>',
        `${HERO_CUTOUT_TEST}\n#include <clipping_planes_fragment>`);
  };
  mat.needsUpdate = true;
  return mat;
}

const _heroProj = new THREE.Vector3();

/**
 * À appeler une fois par image, avant le rendu.
 * @param {THREE.Camera} camera
 * @param {{x:number,y:number,z:number}|null} pos  position MONDE du héros,
 *   ou null pour désactiver (menu, cinématique, joueur mort).
 * @param {number} aspect  rapport largeur/hauteur du rendu.
 */
export function updateHeroCutout(camera, pos, aspect) {
  const u = HERO_CUTOUT_UNIFORMS;
  if (!pos) { u.uHeroOn.value = 0; return; }
  /* On vise le TORSE, pas les pieds : centrée sur le sol, la zone effacerait
     surtout le décor devant les jambes et laisserait la tête cachée. */
  _heroProj.set(pos.x, (pos.y || 0) + 1.1, pos.z);
  /* Distance le long de l'axe de vue, avant projection : c'est la même mesure
     que le w de gl_Position côté shader. */
  const dz = _heroProj.distanceTo(camera.position);
  _heroProj.project(camera);
  u.uHeroNdc.value.set(_heroProj.x, _heroProj.y);
  u.uHeroDepth.value = dz;
  u.uHeroAspect.value = aspect || 1;
  u.uHeroOn.value = 1;
}
