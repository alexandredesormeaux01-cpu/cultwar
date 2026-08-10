/* ============================== Manette (Xbox / Gamepad API) ==============================
   Un seul module, branché en deux points de main.js :
     · initGamepad(hooks)  — une fois au démarrage ;
     · pollGamepad(dt)     — une fois par frame, avant la simulation.

   ---------------------------------------------------------------------------
   Le problème que ce module résout

   Le jeu n'est pas fait que d'écrans de boutons. Il enchaîne quatre natures
   d'interface très différentes :
     · des overlays DOM (menu, lobby, créateur)      → déplacer un focus ;
     · deux mondes 3D marchables (match, Hub)        → piloter un personnage ;
     · deux canvas de carte (globe, zones du pays)   → choisir une cible dessinée
       à la main, sans le moindre élément focusable ;
     · des champs texte                              → saisir des lettres.

   Une seule stratégie de navigation ne peut pas couvrir les quatre. Le module
   détermine donc un CONTEXTE à chaque frame et applique la stratégie adaptée.
   Pour les canvas, il ne cherche pas à simuler un curseur : c'est l'écran
   concerné qui publie sa propre navigation via registerPadSurface() — lui seul
   sait quels pays sont accessibles ou quelles zones existent.

   ---------------------------------------------------------------------------
   Le mapping suivi est le « standard mapping » du navigateur, celui que Chrome,
   Edge et Firefox exposent pour une manette Xbox. Sur un pad non reconnu
   (mapping vide), on s'en tient aux axes 0/1 et aux boutons 0/1/2 : ça reste
   jouable sans prétendre deviner le reste.
*/

const DEAD = 0.24;          // zone morte du stick — les Xbox dérivent facilement
const MENU_REPEAT_FIRST = 0.42; // s avant la première répétition d'une direction
const MENU_REPEAT_NEXT = 0.14;  // s entre répétitions suivantes

const BTN = { A: 0, B: 1, X: 2, Y: 3, LB: 4, RB: 5, LT: 6, RT: 7, VIEW: 8, MENU: 9,
  LS: 10, RS: 11, UP: 12, DOWN: 13, LEFT: 14, RIGHT: 15 };

let hooks = null;
let prev = [];              // état des boutons à la frame précédente
let menuRepeatT = 0;
let menuLastDir = 0;        // 0 = repos, sinon code direction (1..4)
let focusEl = null;
let padSeen = false;        // une manette a-t-elle déjà bougé ? (pour l'UI)
let padHeldInput = false;

function isPlaystationPad(g) {
  if (!g || !g.id) return false;
  return /054c|playstation|dualshock|dualsense|wireless controller|sony/i.test(g.id);
}

function pads() {
  const list = navigator.getGamepads ? navigator.getGamepads() : [];
  const out = [];
  for (const g of list) if (g && g.connected) out.push(g);
  return out;
}

/** Sélectionne la manette active en ignorant les sous-périphériques Bluetooth muets (capteur de mouvement PS4/PS5). */
function getActivePad() {
  const list = pads();
  if (!list.length) return null;

  // 1. Manette avec une touche actuellement enfoncée ou un stick incliné
  for (const g of list) {
    if (!g) continue;
    if (g.buttons) {
      for (let i = 0; i < g.buttons.length; i++) {
        if (pressed(g, i)) return g;
      }
    }
    if (g.axes) {
      for (let a = 0; a < g.axes.length; a++) {
        if (Math.abs(g.axes[a] || 0) > DEAD) return g;
      }
    }
  }

  // 2. Sinon, première manette avec au moins 8 boutons valides
  const valid = list.find(g => g && g.buttons && g.buttons.length >= 8);
  return valid || list[0];
}

function pressed(g, i) {
  const b = g.buttons[i];
  if (!b) return false;
  return typeof b === 'object' ? (b.pressed || b.value > 0.5) : b > 0.5;
}

/** Front montant : vrai uniquement à la frame où le bouton vient d'être enfoncé. */
function justPressed(g, i) {
  const now = pressed(g, i);
  const was = !!prev[i];
  return now && !was;
}

function rumble(g, ms = 90, strong = 0.25, weak = 0.15) {
  try {
    const act = g.vibrationActuator;
    if (act && act.playEffect) {
      act.playEffect('dual-rumble', {
        startDelay: 0, duration: ms, strongMagnitude: strong, weakMagnitude: weak,
      });
    }
  } catch { /* la vibration n'est jamais essentielle */ }
}

function applyDead(v) {
  const a = Math.abs(v);
  if (a < DEAD) return 0;
  // remise à l'échelle : on retrouve toute la course utile après la zone morte
  return Math.sign(v) * ((a - DEAD) / (1 - DEAD));
}

