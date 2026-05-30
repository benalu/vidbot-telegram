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

  // ✨ SP-1 FIX: Tambahkan Retry Logic (Maks 3 Percobaan)
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await axios.post(
        'https://accounts.spotify.com/api/token',
        'grant_type=client_credentials',
        {
          headers: {
            'Authorization': `Basic ${credentials}`,
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          timeout: 5000, // ✨ Fail-Fast: 5 detik cukup untuk minta token
        }
      )

      accessToken    = res.data.access_token
      tokenExpiresAt = Date.now() + (res.data.expires_in - 60) * 1000
      return accessToken
    } catch (err) {
      lastErr = err;
      if (attempt < 3) {
        // Tunggu 1 detik sebelum mencoba lagi
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
  }
  
  // Jika 3x gagal, lemparkan error terakhir
  throw lastErr;
}

async function enrichMetadata(title, artist) {
  try {
    const token = await getAccessToken()
    const query = `track:${title} artist:${artist}`
    
    // ✨ SP-2 FIX: Fail-Fast Timeout via Env (Default: 5 detik)
    const SPOTIFY_TIMEOUT = Number(process.env.SPOTIFY_TIMEOUT) || 5000
    
    const res   = await axios.get('https://api.spotify.com/v1/search', {
      params: {
        q:      query,
        type:   'track',
        limit:  5,
        market: 'US',
      },
      headers: { Authorization: `Bearer ${token}` },
      timeout: SPOTIFY_TIMEOUT,
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
        // ✨ SP-2 FIX: Last.fm bukan API utama, gunakan timeout super singkat (Default: 3 detik)
        const LASTFM_TIMEOUT = Number(process.env.LASTFM_TIMEOUT) || 3000
        
        const lfmRes = await axios.get('https://ws.audioscrobbler.com/2.0/', {
          params: {
            method:  'artist.getTopTags',
            artist:  artistName,
            api_key: process.env.LASTFM_API_KEY,
            format:  'json',
            limit:   5,
          },
          timeout: LASTFM_TIMEOUT,
        })
        const tags = lfmRes.data?.toptags?.tag || []
        const skip = ['seen live', 'favorites', 'favourite', 'love', 'beautiful', 'awesome']
        genre = tags
          .map(t => t.name?.toLowerCase())
          .find(t => t && !skip.includes(t)) || null
        logger.info({ event: 'lastfm_genre', artist: artistName, genre })
      } catch {
        // Last.fm gagal (atau timeout) — biarkan genre null, tidak perlu merusak flow utama
      }
    }

    return {
        album:     album.name                      || null,
        year:      album.release_date?.slice(0, 4) || null,
        thumbnail: album.images?.[0]?.url          || null,
        genre,
    }
  } catch (err) {
    logger.warn({ event: 'spotify_enrich_failed', msg: err.message })
    return {}
  }
}

module.exports = { enrichMetadata, getAccessToken }