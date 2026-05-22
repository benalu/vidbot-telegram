// src/features/spotify/spotify.format.js

// Import util escape dari folder aslinya (sementara sebelum folder formats ikut dirapikan)
const { escape } = require('../../formats/utils') 

function formatSpotify(data) {
  const { data: info, download } = data

  const buttons = []
  if (download.original) buttons.push([{ text: '📥 Original', url: download.original }])
  if (download.server_2) buttons.push([{ text: '📥 Server 2', url: download.server_2 }])

  const text = [
    `🎵 *${escape(info.title || 'Spotify Track')}*`,
    ``,
    `👤 *Artist:* ${escape(info.author || 'Unknown')}`,
    `⏱ *Duration:* ${escape(info.duration || 'N/A')}`,
    `🎚 *Quality:* ${escape(info.quality || 'HQ')}`,
    `📁 *Format:* \\.${escape(data.type || 'mp3')}`,
  ].join('\n')

  return { text, buttons }
}

module.exports = { formatSpotify }