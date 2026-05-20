require('dotenv').config()
const { Telegraf } = require('telegraf')
const GROUP_TOPICS = require('./config/topics')
const COMMANDS     = require('./config/commands')
const { handleHelp } = require('./handlers/help')

const { handleSpotifyCallback } = require('./handlers/spotify')
const { registerAdminHandlers } = require('./handlers/admin')

// ---------------------------------------------------------------------------
// Env validation at startup — fail fast
// ---------------------------------------------------------------------------
const REQUIRED_ENV = [
  'TELEGRAM_TOKEN', 'API_URL', 'API_KEY', 'TELEGRAM_GROUP_ID',
  'TELEGRAM_THREAD_LEAKCHECK', 'TELEGRAM_THREAD_MOVIES', 'TELEGRAM_THREAD_FLAC',
  'TELEGRAM_THREAD_APK', 'TELEGRAM_THREAD_VIDHUB', 'TELEGRAM_THREAD_SOCIAL',
  'TELEGRAM_THREAD_SPOTIFY', 'TELEGRAM_ADMIN_GROUP_ID', 'TELEGRAM_OWNER_ID',
  'R2_ENDPOINT', 'R2_BUCKET', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_PUBLIC_URL',
]
const missingEnv = REQUIRED_ENV.filter(k => !process.env[k])
if (missingEnv.length) {
  console.error('[startup] Missing required env vars:', missingEnv.join(', '))
  process.exit(1)
}

// ---------------------------------------------------------------------------
// Rate limiter — in-memory, per user per command, 5s cooldown
// ---------------------------------------------------------------------------
const cooldowns = new Map()

function isRateLimited(userId, command, ms = 5000) {
  const key = `${userId}:${command}`
  const last = cooldowns.get(key) || 0
  if (Date.now() - last < ms) return true
  cooldowns.set(key, Date.now())
  return false
}

// Cleanup expired cooldowns every 10 minutes
setInterval(() => {
  const cutoff = Date.now() - 60_000
  for (const [key, ts] of cooldowns) {
    if (ts < cutoff) cooldowns.delete(key)
  }
}, 10 * 60 * 1000)

// ---------------------------------------------------------------------------
// Structured logger
// ---------------------------------------------------------------------------
function log(level, data) {
  console[level === 'error' ? 'error' : 'log'](JSON.stringify({ ts: new Date().toISOString(), ...data }))
}

// ---------------------------------------------------------------------------
// Handler factory
// ---------------------------------------------------------------------------
function createHandler(commandName, { topic, handler, requiresArg }) {
  return async (ctx) => {
    const chatId   = String(ctx.chat.id)
    const threadId = String(ctx.message.message_thread_id)
    const userId   = ctx.from?.id
    const topics   = GROUP_TOPICS[chatId]

    // Unknown group → ignore
    if (!topics) return

    // Override ctx.reply — semua balasan otomatis reply ke pesan user
    const messageId  = ctx.message.message_id
    const originalReply        = ctx.reply.bind(ctx)
    const originalReplyWithPhoto = ctx.replyWithPhoto.bind(ctx)

    ctx.reply = (text, opts = {}) => originalReply(text, {
      ...opts,
      reply_parameters: { message_id: messageId, allow_sending_without_reply: true }
      
    })
    ctx.replyWithPhoto = (photo, opts = {}) => originalReplyWithPhoto(photo, {
      ...opts,
      reply_parameters: { message_id: messageId, allow_sending_without_reply: true }
    })

    // Wrong topic → nudge with link to correct topic
    const allowedThread = String(topics[topic])
    if (threadId !== allowedThread) {
      const cleanChatId = chatId.replace('-100', '')
      const topicLink   = `https://t.me/c/${cleanChatId}/${allowedThread}`
      return ctx.reply(
        `❌ */${commandName}* is not available here\\.\n\n👉 [Use it in the correct topic](${topicLink})`,
        { parse_mode: 'MarkdownV2', message_thread_id: ctx.message.message_thread_id }
      )
    }

    // Rate limit
    if (isRateLimited(userId, commandName)) {
      return ctx.reply('⏳ Please wait a moment before sending another request\\.', {
        parse_mode: 'MarkdownV2',
        message_thread_id: ctx.message.message_thread_id
      })
    }

    // Argument check
    const args = ctx.message.text.split(/\s+/).slice(1)
    if (requiresArg && args.length === 0) {
      return ctx.reply(`❌ Argument required\\. Example: \`/${commandName} https://\\.\\.\\.\\.\``, {
        parse_mode: 'MarkdownV2',
        message_thread_id: ctx.message.message_thread_id
      })
    }

    // Typing indicator loop — stays active while handler runs
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
      log('info', { cmd: commandName, userId, ms: Date.now() - start, status: 'ok' })
    } catch (err) {
      const apiCode    = err?.response?.data?.code
      const apiMessage = err?.response?.data?.message
      const SAFE_CODES = ['NOT_FOUND', 'BAD_REQUEST', 'RATE_LIMIT']

      const userMessage = apiCode && SAFE_CODES.includes(apiCode)
        ? apiMessage
        : 'Something went wrong. Please try again later.'

      log('error', {
        cmd: commandName,
        userId,
        ms: Date.now() - start,
        status: 'error',
        code: apiCode,
        msg: err.message
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
const bot = new Telegraf(process.env.TELEGRAM_TOKEN)

// /help available in all topics — no thread validation needed
bot.command('help', handleHelp)

for (const [name, config] of Object.entries(COMMANDS)) {
  bot.command(name, createHandler(name, config))
}

bot.catch((err, ctx) => {
  const apiCode    = err?.response?.data?.code
  const apiMessage = err?.response?.data?.message
  const SAFE_CODES = ['NOT_FOUND', 'BAD_REQUEST', 'RATE_LIMIT']
  const isTimeout  = err.message?.toLowerCase().includes('timeout')

  const userMessage = isTimeout
    ? 'Request timed out. The server is taking too long — try again in a moment.'
    : apiCode && SAFE_CODES.includes(apiCode)
      ? apiMessage
      : 'Something went wrong. Please try again later.'

  log('error', { msg: err.message, update: ctx?.update?.update_id })

  ctx.reply(`❌ ${userMessage}`, {
    message_thread_id: ctx.message?.message_thread_id
  }).catch(() => {})
})

bot.catch((err, ctx) => {
  const isTimeout = err.message?.toLowerCase().includes('timeout')
  const userMessage = isTimeout
    ? 'Request timed out\\. Please try again in a moment\\.'
    : 'Something went wrong\\. Please try again later\\.'

  log('error', { msg: err.message, update: ctx?.update?.update_id })

  ctx.reply(`❌ ${userMessage}`, {
    parse_mode: 'MarkdownV2',
    message_thread_id: ctx.message?.message_thread_id
  }).catch(() => {})
})

bot.action(/^spot:/, handleSpotifyCallback)
registerAdminHandlers(bot)

bot.launch()
log('info', { status: 'started', commands: ['help', ...Object.keys(COMMANDS)] })

process.once('SIGINT',  () => bot.stop('SIGINT'))
process.once('SIGTERM', () => bot.stop('SIGTERM'))