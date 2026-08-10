/* ===========================================================================
   Cult.io — Archipel hexagonal procédural
   ---------------------------------------------------------------------------
   Chaque carte est une île suspendue dans le vide, bâtie de tuiles hexagonales
   épaisses (« flat-top ») posées sur une grille axiale. Ciel / props = un biome ;
   le SOL part d'une teinte par tuile, à laquelle un grain procédural lu en
   coordonnées monde ajoute plaques, strates et matière (voir applyGroundDetail).

   Règles de génération (contrat de jeu) :
     • Chaque tuile a un NIVEAU entier ; sa surface est à y = level × STEP_H.
       Une marche d'un niveau se monte en marchant, deux niveaux ou plus
       forment une falaise infranchissable à pied.
     • Le relief est posé librement (bruit seuillé) : c'est ce qui donne de
       vrais massifs à bord franc plutôt qu'une pente douce généralisée.
     • Aucune tuile n'est inatteignable : ensureWalkable creuse ensuite des
       RAMPES. Une seule tuile de rampe par passe et par massif isolé, si bien
       que le plateau garde sa falaise tout autour sauf à l'endroit où le
       chemin monte. Bridier la hauteur pendant la croissance donnerait la même
       garantie mais lisserait tout : plus aucune falaise ne survivrait.
     • La connexité de forme reste vérifiée sur le graphe
       « adjacence ∪ saut » (voir JUMP ci-dessous).
     • Trous intérieurs : fosses d'une tuile (bondissables) + quelques lacs
       de 2–3 tuiles. Toute suppression est validée par isFullyReachable.
       (Les anciens grappes trop larges formaient des murs invisibles.)
=========================================================================== */

import * as THREE from 'three';
import { BIOMES, toonMaterial, attachCartoonOutline, getNatureAsset } from './biomes.js';
import { IS_MOBILE } from './device.js';
import { GROUND_NOISE_GLSL, LIFT_FADE_IN, LIFT_FADE_OUT, applyGroundFollow } from './groundNoise.js';
import { makeGLTFLoader } from './gltf.js';

/* ============================== Géométrie de la grille ============================== */

/* Rayon circonscrit d'une tuile. Choisi pour que le bond au-dessus d'un trou
   d'une tuile (≈ 2 × apothème × 2) reste lisible à l'échelle des fidèles. */
export const HEX_R = 4.1;
const SQ3 = Math.sqrt(3);
const APOTHEM = (SQ3 / 2) * HEX_R;        // centre → milieu d'arête
const CRUST_H = 1.2;                      // Épaisseur de la dalle (tuiles plus minces)

/* ---- Relief ----
   STEP_H est la hauteur d'un niveau. Elle est volontairement inférieure à la
   taille d'un fidèle : une marche doit se lire comme un ressaut de terrain,
   pas comme un mur. MAX_LEVEL borne l'amplitude totale (ici ~3,5 u) pour que
   la caméra de dessus reste lisible et que rien ne masque le jeu.

   CLIMB est le dénivelé franchissable à pied, en niveaux. À 1, une marche
   passe et deux niveaux font falaise — c'est ce seuil qui crée les plateaux
   et les chemins obligés. */
export const STEP_H = 0.95;
const MAX_LEVEL = 4;
const CLIMB = 1;

/* Les PLATEAUX n'occupent que les niveaux PAIRS (0, 2, 4). Deux massifs
   voisins sont donc séparés d'au moins deux marches — c'est-à-dire d'une
   falaise, puisque CLIMB n'en autorise qu'une. Les niveaux impairs sont
   réservés aux tuiles de rampe creusées par ensureWalkable : ce sont les
   seuls points de passage entre deux altitudes.

   Sans cette parité, un seuillage classique donnait des paliers consécutifs
   (Δ = 1 niveau), tous franchissables : du relief, mais pas une seule
   falaise. */
const PLATEAU_STEP = 2;

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

/* Bornes recalées sur HEX_R = 4.1 : l'aire d'un hex vaut (3√3/2)·r², donc
   passer de 6.2 à 4.1 en multiplie le nombre par ~2,3 à surface d'île égale. */