/** Direction cardinale dominante d'une paire d'axes, ou 0 au repos. */
function cardinal(dx, dy) {
  if (Math.abs(dy) > Math.abs(dx)) return dy < -0.5 ? 1 : (dy > 0.5 ? 2 : 0);
  return dx < -0.5 ? 3 : (dx > 0.5 ? 4 : 0);
}

const DIR_VEC = { 1: [0, -1], 2: [0, 1], 3: [-1, 0], 4: [1, 0] };

/**
 * Direction du pad avec auto-répétition, commune à tous les contextes de
 * navigation. Retourne 0, ou un code 1..4 (haut/bas/gauche/droite) uniquement à
 * la frame où il faut bouger d'un cran.
 *
 * Pourquoi c'est mutualisé : sans répétition, tenir le stick ne fait avancer
 * que d'un cran et il faut le relâcher entre chaque élément — insupportable sur
 * une grille de 26 lettres.
 */
function steppedDir(g, dt, dpadOnly = false) {
  let dx = dpadOnly ? 0 : applyDead(g.axes[0] || 0);
  let dy = dpadOnly ? 0 : applyDead(g.axes[1] || 0);
  if (pressed(g, BTN.LEFT)) dx = -1;
  if (pressed(g, BTN.RIGHT)) dx = 1;
  if (pressed(g, BTN.UP)) dy = -1;
  if (pressed(g, BTN.DOWN)) dy = 1;

  const dir = cardinal(dx, dy);
  if (!dir) { menuLastDir = 0; menuRepeatT = 0; return 0; }
  menuRepeatT -= dt;
  if (dir !== menuLastDir || menuRepeatT <= 0) {
    const first = dir !== menuLastDir;
    menuLastDir = dir;
    menuRepeatT = first ? MENU_REPEAT_FIRST : MENU_REPEAT_NEXT;
    return dir;
  }
  return 0;
}

/* ============================================================================
   Surfaces : navigation fournie par l'écran lui-même

   Le globe et la carte des zones dessinent leurs cibles dans un canvas. Aucun
   élément focusable, donc rien à parcourir pour le pad — et lui seul ne peut
   pas savoir quel pays est accessible depuis les terres du joueur. C'est donc
   l'écran qui publie sa navigation ici, et qui la retire en se fermant.

   Une surface : { el, step(dir), pick(), zoom(k), label }
     el    — élément visible tant que la surface est active (sert de test)
     step  — déplace la sélection d'un cran (dir : 1 haut, 2 bas, 3 gauche, 4 droite)
     pick  — valide la sélection courante
     zoom  — optionnel, k = +1 / -1
     label — nom court pour la barre d'aide
========================================================================== */
const surfaces = new Map();

export function registerPadSurface(name, api) { surfaces.set(name, api); }

/** `api` sert de garde d'identité : une carte qui se ferme après qu'une autre
 *  ait déjà pris sa place ne doit pas désinscrire la nouvelle. */
export function unregisterPadSurface(name, api) {
  if (api && surfaces.get(name) !== api) return;
  surfaces.delete(name);
}

/* Test de visibilité.
   Surtout PAS `offsetParent !== null` : la spec rend offsetParent nul pour tout
   élément en position:fixed, et c'est le cas de chaque .overlay du jeu. Ce test
   déclarait donc invisibles tous les écrans de menu, et la navigation au pad n'y
   a jamais fonctionné — le focus n'était simplement jamais posé.
   getClientRects() est vide pour display:none (et pour toute sa descendance),
   ce qui est exactement le critère voulu, position quelconque. */
function visible(el) {
  if (!el || el.classList.contains('hidden')) return false;
  if (!el.getClientRects().length) return false;
  const cs = window.getComputedStyle(el);
  return cs.visibility !== 'hidden' && cs.opacity !== '0';
}

/** La surface active, s'il y en a une réellement au premier plan.
 *
 *  Deux précautions, chacune pour un bug constaté :
 *  · on parcourt à l'envers, car la carte d'un pays se monte APRÈS le globe et
 *    le recouvre alors que le canvas du globe reste visible dessous ;
 *  · on exige onTop(), car le canvas du globe reste visible sous le créateur de
 *    campagne. Sans ce test, ouvrir le créateur laissait le pad piloter le globe
 *    caché derrière : les champs de nom étaient inatteignables, donc la campagne
 *    impossible à créer à la manette — exactement ce qu'on cherche à corriger. */
function activeSurface() {
  const list = [...surfaces.values()];
  for (let i = list.length - 1; i >= 0; i--) {
    const s = list[i];
    if (visible(s.el) && onTop(s.el)) return s;
  }
  return null;
}

/* ---------- navigation de menu (overlays DOM) ---------- */

/** Le conteneur qui a le focus visuel : la dernière overlay visible du document,
 *  ou la modale ouverte à l'intérieur si elle existe. */
