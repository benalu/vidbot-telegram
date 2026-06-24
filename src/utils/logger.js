// src/utils/logger.js
// Structured logger — satu tempat, konsisten di seluruh codebase.
// • stdout TTY (terminal langsung)  → pretty print berwarna, mudah dibaca
// • stdout non-TTY (PM2 log file)   → JSON satu baris, bisa di-parse
// • LOG_FILE di-set di env          → selalu JSON dengan rotasi harian

const fs   = require('fs')
const path = require('path')

const IS_TTY = process.stdout.isTTY === true

// ── ANSI color helpers ────────────────────────────────────────────────────────
const C = {
  reset:  '\x1b[0m',
  dim:    '\x1b[2m',
  bold:   '\x1b[1m',
  red:    '\x1b[31m',
  yellow: '\x1b[33m',
  cyan:   '\x1b[36m',
  green:  '\x1b[32m',
  gray:   '\x1b[90m',
  white:  '\x1b[97m',
}

const LEVEL_STYLE = {
  info:  { label: 'INFO ', color: C.cyan   },
  warn:  { label: 'WARN ', color: C.yellow },
  error: { label: 'ERROR', color: C.red    },
}

// ── Pretty formatter (TTY only) ───────────────────────────────────────────────
function prettyFormat(level, data) {
  const now   = new Date()
  const time  = now.toLocaleTimeString('id-ID', { hour12: false, timeZone: 'Asia/Jakarta' })
  const style = LEVEL_STYLE[level] || { label: level.toUpperCase(), color: C.white }

  // Pisahkan field utama dari sisa data
  const { event, msg, cmd, status, ms, ...rest } = data

  // Baris utama: waktu · level · event/cmd
  const label   = `${style.color}${C.bold}${style.label}${C.reset}`
  const timeStr = `${C.gray}${time}${C.reset}`
  const topic   = event || cmd || '—'
  const topicStr = `${C.white}${topic}${C.reset}`

  // Payload ringkas: status, msg, ms, lalu sisa field
  const parts = []
  if (status)            parts.push(`${C.green}${status}${C.reset}`)
  if (msg)               parts.push(`${C.dim}${msg}${C.reset}`)
  if (ms !== undefined)  parts.push(`${C.gray}${ms}ms${C.reset}`)

  // Sisa field — tampilkan sebagai key=value singkat
  const extras = Object.entries(rest)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => {
      const val = typeof v === 'string' && v.length > 60 ? v.slice(0, 57) + '…' : v
      return `${C.gray}${k}=${C.reset}${val}`
    })
    .join('  ')

  const payload = [...parts, extras].filter(Boolean).join('  ')
  return `${timeStr}  ${label}  ${topicStr}${payload ? `  ${payload}` : ''}`
}

// ── File writer (opsional) ────────────────────────────────────────────────────
let currentLogDate = null
let fileStream     = null

function getDateString() {
  return new Date().toISOString().slice(0, 10)
}

function getLogStream() {
  if (!process.env.LOG_FILE) return null

  const today = getDateString()

  if (today !== currentLogDate) {
    if (fileStream) { fileStream.end(); fileStream = null }

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
        console.error(JSON.stringify({ ts: new Date().toISOString(), level: 'error', event: 'logger_stream_error', msg: err.message }))
        fileStream = null; currentLogDate = null
      })
    } catch (err) {
      console.error(JSON.stringify({ ts: new Date().toISOString(), level: 'error', event: 'logger_init_error', msg: err.message, path: filePath }))
    }
  }

  return fileStream
}

// ── Core ──────────────────────────────────────────────────────────────────────
function log(level, data) {
  // Stdout: pretty kalau TTY, JSON kalau non-TTY (PM2 log file, pipe, Docker)
  if (IS_TTY) {
    const out = prettyFormat(level, data)
    level === 'error' || level === 'warn' ? console.error(out) : console.log(out)
  } else {
    const out = JSON.stringify({ ts: new Date().toISOString(), level, ...data })
    level === 'error' || level === 'warn' ? console.error(out) : console.log(out)
  }

  // File log selalu JSON
  const stream = getLogStream()
  if (stream) stream.write(JSON.stringify({ ts: new Date().toISOString(), level, ...data }) + '\n')
}

module.exports = {
  info:  (data) => log('info',  data),
  warn:  (data) => log('warn',  data),
  error: (data) => log('error', data),
}