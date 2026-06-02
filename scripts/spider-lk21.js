// scripts/spider-lk21.js
const axios = require('axios');
const cheerio = require('cheerio');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const { escape } = require('../src/formats/utils');
const logger = require('../src/utils/logger');
const { searchMovieMeta } = require('../src/utils/tmdb');
const { saveMovieLocal, updateMovieR2, getMovieByHash, searchMoviesLocal } = require('../src/features/movies/movies.repo');
const { executeMoviePipeline, pendingMovieMeta, clearPendingMovie } = require('../src/features/movies/movies.admin');

// FIX #9 — WORKER_URL dipindah ke env, tidak hardcode
const WORKER_URL = process.env.TURBOVIP_WORKER_URL;
const ARCHIVE_CHANNEL = process.env.TELEGRAM_ARCHIVE_MOVS_CHANNEL_ID;
const ADMIN_GROUP_ID = process.env.TELEGRAM_ADMIN_GROUP_ID;
const ADMIN_THREAD_SPIDER = Number(process.env.TELEGRAM_ADMIN_THREAD_SPIDER || 0);
const M3U8_THREAD_COUNT = Math.max(1, parseInt(process.env.M3U8_THREAD_COUNT || '2', 10) || 2);
const LK21_PREFER_QUALITY = (process.env.LK21_PREFER_QUALITY || 'lowest').toLowerCase();

const randomDelay = (min = 1500, max = 3500) => {
  return new Promise(resolve => setTimeout(resolve, Math.floor(Math.random() * (max - min + 1)) + min));
};

const getRandomHeaders = () => ({
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Referer': 'https://www.google.com/search?q=nonton+film+terbaru'
});

