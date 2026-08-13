/* ============================================================================
   Flamme cel-shadée — géométrie cuite dans Blender, vie donnée en GLSL
   ----------------------------------------------------------------------------
   La forme vient de blender/flame.py : cinq coques en goutte imbriquées, de la
   plus froide (extérieure) à la plus chaude (le cœur), fusionnées en un seul
   maillage. Ce module ne fait que deux choses, mais ce sont celles que le glTF
   ne sait pas transporter : il les ANIME et il les COLORE.

   POURQUOI L'ANIMATION EST DANS LE VERTEX SHADER

     Une flamme jouée en morph targets ou en VAT (voir vat.js) coûterait des
     frames à stocker et boucherait mal : le raccord entre la dernière frame et
     la première se voit toujours sur un mouvement continu. Ici l'ondulation est
     une somme de sinus — elle n'a ni début ni fin, la boucle est exacte à la
     virgule près, et le coût est nul.

     Surtout, chaque instance peut avoir sa PHASE propre (attribut aPhase). Cent
     torches ondulent chacune à son rythme en un seul appel GPU, là où cent
     animations jouées séparément en coûteraient cent.

   LE CEL-SHADING, ET POURQUOI LA COULEUR N'EST PAS DANS L'ASSET

     Pas de MeshToonMaterial ici : le toon du projet éclaire une surface, or une
     flamme n'est pas éclairée, elle émet. Les paliers sont donc obtenus en
     quantifiant une valeur de « chaleur » — haute au cœur et à la base, basse
     en périphérie et à la pointe. Les bandes qui en résultent remontent
     lentement le long de la langue de feu : c'est ce défilement qui vend la
     combustion, davantage que l'ondulation elle-même.

     La chaleur est un NOMBRE, pas une couleur, et c'est tout l'intérêt. Une
     première version faisait porter les teintes par l'asset (COLOR_0, palette
     chaude) et les multipliait par une teinte d'appelant : une flamme bleue
     sortait blanche, parce que bleu × rouge ne donne rien. Or pillars.js a
     besoin de flammes Fleuve, Racine et Gardienne autant que Cendre. La rampe
     est donc reconstruite ici, entre uCool et uHot, et n'importe quelle teinte
     marche — y compris froide.

   CONTRAT AVEC L'ASSET (blender/flame.py, invariants 1 à 4)
     uv.x = hauteur normalisée, uv.y = rang de coque, hauteur totale 1, base à
     l'origine. Casser l'un des quatre casse ce module.
   ========================================================================== */
import * as THREE from 'three';

import { gltfLoader } from './gltf.js';

export const TUNE_FLAME = {
  speed: 1.0,       // vitesse générale de l'ondulation
  sway: 1.0,        // amplitude du balancement latéral
  flicker: 1.0,     // amplitude du scintillement radial
  stretch: 1.0,     // amplitude de l'étirement vertical (la « léchée »)
  bands: 5.0,       // nombre de paliers cel dans la rampe de chaleur
  white: 0.80,      // blanchiment du cœur (0 = flamme d'une seule teinte)
  intensity: 1.0,   // multiplicateur d'émission — dosé POUR un bloom actif
  /* Bien en dessous de 1, et ce n'est pas un réglage esthétique : sous additive
     les cinq coques S'ADDITIONNENT le long du rayon visuel. À opacité pleine le
     cœur reçoit cinq fois la contribution d'une coque, sature en blanc, et la
     flamme perd et sa teinte et son étagement. Chaque coque ne doit donc peser
     qu'une fraction — c'est leur somme qui fait la flamme. */
  opacity: 0.52,
};

const MODEL_URL = 'assets/models/flame.glb';

/* Horloge partagée. Un seul objet uniforme référencé par TOUS les matériaux :
   updateFlames() écrit une fois, chaque flamme du jeu avance. C'est aussi ce
   qui garantit que deux flammes de même phase restent synchrones à jamais. */
