// src/handlers/flacCollection.js
const logger  = require('../utils/logger')
const { escape } = require('../formats/utils')
const { searchFlacTracks, getFlacTrack,
        incrementFlacRequestCount } = require('../utils/flacDb')

const SEARCH_PAGE_SIZE = 5
const SEARCH_CACHE_TTL = 10 * 60 * 1000
const SEARCH_CACHE_MAX = 300
const searchCache      = new Map()

function cacheSearch(userId, keyword, results) {
  const key = `${userId}:${keyword}`
  if (searchCache.size >= SEARCH_CACHE_MAX && !searchCache.has(key)) {
    searchCache.delete(searchCache.keys().next().value)
  }
  searchCache.set(key, { results, ts: Date.now() })
}

function getCachedSearch(userId, keyword) {
  const key = `flac:${userId}:${keyword}`
  const hit = searchCache.get(key)
  if (!hit) return null
  if (Date.now() - hit.ts > SEARCH_CACHE_TTL) {
    searchCache.delete(key)
    return null
  }
  return hit.results
}

function buildSearchMessage(results, keyword, page) {
  const total  = results.length
  const pages  = Math.ceil(total / SEARCH_PAGE_SIZE)
  const offset = (page - 1) * SEARCH_PAGE_SIZE
  const slice  = results.slice(offset, offset + SEARCH_PAGE_SIZE)

  const audioButtons = slice.map(track => ([{
    text:          `${track.title} — ${track.artist}`,
    callback_data: `flac:${track.track_id}`,
  }]))

  const nav = []
  if (page > 1)     nav.push({ text: '◀️ Prev', callback_data: `flacpage:${page - 1}:${keyword}` })
  if (page < pages) nav.push({ text: 'Next ▶️', callback_data: `flacpage:${page + 1}:${keyword}` })

  const buttons = nav.length ? [...audioButtons, nav] : audioButtons

  const text = (
    `\\[ FLAC \\] *${total} found* for _${escape(keyword)}_\n` +
    `_Halaman ${page}/${pages} — pilih lagu di bawah:_`
  )

  return { text, buttons }
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

async function handleFlacCollection(ctx) {
  const arg        = ctx.message.text.split(/\s+/).slice(1).join(' ').trim()
  const safeKeyword = arg.slice(0, 40).trim()

  if (!safeKeyword) {
    return ctx.reply(
      `\\[ INFO \\]\nMasukkan judul atau nama artist\\.\n\n` +
      `*Contoh:*\n\`/flac Daft Punk\`\n\`/flac Radiohead OK Computer\``,
      replyOpts(ctx)
    )
  }

  const results = searchFlacTracks(safeKeyword)

  if (!results.length) {
    return ctx.reply(
      `\\[ NOT FOUND \\]\n` +
      `Tidak ada FLAC untuk: *${escape(arg)}*\n\n` +
      `_Koleksi FLAC diupload manual oleh admin\\._`,
      replyOpts(ctx)
    )
  }

  cacheSearch(ctx.from?.id, safeKeyword, results)
  const { text, buttons } = buildSearchMessage(results, safeKeyword, 1)

  await ctx.reply(text, {
    ...replyOpts(ctx),
    reply_markup: { inline_keyboard: buttons },
  })
}

async function handleFlacSearchPage(ctx) {
  const raw   = ctx.callbackQuery.data
  const match = raw.match(/^flacpage:(\d+):(.+)$/)
  if (!match) return ctx.answerCbQuery()

  const page    = parseInt(match[1])
  const keyword = match[2]
  const userId  = ctx.from?.id

  let results = getCachedSearch(userId, keyword)
  if (!results) {
    results = searchFlacTracks(keyword)
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

async function handleFlacCallback(ctx) {
  const trackId = ctx.callbackQuery.data.replace('flac:', '')
  const track   = getFlacTrack(trackId)

  if (!track) {
    return ctx.answerCbQuery('❌ Track tidak ditemukan.', { show_alert: true })
  }

  await ctx.answerCbQuery()

  await ctx.replyWithAudio(track.file_id, {
    title:             track.title,
    performer:         track.artist,
    thumbnail:         track.thumbnail ? { url: track.thumbnail } : undefined,
    message_thread_id: ctx.callbackQuery.message.message_thread_id,
  })

  incrementFlacRequestCount(track.track_id)
}

module.exports = { handleFlacCollection, handleFlacSearchPage, handleFlacCallback }