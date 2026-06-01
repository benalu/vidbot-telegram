// scripts/spider-lk21.js
const axios = require('axios');
const cheerio = require('cheerio');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const { escape } = require('../src/formats/utils');
const logger = require('../src/utils/logger');
const { uploadToR2 } = require('../src/utils/r2');
const { searchMovieMeta } = require('../src/utils/tmdb');
const { syncMovieToApi } = require('../src/utils/api-sync-movies');
const { saveMovieLocal, updateMovieR2, getMovieByHash } = require('../src/features/movies/movies.repo');
const { pendingMovieMeta } = require('../src/features/movies/movies.admin');

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
    const playerRes = await axios.get(proxyPlayerUrl, { headers: getRandomHeaders() });

    const urlPlayMatch = playerRes.data.match(/var urlPlay\s*=\s*['"](.*?)['"]/);
    if (!urlPlayMatch) throw new Error('Gagal menemukan urlPlay Turbovip');
    const urlPlay = urlPlayMatch[1];
    
    const proxyM3u8Url = `${WORKER_URL}?url=${encodeURIComponent(urlPlay)}`;
    const m3u8Res = await axios.get(proxyM3u8Url, { headers: getRandomHeaders() });

    const lines = m3u8Res.data.split('\n');
    const streams = []; 

    for (let i = 0; i < lines.length; i++) {
      if (lines[i].startsWith('#EXT-X-STREAM-INF:')) {
        const bwMatch = lines[i].match(/BANDWIDTH=(\d+)/);
        const resMatch = lines[i].match(/RESOLUTION=([^,]+)/);
        const streamUrl = lines[i + 1] ? lines[i + 1].trim() : ''; 
        if (streamUrl) {
          streams.push({
            quality: resMatch ? resMatch[1] : 'Unknown',
            bandwidth: bwMatch ? parseInt(bwMatch[1]) : 0,
            url: streamUrl
          });
        }
      }
    }
    streams.sort((a, b) => b.bandwidth - a.bandwidth);
    return { videoId, streams, masterM3u8: urlPlay };
  }
}

