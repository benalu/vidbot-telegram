const api = require('../api/client')
const { formatVidhub } = require('../formats/vidhub')

const VIDHUB_SITES = {
  'videb.co': 'videb', 'videb.lol': 'videb',
  'vidoy.co': 'vidoy', 'vidoy.cam': 'vidoy',
  'vidstrm.cloud': 'vidoy', 'vidstring.com': 'vidoy',
  'vidbos.com': 'vidbos',
  'vidara.to': 'vidarato', 'vidara.so': 'vidarato',
  'vidnest.io': 'vidnest',
}

async function handleVidhub(ctx) {
  const url = ctx.message.text.split(/\s+/)[1]

  let hostname
  try {
    hostname = new URL(url).hostname.replace('www.', '')
  } catch {
    return ctx.reply('❌ URL tidak valid', {
      message_thread_id: ctx.message.message_thread_id
    })
  }

  const site = VIDHUB_SITES[hostname]
  if (!site) {
    return ctx.reply(`❌ Domain \`${hostname}\` tidak didukung`, {
      message_thread_id: ctx.message.message_thread_id
    })
  }

  const data = await api.vidhub(site, url)
  const { text, buttons } = formatVidhub(data)
  await ctx.reply(text, {
    parse_mode: 'MarkdownV2',
    message_thread_id: ctx.message.message_thread_id,
    reply_markup: { inline_keyboard: buttons }
  })
}

module.exports = { handleVidhub }