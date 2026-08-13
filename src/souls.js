/* -- Le portage des âmes (GDD §10.5) --

   Quatre emplacements, une âme maximum par type, sélection à la croix.

   Trois règles portent tout, et elles se répondent :

   1. **Personne ne sait combien tu portes.** L'aura dit « il a quelque chose »,
      jamais combien. C'est la première information cachée de la carte : on
      poursuit quelqu'un sans savoir ce qu'on va gagner.
   2. **À la mort, une âme TIRÉE AU SORT tombe** — les autres éclatent en
      lumière et retournent au monde des esprits. Le tirage est délibéré : on
      ne choisit pas ce qu'on perd, donc porter une âme précieuse est risqué
      quoi qu'on fasse, et il n'existe aucune façon de se couvrir.

      Cette règle a d'abord fait tomber l'âme SÉLECTIONNÉE. C'était plus fin —
      se déplacer avec sa moins précieuse en main devenait un réflexe de bon
      joueur — mais ça offrait une assurance : bien joué, on ne perdait jamais
      rien de cher. Le tirage au sort supprime l'assurance et rend la règle 3
      mordante. La sélection ne sert donc plus qu'au dépôt sur un autel.
   3. **Thésauriser est irrationnel.** Quatre âmes sur soi, c'est trois qui
      partent en fumée au premier contact. Le jeu pousse à dépenser vite —
      prendre, placer, repartir — et la carte reste en mouvement sans qu'aucune
      règle anti-camping n'ait été écrite. */

import * as THREE from 'three';
import { SOULS } from './pillars.js';

export const TUNE_SOULS = {
  dropPickR: 2.2,      // rayon de ramassage d'une âme au sol
  dropLifetime: 14,    // au-delà, elle remonte d'elle-même au monde des esprits
  dropSelfLock: 1.4,   // délai avant que celui qui l'a lâchée puisse la reprendre
  auraR: 1.5,
};

/* -- Inventaires --
   UN SAC PAR FACTION, pas un sac unique. Les bots jouent exactement au même jeu
   que le joueur : mêmes quatre emplacements, même unicité par type, mêmes
   pertes à la mort. Tout ce qu'on équilibre pour l'un vaut donc pour les
   autres, et il n'y a jamais deux jeux de règles à maintenir.

   `held[i]` = true si l'on porte une âme du type SOULS[i]. Un seul exemplaire
   par type : la rareté fait toute la tension, et ça garde le HUD lisible. */
const bags = [];

function newBag() {
  return { held: SOULS.map(() => false), selected: 0 };
}

/** Sac d'une faction, créé à la demande. */
export function bagOf(fi) {
  if (!bags[fi]) bags[fi] = newBag();
  return bags[fi];
}

export function heldCount(fi) {
  return bagOf(fi).held.reduce((n, h) => n + (h ? 1 : 0), 0);
}
export function hasSoul(fi, i) { return !!bagOf(fi).held[i]; }
export function carryingAnything(fi) { return heldCount(fi) > 0; }
/** Type actuellement sélectionné, ou -1 si l'emplacement est vide. */
export function selectedSoul(fi) {
  const b = bagOf(fi);
  return b.held[b.selected] ? b.selected : -1;
}
/** Indices des âmes réellement portées. */
export function heldList(fi) {
  const out = [];
  const b = bagOf(fi);
  for (let i = 0; i < SOULS.length; i++) if (b.held[i]) out.push(i);
  return out;
}

export function resetSouls() {
  bags.length = 0;
  for (const d of dropped) d.grp.parent?.remove(d.grp);
  dropped.length = 0;
  refreshHud();
}

/** Ajoute une âme. Échoue si on porte déjà ce type — d'où le retour booléen,
 *  que l'appelant utilise pour ne PAS consommer le pilier. */
