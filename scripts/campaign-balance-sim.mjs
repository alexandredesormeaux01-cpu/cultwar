/* ============================================================================
   Simulateur d'équilibrage de la campagne — headless, hors du jeu.

   But : régler les constantes de la « Propagation de la Foi » sur des courbes
   plutôt qu'en jouant une heure pour découvrir que ça plafonne encore.

   Modèle simulé :
     · La foi ne se duplique JAMAIS, elle se déplace. Tous les transferts sont
       faits en croyants absolus, jamais en pourcentages.
     · Chaque zone possédée voit son % de croyants croître en S (logistique)
       vers un plafond qui dépend de la pression rivale alentour.
     · Au-dessus d'un seuil, une zone se DÉVERSE sur sa voisine la plus faible :
       elle lui donne des croyants, et retombe d'autant.
     · Le débordement reste À L'INTÉRIEUR d'un pays. Entrer dans un nouveau pays
       exige un match (la tête de pont), ce qui préserve le rôle du match.
     · Attaquer une zone rivale, c'est miser des croyants. Le rang S/A/B/C du
       match décide de la part qui change de main, dans les deux sens.
     · Prendre le SIÈGE d'un culte fait s'effondrer son empire (décapitation).

   Données : vraies populations (world-countries-110m.geojson), vrai graphe de
   voisinage des pays (src/countryNeighbors.js), vrai nombre de zones par pays
   (compté dans assets/maps/admin-1 puis passé par la règle de clusterRegions).

   APPROXIMATIONS ASSUMÉES :
     · l'adjacence des zones À L'INTÉRIEUR d'un pays est générée (anneau +
       cordes, degré moyen ~4) au lieu d'être calculée sur la géométrie réelle ;
     · le joueur joue une stratégie parfaite, à taux de victoire fixe.
   C'est la FORME des courbes qui est exploitable, pas la troisième décimale.

   IMPORTANT : une partie unique a une variance énorme (tout dépend d'où le
   joueur est semé). Utilisez --runs=N pour raisonner sur des médianes.

   Usage :
     node scripts/campaign-balance-sim.mjs --runs=25
     node scripts/campaign-balance-sim.mjs --runs=25 --diff=hard
     node scripts/campaign-balance-sim.mjs --decap --spread=spillplayer
     node scripts/campaign-balance-sim.mjs            (1 partie, rapport détaillé)
============================================================================ */

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { NEIGHBORS } from '../src/countryNeighbors.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MAPS = join(ROOT, 'public', 'assets', 'maps');

/* ----------------------------- Paramètres ----------------------------- */
const argv = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v === undefined ? true : v];
  })
);
const num = (k, d) => (argv[k] !== undefined ? Number(argv[k]) : d);

