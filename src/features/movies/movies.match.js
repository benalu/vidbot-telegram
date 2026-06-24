// src/features/movies/movies.match.js
// Normalisasi & fuzzy match judul film untuk deteksi duplikat lintas provider.
// Tujuan: "Kafir: Gerbang Sukma" dari Ngefilm21 == "KAFIR GERBANG SUKMA (2026)" dari LK21.

'use strict';

// Kata-kata noise yang sering nempel di judul scraping tapi bukan bagian judul asli
const NOISE_WORDS = [
  'sub indo', 'subtitle indonesia', 'subindo', 'indo sub',
  'full movie', 'fullmovie', 'hd', 'cam', 'webrip', 'bluray',
  'download', 'nonton', 'streaming', 'film',
];

/**
 * Normalize title supaya bisa dibandingkan lintas provider.
 * - lowercase
 * - hapus tanda baca (: , . ' " - dll)
 * - hapus noise words (sub indo, hd, dll)
 * - collapse multiple spaces
 * - trim
 */
function normalizeTitle(title) {
  if (!title) return '';

  let t = title.toLowerCase();

  // Hapus noise words dulu (sebelum tanda baca dihapus, biar "sub indo" tetap kebaca sebagai frasa)
  for (const noise of NOISE_WORDS) {
    t = t.replace(new RegExp(`\\b${noise}\\b`, 'gi'), ' ');
  }

  // Hapus semua karakter selain huruf, angka, spasi
  t = t.replace(/[^a-z0-9\s]/g, ' ');

  // Collapse spasi + trim
  t = t.replace(/\s+/g, ' ').trim();

  return t;
}

/**
 * Hitung Levenshtein distance antara dua string.
 * Dipakai untuk fuzzy match kalau normalized title tidak exact sama
 * (misal typo minor atau urutan kata sedikit beda).
 */
function levenshtein(a, b) {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;

  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost
      );
    }
  }
  return dp[m][n];
}

/**
 * Similarity ratio 0..1 berdasarkan Levenshtein distance.
 * 1 = identik, 0 = sama sekali beda.
 */
function similarityRatio(a, b) {
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  return 1 - levenshtein(a, b) / maxLen;
}

/**
 * Cek apakah dua judul kemungkinan film yang sama.
 * threshold default 0.85 — cukup ketat supaya tidak false-positive
 * antar film yang judulnya kebetulan mirip (misal sequel).
 */
function isSameTitle(titleA, titleB, threshold = 0.85) {
  const normA = normalizeTitle(titleA);
  const normB = normalizeTitle(titleB);

  if (!normA || !normB) return false;
  if (normA === normB) return true;

  return similarityRatio(normA, normB) >= threshold;
}

/**
 * Cari film duplikat dari daftar kandidat (hasil searchMoviesLocal),
 * dengan toleransi perbedaan penulisan judul antar provider.
 *
 * @param {string} title       - judul hasil ekstraksi (belum dinormalisasi)
 * @param {string} year        - tahun film
 * @param {Array}  candidates  - hasil dari searchMoviesLocal(title)
 * @returns {object|null}      - entry duplikat kalau ketemu, null kalau tidak
 */
function findDuplicateMovie(title, year, candidates) {
  for (const candidate of candidates) {
    // Tahun harus match kalau dua-duanya ada (toleransi 1 tahun untuk salah parsing rilis vs tayang)
    if (year && candidate.year) {
      const yearDiff = Math.abs(parseInt(year, 10) - parseInt(candidate.year, 10));
      if (yearDiff > 1) continue;
    }

    if (isSameTitle(title, candidate.title)) {
      return candidate;
    }
  }
  return null;
}

module.exports = { normalizeTitle, isSameTitle, similarityRatio, findDuplicateMovie };