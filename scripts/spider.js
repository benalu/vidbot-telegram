// scripts/spider.js
require('dotenv').config();
const axios = require('axios');
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const { Telegraf } = require('telegraf');

// Import fungsi dari core bot
const { handleAddTrack } = require('../src/features/admin/admin.handler');
const { getTrack, findTrackByTitleArtist } = require('../src/features/spotify/spotify.repo');
const { escape } = require('../src/formats/utils'); 

// ── SISTEM LOGGING PRODUKSI ───────────────────────────────────────────────────
// Format: [YYYY-MM-DDTHH:mm:ss.sssZ] [LEVEL] [MODULE] Pesan... | { meta }
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
  'TELEGRAM_ADMIN_THREAD_SPIDER_PANEL', // ✨ Diperlukan untuk log operasional
  'TELEGRAM_ADMIN_THREAD_ALERT'        // ✨ Diperlukan untuk darurat sistem
];
const missingEnv = requiredEnv.filter(key => !process.env[key]);
if (missingEnv.length > 0) {
  sysLog('ERROR', 'SYSTEM_FATAL', `Gagal Start: Environment variables krusial belum diset: ${missingEnv.join(', ')}`);
  process.exit(1);
}
// ──────────────────────────────────────────────────────────────────────────────

const bot = new Telegraf(process.env.TELEGRAM_TOKEN);

// Koneksi ke DB yang sama untuk menyimpan queue artis (Dengan proteksi antrean 5 detik)
const DB_PATH = path.join(__dirname, '../data/spotify/data.db');
const db = new Database(DB_PATH, { timeout: 5000 });
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');

// Konstanta
const MAX_RETRY = parseInt(process.env.SPIDER_MAX_RETRY) || 2;

// Buat tabel antrean spider jika belum ada
db.exec(`
  CREATE TABLE IF NOT EXISTS spider_artists (
    artist_id TEXT PRIMARY KEY,
    name TEXT,
    status TEXT DEFAULT 'pending', -- 'pending', 'done'
    added_at INTEGER DEFAULT (strftime('%s', 'now'))
  )
`);

const stmts = {
  addArtist: db.prepare(`INSERT OR IGNORE INTO spider_artists (artist_id, name, status) VALUES (?, ?, 'pending')`),
  getPending: db.prepare(`SELECT * FROM spider_artists WHERE status = 'pending' ORDER BY added_at ASC LIMIT 1`),
  markDone: db.prepare(`UPDATE spider_artists SET status = 'done' WHERE artist_id = ?`),
  countPending: db.prepare(`SELECT COUNT(*) as count FROM spider_artists WHERE status = 'pending'`),
  countDone: db.prepare(`SELECT COUNT(*) as count FROM spider_artists WHERE status = 'done'`), 
  checkArtistName: db.prepare(`SELECT artist_id FROM spider_artists WHERE LOWER(name) = LOWER(?)`),
};

// Helper: URL Spotify 
const SPOTIFY_AUTH_URL = 'https://' + 'accounts' + '.spotify' + '.com' + '/api/token';
const SPOTIFY_API_URL  = 'https://' + 'api' + '.spotify' + '.com' + '/v1';
const SPOTIFY_WEB_URL  = 'https://' + 'open' + '.spotify' + '.com' + '/track/';

// Helper: Abort-aware delay
const abortController = new AbortController();
const { signal } = abortController;

const delay = (ms) => new Promise((res, rej) => {
  if (signal.aborted) return rej(new Error('ABORTED'));
  const timer = setTimeout(res, ms);
  signal.addEventListener('abort', () => {
    clearTimeout(timer);
    rej(new Error('ABORTED'));
  }, { once: true });
});

// Sinyal Dinamis (Graceful Shutdown & Anti-Crash)
let isRunning = true;
let shutdownReason = 'UNKNOWN_FATAL_ERROR'; 

process.on('uncaughtException', (err) => {
  sysLog('ERROR', 'SYSTEM_FATAL', `Uncaught Exception (Crash Sinkron)`, { error: err.message, stack: err.stack });
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  sysLog('ERROR', 'SYSTEM_FATAL', `Unhandled Rejection (Promise Bocor)`, { reason: reason?.message || reason });
});

