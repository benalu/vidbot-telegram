// scripts/spider-lk21.js
const axios = require('axios');
const cheerio = require('cheerio');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const { escape } = require('../src/formats/utils');
const logger = require('../src/utils/logger');
const { sendAlert } = require('../src/utils/alerting');
const { searchMovieMeta } = require('../src/utils/tmdb');
const { saveMovieLocal, updateMovieR2, getMovieByHash, searchMoviesLocal } = require('../src/features/movies/movies.repo');
const { executeMoviePipeline, pendingMovieMeta, clearPendingMovie } = require('../src/features/movies/movies.admin');

// ─── ENV CONSTANTS ───────────────────────
const WORKER_URL = process.env.TURBOVIP_WORKER_URL;
const ARCHIVE_CHANNEL = process.env.TELEGRAM_ARCHIVE_MOVS_CHANNEL_ID;
const ADMIN_GROUP_ID = process.env.TELEGRAM_ADMIN_GROUP_ID;
const ADMIN_THREAD_SPIDER = Number(process.env.TELEGRAM_ADMIN_THREAD_SPIDER || 0);
const M3U8_THREAD_COUNT = Math.max(1, parseInt(process.env.M3U8_THREAD_COUNT || '2', 10) || 2);
const LK21_PREFER_QUALITY = (process.env.LK21_PREFER_QUALITY || 'lowest').toLowerCase();

// ─── STATS FILE ──────────────────────────────────────────────────────────────
const LK21_STATS_PATH = path.join(__dirname, '../data/movies/spider-lk21-stats.json');

// Session counters — di-reset setiap restart bot
let statsSession = {
  total_success:   0,
  total_failed:    0,
  total_duplicate: 0,
  total_size_bytes: 0,
  total_duration_ms: 0,
};

// ─── PATH CONSTANTS — dihitung sekali saat module load ───────────────────────
const IS_WINDOWS   = process.platform === 'win32';
const BINARY_NAME  = IS_WINDOWS ? 'N_m3u8DL-RE.exe' : 'N_m3u8DL-RE';
const EXE_PATH     = path.join(__dirname, 'tools', BINARY_NAME);
const DOWNLOAD_DIR = path.join(__dirname, 'Downloads');

// Setup direktori saat module load — tidak perlu cek ulang setiap invokasi
if (!fs.existsSync(path.join(__dirname, 'tools'))) {
  fs.mkdirSync(path.join(__dirname, 'tools'), { recursive: true });
}
if (!fs.existsSync(DOWNLOAD_DIR)) {
  fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
}

// ID-7 — Validasi binary saat module load
// Lebih baik gagal sekarang dengan pesan jelas daripada gagal di tengah pipeline
// setelah DOM parsing dan M3U8 extraction sudah selesai.
try {
  fs.accessSync(EXE_PATH, fs.constants.X_OK);
  logger.info({ event: 'lk21_binary_ok', path: EXE_PATH });
} catch (err) {
  // Jangan crash — bot mungkin berjalan di platform lain atau binary belum dipasang.
  // Log warning saja; error yang spesifik akan muncul saat spawn dipanggil.
  logger.warn({
    event: 'lk21_binary_missing_or_not_executable',
    path:  EXE_PATH,
    msg:   err.message,
    hint:  'Pastikan N_m3u8DL-RE ada di scripts/tools/ dan sudah chmod +x'
  });
}

function gaussianRandom(min, max) {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  let num = Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
  num = num / 10.0 + 0.5;
  if (num > 1 || num < 0) return gaussianRandom(min, max); 
  return Math.floor(num * (max - min) + min);
}

const randomDelay = (min = 1500, max = 3500) => {
  return new Promise(resolve => setTimeout(resolve, gaussianRandom(min, max)));
};

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:123.0) Gecko/20100101 Firefox/123.0',
];

const REFERERS = [
  'https://www.google.com/search?q=nonton+film+terbaru',
  'https://www.google.com/search?q=nonton+film+subtitle+indonesia',
  'https://www.google.com/',
  'https://www.facebook.com/',
];

const getRandomHeaders = () => ({
  'User-Agent': USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)],
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Referer': REFERERS[Math.floor(Math.random() * REFERERS.length)],
});


// Helper retry untuk axios GET — transient timeout/network error dicoba ulang
// maxAttempts=3 berarti 1 attempt awal + 2 retry
async function axiosGetWithRetry(url, opts, maxAttempts = 3) {
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await axios.get(url, opts);
    } catch (err) {
      lastErr = err;
      const status = err.response?.status;
      if (status === 403 || status === 404) throw err;
      if (status === 429) {
        throw new Error('Worker rate limit tercapai (HTTP 429). Coba lagi beberapa jam lagi.');
      }
      if (attempt < maxAttempts) {
        const backoff = attempt * 2000; // 2 detik, 4 detik
        logger.warn({ event: 'axios_retry', attempt, url: url.slice(0, 80), msg: err.message });
        await new Promise(r => setTimeout(r, backoff));
      }
    }
  }
  throw lastErr;
}

