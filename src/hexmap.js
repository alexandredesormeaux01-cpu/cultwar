/* ===========================================================================
   Cult.io — Archipel hexagonal procédural
   ---------------------------------------------------------------------------
   Chaque carte est une île suspendue dans le vide, bâtie de tuiles hexagonales
   épaisses (« flat-top ») posées sur une grille axiale. Ciel / props = un biome ;
   le SOL est une couleur unie par tuile + léger dégradé radial (look mobile).

   Règles de génération (contrat de jeu) :
     • Le dessus de TOUTES les tuiles jouables est à y = 0. Le gameplay reste
       strictement plan — seuls les dessous et le décor varient en hauteur.
     • Aucune tuile n'est inatteignable : la connexité est vérifiée sur le
       graphe « adjacence ∪ saut » (voir JUMP ci-dessous).
     • Trous intérieurs : fosses d'une tuile (bondissables) + quelques lacs
       de 2–3 tuiles. Toute suppression est validée par isFullyReachable.
       (Les anciens grappes trop larges formaient des murs invisibles.)
=========================================================================== */

import * as THREE from 'three';
import { BIOMES, toonMaterial, attachCartoonOutline } from './biomes.js';

/* ============================== Géométrie de la grille ============================== */

/* Rayon circonscrit d'une tuile. Choisi pour que le bond au-dessus d'un trou
   d'une tuile (≈ 2 × apothème × 2) reste lisible à l'échelle des fidèles. */
export const HEX_R = 6.2;
const SQ3 = Math.sqrt(3);
const APOTHEM = (SQ3 / 2) * HEX_R;        // centre → milieu d'arête
const CRUST_H = 1.2;                      // Épaisseur de la dalle (tuiles plus minces)

/* Directions axiales, dans l'ordre des normales d'arête (−30°, 30°, 90°…). */
const DIRS = [[1, -1], [1, 0], [0, 1], [-1, 1], [-1, 0], [0, -1]];
/* Normales unitaires correspondantes en espace monde (x, z). */
const NORMALS = DIRS.map(([dq, dr]) => {
  const x = HEX_R * 1.5 * dq;
  const z = HEX_R * (SQ3 / 2) * dq + HEX_R * SQ3 * dr;
  const n = Math.hypot(x, z);
  return [x / n, z / n];
});

const key = (q, r) => (q + 1000) * 10000 + (r + 1000);

export function axialToWorld(q, r) {
  return {
    x: HEX_R * 1.5 * q,
    z: HEX_R * ((SQ3 / 2) * q + SQ3 * r),
  };
}

/* Monde → axial, avec arrondi cubique (le seul arrondi correct sur une grille hex). */
export function worldToAxial(x, z) {
  const fq = (2 / 3) * x / HEX_R;
  const fr = (-x / 3 + (SQ3 / 3) * z) / HEX_R;
  const fs = -fq - fr;
  let q = Math.round(fq), r = Math.round(fr), s = Math.round(fs);
  const dq = Math.abs(q - fq), dr = Math.abs(r - fr), ds = Math.abs(s - fs);
  if (dq > dr && dq > ds) q = -r - s;
  else if (dr > ds) r = -q - s;
  return { q, r };
}

/* ============================== Aléatoire reproductible ============================== */

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* Bruit de valeur 2D lissé, suffisant pour découper une silhouette organique. */
function makeNoise(rng) {
  const perm = new Float32Array(256);
  for (let i = 0; i < 256; i++) perm[i] = rng();
  const at = (i, j) => perm[(((i * 73 + j * 151) % 256) + 256) % 256];
  const smooth = (t) => t * t * (3 - 2 * t);
  return function noise(x, y) {
    const i = Math.floor(x), j = Math.floor(y);
    const fx = smooth(x - i), fy = smooth(y - j);
    const a = at(i, j), b = at(i + 1, j), c = at(i, j + 1), d = at(i + 1, j + 1);
    return (a + (b - a) * fx) + ((c + (d - c) * fx) - (a + (b - a) * fx)) * fy;
  };
}

/* ============================== Génération de l'île ============================== */

const TILE_MIN = 92;      // ~ un disque de rayon 55
const TILE_MAX = 132;     // ~ un disque de rayon 66

/* Rôles de tuile. Le rôle pilote la teinte ET le décor qui s'y pose. */
export const ROLE = {
  PLAZA: 'plaza',          // cœur de l'île, dégagé — zone de départ
  PLAIN: 'plain',          // herbe rase, fleurs
  GROVE: 'grove',          // bosquet : arbres et buissons
  VILLAGE: 'village',      // habitations (entités « maison » du gameplay)
  ROCK: 'rock',            // caillasse, sol plus clair, peu de végétation
  SANCTUARY: 'sanctuary',  // Lieu Saint : autel central, sol pâle, rien autour
};

/**
 * Bâtit une île complète.
 * @param {object} opts { seed, biomeKey, maxR }
 * @returns {object} île { tiles, byKey, radius, seed, jumps }
 */
