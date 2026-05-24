// src/utils/api-sync.js
const axios  = require('axios')
const logger = require('./logger')

const REST_API_URL = process.env.REST_API_URL
const REST_API_KEY = process.env.REST_API_MASTER_KEY

// ─── Shared ───────────────────────────────────────────────────────────────────

function isReady(r2Url) {
  if (!REST_API_URL || !REST_API_KEY) {
    logger.warn({ event: 'api_sync_skipped', reason: 'env not set' })
    return false
  }
  if (!r2Url) {
    logger.warn({ event: 'api_sync_skipped', reason: 'no r2_url' })
    return false
  }
  return true
}

async function postToApi(endpoint, payload, label) {
  try {
    await axios.post(`${REST_API_URL}${endpoint}`, payload, {
      headers: { 'X-Master-Key': REST_API_KEY },
      timeout: 10_000,
    })
    logger.info({ event: 'api_sync_ok', type: label, track: payload.title, track_id: payload.track_id })
  } catch (err) {
    const code = err?.response?.data?.code
    const msg  = err?.response?.data?.message || err.message
    // Fire and forget — jangan throw, jangan ganggu flow utama bot
    logger.warn({ event: 'api_sync_failed', type: label, track: payload.title, code, msg })
  }
}

// ─── FLAC ─────────────────────────────────────────────────────────────────────

async function syncFlacToApi(track) {
  if (!isReady(track.r2_url)) return

  await postToApi('/admin/downloader/flac', {
    track_id:  track.track_id,
    title:     track.title     || '',
    artist:    track.artist    || '',
    album:     track.album     || '',
    duration:  track.duration  || '',
    year:      track.year      || '',
    genre:     track.genre     || '',
    quality:   track.quality   || '',
    thumbnail: track.thumbnail || '',
    file_size: track.file_size || 0,
    file_hash: track.file_hash || '',
    url_1:     track.r2_url,
  }, 'flac')
}

// ─── MP3 ──────────────────────────────────────────────────────────────────────

async function syncMp3ToApi(track) {
  if (!isReady(track.r2_url)) return

  await postToApi('/admin/downloader/mp3', {
    track_id:  track.track_id,
    title:     track.title     || '',
    artist:    track.artist    || '',
    album:     track.album     || '',
    duration:  track.duration  || '',
    year:      track.year      || '',
    genre:     track.genre     || '',
    quality:   track.quality   || '',
    thumbnail: track.thumbnail || '',
    file_size: track.file_size || 0,
    file_hash: track.file_hash || '',
    url_1:     track.r2_url,
  }, 'mp3')
}

module.exports = { syncFlacToApi, syncMp3ToApi }