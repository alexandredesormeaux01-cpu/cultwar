/* Cartes événement — surprises à mi-partie (pause + roulette).
   Les effets purs sont décrits ici ; l'application concrète (fuel, bombes,
   couleurs…) passe par le ctx fourni par main.js. */

import { DISC_LVL_MAX } from './constants.js';

/** Événements désactivés — aucune carte ne tombe. */
export const EVENT_TIMES = [];

export const EVENT_SPIN_DUR = 3.8;
export const EVENT_REVEAL_DUR = 4.8;

const art = (id) => `assets/events/${id}.webp`;

/** Catalogue. `tone` : good | bad | chaos — style de la carte. */
export const EVENT_DECK = [
  {
    id: 'color_swap',
    tone: 'chaos',
    icon: '🎨',
    art: art('color_swap'),
    title: 'Échange de couleurs',
    blurb: 'Les cultes échangent leurs teintes. Confusion garantie.',
  },
  {
    id: 'disciple_level',
    tone: 'good',
    icon: '✝',
    art: art('disciple_level'),
    title: 'Bénédiction apostolique',
    blurb: 'Tous les disciples actifs gagnent 1 niveau.',
  },
  {
    id: 'fuel_drought',
    tone: 'bad',
    icon: '💀',
    art: art('fuel_drought'),
    title: 'Sécheresse de peinture',
    blurb: 'Toute la peinture tombe à 0 % pendant 10 secondes.',
  },
  {
    id: 'crystal_surge',
    tone: 'good',
    icon: '💎',
    art: art('crystal_surge'),
    title: 'Pluie de cristaux',
    blurb: '+50 % de cristaux-bombes sur la carte pendant 30 s.',
  },
  {
    id: 'leader_boost',
    tone: 'good',
    icon: '⚡',
    art: art('leader_boost'),
    title: 'Ferveur collective',
    blurb: 'Tous les Leaders reçoivent un boost de vitesse.',
  },
  {
    id: 'leader_slow',
    tone: 'bad',
    icon: '🕸',
    art: art('leader_slow'),
    title: 'Marais sacré',
    blurb: 'Tous les Leaders sont ralentis pendant quelques secondes.',
  },
  {
    id: 'gray_panic',
    tone: 'chaos',
    icon: '😱',
    art: art('gray_panic'),
    title: 'Panique des sceptiques',
    blurb: 'Les gris s\'éparpillent — conversion plus difficile un moment.',
  },
  {
    id: 'fuel_blessing',
    tone: 'good',
    icon: '🪔',
    art: art('fuel_blessing'),
    title: 'Fontaine sacrée',
    blurb: 'Les réserves de peinture de tous les cultes sont remplies.',
  },
  {
    id: 'paint_wash',
    tone: 'chaos',
    icon: '🌊',
    art: art('paint_wash'),
    title: 'Déluge d\'oubli',
    blurb: 'Toute la peinture de la vallée est lessivée d\'un coup.',
  },
  {
    id: 'leader_splash',
    tone: 'good',
    icon: '🩸',
    art: art('leader_splash'),
    title: 'Empreinte divine',
    blurb: 'Chaque Leader laisse une large flaque de sa couleur.',
  },
  {
    id: 'bomb_drought',
    tone: 'bad',
    icon: '🌑',
    art: art('bomb_drought'),
    title: 'Cristaux épuisés',
    blurb: 'Tous les cristaux disparaissent. Aucun nouveau pendant 20 s.',
  },
  {
    id: 'pilgrim_wave',
    tone: 'chaos',
    icon: '👣',
    art: art('pilgrim_wave'),
    title: 'Vague de pèlerins',
    blurb: 'Une foule de sceptiques apparaît soudain sur la carte.',
  },
  {
    id: 'teleport_dance',
    tone: 'chaos',
    icon: '🌀',
    art: art('teleport_dance'),
    title: 'Danse des prophètes',
    blurb: 'Les Leaders sont téléportés à des points aléatoires.',
  },
  {
    id: 'zeal_aura',
    tone: 'good',
    icon: '🔥',
    art: art('zeal_aura'),
    title: 'Zèle ardent',
    blurb: 'Les conversions sont bien plus rapides pendant 12 s.',
  },
  {
    id: 'silence_disciples',
    tone: 'bad',
    icon: '🤐',
    art: art('silence_disciples'),
    title: 'Vœu de silence',
    blurb: 'Les disciples sont figés sur place pendant 8 secondes.',
  },
  {
    id: 'position_swap',
    tone: 'chaos',
    icon: '🔀',
    art: art('position_swap'),
    title: 'Chassé-croisé',
    blurb: 'Deux Leaders échangent leurs positions instantanément.',
  },
  {
    id: 'faith_rain',
    tone: 'good',
    icon: '✨',
    art: art('faith_rain'),
    title: 'Pluie de foi',
    blurb: 'Chaque culte gagne plusieurs croyants d\'un coup.',
  },
  {
    id: 'quake',
    tone: 'bad',
    icon: '⛰',
    art: art('quake'),
    title: 'Tremblement sacré',
    blurb: 'La vallée tremble : Leaders ralentis, gris désorientés.',
  },
];

export function pickEvent(rng = Math.random) {
  const i = Math.floor(rng() * EVENT_DECK.length) % EVENT_DECK.length;
  return EVENT_DECK[i];
}

/** Applique l'effet. `ctx` porte les hooks mutateurs du jeu. */
export function applyEvent(ev, ctx) {
  if (!ev || !ctx) return;
  switch (ev.id) {
    case 'color_swap':
      ctx.swapFactionColors?.();
      break;
    case 'disciple_level':
      ctx.levelUpDisciples?.(1);
      break;
    case 'fuel_drought':
      ctx.drainAllFuel?.(10);
      break;
    case 'crystal_surge':
      ctx.surgeBombs?.(30, 1.5);
      break;
    case 'leader_boost':
      ctx.boostAllLeaders?.(2.5);
      break;
    case 'leader_slow':
      ctx.slowAllLeaders?.(4.0);
      break;
    case 'gray_panic':
      ctx.panicGrays?.(8);
      break;
    case 'fuel_blessing':
      ctx.fillAllFuel?.();
      break;
    case 'paint_wash':
      ctx.washAllPaint?.();
      break;
    case 'leader_splash':
      ctx.splashAllLeaders?.(7.5);
      break;
    case 'bomb_drought':
      ctx.droughtBombs?.(20);
      break;
    case 'pilgrim_wave':
      ctx.spawnPilgrims?.(28);
      break;
    case 'teleport_dance':
      ctx.scrambleLeaders?.();
      break;
    case 'zeal_aura':
      ctx.zealAura?.(12);
      break;
    case 'silence_disciples':
      ctx.freezeDisciples?.(8);
      break;
    case 'position_swap':
      ctx.swapTwoLeaders?.();
      break;
    case 'faith_rain':
      ctx.grantBelieversAll?.(6);
      break;
    case 'quake':
      ctx.quake?.(5);
      break;
    default:
      break;
  }
}

export function clampDiscipleLevel(a, delta = 1) {
  if (!a) return;
  a.discLvl = Math.min(DISC_LVL_MAX, (a.discLvl || 1) + delta);
  if ((a.discLvl || 1) >= DISC_LVL_MAX) a.discXp = 0;
}