const P = {
  turns: num('turns', 200),
  GOAL: num('goal', 40),              // % de l'humanité à rallier pour gagner
  countryMode: !!argv.countrymode,    // 1 pays = 1 zone = 1 match
  noProtect: !!argv.noprotect,        // l'élimination est une vraie défaite
  runs: num('runs', 1),
  seed: num('seed', 1234567),
  difficulty: argv.diff || 'normal',
  /* 'all'         : tout le monde mûrit et déborde (monde symétrique)
     'spillplayer' : tout le monde mûrit, seul le JOUEUR déborde  ← l'asymétrie
     'player'      : seul le joueur mûrit et déborde (test extrême) */
  spread: argv.spread || 'all',
  strategy: argv.strategy || 'pop',   // pop | small
  erosionFlip: !!argv.erosionflip,    // le déversement CONVERTIT les zones rivales
  dogpile: !!argv.dogpile,            // les IA visent la religion de tête
  capitals: !!argv.capitals,          // une capitale par pays : la tenir dope la foi
  CAPITAL_BONUS: num('capitalbonus', 1.6),
  capitalGrowthOnly: !!argv.capitalgrowthonly,  // bonus sur la maturation seule
  AI_CAPITAL_PREF: num('aicapitalpref', 0.5),   // appétit des IA pour les capitales

  /* BUDGET DE CLERGÉ : nombre max de zones converties passivement par tour.
     Sans lui, le déversement est linéaire en nombre de zones, donc planter des
     têtes de pont partout domine toute autre stratégie (mesuré : 27 % → 66 %
     rien qu'en changeant les priorités de cible). 0 = pas de plafond. */
  CLERGY_BASE: num('clergybase', 0),
  CLERGY_PER_ZONE: num('clergyperzone', 0.02),  // +1 prêcheur toutes les 50 zones

  // --- Croissance logistique du % de croyants d'une zone possédée ---
  GROWTH_RATE: num('rate', 0.18),
  CAP_BASE: num('cap', 0.95),
  CAP_PER_RIVAL: num('caprival', 0.09),
  CAP_MIN: num('capmin', 0.45),

  /* DÉMESURE : au-delà d'une certaine taille, l'Église s'étire et perd en
     ferveur — le plafond de conversion baisse avec le nombre de zones tenues.
     Sans ça, la saturation est un cliquet : elle ne fait que monter, les cœurs
     d'empire deviennent inviolables et la carte se fige en sphères étanches
     (mesuré : les 10 fiefs tenus à 100 %, zéro envahisseur, jamais). */
  HUBRIS: num('hubris', 0),          // 0 = désactivé ; 0.35 = -35 % à HUBRIS_REF zones
  HUBRIS_REF: num('hubrisref', 200), // taille d'empire de référence
  /* REFLUX : sans lui, abaisser un plafond ne changerait rien aux zones déjà
     saturées — la démesure serait purement décorative. */
  DECAY: num('decay', 0.10),         // vitesse de retour au plafond

  // --- Déversement ---
  SPILL_THRESHOLD: num('threshold', 0.55),
  SPILL_EFF: num('spilleff', 0.60),
  SPILL_FLOOR: num('spillfloor', 0.20),
  EROSION_MULT: num('erosion', 0.35),

  // --- Décapitation ---
  decap: !!argv.decap,
  siege: !!argv.siege,               // briser un siège exige de tenir le pays
  siegeAuto: !!argv.siegeauto,       // le siège tombe dès que son fief est conquis
  SIEGE_SHARE: num('siegeshare', 0.5),  // part du pays à tenir pour briser le siège
  DECAP_SHARE: num('decapshare', 0.20),
  DECAP_KEEP: num('decapkeep', 0.70),
  DECAP_SCHISM: num('decapschism', 0.15),
  DECAP_COOLDOWN: num('decapcd', 25),

  /* --- Match du joueur : 1 par tour, mais PAS une victoire à chaque fois ---
   *
   * Le taux de victoire ne peut pas être une constante : prendre une terre
   * barbare vide et arracher le siège saturé du culte dominant ne sont pas le
   * même match. On le dérive donc du rapport de force réel (croyants engagés
   * contre croyants défenseurs), majoré pour les objectifs fortifiés.
   *
   * `PLAYER_SKILL` représente ce qu'un humain apporte au-dessus des chiffres :
   * c'est LUI qui joue le match, pas un dé. 1.0 = le joueur vaut son rapport de
   * force ; au-dessus, il gagne des matchs qu'il « devrait » perdre.
   */
  WIN_RATE: num('winrate', 0.85),        // plafond, atteint face aux terres barbares
  WIN_FLOOR: num('winfloor', 0.10),      // on n'est jamais totalement condamné
  PLAYER_SKILL: num('skill', 1.4),       // avantage du joueur humain sur le modèle
  DEF_CAPITAL: num('defcapital', 1.5),   // une capitale se défend mieux
  DEF_SEAT: num('defseat', 2.2),         // un siège sacré est une forteresse
  /* Un joueur sensé n'attaque pas une forteresse avec zéro troupe : en dessous
     de ces chances, il préfère une terre barbare et laisse mûrir ses provinces.
     Sans ce seuil, le modèle se suicidait sur les sièges à chaque tour. */
  MIN_ODDS: num('minodds', 0.35),
  /* Portée de la mobilisation : 'adjacent' ne lève que les provinces voisines,
     'country' lève les fidèles de tout le pays. Avec 'adjacent', la propagation
     passive crée tant de provinces peu saturées que le joueur attaque les mains
     vides et ne prend jamais un siège. */
  stakeScope: argv.stakescope || 'adjacent',
  GRADE_DIST: { S: 0.15, A: 0.30, B: 0.35, C: 0.20 },
  START_PCT: { S: 0.60, A: 0.45, B: 0.30, C: 0.20 },
  ABSORB: { S: 0.60, A: 0.45, B: 0.30, C: 0.20 },
  LOSS: { S: 0.10, A: 0.25, B: 0.50, C: 1.00 },
  STAKE_FRACTION: num('stake', 0.30),

  /* `focus` = part des vols dirigée vers le joueur. Sans lui, monter `steal`
     faisait s'entre-dévorer les IA et AIDAIT le joueur (difficulté inversée). */
  DIFF_SIM: {
    easy: { act: 0.35, steal: 0.05, focus: 0.10 },
    normal: { act: 0.65, steal: 0.20, focus: 0.40 },
    hard: { act: 0.95, steal: 0.30, focus: 0.75 },
  },
  AI_ABSORB: num('aiabsorb', 0.40),
};

const PLAYER = 'P';
const AI_COLORS = ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'a8', 'a9'];
const ALL = [PLAYER, ...AI_COLORS];

/* --------------------------- Chargement carte --------------------------- */
/* Coûteux (254 fichiers) : fait une seule fois, partagé par tous les runs. */
const WORLD = (function loadWorld() {
  const geo = JSON.parse(readFileSync(join(MAPS, 'world-countries-110m.geojson'), 'utf8'));
  const pops = {};
  for (const f of geo.features) {
    const p = f.properties || {};
    const iso = p.ISO_A3 && p.ISO_A3 !== '-99' ? p.ISO_A3 : p.ADM0_A3;
    if (!iso || iso === '-99') continue;
    pops[iso] = Math.max(1000, p.POP_EST || 1000000);
  }
  /* Nombre de zones = features admin-1 passées par la règle de clusterRegions
     (≤15 → tel quel, sinon K = clamp(round(n/8), 8, 15)). On compte au regex :
     inutile de parser 7 Mo de géométrie pour un simple décompte. */
  const countries = [];
  for (const file of readdirSync(join(MAPS, 'admin-1'))) {
    if (!file.endsWith('.geojson')) continue;
    const iso = file.replace('.geojson', '');
    if (!pops[iso]) continue;
    const raw = readFileSync(join(MAPS, 'admin-1', file), 'utf8');
    const n = (raw.match(/"type":"Feature"/g) || []).length;
    if (!n) continue;
    let zoneCount = n <= 15 ? n : Math.min(n, Math.max(8, Math.min(15, Math.round(n / 8))));
    /* Densité de la carte : 1537 zones à ~4 min de match font 100 h de campagne,
       hors de propos pour du mobile. `--zonediv` simule une carte plus grossière
       (moins de provinces par pays) pour chiffrer le gain avant de retoucher
       clusterRegions. */
    zoneCount = Math.max(1, Math.round(zoneCount / num('zonediv', 1)));
    countries.push({ iso, pop: pops[iso], zoneCount });
  }
  /* Monde curaté : ne garder que les N pays les plus peuplés. Alternative à
     `--zonediv` — raccourcit la campagne SANS appauvrir les hubs 3D, dont le
     nombre de portails suit le nombre de zones d'un pays. */
  const cap = num('countrymax', 0);
  if (cap > 0) {
    countries.sort((a, b) => b.pop - a.pop);
    return countries.slice(0, cap);
  }
  return countries;
})();

