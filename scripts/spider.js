// scripts/spider.js
require('dotenv').config();
const axios = require('axios');
const path = require('path');
const fs = require('fs');
const { Telegraf } = require('telegraf');

// Import fungsi dari core bot
const { handleAddTrack } = require('../src/features/admin/admin.handler');
const { getTrack, findTrackByTitleArtist } = require('../src/features/spotify/spotify.repo');
const { escape } = require('../src/formats/utils'); 

// ✨ IMPORT SPIDER REPO & DB CONNECTION
const { 
  getNextPendingArtist, markArtistDone, countSpiderQueue, 
  countDoneSpider, checkArtistNameExists, addSpiderSeed 
} = require('../src/features/spider/spider.repo');
const { db } = require('../src/features/spotify/spotify.repo'); // Untuk penutupan DB dengan aman

// ── SISTEM LOGGING PRODUKSI ───────────────────────────────────────────────────
function sysLog(level, moduleName, message, meta = null) {
  const ts = new Date().toISOString();
  const metaStr = meta ? ` | META: ${JSON.stringify(meta)}` : '';
  const logString = `[${ts}] [${level}] [${moduleName}] ${message}${metaStr}`;
  
  if (level === 'ERROR') console.error(logString);
  else if (level === 'WARN') console.warn(logString);
  else console.log(logString);
}

// Helper: Human-like delay dengan Gaussian Distribution (Kurva Lonceng)
function gaussianRandom(min, max) {
  let num;
  do {
    let u = 0, v = 0;
    while (u === 0) u = Math.random(); 
    while (v === 0) v = Math.random();
    num = Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
    num = num / 10.0 + 0.5; 
  } while (num > 1 || num < 0); 
  
  return Math.floor(num * (max - min) + min);
}

// ── VALIDASI ENVIRONMENT VARIABLES ────────────────────────────────────────────
const requiredEnv = [
  'TELEGRAM_TOKEN', 
  'SPOTIFY_CLIENT_ID', 
  'SPOTIFY_CLIENT_SECRET', 
  'TELEGRAM_ADMIN_GROUP_ID', 
  'TELEGRAM_OWNER_ID', 
  'TELEGRAM_ADMIN_THREAD_SPIDER',
  'TELEGRAM_ADMIN_THREAD_SPIDER_PANEL', 
  'TELEGRAM_ADMIN_THREAD_ALERT'        
];
const missingEnv = requiredEnv.filter(key => !process.env[key]);
if (missingEnv.length > 0) {
  sysLog('ERROR', 'SYSTEM_FATAL', `Gagal Start: Environment variables krusial belum diset: ${missingEnv.join(', ')}`);
  process.exit(1);
}

const bot = new Telegraf(process.env.TELEGRAM_TOKEN);
const ADMIN_GROUP = process.env.TELEGRAM_ADMIN_GROUP_ID;
const THREAD_SPIDER = Number(process.env.TELEGRAM_ADMIN_THREAD_SPIDER);
const THREAD_PANEL = Number(process.env.TELEGRAM_ADMIN_THREAD_SPIDER_PANEL);
const THREAD_ALERT = Number(process.env.TELEGRAM_ADMIN_THREAD_ALERT);
const ARCHIVE_CHANNEL = process.env.TELEGRAM_ARCHIVE_CHANNEL_ID;

const STATS_PATH = path.join(__dirname, '../data/spotify/spider-stats.json');
const MAX_RETRY = parseInt(process.env.SPIDER_MAX_RETRY) || 2;
const SPOTIFY_AUTH_URL = 'https://accounts.spotify.com/api/token';
const SPOTIFY_API_URL  = 'https://api.spotify.com/v1';

let isRunning = true;
let globalArtistsProcessed = 0;
let globalAlbumsScanned = 0;
let globalTracksAttempted = 0;
let globalTracksSuccess = 0;
let globalDeepSleepCount = 0;
let globalStartTime = Date.now();
let consecutiveFatalErrors = 0;

