const Database = require('better-sqlite3')
const path     = require('path')
const fs       = require('fs')

const DB_DIR  = path.join(__dirname, '../../data/spotify')
const DB_PATH = path.join(DB_DIR, 'data.db')

fs.mkdirSync(DB_DIR, { recursive: true })

const db = new Database(DB_PATH)

db.exec(`
  CREATE TABLE IF NOT EXISTS tracks (
    track_id   TEXT PRIMARY KEY,
    file_id    TEXT NOT NULL,
    title      TEXT,
    artist     TEXT,
    duration   TEXT,
    quality    TEXT,
    thumbnail  TEXT,
    file_size  INTEGER,
    r2_url     TEXT,
    created_at INTEGER DEFAULT (strftime('%s', 'now'))
  )
`)

try { db.exec(`ALTER TABLE tracks ADD COLUMN file_size INTEGER`) } catch {}
try { db.exec(`ALTER TABLE tracks ADD COLUMN r2_url TEXT`) } catch {}

db.exec(`CREATE INDEX IF NOT EXISTS idx_title  ON tracks (title)`)
db.exec(`CREATE INDEX IF NOT EXISTS idx_artist ON tracks (artist)`)

const stmts = {
  get:    db.prepare(`SELECT * FROM tracks WHERE track_id = ?`),
  insert: db.prepare(`
    INSERT OR REPLACE INTO tracks (track_id, file_id, title, artist, duration, quality, thumbnail, file_size, r2_url)
    VALUES (@track_id, @file_id, @title, @artist, @duration, @quality, @thumbnail, @file_size, @r2_url)
  `),
  delete: db.prepare(`DELETE FROM tracks WHERE track_id = ?`),
  search: db.prepare(`
    SELECT * FROM tracks
    WHERE LOWER(title) LIKE ? OR LOWER(artist) LIKE ?
    ORDER BY created_at DESC
    LIMIT 10
  `),
  list:   db.prepare(`
    SELECT * FROM tracks
    ORDER BY artist ASC, title ASC
    LIMIT ? OFFSET ?
  `),
  count:  db.prepare(`SELECT COUNT(*) as total FROM tracks`),
  stats:  db.prepare(`
    SELECT
      COUNT(*)                                        as total_tracks,
      COUNT(DISTINCT artist)                          as total_artists,
      MAX(created_at)                                 as last_added,
      SUM(CASE WHEN r2_url IS NULL OR r2_url = ''
               THEN 1 ELSE 0 END)                    as without_r2
    FROM tracks
  `),
  topArtists: db.prepare(`
    SELECT artist, COUNT(*) as total
    FROM tracks
    GROUP BY artist
    ORDER BY total DESC
    LIMIT 5
  `),
  updateR2: db.prepare(`UPDATE tracks SET r2_url = ? WHERE track_id = ?`),
  withoutR2: db.prepare(`
    SELECT * FROM tracks
    WHERE r2_url IS NULL OR r2_url = ''
    ORDER BY created_at ASC
  `),
  searchByWord: db.prepare(`
    SELECT * FROM tracks
    WHERE LOWER(title) LIKE ? OR LOWER(artist) LIKE ?
    ORDER BY created_at DESC
    LIMIT 10
  `),
}

function getTrack(trackId) {
  return stmts.get.get(trackId) || null
}

function saveTrack(data) {
  stmts.insert.run(data)
}

function deleteTrack(trackId) {
  const info = stmts.delete.run(trackId)
  return info.changes > 0
}

function searchTracks(keyword) {
  const normalized = keyword.toLowerCase().replace(/\s+/g, ' ').trim()
  const q          = `%${normalized}%`

  const words  = normalized.split(' ').filter(w => w.length > 1)
  const byWord = words.flatMap(w => {
    const wq = `%${w}%`
    return stmts.searchByWord.all(wq, wq)  
  })

  const exact = stmts.search.all(q, q)
  const seen  = new Set(exact.map(r => r.track_id))
  const extra = byWord.filter(r => !seen.has(r.track_id))

  return [...exact, ...extra].slice(0, 10)
}

function listTracks(limit = 10, offset = 0) {
  return stmts.list.all(limit, offset)
}

function countTracks() {
  return stmts.count.get().total
}

function getStats() {
  const stats      = stmts.stats.get()
  const topArtists = stmts.topArtists.all()
  return { ...stats, topArtists }
}

function updateTrackR2(trackId, r2Url) {
  stmts.updateR2.run(r2Url, trackId)
}

function listTracksWithoutR2() {
  return stmts.withoutR2.all()
}

module.exports = { getTrack, saveTrack, deleteTrack, searchTracks, listTracks, countTracks, getStats, updateTrackR2, listTracksWithoutR2 }