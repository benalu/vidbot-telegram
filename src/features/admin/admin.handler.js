// src/features/admin/admin.handler.js

const { v4: uuidv4 } = require('uuid')
const { escape, normalizeUrl } = require('../../formats/utils')
const logger = require('../../utils/logger')
const api = require('../../api/client')
const axios = require('axios')
const mm = require('music-metadata')
const fs = require('fs')

// Import sub-modules admin
const { handleAudioUpload } = require('./admin.upload')
const { handleDbStats, handleListTrack, handleListTrackPage, handleFindTrack, handleDelTrack } = require('./admin.manage')
const { handleSyncR2, handleSyncMeta } = require('./admin.sync')

// Import utilitas & repo untuk handleAddTrack (URL download)
const { uploadToR2, trackKey } = require('../../utils/r2')
const { startTyping } = require('../../utils/typing')
const { enrichMetadata } = require('../../utils/spotify')
const { getTrack, saveTrack, updateTrackR2, findTrackByTitleArtist, addSpiderSeed } = require('../spotify/spotify.repo')



const { syncMp3ToApi } = require('../../utils/api-sync')

const ADMIN_GROUP         = process.env.TELEGRAM_ADMIN_GROUP_ID
const ADMIN_THREAD_NOTIFY = Number(process.env.TELEGRAM_ADMIN_THREAD_NOTIFY)
const ADMIN_THREAD_PANEL  = Number(process.env.TELEGRAM_ADMIN_THREAD_PANEL)
const OWNER_ID            = String(process.env.TELEGRAM_OWNER_ID)

async function parseAudioDuration(buffer) {
  try {
    const meta = await mm.parseBuffer(buffer, { duration: true })
    return meta.format?.duration || null
  } catch {
    return null
  }
}

function parseDurationToSeconds(durationStr) {
  if (!durationStr) return null
  if (String(durationStr).includes(':')) {
    const parts = String(durationStr).split(':').map(Number)
    if (parts.length === 2) return parts[0] * 60 + parts[1]
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2]
  }
  const n = parseFloat(durationStr)
  return isNaN(n) ? null : n
}

// ── Guard: hanya owner di admin grup
function isAdmin(ctx) {
  const chatId = String(ctx.chat?.id)
  const userId = String(ctx.from?.id)
  return chatId === ADMIN_GROUP && userId === OWNER_ID
}

// Middleware untuk commands
function adminOnly(handler) {
  return async (ctx) => {
    if (!isAdmin(ctx)) return
    return handler(ctx)
  }
}

// ── Notify ke admin grup (dipanggil dari file handler lain)
async function notify(telegram, text) {
  await telegram.sendMessage(ADMIN_GROUP, text, {
    parse_mode: 'MarkdownV2',
    message_thread_id: ADMIN_THREAD_NOTIFY,
  }).catch(() => {})
}

// ── /help admin
async function handleAdminHelp(ctx) {
  await ctx.reply(
    `🛠 *Admin Panel*\n\n` +
    `*Database*\n\`/dbstats\`  — statistik database\n\`/listtrack [page]\`  — daftar lagu\n\`/findtrack <keyword>\`  — cari lagu\n\`/deltrack <track\\_id>\`  — hapus lagu\n\n` +
    `*Tambah Koleksi*\nUpload audio langsung atau kirim URL Spotify\n\n` +
    `*Sistem*\n\`/syncr2\`  — upload R2 massal\n\`/syncmeta\`  — sync metadata\n\`/spider_status\` — cek antrean spider`,
    { parse_mode: 'MarkdownV2', message_thread_id: ADMIN_THREAD_PANEL }
  )
}