export function addSoul(fi, i) {
  const b = bagOf(fi);
  if (i < 0 || i >= SOULS.length || b.held[i]) return false;
  b.held[i] = true;
  /* On sélectionne ce qu'on vient de ramasser : c'est presque toujours ce
     qu'on va poser, et ça évite un aller-retour dans le HUD. */
  b.selected = i;
  if (fi === 0) refreshHud();
  return true;
}

/** Sélectionne un emplacement, plein ou vide (on peut viser un vide exprès :
 *  c'est la façon de ne RIEN risquer de précieux en se déplaçant). */
export function selectSlot(fi, i) {
  if (i < 0 || i >= SOULS.length) return false;
  bagOf(fi).selected = i;
  if (fi === 0) refreshHud();
  return true;
}

/** Fait tomber une âme tirée au sort et disperse les autres.
 *  @returns {{drop:number, scattered:number[]}} `drop` = -1 si l'on ne portait
 *  rien ; `scattered` = tout le reste, qui éclate en lumière. */
export function loseAllOnDeath(fi) {
  const b = bagOf(fi);
  const held = [];
  for (let i = 0; i < SOULS.length; i++) if (b.held[i]) held.push(i);

  /* Le tirage porte sur ce qu'on possède RÉELLEMENT, pas sur les quatre types :
     tirer parmi les quatre puis vérifier ferait tomber « rien » la plupart du
     temps, et un porteur mourrait sans rien lâcher. */
  const drop = held.length ? held[(Math.random() * held.length) | 0] : -1;
  const scattered = held.filter((i) => i !== drop);

  for (const i of held) b.held[i] = false;
  if (fi === 0) refreshHud();
  return { drop, scattered };
}

/** Retire l'âme du slot `i` — dépôt volontaire sur un autel. */
export function takeSoul(fi, i) {
  const b = bagOf(fi);
  if (i < 0 || i >= SOULS.length || !b.held[i]) return false;
  b.held[i] = false;
  if (fi === 0) refreshHud();
  return true;
}

/* ============================ Âmes au sol ============================
   Une âme lâchée est un objet MATÉRIEL : visible et ramassable dans les deux
   formes. Sans ça, un rival resté en chair ne pourrait jamais toucher son
   butin, et tuer un porteur ne rapporterait rien à personne. */

const dropped = [];
const DROP_GEO = new THREE.OctahedronGeometry(0.34, 0);
const DROP_GLOW_GEO = new THREE.CircleGeometry(1.0, 18);

/** Lâche une âme au sol. `owner` ne pourra pas la reprendre tout de suite. */
export function dropSoulAt(scene, soulIdx, x, y, z, owner = -1) {
  const soul = SOULS[soulIdx];
  if (!soul) return null;
  const grp = new THREE.Group();
  const core = new THREE.Mesh(DROP_GEO, new THREE.MeshBasicMaterial({
    color: soul.col, toneMapped: false, fog: false,
  }));
  core.position.y = 0.75;
  grp.add(core);
  const glow = new THREE.Mesh(DROP_GLOW_GEO, new THREE.MeshBasicMaterial({
    color: soul.col, transparent: true, opacity: 0.4,
    blending: THREE.AdditiveBlending, depthWrite: false,
    toneMapped: false, fog: false,
  }));
  glow.rotation.x = -Math.PI / 2;
  glow.position.y = 0.06;
  grp.add(glow);
  grp.position.set(x, y, z);
  scene.add(grp);
  dropped.push({ grp, core, glow, soulIdx, x, z, t: 0, owner });
  return dropped[dropped.length - 1];
}

export function getDropped() { return dropped; }

/** Toutes les factions ramassent, pas seulement le joueur : une âme au sol est
 *  le meilleur butin de la carte, et un bot qui passerait à côté sans la voir
 *  ne jouerait pas au même jeu.
 *  @param {{claimants:Array<{fi:number,x:number,z:number}>, elapsed:number,
 *           onPick:(i:number,fi:number)=>void, onExpire:(i:number)=>void}} s */
