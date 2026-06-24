// src/index.js

require('dotenv').config()
const { Telegraf } = require('telegraf')
const GROUP_TOPICS = require('./config/topics')
const COMMANDS     = require('./config/commands')
const { handleHelp } = require('./handlers/help')

const { 
  handleSpotifyCallback, handleSearchPage,
  handleRandom, handleTop 
} = require('./features/spotify/spotify.handler')
const { handleFlacCallback, handleFlacSearchPage } = require('./features/flac/flac.handler')
const { registerAdminHandlers } = require('./features/admin/admin.handler')
const {
  handleDmStart,
  routeDmCommand,
  handleDmSpotCallback,
  handleDmSpotPage,
  handleDmFlacCallback,
  handleDmFlacPage,
} = require('./features/dm/dm.handler')
const { setupProcessHandlers } = require('./utils/process')
const { startAlerting, sendAlert } = require('./utils/alerting')

// ─── Ebooks ───────────────────────────────────────────────────────────────────
const { handleEbookCallback, handleEbookSearchPage } = require('./features/ebooks/ebooks.handler')
const {
  handleEbookUpload,
  handleEbookMetadataInput,
  handleAddEbookCommand,
  handleSyncR2Ebooks,
  handleDeleteEbook,
  handleEbookStats,
  handleListEbooks,
  handleListEbooksPage,
  pendingMetadata,
} = require('./features/ebooks/ebooks.admin')

const { handleMovieUpload, handleMovieTmdbInput, pendingMovieMeta } = require('./features/movies/movies.admin')

// ---------------------------------------------------------------------------
// Env validation at startup — fail fast
// ---------------------------------------------------------------------------
const REQUIRED_ENV = [
  'TELEGRAM_TOKEN', 'API_URL', 'API_KEY', 'TELEGRAM_GROUP_ID',
  'TELEGRAM_THREAD_LEAKCHECK', 'TELEGRAM_THREAD_MOVIES', 'TELEGRAM_THREAD_FLAC',
  'TELEGRAM_THREAD_APK', 'TELEGRAM_THREAD_VIDHUB', 'TELEGRAM_THREAD_SOCIAL',
  'TELEGRAM_THREAD_SPOTIFY', 'TELEGRAM_THREAD_EBOOKS',
  'TELEGRAM_ADMIN_GROUP_ID', 'TELEGRAM_OWNER_ID', 'TELEGRAM_ADMIN_THREAD_NOTIFY', 'TELEGRAM_ADMIN_THREAD_PANEL',
  'TELEGRAM_ADMIN_THREAD_ALERT', 'TELEGRAM_ADMIN_THREAD_SPIDER', 'TELEGRAM_ADMIN_THREAD_SPIDER_PANEL',
  'REST_API_URL', 'REST_API_MASTER_KEY',
  'R2_ENDPOINT', 'R2_BUCKET', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_PUBLIC_URL',
  'SPOTIFY_CLIENT_ID', 'SPOTIFY_CLIENT_SECRET', 'LASTFM_API_KEY',
]
const missingEnv = REQUIRED_ENV.filter(k => !process.env[k])
if (missingEnv.length) {
  console.error('[startup] Missing required env vars:', missingEnv.join(', '))
  process.exit(1)
}

const { isRateLimited } = require('./utils/ratelimit')
const logger = require('./utils/logger')

// ---------------------------------------------------------------------------
// Handler factory
// ---------------------------------------------------------------------------
function createHandler(commandName, { topic, handler, requiresArg }) {
  return async (ctx) => {
    const chatId   = String(ctx.chat.id)
    const threadId = String(ctx.message.message_thread_id)
    const userId   = ctx.from?.id
    const topics   = GROUP_TOPICS[chatId]

    if (ctx.chat?.type === 'private') {
      return routeDmCommand(ctx, commandName)
    }

    if (!topics) return

    const messageId          = ctx.message.message_id
    const originalReply      = ctx.reply.bind(ctx)
    const originalReplyWithPhoto = ctx.replyWithPhoto.bind(ctx)

    ctx.reply = (text, opts = {}) => originalReply(text, {
      ...opts,
      reply_parameters: { message_id: messageId, allow_sending_without_reply: true }
    })
    ctx.replyWithPhoto = (photo, opts = {}) => originalReplyWithPhoto(photo, {
      ...opts,
      reply_parameters: { message_id: messageId, allow_sending_without_reply: true }
    })

    const allowedThread = String(topics[topic])
    if (threadId !== allowedThread) {
      const cleanChatId = chatId.replace('-100', '')
      const topicLink   = `https://t.me/c/${cleanChatId}/${allowedThread}`
      return ctx.reply(
        `❌ */${commandName}* is not available here\\.\n\n👉 [Use it in the correct topic](${topicLink})`,
        { parse_mode: 'MarkdownV2', message_thread_id: ctx.message.message_thread_id }
      )
    }

    if (isRateLimited(userId, commandName)) {
      return ctx.reply('⏳ Please wait a moment before sending another request\\.', {
        parse_mode: 'MarkdownV2',
        message_thread_id: ctx.message.message_thread_id
      })
    }

    const args = ctx.message.text.split(/\s+/).slice(1)
    if (requiresArg && args.length === 0) {
      return ctx.reply(`❌ Argument required\\. Example: \`/${commandName} https://\\.\\.\\.\\.\``, {
        parse_mode: 'MarkdownV2',
        message_thread_id: ctx.message.message_thread_id
      })
    }

    const typingInterval = setInterval(() => {
      ctx.sendChatAction('typing', {
        message_thread_id: ctx.message.message_thread_id
      }).catch(() => {})
    }, 4000)
    await ctx.sendChatAction('typing', {
      message_thread_id: ctx.message.message_thread_id
    })

    const start = Date.now()
    try {
      await handler(ctx)
      logger.info({ cmd: commandName, userId, ms: Date.now() - start, status: 'ok' })
    } catch (err) {
      const apiCode    = err?.response?.data?.code
      const apiMessage = err?.response?.data?.message
      const SAFE_CODES = ['NOT_FOUND', 'BAD_REQUEST', 'RATE_LIMIT']

      const userMessage = apiCode && SAFE_CODES.includes(apiCode)
        ? apiMessage
        : 'Something went wrong. Please try again later.'

      logger.error({
        cmd: commandName, userId, ms: Date.now() - start,
        status: 'error', code: apiCode, msg: err.message
      })

      await ctx.reply(`❌ ${userMessage}`, {
        message_thread_id: ctx.message.message_thread_id
      })
    } finally {
      clearInterval(typingInterval)
    }
  }
}