// FIX #8 — Class tidak perlu, tidak ada state yang disimpan. Jadikan function biasa.
async function extractTurbovip(iframeUrl) {
  // FIX #9 — Guard jika env belum diset
  if (!WORKER_URL) throw new Error('TURBOVIP_WORKER_URL belum diset di .env');

  const match = iframeUrl.match(/turbovip\/([a-zA-Z0-9]+)/);
  if (!match) throw new Error('Format URL Turbovip tidak valid');
  const videoId = match[1];

  const proxyPlayerUrl = `${WORKER_URL}?url=${encodeURIComponent(`https://turbovidhls.com/t/${videoId}`)}`;
  const playerRes = await axios.get(proxyPlayerUrl, { headers: getRandomHeaders(), timeout: 10000 });

  const urlPlayMatch = playerRes.data.match(/var urlPlay\s*=\s*['"](.*?)['"]/);
  if (!urlPlayMatch) throw new Error('Gagal menemukan urlPlay Turbovip');
  let urlPlay = urlPlayMatch[1];

  if (urlPlay.startsWith('//')) {
    urlPlay = 'https:' + urlPlay;
  } else if (urlPlay.startsWith('/')) {
    urlPlay = 'https://turbovidhls.com' + urlPlay;
  }

  const proxyM3u8Url = `${WORKER_URL}?url=${encodeURIComponent(urlPlay)}`;
  const m3u8Res = await axios.get(proxyM3u8Url, { headers: getRandomHeaders(), timeout: 10000 });

  const lines = m3u8Res.data.split('\n');
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
  const isWindows = process.platform === 'win32';
  const binaryName = isWindows ? 'N_m3u8DL-RE.exe' : 'N_m3u8DL-RE';
  const exePath = path.join(__dirname, 'tools', binaryName);
  const toolsDir = path.join(__dirname, 'tools');
  const downloadDir = path.join(__dirname, 'Downloads');
  if (!fs.existsSync(toolsDir)) fs.mkdirSync(toolsDir, { recursive: true });
  if (!fs.existsSync(downloadDir)) fs.mkdirSync(downloadDir, { recursive: true });

  const args = [
    m3u8Url,
    '--header', 'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
    '--header', 'Referer: https://turbovidhls.com/',
    '--save-name', safeFileName,
    '--save-dir', downloadDir,
    '--tmp-dir', downloadDir,
    '--thread-count', String(M3U8_THREAD_COUNT),
    '--download-retry-count', '3',
    '--auto-select',
    '--mp4-real-time-decryption'
  ];

  return new Promise((resolve, reject) => {
    logger.info({ event: 'download_started', target: safeFileName });

    const dlProcess = spawn(exePath, args);
    let lastReportedCheckpoint = 0;

    dlProcess.stdout.on('data', (data) => {
      const text = data.toString().trim();
      if (!text) return;

      const match = text.match(/(\d{1,3})\.\d+%/);
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
      if (code === 0) {
        logger.info({ event: 'download_success', target: safeFileName });
        resolve(path.join(downloadDir, `${safeFileName}.mp4`));
      } else {
        reject(new Error(`N_m3u8DL-RE gagal dengan kode exit: ${code}`));
      }
    });

    dlProcess.on('error', reject);
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

async function prosesDownloadSelesai(ctx, waitMsg, localFilePath, cleanTitle, fileStats, tgFileId, archiveMsgId, userId, threadId, fileHash, tmdbMeta = null) {
  try {
    const meta = tmdbMeta || (await searchMovieMeta(cleanTitle));

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

    } else {
      logger.warn({ event: 'lk21_tmdb_not_found', title: cleanTitle });

      // FIX #5 — Set state ke Map DULU, baru buat timeout.
      // Ini menghindari race condition di mana timeout firing sebelum state tersimpan.
      pendingMovieMeta.set(userId, {
        fileId:        tgFileId,
        archiveMsgId:  archiveMsgId,
        fileSize:      fileStats.size,
        fileHash:      fileHash,
        mimeType:      'video/mp4',
        localPath:     localFilePath,
        ext:           'mp4',
        timeoutHandle: null  // placeholder, diisi setelah setTimeout
      });

      const timeoutHandle = setTimeout(() => {
        const stale = pendingMovieMeta.get(userId);
        // Guard: pastikan ini state yang sama (archiveMsgId cocok), bukan state baru yang sudah override
        if (stale && stale.archiveMsgId === archiveMsgId) {
          if (stale.localPath && fs.existsSync(stale.localPath)) {
            try { fs.unlinkSync(stale.localPath); } catch (e) {}
          }
          // Langsung delete dari Map, tidak perlu clearPendingMovie karena
          // clearTimeout pada diri sendiri dari dalam callback tidak berbahaya
          // tapi juga tidak perlu — timeout sudah firing.
          pendingMovieMeta.delete(userId);
          logger.info({ event: 'lk21_pending_timeout', title: cleanTitle });
        }
      }, 30 * 60 * 1000);

      // Update timeoutHandle ke state yang sudah ada di Map
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


// ─── MAIN HANDLER ───────────────────────────────────────────────────────────

// FIX #1 — Ganti timestamp-based lock dengan boolean sederhana.
// Boolean tidak punya masalah "lock aktif terlalu lama" jika finally tidak sempat jalan.
// finally di try/catch SELALU jalan kecuali process.exit() atau crash total —
// dan dalam kedua kasus itu, timestamp lock juga tidak akan di-reset.
// Boolean lebih jelas dan tidak ada edge case lock "stuck 45 menit".
let seedMovsLock = false;

async function handleSeedMovs(ctx) {
  const threadId = ctx.message.message_thread_id;

  if (!ARCHIVE_CHANNEL) {
    return ctx.reply('❌ *Konfigurasi Error:* TELEGRAM_ARCHIVE_MOVS_CHANNEL_ID belum diset di \\.env', { parse_mode: 'MarkdownV2', message_thread_id: threadId });
  }

  // FIX #9 — Guard WORKER_URL di entry point, bukan di dalam extractor saja
  if (!WORKER_URL) {
    return ctx.reply('❌ *Konfigurasi Error:* TURBOVIP_WORKER_URL belum diset di \\.env', { parse_mode: 'MarkdownV2', message_thread_id: threadId });
  }

  if (seedMovsLock) {
    return ctx.reply('⏳ *Bot Sedang Sibuk*\nBot sedang memproses unduhan LK21 lain\\. Harap tunggu hingga selesai sebelum mengantre film baru\\.', { parse_mode: 'MarkdownV2', message_thread_id: threadId });
  }

  const args = ctx.message.text.split(/\s+/);
  const url = args[1];
  const userId = String(ctx.from.id);

  if (!url || !url.includes('lk21')) {
    return ctx.reply('❌ Format salah\\. Gunakan: `/seedmovs <url_lk21>`', { parse_mode: 'MarkdownV2', message_thread_id: threadId });
  }

  // Set lock SETELAH semua validasi awal lulus
  seedMovsLock = true;
  let localFilePath = null;
  let activeSafeFileName = null;
  const waitMsg = await ctx.reply('⏳ *Menganalisis URL LK21\\.\\.\\.*', { parse_mode: 'MarkdownV2', message_thread_id: threadId });

  try {
    // 1. DOM Parsing
    let pageData;
    try {
      const resp = await axios.get(url, { headers: getRandomHeaders(), timeout: 15000 });
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
      // Re-throw dengan pesan yang lebih spesifik untuk kasus 403
      if (err.response?.status === 403) {
        throw new Error('Akses ditolak (HTTP 403) — Cloudflare memblokir request. Coba lagi nanti atau gunakan URL berbeda.');
      }
      throw err;
    }

    const $ = cheerio.load(pageData);

    let rawTitle = $('div.movie-info > h1').text() || $('h1').first().text();
    let cleanTitle = rawTitle.replace(/^Nonton\s+/i, '').replace(/\s*Sub\s+Indo\s+di\s+Lk21\s*$/i, '').trim();

    if (!cleanTitle) {
      throw new Error('Gagal mengekstrak judul. Struktur halaman LK21 mungkin berubah atau terkena Cloudflare protection.');
    }

    let year = '';
    const yearMatch = cleanTitle.match(/\((\d{4})\)/);
    if (yearMatch) {
      year = yearMatch[1];
      cleanTitle = cleanTitle.replace(/\(\d{4}\)/, '').trim();
    }

    // Early duplicate check — hanya jika tahun diketahui.
    // searchMoviesLocal pakai LIKE %keyword% sehingga bisa return film
    // dengan judul mirip. Tanpa tahun, tidak ada cara membedakan duplikat
    // dari film berbeda yang judulnya serupa. Biarkan hash final yang menentukan.
    if (year) {
      const existingMovies = searchMoviesLocal(cleanTitle);
      const duplicate = existingMovies.find(m => m.year === year);
      if (duplicate) {
        logger.info({ event: 'lk21_early_duplicate_found', title: cleanTitle, year });
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

    // 2. Ekstraksi M3U8 — FIX #8: panggil function biasa, bukan instance class
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

    activeSafeFileName = `${cleanTitle.replace(/[^a-zA-Z0-9]/g, '_')}_${crypto.randomBytes(4).toString('hex')}`;

    await ctx.telegram.editMessageText(ctx.chat.id, waitMsg.message_id, undefined, `📥 *Mengunduh Video* \\[${escape(targetStream.quality)}\\]\n⏳ Progress: *0%*\n_Proses ini memakan waktu beberapa menit\\._`, { parse_mode: 'MarkdownV2' });

    // 3. Download ke VPS
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

    // Hash final dengan fileSize — ini yang disimpan ke DB untuk deduplikasi akurat
    const fileHash = crypto.createHash('sha256')
      .update(`LK21_SPIDER:${cleanTitle}:${year}:${fileStats.size}`)
      .digest('hex');

    if (getMovieByHash(fileHash)) {
      fs.unlinkSync(localFilePath);
      return ctx.telegram.editMessageText(ctx.chat.id, waitMsg.message_id, undefined, `ℹ️ Film *${escape(cleanTitle)}* sudah ada di database\\. Unduhan dibatalkan\\.`, { parse_mode: 'MarkdownV2' });
    }

    await ctx.telegram.editMessageText(ctx.chat.id, waitMsg.message_id, undefined, `🚀 *Mengunggah ke Archive Channel\\.\\.\\.*\nUkuran: ${escape((fileStats.size / 1024 / 1024).toFixed(2))} MB`, { parse_mode: 'MarkdownV2' });

    // 4. Upload ke Telegram Archive
    logger.info({ event: 'telegram_upload_start', target: cleanTitle, size_mb: (fileStats.size / 1024 / 1024).toFixed(2) });

    const resHeight = targetStream.quality.split('x').pop();
    const qualityLabel = isNaN(resHeight) ? targetStream.quality : `${resHeight}p`;

    // Cari metadata TMDB sebelum membangun caption agar tidak ada referensi ke variabel yang belum ada.
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

    // Caption Telegram max 1024 karakter untuk video
    if (richCaption.length > 1024) richCaption = richCaption.slice(0, 1021) + '...';

    let sent;
    let uploadAttempt = 0;
    while (uploadAttempt < 3) {
      try {
        const sendOpts = {
          caption: richCaption,
          // Tanpa parse_mode — plain text lebih aman untuk caption kaya metadata
          // MarkdownV2 rawan crash kalau ada karakter spesial di judul/overview TMDB
          supports_streaming: true,
        };
        if (thumbBuffer) {
          sendOpts.thumbnail = { source: thumbBuffer, filename: 'thumb.jpg' };
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
    await prosesDownloadSelesai(
      ctx,
      waitMsg,
      localFilePath,
      cleanTitle,
      fileStats,
      tgFileId,
      archiveMsgId,
      userId,
      threadId,
      fileHash,
      tmdbMeta
    );

  } catch (err) {
    try {
      if (localFilePath && fs.existsSync(localFilePath)) {
        fs.unlinkSync(localFilePath);
      }
      if (activeSafeFileName) {
        const dlDir = path.join(__dirname, 'Downloads');
        const partialFile = path.join(dlDir, `${activeSafeFileName}.mp4`);
        const tmpFolder = path.join(dlDir, activeSafeFileName);
        if (fs.existsSync(partialFile)) fs.unlinkSync(partialFile);
        // FIX #3 — rmSync juga handles direktori sementara N_m3u8DL-RE
        if (fs.existsSync(tmpFolder)) fs.rmSync(tmpFolder, { recursive: true, force: true });
      }
    } catch (cleanupErr) {
      logger.warn({ event: 'lk21_cleanup_error', msg: cleanupErr.message });
    }

    ctx.telegram.deleteMessage(ctx.chat.id, waitMsg.message_id).catch(() => {});
    ctx.reply(`❌ *Gagal:* ${escape(err.message)}`, { parse_mode: 'MarkdownV2', message_thread_id: threadId });
  } finally {
    // FIX #1 — Reset lock boolean, selalu jalan
    seedMovsLock = false;
  }
}

function sweepOrphanedFiles() {
  const downloadDir = path.join(__dirname, 'Downloads');
  if (!fs.existsSync(downloadDir)) return;
  try {
    const entries = fs.readdirSync(downloadDir);
    const now = Date.now();
    let swept = 0;

    for (const entry of entries) {
      const entryPath = path.join(downloadDir, entry);
      let stats;
      try {
        stats = fs.statSync(entryPath);
      } catch (e) {
        // File bisa saja terhapus concurrent, skip saja
        continue;
      }

      const age = now - stats.mtimeMs;
      const OLD_ENOUGH = 2 * 60 * 60 * 1000; // 2 jam

      if (age <= OLD_ENOUGH) continue;

      if (stats.isDirectory()) {
        // FIX #3 — Hapus folder sisa N_m3u8DL-RE yang sebelumnya tidak pernah dibersihkan
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

module.exports = { handleSeedMovs };