// src/handlers/help.js
// Context-aware help — each topic gets its own guide.
// Falls back to a summary of all topics if /help is used outside a known topic.

const GROUP_TOPICS = require('../config/topics')
const { escape }   = require('../formats/utils')

// ---------------------------------------------------------------------------
// Help content per topic
// Each entry is a function returning a MarkdownV2 string.
// ---------------------------------------------------------------------------
const TOPIC_HELP = {

  vidhub: () => `
*Vidhub Downloader*

Download videos from private video hosting sites\\.

*Command*
\`/vids <url>\`

*Supported sites*
\`\`\`
videb.co       videb.lol
vidoy.co       vidoy.cam
vidstrm.cloud  vidstring.com
vidbos.com
vidara.to      vidara.so
vidnest.io
\`\`\`

*Examples*
\`\`\`
/vids videb.co/v/abc123
/vids vidnest.io/embed/xyz
\`\`\`

Paste the URL directly from your browser — with or without \`https://\`\\.
`.trim(),

  leakcheck: () => `
*Leakcheck*

Search for leaked data from breach databases by email, username, or phone number\\.

*Command*
\`/leak <query>\`
\`/leak \\-total\`

*Examples*
\`/leak user@gmail\\.com\`
\`/leak johndoe\`
\`/leak \\-total\`  — show total number of records in the database

*Notes*
— Minimum 6 characters
— URLs are not allowed as a query
— Results are capped at 50 rows per request
`.trim(),

spotify: () => `
*Spotify Downloader*

Download tracks from Spotify in high quality\\.

*Commands*
\`/spot <url>\`      — download via Spotify link
\`/spot <title>\`    — search from collection
\`/random\`          — surprise me\\! random track
\`/top\`             — top 10 most requested

*Example*
\`/spot open\\.spotify\\.com/track/4cOdK2wGLETKBW3PvgPWqT\`

Copy the share URL from Spotify — with or without \`https://\`\\.
`.trim(),

  social: () => `
*Social Media Downloader*

Download videos and media from TikTok, Instagram, Twitter/X, and Threads\\.

*Commands*
\`\`\`
/tik     <url>   TikTok
/inst    <url>   Instagram
/twit    <url>   Twitter / X
/threads <url>   Threads
\`\`\`

*Examples*
\`\`\`
/tik vt.tiktok.com/ZSjkxyz
/inst instagram.com/p/ABC123
/twit x.com/user/status/123456
/threads threads.net/@user/post/abc
\`\`\`

Use the share URL from the app — with or without \`https://\`\\.
`.trim(),

  apk: () => `
*APK Downloader*

Search and download modded Android APKs\\.

*Command*
\`/apk <app name>\`

*Examples*
\`/apk Spotify\`
\`/apk YouTube\`
\`/apk WhatsApp\`

Use the app name, not the package name\\. Minimum 3 characters\\.
`.trim(),

  movies: () => `
*Movie Downloader*

Search and download movies by title\\.

*Command*
\`/movie <title>\`

*Examples*
\`/movie Interstellar\`
\`/movie The Dark Knight\`
\`/movie Oppenheimer 2023\`

Add the release year if the title is too common\\.
`.trim(),

  flac: () => `
  *FLAC Collection*

  Cari dan putar lagu FLAC dari koleksi Vidbot\\.

  *Command*
  \`/flac <judul atau artist>\`

  *Contoh*
  \`/flac Daft Punk\`
  \`/flac Radiohead OK Computer\`
  \`/flac The Weeknd\`

  Semakin spesifik keyword, semakin akurat hasilnya\\.
  `.trim(),

  // Aliases — covers both before and after social topic migration
  tiktok:    (...a) => TOPIC_HELP.social(...a),
  instagram: (...a) => TOPIC_HELP.social(...a),
  twitter:   (...a) => TOPIC_HELP.social(...a),
  threads:   (...a) => TOPIC_HELP.social(...a),

}

// ---------------------------------------------------------------------------
// Fallback — shown when /help is used outside a recognised topic
// ---------------------------------------------------------------------------
function allTopicsHelp() {
  return `
*VidOpsBot*

Use \`/help\` inside each topic for a full guide\\.

*Available topics*
\`\`\`
Leakcheck   — search breach data
Spotify     — download tracks
Social      — TikTok, Instagram, Twitter, Threads
Vidhub      — download from video hosting
APK         — download Android apps
Movies      — download films
FLAC        — download lossless music
\`\`\`
`.trim()
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------
async function handleHelp(ctx) {
  const chatId   = String(ctx.chat.id)
  const threadId = String(ctx.message.message_thread_id)
  const topics   = GROUP_TOPICS[chatId]

  let text = allTopicsHelp()

  if (topics) {
    const topicKey = Object.keys(topics).find(k => String(topics[k]) === threadId)
    if (topicKey && TOPIC_HELP[topicKey]) {
      text = TOPIC_HELP[topicKey]()
    }
  }

  await ctx.reply(text, {
    parse_mode: 'MarkdownV2',
    message_thread_id: ctx.message.message_thread_id
  })
}



module.exports = { handleHelp }