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

/* La musique n'a pas de filet : un fichier absent ne lève rien, l'Audio échoue
   en silence et la partie se joue sans bande-son. On vérifie donc que les deux
   morceaux référencés existent bel et bien sur le disque. */
console.log('\n== musique ==');
{
  const se = fs.readFileSync('src/soundEngine.js', 'utf8');
  const block = /const MUSIC = \{([\s\S]*?)\};/.exec(se);
  ok('le registre MUSIC est lisible', !!block);
  const refs = block ? [...block[1].matchAll(/asset\('([^']+)'\)/g)].map((m) => m[1]) : [];
  ok('deux morceaux déclarés', refs.length === 2);
  for (const r of refs) ok(`${r} présent`, fs.existsSync('public/assets/' + r));
  ok('plus aucune référence à l\'ancien thème', !se.includes('pocket_quest'));
}

console.log('\n== famille inconnue ==');
ok('rend null sans exploser', soundEngine.playSFXGroup('inexistant') === null);

/* La levée d'une statue de sanctuaire dure EXACTEMENT le temps du grondement.
   Hors navigateur — et sur mobile avant décodage — `duration` vaut NaN : si le
   repli ne tenait pas, l'animation durerait NaN seconde et la statue resterait
   enterrée pour toujours. C'est un bug muet, d'où ce test. */
console.log('\n== durée d\'un bruitage ==');
{
  ok('repli sur un son jamais joué', soundEngine.sfxDuration('earth_1', 1.4) === 1.4);
  ok('repli sur un son inexistant', soundEngine.sfxDuration('inexistant', 0.9) === 0.9);
  const d = soundEngine.sfxDuration('earth_1');
  ok('toujours un nombre fini et positif', Number.isFinite(d) && d > 0);
}

console.log(`\n${pass} réussis, ${fail} échoués`);
process.exit(fail ? 1 : 0);
