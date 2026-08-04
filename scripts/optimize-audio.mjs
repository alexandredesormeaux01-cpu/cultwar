/* ============================================================================
   Optimisation des bruitages — rognage des silences + ré-encodage
   ----------------------------------------------------------------------------
   Les sons de sorts sortent de leur banque en 8,04 s à 256 kbps stéréo, soit
   251 Ko pièce, alors que l'effet utile dure une seconde ou deux : le reste
   est du silence de remplissage. Neuf fichiers = 2,26 Mo dans l'APK pour
   quelques secondes de son.

   Deux passes :
     1. `silencedetect` MESURE où le son commence et finit. On coupe sur des
        bornes constatées, jamais devinées — un `silenceremove` appliqué à
        l'aveugle mange les attaques douces et les queues de réverbération,
        et c'est précisément ce qui donne du corps à un sort.
     2. Ré-encodage mono 64 kbps. Le jeu n'a aucune spatialisation stéréo :
        la moitié des octets servait à dupliquer un canal.

   Une marge est conservée de chaque côté pour ne pas tronquer l'attaque ni
   couper net la réverbération.

   Usage : node scripts/optimize-audio.mjs [--dry] [motif]
   ========================================================================== */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import ffmpeg from 'ffmpeg-static';

const DRY = process.argv.includes('--dry');
const DIR = 'public/assets';
const THRESH = '-45dB';    // en dessous, on considère que c'est du silence
const PAD_IN = 0.03;       // marge avant l'attaque (s)
const PAD_OUT = 0.25;      // marge après la dernière crête : la réverbération
const BITRATE = '64k';

const targets = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const files = (targets.length ? targets : fs.readdirSync(DIR).filter((f) => /^sfx_.*\.mp3$/.test(f)))
  .map((f) => (f.includes('/') || f.includes('\\') ? f : path.join(DIR, f)));

/* ffmpeg écrit ses diagnostics sur stderr et sort en 0 : spawnSync est le seul
   moyen d'obtenir les deux flux sans dépendre d'une exception. */
const run = (args) => {
  const r = spawnSync(ffmpeg, args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  if (r.error) throw r.error;
  return { out: r.stdout || '', err: r.stderr || '', code: r.status };
};

/** Bornes du son utile, mesurées par silencedetect. */
function measure(file) {
  const { err } = run(['-hide_banner', '-i', file, '-af', `silencedetect=noise=${THRESH}:d=0.08`, '-f', 'null', '-']);

  const d = /Duration: (\d+):(\d+):([\d.]+)/.exec(err);
  const dur = d ? (+d[1]) * 3600 + (+d[2]) * 60 + parseFloat(d[3]) : 0;

  const starts = [...err.matchAll(/silence_start: ([\d.-]+)/g)].map((m) => parseFloat(m[1]));
  const ends = [...err.matchAll(/silence_end: ([\d.]+)/g)].map((m) => parseFloat(m[1]));

  /* Début utile : fin du premier silence, s'il démarre au tout début. */
  let from = 0;
  if (starts.length && starts[0] <= 0.05 && ends.length) from = Math.max(0, ends[0] - PAD_IN);

  /* Fin utile : début du dernier silence, à condition que ce silence aille
     jusqu'au bout du fichier.
     Attention : silencedetect ferme TOUJOURS la dernière plage par un
     silence_end à la durée totale, même quand le silence court jusqu'à la
     fin. Tester « pas de silence_end » ne détecte donc jamais rien — il faut
     comparer ce silence_end à la durée. */
  let to = dur;
  if (starts.length && ends.length) {
    const lastStart = starts[starts.length - 1];
    const lastEnd = ends[ends.length - 1];
    if (dur - lastEnd < 0.05 && lastStart > from) to = Math.min(dur, lastStart + PAD_OUT);
  }
  return { dur, from, to: Math.max(to, from + 0.15) };
}

let before = 0, after = 0, n = 0;
for (const file of files) {
  if (!fs.existsSync(file)) { console.log(`  absent : ${file}`); continue; }
  const sizeBefore = fs.statSync(file).size;
  const m = measure(file);
  const out = file.replace(/\.mp3$/, '.opt.mp3');

  /* `-t` (durée) plutôt que `-to` (instant) : selon sa position, `-to` se
     compte depuis le début du fichier ou depuis le point de départ, et la
     règle a changé entre les versions de ffmpeg. Une durée ne souffre
     d'aucune ambiguïté. */
  /* -1,5 dB de marge avant encodage. Un ré-encodage MP3 dépasse légèrement le
     niveau d'origine (le codec « déborde » sur les transitoires) : sans cette
     réserve, plusieurs bruitages ressortaient collés à 0 dB, donc écrêtés.
     La perte de volume est inaudible, l'écrêtage ne l'est pas. */
  const enc = run([
    '-hide_banner', '-y',
    '-ss', m.from.toFixed(3), '-i', file, '-t', (m.to - m.from).toFixed(3),
    '-af', 'volume=-1.5dB',
    '-ac', '1', '-b:a', BITRATE, '-ar', '44100',
    out,
  ]);
  if (enc.code !== 0 || !fs.existsSync(out)) {
    console.log(`  ÉCHEC ${path.basename(file)} : ${enc.err.split('\n').slice(-3).join(' ')}`);
    continue;
  }

  const sizeAfter = fs.statSync(out).size;
  before += sizeBefore; after += sizeAfter; n++;
  console.log(`  ${path.basename(file).padEnd(26)} ${m.dur.toFixed(2)}s → ${(m.to - m.from).toFixed(2)}s   `
    + `${(sizeBefore / 1024).toFixed(0)} Ko → ${(sizeAfter / 1024).toFixed(0)} Ko`);

  if (DRY) fs.unlinkSync(out);
  else { fs.unlinkSync(file); fs.renameSync(out, file); }
}

console.log(`\n${n} bruitages : ${(before / 1024 / 1024).toFixed(2)} Mo → ${(after / 1024 / 1024).toFixed(2)} Mo`
  + (DRY ? '  (simulation)' : ''));