async function getSpotifyToken() {
  const creds = Buffer.from(`${process.env.SPOTIFY_CLIENT_ID}:${process.env.SPOTIFY_CLIENT_SECRET}`).toString('base64');
  const params = new URLSearchParams();
  params.append('grant_type', 'client_credentials');
  
  const res = await axios.post(SPOTIFY_AUTH_URL, params, {
    headers: {
      'Authorization': `Basic ${creds}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    timeout: 7000
  });
  return res.data.access_token;
}

const executeWithTimeout = (promise, ms, abortSignal) => {
  let timer;
  const timeoutPromise = new Promise((_, rej) => {
    timer = setTimeout(() => rej(new Error('TIMEOUT')), ms);
  });
  const abortPromise = new Promise((_, rej) => {
    if (abortSignal?.aborted) return rej(new Error('ABORTED'));
    abortSignal?.addEventListener('abort', () => rej(new Error('ABORTED')), { once: true });
  });
  return Promise.race([promise, timeoutPromise, abortPromise]).finally(() => clearTimeout(timer));
};

const baseMockCtx = {
  isSpider: true,
  chat: { id: Number(ADMIN_GROUP) },
  message: { message_thread_id: THREAD_SPIDER },
  telegram: bot.telegram,
  reply: async (text, opts = {}) => {
    const targetThread = opts.message_thread_id || THREAD_SPIDER;
    return bot.telegram.sendMessage(ADMIN_GROUP, text, { parse_mode: 'MarkdownV2', ...opts, message_thread_id: targetThread });
  },
  replyWithAudio: async (audio, opts = {}) => {
    const targetThread = opts.message_thread_id || THREAD_SPIDER;
    return bot.telegram.sendAudio(ADMIN_GROUP, audio, { ...opts, message_thread_id: targetThread });
  }
};

async function checkMemoryAndRestartIfNeeded() {
  const mem = process.memoryUsage();
  const memRssMB = (mem.rss / 1024 / 1024).toFixed(1);
  if (mem.rss > 1200 * 1024 * 1024) { 
    sysLog('WARN', 'SYSTEM_MEMORY', `Proteksi RAM Terpicu! Penggunaan RSS: ${memRssMB} MB. Melakukan restart terencana...`);
    try {
      await bot.telegram.sendMessage(
        ADMIN_GROUP,
        `⚠️ *Spider Auto-Restart*\nRAM mencapai *${memRssMB} MB*\\. Restart preventif diaktifkan untuk mencegah OOM crash dan menjaga stabilitas VPS\\.\n_Sistem akan hidup kembali otomatis via systemd/PM2\\._`,
        { parse_mode: 'MarkdownV2', message_thread_id: THREAD_ALERT }
      );
    } catch (e) {}
    await updateStatsFile('MEMORY_RESTART');
    process.exit(0);
  }
}

async function updateStatsFile(statusString, nextWake = null) {
  try {
    const currentStatsPath = STATS_PATH;
    let currentStats = {};
    if (fs.existsSync(currentStatsPath)) {
      currentStats = JSON.parse(fs.readFileSync(currentStatsPath, 'utf8'));
    }
    const uptimeMins = ((Date.now() - globalStartTime) / 1000 / 60).toFixed(1);
    
    currentStats.status = statusString;
    currentStats.next_wake_time = nextWake ? nextWake.toISOString() : null;
    currentStats.uptime_minutes = parseFloat(uptimeMins);
    currentStats.artists_processed_session = globalArtistsProcessed;
    currentStats.albums_scanned_session = globalAlbumsScanned;
    currentStats.tracks_attempted_session = globalTracksAttempted;
    currentStats.tracks_success_session = globalTracksSuccess;
    currentStats.deep_sleep_count = globalDeepSleepCount;
    currentStats.last_updated = new Date().toISOString();
    
    fs.writeFileSync(currentStatsPath, JSON.stringify(currentStats, null, 2));
  } catch (err) {
    sysLog('WARN', 'STATS_FILE', `Gagal mengupdate stats berkas JSON`, err.message);
  }
}

async function runSpiderWorker() {
  const pendingCount = countSpiderQueue();
  const doneCount = countDoneSpider();
  sysLog('INFO', 'SYSTEM', `=== SPIDER BOT WORKER ONLINE === | Statistik Antrean: ${pendingCount} Pending, ${doneCount} Selesai`);
  
  const dataDir = path.join(__dirname, '../data/spotify');
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  while (isRunning) {
    await checkMemoryAndRestartIfNeeded();
    const currentArtist = getNextPendingArtist();
    
    if (!currentArtist) {
      sysLog('INFO', 'WORKER_SLEEP', `Tidak ada antrean pending. Masuk ke mode Deep Sleep (15 Menit)...`);
      globalDeepSleepCount++;
      const wakeTime = new Date(Date.now() + 15 * 60 * 1000);
      await updateStatsFile('DEEP_SLEEP', wakeTime);
      
      for (let i = 0; i < 90; i++) {
        if (!isRunning) break;
        await new Promise(r => setTimeout(r, 10000));
      }
      continue;
    }

    sysLog('INFO', 'WORKER_PROCESS', `Memulai koordinasi artis`, { id: currentArtist.artist_id, name: currentArtist.name });
    await updateStatsFile('PROCESSING_ARTIST');
    
    let token;
    try {
      token = await getSpotifyToken();
    } catch (err) {
      sysLog('ERROR', 'SPOTIFY_AUTH', `Gagal mendapatkan token akses`, err.message);
      consecutiveFatalErrors++;
      if (consecutiveFatalErrors >= 5) {
        sysLog('ERROR', 'SYSTEM_FATAL', `Terlalu banyak kesalahan fatal beruntun. Emergency Shutdown.`);
        process.exit(1);
      }
      await new Promise(r => setTimeout(r, 30000));
      continue;
    }

    const artistStartTime = Date.now();
    let albumOffset = 0;
    const albumLimit = 50;
    let fetchAlbums = true;
    let totalLaguTerproses = 0;
    let totalLaguBerhasil = 0;
    
    const abortController = new AbortController();
    const { signal } = abortController;

    while (fetchAlbums && isRunning) {
      try {
        sysLog('INFO', 'API_SPOTIFY', `Fetching daftar album...`, { offset: albumOffset, limit: albumLimit });
        const albumRes = await axios.get(`${SPOTIFY_API_URL}/artists/${currentArtist.artist_id}/albums`, {
          headers: { 'Authorization': `Bearer ${token}` },
          params: { include_groups: 'album,single', limit: albumLimit, offset: albumOffset },
          timeout: 10000
        });

        const albums = albumRes.data.items;
        if (!albums || albums.length === 0) {
          fetchAlbums = false;
          break;
        }

        sysLog('INFO', 'PROCESS_ALBUMS', `Ditemukan ${albums.length} album untuk discan`);
        for (const album of albums) {
          if (!isRunning) break;
          globalAlbumsScanned++;
          sysLog('INFO', 'ALBUM_SCAN', `Membongkar track dari album: ${album.name} (${album.release_date})`);
          
          let trackOffset = 0;
          const trackLimit = 50;
          let fetchTracks = true;

          while (fetchTracks && isRunning) {
            try {
              const trackRes = await axios.get(`${SPOTIFY_API_URL}/albums/${album.id}/tracks`, {
                headers: { 'Authorization': `Bearer ${token}` },
                params: { limit: trackLimit, offset: trackOffset },
                timeout: 10000
              });

              const tracks = trackRes.data.items;
              if (!tracks || tracks.length === 0) {
                fetchTracks = false;
                break;
              }

              for (const track of tracks) {
                if (!isRunning) break;
                totalLaguTerproses++;
                const safeTitle = track.name;
                const safeArtist = currentArtist.name;

                const existing = findTrackByTitleArtist(safeTitle, safeArtist);
                if (existing) {
                  sysLog('INFO', 'TRACK_SKIP', `Lagu sudah ada di database local`, { track: safeTitle });
                  continue;
                }

                const spotifyUrl = `https://open.spotify.com/track/${track.id}`;
                sysLog('INFO', 'DOWNLOAD_QUEUE', `Mengirim lagu ke CORE core downloader`, { track: safeTitle, url: spotifyUrl });
                
                let attempt = 1;
                let success = false;
                
                const currentMockCtx = {
                  ...baseMockCtx,
                  message: { ...baseMockCtx.message, text: `/add ${spotifyUrl}` },
                  from: { id: Number(process.env.TELEGRAM_OWNER_ID), first_name: 'SpiderWorker' }
                };

                while (attempt <= MAX_RETRY && !success) {
                  try {
                    await executeWithTimeout(handleAddTrack(currentMockCtx, spotifyUrl), 3 * 60 * 1000, signal);
                    success = true;
                    totalLaguBerhasil++;
                    sysLog('INFO', 'DOWNLOAD_SUCCESS', `Handler selesai diproses`, { track: safeTitle });
                  } catch (err) {
                    sysLog('WARN', 'DOWNLOAD_FAILED', `Gagal download di attempt ${attempt}/${MAX_RETRY}`, { track: safeTitle, msg: err.message });
                    attempt++;
                    if (attempt <= MAX_RETRY && isRunning) {
                      const backoff = gaussianRandom(10000, 25000);
                      await new Promise(r => setTimeout(r, backoff));
                    }
                  }
                }

                if (!success && isRunning) {
                  try {
                    await bot.telegram.sendMessage(
                      ADMIN_GROUP,
                      `❌ *Spider Download Gagal*\n\n` +
                      `Artis: *${escape(safeArtist)}*\n` +
                      `Lagu: *${escape(safeTitle)}*\n` +
                      `URL: \`${spotifyUrl}\`\n` +
                      `Detail: _Semua attempt (${MAX_RETRY}) gagal_`,
                      { parse_mode: 'MarkdownV2', message_thread_id: THREAD_SPIDER }
                    );
                  } catch (e) {
                    sysLog('WARN', 'NOTIFY_FAILED', `Gagal mengirim notifikasi Telegram`, e.message);
                  }
                }

                if (isRunning) {
                  const stealthDelay = gaussianRandom(15000, 35000);
                  await new Promise(r => setTimeout(r, stealthDelay));
                }
              }

              trackOffset += trackLimit;
              if (trackRes.data.next === null) {
                fetchTracks = false;
              }
            } catch (trackErr) {
              sysLog('ERROR', 'TRACK_API_ERR', `Gagal mengambil daftar track album`, trackErr.message);
              fetchTracks = false;
            }
          }
        }

        albumOffset += albumLimit;
        if (albumRes.data.next === null) {
          fetchAlbums = false;
        }
      } catch (albumErr) {
        sysLog('ERROR', 'ALBUM_API_ERR', `Gagal mengambil daftar album artis`, albumErr.message);
        fetchAlbums = false;
      }
    }

    if (!isRunning) {
      throw new Error('ABORTED');
    }

    const artistEndTime = Date.now();
    const durationMs = artistEndTime - artistStartTime;
    const durationMin = (durationMs / 1000 / 60).toFixed(2);
    
    globalArtistsProcessed++;
    globalTracksAttempted += totalLaguTerproses;
    globalTracksSuccess += totalLaguBerhasil;
    consecutiveFatalErrors = 0;

    markArtistDone(currentArtist.artist_id);
    sysLog('INFO', 'ARTIST_COMPLETE', `Selesai memproses penuh artis`, {
      name: currentArtist.name,
      duration_minutes: durationMin,
      total_tracks: totalLaguTerproses,
      success_tracks: totalLaguBerhasil
    });

    const artistBreak = gaussianRandom(45000, 90000);
    sysLog('INFO', 'SYSTEM_BREAK', `Istirahat antar artis selama ${(artistBreak / 1000).toFixed(1)} detik...`);
    
    for (let t = 0; t < artistBreak; t += 5000) {
      if (!isRunning) break;
      await new Promise(r => setTimeout(r, 5000));
    }
  }
}

