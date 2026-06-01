// src/features/admin/admin.upload.js

const fs                 = require('fs')
const path               = require('path')
const axios              = require('axios')
const mm                 = require('music-metadata')
const { v4: uuidv4 }     = require('uuid')
const crypto             = require('crypto')
const logger             = require('../../utils/logger')
const { escape }         = require('../../formats/utils')
const { uploadToR2, trackKey }   = require('../../utils/r2')
const { enrichMetadata }         = require('../../utils/spotify')
const { saveTrack, updateTrackR2, getTrackByHash, findTrackByTitleArtist }             = require('../spotify/spotify.repo')
const { saveFlacTrack, updateFlacTrackR2, getFlacTrackByHash, findFlacTrackByTitleArtist } = require('../flac/flac.repo')
const { syncFlacToApi, syncMp3ToApi } = require('../../utils/api-sync')

const ADMIN_GROUP        = process.env.TELEGRAM_ADMIN_GROUP_ID
const OWNER_ID           = String(process.env.TELEGRAM_OWNER_ID)
const ADMIN_THREAD_PANEL = Number(process.env.TELEGRAM_ADMIN_THREAD_PANEL)

// ✨ Limit dinaikkan jadi 2GB
const TG_DOWNLOAD_LIMIT  = 2000 * 1024 * 1024

function panelOpts(extra = {}) {
  return { parse_mode: 'MarkdownV2', message_thread_id: ADMIN_THREAD_PANEL, ...extra }
}

function isAdmin(ctx) {
  return String(ctx.chat?.id) === String(ADMIN_GROUP) &&
         String(ctx.from?.id) === OWNER_ID
}

function parseCaption(caption) {
  if (!caption) return null
  const sep   = caption.includes('|') ? '|' : '-'
  const parts = caption.split(sep).map(s => s.trim())
  if (parts.length < 2) return null
  return { title: parts[0], artist: parts.slice(1).join(sep).trim() }
}

