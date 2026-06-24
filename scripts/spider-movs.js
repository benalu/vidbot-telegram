// scripts/spider-movs.js
// Spider multi-provider untuk download film dari LK21, Ngefilm21, dan Dutamovie21.
//
// Usage:
//   /seedmovs <url> -lk21              → LK21 via Turbovip, tanpa proxy
//   /seedmovs <url> -lk21 -proxy       → LK21 via Turbovip, pakai proxy
//   /seedmovs <url> -ngefilm21         → Ngefilm21, tanpa proxy
//   /seedmovs <url> -ngefilm21 -proxy  → Ngefilm21, pakai proxy
//   /seedmovs <url> -dutamovie21          → Dutamovie21, tanpa proxy
//   /seedmovs <url> -dutamovie21 -proxy   → Dutamovie21, pakai proxy
//   /seedmovs <url.m3u8> --header "Referer: ..." --save-name "Judul"  → Direct M3U8

'use strict';

const axios = require('axios');
const { spawn } = require('child_process');
const path    = require('path');
const fs      = require('fs');
const crypto  = require('crypto');

const { escape }                           = require('../src/formats/utils');
const logger                               = require('../src/utils/logger');
const { sendAlert }                        = require('../src/utils/alerting');
const { searchMovieMeta, searchMovieMetaMulti, fetchMovieMeta } = require('../src/utils/tmdb');
const { sweepOrphanedFiles }               = require('../src/utils/sweep');
const { getRandomHeaders } = require('../src/utils/http');
const { getMovieByHash, getMoviesByYearRange, saveMovieLocal } = require('../src/features/movies/movies.repo');
const { findDuplicateMovie } = require('../src/features/movies/movies.match');
const { executeMoviePipeline, pendingMovieMeta } = require('../src/features/movies/movies.admin');
const { getVideoQuality, buildUploadPayload, uploadVideoToArchive } = require('../src/features/movies/movies.helpers'); 
const { updateSpiderStats, readSpiderStats } = require('../src/features/movies/movies.stats');
const { extractStream } = require('../src/features/movies/extractors/index');

// ─── ENV ──────────────────────────────────────────────────────────────────────
const ARCHIVE_CHANNEL     = process.env.TELEGRAM_ARCHIVE_MOVS_CHANNEL_ID;
const ADMIN_GROUP_ID      = process.env.TELEGRAM_ADMIN_GROUP_ID;
const ADMIN_THREAD_SPIDER = Number(process.env.TELEGRAM_ADMIN_THREAD_SPIDER || 0);
const M3U8_THREAD_COUNT = Math.max(1, parseInt(process.env.M3U8_THREAD_COUNT || '2', 10));
const WORKER_URL        = process.env.WORKER_URL;
const MOVS_QUALITY      = (process.env.MOVS_QUALITY || 'lowest').toLowerCase() === 'highest' ? 'best' : 'worst';

// ─── PROXY CONFIG ─────────────────────────────────────────────────────────────
// Env: PROXY_HOST, PROXY_PORT, PROXY_USERNAME, PROXY_PASSWORD
// Proxy hanya aktif kalau user kirim flag -proxy di command
const proxyConfig = process.env.PROXY_HOST ? {
  host: process.env.PROXY_HOST,
  port: parseInt(process.env.PROXY_PORT, 10),
  auth: {
    username: process.env.PROXY_USERNAME,
    password: process.env.PROXY_PASSWORD,
  },
} : null;

// ─── PATH & BINARY ────────────────────────────────────────────────────────────
const IS_WINDOWS   = process.platform === 'win32';
const BINARY_NAME  = IS_WINDOWS ? 'N_m3u8DL-RE.exe' : 'N_m3u8DL-RE';
const EXE_PATH     = path.join(__dirname, 'tools', BINARY_NAME);
const DOWNLOAD_DIR = path.join(__dirname, 'Downloads');

fs.mkdirSync(path.join(__dirname, 'tools'), { recursive: true });
fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });

try {
  fs.accessSync(EXE_PATH, fs.constants.X_OK);
  logger.info({ event: 'movs_binary_ok', path: EXE_PATH });
} catch (err) {
  logger.warn({ event: 'movs_binary_missing', path: EXE_PATH, hint: 'chmod +x scripts/tools/N_m3u8DL-RE' });
}

// ─── ARG PARSER ───────────────────────────────────────────────────────────────
/**
 * Parse raw args dari pesan Telegram.
 * Return { url, provider, useProxy, isDirect, directReferer, directTitle }
 */
