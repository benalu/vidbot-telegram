const api = require('../api/client')
const { escape, normalizeUrl }                           = require('../formats/utils')
const { getTrack, saveTrack, deleteTrack,
        listTracks, countTracks, getStats,
        updateTrackR2 }                                  = require('../utils/db')
const { uploadToR2, deleteFromR2, trackKey } = require('../utils/r2')

const ADMIN_GROUP  = process.env.TELEGRAM_ADMIN_GROUP_ID
const OWNER_ID     = String(process.env.TELEGRAM_OWNER_ID)
const PAGE_SIZE    = 10

let isSyncing = false

// Tunggu input berikutnya dari owner — simpan state per chat
const awaitingInput = new Map()

function formatSize(bytes) {
  if (!bytes) return 'N/A'
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

// ── Guard: hanya owner di admin grup ─────────────────────────────────────────
function isAdmin(ctx) {
  const chatId = String(ctx.chat?.id)
  const userId = String(ctx.from?.id)
  return chatId === String(ADMIN_GROUP) && userId === OWNER_ID
}

// ── Notify ke admin grup (dipanggil dari handler lain) ────────────────────────
async function notify(bot, text) {
  await bot.telegram.sendMessage(ADMIN_GROUP, text, { parse_mode: 'MarkdownV2' }).catch(() => {})
}

// ── /dbstats ──────────────────────────────────────────────────────────────────
async function handleDbStats(ctx) {
  if (!isAdmin(ctx)) return

  const s         = getStats()
  const lastAdded = s.last_added
    ? new Date(s.last_added * 1000).toLocaleString('id-ID')
    : 'N/A'

  const r2Count   = s.total_tracks - (s.without_r2 || 0)
  const r2Pct     = s.total_tracks > 0
    ? Math.round((r2Count / s.total_tracks) * 100)
    : 0
  const barFilled = Math.round(r2Pct / 10)
  const bar       = '■'.repeat(barFilled) + '□'.repeat(10 - barFilled)

  const topList = s.topArtists
    .map((a, i) => `${i + 1}\\. ${escape(a.artist)} \\(${a.total}\\)`)
    .join('\n')

  await ctx.reply(
    `📊 *Database Stats*\n\n` +
    `🎵 Total tracks: *${s.total_tracks}*\n` +
    `🎤 Total artists: *${s.total_artists}*\n` +
    `🕐 Last added: *${escape(lastAdded)}*\n\n` +
    `*R2 Coverage*\n` +
    `\`${bar}\` ${r2Pct}%\n` +
    `☁️ ${r2Count} / ${s.total_tracks} tracks\n\n` +
    `*Top Artists:*\n${topList}`,
    { parse_mode: 'MarkdownV2' }
  )
}

// ── /listtrack [page] ─────────────────────────────────────────────────────────
async function handleListTrack(ctx) {
  if (!isAdmin(ctx)) return

  const arg    = ctx.message.text.split(/\s+/)[1]
  const page   = Math.max(1, parseInt(arg) || 1)
  const offset = (page - 1) * PAGE_SIZE
  const total  = countTracks()
  const tracks = listTracks(PAGE_SIZE, offset)
  const pages  = Math.ceil(total / PAGE_SIZE)

  if (!tracks.length) {
    return ctx.reply('❌ Database kosong\\.', { parse_mode: 'MarkdownV2' })
  }

  const lines = tracks.map((t, i) =>
  `${offset + i + 1}\\. *${escape(t.title)}* — ${escape(t.artist)}\n` +
  `    ${escape(t.duration || 'N/A')}  ·  ${escape(formatSize(t.file_size))}  ·  ${t.r2_url ? '☁️ R2' : '❌ No R2'}\n` +
  `    \`${t.track_id}\``
).join('\n\n')

  await ctx.reply(
    `🎵 *Track List* \\(page ${page}/${pages}\\)\n\n${lines}\n\n` +
    `_Total: ${total} tracks_`,
    { parse_mode: 'MarkdownV2' }
  )
}

// ── /findtrack <keyword> ──────────────────────────────────────────────────────
async function handleFindTrack(ctx) {
  if (!isAdmin(ctx)) return

  const keyword = ctx.message.text.split(/\s+/).slice(1).join(' ').trim()
  if (!keyword) return ctx.reply('❌ Masukkan keyword\\.', { parse_mode: 'MarkdownV2' })

  const { searchTracks } = require('../utils/db')
  const results = searchTracks(keyword)

  if (!results.length) {
    return ctx.reply(`❌ Tidak ditemukan: *${escape(keyword)}*`, { parse_mode: 'MarkdownV2' })
  }

   const lines = results.map((t, i) =>
    `${i + 1}\\. *${escape(t.title)}* — ${escape(t.artist)}\n` +
    `    ${escape(t.duration || 'N/A')}  ·  ${escape(t.quality || 'N/A')}  ·  ${escape(formatSize(t.file_size))}\n` +
    `    \`${t.track_id}\``
  ).join('\n\n')

  await ctx.reply(
    `*Find:* _${escape(keyword)}_ \\(${results.length} results\\)\n\n${lines}`,
    { parse_mode: 'MarkdownV2' }
  )
}

// ── /deltrack <track_id> ──────────────────────────────────────────────────────
async function handleDelTrack(ctx) {
  if (!isAdmin(ctx)) return

  const trackId = ctx.message.text.split(/\s+/)[1]
  if (!trackId) return ctx.reply('❌ Masukkan track\\_id\\.', { parse_mode: 'MarkdownV2' })

  const track = getTrack(trackId)
  if (!track) return ctx.reply(`❌ Track \`${trackId}\` tidak ditemukan\\.`, { parse_mode: 'MarkdownV2' })

   const deleted = deleteTrack(trackId)
  if (deleted) {
    // Hapus dari R2 kalau ada
    if (track.r2_url) {
      const key = track.r2_url.replace(`${process.env.R2_PUBLIC_URL}/`, '')
      deleteFromR2(key).catch(err => console.warn(`[r2] delete failed: ${err.message}`))
    }
    await ctx.reply(
      `✅ Dihapus dari DB dan R2:\n*${escape(track.title)}* — ${escape(track.artist)}`,
      { parse_mode: 'MarkdownV2' }
    )
  } else {
    await ctx.reply('❌ Gagal menghapus\\.', { parse_mode: 'MarkdownV2' })
  }
}

// ── /addtrack <spotify_url> ───────────────────────────────────────────────────
async function handleAddTrack(ctx) {
  if (!isAdmin(ctx)) return

  const raw = ctx.message.text.split(/\s+/)[1]
  const url = normalizeUrl(raw)

  if (!url) {
    return ctx.reply(
      '❌ Masukkan URL Spotify yang valid\\.\n`/addtrack open\\.spotify\\.com/track/\\.\\.\\.`',
      { parse_mode: 'MarkdownV2' }
    )
  }

  const data                     = await api.contentSpotify(url)
  const { data: info, download } = data
  const trackId                  = info.track_id || null

  if (trackId && getTrack(trackId)) {
    return ctx.reply(
      `ℹ️ Track sudah ada di DB:\n*${escape(info.title)}* — ${escape(info.author)}`,
      { parse_mode: 'MarkdownV2' }
    )
  }

  const axios      = require('axios')
  const safeTitle  = info.title  || 'Track'
  const safeArtist = info.author || 'Unknown'
  const candidates = [download.server_2, download.original, download.server_1].filter(Boolean)

  // 1. Download buffer dulu — ini yang cepat, aman di-await
  let buffer   = null
  let fileSize = null
  let lastErr  = null

  for (const candidate of candidates) {
    try {
      const res = await axios.get(candidate, {
        responseType: 'arraybuffer',
        timeout: 60_000,
        maxRedirects: 5,
      })
      buffer   = Buffer.from(res.data)
      fileSize = buffer.length
      break
    } catch (err) {
      lastErr = err
      console.warn(`[addtrack] download failed: ${candidate} — ${err.message}`)
    }
  }

  if (!buffer) {
    return ctx.reply(
      `❌ Gagal download: _${escape(lastErr?.message)}_`,
      { parse_mode: 'MarkdownV2' }
    )
  }

  // 2. Konfirmasi ke admin langsung — handler selesai di sini, tidak ada timeout
  await ctx.reply(
    `⏳ Download selesai \\(${(fileSize / 1024).toFixed(0)} KB\\)\\. Uploading ke Telegram di background\\.\\.\\.`,
    { parse_mode: 'MarkdownV2' }
  )

  // 3. Upload Telegram + R2 + simpan DB — semua background, tidak blokir handler
  const key      = trackKey(trackId || Date.now().toString(), safeTitle, safeArtist)
  const audioOpts = {
    title:     safeTitle,
    performer: safeArtist,
    thumbnail: info.thumbnail ? { url: info.thumbnail } : undefined,
  }

  ;(async () => {
    try {
      // Upload ke Telegram — bisa lama, tapi tidak ada yang menunggu
      const sent   = await ctx.replyWithAudio(
        { source: buffer, filename: `${safeTitle}.mp3` },
        audioOpts
      )
      const fileId = sent?.audio?.file_id

      // Simpan DB segera setelah dapat file_id
      if (trackId && fileId) {
        saveTrack({
          track_id:  trackId,
          file_id:   fileId,
          title:     safeTitle,
          artist:    safeArtist,
          duration:  info.duration  || null,
          quality:   info.quality   || null,
          thumbnail: info.thumbnail || null,
          file_size: fileSize,
          r2_url:    null,
        })
        await ctx.reply(
          `✅ Berhasil ditambahkan:\n*${escape(safeTitle)}* — ${escape(safeArtist)}`,
          { parse_mode: 'MarkdownV2' }
        )
      }

      // R2 setelah Telegram selesai
      uploadToR2(buffer, key, 'audio/mpeg', fileSize)
        .then(r2Url => {
          if (trackId && r2Url) updateTrackR2(trackId, r2Url)
          console.log(`[r2] admin upload ok: ${r2Url}`)
        })
        .catch(err => console.warn(`[r2] admin background upload failed: ${err.message}`))

    } catch (err) {
      console.error(`[addtrack] background upload error: ${err.message}`)
      ctx.reply(
        `❌ Upload ke Telegram gagal: _${escape(err.message)}_`,
        { parse_mode: 'MarkdownV2' }
      ).catch(() => {})
    }
  })()
  // Fungsi async IIFE di atas tidak di-await — handler langsung return di sini
}

// ── /syncr2 ───────────────────────────────────────────────────────────────────
async function handleSyncR2(ctx) {
  if (!isAdmin(ctx)) return

  if (isSyncing) {
    return ctx.reply('⏳ Sync sedang berjalan\\. Tunggu sampai selesai\\.', { parse_mode: 'MarkdownV2' })
  }

  const { listTracksWithoutR2 } = require('../utils/db')
  const axios = require('axios')

  const tracks = listTracksWithoutR2()

  if (!tracks.length) {
    return ctx.reply('✅ Semua track sudah ada di R2\\.', { parse_mode: 'MarkdownV2' })
  }

  // Kirim pesan awal — akan di-edit sebagai progress bar
  const progressMsg = await ctx.reply(
    `☁️ *Sync R2*\n\n` +
    `${tracks.length} track belum di R2\\. Memulai sync\\.\\.\\.`,
    { parse_mode: 'MarkdownV2' }
  )

  // Fungsi render teks progress bar
  function renderProgress(current, total, success, failed, currentTrack) {
    const pct       = total > 0 ? Math.round((current / total) * 100) : 0
    const filled    = Math.round(pct / 10)
    const bar       = '■'.repeat(filled) + '□'.repeat(10 - filled)
    const trackLine = currentTrack
      ? `\n📀 _${escape(currentTrack.title)} — ${escape(currentTrack.artist)}_`
      : ''

    return (
      `☁️ *Sync R2*\n\n` +
      `\`${bar}\` ${pct}%\n` +
      `${current} / ${total} diproses${trackLine}\n\n` +
      `✅ Berhasil: *${success}*\n` +
      `❌ Gagal: *${failed}*`
    )
  }

  // Edit progress message — swallow error kalau pesan sudah terlalu lama
  async function updateProgress(current, total, success, failed, currentTrack) {
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      progressMsg.message_id,
      undefined,
      renderProgress(current, total, success, failed, currentTrack),
      { parse_mode: 'MarkdownV2' }
    ).catch(() => {})
  }

  // Background IIFE — tidak blokir handler, tidak ada timeout risk
  ;(async () => {
    isSyncing    = true
    let success  = 0
    let failed   = 0
    const total  = tracks.length
    const BATCH  = 5  // update progress setiap N track

    try {
      for (let i = 0; i < tracks.length; i++) {
        const track = tracks[i]

        // Update progress di awal tiap track
        if (i % BATCH === 0) {
          await updateProgress(i, total, success, failed, track)
        }

        try {
          const fileLink = await ctx.telegram.getFileLink(track.file_id)
          const url      = fileLink.href

          const res    = await axios.get(url, { responseType: 'arraybuffer', timeout: 60_000 })
          const buffer = Buffer.from(res.data)
          const size   = buffer.length

          const key   = trackKey(track.track_id, track.title || 'Track', track.artist || 'Unknown')
          const r2Url = await uploadToR2(buffer, key, 'audio/mpeg', size)

          updateTrackR2(track.track_id, r2Url)
          success++
          console.log(`[syncr2] ok (${i + 1}/${total}): ${track.title} — ${track.artist}`)
        } catch (err) {
          failed++
          console.warn(`[syncr2] failed: ${track.track_id} — ${err.message}`)
        }
      }

      // Update final
      await updateProgress(total, total, success, failed, null)

      await ctx.reply(
        `☁️ *Sync R2 Selesai*\n\n` +
        `✅ Berhasil: *${success}*\n` +
        `❌ Gagal: *${failed}*\n` +
        `${failed > 0 ? '_Jalankan /syncr2 lagi untuk retry yang gagal\\._' : '_Semua track sudah tersimpan di R2\\._'}`,
        { parse_mode: 'MarkdownV2' }
      )
    } finally {
      isSyncing = false
    }
  })()
}


