/**
 * Escape karakter spesial MarkdownV2 Telegram.
 * Dipanggil di semua format files — jangan duplikasi di tempat lain.
 */
function escape(text) {
  return String(text).replace(/[_*[\]()~`>#+=|{}.!\\-]/g, '\\$&')
}

module.exports = { escape }