async function extractTurbovip(iframeUrl) {
  // FIX #9 — Guard jika env belum diset
  if (!WORKER_URL) throw new Error('TURBOVIP_WORKER_URL belum diset di .env');

  const match = iframeUrl.match(/turbovip\/([a-zA-Z0-9]+)/);
  if (!match) throw new Error('Format URL Turbovip tidak valid');
  const videoId = match[1];

  const proxyPlayerUrl = `${WORKER_URL}?url=${encodeURIComponent(`https://turbovidhls.com/t/${videoId}`)}`;
  const playerRes = await axiosGetWithRetry(proxyPlayerUrl, { headers: getRandomHeaders(), timeout: 10000 });

  const urlPlayMatch = playerRes.data.match(/var urlPlay\s*=\s*['"](.*?)['"]/);
  if (!urlPlayMatch) throw new Error('Gagal menemukan urlPlay Turbovip');
  let urlPlay = urlPlayMatch[1];

  if (urlPlay.startsWith('//')) {
    urlPlay = 'https:' + urlPlay;
  } else if (urlPlay.startsWith('/')) {
    urlPlay = 'https://turbovidhls.com' + urlPlay;
  }

  const proxyM3u8Url = `${WORKER_URL}?url=${encodeURIComponent(urlPlay)}`;
  const m3u8Res = await axiosGetWithRetry(proxyM3u8Url, { headers: getRandomHeaders(), timeout: 10000 });

  const lines = m3u8Res.data.replace(/\r/g, '').split('\n');
  const streams = [];

  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('#EXT-X-STREAM-INF:')) {
      const bwMatch = lines[i].match(/BANDWIDTH=(\d+)/);
      const resMatch = lines[i].match(/RESOLUTION=([^,]+)/);
      const streamUrl = lines[i + 1] ? lines[i + 1].trim() : '';
      if (streamUrl) {
        let absoluteStreamUrl = streamUrl;
        if (!streamUrl.startsWith('http')) {
          try {
            absoluteStreamUrl = new URL(streamUrl, urlPlay).href;
          } catch (_) {
            absoluteStreamUrl = streamUrl;
          }
        }
        streams.push({
          quality: resMatch ? resMatch[1] : 'Unknown',
          bandwidth: bwMatch ? parseInt(bwMatch[1]) : 0,
          url: absoluteStreamUrl
        });
      }
    }
  }
  streams.sort((a, b) => b.bandwidth - a.bandwidth);
  return { videoId, streams, masterM3u8: urlPlay };
}

// ─── DOWNLOADER ─────────────────────────────────────────────────────────────
async function downloadM3u8(m3u8Url, safeFileName, onProgress) {

  const args = [
    m3u8Url,
    '--header', 'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
    '--header', 'Referer: https://turbovidhls.com/',
    '--save-name', safeFileName,
    '--save-dir', DOWNLOAD_DIR,
    '--tmp-dir', DOWNLOAD_DIR,
    '--thread-count', String(M3U8_THREAD_COUNT),
    '--download-retry-count', '3',
    '--auto-select',
    '--mp4-real-time-decryption'
  ];

  return new Promise((resolve, reject) => {
    logger.info({ event: 'download_started', target: safeFileName });

    const DOWNLOAD_TIMEOUT_MS = 45 * 60 * 1000; // 45 menit
    let settled = false;

    const dlProcess = spawn(EXE_PATH, args);
    let lastReportedCheckpoint = 0;

    // BL-9 — Global timeout guard: jika binary hang dan tidak pernah emit
    // close/error, Promise akan hang selamanya dan seedMovsLock tidak
    // pernah di-release. Kill proses dan reject setelah 45 menit.
    const globalTimeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      logger.warn({ event: 'download_timeout', target: safeFileName, limit_min: 45 });
      try { dlProcess.kill('SIGKILL'); } catch (_) {}
      reject(new Error('Download timeout: N_m3u8DL-RE tidak selesai dalam 45 menit.'));
    }, DOWNLOAD_TIMEOUT_MS);

    dlProcess.stdout.on('data', (data) => {
      const text = data.toString().trim();
      if (!text) return;

      const match = text.match(/(\d{1,3})(?:\.\d+)?%/);
      const speedMatch = text.match(/([\d.]+)\s*(KB\/s|MB\/s|GB\/s)/i);
      const speedText = speedMatch ? `${speedMatch[1]} ${speedMatch[2]}` : null;

      if (match) {
        const currentProgress = parseInt(match[1], 10);
        const checkpoint = Math.floor(currentProgress / 20) * 20;
        if (checkpoint > lastReportedCheckpoint && checkpoint < 100) {
          logger.info({ event: 'download_progress', progress: `${checkpoint}%`, speed: speedText, target: safeFileName });
          if (onProgress) onProgress(checkpoint, speedText);
          lastReportedCheckpoint = checkpoint;
        }
      } else {
        const cleanText = text.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '');
        if (cleanText.includes('INFO') || cleanText.includes('WARN') || cleanText.includes('ERROR') || cleanText.match(/muxing|merging|done/i)) {
          logger.info({ event: 'downloader_status', msg: cleanText });
        }
      }
    });

    dlProcess.stderr.on('data', (data) => {
      const msg = data.toString();
      if (msg.includes('ERROR')) {
        logger.warn({ event: 'downloader_error', msg: msg.trim() });
      }
    });

    dlProcess.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(globalTimeout);
      if (code === 0) {
        logger.info({ event: 'download_success', target: safeFileName });
        resolve(path.join(DOWNLOAD_DIR, `${safeFileName}.mp4`));
      } else {
        reject(new Error(`N_m3u8DL-RE gagal dengan kode exit: ${code}`));
      }
    });

    dlProcess.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(globalTimeout);
      reject(err);
    });
  });
}

