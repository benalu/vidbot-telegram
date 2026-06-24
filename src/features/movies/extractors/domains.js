// src/features/movies/extractors/domains.js
'use strict';

const fs   = require('fs');
const path = require('path');

const DOMAINS_PATH = path.join(__dirname, '../../../config/movs-domains.json');

function getDomainConfig(provider, playerKey) {
  try {
    if (fs.existsSync(DOMAINS_PATH)) {
      const cfg = JSON.parse(fs.readFileSync(DOMAINS_PATH, 'utf8'));
      return cfg[provider]?.[playerKey] ?? null;
    }
  } catch { /* silent */ }
  return null;
}

function getTargetDomains(provider, playerKey) {
  return getDomainConfig(provider, playerKey)?.targetDomains ?? [];
}

module.exports = { getDomainConfig, getTargetDomains };