/* ============================================================================
   Relève le point noir de la texture d'un modèle .glb
   ---------------------------------------------------------------------------
   POURQUOI CE SCRIPT EXISTE

   Les textures des personnages ont été peintes du temps où le jeu rendait en
   cel-shading. Un aplat très sombre y passait : le modèle toon quantifie la
   lumière en quelques crans, et l'œil accepte un personnage presque noir comme
   un parti pris graphique.

   Le rendu PBR calcule `sortie = albédo × lumière`. Une texture dont la
   luminance moyenne est de 0,10 ne peut PAS être éclaircie par l'éclairage :
   il faudrait dix fois la lumière du décor pour l'amener au même niveau, et
   tout le reste de l'image serait cramé bien avant. Le personnage reste sombre
   quoi qu'on règle — ce n'est pas un défaut d'éclairage, c'est le fichier.

   D'où ce script : il remonte le plancher des textures concernées, sans toucher
   aux teintes ni aux hautes lumières.

   LA COURBE

       sortie = plancher + (1 - plancher) × entrée^gamma

   `plancher` est la valeur minimale de sortie : plus aucun pixel ne descend en
   dessous. `gamma` sous 1 relève les tons moyens et laisse le blanc à 1, ce qui
   évite d'aplatir le contraste — une simple addition, elle, délaverait tout.

   POURQUOI PAS DANS BLENDER

   Ce n'est pas un travail de modelage : ni la géométrie, ni les UV, ni le
   rig ne bougent. Passer par Blender demanderait de réexporter, donc de
   risquer des différences sur tout le reste du fichier. Ici seuls les octets
   de l'image changent, tout le reste du .glb est recopié à l'identique.

   USAGE
     node scripts/lift-model-texture.mjs --scan
       Mesure la luminance de tous les modèles, sans rien modifier.

     node scripts/lift-model-texture.mjs sorcerer_rigged [--floor=0.22] [--gamma=0.75]
       Corrige un modèle. L'original est sauvegardé en .glb.bak s'il n'existe pas
       déjà — donc rejouer le script ne détruit jamais la source d'origine.
   ========================================================================== */

import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

const MODELS_DIR = 'public/assets/models';
/* Voir le commentaire à la création des sauvegardes : hors de public/, sinon
   elles partent dans le build web et dans l'APK. */
const BACKUP_DIR = '.model-backups';
const GLB_MAGIC = 0x46546c67;
const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;

/** Découpe un .glb en { json, bin }. */
function readGlb(file) {
  const buf = fs.readFileSync(file);
  if (buf.readUInt32LE(0) !== GLB_MAGIC) throw new Error(`${file} n'est pas un .glb`);
  let off = 12, json = null, bin = null;
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32LE(off);
    const type = buf.readUInt32LE(off + 4);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === CHUNK_JSON) json = JSON.parse(data.toString('utf8'));
    else if (type === CHUNK_BIN) bin = Buffer.from(data);
    off += 8 + len;
  }
  if (!json) throw new Error(`${file} : chunk JSON absent`);
  return { json, bin };
}

/* Les chunks d'un GLB doivent être alignés sur 4 octets, JSON complété par des
   espaces et BIN par des zéros — un lecteur strict rejette le fichier sinon. */
function pad4(buf, fill) {
  const rest = buf.length % 4;
  if (rest === 0) return buf;
  return Buffer.concat([buf, Buffer.alloc(4 - rest, fill)]);
}

function writeGlb(file, json, bin) {
  const jsonChunk = pad4(Buffer.from(JSON.stringify(json), 'utf8'), 0x20);
  const binChunk = pad4(bin, 0x00);
  const total = 12 + 8 + jsonChunk.length + 8 + binChunk.length;
  const out = Buffer.alloc(total);
  out.writeUInt32LE(GLB_MAGIC, 0);
  out.writeUInt32LE(2, 4);
  out.writeUInt32LE(total, 8);
  let o = 12;
  out.writeUInt32LE(jsonChunk.length, o); out.writeUInt32LE(CHUNK_JSON, o + 4);
  jsonChunk.copy(out, o + 8); o += 8 + jsonChunk.length;
  out.writeUInt32LE(binChunk.length, o); out.writeUInt32LE(CHUNK_BIN, o + 4);
  binChunk.copy(out, o + 8);
  fs.writeFileSync(file, out);
}

/**
 * Remplace le contenu d'UNE bufferView, en n'en déplaçant aucune autre.
 *
 * ATTENTION — la version précédente de cette fonction réécrivait TOUTES les
 * bufferViews à la suite, en recalculant leurs offsets. Ça paraît propre et
 * c'est catastrophique sur ces modèles : ils utilisent EXT_meshopt_compression,
 * où le fichier contient DEUX buffers. Le buffer 0 est le BIN, il porte les
 * données compressées ; le buffer 1 n'existe pas dans le fichier, il décrit la
 * mémoire que le décodeur remplira à l'exécution — et c'est lui que visent la
 * plupart des bufferViews, avec des offsets qui dépassent largement la taille
 * du BIN. Les réécrire contre le BIN détruit la géométrie et les animations,
 * silencieusement : le fichier reste lisible, le modèle est faux.
 *
 * La méthode retenue ne touche à rien : les nouveaux octets sont AJOUTÉS à la
 * fin du BIN, et seule la bufferView de l'image est repointée dessus. Tout le
 * reste du fichier est recopié à l'octet près, compression comprise.
 *
 * Contrepartie : les anciens octets de l'image restent dans le fichier, perdus.
 * Quelques dizaines de kilo-octets — le prix d'une opération dont on peut
 * garantir qu'elle ne casse rien d'autre.
 */