async function notifySpiderSuccess(ctx, meta, fileStats, archiveMsgId, fileHash) {
  if (!ADMIN_GROUP_ID || !ADMIN_THREAD_SPIDER) return;

  const sizeMb = (fileStats.size / 1024 / 1024).toFixed(2);
  const text =
    `🕸️ *LK21 Spider Selesai*\n\n` +
    `🎬 *${escape(meta.title || 'LK21 Movie')}*\n` +
    `📅 Tahun: ${escape(meta.year || '-')}\n` +
    `📦 Ukuran: ${escape(sizeMb)} MB\n` +
    `🆔 Archive Msg: ${archiveMsgId}\n` +
    `🧾 File Hash: \`${escape(fileHash)}\``;

  await ctx.telegram.sendMessage(ADMIN_GROUP_ID, text, {
    parse_mode: 'MarkdownV2',
    message_thread_id: ADMIN_THREAD_SPIDER
  }).catch(() => {});
}

async function prosesDownloadSelesai({ ctx, waitMsg, localFilePath, cleanTitle, year = '', fileStats, tgFileId, archiveMsgId, userId, threadId, fileHash, tmdbMeta = null, lockStartTime = null }) {
  try {
    const meta = tmdbMeta || (await searchMovieMeta(cleanTitle, year));

    if (meta) {
      logger.info({ event: 'lk21_tmdb_match_success', title: meta.title });

      await executeMoviePipeline({
        meta,
        localPath:  localFilePath,
        fileSize:   fileStats.size,
        mimeType:   'video/mp4',
        ext:        'mp4',
        fileId:     tgFileId,
        messageId:  archiveMsgId,
        fileHash:   fileHash,
        onBgError:  (errMsg) => {
          ctx.reply(
            `⚠️ *R2 Upload Gagal*\n🎬 *${escape(meta.title)}*\n_${escape(errMsg)}_`,
            { parse_mode: 'MarkdownV2', message_thread_id: threadId }
          ).catch(() => {})
        }
      });

      await ctx.telegram.editMessageText(
        ctx.chat.id,
        waitMsg.message_id,
        undefined,
        `✅ *Spider Sukses\\!*\n🎬 *${escape(meta.title)}* \\(${escape(meta.year)}\\)\n_Upload R2 & Sinkronisasi API berjalan di background\\._`,
        { parse_mode: 'MarkdownV2' }
      );

      await notifySpiderSuccess(ctx, meta, fileStats, archiveMsgId, fileHash);
      updateLk21Stats({
        success:     true,
        title:       meta.title,
        size_bytes:  fileStats.size,
        duration_ms: Date.now() - (lockStartTime || Date.now()),
        status:      'IDLE',
        active_title: '',
      });

    } else {
      logger.warn({ event: 'lk21_tmdb_not_found', title: cleanTitle });

      // FIX #5 — Set state ke Map DULU, baru buat timeout.
      pendingMovieMeta.set(userId, {
        fileId:        tgFileId,
        archiveMsgId:  archiveMsgId,
        fileSize:      fileStats.size,
        fileHash:      fileHash,
        mimeType:      'video/mp4',
        localPath:     localFilePath,
        ext:           'mp4',
        timeoutHandle: null
      });

      const timeoutHandle = setTimeout(() => {
        const stale = pendingMovieMeta.get(userId);
        if (stale && stale.archiveMsgId === archiveMsgId) {
          if (stale.localPath && fs.existsSync(stale.localPath)) {
            try { fs.unlinkSync(stale.localPath); } catch (e) {}
          }
          pendingMovieMeta.delete(userId);
          logger.info({ event: 'lk21_pending_timeout', title: cleanTitle });
        }
      }, 30 * 60 * 1000);

      pendingMovieMeta.get(userId).timeoutHandle = timeoutHandle;

      await ctx.telegram.editMessageText(
        ctx.chat.id,
        waitMsg.message_id,
        undefined,
        `⚠️ *Spider Berhasil, Tapi TMDB Gagal\\!*\n\nPencarian untuk _${escape(cleanTitle)}_ tidak akurat\\.\n👉 Balas pesan ini dengan *ID TMDB* manual agar pipeline berjalan:`,
        { parse_mode: 'MarkdownV2' }
      );
    }

  } catch (err) {
    if (localFilePath && fs.existsSync(localFilePath)) {
      try { fs.unlinkSync(localFilePath); } catch (e) {}
    }
    logger.error({ event: 'lk21_process_failed', msg: err.message });
    ctx.reply(`❌ *Spider Gagal:* ${escape(err.message)}`, { parse_mode: 'MarkdownV2', message_thread_id: threadId });
  }
}

