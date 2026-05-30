// src/features/ebooks/ebooks.repo.js

const Database = require('better-sqlite3')
const path     = require('path')
const fs       = require('fs')

const DB_DIR  = path.join(__dirname, '../../../data/ebooks')
const DB_PATH = path.join(DB_DIR, 'data.db')

fs.mkdirSync(DB_DIR, { recursive: true })

const db = new Database(DB_PATH)
db.pragma('journal_mode = WAL')
db.pragma('synchronous = NORMAL')

db.exec(`
  CREATE TABLE IF NOT EXISTS ebook_entries (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    title       TEXT    NOT NULL,
    author      TEXT    NOT NULL,
    genres      TEXT    NOT NULL DEFAULT '',
    publisher   TEXT    NOT NULL DEFAULT '',
    published   TEXT    NOT NULL DEFAULT '',
    thumbnail   TEXT    NOT NULL DEFAULT '',
    language    TEXT    NOT NULL DEFAULT '',
    file_size   INTEGER DEFAULT 0,
    file_hash   TEXT    DEFAULT '',
    r2_url      TEXT    DEFAULT '',
    file_id     TEXT    DEFAULT '',
    request_count INTEGER DEFAULT 0,
    created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    UNIQUE(title, author)
  )
`)

db.exec(`CREATE INDEX IF NOT EXISTS idx_ebook_title    ON ebook_entries (title)`)
db.exec(`CREATE INDEX IF NOT EXISTS idx_ebook_author   ON ebook_entries (author)`)
db.exec(`CREATE INDEX IF NOT EXISTS idx_ebook_genres   ON ebook_entries (genres)`)
db.exec(`CREATE INDEX IF NOT EXISTS idx_ebook_filehash ON ebook_entries (file_hash)`)

// ─── Statements ───────────────────────────────────────────────────────────────

const stmts = {
  insert: db.prepare(`
    INSERT INTO ebook_entries
      (title, author, genres, publisher, published, thumbnail, language,
       file_size, file_hash, r2_url, file_id)
    VALUES
      (@title, @author, @genres, @publisher, @published, @thumbnail, @language,
       @file_size, @file_hash, @r2_url, @file_id)
    ON CONFLICT(title, author) DO UPDATE SET
      genres    = CASE WHEN excluded.genres    != '' THEN excluded.genres    ELSE genres    END,
      publisher = CASE WHEN excluded.publisher != '' THEN excluded.publisher ELSE publisher END,
      published = CASE WHEN excluded.published != '' THEN excluded.published ELSE published END,
      thumbnail = CASE WHEN excluded.thumbnail != '' THEN excluded.thumbnail ELSE thumbnail END,
      language  = CASE WHEN excluded.language  != '' THEN excluded.language  ELSE language  END,
      file_size = CASE WHEN excluded.file_size  > 0  THEN excluded.file_size  ELSE file_size  END,
      file_hash = CASE WHEN excluded.file_hash != '' THEN excluded.file_hash ELSE file_hash END,
      r2_url    = CASE WHEN excluded.r2_url    != '' THEN excluded.r2_url    ELSE r2_url    END,
      file_id   = CASE WHEN excluded.file_id   != '' THEN excluded.file_id   ELSE file_id   END
  `),

  getById: db.prepare(`SELECT * FROM ebook_entries WHERE id = ?`),

  getByTitleAuthor: db.prepare(`
    SELECT * FROM ebook_entries
    WHERE LOWER(TRIM(title)) = LOWER(TRIM(?)) AND LOWER(TRIM(author)) = LOWER(TRIM(?))
    LIMIT 1
  `),

  getByHash: db.prepare(`
    SELECT * FROM ebook_entries WHERE file_hash = ? LIMIT 1
  `),

  updateR2: db.prepare(`
    UPDATE ebook_entries SET r2_url = ? WHERE id = ?
  `),

  updateFileId: db.prepare(`
    UPDATE ebook_entries SET file_id = ? WHERE id = ?
  `),

  delete: db.prepare(`DELETE FROM ebook_entries WHERE id = ?`),

  search: db.prepare(`
    SELECT * FROM ebook_entries
    WHERE LOWER(title)  LIKE ?
       OR LOWER(author) LIKE ?
       OR LOWER(genres) LIKE ?
    ORDER BY created_at DESC
    LIMIT 50
  `),

  searchByWord: db.prepare(`
    SELECT * FROM ebook_entries
    WHERE LOWER(title)  LIKE ?
       OR LOWER(author) LIKE ?
       OR LOWER(genres) LIKE ?
    ORDER BY created_at DESC
    LIMIT 50
  `),

  list: db.prepare(`
    SELECT * FROM ebook_entries
    ORDER BY author ASC, title ASC
    LIMIT ? OFFSET ?
  `),

  count: db.prepare(`SELECT COUNT(*) as total FROM ebook_entries`),

  stats: db.prepare(`
    SELECT
      COUNT(*)                                          AS total_entries,
      COUNT(DISTINCT author)                            AS total_authors,
      SUM(file_size)                                    AS total_size_bytes,
      MAX(created_at)                                   AS last_added,
      SUM(CASE WHEN r2_url IS NULL OR r2_url = ''
               THEN 1 ELSE 0 END)                      AS without_r2
    FROM ebook_entries
  `),

  topAuthors: db.prepare(`
    SELECT author, COUNT(*) as total
    FROM ebook_entries
    GROUP BY author
    ORDER BY total DESC
    LIMIT 5
  `),

  withoutR2: db.prepare(`
    SELECT * FROM ebook_entries
    WHERE r2_url IS NULL OR r2_url = ''
    ORDER BY created_at ASC
  `),

  incrementRequest: db.prepare(`
    UPDATE ebook_entries SET request_count = request_count + 1 WHERE id = ?
  `),
}

