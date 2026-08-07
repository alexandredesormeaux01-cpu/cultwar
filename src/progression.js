/* ============================================================================
   Cult.io — Écran de progression (autonome)
   Porté depuis Mix-it : fond étoilé (GalaxyStarfield), globe Terre (CelGlobeMap),
   carte de niveaux (ProgressMap). Rendu 100% canvas/DOM, zéro dépendance.
   ========================================================================== */

import { NEIGHBORS, ISLAND_HOP_RADIUS } from './countryNeighbors.js';
import {
  SKILL_DEFS, SKILL_BRANCHES, getSkillLevel, getSkillPoints,
  canUpgradeSkill, upgradeSkill, isSkillUnlocked, awardConquestSkills,
  nextUpgradeCost, spentSkillPoints, WORLD_SKILL_BUDGET, treeCapacity,
  addXp, ensureLevelState, aiSpendSkillPoints, aiExpansionPower, xpToNext, POINTS_PER_LEVEL,
} from './skills.js';
import { soundEngine } from './soundEngine.js';

function playUIClick() {
  soundEngine.playUIClick();
}

const DEG = Math.PI / 180;
const GEOJSON_URL = 'assets/maps/world-countries-110m.geojson';
const SAVE_KEY = 'cultio_progress_v3';

/* -------- Libellés/format des effets de compétence (pour l'oracle) -------- */
const SKILL_EFFECT_LABELS = {
  influence: 'Attraction', grayContact: 'Contact des gris', grayConv: 'Conversion des gris',
  conv: 'Conversion', overwhelm: 'Bonus surnombre', contact: 'Accrochage', push: 'Poussée',
  resist: 'Résistance', knight: 'Chevaliers', knightRange: 'Aura chevalier',
  knightMax: 'Chevaliers empilables', flock: 'Fidèles au départ', formation: 'Formation',
  crowd: 'Rayon de foule', speedMax: 'Vitesse max', speedMin: 'Vitesse (masse)',
  leaderResp: 'Réactivité', boostSpeed: 'Vitesse sacrifice', boostDur: 'Durée sacrifice',
  boostPow: 'Puissance sacrifice', rallyDur: 'Durée ralliement', rallyCd: 'Recharge ralliement',
  sacCost: 'Coût du sacrifice', streakWin: 'Fenêtre de série', winShare: 'Seuil de victoire',
  killShake: 'Impact de mise à mort',
};
const SKILL_FLAT_KEYS = { flock: 'fidèle', knightMax: 'chevalier' };

function fmtSkillNum(n) {
  const r = Math.round(n * 10) / 10;
  return Number.isInteger(r) ? String(r) : r.toFixed(1).replace('.', ',');
}
function skillEffectValue(key, value, level) {
  if (SKILL_FLAT_KEYS[key]) {
    const unit = SKILL_FLAT_KEYS[key];
    const total = key === 'knightMax' ? Math.floor(level * value) : Math.round(level * value);
    return `+${total} ${unit}${Math.abs(total) > 1 ? 's' : ''}`;
  }
  const pct = level * value * 100;
  return `${pct >= 0 ? '+' : '−'}${fmtSkillNum(Math.abs(pct))} %`;
}
/** Résumé des bonus : cumulé au niveau actuel + valeur au niveau suivant. */
function skillEffectSummary(def, level) {
  const keys = Object.keys(def.perLevel || {});
  if (!keys.length) return null;
  const fmt = (lvl) => keys.map((k) => `${SKILL_EFFECT_LABELS[k] || k} ${skillEffectValue(k, def.perLevel[k], lvl)}`).join(' · ');
  return { current: level > 0 ? fmt(level) : null, next: level < def.max ? fmt(level + 1) : null };
}

/* -------- Leaders disponibles -------- */
const LEADERS = [
  {
    id: 'monk',
    name: 'Petit Moine',
    archetype: 'Guide Spirituel',
    desc: 'Un humble guide spirituel qui convertit par la paix, l\'empathie et la ferveur.',
    perk: '✨ Aura d\'attraction étendue (+15%)',
    color: '#ffe259',
    bgGradient: 'linear-gradient(135deg, rgba(255, 226, 89, 0.2), rgba(255, 179, 0, 0.08))',
    img: 'assets/monk_leader.webp',
    avatar: 'assets/monk_avatar.webp',
    stats: { vitesse: 75, conversion: 90, ferveur: 85 }
  },
  {
    id: 'sorcerer',
    name: 'Sombre Sorcier',
    archetype: 'Maître des Ombrages',
    desc: 'Un mystique encapuchonné dont la peinture violacée hante et souille la vallée.',
    perk: '🔮 Siphon de peinture accru (+20%)',
    color: '#c084fc',
    bgGradient: 'linear-gradient(135deg, rgba(192, 132, 252, 0.2), rgba(126, 34, 206, 0.08))',
    img: 'assets/sorcerer_leader.webp',
    avatar: 'assets/sorcerer_avatar.webp',
    stats: { vitesse: 70, conversion: 85, ferveur: 95 }
  },
  {
    id: 'nomad',
    name: 'Nomade du Désert',
    archetype: 'Traqueur des Dunes',
    desc: 'Un voyageur aguerri qui fend le sable et marque son territoire à vitesse fulgurante.',
    perk: '⚡ Agilité du désert (+20% Vitesse)',
    color: '#f97316',
    bgGradient: 'linear-gradient(135deg, rgba(249, 115, 22, 0.2), rgba(194, 65, 12, 0.08))',
    img: 'assets/nomad_leader.webp',
    avatar: 'assets/nomad_avatar.webp',
    stats: { vitesse: 95, conversion: 75, ferveur: 80 }
  },
  {
    id: 'amazon',
    name: 'Guerrière Amazone',
    archetype: 'Conquérante',
    desc: 'Une combattante indomptable qui revendique la vallée d\'un pas altier et impérieux.',
    perk: '🛡️ Impulsion de foule (+15% Ferveur)',
    color: '#06b6d4',
    bgGradient: 'linear-gradient(135deg, rgba(6, 182, 212, 0.2), rgba(14, 116, 144, 0.08))',
    img: 'assets/amazon_leader.webp',
    avatar: 'assets/amazon_avatar.webp',
    stats: { vitesse: 85, conversion: 80, ferveur: 90 }
  },
  {
    id: 'alien',
    name: 'Extraterrestre',
    archetype: 'Visiteur des Étoiles',
    desc: 'Un voyageur venu d\'ailleurs, son passage laisse une empreinte étrange et déroutante.',
    perk: '👽 Aura psychique (+10% Toutes stats)',
    color: '#a3e635',
    bgGradient: 'linear-gradient(135deg, rgba(163, 230, 53, 0.2), rgba(77, 124, 15, 0.08))',
    img: 'assets/alien_leader.webp',
    avatar: 'assets/alien_avatar.webp',
    stats: { vitesse: 78, conversion: 82, ferveur: 82 }
  },
  {
    id: 'chief',
    name: 'Chef des Nations',
    archetype: 'Gardien des Ancêtres',
    desc: 'Un chef vénéré des Premières Nations, sa présence sacrée honore la terre qu\'il foule.',
    perk: '🪶 Bénédiction ancestrale (+15% Conversion)',
    color: '#d97706',
    bgGradient: 'linear-gradient(135deg, rgba(217, 119, 6, 0.2), rgba(146, 64, 14, 0.08))',
    img: 'assets/chief_leader.webp',
    avatar: 'assets/chief_avatar.webp',
    stats: { vitesse: 72, conversion: 95, ferveur: 85 }
  },
];


/* -------- Terres du culte (mondes posés sur le globe) -------- */
let WORLDS = [
  { id: 0, iso: 'FRA', name: 'Vallée de la Genèse', lat: 46 * DEG, lon:   2 * DEG, color: '#ff2e7e', sym: '✦' },
  { id: 1, iso: 'EGY', name: 'Sables du Prophète',  lat: 26 * DEG, lon:  30 * DEG, color: '#ffb300', sym: '☀' },
  { id: 2, iso: 'RUS', name: 'Toundra des Élus',    lat: 62 * DEG, lon:  99 * DEG, color: '#00c8ff', sym: '☾' },
  { id: 3, iso: 'BRA', name: 'Jungles Ferventes',   lat: -5 * DEG, lon: -55 * DEG, color: '#22dd77', sym: '❖' },
  { id: 4, iso: 'AUS', name: 'Cendres du Sud',      lat:-25 * DEG, lon: 134 * DEG, color: '#ff5533', sym: '✚' },
];
let ISO_WORLD = { FRA: 0, EGY: 1, RUS: 2, BRA: 3, AUS: 4 };
/** Les 10 religions du globe (incluant le joueur) */
const CULTS = [
  { color: '#ff2e7e', name: 'Écarlate',  sym: '❤' },
  { color: '#00c8ff', name: 'Sélénie',   sym: '☾' },
  { color: '#ffb300', name: 'Hélion',    sym: '☀' },
  { color: '#22dd77', name: 'Sylvane',   sym: '🌿' },
  { color: '#8b5cf6', name: 'Occule',    sym: '👁' },
  { color: '#ff5533', name: 'Pyrrhée',   sym: '🔥' },
  { color: '#00ffcc', name: 'Thalasse',  sym: '🌊' },
  { color: '#ff7700', name: 'Aurore',    sym: '✶' },
  { color: '#3f51b5', name: 'Nyxar',     sym: '☯' },
  { color: '#ff4fd8', name: 'Specula',   sym: '✧' },
];
const NEUTRAL = '#8b93a7';   // zones non conquises (gris)

/* -------- Palette des terres (portée de globeLandPolygons.ts) -------- */
const BIOME_PALETTES = {
  desert:    { color: '#d97832', cliff: '#9a4a20' },
  nordic:    { color: '#2d6a52', cliff: '#1a4438' },
  tropical:  { color: '#2d8a38', cliff: '#1a5a28' },
  temperate: { color: '#5a9a40', cliff: '#3a6828' },
};
const TONES = {
  light:  { color: '#98b890', cliff: '#6a8a68' },
  medium: { color: '#7a9a72', cliff: '#5a7a58' },
  snow:   { color: '#e8f2f8', cliff: '#b0c4d0' },
};
const DESERT = ['AUS','EGY','DZA','SAU','IRQ','IRN','KAZ','MEX','ZAF','MAR','PER','PAK','LBY','SDN','TCD','NER','MLI','MRT'];
const NORDIC = ['CAN','RUS','GRL','NOR','SWE','FIN','ISL','ARG','CHL','MNG'];
const TROPIC = ['BRA','COL','IDN','THA','VNM','PHL','MYS','GHA','KEN','NGA','SEN','TZA','COD','AGO','VEN','BOL','IND'];
function countryBiome(id) {
  if (!id) return 'temperate';
  const c = id.toUpperCase();
  if (DESERT.includes(c)) return 'desert';
  if (NORDIC.includes(c)) return 'nordic';
  if (TROPIC.includes(c)) return 'tropical';
  return 'temperate';
}
function landColors(shape) {
  const c = shape.countryId?.toUpperCase();
  if (c === 'GRL' || c === 'ATA') return TONES.snow;
  return BIOME_PALETTES[countryBiome(shape.countryId)] || TONES.light;
}

/* ============================ Sauvegarde ============================ */
function loadSave() {
  try { return JSON.parse(localStorage.getItem(SAVE_KEY)) || {}; } catch { return {}; }
}
function persist(save) { localStorage.setItem(SAVE_KEY, JSON.stringify(save)); }
/** Étoiles obtenues pour (monde, niveau) : 0 = non joué. */
function levelStars(save, wid, lvl) { return (save[wid] && save[wid][lvl]) || 0; }
function completedCount(save, wid) {
  const w = save[wid] || {}; let n = 0;
  for (const k in w) if (w[k] > 0) n++;
  return n;
}
function worldUnlocked(save, wid) {
  return true;
}

/* ============================ Économie & Portails ============================ */
export function getSpiritsCount() {
  const save = loadSave();
  return save.spirits || 0;
}

export function addSpirits(amount) {
  if (!amount || amount <= 0) return getSpiritsCount();
  const save = loadSave();
  save.spirits = (save.spirits || 0) + Math.round(amount);
  persist(save);
  return save.spirits;
}

export function getCountryPortalState(iso, portalIndex) {
  const save = loadSave();
  const cp = (save.portals && save.portals[iso]) || { won: [], unlocked: [0] };
  const wonList = Array.isArray(cp.won) ? cp.won : [];
  const unlockedList = Array.isArray(cp.unlocked) ? cp.unlocked : [0];

  if (wonList.includes(portalIndex)) return 'won';
  if (unlockedList.includes(portalIndex) || portalIndex === 0) return 'unlocked';
  return 'locked';
}

export function recordPortalVictory(iso, portalIndex, spiritsGained = 0) {
  const save = loadSave();
  if (!save.portals) save.portals = {};
  if (!save.portals[iso]) save.portals[iso] = { won: [], unlocked: [0] };
  const cp = save.portals[iso];
  if (!cp.won.includes(portalIndex)) cp.won.push(portalIndex);
  const nextIdx = portalIndex + 1;
  if (!cp.unlocked.includes(nextIdx)) cp.unlocked.push(nextIdx);
  if (spiritsGained > 0) {
    save.spirits = (save.spirits || 0) + Math.round(spiritsGained);
  }
  persist(save);
  return { spirits: save.spirits || 0, won: cp.won, unlocked: cp.unlocked };
}

/* ============================ GeoJSON ============================ */
let SHAPES = null;
function ringFromCoords(coords) {
  const ring = [];
  const limit = coords.length > 1 ? coords.length - 1 : coords.length;
  for (let i = 0; i < limit; i++) {
    const p = coords[i];
    if (p) ring.push({ lon: p[0] * DEG, lat: p[1] * DEG });
  }
  return ring;
}
const ORIGINAL_WORLDS = [
  { id: 0, iso: 'FRA', name: 'Vallée de la Genèse', lat: 46 * DEG, lon:   2 * DEG, color: '#ff2e7e', sym: '✦' },
  { id: 1, iso: 'EGY', name: 'Sables du Prophète',  lat: 26 * DEG, lon:  30 * DEG, color: '#ffb300', sym: '☀' },
  { id: 2, iso: 'RUS', name: 'Toundra des Élus',    lat: 62 * DEG, lon:  99 * DEG, color: '#00c8ff', sym: '☾' },
  { id: 3, iso: 'BRA', name: 'Jungles Ferventes',   lat: -5 * DEG, lon: -55 * DEG, color: '#22dd77', sym: '❖' },
  { id: 4, iso: 'AUS', name: 'Cendres du Sud',      lat:-25 * DEG, lon: 134 * DEG, color: '#ff5533', sym: '✚' },
];

function parseGeo(data) {
  const shapes = [];
  const dynamicWorlds = [];
  const dynamicIsoWorld = {};
  const tempCentroids = {};

  data.features.forEach((f, fi) => {
    const props = f.properties || {};
    let id = props.ISO_A3 && props.ISO_A3 !== '-99' ? props.ISO_A3
           : props.ADM0_A3 && props.ADM0_A3 !== '-99' ? props.ADM0_A3 : `c${fi}`;
    const name = props.name || props.NAME || props.name_long || id;
    const pop = props.POP_EST || 1000000;
    const tone = ['light', 'medium', 'snow'][fi % 3];
    const g = f.geometry;
    if (!g) return;

    const rings = [];
    if (g.type === 'Polygon') {
      const r = g.coordinates.map(ringFromCoords);
      if (r[0] && r[0].length) {
        shapes.push({ countryId: id, tone, rings: r });
        rings.push(...r);
      }
    } else if (g.type === 'MultiPolygon') {
      g.coordinates.forEach((poly) => {
        const r = poly.map(ringFromCoords);
        if (r[0] && r[0].length) {
          shapes.push({ countryId: id, tone, rings: r });
          rings.push(...r);
        }
      });
    }

    if (rings.length > 0) {
      let sumLon = 0, sumLat = 0, cnt = 0;
      for (const ring of rings) {
        for (const p of ring) {
          sumLon += p.lon;
          sumLat += p.lat;
          cnt++;
        }
      }
      if (cnt > 0) {
        if (!tempCentroids[id]) {
          tempCentroids[id] = { lat: sumLat / cnt, lon: sumLon / cnt, name, pop };
        }
      }
    }
  });

  // Construit les mondes dynamiquement
  let index = 0;
  for (const id in tempCentroids) {
    const c = tempCentroids[id];
    const original = ORIGINAL_WORLDS.find(w => w.iso === id);
    const worldObj = {
      id: index,
      iso: id,
      name: c.name,
      lat: c.lat,
      lon: c.lon,
      color: original ? original.color : CULTS[index % CULTS.length].color,
      sym: original ? original.sym : CULTS[index % CULTS.length].sym,
      pop: c.pop
    };
    dynamicWorlds.push(worldObj);
    dynamicIsoWorld[id] = index;
    index++;
  }

  WORLDS = dynamicWorlds;
  ISO_WORLD = dynamicIsoWorld;

  return shapes;
}

function getFallbackRegions(iso) {
  if (!SHAPES) return [];
  // Collecte toutes les entrées SHAPES pour ce pays (une par polygone séparé)
  const entries = SHAPES.filter(s => s.countryId === iso);
  if (!entries.length) return [];

  const regions = [];
  let idx = 0;
  for (const entry of entries) {
    const outerRing = entry.rings[0];
    if (!outerRing || outerRing.length < 3) continue;
    regions.push({
      id: `${iso}-${idx}`,
      name: `Zone ${idx + 1}`,
      rings: [outerRing.map(pt => ({ lon: pt.lon / DEG, lat: pt.lat / DEG }))]
    });
    idx++;
  }

  // Si on n'a qu'un seul polygone, on le retourne tel quel (1 zone = tout le pays)
  return regions.length > 0 ? regions : [];
}
function subdivide(shapes, maxDeg = 2.5) {
  const maxDist = maxDeg * DEG;
  const sub = (pts) => {
    if (pts.length < 2) return pts;
    const out = [];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      out.push(a);
      const dLat = b.lat - a.lat;
      let dLon = b.lon - a.lon;
      if (dLon > Math.PI) dLon -= Math.PI * 2;
      if (dLon < -Math.PI) dLon += Math.PI * 2;
      const dist = Math.hypot(dLat, dLon);
      if (dist > maxDist) {
        const steps = Math.ceil(dist / maxDist);
        for (let s = 1; s < steps; s++) {
          const t = s / steps;
          out.push({ lat: a.lat + dLat * t, lon: a.lon + dLon * t });
        }
      }
    }
    return out;
  };
  return shapes.map((s) => ({ ...s, rings: s.rings.map(sub) }));
}
async function ensureShapes() {
  if (SHAPES) return SHAPES;
  const res = await fetch(GEOJSON_URL);
  if (!res.ok) throw new Error('GeoJSON introuvable');
  SHAPES = subdivide(parseGeo(await res.json()));
  return SHAPES;
}

