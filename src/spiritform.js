/* -- La Chair et l'Esprit (GDD §10.2) --

   Étape 1 de la refonte V3, et son test décisif : le joueur bascule librement
   entre son corps et sa forme d'esprit. Si cet aller-retour n'est pas agréable
   à faire cinquante fois par partie, rien du reste ne sauvera le jeu.

   Le module est volontairement autonome : il ne connaît de main.js que ce que
   `ctx` lui passe. Il ne touche ni à la simulation, ni au réseau, ni au score —
   il pose un état, un chrono, et l'ambiance qui va avec.

   Règle : 10 secondes d'esprit maximum, puis 5 secondes avant de pouvoir y
   retourner. Pas d'économie cachée, pas de ressource à gérer — un chrono que
   tout le monde lit du premier coup d'œil.

   Le déplacement est IDENTIQUE dans les deux formes : marche, course et boost
   fonctionnent en esprit exactement comme en chair. La forme change ce qu'on
   peut faire, jamais la façon de se déplacer. */

import * as THREE from 'three';

/* -- Réglages --
   Regroupés ici : le seul endroit à toucher pendant le playtest. */
export const TUNE_SPIRIT = {
  duration: 10,     // secondes d'esprit par passage
  cooldown: 5,      // délai avant de pouvoir y revenir
  speedMul: 1.38,   // l'esprit est vif ; c'est sa raison d'être
  fadeIn: 0.22,     // durée de la transition visuelle (s)
  warnAt: 3,        // sous ce reste, le chrono s'alarme
};

/* -- Ambiance du monde des esprits --
   Le monde matériel ne disparaît pas, il s'efface. Six leviers tirés ensemble,
   parce qu'aucun ne suffit seul : le premier essai ne changeait que la brume et
   ça ne se sentait pas.

   1. désaturation quasi totale de l'image (le levier le plus fort)
   2. exposition baissée
   3. brume avalée, très proche, bleu profond
   4. soleil éteint et froid, hémisphérique violette
   5. vignette sombre plein écran
   6. respiration lente de l'ensemble */
const SPIRIT_FOG = new THREE.Color(0x161f45);
const SPIRIT_BG = new THREE.Color(0x070b1c);
/* ---- Distances de brume ----
   Elles valaient 3 et 46, et c'est de là que venait l'aspect « overlay opaque
   plaqué sur la carte ». À 3 unités, tout ce qui est au-delà des pieds du
   personnage est déjà presque entièrement remplacé par la couleur de brume :
   le relief, les reliefs lointains, les différences de matière disparaissent
   d'un coup et il ne reste qu'un aplat bleu uniforme. Ce n'est plus de la
   brume, c'est un calque de peinture.

   Une brume doit être un DÉGRADÉ, pas un mur. En reculant le début à 14 et la
   fin à 90, le décor proche garde sa matière, le moyen plan s'estompe, le
   lointain se ferme — et c'est cette progression qui fait un lieu au lieu
   d'une surface. */
const SPIRIT_FOG_NEAR = 14;
const SPIRIT_FOG_FAR = 90;
const SPIRIT_SUN = new THREE.Color(0x7f9fd8);
const SPIRIT_HEMI_SKY = new THREE.Color(0x6d7fd0);
const SPIRIT_HEMI_GND = new THREE.Color(0x1b1f45);
/* Étalonnage cible de l'image en esprit. Interpolé depuis « neutre » selon le
   fondu, et écrit sur le canvas — un filtre CSS coûte zéro frame là où un
   post-process coûterait une passe entière sur mobile. */
/* PLUS DE FILTRE CSS SUR LE CANVAS.
   Il donnait la meilleure désaturation, mais il s'applique à toute l'image —
   il n'existe aucun moyen d'en exempter un objet. Or les esprits doivent
   s'afficher comme en plein jour, sans rien subir du monde des esprits.

   Toute l'ambiance passe donc par la 3D, dont chaque canal peut être désactivé
   par matériau : brume (`fog:false`), exposition (`toneMapped:false`) et
   éclairage (émissif). Le monde s'éteint, les esprits ne bougent pas d'un ton.

   La désaturation est reprise par la brume : très proche et bleu nuit, elle
   ramène tout le décor vers une teinte unique — c'est le même résultat à
   l'œil, mais sélectif. */