export function generateIsland(opts = {}) {
  const seed = opts.seed ?? ((Math.random() * 0xffffffff) | 0);
  const rng = mulberry32(seed);
  const noise = makeNoise(rng);
  const maxR = opts.maxR ?? 60;
  const target = TILE_MIN + Math.floor(rng() * (TILE_MAX - TILE_MIN + 1));

  /* --- 1. Silhouette : croissance depuis le centre, en avalant toujours le
         candidat de plus faible « distance perturbée par le bruit ». Croître
         plutôt que trier un disque garantit une masse d'un seul tenant : le
         bruit ne peut alors que découper la bordure, jamais détacher un îlot.
         fbm 2 octaves = grandes baies + dentelure de côte. --- */
  const scoreOf = (x, z) => {
    const n = noise(x * 0.018, z * 0.018) * 0.72 + noise(x * 0.055, z * 0.055) * 0.28;
    return Math.hypot(x, z) * (0.62 + n * 0.76);
  };

  const byKey = new Map();
  const frontier = [{ q: 0, r: 0, ...axialToWorld(0, 0), score: 0 }];
  const queued = new Set([key(0, 0)]);
  while (byKey.size < target && frontier.length) {
    // frontière courte (quelques dizaines d'entrées) : le balayage linéaire
    // coûte moins qu'un tas, et reste parfaitement déterministe
    let bi = 0;
    for (let i = 1; i < frontier.length; i++) if (frontier[i].score < frontier[bi].score) bi = i;
    const c = frontier.splice(bi, 1)[0];
    const d = Math.hypot(c.x, c.z);
    if (d > maxR) continue;
    byKey.set(key(c.q, c.r), {
      q: c.q, r: c.r, x: c.x, z: c.z, d,
      role: ROLE.PLAIN, edge: false, tint: null,
    });
    for (const [dq, dr] of DIRS) {
      const nq = c.q + dq, nr = c.r + dr, k = key(nq, nr);
      if (queued.has(k)) continue;
      queued.add(k);
      const w = axialToWorld(nq, nr);
      frontier.push({ q: nq, r: nr, x: w.x, z: w.z, score: scoreOf(w.x, w.z) });
    }
  }

  /* --- 2. Trous intérieurs : fosses (1 tuile, bondissables) + petits lacs.
         Les tuiles restantes gardent leur dessus ; le vide se lit entre elles. --- */
  punchInteriorHoles(byKey, rng, maxR);

  /* --- 3. Filet de sécurité : si malgré tout des tuiles restent isolées
         (silhouette éclatée par le bruit), on ne garde que la composante
         principale — jamais de caillou inatteignable en l'air. --- */
  keepLargestComponent(byKey);

  const tiles = [...byKey.values()];
  const radius = tiles.reduce((m, t) => Math.max(m, t.d), 0);

  /* --- 4. Bordures et liens de saut (précalculés une fois pour toutes). --- */
  const jumps = [];
  for (const t of tiles) {
    t.open = 0;         // masque de bits : arêtes donnant sur le vide
    t.jump = 0;         // masque de bits : arêtes franchissables d'un bond
    t.clip = 0;         // arêtes à reculer visuellement (trous intérieurs seulement)
    for (let i = 0; i < 6; i++) {
      const [dq, dr] = DIRS[i];
      if (byKey.has(key(t.q + dq, t.r + dr))) continue;
      t.open |= 1 << i;
      t.edge = true;
      if (byKey.has(key(t.q + dq * 2, t.r + dr * 2))) {
        t.jump |= 1 << i;
        t.clip |= 1 << i;
        const dst = axialToWorld(t.q + dq * 2, t.r + dr * 2);
        jumps.push({ from: t, dir: i, x: dst.x, z: dst.z });
      } else {
        /* Lac / fosse multi-tuiles : la case vide a assez de voisins solides. */
        const eq = t.q + dq, er = t.r + dr;
        let n = 0;
        for (const [dq2, dr2] of DIRS) {
          if (byKey.has(key(eq + dq2, er + dr2))) n++;
        }
        if (n >= 3) t.clip |= 1 << i;
      }
    }
  }

  /* --- 5. Rôles. --- */
  assignRoles(tiles, byKey, rng, radius);

  /* --- 6. Teinte unie par tuile (variations douces dans la palette biome). --- */
  const B = BIOMES[opts.biomeKey] || BIOMES.temperate;
  const cGround = B.ground.map((h) => new THREE.Color(h));
  const biomeKey = opts.biomeKey || 'temperate';
  for (const t of tiles) {
    const n = noise(t.x * 0.05 + 40, t.z * 0.05 + 40);
    const c = cGround[0].clone().lerp(n > 0.5 ? cGround[2] : cGround[1], Math.abs(n * 2 - 1) * 0.85);
    if (t.role === ROLE.GROVE) c.offsetHSL(0, 0.06, -0.04);
    else if (t.role === ROLE.ROCK) c.lerp(new THREE.Color(0xb8b4a8), 0.35);
    else if (t.role === ROLE.SANCTUARY) c.lerp(new THREE.Color(0xffffff), 0.38);
    else if (t.role === ROLE.PLAZA) c.lerp(new THREE.Color(B.pathColor || 0xa87a4a), 0.22);
    c.offsetHSL(0, 0.08, (n - 0.5) * 0.04);
    t.tint = c;
  }

  return { tiles, byKey, radius, seed, jumps, biomeKey };
}

/* Parcours en largeur sur adjacence ∪ saut, depuis la tuile la plus centrale. */
function reachableSet(byKey) {
  const tiles = [...byKey.values()];
  if (!tiles.length) return new Set();
  let start = tiles[0];
  for (const t of tiles) if (t.d < start.d) start = t;
  const seen = new Set([key(start.q, start.r)]);
  const stack = [start];
  while (stack.length) {
    const t = stack.pop();
    for (const [dq, dr] of DIRS) {
      // pas adjacent
      let k = key(t.q + dq, t.r + dr);
      let nb = byKey.get(k);
      if (nb && !seen.has(k)) { seen.add(k); stack.push(nb); continue; }
      // bond au-dessus d'un trou d'exactement une tuile
      if (nb) continue;
      k = key(t.q + dq * 2, t.r + dr * 2);
      nb = byKey.get(k);
      if (nb && !seen.has(k)) { seen.add(k); stack.push(nb); }
    }
  }
  return seen;
}

