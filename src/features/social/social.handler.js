const api = require('../../api/client')
const { normalizeUrl } = require('../../formats/utils')
const { formatTiktok, formatInstagram, formatTwitter, formatThreads } = require('./social.format')
const { formatSpotify } = require('../spotify/spotify.format')

function replyOpts(ctx) {
  return { message_thread_id: ctx.message.message_thread_id }
}

// Ekstrak dan normalisasi URL dari teks command, return null kalau tidak valid
function parseUrl(ctx) {
  const raw = ctx.message.text.split(/\s+/)[1]
  return normalizeUrl(raw)
}

async function handleTiktok(ctx) {
  const url = parseUrl(ctx)
  if (!url) {
    return ctx.reply('❌ URL tidak valid\\. Contoh: `/tik tiktok\\.com/video/\\.\\.\\.`', {
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
  const url = parseUrl(ctx)
  if (!url) {
    return ctx.reply('❌ URL tidak valid\\. Contoh: `/spot open\\.spotify\\.com/track/\\.\\.\\.`', {
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
  const url = parseUrl(ctx)
  if (!url) {
    return ctx.reply('❌ URL tidak valid\\. Contoh: `/inst instagram\\.com/p/\\.\\.\\.`', {
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
  const url = parseUrl(ctx)
  if (!url) {
    return ctx.reply('❌ URL tidak valid\\. Contoh: `/twit x\\.com/user/status/\\.\\.\\.`', {
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
  const url = parseUrl(ctx)
  if (!url) {
    return ctx.reply('❌ URL tidak valid\\. Contoh: `/threads threads\\.net/\\@user/post/\\.\\.\\.`', {
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