/** Vrai si `el` est réellement au-dessus de la pile en son propre centre.
 *  On délègue au hit-testing du navigateur : c'est la seule autorité qui tienne.
 *  Comparer les z-index à la main ne marche pas ici — les overlays du jeu ne
 *  sont pas sœurs (le créateur de campagne vit DANS l'écran de progression), et
 *  un z-index ne se compare qu'entre éléments d'un même contexte d'empilement.
 *  À l'essai, l'écran-titre (z-index 20) « gagnait » contre le créateur ouvert
 *  par-dessus lui, dont le z-index vaut auto. */
function onTop(el) {
  const r = el.getBoundingClientRect();
  const x = Math.round(r.left + r.width / 2);
  const y = Math.round(r.top + r.height / 2);
  if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) return false;
  const hit = document.elementFromPoint(x, y);
  return !!hit && (el === hit || el.contains(hit));
}

/* Racines navigables.
   `#prog` — l'écran de progression (globe, pays, compétences) — n'est PAS une
   .overlay. Sans lui dans cette liste, l'ouvrir depuis le Hub laissait le pad
   sans prise : ni surface enregistrée, ni menu, donc retour au mapping de marche
   et personnage promené derrière l'écran, sans aucune sortie. Le lister garantit
   qu'un écran affiché est toujours navigable, même si la carte qu'il contient
   n'a pas (ou plus) publié sa propre navigation. */
const ROOT_SELECTOR = '.overlay, #prog';

function activeRoot() {
  const overlays = [...document.querySelectorAll(ROOT_SELECTOR)].filter(visible);
  if (!overlays.length) return null;
  /* Parmi les overlays visibles, celles effectivement au premier plan ; à
     plusieurs, la dernière du document. Repli sur l'ordre du document si
     aucune ne passe le test (overlay en pointer-events:none, par exemple). */
  const top = overlays.filter(onTop);
  const root = (top.length ? top : overlays)[(top.length ? top : overlays).length - 1];
  const modal = [...root.querySelectorAll('.lobby-modal')].find(visible);
  return modal || root;
}

function candidates(root) {
  return [...root.querySelectorAll('button, [role="button"], input, select')]
    .filter(el => !el.disabled && visible(el));
}

function setFocus(el) {
  if (focusEl === el) return;
  if (focusEl) focusEl.classList.remove('gp-focus');
  focusEl = el || null;
  if (focusEl) {
    focusEl.classList.add('gp-focus');
    try { focusEl.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } catch { /* vieux navigateur */ }
  }
}

/**
 * Pose le curseur du pad sur un élément précis.
 *
 * Nécessaire dès qu'une liste se redessine : `replaceChildren()` détruit
 * l'élément focalisé, et la navigation, ne le retrouvant plus, repart du
 * premier bouton venu. Un écran qui se reconstruit doit donc dire lui-même où
 * le curseur atterrit — il est le seul à savoir ce que l'utilisateur suivait.
 *
 * Sans effet si le pad n'a jamais servi : on ne fait pas apparaître un curseur
 * de manette chez quelqu'un qui joue à la souris.
 */
export function setPadFocus(el) {
  if (!el || !focusEl) return;
  setFocus(el);
}

/**
 * Voisin le plus proche dans la direction demandée (dx,dy : un seul non nul).
 *
 * Le score se calcule sur les RECTANGLES, pas sur les centres. La version par
 * centres, avec une pénalité latérale linéaire, se faisait battre par tout
 * élément lointain mais parfaitement aligné : dans le panneau multijoueur,
 * « bas » depuis « Créer un salon » sautait par-dessus le champ de code et la
 * touche « Rejoindre » pour atterrir sur « Retour », centré comme le premier.
 * Le champ de code devenait littéralement inaccessible au pad.
 *
 * Deux mesures, celles qu'utilisent les navigateurs pour leur navigation
 * spatiale : la distance de BORD à bord dans l'axe, et le CHEVAUCHEMENT sur
 * l'axe perpendiculaire. Se chevaucher, c'est être « juste en dessous » ; le
 * décalage ne coûte quelque chose que s'il n'y a aucun recouvrement.
 */
function moveFocus(list, dx, dy) {
  if (!list.length) return;
  if (!focusEl || !list.includes(focusEl)) { setFocus(list[0]); return; }
  const fr = focusEl.getBoundingClientRect();
  let best = null, bestScore = Infinity;
  for (const el of list) {
    if (el === focusEl) continue;
    const r = el.getBoundingClientRect();

    let along, overlap;
    if (dy) {
      along = dy > 0 ? r.top - fr.bottom : fr.top - r.bottom;
      overlap = Math.min(fr.right, r.right) - Math.max(fr.left, r.left);
    } else {
      along = dx > 0 ? r.left - fr.right : fr.left - r.right;
      overlap = Math.min(fr.bottom, r.bottom) - Math.max(fr.top, r.top);
    }
    /* Tolérance négative : deux éléments d'une même ligne se chevauchent un peu
       dans l'axe, il ne faut pas pour autant les déclarer « derrière ». */
    const slack = -0.5 * Math.min(dy ? fr.height : fr.width, dy ? r.height : r.width);
    if (along < slack) continue;

    const off = overlap > 0 ? 0 : -overlap;
    const score = Math.max(along, 0) + off * 2.0;
    if (score < bestScore) { bestScore = score; best = el; }
  }
  if (best) setFocus(best);
}

