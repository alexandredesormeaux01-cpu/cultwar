/* -- L'escorte d'âmes (GDD §10.5) --

   Les âmes portées ne sont plus seulement quatre pastilles en haut de l'écran :
   elles trottent derrière le joueur, une par type possédé, et ne se voient que
   dans le monde des esprits.

   POURQUOI ELLES NE TRAHISSENT RIEN

     La règle 1 du portage dit que personne ne sait combien tu portes : l'aura
     annonce « il a quelque chose », jamais quoi ni combien. L'escorte ne la
     casse pas, et c'est délibéré — elle n'existe QUE dans le monde des esprits,
     où l'on est déjà visible autrement, et le rival resté en chair ne voit
     toujours rien. L'information cachée survit intacte ; le joueur, lui, lit
     son inventaire sans quitter le décor des yeux.

   POURQUOI DES BONDS, ET PAS UN GLISSEMENT

     Une escorte qui suit en glissant à distance fixe ressemble à un curseur
     accroché au joueur : l'œil la range aussitôt dans l'interface et cesse de
     la voir. Ce qui la rend vivante, c'est qu'elle est en RETARD et qu'elle le
     rattrape — elle bondit, dépasse, gambade de côté, se repose quand on
     s'arrête. Chaque bond est une parabole, avec l'écrasement à l'atterrissage
     et l'étirement en l'air qui font toute la lisibilité du saut.

     La longueur du bond suit la distance à rattraper : petits sautillements sur
     place quand on flâne, longues foulées quand on court. Sans ça, l'escorte
     décroche dès qu'on presse le pas, ou trépigne quand on s'arrête.

   Elles suivent DERRIÈRE. Le cap se déduit du déplacement du joueur (voir
   _heading) plutôt que d'être demandé à l'appelant : c'est la seule information
   dont ce module a besoin et qui ne soit pas déjà dans l'inventaire. */

import * as THREE from 'three';

import { SOULS } from './pillars.js';
import { bagOf } from './souls.js';

/* L'escorte n'existe que pour le joueur local : elle montre CE QU'ON PORTE, et
   ce que portent les rivaux est l'information cachée du jeu. Elle lit donc le
   sac 0 en dur, et c'est volontaire. */
import { createFlame, TUNE_FLAME } from './flame.js';

export const TUNE_ESCORT = {
  size: 0.62,        // hauteur de l'âme, une fois mise à l'échelle
  trailR: 1.9,       // distance de repos derrière le joueur
  spread: 1.05,      // écartement latéral entre deux âmes de l'escorte
  /* Les couloirs latéraux ne suffisent pas à les tenir séparées : la gambade
     les fait dériver l'une vers l'autre et, faute de rien qui les repousse,
     elles finissent empilées — quatre âmes portées se lisent alors comme une
     seule, et la fonctionnalité ne dit plus ce qu'elle est censée dire. */
  apart: 1.0,        // distance en deçà de laquelle deux âmes se repoussent
  apartPush: 1.3,    // force du dégagement appliquée à la visée
  /* 8 u/s, et non 2 : le décollement doit être plus rapide que la vitesse à
     laquelle deux âmes se croisent (elles bondissent jusqu'à ~15 u/s), sinon
     elles restent superposées le temps de plusieurs images. Ça ne se voit pas
     pour autant — le dégagement reste proportionnel au recouvrement, donc il
     s'éteint tout seul dès qu'elles se sont écartées. */
  unstick: 8.0,      // vitesse max du décollement positionnel (filet, voir separate)
  hopMin: 0.55,      // longueur minimale d'un bond (le sautillement sur place)
  hopMax: 4.5,       // longueur maximale (la foulée de rattrapage)
  /* L'allure du bond n'est pas constante, elle suit le RETARD. Un plafond fixe
     ne peut pas marcher : en esprit le joueur file à V_MAX × speedMul ≈ 12,7
     u/s, jusqu'à ~15 en nomade et bien plus sous boost, et une escorte plus
     lente que lui décroche pour de bon — la fonctionnalité disparaît de
     l'écran. Élastique, elle se stabilise d'elle-même à la distance où son
     allure égale celle du joueur, quelle que soit cette allure. */
  hopSpeedMin: 5.0,  // allure quand elle est à sa place (la flânerie)
  chase: 3.0,        // gain d'allure par unité de retard
  hopSpeedMax: 26.0, // plafond, pour que le rattrapage reste lisible
  hopRise: 0.30,     // hauteur du bond, proportionnelle à sa longueur
  restMax: 0.34,     // pause entre deux bonds quand on est à sa place
  gambade: 0.45,     // part d'écart latéral aléatoire dans la visée d'un bond
  teleportAt: 22,    // au-delà, on la remet près du joueur au lieu de la traîner
};

