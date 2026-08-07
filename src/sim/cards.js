/* ============================================================================
   Cult.io — Cartes hasard
   ---------------------------------------------------------------------------
   Une carte tourne sur elle-même quelque part sur la carte. Le premier Leader
   qui la touche déclenche son effet — et personne ne sait lequel avant de la
   prendre. C'est un pari, pas une récompense : la moitié du deck peut coûter
   très cher à celui qui se précipite.

   POURQUOI SI RARES
   Cinq à six cartes par partie, une seule présente à la fois. Une carte doit
   valoir un détour : si elle réapparaissait toutes les dix secondes, la ramasser
   deviendrait une routine et le jeu se jouerait sur les cartes plutôt que sur la
   conversion d'esprits. La rareté est ce qui rend le pari intéressant.

   POURQUOI DU PUR HASARD
   Aucun rattrapage : le tirage ignore le classement. Un joueur qui voit son
   rival foncer sur une carte doit pouvoir espérer qu'elle lui explose au visage,
   et cet espoir n'existe que si le tirage ne triche pas.

   Module de simulation pur : aucun Three.js, aucun DOM. Tous les effets passent
   par les méthodes de `ctx`, branchées par main.js.
   ========================================================================== */

/* ---- Rythme ----
   CALENDRIER ABSOLU, et non un délai relançé après chaque ramassage. La version
   relative dérivait : le compte à rebours ne repartant qu'une fois la carte
   prise, un cycle valait « trajet + délai ». Sur une partie de 5 minutes, avec
   une douzaine de secondes pour rejoindre la carte, la sixième apparaissait à
   288 s — douze secondes avant la fin, donc jamais ramassée. Plus les joueurs
   tardaient, plus les cartes se raréfiaient, exactement à l'envers de ce qu'on
   veut.

   Ici les six créneaux sont posés d'avance sur la durée de la partie. Le
   nombre de cartes et leur étalement ne dépendent plus de la vitesse des
   joueurs, et la dernière tombe toujours assez tôt pour changer l'issue. */
import { MATCH_DUR } from './constants.js';

export const CARD_BUDGET = 6;      // cartes sur une partie entière
export const CARD_FIRST_T = 22;    // premier créneau (s) — le temps de s'installer
/* Dernier créneau : il reste ~55 s après lui. De quoi voir la carte, aller la
   chercher et en subir les conséquences — une carte tirée dans les dernières
   secondes ne serait qu'une loterie sur le résultat final. */
export const CARD_LAST_T = MATCH_DUR - 55;
export const CARD_JITTER = 7;      // ± sur chaque créneau, pour qu'on ne les attende pas au chrono
export const CARD_PICK_R = 2.6;    // rayon de ramassage
export const CARD_MIN_D = 18;      // distance minimale à tout Leader à l'apparition

/* `scope` : self = seul le trouveur encaisse | all = tout le monde.
   `tone`  : good | bad | chaos — pilote la couleur de la carte et l'annonce.
   `major` : révélation plein écran (~1,5 s). Réservé aux effets qui changent la
             partie pour tout le monde : sans explication, on les prendrait pour
             un bug. Les effets individuels ne l'utilisent JAMAIS — couper
             l'action pour un bonus qui ne concerne qu'un joueur est une punition
             pour les cinq autres. */

const card = (id, tone, scope, icon, title, blurb, apply, opts = {}) => ({
  id, tone, scope, icon, title, blurb, apply,
  major: opts.major || false,
  weight: opts.weight ?? 1,
});