/** Beaucoup de boutons du jeu n'écoutent que 'pointerdown' (latence tactile) :
 *  on émet donc pointerdown + click pour couvrir les deux styles. */
function activate(el) {
  if (!el) return;
  try {
    el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerId: 9999, pointerType: 'mouse' }));
    el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, pointerId: 9999, pointerType: 'mouse' }));
  } catch { /* PointerEvent absent : le click suffira */ }
  el.click();
}

/* Retour : on cherche un bouton d'annulation VISIBLE, par motif de texte puis
   par classe. L'ancienne version se reposait sur une liste d'identifiants figée
   — chaque nouvel écran repartait sans touche B, et le bug ne se voyait qu'au
   pad. Un motif couvre aussi les écrans à venir. */
const BACK_RE = /^(retour|annuler|fermer|quitter|non|plus tard|×|✕|✖)\b/i;

function findBackButton(root) {
  const list = candidates(root).filter(el => el.tagName === 'BUTTON' || el.getAttribute('role') === 'button');
  const byText = list.find(el => BACK_RE.test((el.textContent || '').trim()));
  if (byText) return byText;
  const byClass = list.find(el => /close|cancel|back|leave|secondary-btn/.test(el.className));
  return byClass || null;
}

function menuBack(root) {
  const el = findBackButton(root);
  if (el) activate(el);
}

/** Bouton ✕ du salon — quitter vers le menu d'accueil (après confirmation). */
function lobbyLeaveTarget(root) {
  if (!root) return null;
  const leave = root.querySelector('#btn-lobby-leave');
  return visible(leave) ? leave : null;
}

/* Carrousels (choix du leader, pages du lobby) : LB / RB sont le geste attendu
   sur une manette. Sans ça il faut viser deux petites flèches perdues dans la
   page, ce qui annule tout l'intérêt du pad. */
function shoulderTargets(root) {
  const prevBtn = root.querySelector('#creator-leader-prev, .carousel-prev, [data-carousel="prev"]');
  const nextBtn = root.querySelector('#creator-leader-next, .carousel-next, [data-carousel="next"]');
  if (visible(prevBtn) || visible(nextBtn)) return { prev: prevBtn, next: nextBtn };
  /* Repli : les flèches du jeu portent « ‹ » et « › » sans classe dédiée. */
  const arrows = candidates(root).filter(el => /^[‹›<>◀▶]$/.test((el.textContent || '').trim()));
  if (arrows.length >= 2) return { prev: arrows[0], next: arrows[1] };
  return null;
}

/** Flèches du salon : changer de joueur vedette. Les gâchettes (LT/RT, L2/R2)
 *  sont le geste naturel — LB/RB restent pour les carrousels de contenu. */
function lobbySlotTargets(root) {
  const prev = root.querySelector('#lobby-slot-prev');
  const next = root.querySelector('#lobby-slot-next');
  if (visible(prev) || visible(next)) return { prev, next };
  return null;
}

