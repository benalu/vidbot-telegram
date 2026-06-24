// src/utils/tmdb.js
const axios = require('axios')
const logger = require('./logger')

async function fetchMovieMeta(tmdbId, language = 'id-ID') {
  const apiKey = process.env.TMDB_API_KEY
  if (!apiKey) throw new Error('TMDB_API_KEY belum diset di .env')

  try {
    // Fetch bahasa utama (id-ID atau sesuai request)
    const res = await axios.get(`https://api.themoviedb.org/3/movie/${tmdbId}`, {
      params: { api_key: apiKey, language },
      timeout: 10000
    })
    const d = res.data

    // Kalau overview kosong dan language bukan en-US, fetch ulang pakai en-US khusus untuk overview
    let overview = d.overview || ''
    if (!overview && language !== 'en-US') {
      try {
        const resEn = await axios.get(`https://api.themoviedb.org/3/movie/${tmdbId}`, {
          params: { api_key: apiKey, language: 'en-US' },
          timeout: 10000
        })
        overview = resEn.data.overview || ''
      } catch (_) {}
    }

    return {
      tmdb_id:  String(d.id),
      title:    d.original_title || d.title || '',
      year:     d.release_date ? d.release_date.slice(0, 4) : '',
      duration: d.runtime ? `${d.runtime} min` : '',
      rating:   d.vote_average ? d.vote_average.toFixed(1) : '',
      genre:    d.genres ? d.genres.map(g => g.name).join(', ') : '',
      poster:   d.poster_path ? `https://image.tmdb.org/t/p/original${d.poster_path}` : '',
      overview,
    }
  } catch (err) {
    logger.warn({ event: 'tmdb_fetch_failed', tmdb_id: tmdbId, msg: err.message })
    throw new Error('Gagal mengambil data dari TMDB. Pastikan ID benar.')
  }
}

// ✨ FUNGSI BARU: Cari otomatis berdasarkan Judul & Tahun
async function searchMovieMeta(title, year) {
  const apiKey = process.env.TMDB_API_KEY
  if (!apiKey) return null

  try {
    const params = { api_key: apiKey, query: title, language: 'en-US' }
    if (year) params.year = year

    const res = await axios.get(`https://api.themoviedb.org/3/search/movie`, {
      params, timeout: 10000
    })
    
    if (res.data.results && res.data.results.length > 0) {
      // Ambil hasil teratas dan fetch metadatanya
      return await fetchMovieMeta(res.data.results[0].id)
    }
    return null
  } catch (err) {
    logger.warn({ event: 'tmdb_search_failed', title, year, msg: err.message })
    return null
  }
}

async function searchMovieMetaMulti(title, language = 'id-ID', year = null) {
  const apiKey = process.env.TMDB_API_KEY
  if (!apiKey) throw new Error('TMDB_API_KEY belum diset di .env')

  try {
    const res = await axios.get(`https://api.themoviedb.org/3/search/movie`, {
      params: {
        api_key: apiKey,
        query: title,
        language,
        include_adult: false,
        ...(year ? { year } : {})
      },
      timeout: 10000
    })

    const results = res.data?.results || []
    if (results.length === 0) return []

    return results.slice(0, 10).map(r => ({
      id:    String(r.id),
      title: r.title || r.original_title || '',
      year:  r.release_date ? r.release_date.slice(0, 4) : '?',
    }))
  } catch (err) {
    logger.warn({ event: 'tmdb_search_multi_failed', title, language, msg: err.message })
    throw new Error('Gagal mencari film di TMDB.')
  }
}

module.exports = { fetchMovieMeta, searchMovieMeta, searchMovieMetaMulti }