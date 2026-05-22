// scripts/syncR2Flac.js

require('dotenv').config()
const fs = require('fs')
const path = require('path')
const mm = require('music-metadata')

// Import utilitas R2 dan Repo FLAC kamu
const { uploadToR2, trackKey } = require('../src/utils/r2')
const { listFlacTracksWithoutR2, updateFlacTrackR2 } = require('../src/features/flac/flac.repo')

// Folder tempat file lokal berada
const FLAC_DIR = path.join(__dirname, '../data/local_flac')

// Buat folder otomatis jika belum ada
if (!fs.existsSync(FLAC_DIR)) {
  fs.mkdirSync(FLAC_DIR, { recursive: true })
  console.log(`📂 Folder dibuat: ${FLAC_DIR}\nTaruh file .flac mentah kamu di sana, lalu jalankan ulang script ini.`)
  process.exit(0)
}

async function syncFlac() {
  // 1. Ambil HANYA lagu FLAC di DB yang r2_url-nya masih NULL
  const pendingDbTracks = listFlacTracksWithoutR2()
  
  if (pendingDbTracks.length === 0) {
    console.log('✅ Semua lagu FLAC di database sudah memiliki r2_url.')
    return
  }

  // 2. Baca file lokal
  const files = fs.readdirSync(FLAC_DIR).filter(f => f.endsWith('.flac'))
  if (files.length === 0) {
    console.log(`❌ Ada ${pendingDbTracks.length} lagu di DB tanpa R2, tapi folder ${FLAC_DIR} kosong.`)
    return
  }

  console.log(`🔍 Menemukan ${pendingDbTracks.length} lagu di DB tanpa R2. Memindai ${files.length} file lokal...\n`)

  // 3. Proses pencocokan dan upload
  for (const file of files) {
    const filePath = path.join(FLAC_DIR, file)
    const buffer   = fs.readFileSync(filePath)
    
    try {
      // Ekstrak ID3 Tag (harus sama persis dengan saat upload Telegram)
      const meta   = await mm.parseBuffer(buffer, { mimeType: 'audio/flac' })
      const title  = meta.common?.title
      const artist = meta.common?.artist

      if (!title || !artist) {
        console.log(`⚠️ Skip: ${file} (ID3 Tag Title/Artist kosong)`)
        continue
      }

      // Cari baris di DB yang r2_url-nya NULL dan title/artist-nya cocok
      const dbMatch = pendingDbTracks.find(t => 
        t.title?.toLowerCase() === title.toLowerCase() && 
        t.artist?.toLowerCase() === artist.toLowerCase()
      )

      if (!dbMatch) {
        console.log(`⏩ Skip: ${artist} - ${title} (Bukan target / sudah ada R2 URL)`)
        continue
      }

      console.log(`☁️ Uploading ke R2: ${artist} - ${title} ...`)
      
      // Buat custom key langsung di sini agar masuk ke folder 'flac' dengan ekstensi .flac
      const safeName = (str) => str.replace(/[^a-zA-Z0-9 \-_]/g, '').trim()
      const customKey = `flac/${safeName(dbMatch.artist)} - ${safeName(dbMatch.title)} (${dbMatch.track_id}).flac`
      
      const r2Url = await uploadToR2(buffer, customKey, 'audio/flac', buffer.length)

      // UPDATE HANYA KOLOM r2_url DI DATABASE
      updateFlacTrackR2(dbMatch.track_id, r2Url)
      console.log(`🎉 Sukses mengisi r2_url: ${r2Url}`)

      // Tambahkan prefix _done_ agar file tidak di-scan ulang saat script dijalankan lagi
      fs.renameSync(filePath, path.join(FLAC_DIR, `_done_${file}`))

    } catch (err) {
      console.error(`❌ Gagal memproses ${file}:`, err.message)
    }
  }
  
  console.log('\n✅ Proses pengisian r2_url selesai!')
}

syncFlac()