/* ============================== UNE PARTIE ============================== */
function runOnce(seed) {
  let _s = seed >>> 0;
  const rnd = () => { _s = (_s * 1664525 + 1013904223) >>> 0; return _s / 4294967296; };
  const pick = (arr) => arr[(rnd() * arr.length) | 0];

  /* Adjacence intra-pays générée : anneau (connexité garantie) + cordes. */
  function buildZoneNeighbors(count) {
    const nb = Array.from({ length: count }, () => new Set());
    if (count === 1) return nb;
    for (let i = 0; i < count; i++) {
      const j = (i + 1) % count;
      nb[i].add(j); nb[j].add(i);
    }
    for (let k = 0; k < Math.round(count * 0.9); k++) {   // degré moyen visé ~4
      const a = (rnd() * count) | 0, b = (rnd() * count) | 0;
      if (a !== b) { nb[a].add(b); nb[b].add(a); }
    }
    return nb;
  }

  const zones = [];
  const byIso = {};
  const capitalOf = {};        // iso → index de la zone capitale

  if (P.countryMode) {
    /* MODE PAYS : on oublie les provinces. Une zone = un pays, un match = un
       pays. La foi ne se propage plus À L'INTÉRIEUR d'un pays (il n'y a plus
       d'intérieur) mais DE PAYS À PAYS, le long du vrai graphe de voisinage.
       177 unités au lieu de 1537 : division par ~9 de la longueur de campagne. */
    const idxOf = {};
    for (const c of WORLD) {
      idxOf[c.iso] = zones.length;
      byIso[c.iso] = [zones.length];
      zones.push({ idx: zones.length, iso: c.iso, maxPop: c.pop, owner: null, believers: 0, nb: [] });
    }
    for (const z of zones) {
      z.nb = (NEIGHBORS[z.iso] || []).map((n) => idxOf[n]).filter((i) => i !== undefined);
    }
    // Pas de capitale distincte : le pays EST l'unité.
  } else {
    for (const c of WORLD) {
      const nb = buildZoneNeighbors(c.zoneCount);
      const ids = [];
      const zoneMax = c.pop / c.zoneCount;
      for (let i = 0; i < c.zoneCount; i++) {
        ids.push(zones.length);
        zones.push({ idx: zones.length, iso: c.iso, maxPop: zoneMax, owner: null, believers: 0, nb: [] });
      }
      for (let i = 0; i < c.zoneCount; i++) zones[ids[i]].nb = [...nb[i]].map((j) => ids[j]);
      byIso[c.iso] = ids;
      // Capitale du pays (dans le jeu : la plus grande province ; ici, une zone fixe).
      capitalOf[c.iso] = ids[0];
    }
  }
  const isoList = Object.keys(byIso);

  /* Semis : une zone de départ par religion, dans un pays distinct, à 12 %
     (comme seedReligionStarts). Cette zone devient le siège sacré du culte. */
  const seats = {};
  {
    const pool = [...isoList];
    for (const color of ALL) {
      if (!pool.length) break;
      const iso = pool.splice((rnd() * pool.length) | 0, 1)[0];
      const zi = pick(byIso[iso]);
      zones[zi].owner = color;
      zones[zi].believers = zones[zi].maxPop * 0.12;
      seats[color] = zi;
    }
  }

  /* ----------------------------- Helpers ------------------------------ */
  const pctOf = (z) => (z.maxPop > 0 ? z.believers / z.maxPop : 0);

  /* Facteur de démesure par religion, recalculé une fois par tour (parcourir
     toutes les zones pour chaque zone serait quadratique). */
  let hubrisFactor = {};
  function refreshHubris() {
    hubrisFactor = {};
    if (!P.HUBRIS) return;
    for (const c of ALL) {
      hubrisFactor[c] = Math.max(0.35, 1 - P.HUBRIS * (zonesOf(c) / P.HUBRIS_REF));
    }
  }

  function capOf(z) {
    let rivals = 0;
    for (const n of z.nb) if (zones[n].owner && zones[n].owner !== z.owner) rivals++;
    const base = Math.max(P.CAP_MIN, P.CAP_BASE - rivals * P.CAP_PER_RIVAL);
    return base * (hubrisFactor[z.owner] ?? 1);
  }
  function countryShare(iso, color) {
    const ids = byIso[iso];
    let mine = 0;
    for (const i of ids) if (zones[i].owner === color) mine++;
    return mine / ids.length;
  }
  const isMajority = (iso, color) => countryShare(iso, color) > 0.5;

  /** Pays où `color` peut entrer : présence, ou voisin d'un pays tenu en majorité. */
  function accessibleCountries(color) {
    const out = new Set();
    for (const iso of isoList) {
      if (countryShare(iso, color) > 0) out.add(iso);
      if (isMajority(iso, color)) for (const n of (NEIGHBORS[iso] || [])) if (byIso[n]) out.add(n);
    }
    return out;
  }
  function believersOf(color) {
    let n = 0;
    for (const z of zones) if (z.owner === color) n += z.believers;
    return n;
  }
  function zonesOf(color) {
    let n = 0;
    for (const z of zones) if (z.owner === color) n++;
    return n;
  }
  /* La simulation passive ne raye jamais une religion de la carte (miroir de
     canLoseZonePassively dans progression.js). Seul un vrai match peut achever
     un culte — sinon le joueur pouvait être éliminé dès son premier tour. */
  const canLosePassively = (color) => !color || P.noProtect || zonesOf(color) > 1;

  /** Bonus dont bénéficie `color` dans ce pays s'il en tient la capitale. */
  function capitalMult(iso, color) {
    if (!P.capitals || !color) return 1;
    const ci = capitalOf[iso];
    return ci !== undefined && zones[ci].owner === color ? P.CAPITAL_BONUS : 1;
  }
  function grade() {
    const r = rnd();
    let acc = 0;
    for (const [g, p] of Object.entries(P.GRADE_DIST)) { acc += p; if (r < acc) return g; }
    return 'C';
  }

  /* --------------------------- Décapitation --------------------------- */
  const decapLog = [];
  const matchLog = [];   // chaque match contre un rival : gagné ? avec quelles chances ?
  const lastDecap = {};
  let curTurn = 0;

  function decapitate(victim, conqueror) {
    const held = [];
    for (const z of zones) if (z.owner === victim) held.push(z.idx);
    if (!held.length) { delete seats[victim]; return 0; }

    // Les zones les plus riches basculent en premier : c'est le cœur du culte.
    held.sort((a, b) => zones[b].believers - zones[a].believers);
    const nFlip = Math.round(held.length * P.DECAP_SHARE);
    const nSchism = Math.round(held.length * P.DECAP_SCHISM);

    for (let k = 0; k < nFlip && k < held.length; k++) {
      const z = zones[held[k]];
      z.owner = conqueror;
      z.believers *= P.DECAP_KEEP;
    }
    for (let k = nFlip; k < nFlip + nSchism && k < held.length; k++) {
      const z = zones[held[k]];
      z.owner = null; z.believers = 0;
    }

    /* EXIL : le siège fuit le plus LOIN possible du conquérant, pas sur la plus
       grosse zone survivante. Sans ça il se relocalise juste à côté et le joueur
       farme le même culte tour après tour (observé : 5 décapitations de suite). */
    const survivors = held.slice(nFlip + nSchism);
    if (survivors.length) {
      const scored = survivors.map((i) => {
        const z = zones[i];
        const adjacent = z.nb.filter((n) => zones[n].owner === conqueror).length;
        const inCountry = byIso[z.iso].filter((n) => zones[n].owner === conqueror).length;
        return { i, score: adjacent * 10 + inCountry - pctOf(z) };
      });
      scored.sort((a, b) => a.score - b.score);
      seats[victim] = scored[0].i;
    } else {
      delete seats[victim];
    }
    lastDecap[victim] = curTurn;
    return nFlip;
  }

  function maybeDecapitate(zoneIdx, oldOwner, newOwner) {
    if (!P.decap || !oldOwner || oldOwner === newOwner) return;
    if (seats[oldOwner] !== zoneIdx) return;
    // Latence : un culte fraîchement brisé se relève avant de pouvoir l'être encore.
    if (curTurn - (lastDecap[oldOwner] ?? -1e9) < P.DECAP_COOLDOWN) return;
    /* SIÈGE EN DEUX TEMPS : il faut tenir le pays avant de briser le culte.
       Sans cette règle, la décapitation était un jet de dé qu'un joueur
       rationnel ne tentait jamais (0 décapitation par partie). */
    if (P.siege && countryShare(zones[zoneIdx].iso, newOwner) < P.SIEGE_SHARE) return;
    const n = decapitate(oldOwner, newOwner);
    decapLog.push({ turn: curTurn, victim: oldOwner, by: newOwner, flipped: n });
  }

  /* --------------------- Phase 1 : croissance logistique ---------------- */
  function growPhase() {
    refreshHubris();
    for (const z of zones) {
      if (!z.owner) continue;
      if (P.spread === 'player' && z.owner !== PLAYER) continue;   // mode extrême
      const cap = capOf(z);
      const pct = pctOf(z);
      if (pct >= cap) {
        /* REFLUX : au-dessus du plafond, la ferveur retombe. C'est ce qui rend
           la démesure et la pression frontalière réellement mordantes — un cœur
           d'empire trop étendu ou encerclé se ramollit au lieu de rester figé. */
        if (P.DECAY > 0 && pct > cap) {
          z.believers = Math.max(z.maxPop * cap, z.believers - (pct - cap) * z.maxPop * P.DECAY);
        }
        continue;
      }
      // Amorce : une zone à 0 % ne démarrerait jamais en logistique pure.
      const growth = P.GROWTH_RATE * capitalMult(z.iso, z.owner) * Math.max(pct, 0.05) * (1 - pct / cap);
      z.believers = Math.min(z.maxPop * cap, z.believers + growth * z.maxPop);
    }
  }

  /* ------------------------ Phase 2 : déversement ----------------------- */
  function spillPhase() {
    // Snapshot : tout le monde déverse depuis le même état, pour que l'ordre
    // d'itération ne change pas le résultat (pas de cascade dans un même tour).
    const snap = zones.map((z) => z.believers);
    /* Budget de clergé : on ne peut pas prêcher partout à la fois. Les zones les
       plus ferventes passent en premier (elles débordent le plus fort). */
    let budget = Infinity;
    if (P.CLERGY_BASE > 0) {
      budget = Math.max(1, Math.round(P.CLERGY_BASE + zonesOf(PLAYER) * P.CLERGY_PER_ZONE));
    }
    const order = P.CLERGY_BASE > 0
      ? [...zones].sort((a, b) => (snap[b.idx] / b.maxPop) - (snap[a.idx] / a.maxPop))
      : zones;
    for (const z of order) {
      if (!z.owner) continue;
      if (P.spread !== 'all' && z.owner !== PLAYER) continue;
      if (z.owner === PLAYER && budget <= 0) continue;
      const pct = snap[z.idx] / z.maxPop;
      if (pct <= P.SPILL_THRESHOLD) continue;

      // Cible : la voisine la plus faible — neutre en priorité, rivale sinon.
      let target = null, best = Infinity;
      for (const n of z.nb) {
        const t = zones[n];
        if (t.owner === z.owner) continue;
        if (t.owner && !canLosePassively(t.owner)) continue;   // dernière zone : intouchable
        const score = (t.owner ? 1000 : 0) + snap[n] / t.maxPop;
        if (score < best) { best = score; target = t; }
      }
      if (!target) continue;

      const spillCap = P.capitalGrowthOnly ? 1 : capitalMult(z.iso, z.owner);
      const surplus = (pct - P.SPILL_THRESHOLD) * z.maxPop * P.SPILL_EFF * spillCap;
      const sent = Math.max(0, Math.min(surplus, z.believers - z.maxPop * P.SPILL_FLOOR));
      if (sent <= 0) continue;
      z.believers -= sent;

      if (z.owner === PLAYER) budget--;   // ce prêcheur est occupé ce tour-ci

      if (!target.owner) {
        target.owner = z.owner;
        target.believers += sent;
      } else if (P.erosionFlip) {
        /* PRÉDICATION : la foi déversée ne détruit pas les croyants rivaux, elle
           les CONVERTIT. Sous le plancher, la zone bascule vers qui l'arrose. */
        const drained = Math.min(target.believers, sent * P.EROSION_MULT);
        target.believers -= drained;
        if (target.believers <= target.maxPop * P.SPILL_FLOOR) {
          const old = target.owner;
          target.owner = z.owner;
          target.believers += drained;
          maybeDecapitate(target.idx, old, z.owner);
        } else {
          z.believers += drained * 0.5;   // une part revient au prêcheur
        }
      } else {
        target.believers = Math.max(0, target.believers - sent * P.EROSION_MULT);
        if (target.believers <= 0) target.owner = null;
      }
    }
  }

  /* --------------------- Phase 3 : le match du joueur ------------------- */
  function playerTurn() {
    const access = accessibleCountries(PLAYER);
    const cands = [];
    for (const iso of access) {
      for (const i of byIso[iso]) {
        const z = zones[i];
        if (z.owner === PLAYER) continue;
        const touching = z.nb.some((n) => zones[n].owner === PLAYER);
        const beachhead = countryShare(iso, PLAYER) === 0;
        if (!touching && !beachhead) continue;
        cands.push(z);
      }
    }
    if (!cands.length) return;

    /* Stratégie : le neutre d'abord (aucune mise à risquer), et à la plus grosse
       population — le choix qu'un joueur rationnel fait. */
    const dir = P.strategy === 'small' ? -1 : 1;
    cands.sort((a, b) => {
      const an = a.owner ? 1 : 0, bn = b.owner ? 1 : 0;
      if (an !== bn) return an - bn;
      return (b.maxPop - a.maxPop) * dir;
    });

    /* Une capitale à portée est l'ouverture naturelle d'un pays : elle accélère
       la foi sur tout le territoire. Placée avant le siège pour que celui-ci
       reste prioritaire après l'insertion. */
    if (P.capitals) {
      const capSet = new Set(Object.values(capitalOf));
      const capT = cands.find((z) => capSet.has(z.idx) && z.owner !== PLAYER);
      if (capT) cands.unshift(capT);
    }

    /* Un siège ennemi à portée vaut tout le reste : c'est le coup qui brise un
       empire. Le joueur rationnel le prend dès qu'il peut. */
    if (P.decap) {
      const seatSet = new Set(Object.entries(seats).filter(([c]) => c !== PLAYER).map(([, i]) => i));
      /* Avec la règle du siège, viser un siège n'a de sens que si l'on tient
         déjà le pays — sinon la prise ne brise rien. */
      const st = cands.find((z) => seatSet.has(z.idx) && (!P.siege || countryShare(z.iso, PLAYER) >= P.SIEGE_SHARE));
      if (st) cands.unshift(st);
    }

    /* Choix rationnel : on estime les chances AVANT d'engager. Une cible rivale
       hors de portée est écartée au profit d'une terre barbare — on reviendra
       quand les provinces alentour auront mûri. C'est la différence entre un
       joueur et un modèle qui charge une forteresse les mains vides. */
    /* Provinces mobilisables contre une cible : voisines seules, ou tout le pays. */
    const mobilizable = (z) => (P.stakeScope === 'country'
      ? byIso[z.iso].map((i) => zones[i])
      : z.nb.map((n) => zones[n])).filter((s) => s.owner === PLAYER);
    const stakeFrom = (sources) => sources.reduce((sum, s) => sum + Math.max(0,
      Math.min(s.believers * P.STAKE_FRACTION, s.believers - s.maxPop * P.SPILL_FLOOR)), 0);

    const oddsAgainst = (z) => {
      if (!z.owner) return 1;
      const stake = stakeFrom(mobilizable(z));
      let defMult = 1;
      if (P.capitals && capitalOf[z.iso] === z.idx) defMult *= P.DEF_CAPITAL;
      if (P.decap && Object.values(seats).includes(z.idx)) defMult *= P.DEF_SEAT;
      const def = z.believers * defMult;
      return (stake * P.PLAYER_SKILL) / ((stake * P.PLAYER_SKILL) + def || 1);
    };
    const viable = cands.filter((z) => !z.owner || oddsAgainst(z) >= P.MIN_ODDS);
    if (viable.length) cands.length = 0, cands.push(...viable);

    const target = cands[0];

    if (!target.owner) {
      /* Terre barbare : aucune religion organisée en face. Le joueur l'emporte
         le plus souvent, mais pas toujours — d'où WIN_RATE en plafond. */
      const g = grade();
      if (rnd() < P.WIN_RATE) {
        target.owner = PLAYER;
        target.believers = Math.max(target.believers, target.maxPop * P.START_PCT[g]);
      }
      return;
    }

    // Zone rivale : on mise les croyants levés sur les provinces mobilisables.
    const sources = mobilizable(target);
    let stake = 0;
    for (const s of sources) {
      const give = Math.max(0, Math.min(s.believers * P.STAKE_FRACTION, s.believers - s.maxPop * P.SPILL_FLOOR));
      s.believers -= give;
      stake += give;
    }

    /* Rapport de force : la mise contre la défense, fortifiée si la zone est une
       capitale ou un siège. C'est ici que « on ne gagne pas à tous les tours »
       devient vrai — attaquer un siège saturé sans troupes est perdu d'avance. */
    let defMult = 1;
    if (P.capitals && capitalOf[target.iso] === target.idx) defMult *= P.DEF_CAPITAL;
    if (P.decap && Object.values(seats).includes(target.idx)) defMult *= P.DEF_SEAT;
    const defense = target.believers * defMult;
    const odds = (stake * P.PLAYER_SKILL) / ((stake * P.PLAYER_SKILL) + defense || 1);
    const pWin = Math.max(P.WIN_FLOOR, Math.min(P.WIN_RATE, odds));
    const won = rnd() < pWin;
    matchLog.push({ won, pWin, seat: P.decap && Object.values(seats).includes(target.idx) });
    /* Le rang suit la marge : on ne décroche un S qu'en écrasant l'adversaire.
       Le rang tiré au sort indépendamment du match était la seconde facilité. */
    const g = won
      ? (pWin > 0.75 ? 'S' : pWin > 0.55 ? 'A' : pWin > 0.35 ? 'B' : 'C')
      : grade();

    if (won) {
      const old = target.owner;
      target.owner = PLAYER;
      target.believers = stake + target.believers * P.ABSORB[g];
      maybeDecapitate(target.idx, old, PLAYER);
    } else {
      // La mise perdue grossit le défenseur ; le reste rentre au bercail.
      const lost = stake * P.LOSS[g];
      target.believers += lost;
      const back = (stake - lost) / (sources.length || 1);
      for (const s of sources) s.believers = Math.min(s.maxPop, s.believers + back);
    }
  }

  /* ------------------------- Phase 4 : les 9 IA ------------------------- */
  function aiTurn() {
    const dp = P.DIFF_SIM[P.difficulty] || P.DIFF_SIM.normal;
    let leaderColor = null, leaderB = -1;
    if (P.dogpile) {
      for (const c of ALL) { const b = believersOf(c); if (b > leaderB) { leaderB = b; leaderColor = c; } }
    }
    for (const color of AI_COLORS) {
      if (rnd() >= dp.act) continue;
      const cands = [];
      for (const iso of accessibleCountries(color)) {
        for (const i of byIso[iso]) {
          const z = zones[i];
          if (z.owner === color) continue;
          if (z.owner && rnd() >= dp.steal) continue;   // voler est plus rare
          if (z.owner && !canLosePassively(z.owner)) continue;   // dernière zone : intouchable
          const touching = z.nb.some((n) => zones[n].owner === color);
          const beachhead = countryShare(iso, color) === 0;
          if (!touching && !beachhead) continue;
          cands.push(z);
        }
      }
      if (!cands.length) continue;

      /* Les IA convoitent les capitales elles aussi : sans ça le joueur était
         seul à jouer l'objectif, et la mécanique lui offrait ~4× son territoire. */
      let target;
      const capSet = P.capitals ? new Set(Object.values(capitalOf)) : null;
      const capCands = capSet ? cands.filter((z) => capSet.has(z.idx)) : [];
      const onPlayer = cands.filter((z) => z.owner === PLAYER);
      if (capCands.length && rnd() < P.AI_CAPITAL_PREF) target = pick(capCands);
      else if (onPlayer.length && rnd() < dp.focus) target = pick(onPlayer);
      else if (P.dogpile) {
        const lead = cands.filter((z) => z.owner === leaderColor && z.owner !== color);
        target = lead.length && rnd() < 0.7 ? pick(lead) : pick(cands);
      } else target = pick(cands);

      if (!target.owner) {
        target.owner = color;
        target.believers = Math.max(target.believers, target.maxPop * 0.30);
        continue;
      }
      /* Combat abstrait pondéré par les croyants engagés de part et d'autre —
         cohérent avec la mise du joueur. */
      const attack = target.nb
        .filter((n) => zones[n].owner === color)
        .reduce((s, n) => s + zones[n].believers, 0) * P.STAKE_FRACTION;
      if (attack <= 0) continue;
      const defense = target.believers;
      if (rnd() < attack / (attack + defense)) {
        const old = target.owner;
        target.owner = color;
        target.believers = attack + defense * P.AI_ABSORB;
        maybeDecapitate(target.idx, old, color);
      } else {
        target.believers += attack * 0.5;
      }
    }
  }

  /* ------------------------------- Boucle ------------------------------- */
  /* Déclencheur alternatif : le siège tombe quand une AUTRE religion tient le
     fief qui l'abrite — sans exiger de gagner un match sur la zone du siège
     elle-même. Conquérir la terre sainte EST la décapitation. */
  function autoSiegeCheck() {
    for (const victim of ALL) {
      const seat = seats[victim];
      if (seat === undefined) continue;
      if (curTurn - (lastDecap[victim] ?? -1e9) < P.DECAP_COOLDOWN) continue;
      const iso = zones[seat].iso;
      for (const conq of ALL) {
        if (conq === victim) continue;
        if (countryShare(iso, conq) < P.SIEGE_SHARE) continue;
        const n = decapitate(victim, conq);
        decapLog.push({ turn: curTurn, victim, by: conq, flipped: n });
        break;
      }
    }
  }

  const worldPopTotal = zones.reduce((s, z) => s + z.maxPop, 0) || 1;
  const log = [];
  for (let turn = 1; turn <= P.turns; turn++) {
    curTurn = turn;
    growPhase();
    spillPhase();
    playerTurn();
    aiTurn();
    if (P.siegeAuto) autoSiegeCheck();

    const pb = believersOf(PLAYER);
    const aiB = AI_COLORS.map(believersOf);
    const allB = pb + aiB.reduce((a, b) => a + b, 0);
    let pSat = 0, pn = 0, aSat = 0, an = 0;
    for (const z of zones) {
      if (z.owner === PLAYER) { pSat += pctOf(z); pn++; }
      else if (z.owner) { aSat += pctOf(z); an++; }
    }
    log.push({
      turn,
      pz: zonesOf(PLAYER), pb,
      pShare: allB > 0 ? pb / allB : 0,          // part des âmes DÉJÀ converties
      /* Part de l'HUMANITÉ ENTIÈRE — c'est la métrique du jeu
         (getFaithGoalState : believers / totalEarthPop). Les deux divergent
         énormément en début de partie, où presque personne n'est converti. */
      pWorld: pb / worldPopTotal,
      rank: 1 + aiB.filter((b) => b > pb).length,
      topAI: Math.max(...aiB),
      avgAI: aiB.reduce((a, b) => a + b, 0) / aiB.length,
      pSat: pn ? pSat / pn : 0,
      aSat: an ? aSat / an : 0,
      neutral: zones.filter((z) => !z.owner).length,
    });
  }

  const parity = log.find((r) => r.pb >= r.topAI);
  return {
    log, decapLog, matchLog, zones, byIso, seats,
    last: log[log.length - 1],
    parityTurn: parity ? parity.turn : null,
    worldPop: zones.reduce((s, z) => s + z.maxPop, 0),
    totalZones: zones.length,
  };
}

