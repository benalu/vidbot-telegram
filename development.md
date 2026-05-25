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
- **`trackKey()` di `admin.upload.js` sekarang menyertakan `type`** — FLAC manual upload menghasilkan key R2 yang benar (`flac/` dir, `.flac` ext) ✅ *DONE (sesi lalu)*
- **`trackKey()` di `spotify.handler.js` sekarang eksplisit `'mp3'`** — `handleUrl()` memanggil `trackKey(..., 'mp3')` secara eksplisit ✅ *DONE*
- **`notify()` di `admin.handler.js` menerima `telegram` instance** — fix parameter dari `bot` ke `telegram` mencegah semua notifikasi admin silent fail ✅ *DONE (sesi sebelumnya)*
- **`handleAddTrack` enrichment sekarang satu kali** — satu IIFE background, satu enrichment call, tanpa nested IIFE atau race condition ✅ *DONE (sesi sebelumnya)*
- **`INSERT OR REPLACE` di kedua repo** diganti `ON CONFLICT DO UPDATE SET` yang exclude `request_count` — statistik request tidak ter-reset saat track di-insert ulang ✅ *DONE*
- **Deduplication upload** via `file_hash` dan `title+artist` mencegah data ganda dari jalur berbeda
- **WAL mode SQLite** sudah aktif di kedua database
- **Graceful shutdown** sudah ada via `setupProcessHandlers()`
- **Rate limiting** per user per command sudah berjalan
- **Token refresh deduplification** di VidBotClient via `_refreshPromise` sudah benar
- **Search two-pass** (exact phrase + per kata) memberikan hasil yang lebih relevan
- **DM keyword-only by design** — URL Spotify sudah di-reject eksplisit di `handleDmSpot()` dan `handleDmFlac()` via `normalizeUrl()`, dan pesan `/start` sudah menyebutkan batasan ini ✅ *DONE*
- **Admin group auto-detect Spotify URL** sudah berjalan via `bot.on('text')` di `registerAdminHandlers()`
- **Dead code `handleSpotify` di `social.handler.js`** sudah dihapus beserta import `formatSpotify` ✅ *DONE*
- **`routeDmCommand` fallback** — command tidak dikenal di DM sekarang reply dengan pesan yang jelas dan daftar command yang tersedia ✅ *DONE*
- **Cache key prefix DM** sudah diperbaiki dari `dm_spot:` menjadi `cache_spot:` untuk menghindari naming collision ✅ *DONE*

---

### ⚠️ Temuan & Potensi Masalah

**1. `admin.handler.js` — early return memblokir seluruh pipeline saat `trackId` null** *(BUG BARU, belum ada di todo)*
Di dalam outer IIFE `handleAddTrack`, setelah `replyWithAudio` berhasil, ada guard:
```js
if (!trackId || !sent?.audio?.file_id) return
```
Guard ini dieksekusi **sebelum** inner background IIFE yang berisi `saveTrack`, `uploadToR2`, dan `syncMp3ToApi`. Jika `trackId` null (track regional yang tidak punya Spotify ID), audio berhasil dikirim ke Telegram tapi **tidak tersimpan sama sekali** — tidak di SQLite, tidak di R2, tidak di REST API. Track hilang begitu saja. Ini berbeda dari temuan #11 di versi sebelumnya (yang sudah ditandai DONE tapi hanya menambahkan `uuidv4()` di inner IIFE yang tidak pernah dieksekusi karena early return ini).

