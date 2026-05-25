// src/utils/logger.js
// Structured logger — satu tempat, konsisten di seluruh codebase.
// Jika LOG_FILE di-set di env, log juga ditulis ke file dengan rotasi harian.

const fs   = require('fs')
const path = require('path')

// ── File writer (opsional) ────────────────────────────────────────────────────

let currentLogDate = null   // format: 'YYYY-MM-DD'
let fileStream     = null   // WriteStream aktif

function getDateString() {
  return new Date().toISOString().slice(0, 10)  // 'YYYY-MM-DD'
}

function getLogStream() {
  if (!process.env.LOG_FILE) return null

  const today = getDateString()

  // Rotasi: tanggal berubah → tutup stream lama, buka yang baru
  if (today !== currentLogDate) {
    if (fileStream) {
      fileStream.end()
      fileStream = null
    }

    // Tentukan path file: LOG_FILE bisa berisi placeholder {date}
    // Contoh: ./logs/bot.log        → ./logs/bot-2026-05-25.log (rotasi otomatis)
    //         ./logs/bot-{date}.log → ./logs/bot-2026-05-25.log (eksplisit)
    const rawPath  = process.env.LOG_FILE
    const filePath = rawPath.includes('{date}')
      ? rawPath.replace('{date}', today)
      : rawPath.replace(/(\.\w+)$/, `-${today}$1`)

    const dir = path.dirname(filePath)
    try {
      fs.mkdirSync(dir, { recursive: true })
      fileStream     = fs.createWriteStream(filePath, { flags: 'a' })
      currentLogDate = today

      fileStream.on('error', (err) => {
        // Jangan crash bot karena gagal tulis log
        console.error(JSON.stringify({
          ts: new Date().toISOString(), level: 'error',
          event: 'logger_stream_error', msg: err.message,
        }))
        fileStream     = null
        currentLogDate = null
      })
    } catch (err) {
      console.error(JSON.stringify({
        ts: new Date().toISOString(), level: 'error',
        event: 'logger_init_error', msg: err.message, path: filePath,
      }))
    }
  }

  return fileStream
}

// ── Core ──────────────────────────────────────────────────────────────────────

function log(level, data) {
  const out = JSON.stringify({ ts: new Date().toISOString(), level, ...data })

  // Selalu tulis ke stdout/stderr (cocok untuk PM2 / Docker log aggregator)
  if (level === 'error' || level === 'warn') {
    console.error(out)
  } else {
    console.log(out)
  }

  // Tambahan: tulis ke file kalau LOG_FILE di-set
  const stream = getLogStream()
  if (stream) {
    stream.write(out + '\n')
  }
}

module.exports = {
  info:  (data) => log('info',  data),
  warn:  (data) => log('warn',  data),
  error: (data) => log('error', data),
}