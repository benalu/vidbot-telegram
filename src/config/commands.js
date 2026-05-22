// src/config/commands.js
// Daftarkan semua command bot di sini.
// index.js membaca file ini — tidak perlu disentuh kalau hanya tambah/hapus command.
//
// Schema tiap command:
//   topic       : key di GROUP_TOPICS (harus cocok dengan topics.js)
//   handler     : fungsi async (ctx) => void
//   requiresArg : true → index.js cek ada argument sebelum panggil handler

const { handleTiktok, handleInstagram, handleTwitter, handleThreads } = require('../features/social/social.handler')
const { handleSpotify } = require('../features/spotify/spotify.handler')
const { handleVidhub }     = require('../handlers/vidhub')
const { handleMovies }     = require('../handlers/movies')
const { handleFlacCollection } = require('../features/flac/flac.handler')
const { handleAppAndroid } = require('../handlers/app')
const { handleLeakcheck }  = require('../handlers/leakcheck')

const COMMANDS = {
  leak:    { topic: 'leakcheck', handler: handleLeakcheck,      requiresArg: true },
  spot:    { topic: 'spotify',   handler: handleSpotify,        requiresArg: true },
  tik:     { topic: 'tiktok',    handler: handleTiktok,         requiresArg: true },
  inst:    { topic: 'instagram', handler: handleInstagram,      requiresArg: true },
  twit:    { topic: 'twitter',   handler: handleTwitter,        requiresArg: true },
  threads: { topic: 'threads',   handler: handleThreads,        requiresArg: true },
  vids:    { topic: 'vidhub',    handler: handleVidhub,         requiresArg: true },
  apk:     { topic: 'apk',       handler: handleAppAndroid,     requiresArg: true },
  movie:   { topic: 'movies',    handler: handleMovies,         requiresArg: true },
  flac:    { topic: 'flac',      handler: handleFlacCollection, requiresArg: false },
}

module.exports = COMMANDS