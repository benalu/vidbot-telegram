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

### 3c. Sync REST API (Fire & Forget)

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
- Audio: `music/{Artist} - {Title} ({track_id}).mp3` atau `.flac`
- Cover: `covers/{track_id}.jpg`
- FLAC: `flac/{Artist} - {Title} ({track_id}).flac`

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
- **Metadata dari Spotify Web API + LastFM** — response REST API internal hanya diambil URL download-nya. Semua metadata (album, year, thumbnail, genre) diambil dari Spotify Web API dan LastFM sebagai single source of truth. Single write ke SQLite, data langsung lengkap ✅ *DONE (direfactor sesi ini)*
- **Deduplication upload** via `file_hash` dan `title+artist` mencegah data ganda dari jalur berbeda
- **WAL mode SQLite** sudah aktif di kedua database
- **Graceful shutdown** sudah ada via `setupProcessHandlers()`
- **Rate limiting** per user per command sudah berjalan
- **Token refresh deduplification** di VidBotClient via `_refreshPromise` sudah benar
- **Search two-pass** (exact phrase + per kata) memberikan hasil yang lebih relevan
- **DM keyword-only by design** — URL Spotify sudah di-reject eksplisit di `handleDmSpot()` via `normalizeUrl()`, dan pesan `/start` sudah menyebutkan batasan ini secara eksplisit ✅ *DONE (diupdate sesi ini)*
- **Admin group auto-detect Spotify URL** sudah berjalan via `bot.on('text')` di `registerAdminHandlers()`
- **Bug #1–#4** dari review pertama sudah diperbaiki (import formatSpotify, cache key FLAC, middleware next(), pendingUploads finally)

### ⚠️ Temuan & Potensi Masalah (Review Round 3)

**1. `flac.format.js` — import path salah, akan crash saat dipakai**
`require('./utils')` tidak ada di folder `src/features/flac/`. Yang benar adalah `../../formats/utils`. File ini belum diimport di mana pun sehingga tidak crash sekarang, tapi akan crash begitu diimport.

**2. `admin.handler.js` — `enrichMetadata` dipanggil dua kali untuk track yang sama**
Di `handleAddTrack()`, enrichment dipanggil sekali di dalam IIFE luar lalu dipanggil lagi di nested IIFE background untuk `updateTrackMeta`. Ini hit Spotify API dua kali untuk data yang sama dan membuang rate limit kuota.

**3. `admin.upload.js` — download buffer dari Telegram dua kali**
Buffer untuk baca ID3 tag (download pertama via `axios.get`) dibuang setelah blok `try` selesai. IIFE background kemudian download ulang file yang sama dari Telegram untuk upload ke R2. Double bandwidth dan double latency untuk setiap upload admin.

**4. `social.handler.js` — `handleSpotify` dead code tapi masih di-export**
`commands.js` sudah pakai `handleSpotify` dari `spotify.handler.js`. Export `handleSpotify` dari `social.handler.js` tidak dipakai di mana pun — dua fungsi dengan nama sama di dua file berbeda, rawan bingung saat debugging.

**5. Tiga `searchCache` Map tanpa interval cleanup aktif**
`spotify.handler.js`, `flac.handler.js`, dan `dm.handler.js` masing-masing punya Map sendiri (max 300 entry tiap Map). Cleanup hanya terjadi saat ada cache hit expired — tidak ada `setInterval` aktif. Dengan tiga Map, potensi 900 entry stale di memory. Aman untuk sekarang, tapi perlu dimonitor kalau user tumbuh.

**6. `dm.handler.js` — cache key prefix `dm_spot:` bentrok naming dengan callback data**
Cache key untuk search result menggunakan format `dm_spot:{userId}:{keyword}`, sedangkan callback data untuk pilih track juga `dm_spot:{trackId}`. Tidak crash sekarang karena `cacheGet()` hanya dipanggil di `handleDmSpotPage()` — tapi naming rawan collision kalau ada refactor.

---

## 12. To-Do List

> **Catatan desain yang tidak boleh diubah:**
> - Spotify memiliki thread tersendiri di grup publik, terpisah dari thread Social (TikTok/IG/Twitter/Threads)
> - DM (private chat) hanya mendukung pencarian via **keyword** — URL tidak didukung di DM, sengaja by design
> - Semua operasi berat (enrichment, R2 upload, REST API sync) harus di background — user hanya menunggu sampai audio terkirim, tidak lebih
> - File FLAC >20MB tidak bisa di-upload ke R2 oleh bot secara otomatis — harus via `scripts/syncR2Flac.js` manual. File MP3 umumnya <20MB sehingga auto-upload R2 oleh bot adalah perilaku yang benar
> - `/syncr2` adalah one-time utility untuk backfill `r2_url` kosong di SQLite, bukan untuk sync ke REST API. Setelah `/syncr2`, jalankan migration script untuk sync ke REST API
> - Metadata (album, year, thumbnail, genre) diambil dari Spotify Web API + LastFM, bukan dari response REST API internal. REST API internal hanya dipakai untuk URL download

---

### 🔴 Critical (Bug — Perbaiki Segera)

