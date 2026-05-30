// src/features/ebooks/ebooks.handler.js
// Handler untuk command /ebooks di grup publik

const logger = require('../../utils/logger')
const { escape } = require('../../formats/utils')
const { searchEbooks, getEbookById, incrementEbookRequestCount } = require('./ebooks.repo')

const SEARCH_PAGE_SIZE = 5
const SEARCH_CACHE_TTL = 10 * 60 * 1000
const SEARCH_CACHE_MAX = 300
const searchCache      = new Map()

function cacheSearch(userId, keyword, results) {
  const key = `eb:${userId}:${keyword}`
  if (searchCache.size >= SEARCH_CACHE_MAX && !searchCache.has(key)) {
    searchCache.delete(searchCache.keys().next().value)
  }
  searchCache.set(key, { results, ts: Date.now() })
}

function getCachedSearch(userId, keyword) {
  const key = `eb:${userId}:${keyword}`
  const hit = searchCache.get(key)
  if (!hit) return null
  if (Date.now() - hit.ts > SEARCH_CACHE_TTL) {
    searchCache.delete(key)
    return null
  }
  return hit.results
}

function buildSearchMessage(results, keyword, page) {
  const total  = results.length
  const pages  = Math.ceil(total / SEARCH_PAGE_SIZE)
  const offset = (page - 1) * SEARCH_PAGE_SIZE
  const slice  = results.slice(offset, offset + SEARCH_PAGE_SIZE)

  const buttons = slice.map(e => ([{
    text:          `📚 ${e.title} — ${e.author}`,
    callback_data: `ebooks:${e.id}`,
  }]))

  const nav = []
  if (page > 1)     nav.push({ text: '◀️ Prev', callback_data: `ebpage:${page - 1}:${keyword}` })
  if (page < pages) nav.push({ text: 'Next ▶️', callback_data: `ebpage:${page + 1}:${keyword}` })

  const allButtons = nav.length ? [...buttons, nav] : buttons

  const text = (
    `\\[ EBOOKS \\] *${total} found* for _${escape(keyword)}_\n` +
    `_Halaman ${page}/${pages} — pilih buku di bawah:_`
  )

  return { text, buttons: allButtons }
}

function replyOpts(ctx) {
  return {
    parse_mode: 'MarkdownV2',
    message_thread_id: ctx.message?.message_thread_id,
    reply_parameters: {
      message_id: ctx.message?.message_id,
      allow_sending_without_reply: true,
    },
  }
}

// ─── /ebooks <keyword> ────────────────────────────────────────────────────────

async function handleEbooks(ctx) {
  const arg         = ctx.message.text.split(/\s+/).slice(1).join(' ').trim()
  const safeKeyword = arg.slice(0, 60).trim()

  if (!safeKeyword) {
    return ctx.reply(
      `\\[ INFO \\]\nMasukkan judul, nama penulis, atau genre\\.\n\n` +
      `*Contoh:*\n\`/ebooks Atomic Habits\`\n\`/ebooks James Clear\`\n\`/ebooks Self\\-Help\``,
      replyOpts(ctx)
    )
  }

  const results = searchEbooks(safeKeyword)

  if (!results.length) {
    return ctx.reply(
      `\\[ NOT FOUND \\]\n` +
      `Tidak ada ebook untuk: *${escape(arg)}*\n\n` +
      `_Koleksi ebook diupload manual oleh admin\\._`,
      replyOpts(ctx)
    )
  }

  cacheSearch(ctx.from?.id, safeKeyword, results)

  const { text, buttons } = buildSearchMessage(results, safeKeyword, 1)
  await ctx.reply(text, {
    ...replyOpts(ctx),
    reply_markup: { inline_keyboard: buttons },
  })
}

// ─── Pagination callback ──────────────────────────────────────────────────────

async function handleEbookSearchPage(ctx) {
  const raw   = ctx.callbackQuery.data
  const match = raw.match(/^ebpage:(\d+):(.+)$/)
  if (!match) return ctx.answerCbQuery()

  const page    = parseInt(match[1])
  const keyword = match[2]
  const userId  = ctx.from?.id

  let results = getCachedSearch(userId, keyword)
  if (!results) {
    results = searchEbooks(keyword)
    if (results.length) cacheSearch(userId, keyword, results)
  }

  if (!results.length) {
    return ctx.answerCbQuery('❌ Hasil tidak ditemukan.', { show_alert: true })
  }

  const { text, buttons } = buildSearchMessage(results, keyword, page)
  await ctx.editMessageText(text, {
    parse_mode: 'MarkdownV2',
    reply_markup: { inline_keyboard: buttons },
  }).catch(() => {})

  await ctx.answerCbQuery()
}

// ─── Pilih ebook → kirim dokumen ─────────────────────────────────────────────

async function handleEbookCallback(ctx) {
  const idStr = ctx.callbackQuery.data.replace('ebooks:', '')
  const id    = parseInt(idStr)
  const entry = getEbookById(id)

  if (!entry) {
    return ctx.answerCbQuery('❌ Ebook tidak ditemukan.', { show_alert: true })
  }

  await ctx.answerCbQuery()

  const threadId = ctx.callbackQuery.message?.message_thread_id

  // Kalau ada file_id di Telegram → kirim dokumen langsung
  if (entry.file_id) {
    try {
      await ctx.replyWithDocument(entry.file_id, {
        caption:      `📚 *${escape(entry.title)}*\n✍️ ${escape(entry.author)}`,
        parse_mode:   'MarkdownV2',
        message_thread_id: threadId,
      })
      incrementEbookRequestCount(id)
      logger.info({ event: 'ebook_sent_via_file_id', title: entry.title, userId: ctx.from?.id })
      return
    } catch (err) {
      // file_id expired — fallback ke R2 URL
      logger.warn({ event: 'ebook_file_id_expired', title: entry.title, msg: err.message })
    }
  }

  // Fallback: kirim tombol download R2
  if (entry.r2_url) {
    const buttons = [[{ text: '📥 Download', url: entry.r2_url }]]
    await ctx.reply(
      `📚 *${escape(entry.title)}*\n` +
      `✍️ *Penulis:* ${escape(entry.author)}\n` +
      `🏷️ *Genre:* ${escape(entry.genres || 'N/A')}\n` +
      `${entry.publisher ? `🏢 *Penerbit:* ${escape(entry.publisher)}\n` : ''}` +
      `${entry.published ? `📅 *Tahun:* ${escape(entry.published)}\n` : ''}` +
      `🌐 *Bahasa:* ${escape(entry.language || 'Indonesian')}`,
      {
        parse_mode: 'MarkdownV2',
        message_thread_id: threadId,
        reply_markup: { inline_keyboard: buttons },
      }
    )
    incrementEbookRequestCount(id)
    logger.info({ event: 'ebook_sent_via_r2', title: entry.title, userId: ctx.from?.id })
    return
  }

  // Tidak ada file_id maupun r2_url
  await ctx.reply(
    `📚 *${escape(entry.title)}*\n` +
    `✍️ *Penulis:* ${escape(entry.author)}\n\n` +
    `_File belum tersedia\\. Hubungi admin\\._`,
    {
      parse_mode: 'MarkdownV2',
      message_thread_id: threadId,
    }
  )
}

module.exports = { handleEbooks, handleEbookSearchPage, handleEbookCallback }