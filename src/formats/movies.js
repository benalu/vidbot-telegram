function formatMovies(movie) {
  const { data: info, download } = movie

  const overview = info.overview
    ? (info.overview.length > 200 ? info.overview.slice(0, 197) + '...' : info.overview)
    : 'No description available.'

  const buttons = []
  if (download.url_1) buttons.push([{ text: '📥 Mirror 1', url: download.url_1 }])
  if (download.url_2) buttons.push([{ text: '📥 Mirror 2', url: download.url_2 }])
  if (download.url_3) buttons.push([{ text: '📥 Mirror 3', url: download.url_3 }])

  const text = [
    `🎬 *${escape(info.title || 'Movie')} \\(${escape(info.year || 'N/A')}\\)*`,
    ``,
    `> ${escape(overview)}`,
    ``,
    `⭐ *Rating:* ${escape(info.rating || 'N/A')}`,
    `🕐 *Duration:* ${escape(info.duration || 'N/A')}`,
    `🎭 *Genre:* ${escape(info.genre || 'N/A')}`,
  ].join('\n')

  return { text, buttons }
}

function escape(text) {
  return String(text).replace(/[_*[\]()~`>#+=|{}.!\\-]/g, '\\$&')
}

module.exports = { formatMovies }