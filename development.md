# VidOpsBot — Development Guide

> Dokumen ini adalah pegangan utama pengembangan. Baca sebelum membuat perubahan apapun.

---

## Daftar Isi

1. [Arsitektur & Gambaran Umum](#1-arsitektur--gambaran-umum)
2. [Struktur Proyek](#2-struktur-proyek)
3. [Alur Data](#3-alur-data)
4. [Modul & Tanggung Jawab](#4-modul--tanggung-jawab)
5. [Konvensi Kode](#5-konvensi-kode)
6. [Cara Menambah Fitur Baru](#6-cara-menambah-fitur-baru)
7. [Database](#7-database)
8. [Integrasi Eksternal](#8-integrasi-eksternal)
9. [Environment Variables](#9-environment-variables)
10. [Scripts & Migrasi](#10-scripts--migrasi)
11. [Review & Temuan Penting](#11-review--temuan-penting)
12. [To-Do List](#12-to-do-list)

---

## 1. Arsitektur & Gambaran Umum

Bot ini beroperasi di **dua grup Telegram** dengan peran berbeda:

```
┌──────────────────────────────────────────────────────────────┐
│                         VidOpsBot                            │
│                                                              │
│  Grup Publik (thread per fitur)   Grup Admin (Panel)         │
│  ──────────────────────────────   ──────────────────         │
│  Thread Spotify  → /spot          Upload audio manual        │
│                    /random /top   /dbstats  /listtrack       │
│  Thread FLAC     → /flac          /findtrack /deltrack       │
│  Thread Social   → /tik /inst     /syncr2   /syncmeta       │
│                    /twit /threads Auto-detect Spotify URL    │
│  Thread Vidhub   → /vids                                     │
│  Thread APK      → /apk                                      │
│  Thread Movies   → /movie                                    │
│  Thread Leakcheck→ /leak                                     │
│  (semua thread)  → /help                                     │
│                                                              │
│  DM (Private Chat)                                           │
│  ──────────────────                                          │
│  /spot  /flac  /apk   (keyword search only, no URL)         │
└──────────────────────────────────────────────────────────────┘
         │                        │
         ▼                        ▼
   SQLite (local)          REST API (eksternal)
   data/spotify/           /admin/downloader/mp3
   data/flac/              /admin/downloader/flac
         │
         ▼
   Cloudflare R2
   (file storage publik)
```

**Filosofi utama:**
- Bot Telegram = sumber kebenaran pertama (file_id Telegram + SQLite lokal)
- REST API = database sekunder untuk kebutuhan web/frontend
- R2 = CDN publik, URL-nya disimpan di kedua database
- Sync ke REST API selalu berjalan **fire-and-forget** di background, tidak boleh memblokir respons ke user

---

## 2. Struktur Proyek

```
/
├── src/
│   ├── index.js                  # Entry point, registrasi semua command & action
│   ├── api/
│   │   └── client.js             # VidBotClient — HTTP client ke REST API eksternal
│   ├── config/
│   │   ├── commands.js           # Registry command bot (tambah command di sini)
│   │   └── topics.js             # Mapping grup → thread ID per fitur
│   ├── features/
│   │   ├── admin/
│   │   │   ├── admin.handler.js  # Orchestrator admin + handleAddTrack via URL
│   │   │   ├── admin.manage.js   # /dbstats /listtrack /findtrack /deltrack
│   │   │   ├── admin.sync.js     # /syncr2 /syncmeta
│   │   │   └── admin.upload.js   # Upload audio manual (on:audio / on:document)
│   │   ├── dm/
│   │   │   └── dm.handler.js     # Handler khusus private chat + callback DM
│   │   ├── flac/
│   │   │   ├── flac.format.js    # Format pesan FLAC (belum dipakai di handler utama)
│   │   │   ├── flac.handler.js   # /flac command + callback + pagination
│   │   │   └── flac.repo.js      # Repository SQLite FLAC
│   │   ├── social/
│   │   │   ├── social.format.js  # Format TikTok/IG/Twitter/Threads
│   │   │   └── social.handler.js # Handler TikTok/IG/Twitter/Threads/Spotify
│   │   └── spotify/
│   │       ├── spotify.format.js # Format pesan Spotify (URL mode)
│   │       ├── spotify.handler.js# /spot command — search, URL, callback, random, top
│   │       └── spotify.repo.js   # Repository SQLite MP3/Spotify
│   ├── formats/
│   │   ├── app.js                # Format pesan APK
│   │   ├── movies.js             # Format pesan Movies
│   │   ├── utils.js              # escape() + normalizeUrl() — JANGAN duplikasi
│   │   └── vidhub.js             # Format pesan Vidhub
│   ├── handlers/
│   │   ├── app.js                # handleAppAndroid
│   │   ├── help.js               # handleHelp (context-aware per topic)
│   │   ├── leakcheck.js          # handleLeakcheck
│   │   ├── movies.js             # handleMovies
│   │   └── vidhub.js             # handleVidhub
│   └── utils/
│       ├── api-sync.js           # syncMp3ToApi + syncFlacToApi → REST API
│       ├── logger.js             # Structured JSON logger
│       ├── process.js            # Graceful shutdown + uncaughtException handler
│       ├── r2.js                 # uploadToR2, deleteFromR2, trackKey()
│       ├── ratelimit.js          # Per-user cooldown (in-memory Map)
│       └── spotify.js            # Spotify API client untuk metadata enrichment
├── scripts/
│   ├── migrateFlacToApi.js       # Migrasi bulk FLAC SQLite → REST API
│   ├── migrateMp3ToApi.js        # Migrasi bulk MP3 SQLite → REST API
│   └── syncR2Flac.js             # Upload file .flac lokal ke R2 + sync API
└── data/
    ├── spotify/data.db           # SQLite MP3 (auto-created)
    ├── flac/data.db              # SQLite FLAC (auto-created)
    └── local_flac/               # Drop folder untuk syncR2Flac.js
```

---

## 3. Alur Data

### 3a. User Request via Spotify URL (`/spot <url>`)

```
User kirim URL
     │
     ▼
handleUrl() — cek cache DB (track_id / title+artist)
     │
     ├─ HIT → replyWithAudio(file_id) ──────────────────────► Selesai
     │
     └─ MISS → download buffer dari CDN Spotify
                    │
                    ▼
             replyWithAudio(buffer) → Telegram mengembalikan file_id
                    │
                    ▼ (background IIFE, tidak di-await)
             ┌──────────────────────────────────┐
             │ 1. saveTrack() → SQLite           │
             │ 2. enrichMetadata() → Spotify API │
             │ 3. updateTrackMeta() → SQLite     │
             │ 4. uploadToR2() → Cloudflare R2   │
             │ 5. syncMp3ToApi() → REST API      │
             └──────────────────────────────────┘
```

### 3b. Upload Audio Manual (Admin)

```
Admin upload file audio
     │
     ▼
handleAudioUpload()
     │
     ├─ Cek duplikat via file_hash
     ├─ Parse ID3 tag (music-metadata)
     ├─ Fallback: Telegram metadata → caption
     ├─ Cek duplikat via title+artist
     ├─ enrichMetadata() → Spotify + LastFM
     ├─ saveFlacTrack() / saveTrack() → SQLite
     │
     └─ (background) uploadToR2() → syncFlacToApi() / syncMp3ToApi()
```

### 3c. Add Track via Spotify URL (Admin Panel)

```
Admin kirim Spotify URL di grup admin
     │
     ▼
handleAddTrack()
     │
     ├─ api.contentSpotify(url) → ambil info + download URL
     ├─ Download buffer → replyWithAudio ke Telegram
     ├─ saveTrack() → SQLite (data awal dari REST API response)
     │
     └─ (background IIFE)
          ├─ enrichMetadata() → Spotify Web API + LastFM (satu kali)
          ├─ updateTrackMeta() → SQLite
          ├─ uploadToR2() → Cloudflare R2
          └─ syncMp3ToApi() → REST API
```

### 3d. Sync REST API (Fire & Forget)

`syncMp3ToApi` dan `syncFlacToApi` di `api-sync.js` selalu dipanggil tanpa `await` di level tertinggi. Kegagalan hanya di-log, tidak pernah melempar error ke user.

---

## 4. Modul & Tanggung Jawab

| Modul | Tanggung Jawab | Boleh Import |
|---|---|---|
| `index.js` | Registrasi bot, routing command | Semua |
| `config/commands.js` | Daftar command + handler mapping | Handler saja |
| `config/topics.js` | Thread ID per fitur per grup | Tidak ada |
| `features/*/repo.js` | Akses SQLite (CRUD) | Hanya utils |
| `features/*/handler.js` | Logic bisnis, reply Telegram | repo, utils, api/client |
| `features/*/format.js` | Format teks MarkdownV2 | formats/utils saja |
| `formats/utils.js` | `escape()` + `normalizeUrl()` | Tidak ada |
| `utils/api-sync.js` | Push data ke REST API | utils/logger, axios |
| `utils/r2.js` | Upload/delete file Cloudflare R2 | AWS SDK |
| `utils/ratelimit.js` | Cooldown per user per command | Tidak ada |

**Aturan import:** Handler tidak boleh import handler lain secara langsung. Semua cross-feature communication lewat repo atau utils.

---

## 5. Konvensi Kode

### MarkdownV2
Semua teks yang dikirim ke Telegram **wajib** melewati `escape()` dari `src/formats/utils.js`. Karakter yang tidak di-escape akan menyebabkan `Bad Request` dari Telegram API.

```js
// ✅ Benar
const { escape } = require('../../formats/utils')
await ctx.reply(`*${escape(track.title)}*`, { parse_mode: 'MarkdownV2' })

// ❌ Salah — jangan buat escape() sendiri
```

### Reply Options
Semua reply di grup harus menyertakan `message_thread_id` dan `reply_parameters`:

```js
function replyOpts(ctx) {
  return {
    parse_mode: 'MarkdownV2',
    message_thread_id: ctx.message.message_thread_id,
    reply_parameters: {
      message_id: ctx.message.message_id,
      allow_sending_without_reply: true,
    },
  }
}
```

### Background Tasks (IIFE)
Operasi yang tidak boleh memblokir respons user (R2 upload, REST sync, enrich metadata) **harus** dibungkus dalam IIFE tanpa await:

```js
// ✅ Pattern yang benar
;(async () => {
  try {
    await uploadToR2(...)
    await syncMp3ToApi(...)
  } catch (err) {
    logger.warn({ event: 'r2_upload_failed', msg: err.message })
  }
})()
// Handler lanjut tanpa menunggu
```

### Logging
Gunakan `logger` dari `src/utils/logger.js`. Selalu sertakan `event` sebagai identifier:

```js
logger.info({ event: 'track_cached', track: title, userId })
logger.warn({ event: 'r2_upload_failed', track: title, msg: err.message })
logger.error({ event: 'spotify_fatal', msg: err.message })
```

### Rate Limiting
Semua command publik sudah dilindungi oleh `isRateLimited()` di `index.js`. Default cooldown 5 detik. Command DM punya cooldown sendiri di `dm.handler.js`:

```js
const DM_COOLDOWN = {
  spot: 5_000,
  flac: 5_000,
  apk:  10_000,  // lebih mahal karena hit external API
}
```

---

## 6. Cara Menambah Fitur Baru

### 6a. Tambah Command Grup Baru

1. **Buat handler** di `src/handlers/<nama>.js` atau `src/features/<nama>/<nama>.handler.js`
2. **Buat formatter** di `src/formats/<nama>.js` (jika perlu format pesan khusus)
3. **Daftarkan thread** di `src/config/topics.js`:
   ```js
   newfeature: process.env.TELEGRAM_THREAD_NEWFEATURE,
   ```
4. **Daftarkan command** di `src/config/commands.js`:
   ```js
   newcmd: { topic: 'newfeature', handler: handleNewFeature, requiresArg: true },
   ```
5. **Tambah env var** `TELEGRAM_THREAD_NEWFEATURE` ke `.env` dan ke `REQUIRED_ENV` di `index.js`
6. **Tambah help text** di `src/handlers/help.js` bagian `TOPIC_HELP`

### 6b. Tambah Command DM Baru

1. Buat handler di `dm.handler.js`
2. Tambahkan ke `DM_COMMANDS` dan `DM_COOLDOWN`
3. Update `handleDmStart()` untuk tampilkan command baru di pesan sambutan

### 6c. Tambah Kolom Database Baru

Gunakan pattern `try/catch ALTER TABLE` yang sudah ada di repo untuk backward compatibility:

```js
try { db.exec(`ALTER TABLE tracks ADD COLUMN new_col TEXT`) } catch {}
```

Tambahkan kolom ke statement `insert` dan semua fungsi yang relevan.

---

## 7. Database

### Skema (kedua DB identik kecuali path)

| Kolom | Tipe | Keterangan |
|---|---|---|
| `track_id` | TEXT PK | UUID (manual upload) atau Spotify track ID |
| `file_id` | TEXT | Telegram file_id — hanya valid di bot yang sama |
| `title` | TEXT | Judul lagu |
| `artist` | TEXT | Nama artist |
| `duration` | TEXT | Format `M:SS` |
| `quality` | TEXT | `MP3` / `FLAC` / `HQ` |
| `thumbnail` | TEXT | URL gambar cover (R2 atau Spotify CDN) |
| `file_size` | INTEGER | Bytes |
| `r2_url` | TEXT | URL publik Cloudflare R2 |
| `request_count` | INTEGER | Counter berapa kali diputar |
| `type` | TEXT | `mp3` atau `flac` |
| `source` | TEXT | `spotify` / `manual` |
| `album` | TEXT | Nama album (dari enrichment) |
| `year` | TEXT | Tahun rilis |
| `genre` | TEXT | Genre (dari LastFM) |
| `file_hash` | TEXT | SHA-256 dari `file_id:file_size` |
| `created_at` | INTEGER | Unix timestamp |

### Lokasi
- `data/spotify/data.db` — MP3/Spotify
- `data/flac/data.db` — FLAC

### WAL Mode
Kedua database menggunakan `journal_mode = WAL` dan `synchronous = NORMAL` untuk performa baca-tulis bersamaan yang lebih baik.

### Pencarian
Pencarian menggunakan dua pass: exact phrase match (`LIKE %keyword%`) lalu per-kata. Hasil digabung dengan deduplication via `Set`. Ini memungkinkan pencarian "daft punk" maupun "punk daft" menemukan hasil yang sama.

---

## 8. Integrasi Eksternal

### REST API (Internal)
Diakses via `axios` langsung di `api-sync.js` menggunakan `X-Master-Key` header. **Bukan** menggunakan `VidBotClient` — karena sync tidak butuh access token, hanya master key.

Endpoint yang digunakan:
- `POST /admin/downloader/mp3` — upsert satu track MP3
- `POST /admin/downloader/mp3/bulk` — bulk insert (script migrasi)
- `POST /admin/downloader/flac` — upsert satu track FLAC
- `POST /admin/downloader/flac/bulk` — bulk insert (script migrasi)

### VidBotClient (`api/client.js`)
Client HTTP ke REST API publik dengan auth dua lapis: API Key + Access Token (rotate otomatis setiap 4 menit). Digunakan oleh semua handler publik (Spotify download, TikTok, APK, dll).

Deduplifikasi refresh token via `_refreshPromise` — aman untuk concurrent request.

### Cloudflare R2
Diakses via AWS S3 SDK. Key format:
- MP3: `music/{Artist} - {Title} ({track_id}).mp3`
- FLAC: `flac/{Artist} - {Title} ({track_id}).flac`
- Cover: `covers/{track_id}.jpg`

`trackKey(trackId, title, artist, type)` di `r2.js` menghasilkan key yang benar berdasarkan parameter `type` (`'mp3'` | `'flac'`). **Selalu sertakan parameter `type`** saat memanggil fungsi ini — default `'mp3'` hanya fallback, bukan pilihan eksplisit.

### Spotify Web API
Hanya untuk **enrichment metadata** (album, year, thumbnail, genre). Tidak untuk download. Token di-cache in-memory, expire 1 menit sebelum waktu Spotify.

### LastFM API
Digunakan untuk mengambil genre/tag artist. Dipanggil setelah Spotify enrichment. Kegagalan diabaikan, genre akan null.

---

## 9. Environment Variables

```env
# REST API Publik (VidBotClient)
API_URL=
API_KEY=

# REST API Internal
REST_API_URL=                     # Base URL, tanpa trailing slash
REST_API_MASTER_KEY=              # Header X-Master-Key

# Telegram
TELEGRAM_GROUP_ID=                # ID grup publik (format: -100xxx)
TELEGRAM_TOKEN=                   # Bot token dari @BotFather

# Thread IDs (topik dalam grup publik — masing-masing thread berbeda)
TELEGRAM_THREAD_LEAKCHECK=
TELEGRAM_THREAD_MOVIES=
TELEGRAM_THREAD_FLAC=
TELEGRAM_THREAD_APK=
TELEGRAM_THREAD_VIDHUB=
TELEGRAM_THREAD_SPOTIFY=         # Thread khusus Spotify — TERPISAH dari social
TELEGRAM_THREAD_SOCIAL=          # Satu thread untuk TikTok, Instagram, Twitter, Threads

# Grup Admin
TELEGRAM_ADMIN_GROUP_ID=          # ID grup admin/panel
TELEGRAM_OWNER_ID=                # User ID pemilik (hanya dia yang bisa pakai admin commands)

# Cloudflare R2
R2_ENDPOINT=                      # https://<account>.r2.cloudflarestorage.com
R2_BUCKET=
R2_ACCESS_KEY_ID=
R2_SECRET_ACCESS_KEY=
R2_PUBLIC_URL=                    # URL publik tanpa trailing slash

# Spotify (metadata enrichment)
SPOTIFY_CLIENT_ID=
SPOTIFY_CLIENT_SECRET=

# LastFM (genre)
LASTFM_API_KEY=
```

---

## 10. Scripts & Migrasi

### `scripts/migrateMp3ToApi.js`
Membaca semua track dari `data/spotify/data.db` yang sudah punya `r2_url` lalu bulk-insert ke REST API. Jalankan sekali saat awal setup atau setelah ada data baru di SQLite yang belum masuk REST API.

```bash
node scripts/migrateMp3ToApi.js
```

### `scripts/migrateFlacToApi.js`
Sama seperti di atas tapi untuk FLAC.

```bash
node scripts/migrateFlacToApi.js
```

### `scripts/syncR2Flac.js`
Upload file `.flac` dari folder `data/local_flac/` ke R2, update SQLite, sync ke REST API. File yang berhasil diproses akan diberi prefix `_done_`.

Alur:
1. Taruh file `.flac` di `data/local_flac/`
2. Pastikan track sudah ada di SQLite FLAC (tanpa r2_url)
3. Jalankan script — matching dilakukan via ID3 tag title+artist
4. File berhasil → rename jadi `_done_namafile.flac`

```bash
node scripts/syncR2Flac.js
```

---

## 11. Review & Temuan Penting

Berikut hasil analisis codebase. Tidak semua perlu diperbaiki segera — prioritasnya ada di To-Do List.

### ✅ Yang Sudah Baik

- **Separation of concerns** cukup bersih: repo, handler, format, utils masing-masing punya tanggung jawab jelas
- **Background IIFE pattern** konsisten untuk operasi mahal (R2, sync API, enrich metadata) — user hanya menunggu sampai audio terkirim, tidak lebih
- **FLAC 20MB limit sudah benar** — `admin.upload.js` menggunakan `TG_DOWNLOAD_LIMIT = 20MB`; file yang lebih besar langsung di-skip R2 dengan log `manual_upload_r2_skipped`, dan harus diproses via `scripts/syncR2Flac.js` secara manual. MP3 umumnya di bawah 20MB sehingga bisa auto-upload R2 oleh bot
- **Auto-sync REST API via URL Spotify sudah benar** — alur di `spotify.handler.js`: download → replyWithAudio → background (enrich → saveTrack → uploadR2 → syncMp3ToApi). Selama file di bawah 20MB, REST API terisi otomatis tanpa intervensi manual
- **`/syncr2` by design tidak sync ke REST API** — ini one-time utility untuk backfill `r2_url` yang kosong. Setelah selesai, jalankan `migrateMp3ToApi.js` / `migrateFlacToApi.js` untuk bulk sync ke REST API. Dua step terpisah by design, bukan bug
- **Metadata dari Spotify Web API + LastFM** — response REST API internal hanya diambil URL download-nya. Semua metadata (album, year, thumbnail, genre) diambil dari Spotify Web API dan LastFM sebagai single source of truth ✅ *DONE (direfactor sesi lalu)*
- **`handleAddTrack` enrichment sekarang satu kali** — enrichment dipanggil sekali di background IIFE, hasilnya langsung ke `updateTrackMeta()` + R2 + sync dalam satu alur tanpa race condition ✅ *DONE (sesi ini)*
- **`trackKey()` di `admin.upload.js` sekarang menyertakan `type`** — FLAC manual upload menghasilkan key R2 yang benar (`flac/` dir, `.flac` ext) ✅ *DONE (sesi lalu)*
- **`notify()` di `admin.handler.js` sekarang menerima `telegram` instance** — sebelumnya menerima `bot` dan mengakses `bot.telegram.sendMessage` yang menyebabkan semua notifikasi admin silent fail sejak awal. Fix: parameter diganti `telegram`, body jadi `telegram.sendMessage(...)` langsung. Semua pemanggilan di `spotify.handler.js` dengan `ctx.telegram` sudah benar tanpa perlu diubah ✅ *DONE (sesi ini)*
- **Deduplication upload** via `file_hash` dan `title+artist` mencegah data ganda dari jalur berbeda
- **WAL mode SQLite** sudah aktif di kedua database
- **Graceful shutdown** sudah ada via `setupProcessHandlers()`
- **Rate limiting** per user per command sudah berjalan
- **Token refresh deduplification** di VidBotClient via `_refreshPromise` sudah benar
- **Search two-pass** (exact phrase + per kata) memberikan hasil yang lebih relevan
- **DM keyword-only by design** — URL Spotify sudah di-reject eksplisit di `handleDmSpot()` via `normalizeUrl()`, dan pesan `/start` sudah menyebutkan batasan ini secara eksplisit ✅ *DONE (sesi lalu)*
- **Admin group auto-detect Spotify URL** sudah berjalan via `bot.on('text')` di `registerAdminHandlers()`
- **Bug #1–#4** dari review pertama sudah diperbaiki (import formatSpotify, cache key FLAC, middleware next(), pendingUploads finally)

### ⚠️ Temuan & Potensi Masalah

**1. `flac.format.js` — import path salah, akan crash saat dipakai**
`require('./utils')` tidak ada di folder `src/features/flac/`. Yang benar adalah `../../formats/utils`. File ini belum diimport di mana pun sehingga tidak crash sekarang, tapi akan crash begitu diimport.

**2. `social.handler.js` — `handleSpotify` dead code tapi masih di-export dan masih import `formatSpotify`**
`commands.js` sudah pakai `handleSpotify` dari `spotify.handler.js`. Export `handleSpotify` dari `social.handler.js` tidak dipakai di mana pun — dua fungsi dengan nama sama di dua file berbeda, rawan bingung saat debugging. Import `formatSpotify` di baris atas file ini juga jadi orphan karena hanya dipakai oleh fungsi dead code ini.

**3. Tiga `searchCache` Map tanpa interval cleanup aktif**
`spotify.handler.js`, `flac.handler.js`, dan `dm.handler.js` masing-masing punya Map sendiri (max 300 entry tiap Map). Cleanup hanya terjadi saat ada cache hit expired — tidak ada `setInterval` aktif. Dengan tiga Map, potensi 900 entry stale di memory. Aman untuk sekarang, tapi perlu dimonitor kalau user tumbuh.

**4. `dm.handler.js` — cache key prefix `dm_spot:` bentrok naming dengan callback data**
Cache key untuk search result menggunakan format `dm_spot:{userId}:{keyword}`, sedangkan callback data untuk pilih track juga `dm_spot:{trackId}`. Tidak crash sekarang karena `cacheGet()` hanya dipanggil di `handleDmSpotPage()` — tapi naming rawan collision kalau ada refactor.

**5. `ratelimit.js` — cleanup cutoff lebih pendek dari interval**
Cleanup `setInterval` jalan tiap 60 detik, tapi cutoff hanya `COOLDOWN_MS * 2` (10 detik). Artinya entry yang sudah tidak berguna sejak 10 detik lalu masih duduk di Map hingga 50 detik berikutnya. Dengan max 2000 entry ini tidak jadi masalah memory, tapi cutoff yang lebih masuk akal adalah `60_000` (sama dengan interval) sehingga entry bersih tepat saat cleanup jalan.

**6. `handleSyncR2` — tidak ada summary invalid file_id**
Saat `/syncr2` jalan dan ada `file_id` yang sudah expired (misalnya bot pernah diganti token), error per-track hanya di-log individual. Tidak ada hitungan berapa file_id yang tidak valid di summary akhir. Berguna untuk mendeteksi kalau ada masalah sistemik, bukan hanya satu track yang corrupt.

**7. `spotify.handler.js` — `trackKey` dipanggil tanpa `type` eksplisit**
Di `handleUrl()`, `trackKey` dipanggil tanpa parameter `type`. Default fallback `'mp3'` memang benar untuk jalur ini, tapi tidak konsisten dengan aturan di catatan desain yang menyebut `type` wajib eksplisit. Fix: tambah `'mp3'` sebagai argument keempat.

**8. Resource usage di VPS (2 vCPU, 4 GB RAM, shared dengan bot Discord + REST API)**
Bot Node.js single-threaded — CPU tidak jadi bottleneck. Yang perlu diperhatikan adalah memory: setiap request `/spot` URL bisa hold buffer 5–10 MB selama background IIFE belum selesai. Beberapa request concurrent bisa hold 30–50 MB buffer sekaligus. Aman di 4 GB tapi perlu PM2 memory limit sebagai safety net.

Rekomendasi `ecosystem.config.js` untuk production:
```js
module.exports = {
  apps: [{
    name: 'vidops-bot',
    script: 'src/index.js',
    max_memory_restart: '512M',  // restart otomatis kalau ada leak
    instances: 1,                 // JANGAN cluster — SQLite tidak thread-safe
    watch: false,
    env: { NODE_ENV: 'production' }
  }]
}
```

**9. `admin.manage.js` `handleFindTrack` — hanya search MP3 DB, FLAC tidak dicakup**
`handleFindTrack` hanya memanggil `searchTracks()` dari `spotify.repo` — koleksi FLAC tidak dicari sama sekali. Admin yang mencari track FLAC via `/findtrack` tidak akan menemukan apapun meskipun track ada di FLAC DB. Ini inkonsisten dengan `/dbstats` dan `/listtrack` yang sudah gabungkan kedua DB. Fix: tambahkan `searchFlacTracks()` dan gabungkan hasilnya seperti yang dilakukan di `buildTrackListMessage()`.

**10. `admin.upload.js` — buffer di-download dua kali: sekali untuk ID3, sekali lagi untuk R2**
Buffer pertama di-download di awal handler (di dalam blok `if fileSize <= TG_DOWNLOAD_LIMIT`) untuk parsing ID3 tag, tapi setelah `saveTrack()` selesai, IIFE background memanggil `ctx.telegram.getFileLink()` dan `axios.get()` lagi untuk download ulang file yang sama sebelum upload ke R2. Ini membuang bandwidth dan menambah latency upload R2 tanpa alasan. Fix: simpan `buffer` dari ID3 parsing di variable yang bisa diakses IIFE background, dan skip re-download kalau buffer sudah tersedia.

**11. `handleAddTrack` — `saveTrack` dipanggil meski `trackId` null, akan crash SQLite**
Di `admin.handler.js`, jika `api.contentSpotify()` mengembalikan response tanpa `track_id` (misalnya track regional), variable `trackId` akan `null`. Blok background IIFE kemudian memanggil `saveTrack({ track_id: null, ... })` — karena `track_id` adalah `PRIMARY KEY TEXT NOT NULL` di SQLite, ini akan throw constraint error. Error ini ditangkap oleh `catch` di IIFE tapi track tidak tersimpan, dan tidak ada notifikasi ke admin. Fix: tambahkan guard sebelum `saveTrack()` — jika `trackId` null, generate UUID fallback atau log warning dan skip save.

**12. `spotify.handler.js` — user kedua yang concurrent dapat `fileId` null dari `pendingUploads`**
`pendingUploads` di `handleUrl()` menyimpan Promise yang resolve dengan `fileId`. Jika upload ke Telegram gagal (misalnya timeout), `resolveFileId(null)` dipanggil di `finally`. User lain yang menunggu `pendingUploads.get(trackId)` akan mendapat `fileId = null`, lalu `ctx.replyWithAudio(null, audioOpts)` dipanggil — ini akan throw error atau kirim request tidak valid ke Telegram. Fix: tambahkan null check setelah await: `if (fileId) await ctx.replyWithAudio(fileId, audioOpts)` dan reply error jika `fileId` null.

**13. `dm.handler.js` — `handleDmFlac` tidak menolak URL seperti `handleDmSpot`**
`handleDmSpot` sudah punya guard `normalizeUrl(arg)` yang menolak URL dengan pesan jelas. `handleDmFlac` tidak punya guard yang sama — user yang kirim `/flac https://open.spotify.com/...` tidak akan ditolak, URL-nya akan dijadikan keyword search (hasilnya NOT FOUND tanpa penjelasan yang informatif). Inkonsisten dengan perilaku `/spot` DM dan prinsip keyword-only di DM. Fix: tambahkan blok yang sama di awal `handleDmFlac`.

**14. `spotify.repo.js` dan `flac.repo.js` — `INSERT OR REPLACE` me-reset `request_count`**
Statement insert di kedua repo menggunakan `INSERT OR REPLACE`. Jika `track_id` yang sama dimasukkan lagi (misalnya admin panggil `handleAddTrack` dua kali untuk URL yang sama sebelum ada guard duplikat), seluruh row termasuk `request_count` akan di-replace dengan nilai baru (default 0). Statistik request historis hilang. Fix: gunakan `INSERT OR IGNORE` untuk insert awal, atau pisahkan upsert dengan `ON CONFLICT(track_id) DO UPDATE SET ... WHERE kolom_baru IS NOT NULL` agar `request_count` tidak ikut ter-reset.

---

## 12. To-Do List

> **Catatan desain yang tidak boleh diubah:**
> - Spotify memiliki thread tersendiri di grup publik, terpisah dari thread Social (TikTok/IG/Twitter/Threads)
> - DM (private chat) hanya mendukung pencarian via **keyword** — URL tidak didukung di DM, sengaja by design
> - Semua operasi berat (enrichment, R2 upload, REST API sync) harus di background — user hanya menunggu sampai audio terkirim, tidak lebih
> - File FLAC >20MB tidak bisa di-upload ke R2 oleh bot secara otomatis — harus via `scripts/syncR2Flac.js` manual. File MP3 umumnya <20MB sehingga auto-upload R2 oleh bot adalah perilaku yang benar
> - `/syncr2` adalah one-time utility untuk backfill `r2_url` kosong di SQLite, bukan untuk sync ke REST API. Setelah `/syncr2`, jalankan migration script untuk sync ke REST API
> - Metadata (album, year, thumbnail, genre) diambil dari Spotify Web API + LastFM, bukan dari response REST API internal. REST API internal hanya dipakai untuk URL download
> - `trackKey()` **wajib** dipanggil dengan parameter `type` eksplisit (`'mp3'` atau `'flac'`) — default `'mp3'` hanya fallback, bukan pilihan yang disengaja

---

### 🔴 Critical (Bug — Perbaiki Segera)

- [x] ~~**Fix import `formatSpotify` yang salah** di `social.handler.js`~~ ✅ *DONE*
- [x] ~~**Fix cache key mismatch** di `flac.handler.js`~~ ✅ *DONE*
- [x] ~~**Fix middleware `bot.use`** di `index.js`~~ ✅ *DONE*
- [x] ~~**Fix `pendingUploads` leak** di `spotify.handler.js`~~ ✅ *DONE*
- [x] ~~**Fix pesan NOT FOUND yang menyesatkan** di `spotify.handler.js`~~ ✅ *DONE*
- [x] ~~**Fix `/dbstats` tidak include koleksi FLAC** di `admin.manage.js`~~ ✅ *DONE*
- [x] ~~**Fix `trackKey()` dipanggil tanpa `type` di `admin.upload.js`**~~ ✅ *DONE (sesi ini)*
  Semua manual upload FLAC sebelumnya menghasilkan key R2 yang salah (`music/` dir, `.mp3` ext). Fix: `trackKey(trackId, title, artist, isFlac ? 'flac' : 'mp3')`.
- [x] ~~**Fix `enrichMetadata` dipanggil dua kali + race condition di `admin.handler.js`**~~ ✅ *DONE (sesi lalu)*
  `handleAddTrack()` sekarang punya satu IIFE background dengan satu enrichment call: enrich → `saveTrack()` sekali dengan data lengkap → `uploadToR2()` → `syncMp3ToApi()`. Tidak ada nested IIFE, tidak ada race condition.
- [x] ~~**Fix `notify()` parameter salah di `admin.handler.js`**~~ ✅ *DONE (sesi ini)*
  `notify(bot, text)` mengakses `bot.telegram.sendMessage` — padahal semua pemanggilan dari `spotify.handler.js` mengirim `ctx.telegram` (bukan bot instance), sehingga `bot.telegram` menjadi `undefined` dan semua notifikasi admin silent fail sejak awal. Fix: ganti parameter jadi `notify(telegram, text)` dan body jadi `telegram.sendMessage(...)` langsung.

- [x] ~~**Fix silent fail di `routeDmCommand` untuk command yang tidak didukung di DM**~~ ✅ *DONE*
  `DM_COMMANDS` hanya berisi `{ spot, flac, apk }` — command lain (`/tik`, `/vids`, `/movie`, dll) menghasilkan `handler = undefined` dan `routeDmCommand` return tanpa balas apapun. Fix: tambahkan fallback reply jika handler tidak ditemukan, arahkan user ke command yang tersedia.

- [x] ~~**Fix import path di `flac.format.js`**~~ ✅ *DONE*
  `require('./utils')` tidak ada di `src/features/flac/`. File belum diimport di mana pun sehingga tidak crash sekarang, tapi akan crash begitu diimport.

- [x] ~~***Fix `handleFindTrack` di `admin.manage.js`~~* — tidak mencari koleksi FLAC** ✅ DONE
  `handleFindTrack` hanya memanggil `searchTracks()` (MP3 DB). Tambahkan `searchFlacTracks()` dari `flac.repo`, gabungkan hasilnya, dan tandai badge `[FLAC]` / `[MP3]` di output seperti yang dilakukan `buildTrackListMessage()`. Tanpa fix ini, admin tidak bisa menemukan track FLAC via `/findtrack`.

- [x] ~~**Fix `handleAddTrack` di `admin.handler.js` — `saveTrack` crash jika `trackId` null**~~ ✅ DONE
  Jika `api.contentSpotify()` mengembalikan response tanpa `track_id`, variable `trackId` akan `null`. `saveTrack({ track_id: null })` akan throw SQLite PRIMARY KEY constraint error yang ter-swallow di IIFE catch. Fix: tambahkan guard sebelum `saveTrack()` — jika `trackId` null, generate UUID fallback (`const { v4: uuidv4 } = require('uuid')`) atau log warning dan skip save.

- [x] ~~**Fix `pendingUploads` null fileId di `spotify.handler.js`**~~ ✅ *DONE*
  Null check `if (fileId)` sudah ada di kode sebelumnya sehingga tidak akan throw, tapi user concurrent tetap dapat silent fail (return tanpa pesan). Fix: tambahkan `else` branch dengan pesan error eksplisit.

- [x] ~~**Fix `handleDmFlac` tidak menolak URL di `dm.handler.js`**~~ ✅ *DONE*

- [x] **Fix `INSERT OR REPLACE` me-reset `request_count` di kedua repo** ✅ *DONE*
  `INSERT OR REPLACE` di `spotify.repo.js` dan `flac.repo.js` akan me-replace seluruh row jika `track_id` sudah ada, termasuk `request_count` yang di-reset ke 0. Statistik request historis hilang jika track di-insert ulang. Fix: ganti ke `INSERT OR IGNORE` untuk insert pertama kali, atau gunakan `ON CONFLICT(track_id) DO UPDATE SET ... ` yang exclude `request_count` dari kolom yang di-update.

---

### 🟡 Penting (Planned)

- [x] ~~**Refactor `trackKey()` di `r2.js`** — tambah parameter `type`~~ ✅ *DONE*
- [x] ~~**Refactor metadata `spotify.handler.js`** — single write, Spotify Web API + LastFM sebagai source of truth~~ ✅ *DONE*
- [x] ~~**Update `/start` DM** — perjelas batasan keyword-only~~ ✅ *DONE*

- [x] **Hapus dead code `handleSpotify` di `social.handler.js`** ✅ *DONE*
  Fungsi ini tidak dipakai di mana pun. Hapus fungsi `handleSpotify`, hapus import `formatSpotify` di baris atas, dan hapus dari `module.exports`. Kalau tidak dihapus, dua fungsi bernama `handleSpotify` di dua file berbeda akan terus jadi sumber kebingungan saat debugging.

- [ ] **Hapus atau integrasikan `flac.format.js`**
  File ini ada tapi tidak pernah diimport. Kalau masih relevan, pakai di `flac.handler.js`. Kalau tidak, hapus agar tidak membingungkan. Sebelum mengintegrasikan, fix dulu import path-nya (lihat Critical di atas).

- [x] ~~**Rename cache key prefix di `dm.handler.js`**~~ ✅ *DONE*

- [ ] **Tambah `type` eksplisit di `trackKey()` dalam `spotify.handler.js`**
  Di `handleUrl()`, `trackKey` dipanggil tanpa parameter `type`. Secara fungsional benar (default `'mp3'`), tapi tidak konsisten dengan aturan bahwa `type` wajib eksplisit. Fix: `trackKey(trackId || Date.now().toString(), safeTitle, safeArtist, 'mp3')`.

- [ ] **Refactor `admin.upload.js` — reuse buffer ID3 untuk upload R2**
  Buffer yang sudah di-download untuk parsing ID3 tag seharusnya di-pass ke IIFE background untuk upload R2, bukan download ulang dari Telegram. Simpan `buffer` di variable yang bisa diakses IIFE (deklarasikan di luar blok `try` ID3), lalu gunakan kembali di IIFE dan skip `getFileLink()` + `axios.get()` kedua. Ini memangkas bandwidth dan latency upload R2 jadi setengahnya untuk setiap upload admin.

---

### 🟢 Improvement (Backlog)

- [ ] **`handleSyncR2` di `admin.sync.js` — `BATCH` hanya mengontrol progress bar, bukan real concurrency**
  Variable `BATCH = 5` hanya dipakai sebagai trigger update progress bar (`if (i % BATCH === 0)`), sedangkan proses download dan upload tetap sequential satu per satu di dalam loop `for`. Untuk `/syncr2` yang bisa jalan ratusan track sekaligus, ini berarti waktu total = jumlah track × (latency getFileLink + latency download + latency R2 upload). Improvement: proses bisa di-chunk dengan `Promise.allSettled()` per N track — tapi harus hati-hati dengan Telegram API rate limit (30 req/sec global, lebih rendah per-chat). Jangan apply ke `handleSyncMeta` karena sudah ada intentional `delay(1000)` untuk rate limit Spotify/LastFM yang tidak boleh dihilangkan.

- [ ] **Setup PM2 ecosystem config sebelum production**
  Buat `ecosystem.config.js` di root project dengan `max_memory_restart: '512M'` dan `instances: 1`. Lihat contoh di Section 11. Ini safety net kalau ada memory leak yang tidak terduga — PM2 restart otomatis tanpa intervensi manual.

- [ ] **Admin: command `/syncapi`**
  Trigger manual sync dari bot — kirim semua track di SQLite yang punya `r2_url` tapi belum/gagal masuk REST API. Ini versi interaktif dari migration script, berguna saat REST API sempat down.

- [ ] **Admin: command `/status`**
  Dashboard ringkas untuk admin: uptime bot, jumlah track MP3/FLAC, R2 coverage percentage, status ping ke REST API, dan memory usage process (`process.memoryUsage().heapUsed`).

- [ ] **Callback handler audio (`handleSpotifyCallback`, `handleFlacCallback`) tidak ada rate limit — `request_count` bisa inflate**
  `bot.action` callback tidak lewat `createHandler()` sehingga tidak ada `isRateLimited()`. User yang tap tombol audio berulang kali (atau double-tap) akan mendapat kiriman audio yang sama berkali-kali ke chat, dan `incrementRequestCount()` dipanggil tiap tap sehingga statistik `/top` bisa tidak akurat. Tidak ada download ulang dari external URL (hanya forward `file_id`) sehingga ini bukan masalah performa berat, tapi tetap boros dan mengganggu. Fix: tambahkan `isRateLimited()` sederhana di awal `handleSpotifyCallback` dan `handleFlacCallback` dengan cooldown pendek (misalnya 3 detik) menggunakan key `callback_spot:{userId}:{trackId}`.

- [ ] **`buildTrackListMessage` di `admin.manage.js` — query ulang semua data tiap pagination**
  Setiap kali admin pindah halaman via callback `lt:N`, fungsi ini memanggil `listTracks(9999, 0)` dan `listFlacTracks(9999, 0)` — menarik semua rows ke JS array, menggabungkan, lalu sort di JS. Untuk koleksi ribuan lagu ini tidak akan crash (sort 10.000 items <10ms, ~2MB memory), tapi polanya tidak efisien karena seluruh dataset dimuat ulang hanya untuk menampilkan 10 baris. Fix yang benar: pindahkan sort ke query SQLite (`ORDER BY artist ASC, title ASC`), gunakan `COUNT(*)` terpisah untuk total, dan query hanya satu halaman dengan `LIMIT 10 OFFSET (page-1)*10`. Ini menghilangkan kebutuhan tarik semua data ke JS sama sekali.

- [ ] **`r2.js` `trackKey()` — edge case title/artist semua karakter spesial**
  Fungsi `safe()` di dalam `trackKey()` strip semua karakter non-alphanumeric. Jika `title` atau `artist` sepenuhnya terdiri dari karakter spesial (misalnya `"!!!"`, `"---"`), hasilnya string kosong dan key R2 menjadi `"music/ -  (trackId).mp3"` — path tidak valid dan bisa menyebabkan masalah di R2 atau URL yang tidak bisa di-fetch. Fix: tambahkan fallback `safe(str) || 'unknown'` untuk mencegah segment kosong.

- [ ] **Fix `ratelimit.js` — sesuaikan cutoff dengan interval cleanup**
  Ganti `COOLDOWN_MS * 2` menjadi `60_000` (sama dengan interval) agar entry yang sudah tidak berguna bersih tepat saat cleanup jalan, bukan tertinggal hingga 50 detik.

- [ ] **`handleSyncR2` — tambah summary invalid file_id**
  Bedakan antara error jaringan/R2 dengan error `file_id` expired/invalid (biasanya berupa HTTP 400 dari Telegram). Tambahkan counter `invalidFileId` terpisah dan tampilkan di summary akhir. Berguna untuk deteksi masalah sistemik kalau banyak file_id yang expired sekaligus.

- [ ] **Simple retry queue untuk REST API sync**
  Simpan payload yang gagal di-sync ke tabel SQLite kecil (`sync_queue`). Background job coba retry setiap N menit. Ini menghilangkan kebutuhan jalankan migration script secara manual saat REST API sempat down.

- [ ] **`searchTracks` / `searchFlacTracks` — pass 2 per-kata berpotensi tarik banyak row ke memory**
  Fungsi search dua pass: pass 1 query exact phrase (`LIKE '%keyword%'`), pass 2 query tiap kata secara terpisah dan hasilnya digabung. Pass 2 memang OR semantics — kata umum seperti `"the"`, `"my"`, `"of"` lolos filter `length > 1` dan bisa match ribuan row yang semua ditarik ke array JavaScript sebelum di-dedup. Untuk keyword 3 kata dengan DB 5000 track, bisa ada 6000–10000 row objects di memory sementara hanya untuk satu search request. Hasil yang diterima user tetap benar (pass 1 sudah narrow), tapi memory overhead-nya nyata dan makin besar seiring koleksi bertambah. Fix: tambahkan stopword filter minimal (`["the", "a", "an", "of", "in", "my", "is", "at", "it"]`) sebelum loop per-kata di pass 2, dan/atau tambahkan `LIMIT` pada query per-kata agar tidak pull semua row sekaligus.

- [ ] **Search ranking improvement**
  Saat ini urutan hasil hanya by `created_at DESC`. Tambahkan boost untuk: exact title match > partial title match > artist match. Bisa dilakukan di layer JS setelah query, tanpa ubah skema DB.

- [ ] **`syncR2Flac.js` — mode `--dry-run`**
  Tambahkan flag `--dry-run` untuk preview "ini yang akan diupload" tanpa benar-benar upload ke R2. Berguna untuk verifikasi matching ID3 tag sebelum commit operasi yang tidak bisa di-undo.

- [ ] **`syncR2Flac.js` — mode `--insert`**
  Script saat ini mengharuskan track sudah ada di SQLite (hanya matching). Tambahkan flag `--insert` untuk otomatis insert track baru ke SQLite dari ID3 tag file `.flac` yang ada di folder, tanpa perlu entry manual dulu.

- [x] ~~**Logging ke file**~~ ✅ *DONE*
  Log hanya ke stdout — tidak ada file writer. Fix: refactor `src/utils/logger.js` agar jika `LOG_FILE` di-set di env, log juga ditulis ke file dengan rotasi harian otomatis. Drop-in replacement — tidak ada perubahan di semua caller.

- [ ] **Environment variable validation lebih informatif**
  Saat ini startup hanya print nama key yang missing. Tambahkan contoh value dan link ke dokumentasi untuk setiap key yang hilang, agar onboarding lebih mudah.

---

### ✨ Nice to Have (Ideas)

- [ ] **Admin: command `/auditdupes` — deteksi track duplikat dengan penamaan berbeda**
  Terkadang lagu yang sama masuk dua kali dengan penamaan sedikit berbeda (misal `"Song A"` vs `"Song A - Single Version"`). Buat command admin `/auditdupes` yang mencari kandidat duplikat berdasarkan kombinasi: `file_size` identik, atau string similarity `title+artist` di atas threshold tertentu (Levenshtein distance di layer JS). Output berupa daftar pasangan kandidat duplikat beserta `track_id`-nya agar admin bisa review dan hapus manual via `/deltrack`.

- [ ] **Auto-backup SQLite ke grup admin — disaster recovery via Telegram**
  File `data/spotify/data.db` dan `data/flac/data.db` adalah single point of failure — jika VPS wipe atau hardware failure, semua `file_id` Telegram dan metadata hilang dan tidak bisa direcovery. Buat command `/backupdb` (atau cron job mingguan) yang mengirimkan kedua file `.db` langsung ke grup admin sebagai Document. Telegram bertindak sebagai cloud backup gratis. File SQLite untuk ribuan track biasanya <10MB sehingga masih dalam batas upload Telegram Bot API (50MB).

- [ ] **Command `/stats` publik di thread Spotify & FLAC**
  Tampilkan statistik koleksi yang bisa dilihat semua member: total lagu, total artist, lagu paling sering diminta, last added. Berbeda dari `/dbstats` admin yang lebih teknis.

- [ ] **Inline query support (`@botname keyword`)**
  Izinkan user search langsung dari kolom chat mana saja via inline query tanpa harus masuk ke thread yang benar. Hasil ditampilkan sebagai daftar audio yang bisa diklik. Cocok untuk akses cepat dari DM atau grup lain.

- [ ] **Notifikasi admin saat koleksi bertambah (daily digest)**
  Kirim ringkasan harian ke grup admin: berapa track baru ditambahkan, track apa yang paling banyak diminta hari ini, dan apakah ada sync yang gagal.

- [ ] **Blacklist track**
  Command admin `/blacktrack <track_id>` untuk menandai track yang tidak boleh muncul di hasil pencarian (misal: salah metadata, file corrupt) tanpa harus dihapus dari DB.

- [ ] **Admin: edit metadata track via bot**
  Command `/editmeta <track_id>` untuk mengubah title/artist/album/year langsung dari grup admin tanpa harus akses SQLite manual. Berguna untuk memperbaiki hasil enrichment yang salah.

- [ ] **Fuzzy search / typo tolerance**
  Pencarian saat ini exact LIKE match. Tambahkan toleransi typo ringan untuk keyword yang salah ketik (misal "radiohed" → "Radiohead") menggunakan Levenshtein distance di layer JS.

- [ ] **Support format audio lain di admin upload**
  Saat ini hanya MP3 dan FLAC. Pertimbangkan OPUS/OGG untuk konten podcast atau audio yang memang di-encode di format tersebut, dengan konversi otomatis ke MP3 sebelum disimpan.

- [ ] **Web mini-player preview**
  Manfaatkan `r2_url` yang sudah ada untuk embed preview player di halaman web sederhana. Link bisa dikirim bot sebagai tombol inline di samping tombol download FLAC.