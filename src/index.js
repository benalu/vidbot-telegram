require('dotenv').config()
const { Telegraf } = require('telegraf')
const GROUP_TOPICS = require('./config/topics')

const { handleTiktok, handleSpotify, handleInstagram, handleTwitter, handleThreads } = require('./handlers/content')
const { handleVidhub }     = require('./handlers/vidhub')
const { handleMovies }     = require('./handlers/movies')
const { handleFlac }       = require('./handlers/flac')
const { handleAppAndroid } = require('./handlers/app')
const { handleLeakcheck }  = require('./handlers/leakcheck')

const bot = new Telegraf(process.env.TELEGRAM_TOKEN)

// Map command → { topic, handler }
const COMMANDS = {
  leak:     { topic: 'leakcheck', handler: handleLeakcheck,  requiresArg: true  },
  spot:     { topic: 'spotify',   handler: handleSpotify,    requiresArg: true  },
  tik:      { topic: 'tiktok',    handler: handleTiktok,     requiresArg: true  },
  inst:     { topic: 'instagram', handler: handleInstagram,  requiresArg: true  },
  twit:     { topic: 'twitter',   handler: handleTwitter,    requiresArg: true  },
  threads:  { topic: 'threads',   handler: handleThreads,    requiresArg: true  },
  vids:     { topic: 'vidhub',    handler: handleVidhub,     requiresArg: true  },
  apk:      { topic: 'apk',       handler: handleAppAndroid, requiresArg: true  },
  movie:    { topic: 'movies',    handler: handleMovies,     requiresArg: true  },
  flac:     { topic: 'flac',      handler: handleFlac,       requiresArg: true  },
}

// Middleware validasi semua command
function createHandler(commandName, { topic, handler, requiresArg }) {
  return async (ctx) => {
    const chatId   = String(ctx.chat.id)
    const threadId = String(ctx.message.message_thread_id)
    const topics   = GROUP_TOPICS[chatId]

    // Grup tidak dikenal → ignore
    if (!topics) return

    // Command di topik yang salah → teguran
    const allowedThread = String(topics[topic])
    if (threadId !== allowedThread) {
      return ctx.reply(`❌ Command ini hanya bisa digunakan di topik yang sesuai`, {
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

    // Tampilkan typing indicator
    await ctx.sendChatAction('typing', {
      message_thread_id: ctx.message.message_thread_id
    })

    // Jalankan handler
    try {
      await handler(ctx)
    } catch (err) {
      console.error(`[${commandName}] error:`, err?.response?.data || err.message)

      const apiCode    = err?.response?.data?.code
      const apiMessage = err?.response?.data?.message
      const SAFE_CODES = ['NOT_FOUND', 'BAD_REQUEST', 'RATE_LIMIT']

      const userMessage = apiCode && SAFE_CODES.includes(apiCode)
        ? apiMessage
        : 'Something went wrong. Please try again later.'

      await ctx.reply(`❌ ${userMessage}`, {
        message_thread_id: ctx.message.message_thread_id
      })
    }
  }
}

// Register semua command
for (const [name, config] of Object.entries(COMMANDS)) {
  bot.command(name, createHandler(name, config))
}

bot.launch()
console.log('✅ Telegram bot started')

process.once('SIGINT',  () => bot.stop('SIGINT'))
process.once('SIGTERM', () => bot.stop('SIGTERM'))