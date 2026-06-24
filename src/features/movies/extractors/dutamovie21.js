// src/features/movies/extractors/dutafilm.js

'use strict';

const axios   = require('axios');
const cheerio = require('cheerio');
const { getRandomHeaders } = require('../../../utils/http');
const { mirrorLoop, tryExtract } = require('./base');
const { getTargetDomains } = require('./domains');

/**
 * Ekstrak M3U8 dari halaman Dutafilm.
 * Support: domain rotation + eval unpack.
 * @returns {Promise<{ title, year, m3u8Url, referer }>}
 */
async function extractDutamovie21(pageUrl, proxy, workerUrl) {
  if (!workerUrl) throw new Error('WORKER_URL belum diset di .env — dibutuhkan untuk Dutamovie21.');

  const parsedUrl = new URL(pageUrl);
  const playerNum = parsedUrl.searchParams.get('player') || '1';

  // Step 1: Fetch via worker
  const mainRes = await axios.post(workerUrl, {
    url: pageUrl,
    headers: getRandomHeaders(),
  }, { timeout: 15000 });

  const $ = cheerio.load(mainRes.data);
  let title = ($('title').text() || '').split(' - Nonton')[0].trim() || 'Judul Tidak Ditemukan';

  let year = '';
  const ym = title.match(/\((\d{4})\)/);
  if (ym) { year = ym[1]; title = title.replace(/\(\d{4}\)/, '').trim(); }

  const overview = $('div.entry-content.entry-content-single > p').first().text().trim() || '';

  // Step 2: Ambil iframe
  const rawSrc = $(`#player-${playerNum} iframe`).attr('src');
  if (!rawSrc) throw new Error(`Iframe Player ${playerNum} tidak ditemukan di halaman Dutafilm.`);
  const embedUrl    = rawSrc.startsWith('//') ? 'https:' + rawSrc : rawSrc;
  const parsedEmbed = new URL(embedUrl);

  // Step 3: Mirror domain loop + eval unpack
  const playerKey = `player${playerNum}`;
  const domains   = getTargetDomains('DUTAFILM21', playerKey);

  if (domains.length > 0) {
    const { m3u8Url, sourceUrl } = await mirrorLoop(
      domains, parsedEmbed.pathname, parsedUrl.origin + '/', proxy, 'DUTAMOVIE21'
    );
    return { title, year, m3u8Url, referer: sourceUrl, overview };
  }

  // Fallback: langsung ke embed domain asli
  const m3u8Url = await tryExtract(embedUrl, parsedEmbed.host, parsedUrl.origin + '/', proxy);
  if (!m3u8Url) throw new Error('Gagal mengekstrak M3U8 dari Dutamovie21.');
  return { title, year, m3u8Url, referer: embedUrl, overview };
}

module.exports = { extractDutafilm };