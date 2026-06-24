// src/features/movies/extractors/ngefilm21.js

'use strict';

const axios   = require('axios');
const cheerio = require('cheerio');
const { getRandomHeaders } = require('../../../utils/http');
const { mirrorLoop, tryExtract } = require('./base');
const { getTargetDomains } = require('./domains');

const VIDARATO_BASE = 'https://vidara.to';

/**
 * Ekstrak M3U8 dari halaman Ngefilm21.
 * Support: Vidarato API + domain rotation (eval unpack).
 * @returns {Promise<{ title, year, m3u8Url, referer }>}
 */
async function extractNgefilm21(pageUrl, proxy, workerUrl) {
  if (!workerUrl) throw new Error('WORKER_URL belum diset di .env — dibutuhkan untuk Ngefilm21.');

  // Step 1: Fetch halaman via worker
  const parsedUrl = new URL(pageUrl);
  const playerNum = parsedUrl.searchParams.get('player') || '1';

  const mainRes = await axios.post(workerUrl, {
    url: pageUrl,
    headers: getRandomHeaders(),
  }, { timeout: 15000 });

  const $ = cheerio.load(mainRes.data);
  let title = ($('title').text() || '')
    .split(' - NGEFILM21')[0].split(' - Nonton')[0]
    .split(' | ')[0].split(' – ')[0].trim()
    || 'Judul Tidak Ditemukan';

  let year = '';
  const ym = title.match(/\((\d{4})\)/);
  if (ym) { year = ym[1]; title = title.replace(/\(\d{4}\)/, '').trim(); }

  const overview = $('div.entry-content.entry-content-single > p > span').first().text().trim() || '';


  // Step 2: Ambil iframe src (support lazy-load)
  const iframeEl = $(`#player-${playerNum} iframe`);
  const rawSrc   = iframeEl.attr('data-litespeed-src')
                || iframeEl.attr('data-src')
                || iframeEl.attr('data-lazy')
                || iframeEl.attr('data-original')
                || iframeEl.attr('src');
  if (!rawSrc || rawSrc === 'about:blank')
    throw new Error(`Iframe Player ${playerNum} tidak ditemukan di halaman Ngefilm21.`);

  const embedUrl    = rawSrc.startsWith('//') ? 'https:' + rawSrc : rawSrc;
  const parsedEmbed = new URL(embedUrl);

  // Step 3: Vidarato path — deteksi dari hostname, bukan nomor player
  if (parsedEmbed.hostname.includes('vidara.to')) {
    const fcMatch = embedUrl.match(/\/e\/([^/?#]+)/);
    if (!fcMatch) throw new Error('Ngefilm21/Vidarato: filecode tidak ditemukan.');
    const filecode   = fcMatch[1];
    const refererUrl = `${VIDARATO_BASE}/e/${filecode}`;

    const apiRes = await axios.post(`${VIDARATO_BASE}/api/stream`, { filecode, device: 'web' }, {
      headers: {
        'Content-Type':   'application/json',
        'Origin':         VIDARATO_BASE,
        'Referer':        refererUrl,
        'User-Agent':     getRandomHeaders()['User-Agent'],
      },
      timeout: 10000,
      proxy,
    });

    const m3u8Url = apiRes.data.streaming_url;
    if (!m3u8Url) throw new Error('Ngefilm21/Vidarato: streaming_url tidak ada di response.');
    return { title, year, m3u8Url, referer: refererUrl, overview };
  }

  // Step 4: Mirror domain loop + eval unpack
  const playerKey = `player${playerNum}`;
  const domains   = getTargetDomains('NGEFILM21', playerKey);

  if (domains.length > 0) {
    const { m3u8Url, sourceUrl } = await mirrorLoop(
      domains, parsedEmbed.pathname, parsedUrl.origin + '/', proxy, 'NGEFILM21'
    );
    return { title, year, m3u8Url, referer: sourceUrl, overview };
  }

  // Fallback: langsung ke embed domain asli
  const m3u8Url = await tryExtract(embedUrl, parsedEmbed.host, parsedUrl.origin + '/', proxy);
  if (!m3u8Url) throw new Error('Gagal mengekstrak M3U8 dari Ngefilm21.');
  return { title, year, m3u8Url, referer: embedUrl, overview };
}

module.exports = { extractNgefilm21 };