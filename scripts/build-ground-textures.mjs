/* ============================================================================
   Cuisson des textures de sol — matière des dessus de tuile
   ----------------------------------------------------------------------------
   Le sol du jeu n'avait aucune texture : tout venait du shader, à des échelles
   de 12 et 2,5 unités, c'est-à-dire l'échelle du PAYSAGE. La signature du
   MATÉRIAU — la ride de sable, la fibre d'herbe, la fracture de roche — n'y
   existait pas, et les six biomes partageaient la même recette à la couleur
   près. D'où l'aplat.

   Pourquoi cuire plutôt que sourcer des images
     · Rien à licencier, rien à accorder entre six biomes dessinés par des
       mains différentes : la même recette les produit tous, donc ils se
       ressemblent comme les six faces d'un même monde.
     · Le résultat est reproductible et se relit dans le diff : changer une
       constante ici et relancer, c'est tout le pipeline d'art du sol.
     · Tuilage EXACT garanti par construction (bruit périodique), là où une
       photo détourée demande un raccord manuel.

   Ce qu'on cuit, et pourquoi ces canaux-là
     Surtout PAS une normal map d'éclairage. hexmap.js le documente déjà :
     perturber la normale sous un dégradé toon à 4 crans ne donne pas du
     volume mais des taches à bord dur, parce que deux orientations voisines
     retombent sur le même cran. Le modelé y est porté par l'ALBÉDO, via un
     hillshade calculé au fragment. On cuit donc ce que ce hillshade consomme :

       R : TRAIT d'encre — 0 partout, 1 sur le contour d'une marque
       G : modulation d'albédo (gris ; la couleur vient du biome)
       B : masque de MARQUE — 0 sur le fond, 1 sur une touffe
       A : 255, CONSTANT. Surtout pas de donnée ici — voir ci-dessous.

     N'UTILISEZ JAMAIS LE CANAL ALPHA POUR DE LA DONNÉE.
     Le WebP met le RGB à ZÉRO partout où l'alpha vaut 0, y compris en mode
     sans perte : l'encodeur considère ces pixels comme invisibles et jette
     leur couleur. Un masque de marque logé dans l'alpha détruisait donc les
     trois autres canaux sur toute la surface hors marque — c'est-à-dire
     partout, pour du sable ou de la terre nue. La texture ressortait à 34
     octets, parfaitement uniforme, sans le moindre avertissement.

     Pourquoi un TRAIT et non un ombrage directionnel.
     La version précédente cuisait le gradient (∂h/∂x, ∂h/∂y) et le projetait
     sur le soleil : c'est du relief photographique. Un sol dessiné n'a pas
     d'ombrage à l'intérieur de ses aplats, il a des CONTOURS. On cuit donc la
     norme du gradient, qui vaut zéro sur les aplats et se concentre sur les
     marches — c'est exactement le trait d'encre, et ça libère le canal dont
     le masque de marque avait besoin.

     Une seule texture RGBA, donc UN SEUL échantillonnage par pixel — ce qui
     compte sur téléphone, où le sol remplit l'écran.

   Encodage
     WebP SANS PERTE. Le bruit se compresse mal, mais R et G sont un gradient :
     la moindre perte s'y voit en marches dans l'ombrage, très exactement le
     défaut qu'on cherche à supprimer.

   Usage : node scripts/build-ground-textures.mjs [biome…]
   ========================================================================== */
import sharp from 'sharp';
import fs from 'node:fs';
import path from 'node:path';

/* 256 suffit : le budget de gradient ci-dessous place l'essentiel du modelé
   dans les basses fréquences. En 512 le fichier triple (302 Ko contre 112) pour
   un gain invisible à la distance de caméra du jeu. */
const SIZE = Number(process.env.GROUND_TEX_SIZE || 256);
const OUT = path.join(process.cwd(), 'public', 'assets', 'ground');

