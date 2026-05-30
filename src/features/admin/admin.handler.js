// src/features/admin/admin.handler.js

const { v4: uuidv4 } = require('uuid')
const { escape, normalizeUrl } = require('../../formats/utils')
const logger = require('../../utils/logger')
const api = require('../../api/client')
const axios = require('axios')
const mm = require('music-metadata')
const fs = require('fs')
const path = require('path')

// Import sub-modules admin
const { handleAudioUpload } = require('./admin.upload')
const { handleDbStats, handleListTrack, handleListTrackPage, handleFindTrack, handleDelTrack } = require('./admin.manage')
const { handleSyncR2, handleSyncMeta } = require('./admin.sync')

// Import utilitas & repo untuk handleAddTrack (URL download)
const { uploadToR2, trackKey } = require('../../utils/r2')
const { startTyping } = require('../../utils/typing')
const { enrichMetadata, getAccessToken } = require('../../utils/spotify')
const { getTrack, saveTrack, updateTrackR2, findTrackByTitleArtist, addSpiderSeed, getSpiderQueue, skipSpiderArtist, countSpiderQueue } = require('../spotify/spotify.repo')



const { syncMp3ToApi } = require('../../utils/api-sync')

const ADMIN_GROUP         = process.env.TELEGRAM_ADMIN_GROUP_ID
const ADMIN_THREAD_NOTIFY = Number(process.env.TELEGRAM_ADMIN_THREAD_NOTIFY)
const ADMIN_THREAD_PANEL  = Number(process.env.TELEGRAM_ADMIN_THREAD_PANEL)
const ADMIN_THREAD_SPIDER_PANEL = Number(process.env.TELEGRAM_ADMIN_THREAD_SPIDER_PANEL) // ✨ Tambahan Thread
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

// ── Guard untuk membatasi command tertentu hanya di thread Spider Panel
function spiderPanelOnly(handler) {
  return async (ctx) => {
    if (!isAdmin(ctx)) return
    if (ctx.message && ctx.message.message_thread_id !== ADMIN_THREAD_SPIDER_PANEL) {
      const msg = await ctx.reply('❌ Command Spider hanya bisa digunakan di thread Spider Panel.', {
        message_thread_id: ctx.message.message_thread_id
      })
      // Hapus otomatis peringatan dan pesan salah kamar dalam 5 detik
      setTimeout(() => {
        ctx.telegram.deleteMessage(ctx.chat.id, msg.message_id).catch(() => {})
        ctx.telegram.deleteMessage(ctx.chat.id, ctx.message.message_id).catch(() => {})
      }, 5000)
      return
    }
    return handler(ctx)
  }
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
    `*Sistem Spider & R2*\n\`/seed <artis>\` — masukan artis ke antrean spider\n\`/queue\` — lihat antrean spider saat ini\n\`/spider_skip <nama>\` — hapus artis dari antrean\n\`/spider_status\` — cek metrik spider\n\`/syncr2\`  — upload R2 massal\n\`/syncmeta\`  — sync metadata`,
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
    return ctx.reply('Gunakan format: /seed nama artis\nAtau: /seed <URL Spotify Artist>', {
      message_thread_id: ADMIN_THREAD_SPIDER_PANEL
    })
  }

  const waitMsg = await ctx.reply('Mencari artis di Spotify...', { message_thread_id: ADMIN_THREAD_SPIDER_PANEL })
  
  try {
    const SPOTIFY_API_URL  = 'https://api.spotify.com/v1'
    const token = await getAccessToken()

    const urlMatch = keyword.match(/artist\/([a-zA-Z0-9]{22})/)
    const exactId = urlMatch ? urlMatch[1] : (keyword.length === 22 && !keyword.includes(' ') ? keyword : null)

    if (exactId) {
      const res = await axios.get(`${SPOTIFY_API_URL}/artists/${exactId}`, {
        headers: { 'Authorization': `Bearer ${token}` },
        timeout: 10000 
      })
      
      const artist = res.data
      const isNew = addSpiderSeed(artist.id, artist.name)
      const pendingCount = countSpiderQueue() 
      
      const statusMsg = isNew 
        ? `✅ Seed berhasil ditambahkan:\nArtis: ${artist.name}\nID: ${artist.id}\n\nSpider bot akan otomatis memproses artis ini.\n⏳ Sisa antrean saat ini: *${pendingCount} Artis*`
        : `ℹ️ Seed sudah ada:\nArtis ${artist.name} sudah berada di dalam antrean atau selesai diproses.`
            
      return ctx.telegram.editMessageText(ctx.chat.id, waitMsg.message_id, undefined, statusMsg)
    }

    const res = await axios.get(`${SPOTIFY_API_URL}/search?q=${encodeURIComponent(keyword)}&type=artist&limit=5`, {
      headers: { 'Authorization': `Bearer ${token}` },
      timeout: 10000 
    })

    const artists = res.data.artists.items
    if (artists.length === 0) {
      return ctx.telegram.editMessageText(ctx.chat.id, waitMsg.message_id, undefined, 
        `Gagal: Artis "${keyword}" tidak ditemukan di Spotify.`)
    }
    
    if (artists.length === 1) {
      const artist = artists[0]
      const isNew = addSpiderSeed(artist.id, artist.name)
      const pendingCount = countSpiderQueue()
      
      const statusMsg = isNew 
        ? `✅ Seed berhasil ditambahkan:\nArtis: ${artist.name}\nID: ${artist.id}\n\nSpider bot akan otomatis memproses artis ini.\n⏳ Sisa antrean saat ini: *${pendingCount} Artis*`
        : `ℹ️ Seed sudah ada:\nArtis ${artist.name} sudah berada di dalam antrean atau selesai diproses.`
      return ctx.telegram.editMessageText(ctx.chat.id, waitMsg.message_id, undefined, statusMsg)
    }

    const ts = Date.now();
    const inlineKeyboard = artists.map(a => ([
      { text: a.name, callback_data: `seed_artist:${a.id}:${ts}` }
    ]))

    await ctx.telegram.editMessageText(ctx.chat.id, waitMsg.message_id, undefined, 
      `Ditemukan beberapa hasil untuk "${keyword}". Pilih artis yang tepat:`,
      { reply_markup: { inline_keyboard: inlineKeyboard } }
    )

  } catch (err) {
    logger.error({ event: 'seed_artist_failed', msg: err.message }) 
    ctx.telegram.editMessageText(ctx.chat.id, waitMsg.message_id, undefined, 
      `Gagal mencari artis: ${err.message}`)
  }
}

