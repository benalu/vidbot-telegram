// src/features/movies/extractors/index.js
// Registry semua provider extractor.
// Untuk tambah provider baru: buat file extractor-nya, daftarkan di EXTRACTORS.

'use strict';

const fs   = require('fs');
const path = require('path');
const { getDomainConfig, getTargetDomains } = require('./domains');

// ─── Provider registry ─────────────────────────────────────────────────────────
// Untuk tambah provider baru (misal REBAHIN):
//   1. Buat file: src/features/movies/extractors/rebahin.js
//   2. Export fungsi: extractRebahin(pageUrl, proxy, workerUrl)
//   3. Daftarkan di bawah: REBAHIN: require('./rebahin').extractRebahin
//   4. Tambah entry di movs-domains.json kalau pakai domain rotation
const EXTRACTORS = {
  LK21:      require('./lk21').extractLk21,
  NGEFILM21: require('./ngefilm21').extractNgefilm21,
  DUTAFILM21: require('./dutamovie21').extractDutafilm,
};

/**
 * Dispatch ke extractor yang sesuai berdasarkan provider string.
 * workerUrl dioper dari spider-movs supaya extractor tidak akses env langsung.
 */
async function extractStream(provider, pageUrl, proxy, workerUrl) {
  const extractor = EXTRACTORS[provider];
  if (!extractor) throw new Error(`Provider tidak dikenal: ${provider}`);
  return extractor(pageUrl, proxy, workerUrl);
}

module.exports = { extractStream, getDomainConfig, getTargetDomains };