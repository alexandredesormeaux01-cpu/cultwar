/* ============================================================================
   Cult.io — Orbes d'énergie dessinées au canvas
   ---------------------------------------------------------------------------
   Six orbes (une par élément) peintes une seule fois au chargement, puis
   affichées en sprites. Aucun asset à produire, aucun octet dans l'APK, et la
   teinte de chaque culte sort de la même recette.

   La recette reprend ce qui fait lire une boule d'énergie :
     1. un CŒUR clair décentré vers le haut-gauche — c'est lui qui donne le
        volume, une sphère éclairée de face paraît plate ;
     2. des RUBANS qui enrobent la sphère : des arcs elliptiques d'inclinaisons
        variées, tracés en mode « lighter » pour que leurs croisements brûlent ;
     3. un ÉCLAT spéculaire court en haut à gauche, cohérent avec le cœur ;
     4. des ÉTINCELLES au-delà du disque, qui cassent le cercle parfait et
        donnent le mouvement.

   Chaque élément règle la nervosité de ses rubans : le feu crépite en zigzag,
   l'eau ondule, l'air s'effiloche. C'est ce paramètre — pas seulement la
   couleur — qui rend les six reconnaissables d'un coup d'œil.
   ========================================================================== */

/* deep = pourtour saturé, mid = corps, bright = rubans et cœur.
   `wobble` : amplitude du tremblement des rubans (0 = lisse, 1 = crépitant).
   `ribbons` : combien d'arcs enrobent la sphère.
   `drops` : étincelles rondes (gouttes) plutôt qu'éclats pointus. */
const ORB_STYLE = {
  fire:  { deep: '#c23a00', mid: '#ff8a1e', bright: '#fff0b8', ribbons: 7, wobble: 1.00, drops: false },
  water: { deep: '#0b3fa8', mid: '#39a8ff', bright: '#eaffff', ribbons: 6, wobble: 0.30, drops: true },
  air:   { deep: '#4a86c8', mid: '#9fd8ff', bright: '#ffffff', ribbons: 8, wobble: 0.55, drops: false },
  light: { deep: '#c07a00', mid: '#ffd23f', bright: '#fffbe0', ribbons: 7, wobble: 0.80, drops: false },
  earth: { deep: '#2f6b1e', mid: '#8fd44a', bright: '#f2ffcf', ribbons: 7, wobble: 0.45, drops: false },
  ether: { deep: '#5a1ea8', mid: '#b06bff', bright: '#f6e8ff', ribbons: 5, wobble: 0.25, drops: true },
};

const S = 160;              // côté de la texture
const C = S / 2;            // centre
const R = S * 0.335;        // rayon du corps de l'orbe

/* Générateur reproductible : deux appels successifs doivent rendre la même
   orbe, sinon un rechargement changerait l'aspect des projectiles. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Un ruban : arc elliptique tremblé, tracé point par point. */
function ribbon(g, rnd, style, tilt, squash, width, alpha) {
  const steps = 46;
  const phase = rnd() * Math.PI * 2;
  const amp = style.wobble * R * 0.14;

  g.beginPath();
  for (let i = 0; i <= steps; i++) {
    const t = (i / steps) * Math.PI * 2;
    /* Le tremblement bat plus vite que l'arc : c'est ce déphasage qui donne
       l'aspect vivant plutôt qu'une ellipse déformée régulièrement. */
    const w = Math.sin(t * 3 + phase) * amp + Math.sin(t * 7 - phase) * amp * 0.5;
    const rr = R * 0.96 + w;
    const x = Math.cos(t) * rr;
    const y = Math.sin(t) * rr * squash;
    const px = C + x * Math.cos(tilt) - y * Math.sin(tilt);
    const py = C + x * Math.sin(tilt) + y * Math.cos(tilt);
    if (i === 0) g.moveTo(px, py); else g.lineTo(px, py);
  }
  g.closePath();
  g.globalAlpha = alpha;
  g.lineWidth = width;
  g.strokeStyle = style.bright;
  g.stroke();
}

