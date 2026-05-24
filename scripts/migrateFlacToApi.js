// scripts/migrateFlacToApi.js
require('dotenv').config()
const axios  = require('axios')
const DB     = require('better-sqlite3')

const REST_API_URL = process.env.REST_API_URL
const REST_API_KEY = process.env.REST_API_MASTER_KEY
const BATCH_SIZE   = 50
const DELAY_MS     = 300

if (!REST_API_URL || !REST_API_KEY) {
    console.error('REST_API_URL dan REST_API_MASTER_KEY wajib diset di .env')
    process.exit(1)
}

async function migrate() {
    const db = new DB('./data/flac/data.db', { readonly: true })

    const tracks = db.prepare(`
        SELECT * FROM tracks
        WHERE r2_url IS NOT NULL AND r2_url != ''
        ORDER BY created_at ASC
    `).all()

    console.log(`\nFound ${tracks.length} tracks dengan r2_url\n`)

    let totalOk = 0, totalFailed = 0

    for (let i = 0; i < tracks.length; i += BATCH_SIZE) {
        const batch   = tracks.slice(i, i + BATCH_SIZE)
        const batchNo = Math.floor(i / BATCH_SIZE) + 1
        const entries = batch.map(t => ({
            track_id:  t.track_id,
            title:     t.title     || '',
            artist:    t.artist    || '',
            album:     t.album     || '',
            duration:  t.duration  || '',
            year:      t.year      || '',
            genre:     t.genre     || '',
            quality:   t.quality   || 'FLAC',
            thumbnail: t.thumbnail || '',
            file_size: t.file_size || 0,
            file_hash: t.file_hash || '',
            url_1:     t.r2_url,
        }))

        try {
            const res = await axios.post(
                `${REST_API_URL}/admin/downloader/flac/bulk`,
                { entries },
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

        if (i + BATCH_SIZE < tracks.length) {
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