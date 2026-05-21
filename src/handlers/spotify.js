const axios  = require('axios')
const api    = require('../api/client')
const logger = require('../utils/logger')
const { escape, normalizeUrl }                             = require('../formats/utils')
const { getTrack, saveTrack, searchTracks, updateTrackR2 } = require('../utils/db')
const { uploadToR2, trackKey }                             = require('../utils/r2')
const { notify }                                           = require('./admin')

const pendingUploads = new Map()


function buildAudioOpts(info, ctx) {
  return {
    title:      info.title  || 'Track',
    performer:  info.artist || info.author || 'Unknown',
    thumbnail:  info.thumbnail ? { url: info.thumbnail } : undefined,
    message_thread_id: ctx.message.message_thread_id,
    reply_parameters: {
      message_id: ctx.message.message_id,
      allow_sending_without_reply: true,
    },
  }
}

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

// ── Search: tampilkan daftar tombol dulu ──────────────────────────────────────
const SEARCH_PAGE_SIZE = 5

function buildSearchMessage(results, keyword, page) {
  const total   = results.length
  const pages   = Math.ceil(total / SEARCH_PAGE_SIZE)
  const offset  = (page - 1) * SEARCH_PAGE_SIZE
  const slice   = results.slice(offset, offset + SEARCH_PAGE_SIZE)

  // Tombol audio — satu per baris
  const audioButtons = slice.map(track => ([{
    text:          `${track.title} — ${track.artist}`,
    callback_data: `spot:${track.track_id}`,
  }]))

  // Tombol navigasi prev/next — satu baris di bawah
  const nav = []
  if (page > 1)     nav.push({ text: '◀️ Prev', callback_data: `srch:${page - 1}:${keyword}` })
  if (page < pages) nav.push({ text: 'Next ▶️', callback_data: `srch:${page + 1}:${keyword}` })

  const buttons = nav.length ? [...audioButtons, nav] : audioButtons

  const text = (
    `\\[ RESULT \\] *${total} found* for _${escape(keyword)}_\n` +
    `_Halaman ${page}/${pages} — pilih lagu di bawah:_`
  )

  return { text, buttons }
}

async function handleSearch(ctx, keyword) {
  const safeKeyword = keyword.slice(0, 40).trim()
  const results = searchTracks(safeKeyword)

  if (!results.length) {
    return ctx.reply(
      `\\[ NOT FOUND \\]\n` +
      `No cached songs found for: *${escape(keyword)}*\n\n` +
      `_The collection is still empty\\. Send a Spotify track link first:_\n` +
      `\`/spot open\\.spotify\\.com/track/\\.\\.\\.\``,
      replyOpts(ctx)
    )
  }

  // Simpan ke cache untuk pagination
  cacheSearch(ctx.from?.id, safeKeyword, results)

  const { text, buttons } = buildSearchMessage(results, safeKeyword, 1)

  await ctx.reply(text, {
    ...replyOpts(ctx),
    reply_markup: { inline_keyboard: buttons },
  })
}

const searchCache = new Map()

function cacheSearch(userId, keyword, results) {
  const key = `${userId}:${keyword}`
  searchCache.set(key, { results, ts: Date.now() })

  // Cleanup otomatis setelah 10 menit
  setTimeout(() => searchCache.delete(key), 10 * 60 * 1000)
}

function getCachedSearch(userId, keyword) {
  const key  = `${userId}:${keyword}`
  const hit  = searchCache.get(key)
  if (!hit) return null
  if (Date.now() - hit.ts > 10 * 60 * 1000) {
    searchCache.delete(key)
    return null
  }
  return hit.results
}

async function handleSearchPage(ctx) {
  // Format callback_data: srch:{page}:{keyword}
  const raw     = ctx.callbackQuery.data
  const match   = raw.match(/^srch:(\d+):(.+)$/)
  if (!match) return ctx.answerCbQuery()

  const page    = parseInt(match[1])
  const keyword = match[2]
  const userId  = ctx.from?.id

  // Ambil dari cache dulu, kalau tidak ada query ulang
  let results = getCachedSearch(userId, keyword)
  if (!results) {
    results = searchTracks(keyword)
    if (results.length) cacheSearch(userId, keyword, results)
  }

  if (!results.length) {
    return ctx.answerCbQuery('❌ Hasil tidak ditemukan.', { show_alert: true })
  }

  const { text, buttons } = buildSearchMessage(results, keyword, page)

  await ctx.editMessageText(text, {
    parse_mode: 'MarkdownV2',
    reply_markup: { inline_keyboard: buttons },
  }).catch(() => {})

  await ctx.answerCbQuery()
}

// ── Callback: user pilih tombol → kirim audio ────────────────────────────────
async function handleSpotifyCallback(ctx) {
  const trackId = ctx.callbackQuery.data.replace('spot:', '')
  const track   = getTrack(trackId)

  await ctx.answerCbQuery()

  if (!track) {
    return ctx.answerCbQuery('❌ Track not found in cache.', { show_alert: true })
  }

  await ctx.replyWithAudio(track.file_id, {
    title:     track.title,
    performer: track.artist,
    thumbnail: track.thumbnail ? { url: track.thumbnail } : undefined,
    message_thread_id: ctx.callbackQuery.message.message_thread_id,
  })
}

