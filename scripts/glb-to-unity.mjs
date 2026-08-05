/* Convertit les .glb de Cult.io en variantes lisibles par Unity.
 *
 * glTFast ne supporte pas l'extension EXT_texture_webp, et son import ECHOUE
 * entierement sur un modele qui en contient — ce n'est pas une degradation
 * silencieuse. Seuls grass et trees passaient, faute de textures.
 *
 * Ce script relit chaque modele, reencode ses textures WebP en PNG, retire
 * l'extension, et ecrit le resultat dans le projet Unity. La compression
 * meshopt est conservee : le paquet com.unity.meshopt.decompress la gere.
 *
 * Usage : node scripts/glb-to-unity.mjs [dossier_de_sortie]
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer';

const SRC = 'public/assets/models';
const OUT = process.argv[2]
  || 'C:/CultUnity/Cultwar/Assets/_Project/Art/Models';

const io = new NodeIO()
  .registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({
    'meshopt.decoder': MeshoptDecoder,
    'meshopt.encoder': MeshoptEncoder,
  });

async function convert(srcFile, outFile) {
  const doc = await io.read(srcFile);
  const root = doc.getRoot();

  let converted = 0;
  for (const tex of root.listTextures()) {
    if (tex.getMimeType() !== 'image/webp') continue;
    const image = tex.getImage();
    if (!image) continue;
    const png = await sharp(Buffer.from(image)).png().toBuffer();
    tex.setImage(new Uint8Array(png));
    tex.setMimeType('image/png');
    const uri = tex.getURI();
    if (uri) tex.setURI(uri.replace(/\.webp$/i, '.png'));
    converted++;
  }

  /* On retire deux extensions :
     - EXT_texture_webp : sans cela elle resterait declaree alors qu'aucune
       texture ne l'utilise, et glTFast refuserait encore le fichier ;
     - EXT_meshopt_compression : glTFast plante dans son propre pipeline de
       jobs (ConvertVector3FloatToFloatJob, InvalidOperationException) sur les
       modeles articules compresses. Les buffers sont deja decodes en memoire,
       les retirer suffit a ecrire du glTF non compresse. Les fichiers sont
       plus lourds, mais c'est le prix d'un import qui fonctionne. */
  const drop = new Set(['EXT_texture_webp', 'EXT_meshopt_compression']);
  for (const ext of doc.getRoot().listExtensionsUsed()) {
    if (drop.has(ext.extensionName)) ext.dispose();
  }

  await io.write(outFile, doc);
  return converted;
}

const files = (await fs.readdir(SRC)).filter((f) => f.endsWith('.glb'));
await fs.mkdir(OUT, { recursive: true });
await fs.mkdir(path.join(OUT, 'lo'), { recursive: true });

let totalTex = 0;
for (const file of files) {
  const n = await convert(path.join(SRC, file), path.join(OUT, file));
  totalTex += n;
  console.log(`${file.padEnd(28)} ${n} texture(s) converties`);
}

const loFiles = (await fs.readdir(path.join(SRC, 'lo'))).filter((f) => f.endsWith('.glb'));
for (const file of loFiles) {
  const n = await convert(path.join(SRC, 'lo', file), path.join(OUT, 'lo', file));
  totalTex += n;
  console.log(`lo/${file.padEnd(25)} ${n} texture(s) converties`);
}

console.log(`\n${files.length + loFiles.length} modeles, ${totalTex} textures converties`);
console.log(`Sortie : ${OUT}`);
