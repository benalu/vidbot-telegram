// src/utils/api-sync-movies.js
const axios  = require('axios')
const logger = require('./logger')

const REST_API_URL = process.env.REST_API_URL
const REST_API_KEY = process.env.REST_API_MASTER_KEY

async function syncMovieToApi(movie) {
  if (!REST_API_URL || !REST_API_KEY || !movie.r2_url) return

  try {
    await axios.post(
      `${REST_API_URL}/admin/downloader/movies`,
      {
        id_tmdb:  movie.tmdb_id,
        title:    movie.title,
        year:     movie.year,
        duration: movie.duration,
        rating:   movie.rating,
        genre:    movie.genre,
        poster:   movie.poster,
        overview: movie.overview,
        url_1:    movie.r2_url,
      },
      { headers: { 'X-Master-Key': REST_API_KEY }, timeout: 10_000 }
    )
    logger.info({ event: 'api_sync_ok', type: 'movie', title: movie.title })
  } catch (err) {
    logger.warn({ event: 'api_sync_failed', type: 'movie', title: movie.title, msg: err.message })
  }
}

module.exports = { syncMovieToApi }