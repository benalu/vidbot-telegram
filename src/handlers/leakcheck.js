const api = require('../api/client')

const BLACKLIST = ['admin', 'kontol', 'memek']

async function handleLeakcheck(ctx) {
  const id = ctx.message.text.split(/\s+/)[1]

  if (!id) {
    return ctx.reply('❌ Argument diperlukan\\. Contoh: `/leak user@gmail.com`', {
      parse_mode: 'MarkdownV2',
      message_thread_id: ctx.message.message_thread_id
    })
  }

  if (id === '-total') {
    const data = await api.leakcheckCount()
    const formatted = Number(data.total).toLocaleString('id-ID')
    return ctx.reply(`📊 *Leakcheck Database*\n\nTotal Rows: \`${formatted}\``, {
      parse_mode: 'MarkdownV2',
      message_thread_id: ctx.message.message_thread_id
    })
  }

  if (id.length < 6) {
    return ctx.reply('❌ Minimum 6 karakter', {
      message_thread_id: ctx.message.message_thread_id
    })
  }

  if (BLACKLIST.some(word => id.toLowerCase().includes(word))) {
    return ctx.reply('❌ Kata tersebut tidak diizinkan', {
      message_thread_id: ctx.message.message_thread_id
    })
  }

  if (id.startsWith('http://') || id.startsWith('https://')) {
    return ctx.reply('❌ URL tidak diizinkan', {
      message_thread_id: ctx.message.message_thread_id
    })
  }

  const data = await api.leakcheck(id)

  if (!data.total || data.total === 0) {
    return ctx.reply(`❌ No results found for \`${id}\``, {
      parse_mode: 'MarkdownV2',
      message_thread_id: ctx.message.message_thread_id
    })
  }

  const CHUNK_SIZE = 10
  const chunks = []
  for (let i = 0; i < data.data.length; i += CHUNK_SIZE) {
    chunks.push(data.data.slice(i, i + CHUNK_SIZE))
  }

  for (let i = 0; i < chunks.length; i++) {
    const lines = chunks[i].map(entry => {
      const parts = []
      if (entry.source)   parts.push(`source: ${entry.source}`)
      if (entry.login)    parts.push(`login: ${entry.login}`)
      if (entry.password) parts.push(`password: ${entry.password}`)
      return parts.join('\n')
    }).join('\n────────────────\n')

    const header = i === 0
      ? `📋 ${data.total} result${data.total > 1 ? 's' : ''} for "${id}"\n\n`
      : `📋 page ${i + 1} of ${chunks.length}\n\n`

    await ctx.reply(`\`\`\`\n${header}${lines}\n\`\`\``, {
      parse_mode: 'MarkdownV2',
      message_thread_id: ctx.message.message_thread_id
    })
  }
}

module.exports = { handleLeakcheck }