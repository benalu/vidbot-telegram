// src/utils/process.js
// Safety net untuk unhandled error dan graceful shutdown.

function log(level, data) {
  console[level === 'error' ? 'error' : 'log'](
    JSON.stringify({ ts: new Date().toISOString(), ...data })
  )
}

function setupProcessHandlers(bot) {
  // Tangkap error yang tidak di-handle — cegah bot mati diam-diam
  process.on('uncaughtException', (err) => {
    log('error', { event: 'uncaughtException', msg: err.message, stack: err.stack })
    // Jangan exit — biarkan bot tetap jalan kecuali error benar-benar fatal
  })

  process.on('unhandledRejection', (reason) => {
    const msg = reason instanceof Error ? reason.message : String(reason)
    log('error', { event: 'unhandledRejection', msg })
    // Sama — log saja, jangan crash
  })

  // Graceful shutdown — tunggu proses background selesai
  let isShuttingDown = false

  async function shutdown(signal) {
    if (isShuttingDown) return
    isShuttingDown = true

    log('info', { event: 'shutdown', signal })

    // Beri waktu 5 detik untuk background IIFE selesai
    await new Promise(resolve => setTimeout(resolve, 5000))

    bot.stop(signal)
    log('info', { event: 'stopped' })
    process.exit(0)
  }

  process.once('SIGINT',  () => shutdown('SIGINT'))
  process.once('SIGTERM', () => shutdown('SIGTERM'))
}

module.exports = { setupProcessHandlers }