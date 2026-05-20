/**
 * Escape karakter spesial MarkdownV2 Telegram.
 * Dipanggil di semua format files — jangan duplikasi di tempat lain.
 */
function escape(text) {
  return String(text).replace(/[_*[\]()~`>#+=|{}.!\\-]/g, '\\$&')
}

/**
 * Normalisasi URL dari input user:
 * - Auto-prefix https:// kalau tidak ada protocol
 * - Return null kalau tetap tidak valid setelah prefix
 *
 * Contoh:
 *   "tiktok.com/video/123"      → "https://tiktok.com/video/123"
 *   "https://tiktok.com/..."    → "https://tiktok.com/..."  (tidak berubah)
 *   "bukan url sama sekali"     → null
 */
function normalizeUrl(str) {
  if (!str) return null
  const input = str.trim()

  // Harus ada protocol eksplisit atau terlihat seperti domain (ada titik + TLD)
  const looksLikeDomain = /^(https?:\/\/)|(\S+\.\S{2,}(\/\S*)?$)/i.test(input)
  if (!looksLikeDomain) return null

  const withPrefix = /^https?:\/\//i.test(input) ? input : `https://${input}`
  try {
    new URL(withPrefix)
    return withPrefix
  } catch {
    return null
  }
}

module.exports = { escape, normalizeUrl }