// src/features/admin/admin.handler.js

const { v4: uuidv4 } = require('uuid')
const { escape, normalizeUrl } = require('../../formats/utils')
const logger = require('../../utils/logger')
const api = require('../../api/client')
const axios = require('axios')

// Import sub-modules admin
const { handleAudioUpload } = require('./admin.upload')
const { handleDbStats, handleListTrack, handleListTrackPage, handleFindTrack, handleDelTrack } = require('./admin.manage')
const { handleSyncR2, handleSyncMeta } = require('./admin.sync')

// Import utilitas & repo untuk handleAddTrack (URL download)
const { uploadToR2, trackKey } = require('../../utils/r2')
const { enrichMetadata } = require('../../utils/spotify')
const { getTrack, saveTrack, updateTrackR2, findTrackByTitleArtist } = require('../spotify/spotify.repo')

const { syncMp3ToApi } = require('../../utils/api-sync')

const ADMIN_GROUP = process.env.TELEGRAM_ADMIN_GROUP_ID
const OWNER_ID    = String(process.env.TELEGRAM_OWNER_ID)

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
  await telegram.sendMessage(ADMIN_GROUP, text, { parse_mode: 'MarkdownV2' }).catch(() => {})
}

// ── /help admin
async function handleAdminHelp(ctx) {
  await ctx.reply(
    `🛠 *Admin Panel*\n\n` +
    `*Database*\n\`/dbstats\`  — statistik database\n\`/listtrack [page]\`  — daftar lagu\n\`/findtrack <keyword>\`  — cari lagu\n\`/deltrack <track\\_id>\`  — hapus lagu\n\n` +
    `*Tambah Koleksi*\nUpload audio langsung atau kirim URL Spotify\n\n` +
    `*Sistem*\n\`/syncr2\`  — upload R2 massal\n\`/syncmeta\`  — sync metadata`,
    { parse_mode: 'MarkdownV2' }
  )
}

// ── Add Track via Spotify URL
async function handleAddTrack(ctx, url) {
  const data = await api.contentSpotify(url)
  const { data: info, download } = data
  const trackId = info.track_id || null

  if (trackId && getTrack(trackId)) {
    return ctx.reply(
      `ℹ️ Track sudah ada di DB:\n*${escape(info.title)}* — ${escape(info.author)}`,
      { parse_mode: 'MarkdownV2' }
    )
  }

  const safeTitle  = info.title  || 'Track'
  const safeArtist = info.author || 'Unknown'

  const existingByMeta = findTrackByTitleArtist(safeTitle, safeArtist)
  if (existingByMeta) {
    return ctx.reply(
      `ℹ️ Track sudah ada di DB \\(via jalur lain\\):\n*${escape(existingByMeta.title)}* — ${escape(existingByMeta.artist)}\n🆔 \`${existingByMeta.track_id}\``,
      { parse_mode: 'MarkdownV2' }
    )
  }
  const candidates = [download.server_2, download.original, download.server_1].filter(Boolean)

  let buffer = null, fileSize = null, lastErr = null

  for (const candidate of candidates) {
    try {
      const res = await axios.get(candidate, { responseType: 'arraybuffer', timeout: 60_000 })
      buffer = Buffer.from(res.data)
      fileSize = buffer.length
      break
    } catch (err) {
      lastErr = err
      logger.warn({ event: 'addtrack_download_failed', msg: err.message })
    }
  }

  if (!buffer) {
    return ctx.reply(
      `❌ Gagal download: _${escape(lastErr?.message)}_`,
      { parse_mode: 'MarkdownV2' }
    )
  }

  const waitMsg = await ctx.reply(
    `⏳ Uploading ke Telegram\\.\\.\\. \\(${(fileSize / 1024).toFixed(0)} KB\\)`,
    { parse_mode: 'MarkdownV2' }
  )
  const key      = trackKey(trackId || Date.now().toString(), safeTitle, safeArtist, 'mp3')
  const audioOpts = {
    title:     safeTitle,
    performer: safeArtist,
    thumbnail: info.thumbnail ? { url: info.thumbnail } : undefined,
  }

  ;(async () => {
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
        { parse_mode: 'MarkdownV2' }
      )

      // Background: enrich dulu → saveTrack sekali dengan data lengkap → R2 → sync
      ;(async () => {
        // Tahap 1: enrichment sekali saja
        let enriched = {}
        try {
          enriched = await enrichMetadata(safeTitle, safeArtist)
          logger.info({ event: 'addtrack_enrich_ok', track: safeTitle })
        } catch (err) {
          logger.warn({ event: 'addtrack_enrich_failed', track: safeTitle, msg: err.message })
        }
        const finalTrackId = trackId || uuidv4()
        // Tahap 2: saveTrack sekali dengan data lengkap
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

        // Tahap 3: upload R2 → sync REST API
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
      })()

    } catch (err) {
      ctx.telegram.deleteMessage(ctx.chat.id, waitMsg.message_id).catch(() => {})
      logger.error({ event: 'addtrack_upload_failed', msg: err.message })
      ctx.reply(
        `❌ Upload ke Telegram gagal: _${escape(err.message)}_`,
        { parse_mode: 'MarkdownV2' }
      ).catch(() => {})
    }
  })()
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
      ctx.reply(`❌ ${escape(err.message)}`, { parse_mode: 'MarkdownV2' }).catch(() => {})
    }
  })
}

module.exports = { registerAdminHandlers, notify }