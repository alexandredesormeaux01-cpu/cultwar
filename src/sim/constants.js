/* Constantes de gameplay — valeurs numériques pures, aucune dépendance Three.js.
   Extraites de main.js pour que le moteur headless (Node/serveur) puisse les
   partager avec le client. Les constantes purement visuelles (couleurs des
   cultes, tailles de mesh, bandes de masque de vêtement) restent dans main.js. */

/* ---- Carte ---- */
export const MAP_R = 60;               // rayon jouable de la vallée
export const DENSITY = 1;              // multiplicateur de population (alléger GPU + carte)
export const AGENT_CAP_MOBILE = 350;
export const AGENT_CAP_DESKTOP = 600;
export const START_GRAYS = 300;

/* ---- Factions & base ---- */
export const NB_FACTIONS = 3;
export const GOAL = 60;              // premier culte à 60 esprits déposés au sanctuaire : victoire
export const SIEGE_R = 3.5;
export const SIEGE_R2 = SIEGE_R * SIEGE_R;
export const SIEGE_RATE = 0.5;
export const BASE_WALL_R = 7.2;
export const BASE_WALL_T = 1.4;
export const BASE_WALL_H = 2.85;
export const BASE_GATE_HALF = 0.50;
export const BASE_WALL_SEGS = 18;
export const BASE_SPAWN_R = 3.2;

/* ---- Livraison / dépôt ---- */
export const DEPOSIT_RATE = 26;

/* ---- Mode partie ---- */
export const MATCH_DUR = 120;
export const FUEL_MAX = 100;
export const FUEL_PER_UNIT = 0.70;
export const FUEL_PER_GRAY = 10;
export const SCORE_PER_PCT = 100;
export const SCORE_PER_GRAY = 6;
export const SCORE_PER_DIST = 0.35;
export const PAINT_TRAIL_R = 2.6;

/* ---- Siphon (foule contre foule) ---- */
export const SIPHON_BASE = 1.8;
export const SIPHON_RATIO_MIN = 1.1;
export const SIPHON_RATIO_CAP = 3.0;

/* ---- Boost ---- */
export const BOOST_MULT = 1.7;
export const BOOST_DUR = 2.6;
export const BOOST_CD = 9.0;

/* ---- Série de conversions ---- */
export const STREAK_WINDOW = 2.0;
export const STREAK_PALIERS = [5, 10, 25, 50, 100];

/* ---- Conversion / aura ---- */
export const CONV_R = 3.15;
export const CONV_RITUAL_T = 0.62;
export const FLEE_R = 11;

/* ---- Disciples ---- */
export const DISCIPLE_CHANCE = 0.10;
export const DISCIPLE_COOLDOWN = 10.0;
export const DISCIPLE_MAX_BASE = 3;
export const DISC_HUNT_R = 22;
export const DISC_SPD = 7.5;
export const DISC_FLEE_R = 6.5;
export const DISC_HALO_Y = 2.45;
export const DISC_DETOUR_T = 1.1;
export const DISC_PAINT_R = 0.62;
export const DISC_SEP_R = 9;
/* Priorité #1 : peindre le maître. Bombes chassées loin ; au-dessous de
   DISC_FUEL_CRITICAL le disciple abandonne presque toute chasse de gris. */
export const DISC_BOMB_R = 48;
export const DISC_FUEL_CRITICAL = 0.40;
export const DISC_FUEL_COMFORT = 0.72;
export const DISC_LVL_MAX = 3;
export const DISC_XP_TO_NEXT = [0, 30, 45];

/* ---- Followers (convertis fidèles) ---- */
export const FOLLOWER_SCALE = 0.55;
/** Disciples : même mesh Leader que les followers, remis à taille Leader (1 / FOLLOWER_SCALE). */
export const DISCIPLE_FORM_SCALE = 1 / FOLLOWER_SCALE;
export const FOLLOWER_FLEE_R = 10;
export const FOLLOWER_SPD = 2.8;
export const FOLLOWER_WANDER_SPD = 0.8;

/* ---- Ralliement / repop ---- */
export const RALLY_CD = 14;
export const RALLY_DUR = 3.0;
export const GRAY_MIN = 22 * DENSITY;

/* ---- Ferveur / Extase ---- */
export const FERVOR_GAIN = 0.042;
export const FERVOR_DECAY = 0.028;
export const ECSTASY_DUR = 6.0;
export const ECSTASY_RANGE = 1.9;
export const ECSTASY_CONV = 3.0;

/* ---- Sanctuaires ---- */
export const SHRINE_R = 4.4;
export const SHRINE_CAPTURE_T = 4.0;
export const SHRINE_INCOME_T = 3.2;
export const SHRINE_INCOME_N = 2;

/* ---- Grille / voisinage ---- */
export const CELL = 1.7;
export const CONTACT_R = 0.85;
export const CONTACT_R2 = CONTACT_R * CONTACT_R;
export const SEP_R = 0.6;

/* ---- Vitesse Leader ---- */
export const V_MAX = 9.2;
export const V_MIN = 7.3;
export const N_REF = 220;
export const LEADER_RESP = 16;
export const CAM_RESP = 6;
export const CAM_LOOK_RESP = 9;