- [x] ~~**Fix import `formatSpotify` yang salah** di `social.handler.js`~~ ✅ *DONE*
- [x] ~~**Fix cache key mismatch** di `flac.handler.js`~~ ✅ *DONE*
- [x] ~~**Fix middleware `bot.use`** di `index.js`~~ ✅ *DONE*
- [x] ~~**Fix `pendingUploads` leak** di `spotify.handler.js`~~ ✅ *DONE*
- [x] ~~**Fix pesan NOT FOUND yang menyesatkan** di `spotify.handler.js`~~ ✅ *DONE (sesi ini)*
- [x] ~~**Fix `/dbstats` tidak include koleksi FLAC** di `admin.manage.js`~~ ✅ *DONE (sesi ini)*

- [ ] **Fix import path di `flac.format.js`**
  `require('./utils')` tidak ada di folder `src/features/flac/`. Ganti ke `../../formats/utils`. File ini belum dipakai jadi tidak crash sekarang, tapi akan crash begitu diimport.

---

### 🟡 Penting (Planned)

- [x] ~~**Refactor `trackKey()` di `r2.js`** — tambah parameter `type`~~ ✅ *DONE (sesi ini)*
  Fungsi sekarang menerima `type` (`'mp3'` | `'flac'`), menghasilkan direktori dan ekstensi yang tepat. Custom key manual di `admin.sync.js` dan `syncR2Flac.js` sudah dihapus.

- [x] ~~**Refactor metadata `spotify.handler.js`** — single write, Spotify Web API + LastFM sebagai source of truth~~ ✅ *DONE (sesi ini)*
  Sekarang enrich dulu di background, baru `saveTrack()` sekali dengan data lengkap. Import `updateTrackMeta` di handler ini sudah tidak dipakai dan bisa dihapus.

- [x] ~~**Update `/start` DM** — perjelas batasan keyword-only~~ ✅ *DONE (sesi ini)*

- [ ] **Hapus enrichment redundan di `admin.handler.js`**
  `handleAddTrack()` masih memanggil `enrichMetadata()` dua kali. Cukup satu kali di background IIFE setelah `saveTrack()`, lalu langsung `updateTrackMeta()` + R2 + sync dalam satu alur.

- [ ] **Hapus dead code `handleSpotify` di `social.handler.js`**
  Fungsi ini tidak dipakai di mana pun. Hapus dari export dan hapus import `formatSpotify` yang mengikutinya.

- [ ] **Hapus atau integrasikan `flac.format.js`**
  File ini ada tapi tidak pernah diimport. Kalau masih relevan, pakai di `flac.handler.js`. Kalau tidak, hapus agar tidak membingungkan.

- [ ] **Rename cache key prefix di `dm.handler.js`**
  Ganti prefix cache search menjadi `cache_spot:` dan `cache_flac:` agar tidak bentrok naming dengan callback data `dm_spot:` dan `dm_flac:`.

---

### 🟢 Improvement (Backlog)

- [ ] **Refactor `admin.upload.js` — reuse buffer ID3 untuk upload R2**
  Buffer yang sudah di-download untuk parsing ID3 tag seharusnya di-pass ke IIFE background untuk upload R2, bukan download ulang dari Telegram. Simpan `buffer` di variable luar blok `try` ID3, lalu gunakan kembali di IIFE. Ini memangkas bandwidth dan latency jadi setengahnya untuk setiap upload admin.

- [ ] **Admin: command `/syncapi`**
  Trigger manual sync dari bot — kirim semua track di SQLite yang punya `r2_url` tapi belum/gagal masuk REST API. Ini versi interaktif dari migration script, berguna saat REST API sempat down.

- [ ] **Admin: command `/status`**
  Dashboard ringkas untuk admin: uptime bot, jumlah track MP3/FLAC, R2 coverage percentage, status ping ke REST API, dan memory usage process.

- [ ] **Simple retry queue untuk REST API sync**
  Simpan payload yang gagal di-sync ke tabel SQLite kecil (`sync_queue`). Background job coba retry setiap N menit. Ini menghilangkan kebutuhan jalankan migration script secara manual saat REST API sempat down.

- [ ] **Search ranking improvement**
  Saat ini urutan hasil hanya by `created_at DESC`. Tambahkan boost untuk: exact title match > partial title match > artist match. Bisa dilakukan di layer JS setelah query, tanpa ubah skema DB.

- [ ] **`syncR2Flac.js` — mode `--insert`**
  Script saat ini mengharuskan track sudah ada di SQLite (hanya matching). Tambahkan flag `--insert` untuk otomatis insert track baru ke SQLite dari ID3 tag file `.flac` yang ada di folder, tanpa perlu entry manual dulu.

- [ ] **Logging ke file**
  Saat ini log hanya ke stdout (cocok untuk Docker/PM2 dengan log aggregator). Untuk self-hosted tanpa aggregator, tambahkan opsi `LOG_FILE=./logs/bot.log` di env dengan rotasi harian sederhana.

- [ ] **Environment variable validation lebih informatif**
  Saat ini startup hanya print nama key yang missing. Tambahkan contoh value dan link ke dokumentasi untuk setiap key yang hilang, agar onboarding lebih mudah.

---

### ✨ Nice to Have (Ideas)

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