async function notifySpiderError(url, phase, errMessage) {
  try {
    await sendAlert(
      `🔴 *LK21 Spider Gagal*\n\n` +
      `📍 Fase: \`${escape(phase)}\`\n` +
      `❌ Error: _${escape(errMessage.slice(0, 300))}_\n` +
      `🔗 URL: \`${escape(url.slice(0, 100))}\``
    )
  } catch (_) {}
}

function updateLk21Stats(patch) {
  try {
    let current = {}
    if (fs.existsSync(LK21_STATS_PATH)) {
      current = JSON.parse(fs.readFileSync(LK21_STATS_PATH, 'utf8'))
    }

    // Merge patch ke persistent stats
    current.total_success   = (current.total_success   || 0) + (patch.success   ? 1 : 0)
    current.total_failed    = (current.total_failed    || 0) + (patch.failed    ? 1 : 0)
    current.total_duplicate = (current.total_duplicate || 0) + (patch.duplicate ? 1 : 0)

    if (patch.size_bytes) {
      current.total_size_bytes  = (current.total_size_bytes  || 0) + patch.size_bytes
      current.total_success_for_avg = (current.total_success_for_avg || 0) + 1
      current.avg_size_mb = ((current.total_size_bytes / current.total_success_for_avg) / 1024 / 1024).toFixed(1)
    }

    if (patch.duration_ms) {
      current.total_duration_ms      = (current.total_duration_ms || 0) + patch.duration_ms
      current.total_duration_for_avg = (current.total_duration_for_avg || 0) + 1
      current.avg_duration_min       = ((current.total_duration_ms / current.total_duration_for_avg) / 1000 / 60).toFixed(1)
    }

    if (patch.title) {
      current.last_movie        = patch.title
      current.last_processed_at = new Date().toISOString()
    }

    if (patch.status       !== undefined) current.status       = patch.status
    if (patch.active_title !== undefined) current.active_title = patch.active_title
    if (patch.lock_start   !== undefined) current.lock_start   = patch.lock_start

    current.last_updated = new Date().toISOString()

    // Pastikan direktori ada
    const dir = path.dirname(LK21_STATS_PATH)
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })

    fs.writeFileSync(LK21_STATS_PATH, JSON.stringify(current, null, 2))
  } catch (err) {
    logger.warn({ event: 'lk21_stats_write_failed', msg: err.message })
  }
}


// ─── MAIN HANDLER ───────────────────────────────────────────────────────────

let seedMovsLock = false;

