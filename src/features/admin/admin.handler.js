// src/features/admin/admin.handler.js

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
const { getTrack, saveTrack, updateTrackR2 } = require('../spotify/spotify.repo')

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
async function notify(bot, text) {
  await bot.telegram.sendMessage(ADMIN_GROUP, text, { parse_mode: 'MarkdownV2' }).catch(() => {})
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
    return ctx.reply(`ℹ️ Track sudah ada di DB:\n*${escape(info.title)}* — ${escape(info.author)}`, { parse_mode: 'MarkdownV2' })
  }

  const safeTitle  = info.title  || 'Track'
  const safeArtist = info.author || 'Unknown'
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

  if (!buffer) return ctx.reply(`❌ Gagal download: _${escape(lastErr?.message)}_`, { parse_mode: 'MarkdownV2' })

  const waitMsg = await ctx.reply(`⏳ Uploading ke Telegram\\.\\.\\. \\(${(fileSize / 1024).toFixed(0)} KB\\)`, { parse_mode: 'MarkdownV2' })
  const key = trackKey(trackId || Date.now().toString(), safeTitle, safeArtist, 'mp3')
  const audioOpts = { title: safeTitle, performer: safeArtist, thumbnail: info.thumbnail ? { url: info.thumbnail } : undefined }

  ;(async () => {
    try {
      const sent = await ctx.replyWithAudio({ source: buffer, filename: `${safeTitle}.mp3` }, audioOpts)
      ctx.telegram.deleteMessage(ctx.chat.id, waitMsg.message_id).catch(() => {})

      if (trackId && sent?.audio?.file_id) {
        let albumMeta = info.album || null, yearMeta = info.year || null, thumbnailMeta = info.thumbnail || null, genreMeta = null

        try {
            const enriched = await enrichMetadata(safeTitle, safeArtist)
            if (!albumMeta && enriched.album) albumMeta = enriched.album
            if (!yearMeta && enriched.year) yearMeta = enriched.year
            if (!thumbnailMeta && enriched.thumbnail) thumbnailMeta = enriched.thumbnail
            if (enriched.genre) genreMeta = enriched.genre
        } catch (err) {}

        saveTrack({
          track_id:  trackId,
          file_id:   sent.audio.file_id,
          title:     safeTitle,
          artist:    safeArtist,
          duration:  info.duration || null,
          quality:   info.quality  || null,
          thumbnail: thumbnailMeta,
          file_size: fileSize,
          r2_url:    null,
          type:      'mp3',
          source:    'spotify',
          album:     albumMeta,
          year:      yearMeta,
          genre:     genreMeta,
          file_hash: null,
      })
        await ctx.reply(`✅ Berhasil ditambahkan:\n*${escape(safeTitle)}* — ${escape(safeArtist)}`, { parse_mode: 'MarkdownV2' })
      }

      ;(async () => {
      // Enrich metadata dulu
      try {
        const enriched = await enrichMetadata(safeTitle, safeArtist)
        if (enriched.album || enriched.year || enriched.thumbnail || enriched.genre) {
          const { updateTrackMeta } = require('../spotify/spotify.repo')
          updateTrackMeta(trackId, {
            album:     enriched.album     || albumMeta     || null,
            year:      enriched.year      || yearMeta      || null,
            thumbnail: enriched.thumbnail || thumbnailMeta || null,
            genre:     enriched.genre     || null,
          })
          logger.info({ event: 'addtrack_enrich_ok', track: safeTitle })
        }
      } catch (err) {
        logger.warn({ event: 'addtrack_enrich_failed', track: safeTitle, msg: err.message })
      }

      // R2 upload → sync REST API
      try {
        const r2Url = await uploadToR2(buffer, key, 'audio/mpeg', fileSize)
        if (trackId && r2Url) {
          updateTrackR2(trackId, r2Url)
          const fullTrack = getTrack(trackId)
          await syncMp3ToApi({ ...fullTrack, r2_url: r2Url })
        }
      } catch (err) {
        logger.warn({ event: 'r2_upload_failed', track: safeTitle, msg: err.message })
      }
    })()

    } catch (err) {
      ctx.telegram.deleteMessage(ctx.chat.id, waitMsg.message_id).catch(() => {})
      logger.error({ event: 'addtrack_upload_failed', msg: err.message })
      ctx.reply(`❌ Upload ke Telegram gagal: _${escape(err.message)}_`, { parse_mode: 'MarkdownV2' }).catch(() => {})
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