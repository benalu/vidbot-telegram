const { escape } = require('./utils')

function formatFlac(entry) {
  const { data: info, download } = entry

  const buttons = []
  if (download.url_1) buttons.push([{ text: '📥 Mirror 1', url: download.url_1 }])
  if (download.url_2) buttons.push([{ text: '📥 Mirror 2', url: download.url_2 }])
  if (download.url_3) buttons.push([{ text: '📥 Mirror 3', url: download.url_3 }])

  const text = [
    `🎵 *${escape(info.artist)} — ${escape(info.album)}*`,
    ``,
    `🎸 *Genre:* ${escape(info.genre || 'N/A')}`,
    `📅 *Year:* ${escape(info.year || 'N/A')}`,
    `🎚 *Quality:* ${escape(info.quality || 'FLAC')}`,
  ].join('\n')

  return { text, buttons }
}

module.exports = { formatFlac }