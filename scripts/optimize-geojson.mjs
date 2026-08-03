/* ============================================================================
   Optimisation des GeoJSON — quantification des coordonnées
   ----------------------------------------------------------------------------
   Natural Earth livre les contours avec 5 décimales, soit ~1 m de précision.
   La carte de progression affiche des régions entières sur quelques centaines
   de pixels : au-delà de 3 décimales (~110 m) rien n'est distinguable, et sur
   la carte du monde 2 décimales (~1,1 km) suffisent encore.

   On arrondit, puis on supprime les points consécutifs devenus identiques —
   c'est là que vient l'essentiel du gain sur les côtes très échantillonnées.
   Les anneaux gardent toujours au moins 4 points pour rester des polygones
   valides.

   Usage : node scripts/optimize-geojson.mjs [--dry]
   ========================================================================== */
import fs from 'node:fs';
import path from 'node:path';

const DRY = process.argv.includes('--dry');

/* `tolerance` est en degrés : 0.01° ≈ 1,1 km. Une région admin-1 s'affiche sur
   quelques centaines de pixels — un détail de 1 km y est sous-pixel. */
const TARGETS = [
  { dir: 'public/assets/maps/admin-1', decimals: 3, tolerance: 0.01 },
  { file: 'public/assets/maps/world-countries-110m.geojson', decimals: 2, tolerance: 0.02 },
];

/* Douglas-Peucker : garde les sommets qui portent la forme, jette ceux qui
   sont à moins de `tol` de la corde. C'est là qu'est le vrai gain — les côtes
   de Natural Earth sont échantillonnées bien plus finement que nécessaire. */
function simplifyRing(pts, tol) {
  if (pts.length <= 4) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;

  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [lo, hi] = stack.pop();
    if (hi - lo < 2) continue;
    const [ax, ay] = pts[lo], [bx, by] = pts[hi];
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;

    let far = -1, farD = tol;
    for (let i = lo + 1; i < hi; i++) {
      const [px, py] = pts[i];
      /* Distance point↔segment, dégénérescence incluse (a == b). */
      let d;
      if (len2 === 0) {
        d = Math.hypot(px - ax, py - ay);
      } else {
        let t = ((px - ax) * dx + (py - ay) * dy) / len2;
        t = Math.max(0, Math.min(1, t));
        d = Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
      }
      if (d > farD) { farD = d; far = i; }
    }
    if (far > 0) {
      keep[far] = 1;
      stack.push([lo, far], [far, hi]);
    }
  }

  const out = [];
  for (let i = 0; i < pts.length; i++) if (keep[i]) out.push(pts[i]);
  /* Sous 4 points l'anneau n'est plus un polygone : on rend l'original. */
  return out.length >= 4 ? out : pts;
}

/* Parcourt n'importe quelle imbrication de coordonnées GeoJSON (Point →
   MultiPolygon) sans se soucier du type : une position est un tableau dont le
   premier élément est un nombre. */
function quantize(coords, p, tol) {
  if (typeof coords[0] === 'number') {
    return [Math.round(coords[0] * p) / p, Math.round(coords[1] * p) / p];
  }
  const out = coords.map((c) => quantize(c, p, tol));

  /* Anneau de positions : simplification puis dédoublonnage des points
     consécutifs devenus identiques par arrondi. */
  if (out.length && typeof out[0][0] === 'number') {
    const simple = simplifyRing(out, tol);
    const dedup = [simple[0]];
    for (let i = 1; i < simple.length; i++) {
      const a = dedup[dedup.length - 1], b = simple[i];
      if (a[0] !== b[0] || a[1] !== b[1]) dedup.push(b);
    }
    /* L'anneau doit rester fermé : le dernier point rejoint le premier. */
    if (dedup.length >= 4) {
      const first = dedup[0], last = dedup[dedup.length - 1];
      if (first[0] !== last[0] || first[1] !== last[1]) dedup.push([first[0], first[1]]);
      return dedup;
    }
    return simple.length >= 4 ? simple : out;
  }
  return out;
}

let before = 0, after = 0, files = 0;

function run(file, decimals, tolerance) {
  const p = 10 ** decimals;
  const raw = fs.readFileSync(file, 'utf8');
  const json = JSON.parse(raw);
  for (const f of json.features || []) {
    if (f.geometry && f.geometry.coordinates) {
      f.geometry.coordinates = quantize(f.geometry.coordinates, p, tolerance);
    }
  }
  const out = JSON.stringify(json);
  before += raw.length;
  after += out.length;
  files++;
  if (!DRY) fs.writeFileSync(file, out);
}

for (const t of TARGETS) {
  if (t.file) { if (fs.existsSync(t.file)) run(t.file, t.decimals, t.tolerance); continue; }
  if (!fs.existsSync(t.dir)) continue;
  for (const f of fs.readdirSync(t.dir)) {
    if (f.endsWith('.geojson')) run(path.join(t.dir, f), t.decimals, t.tolerance);
  }
}

console.log(`${files} GeoJSON : ${(before / 1024 / 1024).toFixed(1)} Mo → ${(after / 1024 / 1024).toFixed(1)} Mo`
  + (DRY ? '  (simulation)' : ''));
