// src/utils/process.js

const logger = require('./logger')

// sendAlert di-inject dari luar untuk hindari circular dependency dengan alerting.js
function setupProcessHandlers(bot, sendAlert) {
  const safeAlert = (text) => {
    if (typeof sendAlert !== 'function') return Promise.resolve()
    return sendAlert(text).catch(() => {})
  }

  // ID-3: uncaughtException — kirim stack trace (truncated) ke Telegram
  process.on('uncaughtException', (err) => {
    logger.error({ event: 'uncaughtException', msg: err.message, stack: err.stack })
    const stack = err.stack ? err.stack.slice(0, 400) : err.message
    safeAlert(
      `🔴 *Uncaught Exception*\n\n` +
      `\`${esc(stack)}\``
    )
  })

  // ID-3: unhandledRejection — kirim ke Telegram
  process.on('unhandledRejection', (reason) => {
    const msg = reason instanceof Error ? reason.message : String(reason)
    logger.error({ event: 'unhandledRejection', msg })
    safeAlert(
      `🔴 *Unhandled Rejection*\n\n` +
      `\`${esc(msg.slice(0, 400))}\``
    )
  })

  let isShuttingDown = false

  async function shutdown(signal) {
    if (isShuttingDown) return
    isShuttingDown = true
    logger.info({ event: 'shutdown', signal })

    // ID-4: Alert sebelum shutdown — berguna untuk tahu kapan bot mati
    await safeAlert(
      `⚠️ *Bot Shutdown*\n\n` +
      `Signal: \`${signal}\`\n` +
      `_Bot akan berhenti sebentar\\. Jika ini tidak direncanakan, cek PM2 logs\\._`
    )

    await new Promise(resolve => setTimeout(resolve, 5000))
    bot.stop(signal)
    logger.info({ event: 'stopped' })
    process.exit(0)
  }

  process.once('SIGINT',  () => shutdown('SIGINT'))
  process.once('SIGTERM', () => shutdown('SIGTERM'))
}

// Minimal escape untuk MarkdownV2 — tidak import formats/utils agar tidak circular
function esc(text) {
  return String(text).replace(/[_*[\]()~`>#+=|{}.!\\-]/g, '\\$&')
}

module.exports = { setupProcessHandlers }