// ─── DOWNLOADER ─────────────────────────────────────────────────────────────
async function downloadM3u8(m3u8Url, safeFileName) {
  const isWindows = process.platform === 'win32';
  const binaryName = isWindows ? 'N_m3u8DL-RE.exe' : 'N_m3u8DL-RE';
  const exePath = path.join(__dirname, 'tools', binaryName);
  const downloadDir = path.join(__dirname, 'Downloads');
  
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

// ─── MAIN HANDLER ───────────────────────────────────────────────────────────
async function handleSeedMovs(ctx) {
  const args = ctx.message.text.split(/\s+/);
  const url = args[1];
  const threadId = ctx.message.message_thread_id;
  const userId = String(ctx.from.id);

  if (!url || !url.includes('lk21')) {
    return ctx.reply('❌ Format salah\\. Gunakan: `/seedmovs <url_lk21>`', { parse_mode: 'MarkdownV2', message_thread_id: threadId });
  }

  const waitMsg = await ctx.reply('⏳ *Menganalisis URL LK21\\.\\.\\.*', { parse_mode: 'MarkdownV2', message_thread_id: threadId });

  try {
    // 1. DOM Parsing
    const { data } = await axios.get(url, { headers: getRandomHeaders(), timeout: 15000 });
    const $ = cheerio.load(data);
    
    let rawTitle = $('div.movie-info > h1').text() || $('h1').first().text();
    let cleanTitle = rawTitle.replace(/^Nonton\s+/i, '').replace(/\s*Sub\s+Indo\s+di\s+Lk21\s*$/i, '').trim();
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

    if (!targetUrl) throw new Error('Iframe Turbovip tidak ditemukan di halaman ini\\.');

    await ctx.telegram.editMessageText(ctx.chat.id, waitMsg.message_id, undefined, `⏳ Ekstraksi M3U8 *${escape(cleanTitle)}*\\.\\.\\.`, { parse_mode: 'MarkdownV2' });
    await randomDelay(1500, 3000);

    // 2. Ekstraksi M3U8
    const turbo = new TurbovipExtractor();
    const result = await turbo.extract(targetUrl);
    
    // Ambil resolusi terendah untuk kecepatan
    const targetStream = result.streams[result.streams.length - 1]; 
    if (!targetStream) throw new Error('Tidak ada stream video yang valid\\.');

    const safeFileName = `${cleanTitle.replace(/[\\/:*?"<>|]/g, '')}_${Date.now()}`;
    
    await ctx.telegram.editMessageText(ctx.chat.id, waitMsg.message_id, undefined, `📥 *Mengunduh Video* \\\[${escape(targetStream.quality)}\\\]\n_Proses ini memakan waktu beberapa menit \\(Stealth Mode\\)\\._`, { parse_mode: 'MarkdownV2' });

    // 3. Download ke VPS
    const localFilePath = await downloadM3u8(targetStream.url, safeFileName);
    const fileStats = fs.statSync(localFilePath);
    const fileHash = crypto.createHash('sha256').update(`LK21_SPIDER:${fileStats.size}`).digest('hex');

    if (getMovieByHash(fileHash)) {
      fs.unlinkSync(localFilePath);
      return ctx.telegram.editMessageText(ctx.chat.id, waitMsg.message_id, undefined, `ℹ️ Film *${escape(cleanTitle)}* sudah ada di database\\. Unduhan dibatalkan\\.`, { parse_mode: 'MarkdownV2' });
    }

    await ctx.telegram.editMessageText(ctx.chat.id, waitMsg.message_id, undefined, `🚀 *Mengunggah ke Archive Channel\\.\\.\\.*\nUkuran: ${escape((fileStats.size / 1024 / 1024).toFixed(2))} MB`, { parse_mode: 'MarkdownV2' });

    // 4. Upload ke Telegram Archive
    logger.info({ event: 'telegram_upload_start', target: cleanTitle, size_mb: (fileStats.size / 1024 / 1024).toFixed(2) });
    
    // ✨ Konversi resolusi mentah (misal: "854x480") menjadi "480p"
    const resHeight = targetStream.quality.split('x').pop();
    const qualityLabel = isNaN(resHeight) ? targetStream.quality : `${resHeight}p`;
    
    // ✨ Rangkai caption mentah menjadi format rapi: Judul (Tahun) - 480p
    const rawCaption = `${cleanTitle} ${year ? `(${year}) ` : ''}- ${qualityLabel}`;

    const sent = await ctx.telegram.sendVideo(ARCHIVE_CHANNEL, { source: localFilePath }, {
      caption: escape(rawCaption),
      parse_mode: 'MarkdownV2',
      supports_streaming: true
    });
    
    const archiveMsgId = sent.message_id;
    const tgFileId = sent.video.file_id;
    logger.info({ event: 'telegram_upload_success', archive_msg_id: archiveMsgId });

    await ctx.telegram.editMessageText(ctx.chat.id, waitMsg.message_id, undefined, `🔍 *Mencari Metadata TMDB\\.\\.\\.*`, { parse_mode: 'MarkdownV2' });

    // 5. Automasi TMDB & Database
    logger.info({ event: 'tmdb_search_start', title: cleanTitle, year: year || 'N/A' });
    let meta = await searchMovieMeta(cleanTitle, year);
    
    if (meta) {
      logger.info({ event: 'tmdb_search_success', tmdb_id: meta.tmdb_id, found_title: meta.title });
      const dbId = saveMovieLocal({
        ...meta,
        file_size: fileStats.size,
        file_hash: fileHash,
        r2_url: '',
        file_id: tgFileId,
        message_id: archiveMsgId
      });

      await ctx.telegram.editMessageText(ctx.chat.id, waitMsg.message_id, undefined, `✅ *Berhasil Ditambahkan\\!*\n🎬 *${escape(meta.title)}* \\(${escape(meta.year)}\\)\n_Upload R2 berjalan di background\\.\\.\\._`, { parse_mode: 'MarkdownV2' });

      // Background Upload R2 & Hapus Lokal
      logger.info({ event: 'r2_upload_start', target: meta.title });
      uploadToR2(fs.createReadStream(localFilePath), `movies/${meta.tmdb_id}_${meta.title.replace(/[^a-zA-Z0-9]/g, '')}.mp4`, 'video/mp4', fileStats.size)
        .then(async r2Url => {
          if (r2Url) {
            updateMovieR2(dbId, r2Url);
            await syncMovieToApi({ ...meta, r2_url: r2Url });
            logger.info({ event: 'lk21_r2_sync_ok', title: meta.title });
          }
        })
        .catch(err => logger.error({ event: 'lk21_bg_process_failed', msg: err.message }))
        .finally(() => {
           fs.unlinkSync(localFilePath); // Hapus dari VPS!
           logger.info({ event: 'local_cleanup_done', target: meta.title });
        });

    } else {
      logger.warn({ event: 'tmdb_search_failed', reason: 'Not found automatically', title: cleanTitle });
      // Tunggu input manual... (kode lama tetap sama)
      pendingMovieMeta.set(userId, {
        fileId: tgFileId,
        archiveMsgId: archiveMsgId,
        fileSize: fileStats.size,
        fileHash: fileHash,
        mimeType: 'video/mp4',
        localPath: localFilePath,
        ext: 'mp4'
      });

      await ctx.telegram.editMessageText(ctx.chat.id, waitMsg.message_id, undefined, `⚠️ *Video Selesai Diunggah\\!*\n\nPencarian otomatis TMDB untuk "${escape(cleanTitle)}" gagal\\.\n👉 Silakan balas pesan ini dengan *ID TMDB* secara manual:`, { parse_mode: 'MarkdownV2' });
    }

  } catch (err) {
    ctx.telegram.deleteMessage(ctx.chat.id, waitMsg.message_id).catch(() => {});
    ctx.reply(`❌ *Gagal:* ${escape(err.message)}`, { parse_mode: 'MarkdownV2', message_thread_id: threadId });
  }
}

module.exports = { handleSeedMovs };