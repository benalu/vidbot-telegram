// src/features/dm/dm.handler.js
//
// Handler untuk private chat (DM langsung ke bot).
// Support: Spotify (search by keyword dari koleksi DB), FLAC, APK.

const logger = require('../../utils/logger')
const { escape } = require('../../formats/utils')
const { isRateLimited } = require('../../utils/ratelimit')

const { handleFlacCollection } = require('../flac/flac.handler')
const { handleAppAndroid }     = require('../../handlers/app')

const {
  searchTracks, getTrack, incrementRequestCount,
} = require('../spotify/spotify.repo')

// ── Konstanta ─────────────────────────────────────────────────────────────────

const MENU_TEXT =
  `👋 *Halo\\!* Selamat datang di VidOpsBot\\.\n\n` +
  `Pilih fitur yang ingin kamu gunakan:`

const MENU_BUTTONS = {
  inline_keyboard: [
    [{ text: '🎵 Spotify', callback_data: 'dm:menu:spot' }],
    [{ text: '🎚 FLAC',    callback_data: 'dm:menu:flac' }],
    [{ text: '📦 APK',     callback_data: 'dm:menu:apk'  }],
  ],
}

const FEATURE_HINTS = {
  spot: `🎵 *Spotify*\n\nCari lagu dari koleksi dengan nama lagu atau artist\\.\n\n*Contoh:*\n\`/spot Dirimu Yang Dulu\`\n\`/spot Nadhif Basalamah\``,
  flac: `🎚 *FLAC*\n\nKirim nama lagu atau artist\\.\n\n*Contoh:*\n\`/flac Daft Punk\`\n\`/flac Radiohead OK Computer\``,
  apk:  `📦 *APK*\n\nKirim nama aplikasi Android\\.\n\n*Contoh:*\n\`/apk Spotify\`\n\`/apk YouTube\``,
}

const SEARCH_PAGE_SIZE = 5

// ── Helpers ───────────────────────────────────────────────────────────────────

function isPrivateChat(ctx) {
  return ctx.chat?.type === 'private'
}

function replyOpts(extra = {}) {
  return { parse_mode: 'MarkdownV2', ...extra }
}

function buildSearchMessage(results, keyword, page) {
  const total  = results.length
  const pages  = Math.ceil(total / SEARCH_PAGE_SIZE)
  const offset = (page - 1) * SEARCH_PAGE_SIZE
  const slice  = results.slice(offset, offset + SEARCH_PAGE_SIZE)

  const audioButtons = slice.map(track => ([{
    text:          `${track.title} — ${track.artist}`,
    callback_data: `dm:spot:${track.track_id}`,
  }]))

  const nav = []
  if (page > 1)     nav.push({ text: '◀️ Prev', callback_data: `dm:srch:${page - 1}:${keyword}` })
  if (page < pages) nav.push({ text: 'Next ▶️', callback_data: `dm:srch:${page + 1}:${keyword}` })

  return {
    text:    `\\[ RESULT \\] *${total} found* for _${escape(keyword)}_\n_Halaman ${page}/${pages} — pilih lagu di bawah:_`,
    buttons: nav.length ? [...audioButtons, nav] : audioButtons,
  }
}

// ── Spotify DM — search only ──────────────────────────────────────────────────

async function handleDmSpotify(ctx) {
  const keyword = ctx.message.text.split(/\s+/).slice(1).join(' ').trim()

  if (!keyword) {
    return ctx.reply(
      `🎵 *Spotify*\n\nCari lagu dari koleksi dengan nama lagu atau artist\\.\n\n` +
      `*Contoh:*\n\`/spot Dirimu Yang Dulu\`\n\`/spot Nadhif Basalamah\``,
      replyOpts()
    )
  }

  const safeKeyword = keyword.slice(0, 40).trim()
  const results     = searchTracks(safeKeyword)

  if (!results.length) {
    return ctx.reply(
      `\\[ NOT FOUND \\]\nTidak ada lagu untuk: *${escape(keyword)}*`,
      replyOpts()
    )
  }

  const { text, buttons } = buildSearchMessage(results, safeKeyword, 1)
  await ctx.reply(text, replyOpts({ reply_markup: { inline_keyboard: buttons } }))
}