function tickMenu(g, dt) {
  const root = activeRoot();
  /* Aucun ecran de menu a l'ecran : on efface l'aide plutot que de laisser la
     derniere barre affichee, qui annoncerait des commandes sans effet. */
  if (!root) { setFocus(null); setHints('none'); return; }

  const list = candidates(root);
  if (!list.length) { setFocus(null); setHints('none'); return; }
  if (focusEl && !list.includes(focusEl)) setFocus(null);
  if (!focusEl) setFocus(list[0]);

  // après setFocus : le libellé de A dépend de ce qui est sélectionné
  setHints('menu', root, g);

  const dir = steppedDir(g, dt);
  if (dir) { const [dx, dy] = DIR_VEC[dir]; moveFocus(list, dx, dy); }

  const shoulders = shoulderTargets(root);
  if (shoulders) {
    if (justPressed(g, BTN.LB) && shoulders.prev) activate(shoulders.prev);
    if (justPressed(g, BTN.RB) && shoulders.next) activate(shoulders.next);
  }

  const lobbySlots = lobbySlotTargets(root);
  if (lobbySlots) {
    if (justPressed(g, BTN.LT) && lobbySlots.prev) {
      activate(lobbySlots.prev); rumble(g, 50, 0.12, 0.08);
    }
    if (justPressed(g, BTN.RT) && lobbySlots.next) {
      activate(lobbySlots.next); rumble(g, 50, 0.12, 0.08);
    }
  }

  /* R3 : cycle rapide Proche → Standard → Éloignée (même réglage que le menu). */
  if (justPressed(g, BTN.RS) && hooks.onCycleCam) {
    hooks.onCycleCam();
    rumble(g, 45, 0.1, 0.08);
  }

  if (justPressed(g, BTN.MENU) || justPressed(g, BTN.VIEW)) {
    if (hooks.onPause && root && root.id === 'pause-modal') {
      hooks.onPause();
      rumble(g, 60, 0.15, 0.1);
      return;
    }
  }

  if (justPressed(g, BTN.A)) {
    rumble(g, 60, 0.15, 0.1);
    /* Un champ texte ne s'« active » pas : au pad, le valider veut dire ouvrir
       le clavier virtuel. Sans ça, la campagne est infranchissable — le nom du
       prophète est obligatoire et rien ne permet de le saisir. */
    if (focusEl && isTextField(focusEl)) openKeyboard(focusEl);
    else activate(focusEl);
  } else if (justPressed(g, BTN.B)) {
    if (root && root.id === 'pause-modal' && hooks.onPause) {
      hooks.onPause();
      rumble(g, 60, 0.15, 0.1);
    } else {
      menuBack(root);
    }
  } else if (justPressed(g, BTN.X) && lobbyLeaveTarget(root)) {
    /* Salon : Carré (PS) / X (Xbox) = même sortie que B → confirmation puis
       menu d'accueil. Ailleurs X reste libre. */
    rumble(g, 60, 0.15, 0.1);
    activate(lobbyLeaveTarget(root));
  }
}

/* ---------- navigation d'une surface canvas (globe, carte des zones) ---------- */

function tickSurface(g, dt, s) {
  setFocus(null);
  /* Stick = vue libre, D-pad = cible suivante. Les deux gestes coexistent parce
     qu'ils répondent à deux besoins distincts : regarder la carte, et choisir où
     aller. Confondus sur le même axe, l'un des deux disparaissait — et c'est la
     vue libre qui manquait, alors qu'en début de campagne un seul pays est
     jouable et que le saut de sélection n'a donc aucune cible. */
  if (s.pan) {
    const px = applyDead(g.axes[0] || 0);
    const py = applyDead(g.axes[1] || 0);
    if (px || py) s.pan(px, py, dt);
  }
  const dir = steppedDir(g, dt, !!s.pan);
  if (dir) s.step(dir);
  if (justPressed(g, BTN.A)) { rumble(g, 60, 0.18, 0.12); s.pick(); }
  else if (justPressed(g, BTN.B)) {
    const root = activeRoot();
    if (root) menuBack(root);
  }
  if (s.zoom) {
    if (justPressed(g, BTN.RT) || justPressed(g, BTN.RB)) s.zoom(1);
    if (justPressed(g, BTN.LT) || justPressed(g, BTN.LB)) s.zoom(-1);
  }
}

/* ============================================================================
   Clavier virtuel

   Obligatoire pour prétendre au « 100 % pad » : le créateur de campagne exige
   un nom de prophète et un nom de religion, et le bouton de lancement reste
   inerte tant qu'ils sont vides. Sans clavier, une manette seule ne peut
   littéralement pas commencer une partie.

   Volontairement sobre : une grille de lettres, pas de prédiction ni de
   ponctuation exotique. Ce champ reçoit des noms propres, pas de la prose.
========================================================================== */
const KEY_ROWS = [
  ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'],
  ['A', 'Z', 'E', 'R', 'T', 'Y', 'U', 'I', 'O', 'P'],
  ['Q', 'S', 'D', 'F', 'G', 'H', 'J', 'K', 'L', 'M'],
  ['W', 'X', 'C', 'V', 'B', 'N', "'", '-', 'É', 'È'],
];

let osk = null;   // { el, target, cells, row, col, caps }

function isTextField(el) {
  return el && el.tagName === 'INPUT'
    && !['button', 'checkbox', 'radio', 'range', 'submit'].includes((el.type || 'text').toLowerCase());
}

function buildKeyboard() {
  const el = document.createElement('div');
  el.id = 'gp-osk';
  el.className = 'gp-osk hidden';
  el.innerHTML = `
    <div class="gp-osk-head">
      <span class="gp-osk-label"></span>
      <span class="gp-osk-value"></span>
    </div>
    <div class="gp-osk-grid"></div>
    <div class="gp-osk-legend"></div>`;
  const grid = el.querySelector('.gp-osk-grid');
  const cells = [];
  KEY_ROWS.forEach((row, r) => {
    const rowEl = document.createElement('div');
    rowEl.className = 'gp-osk-row';
    cells[r] = [];
    row.forEach((ch, c) => {
      const k = document.createElement('span');
      k.className = 'gp-osk-key';
      k.textContent = ch;
      rowEl.appendChild(k);
      cells[r][c] = { el: k, ch };
    });
    grid.appendChild(rowEl);
  });
  document.body.appendChild(el);
  return { el, cells };
}

