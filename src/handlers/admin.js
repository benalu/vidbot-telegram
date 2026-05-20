const api = require('../api/client')
const { escape, normalizeUrl }                           = require('../formats/utils')
const { getTrack, saveTrack, deleteTrack,
        listTracks, countTracks, getStats }              = require('../utils/db')
const { uploadToR2, deleteFromR2, trackKey } = require('../utils/r2')

const ADMIN_GROUP  = process.env.TELEGRAM_ADMIN_GROUP_ID
const OWNER_ID     = String(process.env.TELEGRAM_OWNER_ID)
const PAGE_SIZE    = 10

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

  const s          = getStats()
  const lastAdded  = s.last_added
    ? new Date(s.last_added * 1000).toLocaleString('id-ID')
    : 'N/A'

  const topList = s.topArtists
    .map((a, i) => `${i + 1}\\. ${escape(a.artist)} \\(${a.total}\\)`)
    .join('\n')

  await ctx.reply(
    `📊 *Database Stats*\n\n` +
    `🎵 Total tracks: *${s.total_tracks}*\n` +
    `🎤 Total artists: *${s.total_artists}*\n` +
    `🕐 Last added: *${escape(lastAdded)}*\n\n` +
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
    `    ${escape(t.duration || 'N/A')}  ·  ${escape(formatSize(t.file_size))}\n` +
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

  // Cek apakah sudah ada di DB
  const data                     = await api.contentSpotify(url)
  const { data: info, download } = data
  const trackId                  = info.track_id || null

  if (trackId && getTrack(trackId)) {
    return ctx.reply(
      `ℹ️ Track sudah ada di DB:\n*${escape(info.title)}* — ${escape(info.author)}`,
      { parse_mode: 'MarkdownV2' }
    )
  }

  const waitMsg = await ctx.reply('⏳ Downloading and uploading to Telegram\\.\\.\\.', { parse_mode: 'MarkdownV2' })

  // Reuse flow yang sama dengan handleSpotify — stream langsung ke Telegram
  const axios        = require('axios')
  const safeTitle    = info.title  || 'Track'
  const safeArtist   = info.author || 'Unknown'
  const candidates   = [download.server_2, download.original, download.server_1].filter(Boolean)

  let lastErr
  let sent
  let r2Url    = null
  let fileSize = null
  for (const candidate of candidates) {
    try {
      const res    = await axios.get(candidate, { responseType: 'arraybuffer', timeout: 60_000, maxRedirects: 5 })
      const buffer = Buffer.from(res.data)
      fileSize     = buffer.length

      const key            = trackKey(trackId || Date.now().toString(), safeTitle, safeArtist)
      const audioOpts      = {
        title:     safeTitle,
        performer: safeArtist,
        thumbnail: info.thumbnail ? { url: info.thumbnail } : undefined,
      }
      ;[sent, r2Url] = await Promise.all([
        ctx.replyWithAudio({ source: buffer, filename: `${safeTitle}.mp3` }, audioOpts),
        uploadToR2(buffer, key, 'audio/mpeg', fileSize),
      ])
      break
    } catch (err) {
      lastErr = err
    }
  }

  if (!sent) {
    return ctx.reply(`❌ Gagal download: _${escape(lastErr?.message)}_`, { parse_mode: 'MarkdownV2' })
  }

  const fileId = sent?.audio?.file_id
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
      r2_url:    r2Url,
    })
    await ctx.reply(
      `✅ Berhasil ditambahkan:\n*${escape(safeTitle)}* — ${escape(safeArtist)}`,
      { parse_mode: 'MarkdownV2' }
    )
  }
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
    `\`/addtrack <spotify\\_url>\`  — tambah via URL Spotify\n`,
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
}

module.exports = { registerAdminHandlers, notify }