function replaceImageBytes(json, bin, viewIndex, bytes) {
  const view = json.bufferViews[viewIndex];
  if (view.extensions && view.extensions.EXT_meshopt_compression) {
    throw new Error('la bufferView de l\'image est compressée (meshopt) — cas non traité');
  }
  /* L'image doit vivre dans le buffer 0, le seul réellement présent. */
  const bufIndex = view.buffer || 0;
  if (bufIndex !== 0) throw new Error(`image dans le buffer ${bufIndex}, attendu 0`);

  const pad = (4 - (bin.length % 4)) % 4;
  const out = Buffer.concat([bin, Buffer.alloc(pad), Buffer.from(bytes)]);
  view.buffer = 0;
  view.byteOffset = bin.length + pad;
  view.byteLength = bytes.length;
  json.buffers[0].byteLength = out.length;
  return out;
}

/**
 * Vérifie qu'un modèle réécrit est encore structurellement sain.
 *
 * Rejouée sur l'original AUSSI : une règle qui échoue sur les deux fichiers
 * dénonce la règle, pas la modification. C'est ce qui a permis de repérer que
 * le buffer 1 n'est pas dans le fichier au lieu de croire à une corruption.
 */
function validate(json, bin) {
  const errs = [];
  json.bufferViews.forEach((v, i) => {
    /* Seul le buffer 0 est présent physiquement. Les bufferViews qui visent le
       buffer 1 décrivent la sortie du décodeur meshopt : rien à vérifier ici. */
    if ((v.buffer || 0) !== 0) return;
    const mo = v.extensions && v.extensions.EXT_meshopt_compression;
    const off = mo ? mo.byteOffset || 0 : v.byteOffset || 0;
    const len = mo ? mo.byteLength : v.byteLength;
    if (off + len > bin.length) errs.push(`bufferView ${i} déborde du BIN`);
  });
  json.bufferViews.forEach((v, i) => {
    const mo = v.extensions && v.extensions.EXT_meshopt_compression;
    if (!mo) return;
    if ((mo.byteOffset || 0) + mo.byteLength > bin.length) {
      errs.push(`meshopt ${i} déborde du BIN`);
    }
  });
  return errs;
}

/** Première image du modèle, avec sa bufferView. */
function firstImage(json) {
  if (!json.images || !json.images.length) return null;
  const img = json.images[0];
  if (img.bufferView === undefined) return null;
  return { img, viewIndex: img.bufferView };
}

/**
 * Luminance moyenne perçue, fond transparent exclu.
 * Les pixels transparents d'un atlas sont souvent noirs et n'ont jamais été
 * peints : les compter ferait paraître toutes les textures plus sombres
 * qu'elles ne sont, et fausserait la comparaison entre modèles.
 */
async function measure(buffer) {
  const { data, info } = await sharp(buffer).raw().toBuffer({ resolveWithObject: true });
  const ch = info.channels;
  let sum = 0, n = 0;
  for (let i = 0; i < data.length; i += ch) {
    if (ch === 4 && data[i + 3] < 20) continue;
    sum += (0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]) / 255;
    n++;
  }
  return { mean: n ? sum / n : 0, width: info.width, height: info.height, channels: ch };
}

async function lift(buffer, floor, gamma) {
  const { data, info } = await sharp(buffer).raw().toBuffer({ resolveWithObject: true });
  const ch = info.channels;
  /* Table de correspondance : 256 valeurs calculées une fois, au lieu d'un
     `pow` par composante et par pixel — un million de pixels × 3 canaux. */
  const lut = new Uint8Array(256);
  for (let v = 0; v < 256; v++) {
    lut[v] = Math.round(255 * Math.min(1, floor + (1 - floor) * Math.pow(v / 255, gamma)));
  }
  for (let i = 0; i < data.length; i += ch) {
    data[i] = lut[data[i]];
    data[i + 1] = lut[data[i + 1]];
    data[i + 2] = lut[data[i + 2]];
    /* L'alpha n'est PAS touché : c'est un masque de découpe, pas une couleur.
       Le relever remplirait le fond transparent de l'atlas. */
  }
  return sharp(data, { raw: { width: info.width, height: info.height, channels: ch } })
    .webp({ quality: 92 })
    .toBuffer();
}

/* ---------------------------------------------------------------------- */

const args = process.argv.slice(2);
const opt = (name, def) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? parseFloat(hit.split('=')[1]) : def;
};