async function handleDmSpotifyCallback(ctx) {
  const trackId = ctx.callbackQuery.data.replace('dm:spot:', '')
  const track   = getTrack(trackId)

  if (!track) return ctx.answerCbQuery('❌ Track tidak ditemukan.', { show_alert: true })

  await ctx.answerCbQuery()
  await ctx.replyWithAudio(track.file_id, {
    title:     track.title,
    performer: track.artist,
    thumbnail: track.thumbnail ? { url: track.thumbnail } : undefined,
  })
  incrementRequestCount(track.track_id)
}

async function handleDmSearchPage(ctx) {
  const match = ctx.callbackQuery.data.match(/^dm:srch:(\d+):(.+)$/)
  if (!match) return ctx.answerCbQuery()

  const page    = parseInt(match[1])
  const keyword = match[2]
  const results = searchTracks(keyword)

  if (!results.length) return ctx.answerCbQuery('❌ Hasil tidak ditemukan.', { show_alert: true })

  const { text, buttons } = buildSearchMessage(results, keyword, page)
  await ctx.editMessageText(text, replyOpts({ reply_markup: { inline_keyboard: buttons } })).catch(() => {})
  await ctx.answerCbQuery()
}

// ── FLAC dan APK — patch ctx agar handler grup berjalan di DM ────────────────

function patchCtxForDm(ctx) {
  if (ctx.message) {
    ctx.message = { ...ctx.message, message_thread_id: undefined }
  }
}

async function handleDmFlac(ctx) {
  patchCtxForDm(ctx)
  await handleFlacCollection(ctx)
}

async function handleDmApk(ctx) {
  patchCtxForDm(ctx)
  await handleAppAndroid(ctx)
}

// ── Rate limit wrapper ────────────────────────────────────────────────────────

function withRateLimit(commandName, handler) {
  return async (ctx) => {
    if (!isPrivateChat(ctx)) return

    if (isRateLimited(ctx.from?.id, `dm:${commandName}`)) {
      return ctx.reply('⏳ Please wait a moment before sending another request\\.', replyOpts())
    }

    const typingInterval = setInterval(() => ctx.sendChatAction('typing').catch(() => {}), 4000)
    await ctx.sendChatAction('typing').catch(() => {})

    const start = Date.now()
    try {
      await handler(ctx)
      logger.info({ cmd: `dm:${commandName}`, userId: ctx.from?.id, ms: Date.now() - start, status: 'ok' })
    } catch (err) {
      const apiCode    = err?.response?.data?.code
      const apiMessage = err?.response?.data?.message
      const SAFE_CODES = ['NOT_FOUND', 'BAD_REQUEST', 'RATE_LIMIT']
      const msg        = apiCode && SAFE_CODES.includes(apiCode) ? escape(apiMessage) : 'Something went wrong\\. Please try again later\\.'
      logger.error({ cmd: `dm:${commandName}`, userId: ctx.from?.id, ms: Date.now() - start, status: 'error', msg: err.message })
      await ctx.reply(`❌ ${msg}`, replyOpts()).catch(() => {})
    } finally {
      clearInterval(typingInterval)
    }
  }
}

// ── Register ──────────────────────────────────────────────────────────────────

function registerDmHandlers(bot) {
  bot.command('start', async (ctx) => {
    if (!isPrivateChat(ctx)) return
    await ctx.reply(MENU_TEXT, replyOpts({ reply_markup: MENU_BUTTONS }))
  })

  bot.command('spot', withRateLimit('spot', handleDmSpotify))
  bot.command('flac', withRateLimit('flac', handleDmFlac))
  bot.command('apk',  withRateLimit('apk',  handleDmApk))

  bot.action(/^dm:menu:(spot|flac|apk)$/, async (ctx) => {
    if (!isPrivateChat(ctx)) return
    const feature = ctx.callbackQuery.data.replace('dm:menu:', '')
    await ctx.answerCbQuery()
    await ctx.reply(FEATURE_HINTS[feature], replyOpts())
  })

  bot.action(/^dm:spot:[^:]+$/, async (ctx) => {
    if (!isPrivateChat(ctx)) return
    await handleDmSpotifyCallback(ctx)
  })

  bot.action(/^dm:srch:\d+:.+$/, async (ctx) => {
    if (!isPrivateChat(ctx)) return
    await handleDmSearchPage(ctx)
  })
}

module.exports = { registerDmHandlers }