// ── Handler untuk klik tombol artis 
async function handleSeedArtistCallback(ctx) {
  const artistId = ctx.match[1]
  const timestamp = parseInt(ctx.match[2], 10)

  if (Date.now() - timestamp > 60 * 60 * 1000) {
    return ctx.answerCbQuery('❌ Tombol sudah kedaluwarsa. Silakan cari ulang.', { show_alert: true })
  }
  
  await ctx.answerCbQuery('Memproses artis...').catch(() => {})

  try {
    const SPOTIFY_API_URL = 'https://api.spotify.com/v1'
    const token = await getAccessToken()
    
    const res = await axios.get(`${SPOTIFY_API_URL}/artists/${artistId}`, {
      headers: { 'Authorization': `Bearer ${token}` },
      timeout: 10000
    })

    const artist = res.data
    const isNew = addSpiderSeed(artist.id, artist.name)
    const pendingCount = countSpiderQueue()

    const statusMsg = isNew 
        ? `✅ Seed berhasil ditambahkan:\nArtis: ${artist.name}\nID: ${artist.id}\n\nSpider bot akan otomatis memproses artis ini.\n⏳ Sisa antrean saat ini: *${pendingCount} Artis*`
        : `ℹ️ Seed sudah ada:\nArtis ${artist.name} sudah berada di dalam antrean atau selesai diproses.`

    await ctx.editMessageText(statusMsg)

  } catch (err) {
    logger.error({ event: 'seed_artist_callback_failed', msg: err.message })
    await ctx.editMessageText(`Gagal memproses artis pilihan: ${err.message}`).catch(() => {})
  }
}