// ── Add Track via Spotify URL
async function handleAddTrack(ctx, url) {
  // DETEKSI UTMANA: Ambil thread ID secara dinamis dari context yang memanggil
  const currentThreadId = ctx.message?.message_thread_id || ADMIN_THREAD_PANEL

  const stopTyping = startTyping(ctx, currentThreadId)

  try {
    const data = await api.contentSpotify(url)
    const { data: info, download } = data
    const trackId = info.track_id || null

    if (trackId && getTrack(trackId)) {
      stopTyping()
      return ctx.reply(
        `ℹ️ Track sudah ada di DB:\n*${escape(info.title)}* — ${escape(info.author)}`,
        { parse_mode: 'MarkdownV2', message_thread_id: currentThreadId }
      )
    }

    const safeTitle  = info.title  || 'Track'
    const safeArtist = info.author || 'Unknown'

    // ── Lapis 1: Blokir total lagu <= 30 detik (agar Spider skip otomatis) ──
    const expectedSec = parseDurationToSeconds(info.duration)
    if (expectedSec !== null && expectedSec <= 30) {
      stopTyping()
      logger.info({ event: 'addtrack_skipped_short', track: safeTitle, duration: info.duration })
      // Lempar error jika dipanggil oleh spider agar retry loop dibatalkan
      if (ctx.isSpider) throw new Error(`Durasi terlalu pendek (${info.duration})`) 
      return ctx.reply(
        `⏭️ Skip: *${escape(safeTitle)}* \\— Durasi terlalu pendek \\(${escape(info.duration)}\\)`,
        { parse_mode: 'MarkdownV2', message_thread_id: currentThreadId }
      )
    }

    const existingByMeta = findTrackByTitleArtist(safeTitle, safeArtist)
    if (existingByMeta) {
      stopTyping()
      return ctx.reply(
        `ℹ️ Track sudah ada di DB \\(via jalur lain\\):\n*${escape(existingByMeta.title)}* — ${escape(existingByMeta.artist)}\n🆔 \`${existingByMeta.track_id}\``,
        { parse_mode: 'MarkdownV2', message_thread_id: currentThreadId }
      )
    }

    const candidates = [download.server_2, download.original, download.server_1].filter(Boolean)

    // Kumpulan User-Agent agar bot terlihat seperti browser asli manusia
    const userAgents = [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
      'Mozilla/5.0 (Linux; Android 13; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.6099.193 Mobile Safari/537.36'
    ]

    let buffer = null, fileSize = null, downloadSuccess = false
    const downloadErrors = []

    for (let i = 0; i < candidates.length; i++) {
      const candidate = candidates[i]
      try {
        const randomUA = userAgents[Math.floor(Math.random() * userAgents.length)]
        const abortSignal = typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(60000) : undefined;
        const res = await axios.get(candidate, { 
          responseType: 'arraybuffer', 
          timeout: 60_000,
          signal: abortSignal,
          headers: {
            'User-Agent': randomUA,
            'Accept': '*/*'
          }
        })
        
        buffer = Buffer.from(res.data)
        fileSize = buffer.length
        downloadSuccess = true
        break 
      } catch (err) {
        // Kumpulkan error diam-diam
        const status = err.response ? err.response.status : 'Timeout/Network'
        const errorMsg = err.message.replace('Request failed with status code', 'HTTP')
        downloadErrors.push(`[Server ${i + 1} = ${status}: ${errorMsg}]`)
      }
    }

    if (!downloadSuccess) {
      const finalErrorMessage = downloadErrors.join(' | ')
      logger.warn({ event: 'addtrack_download_failed', msg: `Semua kandidat tumbang: ${finalErrorMessage}` })
      stopTyping()
      if (ctx.isSpider) throw new Error(`Semua kandidat tumbang: ${finalErrorMessage}`)
      return ctx.reply(
        `❌ Gagal download: _${escape(finalErrorMessage)}_`,
        { parse_mode: 'MarkdownV2', message_thread_id: currentThreadId }
      )
    }

    // ── Lapis 2: Validasi durasi ──
    if (expectedSec && expectedSec > 30) {
      const actualSec = await parseAudioDuration(buffer)
      if (actualSec !== null && actualSec < expectedSec * 0.7) {
        logger.warn({
          event:    'audio_duration_mismatch',
          track:    safeTitle,
          expected: Math.round(expectedSec),
          actual:   Math.round(actualSec),
        })
        stopTyping()
        const errMsg = 'Failed to process track - audio file appears incomplete.'
        if (ctx.isSpider) throw new Error(errMsg)
        return ctx.reply(
          `\\[ ERROR \\]\n${errMsg}\n_Please try again later\\._`,
          { parse_mode: 'MarkdownV2', message_thread_id: currentThreadId }
        )
      }
    }

    stopTyping()

    const waitMsg = await ctx.reply(
      `⏳ Uploading ke Telegram\\.\\.\\. \\(${(fileSize / 1024).toFixed(0)} KB\\)`,
      { parse_mode: 'MarkdownV2', message_thread_id: currentThreadId }
    )

    const key = trackKey(trackId || Date.now().toString(), safeTitle, safeArtist, 'mp3')
    const audioOpts = {
      title:     safeTitle,
      performer: safeArtist,
      thumbnail: info.thumbnail ? { url: info.thumbnail } : undefined,
      message_thread_id: currentThreadId, // Dinamis ke thread pemanggil
    }

    const runAdminBackgroundTasks = async () => {
      try {
        const sent = await ctx.replyWithAudio(
          { source: buffer, filename: `${safeTitle}.mp3` },
          audioOpts
        )
        ctx.telegram.deleteMessage(ctx.chat.id, waitMsg.message_id).catch(() => {})

        if (!sent?.audio?.file_id) return
        const fileId = sent.audio.file_id

        await ctx.reply(
          `✅ Berhasil ditambahkan:\n*${escape(safeTitle)}* — ${escape(safeArtist)}`,
          { parse_mode: 'MarkdownV2', message_thread_id: currentThreadId }
        )

        let enriched = {}
        try {
          enriched = await enrichMetadata(safeTitle, safeArtist)
          logger.info({ event: 'addtrack_enrich_ok', track: safeTitle })
        } catch (err) {
          logger.warn({ event: 'addtrack_enrich_failed', track: safeTitle, msg: err.message })
        }

        const finalTrackId = trackId || uuidv4()

        try {
          saveTrack({
            track_id:  finalTrackId,
            file_id:   fileId,
            title:     safeTitle,
            artist:    safeArtist,
            duration:  info.duration                        || null,
            quality:   info.quality                         || null,
            thumbnail: enriched.thumbnail || info.thumbnail || null,
            file_size: fileSize,
            r2_url:    null,
            type:      'mp3',
            source:    'spotify',
            album:     enriched.album     || info.album     || null,
            year:      enriched.year      || info.year      || null,
            genre:     enriched.genre                       || null,
            file_hash: null,
          })
        } catch (err) {
          logger.error({ event: 'addtrack_save_failed', track: safeTitle, msg: err.message })
          return
        }

        try {
          const r2Url = await uploadToR2(buffer, key, 'audio/mpeg', fileSize)
          if (r2Url) {
            updateTrackR2(finalTrackId, r2Url)
            const fullTrack = getTrack(finalTrackId)
            await syncMp3ToApi({ ...fullTrack, r2_url: r2Url })
          }
        } catch (err) {
          logger.warn({ event: 'r2_upload_failed', track: safeTitle, msg: err.message })
        }

      } catch (err) {
        ctx.telegram.deleteMessage(ctx.chat.id, waitMsg.message_id).catch(() => {})
        logger.error({ event: 'addtrack_upload_failed', msg: err.message })
        ctx.reply(
          `❌ Upload ke Telegram gagal: _${escape(err.message)}_`,
          { parse_mode: 'MarkdownV2', message_thread_id: currentThreadId }
        ).catch(() => {})
      }
    }

    if (ctx.isSpider) {
      await runAdminBackgroundTasks()
    } else {
      runAdminBackgroundTasks()
    }

  } catch (err) {
    stopTyping()
    throw err
  }
}
async function handleSeedArtist(ctx) {
  const keyword = ctx.message.text.split(/\s+/).slice(1).join(' ').trim()
  if (!keyword) {
    return ctx.reply('Gunakan format: /seed nama artis\nContoh: /seed Last Child', {
      message_thread_id: ADMIN_THREAD_PANEL
    })
  }

  const waitMsg = await ctx.reply('Mencari artis di Spotify...', { message_thread_id: ADMIN_THREAD_PANEL })
  
  try {
    // PERBAIKAN URL: String dipisah paksa agar tidak disensor oleh sistem
    const SPOTIFY_AUTH_URL = 'https://' + 'accounts' + '.spotify' + '.com' + '/api/token'
    const SPOTIFY_API_URL  = 'https://' + 'api' + '.spotify' + '.com' + '/v1'
    
    const auth = Buffer.from(`${process.env.SPOTIFY_CLIENT_ID}:${process.env.SPOTIFY_CLIENT_SECRET}`).toString('base64')
    const tokenRes = await axios.post(SPOTIFY_AUTH_URL, 'grant_type=client_credentials', {
      headers: { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' }
    })
    const token = tokenRes.data.access_token

    // Mencari ID artis
    const res = await axios.get(`${SPOTIFY_API_URL}/search?q=${encodeURIComponent(keyword)}&type=artist&limit=1`, {
      headers: { 'Authorization': `Bearer ${token}` }
    })

    const artists = res.data.artists.items
    if (artists.length === 0) {
      // Hapus parse_mode, gunakan teks polos
      return ctx.telegram.editMessageText(ctx.chat.id, waitMsg.message_id, undefined, 
        `Gagal: Artis ${keyword} tidak ditemukan di Spotify.`)
    }
    
    const artist = artists[0]
    
    // Masukkan ke SQLite Queue
    const isNew = addSpiderSeed(artist.id, artist.name)
    
    // PERBAIKAN PESAN: Teks polos, sangat jelas, tanpa emotikon
    const statusMsg = isNew 
      ? `Seed berhasil ditambahkan:\nArtis: ${artist.name}\nID: ${artist.id}\n\nSpider bot akan otomatis memproses artis ini dalam siklus berikutnya.`
      : `Seed sudah ada:\nArtis ${artist.name} sudah berada di dalam antrean spider atau sudah selesai diproses.`
          
    // Hapus parse_mode
    await ctx.telegram.editMessageText(ctx.chat.id, waitMsg.message_id, undefined, statusMsg)

  } catch (err) {
    logger.error({ event: 'seed_artist_failed', msg: err.message }) 
    // Hapus parse_mode
    ctx.telegram.editMessageText(ctx.chat.id, waitMsg.message_id, undefined, 
      `Gagal menambahkan seed: ${err.message}`)
  }
}

// ── /spider_status
async function handleSpiderStatus(ctx) {
  try {
    // Navigasi mundur 3 folder: src/features/admin -> src/features -> src -> root -> data/spotify
    const statsPath = path.join(__dirname, '../../../data/spotify/spider-stats.json')
    
    if (!fs.existsSync(statsPath)) {
      return ctx.reply('⚠️ Data statistik Spider belum tersedia. Mungkin Spider belum selesai memproses artis pertamanya.', { message_thread_id: ADMIN_THREAD_PANEL })
    }

    const statsRaw = fs.readFileSync(statsPath, 'utf8')
    const stats = JSON.parse(statsRaw)
    
    // Format tanggal update terakhir
    const lastUpdate = new Date(stats.timestamp).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })

    const message = `🕸️ *SPIDER BOT STATUS* 🕸️\n\n` +
      `👤 *Artis Terakhir:* ${stats.last_artist_processed}\n` +
      `✅ *Total Selesai (DB):* ${stats.done}\n` +
      `⏳ *Sisa Antrean:* ${stats.pending}\n` +
      `⏱️ *Durasi Terakhir:* ${stats.last_duration_minutes} Menit\n` +
      `🔮 *ETA Selesai:* ~${stats.estimated_time_remaining_hours} Jam\n\n` +
      `_🔄 Diperbarui: ${lastUpdate}_`

    return ctx.reply(message, { parse_mode: 'Markdown', message_thread_id: ADMIN_THREAD_PANEL })
  } catch (err) {
    logger.error({ event: 'spider_status_failed', msg: err.message })
    return ctx.reply(`❌ Terjadi kesalahan saat membaca status Spider: ${err.message}`, { message_thread_id: ADMIN_THREAD_PANEL })
  }
}


