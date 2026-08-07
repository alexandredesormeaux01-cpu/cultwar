/* ============================================================================
   Panneau de développement — réglage à chaud
   ---------------------------------------------------------------------------
   Chercher une direction artistique en recompilant à chaque essai est
   intenable : entre deux valeurs proches, la comparaison se perd dans le temps
   de rebuild. Ce panneau déplace tout en direct, retient les réglages d'une
   session à l'autre, et rend les constantes à recopier quand on a trouvé.

   Ce module ne sait RIEN du jeu. main.js lui décrit des groupes de contrôles —
   un libellé, des bornes, un lecteur, un écrivain — et le panneau se construit
   tout seul. Ajouter un réglage ne demande donc jamais de toucher ici.

   Chargé par import dynamique sous `import.meta.env.DEV` : absent du build de
   production, y compris ce fichier.
   ========================================================================== */

const CSS = `
.devp{position:fixed;top:8px;right:8px;z-index:9999;width:290px;max-height:calc(100vh - 16px);
 display:flex;flex-direction:column;font:11px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;
 color:#e8ecf4;background:rgba(14,17,26,.93);border:1px solid rgba(255,255,255,.16);
 border-radius:10px;box-shadow:0 8px 28px rgba(0,0,0,.5);backdrop-filter:blur(8px);}
.devp.closed .devp-body{display:none}
.devp-head{display:flex;align-items:center;gap:6px;padding:7px 9px;cursor:pointer;
 border-bottom:1px solid rgba(255,255,255,.12);user-select:none;flex:0 0 auto}
.devp-head b{font-size:11px;letter-spacing:.5px;flex:1}
.devp-head span{opacity:.5;font-size:10px}
.devp-body{overflow-y:auto;padding:4px 0 8px}
.devp-grp{padding:6px 9px 2px}
.devp-grp>h4{font-size:10px;text-transform:uppercase;letter-spacing:.7px;opacity:.55;
 margin:2px 0 5px;font-weight:700}
.devp-row{display:flex;align-items:center;gap:6px;margin:3px 0}
.devp-row label{flex:0 0 82px;opacity:.8;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.devp-row input[type=range]{flex:1;min-width:0;height:16px;accent-color:#a78bfa;margin:0}
.devp-row output{flex:0 0 42px;text-align:right;font-variant-numeric:tabular-nums;opacity:.95}
.devp-row select,.devp-row input[type=color]{flex:1;min-width:0;background:#1b2030;color:#e8ecf4;
 border:1px solid rgba(255,255,255,.18);border-radius:5px;padding:2px 4px;font:inherit}
.devp-row input[type=color]{height:20px;padding:0}
.devp-acts{display:flex;flex-wrap:wrap;gap:5px;padding:7px 9px 2px;
 border-top:1px solid rgba(255,255,255,.12);margin-top:4px}
.devp-acts button{flex:1 1 auto;background:#252c40;color:#e8ecf4;border:1px solid rgba(255,255,255,.18);
 border-radius:5px;padding:4px 7px;font:inherit;cursor:pointer}
.devp-acts button:hover{background:#31394f}
.devp-acts button.wide{flex-basis:100%}
.devp-note{padding:5px 9px 0;opacity:.5;font-size:10px}
`;

/**
 * @param {object} spec
 * @param {Array}  spec.groups   [{ title, controls: [...] }]
 *   contrôle glissière : { key, label, min, max, step, get, set }
 *   contrôle liste     : { key, label, options: [...], get, set }
 *   contrôle couleur   : { key, label, color: true, get, set }   (get → '#rrggbb')
 * @param {Array}  spec.actions  [{ label, run, wide? }]
 * @param {string} spec.storageKey  clé localStorage des réglages retenus
 * @param {string} spec.hotkey      touche de bascule (défaut 'F9')
 */