function parseMovsArgs(rawArgs) {
  const tokens  = rawArgs.trim().split(/\s+/);
  const url     = tokens.find(t => t.startsWith('http')) || '';
  const isDirect = url.includes('.m3u8');

  // Flag provider: -lk21 | -ngefilm21 | -dutafilm  (default LK21)
  let provider = 'LK21';
  if (tokens.includes('-ngefilm21')) provider = 'NGEFILM21';
  else if (tokens.includes('-dutamovie21')) provider = 'DUTAMOVIE21';
  else if (tokens.includes('-lk21'))    provider = 'LK21';

  const useProxy = tokens.includes('-proxy');
  const noSync   = tokens.includes('-nosync');

  // Direct M3U8 mode — ambil referer & save-name dari --header / --save-name
  let directReferer = null;
  let directTitle   = null;
  if (isDirect) {
    const refMatch  = rawArgs.match(/--header\s+["']?Referer:\s*(https?:\/\/[^\s"']+)["']?/i);
    directReferer   = refMatch ? refMatch[1] : null;
    const nameMatch = rawArgs.match(/--save-name\s+["']?([^"'\n]+?)["']?(?:\s|$)/i);
    directTitle     = nameMatch ? nameMatch[1].replace(/_/g, ' ').trim() : 'Direct M3U8';
  }

  return { url, provider, useProxy, noSync, isDirect, directReferer, directTitle };
}

// ─── PROXY HELPER ─────────────────────────────────────────────────────────────
/** Return proxy object untuk axios, atau null kalau useProxy=false atau belum dikonfigurasi */
function getProxy(useProxy) {
  if (!useProxy) return null;
  if (!proxyConfig) {
    logger.warn({ event: 'proxy_not_configured', hint: 'Set PROXY_HOST, PROXY_PORT, PROXY_USERNAME, PROXY_PASSWORD di .env' });
    return null;
  }
  return proxyConfig;
}

// ─── PRE-FLIGHT M3U8 VALIDATION ────────────────────────────────────────────────
/**
 * Validasi cepat bahwa m3u8Url benar-benar mengarah ke manifest HLS valid,
 * sebelum spawn proses download yang baru ketahuan gagal setelah timeout 45 menit.
 * @throws {Error} kalau bukan m3u8 valid
 */