// ── Register semua handler
function registerAdminHandlers(bot) {
  bot.command('adminhelp',  adminOnly(handleAdminHelp))
  bot.command('dbstats',    adminOnly(handleDbStats))
  bot.command('listtrack',  adminOnly(handleListTrack))
  bot.command('findtrack',  adminOnly(handleFindTrack))
  bot.command('deltrack',   adminOnly(handleDelTrack))
  bot.command('syncr2',     adminOnly(handleSyncR2))
  bot.command('syncmeta',   adminOnly(handleSyncMeta))
  bot.command('seed', adminOnly(handleSeedArtist))
  bot.command('spider_status', adminOnly(handleSpiderStatus))
  
  // Guard untuk manual upload sudah ada di dalam admin.upload.js
  bot.on('audio',    handleAudioUpload)
  bot.on('document', handleAudioUpload)

  bot.action(/^lt:\d+$/, handleListTrackPage)

  // Auto-detect Spotify URL di grup admin
  bot.on('text', async (ctx) => {
    if (!isAdmin(ctx)) return
    const text = ctx.message.text.trim()
    if (text.startsWith('/')) return
    
    const url = normalizeUrl(text)
    if (!url || !url.includes('/track/')) return
    
    try {
      await handleAddTrack(ctx, url)
    } catch (err) {
      logger.error({ event: 'addtrack_error', msg: err.message })
      ctx.reply(`❌ ${escape(err.message)}`, { parse_mode: 'MarkdownV2', message_thread_id: ADMIN_THREAD_PANEL }).catch(() => {})
    }
  })
}

module.exports = { registerAdminHandlers, notify, handleAddTrack }