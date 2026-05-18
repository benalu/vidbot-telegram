const api = require('../api/client')
const { formatApp } = require('../formats/app')

async function handleAppAndroid(ctx) {
  const keyword = ctx.message.text.split(/\s+/).slice(1).join(' ')

  if (keyword.length < 3) {
    return ctx.reply('❌ Minimum 3 karakter', {
      message_thread_id: ctx.message.message_thread_id
    })
  }

  const data = await api.appAndroid(keyword)

  if (!data.total || data.total === 0) {
    return ctx.reply(`❌ Not Found: ${keyword}`, {
      message_thread_id: ctx.message.message_thread_id
    })
  }

  for (const app of data.data) {
    const { text, buttons } = formatApp(app)

    if (app.image) {
      await ctx.replyWithPhoto(app.image, {
        caption: text,
        parse_mode: 'MarkdownV2',
        message_thread_id: ctx.message.message_thread_id,
        reply_markup: { inline_keyboard: buttons }
      })
    } else {
      await ctx.reply(text, {
        parse_mode: 'MarkdownV2',
        message_thread_id: ctx.message.message_thread_id,
        reply_markup: { inline_keyboard: buttons }
      })
    }
  }
}

module.exports = { handleAppAndroid }