async function handleSeedMovs(ctx) {
  const threadId = ctx.message.message_thread_id;

  if (!ARCHIVE_CHANNEL) {
    return ctx.reply('❌ *Konfigurasi Error:* TELEGRAM_ARCHIVE_MOVS_CHANNEL_ID belum diset di \\.env', { parse_mode: 'MarkdownV2', message_thread_id: threadId });
  }

  if (!WORKER_URL) {
    return ctx.reply('❌ *Konfigurasi Error:* TURBOVIP_WORKER_URL belum diset di \\.env', { parse_mode: 'MarkdownV2', message_thread_id: threadId });
  }

  if (seedMovsLock) {
    return ctx.reply('⏳ *Bot Sedang Sibuk*\nBot sedang memproses unduhan LK21 lain\\. Harap tunggu hingga selesai sebelum mengantre film baru\\.', { parse_mode: 'MarkdownV2', message_thread_id: threadId });
  }

  const args = ctx.message.text.split(/\s+/);
  const url = args[1];
  const userId = String(ctx.from.id);

  // FIX B-1 — Tambah validasi url.startsWith('http') agar input tanpa
  // protocol (contoh: "lk21" atau "lk21.one/film/...") tidak lolos validasi
  // dan axios.get() tidak throw ERR_INVALID_URL yang tidak informatif.
  if (!url || !url.startsWith('http') || !url.includes('lk21')) {
    return ctx.reply(
      '❌ Format salah\\. Gunakan: `/seedmovs <url_lk21>`\n_Contoh: `https://lk21\\.one/film/judul\\-film`_',
      { parse_mode: 'MarkdownV2', message_thread_id: threadId }
    );
  }

  // Set lock SETELAH semua validasi awal lulus
  seedMovsLock = true;
  const lockStartTime = Date.now();
  let localFilePath = null;
  let activeSafeFileName = null;
  let currentPhase = 'init';
  updateLk21Stats({ status: 'PROCESSING', lock_start: new Date().toISOString(), active_title: '...' });
  const waitMsg = await ctx.reply('⏳ *Menganalisis URL LK21\\.\\.\\.*', { parse_mode: 'MarkdownV2', message_thread_id: threadId });

  try {
    // 1. DOM Parsing
    currentPhase = 'dom_parsing';
    let pageData;
    try {
      const resp = await axiosGetWithRetry(url, { headers: getRandomHeaders(), timeout: 15000 });
      pageData = resp.data;
      
      // Deteksi Cloudflare challenge
      if (resp.status === 403 || 
          (typeof pageData === 'string' && (
            pageData.includes('cf-browser-verification') ||
            pageData.includes('Just a moment') ||
            pageData.includes('Checking your browser') ||
            pageData.includes('cf_clearance')
          ))
      ) {
        throw new Error('Halaman LK21 diblokir oleh Cloudflare. Bot tidak bisa bypass proteksi ini secara otomatis.');
      }
    } catch (err) {
      if (err.response?.status === 403) {
        throw new Error('Akses ditolak (HTTP 403) — Cloudflare memblokir request. Coba lagi nanti atau gunakan URL berbeda.');
      }
      throw err;
    }

    const $ = cheerio.load(pageData);

    let rawTitle = $('div.movie-info > h1').text() || $('h1').first().text();
    let cleanTitle = rawTitle
    .replace(/^Nonton\s+/i, '')           // "Nonton X" → "X"
    .replace(/^Download\s+Film\s+/i, '')  // "Download Film X" → "X"
    .replace(/^Nonton\s+Film\s+/i, '')    // "Nonton Film X" → "X"
    .replace(/^Film\s+/i, '')             // "Film X" → "X" (sisa setelah strip prefix lain)
    .replace(/\s*Sub(?:title)?\s+Indo(?:nesia)?\s+di\s+Lk21\s*$/i, '')  // "... Sub Indo di Lk21"
    .replace(/\s*Sub(?:title)?\s+Indo(?:nesia)?\s*$/i, '')               // "... Sub Indo" atau "... Subtitle Indonesia"
    .replace(/\s*\|\s*.*$/i, '')          // "Judul | Kategori" → "Judul"
    .replace(/\s+/g, ' ')                 // normalize multiple whitespace
    .trim();

    if (!cleanTitle) {
      throw new Error('Gagal mengekstrak judul. Struktur halaman LK21 mungkin berubah atau terkena Cloudflare protection.');
    }
    updateLk21Stats({ status: 'PROCESSING', active_title: cleanTitle, lock_start: new Date().toISOString() });

    let year = '';
    const yearMatch = cleanTitle.match(/\((\d{4})\)/);
    if (yearMatch) {
      year = yearMatch[1];
      cleanTitle = cleanTitle.replace(/\(\d{4}\)/, '').trim();
    }

    if (year) {
      const existingMovies = searchMoviesLocal(cleanTitle);
      const duplicate = existingMovies.find(m => m.year === year);
      if (duplicate) {
        logger.info({ event: 'lk21_early_duplicate_found', title: cleanTitle, year });
        updateLk21Stats({ duplicate: true, title: cleanTitle, status: 'IDLE' });
        return ctx.telegram.editMessageText(
          ctx.chat.id, waitMsg.message_id, undefined,
          `ℹ️ Film *${escape(cleanTitle)}* \\(${escape(year)}\\) sudah ada di database\\. Unduhan dibatalkan\\.`,
          { parse_mode: 'MarkdownV2' }
        );
      }
    }

    let targetUrl = $('ul#player-list li a[data-server="turbovip"]').attr('data-url') ||
                    $('ul#player-list li a[data-server="turbovip"]').attr('href');

    if (!targetUrl) {
      $('iframe').each((i, el) => {
        const src = $(el).attr('src');
        if (src && src.includes('/turbovip/')) { targetUrl = src; return false; }
      });
    }

    if (!targetUrl) throw new Error('Iframe Turbovip tidak ditemukan di halaman ini.');

    await ctx.telegram.editMessageText(ctx.chat.id, waitMsg.message_id, undefined, `⏳ Ekstraksi M3U8 *${escape(cleanTitle)}*\\.\\.\\.`, { parse_mode: 'MarkdownV2' });
    await randomDelay(1500, 3000);

    // 2. Ekstraksi M3U8
    currentPhase = 'm3u8_extraction';
    const result = await extractTurbovip(targetUrl);

    const preferBest = LK21_PREFER_QUALITY === 'best' || LK21_PREFER_QUALITY === 'highest';
    const targetStream = preferBest ? result.streams[0] : result.streams[result.streams.length - 1];
    if (!targetStream) {
      logger.warn({ event: 'm3u8_parsing_empty', url: targetUrl });
      throw new Error('Tidak ada stream video yang valid.');
    }

    logger.info({
      event: 'lk21_stream_selected',
      preference: LK21_PREFER_QUALITY,
      quality: targetStream.quality,
      bandwidth: targetStream.bandwidth,
      url: targetStream.url
    });

    const safePart = cleanTitle.replace(/[^a-zA-Z0-9]/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '');
    activeSafeFileName = `${safePart || 'movie'}_${crypto.randomBytes(4).toString('hex')}`;

    await ctx.telegram.editMessageText(ctx.chat.id, waitMsg.message_id, undefined, `📥 *Mengunduh Video* \\[${escape(targetStream.quality)}\\]\n⏳ Progress: *0%*\n_Proses ini memakan waktu beberapa menit\\._`, { parse_mode: 'MarkdownV2' });

    // 3. Download ke VPS
    currentPhase = 'download';
    localFilePath = await downloadM3u8(targetStream.url, activeSafeFileName, (percent, speedText) => {
      const speedLabel = speedText ? ` · ${escape(speedText)}` : '';
      ctx.telegram.editMessageText(
        ctx.chat.id,
        waitMsg.message_id,
        undefined,
        `📥 *Mengunduh Video* \\[${escape(targetStream.quality)}\\]\n⏳ Progress: *${percent}%${speedLabel}*\n_Sedang berjalan\\.\\.\\._`,
        { parse_mode: 'MarkdownV2' }
      ).catch((err) => {
        if (!err.message.includes('429')) {
          logger.warn({ event: 'telegram_progress_edit_failed', msg: err.message });
        }
      });
    });

    if (!fs.existsSync(localFilePath)) {
      throw new Error('N_m3u8DL-RE gagal membentuk file video.');
    }

    const fileStats = fs.statSync(localFilePath);
    if (fileStats.size < 1024 * 1024) {
      throw new Error('File hasil unduhan korup atau terlalu kecil (Kurang dari 1 MB).');
    }

    const fileHash = crypto.createHash('sha256')
      .update(`LK21_SPIDER:${cleanTitle}:${year}:${fileStats.size}`)
      .digest('hex');

    // FIX B-2 — Tambah try-catch di sekitar unlinkSync.
    // Tanpa guard ini, jika file sudah terhapus oleh sweepOrphanedFiles
    // atau proses lain (race condition), ENOENT akan masuk ke catch utama
    // dan menghasilkan error message menyesatkan seolah pipeline yang gagal.
    if (getMovieByHash(fileHash)) {
      try { fs.unlinkSync(localFilePath); } catch (e) {
        logger.warn({ event: 'lk21_unlink_skip', msg: e.message, file: localFilePath });
      }
      updateLk21Stats({ duplicate: true, title: cleanTitle, status: 'IDLE' });
      return ctx.telegram.editMessageText(ctx.chat.id, waitMsg.message_id, undefined, `ℹ️ Film *${escape(cleanTitle)}* sudah ada di database\\. Unduhan dibatalkan\\.`, { parse_mode: 'MarkdownV2' });
    }

    await ctx.telegram.editMessageText(ctx.chat.id, waitMsg.message_id, undefined, `🚀 *Mengunggah ke Archive Channel\\.\\.\\.*\nUkuran: ${escape((fileStats.size / 1024 / 1024).toFixed(2))} MB`, { parse_mode: 'MarkdownV2' });

    // 4. Upload ke Telegram Archive
    currentPhase = 'telegram_upload';
    logger.info({ event: 'telegram_upload_start', target: cleanTitle, size_mb: (fileStats.size / 1024 / 1024).toFixed(2) });

    const resHeight = targetStream.quality.split('x').pop();
    const qualityLabel = isNaN(resHeight) ? targetStream.quality : `${resHeight}p`;

    let tmdbMeta = null;
    let thumbBuffer = null;

    await ctx.telegram.editMessageText(ctx.chat.id, waitMsg.message_id, undefined, `🔍 *Mencari Metadata TMDB\.\.\.*`, { parse_mode: 'MarkdownV2' });
    tmdbMeta = await searchMovieMeta(cleanTitle, year);

    if (tmdbMeta?.poster) {
      try {
        const posterRes = await axios.get(
          tmdbMeta.poster.replace('/original/', '/w500/'),
          { responseType: 'arraybuffer', timeout: 8000 }
        );
        thumbBuffer = Buffer.from(posterRes.data);
      } catch (e) {
        logger.warn({ event: 'tmdb_poster_fetch_failed', title: cleanTitle, msg: e.message });
      }
    }

    let richCaption;
    if (tmdbMeta) {
      const sizeMb = (fileStats.size / 1024 / 1024).toFixed(1);
      const overviewTrunc = tmdbMeta.overview
        ? (tmdbMeta.overview.length > 200 ? tmdbMeta.overview.slice(0, 197) + '...' : tmdbMeta.overview)
        : null;

      richCaption = [
        `🎬 ${tmdbMeta.title} (${tmdbMeta.year})`,
        tmdbMeta.rating ? `⭐ ${tmdbMeta.rating}` : null,
        tmdbMeta.duration ? `⏱ ${tmdbMeta.duration}` : null,
        tmdbMeta.genre ? `🎭 ${tmdbMeta.genre}` : null,
        overviewTrunc ? `📝 ${overviewTrunc}` : null,
        `🎞 ${qualityLabel} · 📦 ${sizeMb} MB · Spider LK21`,
      ].filter(Boolean).join('\n');
    } else {
      richCaption = `${cleanTitle}${year ? ` (${year})` : ''} - ${qualityLabel} · Spider LK21`;
    }

    if (richCaption.length > 1024) richCaption = richCaption.slice(0, 1021) + '...';

    let sent;
    let uploadAttempt = 0;
    while (uploadAttempt < 3) {
      try {
        const sendOpts = {
          caption: richCaption,
          supports_streaming: true,
        };
        if (thumbBuffer && thumbBuffer.length > 1000) {
          sendOpts.thumbnail = { source: thumbBuffer, filename: 'thumb.jpg' };
        }
        try {
          fs.accessSync(localFilePath, fs.constants.R_OK);
        } catch (e) {
          throw new Error(`File tidak bisa dibaca sebelum upload: ${e.message}`);
        }
        sent = await ctx.telegram.sendVideo(ARCHIVE_CHANNEL, { source: localFilePath }, sendOpts);
        break;
      } catch (uploadErr) {
        uploadAttempt++;
        logger.warn({ event: 'telegram_upload_retry', attempt: uploadAttempt, msg: uploadErr.message });
        if (uploadAttempt >= 3) {
          throw new Error(`Gagal upload ke Telegram setelah 3 percobaan: ${uploadErr.message}`);
        }
        await randomDelay(3000, 6000);
      }
    }

    const archiveMsgId = sent.message_id;
    const tgFileId = sent.video.file_id;
    logger.info({ event: 'telegram_upload_success', archive_msg_id: archiveMsgId });

    // 5. Automasi TMDB & Database
    currentPhase = 'tmdb_pipeline';
    await prosesDownloadSelesai({
      ctx, waitMsg, localFilePath, cleanTitle, year,
      fileStats, tgFileId, archiveMsgId,
      userId, threadId, fileHash, tmdbMeta, lockStartTime,
    });
  } catch (err) {
    try {
      if (localFilePath && fs.existsSync(localFilePath)) {
        fs.unlinkSync(localFilePath);
      }
      if (activeSafeFileName) {
        const partialFile = path.join(DOWNLOAD_DIR, `${activeSafeFileName}.mp4`);
        const tmpFolder = path.join(DOWNLOAD_DIR, activeSafeFileName);
        if (fs.existsSync(partialFile)) fs.unlinkSync(partialFile);
        if (fs.existsSync(tmpFolder)) fs.rmSync(tmpFolder, { recursive: true, force: true });
      }
    } catch (cleanupErr) {
      logger.warn({ event: 'lk21_cleanup_error', msg: cleanupErr.message });
    }
    updateLk21Stats({ failed: true, status: 'IDLE', active_title: '' });
    await notifySpiderError(url || 'unknown', currentPhase, err.message);

    ctx.telegram.deleteMessage(ctx.chat.id, waitMsg.message_id).catch(() => {});
    ctx.reply(`❌ *Gagal:* ${escape(err.message)}`, { parse_mode: 'MarkdownV2', message_thread_id: threadId });
  } finally {
    seedMovsLock = false;
    updateLk21Stats({ status: 'IDLE', active_title: '' });
  }
}