/** Dessine l'orbe d'un élément et rend le canvas. */
export function drawOrb(key, seed = 1) {
  const style = ORB_STYLE[key] || ORB_STYLE.ether;
  const rnd = rng(seed * 7919 + key.length * 131);

  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const g = cv.getContext('2d');

  /* --- 1. Halo : large, très doux, il déborde bien au-delà du corps. --- */
  const halo = g.createRadialGradient(C, C, R * 0.5, C, C, C);
  halo.addColorStop(0, hexA(style.mid, 0.55));
  halo.addColorStop(0.45, hexA(style.mid, 0.18));
  halo.addColorStop(1, hexA(style.mid, 0));
  g.fillStyle = halo;
  g.fillRect(0, 0, S, S);

  /* --- 2. Corps : dégradé décentré vers le haut-gauche. --- */
  const body = g.createRadialGradient(C - R * 0.34, C - R * 0.38, R * 0.06, C, C, R);
  body.addColorStop(0, style.bright);
  body.addColorStop(0.42, style.mid);
  body.addColorStop(1, style.deep);
  g.beginPath();
  g.arc(C, C, R, 0, Math.PI * 2);
  g.fillStyle = body;
  g.fill();

  /* --- 3. Rubans. En « lighter », les croisements saturent vers le blanc,
         ce qui imite une matière incandescente sans calcul d'éclairage. --- */
  g.globalCompositeOperation = 'lighter';
  g.lineCap = 'round';
  for (let i = 0; i < style.ribbons; i++) {
    const tilt = (i / style.ribbons) * Math.PI + rnd() * 0.5;
    const squash = 0.16 + rnd() * 0.5;
    ribbon(g, rnd, style, tilt, squash, 1.6 + rnd() * 2.6, 0.5 + rnd() * 0.4);
  }
  g.globalAlpha = 1;
  g.globalCompositeOperation = 'source-over';

  /* --- 4. Éclat spéculaire : un arc court, jamais un point rond — c'est ce
         qui fait lire une surface bombée et vernie. --- */
  g.beginPath();
  g.ellipse(C - R * 0.34, C - R * 0.40, R * 0.34, R * 0.17, -0.7, 0, Math.PI * 2);
  g.fillStyle = 'rgba(255,255,255,0.85)';
  g.fill();

  /* --- 5. Étincelles autour du disque. --- */
  g.fillStyle = style.bright;
  for (let i = 0; i < 16; i++) {
    const a = rnd() * Math.PI * 2;
    const d = R * (1.02 + rnd() * 0.55);
    const x = C + Math.cos(a) * d, y = C + Math.sin(a) * d;
    const s = R * (0.03 + rnd() * 0.06);
    g.globalAlpha = 0.35 + rnd() * 0.5;
    g.beginPath();
    if (style.drops) {
      g.ellipse(x, y, s, s * 1.5, a, 0, Math.PI * 2);
    } else {
      /* Éclat pointu : un losange étiré dans le sens de la fuite. */
      g.moveTo(x + Math.cos(a) * s * 2.4, y + Math.sin(a) * s * 2.4);
      g.lineTo(x + Math.cos(a + 1.57) * s, y + Math.sin(a + 1.57) * s);
      g.lineTo(x - Math.cos(a) * s * 1.2, y - Math.sin(a) * s * 1.2);
      g.lineTo(x + Math.cos(a - 1.57) * s, y + Math.sin(a - 1.57) * s);
    }
    g.fill();
  }
  g.globalAlpha = 1;

  return cv;
}

/** Halo seul, en niveaux de gris : teinté par le matériau du sprite, il sert
 *  à toutes les couleurs sans multiplier les textures. */
export function drawGlow(size = 128) {
  const cv = document.createElement('canvas');
  cv.width = cv.height = size;
  const g = cv.getContext('2d');
  const c = size / 2;
  const grad = g.createRadialGradient(c, c, 0, c, c, c);
  grad.addColorStop(0, 'rgba(255,255,255,0.95)');
  grad.addColorStop(0.25, 'rgba(255,255,255,0.42)');
  grad.addColorStop(0.6, 'rgba(255,255,255,0.10)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  return cv;
}

/** '#rrggbb' + alpha → 'rgba(...)'. */
function hexA(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}
