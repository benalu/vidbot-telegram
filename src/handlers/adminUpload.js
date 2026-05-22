// src/handlers/adminUpload.js

const axios    = require('axios')
const mm       = require('music-metadata')
const { v4: uuidv4 } = require('uuid')
const logger   = require('../utils/logger')
const { escape }                     = require('../formats/utils')
const crypto = require('crypto')
const { saveTrack, updateTrackR2, getTrackByHash }             = require('../utils/db')
const { saveFlacTrack, updateFlacTrackR2, getFlacTrackByHash } = require('../utils/flacDb')
const { uploadToR2, trackKey }       = require('../utils/r2')
const { enrichMetadata }             = require('../utils/spotify')



const ADMIN_GROUP  = process.env.TELEGRAM_ADMIN_GROUP_ID
const OWNER_ID     = String(process.env.TELEGRAM_OWNER_ID)

const TG_DOWNLOAD_LIMIT = 20 * 1024 * 1024

function isAdmin(ctx) {
  return String(ctx.chat?.id) === String(ADMIN_GROUP) &&
         String(ctx.from?.id) === OWNER_ID
}

// Parse "Title - Artist" atau "Title | Artist" dari caption
function parseCaption(caption) {
  if (!caption) return null
  const sep = caption.includes('|') ? '|' : '-'
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

// Fingerprint unik per file — cek duplikasi sebelum proses apapun
  const isFlac   = mime.includes('flac')
  const fileHash = crypto
    .createHash('sha256')
    .update(`${audio.file_id}:${fileSize}`)
    .digest('hex')

  const existing = isFlac ? getFlacTrackByHash(fileHash) : getTrackByHash(fileHash)
   if (existing) {
   return ctx.reply(
        `ℹ️ File ini sudah ada di database:\n*${escape(existing.title)}* — ${escape(existing.artist)}\n\`${existing.track_id}\``,
        { parse_mode: 'MarkdownV2' }
    )
    }

  const waitMsg = await ctx.reply('⏳ Memproses audio\\.\\.\\.', { parse_mode: 'MarkdownV2' })

  try {
    // ── Baca metadata dari buffer (perlu download untuk ID3) ──────────────
    let title  = null
    let artist = null
    let albumMeta = null
    let yearMeta  = null
    const trackId = uuidv4()
    let durationMeta = null
    let thumbnailUrl = null
    let genreMeta    = null

    // Download buffer hanya untuk baca ID3 — tidak untuk upload ulang ke Telegram
    if (fileSize <= TG_DOWNLOAD_LIMIT) {
    try {
        const fileLink = await ctx.telegram.getFileLink(audio.file_id)
        const res      = await axios.get(fileLink.href, {
        responseType: 'arraybuffer',
        timeout: 60_000,
        })
        const buffer = Buffer.from(res.data)
        const meta   = await mm.parseBuffer(buffer, { mimeType: mime })

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
        const secs = Math.round(meta.format.duration)
        const m    = Math.floor(secs / 60)
        const s    = String(secs % 60).padStart(2, '0')
        durationMeta = `${m}:${s}`
        }

        const cover = meta.common?.picture?.[0]
        if (cover?.data) {
        const coverBuffer = Buffer.from(cover.data)
        const coverMime   = cover.format || 'image/jpeg'
        const coverExt    = coverMime.includes('png') ? 'png' : 'jpg'
        const coverKey    = `covers/${trackId}.${coverExt}`
        thumbnailUrl = await uploadToR2(coverBuffer, coverKey, coverMime, coverBuffer.length)
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
       // album + year akan di-enrich via Spotify setelah fallback Telegram di bawah
    }


    if (!durationMeta && audio.duration) {
    const secs = Math.round(audio.duration)
    const m    = Math.floor(secs / 60)
    const s    = String(secs % 60).padStart(2, '0')
    durationMeta = `${m}:${s}`
    }

    // Fallback metadata dari Telegram audio object
    if (!title)  title  = audio.title     || null
    if (!artist) artist = audio.performer || null

    // Fallback caption
    if (!title || !artist) {
    const caption = ctx.message.caption || ''
    const parsed  = parseCaption(caption)
    if (parsed) {
        title  = title  || parsed.title
        artist = artist || parsed.artist
    }
    }

    // Spotify enrichment — jalankan kalau ada title + artist
    // dan ada field yang masih kosong (album/year)
    if (title && artist && (!albumMeta || !yearMeta || !thumbnailUrl)) {
      const enriched = await enrichMetadata(title, artist)
      if (!albumMeta && enriched.album) {
        albumMeta = enriched.album
        logger.info({ event: 'spotify_enrich_album', track: title, album: albumMeta })
       }
      if (!yearMeta && enriched.year) {
        yearMeta = enriched.year
        logger.info({ event: 'spotify_enrich_year', track: title, year: yearMeta })
       }
      if (!thumbnailUrl && enriched.thumbnail) {
        thumbnailUrl = enriched.thumbnail
        logger.info({ event: 'spotify_enrich_thumbnail', track: title, thumbnail: thumbnailUrl })
       }
       if (!genreMeta && enriched.genre) {
        genreMeta = enriched.genre
        logger.info({ event: 'spotify_enrich_genre', track: title, genre: genreMeta })
       }
    }

    // Validasi akhir
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
    
    const key = trackKey(trackId, title, artist)

    // ── Pakai file_id langsung — tidak upload ulang buffer ─────────────────
    // Forward ke chat yang sama untuk dapat file_id yang stable
    const fileId   = audio.file_id
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

    if (isFlac) {
        saveFlacTrack(trackData)
    } else {
        saveTrack(trackData)
    }

    ctx.telegram.deleteMessage(ctx.chat.id, waitMsg.message_id).catch(() => {})

    const sizeMB = escape((fileSizeFinal / 1024 / 1024).toFixed(1))

    await ctx.reply(
      `✅ *Berhasil disimpan*\n\n` +
      `🎵 *${escape(title)}* — ${escape(artist)}\n` +
      `📁 ${sizeMB} MB\n` +
      `🆔 \`${trackId}\``,
      { parse_mode: 'MarkdownV2' }
    )

    // ── Upload ke R2 background — download buffer sekali untuk R2 ──────────
    ;(async () => {
    if (fileSizeFinal > TG_DOWNLOAD_LIMIT) {
        logger.info({ event: 'manual_upload_r2_skipped', reason: 'file_too_large_for_bot_api', track: title, size: fileSizeFinal })
        return
    }

    try {
        const fileLink = await ctx.telegram.getFileLink(fileId)
        const res      = await axios.get(fileLink.href, {
        responseType: 'arraybuffer',
        timeout: 120_000,
        })
        const buffer = Buffer.from(res.data)
        const r2Url  = await uploadToR2(buffer, key, mime, buffer.length)
        if (r2Url) {
            if (isFlac) updateFlacTrackR2(trackId, r2Url)
            else        updateTrackR2(trackId, r2Url)
        }
        logger.info({ event: 'manual_upload_r2_ok', track: title, artist })
    } catch (err) {
        logger.warn({ event: 'manual_upload_r2_failed', track: title, msg: err.message })
    }
    })()

  } catch (err) {
    ctx.telegram.deleteMessage(ctx.chat.id, waitMsg.message_id).catch(() => {})
    logger.error({ event: 'manual_upload_error', msg: err.message })
    ctx.reply(
      `❌ Gagal memproses: _${escape(err.message)}_`,
      { parse_mode: 'MarkdownV2' }
    ).catch(() => {})
  }
}

module.exports = { handleAudioUpload }