// src/utils/api-sync-ebooks.js
// Tambahkan fungsi ini ke src/utils/api-sync.js yang sudah ada,
// atau buat file terpisah dan re-export dari api-sync.js

const axios  = require('axios')
const logger = require('./logger')

const REST_API_URL = process.env.REST_API_URL
const REST_API_KEY = process.env.REST_API_MASTER_KEY

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

async function syncEbookToApi(entry) {
  if (!isReady(entry.r2_url)) return

  try {
    await axios.post(
      `${REST_API_URL}/admin/downloader/ebooks`,
      {
        title:     entry.title     || '',
        author:    entry.author    || '',
        genres:    entry.genres    || '',
        publisher: entry.publisher || '',
        published: entry.published || '',
        thumbnail: entry.thumbnail || '',
        language:  entry.language  || 'Indonesian',
        url_1:     entry.r2_url,
      },
      {
        headers: { 'X-Master-Key': REST_API_KEY },
        timeout: 10_000,
      }
    )
    logger.info({ event: 'api_sync_ok', type: 'ebook', title: entry.title })
  } catch (err) {
    const code = err?.response?.data?.code
    const msg  = err?.response?.data?.message || err.message
    logger.warn({ event: 'api_sync_failed', type: 'ebook', title: entry.title, code, msg })
  }
}

async function deleteEbookFromApi(ebookId) {
  if (!REST_API_URL || !REST_API_KEY) {
    logger.warn({ event: 'api_delete_skipped', reason: 'env not set', ebook_id: ebookId })
    return
  }
  try {
    await axios.delete(
      `${REST_API_URL}/admin/downloader/ebooks/${ebookId}`,
      {
        headers: { 'X-Master-Key': REST_API_KEY },
        timeout: 10_000,
      }
    )
    logger.info({ event: 'api_delete_ok', type: 'ebook', ebook_id: ebookId })
  } catch (err) {
    if (err?.response?.status === 404) {
      logger.info({ event: 'api_delete_not_found', type: 'ebook', ebook_id: ebookId })
      return
    }
    const code = err?.response?.data?.code
    const msg  = err?.response?.data?.message || err.message
    logger.warn({ event: 'api_delete_failed', type: 'ebook', ebook_id: ebookId, code, msg })
  }
}

module.exports = { syncEbookToApi, deleteEbookFromApi }