// ── URL: download + upload ────────────────────────────────────────────────────
async function handleUrl(ctx, url) {
  const waitMsg = await ctx.reply('_Processing audio, please wait\\.\\.\\._', replyOpts(ctx))

  try {
    const data                     = await api.contentSpotify(url)
    const { data: info, download } = data
    const trackId                  = info.track_id || null
    const safeTitle                = info.title    || 'Track'
    const safeArtist               = info.author   || 'Unknown'

    const audioOpts = buildAudioOpts({ ...info, artist: safeArtist }, ctx)

    // Cache hit — file_id sudah ada, langsung kirim, tidak perlu download
    if (trackId) {
      const cached = getTrack(trackId)
      if (cached) {
        await ctx.replyWithAudio(cached.file_id, audioOpts)
        notify(ctx.telegram,
          `⚡ *Cache hit*\n` +
          `*${escape(cached.title)}* — ${escape(cached.artist)}\n` +
          `👤 @${escape(ctx.from?.username || String(ctx.from?.id))}`
        ).catch(() => {})
        return
      }
    }

    // Sedang diproses user lain — tunggu file_id dari pendingUploads
    if (trackId && pendingUploads.has(trackId)) {
      const fileId = await pendingUploads.get(trackId)
      if (fileId) await ctx.replyWithAudio(fileId, audioOpts)
      return
    }

    const candidates = [download.server_2, download.original, download.server_1].filter(Boolean)

    // Download buffer dulu — ini yang cepat, aman di-await
    let buffer  = null
    let size    = null
    let lastErr = null

    for (const candidate of candidates) {
      try {
        const res = await axios.get(candidate, {
          responseType: 'arraybuffer',
          timeout: 60_000,
          maxRedirects: 5,
        })
        buffer = Buffer.from(res.data)
        size   = buffer.length
        break
      } catch (err) {
        lastErr = err
        logger.warn({ event: 'spotify_download_failed', candidate, msg: err.message })
      }
    }

    if (!buffer) {
      await ctx.reply(
        `\\[ ERROR \\]\nFailed to download track: _${escape(lastErr?.message)}_`,
        replyOpts(ctx)
      )
      return
    }

    // Simpan promise file_id untuk user lain yang request lagu sama
    const key = trackKey(trackId || Date.now().toString(), safeTitle, safeArtist)

    // Resolve dengan file_id supaya pendingUploads bisa dipakai user lain
    let resolveFileId
    const fileIdPromise = new Promise(res => { resolveFileId = res })

    if (trackId) {
      pendingUploads.set(trackId, fileIdPromise)
      fileIdPromise.finally(() => pendingUploads.delete(trackId))
    }

    // Handler selesai setelah delete waitMsg — tidak ada lagi yang di-await
    ;(async () => {
    try {
      const sent   = await ctx.replyWithAudio(
        { source: buffer, filename: `${safeTitle}.mp3` },
        audioOpts
      )
      const fileId = sent?.audio?.file_id

      resolveFileId(fileId)

      if (trackId && fileId) {
        saveTrack({
          track_id:  trackId,
          file_id:   fileId,
          title:     safeTitle,
          artist:    safeArtist,
          duration:  info.duration  || null,
          quality:   info.quality   || null,
          thumbnail: info.thumbnail || null,
          file_size: size,
          r2_url:    null,
        })
        notify(ctx.telegram,
          `🎵 *New track cached*\n` +
          `*${escape(safeTitle)}* — ${escape(safeArtist)}\n` +
          `👤 @${escape(ctx.from?.username || String(ctx.from?.id))}`
        ).catch(() => {})
      }

      // R2 — gagal atau berhasil, user tidak tahu sama sekali
      uploadToR2(buffer, key, 'audio/mpeg', size)
        .then(r2Url => {
          if (trackId && r2Url) updateTrackR2(trackId, r2Url)
          logger.info({ event: 'r2_upload', context: 'public', track: safeTitle })
        })
        .catch(err => {
          // Hanya logger + admin — tidak ada yang ke user
          logger.warn({ event: 'r2_upload_failed', track: safeTitle, msg: err.message })
          notify(ctx.telegram,
            `⚠️ *R2 upload gagal*\n` +
            `*${escape(safeTitle)}* — ${escape(safeArtist)}\n` +
            `_${escape(err.message)}_`
          ).catch(() => {})
        })

    } catch (err) {
      resolveFileId(null)
      // Hanya logger + admin — user tidak dapat pesan error apapun
      logger.error({ event: 'spotify_upload_failed', track: safeTitle, msg: err.message })
      notify(ctx.telegram,
        `❌ *Upload Telegram gagal*\n` +
        `*${escape(safeTitle)}* — ${escape(safeArtist)}\n` +
        `👤 @${escape(ctx.from?.username || String(ctx.from?.id))}\n` +
        `_${escape(err.message)}_`
      ).catch(() => {})
    }
  })()
    // IIFE tidak di-await — handler langsung lanjut ke finally

  } catch (error) {
    await ctx.reply(
      `\\[ ERROR \\]\nFailed to process track: _${escape(error.message)}_`,
      replyOpts(ctx)
    )
  } finally {
    ctx.telegram.deleteMessage(ctx.chat.id, waitMsg.message_id).catch(() => {})
  }
}

// ── Entry point ───────────────────────────────────────────────────────────────
async function handleSpotify(ctx) {
  const arg = ctx.message.text.split(/\s+/).slice(1).join(' ').trim()

  if (!arg) {
    return ctx.reply(
      `\\[ INFO \\]\nPlease provide a song name or a Spotify link\\.\n\n` +
      `*URL Example:*\n\`/spot open\\.spotify\\.com/track/\\.\\.\\.\`\n\n` +
      `*Title Example:*\n\`/spot Dirimu Yang Dulu\``,
      replyOpts(ctx)
    )
  }

  const url = normalizeUrl(arg)
  if (url) {
    await handleUrl(ctx, url)
  } else {
    await handleSearch(ctx, arg)
  }
}

module.exports = { handleSpotify, handleSpotifyCallback, handleSearchPage }