/* ---- Cibles ABSOLUES, et non plus des facteurs ----
   L'ambiance esprit s'écrivait en facteurs appliqués à l'état courant :
   `exposition × 0.46`, `soleil × 0.07`, `hémisphérique × 0.20`. Tant que la
   vallée se jouait en plein jour, cela partait toujours du même point et le
   résultat était stable. Depuis que toutes les cartes se jouent à la brunante,
   le point de départ est déjà bas — et les facteurs s'appliquent PAR-DESSUS.
   Le monde des esprits s'est donc effondré au noir, chaque assombrissement se
   multipliant à l'autre.

   Ce sont maintenant des valeurs de destination, atteintes par interpolation
   selon le fondu. La conséquence dépasse la correction du bug : le monde des
   esprits ne dépend plus de l'heure de la vallée. C'est le comportement juste —
   c'est un AUTRE lieu, il n'a aucune raison d'hériter du couchant du monde des
   vivants, et il aura la même tenue si l'heure de la vallée change encore.

   Les valeurs reproduisent ce que les anciens facteurs donnaient depuis le
   plein jour, qui était l'ambiance validée. */
/* Ces trois-là étaient calées pour un décor de toute façon noyé par la brume à
   3 unités : autant les mettre très bas, rien n'était visible. Maintenant que
   la brume laisse voir le décor, elles décident de ce qu'on en lit — trop
   basses, le terrain redevient une silhouette noire découpée sur un aplat, ce
   qui est l'autre moitié de l'effet « calque plaqué ». Il faut assez de lumière
   pour que le relief ait une FORME. */
const SPIRIT_EXPOSURE = 0.45;   // exposition absolue en esprit
const SPIRIT_SUN_I = 0.22;      // intensité absolue du soleil
const SPIRIT_HEMI_I = 0.16;     // intensité absolue de l'hémisphérique
/* L'éclairage par image est la principale source d'ambiant depuis le passage au
   PBR, et l'ambiance esprit ne le connaissait pas : le décor gardait la lumière
   colorée du ciel de la vallée pendant que tout le reste virait au violet. Il
   doit descendre avec les autres, sans tomber à zéro — c'est lui qui garde un
   reste de modelé sur les faces à l'ombre. */
const SPIRIT_ENV_I = 0.20;
/* Intensité du ciel de biome en esprit. Pas zéro : un fond parfaitement noir
   supprimerait la silhouette des reliefs lointains contre l'horizon, et la
   vallée perdrait sa profondeur. */
const SPIRIT_BG_I = 0.14;

/* -- Un état de forme PAR FACTION --
   Les bots vivent les deux mondes comme le joueur : mêmes dix secondes, même
   délai de cinq, même éjection quand le chrono tombe. `spirit` reste l'état de
   la faction 0 — c'est le même objet que `forms[0]`, pas une copie — parce que
   tout ce qui touche à la caméra, au voile et au HUD ne concerne que le joueur
   local et n'a aucune raison de s'indexer. */
export const spirit = {
  active: false,   // true = forme d'esprit
  t: 0,            // secondes d'esprit restantes
  cd: 0,           // secondes avant de pouvoir y retourner
  blend: 0,        // 0..1, transition visuelle lissée
  forcedOut: false,// dernière sortie due au chrono épuisé
};

const forms = [spirit];

/** État de forme d'une faction, créé à la demande. */
export function formOf(fi) {
  if (!forms[fi]) {
    forms[fi] = { active: false, t: 0, cd: 0, blend: 0, forcedOut: false };
  }
  return forms[fi];
}

/** Peut-on basculer en esprit maintenant ? */
export function canEnterSpirit(fi = 0) {
  const s = formOf(fi);
  return !s.active && s.cd <= 0;
}

/* -- Ambiance --
   applyDayCycle() réécrit brouillard et fond à CHAQUE image. On ne peut donc
   pas poser la teinte d'esprit une fois pour toutes : on la mélange après coup,
   à partir des valeurs que le cycle vient d'écrire. */
const _fogCol = new THREE.Color();

