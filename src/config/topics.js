// src/config/topics.js

const GROUP_TOPICS = {
  [process.env.TELEGRAM_GROUP_ID]: {
    leakcheck: process.env.TELEGRAM_THREAD_LEAKCHECK,
    movies:    process.env.TELEGRAM_THREAD_MOVIES,
    flac:      process.env.TELEGRAM_THREAD_FLAC,
    apk:       process.env.TELEGRAM_THREAD_APK,
    vidhub:    process.env.TELEGRAM_THREAD_VIDHUB,
    tiktok:    process.env.TELEGRAM_THREAD_TIKTOK,
    spotify:   process.env.TELEGRAM_THREAD_SPOTIFY,
    instagram: process.env.TELEGRAM_THREAD_INSTAGRAM,
    twitter:   process.env.TELEGRAM_THREAD_TWITTER,
    threads:   process.env.TELEGRAM_THREAD_THREADS,
  }
}

module.exports = GROUP_TOPICS