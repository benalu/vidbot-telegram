// src/utils/spotify.js
// Spotify Web API client — hanya untuk metadata enrichment

const axios  = require('axios')
const logger = require('./logger')

let accessToken     = null
let tokenExpiresAt  = 0

async function getAccessToken() {
  if (accessToken && Date.now() < tokenExpiresAt) return accessToken

  const credentials = Buffer.from(
    `${process.env.SPOTIFY_CLIENT_ID}:${process.env.SPOTIFY_CLIENT_SECRET}`
  ).toString('base64')

  const res = await axios.post(
    'https://accounts.spotify.com/api/token',
    'grant_type=client_credentials',
    {
      headers: {
        'Authorization': `Basic ${credentials}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      timeout: 10_000,
    }
  )

  accessToken    = res.data.access_token
  tokenExpiresAt = Date.now() + (res.data.expires_in - 60) * 1000
  return accessToken
}

async function enrichMetadata(title, artist) {
  try {
    const token = await getAccessToken()
    const query = `track:${title} artist:${artist}`
    const res   = await axios.get('https://api.spotify.com/v1/search', {
      params: {
        q:      query,
        type:   'track',
        limit:  5,
        market: 'US',
      },
      headers: { Authorization: `Bearer ${token}` },
      timeout: 10_000,
    })

    const items = res.data?.tracks?.items || []
    if (!items.length) return {}

    // Prioritaskan album_type === 'album', fallback ke item pertama
    const best = items.find(t => t.album?.album_type === 'album') || items[0]
    const album = best?.album

    if (!album) return {}

    const artistName = best?.artists?.[0]?.name || null
    let genre        = null

    if (artistName && process.env.LASTFM_API_KEY) {
    try {
        const lfmRes = await axios.get('https://ws.audioscrobbler.com/2.0/', {
        params: {
            method:  'artist.getTopTags',
            artist:  artistName,
            api_key: process.env.LASTFM_API_KEY,
            format:  'json',
            limit:   5,
        },
        timeout: 10_000,
        })
        const tags = lfmRes.data?.toptags?.tag || []
        const skip = ['seen live', 'favorites', 'favourite', 'love', 'beautiful', 'awesome']
        genre = tags
        .map(t => t.name?.toLowerCase())
        .find(t => t && !skip.includes(t)) || null
        logger.info({ event: 'lastfm_genre', artist: artistName, genre })
    } catch {
        // Last.fm gagal — biarkan genre null
    }
    }

    return {
        album:     album.name                       || null,
        year:      album.release_date?.slice(0, 4) || null,
        thumbnail: album.images?.[0]?.url          || null,
        genre,
    }
  } catch (err) {
    logger.warn({ event: 'spotify_enrich_failed', msg: err.message })
    return {}
  }
}

module.exports = { enrichMetadata }