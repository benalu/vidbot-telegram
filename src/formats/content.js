const { escape } = require('./utils')

function formatTiktok(data) {
  const { data: info, download } = data

  const title     = (info.title || 'TikTok Video').replace(/[\u200B-\u200D\uFEFF]/g, '').trim()
  const truncated = title.length > 200 ? title.slice(0, 197) + '...' : title

  const hdVideo = download.video?.find(v => v.quality === 'hd_no_watermark')
  const audio   = download.audio

  const buttons = []
  if (hdVideo) buttons.push([{ text: '📥 Download Video', url: hdVideo.original }])
  if (audio)   buttons.push([{ text: '🎵 Download Audio', url: audio.original }])

  const text = [
    `🎵 *${escape(truncated)}*`,
    ``,
    `👤 *Author:* ${escape(info.author || 'Unknown')}`,
    `🔗 *Username:* ${escape(info.username || 'Unknown')}`,
  ].join('\n')

  return { text, buttons }
}

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

function formatInstagram(data) {
  const { data: info, download } = data

  const buttons = []
  if (download.video?.length) {
    download.video.forEach((v, i) => {
      buttons.push([{ text: `📥 Video ${i + 1} (${v.quality})`, url: v.server_1 || v.original }])
    })
  }
  if (download.audio) {
    buttons.push([{ text: '🎵 Audio', url: download.audio.server_1 || download.audio.original }])
  }

  const text = [
    `📸 *Instagram*`,
    ``,
    `👤 *Author:* ${escape(info.author || 'Unknown')}`,
  ].join('\n')

  return { text, buttons }
}

function formatTwitter(data) {
  const { data: info, download } = data

  const buttons = []
  if (download.video?.length) {
    download.video.forEach((v, i) => {
      buttons.push([{ text: `📥 Download (${v.quality})`, url: v.server_1 || v.original }])
    })
  }

  const text = [
    `🐦 *Twitter/X*`,
    ``,
    `👤 *Author:* ${escape(info.author || 'Unknown')}`,
  ].join('\n')

  return { text, buttons }
}

function formatThreads(data) {
  const { data: info, download } = data

  const buttons = []
  if (download.media?.length) {
    download.media.forEach((m, i) => {
      buttons.push([{ text: `📥 ${m.type} ${i + 1}`, url: m.server_1 || m.original }])
    })
  }

  const text = [
    `🧵 *Threads*`,
    ``,
    `👤 *Author:* ${escape(info.author || 'Unknown')}`,
  ].join('\n')

  return { text, buttons }
}

module.exports = { formatTiktok, formatSpotify, formatInstagram, formatTwitter, formatThreads }