process.on('SIGINT', () => {
  sysLog('WARN', 'SYSTEM', `Sinyal SIGINT diterima. Memulai graceful shutdown... (Artis selesai sesi ini: ${globalArtistsProcessed})`);
  isRunning = false;
  shutdownReason = 'SIGINT (Manual/Systemd Stop)'; 
  abortController.abort();
});
process.on('SIGTERM', () => {
  sysLog('WARN', 'SYSTEM', `Sinyal SIGTERM diterima. Memulai graceful shutdown... (Artis selesai sesi ini: ${globalArtistsProcessed})`);
  isRunning = false;
  shutdownReason = 'SIGTERM (Systemd Restart/Kill)'; 
  abortController.abort();
});

async function getSpotifyAccessToken() {
  try {
    const auth = Buffer.from(`${process.env.SPOTIFY_CLIENT_ID}:${process.env.SPOTIFY_CLIENT_SECRET}`).toString('base64');
    const res = await axios.post(SPOTIFY_AUTH_URL, 'grant_type=client_credentials', {
      headers: { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 10000
    });
    sysLog('INFO', 'AUTH', 'Spotify Access Token berhasil didapatkan.');
    return res.data.access_token;
  } catch (err) {
    sysLog('ERROR', 'AUTH', 'Gagal mendapatkan Spotify Access Token', { error: err.message });
    throw err;
  }
}

// ── VARIABEL ANALITIK GLOBAL ──────────────────────────────────────────────────
let globalArtistsProcessed = 0;
let globalTotalDurationMs = 0;
let globalTracksAttempted = 0;  
let globalTracksSuccess = 0;   
let consecutiveFatalErrors = 0;
// ──────────────────────────────────────────────────────────────────────────────

async function runSpider() {
  const pendingCount = stmts.countPending.get().count;
  const doneCount = stmts.countDone.get().count;
  sysLog('INFO', 'SYSTEM', `=== SPIDER BOT WORKER ONLINE === | Statistik Antrean: ${pendingCount} Pending, ${doneCount} Selesai`);

  try {
    const statsPath = path.join(__dirname, '../data/spotify/spider-stats.json');
    let initStats = {};
    if (fs.existsSync(statsPath)) {
      initStats = JSON.parse(fs.readFileSync(statsPath, 'utf8'));
      if (initStats.shutdown_reason) {
        initStats.last_shutdown_reason = initStats.shutdown_reason; 
        delete initStats.shutdown_reason;
      }
    }
    initStats.status = 'ONLINE';
    initStats.timestamp = new Date().toISOString();
    fs.writeFileSync(statsPath, JSON.stringify(initStats, null, 2));
  } catch (e) {}

  let token = null;
  try {
    token = await getSpotifyAccessToken();
  } catch (e) {
    sysLog('ERROR', 'SYSTEM', 'Gagal inisialisasi token awal. Bot dihentikan.');
    process.exit(1);
  }
  let tokenTime = Date.now();
  let isIdle = false;

  while (isRunning) {
    // Auto-refresh token tiap 50 menit
    if (Date.now() - tokenTime > 50 * 60 * 1000) {
      sysLog('INFO', 'AUTH', 'Menyegarkan masa berlaku Spotify Token...');
      try {
        token = await getSpotifyAccessToken();
        tokenTime = Date.now();
      } catch (err) {
        sysLog('WARN', 'AUTH', 'Gagal refresh token rutin, akan dicoba lagi dalam 5 menit.');
        tokenTime = Date.now() - (45 * 60 * 1000);
      }
    }

    const currentArtist = stmts.getPending.get();
    if (!currentArtist) {
        if (!isIdle) {
          sysLog('INFO', 'QUEUE', 'Antrean artis telah habis. Spider masuk mode Idle (Tidur 30 detik).');
          bot.telegram.sendMessage(
            process.env.TELEGRAM_ADMIN_GROUP_ID,
            `💤 *Spider Idle*\nAntrean artis telah disapu bersih\\. Bot menunggu data baru\\.\\.\\.`,
            { parse_mode: 'MarkdownV2', message_thread_id: Number(process.env.TELEGRAM_ADMIN_THREAD_SPIDER_PANEL) } // ✨ PANEL
          ).catch(() => {});
          isIdle = true;
        }
        await delay(30000).catch(() => {});
        continue;
    }
    
    if (isIdle) {
      sysLog('INFO', 'SYSTEM', 'Spider keluar dari mode Idle. Menemukan artis baru di antrean!');
      isIdle = false;
    }

    const sisaAntrean = Math.max(0, stmts.countPending.get().count - 1);
    sysLog('INFO', 'QUEUE', `Memulai pemrosesan artis.`, { 
      artist_name: currentArtist.name, 
      artist_id: currentArtist.artist_id,
      pending_queue: sisaAntrean 
    });

    const artistStartTime = Date.now();

    try {
      let albumOffset = 0;
      const albumLimit = 10;
      const trackLimit = 10;
      let fetchAlbums = true;
      let totalLaguTerproses = 0;
      let totalLaguBerhasil = 0;
      let totalSkipPermanen = 0;
      let totalGagalTotal = 0;
      let artisBaruDitemukan = 0;
      let currentAlbumIndex = 0;
      let totalAlbumsInApi = 0;

      // ✨ ROUTING TERPISAH: Text/Log ke PANEL, Media Audio ke SONGS
      const baseMockCtx = {
        isSpider: true, 
        chat: { id: Number(process.env.TELEGRAM_ADMIN_GROUP_ID) },
        from: { id: Number(process.env.TELEGRAM_OWNER_ID), username: 'spider_bot' },
        telegram: bot.telegram,
        sendChatAction: async () => {},
        reply: (text, opts) => {
          sysLog('INFO', 'TG_MOCK_REPLY', `Pesan Telegram dikirim`, { msg: text.substring(0, 50).replace(/\n/g, ' ') });
          return bot.telegram.sendMessage(process.env.TELEGRAM_ADMIN_GROUP_ID, text, {
            ...opts, message_thread_id: Number(process.env.TELEGRAM_ADMIN_THREAD_SPIDER_PANEL) // ✨ PANEL
          });
        },
        replyWithAudio: (audio, opts) => {
          sysLog('INFO', 'TG_MOCK_UPLOAD', `Mengunggah buffer audio ke Telegram...`);
          return bot.telegram.sendAudio(process.env.TELEGRAM_ADMIN_GROUP_ID, audio, {
            ...opts, message_thread_id: Number(process.env.TELEGRAM_ADMIN_THREAD_SPIDER) // ✨ SONGS
          }).then(sent => {
            sysLog('INFO', 'TG_MOCK_UPLOAD', `Audio berhasil terkirim ke Telegram`, { file_id: sent?.audio?.file_id });
            return sent;
          }).catch(err => {
            sysLog('ERROR', 'TG_MOCK_UPLOAD', `Gagal mengunggah ke Telegram`, { error: err.message });
            throw err;
          });
        },
        message: { message_thread_id: Number(process.env.TELEGRAM_ADMIN_THREAD_SPIDER_PANEL) } // ✨ PANEL Default
      };

      while (fetchAlbums && isRunning) {
        try {
          sysLog('INFO', 'API_SPOTIFY', `Fetching daftar album...`, { offset: albumOffset, limit: albumLimit });
          const albumRes = await axios.get(`${SPOTIFY_API_URL}/artists/${currentArtist.artist_id}/albums`, {
            headers: { 'Authorization': `Bearer ${token}` },
            params: { include_groups: 'album,single', market: 'ID', limit: albumLimit, offset: albumOffset },
            timeout: 10000
          });

          if (albumOffset === 0) totalAlbumsInApi = albumRes.data.total;
          
          const albums = albumRes.data.items;
          if (albums.length === 0) {
            fetchAlbums = false;
            continue;
          }

          sysLog('INFO', 'API_SPOTIFY', `Berhasil mendapatkan ${albums.length} rilis album/single.`);
          
          for (const album of albums) {
            if (!isRunning) break;
            
            currentAlbumIndex++;
            sysLog('INFO', 'PROCESS_ALBUM', `Membongkar tracklist album [${currentAlbumIndex}/${totalAlbumsInApi || '?'}]`, { album_name: album.name, type: album.album_type });
            await delay(gaussianRandom(1200, 2500)).catch(() => {});

            let trackOffset = 0;
            let fetchTracks = true;

            while (fetchTracks && isRunning) {
              try {
                 const trackRes = await axios.get(`${SPOTIFY_API_URL}/albums/${album.id}/tracks`, {
                   headers: { 'Authorization': `Bearer ${token}` },
                   params: { market: 'ID', limit: trackLimit, offset: trackOffset },
                   timeout: 10000
                 });
                 
                 const tracks = trackRes.data.items;
                 if (tracks.length === 0) {
                   fetchTracks = false;
                   continue;
                 }

                 const executeWithTimeout = (promise, ms, abortSignal) => {
                   let timer;
                   const timeoutPromise = new Promise((_, rej) => {
                     timer = setTimeout(() => rej(new Error('TIMEOUT_HANG: API eksternal menggantung (Stuck)')), ms);
                   });
                   const abortPromise = new Promise((_, rej) => {
                     if (abortSignal.aborted) return rej(new Error('ABORTED'));
                     abortSignal.addEventListener('abort', () => rej(new Error('ABORTED')), { once: true });
                   });
                   return Promise.race([promise, timeoutPromise, abortPromise])
                     .finally(() => clearTimeout(timer));
                 };

                 for (let i = 0; i < tracks.length; i++) {
                    if (!isRunning) break;
                    const track = tracks[i];
                    const safeTitle = track.name;
                    const safeArtist = track.artists?.length > 0 ? track.artists[0].name : 'Unknown';

                    if (!track.id || !/^[a-zA-Z0-9]{22}$/.test(track.id)) {
                      sysLog('WARN', 'FILTER_SKIP', `Track dilewati (ID tidak valid / Malformed API Response)`, { track: safeTitle, id: track.id });
                      continue; 
                    }

                    // Filter 1: Pastikan ini lagu artis utama
                    if (safeArtist.toLowerCase() !== currentArtist.name.toLowerCase()) {
                      continue; 
                    }

                    // Filter 2: Ekspansi Kolaborasi
                    track.artists.forEach(a => {
                      if (a.id !== currentArtist.artist_id && /^[a-zA-Z0-9]{22}$/.test(a.id)) {
                        const existingName = stmts.checkArtistName.get(a.name);
                        if (!existingName) {
                          const result = stmts.addArtist.run(a.id, a.name);
                          if (result.changes > 0) artisBaruDitemukan++;
                        }
                      }
                    });

                    // Filter 3: Cek Bypass ID
                    if (getTrack(track.id)) {
                      sysLog('INFO', 'FILTER_SKIP', `Track dilewati (Sudah ada via ID)`, { track: safeTitle });
                      await delay(100).catch(() => {});
                      continue;
                    }

                    // Filter 4: Cek Meta DB
                    if (findTrackByTitleArtist(safeTitle, safeArtist)) {
                      sysLog('INFO', 'FILTER_SKIP', `Track dilewati (Sudah ada via Meta DB)`, { track: safeTitle });
                      await delay(100).catch(() => {});
                      continue;
                    }

                    totalLaguTerproses++;
                    sysLog('INFO', 'DOWNLOAD_INIT', `Mengeksekusi handler pengunduhan`, { index: totalLaguTerproses, track: safeTitle });
                    const spotifyUrl = SPOTIFY_WEB_URL + track.id;

                    baseMockCtx.message.message_id = Date.now() % 100000000;
                    baseMockCtx.message.text = `/spot ${spotifyUrl}`;

                    let attempt = 0;
                    let success = false;
                    let skipStealthDelay = false;
                    while (attempt <= MAX_RETRY && !success) {
                      try {
                        await executeWithTimeout(handleAddTrack(baseMockCtx, spotifyUrl), 3 * 60 * 1000, signal);
                        success = true;
                        totalLaguBerhasil++;
                        sysLog('INFO', 'DOWNLOAD_SUCCESS', `Handler selesai diproses`, { track: safeTitle });
                      } catch (err) {
                        if (err.message === 'ABORTED') throw err; 
                        
                        // Cek kondisi Skip Permanen
                        if (err.message.includes('Durasi terlalu pendek') || 
                            err.message.includes('incomplete') || 
                            err.message.includes('kandidat tumbang')) {
                          totalSkipPermanen++;
                          sysLog('WARN', 'DOWNLOAD_ABORTED', `Skip Permanen (Aturan Validasi)`, { track: safeTitle, reason: err.message });
                          
                          // ✨ NOTIFIKASI KE TELEGRAM (SKIP PERMANEN -> PANEL)
                          bot.telegram.sendMessage(
                            process.env.TELEGRAM_ADMIN_GROUP_ID,
                            `⚠️ *Skip Permanen*\n🎵 ${escape(safeTitle)} — ${escape(safeArtist)}\n_Alasan: ${escape(err.message)}_`,
                            { parse_mode: 'MarkdownV2', message_thread_id: Number(process.env.TELEGRAM_ADMIN_THREAD_SPIDER_PANEL) } // ✨ PANEL
                          ).catch((err) => {
                            sysLog('ERROR', 'TG_NOTIFY_FAILED', `Gagal mengirim notifikasi Skip/Gagal ke Telegram`, { error: err.message });
                          });
                          
                          skipStealthDelay = true;
                          break; // Keluar dari loop retry
                        }

                        // Jika masih ada sisa retry
                        if (attempt < MAX_RETRY) {
                          const waitTime = 10000 * Math.pow(2, attempt); 
                          sysLog('WARN', 'DOWNLOAD_RETRY', `Gagal mengeksekusi handler, menjadwalkan ulang`, { attempt: attempt + 1, error: err.message, wait_ms: waitTime });
                          await delay(waitTime);
                        } else {
                          totalGagalTotal++;
                          sysLog('ERROR', 'DOWNLOAD_FATAL', `Semua retry habis. Track dilewati secara paksa`, { track: safeTitle });
                          
                          // ✨ NOTIFIKASI KE TELEGRAM (GAGAL TOTAL -> PANEL)
                          bot.telegram.sendMessage(
                            process.env.TELEGRAM_ADMIN_GROUP_ID,
                            `❌ *Gagal Download*\n🎵 ${escape(safeTitle)} — ${escape(safeArtist)}\n_Alasan: Semua retry habis \\(${escape(err.message)}\\)_`,
                            { parse_mode: 'MarkdownV2', message_thread_id: Number(process.env.TELEGRAM_ADMIN_THREAD_SPIDER_PANEL) } // ✨ PANEL
                          ).catch((err) => {
                            sysLog('ERROR', 'TG_NOTIFY_FAILED', `Gagal mengirim notifikasi Skip/Gagal ke Telegram`, { error: err.message });
                          });
                        }
                        attempt++;
                      }
                    }

                    // Delay antar lagu (STEALTH MODE: 45 - 90 Detik)
                    if (isRunning && !skipStealthDelay) {
                      const minDelay = 45000;
                      const maxDelay = 90000;
                      const waitTime = gaussianRandom(minDelay, maxDelay);
                      sysLog('INFO', 'STEALTH_DELAY', `Menunggu sebelum memproses track berikutnya...`, { delay_sec: (waitTime / 1000).toFixed(1) });
                      await delay(waitTime).catch(() => {});
                    }
                 }

                 trackOffset += trackLimit;
                 if (tracks.length < trackLimit) fetchTracks = false;
                 else await delay(gaussianRandom(400, 900)).catch(() => {});
                 
              } catch (err) {
                sysLog('ERROR', 'API_SPOTIFY', `Gagal fetch list lagu dalam album`, { 
                  error: err.message, 
                  response: err.response?.data,
                  last_track_offset: trackOffset 
                });
                if (err.message === 'ABORTED') throw err; // ✨ FIX: Sinyal Abort diteruskan ke atas, tidak tertelan
                if (err.response && [401, 429, 500, 502, 503].includes(err.response.status)) {
                  throw err; 
                }
                fetchTracks = false;
              }
            }
            await delay(gaussianRandom(800, 1800)).catch(() => {});
          }
          
          albumOffset += albumLimit;
          if (albums.length < albumLimit) fetchAlbums = false;

        } catch (err) {
          sysLog('ERROR', 'API_SPOTIFY', `Gagal fetch halaman album`, { 
            error: err.message, 
            response: err.response?.data,
            last_album_offset: albumOffset
          });
          if (err.message === 'ABORTED') throw err; // ✨ FIX: Sinyal Abort diteruskan ke atas, tidak tertelan
          if (err.response && [401, 429, 500, 502, 503].includes(err.response.status)) {
            throw err; 
          }
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
      globalTotalDurationMs += durationMs;
      globalTracksAttempted += totalLaguTerproses;
      globalTracksSuccess += totalLaguBerhasil;
      consecutiveFatalErrors = 0;

      const memSnapshot = process.memoryUsage();
      const memRssMB = Math.round(memSnapshot.rss / 1024 / 1024);
      const memHeapMB = Math.round(memSnapshot.heapUsed / 1024 / 1024);

      // ✨ FIX: Sisa antrean di-query dan disimpan di atas sebelum deklarasi duplikat terjadi
      stmts.markDone.run(currentArtist.artist_id);
      const sisaAntreanUpdate = stmts.countPending.get().count;
      const doneCountUpdate = stmts.countDone.get().count;

      sysLog('INFO', 'QUEUE_DONE', `Selesai memproses artis. Antrean: ${sisaAntreanUpdate} Pending | ${doneCountUpdate} Selesai.`, { artis_baru_dijaring: artisBaruDitemukan, durasi_menit: durationMin, ram_rss_mb: memRssMB, ram_heap_mb: memHeapMB });
      const avgDurationMs = globalTotalDurationMs / globalArtistsProcessed;

      const etaMs = avgDurationMs * sisaAntreanUpdate;
      const etaHours = (etaMs / 1000 / 60 / 60).toFixed(1);
      const displayEta = globalArtistsProcessed <= 3 ? escape('Kalkulasi...') : `~${escape(etaHours)} Jam`;

      const statsExport = {
        status: 'ONLINE',
        pending: sisaAntreanUpdate,
        done: doneCountUpdate,
        last_artist_processed: currentArtist.name,
        last_aborted_artist: null, // Reset state abort karena siklus ini sukses penuh
        last_duration_minutes: parseFloat(durationMin),
        average_duration_ms: Math.floor(avgDurationMs),
        memory_rss_mb: memRssMB,
        memory_heap_mb: memHeapMB,
        total_session_artists: globalArtistsProcessed,
        total_albums_scanned: currentAlbumIndex,
        total_session_tracks_attempted: globalTracksAttempted,
        total_session_tracks_success: globalTracksSuccess,
        estimated_time_remaining_hours: parseFloat(etaHours),
        uptime_hours: parseFloat((process.uptime() / 3600).toFixed(2)),
        timestamp: new Date().toISOString()
      };
      
      fs.promises.writeFile(path.join(__dirname, '../data/spotify/spider-stats.json'), JSON.stringify(statsExport, null, 2))
        .catch(err => sysLog('WARN', 'SYSTEM', `Gagal mengekspor spider-stats.json`, { error: err.message }));

      // ✨ NOTIFIKASI REPORT SELESAI -> PANEL (265)
      await bot.telegram.sendMessage( 
        process.env.TELEGRAM_ADMIN_GROUP_ID,
        `✅ *Spider Report: Selesai*\n\n` +
        `👤 *Artis:* ${escape(currentArtist.name)}\n` +
        `CD *Album Disisir:* ${currentAlbumIndex}\n` + 
        `🎵 *Lagu Sukses:* ${totalLaguBerhasil} / ${totalLaguTerproses}\n` +
        (totalSkipPermanen > 0 ? `⏭️ *Skip Permanen:* ${totalSkipPermanen}\n` : '') +  
        (totalGagalTotal > 0 ? `❌ *Gagal Total:* ${totalGagalTotal}\n` : '') +       
        `⏱️ *Waktu Eksekusi:* ${escape(durationMin)} Menit\n` +
        `🕸️ *Artis Baru Terjaring:* ${artisBaruDitemukan}\n` +
        `⏳ *Sisa Antrean:* ${sisaAntreanUpdate}\n` +
        `💾 *RAM:* ${memRssMB} MB\n` +
        `🔮 *Estimasi Selesai:* ${displayEta}`,
        { parse_mode: 'MarkdownV2', message_thread_id: Number(process.env.TELEGRAM_ADMIN_THREAD_SPIDER_PANEL) } // ✨ PANEL
      ).catch((err) => {
        sysLog('ERROR', 'TG_REPORT_FAILED', `Gagal mengirim ringkasan ke Telegram`, { error: err.message });
      });

      const RAM_THRESHOLD_MB = Number(process.env.SPIDER_RAM_LIMIT_MB) || 800;
      const MAX_ARTISTS_SESSION = Number(process.env.SPIDER_MAX_ARTISTS) || 100;
      
      // ✨ EMERGENCY NOTIFICATION -> ALERT (74)
      if (memRssMB >= RAM_THRESHOLD_MB) {
        sysLog('WARN', 'SYSTEM_RESTART', `RAM OS melebihi batas aman (${memRssMB}MB >= ${RAM_THRESHOLD_MB}MB). Memicu auto-restart...`);
        await bot.telegram.sendMessage(
          process.env.TELEGRAM_ADMIN_GROUP_ID, 
          `⚠️ *Spider Auto-Restart*\nRAM mencapai *${memRssMB} MB*\\. Restart preventif diaktifkan untuk mencegah OOM crash dan menjaga stabilitas VPS\\.\n_Sistem akan hidup kembali otomatis via systemd/PM2\\._`, 
          { parse_mode: 'MarkdownV2', message_thread_id: Number(process.env.TELEGRAM_ADMIN_THREAD_ALERT) } // 🚨 ALERT
        ).catch(() => {});
        
        isRunning = false;
        shutdownReason = 'AUTO_RESTART_RAM_LIMIT';
      } else if (globalArtistsProcessed >= MAX_ARTISTS_SESSION) {
        sysLog('INFO', 'SYSTEM_RESTART', `Batas ${MAX_ARTISTS_SESSION} artis tercapai. Memicu auto-restart preventif...`);
        await bot.telegram.sendMessage(
          process.env.TELEGRAM_ADMIN_GROUP_ID, 
          `🔄 *Spider Auto-Restart*\nBatas *${MAX_ARTISTS_SESSION} artis* tercapai dalam satu sesi\\. Melakukan refresh memori & koneksi database\\.\n_Sistem akan hidup kembali otomatis\\._`, 
          { parse_mode: 'MarkdownV2', message_thread_id: Number(process.env.TELEGRAM_ADMIN_THREAD_ALERT) } // 🚨 ALERT
        ).catch(() => {});
        
        isRunning = false;
        shutdownReason = 'AUTO_RESTART_ARTIST_LIMIT';
      }

      // Delay perpindahan Artis (SUPER STEALTH: 2 - 4 Menit)
      if (isRunning) {
        const minDelay = 120000;
        const maxDelay = 240000;
        const waitTime = gaussianRandom(minDelay, maxDelay);
        sysLog('INFO', 'STEALTH_DELAY', `Istirahat panjang sebelum artis berikutnya...`, { delay_min: (waitTime / 1000 / 60).toFixed(1) });
        await delay(waitTime).catch(() => {});
      }

    } catch (err) {
      if (err.message === 'ABORTED') {
        sysLog('WARN', 'PROCESS_ABORTED', `Pemrosesan dihentikan paksa (Graceful Shutdown)`, { artist: currentArtist.name });
        try {
          const statsPath = path.join(__dirname, '../data/spotify/spider-stats.json');
          if (fs.existsSync(statsPath)) {
            const statsRaw = fs.readFileSync(statsPath, 'utf8');
            const stats = JSON.parse(statsRaw);
            stats.last_aborted_artist = currentArtist.name;
            fs.writeFileSync(statsPath, JSON.stringify(stats, null, 2));
          }
        } catch (e) {}
        break;
      }
      if (err.response) {
        const status = err.response.status;
        if (status === 401) {
          sysLog('WARN', 'AUTH', `Token expired saat memproses ${currentArtist.name}. Memaksa refresh token...`);
          sysLog('INFO', 'RECOVERY', `Artis akan diproses ulang dari awal pada siklus berikutnya.`);
          tokenTime = 0;
          continue;
        } else if (status === 429) {
          sysLog('WARN', 'API_SPOTIFY', `Rate Limit (429) tercapai. Menidurkan Spider 5 menit...`);
          sysLog('INFO', 'RECOVERY', `Artis akan diproses ulang dari awal pada siklus berikutnya.`);
          await delay(5 * 60 * 1000).catch(() => {});
          continue;
        } else if (status >= 500) {
          sysLog('WARN', 'API_SPOTIFY', `Server Spotify Error (${status}). Menidurkan Spider 30 detik...`);
          await delay(30000).catch(() => {});
          continue;
        }
      }
      consecutiveFatalErrors++;
      sysLog('ERROR', 'PROCESS_FATAL', `Kesalahan fatal saat memproses artis`, { artist: currentArtist.name, error: err.response ? err.response.data : err.message, consecutive_errors: consecutiveFatalErrors });
      
      // 🚨 CRITICAL EMERGENCY SYSTEM FAILURE -> ALERT (74)
      if (consecutiveFatalErrors >= 3) {
         await bot.telegram.sendMessage(
            process.env.TELEGRAM_ADMIN_GROUP_ID,
            `🚨 *Spider Alert: FATAL ERROR Beruntun*\nBot mengalami kegagalan fatal 3x berturut\\-turut\\.\n_Cek log server segera\\!_`,
            { parse_mode: 'MarkdownV2', message_thread_id: Number(process.env.TELEGRAM_ADMIN_THREAD_ALERT) } // 🚨 ALERT
         ).catch(() => {});
         consecutiveFatalErrors = 0;
      }
      sysLog('INFO', 'RECOVERY', `Tidur 3 menit untuk pemulihan dari error...`);
      await delay(3 * 60 * 1000).catch(() => {});
    }
  }

  const totalSesiMenit = (globalTotalDurationMs / 1000 / 60).toFixed(2);
  sysLog('INFO', 'SYSTEM', `=== SPIDER BOT OFF LINE === | Total Sesi Ini: ${globalArtistsProcessed} Artis Selesai | Total Waktu Kerja: ${totalSesiMenit} Menit.`);
  try {
    const statsPath = path.join(__dirname, '../data/spotify/spider-stats.json');
    let finalStats = {};
    if (fs.existsSync(statsPath)) {
        finalStats = JSON.parse(fs.readFileSync(statsPath, 'utf8'));
    }
    finalStats.status = 'OFFLINE';
    finalStats.shutdown_reason = shutdownReason;
    finalStats.total_session_minutes = parseFloat(totalSesiMenit);
    finalStats.total_session_tracks_attempted = globalTracksAttempted;
    finalStats.total_session_tracks_success = globalTracksSuccess;
    finalStats.timestamp = new Date().toISOString();
    
    fs.writeFileSync(statsPath, JSON.stringify(finalStats, null, 2));
  } catch (e) {}

  try {
    db.close();
    sysLog('INFO', 'SYSTEM', 'Koneksi database SQLite ditutup dengan aman.');
  } catch (err) {
    sysLog('ERROR', 'SYSTEM', 'Gagal menutup koneksi database', { error: err.message });
  }
  process.exit(0);
}

runSpider();