async function handleSeedMovsStatus(ctx) {
  const threadId = ctx.message.message_thread_id;

  try {
    const lockStatus = seedMovsLock ? '🔴 Aktif' : '🟢 Idle';

    let statsText = '_Belum ada data statistik\\._';
    if (fs.existsSync(LK21_STATS_PATH)) {
      const stats = JSON.parse(fs.readFileSync(LK21_STATS_PATH, 'utf8'));

      const activeTitle = stats.active_title
        ? `\n🎬 *Film Saat Ini:* _${escape(stats.active_title)}_` : '';

      let lockDuration = '';
      if (seedMovsLock && stats.lock_start) {
        const elapsedMin = ((Date.now() - new Date(stats.lock_start).getTime()) / 1000 / 60).toFixed(1);
        lockDuration = `\n⏱ *Berjalan:* ${escape(elapsedMin)} menit`;
      }

      const lastMovie = stats.last_movie
        ? `\n🎞 *Film Terakhir:* _${escape(stats.last_movie)}_` : '';

      const lastAt = stats.last_processed_at
        ? `\n🕐 *Diproses:* ${escape(new Date(stats.last_processed_at).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' }))}` : '';

      statsText =
        `✅ Berhasil: *${stats.total_success || 0}*\n` +
        `❌ Gagal: *${stats.total_failed || 0}*\n` +
        `♻️ Duplikat: *${stats.total_duplicate || 0}*\n` +
        `📦 Rata\\-rata ukuran: *${stats.avg_size_mb || '\\-'} MB*\n` +
        `⏱ Rata\\-rata durasi: *${stats.avg_duration_min || '\\-'} menit*` +
        lastMovie + lastAt;

      statsText = activeTitle + lockDuration + '\n\n' + statsText;
    }

    await ctx.reply(
      `🕸️ *LK21 Spider Status*\n\n` +
      `🔒 *Lock:* ${lockStatus}\n` +
      `${statsText}`,
      { parse_mode: 'MarkdownV2', message_thread_id: threadId }
    );
  } catch (err) {
    logger.warn({ event: 'seedmovs_status_error', msg: err.message });
    await ctx.reply('❌ Gagal membaca status LK21 spider\\.', {
      parse_mode: 'MarkdownV2', message_thread_id: threadId
    });
  }
}