/* point-in-polygon en coords sphériques (lat/lon radians) */
function pointInRing(lat, lon, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i].lon, yi = ring[i].lat, xj = ring[j].lon, yj = ring[j].lat;
    if (((yi > lat) !== (yj > lat)) && (lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}
function findCountryAt(lat, lon) {
  if (!SHAPES) return null;
  for (const s of SHAPES) {
    const outer = s.rings[0];
    if (!outer || !pointInRing(lat, lon, outer)) continue;
    let hole = false;
    for (let i = 1; i < s.rings.length; i++) if (pointInRing(lat, lon, s.rings[i])) { hole = true; break; }
    if (!hole) return s.countryId;
  }
  return null;
}
/** Clic écran -> lat/lon sur l'hémisphère visible (inverse de project). */
function screenToLatLon(px, py, cx, cy, R, rotY, rotX) {
  const nx = (px - cx) / R, ny = -(py - cy) / R;
  const d2 = nx * nx + ny * ny;
  if (d2 > 1) return null;
  const z2 = Math.sqrt(1 - d2), x2 = nx, y2 = ny;
  const y1 = y2 * Math.cos(rotX) + z2 * Math.sin(rotX);
  const z1 = -y2 * Math.sin(rotX) + z2 * Math.cos(rotX);
  const x0 = x2 * Math.cos(rotY) + z1 * Math.sin(rotY);
  const z0 = -x2 * Math.sin(rotY) + z1 * Math.cos(rotY);
  const lat = Math.asin(Math.max(-1, Math.min(1, y1)));
  const lon = Math.atan2(x0, z0);
  return { lat, lon };
}

/* ---- Régions internes d'un pays (admin-1) : les "zones" à conquérir ---- */
const regionCache = {};
async function loadRegions(iso) {
  if (regionCache[iso]) return regionCache[iso];
  try {
    const res = await fetch(`assets/maps/admin-1/${iso}.geojson`);
    if (!res.ok) throw new Error('regions introuvables');
    const data = await res.json();
    const regions = [];
    data.features.forEach((f, i) => {
      const name = (f.properties && f.properties.name) || `Zone ${i + 1}`;
      const g = f.geometry;
      if (!g) return;
      const polys = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
      // ne garde que le plus grand anneau extérieur de chaque polygone (zones lisibles)
      const rings = [];
      for (const poly of polys) {
        const outer = poly[0];
        if (outer && outer.length > 2) rings.push(outer.map((p) => ({ lon: p[0], lat: p[1] })));
      }
      if (!rings.length) return;
      regions.push({ id: `${iso}-${i}`, name, rings });
    });
    const zones = clusterRegions(iso, filterMainland(regions));
    regionCache[iso] = zones;
    return zones;
  } catch (err) {
    const fallback = getFallbackRegions(iso);
    if (fallback && fallback.length > 0) {
      regionCache[iso] = fallback;
      return fallback;
    }
    throw new Error('regions introuvables');
  }
}
/* Regroupe les régions admin-1 en 8–15 zones plus larges (k-means déterministe sur les centroïdes). */
function ringBBox(ring) {
  let a = Infinity, b = -Infinity, c = Infinity, d = -Infinity;
  for (const p of ring) { if (p.lon < a) a = p.lon; if (p.lon > b) b = p.lon; if (p.lat < c) c = p.lat; if (p.lat > d) d = p.lat; }
  return { minLon: a, maxLon: b, minLat: c, maxLat: d };
}
function clusterRegions(iso, regions) {
  const n = regions.length;
  if (n <= 15) { // déjà assez peu de zones : on garde tel quel
    return regions.map((r, k) => ({ id: `${iso}-z${k}`, name: r.name, rings: r.rings }));
  }
  const K = Math.min(n, Math.max(8, Math.min(15, Math.round(n / 8))));
  const cs = regions.map(centroidOf);
  const lat0 = cs.reduce((s, c) => s + c.lat, 0) / n;
  const kx = Math.cos(lat0 * DEG);
  const pts = cs.map((c) => ({ x: c.lon * kx, y: c.lat }));
  // init déterministe : tri par x puis y, K centroïdes régulièrement espacés (zones stables entre sessions)
  const order = [...pts.keys()].sort((a, b) => pts[a].x - pts[b].x || pts[a].y - pts[b].y);
  let cent = [];
  for (let k = 0; k < K; k++) cent.push({ ...pts[order[Math.floor((k + 0.5) * n / K)]] });
  const assign = new Array(n).fill(0);
  for (let it = 0; it < 40; it++) {
    let changed = false;
    for (let i = 0; i < n; i++) {
      let best = 0, bd = Infinity;
      for (let k = 0; k < K; k++) { const dx = pts[i].x - cent[k].x, dy = pts[i].y - cent[k].y; const dd = dx * dx + dy * dy; if (dd < bd) { bd = dd; best = k; } }
      if (assign[i] !== best) { assign[i] = best; changed = true; }
    }
    const sx = new Array(K).fill(0), sy = new Array(K).fill(0), cnt = new Array(K).fill(0);
    for (let i = 0; i < n; i++) { sx[assign[i]] += pts[i].x; sy[assign[i]] += pts[i].y; cnt[assign[i]]++; }
    for (let k = 0; k < K; k++) if (cnt[k]) cent[k] = { x: sx[k] / cnt[k], y: sy[k] / cnt[k] };
    if (!changed && it > 0) break;
  }
  const zones = [];
  for (let k = 0; k < K; k++) {
    const members = regions.filter((_, i) => assign[i] === k);
    if (!members.length) continue;
    const rings = [];
    for (const m of members) for (const ring of m.rings) rings.push(ring);
    // nom = la région la plus étendue du groupe (plus reconnaissable)
    let name = members[0].name, bestA = -1;
    for (const m of members) { const b = ringBBox(m.rings[0]); const a = (b.maxLon - b.minLon) * (b.maxLat - b.minLat); if (a > bestA) { bestA = a; name = m.name; } }
    zones.push({ id: `${iso}-z${zones.length}`, name, rings });
  }
  return zones;
}
/* Écarte les exclaves lointaines (outre-mer) pour cadrer la masse principale. */
function centroidOf(r) { let sx = 0, sy = 0, n = 0; for (const p of r.rings[0]) { sx += p.lon; sy += p.lat; n++; } return { lon: sx / n, lat: sy / n }; }
function median(a) { const b = [...a].sort((x, y) => x - y); const m = b.length >> 1; return b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2; }
function filterMainland(regions) {
  if (regions.length < 5) return regions;
  const cs = regions.map(centroidOf);
  const mlon = median(cs.map((c) => c.lon)), mlat = median(cs.map((c) => c.lat));
  const madLon = median(cs.map((c) => Math.abs(c.lon - mlon))) || 1;
  const madLat = median(cs.map((c) => Math.abs(c.lat - mlat))) || 1;
  const tolLon = Math.max(madLon * 3.5, 8), tolLat = Math.max(madLat * 3.5, 8);
  return regions.filter((r, i) => Math.abs(cs[i].lon - mlon) <= tolLon && Math.abs(cs[i].lat - mlat) <= tolLat);
}

/* ============================ Fond étoilé ============================ */
function seeded(seed) {
  const x = Math.sin(seed * 127.1 + seed * 311.7) * 43758.5453;
  return x - Math.floor(x);
}
/* -------- Nuages Cel-Shaded de Périmètre (Banques Vectorielles Unifiées) -------- */
function drawStylizedCelCloud(ctx, x, y, scale, flipX = false, opacity = 1, variant = 0, dpr = 1) {
  ctx.save();
  ctx.translate(x, y);
  const s = scale * dpr * 0.90;
  if (flipX) ctx.scale(-s, s); else ctx.scale(s, s);
  ctx.globalAlpha = opacity;

  const outlineCol = '#090d16'; // Contour encre noir cel-shading net
  const shadowCol = '#bae6fd';  // Ombre cyan pastel toon
  const baseCol = '#ffffff';    // Blanc pur

  // Définition des tracés vectoriels extérieurs unifiés (Continuous Outer Path)
  const buildPath = (c) => {
    c.beginPath();
    if (variant === 0) {
      // Banque de 3 grands dômes
      c.moveTo(-50, 10);
      c.arc(-30, -4, 18, Math.PI * 0.85, Math.PI * 1.75);
      c.arc(0, -20, 24, Math.PI * 1.1, Math.PI * 1.88);
      c.arc(30, -4, 18, Math.PI * 1.25, Math.PI * 0.15);
      c.quadraticCurveTo(48, 14, 25, 14);
      c.lineTo(-25, 14);
      c.quadraticCurveTo(-48, 14, -50, 10);
    } else if (variant === 1) {
      // Banque étirée de 4 dômes
      c.moveTo(-65, 12);
      c.arc(-42, -2, 16, Math.PI * 0.85, Math.PI * 1.75);
      c.arc(-15, -22, 22, Math.PI * 1.1, Math.PI * 1.85);
      c.arc(18, -16, 18, Math.PI * 1.15, Math.PI * 1.9);
      c.arc(45, -2, 15, Math.PI * 1.25, Math.PI * 0.15);
      c.quadraticCurveTo(62, 15, 40, 15);
      c.lineTo(-40, 15);
      c.quadraticCurveTo(-62, 15, -65, 12);
    } else {
      // Banque compacte de 2 dômes
      c.moveTo(-38, 8);
      c.arc(-18, -5, 15, Math.PI * 0.85, Math.PI * 1.75);
      c.arc(10, -15, 20, Math.PI * 1.1, Math.PI * 0.15);
      c.quadraticCurveTo(35, 12, 15, 12);
      c.lineTo(-15, 12);
      c.quadraticCurveTo(-35, 12, -38, 8);
    }
    c.closePath();
  };

  // 1. Ombre cyan pastel portée décalée sous le nuage
  ctx.save();
  ctx.translate(0, 4);
  ctx.fillStyle = shadowCol;
  buildPath(ctx);
  ctx.fill();
  ctx.restore();

  // 2. Corps principal blanc pur
  ctx.fillStyle = baseCol;
  buildPath(ctx);
  ctx.fill();

  // 3. Ombre toon interne découpée sur la moitié inférieure
  ctx.save();
  buildPath(ctx);
  ctx.clip();
  ctx.fillStyle = 'rgba(186, 230, 253, 0.65)';
  ctx.fillRect(-80, 2, 160, 40);
  ctx.restore();

  // 4. Contour noir extérieur continu à l'encre (SANS croisement de cercles internes)
  ctx.strokeStyle = outlineCol;
  ctx.lineWidth = 2.6;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  buildPath(ctx);
  ctx.stroke();

  // 5. Amorces de volutes internes discrètes aux jonctions de dômes
  ctx.beginPath();
  if (variant === 0) {
    ctx.arc(-15, -4, 8, Math.PI * 0.4, Math.PI * 1.05); ctx.stroke();
    ctx.arc(15, -4, 8, Math.PI * 0.0, Math.PI * 0.65); ctx.stroke();
  } else if (variant === 1) {
    ctx.arc(-28, -4, 8, Math.PI * 0.4, Math.PI * 1.05); ctx.stroke();
    ctx.arc(2, -6, 8, Math.PI * 0.3, Math.PI * 0.95); ctx.stroke();
  } else {
    ctx.arc(-4, -2, 6, Math.PI * 0.35, Math.PI * 1.05); ctx.stroke();
  }

  ctx.restore();
}

function createStarfield(canvas) {
  const ctx = canvas.getContext('2d', { alpha: true });
  let stars = [], shooting = [], nextShoot = 0, raf = 0, W = 0, H = 0;
  const TINT = { inner: '#818cf8', outer: '#4338ca', arm: '#6366f1' };
  const hex = (h) => { h = h.replace('#',''); return { r: parseInt(h.slice(0,2),16), g: parseInt(h.slice(2,4),16), b: parseInt(h.slice(4,6),16) }; };
  const rgba = (h, a) => { const c = hex(h); return `rgba(${c.r},${c.g},${c.b},${a})`; };

  function resize() {
    const dpr = Math.min(devicePixelRatio || 1, 1.5);
    W = canvas.width = Math.round(innerWidth * dpr);
    H = canvas.height = Math.round(innerHeight * dpr);
    canvas.style.width = innerWidth + 'px';
    canvas.style.height = innerHeight + 'px';
    const count = Math.min(520, Math.floor((W * H) / 6400));
    stars = Array.from({ length: count }, (_, i) => ({
      x: seeded(i * 3 + 1) * W, y: seeded(i * 3 + 2) * H,
      size: seeded(i * 3 + 3) * 1.8 + 0.3,
      opacity: seeded(i * 7) * 0.6 + 0.2,
      tw: seeded(i * 11) * 2 + 0.5, ph: seeded(i * 13) * Math.PI * 2,
    }));
  }

  let last = 0;
  const FPS = 30;
  function draw(now) {
    raf = requestAnimationFrame(draw);
    if (now - last < 1000 / FPS) return;
    last = now;
    ctx.clearRect(0, 0, W, H);

    const CARTOON_SKY = false;
    if (CARTOON_SKY) {
      // 1. Dégradé de Ciel Bleu Cel-Shaded Vibrant
      const skyGrad = ctx.createLinearGradient(0, 0, 0, H);
      skyGrad.addColorStop(0, '#38bdf8');    // Cyan / bleu ciel lumineux en haut
      skyGrad.addColorStop(0.45, '#0284c7'); // Bleu roi céleste au centre
      skyGrad.addColorStop(0.85, '#0369a1'); // Bleu océan profond
      skyGrad.addColorStop(1, '#0c4a6e');    // Bleu nuit horizon
      ctx.fillStyle = skyGrad;
      ctx.fillRect(0, 0, W, H);

      // 2. Halo de Soleil & Rayons Cel-Shaded en haut à gauche
      const sunGrad = ctx.createRadialGradient(W * 0.2, H * 0.15, 0, W * 0.2, H * 0.15, Math.min(W, H) * 0.65);
      sunGrad.addColorStop(0, 'rgba(255, 255, 255, 0.55)');
      sunGrad.addColorStop(0.25, 'rgba(224, 242, 254, 0.30)');
      sunGrad.addColorStop(0.65, 'rgba(56, 189, 248, 0.12)');
      sunGrad.addColorStop(1, 'rgba(56, 189, 248, 0)');
      ctx.fillStyle = sunGrad;
      ctx.fillRect(0, 0, W, H);

      // 3. Nuages d'arrière-plan vaporeux
      const t = now / 1000;
      const bgClouds = [
        { x: ((W * 0.15 + t * 14) % (W + 280)) - 140, y: H * 0.18, scale: 0.85, variant: 0, opacity: 0.85 },
        { x: ((W * 0.70 + t * 18) % (W + 280)) - 140, y: H * 0.24, scale: 0.70, variant: 1, opacity: 0.75 },
        { x: ((W * 0.42 + t * 10) % (W + 280)) - 140, y: H * 0.75, scale: 0.75, variant: 2, opacity: 0.70 },
        { x: ((W * 0.85 + t * 12) % (W + 280)) - 140, y: H * 0.82, scale: 0.60, variant: 0, opacity: 0.65 }
      ];
      for (const c of bgClouds) {
        drawStylizedCelCloud(ctx, c.x, c.y, c.scale, false, c.opacity, c.variant, dprScale());
      }
    } else {
      // Fond cosmique + nébuleuses (Rendu original conservé)
      const bg = ctx.createRadialGradient(W*0.5, H*0.45, 0, W*0.5, H*0.5, W*0.75);
      bg.addColorStop(0, rgba(TINT.inner, 0.20));
      bg.addColorStop(0.4, rgba(TINT.outer, 0.12));
      bg.addColorStop(1, 'rgb(3,8,16)');
      ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);
      for (const [cx, cy, rr, col, al] of [
        [0.3, 0.35, 0.25, TINT.inner, 0.11], [0.7, 0.6, 0.2, TINT.arm, 0.09], [0.5, 0.85, 0.35, TINT.outer, 0.06],
      ]) {
        const n = ctx.createRadialGradient(W*cx, H*cy, 0, W*cx, H*cy, W*rr);
        n.addColorStop(0, rgba(col, al)); n.addColorStop(1, 'transparent');
        ctx.fillStyle = n; ctx.fillRect(0, 0, W, H);
      }
      const t = now / 1000;
      for (const s of stars) {
        const tw = 0.5 + 0.5 * Math.sin(t * s.tw + s.ph);
        const a = s.opacity * (0.4 + tw * 0.6);
        ctx.beginPath(); ctx.arc(s.x, s.y, s.size, 0, 7);
        ctx.fillStyle = `rgba(220,230,255,${a})`; ctx.fill();
        if (s.size > 1.4 && tw > 0.85) {
          ctx.beginPath(); ctx.arc(s.x, s.y, s.size * 2.5, 0, 7);
          ctx.fillStyle = `rgba(180,200,255,${a * 0.15})`; ctx.fill();
        }
      }
      if (now > nextShoot) {
        const sx = seeded(now) * W * 0.8 + W * 0.1, sy = seeded(now + 1) * H * 0.4;
        const ang = Math.PI / 4 + seeded(now + 2) * 0.3, sp = 7 + seeded(now + 3) * 9;
        shooting.push({ x: sx, y: sy, vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp, life: 0, max: 40 + seeded(now + 4) * 30, len: 60 + seeded(now + 5) * 80 });
        nextShoot = now + 3000 + seeded(now + 6) * 5000;
      }
      shooting = shooting.filter((s) => {
        s.x += s.vx; s.y += s.vy; s.life++;
        const pr = s.life / s.max; if (pr >= 1) return false;
        const fade = 1 - pr, sp = Math.hypot(s.vx, s.vy) || 1;
        const tx = s.x - (s.vx / sp) * s.len, ty = s.y - (s.vy / sp) * s.len;
        const grad = ctx.createLinearGradient(tx, ty, s.x, s.y);
        grad.addColorStop(0, 'rgba(200,220,255,0)');
        grad.addColorStop(0.6, `rgba(200,220,255,${fade * 0.5})`);
        grad.addColorStop(1, `rgba(255,255,255,${fade * 0.9})`);
        ctx.beginPath(); ctx.moveTo(tx, ty); ctx.lineTo(s.x, s.y);
        ctx.strokeStyle = grad; ctx.lineWidth = 1.5 * dprScale(); ctx.stroke();
        ctx.beginPath(); ctx.arc(s.x, s.y, 1.5 * dprScale(), 0, 7);
        ctx.fillStyle = `rgba(255,255,255,${fade})`; ctx.fill();
        return true;
      });
    }
  }
  const dprScale = () => Math.min(devicePixelRatio || 1, 1.5);
  resize();
  addEventListener('resize', resize);
  raf = requestAnimationFrame(draw);
  return { stop() { cancelAnimationFrame(raf); removeEventListener('resize', resize); } };
}

const imgCache = {};
function getCachedImage(src, callback) {
  if (imgCache[src]) {
    return imgCache[src].loaded ? imgCache[src].img : null;
  }
  const img = new Image();
  imgCache[src] = { img, loaded: false };
  img.onload = () => {
    imgCache[src].loaded = true;
    if (callback) callback();
  };
  img.src = src;
  return null;
}