const escort = [];        // une entrée par type d'âme, créée à la demande
let _scene = null;

/* Cap du joueur, déduit de son déplacement. Conservé quand il s'arrête : sinon
   l'escorte pivoterait au hasard autour de lui dès qu'il lâche les commandes. */
const _heading = { x: 0, z: 1 };
const _prev = { x: 0, z: 0, has: false };

function makeCompanion(i) {
  const soul = SOULS[i];
  const grp = new THREE.Group();

  /* La même flamme que les piliers : c'est littéralement la flamme du pilier
     qui est entrée dans le joueur, elle doit se reconnaître. Plus vive et plus
     nerveuse ici — c'est une petite chose vivante, pas un feu de veille. */
  const flame = createFlame({
    color: soul.col,
    size: TUNE_ESCORT.size,
    speed: 1.6,
    flicker: 1.35,
  });
  grp.add(flame);

  return {
    grp,
    fx: flame.userData.flame,
    body: flame,
    x: 0, z: 0, y: 0,
    hopY: 0,          // hauteur au-dessus du sol pendant le bond
    air: false,
    t: 0, dur: 0.3, rise: 0.4,
    fromX: 0, fromZ: 0, toX: 0, toZ: 0,
    rest: Math.random() * TUNE_ESCORT.restMax,
    squash: 0,        // 1 juste après l'atterrissage, retombe à 0
    placed: false,
  };
}

/** Point que l'âme `slot` cherche à occuper : en file derrière le joueur,
 *  puis dégagé des autres âmes de l'escorte. */
function targetOf(slot, count, s, self, others) {
  /* Perpendiculaire au cap, pour étaler l'escorte de front plutôt qu'en colonne
     — en colonne, celles de derrière disparaissent derrière celles de devant. */
  const px = -_heading.z, pz = _heading.x;
  const lane = (slot - (count - 1) / 2) * TUNE_ESCORT.spread;
  const t = {
    x: s.px - _heading.x * TUNE_ESCORT.trailR + px * lane,
    z: s.pz - _heading.z * TUNE_ESCORT.trailR + pz * lane,
  };

  /* Dégagement mutuel. Appliqué à la VISÉE et non à la position : l'âme s'en
     écarte en bondissant, comme elle ferait le reste, au lieu d'être poussée
     de côté par une correction qui se verrait comme un glissement. */
  for (const o of others) {
    if (o === self) continue;
    const dx = self.x - o.x, dz = self.z - o.z;
    const d = Math.hypot(dx, dz);
    if (d > TUNE_ESCORT.apart) continue;
    /* Deux âmes exactement au même point n'ont pas de direction de fuite : on
       leur en invente une, sans quoi elles resteraient collées à jamais. */
    const a = d > 1e-3 ? Math.atan2(dz, dx) : Math.random() * Math.PI * 2;
    const k = (TUNE_ESCORT.apart - d) * TUNE_ESCORT.apartPush;
    t.x += Math.cos(a) * k;
    t.z += Math.sin(a) * k;
  }
  return t;
}

function startHop(c, tx, tz) {
  const dx = tx - c.x, dz = tz - c.z;
  const d = Math.hypot(dx, dz);

  /* Longueur du bond : proportionnelle à ce qu'il reste à rattraper, bornée aux
     deux bouts. La borne basse est ce qui fait le sautillement sur place — sans
     elle, une âme arrivée à destination s'immobiliserait complètement. */
  const step = Math.min(TUNE_ESCORT.hopMax,
                        Math.max(TUNE_ESCORT.hopMin, d * 0.6));

  let ux = d > 1e-4 ? dx / d : _heading.x;
  let uz = d > 1e-4 ? dz / d : _heading.z;

  /* La gambade : on vise à côté du but, pas dessus. L'écart est perpendiculaire
     à la course et change de signe d'un bond à l'autre, ce qui donne le
     chaloupement — viser juste donnerait une bille aimantée. */
  const g = (Math.random() - 0.5) * 2 * TUNE_ESCORT.gambade;
  const nx = -uz * g, nz = ux * g;
  ux += nx; uz += nz;
  const n = Math.max(1e-4, Math.hypot(ux, uz));
  ux /= n; uz /= n;

  c.fromX = c.x; c.fromZ = c.z;
  c.toX = c.x + ux * step;
  c.toZ = c.z + uz * step;
  const speed = Math.min(TUNE_ESCORT.hopSpeedMax,
                         TUNE_ESCORT.hopSpeedMin + d * TUNE_ESCORT.chase);
  c.rise = 0.22 + step * TUNE_ESCORT.hopRise;
  c.dur = Math.max(0.14, step / speed);
  c.t = 0;
  c.air = true;
}