export function createDevPanel(spec) {
  const { groups = [], actions = [], storageKey = 'cultio_devpanel', hotkey = 'F9' } = spec;

  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.appendChild(style);

  const root = document.createElement('div');
  root.className = 'devp closed';

  const head = document.createElement('div');
  head.className = 'devp-head';
  head.innerHTML = `<b>⚙ DEV</b><span>${hotkey}</span>`;
  root.appendChild(head);

  const body = document.createElement('div');
  body.className = 'devp-body';
  root.appendChild(body);

  /* Tous les contrôles à plat : sert à la sauvegarde et à la relecture. */
  const all = [];

  for (const g of groups) {
    const box = document.createElement('div');
    box.className = 'devp-grp';
    const h = document.createElement('h4');
    h.textContent = g.title;
    box.appendChild(h);

    for (const c of g.controls) {
      const row = document.createElement('div');
      row.className = 'devp-row';
      const lab = document.createElement('label');
      lab.textContent = c.label;
      lab.title = c.label;
      row.appendChild(lab);

      let input, out = null;
      if (c.options) {
        input = document.createElement('select');
        for (const o of c.options) {
          const opt = document.createElement('option');
          opt.value = o; opt.textContent = o;
          input.appendChild(opt);
        }
        input.value = c.get();
        input.oninput = () => { c.set(input.value); save(); };
      } else if (c.color) {
        input = document.createElement('input');
        input.type = 'color';
        input.value = c.get();
        input.oninput = () => { c.set(input.value); save(); };
      } else {
        input = document.createElement('input');
        input.type = 'range';
        input.min = c.min; input.max = c.max; input.step = c.step ?? 0.01;
        input.value = c.get();
        out = document.createElement('output');
        out.textContent = fmt(c.get(), c.step);
        input.oninput = () => {
          const v = parseFloat(input.value);
          c.set(v);
          out.textContent = fmt(v, c.step);
          save();
        };
      }
      row.appendChild(input);
      if (out) row.appendChild(out);
      box.appendChild(row);
      all.push({ c, input, out });
    }
    body.appendChild(box);
  }

  if (actions.length) {
    const acts = document.createElement('div');
    acts.className = 'devp-acts';
    for (const a of actions) {
      const b = document.createElement('button');
      b.textContent = a.label;
      if (a.wide) b.className = 'wide';
      b.onclick = (e) => { e.stopPropagation(); a.run(refresh); };
      acts.appendChild(b);
    }
    body.appendChild(acts);
  }

  const note = document.createElement('div');
  note.className = 'devp-note';
  note.textContent = 'Réglages retenus entre deux rechargements.';
  body.appendChild(note);

  document.body.appendChild(root);

  /* ---- Persistance ----
     Sans elle, un rechargement — fréquent quand on itère — effacerait tout le
     travail de réglage. On ne stocke que les valeurs des contrôles, jamais
     l'état du jeu. */
  function save() {
    const data = {};
    for (const { c } of all) data[c.key] = c.get();
    try { localStorage.setItem(storageKey, JSON.stringify(data)); } catch (_) { /* quota */ }
  }

  function restore() {
    let data;
    try { data = JSON.parse(localStorage.getItem(storageKey) || 'null'); } catch (_) { return; }
    if (!data) return;
    for (const { c } of all) {
      if (data[c.key] === undefined) continue;
      try { c.set(data[c.key]); } catch (_) { /* contrôle disparu depuis */ }
    }
  }

  /** Relit les valeurs vivantes vers les widgets (après une action externe). */
  function refresh() {
    for (const { c, input, out } of all) {
      const v = c.get();
      input.value = v;
      if (out) out.textContent = fmt(v, c.step);
    }
  }

  function fmt(v, step) {
    if (typeof v !== 'number') return String(v);
    const d = (step ?? 0.01) >= 1 ? 0 : (step ?? 0.01) >= 0.1 ? 1 : 2;
    return v.toFixed(d);
  }

  const toggle = () => root.classList.toggle('closed');
  head.onclick = toggle;
  window.addEventListener('keydown', (e) => {
    if (e.key === hotkey) { e.preventDefault(); toggle(); }
  });

  restore();
  refresh();

  return { refresh, toggle, save, el: root };
}