const TILE_MIN = 215;     // ~ un disque de rayon 55
const TILE_MAX = 300;     // ~ un disque de rayon 66

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

  /* Relief : deux octaves lentes pour de larges massifs, puis un SEUILLAGE en
     paliers. Le seuillage est le point important — c'est lui qui produit des
     bords francs, donc des falaises. Un simple arrondi du bruit donnerait une
     pente continue où deux voisins ne diffèrent jamais assez pour faire mur. */
  const reliefAt = (x, z) => {
    const n = noise(x * 0.019 + 300, z * 0.019 + 300) * 0.72
            + noise(x * 0.052 + 700, z * 0.052 + 700) * 0.28;
    /* Biais vers le bas sur la côte : une île qui retombe au niveau de la mer
       sur ses bords se lit mieux qu'un plateau tranché net au-dessus du vide. */
    const coast = Math.min(1, Math.hypot(x, z) / maxR);
    const v = n * 1.25 - coast * 0.45;
    /* Paliers larges, séparés de PLATEAU_STEP niveaux : chaque frontière est
       une falaise tant qu'une rampe n'y a pas été creusée. */
    if (v < 0.32) return 0;
    if (v < 0.62) return PLATEAU_STEP;
    return MAX_LEVEL;
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

    const level = reliefAt(c.x, c.z);

    byKey.set(key(c.q, c.r), {
      q: c.q, r: c.r, x: c.x, z: c.z, d,
      level, h: level * STEP_H,
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

  /* --- 3 bis. Le relief doit rester marchable APRÈS le percement des trous.
         La chaîne de parenté garantissait un chemin montable vers le centre,
         mais punchInteriorHoles peut avoir supprimé un maillon de cette
         chaîne et laisser un plateau ceinturé de falaises. On vérifie donc
         sur la carte finale, et on rabote ce qui reste inaccessible. --- */
  ensureWalkable(byKey);
  /* Puis on ouvre d'autres montées : une seule par massif rendrait le relief
     praticable sur le papier et pénible à jouer. Un dernier passage de
     ensureWalkable vérifie que ces creusements n'ont rien isolé au passage. */
  openMoreRamps(byKey, rng);
  ensureWalkable(byKey);

  const tiles = [...byKey.values()];
  const radius = tiles.reduce((m, t) => Math.max(m, t.d), 0);

  /* --- 4. Bordures et liens de saut (précalculés une fois pour toutes). --- */
  const jumps = [];
  for (const t of tiles) {
    t.open = 0;         // masque de bits : arêtes donnant sur le vide
    t.jump = 0;         // masque de bits : arêtes franchissables d'un bond
    t.clip = 0;         // arêtes à reculer visuellement (trous intérieurs seulement)
    t.wall = 0;         // masque de bits : falaises (voisin solide, trop haut)
    t.drop = 0;         // masque de bits : falaises vers le BAS (saut possible)
    for (let i = 0; i < 6; i++) {
      const [dq, dr] = DIRS[i];
      const nb = byKey.get(key(t.q + dq, t.r + dr));
      if (nb) {
        /* Voisin solide : marche ou falaise. Le mur est symétrique — on ne
           descend pas une falaise en marchant, sinon un creux entouré de
           falaises deviendrait un piège dont plus rien ne ressort. La descente
           reste possible d'un bond (t.drop), qui est un choix du joueur. */
        const dl = nb.level - t.level;
        if (Math.abs(dl) > CLIMB) {
          t.wall |= 1 << i;
          if (dl < 0) t.drop |= 1 << i;
        }
        continue;
      }
      t.open |= 1 << i;
      t.edge = true;
      const far = byKey.get(key(t.q + dq * 2, t.r + dr * 2));
      /* Un bond passe un trou d'une tuile, pas une muraille : la dalle
         d'arrivée doit rester à portée de l'arc (JUMP_H). */
      if (far && far.level - t.level <= CLIMB + 1) {
        t.jump |= 1 << i;
        t.clip |= 1 << i;
        const dst = axialToWorld(t.q + dq * 2, t.r + dr * 2);
        jumps.push({ from: t, dir: i, x: dst.x, z: dst.z });
      } else if (byKey.has(key(t.q + dq * 2, t.r + dr * 2))) {
        /* Arrivée trop haute : le trou reste un trou, on le creuse visuellement. */
        t.clip |= 1 << i;
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
    /* Lecture de l'altitude : plus c'est haut, plus c'est clair. Vue de
       dessus, l'ombre portée ne suffit pas à distinguer deux plateaux — c'est
       cet éclaircissement qui fait exister le relief à l'écran. Les tuiles de
       rampe sont légèrement réchauffées pour se repérer comme des chemins. */
    c.offsetHSL(0, 0, (t.level / MAX_LEVEL) * 0.13);
    /* Une rampe prend la teinte des chemins du biome. C'est la seule montée
       d'une falaise : si le joueur doit la chercher à l'œil nu, il longe le
       mur et conclut qu'on ne peut pas monter. Elle doit se lire comme un
       sentier, aussi nettement qu'une place de village. */
    if (t.ramp) c.lerp(new THREE.Color(B.pathColor || 0xa87a4a), 0.42);
    t.tint = c;
  }

  /* --- 7. Biais de matière de la tuile. -------------------------------------
     La tuile ne CHOISIT pas sa matière : la découpe entre matières est un
     champ continu, calculé dans le shader en coordonnées monde. Une tuile qui
     porterait un identifiant serait uniforme dès que ses voisines lui
     ressemblent — c'est-à-dire presque partout — et on retomberait sur
     l'aplat par tuile. Le champ, lui, varie À L'INTÉRIEUR d'une tuile : c'est
     ce qui donne des tuiles composées, deux tiers d'une matière et un tiers
     d'une autre, avec une découpe qui continue chez la voisine.

     Ce que la tuile apporte, c'est un BIAIS : de quel côté elle penche.

     AMPLITUDE : il doit rester PETIT devant le champ. Le lissage du biais est
     centré sur les tuiles ; un biais fort redessine donc des régions
     hexagonales et ramène exactement le défaut qu'on corrige. Mesuré : à 0,66
     d'amplitude les plaques épousaient les hexagones, à 0,22 le champ garde la
     main sur la forme.

     Le relief le pilote : une hauteur est balayée par le vent, donc plus sèche
     et plus grossière que le fond d'une cuvette — le sol raconte alors quelque
     chose de la carte au lieu de la décorer. Une part de bruit lent s'y ajoute
     pour que deux plateaux de même altitude ne soient pas jumeaux. */
  for (const t of tiles) {
    const n = noise(t.x * 0.033 + 900, t.z * 0.033 + 900);
    let b = (t.level / MAX_LEVEL) * 0.12 + (n - 0.5) * 0.10;
    /* Les repères de jeu tirent vers la matière la plus neutre : une place ou
       un sanctuaire doit rester lisible comme tel, pas se fondre dans l'herbe
       sèche. */
    if (t.role === ROLE.PLAZA || t.role === ROLE.SANCTUARY) b -= 0.14;
    t.matBias = b;
  }

  return { tiles, byKey, radius, seed, jumps, biomeKey };
}

/* Ensemble des tuiles joignables À PIED depuis la plus centrale : uniquement
   des voisins à CLIMB niveaux au plus.

   Volontairement, le bond par-dessus un trou ne compte PAS. Il rendrait la
   plupart des massifs « atteignables » sans creuser la moindre rampe, mais
   l'accès dépendrait alors d'un trou tombé au bon endroit, abordé avec assez
   d'élan — et la foule, qui ne cherche jamais à sauter, resterait en bas. Le
   saut doit rester un raccourci, jamais l'unique chemin. */
function walkableSet(byKey, extraSeeds = null) {
  const tiles = [...byKey.values()];
  if (!tiles.length) return new Set();
  let start = tiles[0];
  for (const t of tiles) if (t.d < start.d) start = t;

  const seen = new Set([key(start.q, start.r)]);
  const stack = [start];
  /* Points d'entrée supplémentaires : tuiles dont on a validé qu'un bond y
     mène (îlots au milieu d'une fosse). Le marcheur repart d'elles comme s'il
     venait d'atterrir. */
  if (extraSeeds) {
    for (const t of extraSeeds) {
      const k = key(t.q, t.r);
      if (!seen.has(k)) { seen.add(k); stack.push(t); }
    }
  }
  while (stack.length) {
    const t = stack.pop();
    for (const [dq, dr] of DIRS) {
      const nb = byKey.get(key(t.q + dq, t.r + dr));
      if (!nb || Math.abs(nb.level - t.level) > CLIMB) continue;
      const k = key(nb.q, nb.r);
      if (!seen.has(k)) { seen.add(k); stack.push(nb); }
    }
  }
  return seen;
}

/* Creuse des rampes jusqu'à ce que TOUTE tuile soit atteignable à pied.

   Le point délicat : il ne faut pas raboter tout le pourtour d'un massif, ce
   qui le transformerait en colline en pente douce et supprimerait justement
   les falaises qu'on cherche. On ne touche donc qu'UNE tuile par passe et par
   massif isolé — celle dont la marche vers le monde atteignable est la plus
   petite. Passe après passe, cette unique tuile devient atteignable, la
   suivante s'appuie dessus, et il se creuse un escalier étroit dans le flanc.
   Le reste du rebord garde sa falaise.

   Termine forcément : chaque passe rend au moins une tuile atteignable par
   massif, donc au plus une passe par tuile. */
function ensureWalkable(byKey) {
  const limit = byKey.size + 4;
  const jumpSeeds = new Set();
  for (let pass = 0; pass < limit; pass++) {
    const tiles = [...byKey.values()];
    if (!tiles.length) return;
    const seen = walkableSet(byKey, jumpSeeds);
    const orphans = tiles.filter((t) => !seen.has(key(t.q, t.r)));
    if (!orphans.length) return;

    /* Massifs isolés = composantes connexes des orphelins (adjacence seule,
       la hauteur ne compte pas ici : on veut le morceau de terrain). */
    const done = new Set();
    for (const seed of orphans) {
      const sk = key(seed.q, seed.r);
      if (done.has(sk)) continue;

      const comp = [];
      const stack = [seed];
      done.add(sk);
      while (stack.length) {
        const t = stack.pop();
        comp.push(t);
        for (const [dq, dr] of DIRS) {
          const nb = byKey.get(key(t.q + dq, t.r + dr));
          if (!nb) continue;
          const k = key(nb.q, nb.r);
          if (done.has(k) || seen.has(k)) continue;
          done.add(k);
          stack.push(nb);
        }
      }

      /* Meilleur point d'accroche du massif : la plus petite marche à combler. */
      let bestTile = null, bestNb = null, bestGap = Infinity;
      for (const t of comp) {
        for (const [dq, dr] of DIRS) {
          const nb = byKey.get(key(t.q + dq, t.r + dr));
          if (!nb || !seen.has(key(nb.q, nb.r))) continue;
          const gap = Math.abs(nb.level - t.level);
          if (gap < bestGap) { bestGap = gap; bestTile = t; bestNb = nb; }
        }
      }
      if (bestTile) {
        /* La tuile de rampe descend juste assez pour être montable depuis le
           voisin atteignable — pas jusqu'à son niveau : on veut une marche,
           pas un aplanissement. */
        const dir = Math.sign(bestTile.level - bestNb.level) || 1;
        bestTile.level = bestNb.level + dir * CLIMB;
        bestTile.h = bestTile.level * STEP_H;
        bestTile.ramp = true;
        continue;
      }

      /* Aucun contact solide : ce morceau n'est rattaché à l'île que par un
         bond par-dessus un trou (îlot au milieu d'une fosse). C'est voulu par
         la silhouette — on ne peut donc pas y creuser de rampe, mais on doit
         garantir que le bond arrive : on abaisse la tuile d'arrivée jusqu'à
         portée de l'arc. */
      for (const t of comp) {
        let fixed = false;
        for (let i = 0; i < 6 && !fixed; i++) {
          const [dq, dr] = DIRS[i];
          if (byKey.has(key(t.q + dq, t.r + dr))) continue;
          const far = byKey.get(key(t.q + dq * 2, t.r + dr * 2));
          if (!far || !seen.has(key(far.q, far.r))) continue;
          if (t.level - far.level > CLIMB + 1) {
            t.level = far.level + CLIMB + 1;
            t.h = t.level * STEP_H;
          }
          t.jumpOnly = true;
          jumpSeeds.add(t);
          fixed = true;
        }
        if (fixed) break;
      }
    }
  }
}

/* Ouvre des montées SUPPLÉMENTAIRES le long des falaises.

   ensureWalkable garantit qu'un chemin existe, mais un seul par massif : la
   carte devient alors une suite de murs qu'on longe sans jamais pouvoir
   monter, ce qui se joue très mal. On sème donc des rampes le long de chaque
   falaise, espacées d'au moins RAMP_GAP, pour qu'une montée soit toujours en
   vue. La falaise reste l'obstacle qui dessine les trajets — elle cesse
   d'être une frontière étanche. */
const RAMP_GAP = 13;

function openMoreRamps(byKey, rng) {
  const tiles = [...byKey.values()];

  /* Candidats : toute tuile dominant un voisin d'au moins deux niveaux.
     On les mélange pour que les rampes ne s'alignent pas toujours du même
     côté des massifs. */
  const cands = [];
  for (const t of tiles) {
    for (const [dq, dr] of DIRS) {
      const nb = byKey.get(key(t.q + dq, t.r + dr));
      if (nb && t.level - nb.level > CLIMB) { cands.push({ t, nb }); break; }
    }
  }
  shuffleInPlace(cands, rng);

  const placed = tiles.filter((t) => t.ramp);
  for (const { t, nb } of cands) {
    if (t.ramp) continue;
    let tooClose = false;
    for (const p of placed) {
      if (Math.hypot(p.x - t.x, p.z - t.z) < RAMP_GAP) { tooClose = true; break; }
    }
    if (tooClose) continue;
    t.level = nb.level + CLIMB;
    t.h = t.level * STEP_H;
    t.ramp = true;
    placed.push(t);
  }
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

/** Peut-on aller de (x0,z0) à (x1,z1) à pied — sol présent ET dénivelé montable ?
 *  `isSolid` seul ne suffit plus : le sommet d'une falaise est parfaitement
 *  solide, il est juste inaccessible d'en bas. Tout le guidage (steerOnIsland,
 *  score d'approche, test de chemin) doit passer par ici, sinon les bots
 *  poussent contre les plateaux et ne s'en sortent que par l'anti-blocage. */
export function canStep(island, x0, z0, x1, z1) {
  const to = tileAt(island, x1, z1);
  if (!to) return false;
  const from = tileAt(island, x0, z0);
  if (!from || from === to) return true;
  return Math.abs((to.level || 0) - (from.level || 0)) <= CLIMB;
}

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
/* Se jeter d'une falaise doit être un geste franc. Au seuil du bond ordinaire
   (0.35, quasi nul face à une vitesse de ~9), le moindre frôlement du bord
   précipitait dans le vide et on ne pouvait plus longer un plateau. */
const DROP_PUSH = 3.0;
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
  const wall = tile.wall || 0;
  for (let i = 0; i < 6; i++) {
    const [nx, nz] = NORMALS[i];
    const proj = (x - tile.x) * nx + (z - tile.z) * nz;
    /* Une falaise se comporte comme une côte : on s'arrête au bord.
       Surtout pas la limite large des arêtes ouvertes vers un voisin — c'est
       elle qui autorise le chevauchement d'une tuile à l'autre, et elle ferait
       traverser la falaise. */
    const blocked = ((open | wall) & (1 << i)) !== 0;
    const lim = blocked ? (APOTHEM - EDGE_MARGIN + extraMargin) : (APOTHEM + 1.2 + extraMargin);
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
    /* L'arc se plaque sur la pente départ→arrivée : sauter vers une dalle
       plus basse doit se voir comme une chute, pas comme un bond à plat. */
    const y0 = e.jmp.y0 || 0, y1 = e.jmp.y1 || 0;
    e.y = y0 + (y1 - y0) * u + Math.sin(k * Math.PI) * JUMP_H;
    if (k >= 1) {
      e.x = e.jmp.x1;
      e.z = e.jmp.z1;
      e.y = y1;
      e.jmp = null;
      // Atterrissage : ancrer le point sûr sur la dalle d'arrivée
      if (containingTile(island, e.x, e.z)) {
        e._safeX = e.x; e._safeZ = e.z;
      }
      return false;
    }
    return true;
  }

  const inside = containingTile(island, e.x, e.z);
  if (inside) {
    /* Suivi du sol : on glisse vers la hauteur de la tuile au lieu d'y sauter
       d'un coup. Une marche se franchit alors en montant visiblement, et un
       passage de tuile à tuile au même niveau ne coûte rien. */
    const target = inside.h || 0;
    e.y = (e.y || 0) + (target - (e.y || 0)) * Math.min(1, dt * 14);
    if (Math.abs(target - e.y) < 0.02) e.y = target;

    e._safeX = e.x; e._safeZ = e.z;
    if (allowJump) {
      const near = APOTHEM - 0.5;
      for (let i = 0; i < 6; i++) {
        const [nx, nz] = NORMALS[i];
        const proj = (e.x - inside.x) * nx + (e.z - inside.z) * nz;
        if (proj <= near) continue;
        if ((vx * nx + vz * nz) <= JUMP_PUSH) continue;

        const [dq, dr] = DIRS[i];
        const nb = island.byKey.get(key(inside.q + dq, inside.r + dr));
        if (nb) {
          /* Saut de falaise : on ne descend en marchant nulle part, mais on
             peut toujours se jeter en contrebas. C'est le raccourci qui rend
             les plateaux intéressants plutôt que pénibles. */
          if (!((inside.drop || 0) & (1 << i))) continue;
          if ((vx * nx + vz * nz) <= DROP_PUSH) continue;
          e.jmp = { t: 0, x0: e.x, z0: e.z, x1: nb.x, z1: nb.z, y0: e.y, y1: nb.h || 0 };
          return true;
        }
        /* Sinon : bond par-dessus un trou d'une tuile. */
        const far = island.byKey.get(key(inside.q + dq * 2, inside.r + dr * 2));
        if (!far || !((inside.jump || 0) & (1 << i))) continue;
        e.jmp = { t: 0, x0: e.x, z0: e.z, x1: far.x, z1: far.z, y0: e.y, y1: far.h || 0 };
        return true;
      }
    }
    return false;
  }
  /* Hors dalle : on garde la dernière hauteur connue le temps d'être recollé
     au sol juste en dessous. */

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
    const [nx, nz] = NORMALS[i];
    const proj = (x - inside.x) * nx + (z - inside.z) * nz;
    if (proj <= near) continue;
    if ((wx * nx + wz * nz) <= JUMP_PUSH) continue;
    const [dq, dr] = DIRS[i];
    if (island.byKey.has(key(inside.q + dq, inside.r + dr))) {
      /* Voisin solide : seul un saut de falaise vers le bas est disponible. */
      if ((inside.drop || 0) & (1 << i)) return true;
      continue;
    }
    if ((inside.jump || 0) & (1 << i)) return true;
  }
  return false;
}

/** Hauteur du sol sous (x,z) — 0 si le point est dans le vide.
 *  Tout ce qui se pose sur la carte (autels, props, bases, effets) doit passer
 *  par ici, sinon l'objet flotte ou s'enterre dès que la tuile n'est pas au
 *  niveau 0. */
export function groundHeightAt(island, x, z) {
  const t = containingTile(island, x, z) || tileAt(island, x, z);
  return t ? (t.h || 0) : 0;
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

  /* Dessus subdivisé.
     Un éventail de 6 triangles (centre + 6 coins) suffisait tant que la surface
     était plate. Pour lui donner du volume il faut des sommets à déplacer : on
     découpe chaque secteur en une grille barycentrique de TOP_SUB² triangles.
     96 triangles par tuile, ~21 k pour une île entière — négligeable, et c'est
     ce qui permet au relief du shader d'exister vraiment.

     Les sommets sont dupliqués le long des arêtes entre secteurs. Sans
     conséquence : le déplacement ne dépend que de la position monde, donc deux
     sommets confondus reçoivent exactement la même hauteur et restent soudés. */
  const TOP_SUB = 8;
  /* Enroulement CCW vu depuis +Y pour que Face avant = dessus marchable. */
  for (let i = 0; i < 6; i++) {
    const [ax, az] = corner[i];
    const [bx, bz] = corner[(i + 1) % 6];
    // grille du secteur : p(u,v) = centre + u·(A−centre)/N + v·(B−centre)/N
    const grid = [];
    for (let u = 0; u <= TOP_SUB; u++) {
      grid[u] = [];
      for (let v = 0; v + u <= TOP_SUB; v++) {
        const x = (ax * u + bx * v) / TOP_SUB;
        const z = (az * u + bz * v) / TOP_SUB;
        grid[u][v] = push(x, 0, z, topCol(x, z));
      }
    }
    for (let u = 0; u < TOP_SUB; u++) {
      for (let v = 0; u + v < TOP_SUB; v++) {
        indices.push(grid[u][v], grid[u][v + 1], grid[u + 1][v]);
        if (u + v + 1 < TOP_SUB) {
          indices.push(grid[u + 1][v], grid[u][v + 1], grid[u + 1][v + 1]);
        }
      }
    }
  }

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

/* Varyings du shader de sol. Le champ de hauteur lui-meme vit dans
   groundNoise.js : il est partage avec le decor, qui doit se decaler
   d'exactement la meme quantite. */
const GROUND_VARYINGS = /* glsl */`
  varying vec3 vGroundPos;
  varying float vGroundUp;
  varying float vGroundFade;
  /* Position DANS la tuile (hexagone centré sur l'origine), et le BIAIS de
     matière de la tuile puis de ses six voisines. Voir GROUND_WANG_GLSL. */
  varying vec2 vTileLocal;
  varying float vMatSelf;
  varying vec3 vMatNbA;
  varying vec3 vMatNbB;
`;

/* ---------------------------------------------------------------------------
   Pavage à raccords — la matière traverse les tuiles
   ---------------------------------------------------------------------------
   Chaque tuile porte UNE matière (sable fin, sable grossier, herbe sèche…).
   Près d'une arête, elle se fond vers celle de sa voisine : une plaque d'herbe
   sèche s'étend donc sur plusieurs tuiles au lieu de s'arrêter net au bord, et
   la grille hexagonale cesse d'être la limite du dessin.

   LE PROBLÈME DES COINS, et pourquoi les poids ne sont pas par arête.
   La méthode évidente — un poids par arête, croissant vers le bord — se casse
   là où TROIS tuiles se touchent. Au coin, la tuile A voit ses voisines B et C
   et rend ½B + ½C ; la tuile B, au même point, voit A et C et rend ½A + ½C.
   Les deux ne s'accordent pas, et une étoile apparaît à chaque sommet.

   D'où une PARTITION DE L'UNITÉ par distance aux CENTRES : le poids d'une
   tuile en un point ne dépend que de la distance de ce point à son centre.
   C'est une fonction de la position seule, donc toutes les tuiles qui couvrent
   ce point calculent les mêmes poids — l'accord est garanti par construction,
   aux arêtes comme aux coins, sans cas particulier.

   Le rayon de support vaut 5.2 : assez pour englober les coins de la tuile
   (à 4.1) et donc mélanger les trois matières qui s'y rencontrent, trop peu
   pour atteindre une deuxième couronne (le point d'arête le plus proche d'une
   tuile de coin est à 6.15). Il ne contribue donc JAMAIS plus de trois tuiles,
   ce qui borne le mélange sans avoir à le tronquer.
--------------------------------------------------------------------------- */
const MAT_SUPPORT_R = 5.2;

const GROUND_WANG_GLSL = /* glsl */`
  /* Poids d'une tuile dont le centre est à d du point. Nul au-delà du
     support, donc une tuile lointaine ne pèse rien et n'a pas à être connue. */
  float gTileW(vec2 d) {
    float t = max(0.0, 1.0 - dot(d, d) / ${(MAT_SUPPORT_R * MAT_SUPPORT_R).toFixed(2)});
    return t * t;
  }
`;

/* Allongement de la jupe, en shader plutôt que par l'échelle d'instance.
   La dalle est modélisée entre y = -CRUST_H et y = 0 ; sous une tuile haute il
   faut descendre sa base jusqu'au plancher commun. Le faire avec une échelle Y
   d'instance était le plus court, mais ça étirait TOUT le maillage : le dessus
   restait à y = 0 par construction, mais le moindre relief sculpté au-dessus ou
   en dessous se serait retrouvé multiplié par la hauteur de la tuile (jusqu'à
   ×4 sur un plateau). Impossible d'y modeler quoi que ce soit.
   Ici seuls les sommets sous y = 0 bougent, donc le dessus et le haut du flanc
   restent rigides et sculptables. aSkirt = (h + CRUST_H) / CRUST_H. */
const SKIRT_ATTR_GLSL = /* glsl */`
  #ifdef USE_INSTANCING
    attribute float aSkirt;
  #endif
`;
const MAT_ATTR_GLSL = /* glsl */`
  #ifdef USE_INSTANCING
    attribute float aMatSelf;   // biais de matière de la tuile
    attribute vec3 aMatNbA;     // biais des voisines 0,1,2
    attribute vec3 aMatNbB;     // biais des voisines 3,4,5
  #endif
`;
const SKIRT_STRETCH_GLSL = /* glsl */`
  #ifdef USE_INSTANCING
    if (transformed.y < -1e-4) transformed.y *= aSkirt;
  #endif
`;


/* ---------------------------------------------------------------------------
   Texture de matière du sol (scripts/build-ground-textures.mjs)
   ---------------------------------------------------------------------------
   Le sol n'avait que du bruit à l'échelle du paysage (12 et 2,5 unités) : ça
   vallonne, ça ne texture pas. La signature du MATÉRIAU — ride de sable, fibre
   d'herbe, fracture de roche — arrive par cette texture-ci, une par biome.

   Encodage (voir le script) : R,G = gradient de hauteur, B = albédo, A = cavité.
   Ce n'est PAS une image de couleur, c'est de la donnée : elle se lit en
   NoColorSpace. Un décodage sRGB tordrait le gradient et l'ombrage partirait
   de travers, d'une manière difficile à attribuer.

   Le pixel neutre est (0,128,0,255) : aucun trait, albédo au repos, aucune
   marque. C'est la texture par défaut des biomes qui n'en ont pas encore —
   elle traverse le shader sans rien changer, ce qui évite d'avoir deux
   variantes de programme à maintenir. Attention, la valeur neutre n'est PAS
   128 sur les trois canaux : le trait et le masque sont des couvertures, leur
   repos est zéro. Un gris moyen y poserait un demi-trait et une demi-marque
   sur toute la carte.
--------------------------------------------------------------------------- */
const GROUND_TEX_DIR = 'assets/ground/';
const _groundTexCache = new Map();
let _neutralGroundTex = null;

function neutralGroundTex() {
  if (_neutralGroundTex) return _neutralGroundTex;
  const t = new THREE.DataTexture(new Uint8Array([0, 128, 0, 255]), 1, 1);
  t.needsUpdate = true;
  _neutralGroundTex = t;
  return t;
}

function getGroundTexture(name) {
  if (!name) return neutralGroundTex();
  let t = _groundTexCache.get(name);
  if (t) return t;
  t = new THREE.TextureLoader().load(GROUND_TEX_DIR + name + '.webp');
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  /* Donnée, pas couleur : surtout pas de conversion sRGB (voir ci-dessus). */
  t.colorSpace = THREE.NoColorSpace;
  t.anisotropy = 4;
  _groundTexCache.set(name, t);
  return t;
}

/**
 * Greffe le grain procédural sur un matériau toon à vertex colors.
 * @param {THREE.Material} mat
 * @param {boolean} cheap — sans perturbation de normale (tactile).
 */
function applyGroundDetail(mat, cheap) {
  mat.customProgramCacheKey = () => 'ground-detail-' + (cheap ? 'cheap' : 'full');
  /* Uniformes partagés avec le matériau : c'est par eux que le biome change de
     matière sans recompiler le programme. onBeforeCompile est rejoué à chaque
     recompilation, on garde donc les MÊMES objets uniforme d'un appel à
     l'autre — sinon setGroundMaterial écrirait dans un objet orphelin. */
  const u = mat.userData.groundUniforms || (mat.userData.groundUniforms = {
    /* Trois matières au plus : c'est aussi le nombre maximum qui peut se
       rencontrer en un point (au coin de trois tuiles), et la limite de
       l'empaquetage à 2 bits par arête. Les emplacements inutilisés pointent
       sur la texture neutre. */
    uMatTex0: { value: neutralGroundTex() },
    uMatTex1: { value: neutralGroundTex() },
    uMatTex2: { value: neutralGroundTex() },
    uMatCol0: { value: new THREE.Color(1, 1, 1) },
    uMatCol1: { value: new THREE.Color(1, 1, 1) },
    uMatCol2: { value: new THREE.Color(1, 1, 1) },
    uMatMark0: { value: new THREE.Color(1, 1, 1) },
    uMatMark1: { value: new THREE.Color(1, 1, 1) },
    uMatMark2: { value: new THREE.Color(1, 1, 1) },
    /* Taille, en unités monde, d'une répétition de la texture. 6.4 pour une
       tuile large de 8.2 : la matière est nettement plus fine que la tuile,
       donc la répétition ne s'aligne pas sur la grille hexagonale. */
    uGroundTexScale: { value: 1 / 6.4 },
    /* x = force de l'ombrage, y = force de l'albédo, z = force de la cavité.
       Tout à zéro sur la texture neutre : un biome sans matière traverse le
       shader sans rien payer d'autre qu'un échantillonnage. */
    uGroundTexAmt: { value: new THREE.Vector3(0, 0, 0) },
    uMatSharp: { value: 2.4 },
    uMatWobble: { value: 2.6 },
    uMatFieldFreq: { value: 0.045 },
    uMatEdge: { value: 0.07 },
  });
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, u);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${GROUND_VARYINGS}\n${SKIRT_ATTR_GLSL}\n${MAT_ATTR_GLSL}\n${GROUND_NOISE_GLSL}`)
      /* Déplacement des sommets du dessus — le « léger volume » du sol.
         Greffé sur begin_vertex, donc AVANT project_vertex qui calcule
         gl_Position : déplacer plus tard n'aurait aucun effet à l'écran.

         Désactivé sur tactile (`cheap`), et ce n'est pas qu'une économie : le
         pourtour restant plat, le relief ne modifie aucune silhouette et ne se
         voit QUE par la perturbation de normale — elle-même coupée sur mobile.
         On y paierait donc des sommets pour un effet strictement invisible.

         L'échelle d'instance est désormais l'identité — l'allongement de la
         jupe passe par SKIRT_STRETCH_GLSL, appliqué juste au-dessus et qui ne
         touche que les sommets sous y = 0. Le déplacement n'a donc plus à être
         divisé par quoi que ce soit : il porte sur des sommets à échelle 1.
         Reste l'extinction au bord, pour garder un pourtour rigoureusement
         plat et l'emboîtement des tuiles voisines. */
      .replace('#include <begin_vertex>', `#include <begin_vertex>
      ${SKIRT_STRETCH_GLSL}
      vGroundFade = 0.0;
      ${cheap ? '#if 0' : '#if 1'}
      if (normal.y > 0.5) {
        #ifdef USE_INSTANCING
          vec3 gWorld = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;
        #else
          vec3 gWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;
        #endif
        vGroundFade = 1.0 - smoothstep(${LIFT_FADE_IN.toFixed(2)}, ${LIFT_FADE_OUT.toFixed(2)}, length(transformed.xz));
        transformed.y += gLift(gWorld.xz) * vGroundFade;
      }
      #endif
      `)
      /* La position monde doit passer par instanceMatrix : sans elle, les 200
         tuiles liraient le bruit au même endroit et retomberaient identiques.
         Relue ici, après déplacement : la teinte suit ainsi la géométrie. */
      .replace('#include <fog_vertex>', `#include <fog_vertex>
      #ifdef USE_INSTANCING
        vGroundPos = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;
      #else
        vGroundPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
      #endif
      vGroundUp = normal.y;
      /* Coordonnée DANS la tuile, prise avant instanceMatrix : c'est elle qui
         situe le fragment par rapport aux centres voisins. Les instances ne
         subissent qu'une translation (rotation identité, échelle 1 depuis que
         la jupe s'allonge en shader), donc le repère local est aligné sur le
         monde et les décalages de voisines sont des constantes. */
      vTileLocal = position.xz;
      #ifdef USE_INSTANCING
        vMatSelf = aMatSelf;
        vMatNbA = aMatNbA;
        vMatNbB = aMatNbB;
      #else
        vMatSelf = 0.0; vMatNbA = vec3(0.0); vMatNbB = vec3(0.0);
      #endif
      `);

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
${GROUND_VARYINGS}
${GROUND_NOISE_GLSL}
${GROUND_WANG_GLSL}
      uniform sampler2D uMatTex0;
      uniform sampler2D uMatTex1;
      uniform sampler2D uMatTex2;
      uniform vec3 uMatCol0;
      uniform vec3 uMatCol1;
      uniform vec3 uMatCol2;
      /* Couleur des MARQUES d'une matière — les touffes vertes sur du sable.
         Sans ce second ton, une marque ne peut être que son fond en plus clair
         ou plus sombre, et le sol reste monochrome quoi qu'on dessine. */
      uniform vec3 uMatMark0;
      uniform vec3 uMatMark1;
      uniform vec3 uMatMark2;
      uniform float uGroundTexScale;
      uniform vec3 uGroundTexAmt;
      /* Netteté du raccord : 1 = fondu large et doux, 4 = frontière franche.
         C'est le seul réglage de « dessin » du pavage, celui qui décide si une
         plaque d'herbe sèche a un bord net ou s'étale. */
      uniform float uMatSharp;
      /* Amplitude de la déformation de frontière, en unités monde. Au-delà de
         l'apothème (3,55) une tuile peut cesser de porter sa propre matière au
         centre : la matière ne se lirait plus comme attachée à la tuile. */
      uniform float uMatWobble;
      /* Fréquence du champ de matière, en 1/unités monde. 0.045 ≈ une région
         tous les 22 unités, soit environ trois tuiles : assez grand pour que
         la région se lise, assez petit pour qu'une tuile en voie deux. */
      uniform float uMatFieldFreq;
      /* Demi-largeur du fondu entre matières : 0.02 = lisière nette,
         0.20 = dégradé large. */
      uniform float uMatEdge;

      /* Décalages des six centres voisins, en repère de tuile. Ce sont les
         mêmes que NORMALS × 2 × apothème côté JS ; ils sont constants parce
         que les instances ne subissent qu'une translation. */
      const vec2 GNB0 = vec2( ${(NORMALS[0][0] * 2 * APOTHEM).toFixed(4)}, ${(NORMALS[0][1] * 2 * APOTHEM).toFixed(4)});
      const vec2 GNB1 = vec2( ${(NORMALS[1][0] * 2 * APOTHEM).toFixed(4)}, ${(NORMALS[1][1] * 2 * APOTHEM).toFixed(4)});
      const vec2 GNB2 = vec2( ${(NORMALS[2][0] * 2 * APOTHEM).toFixed(4)}, ${(NORMALS[2][1] * 2 * APOTHEM).toFixed(4)});
      const vec2 GNB3 = vec2( ${(NORMALS[3][0] * 2 * APOTHEM).toFixed(4)}, ${(NORMALS[3][1] * 2 * APOTHEM).toFixed(4)});
      const vec2 GNB4 = vec2( ${(NORMALS[4][0] * 2 * APOTHEM).toFixed(4)}, ${(NORMALS[4][1] * 2 * APOTHEM).toFixed(4)});
      const vec2 GNB5 = vec2( ${(NORMALS[5][0] * 2 * APOTHEM).toFixed(4)}, ${(NORMALS[5][1] * 2 * APOTHEM).toFixed(4)});

      /* Lecture d'une matière, en coordonnées MONDE.
         Sur l'UV du modèle, les ~215 tuiles partagent une géométrie instanciée :
         le motif se répéterait à l'identique sur chaque hexagone et la grille
         sauterait aux yeux. En monde, la texture ignore le découpage.
         Canaux (voir le script de cuisson) :
           R = trait d'encre, 0 sur les aplats, 1 sur un contour
           G = albédo, écart signé centré sur 0,5
           B = masque de marque, 0 sur le fond, 1 sur une touffe
         Aucune donnée dans l'alpha : le WebP efface le RGB sous les pixels
         transparents, y compris en sans-perte. */
      vec4 gTex(sampler2D t, vec2 w) { return texture2D(t, w * uGroundTexScale); }`);

    /* Volontairement, AUCUNE perturbation de la normale d'éclairage.
       Une version précédente inclinait la normale avec un gain de 34, en pensant
       compenser une pente trop faible. Effet inverse : la normale devenait quasi
       horizontale dès qu'il y avait la moindre pente, et le dégradé toon — 4 crans
       seulement — renvoyait alors le MÊME cran sombre quelle que soit
       l'orientation. On perdait exactement ce qui fait lire un volume : le côté
       éclairé et le côté à l'ombre d'une même bosse. D'où des taches plates.

       Un dégradé à 4 crans est un mauvais support pour un relief subtil : ou bien
       rien ne bouge, ou bien une tache à bord dur apparaît. Le modelé est donc
       porté par l'albédo, dans le bloc ci-dessous, où la réponse est continue et
       ne peut pas saturer. */

    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <color_fragment>',
      `#include <color_fragment>
      {
        /* OMBRAGE DIRECTIONNEL (hillshade) — c'est lui qui fait voir le volume.

           Une bosse ne se lit pas parce qu'elle est claire ou sombre, mais parce
           qu'elle a un côté FACE au soleil et un côté à l'ombre. C'est ce couple
           qui manquait : les versions précédentes n'assombrissaient les creux
           qu'uniformément, ce que l'œil interprète comme une tache de peinture,
           pas comme une forme. La méthode est celle des cartes en relief, et elle
           fonctionne même vue de la verticale — justement le cas ici.

           La direction doit rester alignée sur le soleil de la scène,
           sun.position = (28, 40, 20) dans main.js. Les deux étant liés par le
           rendu et non par le code, un changement là-bas doit être répercuté ici,
           sans quoi les bosses paraîtront éclairées par la gauche et les ombres
           portées des arbres tomberont vers la droite. */
        /* Hors du bloc conditionnel ci-dessous : la matière de sol s'en sert
           aussi, et elle, elle reste active sur tactile. */
        const vec3 SUN_DIR = normalize(vec3(28.0, 40.0, 20.0));
        float shade = 0.0;
        /* Hauteur brute, en appui : elle creuse légèrement les cuvettes, à la
           manière d'une occlusion ambiante. Dosée bien plus bas que l'ombrage
           directionnel, dont elle n'est qu'un complément. */
        float h = 0.0;
        /* Coupé sur tactile en même temps que le déplacement des sommets : sans
           relief, vGroundFade y vaut zéro et ces quatre évaluations de bruit —
           huit octaves par pixel, sur une surface qui remplit l'écran —
           coûteraient plein tarif pour un résultat identiquement nul. */
        ${cheap ? '#if 0' : '#if 1'}
        float e = 0.45;
        float lx = gLift(vGroundPos.xz + vec2(e, 0.0)) - gLift(vGroundPos.xz - vec2(e, 0.0));
        float lz = gLift(vGroundPos.xz + vec2(0.0, e)) - gLift(vGroundPos.xz - vec2(0.0, e));
        // ×0.5/e : différence centrée → dérivée réelle de la surface
        vec2 slope = vec2(lx, lz) * (0.5 / e) * vGroundFade;
        vec3 nRel = normalize(vec3(-slope.x, 1.0, -slope.y));
        // écart au sol plat : 0 sur une surface horizontale, ± selon l'exposition
        shade = dot(nRel, SUN_DIR) - SUN_DIR.y;
        h = gLiftNorm(vGroundPos.xz) * vGroundFade;
        #endif

        float plaque = gRamp(gFbm(vGroundPos.xz * 0.085));
        float grain  = gNoise(vGroundPos.xz * 2.9);

        /* MATIÈRE. Les deux termes ci-dessus travaillent à 12 et 2,5 unités,
           c'est-à-dire à l'échelle du paysage : ils vallonnent la teinte, ils
           ne donnent pas de matière. Celle-ci arrive ici.

           On la fait entrer par le MÊME hillshade que le relief macro, et pas
           par la normale d'éclairage : voir le bloc ci-dessus, le dégradé toon
           à 4 crans transforme toute perturbation de normale en taches à bord
           dur. Le gradient cuit dans R,G se projette donc sur le soleil et
           module l'albédo, où la réponse est continue.

           uGroundTexAmt vaut zéro sur la texture neutre : les biomes sans
           matière passent ici sans que rien ne change. */
        float texTone = 0.0;
        vec3 matCol = vec3(1.0);
        {
          /* --- Poids des tuiles qui couvrent ce fragment ------------------
             Partition de l'unité par distance aux centres : chaque poids ne
             dépend que de la position, donc la tuile voisine calcule le même
             et le raccord est exact — aux arêtes comme aux coins. */
          /* DÉFORMATION DE LA FRONTIÈRE. Sans elle, le fondu est doux mais la
             région reste découpée à l'hexagone : on voit encore la grille, en
             flou. On déplace donc le point d'évaluation par un bruit lu en
             coordonnées MONDE — et c'est précisément parce qu'il ne dépend que
             du monde que l'accord tient : les deux tuiles voisines subissent
             le même déplacement au même endroit, donc les mêmes poids.
             Résultat : une plaque d'herbe sèche a un contour organique qui ne
             suit plus aucune arête. */
          vec2 wob = vec2(gFbm(vGroundPos.xz * 0.085 + 17.0),
                          gFbm(vGroundPos.xz * 0.085 + 51.0)) - 0.5;
          vec2 lp = vTileLocal + wob * uMatWobble;

          float w[7];
          w[0] = gTileW(lp);
          w[1] = gTileW(lp - GNB0);
          w[2] = gTileW(lp - GNB1);
          w[3] = gTileW(lp - GNB2);
          w[4] = gTileW(lp - GNB3);
          w[5] = gTileW(lp - GNB4);
          w[6] = gTileW(lp - GNB5);

          /* Netteté : élever les poids à une puissance puis renormaliser
             resserre le mélange autour du plus fort, sans jamais rompre
             l'accord — la puissance est une fonction du poids seul, donc les
             deux tuiles la subissent à l'identique. */
          float tot = 0.0;
          for (int i = 0; i < 7; i++) { w[i] = pow(w[i], uMatSharp); tot += w[i]; }
          tot = max(tot, 1e-5);

          /* --- Ce que la partition transporte : un BIAIS, pas une matière ---
             Première version : chaque tuile portait UN identifiant de matière
             et le fondu mordait sur le tiers extérieur. Conséquence, une tuile
             entourée de voisines de même matière était rigoureusement
             uniforme — c'est-à-dire, sur une carte où une matière domine, la
             quasi-totalité de la carte. On retombait sur l'aplat par tuile.

             Ce qu'il faut, c'est une tuile COMPOSÉE : deux tiers d'herbe, un
             tiers de sable, et la découpe qui continue chez la voisine. Ça
             suppose que la frontière soit une courbe libre, donc qu'elle ne
             soit pas un attribut de tuile.

             D'où : la partition mélange un biais continu (exactement comme
             avant, mêmes poids, même garantie d'accord aux coins), et ce biais
             DÉCALE un champ de bruit lu en monde. La frontière vient du bruit
             — libre, traversante, différente à chaque tuile et à chaque arête,
             donc jamais deux configurations identiques sur une carte — et le
             biais décide seulement de quel côté une région penche. */
          float bias = (vMatSelf * w[0]
                      + vMatNbA.x * w[1] + vMatNbA.y * w[2] + vMatNbA.z * w[3]
                      + vMatNbB.x * w[4] + vMatNbB.y * w[5] + vMatNbB.z * w[6]) / tot;

          /* Le champ. gRamp étale le fbm : sans lui il ne s'écarte de 0,5 que
             de ±0,12 et les seuils ci-dessous ne seraient jamais franchis
             franchement — la carte n'aurait qu'une seule matière. */
          float field = gRamp(gFbm(vGroundPos.xz * uMatFieldFreq)) + bias;

          /* Trois matières par seuils fondus. La largeur du fondu est ce qui
             décide si la frontière est une lisière nette ou un dégradé. */
          float e0 = uMatEdge;
          float toB = smoothstep(0.42 - e0, 0.42 + e0, field);
          float toC = smoothstep(0.72 - e0, 0.72 + e0, field);
          vec3 mw;
          mw.x = 1.0 - toB;
          mw.y = toB - toC;
          mw.z = toC;

          /* --- Lecture et mélange -----------------------------------------
             On échantillonne les trois matières et on pondère, plutôt que de
             brancher : un branchement sur une texture donne des dérivées
             fausses au bord du branchement, donc du mipmap qui saute — ça se
             voit comme une ligne scintillante le long des raccords. */
          vec4 t0 = gTex(uMatTex0, vGroundPos.xz);
          vec4 t1 = gTex(uMatTex1, vGroundPos.xz);
          vec4 t2 = gTex(uMatTex2, vGroundPos.xz);

          /* Chaque matière compose SA couleur avant le mélange : le masque de
             marque de l'une ne doit pas teinter les marques d'une autre. */
          matCol = mix(uMatCol0, uMatMark0, t0.b) * mw.x
                 + mix(uMatCol1, uMatMark1, t1.b) * mw.y
                 + mix(uMatCol2, uMatMark2, t2.b) * mw.z;

          float ink = t0.r * mw.x + t1.r * mw.y + t2.r * mw.z;
          float alb = (t0.g * mw.x + t1.g * mw.y + t2.g * mw.z) * 2.0 - 1.0;

          /* Le trait ASSOMBRIT, il n'éclaire jamais : c'est de l'encre. Un
             ombrage directionnel a été essayé ici — il donne du relief
             photographique, pas un dessin, et il jurait avec les contours
             noirs du reste de la scène. */
          texTone = -ink * uGroundTexAmt.x
                  + alb * uGroundTexAmt.y;
        }

        /* Modulations ADDITIVES, pas multiplicatives : des facteurs multipliés
           cumulent leurs extrêmes et cramaient le sol à +46 %. Additionnées,
           l'écart utile reste maîtrisé.
           Centré sur 0,97 et non 1,0 : les palettes de sol sont déjà très
           claires (la prairie part d'un vert vif), et une modulation centrée
           sur 1 poussait les zones hautes jusqu'au délavé. */
        float tone = 0.97
                   + shade * 2.4
                   + h * 0.09
                   + (plaque - 0.5) * 0.12
                   + (grain  - 0.5) * 0.05
                   + texTone;

        if (vGroundUp > 0.5) {
          /* La teinte de matière MULTIPLIE la teinte de tuile au lieu de la
             remplacer. C'est ce qui permet à l'herbe sèche d'être de l'herbe
             sèche sans effacer la légende que porte instanceColor : altitude
             (plus haut = plus clair), rampes teintées en sentier, rôles. Un
             remplacement rendrait deux plateaux indiscernables et ferait
             disparaître les montées. */
          diffuseColor.rgb *= matCol;
          diffuseColor.rgb *= tone;
          /* Les plaques sèches tirent vers le chaud, les creux vers le froid :
             une variation de teinte, pas seulement de valeur — sans ça le sol
             reste monochrome, juste plus ou moins clair. */
          diffuseColor.r *= mix(0.94, 1.09, plaque);
          diffuseColor.g *= mix(1.02, 0.98, plaque);
          diffuseColor.b *= mix(1.10, 0.90, plaque);
        } else {
          /* Flancs de falaise : striures verticales de strates. Elles donnent
             sa hauteur au plateau, qui n'était qu'un bandeau uni. */
          float strat = gRamp(gFbm(vec2((vGroundPos.x + vGroundPos.z) * 0.55,
                                        vGroundPos.y * 1.9)));
          float veins = gRamp(gNoise(vec2((vGroundPos.x - vGroundPos.z) * 1.7,
                                          vGroundPos.y * 0.7)));
          diffuseColor.rgb *= 1.0 + (strat - 0.5) * 0.34 + (veins - 0.5) * 0.12;
        }
      }
      `,
    );
  };
  mat.needsUpdate = true;
  return mat;
}