// ── /spider_status
async function handleSpiderStatus(ctx) {
  try {
    const statsPath = path.join(__dirname, '../../../data/spotify/spider-stats.json')
    
    if (!fs.existsSync(statsPath)) {
      return ctx.reply('⚠️ Data statistik Spider belum tersedia. Mungkin Spider belum selesai memproses artis pertamanya.', { message_thread_id: ADMIN_THREAD_SPIDER_PANEL })
    }

    const statsRaw = await fs.promises.readFile(statsPath, 'utf8')
    const stats = JSON.parse(statsRaw)
    
    const lastUpdate = new Date(stats.timestamp).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })
    const statusIcon = stats.status === 'ONLINE' ? '🟢' : (stats.status === 'SLEEPING' ? '🛌' : '🔴')
    const shiftTotal = (stats.shift_elapsed_minutes || 0) + (stats.shift_remaining_minutes || 0);
    const shiftDisplay = stats.status === 'SLEEPING'
      ? `⏸️ *Shift:* Menunggu jadwal bangun\\.\\.\\.\n`
      : `📅 *Mulai Shift:* ${stats.current_shift_started_at ? escape(stats.current_shift_started_at) : '\\-'}\n` +
        `⏱️ *Shift Berjalan:* ${stats.shift_elapsed_minutes || 0} / ${shiftTotal} Menit\n`;

    const message = `🕸️ *SPIDER BOT STATUS* 🕸️\n\n` +
      `${statusIcon} *Status:* ${escape(stats.status)}\n` +
      (stats.status === 'SLEEPING' && stats.sleep_started_at ? `💤 *Tidur Sejak:* ${escape(stats.sleep_started_at)}\n` : '') +
      (stats.next_wake_time ? `⏰ *Bangun Pada:* ${escape(stats.next_wake_time)}\n` : '') +
      `👤 *Artis Terakhir:* ${escape(stats.last_artist_processed || '-')}\n` +
      `✅ *Total Selesai \\(DB\\):* ${stats.done}\n` +
      `⏳ *Sisa Antrean:* ${stats.pending}\n` +
      shiftDisplay +
      `⏱️ *Durasi Terakhir:* ${escape(String(stats.last_duration_minutes || 0))} Menit\n` +
      `🔮 *ETA Selesai:* \\~${escape(String(stats.estimated_time_remaining_hours || 0))} Jam\n\n` + // ✨ FIX: Tambah \\ pada tanda ~
      `*🖥️ Metrik Sesi Saat Ini:*\n` +
      `• Uptime Spider: ${escape(String(stats.uptime_hours || 0))} Jam\n` +
      `• Siklus Tidur: ${stats.total_deep_sleep_count || 0} Kali \\(${stats.total_sleep_minutes || 0} Menit\\)\n` +
      `• RAM \\(RSS\\): ${stats.memory_rss_mb || 0} MB\n` +
      `• Album Disisir: ${stats.total_albums_scanned || 0}\n` +
      `• Lagu Sukses Sesi Ini: ${stats.total_session_tracks_success || 0}\n\n` +
      (stats.last_shutdown_reason ? `🛑 *Alasan Mati Terakhir:*\n_${escape(stats.last_shutdown_reason)}_\n\n` : '') +
      `_🔄 Diperbarui: ${escape(lastUpdate)}_`

    return ctx.reply(message, { parse_mode: 'MarkdownV2', message_thread_id: ADMIN_THREAD_SPIDER_PANEL })
  } catch (err) {
    logger.error({ event: 'spider_status_failed', msg: err.message })
    return ctx.reply(`❌ Terjadi kesalahan saat membaca status Spider: ${err.message}`, { message_thread_id: ADMIN_THREAD_SPIDER_PANEL })
  }
}

// ── /queue 
async function handleSpiderQueue(ctx) {
  const pendingCount = countSpiderQueue()
  if (pendingCount === 0) {
    return ctx.reply('📭 Antrean Spider kosong saat ini.', { message_thread_id: ADMIN_THREAD_SPIDER_PANEL })
  }

  const queue = getSpiderQueue(15)
  const lines = queue.map((a, i) => `${i + 1}\\. *${escape(a.name)}* \\(\`${a.artist_id}\`\\)`).join('\n')

  await ctx.reply(
    `🕸️ *Spider Queue* \\(${pendingCount} Pending\\)\n_Menampilkan 15 antrean teratas:_\n\n${lines}`, 
    { parse_mode: 'MarkdownV2', message_thread_id: ADMIN_THREAD_SPIDER_PANEL }
  )
}

// ── /spider_skip 
async function handleSpiderSkip(ctx) {
  const keyword = ctx.message.text.split(/\s+/).slice(1).join(' ').trim()
  if (!keyword) {
    return ctx.reply('❌ Masukkan nama artis atau ID untuk di-skip.\nContoh: `/spider_skip Nirvana`', { parse_mode: 'MarkdownV2', message_thread_id: ADMIN_THREAD_SPIDER_PANEL })
  }

  const success = skipSpiderArtist(keyword)
  if (success) {
    const pendingCount = countSpiderQueue()
    ctx.reply(`✅ Berhasil menghapus/melewati *${escape(keyword)}* dari antrean.\n⏳ Sisa antrean: ${pendingCount}`, { parse_mode: 'MarkdownV2', message_thread_id: ADMIN_THREAD_SPIDER_PANEL })
  } else {
    ctx.reply(`❌ Artis *${escape(keyword)}* tidak ditemukan di antrean (atau sedang/sudah diproses).`, { parse_mode: 'MarkdownV2', message_thread_id: ADMIN_THREAD_SPIDER_PANEL })
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
  bot.command('seed', spiderPanelOnly(handleSeedArtist))
  bot.command('queue', spiderPanelOnly(handleSpiderQueue))
  bot.command('spider_skip', spiderPanelOnly(handleSpiderSkip))
  bot.command('spider_status', spiderPanelOnly(handleSpiderStatus))
  bot.action(/^seed_artist:([a-zA-Z0-9]{22}):(\d+)$/, adminOnly(handleSeedArtistCallback))
  
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