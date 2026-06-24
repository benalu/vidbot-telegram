// src/utils/sweep.js
// Generic disk sweeper — hapus file/dir orphan yang lebih tua dari maxAgeMs.
// Dipindah dari spider-lk21.js agar bisa dipakai oleh spider MP3 atau pipeline lain.

const fs     = require('fs');
const path   = require('path');
const logger = require('./logger');

/**
 * Hapus file dan direktori orphan di targetDir yang lebih tua dari maxAgeMs.
 * Hanya file dengan ekstensi di allowedExts yang dihapus — direktori selalu dihapus recursive.
 *
 * @param {string}   targetDir               - Path direktori yang di-sweep
 * @param {object}   [opts]
 * @param {number}   [opts.maxAgeMs]         - Umur minimum sebelum dihapus (default: 2 jam)
 * @param {string[]} [opts.allowedExts]      - Ekstensi file yang boleh dihapus (default: ['.mp4', '.ts'])
 */
function sweepOrphanedFiles(targetDir, { maxAgeMs = 2 * 60 * 60 * 1000, allowedExts = ['.mp4', '.ts'] } = {}) {
  if (!fs.existsSync(targetDir)) return;

  let swept = 0;
  const now = Date.now();

  for (const entry of fs.readdirSync(targetDir)) {
    const entryPath = path.join(targetDir, entry);
    let stats;
    try { stats = fs.statSync(entryPath); } catch { continue; }

    if (now - stats.mtimeMs <= maxAgeMs) continue;

    try {
      if (stats.isDirectory()) {
        fs.rmSync(entryPath, { recursive: true, force: true });
        logger.info({ event: 'sweep_removed_dir', path: entryPath });
      } else if (allowedExts.includes(path.extname(entry).toLowerCase())) {
        fs.unlinkSync(entryPath);
        logger.info({ event: 'sweep_removed_file', path: entryPath });
      } else {
        continue;
      }
      swept++;
    } catch (e) {
      logger.warn({ event: 'sweep_failed', path: entryPath, msg: e.message });
    }
  }

  if (swept > 0) logger.info({ event: 'sweep_done', count: swept, dir: targetDir });
}

module.exports = { sweepOrphanedFiles };