const api = require('../api/client')
const { formatTiktok, formatSpotify, formatInstagram, formatTwitter, formatThreads } = require('../formats/content')

function isValidUrl(str) {
  try {
    const url = new URL(str)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

function replyOpts(ctx) {
  return { message_thread_id: ctx.message.message_thread_id }
}

async function handleTiktok(ctx) {
  const url = ctx.message.text.split(/\s+/)[1]
  if (!isValidUrl(url)) {
    return ctx.reply('❌ URL tidak valid. Contoh: `/tik https://vt.tiktok.com/...`', {
      parse_mode: 'MarkdownV2',
      ...replyOpts(ctx)
    })
  }
  const data = await api.contentTiktok(url)
  const { text, buttons } = formatTiktok(data)
  await ctx.reply(text, {
    parse_mode: 'MarkdownV2',
    reply_markup: { inline_keyboard: buttons },
    ...replyOpts(ctx)
  })
}

async function handleSpotify(ctx) {
  const url = ctx.message.text.split(/\s+/)[1]
  if (!isValidUrl(url)) {
    return ctx.reply('❌ URL tidak valid. Contoh: `/spot https://open.spotify.com/track/...`', {
      parse_mode: 'MarkdownV2',
      ...replyOpts(ctx)
    })
  }
  const data = await api.contentSpotify(url)
  const { text, buttons } = formatSpotify(data)
  await ctx.reply(text, {
    parse_mode: 'MarkdownV2',
    reply_markup: { inline_keyboard: buttons },
    ...replyOpts(ctx)
  })
}

async function handleInstagram(ctx) {
  const url = ctx.message.text.split(/\s+/)[1]
  if (!isValidUrl(url)) {
    return ctx.reply('❌ URL tidak valid. Contoh: `/inst https://www.instagram.com/p/...`', {
      parse_mode: 'MarkdownV2',
      ...replyOpts(ctx)
    })
  }
  const data = await api.contentInstagram(url)
  const { text, buttons } = formatInstagram(data)
  await ctx.reply(text, {
    parse_mode: 'MarkdownV2',
    reply_markup: { inline_keyboard: buttons },
    ...replyOpts(ctx)
  })
}

async function handleTwitter(ctx) {
  const url = ctx.message.text.split(/\s+/)[1]
  if (!isValidUrl(url)) {
    return ctx.reply('❌ URL tidak valid. Contoh: `/twit https://x.com/...`', {
      parse_mode: 'MarkdownV2',
      ...replyOpts(ctx)
    })
  }
  const data = await api.contentTwitter(url)
  const { text, buttons } = formatTwitter(data)
  await ctx.reply(text, {
    parse_mode: 'MarkdownV2',
    reply_markup: { inline_keyboard: buttons },
    ...replyOpts(ctx)
  })
}

async function handleThreads(ctx) {
  const url = ctx.message.text.split(/\s+/)[1]
  if (!isValidUrl(url)) {
    return ctx.reply('❌ URL tidak valid. Contoh: `/threads https://www.threads.net/...`', {
      parse_mode: 'MarkdownV2',
      ...replyOpts(ctx)
    })
  }
  const data = await api.contentThreads(url)
  const { text, buttons } = formatThreads(data)
  await ctx.reply(text, {
    parse_mode: 'MarkdownV2',
    reply_markup: { inline_keyboard: buttons },
    ...replyOpts(ctx)
  })
}

module.exports = { handleTiktok, handleSpotify, handleInstagram, handleTwitter, handleThreads }