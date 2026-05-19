const fs      = require('fs')
const path    = require('path')
const https   = require('https')
const http    = require('http')
const os      = require('os')
const api     = require('../api/client')
const { escape, normalizeUrl } = require('../formats/utils')

// ---------------------------------------------------------------------------
// Cache file_id — in-memory, per track_id
// Kalau lagu sudah pernah diupload ke Telegram, skip download & upload ulang
// ---------------------------------------------------------------------------
const fileIdCache = new Map()

// ---------------------------------------------------------------------------
// Download file dari URL ke path lokal, ikuti redirect secara rekursif
// ---------------------------------------------------------------------------
function downloadFile(url, destPath, redirectCount = 0) {
  if (redirectCount > 5) return Promise.reject(new Error('Too many redirects'))

  return new Promise((resolve, reject) => {
    const proto = url.startsWith('https') ? https : http
    const file  = fs.createWriteStream(destPath)

    proto.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        file.close()
        fs.unlink(destPath, () => {})
        return downloadFile(res.headers.location, destPath, redirectCount + 1)
          .then(resolve).catch(reject)
      }

      if (res.statusCode !== 200) {
        file.close()
        fs.unlink(destPath, () => {})
        return reject(new Error(`HTTP ${res.statusCode}`))
      }

      res.pipe(file)
      file.on('finish', () => file.close(resolve))
      file.on('error', (err) => {
        fs.unlink(destPath, () => {})
        reject(err)
      })
    }).on('error', (err) => {
      fs.unlink(destPath, () => {})
      reject(err)
    })
  })
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------
async function handleSpotify(ctx) {
  const raw = ctx.message.text.split(/\s+/)[1]
  const url = normalizeUrl(raw)

  if (!url) {
    return ctx.reply('❌ Invalid URL\\. Example: `/spot open\\.spotify\\.com/track/\\.\\.\\.`', {
      parse_mode: 'MarkdownV2',
      message_thread_id: ctx.message.message_thread_id
    })
  }

  const data           = await api.contentSpotify(url)
  const { data: info, download } = data
  const trackId        = info.track_id || null
  const safeTitle      = info.title || 'Track'
  const safeArtist     = info.author || 'Unknown'

  const caption = [
    `🎵 *${escape(safeTitle)}*`,
    ``,
    `👤 *Artist:* ${escape(safeArtist)}`,
    `⏱ *Duration:* ${escape(info.duration || 'N/A')}`,
    `🎚 *Quality:* ${escape(info.quality || 'HQ')}`,
  ].join('\n')

  const audioOpts = {
    caption,
    parse_mode:  'MarkdownV2',
    title:       safeTitle,
    performer:   safeArtist,
    thumbnail:   info.thumbnail ? { url: info.thumbnail } : undefined,
    message_thread_id: ctx.message.message_thread_id,
  }

  // ── Cache hit: kirim ulang pakai file_id tanpa download ──────────────────
  if (trackId && fileIdCache.has(trackId)) {
    await ctx.replyWithAudio(fileIdCache.get(trackId), audioOpts)
    return
  }

  // ── Cache miss: feedback dulu, lalu download ──────────────────────────────
  const waitMsg = await ctx.reply('⏳ Downloading track, please wait\\.\\.\\.', {
    parse_mode: 'MarkdownV2',
    message_thread_id: ctx.message.message_thread_id
  })

  const destPath   = path.join(os.tmpdir(), `${trackId || Date.now()}.mp3`)
  const primaryUrl = download.server_2 || download.original
  const fallbackUrl = download.server_2 ? download.original : null

  try {
    // Download — coba primary, fallback ke original
    try {
      await downloadFile(primaryUrl, destPath)
    } catch {
      if (fallbackUrl) {
        await downloadFile(fallbackUrl, destPath)
      } else {
        throw new Error('All download sources failed')
      }
    }

    // Upload ke Telegram
    const sent = await ctx.replyWithAudio(
      { source: destPath, filename: `${safeTitle}.mp3` },
      audioOpts
    )

    // Simpan file_id ke cache untuk request berikutnya
    if (trackId && sent?.audio?.file_id) {
      fileIdCache.set(trackId, sent.audio.file_id)
    }
  } finally {
    // Hapus file temp & pesan "please wait" apapun hasilnya
    fs.unlink(destPath, () => {})
    ctx.telegram.deleteMessage(ctx.chat.id, waitMsg.message_id).catch(() => {})
  }
}

module.exports = { handleSpotify }