async function handleAudioUpload(ctx) {
  if (!isAdmin(ctx)) return

  const audio = ctx.message.audio || ctx.message.document
  if (!audio) return

  const mime    = audio.mime_type || ''
  const allowed = ['audio/mpeg', 'audio/mp3', 'audio/flac', 'audio/ogg', 'audio/x-flac']
  if (!allowed.includes(mime)) return

  const fileSize = audio.file_size || 0
  const isFlac   = mime.includes('flac')

  const fileHash = crypto
    .createHash('sha256')
    .update(`${audio.file_id}:${fileSize}`)
    .digest('hex')

  const existingHash = isFlac ? getFlacTrackByHash(fileHash) : getTrackByHash(fileHash)
  if (existingHash) {
    return ctx.reply(
      `ℹ️ File ini sudah ada di database:\n*${escape(existingHash.title)}* — ${escape(existingHash.artist)}\n\`${existingHash.track_id}\``,
      panelOpts()
    )
  }

  const waitMsg = await ctx.reply('⏳ Memproses audio\\.\\.\\.', panelOpts())

  try {
    const trackId    = uuidv4()
    let title        = null
    let artist       = null
    let albumMeta    = null
    let yearMeta     = null
    let durationMeta = null
    let thumbnailUrl = null
    let genreMeta    = null

    let localFilePath = null; // ✨ Penampung path file di harddisk VPS

    try {
      // ✨ Ambil informasi path absolut dari Local API Server
      const fileData = await ctx.telegram.getFile(audio.file_id)
      
      if (fileData.file_path) {
         // Konversi path Docker (/var/lib/...) menjadi path VPS (/home/ubuntu/...)
         localFilePath = fileData.file_path.replace('/var/lib/telegram-bot-api', '/home/ubuntu/telegram-api-server/data')
      }
    } catch (err) {
      logger.warn({ event: 'get_file_path_failed', msg: err.message })
    }

    if (fileSize <= TG_DOWNLOAD_LIMIT && localFilePath && fs.existsSync(localFilePath)) {
      try {
        // ✨ Baca metadata langsung dari harddisk VPS (Super Cepat & Hemat RAM!)
        const meta = await mm.parseFile(localFilePath, { duration: true })

        logger.info({
          event: 'metadata_raw',
          common: {
            title:  meta.common?.title,
            artist: meta.common?.artist,
            album:  meta.common?.album,
            year:   meta.common?.year,
          }
        })

        title     = meta.common?.title  || null
        artist    = meta.common?.artist || null
        albumMeta = meta.common?.album  || null
        yearMeta  = meta.common?.year
          ? String(meta.common.year)
          : meta.common?.date?.slice(0, 4) || null

        if (meta.format?.duration) {
          const secs   = Math.round(meta.format.duration)
          durationMeta = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`
        }

        const cover = meta.common?.picture?.[0]
        if (cover?.data) {
          const coverBuffer = Buffer.from(cover.data)
          const coverMime   = cover.format || 'image/jpeg'
          const coverExt    = coverMime.includes('png') ? 'png' : 'jpg'
          thumbnailUrl = await uploadToR2(coverBuffer, `covers/${trackId}.${coverExt}`, coverMime, coverBuffer.length).catch(() => null)
        }
      } catch (err) {
        logger.warn({ event: 'metadata_parse_failed', msg: err.message })
      }
    } else {
      logger.info({ event: 'metadata_skipped_large_file', size: fileSize, track: audio.title })
    }

    if (!durationMeta && audio.duration) {
      const secs   = Math.round(audio.duration)
      durationMeta = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`
    }

    if (!title)  title  = audio.title     || null
    if (!artist) artist = audio.performer || null

    if (!title || !artist) {
      const parsed = parseCaption(ctx.message.caption || '')
      if (parsed) {
        title  = title  || parsed.title
        artist = artist || parsed.artist
      }
    }

    if (!title || !artist) {
      ctx.telegram.deleteMessage(ctx.chat.id, waitMsg.message_id).catch(() => {})
      return ctx.reply(
        `❌ Metadata tidak ditemukan\\.\n\n` +
        `ID3 tag kosong dan caption tidak valid\\.\n\n` +
        `*Format caption yang diterima:*\n` +
        `\`Title \\- Artist\`\n` +
        `\`Title \\| Artist\``,
        panelOpts()
      )
    }

    const existingTitleArtist = isFlac
      ? findFlacTrackByTitleArtist(title, artist)
      : findTrackByTitleArtist(title, artist)

    if (existingTitleArtist) {
      ctx.telegram.deleteMessage(ctx.chat.id, waitMsg.message_id).catch(() => {})
      return ctx.reply(
        `ℹ️ Lagu ini sudah ada di database \\(dari jalur berbeda\\):\n` +
        `*${escape(existingTitleArtist.title)}* — ${escape(existingTitleArtist.artist)}\n` +
        `📁 Source: \`${existingTitleArtist.source || 'unknown'}\`\n` +
        `🆔 \`${existingTitleArtist.track_id}\``,
        panelOpts()
      )
    }

    try {
      const enriched = await enrichMetadata(title, artist)
      if (enriched.album)     { albumMeta    = enriched.album }
      if (enriched.year)      { yearMeta     = enriched.year  }
      if (enriched.thumbnail) { thumbnailUrl = enriched.thumbnail }
      if (enriched.genre)     { genreMeta    = enriched.genre }
    } catch (err) {
      logger.warn({ event: 'spotify_enrich_failed', track: title, msg: err.message })
    }

    const key = trackKey(trackId, title, artist, isFlac ? 'flac' : 'mp3')
    const fileId       = audio.file_id
    const fileSizeFinal = fileSize || 0

    const trackData = {
      track_id:  trackId,
      file_id:   fileId,
      title,
      artist,
      duration:  durationMeta,
      quality:   isFlac ? 'FLAC' : 'MP3',
      thumbnail: thumbnailUrl,
      file_size: fileSizeFinal,
      r2_url:    null,
      type:      isFlac ? 'flac' : 'mp3',
      source:    'manual',
      album:     albumMeta,
      year:      yearMeta,
      genre:     genreMeta,
      file_hash: fileHash,
    }

    if (isFlac) saveFlacTrack(trackData)
    else        saveTrack(trackData)

    ctx.telegram.deleteMessage(ctx.chat.id, waitMsg.message_id).catch(() => {})

    await ctx.reply(
      `✅ *Berhasil disimpan*\n\n` +
      `🎵 *${escape(title)}* — ${escape(artist)}\n` +
      `📁 ${escape((fileSizeFinal / 1024 / 1024).toFixed(1))} MB\n` +
      `🆔 \`${trackId}\``,
      panelOpts()
    )

    // ✨ UPDATE: Upload R2 langsung dari Harddisk VPS (Tanpa Axios!)
    ;(async () => {
      if (fileSizeFinal > TG_DOWNLOAD_LIMIT) return

      try {
        if (!localFilePath || !fs.existsSync(localFilePath)) {
          throw new Error('File fisik tidak ditemukan di harddisk VPS')
        }

        // ✨ Baca file langsung dari harddisk
        const buffer = fs.readFileSync(localFilePath)
        
        // Upload ke R2
        const r2Url = await uploadToR2(buffer, key, mime, buffer.length)
        
        if (r2Url) {
          if (isFlac) {
            updateFlacTrackR2(trackId, r2Url)
            const { getFlacTrack } = require('../flac/flac.repo')
            const fullTrack = getFlacTrack(trackId)
            await syncFlacToApi({ ...fullTrack, r2_url: r2Url })
          } else {
            updateTrackR2(trackId, r2Url)
            const { getTrack } = require('../spotify/spotify.repo')
            const fullTrack = getTrack(trackId)
            await syncMp3ToApi({ ...fullTrack, r2_url: r2Url })
          }
        }
        logger.info({ event: 'manual_upload_r2_ok', track: title, artist })
      } catch (err) {
        logger.warn({ event: 'manual_upload_r2_failed', track: title, msg: err.message })
      } finally {
        // ✨ AUTO-DELETE: Bersihkan file dari VPS setelah dikirim ke R2
        if (localFilePath && fs.existsSync(localFilePath)) {
          try {
            // Karena file dibuat oleh Docker (root), kita gunakan akses sudo untuk menghapusnya
            const { execSync } = require('child_process')
            execSync(`sudo rm -f "${localFilePath}"`)
            logger.info({ event: 'local_cache_deleted', file: localFilePath })
          } catch (cleanupErr) {
            logger.warn({ event: 'local_cache_delete_failed', msg: cleanupErr.message })
          }
        }
      }
    })()

  } catch (err) {
    ctx.telegram.deleteMessage(ctx.chat.id, waitMsg.message_id).catch(() => {})
    logger.error({ event: 'manual_upload_error', msg: err.message })
    ctx.reply(`❌ Gagal memproses: _${escape(err.message)}_`, panelOpts()).catch(() => {})
  }
}

module.exports = { handleAudioUpload }