// scripts/syncR2Flac.js

require('dotenv').config()
const fs   = require('fs')
const path = require('path')
const mm   = require('music-metadata')

const { uploadToR2, trackKey } = require('../src/utils/r2')
const { syncFlacToApi }        = require('../src/utils/api-sync')
const {
  listFlacTracksWithoutR2,
  updateFlacTrackR2,
  getFlacTrack,
} = require('../src/features/flac/flac.repo')

const FLAC_DIR = path.join(__dirname, '../data/local_flac')

if (!fs.existsSync(FLAC_DIR)) {
  fs.mkdirSync(FLAC_DIR, { recursive: true })
  console.log(`📂 Folder dibuat: ${FLAC_DIR}`)
  console.log(`Taruh file .flac di sana, lalu jalankan ulang script ini.`)
  process.exit(0)
}

async function syncFlac() {
  const pendingDbTracks = listFlacTracksWithoutR2()

  if (pendingDbTracks.length === 0) {
    console.log('✅ Semua lagu FLAC sudah punya r2_url.')
    return
  }

  const files = fs.readdirSync(FLAC_DIR).filter(f => f.endsWith('.flac'))
  if (files.length === 0) {
    console.log(`❌ Ada ${pendingDbTracks.length} lagu tanpa R2, tapi folder kosong.`)
    return
  }

  console.log(`🔍 ${pendingDbTracks.length} lagu tanpa R2 · ${files.length} file lokal\n`)

  for (const file of files) {
    const filePath = path.join(FLAC_DIR, file)
    const buffer   = fs.readFileSync(filePath)

    try {
      const meta   = await mm.parseBuffer(buffer, { mimeType: 'audio/flac' })
      const title  = meta.common?.title
      const artist = meta.common?.artist

      if (!title || !artist) {
        console.log(`⚠️  Skip: ${file} (ID3 Tag kosong)`)
        continue
      }

      const dbMatch = pendingDbTracks.find(t =>
        t.title?.toLowerCase()  === title.toLowerCase() &&
        t.artist?.toLowerCase() === artist.toLowerCase()
      )

      if (!dbMatch) {
        console.log(`⏩  Skip: ${artist} - ${title} (tidak ada di DB atau sudah ada R2)`)
        continue
      }

      console.log(`☁️  Upload R2: ${artist} - ${title}`)

      const key   = trackKey(dbMatch.track_id, dbMatch.title, dbMatch.artist, 'flac')
      const r2Url = await uploadToR2(buffer, key, 'audio/flac', buffer.length)

      updateFlacTrackR2(dbMatch.track_id, r2Url)
      console.log(`  💾 DB updated: ${r2Url}`)

      // Ambil data lengkap (termasuk metadata yang sudah di-enrich) lalu sync ke REST API
      const fullTrack = getFlacTrack(dbMatch.track_id)
      await syncFlacToApi({ ...fullTrack, r2_url: r2Url })

      fs.renameSync(filePath, path.join(FLAC_DIR, `_done_${file}`))
      console.log(`  ✅ Done: ${artist} - ${title}\n`)

    } catch (err) {
      console.error(`❌ Gagal: ${file} — ${err.message}`)
    }
  }

  console.log('✅ Selesai.')
}

syncFlac()