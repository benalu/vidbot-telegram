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
const { saveMovieLocal, updateMovieR2, getMovieByHash } = require('../src/features/movies/movies.repo');
const { executeMoviePipeline, pendingMovieMeta, clearPendingMovie } = require('../src/features/movies/movies.admin');

// URL Worker Cloudflare
const WORKER_URL = 'https://dry-term-cd9e.vdbtpacker.workers.dev/';
const ARCHIVE_CHANNEL = process.env.TELEGRAM_ARCHIVE_MOVS_CHANNEL_ID;

const randomDelay = (min = 1500, max = 3500) => {
  return new Promise(resolve => setTimeout(resolve, Math.floor(Math.random() * (max - min + 1)) + min));
};

const getRandomHeaders = () => ({
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Referer': 'https://www.google.com/search?q=nonton+film+terbaru'
});

// ─── EXTRACTOR ──────────────────────────────────────────────────────────────
class TurbovipExtractor {
  async extract(iframeUrl) {
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
    '--tmp-dir', downloadDir,    // ✨ FIX 1: Memaksa folder temporary dibuat di dalam Downloads
    '--thread-count', '2', 
    '--download-retry-count', '3',
    '--auto-select',             
    '--mp4-real-time-decryption' 
  ];

  return new Promise((resolve, reject) => {
    logger.info({ event: 'download_started', target: safeFileName });

    // Jalankan proses secara siluman (tanpa { stdio: 'inherit' })
    const dlProcess = spawn(exePath, args);

    // ✨ FIX 2: SMART PROGRESS & STATUS LOGGER
    let lastReportedCheckpoint = 0;

    dlProcess.stdout.on('data', (data) => {
      const text = data.toString().trim();
      if (!text) return; // Abaikan baris kosong

      // 1. Tangkap angka persentase
      const match = text.match(/(\d{1,3})\.\d+%/); 
      if (match) {
        const currentProgress = parseInt(match[1], 10);
        
        // Buat checkpoint setiap kelipatan 20 (20, 40, 60, 80)
        const checkpoint = Math.floor(currentProgress / 20) * 20; 
        
        // Cetak ke log hanya jika melewati checkpoint baru
        if (checkpoint > lastReportedCheckpoint && checkpoint < 100) {
          logger.info({ event: 'download_progress', progress: `${checkpoint}%`, target: safeFileName });
          if (onProgress) onProgress(checkpoint); 
          lastReportedCheckpoint = checkpoint;
        }
      } else {
        // 2. Tangkap teks status (Merging, Muxing, Error, dll)
        // Menghapus kode warna ANSI bawaan terminal agar log PM2 rapi
        const cleanText = text.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, ''); 
        
        // Hanya cetak log yang mengandung kata kunci penting agar tidak spam
        if (cleanText.includes('INFO') || cleanText.includes('WARN') || cleanText.includes('ERROR') || cleanText.match(/muxing|merging|done/i)) {
          logger.info({ event: 'downloader_status', msg: cleanText });
        }
      }
    });

    // Tangkap error jika ada segmen yang terlewat atau gagal
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

async function prosesDownloadSelesai(ctx, waitMsg, localFilePath, cleanTitle, fileStats, tgFileId, archiveMsgId, userId, threadId, fileHash) {
  try {
    // 1. Cari Metadata Otomatis lewat TMDB
    const meta = await searchMovieMeta(cleanTitle);

    if (meta) {
      logger.info({ event: 'lk21_tmdb_match_success', title: meta.title });

      // ✨ PANGGIL CORE PIPELINE TERPUSAT
      // Tidak perlu lagi manggil uploadToR2, updateMovieR2, syncMovieToApi, dan hapus file manual di sini!
      await executeMoviePipeline({
        meta,
        localPath:  localFilePath,
        fileSize:   fileStats.size,
        mimeType:   'video/mp4',
        ext:        'mp4',
        fileId:     tgFileId,
        messageId:  archiveMsgId,
        fileHash:   fileHash
      });

      await ctx.telegram.editMessageText(
        ctx.chat.id, 
        waitMsg.message_id, 
        undefined, 
        `✅ *Spider Sukses\\!*\\n🎬 *${escape(meta.title)}* (${meta.year})\\n_Upload R2 & Sinkronisasi API berjalan di background\\._`, 
        { parse_mode: 'MarkdownV2' }
      );

    } else {
      // 2. Fallback: Jika TMDB tidak ketemu otomatis, masukkan ke pending queue terpusat
      logger.warn({ event: 'lk21_tmdb_not_found', title: cleanTitle });
      
      const timeoutHandle = setTimeout(() => {
      const stale = pendingMovieMeta.get(userId);
      if (stale && stale.archiveMsgId === archiveMsgId) {
        if (stale.localPath && fs.existsSync(stale.localPath)) {
          try { fs.unlinkSync(stale.localPath); } catch (e) {}
        }
        clearPendingMovie(userId)
      }
    }, 30 * 60 * 1000);

    pendingMovieMeta.set(userId, {
      fileId:        tgFileId,
      archiveMsgId:  archiveMsgId,
      fileSize:      fileStats.size,
      fileHash:      fileHash,
      mimeType:      'video/mp4',
      localPath:     localFilePath,
      ext:           'mp4',
      timeoutHandle: timeoutHandle  
    });

      await ctx.telegram.editMessageText(
        ctx.chat.id, 
        waitMsg.message_id, 
        undefined, 
        `⚠️ *Spider Berhasil, Tapi TMDB Gagal\\!*\\n\\nPencarian untuk \"${escape(cleanTitle)}\" tidak akurat\\.\\n👉 Balas pesan ini dengan *ID TMDB* manual agar pipeline berjalan:`, 
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

let seedMovsLockUntil = 0; 
async function handleSeedMovs(ctx) {
  const threadId = ctx.message.message_thread_id;
  
  if (!ARCHIVE_CHANNEL) {
      return ctx.reply('❌ *Konfigurasi Error:* TELEGRAM_ARCHIVE_MOVS_CHANNEL_ID belum diset di .env', { parse_mode: 'MarkdownV2', message_thread_id: threadId });
  }

  if (Date.now() < seedMovsLockUntil) {
     return ctx.reply('⏳ *Bot Sedang Sibuk*\nBot sedang memproses unduhan LK21 lain. Harap tunggu hingga selesai sebelum mengantre film baru.', { parse_mode: 'MarkdownV2', message_thread_id: threadId });
  }
  const args = ctx.message.text.split(/\s+/);
  const url = args[1];
  const userId = String(ctx.from.id);

  if (!url || !url.includes('lk21')) {
    return ctx.reply('❌ Format salah\\. Gunakan: `/seedmovs <url_lk21>`', { parse_mode: 'MarkdownV2', message_thread_id: threadId });
  }
  seedMovsLockUntil = Date.now() + (45 * 60 * 1000);
  let localFilePath = null;
  let activeSafeFileName = null;
  const waitMsg = await ctx.reply('⏳ *Menganalisis URL LK21\\.\\.\\.*', { parse_mode: 'MarkdownV2', message_thread_id: threadId });
  
  try {
    // 1. DOM Parsing
    const { data } = await axios.get(url, { headers: getRandomHeaders(), timeout: 15000 });
    const $ = cheerio.load(data);
    
    let rawTitle = $('div.movie-info > h1').text() || $('h1').first().text();
    let cleanTitle = rawTitle.replace(/^Nonton\s+/i, '').replace(/\s*Sub\s+Indo\s+di\s+Lk21\s*$/i, '').trim();
    
    if (!cleanTitle) {
      throw new Error('Gagal mengekstrak judul. Struktur halaman LK21 mungkin berubah.');
    }

    let year = '';
    const yearMatch = cleanTitle.match(/\((\d{4})\)/);
    if (yearMatch) {
      year = yearMatch[1];
      cleanTitle = cleanTitle.replace(/\(\d{4}\)/, '').trim();
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
    const turbo = new TurbovipExtractor();
    const result = await turbo.extract(targetUrl);
    
    // Ambil resolusi terendah untuk kecepatan
    const targetStream = result.streams[result.streams.length - 1]; 
    if (!targetStream) {
      logger.warn({ event: 'm3u8_parsing_empty', url: targetUrl });
      throw new Error('Tidak ada stream video yang valid.'); 
    }

    activeSafeFileName = `${cleanTitle.replace(/[^a-zA-Z0-9]/g, '_')}_${crypto.randomBytes(4).toString('hex')}`;
    
    await ctx.telegram.editMessageText(ctx.chat.id, waitMsg.message_id, undefined, `📥 *Mengunduh Video* \\\[${escape(targetStream.quality)}\\\]\n⏳ Progress: *0%*\n_Proses ini memakan waktu beberapa menit\\._`, { parse_mode: 'MarkdownV2' });
    
    // 3. Download ke VPS
    localFilePath = await downloadM3u8(targetStream.url, activeSafeFileName, (percent) => {
      ctx.telegram.editMessageText(
        ctx.chat.id, 
        waitMsg.message_id, 
        undefined, 
        `📥 *Mengunduh Video* \\\[${escape(targetStream.quality)}\\\]\n⏳ Progress: *${percent}%*\n_Sedang berjalan..._`, 
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
    const fileHash = crypto.createHash('sha256').update(`LK21_SPIDER:${cleanTitle}:${year}:${fileStats.size}`).digest('hex');

    if (getMovieByHash(fileHash)) {
      fs.unlinkSync(localFilePath);
      return ctx.telegram.editMessageText(ctx.chat.id, waitMsg.message_id, undefined, `ℹ️ Film *${escape(cleanTitle)}* sudah ada di database\\. Unduhan dibatalkan\\.`, { parse_mode: 'MarkdownV2' });
    }

    await ctx.telegram.editMessageText(ctx.chat.id, waitMsg.message_id, undefined, `🚀 *Mengunggah ke Archive Channel\\.\\.\\.*\nUkuran: ${escape((fileStats.size / 1024 / 1024).toFixed(2))} MB`, { parse_mode: 'MarkdownV2' });

    // 4. Upload ke Telegram Archive
    logger.info({ event: 'telegram_upload_start', target: cleanTitle, size_mb: (fileStats.size / 1024 / 1024).toFixed(2) });
    
    const resHeight = targetStream.quality.split('x').pop();
    const qualityLabel = isNaN(resHeight) ? targetStream.quality : `${resHeight}p`;
    
    const strictCleanTitle = cleanTitle.replace(/([_*~`>#+\-=|{}.!])/g, '');
    const rawCaption = `${strictCleanTitle} ${year ? `(${year}) ` : ''}- ${qualityLabel}`;

    let sent;
    let uploadAttempt = 0;
    while (uploadAttempt < 3) {
      try {
        sent = await ctx.telegram.sendVideo(ARCHIVE_CHANNEL, { source: localFilePath }, {
          caption: escape(rawCaption),
          parse_mode: 'MarkdownV2',
          supports_streaming: true
        });
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

    await ctx.telegram.editMessageText(ctx.chat.id, waitMsg.message_id, undefined, `🔍 *Mencari Metadata TMDB\\.\\.\\.*`, { parse_mode: 'MarkdownV2' });

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
      fileHash
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
         if (fs.existsSync(tmpFolder)) fs.rmSync(tmpFolder, { recursive: true, force: true });
      }
    } catch (cleanupErr) {
     
    }

    ctx.telegram.deleteMessage(ctx.chat.id, waitMsg.message_id).catch(() => {});
    ctx.reply(`❌ *Gagal:* ${escape(err.message)}`, { parse_mode: 'MarkdownV2', message_thread_id: threadId });
  } finally {
    seedMovsLockUntil = 0;
  }
}

// Berjalan otomatis setiap kali file ini dimuat (saat PM2 start/restart)
function sweepOrphanedFiles() {
  const downloadDir = path.join(__dirname, 'Downloads');
  if (!fs.existsSync(downloadDir)) return;
  try {
    const files = fs.readdirSync(downloadDir);
    const now = Date.now();
    let swept = 0;
    for (const file of files) {
      const filePath = path.join(downloadDir, file);
      const stats = fs.statSync(filePath);
      const ext = path.extname(file).toLowerCase();
      
      if (now - stats.mtimeMs > 2 * 60 * 60 * 1000 && (ext === '.mp4' || ext === '.ts')) {
        fs.unlinkSync(filePath);
        swept++;
      }
    }
    if (swept > 0) logger.info({ event: 'orphaned_files_swept', count: swept });
  } catch (err) {
    logger.warn({ event: 'orphaned_files_sweep_failed', msg: err.message });
  }
}
sweepOrphanedFiles();

module.exports = { handleSeedMovs };