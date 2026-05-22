// src/features/flac/flac.repo.js

const Database = require('better-sqlite3')
const path     = require('path')
const fs       = require('fs')

const DB_DIR  = path.join(__dirname, '../../../data/flac')
const DB_PATH = path.join(DB_DIR, 'data.db')

fs.mkdirSync(DB_DIR, { recursive: true })

const db = new Database(DB_PATH)
db.pragma('journal_mode = WAL')
db.pragma('synchronous = NORMAL')

db.exec(`
  CREATE TABLE IF NOT EXISTS tracks (
    track_id      TEXT PRIMARY KEY,
    file_id       TEXT NOT NULL,
    title         TEXT,
    artist        TEXT,
    duration      TEXT,
    quality       TEXT,
    thumbnail     TEXT,
    file_size     INTEGER,
    r2_url        TEXT,
    request_count INTEGER DEFAULT 0,
    type          TEXT DEFAULT 'flac',
    source        TEXT DEFAULT 'manual',
    album         TEXT,
    year          TEXT,
    genre         TEXT,
    file_hash     TEXT,
    created_at    INTEGER DEFAULT (strftime('%s', 'now'))
  )
`)

db.exec(`CREATE INDEX IF NOT EXISTS idx_title     ON tracks (title)`)
db.exec(`CREATE INDEX IF NOT EXISTS idx_artist    ON tracks (artist)`)
db.exec(`CREATE INDEX IF NOT EXISTS idx_file_hash ON tracks (file_hash)`)

const stmts = {
  get:    db.prepare(`SELECT * FROM tracks WHERE track_id = ?`),
  insert: db.prepare(`
    INSERT OR REPLACE INTO tracks
      (track_id, file_id, title, artist, duration, quality, thumbnail,
       file_size, r2_url, type, source, album, year, genre, file_hash)
    VALUES
      (@track_id, @file_id, @title, @artist, @duration, @quality, @thumbnail,
       @file_size, @r2_url, @type, @source, @album, @year, @genre, @file_hash)
  `),
  delete: db.prepare(`DELETE FROM tracks WHERE track_id = ?`),
  search: db.prepare(`
    SELECT * FROM tracks
    WHERE LOWER(title) LIKE ? OR LOWER(artist) LIKE ?
    ORDER BY created_at DESC
  `),
  searchByWord: db.prepare(`
    SELECT * FROM tracks
    WHERE LOWER(title) LIKE ? OR LOWER(artist) LIKE ?
    ORDER BY created_at DESC
  `),
  list:   db.prepare(`
    SELECT * FROM tracks ORDER BY artist ASC, title ASC LIMIT ? OFFSET ?
  `),
  count:  db.prepare(`SELECT COUNT(*) as total FROM tracks`),
  stats:  db.prepare(`
    SELECT
      COUNT(*)                                      as total_tracks,
      COUNT(DISTINCT artist)                        as total_artists,
      MAX(created_at)                               as last_added,
      SUM(CASE WHEN r2_url IS NULL OR r2_url = ''
               THEN 1 ELSE 0 END)                  as without_r2
    FROM tracks
  `),
  topArtists: db.prepare(`
    SELECT artist, COUNT(*) as total
    FROM tracks GROUP BY artist ORDER BY total DESC LIMIT 5
  `),
  incrementRequest: db.prepare(`
    UPDATE tracks SET request_count = request_count + 1 WHERE track_id = ?
  `),
  topTracks: db.prepare(`
    SELECT * FROM tracks ORDER BY request_count DESC LIMIT 10
  `),
  random: db.prepare(`
    SELECT * FROM tracks ORDER BY RANDOM() LIMIT 1
  `),
  updateR2: db.prepare(`UPDATE tracks SET r2_url = ? WHERE track_id = ?`),
  withoutR2: db.prepare(`
    SELECT * FROM tracks
    WHERE r2_url IS NULL OR r2_url = ''
    ORDER BY created_at ASC
  `),
  listForMetaSync: db.prepare(`
    SELECT * FROM tracks
    WHERE (album IS NULL OR year IS NULL OR thumbnail IS NULL OR genre IS NULL)
    AND title IS NOT NULL AND artist IS NOT NULL
    ORDER BY created_at ASC
  `),
  updateMeta: db.prepare(`
    UPDATE tracks
    SET album = @album, year = @year, thumbnail = @thumbnail, genre = @genre
    WHERE track_id = @track_id
  `),
  getByHash: db.prepare(`SELECT * FROM tracks WHERE file_hash = ? LIMIT 1`),
}

function getFlacTrack(trackId)          { return stmts.get.get(trackId) || null }
function saveFlacTrack(data)            { stmts.insert.run(data) }
function deleteFlacTrack(trackId)       { return stmts.delete.run(trackId).changes > 0 }
function updateFlacTrackR2(id, url)     { stmts.updateR2.run(url, id) }
function getFlacTrackByHash(hash)       { return stmts.getByHash.get(hash) || null }
function incrementFlacRequestCount(id)  { stmts.incrementRequest.run(id) }
function countFlacTracks()              { return stmts.count.get().total }
function listFlacTracks(limit, offset)  { return stmts.list.all(limit, offset) }
function listFlacTracksWithoutR2()      { return stmts.withoutR2.all() }
function listFlacTracksForMetaSync()    { return stmts.listForMetaSync.all() }
function getFlacTopTracks()             { return stmts.topTracks.all() }
function getFlacRandomTrack()           { return stmts.random.get() || null }

function searchFlacTracks(keyword, limit = null) {
  const normalized = keyword.toLowerCase().replace(/\s+/g, ' ').trim()
  const q          = `%${normalized}%`
  const words      = normalized.split(' ').filter(w => w.length > 1)

  const byWord = words.flatMap(w => {
    const wq = `%${w}%`
    return stmts.searchByWord.all(wq, wq)
  })

  const exact = stmts.search.all(q, q)
  const seen  = new Set(exact.map(r => r.track_id))
  const extra = byWord.filter(r => !seen.has(r.track_id))
  const all   = [...exact, ...extra]
  return limit ? all.slice(0, limit) : all
}

function updateFlacTrackMeta(trackId, { album, year, thumbnail, genre }) {
  stmts.updateMeta.run({ track_id: trackId, album, year, thumbnail, genre })
}

function getFlacStats() {
  const stats      = stmts.stats.get()
  const topArtists = stmts.topArtists.all()
  return { ...stats, topArtists }
}

module.exports = {
  getFlacTrack, saveFlacTrack, deleteFlacTrack,
  searchFlacTracks, listFlacTracks, countFlacTracks,
  updateFlacTrackR2, getFlacTrackByHash,
  listFlacTracksWithoutR2, listFlacTracksForMetaSync,
  updateFlacTrackMeta, getFlacStats,
  incrementFlacRequestCount, getFlacTopTracks, getFlacRandomTrack,
}