/* Filet contre le recouvrement. La répulsion de targetOf() ne suffit pas : elle
   n'agit que sur la VISÉE d'un bond, or une âme déjà en l'air suit une parabole
   figée et ne peut pas répondre — deux trajectoires qui se croisent se traversent
   donc. Ici on écarte les positions elles-mêmes, mais lentement (unstick) et
   seulement en cas de recouvrement franc, ce qui reste invisible à l'œil.

   Le bond en cours est décalé avec la position : sans ça la correction serait
   effacée dès l'image suivante, la position en vol étant recalculée depuis
   from/to. C'est le genre de détail qui ferait vibrer les âmes sur place. */
function separate(live, dt) {
  const R = TUNE_ESCORT.apart * 0.75;
  for (let a = 0; a < live.length; a++) {
    for (let b = a + 1; b < live.length; b++) {
      const A = live[a], B = live[b];
      let dx = B.x - A.x, dz = B.z - A.z;
      let d = Math.hypot(dx, dz);
      if (d >= R) continue;
      if (d < 1e-4) {
        /* Superposition exacte : aucune direction de fuite ne se déduit, on en
           tire une au sort plutôt que de diviser par zéro. */
        const ang = Math.random() * Math.PI * 2;
        dx = Math.cos(ang); dz = Math.sin(ang); d = 1;
      }
      const ux = dx / d, uz = dz / d;
      const push = Math.min((R - d) * 0.5, TUNE_ESCORT.unstick * dt);
      A.x -= ux * push; A.z -= uz * push;
      B.x += ux * push; B.z += uz * push;
      A.fromX -= ux * push; A.toX -= ux * push;
      A.fromZ -= uz * push; A.toZ -= uz * push;
      B.fromX += ux * push; B.toX += ux * push;
      B.fromZ += uz * push; B.toZ += uz * push;
    }
  }
}

/**
 * Fait vivre l'escorte. Les âmes portées sont lues directement dans
 * l'inventaire : l'appelant n'a que l'état du joueur à fournir.
 *
 * @param {number} dt
 * @param {{scene:THREE.Scene, px:number, pz:number, py:number,
 *          spiritBlend:number, groundY:(x:number,z:number)=>number}} s
 */