const isFullyReachable = (byKey) => reachableSet(byKey).size === byKey.size;

function keepLargestComponent(byKey) {
  const seen = reachableSet(byKey);
  if (seen.size === byKey.size) return;
  for (const k of [...byKey.keys()]) if (!seen.has(k)) byKey.delete(k);
}

/** Mélange Fisher–Yates déterministe. */
function shuffleInPlace(arr, rng) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = (rng() * (i + 1)) | 0;
    const tmp = arr[i]; arr[i] = arr[j]; arr[j] = tmp;
  }
  return arr;
}

/**
 * Creuse des vides dans la masse de l'île.
 *  - fosses d'1 tuile (franchissables d'un bond)
 *  - quelques lacs de 4–8 tuiles (on contourne à pied)
 * Le centre (spawn) et la lisière restent pleins.
 */
function punchInteriorHoles(byKey, rng, maxR) {
  const all = [...byKey.values()];
  if (all.length < 80) return;
  const radius = all.reduce((m, t) => Math.max(m, t.d), 0);

  const tryRemove = (tiles) => {
    const saved = [];
    for (const t of tiles) {
      const k = key(t.q, t.r);
      if (!byKey.has(k)) return false;
      saved.push([k, t]);
      byKey.delete(k);
    }
    if (isFullyReachable(byKey)) return true;
    for (const [k, t] of saved) byKey.set(k, t);
    return false;
  };

  /* Fosses unitaires (bondissables). */
  const singleTarget = Math.min(12, 4 + ((all.length / 50) | 0) + ((rng() * 4) | 0));
  const singlePool = shuffleInPlace(
    all.filter((t) => t.d > 16 && t.d < Math.min(maxR - 8, radius - 10)),
    rng,
  );
  let singles = 0;
  for (const t of singlePool) {
    if (singles >= singleTarget) break;
    if (tryRemove([t])) singles++;
  }

  /* Lacs (4–8 tuiles). */
  const lakeTarget = 2 + ((rng() * 3) | 0);
  let lakes = 0;
  const lakeSeeds = shuffleInPlace(
    [...byKey.values()].filter((t) => t.d > 18 && t.d < radius - 12),
    rng,
  );
  for (const seed of lakeSeeds) {
    if (lakes >= lakeTarget) break;
    if (!byKey.has(key(seed.q, seed.r))) continue;
    const cluster = [seed];
    const want = 4 + ((rng() * 5) | 0);
    let guard = 28;
    while (cluster.length < want && guard-- > 0) {
      const from = cluster[(rng() * cluster.length) | 0];
      const [dq, dr] = DIRS[(rng() * 6) | 0];
      const nb = byKey.get(key(from.q + dq, from.r + dr));
      if (!nb || cluster.includes(nb)) continue;
      if (nb.d < 14 || nb.d > radius - 8) continue;
      cluster.push(nb);
    }
    if (cluster.length < 4) continue;
    if (tryRemove(cluster)) lakes++;
  }
}

/* ---------------------------------------------------------------------------
   Rôles : le cœur reste dégagé (on y démarre), les sanctuaires sont espacés,
   les hameaux forment de vraies grappes, les bosquets s'étalent en taches.
--------------------------------------------------------------------------- */
function assignRoles(tiles, byKey, rng, radius) {
  const far = tiles.filter((t) => t.d > 20 && t.d < radius - 6);
  const shuffled = [...far].sort(() => rng() - 0.5);

  // Sanctuaires : 2 à 3, jamais à moins de 26 unités l'un de l'autre
  const sanctuaries = [];
  const wanted = 2 + ((rng() * 2) | 0);
  for (const t of shuffled) {
    if (sanctuaries.length >= wanted) break;
    if (sanctuaries.some((s) => Math.hypot(s.x - t.x, s.z - t.z) < 26)) continue;
    t.role = ROLE.SANCTUARY;
    sanctuaries.push(t);
  }

  // Hameaux : 2 à 3 grappes de 2 à 4 tuiles contiguës
  const hamlets = 2 + ((rng() * 2) | 0);
  for (let h = 0; h < hamlets; h++) {
    const seed = shuffled.find((t) => t.role === ROLE.PLAIN
      && !sanctuaries.some((s) => Math.hypot(s.x - t.x, s.z - t.z) < 20));
    if (!seed) break;
    const cluster = [seed];
    seed.role = ROLE.VILLAGE;
    const size = 2 + ((rng() * 3) | 0);
    let guard = 20;
    while (cluster.length < size && guard-- > 0) {
      const from = cluster[(rng() * cluster.length) | 0];
      const [dq, dr] = DIRS[(rng() * 6) | 0];
      const nb = byKey.get(key(from.q + dq, from.r + dr));
      if (!nb || nb.role !== ROLE.PLAIN || nb.d < 16) continue;
      nb.role = ROLE.VILLAGE;
      cluster.push(nb);
    }
  }

  // Le reste : cœur dégagé, puis bosquets / caillasse / prairie
  for (const t of tiles) {
    if (t.role !== ROLE.PLAIN) continue;
    if (t.d < 13) { t.role = ROLE.PLAZA; continue; }
    const roll = rng();
    if (roll < 0.42) t.role = ROLE.GROVE;
    else if (roll < 0.56) t.role = ROLE.ROCK;
  }
}

