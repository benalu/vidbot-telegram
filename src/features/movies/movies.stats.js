// src/features/movies/movies.stats.js
// Baca/tulis statistik spider movies ke file JSON.

'use strict';

const fs   = require('fs');
const path = require('path');
const logger = require('../../utils/logger');

const STATS_PATH = path.join(__dirname, '../../../data/movies/spider-movs-stats.json');

/**
 * Update file statistik spider movies.
 * patch bisa berisi: success, failed, duplicate, size_bytes, duration_ms,
 *                    status, active_title, lock_start, last_provider, title
 */
function updateSpiderStats(patch) {
  try {
    let s = {};
    if (fs.existsSync(STATS_PATH)) s = JSON.parse(fs.readFileSync(STATS_PATH, 'utf8'));

    s.total_success   = (s.total_success   || 0) + (patch.success   ? 1 : 0);
    s.total_failed    = (s.total_failed    || 0) + (patch.failed    ? 1 : 0);
    s.total_duplicate = (s.total_duplicate || 0) + (patch.duplicate ? 1 : 0);

    for (const [pKey, tKey, cKey, aKey, div] of [
      ['size_bytes',  'total_size_bytes',  'total_success_for_avg',  'avg_size_mb',      1024 * 1024],
      ['duration_ms', 'total_duration_ms', 'total_duration_for_avg', 'avg_duration_min', 1000 * 60],
    ]) {
      if (!patch[pKey]) continue;
      s[tKey] = (s[tKey] || 0) + patch[pKey];
      s[cKey] = (s[cKey] || 0) + 1;
      s[aKey] = (s[tKey] / s[cKey] / div).toFixed(1);
    }

    for (const k of ['status', 'active_title', 'lock_start', 'last_provider']) {
      if (patch[k] !== undefined) s[k] = patch[k];
    }

    if (patch.title) {
      s.last_movie        = patch.title;
      s.last_processed_at = new Date().toISOString();
    }
    s.last_updated = new Date().toISOString();

    fs.mkdirSync(path.dirname(STATS_PATH), { recursive: true });
    fs.writeFileSync(STATS_PATH, JSON.stringify(s, null, 2));
  } catch (err) {
    logger.warn({ event: 'movs_stats_write_failed', msg: err.message });
  }
}

/**
 * Baca file statistik, return object atau null.
 */
function readSpiderStats() {
  try {
    if (fs.existsSync(STATS_PATH)) return JSON.parse(fs.readFileSync(STATS_PATH, 'utf8'));
  } catch { /* silent */ }
  return null;
}

module.exports = { updateSpiderStats, readSpiderStats, STATS_PATH };