export function updateDroppedSouls(dt, s) {
  for (let k = dropped.length - 1; k >= 0; k--) {
    const d = dropped[k];
    d.t += dt;
    /* Elle tourne et flotte : un objet immobile au sol se confond avec le
       décor, et celui-ci doit s'apercevoir depuis l'autre bout de la mêlée. */
    d.core.rotation.y = s.elapsed * 2.2;
    d.core.position.y = 0.75 + Math.sin(s.elapsed * 3.1 + d.x) * 0.14;
    const fade = Math.min(1, (TUNE_SOULS.dropLifetime - d.t) / 2.5);
    d.core.material.opacity = fade;
    d.core.material.transparent = fade < 1;
    d.glow.material.opacity = 0.4 * fade;

    if (d.t >= TUNE_SOULS.dropLifetime) {
      /* Personne n'est venu : elle remonte au monde des esprits. Le plateau se
         nettoie tout seul et personne ne squatte un butin. */
      d.grp.parent?.remove(d.grp);
      dropped.splice(k, 1);
      s.onExpire?.(d.soulIdx);
      continue;
    }
    let taker = -1;
    for (const c of s.claimants) {
      /* Celui qui l'a lâchée ne peut pas la reprendre tout de suite : sinon la
         perte n'en est pas une, et le plus fort ramasse toujours son propre
         butin avant que quiconque n'arrive. */
      if (c.fi === d.owner && d.t < TUNE_SOULS.dropSelfLock) continue;
      if (Math.hypot(d.x - c.x, d.z - c.z) > TUNE_SOULS.dropPickR) continue;
      if (!addSoul(c.fi, d.soulIdx)) continue;   // porte déjà ce type : elle reste
      taker = c.fi;
      break;
    }
    if (taker < 0) continue;
    d.grp.parent?.remove(d.grp);
    dropped.splice(k, 1);
    s.onPick?.(d.soulIdx, taker);
  }
}

/* ============================ HUD ============================
   Quatre pastilles, une par type, dans l'ordre de la croix. Une pastille dit
   deux choses seulement : je l'ai ou non, et c'est elle qui est sélectionnée.
   Rien d'autre — le compte exact ne regarde que le joueur, et il le lit ici. */

function renderFlameIconSVG(cssColor, coreColor = '#ffffff') {
  const cleanHex = cssColor.replace('#', '');
  return `<svg viewBox="0 0 32 38" class="flame-icon-svg" style="filter: drop-shadow(0 0 6px ${cssColor});">
    <defs>
      <linearGradient id="flameGrad_${cleanHex}" x1="0%" y1="100%" x2="0%" y2="0%">
        <stop offset="0%" stop-color="${cssColor}" stop-opacity="0.9" />
        <stop offset="65%" stop-color="${cssColor}" stop-opacity="1" />
        <stop offset="100%" stop-color="${coreColor}" stop-opacity="0.95" />
      </linearGradient>
    </defs>
    <path d="M16 2 C16 2, 23 10, 24 17 C25 24, 22 31, 16 34 C10 31, 7 24, 8 17 C9 10, 16 2, 16 2 Z" fill="url(#flameGrad_${cleanHex})" />
    <path d="M16 10 C16 10, 20 16, 20 21 C20 26, 18 29, 16 30 C14 29, 12 26, 12 21 C12 16, 16 10, 16 10 Z" fill="${coreColor}" opacity="0.85" />
    <path d="M16 17 C16 17, 18 20, 18 23 C18 26, 17 27, 16 28 C15 27, 14 26, 14 23 C14 20, 16 17, 16 17 Z" fill="#ffffff" opacity="0.95" />
  </svg>`;
}

let _bar = null;
const _slots = [];
let _onSlotTap = null;

