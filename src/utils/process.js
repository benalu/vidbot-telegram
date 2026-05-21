// src/utils/process.js

const logger = require('./logger')

function setupProcessHandlers(bot) {
  process.on('uncaughtException', (err) => {
    logger.error({ event: 'uncaughtException', msg: err.message, stack: err.stack })
  })
  process.on('unhandledRejection', (reason) => {
    const msg = reason instanceof Error ? reason.message : String(reason)
    logger.error({ event: 'unhandledRejection', msg })
  })

  let isShuttingDown = false

  async function shutdown(signal) {
    if (isShuttingDown) return
    isShuttingDown = true

    logger.info({ event: 'shutdown', signal })

    await new Promise(resolve => setTimeout(resolve, 5000))

    bot.stop(signal)
    logger.info({ event: 'stopped' })
    process.exit(0)
  }

  process.once('SIGINT',  () => shutdown('SIGINT'))
  process.once('SIGTERM', () => shutdown('SIGTERM'))
}

module.exports = { setupProcessHandlers }