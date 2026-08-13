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
  getSkillModsForSkills,
} from './skills.js';
import { soundEngine } from './soundEngine.js';
import { registerPadSurface, unregisterPadSurface } from './gamepad.js';

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


/* Les provinces admin-1 (loadRegions, clusterRegions, filterMainland…) ont été
   retirées avec le modèle v3 : le pays est désormais l'unité de conquête, et
   la campagne n'a plus besoin de découper les pays ni de charger les 254
   fichiers GeoJSON de provinces. Le globe se contente de SHAPES. */

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

  /* ISO du pays visé par le curseur manette, ou null.
     Conditionné à la présence d'une manette : au doigt ou à la souris, on
     désigne directement le pays qu'on touche, et afficher en permanence un
     « curseur » que le joueur n'a pas déplacé serait un repère parasite. */
  function padSelectedIso() {
    if (!document.body.classList.contains('has-gamepad')) return null;
    return padWorld ? padWorld.iso : null;
  }

  /** Étiquette du pays sélectionné : pastille nom + accessibilité. */
  function drawPadLabel(anchor) {
    if (!padWorld) return;
    const save = loadSave();
    const enterable = padWorld.iso === save.startIso || canEnterCountry(save, padWorld.iso);
    const name = padWorld.name || padWorld.iso;
    /* Le statut est affiché ici, et pas seulement suggéré par la couleur du
       contour : c'est la réponse à « pourquoi A ne fait rien sur ce pays ? ». */
    const sub = enterable ? '✓ Accessible' : '✕ Hors de portée';

    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const fName = `bold ${Math.round(15 * dpr)}px system-ui, sans-serif`;
    const fSub = `600 ${Math.round(11 * dpr)}px system-ui, sans-serif`;
    ctx.font = fName;
    const wName = ctx.measureText(name).width;
    ctx.font = fSub;
    const wSub = ctx.measureText(sub).width;

    const padX = 12 * dpr, padY = 8 * dpr, gap = 3 * dpr;
    const boxW = Math.max(wName, wSub) + padX * 2;
    const boxH = 15 * dpr + gap + 11 * dpr + padY * 2;
    /* Posée AU-DESSUS du pays, décalée du bord haut de sa silhouette : centrée
       dessus, elle masquerait la forme qu'on cherche justement à montrer. */
    let bx = anchor.x - boxW / 2;
    let by = anchor.top - boxH - 14 * dpr;
    // Recadrage dans le canvas : près d'un pôle, la pastille sortait de l'écran.
    bx = Math.max(6 * dpr, Math.min(bx, W - boxW - 6 * dpr));
    if (by < 6 * dpr) by = anchor.y + 16 * dpr;

    // Trait de rattachement, pour lever toute ambiguïté sur le pays désigné
    ctx.strokeStyle = 'rgba(255,255,255,0.55)';
    ctx.lineWidth = 1.6 * dpr;
    ctx.beginPath();
    ctx.moveTo(bx + boxW / 2, by + boxH);
    ctx.lineTo(anchor.x, anchor.y);
    ctx.stroke();

    ctx.fillStyle = 'rgba(9, 13, 22, 0.90)';
    ctx.strokeStyle = enterable ? '#fbbf24' : 'rgba(255,255,255,0.35)';
    ctx.lineWidth = 2 * dpr;
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(bx, by, boxW, boxH, 10 * dpr);
    else ctx.rect(bx, by, boxW, boxH);   // navigateur sans roundRect
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = '#ffffff';
    ctx.font = fName;
    ctx.fillText(name, bx + boxW / 2, by + padY + 8 * dpr);
    ctx.fillStyle = enterable ? '#fbbf24' : '#94a3b8';
    ctx.font = fSub;
    ctx.fillText(sub, bx + boxW / 2, by + padY + 15 * dpr + gap + 6 * dpr);
    ctx.restore();
  }

  function render() {
    const save = loadSave();
    ctx.clearRect(0, 0, W, H);
    /* Renseignée pendant le tracé des terres, consommée après la levée du clip
       de la sphère (voir plus bas) : on a besoin des coordonnées écran du pays,
       qui ne sont connues qu'au moment où on le dessine. */
    let selLabel = null;

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
        /* Pays sous le curseur manette. Le contour dore ne suffit pas a le
           reperer : il marque TOUS les pays jouables, et en debut de campagne
           il n'y en a qu'un — impossible de savoir sur lequel on est pose. */
        const selPolys = [];
        const selIso = padSelectedIso();

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
          if (selIso && poly.countryId === selIso) selPolys.push(poly);
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

        /* --- Curseur manette : le pays SÉLECTIONNÉ ---
           Dessiné après la surbrillance dorée pour passer par-dessus, et dans un
           registre franchement différent (blanc, épais, éclairci) : le doré dit
           « jouable », le blanc dit « c'est ici que tu es ». Deux informations
           distinctes, donc deux traitements distincts — les confondre était tout
           le problème. */
        if (selPolys.length) {
          const pulse = 0.5 + 0.5 * Math.sin(performance.now() * 0.006);
          ctx.save();
          ctx.lineJoin = 'round';
          ctx.lineCap = 'round';

          // Éclaircissement du remplissage : la forme entière se détache
          ctx.globalAlpha = 0.30 + pulse * 0.12;
          ctx.fillStyle = '#ffffff';
          for (const poly of selPolys) {
            for (const ring of poly.rings) {
              ctx.beginPath();
              ring.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y));
              ctx.closePath();
              ctx.fill();
            }
          }

          // Halo large puis trait net : lisible même sur un pays minuscule
          ctx.globalAlpha = 1;
          ctx.strokeStyle = 'rgba(255,255,255,0.45)';
          ctx.lineWidth = (7.5 + pulse * 3.0) * dpr;
          for (const poly of selPolys) {
            for (const ring of poly.rings) {
              ctx.beginPath();
              ring.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y));
              ctx.closePath();
              ctx.stroke();
            }
          }
          ctx.strokeStyle = '#ffffff';
          ctx.lineWidth = 2.6 * dpr;
          for (const poly of selPolys) {
            for (const ring of poly.rings) {
              ctx.beginPath();
              ring.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y));
              ctx.closePath();
              ctx.stroke();
            }
          }
          ctx.restore();

          /* Ancre de l'étiquette : le plus grand anneau visible du pays. Le
             centre géométrique de TOUS les anneaux tomberait dans l'océan pour
             un pays à archipel (Grèce, Indonésie). */
          let bigRing = null, bigLen = -1;
          for (const poly of selPolys) {
            for (const ring of poly.rings) {
              if (ring.length > bigLen) { bigLen = ring.length; bigRing = ring; }
            }
          }
          if (bigRing) {
            let sx = 0, sy = 0, minY = Infinity;
            for (const p of bigRing) { sx += p.x; sy += p.y; if (p.y < minY) minY = p.y; }
            selLabel = { x: sx / bigRing.length, y: sy / bigRing.length, top: minY };
          }
        }
      }
      ctx.restore(); // fin du clip de la sphère

      /* Étiquette du pays sélectionné — HORS du clip de la sphère, sinon elle
         serait tronquée dès que le pays approche du bord du globe, c'est-à-dire
         précisément quand on a le plus besoin de la lire. */
      if (selLabel) drawPadLabel(selLabel);

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

  /* ---------- Navigation à la manette ----------
     Le globe se joue au doigt : on fait tourner la sphère puis on tape le pays.
     Impossible à transposer au pad — viser une forme dessinée demanderait un
     curseur libre, donc de la précision analogique sur une cible de quelques
     pixels, ce qui est exactement ce qu'une manette fait mal.

     On saute donc l'étape du pointage : le pad passe de pays ACCESSIBLE en pays
     accessible, et chaque saut recadre le globe. La navigation se fait sur la
     position à l'écran plutôt que sur la latitude / longitude, sinon « à
     droite » n'aurait aucun sens dès que la sphère est inclinée. */
  let padWorld = null;

  function accessibleWorlds() {
    const save = loadSave();
    // Nos propres terres restent sélectionnables (on veut pouvoir les inspecter),
    // en plus de tout ce qui est attaquable.
    return WORLDS.filter((w) => ownerOf(save, w.iso) === save.playerColor || canEnterCountry(save, w.iso));
  }

  function padStep(dir) {
    const pool = accessibleWorlds();
    if (!pool.length) return;
    if (!padWorld || !pool.includes(padWorld)) {
      padWorld = pool[0];
      focusWorld(padWorld); scheduleLoop();
      return;
    }
    /* On réutilise la projection de rendu : un pays derrière le globe n'a pas
       de position utilisable, on le classe donc par distance angulaire. */
    const from = project(padWorld.lat, padWorld.lon);
    const [vx, vy] = { 1: [0, -1], 2: [0, 1], 3: [-1, 0], 4: [1, 0] }[dir];
    let best = null, bestScore = Infinity;
    for (const w of pool) {
      if (w === padWorld) continue;
      const p = project(w.lat, w.lon);
      const ox = p.x - from.x, oy = p.y - from.y;
      const along = ox * vx + oy * vy;
      if (along <= 2) continue;
      const off = Math.abs(ox * -vy + oy * vx);
      /* Le facteur latéral est volontairement fort : sur une sphère, deux pays
         « vers la droite » peuvent être très éloignés en hauteur, et sans ça la
         sélection sauterait d'un continent à l'autre. */
      /* project() rend z < 0 pour la face cachée de la sphère : ces pays gardent
         des coordonnées écran plausibles mais miroir, d'où la forte pénalité
         plutôt qu'un rejet — s'ils sont les seuls candidats, on y va quand même. */
      const score = along + off * 3.0 + (p.z < 0 ? 4000 : 0);
      if (score < bestScore) { bestScore = score; best = w; }
    }
    /* Aucun autre candidat — cas courant en début de campagne, où un seul pays
       est jouable : on recadre sur la sélection courante. Sans ça, un joueur qui
       a fait tourner le globe au stick perdait de vue l'unique pays accessible,
       sans aucun moyen d'y revenir. */
    if (!best) { focusWorld(padWorld); scheduleLoop(); return; }
    padWorld = best;
    focusWorld(padWorld);
    scheduleLoop();
  }

  function padPick() {
    if (!padWorld) { padStep(4); return; }
    opts.onPick(padWorld);
  }

  function padZoom(k) {
    targetZoom = null;
    setZoom(zoom * (k > 0 ? 1.25 : 0.8));
    scheduleLoop();
  }

  /* Rotation libre au stick, en plus du saut de pays au D-pad.
     Les deux sont indispensables et ne se remplacent pas : en début de campagne
     un SEUL pays est accessible (canEnterCountry n'ouvre un voisin qu'une fois
     un pays entièrement conquis). Le saut de sélection n'avait alors aucune
     autre cible et le globe restait figé — impossible d'aller regarder le
     reste du monde, alors qu'au doigt on le fait tourner librement.
     Mêmes signes que le glissement à la souris, sinon le globe part à l'envers. */
  function padPan(dx, dy, dt) {
    targetY = null; targetX = null;
    velY = 0; velX = 0;
    /* Vitesse réduite à fort zoom : à l'écran, un même angle balaie d'autant
       plus de pixels que la sphère est grosse. */
    const speed = 1.5 / Math.max(1, Math.sqrt(zoom));
    rotY -= dx * speed * dt;
    rotX = clampTilt(rotX + dy * speed * dt);
    scheduleLoop();
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
  /* Navigation manette publiée à gamepad.js. L'inscription se fait ici, dans la
     fabrique, et non sur les cinq sites qui montent un globe : un écran ajouté
     plus tard hériterait sinon d'un globe muet au pad. */
  const padNav = {
    el: canvas,
    label: 'Pays',
    pickLabel: 'Entrer',
    panLabel: 'Tourner',
    step: padStep,
    pick: padPick,
    zoom: padZoom,
    pan: padPan,
  };
  registerPadSurface('globe', padNav);

  return {
    focusWorld(w) { padWorld = w || padWorld; focusWorld(w); scheduleLoop(); },
    padNav,
    stop() {
      unregisterPadSurface('globe', padNav);
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

/* ===================== Conquête : le PAYS est l'unité ===================== *
 * Modèle v3. Fini les provinces : un pays = un propriétaire = un match.
 *
 * Pourquoi : à 1537 provinces et ~4 min de match, la campagne demandait des
 * dizaines d'heures et le joueur n'avait rallié que 2,4 % de l'humanité au bout
 * de deux heures. Au niveau pays (177 unités) il en est à 11,3 %, et le taux de
 * victoire des matchs contre un rival passe de 10 % à 45 % — parce qu'on
 * mobilise des nations entières au lieu de provinces à moitié vides.
 *
 *   save.conq[iso]    = couleur du culte qui tient le pays, ou NEUTRAL
 *   save.conqPop[iso] = fidèles convertis dans ce pays
 *   save.seats[color] = pays d'origine du culte
 *
 * La foi se propage le long de NEIGHBORS — un graphe de voisinage écrit à la
 * main et fiable — au lieu d'une adjacence de provinces reconstruite à partir
 * de la géométrie.
 */

/** Population totale d'un pays (son plafond de fidèles). */
function countryPop(iso) {
  const w = ISO_WORLD[iso] !== undefined ? WORLDS[ISO_WORLD[iso]] : null;
  return Math.max(1, w?.pop || 1000000);
}
/** Culte qui tient ce pays (NEUTRAL si terre barbare, null si inconnu). */
function ownerOf(save, iso) {
  return (save.conq && save.conq[iso]) || null;
}
/** Fidèles convertis dans ce pays. */
function believersIn(save, iso) {
  return (save.conqPop && save.conqPop[iso]) || 0;
}
/** Ferveur : part de la population du pays effectivement convertie (0..1). */
function fervorOf(save, iso) {
  return Math.max(0, Math.min(1, believersIn(save, iso) / countryPop(iso)));
}
const isMineCountry = (save, iso) => ownerOf(save, iso) === save.playerColor;
/** Nombre de pays tenus par un culte. */
function countriesOf(save, color) {
  let n = 0;
  for (const iso in (save.conq || {})) if (save.conq[iso] === color) n++;
  return n;
}
/** Liste des pays tenus par un culte. */
function countryListOf(save, color) {
  const out = [];
  for (const iso in (save.conq || {})) if (save.conq[iso] === color) out.push(iso);
  return out;
}

/** Identité du culte qui tient un pays — utilisée par le rendu du globe. */
function getWorldReligion(save, world) {
  const color = ownerOf(save, world.iso);
  if (!color || color === NEUTRAL) {
    return { color: NEUTRAL, name: 'Terres barbares', sym: '⚔' };
  }
  if (color === save.playerColor && save.playerName) {
    return { color, name: save.religionName || 'Mon Culte', sym: save.religionIcon || '✦' };
  }
  return CULTS.find((c) => c.color === color) || { color, name: 'Inconnu', sym: '•' };
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

/**
 * Paramètres de simulation par difficulté.
 *  · act   : probabilité qu'une IA agisse ce tour.
 *  · steal : probabilité qu'elle s'en prenne à une zone déjà tenue.
 *  · focus : part de ses vols dirigée vers le JOUEUR plutôt qu'une autre IA.
 *
 * `focus` corrige une inversion de difficulté mesurée au simulateur : avec un
 * `steal` élevé et aucun ciblage, les IA se cannibalisaient entre elles, se
 * ruinaient mutuellement et le joueur dépassait le leader au tour 29 en `hard`
 * contre 89 en `normal` — le mode difficile était le plus facile. Monter la
 * difficulté doit augmenter la pression SUR LE JOUEUR, pas le désordre entre IA.
 */
const DIFF_SIM = {
  easy:   { act: 0.35, steal: 0.05, focus: 0.10 },
  normal: { act: 0.65, steal: 0.20, focus: 0.40 },
  hard:   { act: 0.95, steal: 0.30, focus: 0.75 },
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

/**
 * Bascule vers le modèle v3 (le pays est l'unité) : réinitialise la conquête.
 * Les sauvegardes v2 stockaient une table de provinces par pays — incompatible,
 * et il n'y a pas de conversion sensée d'un découpage vers l'autre.
 */
function ensureWorldModel(save) {
  if (save.worldModel === 3) { ensurePlayerLevel(save); return; }
  save.conq = {};
  save.conqPop = {};
  save.conquered = {};
  save.ai = {};
  save.seats = {}; save.decapAt = {};
  save.level = 0; save.xp = 0;
  save.skills = {}; save.skillPoints = 0;
  save.skillMajority = {}; save.skillFull = {};
  save.discovered = {};
  save.seeded = false;
  save.worldTurn = 0;
  delete save.conqMaxPop;   // notion de province : sans objet en v3
  save.worldModel = 3;
  persist(save);
}

/** Déclare un pays comme terre barbare (non conquise) s'il n'est pas déjà connu. */
function initCountry(save, iso) {
  save.conq = save.conq || {};
  save.conqPop = save.conqPop || {};
  if (save.conq[iso]) return;
  save.conq[iso] = NEUTRAL;
  save.conqPop[iso] = 0;
}

/** Déclare d'un coup tous les pays du globe. Plus aucun fetch : le modèle v3
 *  n'a pas besoin des provinces, donc la carte est prête immédiatement. */
function initAllCountries(save) {
  save.conq = save.conq || {};
  save.conqPop = save.conqPop || {};
  for (const w of WORLDS) if (w.iso) initCountry(save, w.iso);
}

/** Grands pays bien visibles : le joueur y commence toujours (repère clair où cliquer). */
const PLAYER_START_ISO = [
  'RUS', 'CAN', 'USA', 'CHN', 'BRA', 'AUS', 'IND', 'ARG', 'KAZ', 'DZA',
  'COD', 'SAU', 'MEX', 'IDN', 'SDN', 'LBY', 'IRN', 'MNG', 'PER', 'NER',
  'TCD', 'AGO', 'MLI', 'ZAF', 'COL', 'ETH', 'EGY', 'TZA', 'NGA', 'PAK',
  'TUR', 'FRA', 'ESP', 'UKR', 'MMR', 'MOZ', 'NAM', 'ZMB', 'CHL', 'BOL',
];

/** Distance angulaire entre deux pays, pour les espacer au semis. */
function seedTooClose(iso, used, minDist) {
  for (const u of used) if (isoDistance(iso, u) < minDist) return true;
  return false;
}

/**
 * Sème les 10 religions sur le globe : une par pays d'origine, bien réparties.
 * Chaque culte démarre à 12 % de la population de son pays, comme avant — mais
 * il tient désormais le pays ENTIER, ce qui lui donne une base réelle pour
 * mobiliser ses fidèles au premier assaut.
 */
async function seedReligionStarts() {
  const save = loadSave();
  if (save.seeded) { healPlayerStart(save); return; }

  const difficulty = localStorage.getItem('cultio_difficulty') || 'normal';
  initAllCountries(save);

  const religions = [{ color: save.playerColor, isPlayer: true }];
  for (const c of aiColors(save)) religions.push({ color: c, isPlayer: false });

  const candidates = WORLDS.filter((w) => !!w.iso);
  if (!candidates.length) return;
  const shuffle = (arr) => arr.map((v) => [Math.random(), v]).sort((a, b) => a[0] - b[0]).map((p) => p[1]);
  const bigPool = candidates.filter((w) => PLAYER_START_ISO.includes(w.iso));
  const used = [];

  for (const rel of religions) {
    if (!rel.color) continue;
    /* Le joueur démarre sur un grand pays visible ; les IA n'importe où.
       Dans les deux cas le pays DOIT avoir une frontière terrestre : semé sur
       une île isolée, un culte n'a aucun voisin à convertir et la partie est
       bloquée au premier tour (mesuré : « 0 pays attaquable »). */
    const usable = (list) => list.filter((w) => neighborsOf(w.iso).length > 0);
    const pool = usable(rel.isPlayer && bigPool.length ? bigPool : candidates);
    if (!pool.length) continue;

    /* Les cultes sont écartés les uns des autres pour que chacun ait de la
       terre barbare à convertir avant le premier contact. Sans cet espacement,
       deux religions voisines se bloquent mutuellement dès le tour 1. Le
       dernier repli relâche la distance mais JAMAIS l'interdiction d'être
       frontalier — c'est le minimum vital. */
    let chosen = null;
    for (const minDist of [0.9, 0.6, 0.35, 0]) {
      for (const w of shuffle(pool)) {
        if (used.includes(w.iso)) continue;
        if (minDist > 0 && seedTooClose(w.iso, used, minDist)) continue;
        if (neighborsOf(w.iso).some((n) => used.includes(n))) continue;   // jamais voisins
        chosen = w.iso; break;
      }
      if (chosen) break;
    }
    if (!chosen) continue;

    used.push(chosen);
    save.conq[chosen] = rel.color;
    save.conqPop[chosen] = Math.round(countryPop(chosen) * 0.12);
    // Le pays d'origine est le siège du culte : le perdre brise la religion.
    save.seats = save.seats || {};
    save.seats[rel.color] = chosen;

    if (rel.isPlayer) {
      save.startIso = chosen;
      ensurePlayerLevel(save);
      save.skillPoints = (save.skillPoints | 0) + 1;
    } else {
      const st = ensureAiState(save, rel.color);
      st.startIso = chosen;
      st.skillPoints = (st.skillPoints | 0) + 1;
      aiSpendSkillPoints(st, difficulty);   // l'IA place aussitôt son point de départ
    }
  }

  save.seeded = true;
  persist(save);
}

/**
 * Filet de sécurité : une sauvegarde semée où le joueur ne tient plus rien.
 * En v3 la défaite est une vraie fin de partie — on ne ressuscite donc PAS un
 * joueur éliminé au combat, on répare seulement une sauvegarde corrompue
 * (aucun pays possédé alors qu'aucune défaite n'a été enregistrée).
 */
function healPlayerStart(save) {
  const pc = save.playerColor;
  if (!pc || !save.conq) return;
  if (countriesOf(save, pc) > 0) return;
  if (save.campaignLost) return;          // défaite légitime : on n'y touche pas

  const iso = save.startIso && save.conq[save.startIso] === NEUTRAL
    ? save.startIso
    : Object.keys(save.conq).find((i) => save.conq[i] === NEUTRAL);
  if (!iso) return;
  save.conq[iso] = pc;
  save.conqPop[iso] = Math.round(countryPop(iso) * 0.12);
  save.startIso = iso;
  save.seats = save.seats || {};
  save.seats[pc] = iso;
  ensurePlayerLevel(save);
  persist(save);
}

/* ===================== Propagation de la Foi ===================== *
 * Principe unique : LA FOI NE SE DUPLIQUE JAMAIS, ELLE SE DÉPLACE.
 * Tous les transferts se font en croyants absolus, jamais en pourcentages.
 *
 *  1. Maturation — tout pays tenu voit ses fidèles croître en S vers un plafond
 *     abaissé par la pression des pays rivaux limitrophes. Vaut pour TOUT LE
 *     MONDE : c'est ce qui fait monter le classement mondial à chaque tour.
 *  2. Déversement — au-delà d'un seuil, un pays donne son surplus au pays voisin
 *     le plus faible. Réservé AU JOUEUR : c'est l'asymétrie qui le sort du
 *     plateau des 10 % (mesuré au simulateur : +67 % de part de foi).
 *  3. Prédication — déversé sur un pays rival, le surplus convertit ses fidèles ;
 *     sous le plancher, le pays bascule. Sans ça le moteur cale dès que les
 *     terres barbares sont épuisées.
 *
 * Le voisinage vient de NEIGHBORS — écrit à la main, fiable — et non plus d'une
 * adjacence de provinces reconstruite depuis la géométrie.
 *
 * Valeurs calibrées avec scripts/campaign-balance-sim.mjs (médianes sur 25 à 30
 * parties). Toucher à GROWTH_RATE ou SPILL_THRESHOLD sans relancer le
 * simulateur, c'est régler à l'aveugle.
 */
const FAITH = {
  GROWTH_RATE: 0.18,      // vitesse de maturation d'un pays
  CAP_BASE: 0.95,         // plafond de conversion d'un pays tranquille
  /* Pression frontalière : chaque pays rival limitrophe étouffe la foi. À 0.09
     l'effet était négligeable et les fronts inertes ; à 0.22 ils deviennent
     réellement corrosifs (mesuré : 40 % → 52 % de victoires). */
  CAP_PER_RIVAL: 0.22,
  CAP_MIN: 0.45,          // …sans jamais descendre sous ça
  /* Reflux : au-dessus de son plafond, un pays perd sa ferveur. Sans lui la
     saturation serait un cliquet, et la pression frontalière décorative. */
  DECAY: 0.10,
  SPILL_THRESHOLD: 0.55,  // seuil de débordement
  SPILL_EFF: 0.60,        // part du surplus réellement transmise
  SPILL_FLOOR: 0.20,      // un pays ne se vide jamais sous ce taux
  EROSION: 0.90,          // efficacité de la prédication sur un pays rival
  /* BUDGET DE CLERGÉ : nombre de pays convertibles passivement par tour. Sans
     plafond, le déversement est linéaire en nombre de pays tenus et s'étaler
     partout écrase toute autre stratégie (mesuré : 27 % → 66 % de part de foi
     rien qu'en changeant les priorités de cible). */
  CLERGY: 2,
};

/** Pays voisins qui existent vraiment sur la carte. */
function neighborsOf(iso) {
  return (NEIGHBORS[iso] || []).filter((n) => ISO_WORLD[n] !== undefined);
}

/** Plafond de conversion d'un pays : la pression rivale étouffe la foi. */
function faithCap(save, iso, owner) {
  let rivals = 0;
  for (const n of neighborsOf(iso)) {
    const h = ownerOf(save, n);
    if (h && h !== NEUTRAL && h !== owner) rivals++;
  }
  return Math.max(FAITH.CAP_MIN, FAITH.CAP_BASE - rivals * FAITH.CAP_PER_RIVAL);
}

/**
 * Un tour de propagation. Modifie `save` sans le persister (l'appelant s'en
 * charge, pour ne pas multiplier les écritures localStorage).
 * @returns {{gained: string[], preached: number}} de quoi informer le joueur.
 */
function faithTick(save) {
  const out = { gained: [], preached: 0 };
  if (!save.conq) return out;
  save.conqPop = save.conqPop || {};
  const pc = save.playerColor;
  // L'arbre de foi pilote la propagation : il fait enfin tourner une machine
  // en dehors des matchs.
  const mods = getSkillModsForSkills(save.skills || {});
  const growthMult = Math.max(0.5, mods.convMult || 1);
  const spreadMult = Math.max(0.5, mods.influenceMult || 1);

  /* ---- 1. Maturation : toutes les religions, tous les pays ---- */
  for (const iso in save.conq) {
    const owner = save.conq[iso];
    if (!owner || owner === NEUTRAL) continue;
    const maxPop = countryPop(iso);
    const cur = save.conqPop[iso] || 0;
    const pct = cur / maxPop;
    const cap = faithCap(save, iso, owner);
    if (pct >= cap) {
      // Reflux : un pays encerclé se ramollit au lieu de rester figé.
      if (pct > cap && FAITH.DECAY > 0) {
        save.conqPop[iso] = Math.max(maxPop * cap, cur - (pct - cap) * maxPop * FAITH.DECAY);
      }
      continue;
    }
    const mult = owner === pc ? growthMult : 1;
    // Amorce à 5 % : un pays à zéro ne démarrerait jamais en logistique pure.
    const growth = FAITH.GROWTH_RATE * mult * Math.max(pct, 0.05) * (1 - pct / cap);
    save.conqPop[iso] = Math.min(maxPop * cap, cur + growth * maxPop);
  }

  /* ---- 2 & 3. Déversement et prédication : le joueur seul ---- */
  if (!pc) return out;

  /* On rassemble d'abord TOUS les pays prêts à déborder, puis on ne sert que
     les plus fervents, dans la limite du budget de clergé. Trier globalement
     est indispensable : sinon l'ordre des clés de save.conq déciderait qui
     prêche. */
  const snap = {};
  for (const iso in save.conq) snap[iso] = save.conqPop[iso] || 0;
  const ready = [];
  for (const iso in save.conq) {
    if (save.conq[iso] !== pc) continue;
    const pct = snap[iso] / countryPop(iso);
    if (pct > FAITH.SPILL_THRESHOLD) ready.push({ iso, pct });
  }
  ready.sort((a, b) => b.pct - a.pct);
  let budget = Math.max(1, Math.round(FAITH.CLERGY * spreadMult));

  for (const cand of ready) {
    if (budget <= 0) break;
    const { iso, pct } = cand;
    const maxPop = countryPop(iso);

    // Cible : le voisin le plus faible — barbare en priorité, rival sinon.
    let target = null, best = Infinity;
    for (const n of neighborsOf(iso)) {
      const h = ownerOf(save, n);
      if (!h || h === pc) continue;
      const score = (h !== NEUTRAL ? 1000 : 0) + (snap[n] || 0) / countryPop(n);
      if (score < best) { best = score; target = n; }
    }
    if (!target) continue;

    const surplus = (pct - FAITH.SPILL_THRESHOLD) * maxPop * FAITH.SPILL_EFF * spreadMult;
    const sent = Math.max(0, Math.min(surplus, save.conqPop[iso] - maxPop * FAITH.SPILL_FLOOR));
    if (sent <= 0) continue;
    save.conqPop[iso] -= sent;
    budget--;

    if (ownerOf(save, target) === NEUTRAL) {
      // Terre barbare : la foi s'y installe sans combat.
      save.conq[target] = pc;
      save.conqPop[target] = (save.conqPop[target] || 0) + sent;
      out.gained.push(target);
      revealNeighbors(save, target);
    } else {
      /* PRÉDICATION : on ne détruit pas les fidèles rivaux, on les convertit.
         Sous le plancher, le pays bascule vers la foi qui l'arrose. */
      const tMax = countryPop(target);
      const drained = Math.min(save.conqPop[target] || 0, sent * FAITH.EROSION);
      save.conqPop[target] = (save.conqPop[target] || 0) - drained;
      out.preached++;
      if (save.conqPop[target] <= tMax * FAITH.SPILL_FLOOR) {
        const victim = save.conq[target];
        save.conq[target] = pc;
        save.conqPop[target] += drained;
        out.gained.push(target);
        revealNeighbors(save, target);
        maybeDecapitate(save, target, victim, pc);
      } else {
        save.conqPop[iso] += drained * 0.5;   // une part revient au prêcheur
      }
    }
  }
  return out;
}

/* ===================== Décapitation des cultes ===================== *
 * Chaque religion a un SIÈGE : son pays d'origine. Le prendre fait s'effondrer
 * son empire — une part bascule vers le conquérant, une part part en schisme et
 * redevient barbare, le reste tient. Plus une religion a grossi, plus l'abattre
 * rapporte : les 9 rivaux deviennent 9 objectifs au lieu de 9 murs.
 *
 * Deux garde-fous, issus d'un exploit observé au simulateur (le joueur brisait
 * le même culte 5 tours d'affilée, dont deux fois pour rien) :
 *   · EXIL    — le siège fuit vers le pays survivant le plus LOIN du vainqueur,
 *               pas vers le plus riche, sinon il se relocalise juste à côté.
 *   · LATENCE — un culte fraîchement brisé se relève avant de pouvoir l'être encore.
 */
const DECAP = {
  SHARE: 0.20,       // part de l'empire de la victime qui bascule
  KEEP: 0.70,        // part des fidèles conservée dans la bascule
  SCHISM: 0.15,      // part qui se disperse et redevient barbare
  COOLDOWN: 25,      // tours de répit avant une nouvelle décapitation
};

/** Garantit la table des sièges : rattrape aussi les parties déjà commencées. */
function ensureSeats(save) {
  if (!save.seats || typeof save.seats !== 'object') save.seats = {};
  if (!save.decapAt || typeof save.decapAt !== 'object') save.decapAt = {};
  const claim = (color, iso) => {
    if (!color || !iso || save.seats[color]) return;
    if (ownerOf(save, iso) === color) save.seats[color] = iso;
  };
  claim(save.playerColor, save.startIso);
  for (const color of aiColors(save)) claim(color, save.ai && save.ai[color] && save.ai[color].startIso);
  return save.seats;
}

/** Le siège de `victim` vient de tomber : son empire s'effondre. */
function decapitate(save, victim, conqueror) {
  // Inventaire des terres de la victime, les plus ferventes d'abord.
  const held = countryListOf(save, victim)
    .map((iso) => ({ iso, pop: save.conqPop[iso] || 0 }))
    .sort((a, b) => b.pop - a.pop);
  if (!held.length) { delete save.seats[victim]; return 0; }

  const nFlip = Math.round(held.length * DECAP.SHARE);
  const nSchism = Math.round(held.length * DECAP.SCHISM);
  for (let k = 0; k < nFlip && k < held.length; k++) {
    save.conq[held[k].iso] = conqueror;
    save.conqPop[held[k].iso] = Math.round(held[k].pop * DECAP.KEEP);
  }
  for (let k = nFlip; k < nFlip + nSchism && k < held.length; k++) {
    save.conq[held[k].iso] = NEUTRAL;
    save.conqPop[held[k].iso] = 0;
  }

  // EXIL : le siège se replie là où le vainqueur est le moins présent.
  const survivors = held.slice(nFlip + nSchism);
  if (survivors.length) {
    let best = survivors[0], bestScore = Infinity;
    for (const h of survivors) {
      let adjacent = 0;
      for (const n of neighborsOf(h.iso)) if (ownerOf(save, n) === conqueror) adjacent++;
      const score = adjacent * 10 - h.pop / countryPop(h.iso);
      if (score < bestScore) { bestScore = score; best = h; }
    }
    save.seats[victim] = best.iso;
  } else {
    delete save.seats[victim];
  }
  save.decapAt[victim] = save.worldTurn | 0;
  return nFlip;
}

/**
 * À appeler après toute prise de pays : le siège de l'ancien maître tombe-t-il ?
 * @returns {{victim: string, flipped: number}|null}
 */
function maybeDecapitate(save, iso, oldOwner, newOwner) {
  if (!oldOwner || oldOwner === NEUTRAL || oldOwner === newOwner) return null;
  ensureSeats(save);
  if (save.seats[oldOwner] !== iso) return null;
  const since = (save.worldTurn | 0) - (save.decapAt[oldOwner] ?? -1e9);
  if (since < DECAP.COOLDOWN) return null;   // culte encore à terre
  const flipped = decapitate(save, oldOwner, newOwner);
  save.lastDecap = { victim: oldOwner, by: newOwner, flipped, turn: save.worldTurn | 0 };
  return { victim: oldOwner, flipped };
}

/* Surface d'essai pour scripts/campaign-faith-test.mjs. Ces fonctions n'ont pas
   d'usage hors du module, mais sans elles rien ne vérifierait le câblage sur les
   vraies formes de sauvegarde (conq, conqPop, seats) — seul le modèle théorique
   est couvert par le simulateur d'équilibrage. */
export const __faithTest = {
  FAITH, DECAP, faithTick, decapitate, maybeDecapitate, ensureSeats,
  countryPop, ownerOf, believersIn, countriesOf, neighborsOf, faithCap,
  /* Hors du jeu, WORLDS n'est peuplé que par la carte de repli (5 pays sans
     voisinage réel), donc neighborsOf ne renvoie rien et rien n'est testable.
     Cette amorce déclare des pays fictifs pour le banc d'essai. */
  primeWorlds(list) {
    for (const w of list) {
      if (ISO_WORLD[w.iso] !== undefined) { WORLDS[ISO_WORLD[w.iso]] = w; continue; }
      ISO_WORLD[w.iso] = WORLDS.length;
      WORLDS.push(w);
    }
  },
  /* Chargement de la carte du monde. Exposé pour qu'un test puisse vérifier que
     le globe a bien ses terres : c'est précisément ce qui manquait quand un
     nettoyage a emporté ensureShapes sans qu'aucun test ne s'en aperçoive
     (le build passe, esbuild ne résolvant pas les identifiants globaux). */
  ensureShapes,
  worlds: () => WORLDS,
  seedReligionStarts,
  canEnterCountry,
  initAllCountries,
};

/**
 * Un tour de monde : la foi se propage, puis les 9 IA agissent.
 * Appelé au lancement de chaque match — un match = un tour.
 *
 * Les TERRES BARBARES (grises) ne sont jamais agressives : elles n'ont aucune
 * agence ici. Personne ne peut se faire prendre un pays par du gris ; seule une
 * religion prend à une religion.
 */
function simulateWorldTurn() {
  const save = loadSave();
  if (!save.seeded || !save.conq) return;

  save.worldTurn = (save.worldTurn | 0) + 1;
  ensureSeats(save);
  save.passiveChanges = [];

  /* La foi mûrit et se propage AVANT que les IA n'agissent : le joueur récolte
     le fruit de ses terres, puis le monde lui répond. */
  const faith = faithTick(save);
  save.lastFaith = { gained: faith.gained.length, preached: faith.preached };

  const diff = localStorage.getItem('cultio_difficulty') || 'normal';
  const dp = DIFF_SIM[diff] || DIFF_SIM.normal;

  for (const color of aiColors(save)) {
    const state = ensureAiState(save, color);
    const power = aiExpansionPower(state);
    const actProb = Math.max(0, Math.min(0.98, dp.act * (0.7 + state.aggr * 0.6) + (power - 1) * 0.05));
    if (Math.random() >= actProb) continue;   // cette IA n'agit pas ce tour

    const mine = countryListOf(save, color);
    if (!mine.length) continue;               // culte éteint

    // Cibles : pays limitrophes qui ne sont pas à elle.
    const barbarian = [], rivals = [];
    for (const iso of mine) {
      for (const n of neighborsOf(iso)) {
        const h = ownerOf(save, n);
        if (!h || h === color) continue;
        (h === NEUTRAL ? barbarian : rivals).push({ iso: n, from: iso });
      }
    }

    let target = null;
    if (barbarian.length) {
      // L'expansion facile d'abord : les terres barbares ne se défendent pas.
      target = barbarian[(Math.random() * barbarian.length) | 0];
    } else if (rivals.length && Math.random() < dp.steal) {
      /* La difficulté se joue ici : plus elle est haute, plus les IA
         concentrent leurs assauts sur le joueur au lieu de se déchirer entre
         elles. Sans ce ciblage, monter `steal` aidait le joueur (inversion de
         difficulté mesurée : dépassement au tour 29 en hard contre 89 en normal). */
      const onPlayer = rivals.filter((r) => ownerOf(save, r.iso) === save.playerColor);
      target = (onPlayer.length && Math.random() < dp.focus)
        ? onPlayer[(Math.random() * onPlayer.length) | 0]
        : rivals[(Math.random() * rivals.length) | 0];
    }
    if (!target) continue;

    const oldOwner = ownerOf(save, target.iso);
    if (oldOwner === NEUTRAL) {
      // Conversion d'une terre barbare : sans combat, mais peu de fidèles.
      save.conq[target.iso] = color;
      save.conqPop[target.iso] = Math.round(countryPop(target.iso) * (0.15 + Math.random() * 0.20));
      addXp(state, 1);
      aiSpendSkillPoints(state, diff);
      continue;
    }

    /* Assaut sur une religion : les fidèles engagés de part et d'autre décident.
       Une nation mûre se défend réellement — c'est ce qui fait des frontières
       des lignes de front plutôt que des portes ouvertes. */
    let attack = 0;
    for (const n of neighborsOf(target.iso)) {
      if (ownerOf(save, n) === color) attack += (save.conqPop[n] || 0) * 0.30;
    }
    attack *= aiExpansionPower(state);
    const defenderColor = oldOwner;
    const defense = (save.conqPop[target.iso] || 0)
      * (defenderColor === save.playerColor ? 1 : aiExpansionPower(ensureAiState(save, defenderColor)));
    if (attack <= 0) continue;

    if (Math.random() < attack / (attack + defense)) {
      save.conq[target.iso] = color;
      save.conqPop[target.iso] = Math.round(attack + defense * 0.40);
      addXp(state, 2);
      aiSpendSkillPoints(state, diff);
      maybeDecapitate(save, target.iso, oldOwner, color);
      // Le joueur doit savoir ce qu'on lui a pris pendant qu'il jouait.
      if (oldOwner === save.playerColor) {
        const w = ISO_WORLD[target.iso] !== undefined ? WORLDS[ISO_WORLD[target.iso]] : null;
        save.passiveChanges.push({
          iso: target.iso, countryName: w ? w.name : target.iso,
          oldOwner, newOwner: color,
        });
      }
    } else {
      // Assaut repoussé : le défenseur y gagne en ferveur.
      save.conqPop[target.iso] = Math.min(
        countryPop(target.iso),
        (save.conqPop[target.iso] || 0) + attack * 0.25
      );
    }
  }

  persist(save);
}

/** Distance angulaire (rad) entre les centroïdes de deux pays. */
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

/**
 * Peut-on partir à l'assaut de ce pays ? Il suffit qu'il touche une de nos
 * terres. On avance de proche en proche depuis le pays d'origine.
 *
 * Les îles sans voisin déclaré restent atteignables par un saut court depuis une
 * de nos côtes — sans quoi des pays entiers seraient définitivement injouables.
 */
function canEnterCountry(save, iso) {
  if (!iso || !save.conq) return false;
  const owner = ownerOf(save, iso);
  if (owner === save.playerColor) return false;   // déjà à nous : rien à y faire
  if (!owner) return false;                       // pays hors carte

  for (const n of neighborsOf(iso)) {
    if (ownerOf(save, n) === save.playerColor) return true;
  }
  // Repli : île isolée (aucun voisin listé) => saut depuis une de nos terres proches.
  if (neighborsOf(iso).length === 0) {
    for (const w of WORLDS) {
      if (!w.iso || w.iso === iso) continue;
      if (ownerOf(save, w.iso) !== save.playerColor) continue;
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
/** Reconstitue l'ensemble découvert : nos terres et tout ce qu'elles touchent.
 *  Le brouillard suit exactement la règle de canEnterCountry — sinon un pays
 *  attaquable resterait masqué et le clic tomberait dans onUnknown.
 *  Rétroactif pour les parties en cours. */
function ensureDiscovery(save) {
  if (!save.discovered || typeof save.discovered !== 'object') save.discovered = {};
  let changed = false;
  const reveal = (iso) => { if (iso && !save.discovered[iso]) { save.discovered[iso] = true; changed = true; } };
  if (save.startIso) {
    reveal(save.startIso);
    for (const n of neighborsOf(save.startIso)) reveal(n);
  }
  if (save.conq) {
    for (const iso in save.conq) {
      if (ownerOf(save, iso) !== save.playerColor) continue;
      reveal(iso);
      for (const n of neighborsOf(iso)) reveal(n);
    }
  }
  if (changed) persist(save);
  return save.discovered;
}
/** Révèle un pays et ses voisins directs (appelé à chaque conquête). */
function revealNeighbors(save, iso) {
  save.discovered = save.discovered || {};
  let changed = false;
  const reveal = (i) => { if (i && !save.discovered[i]) { save.discovered[i] = true; changed = true; } };
  reveal(iso);
  for (const n of (NEIGHBORS[iso] || [])) reveal(n);
  if (changed) persist(save);
  return changed;
}

/**
 * Le joueur remporte un pays. `conversions` vient du match (fidèles ralliés sur
 * le terrain) et `grade` du RANG S/A/B/C affiché en fin de partie : bien jouer
 * donne un pays plus fervent, donc plus utile pour la suite de la campagne.
 */
const GRADE_START = { S: 0.60, A: 0.45, B: 0.30, C: 0.20 };
function captureCountry(iso, color, grade = 'B', conversions = 0) {
  const s = loadSave();
  s.conq = s.conq || {};
  s.conqPop = s.conqPop || {};
  const oldOwner = s.conq[iso];
  const maxPop = countryPop(iso);

  // Base selon le rang, relevée si le match a converti beaucoup de monde.
  const base = (GRADE_START[grade] ?? GRADE_START.B) * maxPop;
  const fromMatch = conversions > 0 ? Math.min(maxPop * 0.9, conversions * (maxPop / 1000)) : 0;
  s.conq[iso] = color;
  s.conqPop[iso] = Math.round(Math.max(base, fromMatch));

  if (color === s.playerColor) revealNeighbors(s, iso);
  const decap = maybeDecapitate(s, iso, oldOwner, color);
  persist(s);
  return { oldOwner, decap };
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
/**
 * CONDITION DE VICTOIRE : la carte n'est pas le score, l'humanité l'est.
 *
 * Peindre le monde est hors de portée — le simulateur montre que même à 1200
 * tours il reste des centaines de zones neutres, que les 10 religions se
 * répartissent le globe en sphères et ne s'affrontent jamais vraiment. En
 * revanche 8 pays contiennent 54 % de l'humanité : convertir les hommes est un
 * objectif atteignable, disputé, et qui donne enfin un sens à la géographie.
 *
 * Gagne la première religion à rallier cette part de l'humanité.
 */
export const WORLD_FAITH_GOAL = 4e9;   // 4 milliards d'âmes ralliées

/**
 * Où en est la course à l'humanité ?
 *
 * Le seuil ne règle PAS la difficulté — mesuré au simulateur, le taux de
 * victoire est identique de 2 à 4 milliards (73 / 37 / 23 % selon la
 * difficulté). Ce qu'il règle, c'est la DURÉE : l'issue se joue tôt, soit on
 * amorce la boule de neige et on franchira n'importe quel seuil, soit on
 * stagne. 4 Md donne une campagne d'environ 55 tours en normal, soit ~3,7 h.
 */
export function getFaithGoalState() {
  const board = getReligionWorldScores();
  const player = board.religions.find((r) => r.isPlayer) || null;
  const leader = board.religions[0] || null;
  const believers = player ? player.believers : 0;
  const save = loadSave();
  /* Défaite : plus un seul pays. Les terres barbares n'attaquant jamais, être
     rayé de la carte ne peut venir que d'un culte rival — c'est une vraie fin
     de partie, pas un accident. */
  const wipedOut = !!(save.seeded && save.playerColor && countriesOf(save, save.playerColor) === 0);
  return {
    goal: WORLD_FAITH_GOAL,
    believers,
    progress: Math.max(0, Math.min(1, believers / WORLD_FAITH_GOAL)),
    playerWon: believers >= WORLD_FAITH_GOAL,
    wipedOut,
    leader,
    // Un rival a-t-il coiffé le joueur au poteau ?
    rivalWon: !!(leader && !leader.isPlayer && leader.believers >= WORLD_FAITH_GOAL),
    playerPct: player ? player.rawPct : 0,
    totalEarthPop: board.totalEarthPop,
  };
}

export function getReligionWorldScores() {
  const save = loadSave();
  const byColor = {};
  for (const c of CULTS) byColor[c.color] = 0;
  if (save.playerColor && byColor[save.playerColor] === undefined) byColor[save.playerColor] = 0;

  let totalZones = 0;      // pays sur la carte
  let playerZones = 0;     // pays tenus par le joueur

  for (const w of WORLDS) {
    if (!w.iso || !save.conq || save.conq[w.iso] === undefined) continue;
    totalZones++;
    const color = save.conq[w.iso];
    if (!color || color === NEUTRAL) continue;
    if (byColor[color] === undefined) byColor[color] = 0;
    byColor[color] += believersIn(save, w.iso);
    if (color === save.playerColor) playerZones++;
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
/* ============================ Controleur d ecran ============================ */
let root = null, star = null, globe = null, playHandler = null, onCloseCb = null;
/* Listener clavier du créateur : posé sur `document`, il doit être retiré par
   closeProgression, sinon chaque réouverture de la campagne en empile un de
   plus (une flèche ← ferait tourner la carte de leader N fois) et retient
   l'ancien `root` détaché en mémoire. */
let creatorKeyHandler = null;

export function setPlayHandler(fn) { playHandler = fn; }

/* Le hub 3D à portails a été retiré : toute la campagne se joue sur le globe.
   Toucher un pays le sélectionne, un bouton lance le match. Un pays = un match,
   ce qui divise par ~9 la longueur de campagne (1537 provinces → 177 pays) et
   fait passer la progression à 2 h de jeu de 2,4 % à 11,3 % de l'humanité. */

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
        <p class="prog-hint">Glissez pour tourner le globe · touchez un pays pour le viser</p>
        <div class="prog-loading">Chargement du monde…</div>
        <div class="prog-zone-panel hidden">
          <div class="prog-zone-info"><span class="prog-zone-name"></span><span class="prog-zone-holder"></span></div>
          <button class="prog-zone-play">⚔ Partir en croisade</button>
        </div>
      </div>
      <aside class="prog-global-stats" aria-label="Classement des religions">
        <div class="prog-lb-head">
          <span class="prog-lb-title">Foi mondiale</span>
          <span class="prog-lb-pts">✦ <span id="global-skill-pts">0</span></span>
        </div>
        <div id="faith-goal" class="prog-goal"></div>
        <div id="global-religion-lb" class="prog-lb-list"></div>
      </aside>
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

  const loading = root.querySelector('.prog-loading');
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

  // Keyboard navigation listener (retiré dans closeProgression)
  if (creatorKeyHandler) document.removeEventListener('keydown', creatorKeyHandler);
  creatorKeyHandler = (e) => {
    if (creatorOverlay && !creatorOverlay.classList.contains('hidden')) {
      if (e.key === 'ArrowLeft') {
        renderCreatorLeaders(-1);
      } else if (e.key === 'ArrowRight') {
        renderCreatorLeaders(1);
      }
    }
  };
  document.addEventListener('keydown', creatorKeyHandler);

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
        sw.classList.toggle('sel', sw.dataset.color === s.playerColor);
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
    /* Un pays tenu vaut ses points de foi. L'attribution est idempotente
       (skillMajority/skillFull par ISO), donc on peut la rejouer sans risque —
       c'est ce qui rattrape les gains manqués des parties déjà commencées. */
    for (const iso of countryListOf(save, save.playerColor)) {
      const award = awardConquestSkills({ iso, wasMajority: false, isMajority: true, isFull: true });
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

  /* Rend visible ce que la propagation a fait pendant qu'on jouait : sans ce
     retour, la mécanique tourne mais le joueur ne la voit jamais. */
  function checkFaithSpread() {
    const save = loadSave();
    const f = save.lastFaith;
    const d = save.lastDecap;
    let delay = 0;
    if (f && (f.gained > 0 || f.preached > 0)) {
      const bits = [];
      if (f.gained > 0) bits.push(`${f.gained} territoire${f.gained > 1 ? 's' : ''} converti${f.gained > 1 ? 's' : ''}`);
      if (f.preached > 0) bits.push(`${f.preached} zone${f.preached > 1 ? 's' : ''} sous prédication`);
      setTimeout(() => toast(`✧ Votre foi se répand : ${bits.join(' · ')}.`), delay);
      delay += 3000;
    }
    // Une décapitation subie ou infligée passivement doit être annoncée.
    if (d && d.turn === (save.worldTurn | 0)) {
      const victim = CULTS.find((c) => c.color === d.victim);
      const mine = d.by === save.playerColor;
      const victimName = d.victim === save.playerColor
        ? 'VOTRE CULTE'
        : `le culte ${victim ? victim.name : 'rival'}`;
      setTimeout(() => toast(mine
        ? `⛧ SIÈGE BRISÉ — ${victimName} s'effondre ! ${d.flipped} territoires vous rejoignent.`
        : `☠ VOTRE SIÈGE EST TOMBÉ — ${d.flipped} de vos territoires ont fait défection.`
      ), delay);
    }
    if (save.lastFaith || save.lastDecap) {
      delete save.lastFaith;
      delete save.lastDecap;
      persist(save);
    }
  }

  /* Barre d'objectif : la campagne se gagne en ralliant l'humanité, pas en
     peignant la carte. Sans ce repère permanent, le but du mode campagne
     resterait invisible et le joueur croirait devoir tout conquérir. */
  function updateFaithGoalUI() {
    const el = root.querySelector('#faith-goal');
    if (!el) return;
    const g = getFaithGoalState();
    const done = Math.round(g.progress * 100);
    el.innerHTML = `
      <div class="prog-goal-head">
        <span class="prog-goal-lbl">Objectif — 4 milliards d'âmes</span>
        <span class="prog-goal-val">${formatBelievers(g.believers)}</span>
      </div>
      <div class="prog-goal-track"><i style="width:${done}%"></i></div>
      <div class="prog-goal-sub">${done} % de l'objectif · ${g.playerPct.toFixed(1)} % de l'humanité</div>`;
    el.classList.toggle('is-won', g.playerWon);

    // Fin de campagne : on ne l'annonce qu'une fois.
    const save = loadSave();
    if (g.playerWon && !save.campaignWon) {
      save.campaignWon = true; persist(save);
      setTimeout(() => toast(
        `🏆 VICTOIRE — ${save.religionName || 'votre culte'} rassemble ${formatBelievers(g.believers)} fidèles.\n`
        + `Le monde a une nouvelle foi.`
      ), 600);
    } else if (g.wipedOut && !save.campaignLost) {
      save.campaignLost = true; persist(save);
      setTimeout(() => toast(
        `☠ DÉFAITE — votre culte a perdu sa dernière terre. La foi s'éteint.`
      ), 600);
    } else if (g.rivalWon && !save.campaignLost) {
      save.campaignLost = true; persist(save);
      setTimeout(() => toast(
        `☠ DÉFAITE — le culte ${g.leader.name} a rallié 4 milliards d'âmes avant vous.`
      ), 600);
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
    updateFaithGoalUI();
    refreshSkillPointsUI();
  }

  // Remplir les couleurs du créateur
  creatorSwatches.innerHTML = '';
  CULTS.forEach((c) => {
    const sw = document.createElement('div');
    sw.className = 'swatch';
    /* role + tabindex : sans eux, ces pastilles ne sont que des div cliquables.
       Elles restaient donc invisibles a la navigation manette, qui ne parcourt
       que des elements interactifs declares — la couleur divine etait tout
       simplement impossible a choisir au pad. Profite aussi aux lecteurs d'ecran. */
    sw.setAttribute('role', 'button');
    sw.tabIndex = 0;
    sw.setAttribute('aria-label', `Couleur ${c.name || c.color}`);
    /* La couleur est mémorisée en dataset : `style.backgroundColor` est
       normalisé par le navigateur en `rgb(...)` et ne pourra jamais être
       comparé au `#rrggbb` de la sauvegarde. */
    sw.dataset.color = c.color;
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
    btn.setAttribute('role', 'button');   // meme raison que les pastilles de couleur
    btn.tabIndex = 0;
    btn.setAttribute('aria-label', `Symbole ${sym}`);
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
      seats: {},
      decapAt: {},
      discovered: {},
      worldTurn: 0,
      seeded: false,
      worldModel: 3,
    };
    persist(save);
    creatorOverlay.classList.add('hidden');

    // Réinitialisation visuelle du globe
    if (globe) globe.stop();
    globe = buildGlobe();

    /* Semis des 10 religions. Plus aucun fetch de provinces : le modèle v3 se
       contente de la liste des pays, donc la carte est prête immédiatement —
       là où la pré-init v2 chargeait 254 fichiers GeoJSON par lots de 20. */
    (async () => {
      try {
        await seedReligionStarts();
        ensureDiscovery(loadSave());
        const startWorld = WORLDS[ISO_WORLD[loadSave().startIso]];
        if (startWorld) {
          setTimeout(() => globe.focusWorld(startWorld), 200);
          setTimeout(() => toast(`Votre foi naît en ${startWorld.name}.`), 400);
        }
        updateGlobalStatsUI();
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
      if (oldColor && newColor && oldColor !== newColor) {
        if (save.conq) {
          for (const iso in save.conq) {
            const zones = save.conq[iso];
            for (const rid in zones) {
              // Échange : le joueur prend newColor, une IA éventuelle récupère oldColor.
              if (zones[rid] === oldColor) zones[rid] = newColor;
              else if (zones[rid] === newColor) zones[rid] = oldColor;
            }
          }
        }
        /* Les états IA sont eux aussi indexés par couleur : sans cet échange,
           l'IA qui tenait newColor hériterait des zones oldColor avec un état
           vierge (niveau, xp, skills, agressivité perdus), et son ancien état
           deviendrait orphelin sous la couleur du joueur — invisible, puisque
           aiColors() filtre playerColor. */
        if (save.ai) {
          const aiNew = save.ai[newColor];   // l'IA qui portait la nouvelle couleur
          if (aiNew) save.ai[oldColor] = aiNew;   // …suit ses zones vers l'ancienne
          else delete save.ai[oldColor];
          delete save.ai[newColor];          // le joueur ne porte pas d'état IA
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
  let selectedWorld = null;   // pays visé sur le globe

  root.querySelector('.prog-back').addEventListener('click', closeProgression);
  root.querySelector('.prog-edit').addEventListener('click', openReligionEditor);

  /**
   * Panneau d'un pays visé, affiché sur le globe. Il doit répondre aux trois
   * questions du joueur avant qu'il n'engage un match : qui tient ce pays,
   * combien d'âmes il y a à prendre, et ce que ça coûte s'il perd.
   */
  function showCountryPanel(world) {
    const save = loadSave();
    const iso = world.iso;
    const owner = ownerOf(save, iso);
    const rel = getWorldReligion(save, world);
    const pop = countryPop(iso);
    const believers = believersIn(save, iso);
    const mine = owner === save.playerColor;
    const barbarian = owner === NEUTRAL;

    const symHtml = (rel.sym.startsWith('data:') || rel.sym.startsWith('http'))
      ? `<img src="${rel.sym}" class="stats-cult-icon" />`
      : rel.sym;

    let body = `Tenu par : ${symHtml} <span style="font-weight:800;">${rel.name}</span>`;
    body += `<br/><span style="font-size:12px;opacity:.85;display:block;margin-top:4px;">`
      + `Population : <b style="color:#fff;">${formatBelievers(pop)}</b>`;
    if (!barbarian) {
      body += ` · Fidèles : <b style="color:#ffe259;">${formatBelievers(believers)}</b>`
        + ` (${Math.round(fervorOf(save, iso) * 100)} %)`;
    }
    body += `</span>`;

    // Le siège d'un culte est l'objectif le plus rentable du jeu : il se voit.
    const seats = ensureSeats(save);
    const seatOwner = Object.keys(seats).find((c) => seats[c] === iso);
    if (seatOwner && seatOwner !== save.playerColor) {
      const sc = CULTS.find((c) => c.color === seatOwner);
      body += `<br/><span style="color:#ffd24d;font-size:11px;font-weight:800;display:block;margin-top:4px;">`
        + `⛧ BERCEAU du culte ${sc ? sc.name : 'rival'} — le prendre brisera son empire.</span>`;
    } else if (seatOwner === save.playerColor) {
      body += `<br/><span style="color:#ffd24d;font-size:11px;font-weight:800;display:block;margin-top:4px;">`
        + `⛧ Votre berceau — le perdre disperserait vos fidèles.</span>`;
    }

    zoneName.textContent = world.name;
    zoneHolder.innerHTML = body;
    zoneHolder.style.color = barbarian ? '#cfe' : rel.color;

    if (mine) {
      zonePlay.classList.add('hidden');
    } else if (canEnterCountry(save, iso)) {
      zonePlay.textContent = barbarian ? '⚔ Convertir cette terre' : '⚔ Partir en croisade';
      zonePlay.disabled = false;
      zonePlay.classList.remove('hidden');
    } else {
      zoneHolder.innerHTML = body
        + `<br/><span style="color:#ff5f6d;font-size:11px;font-weight:700;display:block;margin-top:4px;">`
        + `⚠️ Ce pays doit toucher une de vos terres.</span>`;
      zonePlay.disabled = true;
      zonePlay.classList.remove('hidden');
    }
    panel.classList.remove('hidden');
    // L'indice « glissez pour tourner » gênerait la lecture du panneau.
    root.querySelector('.prog-hint')?.classList.add('hidden');
  }

  /** Referme le panneau et rend l'indice de manipulation du globe. */
  function hideCountryPanel() {
    panel.classList.add('hidden');
    selectedWorld = null;
    root.querySelector('.prog-hint')?.classList.remove('hidden');
  }

  zonePlay.addEventListener('click', () => {
    if (selectedWorld) launchCountry(selectedWorld);
  });

  /**
   * Lance le match pour un pays. Un match = un tour de monde : la foi se
   * propage, les 9 IA jouent, puis le combat a lieu.
   */
  function launchCountry(world) {
    if (!world) return;
    const save = loadSave();
    const iso = world.iso;
    const preHolder = ownerOf(save, iso);
    const isBarbarian = preHolder === NEUTRAL;

    /* Religions présentes autour de la cible : elles s'invitent au match, ce qui
       rend les zones frontalières réellement disputées. */
    const adjacentSet = new Set();
    if (!isBarbarian && preHolder && preHolder !== save.playerColor) adjacentSet.add(preHolder);
    for (const n of neighborsOf(iso)) {
      const h = ownerOf(save, n);
      if (h && h !== NEUTRAL && h !== save.playerColor) adjacentSet.add(h);
    }

    /* Force du défenseur transmise au match : une nation mûre doit se sentir.
       Sans ça, une terre vide et une forteresse lançaient le même combat. */
    const defenseInfo = {
      believers: believersIn(save, iso),
      saturation: fervorOf(save, iso),
      isSeat: Object.values(ensureSeats(save)).includes(iso),
      strength: isBarbarian ? 0 : Math.min(1, fervorOf(save, iso)
        * (Object.values(ensureSeats(save)).includes(iso) ? 1.4 : 1)),
    };

    const onResult = (res) => {
      const win = typeof res === 'object' ? res.win : res;
      const conversions = typeof res === 'object' ? (res.conversions || 0) : 0;
      const grade = typeof res === 'object' ? (res.grade || 'B') : 'B';
      const winnerColor = typeof res === 'object' ? res.winnerColor : null;

      root.classList.remove('hidden');
      if (!star) star = createStarfield(root.querySelector('.prog-stars'));
      if (!globe) globe = buildGlobe();

      if (win) {
        const { decap } = captureCountry(iso, loadSave().playerColor, grade, conversions);
        const s = loadSave();
        ensurePlayerLevel(s);
        const gained = addXp(s, isBarbarian ? 2 : 4);
        delete s.lastDecap;   // on l'annonce nous-même juste en dessous
        persist(s);

        let msg = `✓ ${world.name} rejoint votre culte — ${formatBelievers(believersIn(s, iso))} fidèles.`;
        if (gained > 0) msg += `\n⬆ Niveau ${s.level} ! +${gained} pt${gained > 1 ? 's' : ''} de foi`;
        toast(msg);

        if (decap && decap.flipped > 0) {
          const cult = CULTS.find((c) => c.color === decap.victim);
          setTimeout(() => toast(
            `⛧ BERCEAU BRISÉ — le culte ${cult ? cult.name : 'rival'} s'effondre !\n`
            + `${decap.flipped} pays rejoignent votre foi.`
          ), 2800);
        }
      } else if (winnerColor && winnerColor !== save.playerColor) {
        // Un rival remporte le pays disputé.
        captureCountry(iso, winnerColor, 'B', 0);
        const s = loadSave();
        addXp(ensureAiState(s, winnerColor), 2);
        persist(s);
        const cult = CULTS.find((c) => c.color === winnerColor);
        toast(`✗ Défaite. Le culte ${cult ? cult.name : 'rival'} s'empare de ${world.name}.`);
      } else {
        toast(`✗ ${world.name} résiste. Vos fidèles se replient.`);
      }

      reconcileConquestSkills();
      updateGlobalStatsUI();
      checkPassiveChanges();
      checkFaithSpread();
      hideCountryPanel();
      globe && globe.repaint && globe.repaint();
    };

    // Un match = un tour de monde. La foi se propage, les IA jouent.
    simulateWorldTurn();

    if (playHandler) {
      root.classList.add('hidden');
      if (globe) { globe.stop(); globe = null; }
      if (star) { star.stop(); star = null; }
      playHandler({
        world,
        region: { id: iso, name: world.name },   // compat : le match attend une « région »
        onResult,
        playerColor: save.playerColor,
        zonesCount: 1,
        barbarian: isBarbarian,
        owner: preHolder,
        touchingOwners: Array.from(adjacentSet),
        defense: defenseInfo,
      });
    } else {
      onResult({ win: true, grade: 'B' });   // repli autonome : conquête simulée
    }
  }

  /** Construit (ou reconstruit) le globe avec ses gestionnaires de sélection. */
  function buildGlobe() {
    return createGlobe(root.querySelector('.prog-globe'), {
      onPick(world) {
        const save = loadSave();
        selectedWorld = world;
        globe.focusWorld(world);
        if (ownerOf(save, world.iso) === save.playerColor) {
          showCountryPanel(world);   // nos terres : on informe, on ne combat pas
          return;
        }
        showCountryPanel(world);
      },
      onUnknown() { toast('Cette terre n\'a pas encore été révélée.'); },
    });
  }

  globe = buildGlobe();

  try { await ensureShapes(); } catch (e) { loading.textContent = 'Carte du monde indisponible.'; return; }
  loading.remove();

  // Création du culte, ou reprise de la campagne en cours.
  {
    const s = loadSave();
    if (!s.playerName) {
      selectedCreatorLeader = 'monk';
      renderCreatorLeaders();
      creatorOverlay.classList.remove('hidden');
    } else {
      ensureWorldModel(s);            // migre vers le modèle v3 (le pays est l'unité)
      await seedReligionStarts();     // 1 pays par religion
      /* Reprise de partie : la liste WORLDS vient d'être peuplée par
         ensureShapes. Tout pays absent de la sauvegarde n'aurait aucun
         propriétaire, donc serait à jamais inattaquable — on les déclare
         barbares au passage. */
      {
        const cur = loadSave();
        initAllCountries(cur);
        persist(cur);
      }
      ensureDiscovery(loadSave());
      const s2 = loadSave();
      const w = WORLDS[ISO_WORLD[s2.startIso]];
      if (w) setTimeout(() => globe.focusWorld(w), 200);
      reconcileConquestSkills();
    }
  }

  updateGlobalStatsUI();
  checkPassiveChanges();
  checkFaithSpread();
}

export function closeProgression() {
  if (!root) return;
  if (creatorKeyHandler) { document.removeEventListener('keydown', creatorKeyHandler); creatorKeyHandler = null; }
  globe && globe.stop(); star && star.stop();
  root.remove(); root = null; globe = null; star = null;
  if (onCloseCb) onCloseCb();
}

/* petit toast */
let toastEl = null, toastT = 0;
function toast(msg) {
  if (!toastEl) { toastEl = document.createElement('div'); toastEl.className = 'prog-toast'; document.body.appendChild(toastEl); }
  toastEl.textContent = msg; toastEl.classList.add('show');
  clearTimeout(toastT); toastT = setTimeout(() => toastEl.classList.remove('show'), 2600);
}
