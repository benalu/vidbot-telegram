// src/config/topics.js

const GROUP_TOPICS = {
  [process.env.TELEGRAM_GROUP_ID]: {
    leakcheck: process.env.TELEGRAM_THREAD_LEAKCHECK,
    movies:    process.env.TELEGRAM_THREAD_MOVIES,
    flac:      process.env.TELEGRAM_THREAD_FLAC,
    apk:       process.env.TELEGRAM_THREAD_APK,
    vidhub:    process.env.TELEGRAM_THREAD_VIDHUB,
    spotify:   process.env.TELEGRAM_THREAD_SPOTIFY,
    tiktok:    process.env.TELEGRAM_THREAD_SOCIAL,
    instagram: process.env.TELEGRAM_THREAD_SOCIAL,
    twitter:   process.env.TELEGRAM_THREAD_SOCIAL,
    threads:   process.env.TELEGRAM_THREAD_SOCIAL,
    ebooks:    process.env.TELEGRAM_THREAD_EBOOKS,
  }
}

module.exports = GROUP_TOPICS