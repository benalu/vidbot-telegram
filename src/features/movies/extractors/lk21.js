// src/features/movies/extractors/lk21.js

'use strict';

const axios   = require('axios');
const cheerio = require('cheerio');
const { getRandomHeaders, axiosGetWithRetry } = require('../../../utils/http');
const { getDomainConfig } = require('./domains');

/**
 * Ekstrak M3U8 dari halaman LK21 via Turbovip.
 * @returns {Promise<{ title, year, m3u8Url, referer }>}
 */
async function extractLk21(pageUrl, proxy) {
  // Step 1: Fetch halaman film
  let pageData;
  try {
    const res = await axiosGetWithRetry(pageUrl, {
      headers: getRandomHeaders(),
      timeout: 15000,
      proxy,
    });
    if (res.status === 403) throw new Error('Akses ditolak (HTTP 403) — kemungkinan Cloudflare memblokir.');
    pageData = res.data;
  } catch (err) {
    if (err.response?.status === 403) throw new Error('Akses ditolak (HTTP 403) — kemungkinan Cloudflare memblokir.');
    throw err;
  }

  // Cloudflare check
  if (typeof pageData === 'string' && (
    pageData.includes('cf-browser-verification') ||
    pageData.includes('Just a moment')           ||
    pageData.includes('Checking your browser')   ||
    pageData.includes('cf_clearance')
  )) throw new Error('Halaman LK21 diblokir Cloudflare. Coba pakai flag -proxy.');

  const $ = cheerio.load(pageData);

  // Parse judul
  let title = ($('div.movie-info > h1').text() || $('h1').first().text())
    .replace(/^Nonton\s+/i, '').replace(/^Download\s+Film\s+/i, '')
    .replace(/^Nonton\s+Film\s+/i, '').replace(/^Film\s+/i, '')
    .replace(/\s*Sub(?:title)?\s+Indo(?:nesia)?\s+di\s+Lk21\s*$/i, '')
    .replace(/\s*Sub(?:title)?\s+Indo(?:nesia)?\s*$/i, '')
    .replace(/\s*\|\s*.*$/i, '').replace(/\s+/g, ' ').trim();
  if (!title) throw new Error('Gagal mengekstrak judul. Struktur halaman LK21 mungkin berubah.');

  let year = '';
  const yearMatch = title.match(/\((\d{4})\)/);
  if (yearMatch) { year = yearMatch[1]; title = title.replace(/\(\d{4}\)/, '').trim(); }

  const overview = $('div.synopsis.expanded').text().trim() || '';

  // Cari turbovip URL
  let turbovipUrl = $('ul#player-list li a[data-server="turbovip"]').attr('data-url')
                 || $('ul#player-list li a[data-server="turbovip"]').attr('href');
  if (!turbovipUrl) {
    $('iframe').each((_, el) => {
      const src = $(el).attr('src');
      if (src?.includes('/turbovip/')) { turbovipUrl = src; return false; }
    });
  }
  if (!turbovipUrl) throw new Error('Iframe Turbovip tidak ditemukan di halaman LK21.');

  // Step 2: Ekstrak video ID
  const idMatch = turbovipUrl.match(/turbovip\/([a-zA-Z0-9]+)/);
  if (!idMatch) throw new Error('Format URL Turbovip tidak valid.');
  const videoId = idMatch[1];

  // Step 3: Baca embedDomain dari movs-domains.json
  const turbovipCfg = getDomainConfig('LK21', 'turbovip');
  const embedDomain = turbovipCfg?.embedDomain;
  if (!embedDomain) throw new Error('embedDomain untuk LK21/turbovip tidak ada di movs-domains.json.');

  // Step 4: GET embed URL, ikuti redirect manual
  const embedUrl     = `https://${embedDomain}/t/${videoId}`;
  const embedHeaders = {
    ...getRandomHeaders(),
    'Host':    embedDomain,
    'Referer': 'https://playeriframe.sbs/',
    'Upgrade-Insecure-Requests': '1',
  };

  const step3Res = await axios.get(embedUrl, {
    headers:        embedHeaders,
    maxRedirects:   0,
    validateStatus: s => s === 301 || s === 302 || (s >= 200 && s < 300),
    timeout:        10000,
    proxy,
  });

  const locationUrl = step3Res.headers['location'];
  if (!locationUrl) throw new Error(`Redirect location tidak ditemukan dari ${embedDomain}.`);

  // Step 5: Fetch halaman player → ambil m3u8
  const parsedLoc = new URL(locationUrl);
  const step4Res  = await axios.get(locationUrl, {
    headers: { ...getRandomHeaders(), 'Host': parsedLoc.host, 'Referer': 'https://playeriframe.sbs/' },
    timeout: 10000,
    proxy,
  });

  const $p = cheerio.load(step4Res.data);
  let m3u8Url = $p('#video_player').attr('data-hash');
  if (!m3u8Url) {
    const sm = step4Res.data.match(/var\s+urlPlay\s*=\s*['"]([^'"]+\.m3u8[^'"]*)['"]/i);
    if (sm) m3u8Url = sm[1];
  }
  if (!m3u8Url) throw new Error('Gagal mengekstrak M3U8 dari halaman Turbovid.');

  return { title, year, m3u8Url, referer: locationUrl, overview };
}

module.exports = { extractLk21 };