// ---------------------------------------------------------------------------
// Register commands
// ---------------------------------------------------------------------------
const bot = new Telegraf(process.env.TELEGRAM_TOKEN, {
  telegram: {
    apiRoot: 'http://127.0.0.1:8081'
  },
  handlerTimeout: Infinity
})

bot.use((ctx, next) => {
  const type   = ctx.chat?.type
  const chatId = String(ctx.chat?.id)
  const ALLOWED = [
    process.env.TELEGRAM_GROUP_ID,
    process.env.TELEGRAM_ADMIN_GROUP_ID,
  ]
  if (!ctx.chat || type === 'private' || ALLOWED.includes(chatId)) return next()
  return
})

bot.command('start', handleDmStart)
bot.command('help', handleHelp)

bot.command('random', createHandler('random', { topic: 'spotify', handler: handleRandom, requiresArg: false }))
bot.command('top',    createHandler('top',    { topic: 'spotify', handler: handleTop,    requiresArg: false }))

for (const [name, config] of Object.entries(COMMANDS)) {
  bot.command(name, createHandler(name, config))
}

// ─── Ebooks admin commands ────────────────────────────────────────────────────
const ADMIN_GROUP = process.env.TELEGRAM_ADMIN_GROUP_ID
const OWNER_ID    = String(process.env.TELEGRAM_OWNER_ID)

function isAdminCtx(ctx) {
  return String(ctx.chat?.id) === String(ADMIN_GROUP) &&
         String(ctx.from?.id) === OWNER_ID
}

bot.command('addebook',      (ctx) => { if (isAdminCtx(ctx)) handleAddEbookCommand(ctx) })
bot.command('delebook',      (ctx) => { if (isAdminCtx(ctx)) handleDeleteEbook(ctx) })
bot.command('syncr2ebooks',  (ctx) => { if (isAdminCtx(ctx)) handleSyncR2Ebooks(ctx) })
bot.command('ebookstats',    (ctx) => { if (isAdminCtx(ctx)) handleEbookStats(ctx) })
bot.command('listebooks',    (ctx) => { if (isAdminCtx(ctx)) handleListEbooks(ctx) })

// ─── Callbacks ────────────────────────────────────────────────────────────────
bot.action(/^spot:/, handleSpotifyCallback)
bot.action(/^srch:\d+:.+$/, handleSearchPage)
bot.action(/^flac:[^:]+$/, handleFlacCallback)
bot.action(/^flacpage:\d+:.+$/, handleFlacSearchPage)
bot.action(/^dm_spot:[^:]+$/, handleDmSpotCallback)
bot.action(/^dm_srch:\d+:.+$/, handleDmSpotPage)
bot.action(/^dm_flac:[^:]+$/, handleDmFlacCallback)
bot.action(/^dm_flacpage:\d+:.+$/, handleDmFlacPage)
bot.action(/^ebooks:\d+$/, handleEbookCallback)
bot.action(/^ebpage:\d+:.+$/, handleEbookSearchPage)
bot.action(/^eblist:\d+$/, handleListEbooksPage)

// ─── Admin handlers (termasuk document handler untuk ebooks) ──────────────────
registerAdminHandlers(bot)

// ─── Document handler untuk ebooks upload di admin group ─────────────────────
// Dipasang SETELAH registerAdminHandlers agar tidak bentrok dengan audio handler
bot.on('document', async (ctx) => {
  if (!isAdminCtx(ctx)) return
  await handleEbookUpload(ctx)
})

bot.on('video', async (ctx) => {
  if (!isAdminCtx(ctx)) return
  await handleMovieUpload(ctx)
})

// ─── Text handler untuk wizard metadata ebooks ───────────────────────────────
// Hanya aktif kalau admin sedang dalam sesi input metadata
bot.on('text', async (ctx, next) => {
  if (!isAdminCtx(ctx)) return next()
  if (ctx.message.text?.startsWith('/')) return next()

  const userId = String(ctx.from?.id)
  if (pendingMetadata.has(userId)) {
    return handleEbookMetadataInput(ctx)
  }

  if (pendingMovieMeta.has(userId)) {
    return handleMovieTmdbInput(ctx)
  }

  return next()
})

setupProcessHandlers(bot, sendAlert)
startAlerting()
bot.launch()
logger.info({ status: 'started', commands: ['help', ...Object.keys(COMMANDS)] })