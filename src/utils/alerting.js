// src/utils/alerting.js
// Health monitoring + alerting ke grup admin Telegram.
// Dijalankan via interval dari dalam bot — tidak butuh dependency eksternal.
//
// Checks yang berjalan:
//   1. Memory usage — alert kalau heap > threshold
//   2. REST API reachability — alert kalau endpoint tidak merespons
//   3. R2 upload failure rate — alert kalau banyak gagal dalam window terakhir
//   4. Bot heartbeat — dicatat tiap interval, dipakai external watchdog kalau mau nanti
//
// Bot crash tidak bisa dideteksi dari dalam bot sendiri (proses sudah mati).
// Untuk itu, gunakan PM2 + `max_memory_restart` sebagai safety net,
// dan PM2 event hook atau cron external kalau butuh notifikasi crash.

const axios  = require('axios')
const logger = require('./logger')

// ── Config ────────────────────────────────────────────────────────────────────

const ALERT_CHAT_ID  = process.env.TELEGRAM_ADMIN_GROUP_ID
const ALERT_THREAD   = Number(process.env.TELEGRAM_ADMIN_THREAD_ALERT)
const BOT_TOKEN      = process.env.TELEGRAM_TOKEN

const CHECK_INTERVAL_MS   = 5 * 60 * 1000   // jalankan checks tiap 5 menit
const MEMORY_THRESHOLD_MB = 400              // alert kalau heap > 400 MB
const API_TIMEOUT_MS      = 8_000            // REST API harus merespons dalam 8 detik
const R2_FAIL_THRESHOLD   = 5               // alert kalau >= 5 R2 failure dalam window
const R2_FAIL_WINDOW_MS   = 10 * 60 * 1000  // window 10 menit untuk R2 failure counter

// ── State ─────────────────────────────────────────────────────────────────────

// Simpan timestamp tiap R2 failure — dibersihkan otomatis saat cek
const r2FailTimestamps = []

// Cooldown per alert type — hindari spam notifikasi yang sama berulang
// Key: alert type string, Value: timestamp terakhir alert dikirim
const alertCooldowns = new Map()
const ALERT_COOLDOWN_MS = 15 * 60 * 1000  // satu jenis alert max sekali per 15 menit

// Track apakah REST API sedang down — untuk kirim "recovered" saat pulih
const apiWasDown = { value: false }

// ── Escape MarkdownV2 (minimal, tidak import formats/utils untuk hindari circular) ──

function esc(text) {
  return String(text).replace(/[_*[\]()~`>#+=|{}.!\\-]/g, '\\$&')
}

// ── Send alert ke Telegram ────────────────────────────────────────────────────

async function sendAlert(text) {
  if (!ALERT_CHAT_ID || !ALERT_THREAD || !BOT_TOKEN) {
    logger.warn({ event: 'alerting_skipped', reason: 'env not configured' })
    return
  }

  try {
    await axios.post(
      `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
      {
        chat_id:           ALERT_CHAT_ID,
        message_thread_id: ALERT_THREAD,
        text,
        parse_mode: 'MarkdownV2',
      },
      { timeout: 10_000 }
    )
    logger.info({ event: 'alert_sent', preview: text.slice(0, 80) })
  } catch (err) {
    // Jangan throw — alerting tidak boleh crash bot
    logger.warn({ event: 'alert_send_failed', msg: err.message })
  }
}

// ── Cooldown guard ────────────────────────────────────────────────────────────

function shouldAlert(type) {
  const last = alertCooldowns.get(type) || 0
  if (Date.now() - last < ALERT_COOLDOWN_MS) return false
  alertCooldowns.set(type, Date.now())
  return true
}

// ── Check 1: Memory ───────────────────────────────────────────────────────────

async function checkMemory() {
  const heapUsed = process.memoryUsage().heapUsed
  const heapMB   = Math.round(heapUsed / 1024 / 1024)
  const rssMB    = Math.round(process.memoryUsage().rss / 1024 / 1024)

  logger.info({ event: 'health_memory', heap_mb: heapMB, rss_mb: rssMB })

  if (heapMB > MEMORY_THRESHOLD_MB && shouldAlert('memory')) {
    await sendAlert(
      `⚠️ *Memory Usage Tinggi*\n\n` +
      `Heap: *${esc(heapMB)} MB* \\(threshold: ${esc(MEMORY_THRESHOLD_MB)} MB\\)\n` +
      `RSS: *${esc(rssMB)} MB*\n\n` +
      `_Bot masih berjalan\\. Pantau — PM2 akan restart otomatis kalau mencapai 512 MB\\._`
    )
  }
}

// ── Check 2: REST API ─────────────────────────────────────────────────────────