function openKeyboard(target) {
  if (!osk) {
    const built = buildKeyboard();
    osk = { el: built.el, cells: built.cells, target: null, row: 1, col: 0, caps: true };
  }
  osk.target = target;
  /* Un champ déclaré autocapitalize="characters" — le code de salon — attend une
     valeur en capitales. Le champ l'AFFICHE déjà en majuscules via CSS, mais
     text-transform ne touche pas la valeur : sans ce verrou, on tapait « Aze »
     tout en lisant « AZE » à l'écran, et le salon rejoignait un code erroné. */
  osk.lockCaps = (target.getAttribute('autocapitalize') || '').toLowerCase() === 'characters';
  osk.caps = true;
  osk.el.classList.remove('hidden');
  osk.el.querySelector('.gp-osk-label').textContent =
    target.getAttribute('placeholder') || target.getAttribute('aria-label') || 'Saisie';
  osk.el.querySelector('.gp-osk-legend').innerHTML = hintHTML([
    ['A', 'Taper'], ['X', 'Effacer'], ['Y', 'Espace'], ['LB', 'Maj'], ['MENU', 'Valider'], ['B', 'Fermer'],
  ]);
  refreshKeyboard();
}

function closeKeyboard() {
  if (!osk) return;
  osk.el.classList.add('hidden');
  osk.target = null;
}

function refreshKeyboard() {
  if (!osk || !osk.target) return;
  osk.el.querySelector('.gp-osk-value').textContent = osk.target.value || '…';
  for (let r = 0; r < osk.cells.length; r++) {
    for (let c = 0; c < osk.cells[r].length; c++) {
      const cell = osk.cells[r][c];
      cell.el.textContent = osk.caps ? cell.ch : cell.ch.toLowerCase();
      cell.el.classList.toggle('sel', r === osk.row && c === osk.col);
    }
  }
}

/** Écrit dans le champ en prévenant l'application : beaucoup d'écrans écoutent
 *  'input' pour activer leur bouton de validation. */
function typeInto(target, next) {
  const max = parseInt(target.getAttribute('maxlength') || '0', 10);
  if (max > 0 && next.length > max) return;
  target.value = next;
  target.dispatchEvent(new Event('input', { bubbles: true }));
  target.dispatchEvent(new Event('change', { bubbles: true }));
}

function tickKeyboard(g, dt) {
  const t = osk.target;
  if (!visible(t)) { closeKeyboard(); return; }

  const dir = steppedDir(g, dt);
  if (dir === 1) osk.row = (osk.row - 1 + osk.cells.length) % osk.cells.length;
  else if (dir === 2) osk.row = (osk.row + 1) % osk.cells.length;
  else if (dir === 3) osk.col = (osk.col - 1 + osk.cells[osk.row].length) % osk.cells[osk.row].length;
  else if (dir === 4) osk.col = (osk.col + 1) % osk.cells[osk.row].length;

  if (justPressed(g, BTN.A)) {
    const cell = osk.cells[osk.row][osk.col];
    typeInto(t, (t.value || '') + (osk.caps ? cell.ch : cell.ch.toLowerCase()));
    /* Majuscule automatique sur la première lettre seulement : on saisit des
       noms propres, et laisser CAPS actif donnerait « JEAN LE CONQUÉRANT ». */
    if (osk.caps && !osk.lockCaps && t.value.length > 0) osk.caps = false;
    rumble(g, 30, 0.1, 0.05);
  } else if (justPressed(g, BTN.X)) {
    typeInto(t, (t.value || '').slice(0, -1));
  } else if (justPressed(g, BTN.Y)) {
    typeInto(t, (t.value || '') + ' ');
  } else if (justPressed(g, BTN.LB)) {
    if (!osk.lockCaps) osk.caps = !osk.caps;
  } else if (justPressed(g, BTN.MENU) || justPressed(g, BTN.RB)) {
    closeKeyboard(); return;
  } else if (justPressed(g, BTN.B)) {
    closeKeyboard(); return;
  }
  refreshKeyboard();
}