/* -- Couleurs de référence --
   applyDayCycle() réécrit la brume et la couleur du soleil à chaque image : on
   peut donc les mélanger sur place sans rien casser. Le FOND de scène et les
   deux teintes de l'hémisphérique, eux, sont posés UNE FOIS au démarrage. Les
   mélanger sur place les ferait dériver un peu plus à chaque frame et le ciel
   ne reviendrait jamais au bleu. On mémorise donc leur valeur d'origine et on
   repart d'elle à chaque fois. */
let _base = null;
function captureBase(ctx) {
  if (_base) return _base;
  _base = {
    bg: ctx.scene?.background?.isColor ? ctx.scene.background.clone() : null,
    hemiSky: ctx.hemi ? ctx.hemi.color.clone() : null,
    hemiGnd: ctx.hemi?.groundColor ? ctx.hemi.groundColor.clone() : null,
  };
  return _base;
}

/* Plus aucun voile sur le corps : la bascule change carrément de modèle (le
   petit élémentaire du personnage), et il doit garder SA couleur d'origine —
   c'est elle qui dit de quel esprit il s'agit. Toute l'ambiance passe donc par
   le monde autour, jamais par le personnage. */

/* -- Voile plein écran + chrono --
   Un dégradé CSS coûte zéro frame et fait la moitié du travail d'ambiance : il
   dit « tu n'es plus dans le même monde » avant même que l'œil lise la brume.
   Le module fabrique son propre DOM pour rester autonome. */
let _veil = null;
let _barEl = null;
let _barFill = null;

function ensureDom() {
  if (_veil) return;
  const style = document.createElement('style');
  style.textContent = `
/* Vignette d'esprit. En fondu NORMAL, pas en « screen » : le premier essai
   éclaircissait l'image au lieu de l'enfoncer, et se lisait comme un voile de
   brume banal.

   Mais il fermait BEAUCOUP trop : 94 % d'opaque dans les coins, et la
   fermeture commençant dès 26 % du rayon. Sur un décor déjà écrasé par la
   brume, cela ne se lisait plus comme une vignette mais comme un calque posé
   par-dessus l'image — ce qu'il était littéralement.

   Une vignette doit se sentir sans se voir : elle guide le regard vers le
   centre, elle ne masque pas les bords. La fermeture démarre donc plus tard
   (48 %) et s'arrête à 62 % d'opacité, en laissant le décor lisible partout. */
#spirit-veil{position:fixed;inset:0;pointer-events:none;opacity:0;z-index:40;
  background:
    radial-gradient(ellipse at 50% 45%,rgba(120,170,255,.08) 0%,rgba(30,45,110,0) 55%),
    radial-gradient(ellipse at 50% 50%,rgba(6,10,28,0) 48%,rgba(8,14,40,.30) 78%,rgba(3,6,18,.62) 100%)}
#spirit-timer{position:fixed;left:50%;bottom:86px;transform:translateX(-50%);
  width:min(38vw,240px);height:7px;border-radius:99px;z-index:41;
  background:rgba(10,18,40,.55);box-shadow:0 0 0 1px rgba(150,200,255,.25);
  opacity:0;transition:opacity .2s ease;pointer-events:none}
#spirit-timer.on{opacity:1}
#spirit-timer i{display:block;height:100%;border-radius:99px;width:100%;
  background:linear-gradient(90deg,#7fd8ff,#c9e9ff);box-shadow:0 0 10px rgba(140,215,255,.85)}
/* Chrono d'esprit qui s'épuise : on alarme avant la panne, jamais après. */
#spirit-timer.warn i{background:linear-gradient(90deg,#ff9b6a,#ffd9a8);
  box-shadow:0 0 10px rgba(255,150,90,.9);animation:spg .5s steps(2,end) infinite}
/* Délai de retour : même barre, teinte éteinte — elle se REMPLIT au lieu de
   se vider, pour qu'on lise « ça revient » et non « ça s'épuise ». */
#spirit-timer.cd i{background:linear-gradient(90deg,#4a5a80,#8fa2c8);
  box-shadow:none;opacity:.75}
@keyframes spg{50%{opacity:.35}}`;
  document.head.appendChild(style);

  _veil = document.createElement('div');
  _veil.id = 'spirit-veil';
  document.body.appendChild(_veil);

  _barEl = document.createElement('div');
  _barEl.id = 'spirit-timer';
  _barFill = document.createElement('i');
  _barEl.appendChild(_barFill);
  document.body.appendChild(_barEl);
}