function handleSpiderShutdown(shutdownReason) {
  if (!isRunning) return;
  isRunning = false;
  const totalSesiMenit = ((Date.now() - globalStartTime) / 1000 / 60).toFixed(1);
  sysLog('SYSTEM', 'SHUTDOWN', `Shutdown signal diterima: ${shutdownReason}. Menghentikan seluruh sub-proses...`);
  
  try {
    const finalStats = fs.existsSync(STATS_PATH) ? JSON.parse(fs.readFileSync(STATS_PATH, 'utf8')) : {};
    finalStats.status = 'OFFLINE';
    finalStats.shutdown_reason = shutdownReason;
    finalStats.total_session_minutes = parseFloat(totalSesiMenit);
    finalStats.total_session_albums_scanned = globalAlbumsScanned;
    finalStats.total_deep_sleep_count = globalDeepSleepCount; 
    finalStats.total_session_tracks_attempted = globalTracksAttempted;
    finalStats.total_session_tracks_success = globalTracksSuccess;
    finalStats.timestamp = new Date().toISOString();
    
    fs.writeFileSync(STATS_PATH, JSON.stringify(finalStats, null, 2));
  } catch (e) {}

  try {
    db.close();
    sysLog('INFO', 'SYSTEM', 'Koneksi database SQLite ditutup dengan aman.');
  } catch (err) {
    sysLog('ERROR', 'SYSTEM', 'Gagal menutup koneksi database', { error: err.message });
  }

  setTimeout(() => {
    sysLog('SYSTEM', 'SHUTDOWN_FORCE', 'Shutdown paksa via exit 0.');
    process.exit(0);
  }, 2000);
}

process.on('SIGTERM', () => handleSpiderShutdown('SIGTERM'));
process.on('SIGINT', () => handleSpiderShutdown('SIGINT'));

runSpiderWorker().catch(err => {
  sysLog('ERROR', 'CRITICAL_CRASH', `Worker mengalami crash fatal tak tertangani`, err.stack);
  updateStatsFile('CRASHED');
  process.exit(1);
});