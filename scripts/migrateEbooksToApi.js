// scripts/migrateEbooksToApi.js
// Sync semua ebook dari SQLite lokal ke REST API golang
// Jalankan sekali setelah setup: node scripts/migrateEbooksToApi.js

require('dotenv').config()
const axios = require('axios')
const DB    = require('better-sqlite3')
const path  = require('path')

const REST_API_URL = process.env.REST_API_URL
const REST_API_KEY = process.env.REST_API_MASTER_KEY
const BATCH_SIZE   = 50
const DELAY_MS     = 300

if (!REST_API_URL || !REST_API_KEY) {
  console.error('REST_API_URL dan REST_API_MASTER_KEY wajib diset di .env')
  process.exit(1)
}

async function migrate() {
  const dbPath = path.join(__dirname, '../data/ebooks/data.db')
  const db     = new DB(dbPath, { readonly: true })

  const entries = db.prepare(`
    SELECT * FROM ebook_entries
    WHERE r2_url IS NOT NULL AND r2_url != ''
    ORDER BY created_at ASC
  `).all()

  console.log(`\nFound ${entries.length} ebooks dengan r2_url\n`)

  if (entries.length === 0) {
    console.log('Tidak ada data untuk dimigrasikan.')
    db.close()
    return
  }

  let totalOk = 0, totalFailed = 0

  for (let i = 0; i < entries.length; i += BATCH_SIZE) {
    const batch   = entries.slice(i, i + BATCH_SIZE)
    const batchNo = Math.floor(i / BATCH_SIZE) + 1
    const payload = batch.map(e => ({
      title:     e.title     || '',
      author:    e.author    || '',
      genres:    e.genres    || '',
      publisher: e.publisher || '',
      published: e.published || '',
      thumbnail: e.thumbnail || '',
      language:  e.language  || 'Indonesian',
      url_1:     e.r2_url,
    }))

    try {
      const res = await axios.post(
        `${REST_API_URL}/admin/downloader/ebooks/bulk`,
        { entries: payload },
        {
          headers: { 'X-Master-Key': REST_API_KEY },
          timeout: 30_000,
        }
      )
      const { processed, failed, errors } = res.data.data
      totalOk     += processed
      totalFailed += failed
      console.log(`Batch ${batchNo}: ${processed} ok, ${failed} failed`)
      if (errors?.length) {
        errors.forEach(e => console.warn(`  ↳ [${e.index}] ${e.error}`))
      }
    } catch (err) {
      totalFailed += batch.length
      console.error(`Batch ${batchNo} request failed:`, err.message)
    }

    if (i + BATCH_SIZE < entries.length) {
      await new Promise(r => setTimeout(r, DELAY_MS))
    }
  }

  db.close()
  console.log(`\nDone — ${totalOk} ok, ${totalFailed} failed`)
}

migrate().catch(err => {
  console.error('Migration fatal:', err.message)
  process.exit(1)
})