/* ------------------------------ Rapport -------------------------------- */
const fmt = (n) => {
  if (n >= 1e9) return (n / 1e9).toFixed(2) + ' Md';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + ' M';
  if (n >= 1e3) return (n / 1e3).toFixed(0) + ' k';
  return n.toFixed(0);
};
const pc = (x) => (x * 100).toFixed(1) + ' %';
const median = (a) => {
  if (!a.length) return NaN;
  const b = [...a].sort((x, y) => x - y);
  const m = b.length >> 1;
  return b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2;
};

console.log(`\n=== SIMULATEUR D'ÉQUILIBRAGE — CAMPAGNE ===`);
console.log(`Monde : ${WORLD.length} pays · ${WORLD.reduce((s, c) => s + c.zoneCount, 0)} zones`);
console.log(`Réglages : diff=${P.difficulty} · propagation=${P.spread} · taux=${P.GROWTH_RATE} · seuil=${P.SPILL_THRESHOLD}` +
  ` · prédication=${P.erosionFlip ? P.EROSION_MULT : 'non'} · décapitation=${P.decap ? P.DECAP_SHARE : 'non'}`);

if (P.runs > 1) {
  /* -------- Mode médianes : la seule façon de conclure quoi que ce soit ---- */
  const res = [];
  for (let i = 0; i < P.runs; i++) res.push(runOnce(P.seed + i * 7919));
  const shares = res.map((r) => r.last.pShare);
  const ranks = res.map((r) => r.last.rank);
  const wins = res.filter((r) => r.last.rank === 1).length;
  const parities = res.filter((r) => r.parityTurn).map((r) => r.parityTurn);
  const decaps = res.map((r) => r.decapLog.filter((d) => d.by === PLAYER).length);

  console.log(`\n--- MÉDIANES SUR ${P.runs} PARTIES DE ${P.turns} TOURS ---`);
  console.log(`  Part de foi finale   : médiane ${pc(median(shares))}   (min ${pc(Math.min(...shares))} · max ${pc(Math.max(...shares))})`);
  console.log(`  Rang final           : médiane ${median(ranks)}ᵉ / 10`);
  console.log(`  Parties gagnées (1ᵉʳ): ${wins} / ${P.runs}  (${pc(wins / P.runs)})`);
  console.log(`  Dépasse le leader    : ${parities.length}/${P.runs} parties` +
    (parities.length ? `, médiane au tour ${median(parities)}` : ''));
  console.log(`  Décapitations joueur : médiane ${median(decaps)}`);
  /* Une part de foi à 0,0 % peut n'être qu'un arrondi : on distingue explicitement
     le joueur laminé (encore vivant, mais minuscule) du joueur éliminé. */
  const zs = res.map((r) => r.last.pz);
  const wiped = res.filter((r) => r.last.pz === 0).length;
  console.log(`  Zones finales        : médiane ${median(zs)} (min ${Math.min(...zs)} · max ${Math.max(...zs)})`);
  console.log(`  Parties où le joueur est ÉLIMINÉ : ${wiped} / ${P.runs}`);

  /* « On ne gagne pas une zone à tous les tours » : on le vérifie au lieu de le
     supposer. Un tour productif = un tour où le joueur a gagné une zone. */
  const mAll = res.flatMap((r) => r.matchLog);
  const mWon = mAll.filter((m) => m.won).length;
  const seatTries = mAll.filter((m) => m.seat);
  const seatWon = seatTries.filter((m) => m.won).length;
  const prod = res.map((r) => r.last.pz / P.turns);
  console.log(`  Matchs contre rivaux : ${mAll.length} · gagnés ${mAll.length ? pc(mWon / mAll.length) : '—'}`);
  console.log(`  Assauts sur un siège : ${seatTries.length} · réussis ${seatTries.length ? pc(seatWon / seatTries.length) : '—'}`);
  console.log(`  Zones gagnées par tour (toutes sources) : médiane ${median(prod).toFixed(2)}`);

  /* CONDITION DE VICTOIRE réelle du jeu : rallier P.GOAL % de l'humanité.
     C'est cette ligne qui valide la constante WORLD_FAITH_GOAL, pas le rang. */
  const goalHit = res.filter((r) => r.last.pWorld * 100 >= P.GOAL).length;
  const firstGoal = res.map((r) => {
    const t = r.log.find((x) => x.pWorld * 100 >= P.GOAL);
    return t ? t.turn : null;
  }).filter(Boolean);
  const wp = res.map((r) => r.last.pWorld * 100);
  console.log(`  Part de l'HUMANITÉ ralliée : médiane ${median(wp).toFixed(1)} % (max ${Math.max(...wp).toFixed(1)} %)`);
  console.log(`  OBJECTIF ${P.GOAL} % de l'humanité : atteint dans ${goalHit}/${P.runs} parties (${pc(goalHit / P.runs)})` +
    (firstGoal.length ? `, médiane au tour ${median(firstGoal)}` : ''));
  /* Durée réelle de campagne : 1 tour = 1 match. C'est LA contrainte d'un jeu
     mobile, et elle prime sur toute élégance de courbe. */
  const MIN_PER_MATCH = num('minpermatch', 4);
  for (const mark of [30, 60, 100, 150]) {
    const at = res.map((r) => (r.log[Math.min(mark, r.log.length) - 1]?.pWorld || 0) * 100);
    console.log(`    au tour ${String(mark).padStart(3)} (~${String(Math.round(mark * MIN_PER_MATCH / 60)).padStart(2)} h de jeu) : ${median(at).toFixed(1)} % de l'humanité`);
  }
  console.log('');
} else {
  /* ---------------- Mode détaillé : une partie, tout le récit -------------- */
  const R = runOnce(P.seed);
  const { log, decapLog, zones, byIso, last, totalZones, worldPop } = R;

  console.log(`\n tour | rang | zones J | croyants J |  part J | satur. J | IA méd. | satur. IA | neutres`);
  console.log(`------+------+---------+------------+---------+----------+---------+-----------+--------`);
  const step = Math.max(1, Math.round(P.turns / 20));
  for (const r of log) {
    if (r.turn % step && r.turn !== P.turns) continue;
    console.log(
      ` ${String(r.turn).padStart(4)} | ${String(r.rank).padStart(4)} | ${String(r.pz).padStart(7)} | ${fmt(r.pb).padStart(10)} | ` +
      `${pc(r.pShare).padStart(7)} | ${pc(r.pSat).padStart(8)} | ${fmt(r.avgAI).padStart(7)} | ${pc(r.aSat).padStart(9)} | ${String(r.neutral).padStart(7)}`
    );
  }

  const H = 14, Wc = 76;
  const grid = Array.from({ length: H }, () => new Array(Wc).fill(' '));
  const maxShare = Math.max(0.3, ...log.map((r) => r.pShare));
  for (let x = 0; x < Wc; x++) {
    const r = log[Math.min(log.length - 1, Math.round((x / (Wc - 1)) * (log.length - 1)))];
    grid[H - 1 - Math.round((r.pShare / maxShare) * (H - 1))][x] = '█';
  }
  console.log(`\nPart de foi du joueur — 0 → ${pc(maxShare)} sur ${P.turns} tours`);
  for (const row of grid) console.log('  ' + row.join(''));
  console.log('  ' + '─'.repeat(Wc));

  console.log(`\n--- BILAN ---`);
  console.log(`Rang final : ${last.rank}ᵉ / 10 · part de foi ${pc(last.pShare)} · zones ${last.pz}/${totalZones}`);
  console.log(`Croyants joueur ${fmt(last.pb)} · IA médiane ${fmt(last.avgAI)} · meilleure IA ${fmt(last.topAI)}`);
  console.log(R.parityTurn ? `Dépasse la meilleure IA au tour ${R.parityTurn}.` : `⚠ Ne dépasse JAMAIS la meilleure IA.`);

  if (P.decap && decapLog.length) {
    console.log(`\n--- DÉCAPITATIONS (${decapLog.length}, dont ${decapLog.filter((d) => d.by === PLAYER).length} par le joueur) ---`);
    for (const d of decapLog.slice(0, 12)) {
      console.log(`  tour ${String(d.turn).padStart(3)} · ${d.by === PLAYER ? 'LE JOUEUR' : d.by} brise ${d.victim} → ${d.flipped} zones basculent`);
    }
  }

  /* Diagnostic des fiefs : à quel point les terres saintes sont-elles pénétrées ?
     C'est ce qui décide si la décapitation est atteignable ou décorative. */
  console.log(`\n--- LES 10 TERRES SAINTES (fief de chaque siège) ---`);
  for (const color of ['P', ...AI_COLORS]) {
    const seat = R.seats[color];
    if (seat === undefined) { console.log(`  ${color.padEnd(3)} : culte dissous`); continue; }
    const iso = R.zones[seat].iso;
    const ids = R.byIso[iso];
    const owners = {};
    for (const i of ids) { const k = R.zones[i].owner || 'neutre'; owners[k] = (owners[k] || 0) + 1; }
    const own = ((owners[color] || 0) / ids.length);
    const foreign = Object.entries(owners)
      .filter(([k]) => k !== color && k !== 'neutre')
      .sort((a, b) => b[1] - a[1])[0];
    console.log(`  ${color.padEnd(3)} : ${iso} · tenu à ${pc(own)} par lui-même` +
      ` · meilleur envahisseur ${foreign ? `${foreign[0]} ${pc(foreign[1] / ids.length)}` : 'aucun'}` +
      `${color === PLAYER ? '   ← vous' : ''}`);
  }

  /* La population mondiale est hyper-concentrée : si une religion rafle l'Asie,
     le reste de la carte ne pèse plus rien. */
  const big = [...WORLD].sort((a, b) => b.pop - a.pop).slice(0, 8);
  console.log(`\n--- LES 8 PAYS QUI DÉCIDENT DE LA PARTIE ---`);
  let cum = 0;
  for (const c of big) {
    cum += c.pop;
    const owners = {};
    for (const i of byIso[c.iso]) { const k = zones[i].owner || 'neutre'; owners[k] = (owners[k] || 0) + 1; }
    const top = Object.entries(owners).sort((a, b) => b[1] - a[1])[0];
    console.log(`  ${c.iso}  ${fmt(c.pop).padStart(8)} hab · dominé par ${String(top[0]).padEnd(6)} (${top[1]}) · joueur : ${owners[PLAYER] || 0}`);
  }
  console.log(`  → ces 8 pays = ${pc(cum / worldPop)} de l'humanité.`);
  console.log('');
}
