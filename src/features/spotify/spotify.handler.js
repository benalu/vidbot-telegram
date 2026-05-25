//src/features/spotify/spotify.handler.js

const axios  = require('axios')
const mm = require('music-metadata')
const api = require('../../api/client')
const logger = require('../../utils/logger')
const { escape, normalizeUrl } = require('../../formats/utils')
const { uploadToR2, trackKey } = require('../../utils/r2')
const { notify } = require('../admin/admin.handler')

const { formatSpotify } = require('./spotify.format')
const { enrichMetadata } = require('../../utils/spotify')
const { 
  getTrack, saveTrack, searchTracks, updateTrackR2,
  incrementRequestCount, getTopTracks, getRandomTrack , findTrackByTitleArtist
} = require('./spotify.repo')
const { syncMp3ToApi } = require('../../utils/api-sync')

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
const SEARCH_CACHE_TTL = 10 * 60 * 1000   // 10 menit
const SEARCH_CACHE_MAX = 300               // max entry, ~300 user aktif

const SEARCH_PAGE_SIZE = 5

const searchCache = new Map()

function cacheSearch(userId, keyword, results) {
  const key = `${userId}:${keyword}`

  // Prune FIFO kalau sudah penuh
  if (searchCache.size >= SEARCH_CACHE_MAX && !searchCache.has(key)) {
    const oldestKey = searchCache.keys().next().value
    searchCache.delete(oldestKey)
  }

  searchCache.set(key, { results, ts: Date.now() })
}