/* ============================ Globe ============================ */
function createGlobe(canvas, opts) {
  const ctx = canvas.getContext('2d');
  let W = 0, H = 0, R = 0, cx = 0, cy = 0, dpr = 1, zoom = 1.0;
  const ZOOM_MIN = 0.65, ZOOM_MAX = 7.0;   // zoom bien plus ample sur mobile
  const TILT_MAX = 1.35;                    // ~77° de bascule verticale max
  const DEFAULT_TILT = 0.15;               // légère inclinaison de départ
  let rotY = WORLDS[0].lon, rotX = DEFAULT_TILT;
  let targetY = null, targetX = null, targetZoom = null;
  let velY = 0, velX = 0, dragging = false, moved = 0;
  let lastX = 0, lastY = 0, lastMove = 0;
  let accSet = null, accT = 0;          // cache des pays accessibles (surbrillance)
  const pinScreen = []; // {world, x, y, visible}
  const clampTilt = (v) => Math.max(-TILT_MAX, Math.min(TILT_MAX, v));
  function applyZoom() { R = Math.min(W, H) * 0.42 * zoom; }
  function setZoom(z) { zoom = Math.min(Math.max(z, ZOOM_MIN), ZOOM_MAX); applyZoom(); }

  function resize() {
    dpr = Math.min(devicePixelRatio || 1, 1.5);
    const rect = canvas.getBoundingClientRect();
    const cssW = Math.max(1, rect.width || canvas.clientWidth || innerWidth);
    const cssH = Math.max(1, rect.height || canvas.clientHeight || innerHeight);
    W = canvas.width = Math.round(cssW * dpr);
    H = canvas.height = Math.round(cssH * dpr);
    const baseR = Math.min(W, H) * 0.42;
    R = baseR * zoom;
    cx = W / 2; cy = H / 2;
  }

  const ORBITING_CLOUDS = [
    { lat: 0.20, lon: 0.4, alt: 1.28, scale: 0.85, speed: 0.00030, variant: 0, flip: false },
    { lat: -0.30, lon: 2.2, alt: 1.34, scale: 0.95, speed: 0.00024, variant: 1, flip: true },
    { lat: 0.45, lon: 3.9, alt: 1.25, scale: 0.75, speed: 0.00035, variant: 2, flip: false },
    { lat: -0.15, lon: 5.5, alt: 1.38, scale: 0.90, speed: 0.00022, variant: 0, flip: true }
  ];

  function project(lat, lon, alt = 1.0) {
    const rAlt = R * alt;
    const x0 = Math.cos(lat) * Math.sin(lon), y0 = Math.sin(lat), z0 = Math.cos(lat) * Math.cos(lon);
    const x1 = x0 * Math.cos(rotY) - z0 * Math.sin(rotY), z1 = x0 * Math.sin(rotY) + z0 * Math.cos(rotY);
    const y2 = y0 * Math.cos(rotX) - z1 * Math.sin(rotX), z2 = y0 * Math.sin(rotX) + z1 * Math.cos(rotX);
    return { x: cx + x1 * rAlt, y: cy - y2 * rAlt, z: z2 };
  }
  function interpHorizon(a, b) { const t = a.z / (a.z - b.z); return { x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y), z: 0 }; }
  function clipRing(pts) {
    const n = pts.length;
    if (n < 3) return [];
    if (pts.every((p) => p.z < -0.02)) return [];
    let start = 0;
    for (let i = 0; i < n; i++) if (pts[i].z < -0.02) { start = i; break; }
    const res = []; let seg = [];
    for (let j = 0; j < n + 1; j++) {
      const a = pts[(start + j) % n], b = pts[(start + j + 1) % n];
      const av = a.z >= -0.02, bv = b.z >= -0.02;
      if (av) seg.push(a);
      if (av && !bv) { seg.push(interpHorizon(a, b)); if (seg.length >= 3) res.push(seg); seg = []; }
      else if (!av && bv) seg = [interpHorizon(a, b)];
    }
    if (seg.length >= 3) res.push(seg);
    return res;
  }

  function render() {
    const save = loadSave();
    ctx.clearRect(0, 0, W, H);
    
    // Toggle de style : passer à false pour retrouver le rendu original immédiatement
    const CARTOON_STYLE = true;

    if (CARTOON_STYLE) {
      // ==================== RENDU CEL-SHADED / CARTOON ====================
      
      // 1. Halo d'atmosphère cel-shaded (2 anneaux concentriques néon/cyan à bordures franches)
      ctx.fillStyle = 'rgba(56, 189, 248, 0.18)';
      ctx.beginPath(); ctx.arc(cx, cy, R * 1.15, 0, Math.PI * 2); ctx.fill();
      
      ctx.fillStyle = 'rgba(56, 189, 248, 0.35)';
      ctx.beginPath(); ctx.arc(cx, cy, R * 1.05, 0, Math.PI * 2); ctx.fill();

      ctx.save();
      ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.clip();

      // 3. Océan Cel-Shaded (3 zones de couleur franches, ombres & reflets toon)
      // Base océan bleu roi toon
      ctx.fillStyle = '#2563eb';
      ctx.fillRect(cx - R - 4, cy - R - 4, (R + 4) * 2, (R + 4) * 2);

      // Ombre douce bas-droit (bleu marine cel-shade)
      ctx.fillStyle = '#1d4ed8';
      ctx.beginPath();
      ctx.arc(cx + R * 0.22, cy + R * 0.22, R * 0.95, 0, Math.PI * 2);
      ctx.fill();

      // Ombre subtile bordure
      ctx.fillStyle = '#1e3a8a';
      ctx.beginPath();
      ctx.arc(cx + R * 0.35, cy + R * 0.35, R * 0.88, 0, Math.PI * 2);
      ctx.fill();

      // Zone principale de lumière cel-shade (bleu ciel lumineux)
      ctx.fillStyle = '#3b82f6';
      ctx.beginPath();
      ctx.arc(cx - R * 0.12, cy - R * 0.12, R * 0.85, 0, Math.PI * 2);
      ctx.fill();

      // Reflet bright cel-band en haut à gauche (cyan cartoon)
      ctx.fillStyle = '#60a5fa';
      ctx.beginPath();
      ctx.arc(cx - R * 0.35, cy - R * 0.35, R * 0.62, 0, Math.PI * 2);
      ctx.fill();

      // Reflet glossy spot style comic (spot blanc pur avec bordure franche)
      ctx.fillStyle = 'rgba(255, 255, 255, 0.65)';
      ctx.beginPath();
      ctx.ellipse(cx - R * 0.45, cy - R * 0.45, R * 0.18, R * 0.10, -Math.PI / 4, 0, Math.PI * 2);
      ctx.fill();

      // 5. Méridiens & Parallèles (Grille toon dessinée)
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.22)'; 
      ctx.lineWidth = 1.2 * dpr;
      for (let lat = -60; lat <= 60; lat += 30) {
        ctx.beginPath(); let first = true;
        for (let lon = -180; lon <= 180; lon += 8) { 
          const p = project(lat*DEG, lon*DEG); 
          if (p.z < 0) { first = true; continue; } 
          first ? (ctx.moveTo(p.x,p.y), first=false) : ctx.lineTo(p.x,p.y); 
        }
        ctx.stroke();
      }
      for (let lon = -180; lon < 180; lon += 30) {
        ctx.beginPath(); let first = true;
        for (let lat = -85; lat <= 85; lat += 8) { 
          const p = project(lat*DEG, lon*DEG); 
          if (p.z < 0) { first = true; continue; } 
          first ? (ctx.moveTo(p.x,p.y), first=false) : ctx.lineTo(p.x,p.y); 
        }
        ctx.stroke();
      }

      // 6. Terres & Pays avec contours à l'encre cel-shading (Ink Outlines)
      if (SHAPES) {
        const polys = [];
        for (const shape of SHAPES) {
          const clipped = [];
          for (const ring of shape.rings) {
            const proj = ring.map((pt) => project(pt.lat, pt.lon));
            for (const sub of clipRing(proj)) clipped.push(sub);
          }
          if (!clipped.length) continue;
          const outer = clipped[0];
          const avgZ = outer.reduce((s, p) => s + p.z, 0) / outer.length;
          polys.push({ rings: clipped, col: landColors(shape), countryId: shape.countryId, avgZ });
        }
        polys.sort((a, b) => a.avgZ - b.avgZ);

        const nowMs = performance.now();
        if (!accSet || nowMs - accT > 400) {
          accSet = new Set();
          for (const w of WORLDS) {
            if (w.iso === save.startIso || canEnterCountry(save, w.iso)) accSet.add(w.iso);
          }
          accT = nowMs;
        }
        const accessible = accSet;
        const hlPolys = [];
        const fogPolys = [];

        for (const poly of polys) {
          let fillStyle = poly.col.color;
          let isAccessible = false;
          let discovered = true;
          if (poly.countryId && ISO_WORLD[poly.countryId] !== undefined) {
            discovered = isDiscovered(save, poly.countryId);
            if (discovered) {
              const w = WORLDS[ISO_WORLD[poly.countryId]];
              const rel = getWorldReligion(save, w);
              fillStyle = rel.color;
              isAccessible = accessible.has(poly.countryId);
            } else {
              fillStyle = '#1e293b'; // Brouillard slate sombre toon
            }
          }

          // Remplissage couleur vive pop du pays
          ctx.fillStyle = fillStyle;
          for (const ring of poly.rings) {
            ctx.beginPath();
            ring.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y));
            ctx.closePath(); 
            ctx.fill();
          }

          // Contour à l'encre noir cel-shading sur les côtes et frontières
          ctx.strokeStyle = '#090d16';
          ctx.lineWidth = 1.6 * dpr;
          ctx.lineJoin = 'round';
          ctx.lineCap = 'round';
          for (const ring of poly.rings) {
            ctx.beginPath();
            ring.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y));
            ctx.closePath(); 
            ctx.stroke();
          }

          if (isAccessible) hlPolys.push(poly);
          if (!discovered) fogPolys.push(poly);
        }

        // Voile Trame toon sur les terres inexplorées
        if (fogPolys.length) {
          ctx.save();
          ctx.fillStyle = '#0f172a';
          ctx.globalAlpha = 0.40;
          for (const poly of fogPolys) {
            for (const ring of poly.rings) {
              ctx.beginPath();
              ring.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y));
              ctx.closePath(); 
              ctx.fill();
            }
          }
          ctx.restore();
        }

        // Surbrillance Cel-Shading des pays jouables : double contour néon/jaune comics
        if (hlPolys.length) {
          const pulse = 0.55 + 0.45 * Math.sin(performance.now() * 0.005);
          ctx.save();
          ctx.lineJoin = 'round';
          ctx.lineCap = 'round';
          
          // Tracé néon jaune/doré vibrant
          ctx.strokeStyle = '#fbbf24';
          ctx.lineWidth = (3.0 + pulse * 1.5) * dpr;
          for (const poly of hlPolys) {
            for (const ring of poly.rings) {
              ctx.beginPath();
              ring.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y));
              ctx.closePath(); 
              ctx.stroke();
            }
          }
          ctx.restore();
        }
      }
      ctx.restore(); // fin du clip de la sphère

      // 7. Contour à l'encre noir épais autour du globe complet (Globe Ink Outline)
      ctx.save();
      ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2);
      ctx.lineWidth = 4.2 * dpr;
      ctx.strokeStyle = '#090d16';
      ctx.stroke();

      // Trait interne de contour cyan lumineux
      ctx.lineWidth = 1.6 * dpr;
      ctx.strokeStyle = 'rgba(56, 189, 248, 0.75)';
      ctx.stroke();
      ctx.restore();



      // 9. Pins des Mondes - Style Comic / Cartoon Badges
      pinScreen.length = 0;
      const activeWorlds = WORLDS.filter(w => {
        if (!isDiscovered(save, w.iso)) return false;
        if (w.iso === save.startIso) return true;
        return canEnterCountry(save, w.iso);
      });
      for (const w of activeWorlds) {
        const p = project(w.lat, w.lon);
        const visible = p.z > 0.02;
        pinScreen.push({ world: w, x: p.x, y: p.y, visible });
        if (!visible) continue;
        const rel = getWorldReligion(save, w);
        const unlocked = worldUnlocked(save, w.id);
        const rr = 10 * dpr;

        ctx.save();
        // Ombre portée décalée style comic (drop shadow noir net)
        ctx.fillStyle = '#090d16';
        ctx.beginPath();
        ctx.arc(p.x + 2.5 * dpr, p.y + 3 * dpr, rr * 1.05, 0, Math.PI * 2);
        ctx.fill();

        // Pulsation comic pour les mondes accessibles/débloqués
        if (unlocked) {
          const pulsePin = 1 + 0.15 * Math.sin(performance.now() * 0.006 + w.id);
          ctx.beginPath();
          ctx.arc(p.x, p.y, rr * 1.35 * pulsePin, 0, Math.PI * 2);
          ctx.fillStyle = rel.color + '44';
          ctx.fill();
          ctx.strokeStyle = rel.color;
          ctx.lineWidth = 1.5 * dpr;
          ctx.stroke();
        }

        // Pastille centrale avec contour noir épais (Ink ring)
        ctx.beginPath(); 
        ctx.arc(p.x, p.y, rr, 0, Math.PI * 2);
        ctx.fillStyle = unlocked ? rel.color : '#475569';
        ctx.fill(); 
        ctx.lineWidth = 2.8 * dpr; 
        ctx.strokeStyle = '#090d16'; 
        ctx.stroke();

        // Anneau intérieur blanc net
        ctx.lineWidth = 1.2 * dpr;
        ctx.strokeStyle = '#ffffff';
        ctx.stroke();

        // Symbole ou cadenas
        ctx.globalAlpha = 1;
        ctx.fillStyle = '#fff'; 
        ctx.textAlign = 'center'; 
        ctx.textBaseline = 'middle';
        ctx.font = `bold ${12 * dpr}px sans-serif`;

        if (unlocked) {
          if (rel.sym.startsWith('data:image/') || rel.sym.startsWith('http')) {
            const img = getCachedImage(rel.sym, render);
            if (img) {
              ctx.save();
              ctx.beginPath();
              ctx.arc(p.x, p.y, rr * 0.82, 0, Math.PI * 2);
              ctx.clip();
              ctx.drawImage(img, p.x - rr * 0.82, p.y - rr * 0.82, rr * 1.64, rr * 1.64);
              ctx.restore();
            }
          } else {
            ctx.fillText(rel.sym, p.x, p.y + dpr);
          }
        } else {
          ctx.fillText('🔒', p.x, p.y + dpr);
        }
        ctx.restore();
      }
    } else {
      // --- ANCIEN RENDU STANDARD (POUR ROLLBACK RAPIDE SANS RIEN BRISER) ---
      ctx.fillStyle = 'rgba(15,23,42,0.28)';
      ctx.beginPath(); ctx.ellipse(cx, cy + R * 0.92, R * 0.68, R * 0.12, 0, 0, 7); ctx.fill();

      const atmo = ctx.createRadialGradient(cx, cy, R * 0.98, cx, cy, R * 1.18);
      atmo.addColorStop(0, 'rgba(147,197,253,0.35)');
      atmo.addColorStop(0.5, 'rgba(96,165,250,0.12)');
      atmo.addColorStop(1, 'rgba(59,130,246,0)');
      ctx.fillStyle = atmo; ctx.beginPath(); ctx.arc(cx, cy, R * 1.18, 0, 7); ctx.fill();

      const lightAngle = Math.atan2(-1, -1), lx = Math.cos(lightAngle), ly = Math.sin(lightAngle);
      ctx.save();
      ctx.beginPath(); ctx.arc(cx, cy, R, 0, 7); ctx.clip();

      const ocean = ctx.createRadialGradient(cx - R * 0.25, cy - R * 0.3, R * 0.1, cx, cy, R);
      ocean.addColorStop(0, '#60a5fa'); ocean.addColorStop(0.45, '#3b82f6');
      ocean.addColorStop(0.85, '#1d4ed8'); ocean.addColorStop(1, '#1e3a8a');
      ctx.fillStyle = ocean; ctx.fillRect(cx - R, cy - R, R * 2, R * 2);

      const gloss = ctx.createRadialGradient(cx - R * 0.35, cy - R * 0.42, 0, cx - R * 0.1, cy - R * 0.05, R * 0.85);
      gloss.addColorStop(0, 'rgba(255,255,255,0.55)'); gloss.addColorStop(0.25, 'rgba(191,219,254,0.28)');
      gloss.addColorStop(0.6, 'rgba(59,130,246,0.05)'); gloss.addColorStop(1, 'rgba(30,64,175,0)');
      ctx.fillStyle = gloss; ctx.fillRect(cx - R, cy - R, R * 2, R * 2);

      const ol = ctx.createLinearGradient(cx + lx * R, cy + ly * R, cx - lx * R, cy - ly * R);
      ol.addColorStop(0, 'rgba(186,230,253,0.45)'); ol.addColorStop(0.4, 'rgba(96,165,250,0.15)');
      ol.addColorStop(0.6, 'rgba(30,64,175,0)'); ol.addColorStop(1, 'rgba(15,23,42,0.08)');
      ctx.fillStyle = ol; ctx.fillRect(cx - R, cy - R, R * 2, R * 2);

      ctx.strokeStyle = 'rgba(255,255,255,0.12)'; ctx.lineWidth = 0.8 * dpr;
      for (let lat = -60; lat <= 60; lat += 30) {
        ctx.beginPath(); let first = true;
        for (let lon = -180; lon <= 180; lon += 8) { const p = project(lat*DEG, lon*DEG); if (p.z < 0) { first = true; continue; } first ? (ctx.moveTo(p.x,p.y), first=false) : ctx.lineTo(p.x,p.y); }
        ctx.stroke();
      }
      for (let lon = -180; lon < 180; lon += 30) {
        ctx.beginPath(); let first = true;
        for (let lat = -85; lat <= 85; lat += 8) { const p = project(lat*DEG, lon*DEG); if (p.z < 0) { first = true; continue; } first ? (ctx.moveTo(p.x,p.y), first=false) : ctx.lineTo(p.x,p.y); }
        ctx.stroke();
      }

      if (SHAPES) {
        const polys = [];
        for (const shape of SHAPES) {
          const clipped = [];
          for (const ring of shape.rings) {
            const proj = ring.map((pt) => project(pt.lat, pt.lon));
            for (const sub of clipRing(proj)) clipped.push(sub);
          }
          if (!clipped.length) continue;
          const outer = clipped[0];
          const avgZ = outer.reduce((s, p) => s + p.z, 0) / outer.length;
          polys.push({ rings: clipped, col: landColors(shape), countryId: shape.countryId, avgZ });
        }
        polys.sort((a, b) => a.avgZ - b.avgZ);

        const nowMs = performance.now();
        if (!accSet || nowMs - accT > 400) {
          accSet = new Set();
          for (const w of WORLDS) {
            if (w.iso === save.startIso || canEnterCountry(save, w.iso)) accSet.add(w.iso);
          }
          accT = nowMs;
        }
        const accessible = accSet;
        const hlPolys = [];
        const fogPolys = [];
        for (const poly of polys) {
          let fillStyle = poly.col.color;
          let isAccessible = false;
          let discovered = true;
          if (poly.countryId && ISO_WORLD[poly.countryId] !== undefined) {
            discovered = isDiscovered(save, poly.countryId);
            if (discovered) {
              const w = WORLDS[ISO_WORLD[poly.countryId]];
              const rel = getWorldReligion(save, w);
              fillStyle = rel.color;
              isAccessible = accessible.has(poly.countryId);
            } else {
              fillStyle = '#20293a';
            }
          }
          ctx.fillStyle = fillStyle;
          for (const ring of poly.rings) {
            ctx.beginPath();
            ring.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y));
            ctx.closePath(); ctx.fill();
          }
          if (isAccessible) hlPolys.push(poly);
          if (!discovered) fogPolys.push(poly);
        }
        if (fogPolys.length) {
          ctx.save();
          ctx.globalAlpha = 0.5;
          ctx.fillStyle = '#3a4658';
          for (const poly of fogPolys) {
            for (const ring of poly.rings) {
              ctx.beginPath();
              ring.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y));
              ctx.closePath(); ctx.fill();
            }
          }
          ctx.restore();
        }
        if (hlPolys.length) {
          const pulse = 0.55 + 0.45 * Math.sin(performance.now() * 0.004);
          ctx.save();
          ctx.lineJoin = 'round';
          ctx.lineCap = 'round';
          ctx.shadowColor = '#ffe259';
          ctx.shadowBlur = 10 * dpr * pulse;
          ctx.strokeStyle = `rgba(255,226,89,${0.7 + 0.3 * pulse})`;
          ctx.lineWidth = 2.2 * dpr;
          for (const poly of hlPolys) {
            for (const ring of poly.rings) {
              ctx.beginPath();
              ring.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y));
              ctx.closePath(); ctx.stroke();
            }
          }
          ctx.restore();
        }
      }
      ctx.restore();

      pinScreen.length = 0;
      const activeWorlds = WORLDS.filter(w => {
        if (!isDiscovered(save, w.iso)) return false;
        if (w.iso === save.startIso) return true;
        return canEnterCountry(save, w.iso);
      });
      for (const w of activeWorlds) {
        const p = project(w.lat, w.lon);
        const visible = p.z > 0.02;
        pinScreen.push({ world: w, x: p.x, y: p.y, visible });
        if (!visible) continue;
        const rel = getWorldReligion(save, w);
        const unlocked = worldUnlocked(save, w.id);
        const rr = 9 * dpr;
        const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, rr * 2.6);
        g.addColorStop(0, rel.color); g.addColorStop(0.5, rel.color + '88'); g.addColorStop(1, 'transparent');
        ctx.globalAlpha = unlocked ? 0.9 : 0.4;
        ctx.fillStyle = g; ctx.beginPath(); ctx.arc(p.x, p.y, rr * 2.6, 0, 7); ctx.fill();
        ctx.beginPath(); ctx.arc(p.x, p.y, rr, 0, 7);
        ctx.fillStyle = unlocked ? rel.color : '#5b6472';
        ctx.fill(); ctx.lineWidth = 2.4 * dpr; ctx.strokeStyle = '#fff'; ctx.stroke();
        ctx.globalAlpha = 1;
        ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.font = `${12 * dpr}px serif`;
        if (unlocked) {
          if (rel.sym.startsWith('data:image/') || rel.sym.startsWith('http')) {
            const img = getCachedImage(rel.sym, render);
            if (img) {
              ctx.save();
              ctx.beginPath();
              ctx.arc(p.x, p.y, rr * 0.82, 0, Math.PI * 2);
              ctx.clip();
              ctx.drawImage(img, p.x - rr * 0.82, p.y - rr * 0.82, rr * 1.64, rr * 1.64);
              ctx.restore();
            }
          } else {
            ctx.fillText(rel.sym, p.x, p.y + dpr);
          }
        } else {
          ctx.fillText('🔒', p.x, p.y + dpr);
        }
        ctx.globalAlpha = 1;
      }
    }
  }

  let raf = 0;
  let loopRunning = false;
  function loop() {
    const focusing = targetY !== null || targetX !== null || targetZoom !== null;
    let needsNext = false;
    if (focusing) {
      if (targetY !== null) {
        let dY = targetY - rotY;
        while (dY > Math.PI) dY -= Math.PI * 2;
        while (dY < -Math.PI) dY += Math.PI * 2;
        rotY += dY * 0.12;
        if (Math.abs(dY) < 0.004) { rotY = targetY; targetY = null; } else needsNext = true;
      }
      if (targetX !== null) {
        const dX = targetX - rotX;
        rotX += dX * 0.12;
        if (Math.abs(dX) < 0.004) { rotX = targetX; targetX = null; } else needsNext = true;
      }
      if (targetZoom !== null) {
        const dZ = targetZoom - zoom;
        setZoom(zoom + dZ * 0.12);
        if (Math.abs(dZ) < 0.01) { setZoom(targetZoom); targetZoom = null; } else needsNext = true;
      }
    } else if (!dragging) {
      if (Math.abs(velY) > 0.00015) { rotY += velY; velY *= 0.93; needsNext = true; }
      if (Math.abs(velX) > 0.00015) { rotX = clampTilt(rotX + velX); velX *= 0.9; needsNext = true; }
    }
    if (dragging) needsNext = true;
    render();
    if (needsNext) {
      raf = requestAnimationFrame(loop);
    } else {
      loopRunning = false;
    }
  }
  let pulseTimer = 0;
  function schedulePulse() {
    if (pulseTimer) return;
    pulseTimer = setInterval(() => {
      if (!loopRunning) { render(); }
    }, 250);
  }
  function scheduleLoop() {
    if (!loopRunning) { loopRunning = true; raf = requestAnimationFrame(loop); }
  }

  // interactions — glissement horizontal (rotation) + vertical (bascule)
  function onDown(e) {
    dragging = true; velY = 0; velX = 0; moved = 0;
    lastX = e.clientX; lastY = e.clientY; lastMove = performance.now();
    targetY = null; targetX = null; targetZoom = null;
    startX = e.clientX; startY = e.clientY;
    canvas.setPointerCapture && canvas.setPointerCapture(e.pointerId);
    scheduleLoop();
  }
  function onMove(e) {
    if (!dragging || pinching) return;
    const dx = e.clientX - lastX;
    const dy = e.clientY - lastY;
    moved += Math.abs(dx) + Math.abs(dy);
    rotY -= dx * 0.005;
    rotX = clampTilt(rotX + dy * 0.005);
    velY = -dx * 0.005 * 0.4;
    velX = dy * 0.005 * 0.4;
    lastX = e.clientX; lastY = e.clientY; lastMove = performance.now();
    scheduleLoop();
  }
  function onUp(e) {
    if (!dragging) return;
    dragging = false;
    const totalMove = Math.hypot(e.clientX - startX, e.clientY - startY);
    if (totalMove < 6 && moved < 8) tryPick(e.clientX, e.clientY);
    scheduleLoop();
  }
  let startX = 0, startY = 0;
  function tryPick(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    const px = (clientX - rect.left) * dpr, py = (clientY - rect.top) * dpr;
    // 1) pays sous le doigt
    const hit = screenToLatLon(px, py, cx, cy, R, rotY, rotX);
    if (hit) {
      const iso = findCountryAt(hit.lat, hit.lon);
      if (iso && ISO_WORLD[iso] !== undefined) {
        playUIClick();
        opts.onPick(WORLDS[ISO_WORLD[iso]]);
        return;
      }
      if (iso) { opts.onUnknown && opts.onUnknown(); return; }
    }
    // 2) sinon, pastille la plus proche
    let best = null, bd = 30 * dpr;
    for (const p of pinScreen) {
      if (!p.visible) continue;
      const d = Math.hypot(p.x - px, p.y - py);
      if (d < bd) { bd = d; best = p.world; }
    }
    if (best) {
      playUIClick();
      opts.onPick(best);
    }
  }
  /* Recadre sur un pays : rotation + bascule pour le centrer, et zoom guidé. */
  function focusWorld(w, opts2 = {}) {
    targetY = w.lon;
    targetX = clampTilt(w.lat);
    const wantZoom = opts2.zoom != null ? opts2.zoom : Math.max(zoom, 2.2);
    targetZoom = Math.min(Math.max(wantZoom, ZOOM_MIN), ZOOM_MAX);
  }

  resize();
  const onResize = () => { resize(); scheduleLoop(); };
  addEventListener('resize', onResize);
  const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(onResize) : null;
  if (ro) ro.observe(canvas.parentElement || canvas);
  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerup', onUp);

  // Zoom avec la molette de la souris
  function onWheel(e) {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.08 : 0.92;
    targetZoom = null;
    setZoom(zoom * factor);
    scheduleLoop();
  }
  canvas.addEventListener('wheel', onWheel, { passive: false });

  // Zoom tactile (pincement sur mobile)
  let initialTouchDist = null;
  let pinching = false;
  function onTouchStart(e) {
    if (e.touches.length === 2) {
      pinching = true;
      dragging = false; velX = 0; velY = 0;
      targetZoom = null;
      initialTouchDist = Math.hypot(
        e.touches[0].clientX - e.touches[1].clientX,
        e.touches[0].clientY - e.touches[1].clientY
      );
    }
  }
  function onTouchMove(e) {
    if (e.touches.length === 2 && initialTouchDist !== null) {
      e.preventDefault();
      const dist = Math.hypot(
        e.touches[0].clientX - e.touches[1].clientX,
        e.touches[0].clientY - e.touches[1].clientY
      );
      const factor = dist / initialTouchDist;
      setZoom(zoom * factor);
      initialTouchDist = dist;
      scheduleLoop();
    }
  }
  function onTouchEnd(e) {
    if (e.touches.length < 2) {
      initialTouchDist = null;
      pinching = false;
    }
  }
  canvas.addEventListener('touchstart', onTouchStart);
  canvas.addEventListener('touchmove', onTouchMove);
  canvas.addEventListener('touchend', onTouchEnd);

  scheduleLoop();
  schedulePulse();
  return {
    focusWorld(w) { focusWorld(w); scheduleLoop(); },
    stop() {
      cancelAnimationFrame(raf); loopRunning = false;
      clearInterval(pulseTimer); pulseTimer = 0;
      removeEventListener('resize', onResize);
      if (ro) ro.disconnect();
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('touchstart', onTouchStart);
      canvas.removeEventListener('touchmove', onTouchMove);
      canvas.removeEventListener('touchend', onTouchEnd);
    },
  };
}