/** @param {(i:number)=>void} onSlotTap  sélection tactile */
export function initSoulsHud(onSlotTap) {
  _onSlotTap = onSlotTap;
  if (_bar) return;
  const style = document.createElement('style');
  style.textContent = `
#souls-bar{position:fixed;left:50%;top:150px;transform:translateX(-50%);
  display:flex;gap:10px;z-index:42;pointer-events:auto}
#souls-bar .slot{width:48px;height:48px;border-radius:14px;position:relative;
  display:flex;align-items:center;justify-content:center;cursor:pointer;
  background:rgba(8,12,28,.65);border:1.5px solid rgba(255,255,255,.18);
  backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);
  box-shadow:0 4px 16px rgba(0,0,0,.5);
  transition:transform .15s cubic-bezier(0.34,1.56,0.64,1),box-shadow .2s ease,border-color .2s ease}
#souls-bar .slot .sym{display:flex;align-items:center;justify-content:center;
  width:26px;height:30px;opacity:.3;transition:opacity .2s ease,transform .2s ease}
.flame-icon-svg{width:100%;height:100%;display:block}
#souls-bar .slot .key{position:absolute;bottom:3px;right:6px;font-size:9px;
  font-family:Cinzel,sans-serif;font-weight:800;opacity:.45;color:#fff;
  text-shadow:0 1px 2px #000}
/* Portée : la pastille s'allume de la couleur de son âme. */
#souls-bar .slot.has{background:rgba(8,12,28,.85);border-color:color-mix(in srgb, var(--soul-color, #fff) 50%, transparent)}
#souls-bar .slot.has .sym{opacity:1}
#souls-bar .slot.has:hover{transform:translateY(-2px) scale(1.04)}
/* Sélectionnée : la flamme resplendit */
#souls-bar .slot.sel{transform:translateY(-4px) scale(1.08);
  border-color:var(--soul-color, #fff);
  box-shadow:0 0 0 2px rgba(255,255,255,.6),0 0 18px var(--soul-color, rgba(180,220,255,.75))}
#souls-bar .slot.sel .sym{opacity:1;transform:scale(1.12)}
@media (max-width:720px){#souls-bar{top:132px;gap:7px}
  #souls-bar .slot{width:40px;height:40px;border-radius:12px}
  #souls-bar .slot .sym{width:22px;height:26px}}`;
  document.head.appendChild(style);

  _bar = document.createElement('div');
  _bar.id = 'souls-bar';
  const KEYS = ['1', '2', '3', '4'];
  for (let i = 0; i < SOULS.length; i++) {
    const el = document.createElement('div');
    el.className = 'slot';
    el.title = SOULS[i].nom;
    const css = SOULS[i].css || `#${SOULS[i].col.toString(16).padStart(6, '0')}`;
    const core = SOULS[i].core || '#ffffff';
    el.style.setProperty('--soul-color', css);
    const sym = document.createElement('span');
    sym.className = 'sym';
    sym.innerHTML = renderFlameIconSVG(css, core);
    const key = document.createElement('span');
    key.className = 'key';
    key.textContent = KEYS[i] || '';
    el.append(sym, key);
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault(); e.stopPropagation();
      _onSlotTap?.(i);
    });
    _bar.appendChild(el);
    _slots.push(el);
  }
  document.body.appendChild(_bar);
  refreshHud();
}

export function setSoulsHudVisible(on) {
  if (_bar) _bar.style.display = on ? 'flex' : 'none';
}

/* Le HUD ne montre QUE le sac du joueur local : ce que portent les rivaux est
   l'information cachée du jeu, elle ne doit apparaître nulle part. */
function refreshHud() {
  const b = bagOf(0);
  for (let i = 0; i < _slots.length; i++) {
    _slots[i].classList.toggle('has', !!b.held[i]);
    _slots[i].classList.toggle('sel', b.selected === i);
  }
}

