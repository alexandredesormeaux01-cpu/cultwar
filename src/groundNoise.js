/* ============================== Relief et grain du sol ==============================
   Champ de hauteur partagé entre la dalle et le décor posé dessus.

   Pourquoi un module à part : hexmap.js déplace la surface, biomes.js doit
   décaler les props d'exactement la même quantité, et hexmap importe déjà
   biomes. Loger le champ ici évite un cycle d'imports, et garantit surtout
   qu'il n'existe qu'UNE définition — deux copies qui dérivent, ce sont des
   cailloux qui flottent au-dessus d'une bosse.

   Tout est lu en coordonnées MONDE. C'est le point clé : les ~215 tuiles
   partagent une seule géométrie instanciée, donc un motif plaqué sur l'UV du
   modèle se répéterait à l'identique sur chaque hexagone et la grille sauterait
   aux yeux. Un bruit lu en (x, z) monde ignore le découpage.
================================================================================ */

/* Extinction du relief vers le bord de la tuile, en unités locales.
   Le pourtour doit rester EXACTEMENT plat, pour deux raisons :
     · les liserés noirs des falaises sont des barres posées à plat sur l'arête
       (buildCoastOutline) — une bosse là les ferait flotter ;
     · makeClippedCrust rentre les arêtes de fosse jusqu'à OPEN_CLIP (3,2), et un
       déplacement résiduel y décollerait le dessus de son mur.
   Bénéfice : deux tuiles voisines valant zéro sur leur arête commune se
   rejoignent au sommet près, sans fissure.

   LIFT_FADE_IN doit rester SUPÉRIEUR au rayon de placement des props
   (APOTHEM − 1,6 ≈ 1,95, voir makeTilePlacer). C'est ce qui permet aux props de
   lire le champ NON atténué : à leur position, l'atténuation vaut toujours 1, et
   les deux valeurs coïncident donc exactement sans avoir à reconstruire la
   tuile dans le shader. */
export const LIFT_FADE_IN = 2.7;
export const LIFT_FADE_OUT = 3.15;

export const GROUND_NOISE_GLSL = /* glsl */`
  float gHash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
  }
  float gNoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    float a = gHash(i), b = gHash(i + vec2(1.0, 0.0));
    float c = gHash(i + vec2(0.0, 1.0)), d = gHash(i + vec2(1.0, 1.0));
    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
  }
  float gFbm(vec2 p) {
    float s = 0.0, a = 0.5;
    for (int k = 0; k < 3; k++) { s += a * gNoise(p); p *= 2.07; a *= 0.5; }
    return s / 0.875;
  }
  /* Un fbm ne sort presque jamais de [0.3, 0.7] : utilisé tel quel dans un mix,
     il ne rend que le tiers de l'écart demandé et le sol reste un aplat. On
     étale donc le contraste avant de s'en servir. */
  float gRamp(float x) {
    return clamp((x - 0.5) * 2.6 + 0.5, 0.0, 1.0);
  }

  /* Relief du sol, en unités monde.

     Les longueurs d'onde comptent PLUS que l'amplitude. Une première version
     utilisait des périodes de 12 et 3 unités pour une amplitude de ±0,07 : sur
     une tuile large de 7 unités, la composante longue était quasi constante —
     elle soulevait la tuile en bloc au lieu de la vallonner — et la pente
     résultante valait 2 %, soit environ 1°. Rigoureusement invisible.

     Ce qui se voit, c'est la pente : amplitude / longueur d'onde. On garde donc
     une amplitude modeste (±0,13 maximum, pour une marche de 0,95) mais on la
     concentre sur une période de ~2,5 unités, ce qui donne trois ou quatre
     ondulations par tuile et une pente d'environ 10°.

     Le gRamp() sur chaque octave n'est PAS décoratif. Un fbm brut ne s'écarte
     typiquement de 0,5 que de ±0,12 : sans étalement, une amplitude demandée de
     ±0,13 n'en produisait réellement que ±0,03, et le relief restait invisible
     malgré des chiffres qui semblaient corrects. C'est le même piège que pour la
     teinte, et il se paie deux fois si on ne le rapporte pas ici.

     gLiftNorm rend la hauteur NORMALISÉE (−1 dans un creux, +1 sur une crête) :
     c'est la forme que consomme la teinte du sol. Elle est exposée séparément
     pour qu'aucune constante d'amplitude ne soit recopiée ailleurs — une
     normalisation désynchronisée de l'amplitude est le genre d'erreur silencieuse
     qui ne se manifeste que par « ça ne marche pas ». */
  float gLiftNorm(vec2 w) {
    return clamp((gRamp(gFbm(w * 0.13)) - 0.5)
               + (gRamp(gFbm(w * 0.40)) - 0.5) * 1.08, -1.0, 1.0);
  }
  float gLift(vec2 w) { return gLiftNorm(w) * 0.17; }
`;

/**
 * Fait suivre le relief à un objet posé au sol (props instanciés du décor).
 *
 * Le décor est placé sur le plan LOGIQUE de la tuile, qui reste plat. Sans ce
 * décalage, un caillou de 20 cm posé sur une bosse de 13 cm est à moitié
 * enterré, et le même caillou dans un creux flotte — c'est précisément ce qui
 * interdisait d'augmenter l'amplitude du relief.
 *
 * Le décalage est calculé une fois par INSTANCE (à partir de son origine), pas
 * par sommet : l'objet monte et descend en restant rigide, il ne se déforme
 * pas. On lit le champ NON atténué, ce qui est correct car tout prop se trouve
 * dans la zone où l'atténuation vaut 1 (voir LIFT_FADE_IN).
 *
 * @param {THREE.Material} mat  matériau d'un InstancedMesh de décor
 * @param {string} key          suffixe de cache de programme (matériaux partagés)
 */
export function applyGroundFollow(mat, key = '') {
  if (!mat || mat.userData.groundFollow) return mat;
  mat.userData.groundFollow = true;
  const prevKey = mat.customProgramCacheKey ? mat.customProgramCacheKey() : '';
  mat.customProgramCacheKey = () => 'ground-follow-' + key + '-' + prevKey;
  const prevHook = mat.onBeforeCompile;
  mat.onBeforeCompile = (shader, renderer) => {
    if (prevHook) prevHook(shader, renderer);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
${GROUND_NOISE_GLSL}`)
      /* begin_vertex, donc avant project_vertex qui calcule gl_Position :
         déplacer après n'aurait aucun effet à l'écran. */
      .replace('#include <begin_vertex>', `#include <begin_vertex>
      #ifdef USE_INSTANCING
        /* Origine de l'instance = sa colonne de translation. La rotation des
           props est un lacet autour de Y, elle n'affecte donc pas la hauteur. */
        vec3 gInst = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
        float gSY = length(instanceMatrix[1].xyz);
        transformed.y += gLift(gInst.xz) / max(gSY, 0.0001);
      #endif
      `);
  };
  mat.needsUpdate = true;
  return mat;
}