/** Remet toutes les formes et chronos à neuf — début de chaque partie. */
export function resetSpirit() {
  forms.length = 1;
  spirit.active = false;
  spirit.t = 0;
  spirit.cd = 0;
  spirit.blend = 0;
  spirit.forcedOut = false;
  if (_veil) _veil.style.opacity = '0';
  if (_barEl) _barEl.classList.remove('on', 'warn', 'cd');
}

/** Multiplicateur de vitesse du Leader d'une faction.
 *  S'applique par-dessus le boost : les deux se cumulent, comme voulu. */
export function spiritSpeedMul(fi = 0) {
  return formOf(fi).active ? TUNE_SPIRIT.speedMul : 1;
}

/** Bascule Chair <-> Esprit. Retourne true si le passage a eu lieu.
 *  @param {{onEnter?:Function,onExit?:Function,onRefused?:Function}} ctx */
export function toggleSpirit(fi = 0, ctx = {}) {
  const s = formOf(fi);
  if (!s.active) {
    if (s.cd > 0) { ctx.onRefused?.(); return false; }
    s.active = true;
    s.t = TUNE_SPIRIT.duration;
    s.forcedOut = false;
    ctx.onEnter?.();
  } else {
    /* Sortir tôt n'économise rien : le délai de retour est le même. On est donc
       poussé à se servir de ses dix secondes plutôt qu'à picorer. */
    s.active = false;
    s.t = 0;
    s.cd = TUNE_SPIRIT.cooldown;
    ctx.onExit?.();
  }
  return true;
}

/** Retour en chair imposé, sans déclencher les retours de bascule.
 *  Sert à la dispersion (§10.10) : on ne se reforme jamais en esprit. */
export function forceFlesh(fi = 0) {
  const s = formOf(fi);
  if (s.active) s.cd = TUNE_SPIRIT.cooldown;
  s.active = false;
  s.t = 0;
}

/** Chronos de TOUTES les factions. Séparé de l'ambiance, qui ne concerne que
 *  le joueur local : les règles tournent pour tout le monde, l'écran n'affiche
 *  qu'un point de vue.
 *  @param {(fi:number)=>void} onForcedOut */
export function tickSpiritTimers(dt, count, onForcedOut) {
  for (let fi = 0; fi < count; fi++) {
    const s = formOf(fi);
    if (s.active) {
      s.t -= dt;
      if (s.t <= 0) {
        s.t = 0;
        s.active = false;
        s.cd = TUNE_SPIRIT.cooldown;
        s.forcedOut = true;
        onForcedOut?.(fi);
      }
    } else if (s.cd > 0) {
      s.cd = Math.max(0, s.cd - dt);
    }
    /* Le fondu visuel n'a de sens que pour un corps affiché, mais on le tient
       pour tous : c'est lui qui pilote l'opacité des corps d'esprit rivaux. */
    const target = s.active ? 1 : 0;
    const k = Math.min(1, dt / Math.max(0.001, TUNE_SPIRIT.fadeIn));
    s.blend += (target - s.blend) * k;
    if (Math.abs(s.blend - target) < 0.002) s.blend = target;
  }
}

/** Pas de simulation de la forme et des chronos.
 *  @param {number} dt
 *  @param {{scene:object,sun:object,hemi:object,renderer:object,
 *           elapsed:number,onForcedOut?:Function}} ctx */
export function updateSpirit(dt, ctx) {
  ensureDom();
  /* Les chronos de toutes les factions tournent d'abord (tickSpiritTimers),
     puis l'écran habille le point de vue du joueur. */
  tickSpiritTimers(dt, ctx.count || 1, ctx.onForcedOut);
  applyAmbience(ctx, ctx.elapsed || 0);
  applyHud();
}

/* Mélange l'ambiance d'esprit PAR-DESSUS ce que le cycle du jour vient
   d'écrire. À appeler après applyDayCycle(), jamais avant — sinon le cycle
   réécrit tout à l'image suivante. */

