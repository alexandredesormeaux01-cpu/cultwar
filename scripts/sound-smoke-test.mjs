/* Vérifie le tirage des variantes sonores. Ce qui compte ici n'est pas
   qu'un son sorte — impossible à tester sans carte son — mais que :
     · chaque nom déclaré dans une famille existe bien dans SFX, sinon
       playSFX sort en silence et on cherche longtemps pourquoi ;
     · le fichier correspondant est présent dans public/assets ;
     · deux tirages consécutifs ne redonnent jamais la même variante, ce qui
       est toute la raison d'être de playSFXGroup. */

/* L'élément Audio n'existe pas en Node : on le remplace par un mouchard. */
const played = [];
globalThis.Audio = class {
  constructor(src) { this.src = src; this.volume = 1; this.currentTime = 0; this.playbackRate = 1; }
  play() { played.push(this.src); return Promise.resolve(); }
  pause() {}
  setAttribute() {}
  addEventListener() {}
  cloneNode() { return new globalThis.Audio(this.src); }
};

import fs from 'node:fs';
const { soundEngine } = await import('../src/soundEngine.js');

let pass = 0, fail = 0;
const ok = (label, cond) => { if (cond) { pass++; console.log('  ok  ' + label); } else { fail++; console.log('  ÉCHEC  ' + label); } };

const GROUPS = {
  fire: ['fire_1', 'fire_2', 'fire_3', 'fire_4', 'fire_5', 'fire_6'],
  earth: ['earth_1', 'earth_2', 'earth_3'],
};
const FILES = {
  fire: (i) => `public/assets/sfx_fire_${i}.mp3`,
  earth: (i) => `public/assets/sfx_earth_${i}.mp3`,
};

console.log('\n== fichiers présents ==');
for (const [group, names] of Object.entries(GROUPS)) {
  for (let i = 1; i <= names.length; i++) {
    ok(`${FILES[group](i).split('/').pop()}`, fs.existsSync(FILES[group](i)));
  }
}

console.log('\n== tirage des variantes ==');
soundEngine.isMuted = false;
for (const [group, names] of Object.entries(GROUPS)) {
  const seen = new Set();
  let repeats = 0, last = null;
  for (let i = 0; i < 400; i++) {
    const n = soundEngine.playSFXGroup(group, { volume: 0 });
    if (n === last) repeats++;
    last = n;
    seen.add(n);
  }
  ok(`${group} : toutes les variantes sortent (${seen.size}/${names.length})`, seen.size === names.length);
  ok(`${group} : aucun nom inconnu`, [...seen].every((n) => names.includes(n)));
  ok(`${group} : jamais deux fois de suite la même`, repeats === 0);
}

console.log('\n== famille inconnue ==');
ok('rend null sans exploser', soundEngine.playSFXGroup('inexistant') === null);

console.log(`\n${pass} réussis, ${fail} échoués`);
process.exit(fail ? 1 : 0);
