// src/features/admin/admin.manage.js

const { escape } = require('../../formats/utils')
const logger = require('../../utils/logger')
const { deleteFromR2 } = require('../../utils/r2')
const { deleteFlacFromApi, deleteMp3FromApi } = require('../../utils/api-sync')

// Import Repository
const { getStats, listTracks, searchTracks, deleteTrack, getTrack } = require('../spotify/spotify.repo')
const { listFlacTracks, getFlacTrack, deleteFlacTrack, getFlacStats } = require('../flac/flac.repo')

const OWNER_ID = String(process.env.TELEGRAM_OWNER_ID)
const PAGE_SIZE = 10

function formatSize(bytes) {
  if (!bytes) return 'N/A'
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

// ── /dbstats ──────────────────────────────────────────────────────────────────
async function handleDbStats(ctx) {
  const mp3  = getStats()       // sudah ada
  const flac = getFlacStats()   // sudah ada di flac.repo, tinggal dipanggil

  const totalTracks  = mp3.total_tracks  + flac.total_tracks
  const totalArtists = new Set([
    ...mp3.topArtists.map(a => a.artist),
    ...flac.topArtists.map(a => a.artist),
  ]).size  // deduplicated — artist yang punya MP3 dan FLAC tidak dihitung dua kali

  const withoutR2    = (mp3.without_r2 || 0) + (flac.without_r2 || 0)
  const r2Count      = totalTracks - withoutR2
  const r2Pct        = totalTracks > 0 ? Math.round((r2Count / totalTracks) * 100) : 0
  const barFilled    = Math.round(r2Pct / 10)
  const bar          = '■'.repeat(barFilled) + '□'.repeat(10 - barFilled)

  const lastAdded = Math.max(mp3.last_added || 0, flac.last_added || 0)
  const lastAddedStr = lastAdded
    ? new Date(lastAdded * 1000).toLocaleString('id-ID')
    : 'N/A'

  // Gabungkan top artists dari keduanya, sort by total, ambil 5 teratas
  const artistMap = new Map()
  for (const a of [...mp3.topArtists, ...flac.topArtists]) {
    artistMap.set(a.artist, (artistMap.get(a.artist) || 0) + a.total)
  }
  const topArtists = [...artistMap.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)

  const topList = topArtists
    .map(([artist, total], i) => `${i + 1}\\. ${escape(artist)} \\(${total}\\)`)
    .join('\n')

  await ctx.reply(
    `📊 *Database Stats*\n\n` +
    `🎵 Total tracks: *${totalTracks}* \\(${mp3.total_tracks} MP3 \\+ ${flac.total_tracks} FLAC\\)\n` +
    `🎤 Total artists: *${totalArtists}*\n` +
    `🕐 Last added: *${escape(lastAddedStr)}*\n\n` +
    `*R2 Coverage*\n` +
    `\`${bar}\` ${r2Pct}%\n` +
    `☁️ ${r2Count} / ${totalTracks} tracks\n\n` +
    `*Top Artists:*\n${topList}`,
    { parse_mode: 'MarkdownV2' }
  )
}

// ── /listtrack [page] ─────────────────────────────────────────────────────────
function buildTrackListMessage(page) {
  const allMp3  = listTracks(9999, 0).map(t => ({ ...t, _db: 'mp3' }))
  const allFlac = listFlacTracks(9999, 0).map(t => ({ ...t, _db: 'flac' }))

  const all   = [...allMp3, ...allFlac]
    .sort((a, b) => {
      const byArtist = (a.artist || '').localeCompare(b.artist || '')
      return byArtist !== 0 ? byArtist : (a.title || '').localeCompare(b.title || '')
    })

  const total  = all.length
  const pages  = Math.ceil(total / PAGE_SIZE)
  const offset = (page - 1) * PAGE_SIZE
  const tracks = all.slice(offset, offset + PAGE_SIZE)

  if (!tracks.length) return { text: null, buttons: null, pages: 0 }

  const lines = tracks.map((t, i) => {
    const badge = t._db === 'flac' ? '🎚 FLAC' : '🎵 MP3'
    return (
      `${offset + i + 1}\\. *${escape(t.title)}* — ${escape(t.artist)}\n` +
      `    ${escape(t.duration || 'N/A')}  ·  ${escape(formatSize(t.file_size))}  ·  ${badge}  ·  ${t.r2_url ? '☁️' : '❌'}\n` +
      `    \`${t.track_id}\``
    )
  }).join('\n\n')

  const text = (
    `🎵 *Track List* \\(page ${page}/${pages}\\)\n\n` +
    `${lines}\n\n` +
    `_Total: ${total} tracks \\(${allMp3.length} MP3 \\+ ${allFlac.length} FLAC\\)_`
  )

  const nav = []
  if (page > 1)     nav.push({ text: '◀️ Prev', callback_data: `lt:${page - 1}` })
  if (page < pages) nav.push({ text: 'Next ▶️', callback_data: `lt:${page + 1}` })

  return { text, buttons: nav.length ? [nav] : [], pages }
}

async function handleListTrack(ctx) {
  const arg  = ctx.message.text.split(/\s+/)[1]
  const page = Math.max(1, parseInt(arg) || 1)

  const { text, buttons } = buildTrackListMessage(page)

  if (!text) {
    return ctx.reply('❌ Database kosong\\.', { parse_mode: 'MarkdownV2' })
  }

  await ctx.reply(text, {
    parse_mode: 'MarkdownV2',
    reply_markup: { inline_keyboard: buttons }
  })
}

async function handleListTrackPage(ctx) {
  const page = parseInt(ctx.callbackQuery.data.replace('lt:', ''))
  if (!page || isNaN(page)) return ctx.answerCbQuery()

  // Pastikan hanya owner yang bisa navigasi
  const userId = String(ctx.from?.id)
  if (userId !== OWNER_ID) {
    return ctx.answerCbQuery('❌ Tidak diizinkan.', { show_alert: true })
  }

  const { text, buttons } = buildTrackListMessage(page)

  if (!text) {
    return ctx.answerCbQuery('❌ Halaman tidak ditemukan.', { show_alert: true })
  }

  await ctx.editMessageText(text, {
    parse_mode: 'MarkdownV2',
    reply_markup: { inline_keyboard: buttons }
  }).catch(() => {})

  await ctx.answerCbQuery()
}

// ── /findtrack <keyword> ──────────────────────────────────────────────────────
async function handleFindTrack(ctx) {
  const keyword = ctx.message.text.split(/\s+/).slice(1).join(' ').trim()
  if (!keyword) return ctx.reply('❌ Masukkan keyword\\.', { parse_mode: 'MarkdownV2' })

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
  const trackId = ctx.message.text.split(/\s+/)[1]
  if (!trackId) return ctx.reply('❌ Masukkan track\\_id\\.', { parse_mode: 'MarkdownV2' })

  let track  = getTrack(trackId)
  let isFlac = false

  if (!track) {
    track  = getFlacTrack(trackId)
    isFlac = true
  }

  if (!track) return ctx.reply(`❌ Track \`${trackId}\` tidak ditemukan\\.`, { parse_mode: 'MarkdownV2' })

  const deleted = isFlac ? deleteFlacTrack(trackId) : deleteTrack(trackId)
  
    if (deleted) {
    if (track.r2_url) {
      const key = track.r2_url.replace(`${process.env.R2_PUBLIC_URL}/`, '')
      deleteFromR2(key).catch(err => logger.warn({ event: 'r2_delete_failed', track_id: trackId, msg: err.message }))
    }

    // Hapus dari REST API (fire and forget — tidak boleh block reply ke admin)
    const deleteFn = isFlac ? deleteFlacFromApi : deleteMp3FromApi
    deleteFn(trackId)

    await ctx.reply(
      `✅ Dihapus dari DB, R2, dan REST API:\n*${escape(track.title)}* — ${escape(track.artist)}`,
      { parse_mode: 'MarkdownV2' }
    )
  } else {
      await ctx.reply('❌ Gagal menghapus\\.', { parse_mode: 'MarkdownV2' })
    }
  }

module.exports = {
  handleDbStats,
  handleListTrack,
  handleListTrackPage,
  handleFindTrack,
  handleDelTrack
}