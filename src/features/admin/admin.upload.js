// src/features/admin/admin.upload.js

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

const ADMIN_GROUP       = process.env.TELEGRAM_ADMIN_GROUP_ID
const OWNER_ID          = String(process.env.TELEGRAM_OWNER_ID)
const TG_DOWNLOAD_LIMIT = 20 * 1024 * 1024

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

  // Cek duplikat via file hash sebelum proses apapun
  const fileHash = crypto
    .createHash('sha256')
    .update(`${audio.file_id}:${fileSize}`)
    .digest('hex')

  const existingHash = isFlac ? getFlacTrackByHash(fileHash) : getTrackByHash(fileHash)
  if (existingHash) {
    return ctx.reply(
      `ℹ️ File ini sudah ada di database:\n*${escape(existingHash.title)}* — ${escape(existingHash.artist)}\n\`${existingHash.track_id}\``,
      { parse_mode: 'MarkdownV2' }
    )
  }

  const waitMsg = await ctx.reply('⏳ Memproses audio\\.\\.\\.', { parse_mode: 'MarkdownV2' })

  try {
    const trackId    = uuidv4()
    let title        = null
    let artist       = null
    let albumMeta    = null
    let yearMeta     = null
    let durationMeta = null
    let thumbnailUrl = null
    let genreMeta    = null

    // Baca ID3 tag dari buffer
    if (fileSize <= TG_DOWNLOAD_LIMIT) {
      try {
        const fileLink = await ctx.telegram.getFileLink(audio.file_id)
        const res      = await axios.get(fileLink.href, { responseType: 'arraybuffer', timeout: 60_000 })
        const buffer   = Buffer.from(res.data)
        const meta     = await mm.parseBuffer(buffer, { mimeType: mime })

        logger.info({
          event: 'metadata_raw',
          common: {
            title:  meta.common?.title,
            artist: meta.common?.artist,
            album:  meta.common?.album,
            year:   meta.common?.year,
            date:   meta.common?.date,
          },
          native_keys: Object.keys(meta.native || {}),
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
          thumbnailUrl = await uploadToR2(coverBuffer, `covers/${trackId}.${coverExt}`, coverMime, coverBuffer.length)
            .catch(err => {
              logger.warn({ event: 'manual_upload_cover_failed', msg: err.message })
              return null
            })
        }
      } catch (err) {
        logger.warn({ event: 'metadata_parse_failed', msg: err.message })
      }
    } else {
      logger.info({ event: 'metadata_skipped_large_file', size: fileSize, track: audio.title })
    }

    // Fallback duration dari Telegram object
    if (!durationMeta && audio.duration) {
      const secs   = Math.round(audio.duration)
      durationMeta = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`
    }

    // Fallback title/artist dari Telegram object lalu caption
    if (!title)  title  = audio.title     || null
    if (!artist) artist = audio.performer || null

    if (!title || !artist) {
      const parsed = parseCaption(ctx.message.caption || '')
      if (parsed) {
        title  = title  || parsed.title
        artist = artist || parsed.artist
      }
    }

    // Validasi — harus ada title dan artist sebelum lanjut
    if (!title || !artist) {
      ctx.telegram.deleteMessage(ctx.chat.id, waitMsg.message_id).catch(() => {})
      return ctx.reply(
        `❌ Metadata tidak ditemukan\\.\n\n` +
        `ID3 tag kosong dan caption tidak valid\\.\n\n` +
        `*Format caption yang diterima:*\n` +
        `\`Title \\- Artist\`\n` +
        `\`Title \\| Artist\``,
        { parse_mode: 'MarkdownV2' }
      )
    }

    // Cek duplikat via title+artist — tangkap entry dari jalur berbeda (misal Spotify URL)
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
        { parse_mode: 'MarkdownV2' }
      )
    }

    // Enrich metadata via Spotify + LastFM — hanya jalan kalau bukan duplikat
    try {
      const enriched = await enrichMetadata(title, artist)
      if (enriched.album)     { albumMeta    = enriched.album;     logger.info({ event: 'spotify_enrich_album',     track: title, album: albumMeta }) }
      if (enriched.year)      { yearMeta     = enriched.year;      logger.info({ event: 'spotify_enrich_year',      track: title, year: yearMeta }) }
      if (enriched.thumbnail) { thumbnailUrl = enriched.thumbnail; logger.info({ event: 'spotify_enrich_thumbnail', track: title }) }
      if (enriched.genre)     { genreMeta    = enriched.genre;     logger.info({ event: 'spotify_enrich_genre',     track: title, genre: genreMeta }) }
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
      { parse_mode: 'MarkdownV2' }
    )

    // Upload ke R2 di background
    ;(async () => {
    if (fileSizeFinal > TG_DOWNLOAD_LIMIT) {
      logger.info({ event: 'manual_upload_r2_skipped', reason: 'file_too_large_for_bot_api', track: title, size: fileSizeFinal })
      return
    }
    try {
      const fileLink = await ctx.telegram.getFileLink(fileId)
      const res      = await axios.get(fileLink.href, { responseType: 'arraybuffer', timeout: 120_000 })
      const buffer   = Buffer.from(res.data)
      const r2Url    = await uploadToR2(buffer, key, mime, buffer.length)
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
    }
  })()

  } catch (err) {
    ctx.telegram.deleteMessage(ctx.chat.id, waitMsg.message_id).catch(() => {})
    logger.error({ event: 'manual_upload_error', msg: err.message })
    ctx.reply(`❌ Gagal memproses: _${escape(err.message)}_`, { parse_mode: 'MarkdownV2' }).catch(() => {})
  }
}

module.exports = { handleAudioUpload }