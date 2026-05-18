const api = require('../api/client')
const { formatMovies } = require('../formats/movies')

async function handleMovies(ctx) {
  const keyword = ctx.message.text.split(/\s+/).slice(1).join(' ')

  if (keyword.length < 2) {
    return ctx.reply('❌ Minimum 2 karakter', {
      message_thread_id: ctx.message.message_thread_id
    })
  }

  const data = await api.moviesSearch(keyword)

  if (!data.total || data.total === 0) {
    return ctx.reply(`❌ Not Found: ${keyword}`, {
      message_thread_id: ctx.message.message_thread_id
    })
  }

  for (const movie of data.data) {
    const { text, buttons } = formatMovies(movie)
    await ctx.reply(text, {
      parse_mode: 'MarkdownV2',
      message_thread_id: ctx.message.message_thread_id,
      reply_markup: { inline_keyboard: buttons }
    })
  }
}

module.exports = { handleMovies }