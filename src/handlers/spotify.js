const axios = require('axios')
const api   = require('../api/client')
const { escape, normalizeUrl }              = require('../formats/utils')
const { getTrack, saveTrack, searchTracks } = require('../utils/db')
const { uploadToR2, trackKey } = require('../utils/r2')
const { notify } = require('./admin')

const pendingUploads = new Map()


async function getStreamWithSize(url) {
  const res = await axios.get(url, {
    responseType: 'stream',
    timeout: 60_000,
    maxRedirects: 5,
  })
  const size = parseInt(res.headers['content-length']) || null
  return { stream: res.data, size }
}
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
async function handleSearch(ctx, keyword) {
  const results = searchTracks(keyword)

  if (!results.length) {
    return ctx.reply(
      `\\[ NOT FOUND \\]\n` +
      `No cached songs found for: *${escape(keyword)}*\n\n` +
      `_The collection is still empty\\. Send a Spotify track link first:_\n` +
      `\`/spot open\\.spotify\\.com/track/\\.\\.\\.\``,
      replyOpts(ctx)
    )
  }

  // Satu tombol per baris: "Judul — Artist"
  const buttons = results.map(track => ([{
    text:          `${track.title} — ${track.artist}`,
    callback_data: `spot:${track.track_id}`,
  }]))

  await ctx.reply(
    `\\[ RESULT \\] *${results.length} found* for _${escape(keyword)}_\n_Pilih lagu di bawah:_`,
    {
      ...replyOpts(ctx),
      reply_markup: { inline_keyboard: buttons },
    }
  )
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

    // Cache hit
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

    // Sedang diproses user lain
    if (trackId && pendingUploads.has(trackId)) {
      const fileId = await pendingUploads.get(trackId)
      await ctx.replyWithAudio(fileId, audioOpts)
      return
    }

    const candidates = [download.server_2, download.original, download.server_1].filter(Boolean)

    const uploadPromise = (async () => {
    let lastErr
    for (const candidate of candidates) {
      try {
        // Download ke buffer sekali — dipakai untuk Telegram + R2 sekaligus
        const res    = await axios.get(candidate, { responseType: 'arraybuffer', timeout: 60_000, maxRedirects: 5 })
        const buffer = Buffer.from(res.data)
        const size   = buffer.length

        // Upload ke Telegram + R2 paralel
        const key  = trackKey(trackId || Date.now().toString(), safeTitle, safeArtist)

        // 1. Telegram dulu — ini yang user tunggu
        const sent   = await ctx.replyWithAudio(
          { source: buffer, filename: `${safeTitle}.mp3` },
          audioOpts
        )
        const fileId = sent?.audio?.file_id

        // 2. Simpan DB segera dengan r2_url null dulu
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
            r2_url:    null,           // diisi setelah R2 selesai
          })
          notify(ctx.telegram,
            `🎵 *New track cached*\n` +
            `*${escape(safeTitle)}* — ${escape(safeArtist)}\n` +
            `👤 @${escape(ctx.from?.username || String(ctx.from?.id))}`
          ).catch(() => {})
        }

        // 3. R2 di background — tidak diawait, tidak blokir response
        uploadToR2(buffer, key, 'audio/mpeg', size)
          .then(r2Url => {
            if (trackId && r2Url) {
              // Update kolom r2_url setelah upload selesai
              updateTrackR2(trackId, r2Url)
              console.log(`[r2] uploaded: ${r2Url}`)
            }
          })
          .catch(err => console.warn(`[r2] background upload failed: ${err.message}`))

        return fileId
      } catch (err) {
        lastErr = err
        console.warn(`[spotify] failed: ${candidate} — ${err.message}`)
      }
    }
    throw new Error(`All sources failed: ${lastErr.message}`)
  })()

    if (trackId) {
      pendingUploads.set(trackId, uploadPromise)
      uploadPromise.finally(() => pendingUploads.delete(trackId))
    }

    await uploadPromise

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

module.exports = { handleSpotify, handleSpotifyCallback }