/* ============================== Requêtes de terrain ============================== */

const HEX_MAX_D2 = HEX_R * HEX_R * 1.15; // ~44.2 (couvre 100% de la surface de chaque tuile, y compris les 6 coins)

export function tileAt(island, x, z) {
  if (!island || !island.byKey) return null;
  const { q, r } = worldToAxial(x, z);
  const direct = island.byKey.get(key(q, r));
  if (direct) return direct;

  // Filet de sécurité aux jointures d'arêtes / coins pour éviter tout "faux vide"
  let best = null, bestD = HEX_MAX_D2;
  for (const [dq, dr] of DIRS) {
    const nb = island.byKey.get(key(q + dq, r + dr));
    if (nb) {
      const d2 = (x - nb.x) ** 2 + (z - nb.z) ** 2;
      if (d2 <= bestD) {
        bestD = d2;
        best = nb;
      }
    }
  }
  if (best) return best;

  // Recherche secours sur toutes les tuiles au cas où l'arrondi axiale s'écarte aux coins
  if (island.tiles) {
    for (let i = 0; i < island.tiles.length; i++) {
      const t = island.tiles[i];
      const d2 = (x - t.x) ** 2 + (z - t.z) ** 2;
      if (d2 <= bestD) {
        bestD = d2;
        best = t;
      }
    }
  }
  return best;
}

export const isSolid = (island, x, z) => tileAt(island, x, z) !== null;

/* Un point aléatoire sur une tuile jouable, à distance [minD, maxD] du centre. */
export function randomPoint(island, minD = 0, maxD = Infinity, rng = Math.random) {
  const pool = island.tiles.filter((t) => t.d >= minD && t.d <= maxD && t.role !== ROLE.SANCTUARY);
  const src = pool.length ? pool : island.tiles;
  const t = src[(rng() * src.length) | 0];
  // point uniforme dans le disque inscrit : jamais à cheval sur une arête
  const a = rng() * Math.PI * 2, rr = Math.sqrt(rng()) * (APOTHEM - 1.2);
  return { x: t.x + Math.cos(a) * rr, z: t.z + Math.sin(a) * rr, tile: t };
}

/* ---------------------------------------------------------------------------
   Collision + bond automatique.

   `e` est n'importe quelle entité { x, z, y?, jmp? }. On lui passe sa vitesse
   courante pour décider d'un bond : pousser contre une arête franchissable
   déclenche le saut, ce qui donne un contrôle limpide au pouce (aucun bouton).

   Retourne true si l'entité est en l'air (le reste du moteur peut alors
   sauter sa logique de contact).
--------------------------------------------------------------------------- */
const JUMP_DUR = 0.42;
const JUMP_H = 3.2;
const JUMP_PUSH = 0.35;
/* Marge uniquement au bord du VIDE (recul côte). Entre deux dalles solides
   les hex s'emboîtent à l'apothème exact — toute marge y creuse un fossé
   = mur invisible entre tuiles voisines. */
const EDGE_MARGIN = 0.35;
/* Recul visuel uniquement sur les arêtes face à un trou intérieur.
   Trop agressif sur toute la côte → surfaces mangées. */
const OPEN_CLIP = APOTHEM - 0.35;
const HEX_EPS = 0.25;   // chevauchement aux coins de jointure entre 3 hex adjacents

/** True si (x,z) est dans le polygone de la tuile.
 *  - Si l'arête i donne sur une tuile voisine, la limite est large (APOTHEM + 1.2) pour un passage fluide.
 *  - Si l'arête i donne sur le vide, la limite est APOTHEM - EDGE_MARGIN (recul de falaise).
 */
function insideHexTile(tile, x, z, extraMargin = 0) {
  const open = tile.open || 0;
  for (let i = 0; i < 6; i++) {
    const [nx, nz] = NORMALS[i];
    const proj = (x - tile.x) * nx + (z - tile.z) * nz;
    const isOpen = (open & (1 << i)) !== 0;
    const lim = isOpen ? (APOTHEM - EDGE_MARGIN + extraMargin) : (APOTHEM + 1.2 + extraMargin);
    if (proj > lim) return false;
  }
  return true;
}

/** Tuile solide dont le polygone contient le point (axial + 6 voisins + recherche de secours). */
function containingTile(island, x, z) {
  if (!island || !island.byKey) return null;
  const { q, r } = worldToAxial(x, z);
  let t = island.byKey.get(key(q, r));
  if (t && insideHexTile(t, x, z)) return t;

  for (let i = 0; i < 6; i++) {
    const [dq, dr] = DIRS[i];
    t = island.byKey.get(key(q + dq, r + dr));
    if (t && insideHexTile(t, x, z)) return t;
  }

  // Recherche de secours sur toutes les tuiles au cas où worldToAxial s'écarte aux coins
  if (island.tiles) {
    for (let i = 0; i < island.tiles.length; i++) {
      const tile = island.tiles[i];
      if (insideHexTile(tile, x, z)) return tile;
    }
  }
  return null;
}