/* ===================== Conquête : état des zones d'un pays ===================== */
function conqOf(save, iso) { save.conq = save.conq || {}; return save.conq[iso]; }

function getWorldReligion(save, world) {
  const conq = save.conq && save.conq[world.iso];
  if (!conq) {
    return { color: '#7a8290', name: 'Gris', sym: '•' };
  }
  
  const counts = {};
  for (const zoneId in conq) {
    const color = conq[zoneId];
    counts[color] = (counts[color] || 0) + 1;
  }
  
  let maxCount = -1;
  let bestColors = [];
  for (const color in counts) {
    const cnt = counts[color];
    if (cnt > maxCount) {
      maxCount = cnt;
      bestColors = [color];
    } else if (cnt === maxCount) {
      bestColors.push(color);
    }
  }
  
  // S'il y a égalité, aucune religion n'est dominante => Gris
  if (bestColors.length !== 1) {
    return { color: '#7a8290', name: 'Gris', sym: '•' };
  }
  
  const majorityColor = bestColors[0];
  if (majorityColor === NEUTRAL) {
    return { color: NEUTRAL, name: 'Non conquis', sym: '•' };
  }
  if (majorityColor === save.playerColor && save.playerName) {
    return { color: majorityColor, name: save.religionName || 'Mon Culte', sym: save.religionIcon || '✦' };
  }
  return CULTS.find(c => c.color === majorityColor) || { color: majorityColor, name: 'Inconnu', sym: '•' };
}

function getCountryReligionPercentages(save, world, regions) {
  const conq = save.conq && save.conq[world.iso];
  if (!conq) return [];
  
  const counts = {};
  let total = 0;
  for (const r of regions) {
    const color = conq[r.id] || NEUTRAL;
    counts[color] = (counts[color] || 0) + 1;
    total++;
  }
  
  const pcts = [];
  for (const color in counts) {
    let cult = CULTS.find(c => c.color === color);
    let name = cult ? cult.name : (color === NEUTRAL ? 'Terres barbares' : 'Neutres');
    let sym = cult ? cult.sym : (color === NEUTRAL ? '⚔' : '•');
    
    if (color === save.playerColor && save.playerName) {
      name = save.religionName || name;
      sym = save.religionIcon || sym;
    }
    
    const percent = Math.round((counts[color] / total) * 100);
    pcts.push({ color, name, sym, percent, count: counts[color] });
  }
  
  pcts.sort((a, b) => b.percent - a.percent);
  return pcts;
}

/* ===================== Système de niveaux & religions IA ===================== */
/** Les 9 (ou 10) religions IA = tous les cultes sauf la couleur du joueur. */
function aiColors(save) {
  return CULTS.map((c) => c.color).filter((c) => c !== save.playerColor);
}
/** État persistant d'une religion IA (niveau, xp, points, compétences, pays de départ, agressivité). */
function ensureAiState(save, color) {
  save.ai = save.ai || {};
  if (!save.ai[color]) save.ai[color] = { level: 0, xp: 0, skillPoints: 0, skills: {}, startIso: null };
  ensureLevelState(save.ai[color]);
  // Agressivité individuelle (0..1), figée à la création de la religion IA.
  if (typeof save.ai[color].aggr !== 'number') save.ai[color].aggr = 0.3 + Math.random() * 0.7;
  // Branche favorite individuelle : donne une identité de build à chaque IA.
  if (!save.ai[color].favBranch) {
    save.ai[color].favBranch = SKILL_BRANCHES[(Math.random() * SKILL_BRANCHES.length) | 0].id;
  }
  return save.ai[color];
}

/** Paramètres de simulation par difficulté : probabilité d'agir + de voler une autre IA. */
const DIFF_SIM = {
  easy:   { act: 0.35, steal: 0.05 },
  normal: { act: 0.65, steal: 0.20 },
  hard:   { act: 0.95, steal: 0.45 },
};
/** Garantit les champs de niveau du joueur. */
function ensurePlayerLevel(save) {
  if (typeof save.level !== 'number') save.level = 0;
  if (typeof save.xp !== 'number') save.xp = 0;
  if (typeof save.skillPoints !== 'number') save.skillPoints = 0;
  if (!save.skills || typeof save.skills !== 'object') save.skills = {};
  return save;
}
/** Niveau d'une religion (joueur ou IA) par couleur. */
function colorLevel(save, color) {
  if (color === save.playerColor) return save.level | 0;
  return (save.ai && save.ai[color] && save.ai[color].level) | 0;
}

/** Bascule vers le nouveau modèle de monde (v2) : réinitialise l'état de conquête. */
function ensureWorldModel(save) {
  if (save.worldModel === 2) { ensurePlayerLevel(save); return; }
  save.conq = {};
  save.conqPop = {};
  save.conqMaxPop = {};
  save.conquered = {};
  save.ai = {};
  save.level = 0; save.xp = 0;
  save.skills = {}; save.skillPoints = 0;
  save.skillMajority = {}; save.skillFull = {};
  save.seeded = false;
  save.worldModel = 2;
  persist(save);
}

/** Initialise les zones d'un pays : tout en NEUTRAL (non conquis) dans le modèle v2. */
function initCountry(save, world, regions) {
  save.conq = save.conq || {};
  if (save.conq[world.iso]) return;

  // 1. Calculer l'aire géographique de chaque région
  const areas = regions.map(r => {
    let totalArea = 0;
    for (const ring of r.rings) {
      let area = 0;
      const n = ring.length;
      for (let i = 0; i < n; i++) {
        const p1 = ring[i];
        const p2 = ring[(i + 1) % n];
        const avgLat = (p1.lat + p2.lat) / 2;
        const kx = Math.cos(avgLat);
        const x1 = p1.lon * kx;
        const x2 = p2.lon * kx;
        area += (x1 * p2.lat - x2 * p1.lat);
      }
      totalArea += Math.abs(area) / 2;
    }
    return { id: r.id, area: totalArea };
  });

  // 2. Trouver les valeurs min/max des aires
  let minArea = Infinity, maxArea = -Infinity;
  for (const a of areas) {
    if (a.area < minArea) minArea = a.area;
    if (a.area > maxArea) maxArea = a.area;
  }
  
  const diffArea = maxArea - minArea;

  save.conqPop = save.conqPop || {};
  save.conqMaxPop = save.conqMaxPop || {};
  const map = {};
  
  const zoneRealMaxPop = Math.round((world.pop || 1000000) / regions.length);

  regions.forEach((r) => {
    const rAreaObj = areas.find(a => a.id === r.id);
    const rArea = rAreaObj ? rAreaObj.area : minArea;
    
    // Échelonner la population gameplay entre 200 et 600
    let maxPop = 350;
    if (diffArea > 0.000001) {
      const t = (rArea - minArea) / diffArea;
      maxPop = Math.round(200 + t * 400);
    } else {
      maxPop = 250 + Math.floor(Math.random() * 250);
    }

    save.conqMaxPop[`${world.iso}_${r.id}`] = maxPop;
    // Zone non conquise : aucun fidèle, couleur grise.
    save.conqPop[`${world.iso}_${r.id}`] = 0;
    map[r.id] = NEUTRAL;
  });

  save.conq[world.iso] = map;
  persist(save);
}

/** Attribue une zone de départ à chaque religion (joueur + IA) sur des pays aléatoires. */
/** Grands pays bien visibles : le joueur y commence toujours (repère clair où cliquer). */
const PLAYER_START_ISO = [
  'RUS', 'CAN', 'USA', 'CHN', 'BRA', 'AUS', 'IND', 'ARG', 'KAZ', 'DZA',
  'COD', 'SAU', 'MEX', 'IDN', 'SDN', 'LBY', 'IRN', 'MNG', 'PER', 'NER',
  'TCD', 'AGO', 'MLI', 'ZAF', 'COL', 'ETH', 'EGY', 'TZA', 'NGA', 'PAK',
  'TUR', 'FRA', 'ESP', 'UKR', 'MMR', 'MOZ', 'NAM', 'ZMB', 'CHL', 'BOL',
];

async function seedReligionStarts() {
  let save = loadSave();
  if (save.seeded) {
    await healPlayerStart(save);
    return;
  }
  const difficulty = localStorage.getItem('cultio_difficulty') || 'normal';
  const religions = [{ color: save.playerColor, isPlayer: true }];
  for (const c of aiColors(save)) religions.push({ color: c, isPlayer: false });
  const candidates = WORLDS.filter((w) => !!w.iso);
  if (!candidates.length) return;
  const bigPool = candidates.filter((w) => PLAYER_START_ISO.includes(w.iso));
  const shuffle = (arr) => arr.map((v) => [Math.random(), v]).sort((a, b) => a[0] - b[0]).map((p) => p[1]);
  const used = new Set();
  for (const rel of religions) {
    if (!rel.color) continue;
    // Le joueur démarre sur un grand pays visible ; les IA n'importe où.
    const pool = rel.isPlayer && bigPool.length ? bigPool : candidates;
    let world = null, regions = null;
    // Essaie plusieurs pays (chargeables + non pris) jusqu'à en trouver un valide.
    for (const w of shuffle(pool)) {
      if (used.has(w.iso)) continue;
      try { regions = await loadRegions(w.iso); } catch { regions = null; }
      if (regions && regions.length) { world = w; break; }
    }
    // Repli ultime : n'importe quel candidat chargeable.
    if (!world) {
      for (const w of shuffle(candidates)) {
        if (used.has(w.iso)) continue;
        try { regions = await loadRegions(w.iso); } catch { regions = null; }
        if (regions && regions.length) { world = w; break; }
      }
    }
    if (!world || !regions) continue;
    used.add(world.iso);
    const cur = loadSave();
    initCountry(cur, world, regions);
    const region = regions[(Math.random() * regions.length) | 0];
    cur.conq[world.iso] = cur.conq[world.iso] || {};
    cur.conq[world.iso][region.id] = rel.color;
    const realMax = Math.round((world.pop || 1000000) / regions.length);
    cur.conqPop = cur.conqPop || {};
    cur.conqPop[`${world.iso}_${region.id}`] = Math.round(realMax * 0.12);
    // Zone de départ = 1 point de foi pour chaque religion.
    if (rel.isPlayer) {
      cur.startIso = world.iso;
      ensurePlayerLevel(cur);
      cur.skillPoints = (cur.skillPoints | 0) + 1;
    } else {
      const st = ensureAiState(cur, rel.color);
      st.startIso = world.iso;
      st.skillPoints = (st.skillPoints | 0) + 1;
      aiSpendSkillPoints(st, difficulty); // l'IA place aussitôt son point de départ
    }
    persist(cur);
  }
  const fin = loadSave();
  fin.seeded = true;
  persist(fin);
}

/** Répare une sauvegarde déjà semée où le joueur ne possède aucune zone (bug de race passé). */
async function healPlayerStart(save) {
  const pc = save.playerColor;
  if (!pc || !save.conq) return;
  for (const iso in save.conq) {
    if (Object.values(save.conq[iso]).includes(pc)) return; // le joueur possède déjà une zone
  }
  // Aucune zone possédée : on tente d'abord le pays de départ enregistré.
  const isos = [];
  if (save.startIso) isos.push(save.startIso);
  for (const iso in save.conq) if (!isos.includes(iso)) isos.push(iso);
  for (const iso of isos) {
    let regions;
    try { regions = await loadRegions(iso); } catch { continue; }
    if (!regions || !regions.length) continue;
    const cur = loadSave();
    initCountry(cur, WORLDS[ISO_WORLD[iso]] || { iso }, regions);
    cur.conq[iso] = cur.conq[iso] || {};
    // Préfère une zone neutre pour ne rien voler à une IA.
    const free = regions.filter((r) => (cur.conq[iso][r.id] || NEUTRAL) === NEUTRAL);
    const pick = (free.length ? free : regions)[(Math.random() * (free.length || regions.length)) | 0];
    cur.conq[iso][pick.id] = pc;
    const realMax = Math.round(((WORLDS[ISO_WORLD[iso]]?.pop) || 1000000) / regions.length);
    cur.conqPop = cur.conqPop || {};
    cur.conqPop[`${iso}_${pick.id}`] = Math.round(realMax * 0.12);
    cur.startIso = iso;
    ensurePlayerLevel(cur);
    persist(cur);
    return;
  }
}