function applyAmbience(ctx, elapsed) {
  const b = spirit.blend;
  const scene = ctx.scene;
  const base = captureBase(ctx);
  /* Respiration lente : l'ambiance ne doit jamais être parfaitement stable,
     sinon l'œil s'y habitue en trois secondes et « ne sent plus » rien. */
  const breath = 1 + 0.06 * Math.sin(elapsed * 1.15);

  if (scene) {
    /* Brume : réécrite par le cycle du jour, donc mélange sur place. */
    if (scene.fog) {
      _fogCol.copy(scene.fog.color).lerp(SPIRIT_FOG, b);
      scene.fog.color.copy(_fogCol);
      scene.fog.near += (SPIRIT_FOG_NEAR - scene.fog.near) * b;
      scene.fog.far += (SPIRIT_FOG_FAR * breath - scene.fog.far) * b;
    }
    /* Fond : posé une fois pour toutes, donc toujours reparti de l'origine. */
    if (base.bg && scene.background && scene.background.isColor) {
      scene.background.copy(base.bg).lerp(SPIRIT_BG, b);
    } else if (scene.background) {
      /* En jeu, le fond n'est PAS une couleur mais le ciel du biome, une
         texture — la branche ci-dessus n'a donc jamais rien fait pendant une
         partie, et le ciel du couchant restait à pleine intensité derrière un
         décor éteint. On ne peut pas le teinter, mais on peut le baisser, ce
         qui suffit : la brume esprit, très proche, recouvre de toute façon tout
         ce qui n'est pas immédiatement autour du joueur.
         Écrit à chaque image par applyDayCycle, donc mélangé sur place. */
      scene.backgroundIntensity += (SPIRIT_BG_I - scene.backgroundIntensity) * b;
    }
  }

  /* Lumières : un soleil chaud plein pot annulait tout le reste. On l'éteint
     presque et on le refroidit, et l'hémisphérique vire au violet.

     Interpolation vers une CIBLE et non multiplication (voir les constantes) :
     l'état de départ dépend de l'heure de la vallée, la destination non. */
  if (ctx.sun) {
    ctx.sun.intensity += (SPIRIT_SUN_I - ctx.sun.intensity) * b;
    ctx.sun.color.lerp(SPIRIT_SUN, b);   // réécrite par le cycle : sur place
  }
  if (ctx.hemi) {
    ctx.hemi.intensity += (SPIRIT_HEMI_I - ctx.hemi.intensity) * b;
    if (base.hemiSky) ctx.hemi.color.copy(base.hemiSky).lerp(SPIRIT_HEMI_SKY, b);
    if (base.hemiGnd) ctx.hemi.groundColor.copy(base.hemiGnd).lerp(SPIRIT_HEMI_GND, b);
  }
  /* L'ambiant issu du ciel, que cette ambiance ignorait complètement. Réécrit
     par applyDayCycle à chaque image, donc mélangé sur place comme le reste. */
  if (scene && scene.environmentIntensity !== undefined) {
    scene.environmentIntensity += (SPIRIT_ENV_I - scene.environmentIntensity) * b;
  }
  if (ctx.renderer) {
    ctx.renderer.toneMappingExposure +=
      (SPIRIT_EXPOSURE - ctx.renderer.toneMappingExposure) * b;
  }

  if (_veil) _veil.style.opacity = String(b * (0.85 + 0.15 * Math.sin(elapsed * 1.6)));
}

function applyHud() {
  if (!_barEl) return;
  /* La barre ne s'affiche que quand elle dit quelque chose : en esprit (elle
     se vide) ou pendant le délai de retour (elle se remplit). En chair et
     disponible, elle disparaît — un HUD qui montre en permanence une barre
     pleine ne dit rien. */
  const inCd = !spirit.active && spirit.cd > 0;
  const show = spirit.active || inCd;
  _barEl.classList.toggle('on', show);
  _barEl.classList.toggle('cd', inCd);
  _barEl.classList.toggle('warn', spirit.active && spirit.t <= TUNE_SPIRIT.warnAt);
  if (!_barFill) return;
  const p = spirit.active
    ? spirit.t / TUNE_SPIRIT.duration
    : 1 - spirit.cd / TUNE_SPIRIT.cooldown;
  _barFill.style.width = `${Math.max(0, Math.min(1, p)) * 100}%`;
}