export function resolveIsland(island, e, vx, vz, dt, allowJump = false) {
  if (!island || !island.tiles) { e.y = 0; return false; }

  if (e._safeX === undefined) { e._safeX = e.x; e._safeZ = e.z; }

  if (e.jmp) {
    e.jmp.t += dt;
    const k = Math.min(1, e.jmp.t / JUMP_DUR);
    const u = k * k * (3 - 2 * k);
    e.x = e.jmp.x0 + (e.jmp.x1 - e.jmp.x0) * u;
    e.z = e.jmp.z0 + (e.jmp.z1 - e.jmp.z0) * u;
    e.y = Math.sin(k * Math.PI) * JUMP_H;
    if (k >= 1) {
      e.x = e.jmp.x1;
      e.z = e.jmp.z1;
      e.y = 0;
      e.jmp = null;
      // Atterrissage : ancrer le point sûr sur la dalle d'arrivée
      if (containingTile(island, e.x, e.z)) {
        e._safeX = e.x; e._safeZ = e.z;
      }
      return false;
    }
    return true;
  }

  e.y = 0;

  const inside = containingTile(island, e.x, e.z);
  if (inside) {
    e._safeX = e.x; e._safeZ = e.z;
    if (allowJump) {
      const near = APOTHEM - 0.5;
      for (let i = 0; i < 6; i++) {
        const [dq, dr] = DIRS[i];
        if (island.byKey.has(key(inside.q + dq, inside.r + dr))) continue;
        const [nx, nz] = NORMALS[i];
        const proj = (e.x - inside.x) * nx + (e.z - inside.z) * nz;
        if (proj <= near) continue;
        if ((vx * nx + vz * nz) <= JUMP_PUSH) continue;
        if (!island.byKey.has(key(inside.q + dq * 2, inside.r + dr * 2))) continue;
        const dst = axialToWorld(inside.q + dq * 2, inside.r + dr * 2);
        e.jmp = { t: 0, x0: e.x, z0: e.z, x1: dst.x, z1: dst.z };
        return true;
      }
    }
    return false;
  }

  /* Hors dalle : si le point sûr est lui aussi dans le vide (spawn / repulsion),
     on se téléporte sur la tuile solide la plus proche — sinon on reste coincé. */
  if (!containingTile(island, e._safeX, e._safeZ)) {
    const p = nearestSolidPoint(island, e.x, e.z);
    e.x = e._safeX = p.x;
    e.z = e._safeZ = p.z;
    e.jmp = null;
    return false;
  }

  const sx = e._safeX, sz = e._safeZ;
  const dx = e.x - sx, dz = e.z - sz;
  let lo = 0, hi = 1;
  for (let step = 0; step < 8; step++) {
    const mid = (lo + hi) * 0.5;
    if (containingTile(island, sx + dx * mid, sz + dz * mid)) lo = mid; else hi = mid;
  }
  e.x = sx + dx * lo;
  e.z = sz + dz * lo;
  e._safeX = e.x; e._safeZ = e.z;
  return false;
}

/** Centre de la tuile solide la plus proche de (x,z). */
export function nearestSolidPoint(island, x, z) {
  if (!island?.tiles?.length) return { x, z };
  let best = island.tiles[0], bestD = Infinity;
  for (let i = 0; i < island.tiles.length; i++) {
    const t = island.tiles[i];
    const d = (t.x - x) * (t.x - x) + (t.z - z) * (t.z - z);
    if (d < bestD) { bestD = d; best = t; }
  }
  return { x: best.x, z: best.z };
}

/**
 * True si, depuis (x,z) en poussant vers (dirX,dirZ), un bond d'1 tuile
 * est disponible (même règle que resolveIsland + allowJump).
 */
export function canJumpToward(island, x, z, dirX, dirZ) {
  if (!island?.byKey) return false;
  const dn = Math.hypot(dirX, dirZ);
  if (dn < 1e-5) return false;
  const wx = dirX / dn, wz = dirZ / dn;
  const inside = containingTile(island, x, z);
  if (!inside) return false;
  const near = APOTHEM - 0.5;
  for (let i = 0; i < 6; i++) {
    const [dq, dr] = DIRS[i];
    if (island.byKey.has(key(inside.q + dq, inside.r + dr))) continue;
    const [nx, nz] = NORMALS[i];
    const proj = (x - inside.x) * nx + (z - inside.z) * nz;
    if (proj <= near) continue;
    if ((wx * nx + wz * nz) <= JUMP_PUSH) continue;
    if (!island.byKey.has(key(inside.q + dq * 2, inside.r + dr * 2))) continue;
    return true;
  }
  return false;
}

/* ============================== Rendu de l'île ============================== */