const uTime = { value: 0 };

/* ---------------------------------------------------------------------------
   Shaders
--------------------------------------------------------------------------- */
const VERT = /* glsl */`
  #ifdef USE_INSTANCING
    attribute float aPhase;      // déphasage propre à l'instance
  #endif

  uniform float uTime, uSpeed, uSway, uFlicker, uStretch, uPhase;

  varying float vShell;
  varying float vT;
  varying float vPhase;
  varying float vRim;
  varying vec3  vInst;

  void main() {
    float t     = uv.x;                     // 0 à la base, 1 à la pointe
    float shell = uv.y;                     // rang de coque, 0 extérieur → 1 cœur

    float phase = uPhase;
    #ifdef USE_INSTANCING
      phase += aPhase;
    #endif
    /* Le 0.37 est irrationnel de fait : les coques ne repassent jamais toutes
       en phase, donc le volume ne s'aplatit jamais sur une frame malheureuse. */
    phase += uTime * uSpeed + shell * 6.2831853 * 0.37;

    vec3 p = position;

    // 1. Étirement vertical — la flamme « lèche » vers le haut.
    p.y *= 1.0 + uStretch * 0.18 * sin(phase * 1.7 + shell * 2.1);

    // 2. Pincement radial — le scintillement. Dépend de t, donc l'onde
    //    parcourt la hauteur au lieu de gonfler la flamme d'un bloc.
    p.xz *= 1.0 + uFlicker * 0.10 * sin(phase * 2.3 + t * 6.0 - shell * 3.0);

    // 3. Balancement latéral, en t² : rigoureusement nul à la base (invariant 1
    //    de l'asset — la flamme est accrochée à sa mèche) et franc à la pointe.
    float s = uSway * t * t;
    p.x += s * 0.22 * sin(phase * 1.3 + t * 2.4);
    p.z += s * 0.22 * cos(phase * 1.1 + t * 2.9 + shell * 1.7);

    vShell = shell;
    vT     = t;
    vPhase = phase;

    vInst = vec3(1.0);
    #ifdef USE_INSTANCING_COLOR
      vInst = instanceColor;   // teinte propre à l'instance, cf. setAt()
    #endif

    /* Normale de la forme AU REPOS : la déformer correctement demanderait la
       jacobienne des trois sinus. Inutile — elle ne sert qu'à adoucir la
       silhouette, et l'erreur y est invisible. */
    vRim = 1.0 - abs(normalize(normalMatrix * normal).z);

    vec4 mv = modelViewMatrix
      #ifdef USE_INSTANCING
        * instanceMatrix
      #endif
        * vec4(p, 1.0);
    gl_Position = projectionMatrix * mv;
  }
`;

