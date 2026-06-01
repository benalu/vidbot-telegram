// src/utils/tmdb.js
const axios = require('axios')
const logger = require('./logger')

async function fetchMovieMeta(tmdbId) {
  const apiKey = process.env.TMDB_API_KEY
  if (!apiKey) throw new Error('TMDB_API_KEY belum diset di .env')

  try {
    const res = await axios.get(`https://api.themoviedb.org/3/movie/${tmdbId}`, {
      params: { api_key: apiKey, language: 'en-US' },
      timeout: 10000
    })
    
    const d = res.data
    return {
      tmdb_id: String(d.id),
      title: d.title || '',
      year: d.release_date ? d.release_date.slice(0, 4) : '',
      duration: d.runtime ? `${d.runtime} min` : '',
      rating: d.vote_average ? d.vote_average.toFixed(1) : '',
      genre: d.genres ? d.genres.map(g => g.name).join(', ') : '',
      poster: d.poster_path ? `https://image.tmdb.org/t/p/original${d.poster_path}` : '',
      overview: d.overview || ''
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

module.exports = { fetchMovieMeta, searchMovieMeta }