/* Dalle : hexagone flat-top à 6 sommets nets. */
function makeCrust() {
  const yBot = -CRUST_H;
  const positions = [];
  const colors = [];
  const uvs = [];
  const indices = [];

  const cSide = new THREE.Color(0.42, 0.38, 0.34);
  const cSideBot = new THREE.Color(0.22, 0.20, 0.18);
  const cBot = new THREE.Color(0.14, 0.14, 0.16);

  const corner = [];
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    corner.push([HEX_R * Math.cos(a), HEX_R * Math.sin(a)]);
  }

  function push(x, y, z, col) {
    const idx = positions.length / 3;
    positions.push(x, y, z);
    colors.push(col.r, col.g, col.b);
    uvs.push(x / (HEX_R * 2) + 0.5, z / (HEX_R * 2) + 0.5);
    return idx;
  }

  function topCol(x, z) {
    const dist = Math.min(1, Math.hypot(x, z) / HEX_R);
    const sh = Math.max(0.82, 1.04 - dist * dist * 0.14);
    return new THREE.Color(sh, sh, sh);
  }

  const topC = push(0, 0, 0, topCol(0, 0));
  const topV = corner.map(([x, z]) => push(x, 0, z, topCol(x, z)));
  /* Enroulement CCW vu depuis +Y pour que Face avant = dessus marchable. */
  for (let i = 0; i < 6; i++) indices.push(topC, topV[(i + 1) % 6], topV[i]);

  for (let i = 0; i < 6; i++) {
    const j = (i + 1) % 6;
    const [x0, z0] = corner[i];
    const [x1, z1] = corner[j];
    const a = push(x0, 0, z0, cSide);
    const b = push(x1, 0, z1, cSide);
    const c = push(x1, yBot, z1, cSideBot);
    const d = push(x0, yBot, z0, cSideBot);
    indices.push(d, a, b, d, b, c);
  }

  const botC = push(0, yBot, 0, cBot);
  const botV = corner.map(([x, z]) => push(x, yBot, z, cBot));
  for (let i = 0; i < 6; i++) indices.push(botC, botV[(i + 1) % 6], botV[i]);

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3));
  geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(colors), 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(uvs), 2));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

let crustGeo = null;
const clippedCrustCache = new Map();

let _crustGradient = null;
function getCrustGradient() {
  if (_crustGradient) return _crustGradient;
  const data = new Uint8Array([70, 130, 190, 255]);
  _crustGradient = new THREE.DataTexture(data, 4, 1, THREE.RedFormat);
  _crustGradient.minFilter = THREE.NearestFilter;
  _crustGradient.magFilter = THREE.NearestFilter;
  _crustGradient.needsUpdate = true;
  return _crustGradient;
}

let _crustMat = null;

function getCrustMaterial() {
  if (_crustMat && _crustMat.userData.crustV === 3) return _crustMat;
  if (_crustMat) { _crustMat.dispose(); _crustMat = null; }
  _crustMat = new THREE.MeshToonMaterial({
    gradientMap: getCrustGradient(),
    vertexColors: true,
    color: 0xffffff,
    flatShading: false,
  });
  _crustMat.userData.crustV = 3;
  return _crustMat;
}

/** Clip CPU : seulement les arêtes t.clip (trous), pas toute la côte. */
function makeClippedCrust(clipMask) {
  clipMask = clipMask & 63;
  if (clipMask === 0) {
    if (!crustGeo) crustGeo = makeCrust();
    return crustGeo;
  }
  let geo = clippedCrustCache.get(clipMask);
  if (geo) return geo;
  if (!crustGeo) crustGeo = makeCrust();
  geo = crustGeo.clone();
  const pos = geo.attributes.position;
  const arr = pos.array;
  for (let i = 0; i < pos.count; i++) {
    let x = arr[i * 3], z = arr[i * 3 + 2];
    for (let e = 0; e < 6; e++) {
      if (!(clipMask & (1 << e))) continue;
      const [nx, nz] = NORMALS[e];
      const over = x * nx + z * nz - OPEN_CLIP;
      if (over > 0) { x -= nx * over; z -= nz * over; }
    }
    arr[i * 3] = x;
    arr[i * 3 + 2] = z;
  }
  pos.needsUpdate = true;
  geo.computeVertexNormals();
  clippedCrustCache.set(clipMask, geo);
  return geo;
}

function disposeClippedCrustCache() {
  for (const [mask, geo] of clippedCrustCache) {
    if (mask !== 0) geo.dispose();
  }
  clippedCrustCache.clear();
}

/**
 * Contour côte / fosses : barre coin→coin du hex → jointure exacte aux sommets.
 */
function buildCoastOutline(scene, island) {
  let nEdges = 0;
  for (const t of island.tiles) {
    const open = t.open || 0;
    for (let i = 0; i < 6; i++) if (open & (1 << i)) nEdges++;
  }
  if (!nEdges) return [];

  const BAR_W = 0.16;
  const BAR_H = 0.07;
  const geo = new THREE.BoxGeometry(1, BAR_H, BAR_W);
  const mat = new THREE.MeshBasicMaterial({ color: 0x080a12 });
  const mesh = new THREE.InstancedMesh(geo, mat, nEdges);
  mesh.frustumCulled = false;
  mesh.userData.disposeGeo = true;
  mesh.matrixAutoUpdate = false;

  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const s = new THREE.Vector3();
  const p = new THREE.Vector3();
  const UP = new THREE.Vector3(0, 1, 0);
  let slot = 0;

  for (const t of island.tiles) {
    const open = t.open || 0;
    if (!open) continue;
    for (let i = 0; i < 6; i++) {
      if (!(open & (1 << i))) continue;
      /* Arête i (normale NORMALS[i]) = coins (i+5)%6 → i. */
      const c0 = (i + 5) % 6;
      const c1 = i;
      const a0 = (c0 / 6) * Math.PI * 2;
      const a1 = (c1 / 6) * Math.PI * 2;
      const x0 = t.x + HEX_R * Math.cos(a0);
      const z0 = t.z + HEX_R * Math.sin(a0);
      const x1 = t.x + HEX_R * Math.cos(a1);
      const z1 = t.z + HEX_R * Math.sin(a1);
      const dx = x1 - x0, dz = z1 - z0;
      const len = Math.hypot(dx, dz);
      p.set((x0 + x1) * 0.5, BAR_H * 0.5, (z0 + z1) * 0.5);
      q.setFromAxisAngle(UP, Math.atan2(-dz, dx));
      s.set(len * 1.02, 1, 1);
      m.compose(p, q, s);
      mesh.setMatrixAt(slot++, m);
    }
  }
  mesh.instanceMatrix.needsUpdate = true;
  scene.add(mesh);
  return [mesh];
}

