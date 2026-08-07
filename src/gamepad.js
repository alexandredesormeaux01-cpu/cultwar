/* ============================== Manette (Xbox / Gamepad API) ==============================
   Un seul module, branché en deux points de main.js :
     · initGamepad(hooks)  — une fois au démarrage ;
     · pollGamepad(dt)     — une fois par frame, avant la simulation.

   En jeu   : stick gauche (ou D-pad) = déplacement, A = sprint, X / RT = attaquer.
   En menu  : stick/D-pad = déplacer la sélection, A = valider, B = retour.

   Le mapping suivi est le « standard mapping » du navigateur, celui que Chrome,
   Edge et Firefox exposent pour une manette Xbox. Sur un pad non reconnu
   (mapping vide), on s'en tient aux axes 0/1 et aux boutons 0/1/2 : ça reste
   jouable sans prétendre deviner le reste.
*/

const DEAD = 0.24;          // zone morte du stick — les Xbox dérivent facilement
const MENU_REPEAT_FIRST = 0.42; // s avant la première répétition d'une direction
const MENU_REPEAT_NEXT = 0.14;  // s entre répétitions suivantes

const BTN = { A: 0, B: 1, X: 2, Y: 3, LB: 4, RB: 5, LT: 6, RT: 7, BACK: 8, START: 9,
  UP: 12, DOWN: 13, LEFT: 14, RIGHT: 15 };

const BACK_BUTTON_IDS = ['lobby-modal-close', 'btn-delete-cancel', 'btn-multi-back',
  'btn-lobby-leave', 'btn-end-back', 'btn-end-lobby'];

let hooks = null;
let prev = [];              // état des boutons à la frame précédente
let menuRepeatT = 0;
let menuLastDir = 0;        // 0 = repos, sinon code direction (1..4)
let focusEl = null;
let padSeen = false;        // une manette a-t-elle déjà bougé ? (pour l'UI)

/* ---------- utilitaires ---------- */

function pads() {
  const list = navigator.getGamepads ? navigator.getGamepads() : [];
  const out = [];
  for (const g of list) if (g && g.connected) out.push(g);
  return out;
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

/* ---------- navigation de menu ---------- */

/** Le conteneur qui a le focus visuel : la dernière overlay visible du document,
 *  ou la modale ouverte à l'intérieur si elle existe. */
function activeRoot() {
  const overlays = [...document.querySelectorAll('.overlay')]
    .filter(el => !el.classList.contains('hidden') && el.offsetParent !== null);
  if (!overlays.length) return null;
  const root = overlays[overlays.length - 1];
  const modal = [...root.querySelectorAll('.lobby-modal')]
    .find(el => !el.classList.contains('hidden') && el.offsetParent !== null);
  return modal || root;
}

function candidates(root) {
  return [...root.querySelectorAll('button, [role="button"], input, select')]
    .filter(el => !el.disabled && !el.classList.contains('hidden') && el.offsetParent !== null);
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

function center(el) {
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

/** Voisin le plus proche dans la direction demandée (dx,dz normalisés grossiers). */
function moveFocus(list, dx, dy) {
  if (!list.length) return;
  if (!focusEl || !list.includes(focusEl)) { setFocus(list[0]); return; }
  const from = center(focusEl);
  let best = null, bestScore = Infinity;
  for (const el of list) {
    if (el === focusEl) continue;
    const c = center(el);
    const ox = c.x - from.x, oy = c.y - from.y;
    const along = ox * dx + oy * dy;            // avance dans la direction voulue
    if (along <= 4) continue;                    // derrière ou à côté : ignoré
    const off = Math.abs(ox * -dy + oy * dx);    // écart latéral
    const score = along + off * 2.2;             // on préfère aligné avant proche
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

function menuBack(root) {
  for (const id of BACK_BUTTON_IDS) {
    const el = root.querySelector('#' + id) || document.getElementById(id);
    if (el && !el.classList.contains('hidden') && el.offsetParent !== null) { activate(el); return; }
  }
}

function tickMenu(g, dt) {
  const root = activeRoot();
  if (!root) { setFocus(null); return; }

  const list = candidates(root);
  if (!list.length) { setFocus(null); return; }
  if (focusEl && !list.includes(focusEl)) setFocus(null);
  if (!focusEl) setFocus(list[0]);

  let dx = applyDead(g.axes[0] || 0);
  let dy = applyDead(g.axes[1] || 0);
  if (pressed(g, BTN.LEFT)) dx = -1;
  if (pressed(g, BTN.RIGHT)) dx = 1;
  if (pressed(g, BTN.UP)) dy = -1;
  if (pressed(g, BTN.DOWN)) dy = 1;

  let dir = 0;
  if (Math.abs(dy) > Math.abs(dx)) dir = dy < -0.5 ? 1 : (dy > 0.5 ? 2 : 0);
  else dir = dx < -0.5 ? 3 : (dx > 0.5 ? 4 : 0);

  if (!dir) { menuLastDir = 0; menuRepeatT = 0; }
  else {
    menuRepeatT -= dt;
    if (dir !== menuLastDir || menuRepeatT <= 0) {
      const first = dir !== menuLastDir;
      menuLastDir = dir;
      menuRepeatT = first ? MENU_REPEAT_FIRST : MENU_REPEAT_NEXT;
      if (dir === 1) moveFocus(list, 0, -1);
      else if (dir === 2) moveFocus(list, 0, 1);
      else if (dir === 3) moveFocus(list, -1, 0);
      else moveFocus(list, 1, 0);
    }
  }

  if (justPressed(g, BTN.A) || justPressed(g, BTN.START)) { rumble(g, 60, 0.15, 0.1); activate(focusEl); }
  else if (justPressed(g, BTN.B)) menuBack(root);
}

/* ---------- jeu ---------- */

function tickPlay(g) {
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

  if (justPressed(g, BTN.A) || justPressed(g, BTN.RB)) { hooks.onBoost(); rumble(g, 120, 0.35, 0.2); }
  if (justPressed(g, BTN.X) || justPressed(g, BTN.RT)) { if (hooks.onAttack()) rumble(g, 80, 0.5, 0.25); }
}

let padHeldInput = false;

/* ---------- API ---------- */

/**
 * @param {object} h
 *   input        {x,z} objet d'entrée partagé avec main.js (muté en place)
 *   getState     () => 'menu' | 'play' | ...
 *   isTouchActive() => bool  — joystick tactile en cours ?
 *   onBoost      () => void
 *   onAttack     () => bool  — vrai si le tir est parti
 */
export function initGamepad(h) {
  hooks = h;
  addEventListener('gamepadconnected', (e) => {
    padSeen = true;
    document.body.classList.add('has-gamepad');
    console.log('[gamepad] connecté :', e.gamepad && e.gamepad.id);
  });
  addEventListener('gamepaddisconnected', () => {
    if (!pads().length) document.body.classList.remove('has-gamepad');
    setFocus(null);
  });
}

/** À appeler une fois par frame. */
export function pollGamepad(dt) {
  if (!hooks) return;
  const list = pads();
  if (!list.length) { prev = []; if (focusEl) setFocus(null); return; }
  const g = list[0];
  if (!padSeen) { padSeen = true; document.body.classList.add('has-gamepad'); }

  if (hooks.getState() === 'play') { setFocus(null); tickPlay(g); }
  else tickMenu(g, dt);

  // mémoriser l'état des boutons pour les fronts montants de la frame suivante
  prev = g.buttons.map(b => (typeof b === 'object' ? (b.pressed || b.value > 0.5) : b > 0.5));
}