export function updateSoulEscort(dt, s) {
  _scene = s.scene;

  /* -- Cap -- */
  if (_prev.has) {
    const dx = s.px - _prev.x, dz = s.pz - _prev.z;
    const d = Math.hypot(dx, dz);
    /* Seuil : sous quelques millimètres par image, ce n'est plus un
       déplacement mais du bruit, et le cap se mettrait à tourner sur place. */
    if (d > 1e-3) {
      const k = Math.min(1, dt * 6);
      _heading.x += (dx / d - _heading.x) * k;
      _heading.z += (dz / d - _heading.z) * k;
      const n = Math.max(1e-4, Math.hypot(_heading.x, _heading.z));
      _heading.x /= n; _heading.z /= n;
    }
  }
  _prev.x = s.px; _prev.z = s.pz; _prev.has = true;

  /* -- Qui est de la partie -- */
  const heldIdx = [];
  const bag = bagOf(0);
  for (let i = 0; i < SOULS.length; i++) if (bag.held[i]) heldIdx.push(i);

  for (let i = 0; i < SOULS.length; i++) {
    const carried = !!bag.held[i];
    if (!carried) {
      /* Plus portée : on la retire. Pas de fondu — l'âme est partie au moment
         exact où elle a été posée ou perdue, et la voir s'attarder ferait
         douter de ce que l'on porte encore. */
      if (escort[i]) { escort[i].grp.parent?.remove(escort[i].grp); escort[i] = null; }
      continue;
    }
    if (!escort[i]) {
      escort[i] = makeCompanion(i);
      s.scene.add(escort[i].grp);
    }
  }

  const vis = s.spiritBlend;
  const live = heldIdx.map((i) => escort[i]).filter(Boolean);
  separate(live, dt);
  for (let slot = 0; slot < heldIdx.length; slot++) {
    const c = escort[heldIdx[slot]];
    if (!c) continue;
    const tgt = targetOf(slot, heldIdx.length, s, c, live);

    /* Première image, ou âme distancée par un déplacement que ses bonds ne
       peuvent pas rattraper (téléportation, remontée d'un pilier, réapparition
       après la mort) : on la repose près du joueur. Une âme qui traverse la
       carte au petit galop pour rejoindre son porteur est plus déroutante
       qu'amusante. */
    const far = Math.hypot(c.x - s.px, c.z - s.pz);
    if (!c.placed || far > TUNE_ESCORT.teleportAt) {
      c.x = tgt.x; c.z = tgt.z; c.air = false; c.hopY = 0;
      c.rest = Math.random() * TUNE_ESCORT.restMax;
      c.placed = true;
    }

    /* -- Bond -- */
    if (c.air) {
      c.t += dt;
      const k = Math.min(1, c.t / c.dur);
      c.x = c.fromX + (c.toX - c.fromX) * k;
      c.z = c.fromZ + (c.toZ - c.fromZ) * k;
      c.hopY = 4 * c.rise * k * (1 - k);        // parabole, nulle aux deux bouts
      if (k >= 1) {
        c.air = false;
        c.hopY = 0;
        c.squash = 1;
        /* On souffle d'autant moins qu'on est loin de sa place : c'est ce qui
           permet de rattraper un joueur qui court, sans trépigner à l'arrêt. */
        const d = Math.hypot(tgt.x - c.x, tgt.z - c.z);
        c.rest = TUNE_ESCORT.restMax * Math.max(0.05, 1 - d / 4);
      }
    } else {
      c.rest -= dt;
      if (c.rest <= 0) startHop(c, tgt.x, tgt.z);
    }

    c.squash = Math.max(0, c.squash - dt * 6);

    /* -- Rendu -- */
    const ground = s.groundY ? (s.groundY(c.x, c.z) || 0) : 0;
    c.grp.position.set(c.x, ground + c.hopY, c.z);

    /* Écrasement/étirement. L'écrasement à l'atterrissage donne le poids, et
       l'étirement en l'air suit la VITESSE VERTICALE (donc 1 - 2k, positif en
       montée, négatif en descente) : c'est ce changement de signe au sommet du
       bond qui fait lire une chose vivante plutôt qu'un objet lancé. */
    const kAir = c.air ? Math.min(1, c.t / c.dur) : 0;
    const stretch = c.air ? Math.abs(1 - 2 * kAir) * 0.22 : 0;
    c.grp.scale.set(
      1 - stretch * 0.5 + c.squash * 0.28,
      1 + stretch - c.squash * 0.34,
      1 - stretch * 0.5 + c.squash * 0.28,
    );

    /* Elle regarde où elle va : une flamme qui bondit de côté sans s'orienter
       a l'air poussée, pas volontaire. */
    if (c.air) {
      const dx = c.toX - c.fromX, dz = c.toZ - c.fromZ;
      if (Math.hypot(dx, dz) > 1e-4) c.grp.rotation.y = Math.atan2(dx, dz);
    }

    /* Comme les piliers, l'escorte n'appartient qu'au monde des esprits : son
       opacité suit la transition de forme, elle ne s'allume pas d'un coup. */
    const shown = vis > 0.01;
    c.grp.visible = shown;
    if (shown) c.fx.setOpacity(TUNE_FLAME.opacity * vis);
  }
}

/** Retire toute l'escorte (mort, retour au salon, changement de partie). */
export function clearSoulEscort(scene) {
  for (let i = 0; i < escort.length; i++) {
    if (!escort[i]) continue;
    (scene || _scene)?.remove(escort[i].grp);
    escort[i] = null;
  }
  _prev.has = false;
}

/** Pour les tests : l'escorte réellement en scène. */
export function getSoulEscort() { return escort.filter(Boolean); }

/** Où se trouve l'âme du type `i`, ou null si elle n'est pas de l'escorte.
 *  Sert à la mort : une âme doit éclater LÀ OÙ ELLE ÉTAIT, pas dans le corps du
 *  porteur. Une gerbe unique au centre dirait « le joueur a explosé » ; quatre
 *  gerbes dispersées disent « ce qu'il portait s'échappe », ce qui est ce qui
 *  vient réellement de se produire. */
export function soulPosition(i) {
  const c = escort[i];
  return c ? { x: c.x, y: c.grp.position.y, z: c.z } : null;
}