/**
 * Tous les .glb, sous-dossiers compris.
 *
 * `assets/models/lo/` contient les variantes allégées servies SUR MOBILE
 * (voir modelURL() dans src/gltf.js). Elles portent leur propre copie de la
 * texture : corriger un modèle sans corriger sa variante laisse le défaut
 * entier sur téléphone, là où personne ne le reverra avant la mise en ligne.
 * Le scan doit donc les inclure, sans quoi il donne une fausse assurance.
 */
function allModels(dir = MODELS_DIR, prefix = '') {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) out.push(...allModels(path.join(dir, e.name), `${prefix}${e.name}/`));
    else if (e.name.endsWith('.glb')) out.push(prefix + e.name);
  }
  return out;
}

if (args.includes('--scan')) {
  const files = allModels();
  const rows = [];
  for (const f of files) {
    let e;
    try { e = readGlb(path.join(MODELS_DIR, f)); } catch { continue; }
    const found = firstImage(e.json);
    if (!found || !e.bin) continue;
    const v = e.json.bufferViews[found.viewIndex];
    const bytes = e.bin.subarray(v.byteOffset || 0, (v.byteOffset || 0) + v.byteLength);
    try {
      const m = await measure(bytes);
      rows.push({ modele: f.replace('.glb', ''), luminance: +m.mean.toFixed(3), taille: `${m.width}x${m.height}` });
    } catch { /* format non lisible par sharp */ }
  }
  rows.sort((a, b) => a.luminance - b.luminance);
  console.table(rows);
  console.log('\nRepère : sous ~0,25 une texture ne peut plus être rattrapée par l\'éclairage.');
  process.exit(0);
}

const name = args.find((a) => !a.startsWith('--'));
if (!name) {
  console.error('usage : node scripts/lift-model-texture.mjs <modele> [--floor=0.22] [--gamma=0.75]');
  console.error('        node scripts/lift-model-texture.mjs --scan');
  process.exit(1);
}

const floor = opt('floor', 0.22);
const gamma = opt('gamma', 0.75);
const file = path.join(MODELS_DIR, name.endsWith('.glb') ? name : `${name}.glb`);
if (!fs.existsSync(file)) { console.error(`introuvable : ${file}`); process.exit(1); }

/* Sauvegarde AVANT toute écriture, et jamais écrasée : rejouer le script avec
   d'autres réglages doit rester possible sans perdre la texture d'origine.

   HORS de public/, et c'est important : tout ce qui vit dans public/ est copié
   tel quel par Vite dans dist/, puis par Capacitor dans l'APK. Des sauvegardes
   posées à côté du modèle ont ainsi été livrées — 4,9 Mo de fichiers que
   personne ne charge jamais. Un dossier à part, ignoré par git, ne peut pas
   se retrouver dans un build. */
const bak = path.join(BACKUP_DIR, `${name.replace(/[\\/]/g, '__').replace(/\.glb$/, '')}.glb.bak`);
fs.mkdirSync(BACKUP_DIR, { recursive: true });
if (!fs.existsSync(bak)) {
  fs.copyFileSync(file, bak);
  console.log(`original sauvegardé → ${path.basename(bak)}`);
} else {
  console.log(`original déjà sauvegardé (${path.basename(bak)}) — on repart de lui`);
}

/* On relit TOUJOURS depuis la sauvegarde : sans ça, une seconde exécution
   relèverait une texture déjà relevée et la délaverait un peu plus à chaque
   fois, sans qu'aucun message ne le signale. */
const { json, bin } = readGlb(bak);
const found = firstImage(json);
if (!found || !bin) { console.error('ce modèle n\'a pas de texture embarquée'); process.exit(1); }

const view = json.bufferViews[found.viewIndex];
const original = bin.subarray(view.byteOffset || 0, (view.byteOffset || 0) + view.byteLength);
const before = await measure(original);

const lifted = await lift(original, floor, gamma);
const after = await measure(lifted);

found.img.mimeType = 'image/webp';
const newBin = replaceImageBytes(json, bin, found.viewIndex, lifted);

/* Vérification AVANT écriture. Un .glb corrompu reste parfaitement lisible :
   il se charge, il s'affiche, et c'est la géométrie qui est fausse. Rien ne le
   signale à l'exécution — d'où ce contrôle, qui refuse d'écrire plutôt que de
   laisser découvrir le problème en jeu. */
const errs = validate(json, newBin);
if (errs.length) {
  console.error('ÉCRITURE ANNULÉE — structure invalide :');
  for (const e of errs) console.error('  ' + e);
  process.exit(1);
}
writeGlb(file, json, newBin);

console.log(`${name} — ${before.width}x${before.height}`);
console.log(`  plancher ${floor}   gamma ${gamma}`);
console.log(`  luminance : ${before.mean.toFixed(3)} → ${after.mean.toFixed(3)}`);
console.log(`  poids image : ${(original.length / 1024).toFixed(0)} Ko → ${(lifted.length / 1024).toFixed(0)} Ko`);
