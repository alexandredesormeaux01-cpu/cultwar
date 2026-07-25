/* ===========================================================================
   Cult.io — Cristaux d'énergie
   ---------------------------------------------------------------------------
   Les cristaux remplacent la foule : ils sont à la fois les points de vie, la
   portée d'influence et le score d'un culte. Ils orbitent autour de leur Leader
   en anneaux contrarotatifs.

   Contrat :
     • Convertir un sceptique le fait disparaître et envoie un cristal en vol
       vers le Leader ; à l'arrivée il rejoint l'orbite (+1).
     • Une attaque encaissée détruit un cristal (−1).
     • Zéro cristal = mort du Leader.

   Tout le rendu tient dans UN InstancedMesh partagé par tous les cultes :
   à 5 cultes × 30 cristaux, c'est 150 instances contre les ~1300 agents
   animés de l'ancienne foule.
=========================================================================== */

import * as THREE from 'three';

/* Les cristaux ne sont PAS la ressource : ce sont les croyants amassés qui font
   office de points de vie, sans plafond. Les cristaux en sont la jauge — un
   anneau unique de 1 à 8 gemmes, lisible d'un coup d'œil même en pleine mêlée.
   Un culte vivant en porte toujours au moins un. */
export const CRYSTAL_MIN = 1;
export const CRYSTAL_MAX = 8;
export const CRYSTAL_CAP_TOTAL = CRYSTAL_MAX * 6;   // 5 cultes + marge

/* Anneau unique — DÉSACTIVÉ en jeu (les « diamants » autour du Leader n'ont
   plus de rôle). On garde le code pour les âmes (spawnSoulBurst). */
const RING = { slots: CRYSTAL_MAX, r: 1.7, y: 1.3, w: 0.62 };

/* Position orbitale d'un cristal (repère local du Leader). */
function orbitPos(i, t, out) {
  const a = (i / RING.slots) * Math.PI * 2 + t * RING.w;
  out.set(
    Math.cos(a) * RING.r,
    RING.y + Math.sin(t * 1.7 + i * 1.1) * 0.12,   // respiration verticale
    Math.sin(a) * RING.r,
  );
  return out;
}

/* Cristal allongé façon gemme : deux pyramides tête-bêche, facettes franches.
   La lumière est CUITE dans les couleurs de sommets (pointes claires, ceinture
   plus sombre) : le cristal se lit pareil sous n'importe quel éclairage de
   biome, et n'a besoin d'aucun calcul d'ombrage. */
function makeCrystalGeo() {
  const geo = new THREE.OctahedronGeometry(0.28, 0);
  geo.scale(1, 1.75, 1);
  const pos = geo.attributes.position;
  const col = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    // |y| max aux deux pointes, 0 sur la ceinture équatoriale
    const k = Math.min(1, Math.abs(pos.getY(i)) / (0.28 * 1.75));
    const v = 0.72 + k * 0.78;      // >1 sur les pointes : surbrillance franche
    col[i * 3] = v; col[i * 3 + 1] = v; col[i * 3 + 2] = v;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return geo;
}

let mesh = null;
let geo = null;

/**
 * Crée (une seule fois) l'InstancedMesh partagé et l'ajoute à la scène.
 * À rappeler après un changement de scène — le mesh est réutilisé.
 */
export function initCrystals(scene, pixelRatio = 1) {
  if (mesh) { scene.add(mesh); return mesh; }
  geo = makeCrystalGeo();
  /* Matériau non éclairé : la couleur finale est facette × couleur du culte.
     Un cristal d'énergie doit rayonner de lui-même — le passer par un modèle
     d'éclairage le rendait sombre dès qu'il tournait dos au soleil, et c'est
     précisément la lisibilité des PV qui en dépend. */
  const mat = new THREE.MeshBasicMaterial({
    vertexColors: true,     // géométrie (facettes) × instanceColor (culte)
    transparent: true,
    opacity: 0.95,
  });
  mesh = new THREE.InstancedMesh(geo, mat, CRYSTAL_CAP_TOTAL);
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.frustumCulled = false;
  mesh.castShadow = false;      // de petites ombres pour rien : trop cher, invisible
  mesh.receiveShadow = false;
  scene.add(mesh);
  initSouls(scene, pixelRatio);
  return mesh;
}

/* ============================== Âmes : particules spirituelles ==============================
   Un sceptique absorbé n'envoie pas un objet solide : il se dissout en une
   gerbe d'étincelles de la couleur du culte, qui s'enroulent vers le Leader et
   s'y résorbent. Le croyant est crédité immédiatement — ces particules sont du
   pur retour sensoriel, jamais un délai de jeu. */