async function checkRestApi() {
  const REST_API_URL = process.env.REST_API_URL
  const REST_API_KEY = process.env.REST_API_MASTER_KEY

  if (!REST_API_URL || !REST_API_KEY) return

  // Ping endpoint yang ringan — kalau tidak ada dedicated health endpoint,
  // pakai GET ke base URL dan cukup cek apakah merespons (bukan 5xx)
  const pingUrl = `${REST_API_URL}/health`

  try {
    await axios.get(pingUrl, {
      headers: { 'X-Master-Key': REST_API_KEY },
      timeout: API_TIMEOUT_MS,
      validateStatus: (s) => s < 500,  // 404 pun dianggap "up" — berarti server hidup
    })

    // Pulih dari down
    if (apiWasDown.value) {
      apiWasDown.value = false
      alertCooldowns.delete('api_down')  // reset cooldown agar alert down berikutnya langsung terkirim
      await sendAlert(`✅ *REST API Pulih*\n\n_Koneksi ke REST API kembali normal\\._`)
    }

    logger.info({ event: 'health_api', status: 'ok' })

  } catch (err) {
    logger.warn({ event: 'health_api', status: 'down', msg: err.message })
    apiWasDown.value = true

    if (shouldAlert('api_down')) {
      const reason = err.code === 'ECONNREFUSED'
        ? 'Connection refused \\(server mungkin mati\\)'
        : err.code === 'ETIMEDOUT' || err.code === 'ECONNABORTED'
          ? `Timeout setelah ${esc(API_TIMEOUT_MS / 1000)} detik`
          : esc(err.message)

      await sendAlert(
        `🔴 *REST API Down*\n\n` +
        `Endpoint: \`${esc(pingUrl)}\`\n` +
        `Alasan: _${reason}_\n\n` +
        `_Sync track baru ke REST API akan gagal sampai server pulih\\._`
      )
    }
  }
}

// ── Check 3: R2 failure rate ──────────────────────────────────────────────────
// Dipanggil dari luar (r2.js atau handler) setiap kali R2 upload gagal.
// Alerting module ini mengakumulasi dan cek threshold tiap interval.

function recordR2Failure(trackTitle = '') {
  r2FailTimestamps.push({ ts: Date.now(), track: trackTitle })
}

async function checkR2FailureRate() {
  const windowStart = Date.now() - R2_FAIL_WINDOW_MS

  // Bersihkan entry di luar window
  while (r2FailTimestamps.length && r2FailTimestamps[0].ts < windowStart) {
    r2FailTimestamps.shift()
  }

  const count = r2FailTimestamps.length
  logger.info({ event: 'health_r2', failures_in_window: count })

  if (count >= R2_FAIL_THRESHOLD && shouldAlert('r2_failures')) {
    const windowMin = Math.round(R2_FAIL_WINDOW_MS / 60_000)
    const samples   = r2FailTimestamps
      .slice(-3)
      .map(f => `• _${esc(f.track || 'unknown')}_`)
      .join('\n')

    await sendAlert(
      `⚠️ *R2 Upload Gagal Berulang*\n\n` +
      `*${esc(count)}* kegagalan dalam ${esc(windowMin)} menit terakhir\n\n` +
      `*Track terakhir yang gagal:*\n${samples}\n\n` +
      `_Cek koneksi R2 atau credentials di env\\._`
    )
  }
}

// ── Heartbeat log (bukan alert, hanya untuk audit) ────────────────────────────

function logHeartbeat() {
  const mem   = process.memoryUsage()
  const upSec = Math.round(process.uptime())
  const upStr = upSec < 3600
    ? `${Math.floor(upSec / 60)}m ${upSec % 60}s`
    : `${Math.floor(upSec / 3600)}h ${Math.floor((upSec % 3600) / 60)}m`

  logger.info({
    event:    'heartbeat',
    uptime:   upStr,
    heap_mb:  Math.round(mem.heapUsed / 1024 / 1024),
    rss_mb:   Math.round(mem.rss      / 1024 / 1024),
  })
}

// ── Runner ────────────────────────────────────────────────────────────────────

async function runChecks() {
  logHeartbeat()
  await checkMemory()
  await checkRestApi()
  await checkR2FailureRate()
}

// ── Start ─────────────────────────────────────────────────────────────────────

function startAlerting() {
  if (!ALERT_CHAT_ID || !ALERT_THREAD || !BOT_TOKEN) {
    logger.warn({ event: 'alerting_disabled', reason: 'TELEGRAM_ADMIN_THREAD_ALERT not set' })
    return
  }

  logger.info({ event: 'alerting_started', interval_min: CHECK_INTERVAL_MS / 60_000 })

  // Jalankan sekali saat startup (delay 30 detik agar bot fully ready dulu)
  setTimeout(() => {
    runChecks().catch(err => logger.warn({ event: 'alerting_check_failed', msg: err.message }))
  }, 30_000)

  // Kemudian tiap interval
  setInterval(() => {
    runChecks().catch(err => logger.warn({ event: 'alerting_check_failed', msg: err.message }))
  }, CHECK_INTERVAL_MS)
}

module.exports = { startAlerting, recordR2Failure }