// ── /help admin ───────────────────────────────────────────────────────────────
async function handleAdminHelp(ctx) {
  if (!isAdmin(ctx)) return

  await ctx.reply(
    `🛠 *Admin Panel*\n\n` +
    `*Database*\n` +
    `\`/dbstats\`  — statistik database\n` +
    `\`/listtrack [page]\`  — daftar semua lagu\n` +
    `\`/findtrack <keyword>\`  — cari lagu di DB\n` +
    `\`/deltrack <track\\_id>\`  — hapus lagu dari DB\n\n` +
    `*Tambah Koleksi*\n` +
    `\`/addtrack <spotify\\_url>\`  — tambah via URL Spotify\n\n` +
    `*R2 Storage*\n` +
    `\`/syncr2\`  — upload semua track yang belum ada di R2\n`,
    { parse_mode: 'MarkdownV2' }
  )
}

// ── Register semua handler ke bot ─────────────────────────────────────────────
function registerAdminHandlers(bot) {
  bot.command('adminhelp',  handleAdminHelp)
  bot.command('dbstats',    handleDbStats)
  bot.command('listtrack',  handleListTrack)
  bot.command('findtrack',  handleFindTrack)
  bot.command('deltrack',   handleDelTrack)
  bot.command('addtrack',   handleAddTrack)
  bot.command('syncr2',     handleSyncR2)
}

module.exports = { registerAdminHandlers, notify }