/* Libellés et couleurs officielles des pastilles Xbox / Playstation. */
const GLYPH_XBOX = {
  A: { txt: 'A', cls: 'a' }, B: { txt: 'B', cls: 'b' },
  X: { txt: 'X', cls: 'x' }, Y: { txt: 'Y', cls: 'y' },
  LB: { txt: 'LB', cls: 'bump' }, RB: { txt: 'RB', cls: 'bump' },
  LT: { txt: 'LT', cls: 'bump' }, RT: { txt: 'RT', cls: 'bump' },
  MENU: { txt: '≡', cls: 'sys' }, VIEW: { txt: '⧉', cls: 'sys' },
  STICK: { txt: 'L', cls: 'stick' }, RS: { txt: 'R3', cls: 'stick' },
  DPAD: { txt: '✥', cls: 'stick' },
};

const GLYPH_PS = {
  A: { txt: '✕', cls: 'ps-cross' }, B: { txt: '◯', cls: 'ps-circle' },
  X: { txt: '□', cls: 'ps-square' }, Y: { txt: 'Δ', cls: 'ps-triangle' },
  LB: { txt: 'L1', cls: 'bump' }, RB: { txt: 'R1', cls: 'bump' },
  LT: { txt: 'L2', cls: 'bump' }, RT: { txt: 'R2', cls: 'bump' },
  MENU: { txt: 'Options', cls: 'sys' }, VIEW: { txt: 'Share', cls: 'sys' },
  STICK: { txt: 'L', cls: 'stick' }, RS: { txt: 'R3', cls: 'stick' },
  DPAD: { txt: '✥', cls: 'stick' },
};

function hintHTML(pairs, g) {
  const isPS = isPlaystationPad(g);
  const map = isPS ? GLYPH_PS : GLYPH_XBOX;
  return pairs.map(([key, label]) => {
    const gl = map[key] || { txt: key, cls: 'bump' };
    return `<span class="gp-hint"><b class="gp-glyph gp-${gl.cls}">${gl.txt}</b>${label}</span>`;
  }).join('');
}

const HINTS = {
  play: [['STICK', 'Déplacer'], ['X', 'Attaquer'], ['A', 'Élan'], ['RS', 'Vue'], ['MENU', 'Pause']],
  overworld: [['STICK', 'Déplacer'], ['A', 'Élan'], ['X', 'Interagir'], ['RS', 'Vue']],
  keyboard: null,   // sa propre légende est déjà dans le panneau
};

/* Les hints de menu dépendent de l'écran : annoncer « B Retour » là où aucun
   bouton d'annulation n'existe, ou « LB/RB » sans carrousel, apprend au joueur
   des commandes qui ne répondent pas — pire que pas d'aide du tout. */
function menuHints(root) {
  const pairs = [['DPAD', 'Naviguer']];
  pairs.push(focusEl && isTextField(focusEl) ? ['A', 'Saisir'] : ['A', 'Valider']);
  if (lobbyLeaveTarget(root)) {
    pairs.push(['B', 'Quitter'], ['X', 'Quitter']);
  } else if (findBackButton(root)) {
    pairs.push(['B', 'Retour']);
  }
  if (lobbySlotTargets(root)) pairs.push(['LT', 'Joueur −'], ['RT', 'Joueur +']);
  if (shoulderTargets(root)) pairs.push(['LB', 'Précédent'], ['RB', 'Suivant']);
  if (hooks.onCycleCam) pairs.push(['RS', 'Vue']);
  return pairs;
}

let hintBar = null;
let hintKey = '';

function setHints(ctx, surface, g) {
  if (!hintBar) {
    hintBar = document.createElement('div');
    hintBar.id = 'gp-hints';
    hintBar.className = 'gp-hints';
    document.body.appendChild(hintBar);
  }
  let pairs;
  if (ctx === 'surface') {
    pairs = [];
    if (surface && surface.pan) pairs.push(['STICK', surface.panLabel || 'Vue']);
    pairs.push(['DPAD', surface?.label || 'Choisir'], ['A', surface?.pickLabel || 'Valider'], ['B', 'Retour']);
    if (surface && surface.zoom) pairs.push(['LT', 'Zoom −'], ['RT', 'Zoom +']);
  } else if (ctx === 'menu') {
    pairs = menuHints(surface);   // `surface` porte la racine de l'écran ici
  } else {
    pairs = HINTS[ctx];
  }
  const isPS = isPlaystationPad(g);
  const key = ctx + '|' + (isPS ? 'ps' : 'xb') + '|' + (pairs ? pairs.map(p => p.join()).join('|') : '');
  if (key === hintKey) return;
  hintKey = key;
  if (!pairs) { hintBar.classList.add('hidden'); return; }
  hintBar.innerHTML = hintHTML(pairs, g);
  hintBar.classList.remove('hidden');
}

/* ---------- jeu ---------- */