export const CARD_DECK = [
  /* ======================= INDIVIDUEL — bénéfique ======================= */
  card('spirit_gift', 'good', 'self', '✨', 'Ferveur soudaine',
    'Cinq esprits rejoignent votre cortège sur-le-champ.',
    (ctx, f) => ctx.giftSpirits(f, 5)),

  card('free_altar', 'good', 'self', '🏛', 'Sanctuaire offert',
    'Un sanctuaire s\'éveille à vos couleurs, sans rien livrer.',
    (ctx, f) => ctx.grantAltar(f)),

  card('paint_fervor', 'good', 'self', '🎨', 'Empreinte profonde',
    'Votre peinture mord deux fois plus large pendant 25 s.',
    (ctx, f) => ctx.paintFervor(f, 25, 2)),

  card('swift_feet', 'good', 'self', '🌬', 'Pieds de vent',
    'Vous sprintez sans discontinuer pendant 10 s.',
    (ctx, f) => ctx.boostLeader(f, 10)),

  card('rapid_fire', 'good', 'self', '⚡', 'Main leste',
    'Votre tir recharge deux fois plus vite pendant 20 s.',
    (ctx, f) => ctx.rapidFire(f, 20, 0.5)),

  card('spirit_call', 'good', 'self', '📯', 'Appel du berger',
    'Les esprits alentour cessent de vous fuir pendant 12 s.',
    (ctx, f) => ctx.spiritCall(f, 12)),

  card('big_splash', 'good', 'self', '🩸', 'Marque du prophète',
    'Une immense flaque de votre couleur s\'étale sous vos pieds.',
    (ctx, f) => ctx.splashLeader(f, 14)),

  card('altar_steal', 'chaos', 'self', '🗝', 'Schisme',
    'Vous ravissez un sanctuaire au culte qui en tient le plus.',
    (ctx, f) => ctx.stealAltarFromBest(f)),

  /* ======================= INDIVIDUEL — néfaste ========================= */
  card('lose_spirits', 'bad', 'self', '💔', 'Reniement',
    'Tout votre cortège vous abandonne et se disperse.',
    (ctx, f) => ctx.loseAllSpirits(f)),

  card('lose_altar', 'bad', 'self', '🕯', 'Sanctuaire profané',
    'Un de vos sanctuaires retombe aux mains de personne.',
    (ctx, f) => ctx.loseAltar(f)),

  card('stumble', 'bad', 'self', '🥴', 'Vertige sacré',
    'Vous vous effondrez, puis restez pesant un moment.',
    (ctx, f) => ctx.stumbleLeader(f, 6)),

  card('paint_leak', 'bad', 'self', '🌧', 'Lessive',
    'La peinture s\'efface tout autour de vous.',
    (ctx, f) => ctx.wipePaintAround(f, 16)),

  card('exile', 'bad', 'self', '🌀', 'Exil',
    'Vous êtes projeté à l\'autre bout de la vallée.',
    (ctx, f) => ctx.exileLeader(f)),

  card('double_or_nothing', 'chaos', 'self', '🎲', 'Quitte ou double',
    'Votre cortège double… ou disparaît. Une chance sur deux.',
    (ctx, f) => ctx.doubleOrNothing(f)),

  /* ========================= COLLECTIF — chaos ========================== */
  card('swap_all', 'chaos', 'all', '🔀', 'Grand chassé-croisé',
    'Tous les Leaders permutent leurs positions.',
    (ctx) => ctx.swapAllLeaders(), { major: true }),

  card('swap_two', 'chaos', 'all', '↔️', 'Chassé-croisé',
    'Deux Leaders tirés au sort échangent leurs places.',
    (ctx) => ctx.swapTwoLeaders(), { major: true }),

  card('scatter', 'chaos', 'all', '💨', 'Dispersion',
    'Chacun est téléporté n\'importe où sur la carte.',
    (ctx) => ctx.scrambleLeaders(), { major: true }),

  card('time_rush', 'chaos', 'all', '⏱', 'Le temps s\'emballe',
    'L\'horloge de la partie tourne deux fois plus vite pendant 30 s.',
    (ctx) => ctx.timeRush(30, 2), { major: true }),

  card('blackout', 'chaos', 'all', '🌑', 'Nuit sans lune',
    'La vallée s\'éteint pendant 18 s. On n\'y voit qu\'à ses pieds.',
    (ctx) => ctx.blackout(18), { major: true }),

  card('color_swap', 'chaos', 'all', '🎭', 'Mascarade',
    'Les cultes échangent leurs couleurs. Bon courage.',
    (ctx) => ctx.swapFactionColors(), { major: true }),

  /* ======================= COLLECTIF — bénéfique ======================== */
  card('pilgrim_wave', 'good', 'all', '👣', 'Vague de pèlerins',
    'Une foule d\'esprits déferle sur la vallée.',
    (ctx) => ctx.spawnPilgrims(30)),

  card('zeal_aura', 'good', 'all', '🔥', 'Zèle ardent',
    'Les esprits capturés se relèvent bien plus vite pendant 15 s.',
    (ctx) => ctx.zealAura(15)),

  card('crystal_surge', 'good', 'all', '💎', 'Pluie de cristaux',
    'Les cristaux se multiplient sur la carte.',
    (ctx) => ctx.surgeBombs(30, 1.5)),

  /* ========================= COLLECTIF — néfaste ======================== */
  card('paint_wash', 'bad', 'all', '🌊', 'Déluge d\'oubli',
    'Toute la peinture de la vallée est lessivée. Tout est à refaire.',
    (ctx) => ctx.washAllPaint(), { major: true, weight: 0.6 }),

  card('gray_panic', 'bad', 'all', '😱', 'Panique',
    'Les esprits s\'affolent et fuient beaucoup plus loin.',
    (ctx) => ctx.panicGrays(14)),

  card('quake', 'bad', 'all', '⛰', 'Tremblement sacré',
    'La vallée tremble : tout le monde à terre.',
    (ctx) => ctx.quake(5)),

  card('slow_all', 'bad', 'all', '🕸', 'Marais sacré',
    'Tous les Leaders s\'enlisent pendant 8 s.',
    (ctx) => ctx.slowAllLeaders(8)),
];