function sweepOrphanedFiles() {
  if (!fs.existsSync(DOWNLOAD_DIR)) return;
  try {
    const entries = fs.readdirSync(DOWNLOAD_DIR);
    const now = Date.now();
    let swept = 0;

    for (const entry of entries) {
      const entryPath = path.join(DOWNLOAD_DIR, entry);
      let stats;
      try {
        stats = fs.statSync(entryPath);
      } catch (e) {
        continue;
      }

      const age = now - stats.mtimeMs;
      const OLD_ENOUGH = 2 * 60 * 60 * 1000; // 2 jam

      if (age <= OLD_ENOUGH) continue;

      if (stats.isDirectory()) {
        try {
          fs.rmSync(entryPath, { recursive: true, force: true });
          swept++;
          logger.info({ event: 'orphaned_dir_swept', path: entryPath });
        } catch (e) {
          logger.warn({ event: 'orphaned_dir_sweep_failed', path: entryPath, msg: e.message });
        }
      } else {
        const ext = path.extname(entry).toLowerCase();
        if (ext === '.mp4' || ext === '.ts') {
          try {
            fs.unlinkSync(entryPath);
            swept++;
          } catch (e) {
            logger.warn({ event: 'orphaned_file_sweep_failed', path: entryPath, msg: e.message });
          }
        }
      }
    }

    if (swept > 0) logger.info({ event: 'orphaned_files_swept', count: swept });
  } catch (err) {
    logger.warn({ event: 'orphaned_files_sweep_failed', msg: err.message });
  }
}

setImmediate(() => sweepOrphanedFiles());

module.exports = { handleSeedMovs, handleSeedMovsStatus };