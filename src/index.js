require('dotenv').config()
const { Telegraf } = require('telegraf')
const GROUP_TOPICS = require('./config/topics')

const { handleTiktok, handleSpotify, handleInstagram, handleTwitter, handleThreads } = require('./handlers/content')
const { handleVidhub }     = require('./handlers/vidhub')
const { handleMovies }     = require('./handlers/movies')
const { handleFlac }       = require('./handlers/flac')
const { handleAppAndroid } = require('./handlers/app')
const { handleLeakcheck }  = require('./handlers/leakcheck')

// ---------------------------------------------------------------------------
// Validasi env saat startup — fail fast daripada crash saat command pertama
// ---------------------------------------------------------------------------
const REQUIRED_ENV = [
  'TELEGRAM_TOKEN', 'API_URL', 'API_KEY', 'TELEGRAM_GROUP_ID',
  'TELEGRAM_THREAD_LEAKCHECK', 'TELEGRAM_THREAD_MOVIES', 'TELEGRAM_THREAD_FLAC',
  'TELEGRAM_THREAD_APK', 'TELEGRAM_THREAD_VIDHUB', 'TELEGRAM_THREAD_TIKTOK',
  'TELEGRAM_THREAD_SPOTIFY', 'TELEGRAM_THREAD_INSTAGRAM',
  'TELEGRAM_THREAD_TWITTER', 'TELEGRAM_THREAD_THREADS',
]
const missingEnv = REQUIRED_ENV.filter(k => !process.env[k])
if (missingEnv.length) {
  console.error('[startup] Missing required env vars:', missingEnv.join(', '))
  process.exit(1)
}

// ---------------------------------------------------------------------------
// Rate limiter — in-memory, per user per command, 5 detik cooldown
// ---------------------------------------------------------------------------
const cooldowns = new Map()

function isRateLimited(userId, command, ms = 5000) {
  const key = `${userId}:${command}`
  const last = cooldowns.get(key) || 0
  if (Date.now() - last < ms) return true
  cooldowns.set(key, Date.now())
  return false
}

// Bersihkan cooldowns yang sudah expired setiap 10 menit
// supaya Map tidak tumbuh tak terbatas
setInterval(() => {
  const cutoff = Date.now() - 60_000
  for (const [key, ts] of cooldowns) {
    if (ts < cutoff) cooldowns.delete(key)
  }
}, 10 * 60 * 1000)

// ---------------------------------------------------------------------------
// Logger terstruktur
// ---------------------------------------------------------------------------
function log(level, data) {
  console[level === 'error' ? 'error' : 'log'](JSON.stringify({ ts: new Date().toISOString(), ...data }))
}

// ---------------------------------------------------------------------------
// Commands map
// ---------------------------------------------------------------------------
const COMMANDS = {
  leak:    { topic: 'leakcheck', handler: handleLeakcheck,  requiresArg: true },
  spot:    { topic: 'spotify',   handler: handleSpotify,    requiresArg: true },
  tik:     { topic: 'tiktok',    handler: handleTiktok,     requiresArg: true },
  inst:    { topic: 'instagram', handler: handleInstagram,  requiresArg: true },
  twit:    { topic: 'twitter',   handler: handleTwitter,    requiresArg: true },
  threads: { topic: 'threads',   handler: handleThreads,    requiresArg: true },
  vids:    { topic: 'vidhub',    handler: handleVidhub,     requiresArg: true },
  apk:     { topic: 'apk',       handler: handleAppAndroid, requiresArg: true },
  movie:   { topic: 'movies',    handler: handleMovies,     requiresArg: true },
  flac:    { topic: 'flac',      handler: handleFlac,       requiresArg: true },
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

    // Grup tidak dikenal → ignore
    if (!topics) return

    // Command di topik yang salah → teguran
    const allowedThread = String(topics[topic])
    if (threadId !== allowedThread) {
      return ctx.reply('❌ Command ini hanya bisa digunakan di topik yang sesuai', {
        message_thread_id: ctx.message.message_thread_id
      })
    }

    // Rate limit
    if (isRateLimited(userId, commandName)) {
      return ctx.reply('⏳ Tunggu sebentar sebelum request lagi\\.', {
        parse_mode: 'MarkdownV2',
        message_thread_id: ctx.message.message_thread_id
      })
    }

    // Cek argument
    const args = ctx.message.text.split(/\s+/).slice(1)
    if (requiresArg && args.length === 0) {
      return ctx.reply(`❌ Argument diperlukan\\. Contoh: \`/${commandName} https://\\.\\.\\.\\.\``, {
        parse_mode: 'MarkdownV2',
        message_thread_id: ctx.message.message_thread_id
      })
    }

    // Typing indicator loop — terus aktif selama handler berjalan
    const typingInterval = setInterval(() => {
      ctx.sendChatAction('typing', {
        message_thread_id: ctx.message.message_thread_id
      }).catch(() => {}) // ignore error kalau chat sudah tidak aktif
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
// Register semua command
// ---------------------------------------------------------------------------
const bot = new Telegraf(process.env.TELEGRAM_TOKEN)

for (const [name, config] of Object.entries(COMMANDS)) {
  bot.command(name, createHandler(name, config))
}

bot.launch()
log('info', { status: 'started', commands: Object.keys(COMMANDS) })

process.once('SIGINT',  () => bot.stop('SIGINT'))
process.once('SIGTERM', () => bot.stop('SIGTERM'))