/** Deck indexé, pour retrouver une carte par son id (tests, rejeu réseau). */
export const CARD_BY_ID = Object.fromEntries(CARD_DECK.map((c) => [c.id, c]));

/**
 * Tirage pondéré, sans rattrapage de classement.
 * `recent` : ids déjà sortis dans la partie. Ils ne sont pas interdits — sur six
 * tirages dans un deck de vingt-sept, s'interdire les répétitions ne changerait
 * presque rien — mais leur poids est divisé, ce qui suffit à éviter l'effet
 * « deux fois la même carte d'affilée », le seul qui se remarque vraiment.
 */
export function pickCard(rng = Math.random, recent = []) {
  let total = 0;
  const w = CARD_DECK.map((c) => {
    const seen = recent.indexOf(c.id);
    /* Plus la sortie est fraîche, plus on l'écarte : la dernière carte tirée
       tombe à un quart de son poids, l'avant-dernière à la moitié. */
    const penalty = seen < 0 ? 1 : (seen === recent.length - 1 ? 0.25 : 0.5);
    const v = c.weight * penalty;
    total += v;
    return v;
  });
  let r = rng() * total;
  for (let i = 0; i < CARD_DECK.length; i++) {
    r -= w[i];
    if (r <= 0) return CARD_DECK[i];
  }
  return CARD_DECK[CARD_DECK.length - 1];
}

/**
 * Créneaux d'apparition d'une partie, en secondes depuis le coup d'envoi.
 * Étalés régulièrement de CARD_FIRST_T à CARD_LAST_T, avec un jitter pour qu'on
 * ne puisse pas les attendre au chronomètre. Le tri final est nécessaire : le
 * jitter peut faire passer un créneau devant le précédent.
 */
export function buildCardSchedule(rng = Math.random) {
  const span = CARD_LAST_T - CARD_FIRST_T;
  const step = CARD_BUDGET > 1 ? span / (CARD_BUDGET - 1) : 0;
  const out = [];
  for (let i = 0; i < CARD_BUDGET; i++) {
    out.push(CARD_FIRST_T + step * i + (rng() * 2 - 1) * CARD_JITTER);
  }
  out.sort((a, b) => a - b);
  return out;
}

/**
 * Ton à afficher dans le bandeau, du POINT DE VUE du joueur local.
 * `mine` : le joueur local est-il celui qui a ramassé la carte ?
 *
 * Un malus individuel encaissé par un rival est une bonne nouvelle pour le
 * joueur : afficher « Reniement » en rouge alarmant pendant qu'un adversaire
 * perd tout son cortège dirait exactement le contraire de ce qui se passe. On
 * inverse donc la lecture — mais seulement pour les cartes individuelles : un
 * effet collectif frappe tout le monde de la même façon, y compris le joueur, et
 * son ton ne dépend de personne.
 */
export function bannerTone(c, mine) {
  if (!c) return 'chaos';
  if (c.scope !== 'self' || mine) return c.tone;
  if (c.tone === 'good') return 'bad';
  if (c.tone === 'bad') return 'good';
  return c.tone;
}

/** Applique une carte. `f` = la faction qui l'a ramassée. */
export function applyCard(c, ctx, f) {
  if (!c || !ctx) return;
  c.apply(ctx, f);
}