const FRAG = /* glsl */`
  uniform vec3  uCool, uHot;
  uniform float uBands, uIntensity, uOpacity, uWhite;

  varying float vShell;
  varying float vT;
  varying float vPhase;
  varying float vRim;
  varying vec3  vInst;

  void main() {
    /* Chaleur : monte vers le cœur (vShell) et vers la base (1 - vT). Le terme
       en sinus la fait glisser vers le haut, si bien qu'une fois quantifiée les
       paliers défilent — c'est ce mouvement-là qui se lit comme la combustion. */
    float heat = vShell * 0.72
               + (1.0 - vT) * 0.28
               + 0.07 * sin(vPhase * 2.0 - vT * 8.0);

    // Quantification cel : des paliers francs, pas un dégradé.
    heat = clamp(floor(heat * uBands + 0.5) / uBands, 0.0, 1.0);

    /* Rampe à deux arrêts + blanchiment du cœur. Le blanchiment est SÉPARÉ de
       la rampe : sans lui une flamme froide n'a pas de point chaud et se lit
       comme un gaz ; avec, elle garde un cœur incandescent quelle que soit sa
       teinte. C'est ce qui permet les flammes d'âme bleues ou vertes. */
    vec3 c = mix(uCool, uHot, smoothstep(0.0, 0.60, heat)) * vInst;
    c = mix(c, vec3(1.0), uWhite * smoothstep(0.66, 1.0, heat));

    /* La chaleur pilote aussi la LUMINOSITÉ, pas seulement la teinte. Une rampe
       purement colorée donne une flamme mate, qui se lit comme une feuille
       peinte : c'est l'écart d'intensité entre le cœur et le pourtour qui la
       fait rayonner, et c'est lui qui déclenche le bloom là où il faut. */
    c *= uIntensity * (0.45 + 1.35 * heat);

    /* Opacité croissante vers le cœur. Les coques extérieures ne sont qu'un
       halo — les laisser aussi présentes que le cœur empâte la silhouette et
       mange l'étagement sous l'additive. */
    float a = uOpacity * (0.28 + 0.90 * vShell);

    /* La pointe s'éteint en fondu. Sans ça la goutte se termine sur un bord
       net et la flamme a l'air découpée aux ciseaux. */
    a *= smoothstep(1.0, 0.55, vT);

    // Silhouette légèrement plus vive : donne du galbe malgré l'absence
    // d'éclairage, et aide les coques à se distinguer sous l'additive.
    a *= 1.0 + 0.25 * vRim;

    /* Prémultiplié : sous AdditiveBlending c'est la couleur qui compte, mais
       garder alpha cohérent permet de repasser en NormalBlending sans retoucher
       le shader (utile là où le bloom n'est pas actif). */
    gl_FragColor = vec4(c * a, a);
  }
`;

/* ---------------------------------------------------------------------------
   Matériau
--------------------------------------------------------------------------- */
/** Un ShaderMaterial de flamme. Chaque flamme a le sien : les uniformes de
 *  teinte et d'intensité sont réglés par appelant. Seul le temps est partagé. */
export function flameMaterial(opts = {}) {
  const o = { ...TUNE_FLAME, ...opts };

  /* `color` est la teinte VIVE, celle qu'on reconnaît de loin ; le bas de rampe
     s'en déduit par assombrissement plutôt que d'être un second réglage à
     tenir. Un appelant qui veut un dégradé particulier passe `cool`. */
  const hot = new THREE.Color(o.color ?? 0xff7a22);
  const cool = new THREE.Color(o.cool ?? hot).clone();
  /* 0.55 et pas 0.30 : plus bas, le pourtour et la pointe virent au sombre
     désaturé et la flamme se lit comme une feuille peinte. Une flamme n'a pas
     de zone éteinte — même son bord le plus froid émet. */
  if (o.cool === undefined) cool.multiplyScalar(0.55);

  const mat = new THREE.ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: FRAG,
    uniforms: {
      uTime,                                   // partagé — ne pas cloner
      uSpeed:     { value: o.speed },
      uSway:      { value: o.sway },
      uFlicker:   { value: o.flicker },
      uStretch:   { value: o.stretch },
      uPhase:     { value: opts.phase ?? Math.random() * 6.2831853 },
      uHot:       { value: hot },
      uCool:      { value: cool },
      uWhite:     { value: o.white },
      uBands:     { value: o.bands },
      uIntensity: { value: o.intensity },
      uOpacity:   { value: o.opacity },
    },
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,          // les coques doivent s'additionner, pas se masquer
    /* FrontSide, pas DoubleSide : en double face chaque coque est traversée deux
       fois et l'empilement additif double encore — dix couches au lieu de cinq,
       saturation garantie. C'est aussi moitié moins de fragments. */
    side: THREE.FrontSide,
    toneMapped: false,          // la flamme annonce, elle ne subit pas l'exposition
  });
  return mat;
}

/* ---------------------------------------------------------------------------
   Géométrie
--------------------------------------------------------------------------- */
let _geo = null;       // gabarit chargé
let _pending = null;   // promesse de chargement en cours