/* ---------------------------------------------------------------------------
   Bruit PÉRIODIQUE. Le tuilage doit être exact : la texture est lue en
   coordonnées monde sur toute l'île, une couture se lirait comme une grille
   régulière posée sur le paysage — le défaut qu'on essaie justement d'éviter.
   D'où le hachage sur le réseau REPLIÉ (i % period).
--------------------------------------------------------------------------- */
function hash2(x, y, seed) {
  let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ Math.imul(seed, 0x9e3779b9);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

const smooth = (t) => t * t * (3 - 2 * t);

/* Convention de fréquence, et c'est LA condition du tuilage.
   Toutes les fonctions ci-dessous prennent (x, y) dans le carré UNITÉ et une
   fréquence F ENTIÈRE : elles échantillonnent un réseau de F×F cellules replié
   sur lui-même. F entier ⇒ la texture se raccorde exactement à elle-même.
   Une fréquence fractionnaire replie sur un réseau tronqué et rouvre la
   couture — c'est ce qui la faisait apparaître en croix sur le premier essai. */

/** Bruit de valeur, périodique sur F cellules dans le carré unité. */
function pnoise(x, y, F, seed) {
  const sx = x * F, sy = y * F;
  const ix = Math.floor(sx), iy = Math.floor(sy);
  const fx = smooth(sx - ix), fy = smooth(sy - iy);
  const w = (v) => ((v % F) + F) % F;
  const x0 = w(ix), x1 = w(ix + 1), y0 = w(iy), y1 = w(iy + 1);
  const a = hash2(x0, y0, seed), b = hash2(x1, y0, seed);
  const c = hash2(x0, y1, seed), d = hash2(x1, y1, seed);
  return (a + (b - a) * fx) * (1 - fy) + (c + (d - c) * fx) * fy;
}

/** fbm périodique : la fréquence double à chaque octave, donc reste entière. */
function pfbm(x, y, F, seed, octaves = 5, gain = 0.5) {
  let s = 0, amp = 1, norm = 0, f = 1;
  for (let o = 0; o < octaves; o++) {
    s += amp * pnoise(x, y, F * f, seed + o * 31);
    norm += amp;
    amp *= gain;
    f *= 2;
  }
  return s / norm;
}

/** Bruit « nervuré » : |2n−1| inversé. Donne des ARÊTES, pas des bosses —
    c'est ce qui distingue une fracture de roche d'une dune. */
function pridge(x, y, F, seed, octaves = 4) {
  let s = 0, amp = 1, norm = 0, f = 1;
  for (let o = 0; o < octaves; o++) {
    const n = 1 - Math.abs(pnoise(x, y, F * f, seed + o * 17) * 2 - 1);
    s += amp * n * n;
    norm += amp;
    amp *= 0.5;
    f *= 2;
  }
  return s / norm;
}

/** Bruit ANISOTROPE : Fx ≠ Fy. Une matière fibreuse — de l'herbe, des brins
    couchés — n'est pas un bruit rond étiré, c'est un bruit dont la maille est
    plus longue dans un sens. Les deux fréquences restent entières. */
function pnoiseA(x, y, Fx, Fy, seed) {
  const sx = x * Fx, sy = y * Fy;
  const ix = Math.floor(sx), iy = Math.floor(sy);
  const fx = smooth(sx - ix), fy = smooth(sy - iy);
  const wx = (v) => ((v % Fx) + Fx) % Fx;
  const wy = (v) => ((v % Fy) + Fy) % Fy;
  const x0 = wx(ix), x1 = wx(ix + 1), y0 = wy(iy), y1 = wy(iy + 1);
  const a = hash2(x0, y0, seed), b = hash2(x1, y0, seed);
  const c = hash2(x0, y1, seed), d = hash2(x1, y1, seed);
  return (a + (b - a) * fx) * (1 - fy) + (c + (d - c) * fx) * fy;
}

/** Onde parallèle périodique.
    La direction est donnée en ENTIERS (dx, dy) : c'est ce qui garantit que la
    phase reboucle sur les bords. Une direction quelconque (cos θ, sin θ) ne
    reboucle pas, et la ride se casse net au raccord. */
function wave(x, y, dx, dy, reps, phase) {
  return Math.sin(((x * dx + y * dy) * reps + phase) * Math.PI * 2);
}


/* ---------------------------------------------------------------------------
   MARQUES DESSINÉES — la façon dont un sol de jeu cartoon est réellement fait.

   Un premier jeu de recettes remplissait chaque pixel de fbm. C'est du détail
   continu, partout, et ça ne peut PAS donner un rendu dessiné : un illustrateur
   pose un fond presque uni, puis quelques marques nettes dessus, avec beaucoup
   de vide entre elles. La densité de détail est basse, et c'est justement ce
   vide qui fait lire les marques.

   D'où ce qui suit : des TAMPONS semés sur une grille, évalués en distance
   SIGNÉE. La distance signée donne gratuitement les deux choses qui font le
   style : un intérieur parfaitement plat, et un contour d'épaisseur contrôlée
   qu'on peut assombrir — le trait d'encre.

   La grille est repliée (modulo F), donc le semis tuile exactement.
--------------------------------------------------------------------------- */
function hash22(ix, iy, seed) {
  return [hash2(ix, iy, seed), hash2(ix, iy, seed + 977)];
}

/** Distance d'un point à un segment. Brique de base des brins et des traits. */
function segDist(px, py, ax, ay, bx, by) {
  const vx = bx - ax, vy = by - ay;
  const wx = px - ax, wy = py - ay;
  const L = vx * vx + vy * vy || 1e-9;
  const t = Math.max(0, Math.min(1, (wx * vx + wy * vy) / L));
  const dx = wx - vx * t, dy = wy - vy * t;
  return { d: Math.hypot(dx, dy), t };
}

/**
 * Sème un tampon sur une grille de F×F cellules et rend la distance signée la
 * plus PROCHE (donc la plus petite). On balaie les 9 cellules voisines : un
 * tampon débordant de sa cellule serait sinon tronqué net à la frontière, ce
 * qui se lirait comme un quadrillage — le défaut qu'on fuit.
 * `shape(lx, ly, r)` reçoit des coordonnées en unités de cellule et deux
 * aléas, et rend une distance signée (négative à l'intérieur).
 */
function stamp(x, y, F, seed, shape) {
  const sx = x * F, sy = y * F;
  const cx = Math.floor(sx), cy = Math.floor(sy);
  const w = (v) => ((v % F) + F) % F;
  let best = 1e9;
  for (let dj = -1; dj <= 1; dj++) {
    for (let di = -1; di <= 1; di++) {
      const gx = cx + di, gy = cy + dj;
      const [jx, jy] = hash22(w(gx), w(gy), seed);
      const ox = gx + jx, oy = gy + jy;          // centre du tampon
      const r0 = hash2(w(gx), w(gy), seed + 31);
      const r1 = hash2(w(gx), w(gy), seed + 57);
      const d = shape(sx - ox, sy - oy, r0, r1);
      if (d < best) best = d;
    }
  }
  return best;
}

/** Cellules de Voronoï repliées : rend l'écart F2−F1, petit SUR le joint.
    C'est la terre craquelée — des plaques plates séparées d'un trait creux. */
function cracks(x, y, F, seed) {
  const sx = x * F, sy = y * F;
  const cx = Math.floor(sx), cy = Math.floor(sy);
  const w = (v) => ((v % F) + F) % F;
  let d1 = 1e9, d2 = 1e9;
  for (let dj = -1; dj <= 1; dj++) {
    for (let di = -1; di <= 1; di++) {
      const gx = cx + di, gy = cy + dj;
      const [jx, jy] = hash22(w(gx), w(gy), seed);
      const d = Math.hypot(sx - (gx + jx), sy - (gy + jy));
      if (d < d1) { d2 = d1; d1 = d; } else if (d < d2) { d2 = d; }
    }
  }
  return d2 - d1;
}

/* Marque → aplat + contour. `fill` vaut 1 dans la forme, `ink` 1 sur son
   pourtour. Les deux transitions sont étroites mais non nulles : à zéro, la
   forme crénellerait dès la première réduction de mipmap. */
function inkShape(d, ink = 0.06, soft = 0.012) {
  const fill = sstep(-d, -soft, soft);
  const outer = sstep(-(d - ink), -soft, soft);
  return { fill, ink: Math.max(0, outer - fill) };
}


/* ---------------------------------------------------------------------------
   Recettes de matière. Chacune rend, pour un point du carré unité :
     height  — le relief microscopique, c'est lui qui produira l'ombrage
     albedo  — la modulation de clarté, centrée sur 1
     Les deux sont lus en cellules de bruit, pas en pixels : la résolution de
     la texture peut changer sans changer l'aspect.
--------------------------------------------------------------------------- */
const RECIPES = {
  /* SABLE — aplat, et rien d'autre.

     Deux tentatives de « marques » y ont échoué, pour la même raison de fond.
     Des rides tracées en traits courbes se lisaient comme des vers ou des
     virgules posées au sol : à l'échelle d'une tuile, un trait isolé sur du
     sable n'évoque pas une ride, il évoque un objet. Et une trame de rides
     serrées, essayée avant, donnait du velours côtelé.

     Le sable n'a donc AUCUNE marque. Il ne porte qu'une respiration de ton très
     lente — de larges zones à peine plus claires ou plus sombres, qui se lisent
     comme une étendue et non comme un motif. Tout ce qui doit se voir au sol
     (cailloux, touffes, débris) existe déjà en géométrie par-dessus.

     C'est aussi un rappel utile : sur une surface vue en perspective et
     couverte de décor 3D, la texture a moins à dire qu'on ne croit. */
  sand(x, y) {
    const swell = pfbm(x, y, 3, 7, 2);
    const height = 0.5 + (swell - 0.5) * 0.5;
    const albedo = 1 + (swell - 0.5) * 0.05;
    return [height, albedo, 0];
  },

  /* TERRE CRAQUELÉE — des plaques PLATES séparées d'un joint creux. Le sol sec
     des références. Tout se joue dans le joint : l'intérieur ne doit rien
     contenir, sinon on retombe sur de la texture. */
  earthCracked(x, y) {
    const swell = pfbm(x, y, 4, 41, 2);
    const g = cracks(x, y, 7, 43);
    /* g est petit SUR le joint. On en fait un trait d'épaisseur constante. */
    const joint = 1 - sstep(g, 0.02, 0.12);
    /* Un second réseau, plus fin et plus rare : les craquelures réelles se
       subdivisent, un seul réseau donne un carrelage régulier. */
    const g2 = cracks(x, y, 14, 47);
    const joint2 = (1 - sstep(g2, 0.02, 0.10)) * 0.45;
    const j = Math.min(1, joint + joint2);

    const height = 0.72 + (swell - 0.5) * 0.22 - j * 0.62;
    const albedo = 1 + (swell - 0.5) * 0.06 - j * 0.30;
    return [height, albedo, 0];
  },

};



/* ---------------------------------------------------------------------------
   Passage en APLATS — ce qui fait la différence entre un sol photo et un sol
   dessiné.

   Les recettes ci-dessus sont bâties sur du fbm, donc continues par nature :
   elles produisent des dégradés. Or le jeu est en cel-shading, aplats à bords
   nets et contours noirs — un dégradé y jure, et le grain fin s'y lit comme du
   bruit de photo, voire du moiré quand la caméra recule.

   On quantifie donc chaque canal sur quelques paliers. Deux conséquences :
     · la matière devient des TACHES à bord franc, comme des coups de pinceau,
       au lieu d'un fondu ;
     · le relief se terrasse, et l'ombrage se concentre sur les marches — ce
       qui donne un liseré net au bord de chaque tache, exactement le trait
       qu'un illustrateur poserait.

   `edge` contrôle la douceur de la marche. Zéro donnerait de l'escalier
   crénelé une fois minifié : on garde une transition étroite mais non nulle,
   pour que le mipmap ait de quoi filtrer.
--------------------------------------------------------------------------- */
function sstep(x, a, b) {
  const t = Math.max(0, Math.min(1, (x - a) / ((b - a) || 1e-6)));
  return t * t * (3 - 2 * t);
}

function posterize(v, levels, edge) {
  if (!levels) return v;
  const s = Math.max(0, Math.min(1, v)) * levels;
  const i = Math.floor(s);
  const f = s - i;
  return (i + sstep(f, 0.5 - edge, 0.5 + edge)) / levels;
}

/* Paliers par matière. Les recettes à tampons sortent DÉJÀ en aplats — la
   distance signée donne un intérieur plat et un bord net — donc on ne
   quantifie plus que le fond, et légèrement, pour le débarrasser du peu de
   dégradé qu'il lui reste. Trop de paliers ici ramènerait des cernes
   concentriques autour de chaque marque. */
const TOON = {
  /* `ink: 0` — le sable n'a AUCUN trait, et il faut le dire explicitement.
     Deux mécanismes le lui rendaient sinon : la quantification du relief le
     terrasse, et le canal d'encre souligne chaque marche ; puis l'étalement du
     canal, qui cale le blanc sur le 99,5e percentile, ramène ces marches à
     pleine intensité même quand elles sont infimes. Un aplat se retrouvait
     donc cerné de contours pâles alors qu'on n'avait rien dessiné.
     `h: 0` coupe la quantification du relief, `ink: 0` coupe le trait. */
  sand:         { alb: 5, h: 0, edge: 0.18, ink: 0 },
  earthCracked: { alb: 5, h: 4, edge: 0.18 },
};


/* ---------------------------------------------------------------------------
   Cuisson
--------------------------------------------------------------------------- */
function bake(name, recipe) {
  const n = SIZE;
  const h = new Float64Array(n * n);
  const alb = new Float64Array(n * n);
  /* Masque de marque : 1 sur une touffe, 0 sur le fond. Il occupe le canal
     autrefois dédié à la cavité — un ombrage de sillon valait bien moins que
     la possibilité de teinter une marque autrement que son fond, sans quoi une
     touffe d'herbe ne peut qu'être du sable plus clair ou plus sombre. */
  const mark = new Float64Array(n * n);

  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const [hh, aa, mm] = recipe(i / n, j / n);
      h[j * n + i] = hh;
      alb[j * n + i] = aa;
      mark[j * n + i] = mm || 0;
    }
  }

  const toon = TOON[name] || {};

  // Normalise la hauteur sur [0,1] : les recettes n'ont pas à compter leurs
  // amplitudes, et le gradient garde le même sens d'une matière à l'autre.
  let lo = Infinity, hi = -Infinity;
  for (let k = 0; k < h.length; k++) { if (h[k] < lo) lo = h[k]; if (h[k] > hi) hi = h[k]; }
  const span = (hi - lo) || 1;
  /* Le relief se terrasse AVANT le gradient, pas après : c'est ce qui
     concentre l'ombrage sur les marches et pose un liseré net au bord de
     chaque tache. Quantifier le gradient lui-même n'aurait donné que des
     paliers d'ombre sur une forme restée molle. */
  for (let k = 0; k < h.length; k++) {
    h[k] = posterize((h[k] - lo) / span, toon.h, toon.edge || 0.15);
  }

  /* Gradient par différence centrée, enroulé aux bords — sinon les quatre
     bords de la texture porteraient un gradient faux et la couture, invisible
     dans la hauteur, réapparaîtrait dans l'ombrage. */
  const at = (i, j) => h[((j % n) + n) % n * n + (((i % n) + n) % n)];
  const GRAD_GAIN = 1.15;   // ramène ∂h sur une plage lisible en 8 bits sans saturer

  /* Première passe : on calcule les quatre canaux en flottant, sans encoder.
     L'encodage vient après, une fois qu'on connaît leur amplitude réelle —
     voir ÉTALEMENT plus bas. */
  /* Le TRAIT : norme du gradient. Nulle sur un aplat, forte sur une marche —
     donc elle souligne exactement le bord de chaque marque et le joint de
     chaque craquelure, sans rien poser à l'intérieur. */
  const INK = new Float64Array(n * n);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const gx = (at(i + 1, j) - at(i - 1, j)) * 0.5 * n / 64 * GRAD_GAIN;
      const gy = (at(i, j + 1) - at(i, j - 1)) * 0.5 * n / 64 * GRAD_GAIN;
      INK[j * n + i] = Math.hypot(gx, gy);
    }
  }

  /* ÉTALEMENT — la correction qui rendait tout le reste inopérant.
     Premier jet : les quatre canaux n'occupaient qu'un dixième de la dynamique
     8 bits (albédo : écart-type 3,4 sur 255, soit 1,3 %). On compensait par de
     gros multiplicateurs côté shader, ce qui amplifie le bruit de
     quantification sans amplifier le signal — donc un sol resté plat, et des
     réglages qui ne répondaient pas.

     C'est le même piège que gRamp() dans groundNoise.js, un étage plus bas :
     un bruit ne s'écarte presque jamais de sa moyenne autant qu'on le croit, et
     l'écart demandé n'arrive jamais si on ne l'étale pas explicitement.

     On étale donc chaque canal sur toute la plage, et on le fait sur des
     PERCENTILES : un unique pixel extrême — un gravillon, un bord de crête —
     écraserait tout le reste si on calait sur le min/max. Ce qui dépasse est
     écrêté, et compté. Conséquence importante pour le réglage : après ça,
     `amt` porte enfin une amplitude réelle, et se règle autour de 0,1–0,5 au
     lieu de 1,8. */
  const pct = (arr, p) => {
    const s = Float64Array.from(arr).sort();
    return s[Math.min(s.length - 1, Math.max(0, Math.round((s.length - 1) * p)))];
  };
  /* Le trait s'étale depuis ZÉRO, pas autour d'une moyenne : c'est une
     couverture (pas de trait / trait), et la centrer poserait un demi-trait
     sur toute la surface. On cale le blanc sur le 99,5e percentile pour qu'un
     pic isolé n'écrase pas l'ensemble. */
  const inkAmp = pct(INK, 0.995) || 1;
  /* L'albédo s'étale autour de sa MOYENNE, pas de sa plage.
     Caler sur la plage laissait la moyenne de l'albédo à 112 au lieu de 128 :
     le shader lisait donc un assombrissement constant, proportionnel au
     réglage. Un curseur censé ajouter de la matière assombrissait le sol —
     c'est le genre de dérive qui fait conclure « le réglage ne répond pas ».
     Centrés sur la moyenne, les trois canaux de modulation sont des ÉCARTS
     signés : à réglage nul comme à réglage fort, la teinte moyenne du biome
     est exactement celle de la palette. */
  const meanOf = (a) => { let s = 0; for (let k = 0; k < a.length; k++) s += a[k]; return s / a.length; };
  const sdOf = (a, m) => {
    let q = 0; for (let k = 0; k < a.length; k++) { const d = a[k] - m; q += d * d; }
    return Math.sqrt(q / a.length) || 1;
  };
  const aM = meanOf(alb), aS = sdOf(alb, aM);
  /* ±2,2 σ remplit la plage : au-delà on écrête surtout du bruit, en deçà on
     laisse de la dynamique inutilisée. */
  const SPREAD = 2.2;

  const buf = Buffer.alloc(n * n * 4);
  let clipped = 0;
  const enc = (v) => {
    if (v < 0 || v > 1) clipped++;
    return Math.max(0, Math.min(255, Math.round(v * 255)));
  };
  for (let k = 0; k < n * n; k++) {
    const o = k * 4;
    buf[o] = enc(Math.min(1, INK[k] / inkAmp) * (toon.ink !== undefined ? toon.ink : 1));
    /* L'albédo se quantifie APRÈS son centrage : les paliers tombent alors aux
       mêmes valeurs d'une matière à l'autre, donc deux matières voisines
       s'accordent au lieu de présenter deux escaliers décalés. */
    buf[o + 1] = enc(posterize((alb[k] - aM) / (aS * SPREAD) * 0.5 + 0.5,
                               toon.alb, toon.edge || 0.15));
    buf[o + 2] = enc(mark[k]);
    /* Alpha CONSTANT. Toute donnée logée ici serait détruite par l'encodeur
       partout où elle vaut zéro — et elle emporterait le RGB avec elle. */
    buf[o + 3] = 255;
  }

  fs.mkdirSync(OUT, { recursive: true });
  const file = path.join(OUT, `${name}.webp`);
  return sharp(buf, { raw: { width: n, height: n, channels: 4 } })
    .webp({ lossless: true, effort: 6 })
    .toFile(file)
    .then(() => {
      const kb = (fs.statSync(file).size / 1024).toFixed(0);
      const cp = (clipped / (n * n * 4) * 100).toFixed(2);
      /* Étendue utile par canal (percentiles 1–99) : c'est LA mesure qui dit
         si la texture porte du signal. On ne prend pas l'écart-type : une
         recette en aplats produit un gradient ÉPARS — plat sur les plateaux,
         piqué sur les marches — dont l'écart-type est bas alors que l'image
         est franche. L'écart-type criait au loup sur exactement les textures
         qu'on cherche à obtenir. L'étendue, elle, juge les deux pareil.
         En dessous de ~120 sur 255, le canal est trop plat pour se voir quel
         que soit le réglage côté shader : inutile d'aller chercher là-bas. */
      const range = [0, 1, 2, 3].map((c) => {
        const s = new Uint8Array(n * n);
        for (let k = 0; k < n * n; k++) s[k] = buf[k * 4 + c];
        s.sort();
        return s[Math.round((n * n - 1) * 0.99)] - s[Math.round((n * n - 1) * 0.01)];
      });
      console.log(`  ${name}.webp — ${n}×${n} RGBA, ${kb} Ko`);
      console.log(`     étendue  trait ${range[0]}  albédo ${range[1]}  marques ${range[2]}  (sur 255) — écrêté ${cp} %`);
      /* Le masque de marque est EXCLU du contrôle : une matière sans marque
         colorée — du sable nu, de la terre craquelée — le laisse légitimement
         à zéro. L'y inclure faisait crier le garde-fou sur des textures
         parfaitement correctes, ce qui est le meilleur moyen qu'on cesse de
         l'écouter. Le contrôle ne porte donc que sur ce qui doit TOUJOURS
         porter du signal : le trait et l'albédo. */
      /* On exige qu'AU MOINS UN des deux canaux porte. Exiger les deux était
         faux : une matière d'aplat pur — du sable, une dalle lisse — n'a
         légitimement aucun trait, et le garde-fou la signalait à tort. Un
         contrôle qui se trompe sur des cas corrects finit par être ignoré. */
      if (Math.max(range[0], range[1]) < 120) {
        console.log(`     ↑ ni trait ni albédo au-dessus de 120 : la texture est vide, elle ne portera rien`);
      }
      /* Alpha doit rester rigoureusement constant : s'il ne l'est pas, une
         donnée s'y est glissée et le RGB sera silencieusement détruit. */
      let aMin = 255, aMax = 0;
      for (let k = 0; k < n * n; k++) { const v = buf[k * 4 + 3]; if (v < aMin) aMin = v; if (v > aMax) aMax = v; }
      if (aMin !== 255 || aMax !== 255) {
        console.log(`     ↑ ALPHA NON CONSTANT (${aMin}–${aMax}) : le WebP va effacer le RGB sous les pixels transparents`);
      }
    });
}

const wanted = process.argv.slice(2);
const names = wanted.length ? wanted : Object.keys(RECIPES);
console.log(`Cuisson des textures de sol (${SIZE}×${SIZE}) →  public/assets/ground/`);
for (const name of names) {
  if (!RECIPES[name]) { console.error(`  recette inconnue : ${name}`); process.exit(1); }
  await bake(name, RECIPES[name]);
}
console.log('OK');