function getCachedSearch(userId, keyword) {
  const key = `${userId}:${keyword}`
  const hit = searchCache.get(key)
  if (!hit) return null
  if (Date.now() - hit.ts > SEARCH_CACHE_TTL) {
    searchCache.delete(key)
    return null
  }
  return hit.results
}

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
      `No results for: *${escape(keyword)}*\n\n` +
      `_Try a different title or artist name, or send a Spotify link to cache it:_\n` +
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

  if (!track) {
    return ctx.answerCbQuery('❌ Track not found in cache.', { show_alert: true })
  }
  await ctx.answerCbQuery()

  const threadId = ctx.callbackQuery.message.message_thread_id
  await sendAudioOrFallback(ctx, track, {
    title:     track.title,
    performer: track.artist,
    thumbnail: track.thumbnail ? { url: track.thumbnail } : undefined,
    message_thread_id: threadId,
  }, threadId)
  incrementRequestCount(track.track_id)
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
        await sendAudioOrFallback(ctx, cached, audioOpts, ctx.message.message_thread_id)
        incrementRequestCount(trackId)
        notify(ctx.telegram,
          `⚡ *Cache hit*\n` +
          `*${escape(cached.title)}* — ${escape(cached.artist)}\n` +
          `👤 @${escape(ctx.from?.username || String(ctx.from?.id))}`
        ).catch(() => {})
        return
      }
    }

    const titleArtistCached = findTrackByTitleArtist(safeTitle, safeArtist)
    if (titleArtistCached) {
      await sendAudioOrFallback(ctx, titleArtistCached, audioOpts, ctx.message.message_thread_id)
      incrementRequestCount(titleArtistCached.track_id)
      return
    }

    // Sedang diproses user lain — tunggu file_id dari pendingUploads
    if (trackId && pendingUploads.has(trackId)) {
      const fileId = await pendingUploads.get(trackId)
      if (fileId) {
        await ctx.replyWithAudio(fileId, audioOpts)
      } else {
        // Upload original gagal — beri tahu user concurrent untuk coba lagi
        await ctx.reply(
          `\\[ ERROR \\]\nFailed to process track \\— please try again\\.`,
          replyOpts(ctx)
        )
      }
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

    // ── Validasi durasi sebelum kirim ke user ─────────────────────────────────
    const expectedSec = parseDurationToSeconds(info.duration)
    if (expectedSec && expectedSec > 30) {
      const actualSec = await parseAudioDuration(buffer)
      if (actualSec !== null && actualSec < expectedSec * 0.7) {
        logger.warn({
          event:    'audio_duration_mismatch',
          track:    safeTitle,
          expected: Math.round(expectedSec),
          actual:   Math.round(actualSec),
        })
        await ctx.reply(
          `\\[ ERROR \\]\nFailed to process track \\- audio file appears incomplete\\.\n` +
          `_Please try again later\\._`,
          replyOpts(ctx)
        )
        return
      }
    }

    // Simpan promise file_id untuk user lain yang request lagu sama
    const key = trackKey(trackId || Date.now().toString(), safeTitle, safeArtist, 'mp3')

    // Resolve dengan file_id supaya pendingUploads bisa dipakai user lain
    let resolveFileId
    const fileIdPromise = new Promise(res => { resolveFileId = res })

    if (trackId) {
      pendingUploads.set(trackId, fileIdPromise)
      fileIdPromise.finally(() => pendingUploads.delete(trackId))
    }

    // Handler selesai setelah delete waitMsg — tidak ada lagi yang di-await
    ;(async () => {
    // Tahap 1: kirim audio ke Telegram — kalau gagal, stop di sini
    let fileId = null
    try {
      const sent = await ctx.replyWithAudio(
        { source: buffer, filename: `${safeTitle}.mp3` },
        audioOpts
      )
      fileId = sent?.audio?.file_id
    } catch (err) {
      logger.error({ event: 'spotify_upload_failed', track: safeTitle, msg: err.message })
      notify(ctx.telegram,
        `❌ *Upload Telegram gagal*\n` +
        `*${escape(safeTitle)}* — ${escape(safeArtist)}\n` +
        `👤 @${escape(ctx.from?.username || String(ctx.from?.id))}\n` +
        `_${escape(err.message)}_`
      ).catch(() => {})
      return 
    } finally {
      resolveFileId(fileId)
    }

  // Tahap 2: simpan ke DB — audio sudah terkirim, error di sini tidak ganggu user
  let enriched = {}
  try {
    enriched = await enrichMetadata(safeTitle, safeArtist)
    logger.info({ event: 'spotify_enrich_ok', track: safeTitle })
  } catch (err) {
    logger.warn({ event: 'spotify_enrich_background_failed', track: safeTitle, msg: err.message })
  }

  if (trackId && fileId) {
    try {
      saveTrack({
        track_id:  trackId,
        file_id:   fileId,
        title:     safeTitle,
        artist:    safeArtist,
        duration:  info.duration  || null,
        quality:   info.quality   || null,
        thumbnail: enriched.thumbnail || info.thumbnail || null,
        file_size: size,
        r2_url:    null,
        type:      'mp3',
        source:    'spotify',
        album:     enriched.album || info.album || null,
        year:      enriched.year  || info.year  || null,
        genre:     enriched.genre || null,
        file_hash: null,
      })
      notify(ctx.telegram,
        `🎵 *New track cached*\n` +
        `*${escape(safeTitle)}* — ${escape(safeArtist)}\n` +
        `👤 @${escape(ctx.from?.username || String(ctx.from?.id))}`
      ).catch(() => {})
    } catch (err) {
      logger.error({ event: 'spotify_save_failed', track: safeTitle, msg: err.message })
    }
  }

  // Tahap 3: R2 upload → sync REST API (data di DB sudah lengkap)
  try {
    const r2Url = await uploadToR2(buffer, key, 'audio/mpeg', size)
    if (trackId && r2Url) {
      updateTrackR2(trackId, r2Url)
      const fullTrack = getTrack(trackId)
      await syncMp3ToApi({ ...fullTrack, r2_url: r2Url })
    }
    logger.info({ event: 'r2_upload', context: 'public', track: safeTitle })
  } catch (err) {
    logger.warn({ event: 'r2_upload_failed', track: safeTitle, msg: err.message })
    notify(ctx.telegram,
      `⚠️ *R2 upload gagal*\n` +
      `*${escape(safeTitle)}* — ${escape(safeArtist)}\n` +
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

// ── Random and Top ─────────────────────────
async function handleRandom(ctx) {
  const track = getRandomTrack()

  if (!track) {
    return ctx.reply(
      `\\[ EMPTY \\]\nKoleksi masih kosong\\. Tambahkan lagu dulu via Spotify link\\!`,
      replyOpts(ctx)
    )
  }

  await ctx.replyWithAudio(track.file_id, {
    title:     track.title,
    performer: track.artist,
    thumbnail: track.thumbnail ? { url: track.thumbnail } : undefined,
    ...replyOpts(ctx),
  })

  incrementRequestCount(track.track_id)
}

async function handleTop(ctx) {
  const tracks = getTopTracks()

  if (!tracks.length) {
    return ctx.reply(
      `\\[ EMPTY \\]\nBelum ada data request\\. Mulai request lagu dulu\\!`,
      replyOpts(ctx)
    )
  }

  const medal = ['🥇', '🥈', '🥉']

  const lines = tracks.map((t, i) => {
    const rank  = medal[i] || `${i + 1}\\. `
    const count = t.request_count || 0
    return `${rank} *${escape(t.title)}* — ${escape(t.artist)}\n` +
           `    ▶️ ${count} request${count !== 1 ? 's' : ''}`
  }).join('\n\n')

  await ctx.reply(
    `🏆 *Top 10 Most Requested*\n\n${lines}`,
    replyOpts(ctx)
  )
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

async function sendAudioOrFallback(ctx, track, audioOpts, threadId) {
  const MAX_TG_SIZE = 50 * 1024 * 1024  // 50 MB

  if (track.file_size && track.file_size > MAX_TG_SIZE) {
    if (track.r2_url) {
      return ctx.reply(
        `🎵 *${escape(track.title)}* — ${escape(track.artist)}\n\n` +
        `_File ini terlalu besar untuk diputar langsung\\._`,
        {
          parse_mode: 'MarkdownV2',
          message_thread_id: threadId,
          reply_markup: {
            inline_keyboard: [[{ text: '⬇️ Download', url: track.r2_url }]]
          }
        }
      )
    }
    return ctx.reply(
      `❌ File tidak tersedia untuk diputar\\. Hubungi admin\\.`,
      { parse_mode: 'MarkdownV2', message_thread_id: threadId }
    )
  }

  return ctx.replyWithAudio(track.file_id, audioOpts)
}

module.exports = { handleSpotify, handleSpotifyCallback, handleSearchPage, handleRandom, handleTop }