**2. `admin.handler.js` — Tahap 3 masih menggunakan `trackId` bukan `finalTrackId`** *(BUG LATEN, terungkap setelah fix #1)*
Setelah bug #1 diperbaiki, bug ini akan muncul. Di Tahap 3 inner IIFE:
```js
const finalTrackId = trackId || uuidv4()
// ...
if (trackId && r2Url) {   // ← masalah: trackId bukan finalTrackId
  updateTrackR2(finalTrackId, r2Url)
  const fullTrack = getTrack(finalTrackId)
  await syncMp3ToApi({ ...fullTrack, r2_url: r2Url })
}
```
Jika `trackId` null, `finalTrackId` berisi UUID yang valid, tapi kondisi `if (trackId && r2Url)` tetap false — R2 upload dan REST API sync tidak pernah jalan untuk track yang pakai UUID fallback.

**3. `admin.manage.js` — `searchFlacTracks` dipakai tapi tidak diimport** *(BUG, todo salah tandai DONE)*
Todo item "Fix handleFindTrack tidak mencari koleksi FLAC" ditandai ✅ DONE, tapi kode aktual masih crash. Handler `handleFindTrack` memanggil `searchFlacTracks(keyword)` namun import di baris 5 hanya:
```js
const { listFlacTracks, getFlacTrack, deleteFlacTrack, getFlacStats } = require('../flac/flac.repo')
```
`searchFlacTracks` tidak ada di destructuring. Setiap `/findtrack` akan throw `ReferenceError: searchFlacTracks is not defined`. Handler MP3-nya sendiri sudah benar, hanya import FLAC yang ketinggalan.

**4. `admin.upload.js` — buffer di-download dua kali**
Buffer didownload pertama kali di dalam blok `if (fileSize <= TG_DOWNLOAD_LIMIT)` untuk parsing ID3 tag — tapi variable `buffer` ini block-scoped di dalam blok `if` tersebut sehingga tidak bisa diakses oleh IIFE background. IIFE kemudian memanggil `ctx.telegram.getFileLink()` dan `axios.get()` lagi untuk download ulang file yang sama sebelum upload ke R2. Setiap manual upload membuang satu download ekstra (~5–50MB tergantung ukuran file).

**5. `admin.handler.js` — `handleAddTrack` tidak cek duplikat via title+artist**
Guard duplikat hanya cek `if (trackId && getTrack(trackId))`. Bandingkan dengan `handleAudioUpload` yang juga memanggil `findTrackByTitleArtist()` sebagai lapisan kedua. Jika admin dua kali kirim URL Spotify yang sama, dan di request pertama `trackId` null sehingga track disimpan dengan UUID, request kedua akan lolos guard karena `trackId` yang sama tidak ada di DB (yang tersimpan pakai UUID berbeda).

**6. `flac.format.js` — import path salah, akan crash saat dipakai**
`require('./utils')` tidak ada di folder `src/features/flac/`. Yang benar adalah `../../formats/utils`. File ini belum diimport di mana pun sehingga tidak crash sekarang, tapi akan crash begitu diimport.

**7. `admin.upload.js` — inline `require()` di dalam IIFE background redundan**
Di dalam IIFE background, ada dua require yang sebenarnya tidak perlu:
```js
const { getFlacTrack } = require('../flac/flac.repo')
const { getTrack }     = require('../spotify/spotify.repo')
```
Keduanya sudah diimport di bagian atas file (`getFlacTrackByHash`, `findFlacTrackByTitleArtist` dari flac.repo; `saveTrack`, `updateTrackR2` dari spotify.repo — tapi `getFlacTrack` dan `getTrack` memang belum ada di top-level import). Node.js meng-cache module sehingga ini tidak menyebabkan bug atau double-load, tapi pola ini membingungkan dan sebaiknya dipindah ke top-level import.

**8. Tiga `searchCache` Map tanpa interval cleanup aktif**
`spotify.handler.js`, `flac.handler.js`, dan `dm.handler.js` masing-masing punya Map sendiri (max 300 entry tiap Map). Cleanup hanya terjadi saat ada cache hit expired — tidak ada `setInterval` aktif. Dengan tiga Map, potensi 900 entry stale di memory. Aman untuk sekarang, tapi perlu dimonitor kalau user tumbuh.

**9. `ratelimit.js` — cleanup cutoff lebih pendek dari interval**
Cleanup `setInterval` jalan tiap 60 detik, tapi cutoff hanya `COOLDOWN_MS * 2` (10 detik). Entry yang sudah tidak berguna sejak 10 detik lalu masih duduk di Map hingga 50 detik berikutnya. Dengan max 2000 entry ini tidak jadi masalah memory, tapi cutoff yang lebih masuk akal adalah `60_000` (sama dengan interval).

**10. `r2.js` `trackKey()` — edge case title/artist semua karakter spesial**
Fungsi `safe()` di dalam `trackKey()` strip semua karakter non-alphanumeric. Jika `title` atau `artist` sepenuhnya terdiri dari karakter spesial (misalnya `"!!!"`, `"---"`), hasilnya string kosong dan key R2 menjadi `"music/ -  (trackId).mp3"` — path tidak valid. Tidak ada fallback untuk empty string.

**11. `handleSyncR2` — tidak ada summary invalid file_id**
Saat `/syncr2` jalan dan ada `file_id` yang sudah expired (misalnya bot pernah diganti token), error per-track hanya di-log individual. Tidak ada hitungan berapa file_id yang tidak valid di summary akhir. Berguna untuk mendeteksi masalah sistemik.

**12. Resource usage di VPS (2 vCPU, 4 GB RAM, shared dengan bot Discord + REST API)**
Setiap request `/spot` URL bisa hold buffer 5–10 MB selama background IIFE belum selesai. Beberapa request concurrent bisa hold 30–50 MB buffer sekaligus. Aman di 4 GB tapi perlu PM2 memory limit sebagai safety net.

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
- [x] ~~**Fix `trackKey()` dipanggil tanpa `type` di `admin.upload.js`**~~ ✅ *DONE*
- [x] ~~**Fix `enrichMetadata` dipanggil dua kali + race condition di `admin.handler.js`**~~ ✅ *DONE*
- [x] ~~**Fix `notify()` parameter salah di `admin.handler.js`**~~ ✅ *DONE*
- [x] ~~**Fix silent fail di `routeDmCommand`** untuk command tidak dikenal di DM~~ ✅ *DONE*
- [x] ~~**Fix `handleDmFlac` tidak menolak URL** di `dm.handler.js`~~ ✅ *DONE*
- [x] ~~**Fix `INSERT OR REPLACE` me-reset `request_count`** di kedua repo~~ ✅ *DONE*
- [x] ~~**Fix `pendingUploads` null fileId** — tambah `else` branch dengan pesan error eksplisit~~ ✅ *DONE*
- [x] ~~**Fix cache key prefix** di `dm.handler.js` — `dm_spot:` → `cache_spot:`~~ ✅ *DONE*
- [x] ~~**Fix dead code `handleSpotify`** di `social.handler.js`~~ ✅ *DONE*
- [x] ~~**Fix `trackKey()` tanpa `type` eksplisit** di `spotify.handler.js`~~ ✅ *DONE (sudah ada `'mp3'` sebagai arg ke-4)*

- [x] ~~**Fix early return di `handleAddTrack` yang memblokir save saat `trackId` null** — `admin.handler.js`~~ ✅ *DONE*
  Guard `if (!trackId || !sent?.audio?.file_id)` dipecah: hanya `file_id` null yang stop pipeline. `trackId` null tetap lanjut ke inner IIFE dengan UUID fallback.

- [x] ~~**Fix kondisi Tahap 3 di inner IIFE `handleAddTrack` yang masih menggunakan `trackId`** — `admin.handler.js`~~ ✅ *DONE*
  Kondisi `if (trackId && r2Url)` diganti `if (r2Url)` — `finalTrackId` sudah pasti ada (UUID fallback), satu-satunya syarat untuk R2+sync adalah `r2Url` tidak null.

- [x] ~~**Fix `searchFlacTracks` tidak diimport di `admin.manage.js`**~~ ✅ *DONE*
  Tambahkan `searchFlacTracks` ke destructuring import dari `flac.repo`.

- [ ] **Fix import path di `flac.format.js`**
  `require('./utils')` tidak ada di `src/features/flac/`. File belum diimport di mana pun sehingga tidak crash sekarang, tapi akan crash begitu diimport.

  **Pola lama:** `require('./utils')`
  **Gantinya:** `require('../../formats/utils')`

---

### 🟡 Penting (Planned)

- [x] ~~**Refactor `trackKey()` di `r2.js`** — tambah parameter `type`~~ ✅ *DONE*
- [x] ~~**Refactor metadata `spotify.handler.js`** — single write, Spotify Web API + LastFM sebagai source of truth~~ ✅ *DONE*
- [x] ~~**Update `/start` DM** — perjelas batasan keyword-only~~ ✅ *DONE*
- [x] ~~**Hapus dead code `handleSpotify` di `social.handler.js`**~~ ✅ *DONE*

- [x] ~~**Fix `handleAddTrack` di `admin.handler.js` — tidak cek duplikat via title+artist**~~ ✅ *DONE*
  Tambahkan `findTrackByTitleArtist` ke import repo, lalu cek title+artist tepat setelah cek trackId dan setelah `safeTitle`/`safeArtist` dideklarasikan.

- [ ] **Hapus atau integrasikan `flac.format.js`**
  File ini ada tapi tidak pernah diimport. Kalau masih relevan, pakai di `flac.handler.js`. Kalau tidak, hapus agar tidak membingungkan. Sebelum mengintegrasikan, fix dulu import path-nya (lihat Critical di atas).

- [ ] **Refactor `admin.upload.js` — reuse buffer ID3 untuk upload R2**
  Buffer yang sudah di-download untuk parsing ID3 tag tidak bisa diakses IIFE background karena block-scoped di dalam `if (fileSize <= TG_DOWNLOAD_LIMIT)`. Pindahkan deklarasi `let buffer = null` ke luar blok `if`, set nilai di dalam, lalu pass ke IIFE dan skip `getFileLink()` + `axios.get()` kedua kalau buffer sudah tersedia. Ini memangkas satu download ekstra per upload admin.

  Sekaligus, pindahkan `getFlacTrack` dan `getTrack` dari inline `require()` di dalam IIFE ke top-level import di atas file.

---

### 🟢 Improvement (Backlog)

- [ ] **`handleSyncR2` di `admin.sync.js` — `BATCH` hanya mengontrol progress bar, bukan real concurrency**
  Variable `BATCH = 5` hanya dipakai sebagai trigger update progress bar (`if (i % BATCH === 0)`), sedangkan proses download dan upload tetap sequential satu per satu di dalam loop `for`. Improvement: proses bisa di-chunk dengan `Promise.allSettled()` per N track — tapi harus hati-hati dengan Telegram API rate limit. Jangan apply ke `handleSyncMeta` karena sudah ada intentional `delay(1000)` untuk rate limit Spotify/LastFM.

- [ ] **Setup PM2 ecosystem config sebelum production**
  Buat `ecosystem.config.js` di root project dengan `max_memory_restart: '512M'` dan `instances: 1`. Lihat contoh di Section 11. Safety net kalau ada memory leak — PM2 restart otomatis tanpa intervensi manual.

- [ ] **Admin: command `/syncapi`**
  Trigger manual sync dari bot — kirim semua track di SQLite yang punya `r2_url` tapi belum/gagal masuk REST API. Versi interaktif dari migration script, berguna saat REST API sempat down.

- [ ] **Admin: command `/status`**
  Dashboard ringkas untuk admin: uptime bot, jumlah track MP3/FLAC, R2 coverage percentage, status ping ke REST API, dan memory usage process (`process.memoryUsage().heapUsed`).

- [ ] **Callback handler audio tidak ada rate limit — `request_count` bisa inflate**
  `bot.action` callback tidak lewat `createHandler()` sehingga tidak ada `isRateLimited()`. User yang tap tombol audio berulang kali akan mendapat kiriman audio yang sama berkali-kali, dan `incrementRequestCount()` dipanggil tiap tap sehingga statistik `/top` bisa tidak akurat. Fix: tambahkan `isRateLimited()` di awal `handleSpotifyCallback` dan `handleFlacCallback` dengan cooldown pendek (misalnya 3 detik) menggunakan key `callback_spot:{userId}:{trackId}`.

- [ ] **`buildTrackListMessage` di `admin.manage.js` — query ulang semua data tiap pagination**
  Setiap kali admin pindah halaman via callback `lt:N`, fungsi ini menarik semua rows dari kedua DB ke JS array lalu sort dan slice. Untuk koleksi ribuan lagu ini tidak akan crash, tapi polanya tidak efisien. Fix yang benar: sort di SQLite (`ORDER BY artist ASC, title ASC`), `COUNT(*)` untuk total, dan query hanya satu halaman dengan `LIMIT 10 OFFSET`.

- [ ] **`r2.js` `trackKey()` — edge case title/artist semua karakter spesial**
  Fungsi `safe()` strip semua karakter non-alphanumeric. Jika `title` atau `artist` sepenuhnya karakter spesial (misalnya `"!!!"`, `"---"`), hasilnya empty string dan key R2 menjadi path tidak valid. Fix: tambahkan fallback `safe(str) || 'unknown'`.

- [ ] **Fix `ratelimit.js` — sesuaikan cutoff dengan interval cleanup**
  Ganti `COOLDOWN_MS * 2` menjadi `60_000` (sama dengan interval) agar entry bersih tepat saat cleanup jalan, bukan tertinggal hingga 50 detik.

- [ ] **`handleSyncR2` — tambah summary invalid file_id**
  Bedakan antara error jaringan/R2 dengan error `file_id` expired/invalid (biasanya HTTP 400 dari Telegram). Tambahkan counter `invalidFileId` terpisah dan tampilkan di summary akhir.

- [ ] **Simple retry queue untuk REST API sync**
  Simpan payload yang gagal di-sync ke tabel SQLite kecil (`sync_queue`). Background job coba retry setiap N menit. Menghilangkan kebutuhan jalankan migration script manual saat REST API sempat down.

- [ ] **`searchTracks` / `searchFlacTracks` — pass 2 per-kata berpotensi tarik banyak row**
  Kata umum seperti `"the"`, `"my"`, `"of"` lolos filter `length > 1` dan bisa match ribuan row di pass 2. Fix: tambahkan stopword filter minimal sebelum loop per-kata, dan/atau tambahkan `LIMIT` pada query per-kata.

- [ ] **Search ranking improvement**
  Urutan hasil saat ini hanya by `created_at DESC`. Tambahkan boost: exact title match > partial title match > artist match. Bisa dilakukan di layer JS setelah query tanpa ubah skema DB.

- [ ] **`syncR2Flac.js` — mode `--dry-run`**
  Tambahkan flag `--dry-run` untuk preview "ini yang akan diupload" tanpa benar-benar upload ke R2. Berguna untuk verifikasi matching ID3 tag sebelum commit.

- [ ] **`syncR2Flac.js` — mode `--insert`**
  Script saat ini mengharuskan track sudah ada di SQLite. Tambahkan flag `--insert` untuk otomatis insert track baru ke SQLite dari ID3 tag file `.flac` yang ada di folder.

- [x] ~~**Logging ke file**~~ ✅ *DONE*

- [ ] **Environment variable validation lebih informatif**
  Saat ini startup hanya print nama key yang missing. Tambahkan contoh value dan link ke dokumentasi untuk setiap key yang hilang.

---

### ✨ Nice to Have (Ideas)

- [ ] **Admin: command `/auditdupes` — deteksi track duplikat dengan penamaan berbeda**
  Buat command admin yang mencari kandidat duplikat berdasarkan `file_size` identik atau string similarity `title+artist` di atas threshold (Levenshtein distance di layer JS). Output berupa daftar pasangan kandidat duplikat beserta `track_id`-nya.

- [ ] **Auto-backup SQLite ke grup admin — disaster recovery via Telegram**
  Buat command `/backupdb` (atau cron job mingguan) yang mengirimkan kedua file `.db` ke grup admin sebagai Document. File SQLite untuk ribuan track biasanya <10MB, masih dalam batas upload Telegram Bot API (50MB).

- [ ] **Command `/stats` publik di thread Spotify & FLAC**
  Tampilkan statistik koleksi: total lagu, total artist, lagu paling sering diminta, last added. Berbeda dari `/dbstats` admin yang lebih teknis.

- [ ] **Inline query support (`@botname keyword`)**
  Izinkan user search langsung dari kolom chat mana saja via inline query tanpa harus masuk ke thread yang benar.

- [ ] **Notifikasi admin saat koleksi bertambah (daily digest)**
  Kirim ringkasan harian ke grup admin: berapa track baru ditambahkan, track apa yang paling banyak diminta hari ini, apakah ada sync yang gagal.

- [ ] **Blacklist track**
  Command admin `/blacktrack <track_id>` untuk menandai track yang tidak boleh muncul di hasil pencarian tanpa harus dihapus dari DB.

- [ ] **Admin: edit metadata track via bot**
  Command `/editmeta <track_id>` untuk mengubah title/artist/album/year langsung dari grup admin tanpa akses SQLite manual.

- [ ] **Fuzzy search / typo tolerance**
  Tambahkan toleransi typo ringan untuk keyword yang salah ketik menggunakan Levenshtein distance di layer JS.

- [ ] **Support format audio lain di admin upload**
  Pertimbangkan OPUS/OGG dengan konversi otomatis ke MP3 sebelum disimpan.

- [ ] **Web mini-player preview**
  Manfaatkan `r2_url` yang sudah ada untuk embed preview player di halaman web sederhana. Link bisa dikirim bot sebagai tombol inline di samping tombol download FLAC.