/**
 * Construit les meshes de l'île. Retourne les objets à retirer entre parties.
 */
export function buildIslandMeshes(scene, island) {
  if (crustGeo) {
    crustGeo.dispose();
    crustGeo = null;
  }
  disposeClippedCrustCache();
  crustGeo = makeCrust();

  const created = [];
  const n = island.tiles.length;
  const crustMat = getCrustMaterial();
  const crust = new THREE.InstancedMesh(crustGeo, crustMat, n);
  crust.receiveShadow = true;
  crust.castShadow = true;
  crust.userData.sharedGeo = true;
  crust.userData.sharedMat = true;

  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(1, 1, 1), p = new THREE.Vector3();
  q.identity();
  for (let i = 0; i < n; i++) {
    const t = island.tiles[i];
    p.set(t.x, 0, t.z);
    m.compose(p, q, s);
    crust.setMatrixAt(i, m);
    crust.setColorAt(i, t.tint);
  }
  crust.instanceMatrix.needsUpdate = true;
  if (crust.instanceColor) crust.instanceColor.needsUpdate = true;
  scene.add(crust);
  created.push(crust);

  created.push(...buildCoastOutline(scene, island));
  return created;
}

/* ============================== Le vide : ciel, débris, poussière ============================== */

/* Tons de l'abîme, dérivés du ciel du biome : le vide reste de la même famille
   chromatique que l'île, il ne plaque pas un noir générique sous tous les biomes. */
function voidTones(B) {
  const sky = new THREE.Color(B.sky);
  return {
    sky,
    mid: sky.clone().lerp(new THREE.Color(0x2a2450), 0.35),
    deep: sky.clone().lerp(new THREE.Color(0x0b0a1c), 0.82),
  };
}

/* Dégradé vertical : ciel du biome en haut, abîme en bas. */
function makeVoidBackground(B) {
  const cv = document.createElement('canvas');
  cv.width = 4; cv.height = 256;
  const ctx = cv.getContext('2d');
  const { sky, mid, deep } = voidTones(B);
  const g = ctx.createLinearGradient(0, 0, 0, 256);
  g.addColorStop(0, `#${sky.getHexString()}`);
  g.addColorStop(0.42, `#${sky.clone().lerp(mid, 0.5).getHexString()}`);
  g.addColorStop(0.66, `#${mid.getHexString()}`);
  g.addColorStop(1, `#${deep.getHexString()}`);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 4, 256);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.mapping = THREE.EquirectangularReflectionMapping;
  return tex;
}

let fx = null;   // { shards, motes, shardData, halo }

/**
 * Décor du vide : éclats rocheux en suspension, poussière lumineuse, halo bas.
 * Tout est purement décoratif — aucune interaction avec le gameplay.
 */
export function buildVoid(scene, island, biomeKey) {
  const B = BIOMES[biomeKey] || BIOMES.temperate;
  const created = [];

  scene.background = makeVoidBackground(B);
  created.push({ isBackgroundTex: true, dispose: () => scene.background?.dispose?.() });

  /* Brouillard distant : garde la surface de l'île parfaitement nette et vive,
     et fond uniquement les éclats lointains dans le fond du décor. */
  scene.fog = new THREE.Fog(voidTones(B).mid, island.radius * 2.2, island.radius * 6.5);

  /* -- Éclats flottants : des dalles isolées au loin, qui ancrent l'échelle.
        Même géométrie que les tuiles jouables. -- */
  const SHARDS = 24;
  if (!crustGeo) crustGeo = makeCrust();
  const shards = new THREE.InstancedMesh(crustGeo, toonMaterial({ vertexColors: true }), SHARDS);
  shards.userData.sharedGeo = true;
  const shardData = [];
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3();
  const UP = new THREE.Vector3(0, 1, 0);
  const tintPool = island.tiles;
  for (let i = 0; i < SHARDS; i++) {
    const a = (i / SHARDS) * Math.PI * 2 + Math.random() * 0.4;
    const r = island.radius + 26 + Math.random() * 90;
    const y = -14 - Math.random() * 55;
    const sc = 0.35 + Math.random() * 1.5;
    shardData.push({ a, r, y, sc, phase: Math.random() * Math.PI * 2, spin: (Math.random() - 0.5) * 0.12 });
    p.set(Math.cos(a) * r, y, Math.sin(a) * r);
    q.setFromAxisAngle(UP, Math.random() * Math.PI * 2);
    s.set(sc, sc, sc);
    m.compose(p, q, s);
    shards.setMatrixAt(i, m);
    shards.setColorAt(i, tintPool[(Math.random() * tintPool.length) | 0].tint
      .clone().lerp(new THREE.Color(0xffffff), 0.45));
  }
  shards.instanceColor.needsUpdate = true;
  scene.add(shards);
  attachCartoonOutline(shards, 0.06);
  created.push(shards);

  /* -- Poussière lumineuse : particules ambiantes dérivant lentement -- */
  const MOTES = 360;
  const pos = new Float32Array(MOTES * 3);
  const seedAttr = new Float32Array(MOTES);
  for (let i = 0; i < MOTES; i++) {
    const a = Math.random() * Math.PI * 2;
    const r = island.radius * (0.2 + Math.random() * 1.0);
    pos[i * 3] = Math.cos(a) * r;
    pos[i * 3 + 1] = -30 + Math.random() * 60;
    pos[i * 3 + 2] = Math.sin(a) * r;
    seedAttr[i] = Math.random();
  }
  const moteGeo = new THREE.BufferGeometry();
  moteGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  moteGeo.setAttribute('aSeed', new THREE.BufferAttribute(seedAttr, 1));
  const moteMat = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uColor: { value: new THREE.Color(B.torchColor || 0xffd9a0) },
    },
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    vertexShader: `
      attribute float aSeed;
      uniform float uTime;
      varying float vA;
      void main() {
        vec3 p = position;
        p.y = mod(p.y + uTime * (0.9 + aSeed * 1.6) + 30.0, 60.0) - 30.0;
        p.x += sin(uTime * 0.4 + aSeed * 6.28) * 1.8;
        p.z += cos(uTime * 0.33 + aSeed * 6.28) * 1.8;
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        gl_PointSize = (1.2 + aSeed * 2.5) * 95.0 / -mv.z;
        gl_Position = projectionMatrix * mv;
        vA = (0.35 + aSeed * 0.4) * smoothstep(30.0, 18.0, abs(p.y));
      }`,
    fragmentShader: `
      uniform vec3 uColor;
      varying float vA;
      void main() {
        float d = length(gl_PointCoord - 0.5);
        if (d > 0.5) discard;
        gl_FragColor = vec4(uColor, vA * (1.0 - d * 2.0));
      }`,
  });
  const motes = new THREE.Points(moteGeo, moteMat);
  motes.frustumCulled = false;
  scene.add(motes);
  created.push(motes);

  /* -- Halo bas : disque lumineux sous l'île -- */
  const haloGeo = new THREE.CircleGeometry(island.radius * 2.2, 48).rotateX(-Math.PI / 2);
  const haloMat = new THREE.MeshBasicMaterial({
    color: new THREE.Color(B.sky).lerp(new THREE.Color(0xffffff), 0.35),
    transparent: true, opacity: 0.18, depthWrite: false, side: THREE.DoubleSide,
  });
  const halo = new THREE.Mesh(haloGeo, haloMat);
  halo.position.y = -46;
  scene.add(halo);
  created.push(halo);

  fx = { shards, shardData, motes, halo };
  return created;
}

