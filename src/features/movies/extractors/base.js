// src/features/movies/extractors/base.js
// Shared logic untuk semua extractor: mirror domain loop + eval unpack.

'use strict';

const axios  = require('axios');
const logger = require('../../../utils/logger');
const { getRandomHeaders } = require('../../../utils/http');
const { unpackEval }       = require('../../../utils/unpack');

/**
 * Coba ekstrak M3U8 dari satu embed URL.
 * Metode: modern API stream → fallback eval unpack.
 *
 * @param {string} testUrl   - URL embed yang akan di-fetch
 * @param {string} domain    - hostname untuk header Host
 * @param {string} referer   - URL referer (halaman film)
 * @param {object|null} proxy
 * @returns {string|null}    - M3U8 URL atau null
 */
async function tryExtract(testUrl, domain, referer, proxy) {
  const headers = { ...getRandomHeaders(), 'Host': domain, 'Referer': referer };
  const res     = await axios.get(testUrl, { headers, timeout: 8000, proxy });
  const html    = res.data;

  // Metode modern: API stream URL langsung
  if (!html.includes('eval(function(p,a,c,k,e,d)')) {
    const apiMatch = html.match(/["'](https?:\/\/[^"']+\/stream\/[^"']+)["']/i);
    if (apiMatch) {
      const apiRes  = await axios.get(apiMatch[1], { headers: { ...headers, 'Referer': testUrl }, proxy });
      const m3u8Url = apiRes.data.url || apiRes.data.stream_url || apiRes.data.file;
      if (m3u8Url) return m3u8Url;
    }
  }

  // Fallback: unpack eval packer
  const source = unpackEval(html) || html;

  const streamMatch = source.match(/"[^"]+"\s*:\s*"(\/stream\/[^"]+)"/i);
  if (streamMatch) return `https://${domain}${streamMatch[1]}`;

  const m3u8Match = source.match(/(https?:\/\/[^"']+\.m3u8[^"']*)/i);
  if (m3u8Match) return m3u8Match[1];

  return null;
}

/**
 * Loop semua domain mirror, return hasil pertama yang berhasil.
 * Throw kalau semua gagal.
 *
 * @param {string[]} domains
 * @param {string}   pathname     - path dari embed URL asli
 * @param {string}   referer      - URL referer (halaman film)
 * @param {object|null} proxy
 * @param {string}   providerName - untuk log event
 * @returns {Promise<{ m3u8Url: string, sourceUrl: string }>}
 */
async function mirrorLoop(domains, pathname, referer, proxy, providerName) {
  for (const domain of domains) {
    const testUrl = `https://${domain}${pathname}`;
    try {
      const m3u8Url = await tryExtract(testUrl, domain, referer, proxy);
      if (m3u8Url) return { m3u8Url, sourceUrl: testUrl };
    } catch (err) {
      logger.warn({ event: `${providerName}_mirror_failed`, domain, msg: err.message });
    }
  }
  throw new Error(`Semua server mirror ${providerName} tidak merespon.`);
}

module.exports = { tryExtract, mirrorLoop };