async function validateM3u8(m3u8Url, referer, proxy) {
  try {
    const res = await axios.get(m3u8Url, {
      headers: {
        ...getRandomHeaders(),
        ...(referer ? { 'Referer': referer } : {}),
      },
      timeout: proxy ? 15000 : 10000,
      proxy,
      responseType: 'text',
      // Batasi ukuran response yang dibaca — manifest m3u8 normalnya kecil (<100KB)
      maxContentLength: 200 * 1024,
      validateStatus: s => s >= 200 && s < 400,
    });

    const contentType = (res.headers['content-type'] || '').toLowerCase();
    const body = typeof res.data === 'string' ? res.data : '';

    const looksLikeM3u8 =
      body.trimStart().startsWith('#EXTM3U') ||
      contentType.includes('mpegurl') ||
      contentType.includes('m3u8');

    if (!looksLikeM3u8) {
      throw new Error(`Response bukan manifest M3U8 valid (content-type: ${contentType || 'unknown'}).`);
    }
  } catch (err) {
    if (err.response) {
      throw new Error(`M3U8 URL tidak dapat diakses (HTTP ${err.response.status}).`);
    }
    if (err.code === 'ECONNABORTED') {
      throw new Error('M3U8 URL timeout saat validasi awal.');
    }
    throw new Error(`Validasi M3U8 gagal: ${err.message}`);
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// DOWNLOADER
// ═════════════════════════════════════════════════════════════════════════════
/**
 * @param {string}      m3u8Url
 * @param {string}      safeFileName    - nama file tanpa ekstensi
 * @param {Function}    onProgress      - callback(percent, speedText)
 * @param {string}      referer
 * @param {object|null} proxy           - proxyConfig atau null
 */
async function downloadM3u8(m3u8Url, safeFileName, onProgress, referer = '', proxy = null) {
  const args = [
    m3u8Url,
    '--header', `User-Agent: ${getRandomHeaders()['User-Agent']}`,
    '--save-name',            safeFileName,
    '--save-dir',             DOWNLOAD_DIR,
    '--tmp-dir',              DOWNLOAD_DIR,
    '--thread-count',         String(M3U8_THREAD_COUNT),
    '--download-retry-count', '3',
    '--select-video',         MOVS_QUALITY,
    '--mp4-real-time-decryption',
    '--mux-after-done',       'format=mp4',
  ];

  if (referer) args.push('--header', `Referer: ${referer}`);

  // Proxy untuk N_m3u8DL-RE
  if (proxy) {
    const { host, port, auth } = proxy;
    args.push('--custom-proxy', `http://${auth.username}:${auth.password}@${host}:${port}`);
    logger.info({ event: 'downloader_proxy_enabled', host, port });
  }

  return new Promise((resolve, reject) => {
    logger.info({ event: 'download_started', target: safeFileName });

    const TIMEOUT_MS = 45 * 60 * 1000;
    let settled = false;
    const dlProcess = spawn(EXE_PATH, args);
    let lastCheckpoint = 0;
    let lastWarning    = '';

    const globalTimeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { dlProcess.kill('SIGKILL'); } catch (_) {}
      reject(new Error('Unduhan timeout — N_m3u8DL-RE tidak selesai dalam 45 menit.'));
    }, TIMEOUT_MS);

    dlProcess.stdout.on('data', (data) => {
      const text = data.toString().trim();
      if (!text) return;

      if (text.includes('429') || text.includes('Too Many Requests')) {
        lastWarning = 'CDN rate limit (HTTP 429) — coba lagi beberapa jam lagi.';
      }

      const pctMatch   = text.match(/(\d{1,3})(?:\.\d+)?%/);
      const speedMatch = text.match(/([\d.]+)\s*(KB\/s|MB\/s|GB\/s)/i);
      const speedText  = speedMatch ? `${speedMatch[1]} ${speedMatch[2]}` : null;

      if (pctMatch) {
        const pct        = parseInt(pctMatch[1], 10);
        const checkpoint = Math.floor(pct / 20) * 20;
        if (checkpoint > lastCheckpoint && checkpoint < 100) {
          if (onProgress) onProgress(checkpoint, speedText);
          lastCheckpoint = checkpoint;
        }
      } else {
        const clean = text.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '');
        if (clean.match(/INFO|WARN|ERROR|muxing|merging|done/i)) {
          logger.info({ event: 'downloader_status', msg: clean });
        }
      }
    });

    dlProcess.stderr.on('data', (data) => {
      const msg = data.toString();
      if (msg.includes('429') || msg.includes('Too Many Requests')) {
        lastWarning = 'CDN rate limit (HTTP 429) — coba lagi beberapa jam lagi.';
      }
      if (msg.includes('ERROR')) logger.warn({ event: 'downloader_stderr', msg: msg.trim() });
    });

    dlProcess.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(globalTimeout);
      const outPath = path.join(DOWNLOAD_DIR, `${safeFileName}.mp4`);
      if (code === 0 && fs.existsSync(outPath) && fs.statSync(outPath).size > 0) {
        resolve(outPath);
      } else if (code === 0) {
        reject(new Error('N_m3u8DL-RE selesai tapi file tidak terbentuk — muxing mungkin gagal.'));
      } else {
        reject(new Error(lastWarning || `N_m3u8DL-RE gagal dengan exit code: ${code}`));
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

// ═════════════════════════════════════════════════════════════════════════════
// SHARED HELPERS (tidak berubah dari spider-lk21.js)
// ═════════════════════════════════════════════════════════════════════════════

async function notifySpider(type, payload) {
  if (type === 'success') {
    if (!ADMIN_GROUP_ID || !ADMIN_THREAD_SPIDER) return;
    const { ctx, provider, meta, fileStats, archiveMsgId, fileHash } = payload;
    await ctx.telegram.sendMessage(
      ADMIN_GROUP_ID,
      `🕸️ *Spider Selesai*\n\n` +
      `📡 Provider: \`${escape(provider)}\`\n` +
      `🎬 *${escape(meta.title || 'Unknown')}*\n` +
      `📅 Tahun: ${escape(meta.year || '-')}\n` +
      `📦 Ukuran: ${escape((fileStats.size / 1024 / 1024).toFixed(2))} MB\n` +
      `🆔 Archive Msg: ${archiveMsgId}\n` +
      `🧾 Hash: \`${escape(fileHash)}\``,
      { parse_mode: 'MarkdownV2', message_thread_id: ADMIN_THREAD_SPIDER }
    ).catch(() => {});
  } else {
    const { provider, url, phase, errMessage } = payload;
    await sendAlert(
      `🔴 *Spider Gagal*\n\n` +
      `📡 Provider: \`${escape(provider)}\`\n` +
      `📍 Fase: \`${escape(phase)}\`\n` +
      `❌ Error: _${escape(errMessage.slice(0, 300))}_\n` +
      `🔗 URL: \`${escape(url.slice(0, 100))}\``
    ).catch(() => {});
  }
}

async function prosesDownloadSelesai({ ctx, waitMsg, localFilePath, title, year, fileStats, tgFileId, archiveMsgId, userId, threadId, fileHash, tmdbMeta, provider, lockStartTime, noSync }) {
  try {
    const meta = tmdbMeta || (await searchMovieMeta(title, year));

    if (meta) {
      if (noSync) {
        // Mode nosync — simpan ke DB lokal saja, skip R2 upload dan REST API sync
        saveMovieLocal({
          tmdb_id:    String(meta.tmdb_id),
          title:      meta.title,
          year:       meta.year,
          duration:   meta.duration,
          rating:     meta.rating,
          genre:      meta.genre,
          poster:     meta.poster,
          overview:   meta.overview,
          file_size:  fileStats.size,
          file_hash:  fileHash || crypto.createHash('md5').update(meta.title + fileStats.size).digest('hex'),
          r2_url:     '',
          file_id:    tgFileId,
          message_id: archiveMsgId,
        });
      } else {
        await executeMoviePipeline({
          meta,
          localPath:  localFilePath,
          fileSize:   fileStats.size,
          mimeType:   'video/mp4',
          ext:        'mp4',
          fileId:     tgFileId,
          messageId:  archiveMsgId,
          fileHash,
          onBgError: (errMsg) => {
            ctx.reply(
              `⚠️ *R2 Upload Gagal*\n🎬 *${escape(meta.title)}*\n_${escape(errMsg)}_`,
              { parse_mode: 'MarkdownV2', message_thread_id: threadId }
            ).catch(() => {});
          },
        });
      }

      await ctx.telegram.editMessageText(
        ctx.chat.id, waitMsg.message_id, undefined,
        noSync
          ? `✅ *Spider Sukses\\!*\n🎬 *${escape(meta.title)}* \\(${escape(meta.year)}\\)\n_📵 NoSync — film hanya tersimpan di Telegram & database lokal\\._`
          : `✅ *Spider Sukses\\!*\n🎬 *${escape(meta.title)}* \\(${escape(meta.year)}\\)\n_Upload R2 & Sinkronisasi API berjalan di background\\._`,
        { parse_mode: 'MarkdownV2' }
      );

      await notifySpider('success', { ctx, provider, meta, fileStats, archiveMsgId, fileHash });
      updateSpiderStats({
        success:      true,
        title:        meta.title,
        size_bytes:   fileStats.size,
        duration_ms:  Date.now() - (lockStartTime || Date.now()),
        last_provider: provider,
        status:       'IDLE',
        active_title: '',
      });

    } else {
      // TMDB tidak ditemukan — minta admin input manual
      pendingMovieMeta.set(userId, {
        fileId:        tgFileId,
        archiveMsgId,
        fileSize:      fileStats.size,
        fileHash,
        mimeType:      'video/mp4',
        localPath:     localFilePath,
        ext:           'mp4',
        timeoutHandle: null,
      });

      const timeoutHandle = setTimeout(() => {
        const stale = pendingMovieMeta.get(userId);
        if (stale && stale.archiveMsgId === archiveMsgId) {
          if (stale.localPath && fs.existsSync(stale.localPath)) {
            try { fs.unlinkSync(stale.localPath); } catch (_) {}
          }
          pendingMovieMeta.delete(userId);
          logger.info({ event: 'movs_pending_timeout', title });
        }
      }, 30 * 60 * 1000);

      pendingMovieMeta.get(userId).timeoutHandle = timeoutHandle;

      await ctx.telegram.editMessageText(
        ctx.chat.id, waitMsg.message_id, undefined,
        `⚠️ *Spider Berhasil, Tapi TMDB Gagal\\!*\n\nPencarian untuk _${escape(title)}_ tidak akurat\\.\n👉 Balas dengan *ID TMDB* manual:`,
        { parse_mode: 'MarkdownV2' }
      );
    }
  } catch (err) {
    if (localFilePath && fs.existsSync(localFilePath)) {
      try { fs.unlinkSync(localFilePath); } catch (_) {}
    }
    logger.error({ event: 'movs_process_failed', msg: err.message });
    ctx.reply(`❌ *Spider Gagal:* ${escape(err.message)}`, { parse_mode: 'MarkdownV2', message_thread_id: threadId });
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// MAIN HANDLER — /seedmovs
// ═════════════════════════════════════════════════════════════════════════════
let seedMovsLock = false;

async function handleSeedMovs(ctx) {
  const threadId = ctx.message.message_thread_id;

  if (!ARCHIVE_CHANNEL) {
    return ctx.reply('❌ *Konfigurasi Error:* `TELEGRAM_ARCHIVE_MOVS_CHANNEL_ID` belum diset di \\.env', {
      parse_mode: 'MarkdownV2', message_thread_id: threadId,
    });
  }
  if (seedMovsLock) {
    return ctx.reply('⏳ *Bot Sedang Sibuk*\nSedang memproses unduhan lain\\. Harap tunggu\\.', {
      parse_mode: 'MarkdownV2', message_thread_id: threadId,
    });
  }

  const rawArgs = ctx.message.text.split(/\s+/).slice(1).join(' ').trim();
  if (!rawArgs) {
    return ctx.reply(
      '❌ *Format Penggunaan:*\n\n' +
      '`/seedmovs <url> \\-lk21`\n' +
      '`/seedmovs <url> \\-lk21 \\-proxy`\n' +
      '`/seedmovs <url> \\-ngefilm21`\n' +
      '`/seedmovs <url> \\-ngefilm21 \\-proxy`\n' +
      '`/seedmovs <url> \\-dutamovie21`\n' +
      '`/seedmovs <url> \\-dutamovie21 \\-proxy`\n\n' +
      '`/seedmovs <url> \\-lk21 \\-nosync`\n\n' +
      '_Flag \\-nosync: simpan di Telegram saja, skip R2 & REST API sync_\n\n' +
      '_Direct M3U8:_\n' +
      '`/seedmovs <url\\.m3u8> \\-\\-header "Referer: \\.\\.\\." \\-\\-save\\-name "Judul"`',
      { parse_mode: 'MarkdownV2', message_thread_id: threadId }
    );
  }

  const { url, provider, useProxy, noSync, isDirect, directReferer, directTitle } = parseMovsArgs(rawArgs);

  if (!url) {
    return ctx.reply('❌ URL tidak ditemukan di pesan\\.', { parse_mode: 'MarkdownV2', message_thread_id: threadId });
  }

  const proxy = getProxy(useProxy);

  // Validasi proxy dikonfigurasi kalau flag -proxy dikirim
  if (useProxy && !proxyConfig) {
    return ctx.reply(
      '❌ Flag `\\-proxy` dipakai tapi proxy belum dikonfigurasi di \\.env\\.\n' +
      '_Set `PROXY_HOST`, `PROXY_PORT`, `PROXY_USERNAME`, `PROXY_PASSWORD`\\._',
      { parse_mode: 'MarkdownV2', message_thread_id: threadId }
    );
  }

  const userId       = String(ctx.from.id);
  const lockStartTime = Date.now();
  seedMovsLock       = true;
  let localFilePath  = null;
  let safeFileName   = null;
  let currentPhase   = 'init';

  updateSpiderStats({
    status:        'PROCESSING',
    lock_start:    new Date().toISOString(),
    active_title:  '...',
    last_provider: provider,
  });

  const proxyLabel = useProxy && proxy ? ` · 🌐 Proxy` : ' · 🔓 Direct';
  const syncLabel  = noSync ? ' · 📵 NoSync' : '';
  const waitMsg    = await ctx.reply(
    `⏳ *Menganalisis\\.\\.\\.*\n📡 Provider: \`${escape(provider)}\`${escape(proxyLabel)}${escape(syncLabel)}`,
    { parse_mode: 'MarkdownV2', message_thread_id: threadId }
  );

  try {
    let title, year, m3u8Url, referer, siteOverview = '';

    if (isDirect) {
      // ── Direct M3U8 mode ────────────────────────────────────────────────────
      title   = directTitle;
      year    = '';
      m3u8Url = url;
      referer = directReferer || '';

      updateSpiderStats({ active_title: title });
      await ctx.telegram.editMessageText(ctx.chat.id, waitMsg.message_id, undefined,
        `📡 *Direct M3U8 Mode*\n🎬 _${escape(title)}_\n⏳ Memulai unduhan\\.\\.\\.`,
        { parse_mode: 'MarkdownV2' }
      );

    } else {
      // ── Provider extraction ─────────────────────────────────────────────────
      currentPhase = 'extraction';
      await ctx.telegram.editMessageText(ctx.chat.id, waitMsg.message_id, undefined,
        `🔍 *Mengekstrak stream\\.\\.\\.*\n📡 \`${escape(provider)}\`${escape(proxyLabel)}`,
        { parse_mode: 'MarkdownV2' }
      );

      const extracted = await extractStream(provider, url, proxy, WORKER_URL);
      title    = extracted.title;
      year     = extracted.year;
      m3u8Url  = extracted.m3u8Url;
      referer  = extracted.referer;
      siteOverview = extracted.overview || '';

      updateSpiderStats({ active_title: title });

      const candidates = getMoviesByYearRange(year);
      const dup = findDuplicateMovie(title, year, candidates);
      if (dup) {
        updateSpiderStats({ duplicate: true, title, status: 'IDLE' });
        return ctx.telegram.editMessageText(ctx.chat.id, waitMsg.message_id, undefined,
          `ℹ️ Film *${escape(title)}* kemungkinan sudah ada di database sebagai *${escape(dup.title)}* \\(${escape(dup.year)}\\)\\.`,
          { parse_mode: 'MarkdownV2' }
        );
      }

      await ctx.telegram.editMessageText(ctx.chat.id, waitMsg.message_id, undefined,
        `✅ *Stream Ditemukan\\!*\n🎬 _${escape(title)}_\n⏳ Memulai unduhan\\.\\.\\.`,
        { parse_mode: 'MarkdownV2' }
      );
    }

    // ── Validasi M3U8 ──────────────────────────────────────────────────────────
    currentPhase = 'm3u8_validation';
    await validateM3u8(m3u8Url, referer, proxy);

    // ── Download ───────────────────────────────────────────────────────────────
    currentPhase = 'download';
    const safePart = title.replace(/[^a-zA-Z0-9]/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '');
    safeFileName   = `${safePart || 'movie'}_${crypto.randomBytes(4).toString('hex')}`;

    await ctx.telegram.editMessageText(ctx.chat.id, waitMsg.message_id, undefined,
      `📥 *Mengunduh Video*\n🎬 _${escape(title)}_\n⏳ Progress: *0%*\n_Proses ini memakan waktu beberapa menit\\._`,
      { parse_mode: 'MarkdownV2' }
    );

    localFilePath = await downloadM3u8(
      m3u8Url, safeFileName,
      (percent, speedText) => {
        const speedLabel = speedText ? ` · ${escape(speedText)}` : '';
        ctx.telegram.editMessageText(ctx.chat.id, waitMsg.message_id, undefined,
          `📥 *Mengunduh Video*\n🎬 _${escape(title)}_\n⏳ Progress: *${percent}%${speedLabel}*`,
          { parse_mode: 'MarkdownV2' }
        ).catch(err => {
          if (!err.message.includes('429')) logger.warn({ event: 'progress_edit_failed', msg: err.message });
        });
      },
      referer,
      proxy,
    );

    const fileStats = fs.statSync(localFilePath);
    if (fileStats.size < 1024 * 1024) throw new Error('File hasil unduhan korup atau terlalu kecil (< 1 MB).');

    const fileHash = crypto.createHash('sha256')
      .update(`MOVS_SPIDER:${provider}:${title}:${year}:${fileStats.size}`)
      .digest('hex');

    if (getMovieByHash(fileHash)) {
      try { fs.unlinkSync(localFilePath); } catch (_) {}
      updateSpiderStats({ duplicate: true, title, status: 'IDLE' });
      return ctx.telegram.editMessageText(ctx.chat.id, waitMsg.message_id, undefined,
        `ℹ️ Film *${escape(title)}* sudah ada di database\\. Unduhan dibatalkan\\.`,
        { parse_mode: 'MarkdownV2' }
      );
    }

    // ── TMDB + Upload ──────────────────────────────────────────────────────────
    currentPhase = 'tmdb';
    await ctx.telegram.editMessageText(ctx.chat.id, waitMsg.message_id, undefined,
      `🔍 *Mencari Metadata TMDB\\.\\.\\.*`,
      { parse_mode: 'MarkdownV2' }
    );
    const tmdbMeta = isDirect ? null : await searchMovieMeta(title, year);

    if (tmdbMeta && siteOverview) {
      tmdbMeta.overview = siteOverview;
    }

    const detectedQuality = getVideoQuality(localFilePath);
    const { richCaption, thumbBuffer } = await buildUploadPayload(
      title, detectedQuality || 'HD', fileStats, tmdbMeta
    );

    currentPhase = 'telegram_upload';
    await ctx.telegram.editMessageText(ctx.chat.id, waitMsg.message_id, undefined,
      `🚀 *Mengunggah ke Archive Channel\\.\\.\\.*\n📦 ${escape((fileStats.size / 1024 / 1024).toFixed(2))} MB`,
      { parse_mode: 'MarkdownV2' }
    );

    const sent         = await uploadVideoToArchive(ctx, ARCHIVE_CHANNEL, localFilePath, richCaption, thumbBuffer);
    const archiveMsgId = sent.message_id;
    const tgFileId     = sent.video.file_id;

    // ── Post-download pipeline ─────────────────────────────────────────────────
    currentPhase = 'pipeline';
    await prosesDownloadSelesai({
      ctx, waitMsg, localFilePath, title, year,
      fileStats, tgFileId, archiveMsgId,
      userId, threadId, fileHash, tmdbMeta,
      provider, lockStartTime, noSync,
    });

  } catch (err) {
    // Cleanup file sementara
    try {
      if (localFilePath && fs.existsSync(localFilePath)) fs.unlinkSync(localFilePath);
      if (safeFileName) {
        const partial = path.join(DOWNLOAD_DIR, `${safeFileName}.mp4`);
        const tmpDir  = path.join(DOWNLOAD_DIR, safeFileName);
        if (fs.existsSync(partial)) fs.unlinkSync(partial);
        if (fs.existsSync(tmpDir))  fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    } catch (cleanErr) {
      logger.warn({ event: 'movs_cleanup_error', msg: cleanErr.message });
    }

    updateSpiderStats({ failed: true, status: 'IDLE', active_title: '' });
    await notifySpider('error', { provider, url, phase: currentPhase, errMessage: err.message });
    ctx.telegram.deleteMessage(ctx.chat.id, waitMsg.message_id).catch(() => {});
    ctx.reply(
      `❌ *Gagal:* _${escape(err.message)}_`,
      { parse_mode: 'MarkdownV2', message_thread_id: threadId }
    );
  } finally {
    seedMovsLock = false;
    updateSpiderStats({ status: 'IDLE', active_title: '' });
  }
}

// ─── STATUS HANDLER ───────────────────────────────────────────────────────────
async function handleSeedMovsStatus(ctx) {
  const threadId = ctx.message.message_thread_id;
  try {
    const lockLabel = seedMovsLock ? '🔴 Aktif' : '🟢 Idle';
    let statsText   = '_Belum ada data statistik\\._';

    const s = readSpiderStats();
    if (s) {
      const elapsedMin = seedMovsLock && s.lock_start
        ? ((Date.now() - new Date(s.lock_start).getTime()) / 60000).toFixed(1)
        : null;

      statsText = [
        s.active_title  && `🎬 *Film Saat Ini:* _${escape(s.active_title)}_`,
        elapsedMin      && `⏱ *Berjalan:* ${escape(elapsedMin)} menit`,
        s.last_provider && `📡 *Provider Terakhir:* \`${escape(s.last_provider)}\``,
        '',
        `✅ Berhasil: *${s.total_success   || 0}*`,
        `❌ Gagal: *${s.total_failed       || 0}*`,
        `♻️ Duplikat: *${s.total_duplicate || 0}*`,
        `📦 Rata\\-rata ukuran: *${s.avg_size_mb     || '\\-'} MB*`,
        `⏱ Rata\\-rata durasi: *${s.avg_duration_min || '\\-'} menit*`,
        s.last_movie        && `🎞 *Film Terakhir:* _${escape(s.last_movie)}_`,
        s.last_processed_at && `🕐 *Diproses:* ${escape(new Date(s.last_processed_at).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' }))}`,
      ].filter(Boolean).join('\n');
    }

    await ctx.reply(
      `🕸️ *Movie Spider Status*\n\n🔒 *Lock:* ${lockLabel}\n\n${statsText}`,
      { parse_mode: 'MarkdownV2', message_thread_id: threadId }
    );
  } catch (err) {
    logger.warn({ event: 'seedmovs_status_error', msg: err.message });
    await ctx.reply('❌ Gagal membaca status spider\\.', { parse_mode: 'MarkdownV2', message_thread_id: threadId });
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// INJECT HANDLERS (tidak berubah dari spider-lk21.js)
// ═════════════════════════════════════════════════════════════════════════════
const pendingInjectSelect = new Map();

async function handleInjectMovs(ctx) {
  const threadId = ctx.message.message_thread_id;
  const args     = ctx.message.text.split(/\s+/).slice(1);

  if (args.length < 2) {
    return ctx.reply(
      '❌ Format:\n' +
      '• `/injectmovs <filename> ID` — search TMDB bahasa Indonesia\n' +
      '• `/injectmovs <filename> EN` — search TMDB bahasa Inggris\n' +
      '• `/injectmovs <filename> <tmdb_id>` — langsung pakai ID TMDB\n\n' +
      '_Contoh: `/injectmovs Ruthless Bastards (2025) ID`_',
      { parse_mode: 'MarkdownV2', message_thread_id: threadId }
    );
  }

  const lastArg     = args[args.length - 1];
  const filename    = args.slice(0, -1).join(' ');
  const yearMatch   = filename.match(/\((\d{4})\)\s*$/);
  const fileYear    = yearMatch ? yearMatch[1] : null;
  const searchTitle = yearMatch ? filename.replace(/\s*\(\d{4}\)\s*$/, '').trim() : filename;

  const candidates = [
    path.join(DOWNLOAD_DIR, filename),
    path.join(DOWNLOAD_DIR, `${filename}.mp4`),
    path.join(DOWNLOAD_DIR, `${filename}.mkv`),
  ];
  const localFilePath = candidates.find(p => fs.existsSync(p));

  if (!localFilePath) {
    return ctx.reply(
      `❌ File tidak ditemukan di Downloads/:\n\`${escape(filename)}\``,
      { parse_mode: 'MarkdownV2', message_thread_id: threadId }
    );
  }

  const resolvedPath   = path.resolve(localFilePath);
  const resolvedDlDir  = path.resolve(DOWNLOAD_DIR);
  if (!resolvedPath.startsWith(resolvedDlDir + path.sep)) {
    logger.warn({ event: 'inject_path_traversal', path: resolvedPath });
    return ctx.reply('❌ Path file tidak valid\\.', { parse_mode: 'MarkdownV2', message_thread_id: threadId });
  }

  const fileStats = fs.statSync(localFilePath);
  if (fileStats.size < 1024 * 1024) {
    return ctx.reply('❌ File terlalu kecil — kemungkinan korup\\.', { parse_mode: 'MarkdownV2', message_thread_id: threadId });
  }

  if (/^\d+$/.test(lastArg)) {
    return _runInjectPipeline(ctx, { threadId, localFilePath, fileStats, filename, tmdbId: lastArg });
  }

  const lang = lastArg.toUpperCase();
  if (!['ID', 'EN'].includes(lang)) {
    return ctx.reply(
      '❌ Argumen terakhir harus `ID`, `EN`, atau TMDB ID angka\\.',
      { parse_mode: 'MarkdownV2', message_thread_id: threadId }
    );
  }

  const waitMsg = await ctx.reply(
    `🔍 *Mencari di TMDB\\.\\.\\.*\n📁 \`${escape(filename)}\``,
    { parse_mode: 'MarkdownV2', message_thread_id: threadId }
  );

  try {
    const results = await searchMovieMetaMulti(searchTitle, lang === 'ID' ? 'id-ID' : 'en-US', fileYear);

    if (!results || results.length === 0) {
      return ctx.telegram.editMessageText(ctx.chat.id, waitMsg.message_id, undefined,
        `❌ Tidak ada hasil untuk: _${escape(filename)}_\n\nCoba ganti bahasa atau masukkan TMDB ID manual\\.`,
        { parse_mode: 'MarkdownV2' }
      );
    }

    if (results.length === 1) {
      await ctx.telegram.deleteMessage(ctx.chat.id, waitMsg.message_id).catch(() => {});
      return _runInjectPipeline(ctx, { threadId, localFilePath, fileStats, filename, tmdbId: results[0].id });
    }

    const buttons = results.slice(0, 10).map(r => ([{
      text:          `${r.title} (${r.year})`,
      callback_data: `injectsel:${r.id}:${encodeURIComponent(filename)}`,
    }]));

    pendingInjectSelect.set(String(ctx.from.id), {
      localFilePath, fileStats, filename,
      expireAt: Date.now() + 10 * 60 * 1000,
    });

    return ctx.telegram.editMessageText(ctx.chat.id, waitMsg.message_id, undefined,
      `🎬 *${results.length} Hasil untuk:* _${escape(filename)}_\n\nPilih film yang sesuai:`,
      { parse_mode: 'MarkdownV2', reply_markup: { inline_keyboard: buttons } }
    );

  } catch (err) {
    logger.error({ event: 'inject_search_failed', msg: err.message });
    ctx.telegram.editMessageText(ctx.chat.id, waitMsg.message_id, undefined,
      `❌ *Pencarian Gagal:* _${escape(err.message)}_`,
      { parse_mode: 'MarkdownV2' }
    ).catch(() => {});
  }
}

async function _runInjectPipeline(ctx, { threadId, localFilePath, fileStats, filename, tmdbId }) {
  const waitMsg = await ctx.reply(
    `⏳ *Inject Film*\n📁 \`${escape(filename)}\`\n🔍 Mengambil metadata TMDB\\.\\.\\.`,
    { parse_mode: 'MarkdownV2', message_thread_id: threadId }
  );

  try {
    const meta     = await fetchMovieMeta(tmdbId);
    const fileHash = crypto.createHash('sha256')
      .update(`INJECT:${meta.title}:${meta.year}:${fileStats.size}`)
      .digest('hex');

    if (getMovieByHash(fileHash)) {
      try { fs.unlinkSync(localFilePath); } catch (_) {}
      return ctx.telegram.editMessageText(ctx.chat.id, waitMsg.message_id, undefined,
        `ℹ️ Film *${escape(meta.title)}* sudah ada di database\\. File dihapus\\.`,
        { parse_mode: 'MarkdownV2' }
      );
    }

    await ctx.telegram.editMessageText(ctx.chat.id, waitMsg.message_id, undefined,
      `🚀 *Mengunggah ke Archive Channel\\.\\.\\.*\n🎬 ${escape(meta.title)} \\(${escape(meta.year)}\\)\n📦 ${escape((fileStats.size / 1024 / 1024).toFixed(2))} MB`,
      { parse_mode: 'MarkdownV2' }
    );

    const detectedQuality = getVideoQuality(localFilePath);
    const { richCaption, thumbBuffer } = await buildUploadPayload(
      meta.title, detectedQuality || '', fileStats, meta
    );
    const sent = await uploadVideoToArchive(ctx, ARCHIVE_CHANNEL, localFilePath, richCaption, thumbBuffer);

    await ctx.telegram.editMessageText(ctx.chat.id, waitMsg.message_id, undefined,
      `✅ *Inject Sukses\\!*\n🎬 *${escape(meta.title)}* \\(${escape(meta.year)}\\)\n_Upload R2 & Sinkronisasi API berjalan di background\\._`,
      { parse_mode: 'MarkdownV2' }
    );

    await executeMoviePipeline({
      meta,
      localPath:  localFilePath,
      fileSize:   fileStats.size,
      mimeType:   'video/mp4',
      ext:        'mp4',
      fileId:     sent.video.file_id,
      messageId:  sent.message_id,
      fileHash,
      onBgError: (errMsg) => {
        ctx.reply(
          `⚠️ *R2 Upload Gagal*\n🎬 *${escape(meta.title)}*\n_${escape(errMsg)}_`,
          { parse_mode: 'MarkdownV2', message_thread_id: threadId }
        ).catch(() => {});
      },
    });

  } catch (err) {
    logger.error({ event: 'inject_pipeline_failed', msg: err.message });
    ctx.telegram.editMessageText(ctx.chat.id, waitMsg.message_id, undefined,
      `❌ *Inject Gagal:* _${escape(err.message)}_`,
      { parse_mode: 'MarkdownV2' }
    ).catch(() => {});
  }
}

async function handleInjectMovsCallback(ctx) {
  await ctx.answerCbQuery().catch(() => {});
  const data  = ctx.callbackQuery?.data || '';
  const match = data.match(/^injectsel:(\d+):(.+)$/);
  if (!match) return;

  const tmdbId   = match[1];
  const filename = decodeURIComponent(match[2]);
  const userId   = String(ctx.from.id);
  const threadId = ctx.callbackQuery?.message?.message_thread_id;

  const pending = pendingInjectSelect.get(userId);
  if (!pending || Date.now() > pending.expireAt) {
    pendingInjectSelect.delete(userId);
    return ctx.telegram.editMessageText(ctx.chat.id, ctx.callbackQuery.message.message_id, undefined,
      '❌ Sesi pemilihan sudah expired\\. Ulangi perintah `/injectmovs`\\.',
      { parse_mode: 'MarkdownV2' }
    ).catch(() => {});
  }

  await ctx.telegram.editMessageReplyMarkup(
    ctx.chat.id, ctx.callbackQuery.message.message_id, undefined, { inline_keyboard: [] }
  ).catch(() => {});

  pendingInjectSelect.delete(userId);
  return _runInjectPipeline(ctx, {
    threadId,
    localFilePath: pending.localFilePath,
    fileStats:     pending.fileStats,
    filename:      pending.filename,
    tmdbId,
  });
}

// ─── SWEEP ────────────────────────────────────────────────────────────────────
setImmediate(() => sweepOrphanedFiles(DOWNLOAD_DIR));

module.exports = { handleSeedMovs, handleSeedMovsStatus, handleInjectMovs, handleInjectMovsCallback };