/* Animation du vide — à appeler une fois par frame. */
const _vM = new THREE.Matrix4();
const _vQ = new THREE.Quaternion();
const _vS = new THREE.Vector3();
const _vP = new THREE.Vector3();
const _vUP = new THREE.Vector3(0, 1, 0);

export function updateVoid(dt, t) {
  if (!fx) return;
  fx.motes.material.uniforms.uTime.value = t;
  const { shards, shardData } = fx;
  for (let i = 0; i < shardData.length; i++) {
    const d = shardData[i];
    d.a += d.spin * dt * 0.06;
    const bob = Math.sin(t * 0.35 + d.phase) * 2.2;
    _vP.set(Math.cos(d.a) * d.r, d.y + bob, Math.sin(d.a) * d.r);
    _vQ.setFromAxisAngle(_vUP, d.phase + t * d.spin * 0.4);
    _vS.set(d.sc, d.sc, d.sc);
    _vM.compose(_vP, _vQ, _vS);
    shards.setMatrixAt(i, _vM);
  }
  shards.instanceMatrix.needsUpdate = true;
}

export function disposeVoid() { fx = null; }

/* ============================== Placement du décor ============================== */

/* Quel rôle de tuile accueille quel type de prop. */
const ROLE_FOR = {
  house: [ROLE.VILLAGE],
  tree: [ROLE.GROVE, ROLE.PLAIN],
  rock: [ROLE.ROCK, ROLE.GROVE],
  ground: [ROLE.PLAIN, ROLE.GROVE, ROLE.ROCK, ROLE.PLAZA],
  grass: [ROLE.PLAIN, ROLE.GROVE, ROLE.PLAZA],
};

/**
 * Fabrique la fonction de placement passée aux constructeurs de biomes.js.
 * Elle remplace le tirage radial d'origine : chaque prop atterrit sur une
 * tuile dont le rôle l'accepte, en restant à l'écart des arêtes.
 *
 * @returns {(kind: string) => {x, z} | null}   null = instance à masquer
 */
export function makeTilePlacer(island, rng = Math.random) {
  const pools = {};
  for (const kind of Object.keys(ROLE_FOR)) {
    pools[kind] = island.tiles.filter((t) => ROLE_FOR[kind].includes(t.role));
  }
  return function place(kind) {
    const pool = pools[kind] && pools[kind].length ? pools[kind] : island.tiles;
    const t = pool[(rng() * pool.length) | 0];
    /* Marge d'arête : un arbre à cheval sur le vide casserait l'illusion de
       tuiles solides. Les maisons se serrent encore plus vers le centre. */
    const margin = kind === 'house' ? 2.8 : 1.6;
    const a = rng() * Math.PI * 2;
    const rr = Math.sqrt(rng()) * (APOTHEM - margin);
    return { x: t.x + Math.cos(a) * rr, z: t.z + Math.sin(a) * rr, tile: t };
  };
}

/* Centres des tuiles sanctuaire — les Lieux Saints du GDD (§4.3). */
export const sanctuaryTiles = (island) => island.tiles.filter((t) => t.role === ROLE.SANCTUARY);
