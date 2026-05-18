const api = require('../api/client')
const { formatTiktok, formatSpotify, formatInstagram, formatTwitter, formatThreads } = require('../formats/content')

async function handleTiktok(ctx) {
  const url = ctx.message.text.split(/\s+/)[1]
  const data = await api.contentTiktok(url)
  const { text, buttons } = formatTiktok(data)
  await ctx.reply(text, {
    parse_mode: 'MarkdownV2',
    message_thread_id: ctx.message.message_thread_id,
    reply_markup: { inline_keyboard: buttons }
  })
}

async function handleSpotify(ctx) {
  const url = ctx.message.text.split(/\s+/)[1]
  const data = await api.contentSpotify(url)
  const { text, buttons } = formatSpotify(data)
  await ctx.reply(text, {
    parse_mode: 'MarkdownV2',
    message_thread_id: ctx.message.message_thread_id,
    reply_markup: { inline_keyboard: buttons }
  })
}

async function handleInstagram(ctx) {
  const url = ctx.message.text.split(/\s+/)[1]
  const data = await api.contentInstagram(url)
  const { text, buttons } = formatInstagram(data)
  await ctx.reply(text, {
    parse_mode: 'MarkdownV2',
    message_thread_id: ctx.message.message_thread_id,
    reply_markup: { inline_keyboard: buttons }
  })
}

async function handleTwitter(ctx) {
  const url = ctx.message.text.split(/\s+/)[1]
  const data = await api.contentTwitter(url)
  const { text, buttons } = formatTwitter(data)
  await ctx.reply(text, {
    parse_mode: 'MarkdownV2',
    message_thread_id: ctx.message.message_thread_id,
    reply_markup: { inline_keyboard: buttons }
  })
}

async function handleThreads(ctx) {
  const url = ctx.message.text.split(/\s+/)[1]
  const data = await api.contentThreads(url)
  const { text, buttons } = formatThreads(data)
  await ctx.reply(text, {
    parse_mode: 'MarkdownV2',
    message_thread_id: ctx.message.message_thread_id,
    reply_markup: { inline_keyboard: buttons }
  })
}

module.exports = { handleTiktok, handleSpotify, handleInstagram, handleTwitter, handleThreads }