const _isMobileSoul = matchMedia('(pointer: coarse)').matches;
const SOUL_POOL = _isMobileSoul ? 800 : 6000;
const SOULS_PER_ABSORB = _isMobileSoul ? 6 : 22;
/* Deux temps : l'âme se disperse et flotte sur place, puis file d'un coup vers
   le Leader. C'est la suspension qui donne la lecture « magie qui s'attarde
   avant d'être absorbée » — sans elle, la gerbe n'est qu'un trait. */
const SOUL_HOVER = 1.0;
const SOUL_DASH = 0.38;
const SOUL_LIFE = SOUL_HOVER + SOUL_DASH;

const souls = [];          // enregistrements vivants
let soulPoints = null, soulPos = null, soulCol = null, soulSize = null;

function initSouls(scene, pixelRatio = 1) {
  soulPos = new Float32Array(SOUL_POOL * 3);
  soulCol = new Float32Array(SOUL_POOL * 3);
  soulSize = new Float32Array(SOUL_POOL);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(soulPos, 3).setUsage(THREE.DynamicDrawUsage));
  g.setAttribute('color', new THREE.BufferAttribute(soulCol, 3).setUsage(THREE.DynamicDrawUsage));
  g.setAttribute('aSize', new THREE.BufferAttribute(soulSize, 1).setUsage(THREE.DynamicDrawUsage));
  g.setDrawRange(0, 0);
  const mat = new THREE.ShaderMaterial({
    // doit être posé à la construction : c'est lui qui injecte `attribute vec3 color`
    vertexColors: true,
    transparent: true,
    depthWrite: false,
    /* Mélange normal, pas additif. En additif, une étincelle rose sur du sable
       clair ou de la neige n'ajoute rien de perceptible — l'effet disparaissait
       exactement sur les biomes les plus lumineux. */
    blending: THREE.NormalBlending,
    uniforms: {
      /* gl_PointSize est en pixels du framebuffer : sans le facteur de
         densité, les particules rétrécissent quand le pixelRatio monte. */
      uScale: { value: 520 * pixelRatio },
    },
    vertexShader: `
      attribute float aSize;
      uniform float uScale;
      varying vec3 vCol;
      void main() {
        vCol = color;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        // ~10 px à la distance de caméra habituelle (≈35 u) — visible à l'œil
        gl_PointSize = aSize * uScale / -mv.z;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `
      varying vec3 vCol;
      void main() {
        float d = length(gl_PointCoord - 0.5);
        if (d > 0.5) discard;
        // profil resserré : petit point net entouré d'un halo court
        float a = smoothstep(0.5, 0.12, d);
        /* Un ShaderMaterial écrit sa couleur telle quelle dans un framebuffer
           sRGB : sans cet encodage, les teintes linéaires sortent nettement
           plus sombres que le reste de la scène. C'est lui qui rend
           l'étincelle réellement lumineuse. */
        vec3 c = pow(max(vCol, vec3(0.0)), vec3(1.0 / 2.2)) * 1.35;
        // cœur surexposé, mais court : le point garde sa couleur de culte
        c = mix(c, vec3(1.0), smoothstep(0.26, 0.0, d) * 0.55);
        gl_FragColor = vec4(c, a);
      }`,
  });
  mat.toneMapped = false;   // l'ACES du rendu écraserait tout l'éclat
  soulPoints = new THREE.Points(g, mat);
  soulPoints.frustumCulled = false;
  soulPoints.renderOrder = 2;
  scene.add(soulPoints);
}

/**
 * Dissout un sceptique en étincelles qui refluent vers le Leader de `f`.
 * Purement visuel : l'appelant a déjà crédité le croyant.
 */
export function spawnSoulBurst(x, z, f) {
  for (let i = 0; i < SOULS_PER_ABSORB; i++) {
    if (souls.length >= SOUL_POOL) break;
    const a = Math.random() * Math.PI * 2;
    const sp = 1.1 + Math.random() * 2.0;
    souls.push({
      x, y: 0.4 + Math.random() * 0.9, z,
      // brève impulsion vers l'extérieur : la gerbe s'ouvre puis se fige
      vx: Math.cos(a) * sp, vy: 1.0 + Math.random() * 1.8, vz: Math.sin(a) * sp,
      f, t: 0,
      // durées légèrement décalées : la nuée ne part pas d'un seul bloc
      hover: SOUL_HOVER * (0.8 + Math.random() * 0.4),
      dash: SOUL_DASH * (0.85 + Math.random() * 0.3),
      size: 0.26 + Math.random() * 0.34,   // fines, mêlées
      ph: Math.random() * Math.PI * 2,     // phase de scintillement
    });
  }
}

/** Vide les particules en cours (changement de partie). */
export function resetCrystals() { souls.length = 0; }

/* Anime les étincelles : dispersion, suspension sur place, puis aspiration. */
function updateSouls(dt) {
  if (!soulPoints) return;
  let n = 0;
  for (let i = souls.length - 1; i >= 0; i--) {
    const s = souls[i];
    s.t += dt;
    if (s.t >= s.hover + s.dash || !s.f.alive) { souls.splice(i, 1); continue; }

    if (s.t < s.hover) {
      /* -- Suspension : l'impulsion initiale est amortie très vite, puis
         l'étincelle dérive à peine, portée par un souffle. Elle a l'air de
         « tenir » en l'air en attendant d'être appelée. -- */
      const drag = 1 - Math.min(0.9, dt * 4.5);
      s.vx *= drag; s.vz *= drag;
      s.vy += (0.28 - s.vy) * Math.min(1, dt * 2.4);       // portance douce
      s.vx += Math.sin(s.t * 2.3 + s.ph) * 0.7 * dt;       // ondulation lente
      s.vz += Math.cos(s.t * 2.0 + s.ph * 1.7) * 0.7 * dt;
    } else {
      /* -- Aspiration : attraction qui explose sur la fin de course, sans
         amortissement, pour que le départ soit sec et la trajectoire tendue. -- */
      const k = (s.t - s.hover) / s.dash;
      const L = s.f.leader;
      const pull = 22 + k * k * 190;
      s.vx += (L.x - s.x) * pull * dt;
      s.vy += (1.25 - s.y) * pull * dt;
      s.vz += (L.z - s.z) * pull * dt;
      const drag = 1 - Math.min(0.85, dt * 7);
      s.vx *= drag; s.vy *= drag; s.vz *= drag;
    }
    s.x += s.vx * dt; s.y += s.vy * dt; s.z += s.vz * dt;

    soulPos[n * 3] = s.x; soulPos[n * 3 + 1] = s.y; soulPos[n * 3 + 2] = s.z;
    const c = s.f.color;
    soulCol[n * 3] = c.r; soulCol[n * 3 + 1] = c.g; soulCol[n * 3 + 2] = c.b;

    /* Taille : apparition vive, plateau pendant la suspension, résorption dans
       le personnage à l'arrivée. La disparition passe par la taille et non par
       la couleur — en mélange normal, une particule assombrie devient grise
       au lieu de s'effacer. Le scintillement fait le reste de la « brillance ».  */
    let sk = Math.min(1, s.t / 0.1);
    if (s.t > s.hover) {
      const k = (s.t - s.hover) / s.dash;
      sk *= 1 - Math.max(0, (k - 0.6) / 0.4);
    }
    soulSize[n] = s.size * sk * (0.78 + 0.22 * Math.sin(s.t * 22 + s.ph));
    n++;
  }
  soulPoints.geometry.setDrawRange(0, n);
  soulPoints.geometry.attributes.position.needsUpdate = true;
  soulPoints.geometry.attributes.color.needsUpdate = true;
  soulPoints.geometry.attributes.aSize.needsUpdate = true;
}

const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _axis = new THREE.Vector3(0, 1, 0);
const _hidden = new THREE.Matrix4().makeScale(0, 0, 0);

/**
 * Anime et dessine tous les cristaux.
 * @param {number} dt
 * @param {number} t        horloge de la partie
 * @param {Array}  factions (ignoré pour l'anneau — désactivé)
 */
export function updateCrystals(dt, t, factions) {
  if (!mesh) return;
  /* Anneau orbital masqué : pas de diamants autour du Leader. */
  for (let i = 0; i < CRYSTAL_CAP_TOTAL; i++) mesh.setMatrixAt(i, _hidden);
  mesh.count = 0;
  mesh.instanceMatrix.needsUpdate = true;
  updateSouls(dt);
}

/* Position monde d'un cristal donné — sert à faire partir l'éclat quand il casse. */
export function crystalWorldPos(f, i, t, out = new THREE.Vector3()) {
  orbitPos(i, t, out);
  out.x += f.leader.x;
  out.z += f.leader.z;
  return out;
}
