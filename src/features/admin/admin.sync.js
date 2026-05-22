// src/features/admin/admin.sync.js

const axios = require('axios')
const logger = require('../../utils/logger')
const { escape } = require('../../formats/utils')
const { uploadToR2, trackKey } = require('../../utils/r2')
const { enrichMetadata } = require('../../utils/spotify')

// Import Repository
const { listTracksWithoutR2, updateTrackR2, listTracksForMetaSync, updateTrackMeta } = require('../spotify/spotify.repo')
const { listFlacTracksWithoutR2, updateFlacTrackR2, listFlacTracksForMetaSync, updateFlacTrackMeta } = require('../flac/flac.repo')

let isSyncing = false

// ── /syncr2 ───────────────────────────────────────────────────────────────────
async function handleSyncR2(ctx) {
  if (isSyncing) {
    return ctx.reply('⏳ Sync sedang berjalan\\. Tunggu sampai selesai\\.', { parse_mode: 'MarkdownV2' })
  }

  const mp3Tracks  = listTracksWithoutR2().map(t => ({ ...t, _db: 'mp3' }))
  const flacTracks = listFlacTracksWithoutR2().map(t => ({ ...t, _db: 'flac' }))
  const tracks     = [...mp3Tracks, ...flacTracks]

  if (!tracks.length) {
    return ctx.reply('✅ Semua track sudah ada di R2\\.', { parse_mode: 'MarkdownV2' })
  }

  const progressMsg = await ctx.reply(
    `☁️ *Sync R2*\n\n${tracks.length} track belum di R2\\. Memulai sync\\.\\.\\.`,
    { parse_mode: 'MarkdownV2' }
  )

  function renderProgress(current, total, success, failed, currentTrack) {
    const pct       = total > 0 ? Math.round((current / total) * 100) : 0
    const filled    = Math.round(pct / 10)
    const bar       = '■'.repeat(filled) + '□'.repeat(10 - filled)
    const trackLine = currentTrack
      ? `\n📀 _${escape(currentTrack.title)} — ${escape(currentTrack.artist)}_`
      : ''

    return (
      `☁️ *Sync R2*\n\n\`${bar}\` ${pct}%\n${current} / ${total} diproses${trackLine}\n\n` +
      `✅ Berhasil: *${success}*\n❌ Gagal: *${failed}*`
    )
  }

  async function updateProgress(current, total, success, failed, currentTrack) {
    await ctx.telegram.editMessageText(
      ctx.chat.id, progressMsg.message_id, undefined,
      renderProgress(current, total, success, failed, currentTrack),
      { parse_mode: 'MarkdownV2' }
    ).catch(() => {})
  }

  ;(async () => {
    isSyncing = true
    let success = 0, failed = 0
    const total = tracks.length
    const BATCH = 5  

    try {
      for (let i = 0; i < tracks.length; i++) {
        const track = tracks[i]

        if (i % BATCH === 0) await updateProgress(i, total, success, failed, track)

        try {
          const fileLink = await ctx.telegram.getFileLink(track.file_id)
          const res      = await axios.get(fileLink.href, { responseType: 'arraybuffer', timeout: 60_000 })
          const buffer   = Buffer.from(res.data)
          
          const key   = trackKey(track.track_id, track.title || 'Track', track.artist || 'Unknown', track._db)
          const r2Url = await uploadToR2(buffer, key, track._db === 'flac' ? 'audio/flac' : 'audio/mpeg', buffer.length)

          if (track._db === 'flac') updateFlacTrackR2(track.track_id, r2Url)
          else                       updateTrackR2(track.track_id, r2Url)
          
          success++
          logger.info({ event: 'syncr2_ok', n: `${i + 1}/${total}`, track: track.title })
        } catch (err) {
          failed++
          logger.warn({ event: 'syncr2_failed', track_id: track.track_id, msg: err.message })
        }
      }

      await updateProgress(total, total, success, failed, null)

      await ctx.reply(
        `☁️ *Sync R2 Selesai*\n\n✅ Berhasil: *${success}*\n❌ Gagal: *${failed}*\n` +
        `${failed > 0 ? '_Jalankan /syncr2 lagi untuk retry yang gagal\\._' : '_Semua track sudah tersimpan di R2\\._'}`,
        { parse_mode: 'MarkdownV2' }
      )
    } finally {
      isSyncing = false
    }
  })().catch(err => {
    isSyncing = false  
    logger.error({ event: 'syncr2_fatal', msg: err.message })
    ctx.reply('❌ Sync gagal fatal\\.', { parse_mode: 'MarkdownV2' }).catch(() => {})
  })
}