function tickPlay(g, isHub) {
  let x = applyDead(g.axes[0] || 0);
  let z = applyDead(g.axes[1] || 0);
  if (pressed(g, BTN.LEFT)) x = -1;
  if (pressed(g, BTN.RIGHT)) x = 1;
  if (pressed(g, BTN.UP)) z = -1;
  if (pressed(g, BTN.DOWN)) z = 1;

  const len = Math.hypot(x, z);
  if (len > 1) { x /= len; z /= len; }

  /* Le joystick tactile garde la priorité s'il est en cours d'utilisation :
     sinon un pad au repos remettrait l'entrée à zéro à chaque frame. */
  if (!hooks.isTouchActive()) {
    if (len > 0) { hooks.input.x = x; hooks.input.z = z; padHeldInput = true; }
    else if (padHeldInput) { hooks.input.x = 0; hooks.input.z = 0; padHeldInput = false; }
  }

  if (justPressed(g, BTN.MENU) || justPressed(g, BTN.VIEW)) {
    if (hooks.onPause) { hooks.onPause(); rumble(g, 60, 0.2, 0.1); return; }
  }

  if (justPressed(g, BTN.RS) && hooks.onCycleCam) {
    hooks.onCycleCam();
    rumble(g, 45, 0.1, 0.08);
  }

  if (justPressed(g, BTN.A) || justPressed(g, BTN.RB)) { hooks.onBoost(); rumble(g, 120, 0.35, 0.2); }

  if (isHub) {
    // X est libre dans le Hub (rien à attaquer) : l'interaction s'y installe.
    if (justPressed(g, BTN.X) || justPressed(g, BTN.RT)) {
      hooks.onInteract(); rumble(g, 70, 0.2, 0.12);
    }
    return;
  }

  if (justPressed(g, BTN.X) || justPressed(g, BTN.RT)) { if (hooks.onAttack()) rumble(g, 80, 0.5, 0.25); }
}

/* ---------- API ---------- */

/**
 * @param {object} h
 *   input        {x,z} objet d'entrée partagé avec main.js (muté en place)
 *   getState     () => 'menu' | 'play' | 'overworld' | 'over'
 *   isTouchActive() => bool  — joystick tactile en cours ?
 *   onBoost      () => void
 *   onAttack     () => bool  — vrai si le tir est parti
 *   onInteract   () => void  — valider le portail / l'autel du Hub
 */
export function initGamepad(h) {
  hooks = h;
  addEventListener('gamepadconnected', (e) => {
    padSeen = true;
    document.body.classList.add('has-gamepad');
    console.log('[gamepad] connecté :', e.gamepad && e.gamepad.id);
  });
  addEventListener('gamepaddisconnected', () => {
    if (!pads().length) {
      document.body.classList.remove('has-gamepad');
      if (hintBar) { hintBar.classList.add('hidden'); hintKey = ''; }
      closeKeyboard();
    }
    setFocus(null);
  });
}

/** À appeler une fois par frame. */
export function pollGamepad(dt) {
  if (!hooks) return;
  const g = getActivePad();
  if (!g) {
    prev = [];
    if (focusEl) setFocus(null);
    if (hintBar && !hintBar.classList.contains('hidden')) { hintBar.classList.add('hidden'); hintKey = ''; }
    return;
  }
  if (!padSeen) { padSeen = true; document.body.classList.add('has-gamepad'); }

  /* Choix du contexte.
     Il se décide sur CE QUI EST À L'ÉCRAN, pas seulement sur l'état du jeu.
     C'est la leçon d'un blocage net : ouvrir le Grand Portail depuis le Hub
     affiche le globe par-dessus, mais laisse `state` à 'overworld'. En se fiant
     au seul état, le pad gardait le mapping de marche et pilotait un personnage
     invisible derrière la carte — le globe devenait impossible à utiliser, sans
     aucune issue.

     Priorités, de la plus modale à la plus permissive :
       1. clavier virtuel — modal ; laisser le menu réagir dessous validerait un
          bouton en même temps qu'on tape une lettre ;
       2. surface canvas au premier plan (globe, carte des zones) ;
        3. overlay de menu au premier plan ;
       4. sinon, le monde marchable de l'état courant. */
  const state = hooks.getState();
  const walkable = state === 'play' || state === 'overworld';

  if (osk && osk.target) { setHints('keyboard', null, g); tickKeyboard(g, dt); }
  else {
    const s = activeSurface();
    const root = activeRoot();
    if (s) { setHints('surface', s, g); tickSurface(g, dt, s); }
    else if (root && (!walkable || onTop(root))) tickMenu(g, dt);   // publie ses propres hints
    else if (walkable) {
      setFocus(null);
      const hub = state === 'overworld';
      setHints(hub ? 'overworld' : 'play', null, g);
      tickPlay(g, hub);
    } else tickMenu(g, dt);
  }

  // mémoriser l'état des boutons pour les fronts montants de la frame suivante
  prev = g.buttons.map(b => (typeof b === 'object' ? (b.pressed || b.value > 0.5) : b > 0.5));
}
