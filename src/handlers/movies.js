// src/handlers/movies.js
const { escape } = require('../formats/utils')
const { searchMoviesLocal } = require('../features/movies/movies.repo')

const ARCHIVE_CHANNEL = process.env.TELEGRAM_ARCHIVE_MOVS_CHANNEL_ID;

async function handleMovies(ctx) {
  const keyword = ctx.message.text.split(/\s+/).slice(1).join(' ').trim()
  if (keyword.length < 2) {
    return ctx.reply('❌ Minimum 2 karakter', { message_thread_id: ctx.message.message_thread_id })
  }

  const results = searchMoviesLocal(keyword)
  if (!results.length) {
    return ctx.reply(`❌ Not Found: ${escape(keyword)}\n_Koleksi film diupload manual oleh admin._`, {
      parse_mode: 'MarkdownV2',
      message_thread_id: ctx.message.message_thread_id
    })
  }

  // Tampilkan maksimal 3 hasil agar tidak spam
  const toShow = results.slice(0, 3)
  
  for (const movie of toShow) {
    const caption = [
      `🎬 *${escape(movie.title)}* \\(${escape(movie.year)}\\)`,
      `⭐ ${escape(movie.rating)} | ⏱️ ${escape(movie.duration)}`,
      `🎭 ${escape(movie.genre)}`,
      ``,
      `> ${escape(movie.overview.length > 200 ? movie.overview.slice(0, 197) + '...' : movie.overview)}`
    ].join('\n')

    // Siapkan tombol R2 sebagai opsi tambahan
    const buttons = []
    if (movie.r2_url) {
      buttons.push([{ text: '⬇️ Download External (R2)', url: movie.r2_url }])
    }

    // ✨ BOT MENG-COPY DARI ARCHIVE CHANNEL KE GRUP PUBLIK
    // Karena menggunakan copyMessage, file 2GB akan muncul langsung (native) seketika!
    await ctx.telegram.copyMessage(
      ctx.chat.id, 
      ARCHIVE_CHANNEL, 
      movie.message_id, 
      {
        caption: caption,
        parse_mode: 'MarkdownV2',
        message_thread_id: ctx.message.message_thread_id,
        reply_markup: buttons.length ? { inline_keyboard: buttons } : undefined
      }
    ).catch(err => {
      // Fallback jika pesan di archive terhapus
      ctx.reply(`❌ Gagal memuat video untuk ${escape(movie.title)}. File mungkin telah dihapus dari Archive.`, {
         message_thread_id: ctx.message.message_thread_id 
      })
    })
  }
}

module.exports = { handleMovies }