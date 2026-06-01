// src/features/spider/spider.repo.js
const { db } = require('../spotify/spotify.repo');

// Membuat tabel antrean spider jika belum ada
db.exec(`
  CREATE TABLE IF NOT EXISTS spider_artists (
    artist_id TEXT PRIMARY KEY,
    name TEXT,
    status TEXT DEFAULT 'pending',
    added_at INTEGER DEFAULT (strftime('%s', 'now'))
  )
`);

const stmts = {
  addSeed: db.prepare(`INSERT OR IGNORE INTO spider_artists (artist_id, name, status) VALUES (?, ?, 'pending')`),
  getQueue: db.prepare(`SELECT * FROM spider_artists WHERE status = 'pending' ORDER BY added_at ASC LIMIT ?`),
  skipArtist: db.prepare(`DELETE FROM spider_artists WHERE status = 'pending' AND (artist_id = ? OR LOWER(name) = LOWER(?))`),
  countPending: db.prepare(`SELECT COUNT(*) as count FROM spider_artists WHERE status = 'pending'`),
  clearQueue: db.prepare(`DELETE FROM spider_artists WHERE status = 'pending'`),
  
  getPending: db.prepare(`SELECT * FROM spider_artists WHERE status = 'pending' ORDER BY added_at ASC LIMIT 1`),
  markDone: db.prepare(`UPDATE spider_artists SET status = 'done' WHERE artist_id = ?`),
  countDone: db.prepare(`SELECT COUNT(*) as count FROM spider_artists WHERE status = 'done'`),
  checkName: db.prepare(`SELECT artist_id FROM spider_artists WHERE LOWER(name) = LOWER(?)`),
};

// ── Untuk Telegram Admin ──
function addSpiderSeed(artistId, name) { return stmts.addSeed.run(artistId, name).changes > 0; }
function getSpiderQueue(limit = 15) { return stmts.getQueue.all(limit); }
function skipSpiderArtist(keyword) { return stmts.skipArtist.run(keyword, keyword).changes > 0; }
function countSpiderQueue() { return stmts.countPending.get().count; }
function clearSpiderQueue() { return stmts.clearQueue.run().changes; }

// ── Untuk Worker Background (spider.js) ──
function getNextPendingArtist() { return stmts.getPending.get() || null; }
function markArtistDone(artistId) { return stmts.markDone.run(artistId).changes > 0; }
function countDoneSpider() { return stmts.countDone.get().count; }
function checkArtistNameExists(name) { return stmts.checkName.get(name) || null; }

module.exports = {
  addSpiderSeed, getSpiderQueue, skipSpiderArtist, countSpiderQueue, clearSpiderQueue,
  getNextPendingArtist, markArtistDone, countDoneSpider, checkArtistNameExists
};