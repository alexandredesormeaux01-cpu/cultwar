/**
 * scripts/build-admin1.mjs
 *
 * Télécharge Natural Earth 10m admin-1 (états/provinces) et génère
 * un fichier GeoJSON par pays (ISO_A3) dans public/assets/maps/admin-1/.
 *
 * - N'écrase JAMAIS un fichier existant (les 51 fichiers d'origine sont conservés).
 * - Pour les pays sans aucune feature admin-1 dans NE, génère un fichier "1 zone"
 *   à partir du polygone du pays extrait de world-countries-110m.geojson.
 *
 * Usage : node scripts/build-admin1.mjs
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const OUT_DIR = path.join(ROOT, 'public/assets/maps/admin-1')
const WORLD_GEOJSON = path.join(ROOT, 'public/assets/maps/world-countries-110m.geojson')

const NE_ADMIN1_URL =
  'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_admin_1_states_provinces.geojson'

async function main() {
  await fs.mkdir(OUT_DIR, { recursive: true })

  const existing = new Set(
    (await fs.readdir(OUT_DIR))
      .filter((f) => f.endsWith('.geojson'))
      .map((f) => f.replace('.geojson', '').toUpperCase()),
  )
  console.log(`Existants (conservés) : ${existing.size} pays`)

  console.log('Téléchargement Natural Earth 10m admin-1…')
  const res = await fetch(NE_ADMIN1_URL)
  if (!res.ok) throw new Error(`HTTP ${res.status} pour ${NE_ADMIN1_URL}`)
  const ne = await res.json()
  console.log(`  ${ne.features.length} features`)

  // Grouper par adm0_a3
  const byIso = new Map()
  for (const f of ne.features) {
    const p = f.properties || {}
    const iso = (p.adm0_a3 || p.iso_a3 || '').toUpperCase()
    if (!iso || iso === '-99') continue
    if (!byIso.has(iso)) byIso.set(iso, [])
    byIso.get(iso).push(f)
  }
  console.log(`  Regroupés en ${byIso.size} pays`)

  // Charger le world GeoJSON pour le fallback micro-états
  const worldRaw = await fs.readFile(WORLD_GEOJSON, 'utf8')
  const world = JSON.parse(worldRaw)
  const worldByIso = new Map()
  for (const f of world.features) {
    const p = f.properties || {}
    const iso = (p.ISO_A3 || p.iso_a3 || p.ADM0_A3 || '').toUpperCase()
    if (!iso || iso === '-99') continue
    worldByIso.set(iso, f)
  }

  let written = 0
  let fallback = 0
  let skipped = 0

  // Pour chaque pays du monde (world geojson définit l'univers de ~172 pays)
  for (const [iso, worldFeature] of worldByIso.entries()) {
    if (existing.has(iso)) {
      skipped++
      continue
    }

    const neFeatures = byIso.get(iso)
    let outFeatures

    if (neFeatures && neFeatures.length) {
      outFeatures = neFeatures.map((f, i) => {
        const p = f.properties || {}
        const name = p.name || p.name_en || p.gn_name || `Zone ${i + 1}`
        const id = p.adm1_code || p.iso_3166_2 || `${iso}-${i}`
        return {
          type: 'Feature',
          properties: { id, name },
          geometry: f.geometry,
        }
      })
    } else {
      // Fallback : 1 zone = polygone du pays
      const p = worldFeature.properties || {}
      const name = p.NAME || p.name || p.ADMIN || iso
      outFeatures = [
        {
          type: 'Feature',
          properties: { id: `${iso}-0`, name },
          geometry: worldFeature.geometry,
        },
      ]
      fallback++
    }

    const out = {
      type: 'FeatureCollection',
      countryId: iso,
      features: outFeatures,
    }

    const outPath = path.join(OUT_DIR, `${iso}.geojson`)
    await fs.writeFile(outPath, JSON.stringify(out))
    written++
  }

  // Aussi : pays présents dans NE mais absents du world geojson (rare mais possible)
  for (const iso of byIso.keys()) {
    if (existing.has(iso) || worldByIso.has(iso)) continue
    const neFeatures = byIso.get(iso)
    const outFeatures = neFeatures.map((f, i) => {
      const p = f.properties || {}
      const name = p.name || p.name_en || `Zone ${i + 1}`
      const id = p.adm1_code || `${iso}-${i}`
      return {
        type: 'Feature',
        properties: { id, name },
        geometry: f.geometry,
      }
    })
    const outPath = path.join(OUT_DIR, `${iso}.geojson`)
    await fs.writeFile(
      outPath,
      JSON.stringify({ type: 'FeatureCollection', countryId: iso, features: outFeatures }),
    )
    written++
  }

  console.log(`\nRésultat :`)
  console.log(`  ${skipped} pays inchangés (déjà présents)`)
  console.log(`  ${written} pays écrits (dont ${fallback} en fallback pays-entier)`)
  console.log(`  Total dans ${OUT_DIR} : ${(await fs.readdir(OUT_DIR)).length} fichiers`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
