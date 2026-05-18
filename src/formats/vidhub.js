const { escape } = require('./utils')

function formatVidhub(data) {
  const { data: info, download, sites } = data

  const buttons = []
  if (download.original) {
    buttons.push([{ text: '📥 Download Original', url: download.original }])
  }

  const text = [
    `🎬 *${escape(info.title || info.filename || 'Video')}*`,
    ``,
    `🌐 *Sites:* ${escape(sites)}`,
    `📁 *Filename:* ${escape(info.filename || 'N/A')}`,
  ].join('\n')

  return { text, buttons }
}

module.exports = { formatVidhub }