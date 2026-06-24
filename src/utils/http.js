// src/utils/http.js
// Shared HTTP utilities: randomized headers, gaussian delay, axios retry.
// Dipindah dari spider-lk21.js agar bisa dipakai spider lain.

const axios  = require('axios');
const logger = require('./logger');

// ─── Random delay dengan distribusi Gaussian ──────────────────────────────────
// Digabung jadi satu fungsi — gaussianRandom hanya dipakai oleh randomDelay.
const randomDelay = (min = 1500, max = 3500) => new Promise(resolve => {
  let u, v;
  do { u = Math.random(); } while (u === 0);
  do { v = Math.random(); } while (v === 0);
  const n = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v) / 10 + 0.5;
  if (n < 0 || n > 1) return randomDelay(min, max).then(resolve);
  setTimeout(resolve, Math.floor(n * (max - min) + min));
});

// ─── Randomized browser headers ───────────────────────────────────────────────
const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:123.0) Gecko/20100101 Firefox/123.0',
];

const REFERERS = [
  'https://www.google.com/search?q=nonton+film+terbaru',
  'https://www.google.com/search?q=nonton+film+subtitle+indonesia',
  'https://www.google.com/',
  'https://www.facebook.com/',
];

const getRandomHeaders = () => ({
  'User-Agent': USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)],
  'Accept':     'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Referer':    REFERERS[Math.floor(Math.random() * REFERERS.length)],
});

// ─── Axios GET dengan retry otomatis ─────────────────────────────────────────
// maxAttempts=3 → 1 attempt awal + 2 retry dengan exponential backoff.
// HTTP 403/404 langsung throw — tidak ada gunanya retry.
// HTTP 429 throw dengan pesan yang actionable.
async function axiosGetWithRetry(url, opts, maxAttempts = 3) {
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await axios.get(url, opts);
    } catch (err) {
      lastErr = err;
      const status = err.response?.status;
      if (status === 403 || status === 404) throw err;
      if (status === 429) throw new Error('Worker rate limit tercapai (HTTP 429). Coba lagi beberapa jam lagi.');
      if (attempt < maxAttempts) {
        logger.warn({ event: 'axios_retry', attempt, url: url.slice(0, 80), msg: err.message });
        await new Promise(r => setTimeout(r, attempt * 2000));
      }
    }
  }
  throw lastErr;
}

module.exports = { randomDelay, getRandomHeaders, axiosGetWithRetry };