// src/features/movies/movies.repo.js
const Database = require('better-sqlite3')
const path     = require('path')
const fs       = require('fs')

const DB_DIR  = path.join(__dirname, '../../../data/movies')
const DB_PATH = path.join(DB_DIR, 'data.db')

fs.mkdirSync(DB_DIR, { recursive: true })

const db = new Database(DB_PATH, { timeout: 7000 })
db.pragma('journal_mode = WAL')

// ✨ UPDATE: Tambahan kolom message_id
db.exec(`
  CREATE TABLE IF NOT EXISTS movie_entries (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    tmdb_id     TEXT    NOT NULL UNIQUE,
    title       TEXT    NOT NULL,
    year        TEXT    DEFAULT '',
    duration    TEXT    DEFAULT '',
    rating      TEXT    DEFAULT '',
    genre       TEXT    DEFAULT '',
    poster      TEXT    DEFAULT '',
    overview    TEXT    DEFAULT '',
    file_size   INTEGER DEFAULT 0,
    file_hash   TEXT    DEFAULT '',
    r2_url      TEXT    DEFAULT '',
    file_id     TEXT    DEFAULT '',
    message_id  INTEGER DEFAULT 0, 
    created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
  )
`)

const stmts = {
  insert: db.prepare(`
    INSERT INTO movie_entries
      (tmdb_id, title, year, duration, rating, genre, poster, overview, file_size, file_hash, r2_url, file_id, message_id)
    VALUES
      (@tmdb_id, @title, @year, @duration, @rating, @genre, @poster, @overview, @file_size, @file_hash, @r2_url, @file_id, @message_id)
    ON CONFLICT(tmdb_id) DO UPDATE SET
      title = excluded.title, r2_url = excluded.r2_url, file_id = excluded.file_id, 
      file_hash = excluded.file_hash, message_id = excluded.message_id
  `),
  getByTmdbId: db.prepare(`SELECT * FROM movie_entries WHERE tmdb_id = ?`),
  getByHash: db.prepare(`SELECT * FROM movie_entries WHERE file_hash = ? LIMIT 1`),
  updateR2: db.prepare(`UPDATE movie_entries SET r2_url = ? WHERE id = ?`),
  search: db.prepare(`SELECT * FROM movie_entries WHERE LOWER(title) LIKE ? ORDER BY year DESC LIMIT 20`),
  byYearRange: db.prepare(`SELECT * FROM movie_entries WHERE year IN (?, ?, ?) ORDER BY year DESC`),
}

function saveMovieLocal(data) {
  const result = stmts.insert.run(data)
  return result.lastInsertRowid || stmts.getByTmdbId.get(data.tmdb_id).id
}

function getMovieByTmdbId(tmdbId) { return stmts.getByTmdbId.get(tmdbId) || null }
function getMovieByHash(hash) { return stmts.getByHash.get(hash) || null }
function searchMoviesLocal(keyword) { return stmts.search.all(`%${keyword.toLowerCase()}%`) }
function getMoviesByYearRange(year) {
  if (!year) return []
  const y = parseInt(year, 10)
  return stmts.byYearRange.all(String(y - 1), String(y), String(y + 1))
}
function updateMovieR2(id, url) { stmts.updateR2.run(url, id) }

module.exports = {
  saveMovieLocal, getMovieByTmdbId, getMovieByHash,
  searchMoviesLocal, getMoviesByYearRange, updateMovieR2
}