/** Simulation de conquête des religions IA (appelée à chaque lancement de partie). */
function simulateWorldTurn() {
  const save = loadSave();
  if (!save.seeded || !save.conq) return;
  const colors = aiColors(save);
  const isos = Object.keys(save.conq);
  if (!isos.length) return;

  // Réinitialise les changements passifs pour ce tour
  save.passiveChanges = [];

  // Index des pays où chaque IA est présente.
  const holdIsos = {};
  for (const color of colors) holdIsos[color] = [];
  for (const iso of isos) {
    const present = new Set(Object.values(save.conq[iso]));
    for (const color of colors) if (present.has(color)) holdIsos[color].push(iso);
  }

  const diff = localStorage.getItem('cultio_difficulty') || 'normal';
  const dp = DIFF_SIM[diff] || DIFF_SIM.normal;

  for (const color of colors) {
    const state = ensureAiState(save, color);
    const power = aiExpansionPower(state);
    // Agressivité = difficulté (groupe) × variation individuelle + bonus de puissance.
    const actProb = Math.max(0, Math.min(0.98, dp.act * (0.7 + state.aggr * 0.6) + (power - 1) * 0.05));
    if (Math.random() >= actProb) continue; // cette IA n'agit pas ce tour

    let mine = holdIsos[color];
    if (!mine.length) mine = [isos[(Math.random() * isos.length) | 0]];

    // Pays candidats : détenus + voisins déjà initialisés.
    const candSet = new Set();
    for (const iso of mine) {
      candSet.add(iso);
      for (const n of (NEIGHBORS[iso] || [])) if (save.conq[n]) candSet.add(n);
    }
    const cand = [...candSet];

    // Une seule zone conquise par tour (comme le joueur).
    let captured = false, completed = false;
    for (let tries = 0; tries < cand.length && !captured; tries++) {
      const iso = cand[(Math.random() * cand.length) | 0];
      const m = save.conq[iso];
      if (!m) continue;
      
      const neutral = Object.keys(m).filter((z) => m[z] === NEUTRAL);
      let target = null;
      if (neutral.length) {
        target = neutral[(Math.random() * neutral.length) | 0];
      } else if (Math.random() < dp.steal) {
        // Vol à un rival (incluant désormais le joueur !)
        const enemies = Object.keys(m).filter((z) => m[z] !== NEUTRAL && m[z] !== color);
        if (enemies.length) target = enemies[(Math.random() * enemies.length) | 0];
      }
      if (!target) continue;

      // --- SIMULATION DE COMBAT MULTI-FACTIONS ---
      // Les participants sont : l'attaquant, le propriétaire actuel, et toute religion présente dans le pays
      const participantsSet = new Set();
      participantsSet.add(color); // l'attaquant
      const oldOwner = m[target];
      if (oldOwner !== NEUTRAL) {
        participantsSet.add(oldOwner);
      }
      for (const zId in m) {
        if (m[zId] !== NEUTRAL) {
          participantsSet.add(m[zId]);
        }
      }
      const participants = Array.from(participantsSet);

      // Calcul des forces de chacun
      const strengths = participants.map((pColor) => {
        let basePower = 1;
        if (pColor === save.playerColor) {
          basePower = aiExpansionPower(save);
        } else {
          const pState = ensureAiState(save, pColor);
          basePower = aiExpansionPower(pState);
        }
        
        // Bonus de support : nombre de zones détenues dans ce pays
        let ownedCount = 0;
        for (const zId in m) {
          if (m[zId] === pColor) ownedCount++;
        }
        const supportBonus = 1.0 + ownedCount * 0.15;
        
        // Bonus défensif si c'est le propriétaire actuel de la zone cible
        const defenseBonus = (m[target] === pColor) ? 1.3 : 1.0;

        return { color: pColor, str: basePower * supportBonus * defenseBonus };
      });

      const totalStr = strengths.reduce((sum, item) => sum + item.str, 0) || 1;
      let rand = Math.random() * totalStr;
      let winnerColor = color;
      for (const item of strengths) {
        rand -= item.str;
        if (rand <= 0) {
          winnerColor = item.color;
          break;
        }
      }

      // Si le territoire change de propriétaire à l'issue de la simulation
      if (winnerColor !== oldOwner) {
        m[target] = winnerColor;
        const w = ISO_WORLD[iso] !== undefined ? WORLDS[ISO_WORLD[iso]] : null;
        const zonesCount = Math.max(1, Object.keys(m).length);
        const realMax = Math.round((w?.pop || 1000000) / zonesCount);
        save.conqPop = save.conqPop || {};
        save.conqPop[`${iso}_${target}`] = Math.round(realMax * (0.3 + Math.random() * 0.5));
        captured = true;
        
        if (Object.values(m).every((h) => h === winnerColor)) {
          completed = true;
          if (winnerColor === save.playerColor) {
            save.conquered = save.conquered || {};
            save.conquered[iso] = true;
            revealNeighbors(save, iso);
          }
        }

        // Attribution XP
        if (winnerColor === save.playerColor) {
          ensurePlayerLevel(save);
          addXp(save, 1 + (completed ? 3 : 0));
        } else {
          const winnerState = ensureAiState(save, winnerColor);
          addXp(winnerState, 1 + (completed ? 3 : 0));
          aiSpendSkillPoints(winnerState, diff);
        }

        // Trace du changement passif si le joueur y participe (gagne ou perd)
        if (oldOwner === save.playerColor || winnerColor === save.playerColor) {
          save.passiveChanges.push({
            iso,
            countryName: w ? w.name : iso,
            oldOwner,
            newOwner: winnerColor
          });
        }
      } else {
        // Résistance défensive réussie
        captured = true;
      }
    }
  }
  persist(save);
}

/** Le joueur dtient-il la majorit (>50%) des zones d'un pays ? */
function isMajorityMine(save, iso) {
  const m = save.conq && save.conq[iso];
  if (!m) return false;
  const zones = Object.values(m);
  if (!zones.length) return false;
  const mine = zones.filter(c => c === save.playerColor).length;
  return mine * 2 > zones.length;
}
/** Pays entièrement conquis par le joueur (toutes les zones lui appartiennent). */
function isFullyMine(save, iso) {
  const m = save.conq && save.conq[iso];
  if (!m) return false;
  const zones = Object.values(m);
  if (!zones.length) return false;
  return zones.every(c => c === save.playerColor);
}
/** Le joueur possède-t-il au moins une zone dans ce pays ? (pour pouvoir le finir) */
function hasAnyZoneMine(save, iso) {
  const m = save.conq && save.conq[iso];
  if (!m) return false;
  return Object.values(m).some(c => c === save.playerColor);
}

/** Distance angulaire (rad) entre les centro�des de deux pays. */
function isoDistance(isoA, isoB) {
  const a = ISO_WORLD[isoA] !== undefined ? WORLDS[ISO_WORLD[isoA]] : null;
  const b = ISO_WORLD[isoB] !== undefined ? WORLDS[ISO_WORLD[isoB]] : null;
  if (!a || !b) return Infinity;
  const dLat = a.lat - b.lat;
  let dLon = a.lon - b.lon;
  if (dLon > Math.PI) dLon -= Math.PI * 2;
  if (dLon < -Math.PI) dLon += Math.PI * 2;
  return Math.hypot(dLat, dLon);
}

/** Peut-on entrer dans ce pays ? D�part, majorit�, ou voisin d'un pays o� l'on est majoritaire (avec hop d'�les). */
function canEnterCountry(save, iso) {
  if (!iso) return false;
  if (iso === save.startIso) return true;
  // Pays déjà entamé (au moins une zone à nous) : on peut y revenir pour le terminer.
  if (hasAnyZoneMine(save, iso)) return true;
  // Expansion : un pays voisin ne s'ouvre que si l'on détient ENTIÈREMENT un pays adjacent.
  const neighbors = NEIGHBORS[iso] || [];
  for (const n of neighbors) {
    if (isFullyMine(save, n)) return true;
  }
  // Fallback : île isolée (aucun voisin listé) => saut depuis un pays 100% conquis proche.
  if (neighbors.length === 0) {
    for (const w of WORLDS) {
      if (w.iso === iso) continue;
      if (!isFullyMine(save, w.iso)) continue;
      if (isoDistance(iso, w.iso) <= ISLAND_HOP_RADIUS) return true;
    }
  }
  return false;
}
/* ===================== Brouillard de guerre ===================== */
/** Un pays est-il découvert (brouillard levé) ? */
function isDiscovered(save, iso) {
  return !!(save.discovered && save.discovered[iso]);
}
/** Reconstitue l'ensemble découvert : pays de départ + voisins, pays entamés,
 *  et voisins des pays conquis à 100 %. Rétroactif pour les parties en cours. */
function ensureDiscovery(save) {
  if (!save.discovered || typeof save.discovered !== 'object') save.discovered = {};
  let changed = false;
  const reveal = (iso) => { if (iso && !save.discovered[iso]) { save.discovered[iso] = true; changed = true; } };
  if (save.startIso) {
    reveal(save.startIso);
    for (const n of (NEIGHBORS[save.startIso] || [])) reveal(n);
  }
  if (save.conq) {
    for (const iso in save.conq) {
      if (hasAnyZoneMine(save, iso)) reveal(iso);
      if (isFullyMine(save, iso)) for (const n of (NEIGHBORS[iso] || [])) reveal(n);
    }
  }
  if (changed) persist(save);
  return save.discovered;
}
/** Révèle un pays et ses voisins directs (appelé quand un pays est conquis à 100 %). */
function revealNeighbors(save, iso) {
  save.discovered = save.discovered || {};
  let changed = false;
  const reveal = (i) => { if (i && !save.discovered[i]) { save.discovered[i] = true; changed = true; } };
  reveal(iso);
  for (const n of (NEIGHBORS[iso] || [])) reveal(n);
  if (changed) persist(save);
  return changed;
}

function holderOf(save, iso, id) { const m = conqOf(save, iso); return m ? m[id] : null; }
function setHolder(iso, id, color, conversions = 0, worldPop = 1000000, zonesCount = 1) {
  const s = loadSave();
  s.conq = s.conq || {};
  s.conq[iso] = s.conq[iso] || {};
  s.conq[iso][id] = color;
  if (conversions > 0) {
    s.conqPop = s.conqPop || {};
    s.conqMaxPop = s.conqMaxPop || {};
    const gameMax = s.conqMaxPop[`${iso}_${id}`] || 500;
    const zoneRealMax = Math.round(worldPop / zonesCount);
    const ratio = Math.min(1.0, conversions / gameMax);
    s.conqPop[`${iso}_${id}`] = Math.round(ratio * zoneRealMax);
  }
  persist(s);
}
function zonePopOf(save, iso, id) {
  save.conqPop = save.conqPop || {};
  const val = save.conqPop[`${iso}_${id}`];
  if (val !== undefined) return val;
  // Fallback réaliste basé sur la pop du pays si non défini
  const w = WORLDS.find(x => x.iso === iso);
  const conq = save.conq && save.conq[iso];
  const zonesCount = conq ? Object.keys(conq).length : 10;
  const zoneRealMax = Math.round((w ? w.pop : 1000000) / zonesCount);
  return Math.round(zoneRealMax * (0.05 + Math.random() * 0.1));
}
function zoneMaxPopOf(save, iso, id) {
  save.conqMaxPop = save.conqMaxPop || {};
  const val = save.conqMaxPop[`${iso}_${id}`];
  if (val !== undefined) return val;
  const maxPop = 250 + Math.floor(Math.random() * 250);
  save.conqMaxPop[`${iso}_${id}`] = maxPop;
  persist(save);
  return maxPop;
}
export function formatBelievers(n) {
  if (n >= 1e9) {
    return (n / 1e9).toFixed(2).replace(/\.00$/, '').replace(/\.(\d)0$/, '.$1').replace('.', ',') + ' B';
  }
  if (n >= 1e6) {
    return (n / 1e6).toFixed(2).replace(/\.00$/, '').replace(/\.(\d)0$/, '.$1').replace('.', ',') + ' M';
  }
  return n.toLocaleString('fr-FR');
}

function religionMeta(save, color) {
  if (color === save.playerColor && save.playerName) {
    return {
      color,
      name: save.religionName || 'Mon Culte',
      sym: save.religionIcon || '✦',
      isPlayer: true,
    };
  }
  const cult = CULTS.find((c) => c.color === color);
  return {
    color,
    name: cult?.name || 'Inconnu',
    sym: cult?.sym || '•',
    isPlayer: false,
  };
}

function formatFaithPct(raw) {
  if (raw <= 0) return '0%';
  if (raw < 0.1) return '<0,1%';
  if (raw < 10) return raw.toFixed(1).replace('.', ',') + '%';
  return Math.round(raw) + '%';
}

/** Classement mondial des religions : % de foi + fidèles (toujours les 10 cultes). */
export function getReligionWorldScores() {
  const save = loadSave();
  const byColor = {};
  for (const c of CULTS) byColor[c.color] = 0;
  if (save.playerColor && byColor[save.playerColor] === undefined) byColor[save.playerColor] = 0;

  let totalZones = 0;
  let playerZones = 0;

  for (const w of WORLDS) {
    const conq = save.conq && save.conq[w.iso];
    if (!conq) continue;
    for (const zoneId in conq) {
      totalZones++;
      const color = conq[zoneId];
      if (!color || color === NEUTRAL) continue;
      if (byColor[color] === undefined) byColor[color] = 0;
      byColor[color] += zonePopOf(save, w.iso, zoneId);
      if (color === save.playerColor) playerZones++;
    }
  }

  const totalEarthPop = WORLDS.reduce((sum, w) => sum + (w.pop || 1000000), 0) || 1;
  const religions = Object.keys(byColor)
    .map((color) => {
      const believers = byColor[color] || 0;
      const rawPct = (believers / totalEarthPop) * 100;
      return { ...religionMeta(save, color), believers, rawPct, pct: formatFaithPct(rawPct), level: colorLevel(save, color) };
    })
    .sort((a, b) => b.believers - a.believers || b.level - a.level || a.name.localeCompare(b.name, 'fr'));

  const player = religions.find((r) => r.isPlayer) || null;
  return {
    religions,
    totalEarthPop,
    playerZones,
    totalZones,
    pct: player ? player.pct.replace('%', '') : '0',
    believers: player ? player.believers : 0,
  };
}

export function getGlobalStats() {
  const board = getReligionWorldScores();
  return {
    pct: board.pct,
    believers: board.believers,
    playerZones: board.playerZones,
    totalZones: board.totalZones,
    religions: board.religions,
  };
}
function conqueredCount(save, world, regions) {
  const m = conqOf(save, world.iso); if (!m) return 0;
  const playerColor = save.playerColor;
  let n = 0; for (const r of regions) if (m[r.id] === playerColor) n++;
  return n;
}
function isCountryConquered(save, world, regions) { return regions.length > 0 && conqueredCount(save, world, regions) === regions.length; }

function buildRegionNeighbors(regions) {
  const neighbors = {};
  for (const r of regions) {
    neighbors[r.id] = new Set();
  }
  const vertexToRegions = {};
  for (const r of regions) {
    for (const ring of r.rings) {
      for (const p of ring) {
        const key = `${p.lon.toFixed(5)},${p.lat.toFixed(5)}`;
        if (!vertexToRegions[key]) {
          vertexToRegions[key] = [];
        }
        if (!vertexToRegions[key].includes(r.id)) {
          vertexToRegions[key].push(r.id);
        }
      }
    }
  }
  for (const key in vertexToRegions) {
    const list = vertexToRegions[key];
    if (list.length > 1) {
      for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
          neighbors[list[i]].add(list[j]);
          neighbors[list[j]].add(list[i]);
        }
      }
    }
  }
  return neighbors;
}