// ─── Public API ───────────────────────────────────────────────────────────────

function saveEbook(data) {
  return stmts.insert.run({
    title:     data.title     || '',
    author:    data.author    || '',
    genres:    data.genres    || '',
    publisher: data.publisher || '',
    published: data.published || '',
    thumbnail: data.thumbnail || '',
    language:  data.language  || '',
    file_size: data.file_size || 0,
    file_hash: data.file_hash || '',
    r2_url:    data.r2_url    || '',
    file_id:   data.file_id   || '',
  })
}

function getEbookById(id)               { return stmts.getById.get(id)          || null }
function getEbookByTitleAuthor(t, a)    { return stmts.getByTitleAuthor.get(t,a) || null }
function getEbookByHash(hash)           { return stmts.getByHash.get(hash)       || null }
function updateEbookR2(id, url)         { stmts.updateR2.run(url, id) }
function updateEbookFileId(id, fileId)  { stmts.updateFileId.run(fileId, id) }
function deleteEbook(id)                { return stmts.delete.run(id).changes > 0 }
function countEbooks()                  { return stmts.count.get().total }
function listEbooks(limit, offset)      { return stmts.list.all(limit, offset) }
function listEbooksWithoutR2()          { return stmts.withoutR2.all() }
function incrementEbookRequestCount(id) { stmts.incrementRequest.run(id) }

function getEbookStats() {
  const s = stmts.stats.get()
  const topAuthors = stmts.topAuthors.all()
  return { ...s, topAuthors }
}

function searchEbooks(keyword) {
  const normalized = keyword.toLowerCase().replace(/\s+/g, ' ').trim()
  const q          = `%${normalized}%`
  const words      = normalized.split(' ').filter(w => w.length > 1)

  const byWord = words.flatMap(w => {
    const wq = `%${w}%`
    return stmts.searchByWord.all(wq, wq, wq)
  })

  const exact = stmts.search.all(q, q, q)
  const seen  = new Set(exact.map(r => r.id))
  const extra = byWord.filter(r => !seen.has(r.id))
  return [...exact, ...extra]
}

module.exports = {
  saveEbook, getEbookById, getEbookByTitleAuthor, getEbookByHash,
  updateEbookR2, updateEbookFileId, deleteEbook,
  countEbooks, listEbooks, listEbooksWithoutR2,
  getEbookStats, searchEbooks, incrementEbookRequestCount,
}