/* Repli si le .glb manque (APK élagué, 404). Un cône respecte le contrat de
   l'asset — hauteur 1, base à l'origine — à condition qu'on lui fabrique ses
   uv.x et uv.y. La flamme est alors plus pauvre, jamais absente. */
function fallbackGeometry() {
  const g = new THREE.ConeGeometry(0.3, 1, 9, 6, true);
  g.translate(0, 0.5, 0);
  const pos = g.attributes.position;
  const n = pos.count;
  const uv = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    uv[i * 2] = THREE.MathUtils.clamp(pos.getY(i), 0, 1);   // uv.x = hauteur
    /* Coque unique, mais placée au CHAUD de la rampe : à 0 le cône sortirait
       dans la seule teinte sombre et ne se lirait pas comme une flamme. */
    uv[i * 2 + 1] = 0.8;
  }
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return g;
}

/* Le contrat tient entièrement dans uv (cf. en-tête). Vérifié au chargement
   plutôt que supposé : un asset recuit sans ses uv donnerait une flamme noire
   et immobile, sans la moindre erreur pour l'expliquer. */
function checkContract(geo) {
  if (!geo.getAttribute('uv')) throw new Error('[flame] flame.glb sans uv — asset à recuire');
}

/** Charge (une seule fois) la géométrie de flamme. Toujours résolue : en cas
 *  d'échec on rend le repli plutôt que de propager une erreur, la flamme étant
 *  décorative partout où elle sert. */
export function loadFlame() {
  if (_geo) return Promise.resolve(_geo);
  if (_pending) return _pending;
  _pending = new Promise((resolve) => {
    const fallback = (why) => {
      console.warn(`[flame] ${why} — repli géométrique`);
      _geo = fallbackGeometry();
      resolve(_geo);
    };
    /* try/catch autour du load, et pas seulement un onError : GLTFLoader lève
       de façon SYNCHRONE sur une URL qu'il ne sait pas résoudre, et l'exception
       passerait alors à côté du repli — la promesse ne se résoudrait jamais et
       l'appelant attendrait indéfiniment une flamme qui n'arrive pas. */
    try {
      gltfLoader.load(MODEL_URL, (gltf) => {
        let mesh = null;
        gltf.scene.traverse((c) => { if (c.isMesh && !mesh) mesh = c; });
        if (!mesh) { fallback('flame.glb sans maillage'); return; }
        _geo = mesh.geometry;
        checkContract(_geo);
        resolve(_geo);
      }, undefined, () => fallback(`${MODEL_URL} introuvable`));
    } catch (e) {
      fallback(`${MODEL_URL} illisible (${e.message})`);
    }
  });
  return _pending;
}

/* ---------------------------------------------------------------------------
   Fabriques
--------------------------------------------------------------------------- */
/* Réglages appliqués à toute flamme, quel que soit l'appelant. renderOrder
   négatif : la flamme est additive et sans depthWrite, elle doit donc passer
   après l'opaque mais avant les autres transparents pour ne pas les effacer. */
function dress(mesh, o) {
  mesh.frustumCulled = true;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.renderOrder = o.renderOrder ?? 2;
  mesh.scale.setScalar(o.size ?? 1);
  return mesh;
}

/**
 * Une flamme isolée — torche, brasier, sommet de pilier.
 *
 * Rendue immédiatement (repli) et remplacée dès que le .glb arrive : l'appelant
 * n'a pas à attendre, ce qui évite de propager de l'async dans tout le montage
 * de scène pour un objet décoratif.
 *
 * @param {object} opts  color, size, intensity, speed, sway, flicker, bands…
 * @returns {THREE.Mesh}  avec .userData.flame = { setColor, setIntensity, material }
 */