/* ==================== Panneau de dépôt sur un autel ====================
   Il n'apparaît qu'à portée d'un autel, et ne montre QUE les âmes qu'on porte
   et qu'on peut y poser. C'est un choix, pas un menu : une tuile, un geste,
   c'est fait.

   Deux façons de choisir selon le support, la même disposition dans les deux
   cas — les quatre types gardent toujours leur place, donc le geste devient un
   réflexe :
     · tactile / souris : on touche la tuile ;
     · manette : on presse la direction de la croix dessinée sur la tuile. */
const PAD_GLYPH = ['▲', '▶', '▼', '◀'];

let _panel = null;
const _panelTiles = [];
let _onDeposit = null;

export function initAltarPanel(onDeposit) {
  _onDeposit = onDeposit;
  if (_panel) return;
  const style = document.createElement('style');
  style.textContent = `
#altar-panel{position:fixed;right:16px;top:50%;transform:translateY(-50%);
  display:none;flex-direction:column;gap:10px;z-index:44;pointer-events:auto}
#altar-panel.on{display:flex}
#altar-panel .hdr{font:800 10px/1.2 system-ui,sans-serif;letter-spacing:1px;
  text-transform:uppercase;color:rgba(220,235,255,.75);text-align:center;
  text-shadow:0 1px 3px #000}
#altar-panel .tile{width:62px;height:62px;border-radius:16px;position:relative;
  display:flex;align-items:center;justify-content:center;cursor:pointer;
  background:rgba(8,12,28,.72);border:1px solid rgba(255,255,255,.2);
  backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);
  box-shadow:0 4px 18px rgba(0,0,0,.45);
  animation:apIn .18s ease both}
#altar-panel .tile:active{transform:scale(.92)}
#altar-panel .tile .sym{display:flex;align-items:center;justify-content:center;width:32px;height:36px}
/* Pastille de direction : n'a de sens qu'avec une manette branchée. */
#altar-panel .tile .pad{position:absolute;top:-6px;left:-6px;width:22px;height:22px;
  border-radius:50%;display:none;align-items:center;justify-content:center;
  font-size:11px;font-weight:800;color:#0b1020;background:#dfe9ff;
  box-shadow:0 2px 6px rgba(0,0,0,.5)}
body.has-gamepad #altar-panel .tile .pad{display:flex}
@keyframes apIn{from{opacity:0;transform:translateX(14px)}to{opacity:1;transform:none}}
@media (max-width:720px){#altar-panel{right:10px;gap:8px}
  #altar-panel .tile{width:54px;height:54px;border-radius:14px}
  #altar-panel .tile .sym{width:26px;height:30px}}`;
  document.head.appendChild(style);

  _panel = document.createElement('div');
  _panel.id = 'altar-panel';
  const hdr = document.createElement('div');
  hdr.className = 'hdr';
  hdr.textContent = 'Donner une âme';
  _panel.appendChild(hdr);

  for (let i = 0; i < SOULS.length; i++) {
    const el = document.createElement('div');
    el.className = 'tile';
    const css = SOULS[i].css || `#${SOULS[i].col.toString(16).padStart(6, '0')}`;
    const core = SOULS[i].core || '#ffffff';
    el.innerHTML = `<span class="sym">${renderFlameIconSVG(css, core)}</span>`
      + `<span class="pad">${PAD_GLYPH[i]}</span>`;
    el.style.borderColor = css;
    el.title = SOULS[i].nom;
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault(); e.stopPropagation();
      _onDeposit?.(i);
    });
    _panel.appendChild(el);
    _panelTiles.push(el);
  }
  document.body.appendChild(_panel);
}

/** @param {(i:number)=>boolean|null} canDeposit  null = aucun autel à portée */
export function updateAltarPanel(canDeposit) {
  if (!_panel) return;
  let any = false;
  for (let i = 0; i < _panelTiles.length; i++) {
    const ok = !!canDeposit && canDeposit(i);
    _panelTiles[i].style.display = ok ? 'flex' : 'none';
    if (ok) any = true;
  }
  _panel.classList.toggle('on', any);
}
