// src/features/dm/dm.handler.js

const { escape, normalizeUrl } = require('../../formats/utils')
const { searchTracks, getTrack, incrementRequestCount } = require('../spotify/spotify.repo')
const { searchFlacTracks, getFlacTrack, incrementFlacRequestCount } = require('../flac/flac.repo')
const { isRateLimited } = require('../../utils/ratelimit')
const api    = require('../../api/client')
const { formatApp } = require('../../formats/app')
const logger = require('../../utils/logger')

const SEARCH_PAGE_SIZE = 5
const SEARCH_CACHE_TTL = 10 * 60 * 1000
const SEARCH_CACHE_MAX = 300

// Cooldown berbeda per command — APK hit external API, lebih mahal
const DM_COOLDOWN = {
  spot: 5_000,
  flac: 5_000,
  apk:  10_000,
}

// ── Cache ─────────────────────────────────────────────────────────────────────

const searchCache = new Map()

function cacheSet(key, results) {
  if (searchCache.size >= SEARCH_CACHE_MAX && !searchCache.has(key)) {
    searchCache.delete(searchCache.keys().next().value)
  }
  searchCache.set(key, { results, ts: Date.now() })
}

function cacheGet(key) {
  const hit = searchCache.get(key)
  if (!hit) return null
  if (Date.now() - hit.ts > SEARCH_CACHE_TTL) {
    searchCache.delete(key)
    return null
  }
  return hit.results
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function replyOpts(extra = {}) {
  return { parse_mode: 'MarkdownV2', ...extra }
}

// Typing indicator — aktif selama handler jalan, auto-stop di finally
function startTyping(ctx) {
  ctx.sendChatAction('typing').catch(() => {})
  const interval = setInterval(() => ctx.sendChatAction('typing').catch(() => {}), 4000)
  return () => clearInterval(interval)
}

// Guard: callback hanya boleh diproses dari private chat
function isPrivateCallback(ctx) {
  return ctx.callbackQuery?.message?.chat?.type === 'private'
}

// ── /start ────────────────────────────────────────────────────────────────────

async function handleDmStart(ctx) {
  if (ctx.chat?.type !== 'private') return
  const name = escape(ctx.from?.first_name || 'there')
  await ctx.reply(
    `👋 *Halo, ${name}\\!*\n\n` +
    `Aku bisa bantu cari lagu dan aplikasi dari koleksi yang ada\\.\n` +
    `_Pencarian hanya via keyword — URL tidak didukung di sini\\._\n\n` +
    `*🎵 Spotify \\(MP3\\)*\n` +
    `\`/spot <judul atau artist>\`\n` +
    `_Contoh:_ \`/spot Daft Punk\`\n\n` +
    `*🎚 FLAC \\(Lossless\\)*\n` +
    `\`/flac <judul atau artist>\`\n` +
    `_Contoh:_ \`/flac Radiohead\`\n\n` +
    `*📱 APK Android*\n` +
    `\`/apk <nama aplikasi>\`\n` +
    `_Contoh:_ \`/apk Spotify\``,
    replyOpts()
  )
}

// ── /spot DM ──────────────────────────────────────────────────────────────────

function buildSpotifyMessage(results, keyword, page) {
  const total  = results.length
  const pages  = Math.ceil(total / SEARCH_PAGE_SIZE)
  const offset = (page - 1) * SEARCH_PAGE_SIZE
  const slice  = results.slice(offset, offset + SEARCH_PAGE_SIZE)

  const audioButtons = slice.map(track => ([{
    text:          `${track.title} — ${track.artist}`,
    callback_data: `dm_spot:${track.track_id}`,
  }]))

  const nav = []
  if (page > 1)     nav.push({ text: '◀️ Prev', callback_data: `dm_srch:${page - 1}:${keyword}` })
  if (page < pages) nav.push({ text: 'Next ▶️', callback_data: `dm_srch:${page + 1}:${keyword}` })

  const buttons = nav.length ? [...audioButtons, nav] : audioButtons

  return {
    text: `\\[ RESULT \\] *${total} found* for _${escape(keyword)}_\n_Halaman ${page}/${pages} — pilih lagu di bawah:_`,
    buttons,
  }
}

async function handleDmSpot(ctx) {
  const arg = ctx.message.text.split(/\s+/).slice(1).join(' ').trim()

  if (!arg) {
    return ctx.reply(
      `\\[ INFO \\]\nMasukkan judul lagu atau nama artist\\.\n\n*Contoh:*\n\`/spot Daft Punk\`\n\`/spot Blinding Lights\``,
      replyOpts()
    )
  }

  if (normalizeUrl(arg)) {
    return ctx.reply(
      `❌ URL tidak didukung di sini\\.\n_Gunakan judul atau nama artist untuk mencari dari koleksi\\._`,
      replyOpts()
    )
  }

  const safeKeyword = arg.slice(0, 40).trim()
  const stopTyping  = startTyping(ctx)

  try {
    const results = searchTracks(safeKeyword)

    if (!results.length) {
      return ctx.reply(
        `\\[ NOT FOUND \\]\nTidak ada lagu untuk: *${escape(arg)}*\n\n_Coba dengan judul atau artist yang berbeda\\._`,
        replyOpts()
      )
    }

    const cacheKey = `cache_spot:${ctx.from?.id}:${safeKeyword}`
    cacheSet(cacheKey, results)

    const { text, buttons } = buildSpotifyMessage(results, safeKeyword, 1)
    await ctx.reply(text, { ...replyOpts(), reply_markup: { inline_keyboard: buttons } })
  } finally {
    stopTyping()
  }
}

// ── /flac DM ──────────────────────────────────────────────────────────────────

function buildFlacMessage(results, keyword, page) {
  const total  = results.length
  const pages  = Math.ceil(total / SEARCH_PAGE_SIZE)
  const offset = (page - 1) * SEARCH_PAGE_SIZE
  const slice  = results.slice(offset, offset + SEARCH_PAGE_SIZE)

  const audioButtons = slice.map(track => ([{
    text:          `${track.title} — ${track.artist}`,
    callback_data: `dm_flac:${track.track_id}`,
  }]))

  const nav = []
  if (page > 1)     nav.push({ text: '◀️ Prev', callback_data: `dm_flacpage:${page - 1}:${keyword}` })
  if (page < pages) nav.push({ text: 'Next ▶️', callback_data: `dm_flacpage:${page + 1}:${keyword}` })

  const buttons = nav.length ? [...audioButtons, nav] : audioButtons

  return {
    text: `\\[ FLAC \\] *${total} found* for _${escape(keyword)}_\n_Halaman ${page}/${pages} — pilih lagu di bawah:_`,
    buttons,
  }
}

async function handleDmFlac(ctx) {
  const arg = ctx.message.text.split(/\s+/).slice(1).join(' ').trim()

  if (!arg) {
    return ctx.reply(
      `\\[ INFO \\]\nMasukkan judul lagu atau nama artist\\.\n\n*Contoh:*\n\`/flac Daft Punk\`\n\`/flac Radiohead\``,
      replyOpts()
    )
  }

  if (normalizeUrl(arg)) {
    return ctx.reply(
      `❌ URL tidak didukung di sini\\.\n_Gunakan judul atau nama artist untuk mencari dari koleksi\\._`,
      replyOpts()
    )
  }

  const safeKeyword = arg.slice(0, 40).trim()
  const stopTyping  = startTyping(ctx)

  try {
    const results = searchFlacTracks(safeKeyword)

    if (!results.length) {
      return ctx.reply(
        `\\[ NOT FOUND \\]\nTidak ada FLAC untuk: *${escape(arg)}*\n\n_Coba dengan judul atau artist yang berbeda\\._`,
        replyOpts()
      )
    }

    const cacheKey = `cache_flac:${ctx.from?.id}:${safeKeyword}`
    cacheSet(cacheKey, results)

    const { text, buttons } = buildFlacMessage(results, safeKeyword, 1)
    await ctx.reply(text, { ...replyOpts(), reply_markup: { inline_keyboard: buttons } })
  } finally {
    stopTyping()
  }
}

// ── /apk DM ───────────────────────────────────────────────────────────────────

async function handleDmApk(ctx) {
  const keyword = ctx.message.text.split(/\s+/).slice(1).join(' ').trim()

  if (keyword.length < 3) {
    return ctx.reply(
      `\\[ INFO \\]\nMasukkan nama aplikasi \\(minimal 3 karakter\\)\\.\n\n*Contoh:*\n\`/apk Spotify\`\n\`/apk YouTube\``,
      replyOpts()
    )
  }

  const stopTyping = startTyping(ctx)

  try {
    const data = await api.appAndroid(keyword)

    if (!data.total || data.total === 0) {
      return ctx.reply(
        `\\[ NOT FOUND \\]\nTidak ada APK untuk: *${escape(keyword)}*`,
        replyOpts()
      )
    }

    for (const app of data.data) {
      const { text, buttons } = formatApp(app)
      if (app.image) {
        await ctx.replyWithPhoto(app.image, {
          caption: text, parse_mode: 'MarkdownV2',
          reply_markup: { inline_keyboard: buttons },
        })
      } else {
        await ctx.reply(text, { ...replyOpts(), reply_markup: { inline_keyboard: buttons } })
      }
    }

    logger.info({ event: 'dm_apk_sent', keyword, userId: ctx.from?.id })

  } catch (err) {
    logger.error({ event: 'dm_apk_error', msg: err.message })

    const apiCode    = err?.response?.data?.code
    const apiMessage = err?.response?.data?.message
    const SAFE_CODES = ['NOT_FOUND', 'BAD_REQUEST', 'RATE_LIMIT']
    const userMsg    = apiCode && SAFE_CODES.includes(apiCode)
      ? escape(apiMessage)
      : 'Terjadi kesalahan\\. Coba lagi nanti\\.'

    await ctx.reply(`❌ ${userMsg}`, replyOpts())
  } finally {
    stopTyping()
  }
}

// ── Callback handlers ─────────────────────────────────────────────────────────

async function handleDmSpotCallback(ctx) {
  // Guard: hanya dari private chat
  if (!isPrivateCallback(ctx)) return ctx.answerCbQuery()

  const trackId = ctx.callbackQuery.data.replace('dm_spot:', '')
  const track   = getTrack(trackId)

  if (!track) return ctx.answerCbQuery('❌ Track tidak ditemukan.', { show_alert: true })

  await ctx.answerCbQuery()
  await ctx.replyWithAudio(track.file_id, {
    title:     track.title,
    performer: track.artist,
    thumbnail: track.thumbnail ? { url: track.thumbnail } : undefined,
  })
  incrementRequestCount(track.track_id)
  logger.info({ event: 'dm_spot_sent', track: track.title, userId: ctx.from?.id })
}

async function handleDmSpotPage(ctx) {
  if (!isPrivateCallback(ctx)) return ctx.answerCbQuery()

  const match = ctx.callbackQuery.data.match(/^dm_srch:(\d+):(.+)$/)
  if (!match) return ctx.answerCbQuery()

  const page     = parseInt(match[1])
  const keyword  = match[2]
  const cacheKey = `cache_spot:${ctx.from?.id}:${keyword}`

  let results = cacheGet(cacheKey)
  if (!results) {
    results = searchTracks(keyword)
    if (results.length) cacheSet(cacheKey, results)
  }

  if (!results.length) return ctx.answerCbQuery('❌ Hasil tidak ditemukan.', { show_alert: true })

  const { text, buttons } = buildSpotifyMessage(results, keyword, page)
  await ctx.editMessageText(text, { parse_mode: 'MarkdownV2', reply_markup: { inline_keyboard: buttons } }).catch(() => {})
  await ctx.answerCbQuery()
}

async function handleDmFlacCallback(ctx) {
  if (!isPrivateCallback(ctx)) return ctx.answerCbQuery()

  const trackId = ctx.callbackQuery.data.replace('dm_flac:', '')
  const track   = getFlacTrack(trackId)

  if (!track) return ctx.answerCbQuery('❌ Track tidak ditemukan.', { show_alert: true })

  await ctx.answerCbQuery()
  await ctx.replyWithAudio(track.file_id, {
    title:     track.title,
    performer: track.artist,
    thumbnail: track.thumbnail ? { url: track.thumbnail } : undefined,
  })
  incrementFlacRequestCount(track.track_id)
  logger.info({ event: 'dm_flac_sent', track: track.title, userId: ctx.from?.id })
}

async function handleDmFlacPage(ctx) {
  if (!isPrivateCallback(ctx)) return ctx.answerCbQuery()

  const match = ctx.callbackQuery.data.match(/^dm_flacpage:(\d+):(.+)$/)
  if (!match) return ctx.answerCbQuery()

  const page     = parseInt(match[1])
  const keyword  = match[2]
  const cacheKey = `cache_flac:${ctx.from?.id}:${keyword}`

  let results = cacheGet(cacheKey)
  if (!results) {
    results = searchFlacTracks(keyword)
    if (results.length) cacheSet(cacheKey, results)
  }

  if (!results.length) return ctx.answerCbQuery('❌ Hasil tidak ditemukan.', { show_alert: true })

  const { text, buttons } = buildFlacMessage(results, keyword, page)
  await ctx.editMessageText(text, { parse_mode: 'MarkdownV2', reply_markup: { inline_keyboard: buttons } }).catch(() => {})
  await ctx.answerCbQuery()
}

// ── DM command router — dipanggil dari createHandler() di index.js ────────────

const DM_COMMANDS = { spot: handleDmSpot, flac: handleDmFlac, apk: handleDmApk }

async function routeDmCommand(ctx, commandName) {
  const cooldown = DM_COOLDOWN[commandName] ?? 5_000
  if (isRateLimited(ctx.from?.id, `dm_${commandName}`, cooldown)) {
    return ctx.reply('⏳ Tunggu sebentar sebelum request berikutnya\\.', replyOpts())
  }
  const handler = DM_COMMANDS[commandName]
  if (!handler) {
    return ctx.reply(
      `❌ Command ini tidak tersedia di sini\\.\n\n` +
      `_Command yang tersedia di DM:_\n` +
      `\`/spot\` — cari lagu MP3\n` +
      `\`/flac\` — cari lagu FLAC\n` +
      `\`/apk\` — cari APK Android`,
      replyOpts()
    )
  }
  return handler(ctx)
}

module.exports = {
  handleDmStart,
  routeDmCommand,
  handleDmSpotCallback,
  handleDmSpotPage,
  handleDmFlacCallback,
  handleDmFlacPage,
}