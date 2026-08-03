/* Détecte les identifiants référencés mais jamais déclarés.

   Ce contrôle existe parce qu'une suppression de code par expression régulière
   a emporté au passage une déclaration encore utilisée (`netBtnEl`), et que le
   symptôme — un écran figé sans message — coûte plusieurs allers-retours à
   diagnostiquer. Le build ne voit rien : esbuild ne vérifie pas les globales.

   Il a aussi révélé `dayT`, une variable disparue de longue date qui levait une
   ReferenceError à chaque frame et coupait silencieusement la fin de update().

   Usage : node scripts/check-scope.mjs src/*.js src/sim/*.js
   Sortie non nulle si au moins un identifiant est introuvable. */
import * as acorn from 'acorn';
import * as walk from 'acorn-walk';
import fs from 'node:fs';

/* Globales du navigateur admises sans déclaration. */
const GLOBALS = new Set(['window', 'document', 'console', 'Math', 'JSON', 'Object', 'Array', 'String',
  'Number', 'Boolean', 'Date', 'Set', 'Map', 'WeakMap', 'WeakSet', 'Promise', 'Symbol', 'Error',
  'TypeError', 'RangeError', 'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'setTimeout',
  'clearTimeout', 'setInterval', 'clearInterval', 'requestAnimationFrame', 'cancelAnimationFrame',
  'localStorage', 'sessionStorage', 'navigator', 'location', 'fetch', 'performance', 'matchMedia',
  'addEventListener', 'removeEventListener', 'Float32Array', 'Float64Array', 'Uint8Array',
  'Uint8ClampedArray', 'Uint16Array', 'Uint32Array', 'Int8Array', 'Int16Array', 'Int32Array',
  'ArrayBuffer', 'DataView', 'Infinity', 'NaN', 'undefined', 'globalThis', 'structuredClone',
  'URL', 'URLSearchParams', 'Blob', 'FileReader', 'Image', 'Audio', 'AudioContext', 'CustomEvent',
  'Event', 'screen', 'history', 'alert', 'confirm', 'prompt', 'crypto', 'TextEncoder',
  'TextDecoder', 'Intl', 'Reflect', 'Proxy', 'BigInt', 'queueMicrotask', 'ResizeObserver',
  'WebSocket', 'RTCPeerConnection', 'btoa', 'atob', 'encodeURIComponent', 'decodeURIComponent',
  'Path2D', 'OffscreenCanvas', 'process',
  'innerWidth', 'innerHeight', 'devicePixelRatio', 'scrollX', 'scrollY', 'outerWidth', 'outerHeight']);

function check(file) {
  const src = fs.readFileSync(file, 'utf8');
  const ast = acorn.parse(src, { ecmaVersion: 'latest', sourceType: 'module', locations: true });

  const declared = new Set();
  const add = (n) => { if (n) declared.add(n); };
  const pat = (p) => {
    if (!p) return;
    if (p.type === 'Identifier') add(p.name);
    else if (p.type === 'ObjectPattern') p.properties.forEach((q) => pat(q.value || q.argument));
    else if (p.type === 'ArrayPattern') p.elements.forEach(pat);
    else if (p.type === 'AssignmentPattern') pat(p.left);
    else if (p.type === 'RestElement') pat(p.argument);
  };

  walk.full(ast, (n) => {
    if (n.type === 'VariableDeclarator') pat(n.id);
    else if (n.type === 'FunctionDeclaration' || n.type === 'ClassDeclaration') {
      add(n.id && n.id.name);
      (n.params || []).forEach(pat);
    } else if (n.type === 'FunctionExpression' || n.type === 'ArrowFunctionExpression') {
      add(n.id && n.id.name);
      n.params.forEach(pat);
    } else if (n.type === 'CatchClause') pat(n.param);
    else if (n.type === 'ImportSpecifier' || n.type === 'ImportDefaultSpecifier'
          || n.type === 'ImportNamespaceSpecifier') add(n.local.name);
    else if (n.type === 'LabeledStatement') add(n.label.name);
    else if ((n.type === 'ForInStatement' || n.type === 'ForOfStatement')
          && n.left.type === 'Identifier') add(n.left.name);
  });

  /* Un nom protégé quelque part par `typeof x !== 'undefined'` est une
     dépendance optionnelle assumée (crowd-tick tourne aussi côté serveur, sans
     les helpers du client) — pas un oubli. */
  walk.simple(ast, {
    UnaryExpression(n) {
      if (n.operator === 'typeof' && n.argument.type === 'Identifier') add(n.argument.name);
    },
  });

  const missing = new Map();
  walk.ancestor(ast, {
    Identifier(node, _st, anc) {
      const name = node.name;
      if (declared.has(name) || GLOBALS.has(name)) return;
      const parent = anc[anc.length - 2];
      if (!parent) return;
      /* On ignore ce qui n'est pas une référence de valeur : noms de propriété,
         clés d'objet, spécificateurs d'import. */
      if (parent.type === 'MemberExpression' && parent.property === node && !parent.computed) return;
      if (parent.type === 'Property' && parent.key === node && !parent.computed) return;
      if (parent.type === 'ImportSpecifier' || parent.type === 'ExportSpecifier') return;
      if (parent.type === 'MethodDefinition' || parent.type === 'PropertyDefinition') return;
      /* `typeof x !== 'undefined'` est une garde volontaire, pas un oubli. */
      if (parent.type === 'UnaryExpression' && parent.operator === 'typeof') return;
      if (!missing.has(name)) missing.set(name, node.loc.start.line);
    },
  });

  if (!missing.size) return 0;
  for (const [n, l] of [...missing].sort((a, b) => a[1] - b[1])) {
    console.log(`  ${file}:${l}  ${n}`);
  }
  return missing.size;
}

/* Sans argument on balaie src/ : le shell de npm sous Windows ne développe pas
   les jokers, donc on ne peut pas s'en remettre à `src/*.js`. */
function collect(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = `${dir}/${e.name}`;
    if (e.isDirectory()) collect(p, out);
    else if (e.name.endsWith('.js') || e.name.endsWith('.mjs')) out.push(p);
  }
  return out;
}

const files = process.argv.length > 2 ? process.argv.slice(2) : collect('src');
let bad = 0;
for (const f of files) bad += check(f);
if (bad) { console.log(`\n${bad} identifiant(s) jamais déclaré(s).`); process.exit(1); }
console.log(`${files.length} fichier(s) — aucun identifiant non déclaré.`);