// ── /syncmeta ─────────────────────────────────────────────────────────────────
async function handleSyncMeta(ctx) {
  const mp3Tracks  = listTracksForMetaSync().map(t => ({ ...t, _db: 'mp3' }))
  const flacTracks = listFlacTracksForMetaSync().map(t => ({ ...t, _db: 'flac' }))
  const tracks     = [...mp3Tracks, ...flacTracks]

  if (!tracks.length) {
    return ctx.reply('✅ Semua track sudah memiliki metadata lengkap\\.', { parse_mode: 'MarkdownV2' })
  }

  const progressMsg = await ctx.reply(
    `🔍 *Sync Metadata*\n\n${tracks.length} track perlu di\\-sync\\. Memulai\\.\\.\\.`,
    { parse_mode: 'MarkdownV2' }
  )

  function renderProgress(current, total, success, failed, skipped, currentTrack) {
    const pct    = total > 0 ? Math.round((current / total) * 100) : 0
    const filled = Math.round(pct / 10)
    const bar    = '■'.repeat(filled) + '□'.repeat(10 - filled)
    const line   = currentTrack ? `\n🎵 _${escape(currentTrack.title)} — ${escape(currentTrack.artist)}_` : ''

    return (
      `🔍 *Sync Metadata*\n\n\`${bar}\` ${pct}%\n${current} / ${total} diproses${line}\n\n` +
      `✅ Updated: *${success}*\n⏭ Skipped: *${skipped}*\n❌ Gagal: *${failed}*`
    )
  }

  async function updateProgress(current, total, success, failed, skipped, currentTrack) {
    await ctx.telegram.editMessageText(
      ctx.chat.id, progressMsg.message_id, undefined,
      renderProgress(current, total, success, failed, skipped, currentTrack),
      { parse_mode: 'MarkdownV2' }
    ).catch(() => {})
  }

  ;(async () => {
    let success = 0, failed = 0, skipped = 0
    const total = tracks.length
    const BATCH = 3

    try {
      for (let i = 0; i < tracks.length; i++) {
        const track = tracks[i]
        if (i % BATCH === 0) await updateProgress(i, total, success, failed, skipped, track)

        try {
          const enriched = await enrichMetadata(track.title, track.artist)

          if (!enriched.album && !enriched.year && !enriched.thumbnail && !enriched.genre) {
            skipped++
            logger.info({ event: 'syncmeta_no_data', track: track.title })
            continue
          }

          const meta = {
            album:     enriched.album     || track.album     || null,
            year:      enriched.year      || track.year      || null,
            thumbnail: enriched.thumbnail || track.thumbnail || null,
            genre:     enriched.genre     || track.genre     || null,
          }

          if (track._db === 'flac') updateFlacTrackMeta(track.track_id, meta)
          else                       updateTrackMeta(track.track_id, meta)

          success++
          logger.info({ event: 'syncmeta_ok', track: track.title })
        } catch (err) {
          failed++
          logger.warn({ event: 'syncmeta_failed', track_id: track.track_id, msg: err.message })
        }
        await new Promise(r => setTimeout(r, 1000)) // Rate limit
      }

      await updateProgress(total, total, success, failed, skipped, null)

      await ctx.reply(
        `🔍 *Sync Metadata Selesai*\n\n✅ Updated: *${success}*\n⏭ Skipped: *${skipped}*\n❌ Gagal: *${failed}*\n` +
        `${failed > 0 ? '_Jalankan /syncmeta lagi untuk retry\\._' : '_Semua metadata sudah lengkap\\._'}`,
        { parse_mode: 'MarkdownV2' }
      )
    } catch (err) {
      logger.error({ event: 'syncmeta_fatal', msg: err.message })
      ctx.reply('❌ Sync metadata gagal fatal\\.', { parse_mode: 'MarkdownV2' }).catch(() => {})
    }
  })()
}

module.exports = { handleSyncR2, handleSyncMeta }