let _crustMat = null;
let _crustDepthMat = null;
const CRUST_V = 5;

/* La passe d'ombres n'utilise PAS le matériau ci-dessous mais un MeshDepthMaterial
   généré par three.js, qui ignore donc l'étirement de la jupe. Tant qu'il passait
   par l'échelle d'instance, la matrice s'en chargeait pour les deux passes ; en
   shader, il faut le refaire ici, sinon l'ombre d'un plateau s'arrête à 1,2 sous
   son dessus au lieu de descendre au plancher, et la falaise cesse d'ombrer ce
   qu'elle surplombe. Le relief du dessus reste hors de la passe d'ombre : son
   amplitude est trop faible pour se voir dans une ombre portée. */
function getCrustDepthMaterial() {
  if (_crustDepthMat && _crustDepthMat.userData.crustV === CRUST_V) return _crustDepthMat;
  if (_crustDepthMat) { _crustDepthMat.dispose(); _crustDepthMat = null; }
  const mat = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  mat.customProgramCacheKey = () => 'crust-depth-skirt';
  mat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${SKIRT_ATTR_GLSL}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n${SKIRT_STRETCH_GLSL}`);
  };
  mat.userData.crustV = CRUST_V;
  _crustDepthMat = mat;
  return mat;
}

/**
 * Installe la matière de sol du biome sur le matériau de croûte.
 *
 * Passe par des uniformes, pas par une recompilation : changer d'île ne doit
 * pas coûter un nouveau programme GPU (une compilation de shader se voit,
 * c'est une saccade au chargement).
 *
 * `amt` dose séparément les trois canaux cuits — ombrage, albédo, cavité. Ils
 * ne se dosent pas ensemble : l'ombrage porte la forme, l'albédo la matière,
 * la cavité l'usure. Une même valeur pour les trois donne un sol sale.
 */
export function setGroundMaterial(biomeKey) {
  const B = BIOMES[biomeKey] || BIOMES.temperate;
  const mat = getCrustMaterial();
  const u = mat.userData.groundUniforms;
  if (!u) return;
  const g = B.groundMatter;
  const mats = (g && g.mats) || [];
  for (let i = 0; i < 3; i++) {
    const m = mats[i];
    /* Au-delà des matières déclarées, on retombe sur la PREMIÈRE et non sur la
       texture neutre : une tuile dont l'identifiant dépasserait la liste
       resterait ainsi dans la matière du biome, au lieu de devenir un aplat
       nu au milieu du sable. */
    const src = m || mats[0];
    u['uMatTex' + i].value = getGroundTexture(src && src.tex);
    u['uMatCol' + i].value.set(src && src.col !== undefined ? src.col : 0xffffff);
    /* Sans couleur de marque déclarée, la marque prend celle du fond : la
       matière reste alors monochrome, ce qui est le bon défaut pour du sable
       ou de la roche nue. */
    u['uMatMark' + i].value.set(src && src.mark !== undefined ? src.mark : (src && src.col !== undefined ? src.col : 0xffffff));
  }
  u.uGroundTexScale.value = 1 / ((g && g.size) || 6.4);
  u.uMatSharp.value = (g && g.sharp) || 2.4;
  u.uMatWobble.value = (g && g.wobble !== undefined) ? g.wobble : 2.6;
  u.uMatFieldFreq.value = (g && g.fieldFreq) || 0.045;
  u.uMatEdge.value = (g && g.edge !== undefined) ? g.edge : 0.07;
  if (g && g.amt) u.uGroundTexAmt.value.set(g.amt[0], g.amt[1], g.amt[2]);
  else u.uGroundTexAmt.value.set(0, 0, 0);
}

function getCrustMaterial() {
  if (_crustMat && _crustMat.userData.crustV === CRUST_V) return _crustMat;
  if (_crustMat) { _crustMat.dispose(); _crustMat = null; }
  _crustMat = new THREE.MeshToonMaterial({
    gradientMap: getCrustGradient(),
    vertexColors: true,
    color: 0xffffff,
    flatShading: false,
  });
  applyGroundDetail(_crustMat, IS_MOBILE);
  _crustMat.userData.crustV = CRUST_V;
  return _crustMat;
}

/* ------------------------------------------------------------------------
   Dalles sculptées (blender/hex_tile_variants.py)
   ------------------------------------------------------------------------
   makeCrust() reste la référence et le repli : si le modèle n'est pas là, ou
   pas encore arrivé, l'île se construit quand même avec la dalle procédurale.
   Le modèle doit rester interchangeable avec elle — même contour à HEX_R,
   même dessus à y = 0, même anneau bas à -CRUST_H — c'est le script Blender
   qui le vérifie à la génération.

   Chargé une fois pour toutes au démarrage (main.js) et jamais libéré : la
   géométrie est partagée par toutes les îles de la session.
--------------------------------------------------------------------------- */
let tileGeo = null;
let liveCrust = null;

export function loadTileVariant(url) {
  makeGLTFLoader().load(url, (gltf) => {
    let found = null;
    gltf.scene.traverse((o) => { if (!found && o.isMesh) found = o; });
    if (!found) { console.warn('[hexmap] dalle sans maillage :', url); return; }
    const geo = found.geometry;
    if (!geo.attributes.color) {
      /* Sans teintes de sommet, la dalle sortirait d'un blanc uniforme : le
         matériau est en vertexColors, et instanceColor MULTIPLIE cette
         couleur. Mieux vaut garder la dalle procédurale. */
      console.warn('[hexmap] dalle sans attribut color, ignorée :', url);
      return;
    }
    tileGeo = geo;

    /* La carte du menu est bâtie au démarrage, donc avant l'arrivée du modèle.
       On échange la géométrie sous l'InstancedMesh en place plutôt que de
       reconstruire : une reconstruction retirerait la graine du tirage courant
       et redessinerait l'île sous les pieds du joueur. Matrices, teintes et
       matières sont indexés par instance, ils survivent tels quels au
       changement de géométrie — mais les attributs d'INSTANCE vivent sur la
       géométrie et doivent déménager, tous, sinon le shader lit des zéros. */
    if (liveCrust && liveCrust.geometry !== geo) {
      for (const name of ['aSkirt', 'aMatSelf', 'aMatNbA', 'aMatNbB']) {
        const a = liveCrust.geometry.getAttribute(name);
        if (a) geo.setAttribute(name, a);
      }
      liveCrust.geometry = geo;
      liveCrust.computeBoundingSphere();
      if (liveCrust.boundingSphere) liveCrust.boundingSphere.radius += liveCrust.userData.maxDrop || 0;
    }
  }, undefined, (e) => console.warn('[hexmap] dalle non chargée :', url, e));
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
  /* Les falaises reçoivent le même liseré que la côte : c'est ce trait qui
     fait lire un plateau comme un plateau au premier coup d'œil, sans quoi
     deux niveaux voisins se confondent vus de dessus. */
  let nEdges = 0;
  for (const t of island.tiles) {
    const edges = (t.open || 0) | (t.wall || 0);
    for (let i = 0; i < 6; i++) if (edges & (1 << i)) nEdges++;
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
    const edges = (t.open || 0) | (t.wall || 0);
    if (!edges) continue;
    for (let i = 0; i < 6; i++) {
      if (!(edges & (1 << i))) continue;
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
      p.set((x0 + x1) * 0.5, (t.h || 0) + BAR_H * 0.5, (z0 + z1) * 0.5);
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

/* ============================== Escaliers des rampes ==============================
   Une rampe n'était qu'une teinte. `ensureWalkable` et `openMoreRamps` posent
   `t.ramp = true` sur une tuile dont le niveau a été réécrit pour tomber pile
   entre deux plateaux, ce qui la rend franchissable des deux côtés — mais rien ne
   le MONTRAIT, sinon un lerp vers la couleur de chemin. Le joueur devait deviner
   où monter. On y pose donc de vraies volées de marches.

   Purement visuel : la collision ne change pas d'un iota, la rampe était déjà
   marchable. C'est la lecture qui manquait.

   Pourquoi ne pas passer par buildBiomeNature : il sème avec un lacet ALÉATOIRE
   et un décalage aléatoire dans la tuile. Une volée doit au contraire être calée
   sur une arête précise et orientée dans le sens de la pente. On suit donc le
   patron de buildCoastOutline, seul endroit du projet qui pose déjà par arête.
================================================================================ */

/* Gabarit d'une volée, en unités monde. Largeur nettement inférieure à l'arête
   (HEX_R = 4,1) pour lire comme un escalier et non comme un talus. */
const STAIR_W = 3.0;
/* Avancée courte volontairement : 0,95 de montée sur 2,0 d'avancée donnait un
   talus nervuré. À 1,35 la pente atteint ~35°, et les trois marches du modèle se
   lisent comme des marches. */
const STAIR_RUN = 1.35;
/* Le PIED de la volée est enfoncé d'un cheveu. Le sol ondule (voir groundNoise.js)
   et l'atténuation ne l'aplatit qu'au ras du bord : à mi-marche on peut être sur
   une bosse de quelques centimètres. Mieux vaut mordre légèrement dans le terrain
   que flotter au-dessus — une marche encastrée passe inaperçue, une marche en
   l'air non. */
const STAIR_SINK = 0.14;
/* La volée est donc plus HAUTE que la marche qu'elle franchit, d'exactement cet
   enfoncement : le pied descend de STAIR_SINK, la volée en regagne autant, et le
   dessus de la dernière marche retombe pile sur la surface haute.

   Ce calage n'est pas cosmétique. Sans compensation, enfoncer le pied enfonçait
   TOUT l'escalier : mesuré à 0,91 pour une tuile haute à 0,95, soit un
   décrochement franc au sommet. Et compenser DEUX fois faisait au contraire
   ressortir la dernière marche au-dessus du plateau, où elle traînait un liseré
   sur toute la profondeur de l'empiètement.

   L'enfoncement peut être généreux (14 cm) précisément parce qu'il ne touche que
   le pied : celui-ci retombe au milieu de la tuile basse, là où le relief du sol
   n'est pas atténué et ondule de ±0,17 (voir groundNoise.js). Mieux vaut qu'il
   morde dans le terrain que qu'il flotte au-dessus. Le sommet, lui, atterrit sur
   le pourtour, que l'atténuation garde rigoureusement plat — il peut donc affleurer
   au millimètre. */
/* Le retrait d'un demi-centimètre n'est pas du bruit : sur la longueur du
   chevauchement, le dessus de la dernière marche serait sinon EXACTEMENT
   coplanaire avec la surface de la tuile, et deux faces coplanaires scintillent
   dès que la caméra bouge. Sous la tuile, la marche disparaît proprement sous
   elle ; l'écart est trois fois plus fin qu'un cheveu à l'échelle du jeu. */
const STAIR_RISE = STEP_H + STAIR_SINK - 0.005;
/* Recul de la volée depuis l'arête, vers la tuile BASSE. Centrée sur l'arête, elle
   empiétait d'une demi-avancée dans la tuile haute et la traversait. On la décale
   donc de presque toute cette demi-avancée ; il reste un léger chevauchement,
   sans quoi une couture apparaîtrait entre la dernière marche et le plateau. */
const STAIR_BACK = STAIR_RUN * 0.5 - 0.12;

let stairGeoCache = null;   // [{ geo, matName }] pré-mis à l'échelle

/** Géométries de volée prêtes à poser : clonées puis pré-étirées au gabarit.
 *  Pré-étirer la GÉOMÉTRIE plutôt que l'instance permet une échelle d'instance
 *  uniforme, donc un contour cartoon d'épaisseur constante — un scale d'instance
 *  (2,7 ; 0,95 ; 1,5) étirerait le contour presque trois fois plus en largeur
 *  qu'en hauteur. */
function getStairGeos() {
  if (stairGeoCache) return stairGeoCache;
  const variants = getNatureAsset('stairsStone');
  if (!variants || !variants.length) return null;
  /* Le modèle sort de normalizeParts : hauteur 1, base à y = 0, centré en X/Z.
     Il descend sur l'axe Z, le haut vers +Z (mesuré sur le fichier). */
  stairGeoCache = variants[0].map((part) => ({
    geo: part.geo.clone().scale(STAIR_W, STAIR_RISE, STAIR_RUN),
    matName: part.matName || '',
  }));
  return stairGeoCache;
}

/**
 * Pose une volée sur chaque arête de rampe où l'on change réellement de niveau.
 *
 * Seules les tuiles `ramp` sont concernées, et ce n'est pas un raccourci : les
 * plateaux vivent sur les niveaux PAIRS (PLATEAU_STEP = 2), donc deux plateaux
 * voisins diffèrent de 0 ou de 2 niveaux. Un écart de 1 — le seul qui se
 * franchisse à pied — n'existe QUE sur une rampe.
 *
 * @returns {THREE.Object3D[]} meshes ajoutés (à retirer entre deux parties)
 */
export function buildRampStairs(scene, island, biomeKey) {
  const parts = getStairGeos();
  if (!parts || !island) return [];
  const B = BIOMES[biomeKey] || BIOMES.temperate;

  /* Passe 1 — recenser les arêtes à équiper, pour dimensionner l'InstancedMesh.
     Une rampe dessert souvent deux plateaux : on garde ses deux volées, montée
     ET descente, ce qui la fait lire comme un palier entre deux demi-volées. */
  const edges = [];
  for (const t of island.tiles) {
    if (!t.ramp) continue;
    /* Une seule volée par SENS. Une rampe touche souvent deux ou trois tuiles de
       chaque plateau qu'elle relie : tout équiper faisait rayonner un éventail de
       marches autour d'une même tuile. Une montée et une descente suffisent — et
       c'est exactement la lecture voulue, un palier entre deux demi-volées. */
    let down = null, up = null;
    for (let i = 0; i < 6; i++) {
      const [dq, dr] = DIRS[i];
      const nb = island.byKey.get(key(t.q + dq, t.r + dr));
      if (!nb) continue;
      const dl = nb.level - t.level;
      if (dl === -CLIMB && !down) down = { t, nb, i };
      else if (dl === CLIMB && !up) up = { t, nb, i };
    }
    if (down) edges.push(down);
    if (up) edges.push(up);
  }
  if (!edges.length) return [];

  const created = [];
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const s = new THREE.Vector3(1, 1, 1);
  const p = new THREE.Vector3();
  const UP = new THREE.Vector3(0, 1, 0);

  /* Un InstancedMesh par partie du modèle (« stone », « grass »), toutes nourries
     des MÊMES matrices : c'est ainsi que les parties d'un même objet restent
     soudées, comme le fait déjà buildBiomeNature. */
  const meshes = parts.map((part) => {
    /* La palette Kenney est reteintée par biome : telle quelle, l'herbe du modèle
       est un vert turquoise qui ne correspond à aucun sol du jeu. */
    const grass = /grass|dirt|top/i.test(part.matName);
    let color;
    if (grass) {
      /* Le dessus herbeux des marches, un cran plus sombre que le sol : à teinte
         égale il capte la lumière comme une tuile et la volée disparaît. */
      color = new THREE.Color(B.ground[1]).offsetHSL(0, 0, -0.07);
    } else {
      /* Pierre éclaircie vers le sommet de montagne du biome. mountainBase seul
         donnait des marches presque noires, noyées sous le dessus vert. */
      color = new THREE.Color(B.mountainBase || 0x6b7280)
        .lerp(new THREE.Color(B.mountainTop || 0xf4f7fc), 0.45);
    }
    const inst = new THREE.InstancedMesh(part.geo, toonMaterial({ color }), edges.length);
    inst.castShadow = true;
    inst.receiveShadow = true;
    inst.frustumCulled = false;
    inst.matrixAutoUpdate = false;
    /* sharedGeo, et non disposeGeo : le teardown de carte (main.js) libère toute
       géométrie NON marquée partagée. La géométrie de volée vit en cache pour la
       durée de l'application — elle ne dépend pas du biome, seule la teinte du
       matériau en dépend — exactement comme crustGeo. */
    inst.userData.sharedGeo = true;
    return inst;
  });

  for (let e = 0; e < edges.length; e++) {
    const { t, nb, i } = edges[e];
    const [nx, nz] = NORMALS[i];
    /* Sens du +Z local (côté haut du modèle) : vers le voisin s'il domine, vers
       le centre de la tuile sinon. Une rotation de θ autour de Y envoie (0,0,1)
       sur (sin θ, 0, cos θ), d'où l'atan2 dans cet ordre. */
    const up = nb.level > t.level ? 1 : -1;
    q.setFromAxisAngle(UP, Math.atan2(up * nx, up * nz));
    // pied de la volée sur la surface BASSE des deux
    const yLow = Math.min(t.h || 0, nb.h || 0) - STAIR_SINK;
    /* Reculée du côté BAS : le haut du modèle est en +Z local, donc on décale à
       l'opposé de ce sens pour dégager la tuile haute. */
    const off = APOTHEM - up * STAIR_BACK;
    p.set(t.x + nx * off, yLow, t.z + nz * off);
    m.compose(p, q, s);
    for (const inst of meshes) inst.setMatrixAt(e, m);
  }

  for (const inst of meshes) {
    inst.instanceMatrix.needsUpdate = true;
    scene.add(inst);
    attachCartoonOutline(inst, 0.03);
    created.push(inst);
  }
  return created;
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
  /* La dalle sculptée si elle est arrivée, sinon la procédurale. Les deux sont
     interchangeables par construction (voir loadTileVariant). */
  const geo = tileGeo || crustGeo;
  const crust = new THREE.InstancedMesh(geo, crustMat, n);
  crust.receiveShadow = true;
  crust.castShadow = true;
  crust.customDepthMaterial = getCrustDepthMaterial();
  crust.userData.sharedGeo = true;
  crust.userData.sharedMat = true;

  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(1, 1, 1), p = new THREE.Vector3();
  q.identity();
  /* Facteur d'allongement de la jupe, un par instance. Voir SKIRT_STRETCH_GLSL :
     la matrice d'instance reste à l'échelle 1 pour que le maillage soit rigide. */
  const skirt = new Float32Array(n);
  /* Biais de matière : le sien, puis celui des six voisines. Le shader les
     mélange par la partition de l'unité pour obtenir un biais continu —
     voir GROUND_WANG_GLSL. */
  const matSelf = new Float32Array(n);
  const matNbA = new Float32Array(n * 3);
  const matNbB = new Float32Array(n * 3);
  let maxDrop = 0;
  for (let i = 0; i < n; i++) {
    const t = island.tiles[i];
    const h = t.h || 0;
    /* La dalle est modélisée entre y = -CRUST_H et y = 0. On la remonte à sa
       hauteur, et la jupe s'allonge en shader pour que sa base retombe toujours
       au même plancher : sans cet allongement, une tuile haute laisserait voir
       le vide sous elle et l'île se lirait comme des plaques flottantes. */
    p.set(t.x, h, t.z);
    m.compose(p, q, s);
    crust.setMatrixAt(i, m);
    crust.setColorAt(i, t.tint);
    skirt[i] = (h + CRUST_H) / CRUST_H;
    if (h > maxDrop) maxDrop = h;

    const self = t.matBias || 0;
    matSelf[i] = self;
    for (let e = 0; e < 6; e++) {
      const [dq, dr] = DIRS[e];
      const nb = island.byKey.get(key(t.q + dq, t.r + dr));
      /* Pas de voisine : on se répète soi-même. Sans ça le mélange partirait
         vers un biais nul au-dessus du vide, et tout le pourtour de l'île
         porterait un liseré de matière étrangère. */
      const v = nb ? (nb.matBias || 0) : self;
      if (e < 3) matNbA[i * 3 + e] = v;
      else matNbB[i * 3 + (e - 3)] = v;
    }
  }
  geo.setAttribute('aSkirt', new THREE.InstancedBufferAttribute(skirt, 1));
  geo.setAttribute('aMatSelf', new THREE.InstancedBufferAttribute(matSelf, 1));
  geo.setAttribute('aMatNbA', new THREE.InstancedBufferAttribute(matNbA, 3));
  geo.setAttribute('aMatNbB', new THREE.InstancedBufferAttribute(matNbB, 3));
  crust.instanceMatrix.needsUpdate = true;
  if (crust.instanceColor) crust.instanceColor.needsUpdate = true;
  /* L'allongement se produisant en shader, three.js croit le maillage haut de
     CRUST_H seulement et calquerait dessus le volume englobant. Une tuile haute
     descendrait alors hors de ce volume : culling et carte d'ombres la
     couperaient. On rattrape le plus grand allongement de l'île. */
  crust.userData.maxDrop = maxDrop;
  crust.computeBoundingSphere();
  if (crust.boundingSphere) crust.boundingSphere.radius += maxDrop;
  liveCrust = crust;
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

/**
 * Assombrit le VIDE — fond, poussière, halo bas.
 * `k` : 0 = normal, 1 = éteint au maximum.
 *
 * Pourquoi ça ne peut pas passer par l'exposition : la poussière est un
 * ShaderMaterial qui écrit `gl_FragColor` sans inclure le chunk de tone mapping,
 * elle est donc totalement insensible à l'exposition. Le fond, lui, est une
 * texture d'environnement, pas un objet de la scène. Baisser les lumières
 * n'assombrit que les tuiles : sans ce crochet, l'île plongeait dans le noir
 * pendant que le ciel et l'abîme restaient en plein jour.
 */
export function setVoidDim(k) {
  if (!fx) return;
  const m = Math.max(0, 1 - k);
  if (!fx.moteBase) fx.moteBase = fx.motes.material.uniforms.uColor.value.clone();
  fx.motes.material.uniforms.uColor.value.copy(fx.moteBase).multiplyScalar(m);
  if (fx.haloBase == null) fx.haloBase = fx.halo.material.opacity;
  fx.halo.material.opacity = fx.haloBase * m;
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
  /* Repli quand un rôle n'existe pas sur cette île (pas un seul hameau, par
     exemple). Il exclut les places de sanctuaire : sans ça, un pool vide
     ramenait des arbres au milieu du dallage, exactement ce que la
     réservation cherche à empêcher. */
  const anywhere = island.tiles.filter((t) => t.role !== ROLE.SANCTUARY);
  /* Amas en cours, un par type de prop : voir plus bas. */
  const clumps = {};

  /**
   * @param {string} kind — rôle de tuile visé (voir ROLE_FOR).
   * @param {{clump?: number, spread?: number}} [opts]
   *   clump : nombre d'instances à regrouper autour d'un même point avant de
   *   repartir ailleurs. Un semis uniforme donne un gazon de moquette : c'est
   *   l'alternance touffes serrées / sol nu qui fait lire un vrai terrain.
   *   spread : rayon de l'amas en unités monde.
   */
  return function place(kind, opts) {
    const pool = pools[kind] && pools[kind].length ? pools[kind]
      : (anywhere.length ? anywhere : island.tiles);
    /* Marge d'arête : un arbre à cheval sur le vide casserait l'illusion de
       tuiles solides. Les maisons se serrent encore plus vers le centre. */
    const margin = kind === 'house' ? 2.8 : 1.6;
    const lim = APOTHEM - margin;
    const clumpN = opts && opts.clump > 1 ? opts.clump : 0;

    let t, cx, cz;
    if (clumpN) {
      let c = clumps[kind];
      if (!c || c.left <= 0) {
        const nt = pool[(rng() * pool.length) | 0];
        const a = rng() * Math.PI * 2, rr = Math.sqrt(rng()) * lim * 0.75;
        c = clumps[kind] = {
          tile: nt, ox: Math.cos(a) * rr, oz: Math.sin(a) * rr,
          left: clumpN,
        };
      }
      c.left--;
      t = c.tile;
      const spread = opts.spread || 1.1;
      const a = rng() * Math.PI * 2, rr = Math.sqrt(rng()) * spread;
      cx = c.ox + Math.cos(a) * rr;
      cz = c.oz + Math.sin(a) * rr;
      /* L'amas ne doit pas déborder sur l'arête : on rentre le point plutôt
         que de le rejeter, sinon les touffes de bord disparaissent et chaque
         tuile finit auréolée de sol nu. */
      const d = Math.hypot(cx, cz);
      if (d > lim) { const k = lim / d; cx *= k; cz *= k; }
    } else {
      t = pool[(rng() * pool.length) | 0];
      const a = rng() * Math.PI * 2, rr = Math.sqrt(rng()) * lim;
      cx = Math.cos(a) * rr; cz = Math.sin(a) * rr;
    }
    /* `y` est la surface de la tuile : tout prop posé par le placeur doit s'y
       asseoir, sinon il flotte au-dessus d'un plateau ou s'enfonce dedans. */
    return { x: t.x + cx, y: t.h || 0, z: t.z + cz, tile: t };
  };
}

/** Tuile dont tous les voisins existants sont au même niveau.
 *  Tout ce qui pose une surface plane plus large qu'une tuile — disque de
 *  base, pad d'autel — doit s'y installer, sinon la géométrie traverse le
 *  flanc du plateau voisin. */
export function isFlatTile(island, t, rings = 1) {
  if (!island || !t) return false;
  /* Balayage du disque axial de rayon `rings` autour de la tuile. Une place de
     sanctuaire fait plus d'une tuile de rayon : se contenter des six voisins
     laisserait son dallage mordre sur le flanc du plateau suivant.

     L'assise doit être PLEINE autant que plate. La version précédente ne
     testait le niveau que des voisins existants, si bien qu'une tuile de bord
     entourée de vide passait pour parfaitement plate — d'où des sanctuaires
     bâtis à moitié au-dessus du gouffre. Un voisin manquant est maintenant
     rédhibitoire. */
  for (let dq = -rings; dq <= rings; dq++) {
    const lo = Math.max(-rings, -dq - rings);
    const hi = Math.min(rings, -dq + rings);
    for (let dr = lo; dr <= hi; dr++) {
      const nb = island.byKey.get(key(t.q + dq, t.r + dr));
      if (!nb) return false;
      if (nb.level !== t.level) return false;
    }
  }
  return true;
}

/** Toutes les tuiles dont l'assise est plate et pleine, dans une couronne de
 *  distance au centre. Rendre la liste plutôt qu'un point permet d'échantillonner
 *  beaucoup sans refiltrer l'île à chaque tirage. */
export function flatTiles(island, minD = 0, maxD = Infinity, rings = 1) {
  return island.tiles.filter((t) => t.d >= minD && t.d <= maxD
    && t.role !== ROLE.SANCTUARY && isFlatTile(island, t, rings));
}


/* ============================== Nappe de peinture ==============================
   La peinture était plaquée sur un quad unique, puis sur une grille déformée.
   Aucun des deux ne sait faire un décrochement net : la résolution de la
   grille impose la pente, si bien qu'une falaise donnait un plan incliné
   traversant la roche au lieu d'une coulée.

   On construit donc la surface tuile par tuile :
     · une CAPE hexagonale à la hauteur de la dalle ;
     · sur chaque arête dominant un voisin plus bas, une JUPE en deux temps —
       un épaulement court qui arrondit la sortie de la tuile, puis une chute
       verticale jusqu'au niveau d'en dessous.

   L'épaulement ne mesure que quelques centimètres : invisible en tant que
   tel, mais c'est lui qui donne à la coulée son épaisseur de liquide plutôt
   qu'une arête de papier pliée à 90°.

   Les UV sont projetés depuis le plan (x, z) comme l'ancienne nappe, et la
   jupe hérite des UV de la lèvre : la chute est donc une traînée verticale de
   la couleur du bord. Là où la lèvre n'est pas peinte, la jupe est
   transparente et disparaît d'elle-même — aucun test à écrire. */
export function buildPaintSurface(island, opts = {}) {
  const span = opts.span || 128;          // largeur monde couverte par la texture
  const lift = opts.lift ?? 0.04;         // décollement au-dessus de la dalle
  const shoulder = opts.shoulder ?? 0.16; // longueur de l'épaulement adouci
  const coastDrip = opts.coastDrip ?? CRUST_H;   // coulée sur la côte

  const pos = [], uv = [], tileCenter = [], idx = [];
  const uvOf = (x, z) => [x / span + 0.5, 0.5 - z / span];
  const push = (x, y, z, u, v, tX, tZ) => {
    const i = pos.length / 3;
    pos.push(x, y, z); uv.push(u, v); tileCenter.push(tX, tZ);
    return i;
  };

  /* Coins de l'hexagone, très légèrement élargis : deux capes voisines doivent
     se recouvrir d'un cheveu, sinon un liseré de dalle nue apparaît entre
     elles au moindre arrondi flottant. */
  const R = HEX_R * 1.004;
  const cornerAt = (t, i) => {
    const a = (i / 6) * Math.PI * 2;
    return [t.x + R * Math.cos(a), t.z + R * Math.sin(a)];
  };

  const TOP_SUB = 8;

  for (const t of island.tiles) {
    const capY = (t.h || 0) + lift;

    /* --- Cape subdivisée pour suivre le relief de gLift --- */
    const corners = [];
    for (let i = 0; i < 6; i++) corners.push(cornerAt(t, i));

    for (let i = 0; i < 6; i++) {
      const [ax, az] = corners[i];
      const [bx, bz] = corners[(i + 1) % 6];
      const grid = [];
      for (let u = 0; u <= TOP_SUB; u++) {
        grid[u] = [];
        for (let v = 0; v + u <= TOP_SUB; v++) {
          const x = (ax * u + bx * v + t.x * (TOP_SUB - u - v)) / TOP_SUB;
          const z = (az * u + bz * v + t.z * (TOP_SUB - u - v)) / TOP_SUB;
          const [uUv, vUv] = uvOf(x, z);
          grid[u][v] = push(x, capY, z, uUv, vUv, t.x, t.z);
        }
      }
      for (let u = 0; u < TOP_SUB; u++) {
        for (let v = 0; u + v < TOP_SUB; v++) {
          idx.push(grid[u][v], grid[u][v + 1], grid[u + 1][v]);
          if (u + v + 1 < TOP_SUB) {
            idx.push(grid[u + 1][v], grid[u][v + 1], grid[u + 1][v + 1]);
          }
        }
      }
    }

    /* --- Jupes --- */
    for (let i = 0; i < 6; i++) {
      const [dq, dr] = DIRS[i];
      const nb = island.byKey.get(key(t.q + dq, t.r + dr));
      const lowY = nb ? (nb.h || 0) + lift : capY - coastDrip;
      if (lowY >= capY - 0.02) continue;      // voisin au même niveau ou plus haut

      /* Arête i = coins (i+5)%6 → i, comme le contour de côte. */
      const ia = (i + 5) % 6, ib = i;
      const [ax, az] = cornerAt(t, ia);
      const [bx, bz] = cornerAt(t, ib);
      const [nx, nz] = NORMALS[i];

      const [au, av] = uvOf(ax, az);
      const [bu, bv] = uvOf(bx, bz);

      /* Lèvre, puis épaulement sorti vers l'extérieur ET descendu d'autant :
         c'est ce quart de tour raccourci qui fait le bourrelet. */
      const a0 = push(ax, capY, az, au, av, t.x, t.z);
      const b0 = push(bx, capY, bz, bu, bv, t.x, t.z);
      const sx = nx * shoulder, sz = nz * shoulder;
      const a1 = push(ax + sx, capY - shoulder, az + sz, au, av, t.x, t.z);
      const b1 = push(bx + sx, capY - shoulder, bz + sz, bu, bv, t.x, t.z);
      /* Puis la chute, franchement verticale. */
      const a2 = push(ax + sx, lowY, az + sz, au, av, t.x, t.z);
      const b2 = push(bx + sx, lowY, bz + sz, bu, bv, t.x, t.z);

      idx.push(a0, b0, b1, a0, b1, a1);
      idx.push(a1, b1, b2, a1, b2, a2);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(uv), 2));
  geo.setAttribute('tileCenter', new THREE.BufferAttribute(new Float32Array(tileCenter), 2));
  geo.setIndex(idx);
  geo.computeBoundingSphere();
  return geo;
}

/** Réserve une place de sanctuaire : la tuile et ses six voisins passent en
 *  ROLE.SANCTUARY. Aucun `kind` de ROLE_FOR n'accepte ce rôle, donc plus rien
 *  ne se plante sur l'emprise — à condition d'appeler ceci AVANT de semer le
 *  décor du biome. */
export function reserveSanctuary(island, tile) {
  if (!island || !tile) return;
  /* La teinte des tuiles est calculée pendant la génération, avant cette
     réservation : on l'éclaircit ici comme le fait generateIsland pour les
     Lieux Saints, sinon la place ne se distinguerait en rien de la prairie. */
  const pale = (t) => {
    t.role = ROLE.SANCTUARY;
    if (t.tint) t.tint.lerp(new THREE.Color(0xffffff), 0.30);
  };
  pale(tile);
  for (const [dq, dr] of DIRS) {
    const nb = island.byKey.get(key(tile.q + dq, tile.r + dr));
    if (nb) pale(nb);
  }
}

/* Centres des tuiles sanctuaire — les Lieux Saints du GDD (§4.3). */
export const sanctuaryTiles = (island) => island.tiles.filter((t) => t.role === ROLE.SANCTUARY);