/* ===================== Carte de conquête d'un pays ===================== */
function createCountryMap(canvas, world, regions, onSelect) {
  const ctx = canvas.getContext('2d');
  let W = 0, H = 0, dpr = 1, tf = null;
  let selectedId = null;
  const screenPolys = []; // {region, rings:[[{x,y}]]}
  const regionNeighbors = buildRegionNeighbors(regions);

  /** Ensemble des zones conquérables (non détenues + accessibles) — pour la surbrillance. */
  function computeAttackable(save) {
    const set = new Set();
    const pc = save.playerColor;
    const hOf = (id) => (save.conq && save.conq[world.iso]) ? save.conq[world.iso][id] : null;
    const playerOwnsAny = regions.some((r) => hOf(r.id) === pc);
    let hasAdjNonOwned = false;
    if (playerOwnsAny) {
      for (const r of regions) {
        if (hOf(r.id) === pc) continue;
        if ([...(regionNeighbors[r.id] || [])].some((n) => hOf(n) === pc)) { hasAdjNonOwned = true; break; }
      }
    }
    for (const r of regions) {
      if (hOf(r.id) === pc) continue;
      const isAdjacent = [...(regionNeighbors[r.id] || [])].some((n) => hOf(n) === pc);
      if (!playerOwnsAny || isAdjacent || !hasAdjNonOwned) set.add(r.id);
    }
    return set;
  }
  const ZOOM_MIN = 1, ZOOM_MAX = 6;
  let zoom = 1, panX = 0, panY = 0;   // vue : zoom + déplacement
  function clampPan() {
    const mx = (zoom - 1) * W / 2 + W * 0.3;
    const my = (zoom - 1) * H / 2 + H * 0.3;
    panX = Math.max(-mx, Math.min(mx, panX));
    panY = Math.max(-my, Math.min(my, panY));
  }
  function zoomAt(sx, sy, factor) {
    const nz = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, zoom * factor));
    if (nz === zoom) return;
    // garde le point (sx,sy) stable à l'écran
    panX = sx - W / 2 - ((sx - W / 2 - panX) / zoom) * nz;
    panY = sy - H / 2 - ((sy - H / 2 - panY) / zoom) * nz;
    zoom = nz;
    clampPan();
    render();
  }

  function getPolygonCentroid(ring) {
    let area = 0;
    let cx = 0;
    let cy = 0;
    const n = ring.length;
    for (let i = 0; i < n; i++) {
      const p1 = ring[i];
      const p2 = ring[(i + 1) % n];
      const factor = (p1.x * p2.y - p2.x * p1.y);
      area += factor;
      cx += (p1.x + p2.x) * factor;
      cy += (p1.y + p2.y) * factor;
    }
    area = area / 2;
    if (Math.abs(area) < 0.1) {
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      for (const p of ring) {
        if (p.x < minX) minX = p.x;
        if (p.x > maxX) maxX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.y > maxY) maxY = p.y;
      }
      return { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
    }
    cx = cx / (6 * area);
    cy = cy / (6 * area);
    return { x: cx, y: cy };
  }

  // bornes géographiques
  let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity;
  for (const r of regions) for (const ring of r.rings) for (const p of ring) {
    if (p.lon < minLon) minLon = p.lon; if (p.lon > maxLon) maxLon = p.lon;
    if (p.lat < minLat) minLat = p.lat; if (p.lat > maxLat) maxLat = p.lat;
  }
  const centerLat = (minLat + maxLat) / 2, kx = Math.cos(centerLat * DEG);

  function resize() {
    dpr = Math.min(devicePixelRatio || 1, 2);
    const rect = canvas.getBoundingClientRect();
    W = canvas.width = Math.round(rect.width * dpr);
    H = canvas.height = Math.round(rect.height * dpr);
    const pad = 40 * dpr;
    const spanX = (maxLon - minLon) * kx, spanY = (maxLat - minLat);
    const scale = Math.min((W - 2 * pad) / spanX, (H - 2 * pad) / spanY);
    const offX = (W - spanX * scale) / 2, offY = (H - spanY * scale) / 2;
    tf = { scale, offX, offY };
  }
  const proj = (lon, lat) => {
    const bx = tf.offX + (lon - minLon) * kx * tf.scale;
    const by = tf.offY + (maxLat - lat) * tf.scale;
    return { x: (bx - W / 2) * zoom + W / 2 + panX, y: (by - H / 2) * zoom + H / 2 + panY };
  };

  function render() {
    if (!tf) resize();
    ctx.clearRect(0, 0, W, H);
    const save = loadSave();
    screenPolys.length = 0;
    const attackable = computeAttackable(save);

    for (const r of regions) {
      const rings = r.rings.map((ring) => ring.map((p) => proj(p.lon, p.lat)));
      const holder = holderOf(save, world.iso, r.id) || NEUTRAL;
      const mine = holder === save.playerColor;

      // Calcul du centroïde écran pour dessiner le symbole religieux sur la masse principale
      let largestRing = null;
      let maxBoxArea = -1;
      for (const ring of rings) {
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        for (const p of ring) {
          if (p.x < minX) minX = p.x;
          if (p.x > maxX) maxX = p.x;
          if (p.y < minY) minY = p.y;
          if (p.y > maxY) maxY = p.y;
        }
        const boxArea = (maxX - minX) * (maxY - minY);
        if (boxArea > maxBoxArea) {
          maxBoxArea = boxArea;
          largestRing = ring;
        }
      }
      const centroid = largestRing ? getPolygonCentroid(largestRing) : null;

      let religionSym = '';
      if (holder !== NEUTRAL) {
        if (mine && save.playerName) {
          religionSym = save.religionIcon || '✦';
        } else {
          const cult = CULTS.find(c => c.color === holder);
          if (cult) religionSym = cult.sym;
        }
      }

      screenPolys.push({ region: r, rings, color: holder, centroid, sym: religionSym });

      ctx.fillStyle = holder;
      ctx.strokeStyle = holder;
      ctx.lineWidth = 1.5 * dpr;
      ctx.globalAlpha = mine ? 0.95 : 0.82;
      for (const ring of rings) {
        ctx.beginPath();
        ring.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
      }

      // Collecte des arêtes pour détecter le contour extérieur
      const edgeCounts = {};
      for (const ring of rings) {
        for (let i = 0; i < ring.length; i++) {
          const p1 = ring[i], p2 = ring[(i + 1) % ring.length];
          const x1 = Math.round(p1.x * 10) / 10, y1 = Math.round(p1.y * 10) / 10;
          const x2 = Math.round(p2.x * 10) / 10, y2 = Math.round(p2.y * 10) / 10;
          const key = (x1 < x2 || (x1 === x2 && y1 < y2))
            ? `${x1},${y1}_${x2},${y2}` : `${x2},${y2}_${x1},${y1}`;
          if (!edgeCounts[key]) edgeCounts[key] = { count: 0, p1: { x: p1.x, y: p1.y }, p2: { x: p2.x, y: p2.y } };
          edgeCounts[key].count++;
        }
      }

      ctx.globalAlpha = 1;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';

      if (mine) {
        ctx.beginPath();
        for (const key in edgeCounts) if (edgeCounts[key].count === 1) {
          const e = edgeCounts[key]; ctx.moveTo(e.p1.x, e.p1.y); ctx.lineTo(e.p2.x, e.p2.y);
        }
        ctx.lineWidth = 1.6 * dpr;
        ctx.strokeStyle = 'rgba(255,255,255,0.8)';
        ctx.stroke();
      }

      ctx.beginPath();
      for (const key in edgeCounts) if (edgeCounts[key].count === 1) {
        const e = edgeCounts[key]; ctx.moveTo(e.p1.x, e.p1.y); ctx.lineTo(e.p2.x, e.p2.y);
      }
      ctx.lineWidth = (r.id === selectedId ? 3.2 : 1.2) * dpr;
      ctx.strokeStyle = r.id === selectedId ? '#fff' : 'rgba(0,0,0,0.35)';
      ctx.stroke();
    }

    // Surbrillance des zones conquérables (contour doré + halo).
    ctx.save();
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.shadowColor = '#ffe259';
    ctx.shadowBlur = 8 * dpr;
    ctx.strokeStyle = 'rgba(255,226,89,0.95)';
    ctx.lineWidth = 2.4 * dpr;
    for (const sp of screenPolys) {
      if (!attackable.has(sp.region.id) || sp.region.id === selectedId) continue;
      for (const ring of sp.rings) {
        ctx.beginPath();
        ring.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
        ctx.closePath();
        ctx.stroke();
      }
    }
    ctx.restore();

    // Dessiner les icônes de religion au centre des zones
    for (const sp of screenPolys) {
      if (!sp.centroid || !sp.sym) continue;
      const x = sp.centroid.x;
      const y = sp.centroid.y;
      
      const isImage = (sp.sym.startsWith('data:') || sp.sym.startsWith('http'));
      if (isImage) {
        const img = getCachedImage(sp.sym, () => {
          if (canvas.width) render();
        });
        if (img) {
          ctx.save();
          ctx.beginPath();
          ctx.arc(x, y, 10 * dpr, 0, Math.PI * 2);
          ctx.clip();
          ctx.drawImage(img, x - 10 * dpr, y - 10 * dpr, 20 * dpr, 20 * dpr);
          ctx.restore();
          
          ctx.beginPath();
          ctx.arc(x, y, 10 * dpr, 0, Math.PI * 2);
          ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)';
          ctx.lineWidth = 1.5 * dpr;
          ctx.stroke();
        }
      } else {
        ctx.beginPath();
        ctx.arc(x, y, 10 * dpr, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(10, 14, 30, 0.75)';
        ctx.fill();
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.25)';
        ctx.lineWidth = 1 * dpr;
        ctx.stroke();
        
        ctx.fillStyle = '#ffffff';
        ctx.font = `bold ${Math.round(11 * dpr)}px sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(sp.sym, x, y);
      }
    }
  }

  function pointInPoly(x, y, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const xi = ring[i].x, yi = ring[i].y, xj = ring[j].x, yj = ring[j].y;
      if (((yi > y) !== (yj > y)) && (x < ((xj - xi) * (y - yi)) / (yj - yi) + xi)) inside = !inside;
    }
    return inside;
  }
  function hit(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    const x = (clientX - rect.left) * dpr, y = (clientY - rect.top) * dpr;
    for (const sp of screenPolys) for (const ring of sp.rings) if (pointInPoly(x, y, ring)) return sp.region;
    return null;
  }

  let downX = 0, downY = 0, lastX = 0, lastY = 0, dragging = false, moved = 0, pinching = false;
  function onDown(e) {
    if (pinching) return;
    dragging = true; moved = 0;
    downX = e.clientX; downY = e.clientY; lastX = e.clientX; lastY = e.clientY;
    canvas.setPointerCapture && canvas.setPointerCapture(e.pointerId);
  }
  function onMove(e) {
    if (!dragging || pinching) return;
    const dx = e.clientX - lastX, dy = e.clientY - lastY;
    moved += Math.abs(dx) + Math.abs(dy);
    panX += dx * dpr; panY += dy * dpr;
    clampPan();
    lastX = e.clientX; lastY = e.clientY;
    render();
  }
  function onUp(e) {
    if (!dragging) return;
    dragging = false;
    if (Math.hypot(e.clientX - downX, e.clientY - downY) > 8 || moved > 8) return; // c'était un déplacement
    const r = hit(e.clientX, e.clientY);
    selectedId = r ? r.id : null;
    render();
    if (r) playUIClick();
    onSelect(r || null);
  }
  function onWheel(e) {
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const sx = (e.clientX - rect.left) * dpr, sy = (e.clientY - rect.top) * dpr;
    zoomAt(sx, sy, e.deltaY < 0 ? 1.1 : 0.9);
  }
  let pinchDist = null, pinchCx = 0, pinchCy = 0;
  function onTouchStart(e) {
    if (e.touches.length === 2) {
      pinching = true; dragging = false;
      pinchDist = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
    }
  }
  function onTouchMove(e) {
    if (e.touches.length === 2 && pinchDist !== null) {
      e.preventDefault();
      const dist = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
      const rect = canvas.getBoundingClientRect();
      pinchCx = ((e.touches[0].clientX + e.touches[1].clientX) / 2 - rect.left) * dpr;
      pinchCy = ((e.touches[0].clientY + e.touches[1].clientY) / 2 - rect.top) * dpr;
      zoomAt(pinchCx, pinchCy, dist / pinchDist);
      pinchDist = dist;
    }
  }
  function onTouchEnd(e) {
    if (e.touches.length < 2) { pinchDist = null; pinching = false; }
  }
  function onResizeEvt() { resize(); clampPan(); render(); }
  resize();
  addEventListener('resize', onResizeEvt);
  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointercancel', onUp);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  canvas.addEventListener('touchstart', onTouchStart);
  canvas.addEventListener('touchmove', onTouchMove, { passive: false });
  canvas.addEventListener('touchend', onTouchEnd);
  render();
  return {
    repaint() { selectedId = null; render(); },
    stop() {
      removeEventListener('resize', onResizeEvt);
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('pointercancel', onUp);
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('touchstart', onTouchStart);
      canvas.removeEventListener('touchmove', onTouchMove);
      canvas.removeEventListener('touchend', onTouchEnd);
    },
  };
}

/* ============================ Controleur d ecran ============================ */
let root = null, star = null, globe = null, country = null, playHandler = null, onCloseCb = null, curNeighbors = {};

export function setPlayHandler(fn) { playHandler = fn; }

/* Entrer dans un pays n'ouvre plus la carte des provinces : on atterrit dans le
   Hub Overworld 3D, où le choix de la zone se fait en franchissant un portail.
   La carte des provinces ne sert plus que de repli si aucun hub n'est branché. */
let hubHandler = null;
export function setHubHandler(fn) { hubHandler = fn; }

export async function openProgression(opts = {}) {
  onCloseCb = opts.onClose || null;
  soundEngine.init();
  soundEngine.bindUIClicks();
  if (root) { root.classList.remove('hidden'); return; }
  root = document.createElement('div');
  root.id = 'prog';
  root.innerHTML = `
    <canvas class="prog-stars"></canvas>
    <section class="prog-view prog-globe-view">
      <div class="prog-globe-stage">
        <canvas class="prog-globe"></canvas>
        <div class="prog-head">
          <button class="prog-back">‹ Menu</button>
          <button class="prog-edit">⚙ Paramètres</button>
          <button class="prog-skills-btn">✦ Compétences <span class="skill-pts-badge">0</span></button>
          <h2 class="prog-h2">Choisissez une terre à convertir</h2>
        </div>
        <p class="prog-hint">Glissez à gauche / à droite · touchez un pays pour y entrer</p>
        <div class="prog-loading">Chargement du monde…</div>
      </div>
      <aside class="prog-global-stats" aria-label="Classement des religions">
        <div class="prog-lb-head">
          <span class="prog-lb-title">Foi mondiale</span>
          <span class="prog-lb-pts">✦ <span id="global-skill-pts">0</span></span>
        </div>
        <div id="global-religion-lb" class="prog-lb-list"></div>
      </aside>
    </section>
    <section class="prog-view prog-country-view hidden">
      <div class="prog-head">
        <button class="prog-back2">‹ Globe</button>
        <h2 class="prog-c-title"></h2>
        <span class="prog-c-progress"></span>
      </div>
      <div class="prog-c-stats-container"></div>
      <canvas class="prog-country"></canvas>
      <div class="prog-zone-panel hidden">
        <div class="prog-zone-info"><span class="prog-zone-name"></span><span class="prog-zone-holder"></span></div>
        <button class="prog-zone-play">⚔ Convertir cette zone</button>
      </div>
    </section>
    
    <div id="skill-tree" class="skill-sanctum hidden">
      <div class="skill-cosmos" aria-hidden="true">
        <div class="skill-nebula"></div>
        <div class="skill-rays"></div>
        <canvas class="skill-embers"></canvas>
      </div>
      <header class="skill-top">
        <button type="button" class="skill-close" aria-label="Fermer">‹ Retour</button>
        <div class="skill-brand">
          <p class="skill-kicker">Sanctuaire</p>
          <h1>Arbre de Foi</h1>
        </div>
        <div class="skill-crystal" title="Points de foi disponibles">
          <span class="skill-crystal-glow"></span>
          <span class="skill-crystal-lbl">Foi</span>
          <span id="skill-points-count">0</span>
        </div>
      </header>
      <p class="skill-lore">Niveau <b id="skill-level">0</b> · XP <span id="skill-xp">0 / 0</span> · <span id="skill-spent-count">0</span> investis · +${POINTS_PER_LEVEL} pts / niveau</p>
      <nav id="skill-tabs" class="skill-seals" aria-label="Branches de l'arbre"></nav>
      <div class="skill-stage-wrap">
        <div id="skill-tree-body" class="skill-stage"></div>
        <aside id="skill-oracle" class="skill-oracle empty">
          <div class="skill-oracle-inner">
            <p class="skill-oracle-hint">Touchez une relique pour lire son dogme</p>
          </div>
        </aside>
      </div>
    </div>

    <div id="campaign-creator" class="overlay hidden">
      <div class="panel" style="max-width: 440px; padding: 24px;">
        <h1 id="creator-title" style="font-size: 32px; margin-bottom: 6px;">Nouvelle Croisade</h1>
        <p id="creator-subtitle" class="tag" style="margin-bottom: 16px;">Définissez votre culte pour la conquête du monde.</p>
        
        <div class="creator-field">
          <label class="lbl2">Nom du Prophète</label>
          <input type="text" id="creator-player-name" placeholder="Ex: Jean le Conquérant" maxlength="15" />
        </div>

        <div class="creator-field">
          <label class="lbl2">Nom de la Religion</label>
          <input type="text" id="creator-rel-name" placeholder="Ex: Pastafarisme" maxlength="20" />
        </div>

        <div class="creator-field">
          <label class="lbl2">Couleur Divine</label>
          <div id="creator-swatches"></div>
        </div>

        <div class="creator-field">
          <label class="lbl2">Symbole Sacré</label>
          <div id="creator-symbols"></div>
          
          <div class="creator-upload-container">
            <label for="creator-icon-upload" class="creator-upload-btn">
              <span>📤 Importer une image</span>
            </label>
            <input type="file" id="creator-icon-upload" accept="image/*" style="display:none;" />
            <div id="creator-upload-preview" class="hidden"></div>
            <button type="button" id="creator-icon-remove" class="secondary-btn hidden" style="padding: 6px 12px; font-size: 12px;">🗑 Retirer l'image</button>
          </div>
        </div>

        <div class="creator-field creator-leader-selector-field">
          <div class="creator-field-header">
            <label class="lbl2">Choix du Leader</label>
            <span class="leader-counter-badge" id="leader-counter-badge">1 / 4</span>
          </div>

          <div id="creator-card-carousel" class="character-card-carousel">
            <button type="button" class="card-nav-btn prev" id="card-nav-prev" title="Personnage précédent" aria-label="Personnage précédent">
              <svg viewBox="0 0 24 24" width="22" height="22" stroke="currentColor" stroke-width="2.5" fill="none"><path d="M15 18l-6-6 6-6"/></svg>
            </button>

            <div class="card-3d-stage" id="card-3d-stage">
              <div id="character-card-3d" class="character-card-3d"></div>
            </div>

            <button type="button" class="card-nav-btn next" id="card-nav-next" title="Personnage suivant" aria-label="Personnage suivant">
              <svg viewBox="0 0 24 24" width="22" height="22" stroke="currentColor" stroke-width="2.5" fill="none"><path d="M9 18l6-6-6-6"/></svg>
            </button>
          </div>

          <div id="card-dots-container" class="card-dots-container"></div>
        </div>

        <div class="creator-field">
          <label class="lbl2">Difficulté de l'IA</label>
          <div id="creator-difficulty" class="creator-diff">
            <button type="button" class="diff-btn" data-diff="easy">Facile</button>
            <button type="button" class="diff-btn" data-diff="normal">Normale</button>
            <button type="button" class="diff-btn" data-diff="hard">Difficile</button>
          </div>
        </div>

        <div style="display: flex; gap: 12px; justify-content: center; margin-top: 24px;">
          <button id="creator-start-btn" class="big" style="padding: 11px 24px; font-size: 15px;">Lancer la Croisade</button>
          <button id="creator-cancel-btn" class="secondary-btn" style="padding: 11px 24px; font-size: 15px;">Annuler</button>
        </div>
      </div>
    </div>`;
  document.body.appendChild(root);

  const globeView = root.querySelector('.prog-globe-view');
  const countryView = root.querySelector('.prog-country-view');
  const loading = root.querySelector('.prog-loading');
  const cTitle = root.querySelector('.prog-c-title');
  const cProgress = root.querySelector('.prog-c-progress');
  const countryCanvas = root.querySelector('.prog-country');
  const panel = root.querySelector('.prog-zone-panel');
  const zoneName = root.querySelector('.prog-zone-name');
  const zoneHolder = root.querySelector('.prog-zone-holder');
  const zonePlay = root.querySelector('.prog-zone-play');
  const creatorOverlay = root.querySelector('#campaign-creator');
  const skillOverlay = root.querySelector('#skill-tree');
  const skillTreeBody = root.querySelector('#skill-tree-body');
  const creatorPlayerName = root.querySelector('#creator-player-name');
  const creatorRelName = root.querySelector('#creator-rel-name');
  const creatorSwatches = root.querySelector('#creator-swatches');
  const creatorSymbols = root.querySelector('#creator-symbols');
  const creatorUploadInput = root.querySelector('#creator-icon-upload');
  const creatorUploadPreview = root.querySelector('#creator-upload-preview');
  const creatorIconRemove = root.querySelector('#creator-icon-remove');
  const creatorStartBtn = root.querySelector('#creator-start-btn');
  const creatorCancelBtn = root.querySelector('#creator-cancel-btn');
  const creatorTitle = root.querySelector('#creator-title');
  const creatorSubtitle = root.querySelector('#creator-subtitle');
  const creatorDifficulty = root.querySelector('#creator-difficulty');

  let selectedCreatorColor = CULTS[0].color;
  const defaultSymbols = ['✝', '☪', '🕉', '☸', '✡', '⛩', '☯', '☬', '🔥', '👁', '🔱', '👑', '☀', '✦'];
  let selectedCreatorSymbol = defaultSymbols[0];
  let customUploadedIcon = null;
  let creatorEditMode = false;
  let selectedDifficulty = localStorage.getItem('cultio_difficulty') || 'normal';
  let selectedCreatorLeader = 'monk';
  let isCardAnimating = false;

  function renderCreatorLeaders(direction = 0) {
    const cardEl = root.querySelector('#character-card-3d');
    const dotsEl = root.querySelector('#card-dots-container');
    const badgeEl = root.querySelector('#leader-counter-badge');
    if (!cardEl) return;

    let currentIdx = LEADERS.findIndex(l => l.id === selectedCreatorLeader);
    if (currentIdx < 0) currentIdx = 0;

    const buildCardHTML = (l) => `
      <div class="card-3d-inner" style="--leader-color: ${l.color}; background: ${l.bgGradient};">
        <div class="card-header-badge">‹ ${l.archetype.toUpperCase()} ›</div>
        
        <div class="card-hero-frame">
          <div class="card-hero-glow" style="background: ${l.color}"></div>
          <div class="card-hero-img" style="background-image: url('${l.img}')"></div>
        </div>

        <div class="card-hero-info">
          <h3 class="card-hero-name">${l.name}</h3>
          <div class="card-perk-badge">${l.perk}</div>
          <p class="card-hero-desc">${l.desc}</p>
          
          <div class="card-stats-grid">
            <div class="stat-bar-group">
              <span class="stat-lbl">Vitesse</span>
              <div class="stat-bar-track">
                <div class="stat-bar-fill" style="width: ${l.stats.vitesse}%;"></div>
              </div>
            </div>
            <div class="stat-bar-group">
              <span class="stat-lbl">Conversion</span>
              <div class="stat-bar-track">
                <div class="stat-bar-fill" style="width: ${l.stats.conversion}%;"></div>
              </div>
            </div>
            <div class="stat-bar-group">
              <span class="stat-lbl">Ferveur</span>
              <div class="stat-bar-track">
                <div class="stat-bar-fill" style="width: ${l.stats.ferveur}%;"></div>
              </div>
            </div>
          </div>
        </div>
      </div>
    `;

    const updateDots = (activeIdx) => {
      if (!dotsEl) return;
      dotsEl.innerHTML = LEADERS.map((l, i) => `
        <button type="button" class="card-dot ${i === activeIdx ? 'sel' : ''}" data-idx="${i}" title="${l.name}"></button>
      `).join('');
      dotsEl.querySelectorAll('.card-dot').forEach((dot) => {
        dot.addEventListener('click', () => {
          const targetIdx = parseInt(dot.dataset.idx, 10);
          if (targetIdx !== currentIdx && !isCardAnimating) {
            const dir = targetIdx > currentIdx ? 1 : -1;
            selectedCreatorLeader = LEADERS[targetIdx].id;
            renderCreatorLeaders(dir);
          }
        });
      });
    };

    const updateBadge = (idx) => {
      if (badgeEl) badgeEl.textContent = `${idx + 1} / ${LEADERS.length}`;
    };

    if (direction === 0) {
      cardEl.innerHTML = buildCardHTML(LEADERS[currentIdx]);
      cardEl.style.transform = 'rotateY(0deg) scale(1)';
      cardEl.style.opacity = '1';
      updateDots(currentIdx);
      updateBadge(currentIdx);
      return;
    }

    if (isCardAnimating) return;
    isCardAnimating = true;

    // Directing rotation (Next rotates card away left, Prev rotates card away right)
    const exitAngle = direction > 0 ? -90 : 90;
    const enterAngle = direction > 0 ? 90 : -90;

    cardEl.style.transition = 'transform 0.22s cubic-bezier(0.4, 0, 0.2, 1), opacity 0.22s ease';
    cardEl.style.transform = `rotateY(${exitAngle}deg) scale(0.88)`;
    cardEl.style.opacity = '0.3';

    setTimeout(() => {
      currentIdx = (currentIdx + direction + LEADERS.length) % LEADERS.length;
      selectedCreatorLeader = LEADERS[currentIdx].id;

      cardEl.innerHTML = buildCardHTML(LEADERS[currentIdx]);
      updateDots(currentIdx);
      updateBadge(currentIdx);

      cardEl.style.transition = 'none';
      cardEl.style.transform = `rotateY(${enterAngle}deg) scale(0.88)`;

      void cardEl.offsetWidth; // force reflow

      cardEl.style.transition = 'transform 0.28s cubic-bezier(0.175, 0.885, 0.32, 1.275), opacity 0.28s ease';
      cardEl.style.transform = 'rotateY(0deg) scale(1)';
      cardEl.style.opacity = '1';

      setTimeout(() => {
        isCardAnimating = false;
      }, 290);
    }, 220);
  }

  // Bind nav buttons and interactions
  setTimeout(() => {
    const btnPrev = root.querySelector('#card-nav-prev');
    const btnNext = root.querySelector('#card-nav-next');
    if (btnPrev) btnPrev.addEventListener('click', () => renderCreatorLeaders(-1));
    if (btnNext) btnNext.addEventListener('click', () => renderCreatorLeaders(1));

    const cardStage = root.querySelector('#card-3d-stage');
    const card3D = root.querySelector('#character-card-3d');
    if (cardStage && card3D) {
      cardStage.addEventListener('mousemove', (e) => {
        if (isCardAnimating) return;
        const rect = cardStage.getBoundingClientRect();
        const px = (e.clientX - rect.left) / rect.width - 0.5;
        const py = (e.clientY - rect.top) / rect.height - 0.5;
        card3D.style.transform = `rotateY(${px * 20}deg) rotateX(${-py * 20}deg) scale(1.02)`;
      });
      cardStage.addEventListener('mouseleave', () => {
        if (isCardAnimating) return;
        card3D.style.transform = 'rotateY(0deg) rotateX(0deg) scale(1)';
      });

      let touchX = 0;
      cardStage.addEventListener('touchstart', (e) => {
        touchX = e.touches[0].clientX;
      }, { passive: true });
      cardStage.addEventListener('touchend', (e) => {
        if (isCardAnimating) return;
        const endX = e.changedTouches[0].clientX;
        const diff = endX - touchX;
        if (Math.abs(diff) > 35) {
          renderCreatorLeaders(diff < 0 ? 1 : -1);
        }
      }, { passive: true });
    }
  }, 0);

  // Keyboard navigation listener
  document.addEventListener('keydown', (e) => {
    if (creatorOverlay && !creatorOverlay.classList.contains('hidden')) {
      if (e.key === 'ArrowLeft') {
        renderCreatorLeaders(-1);
      } else if (e.key === 'ArrowRight') {
        renderCreatorLeaders(1);
      }
    }
  });

  function highlightDifficulty() {
    creatorDifficulty.querySelectorAll('.diff-btn').forEach((b) => {
      b.classList.toggle('sel', b.dataset.diff === selectedDifficulty);
    });
  }
  creatorDifficulty.querySelectorAll('.diff-btn').forEach((b) => {
    b.addEventListener('click', () => {
      selectedDifficulty = b.dataset.diff;
      highlightDifficulty();
    });
  });
  highlightDifficulty();

  /* Pré-remplit le créateur à partir de la sauvegarde (couleur + icône + noms + difficulté). */
  function prefillCreatorFromSave(s) {
    creatorPlayerName.value = s.playerName || '';
    creatorRelName.value = s.religionName || '';
    selectedDifficulty = localStorage.getItem('cultio_difficulty') || 'normal';
    highlightDifficulty();

    if (s.playerColor) {
      selectedCreatorColor = s.playerColor;
      creatorSwatches.querySelectorAll('.swatch').forEach((sw) => {
        const on = sw.style.backgroundColor === s.playerColor || sw.style.background === s.playerColor;
        sw.classList.toggle('sel', on);
      });
    }

    const icon = s.religionIcon;
    if (icon && icon.startsWith('data:')) {
      selectedCreatorSymbol = icon;
      customUploadedIcon = icon;
      creatorUploadPreview.style.backgroundImage = `url(${icon})`;
      creatorUploadPreview.classList.remove('hidden');
      creatorUploadPreview.classList.add('sel');
      creatorIconRemove.classList.remove('hidden');
      creatorSymbols.querySelectorAll('.symbol-btn').forEach((b) => b.classList.remove('sel'));
    } else {
      customUploadedIcon = null;
      selectedCreatorSymbol = icon || defaultSymbols[0];
      creatorUploadPreview.classList.add('hidden');
      creatorUploadPreview.classList.remove('sel');
      creatorIconRemove.classList.add('hidden');
      creatorSymbols.querySelectorAll('.symbol-btn').forEach((b) => {
        b.classList.toggle('sel', b.textContent === selectedCreatorSymbol);
      });
    }

    selectedCreatorLeader = s.playerLeader || 'monk';
    renderCreatorLeaders();
  }

  /* Ouvre le créateur en mode « édition » : ne modifie que la religion, garde la partie. */
  function openReligionEditor() {
    const s = loadSave();
    if (!s.playerName) return;
    creatorEditMode = true;
    creatorTitle.textContent = 'Paramètres';
    creatorSubtitle.textContent = 'Modifiez votre religion, votre leader et la difficulté. Votre progression est conservée.';
    creatorStartBtn.textContent = 'Enregistrer';
    creatorCancelBtn.textContent = 'Annuler';
    prefillCreatorFromSave(s);
    creatorOverlay.classList.remove('hidden');
  }

  /* Retire l'image importée et revient au premier symbole par défaut. */
  function clearUploadedIcon() {
    customUploadedIcon = null;
    creatorUploadInput.value = '';
    creatorUploadPreview.style.backgroundImage = '';
    creatorUploadPreview.classList.add('hidden');
    creatorUploadPreview.classList.remove('sel');
    creatorIconRemove.classList.add('hidden');
    const first = creatorSymbols.querySelector('.symbol-btn');
    creatorSymbols.querySelectorAll('.symbol-btn').forEach((b) => b.classList.remove('sel'));
    if (first) { first.classList.add('sel'); selectedCreatorSymbol = first.textContent; }
    else selectedCreatorSymbol = CULTS[0].sym;
  }
  creatorIconRemove.addEventListener('click', clearUploadedIcon);

  let activeSkillBranch = SKILL_BRANCHES[0].id;
  let selectedSkillId = null;
  let skillEmberRaf = 0;

  function refreshSkillPointsUI() {
    const save = loadSave();
    const pts = getSkillPoints(save);
    const spent = spentSkillPoints(save);
    const badge = root.querySelector('.skill-pts-badge');
    const globalPts = root.querySelector('#global-skill-pts');
    const count = root.querySelector('#skill-points-count');
    const spentEl = root.querySelector('#skill-spent-count');
    const levelEl = root.querySelector('#skill-level');
    const xpEl = root.querySelector('#skill-xp');
    const crystal = root.querySelector('.skill-crystal');
    if (badge) {
      badge.textContent = pts;
      badge.classList.toggle('has-pts', pts > 0);
    }
    if (globalPts) globalPts.textContent = String(pts);
    if (count) count.textContent = String(pts);
    if (spentEl) spentEl.textContent = String(spent);
    if (levelEl) levelEl.textContent = String(save.level | 0);
    if (xpEl) xpEl.textContent = `${save.xp | 0} / ${xpToNext(save.level | 0)}`;
    if (crystal) crystal.classList.toggle('lit', pts > 0);
  }

  function stopSkillEmbers() {
    if (skillEmberRaf) cancelAnimationFrame(skillEmberRaf);
    skillEmberRaf = 0;
  }

  function startSkillEmbers() {
    const canvas = skillOverlay.querySelector('.skill-embers');
    if (!canvas) return;
    stopSkillEmbers();
    const ctx = canvas.getContext('2d');
    const particles = [];
    const resize = () => {
      const dpr = Math.min(devicePixelRatio || 1, 1.5);
      canvas.width = canvas.clientWidth * dpr;
      canvas.height = canvas.clientHeight * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    const onResize = () => resize();
    addEventListener('resize', onResize);
    const branch = SKILL_BRANCHES.find((b) => b.id === activeSkillBranch);
    const tint = branch ? branch.tint : '#ffb300';
    for (let i = 0; i < 48; i++) {
      particles.push({
        x: Math.random() * canvas.clientWidth,
        y: Math.random() * canvas.clientHeight,
        r: 0.6 + Math.random() * 2.2,
        vy: -0.15 - Math.random() * 0.55,
        vx: (Math.random() - 0.5) * 0.25,
        a: 0.15 + Math.random() * 0.55,
        w: Math.random() * Math.PI * 2,
      });
    }
    const tick = () => {
      if (skillOverlay.classList.contains('hidden')) {
        removeEventListener('resize', onResize);
        stopSkillEmbers();
        return;
      }
      const w = canvas.clientWidth, h = canvas.clientHeight;
      ctx.clearRect(0, 0, w, h);
      for (const p of particles) {
        p.w += 0.02;
        p.x += p.vx + Math.sin(p.w) * 0.12;
        p.y += p.vy;
        if (p.y < -8) { p.y = h + 8; p.x = Math.random() * w; }
        if (p.x < -8) p.x = w + 8;
        if (p.x > w + 8) p.x = -8;
        ctx.beginPath();
        ctx.fillStyle = tint;
        ctx.globalAlpha = p.a * (0.55 + 0.45 * Math.sin(p.w * 2));
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
      skillEmberRaf = requestAnimationFrame(tick);
    };
    skillEmberRaf = requestAnimationFrame(tick);
  }

  function renderSkillTabs() {
    const tabs = root.querySelector('#skill-tabs');
    tabs.innerHTML = '';
    const save = loadSave();
    SKILL_BRANCHES.forEach((branch, idx) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'skill-seal' + (branch.id === activeSkillBranch ? ' sel' : '');
      btn.style.setProperty('--branch', branch.tint);
      btn.style.setProperty('--i', String(idx));
      const nodes = SKILL_DEFS.filter((d) => d.branch === branch.id);
      const lvSum = nodes.reduce((n, d) => n + getSkillLevel(save, d.id), 0);
      const lvMax = nodes.reduce((n, d) => n + d.max, 0);
      const pct = lvMax ? Math.round((lvSum / lvMax) * 100) : 0;
      const rootIcon = nodes[0]?.icon || '✦';
      btn.innerHTML = `
        <span class="skill-seal-ring"></span>
        <span class="skill-seal-ico">${rootIcon}</span>
        <span class="skill-seal-name">${branch.name}</span>
        <span class="skill-seal-bar"><i style="width:${pct}%"></i></span>`;
      btn.addEventListener('click', () => {
        activeSkillBranch = branch.id;
        selectedSkillId = null;
        renderSkillTree();
        startSkillEmbers();
      });
      tabs.appendChild(btn);
    });
  }

  function showSkillOracle(def) {
    const oracle = root.querySelector('#skill-oracle');
    const save = loadSave();
    const branch = SKILL_BRANCHES.find((b) => b.id === def.branch);
    const lv = getSkillLevel(save, def.id);
    const unlocked = isSkillUnlocked(save, def);
    const canUp = canUpgradeSkill(save, def.id);
    const maxed = lv >= def.max;
    const cost = nextUpgradeCost(save, def.id);
    const reqTxt = def.requires
      ? Object.entries(def.requires).map(([id, m]) => {
          const d = SKILL_DEFS.find((x) => x.id === id);
          return `${d ? d.name : id} ${m}`;
        }).join(' · ')
      : null;
    const eff = skillEffectSummary(def, lv);
    const effHtml = eff ? `
        <div class="skill-oracle-effect">
          <div class="skill-eff-row"><span>Bonus cumulé</span><b>${eff.current || '—'}</b></div>
          <div class="skill-eff-row next">
            <span>${maxed ? 'Apogée' : `Niveau ${lv + 1}`}</span>
            <b>${maxed ? 'Max atteint' : eff.next}</b>
          </div>
        </div>` : '';
    oracle.className = 'skill-oracle' + (canUp ? ' can-up' : '') + (maxed ? ' maxed' : '') + (!unlocked ? ' locked' : '');
    oracle.style.setProperty('--branch', branch?.tint || '#ffb300');
    oracle.innerHTML = `
      <div class="skill-oracle-inner">
        <div class="skill-oracle-ico">${def.icon}</div>
        <p class="skill-oracle-branch">${branch?.name || ''}</p>
        <h2>${def.name}</h2>
        <p class="skill-oracle-desc">${def.desc}</p>
        ${effHtml}
        <div class="skill-oracle-meter">
          <div class="skill-oracle-meter-fill" style="width:${(lv / def.max) * 100}%"></div>
          <span>Niveau ${lv} / ${def.max}</span>
        </div>
        ${reqTxt && !unlocked ? `<p class="skill-oracle-req">Scellé — ${reqTxt}</p>` : ''}
        <button type="button" class="skill-oracle-cta" ${canUp ? '' : 'disabled'}>
          ${maxed ? 'Apogée atteinte' : !unlocked ? 'Relique scellée' : canUp ? `Investir ${cost} point${cost > 1 ? 's' : ''}` : `Il faut ${cost} pt${cost > 1 ? 's' : ''}`}
        </button>
      </div>`;
    const cta = oracle.querySelector('.skill-oracle-cta');
    cta.addEventListener('click', () => {
      if (!upgradeSkill(def.id)) return;
      selectedSkillId = def.id;
      renderSkillTree();
      refreshSkillPointsUI();
      toast(`✦ ${def.name} — niveau ${getSkillLevel(loadSave(), def.id)}`);
    });
  }

  function renderSkillTree() {
    const save = loadSave();
    renderSkillTabs();
    skillTreeBody.innerHTML = '';
    const branch = SKILL_BRANCHES.find((b) => b.id === activeSkillBranch) || SKILL_BRANCHES[0];
    skillOverlay.style.setProperty('--branch', branch.tint);
    skillTreeBody.style.setProperty('--branch', branch.tint);

    const nodes = SKILL_DEFS.filter((d) => d.branch === branch.id);
    const W = 360, H = 520, padY = 56;
    const coords = nodes.map((_, i) => {
      const t = nodes.length === 1 ? 0.5 : i / (nodes.length - 1);
      const y = padY + t * (H - padY * 2);
      const side = i % 2 === 0 ? -1 : 1;
      const x = W / 2 + side * (i === 0 ? 0 : 78);
      return { x, y };
    });

    const stage = document.createElement('div');
    stage.className = 'skill-constellation';
    stage.style.width = W + 'px';
    stage.style.height = H + 'px';

    let paths = '';
    for (let i = 0; i < coords.length - 1; i++) {
      const a = coords[i], b = coords[i + 1];
      const midY = (a.y + b.y) / 2;
      const lit = isSkillUnlocked(save, nodes[i + 1]) || getSkillLevel(save, nodes[i].id) > 0;
      paths += `<path class="skill-vein${lit ? ' lit' : ''}" d="M ${a.x} ${a.y} C ${a.x} ${midY}, ${b.x} ${midY}, ${b.x} ${b.y}" />`;
    }

    stage.innerHTML = `
      <svg class="skill-veins" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet">
        <defs>
          <linearGradient id="veinGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="${branch.tint}" stop-opacity="0.15"/>
            <stop offset="50%" stop-color="${branch.tint}" stop-opacity="0.9"/>
            <stop offset="100%" stop-color="#ffe259" stop-opacity="0.55"/>
          </linearGradient>
          <filter id="veinGlow" x="-40%" y="-40%" width="180%" height="180%">
            <feGaussianBlur stdDeviation="3" result="b"/>
            <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
          </filter>
        </defs>
        <path class="skill-trunk" d="M ${W / 2} ${padY - 20} L ${W / 2} ${H - padY + 24}" />
        ${paths}
      </svg>
      <div class="skill-relics"></div>`;

    const relics = stage.querySelector('.skill-relics');
    nodes.forEach((def, i) => {
      const lv = getSkillLevel(save, def.id);
      const unlocked = isSkillUnlocked(save, def);
      const canUp = canUpgradeSkill(save, def.id);
      const maxed = lv >= def.max;
      const c = coords[i];
      const el = document.createElement('button');
      el.type = 'button';
      el.className = 'skill-relic'
        + (lv > 0 ? ' owned' : '')
        + (maxed ? ' maxed' : '')
        + (!unlocked ? ' locked' : '')
        + (canUp ? ' can-up' : '')
        + (selectedSkillId === def.id ? ' focus' : '');
      el.style.left = c.x + 'px';
      el.style.top = c.y + 'px';
      el.style.setProperty('--delay', `${i * 0.07}s`);
      el.innerHTML = `
        <span class="skill-relic-aura"></span>
        <span class="skill-relic-core">${def.icon}</span>
        <span class="skill-relic-lv">${lv}/${def.max}</span>
        <span class="skill-relic-name">${def.name}</span>`;
      el.addEventListener('click', () => {
        selectedSkillId = def.id;
        stage.querySelectorAll('.skill-relic').forEach((r) => r.classList.remove('focus'));
        el.classList.add('focus');
        showSkillOracle(def);
      });
      relics.appendChild(el);
    });

    skillTreeBody.appendChild(stage);

    if (selectedSkillId && nodes.some((n) => n.id === selectedSkillId)) {
      showSkillOracle(nodes.find((n) => n.id === selectedSkillId));
    } else {
      selectedSkillId = nodes[0]?.id || null;
      if (nodes[0]) {
        const first = relics.querySelector('.skill-relic');
        if (first) first.classList.add('focus');
        showSkillOracle(nodes[0]);
      }
    }
    refreshSkillPointsUI();
  }

  function closeSkillTree() {
    skillOverlay.classList.add('hidden');
    skillOverlay.classList.remove('enter');
    stopSkillEmbers();
  }

  function openSkillTree() {
    if (!loadSave().playerName) {
      toast('Créez d\'abord votre culte pour débloquer l\'arbre de foi.');
      return;
    }
    renderSkillTree();
    skillOverlay.classList.remove('hidden');
    requestAnimationFrame(() => skillOverlay.classList.add('enter'));
    startSkillEmbers();
  }

  root.querySelector('.prog-skills-btn').addEventListener('click', openSkillTree);
  root.querySelector('.skill-close').addEventListener('click', closeSkillTree);

  /* Rattrape les points de foi non crédités : parcourt tous les pays et rejoue
     l'attribution (idempotente) pour majorité + conquête 100 %. Corrige les
     campagnes commencées avant l'arbre de foi, ou tout gain manqué. */
  function reconcileConquestSkills() {
    const save = loadSave();
    if (!save.playerColor || !save.conq) return;
    let totalGained = 0;
    for (const iso in save.conq) {
      const zones = save.conq[iso];
      const colors = Object.values(zones || {});
      if (!colors.length) continue;
      const isMajority = isMajorityMine(save, iso);
      const isFull = colors.every((c) => c === save.playerColor);
      if (!isMajority && !isFull) continue;
      const award = awardConquestSkills({ iso, wasMajority: false, isMajority, isFull });
      totalGained += award.gained;
    }
    if (totalGained > 0) {
      toast(`✦ ${totalGained} point${totalGained > 1 ? 's' : ''} de foi récupéré${totalGained > 1 ? 's' : ''} !`);
    }
  }

  function checkPassiveChanges() {
    const save = loadSave();
    if (save.passiveChanges && save.passiveChanges.length > 0) {
      const pc = save.playerColor;
      const msgs = [];
      for (const change of save.passiveChanges) {
        if (change.newOwner === pc) {
          let oldName = 'les barbares';
          if (change.oldOwner !== NEUTRAL) {
            const cult = CULTS.find(c => c.color === change.oldOwner);
            if (cult) oldName = `le culte ${cult.name}`;
          }
          msgs.push(`🎉 Victoire passive : Votre culte a converti un territoire en ${change.countryName} (repris sur ${oldName}) !`);
        } else if (change.oldOwner === pc) {
          let newName = 'un rival';
          const cult = CULTS.find(c => c.color === change.newOwner);
          if (cult) newName = `le culte ${cult.name}`;
          msgs.push(`⚠️ Défaite passive : ${newName} a converti l'un de vos territoires en ${change.countryName} !`);
        }
      }
      
      // Affiche les messages séquentiellement
      msgs.forEach((msg, idx) => {
        setTimeout(() => {
          toast(msg);
        }, idx * 3000);
      });

      save.passiveChanges = [];
      persist(save);
    }
  }

  function updateGlobalStatsUI() {
    const board = getReligionWorldScores();
    const list = root.querySelector('#global-religion-lb');
    if (list) {
      if (!board.religions.length) {
        list.innerHTML = `<div class="prog-lb-empty">Aucune foi recensée</div>`;
      } else {
        list.innerHTML = board.religions.map((r, i) => {
          const symHtml = (r.sym.startsWith('data:') || r.sym.startsWith('http'))
            ? `<img src="${r.sym}" alt="" />`
            : `<span class="prog-lb-sym-txt">${r.sym}</span>`;
          return `
            <div class="prog-lb-row${r.isPlayer ? ' me' : ''}" style="--rc:${r.color}">
              <span class="prog-lb-rank">${i + 1}</span>
              <span class="prog-lb-sym" style="background:${r.color}">${symHtml}</span>
              <span class="prog-lb-body">
                <span class="prog-lb-name">${r.name} <span class="prog-lb-lv">Nv ${r.level}</span></span>
                <span class="prog-lb-stats">
                  <span class="prog-lb-pct">${r.pct}</span>
                  <span class="prog-lb-sep">·</span>
                  <span class="prog-lb-pop"><span class="prog-lb-pop-ico" aria-label="fidèles" title="fidèles">👤</span>${formatBelievers(r.believers)}</span>
                </span>
              </span>
            </div>`;
        }).join('');
      }
    }
    refreshSkillPointsUI();
    checkPassiveChanges();
  }

  // Remplir les couleurs du créateur
  creatorSwatches.innerHTML = '';
  CULTS.forEach((c) => {
    const sw = document.createElement('div');
    sw.className = 'swatch';
    sw.style.background = c.color;
    sw.addEventListener('pointerdown', () => {
      selectedCreatorColor = c.color;
      creatorSwatches.querySelectorAll('.swatch').forEach(s => s.classList.remove('sel'));
      sw.classList.add('sel');
    });
    creatorSwatches.appendChild(sw);
  });
  creatorSwatches.children[0].classList.add('sel');

  // Remplir les symboles du créateur
  creatorSymbols.innerHTML = '';
  defaultSymbols.forEach((sym) => {
    const btn = document.createElement('div');
    btn.className = 'symbol-btn';
    btn.textContent = sym;
    btn.addEventListener('pointerdown', () => {
      selectedCreatorSymbol = sym;
      customUploadedIcon = null;
      creatorSymbols.querySelectorAll('.symbol-btn').forEach(b => b.classList.remove('sel'));
      creatorUploadPreview.classList.remove('sel');
      creatorIconRemove.classList.add('hidden');
      btn.classList.add('sel');
    });
    creatorSymbols.appendChild(btn);
  });
  creatorSymbols.children[0].classList.add('sel');

  // Importation d'image
  creatorUploadInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (evt) => {
      customUploadedIcon = evt.target.result;
      creatorUploadPreview.style.backgroundImage = `url(${customUploadedIcon})`;
      creatorUploadPreview.classList.remove('hidden');
      creatorIconRemove.classList.remove('hidden');
      
      // Sélectionner l'image uploadée
      selectedCreatorSymbol = customUploadedIcon;
      creatorSymbols.querySelectorAll('.symbol-btn').forEach(b => b.classList.remove('sel'));
      creatorUploadPreview.classList.add('sel');
    };
    reader.readAsDataURL(file);
  });

  creatorUploadPreview.addEventListener('pointerdown', () => {
    if (customUploadedIcon) {
      selectedCreatorSymbol = customUploadedIcon;
      creatorSymbols.querySelectorAll('.symbol-btn').forEach(b => b.classList.remove('sel'));
      creatorUploadPreview.classList.add('sel');
    }
  });

  // Annulation
  creatorCancelBtn.addEventListener('click', () => {
    const s = loadSave();
    if (creatorEditMode) creatorEditMode = false;
    if (s.playerName) {
      creatorOverlay.classList.add('hidden');
    } else {
      closeProgression();
    }
  });

  function startCampaign(pName, rName, color, icon, leaderId) {
    const save = {
      playerName: pName,
      religionName: rName,
      playerColor: color,
      religionIcon: icon,
      playerLeader: leaderId || 'monk',
      skillPoints: 0,
      skills: {},
      skillMajority: {},
      skillFull: {},
      level: 0,
      xp: 0,
      ai: {},
      conq: {},
      conqPop: {},
      conqMaxPop: {},
      seeded: false,
      worldModel: 2,
    };
    persist(save);
    creatorOverlay.classList.add('hidden');

    // Réinitialisation visuelle du globe
    if (globe) globe.stop();
    globe = createGlobe(root.querySelector('.prog-globe'), {
      onPick(world) {
        const sCurrent = loadSave();
        if (!canEnterCountry(sCurrent, world.iso)) {
          globe.focusWorld(world);
          toast(`« ${world.name} » n'est pas accessible depuis vos terres.`);
          return;
        }
        globe.focusWorld(world);
        setTimeout(() => enterCountry(world), 360);
      },
      onUnknown() { toast('Cette terre n\'a pas encore été révélée.'); },
    });

    // Attribuer une zone de départ à chaque religion, PUIS pré-initialiser les
    // autres pays. Séquentiel pour éviter que la pré-init n'écrase (race sur
    // localStorage) la zone de départ tout juste attribuée au joueur.
    (async () => {
      try {
        await seedReligionStarts();
        ensureDiscovery(loadSave());   // lève le brouillard sur le pays de départ + voisins
        const sCurrent = loadSave();
        const startWorld = WORLDS[ISO_WORLD[sCurrent.startIso]];
        if (startWorld) {
          setTimeout(() => globe.focusWorld(startWorld), 200);
          setTimeout(() => toast(`Votre foi naît en ${startWorld.name}.`), 400);
        }
        updateGlobalStatsUI();

        const BATCH = 20;
        for (let i = 0; i < WORLDS.length; i += BATCH) {
          const chunk = WORLDS.slice(i, i + BATCH);
          const loaded = await Promise.all(chunk.map(async (w) => {
            try { return { w, regs: await loadRegions(w.iso) }; }
            catch { return null; }
          }));
          const s = loadSave();
          for (const item of loaded) {
            if (!item) continue;
            if (s.conq && s.conq[item.w.iso]) continue;
            initCountry(s, item.w, item.regs);
          }
          updateGlobalStatsUI();
        }
      } catch (err) {
        console.error(err);
      }
    })();
  }

  // Lancement de la campagne (ou enregistrement des modifications)
  creatorStartBtn.addEventListener('click', () => {
    const pName = creatorPlayerName.value.trim();
    const rName = creatorRelName.value.trim();
    if (!pName || !rName) {
      toast("Veuillez renseigner les noms du Prophète et de la Religion.");
      return;
    }
    if (creatorEditMode) {
      const save = loadSave();
      const oldColor = save.playerColor;
      const newColor = selectedCreatorColor;
      // Les zones sont stockées par couleur : migrer pour ne rien perdre.
      if (oldColor && newColor && oldColor !== newColor && save.conq) {
        for (const iso in save.conq) {
          const zones = save.conq[iso];
          for (const rid in zones) {
            // Échange : le joueur prend newColor, une IA éventuelle récupère oldColor.
            if (zones[rid] === oldColor) zones[rid] = newColor;
            else if (zones[rid] === newColor) zones[rid] = oldColor;
          }
        }
      }
      save.playerName = pName;
      save.religionName = rName;
      save.playerColor = newColor;
      save.religionIcon = selectedCreatorSymbol;
      save.playerLeader = selectedCreatorLeader;
      persist(save);
      localStorage.setItem('cultio_difficulty', selectedDifficulty);
      creatorEditMode = false;
      creatorOverlay.classList.add('hidden');
      updateGlobalStatsUI();
      toast('Paramètres mis à jour ✦');
      return;
    }
    localStorage.setItem('cultio_difficulty', selectedDifficulty);
    startCampaign(pName, rName, selectedCreatorColor, selectedCreatorSymbol, selectedCreatorLeader);
  });

  star = createStarfield(root.querySelector('.prog-stars'));
  let curWorld = null, curRegions = null, selectedRegion = null;

  root.querySelector('.prog-back').addEventListener('click', closeProgression);

  root.querySelector('.prog-edit').addEventListener('click', openReligionEditor);

  root.querySelector('.prog-back2').addEventListener('click', () => {
    country && country.stop(); country = null;
    countryView.classList.add('hidden'); globeView.classList.remove('hidden');
    panel.classList.add('hidden');
  });

  function refreshProgress() {
    const save = loadSave();
    const n = conqueredCount(save, curWorld, curRegions), t = curRegions.length;
    cProgress.textContent = `${n} / ${t} zones`;
    cProgress.style.color = n === t ? '#ffd24d' : '#cfe';

    // Remplissage des statistiques des religions
    const pcts = getCountryReligionPercentages(save, curWorld, curRegions);
    const statsContainer = root.querySelector('.prog-c-stats-container');
    if (statsContainer) {
      statsContainer.innerHTML = `
        <div class="prog-c-stats-title">Religions Présentes</div>
        ${pcts.map(p => {
          const symHtml = (p.sym.startsWith('data:') || p.sym.startsWith('http'))
            ? `<img src="${p.sym}" class="stats-cult-icon" />`
            : p.sym;
          return `
            <div class="prog-c-stats-row">
              <span class="prog-c-stats-dot" style="background: ${p.color}"></span>
              <span class="prog-c-stats-name">${symHtml} ${p.name}</span>
              <span class="prog-c-stats-pct">${p.percent}%</span>
            </div>
          `;
        }).join('')}
      `;
    }
  }

  function selectZone(region) {
    selectedRegion = region;
    if (!region) { panel.classList.add('hidden'); return; }
    const save = loadSave();
    const holder = holderOf(save, curWorld.iso, region.id);
    const mine = holder === save.playerColor;
    
    let religionName = 'Terres barbares';
    let religionColor = (holder && holder !== NEUTRAL) ? holder : NEUTRAL;
    let religionSym = '⚔';
    
    if (holder && holder !== NEUTRAL) {
      if (holder === save.playerColor && save.playerName) {
        religionName = save.religionName || 'Mon Culte';
        religionSym = save.religionIcon || '✦';
      } else {
        const cult = CULTS.find(c => c.color === holder);
        if (cult) {
          religionName = `Culte ${cult.name}`;
          religionSym = cult.sym;
        }
      }
    }
    
    const symHtml = (religionSym.startsWith('data:') || religionSym.startsWith('http'))
      ? `<img src="${religionSym}" class="stats-cult-icon" />`
      : religionSym;

    zoneName.textContent = region.name;
    
    const playerOwnsAny = curRegions.some(reg => {
      return holderOf(save, curWorld.iso, reg.id) === save.playerColor;
    });
    
    const isAdjacent = Array.from(curNeighbors[region.id] || []).some(neighId => {
      return holderOf(save, curWorld.iso, neighId) === save.playerColor;
    });
    
    let hasAnyAdjacentNonOwned = false;
    for (const reg of curRegions) {
      const regHolder = holderOf(save, curWorld.iso, reg.id);
      if (regHolder !== save.playerColor) {
        const adj = Array.from(curNeighbors[reg.id] || []).some(neighId => {
          return holderOf(save, curWorld.iso, neighId) === save.playerColor;
        });
        if (adj) {
          hasAnyAdjacentNonOwned = true;
          break;
        }
      }
    }

    const canAttack = !playerOwnsAny || isAdjacent || !hasAnyAdjacentNonOwned;

    const maxPop = zoneMaxPopOf(save, curWorld.iso, region.id);
    const curPop = zonePopOf(save, curWorld.iso, region.id);
    const zoneRealMaxPop = Math.round((curWorld.pop || 1000000) / curRegions.length);
    
    let statsText = '';
    if (mine) {
      const pct = Math.min(100, Math.round((curPop / zoneRealMaxPop) * 100));
      statsText = `<br/><span style="font-size: 12px; opacity: 0.85; display: block; margin-top: 4px;">Fidèles convertis : <span style="font-weight: 800; color: #ffe259;">${formatBelievers(curPop)}</span> / ${formatBelievers(zoneRealMaxPop)} (${pct}%)</span>`;
    } else {
      statsText = `<br/><span style="font-size: 12px; opacity: 0.85; display: block; margin-top: 4px;">Population de la zone : <span style="font-weight: 800; color: #fff;">${formatBelievers(zoneRealMaxPop)}</span> habitants</span>`;
    }

    if (mine) {
      zoneHolder.innerHTML = `Tenue par : ${symHtml} <span style="font-weight: 800;">${religionName}</span>${statsText}`;
      zonePlay.classList.add('hidden');
    } else {
      if (canAttack) {
        zoneHolder.innerHTML = `Tenue par : ${symHtml} <span style="font-weight: 800;">${religionName}</span>${statsText}`;
        zonePlay.disabled = false;
      } else {
        zoneHolder.innerHTML = `Tenue par : ${symHtml} <span style="font-weight: 800;">${religionName}</span>${statsText}<br/><span style="color: #ff5f6d; font-size: 11px; font-weight: 700; display: block; margin-top: 4px;">⚠️ Cette zone doit toucher un de vos territoires pour être convertie.</span>`;
        zonePlay.disabled = true;
      }
      zonePlay.classList.remove('hidden');
    }

    zoneHolder.style.color = religionColor;
    panel.classList.remove('hidden');
  }

  zonePlay.addEventListener('click', () => {
    if (selectedRegion) launchZone(selectedRegion);
  });

  /**
   * Lance la partie d'une zone. Appelé soit par la carte des provinces (repli),
   * soit par un portail du Hub Overworld.
   */
  function launchZone(region) {
    const world = curWorld;
    if (!world || !region) return;
    const preHolder = holderOf(loadSave(), world.iso, region.id);
    const isBarbarian = !preHolder || preHolder === NEUTRAL;

    // Collecte de toutes les religions non-barbares adjacentes (touchant la zone)
    const save = loadSave();
    const adjacentSet = new Set();
    if (preHolder && preHolder !== NEUTRAL && preHolder !== save.playerColor) {
      adjacentSet.add(preHolder);
    }
    const neighbors = curNeighbors[region.id] || [];
    for (const nId of neighbors) {
      const owner = save.conq[world.iso]?.[nId];
      if (owner && owner !== NEUTRAL && owner !== save.playerColor) {
        adjacentSet.add(owner);
      }
    }
    const touchingOwners = Array.from(adjacentSet);

    const onResult = (res) => {
      const win = typeof res === 'object' ? res.win : res;
      const conversions = typeof res === 'object' ? res.conversions : 0;
      const winnerColor = typeof res === 'object' ? res.winnerColor : null;
      root.classList.remove('hidden');
      if (!star) star = createStarfield(root.querySelector('.prog-stars'));
      if (!globe) {
        globe = createGlobe(root.querySelector('.prog-globe'), {
          onPick(w2) {
            const sv = loadSave();
            if (!canEnterCountry(sv, w2.iso)) {
              globe.focusWorld(w2);
              toast(`« ${w2.name} » n'est pas accessible depuis vos terres.`);
              return;
            }
            globe.focusWorld(w2);
            setTimeout(() => enterCountry(w2), 360);
          },
          onUnknown() { toast('Cette terre n\'a pas encore été révélée.'); },
        });
      }
      if (!country && curWorld && curRegions) {
        requestAnimationFrame(() => {
          country = createCountryMap(countryCanvas, curWorld, curRegions, selectZone);
        });
      }
      if (win) {
        const s0 = loadSave();
        setHolder(world.iso, region.id, s0.playerColor, conversions, world.pop, curRegions.length);
        country && country.repaint();
        refreshProgress();
        const save = loadSave();
        const full = isCountryConquered(save, world, curRegions);
        if (full) {
          save.conquered = save.conquered || {}; save.conquered[world.iso] = true;
          revealNeighbors(save, world.iso);   // lève le brouillard sur les voisins
        }
        // XP : +1 par zone conquise, +3 bonus si le pays est complété.
        ensurePlayerLevel(save);
        const proxy = { level: save.level, xp: save.xp, skillPoints: save.skillPoints, skills: save.skills };
        const gainedPts = addXp(proxy, 1 + (full ? 3 : 0));
        save.level = proxy.level; save.xp = proxy.xp; save.skillPoints = proxy.skillPoints;
        persist(save);

        let msg = full
          ? `🏆 ${world.name} entièrement convertie !`
          : `✓ ${region.name} rejoint votre culte.`;
        if (gainedPts > 0) {
          msg += `\n⬆ Niveau ${save.level} ! +${gainedPts} pt${gainedPts > 1 ? 's' : ''} de compétence`;
        }
        toast(msg);
      } else {
        if (winnerColor) {
          // L'IA gagnante du combat manuel prend le contrôle du territoire !
          setHolder(world.iso, region.id, winnerColor, 0, world.pop, curRegions.length);
          const save = loadSave();
          // XP pour l'IA gagnante
          const zones = Object.values(save.conq[world.iso] || {});
          const fullAI = zones.length > 0 && zones.every(c => c === winnerColor);
          const winnerState = ensureAiState(save, winnerColor);
          addXp(winnerState, 1 + (fullAI ? 3 : 0));
          persist(save);
          
          const cult = CULTS.find(c => c.color === winnerColor);
          const name = cult ? cult.name : 'Un rival';
          toast(`✗ Défaite. Le culte ${name} a conquis ${region.name}.`);
        } else {
          toast(`✗ ${region.name} résiste. Réessayez.`);
        }
        country && country.repaint();   // la simulation IA a pu changer des zones
      }
      updateGlobalStatsUI();
      panel.classList.add('hidden'); selectedRegion = null;
    };
    // Chaque lancement fait avancer la conquête des 9 IA.
    simulateWorldTurn();
    if (playHandler) {
      root.classList.add('hidden');
      if (globe) { globe.stop(); globe = null; }
      if (star) { star.stop(); star = null; }
      if (country) { country.stop(); country = null; }
      playHandler({
        world,
        region,
        onResult,
        playerColor: loadSave().playerColor,
        zonesCount: curRegions.length,
        barbarian: isBarbarian,
        owner: preHolder,
        touchingOwners
      });
    } else { onResult(true); } // fallback autonome : conquête simulée
  }

  async function enterCountry(world) {
    loading && loading.parentNode && (loading.textContent = 'Chargement du territoire…');
    let regions;
    try { regions = await loadRegions(world.iso); } catch (e) { toast('Territoire indisponible.'); return; }
    const save = loadSave();
    initCountry(save, world, regions);
    curWorld = world; curRegions = regions; selectedRegion = null;
    curNeighbors = buildRegionNeighbors(regions);

    // Nouveau flux : le pays s'explore en 3D. La carte des provinces est
    // court-circuitée, chaque zone étant représentée par un portail du Hub.
    if (hubHandler) {
      root.classList.add('hidden');
      if (globe) { globe.stop(); globe = null; }
      if (star) { star.stop(); star = null; }
      if (country) { country.stop(); country = null; }
      hubHandler({
        world,
        regions,
        zonesCount: regions.length,
        playerColor: save.playerColor,
        playerLeader: save.playerLeader,
        launchZone: (i) => launchZone(regions[i]),
      });
      return;
    }

    const rel = getWorldReligion(save, world);
    const symHtml = (rel.sym.startsWith('data:') || rel.sym.startsWith('http'))
      ? `<img src="${rel.sym}" class="prog-head-icon" />`
      : rel.sym;
    cTitle.innerHTML = `${symHtml} ${world.name}`;
    cTitle.style.color = rel.color;
    globeView.classList.add('hidden'); countryView.classList.remove('hidden');
    panel.classList.add('hidden');
    country && country.stop();
    // le canvas doit avoir sa taille avant le rendu
    requestAnimationFrame(() => {
      country = createCountryMap(countryCanvas, world, regions, selectZone);
      refreshProgress();
    });
  }

  globe = createGlobe(root.querySelector('.prog-globe'), {
    onPick(world) {
      const save = loadSave();
      if (!canEnterCountry(save, world.iso)) {
        globe.focusWorld(world);
        toast(`« ${world.name} » n'est pas accessible depuis vos terres.`);
        return;
      }
      globe.focusWorld(world);
      setTimeout(() => enterCountry(world), 360);
    },
    onUnknown() { toast('Cette terre n\'a pas encore été révélée.'); },
  });

  try { await ensureShapes(); } catch (e) { loading.textContent = 'Carte du monde indisponible.'; return; }
  loading.remove();

  // Choix du pays de départ + couleur du joueur (dès que WORLDS est peuplé)
  {
    const s = loadSave();
    if (!s.playerName) {
      // Pas encore de campagne active => ouvrir le créateur
      selectedCreatorLeader = 'monk';
      renderCreatorLeaders();
      creatorOverlay.classList.remove('hidden');
    } else {
      ensureWorldModel(s);            // migre vers le modèle v2 (monde réinitialisé)
      await seedReligionStarts();     // 1 zone par religion
      ensureDiscovery(loadSave());    // brouillard : découverte rétroactive + pays de départ
      const s2 = loadSave();
      const w = WORLDS[ISO_WORLD[s2.startIso]];
      if (w) {
        setTimeout(() => globe.focusWorld(w), 200);
      }
    }
  }

  updateGlobalStatsUI();

  // Pré-initialisation asynchrone de TOUS les pays.
  // Fetch en parallèle par lots, puis écriture SÉRIELLE pour éviter les races sur localStorage.
  (async () => {
    const BATCH = 20;
    for (let i = 0; i < WORLDS.length; i += BATCH) {
      const chunk = WORLDS.slice(i, i + BATCH);
      const loaded = await Promise.all(chunk.map(async (w) => {
        try { return { w, regs: await loadRegions(w.iso) }; }
        catch { return null; }
      }));
      const s = loadSave();
      for (const item of loaded) {
        if (!item) continue;
        if (s.conq && s.conq[item.w.iso]) continue;
        initCountry(s, item.w, item.regs);
      }
      updateGlobalStatsUI();
    }
  })();
}

export function closeProgression() {
  if (!root) return;
  country && country.stop(); globe && globe.stop(); star && star.stop();
  root.remove(); root = null; globe = null; star = null; country = null;
  if (onCloseCb) onCloseCb();
}

/* petit toast */
let toastEl = null, toastT = 0;
function toast(msg) {
  if (!toastEl) { toastEl = document.createElement('div'); toastEl.className = 'prog-toast'; document.body.appendChild(toastEl); }
  toastEl.textContent = msg; toastEl.classList.add('show');
  clearTimeout(toastT); toastT = setTimeout(() => toastEl.classList.remove('show'), 2600);
}
