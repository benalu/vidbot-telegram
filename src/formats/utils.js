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
  let input = str.trim()

  // Sudah ada protocol yang valid → langsung validasi
  if (/^https?:\/\//i.test(input)) {
    try {
      new URL(input)
      return input
    } catch {
      return null
    }
  }

  // Coba tambah https:// di depan
  try {
    const withPrefix = `https://${input}`
    new URL(withPrefix)
    return withPrefix
  } catch {
    return null
  }
}

module.exports = { escape, normalizeUrl }