export function createFlame(opts = {}) {
  const mat = flameMaterial(opts);
  const mesh = new THREE.Mesh(_geo || fallbackGeometry(), mat);
  dress(mesh, opts);

  if (!_geo) loadFlame().then((g) => { mesh.geometry = g; });

  mesh.userData.flame = {
    material: mat,
    /* Recale le bas de rampe comme le fait flameMaterial : changer la teinte
       vive sans lui laisserait une flamme bleue sur un pied rouge. */
    setColor: (c) => {
      const u = mat.uniforms;
      u.uHot.value.set(c);
      u.uCool.value.copy(u.uHot.value).multiplyScalar(0.30);
    },
    setIntensity: (v) => { mat.uniforms.uIntensity.value = v; },
    setOpacity: (v) => { mat.uniforms.uOpacity.value = v; },
  };
  return mesh;
}

/**
 * Un champ de flammes instanciées — les torches d'un hub, un brasier multiple.
 *
 * Toutes partagent un matériau et un draw call ; seules la matrice, la couleur
 * et la PHASE varient. Sans phase par instance, toutes les flammes ondulent à
 * l'unisson et l'œil lit immédiatement la copie.
 *
 * Pour des flammes de teintes différentes dans un même champ (les six piliers,
 * par exemple), passer `color: 0xffffff` et donner la teinte à setAt() : elle
 * arrive par instanceColor et multiplie la rampe.
 *
 * @param {number} count  nombre maximal d'instances
 * @returns {THREE.InstancedMesh}  avec .userData.flame = { setAt, commit, material }
 */
export function createFlameField(count, opts = {}) {
  const mat = flameMaterial(opts);

  const phases = new Float32Array(count);
  for (let i = 0; i < count; i++) phases[i] = Math.random() * 6.2831853;

  /* aPhase est propre au champ, mais _geo est le gabarit PARTAGÉ par toutes les
     flammes du jeu. Le poser dessus tel quel ferait que deux champs se volent
     leurs phases — et que les flammes isolées traînent un attribut inutile.
     On clone donc : les tampons de sommets restent partagés par référence, seul
     l'enrobage est dupliqué, le coût mémoire est nul. */
  const withPhase = (g) => {
    const c = g.clone();
    c.setAttribute('aPhase', new THREE.InstancedBufferAttribute(phases, 1));
    return c;
  };

  const im = new THREE.InstancedMesh(withPhase(_geo || fallbackGeometry()), mat, count);
  im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  dress(im, opts);
  im.scale.setScalar(1);   // l'échelle est portée par instance, pas par le champ

  if (!_geo) loadFlame().then((g) => { im.geometry = withPhase(g); });

  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const s = new THREE.Vector3();
  const col = new THREE.Color();
  const base = opts.size ?? 1;

  im.userData.flame = {
    material: mat,
    phases,
    /** Place l'instance i. `size` multiplie la taille de base du champ. */
    setAt(i, pos, size = 1, color = null) {
      s.setScalar(base * size);
      m.compose(pos, q, s);
      im.setMatrixAt(i, m);
      if (color !== null) im.setColorAt(i, col.set(color));
    },
    /** À appeler après une salve de setAt(). */
    commit(visible = count) {
      im.count = visible;
      im.instanceMatrix.needsUpdate = true;
      if (im.instanceColor) im.instanceColor.needsUpdate = true;
    },
  };
  return im;
}

/* ---------------------------------------------------------------------------
   Horloge
--------------------------------------------------------------------------- */
/** Avance toutes les flammes du jeu. Un seul appel par frame, où que soit posé
 *  le module — l'uniforme de temps est partagé par construction. */
export function updateFlames(dt) {
  /* Repliement du temps sur la période commune des sinus du shader. Sans ça,
     après quelques heures de session, uTime devient assez grand pour que la
     précision float du GPU rende l'ondulation saccadée puis immobile. La
     période retenue est un multiple de 2π suffisamment gros pour qu'aucune
     boucle ne se voie, et assez petit pour rester exact en float. */
  uTime.value = (uTime.value + dt) % (6.2831853 * 1000.0);
}
