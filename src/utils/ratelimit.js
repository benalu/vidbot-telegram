// src/utils/ratelimit.js
const COOLDOWN_MS  = 5_000
const MAX_ENTRIES  = 2_000   // batas atas Map agar tidak leak memory

const cooldowns = new Map()

export function isRateLimited(userId, command, ms = COOLDOWN_MS) {
  const key  = `${userId}:${command}`
  const last = cooldowns.get(key) || 0
  if (Date.now() - last < ms) return true

  // Prune kalau sudah terlalu besar sebelum insert
  if (cooldowns.size >= MAX_ENTRIES) {
    // Hapus entri terlama (insertion-order FIFO)
    const oldestKey = cooldowns.keys().next().value
    cooldowns.delete(oldestKey)
  }

  cooldowns.set(key, Date.now())
  return false
}

// Cleanup: cutoff = 2× cooldown agar entri tidak terlalu lama duduk
setInterval(() => {
  const cutoff = Date.now() - COOLDOWN_MS * 2
  for (const [key, ts] of cooldowns) {
    if (ts < cutoff) cooldowns.delete(key)
  }
}, 60_000)