// src/features/ebooks/ebooks.admin.js
// Handle upload ebooks di admin group:
//   1. Admin kirim file PDF/EPUB ke grup admin
//   2. Bot minta metadata via form reply
//   3. Simpan ke DB lokal
//   4. Upload ke R2 di background
//   5. Sync ke REST API golang

const axios        = require('axios')
const crypto       = require('crypto')
const logger       = require('../../utils/logger')
const { escape }   = require('../../formats/utils')
const { uploadToR2 } = require('../../utils/r2')
const { syncEbookToApi, deleteEbookFromApi } = require('../../utils/api-sync-ebooks')
const {
  saveEbook, getEbookByHash, getEbookByTitleAuthor,
  updateEbookR2, updateEbookFileId, deleteEbook,
  getEbookById, listEbooksWithoutR2, getEbookStats,
  searchEbooks, listEbooks,
} = require('./ebooks.repo')

const ADMIN_GROUP        = process.env.TELEGRAM_ADMIN_GROUP_ID
const OWNER_ID           = String(process.env.TELEGRAM_OWNER_ID)
const ADMIN_THREAD_PANEL = Number(process.env.TELEGRAM_ADMIN_THREAD_PANEL)
const TG_DOWNLOAD_LIMIT  = 20 * 1024 * 1024  // 20 MB bot API limit

// Mime types yang diterima
const ALLOWED_MIME = [
  'application/pdf',
  'application/epub+zip',
  'application/x-mobipocket-ebook',
  'application/vnd.amazon.ebook',
  'application/octet-stream',  // fallback — cek extension juga
]

const ALLOWED_EXT = ['.pdf', '.epub', '.mobi', '.azw', '.azw3']

// State machine untuk wizard metadata (per user)
// Map<userId, pendingEbookState>
const pendingMetadata = new Map()

function panelOpts(extra = {}) {
  return { parse_mode: 'MarkdownV2', message_thread_id: ADMIN_THREAD_PANEL, ...extra }
}

function isAdmin(ctx) {
  return String(ctx.chat?.id) === String(ADMIN_GROUP) &&
         String(ctx.from?.id) === OWNER_ID
}

function ebookKey(id, title, author, ext = 'pdf') {
  const safe = (str) => str.replace(/[^a-zA-Z0-9 \-_]/g, '').trim()
  return `ebooks/${safe(author)} - ${safe(title)} (${id}).${ext}`
}

function getExtension(filename = '', mimeType = '') {
  const name = filename.toLowerCase()
  for (const ext of ALLOWED_EXT) {
    if (name.endsWith(ext)) return ext.replace('.', '')
  }
  if (mimeType.includes('epub'))  return 'epub'
  if (mimeType.includes('mobi'))  return 'mobi'
  return 'pdf'
}

// ─── Step 1: Admin kirim file ──────────────────────────────────────────────────

async function handleEbookUpload(ctx) {
  if (!isAdmin(ctx)) return

  const doc  = ctx.message.document
  if (!doc) return

  const mime = doc.mime_type || ''
  const name = doc.file_name || ''
  const ext  = ('.' + name.split('.').pop()).toLowerCase()

  const mimeOk = ALLOWED_MIME.includes(mime)
  const extOk  = ALLOWED_EXT.includes(ext)

  if (!mimeOk && !extOk) return  // bukan ebook, abaikan

  const fileHash = crypto
    .createHash('sha256')
    .update(`${doc.file_id}:${doc.file_size || 0}`)
    .digest('hex')

  const existing = getEbookByHash(fileHash)
  if (existing) {
    return ctx.reply(
      `ℹ️ File ini sudah ada di database:\n*${escape(existing.title)}* — ${escape(existing.author)}\n\`ID: ${existing.id}\``,
      panelOpts()
    )
  }

  // Simpan state, tunggu metadata dari admin
  pendingMetadata.set(String(ctx.from.id), {
    fileId:   doc.file_id,
    fileSize: doc.file_size || 0,
    fileName: name,
    fileHash,
    mimeType: mime,
    ext:      getExtension(name, mime),
    step:     'awaiting_title',
    data:     {},
    ts:       Date.now(),
  })

  await ctx.reply(
    `📚 *Ebook diterima*: \`${escape(name)}\`\n\n` +
    `Sekarang masukkan metadata satu per satu\\.\n\n` +
    `*Langkah 1/6 — Judul Buku:*\n` +
    `_Ketik judul buku, lalu kirim\\._`,
    panelOpts()
  )
}

// ─── Step 2: Admin kirim metadata satu per satu ────────────────────────────────

const STEPS = [
  { key: 'title',     label: 'Judul Buku',           step: 2, hint: 'Contoh: Atomic Habits' },
  { key: 'author',    label: 'Nama Penulis',          step: 3, hint: 'Contoh: James Clear' },
  { key: 'genres',    label: 'Genre',                 step: 4, hint: 'Contoh: Self\\-Help, Productivity' },
  { key: 'publisher', label: 'Penerbit \\(opsional\\)', step: 5, hint: 'Ketik \\- untuk skip' },
  { key: 'published', label: 'Tahun Terbit \\(opsional\\)', step: 6, hint: 'Contoh: 2018, atau \\- untuk skip' },
  { key: 'language',  label: 'Bahasa \\(opsional\\)',  step: 7, hint: 'Contoh: Indonesian / English, atau \\- untuk skip \\(default: Indonesian\\)' },
]

async function handleEbookMetadataInput(ctx) {
  if (!isAdmin(ctx)) return
  if (ctx.message.text?.startsWith('/')) return

  const userId = String(ctx.from.id)
  const state  = pendingMetadata.get(userId)
  if (!state) return

  // Timeout 10 menit
  if (Date.now() - state.ts > 10 * 60 * 1000) {
    pendingMetadata.delete(userId)
    return ctx.reply('⏰ Sesi input metadata kedaluwarsa\\. Upload file lagi untuk memulai ulang\\.', panelOpts())
  }

  const input = ctx.message.text.trim()
  const currentStepIdx = STEPS.findIndex(s => 'awaiting_' + s.key === state.step)

  if (currentStepIdx === -1) return

  const currentStep = STEPS[currentStepIdx]
  const value = input === '-' ? '' : input

  // Validasi field wajib
  if ((currentStep.key === 'title' || currentStep.key === 'author' || currentStep.key === 'genres') && !value) {
    return ctx.reply(
      `❌ *${currentStep.label}* tidak boleh kosong\\. Coba lagi:`,
      panelOpts()
    )
  }

  state.data[currentStep.key] = value
  state.ts = Date.now()

  const nextIdx = currentStepIdx + 1

  if (nextIdx < STEPS.length) {
    // Lanjut ke step berikutnya
    const nextStep = STEPS[nextIdx]
    state.step = 'awaiting_' + nextStep.key
    pendingMetadata.set(userId, state)

    await ctx.reply(
      `✅ *${escape(currentStep.label)}:* ${escape(value || '\\(skip\\)')}\n\n` +
      `*Langkah ${nextStep.step}/${STEPS.length + 1} — ${nextStep.label}:*\n` +
      `_${nextStep.hint}_`,
      panelOpts()
    )
  } else {
    // Semua step selesai — proses simpan
    pendingMetadata.delete(userId)
    await processEbookSave(ctx, state)
  }
}

// ─── Simpan ke DB + background R2 upload ──────────────────────────────────────

async function processEbookSave(ctx, state) {
  const { title, author, genres, publisher, published, language } = state.data

  const existingMeta = getEbookByTitleAuthor(title, author)
  if (existingMeta) {
    return ctx.reply(
      `ℹ️ Ebook sudah ada di database:\n*${escape(existingMeta.title)}* — ${escape(existingMeta.author)}\n\`ID: ${existingMeta.id}\``,
      panelOpts()
    )
  }

  const waitMsg = await ctx.reply('⏳ Menyimpan ebook\\.\\.\\.', panelOpts())

  const ebookData = {
    title,
    author,
    genres,
    publisher: publisher || '',
    published: published || '',
    thumbnail: '',
    language:  language  || 'Indonesian',
    file_size: state.fileSize,
    file_hash: state.fileHash,
    r2_url:    '',
    file_id:   state.fileId,
  }

  let insertId
  try {
    const result = saveEbook(ebookData)
    // Ambil ID — lastInsertRowid kalau INSERT, atau cari by title+author kalau UPDATE
    insertId = result.lastInsertRowid || getEbookByTitleAuthor(title, author)?.id
  } catch (err) {
    ctx.telegram.deleteMessage(ctx.chat.id, waitMsg.message_id).catch(() => {})
    logger.error({ event: 'ebook_save_failed', title, msg: err.message })
    return ctx.reply(`❌ Gagal menyimpan ke database: _${escape(err.message)}_`, panelOpts())
  }

  ctx.telegram.deleteMessage(ctx.chat.id, waitMsg.message_id).catch(() => {})

  await ctx.reply(
    `✅ *Ebook berhasil disimpan\\!*\n\n` +
    `📚 *${escape(title)}*\n` +
    `✍️ ${escape(author)}\n` +
    `🏷️ ${escape(genres)}\n` +
    `${publisher ? `🏢 ${escape(publisher)}\n` : ''}` +
    `${published ? `📅 ${escape(published)}\n` : ''}` +
    `🌐 ${escape(language || 'Indonesian')}\n` +
    `📁 ${(state.fileSize / 1024 / 1024).toFixed(1)} MB\n` +
    `🆔 \`${insertId}\`\n\n` +
    `_Upload ke R2 berjalan di background\\.\\.\\._`,
    panelOpts()
  )

  // Background: download dari Telegram → upload ke R2 → sync REST API
  ;(async () => {
    if (state.fileSize > TG_DOWNLOAD_LIMIT) {
      logger.info({ event: 'ebook_r2_skipped', reason: 'file_too_large', title, size: state.fileSize })
      await ctx.reply(
        `⚠️ File terlalu besar \\(${(state.fileSize / 1024 / 1024).toFixed(1)} MB\\) untuk diupload otomatis\\.\n` +
        `Gunakan \`/syncr2ebooks\` setelah menyediakan akses langsung ke file\\.`,
        panelOpts()
      )
      return
    }

    try {
      const fileLink = await ctx.telegram.getFileLink(state.fileId)
      const res      = await axios.get(fileLink.href, { responseType: 'arraybuffer', timeout: 120_000 })
      const buffer   = Buffer.from(res.data)

      const key   = ebookKey(insertId, title, author, state.ext)
      const mime  = state.ext === 'epub' ? 'application/epub+zip'
                  : state.ext === 'mobi' ? 'application/x-mobipocket-ebook'
                  : 'application/pdf'

      const r2Url = await uploadToR2(buffer, key, mime, buffer.length)

      updateEbookR2(insertId, r2Url)
      logger.info({ event: 'ebook_r2_ok', title, r2Url })

      const fullEntry = getEbookById(insertId)
      await syncEbookToApi({ ...fullEntry, r2_url: r2Url })

      await ctx.reply(
        `☁️ *R2 Upload Selesai*\n*${escape(title)}*\n_${escape(r2Url.substring(0, 60))}_`,
        panelOpts()
      )
    } catch (err) {
      logger.warn({ event: 'ebook_r2_failed', title, msg: err.message })
      await ctx.reply(
        `⚠️ R2 upload gagal untuk *${escape(title)}*: _${escape(err.message)}_\n` +
        `Jalankan \`/syncr2ebooks\` untuk retry\\.`,
        panelOpts()
      )
    }
  })()
}

// ─── /addebook — tambah ebook via command (tanpa upload file) ─────────────────
// Format: /addebook Title | Author | Genres | Publisher | Published | Language | URL
// Berguna kalau sudah punya URL langsung (misalnya dari hosting lain)

async function handleAddEbookCommand(ctx) {
  if (!isAdmin(ctx)) return

  const args = ctx.message.text.split(/\s+/).slice(1).join(' ').trim()
  if (!args) {
    return ctx.reply(
      `*Format /addebook:*\n` +
      `\`/addebook Title | Author | Genres | Publisher | Published | Language | URL\`\n\n` +
      `*Contoh:*\n` +
      `\`/addebook Atomic Habits | James Clear | Self\\-Help | Penguin | 2018 | English | https://r2\\.example\\.com/...\`\n\n` +
      `_Field Publisher, Published, Language opsional \\(isi \\- untuk skip\\)_`,
      panelOpts()
    )
  }

  const parts = args.split('|').map(s => s.trim())
  if (parts.length < 3) {
    return ctx.reply('❌ Minimal 3 field: Title | Author | Genres', panelOpts())
  }

  const [title, author, genres, publisher, published, language, url] = parts
  if (!title || !author || !genres) {
    return ctx.reply('❌ Title, Author, dan Genres wajib diisi\\.', panelOpts())
  }

  const existing = getEbookByTitleAuthor(title, author)
  if (existing) {
    return ctx.reply(
      `ℹ️ Sudah ada: *${escape(existing.title)}* — ${escape(existing.author)} \\(\`${existing.id}\`\\)`,
      panelOpts()
    )
  }

  const ebookData = {
    title,
    author,
    genres,
    publisher: publisher === '-' ? '' : (publisher || ''),
    published: published === '-' ? '' : (published || ''),
    language:  language  === '-' ? 'Indonesian' : (language || 'Indonesian'),
    thumbnail: '',
    file_size: 0,
    file_hash: '',
    r2_url:    url || '',
    file_id:   '',
  }

  try {
    const result  = saveEbook(ebookData)
    const insertId = result.lastInsertRowid || getEbookByTitleAuthor(title, author)?.id

    await ctx.reply(
      `✅ *Ebook ditambahkan:*\n` +
      `📚 *${escape(title)}* — ${escape(author)}\n` +
      `🆔 \`${insertId}\``,
      panelOpts()
    )

    // Sync ke REST API kalau sudah ada URL
    if (url && url.startsWith('http')) {
      const fullEntry = getEbookById(insertId)
      await syncEbookToApi({ ...fullEntry, r2_url: url })
    }
  } catch (err) {
    logger.error({ event: 'addebook_command_failed', title, msg: err.message })
    await ctx.reply(`❌ Gagal: _${escape(err.message)}_`, panelOpts())
  }
}

// ─── /syncr2ebooks — retry R2 upload untuk yang belum punya R2 ───────────────

async function handleSyncR2Ebooks(ctx) {
  if (!isAdmin(ctx)) return

  const pending = listEbooksWithoutR2()
  if (!pending.length) {
    return ctx.reply('✅ Semua ebook sudah ada di R2\\.', panelOpts())
  }

  const progressMsg = await ctx.reply(
    `☁️ *Sync R2 Ebooks*\n\n${pending.length} ebook belum di R2\\. Memulai sync\\.\\.\\.`,
    panelOpts()
  )

  let success = 0, failed = 0, skipped = 0

  for (let i = 0; i < pending.length; i++) {
    const entry = pending[i]

    // Update progress tiap 3 entry
    if (i % 3 === 0) {
      const pct    = Math.round((i / pending.length) * 100)
      const filled = Math.round(pct / 10)
      const bar    = '■'.repeat(filled) + '□'.repeat(10 - filled)
      await ctx.telegram.editMessageText(
        ctx.chat.id, progressMsg.message_id, undefined,
        `☁️ *Sync R2 Ebooks*\n\n\`${bar}\` ${pct}%\n${i}/${pending.length}\n\n✅ ${success}  ❌ ${failed}  ⏭️ ${skipped}`,
        panelOpts()
      ).catch(() => {})
    }

    if (!entry.file_id) {
      skipped++
      logger.info({ event: 'ebook_syncr2_skipped', reason: 'no_file_id', title: entry.title })
      continue
    }

    if (entry.file_size > TG_DOWNLOAD_LIMIT) {
      skipped++
      logger.info({ event: 'ebook_syncr2_skipped', reason: 'file_too_large', title: entry.title })
      continue
    }

    try {
      const fileLink = await ctx.telegram.getFileLink(entry.file_id)
      const res      = await axios.get(fileLink.href, { responseType: 'arraybuffer', timeout: 120_000 })
      const buffer   = Buffer.from(res.data)
      const ext      = entry.file_size > 0 ? 'pdf' : 'pdf'  // default pdf

      const key   = ebookKey(entry.id, entry.title, entry.author, ext)
      const mime  = ext === 'epub' ? 'application/epub+zip' : 'application/pdf'
      const r2Url = await uploadToR2(buffer, key, mime, buffer.length)

      updateEbookR2(entry.id, r2Url)
      await syncEbookToApi({ ...entry, r2_url: r2Url })
      success++
    } catch (err) {
      failed++
      logger.warn({ event: 'ebook_syncr2_failed', title: entry.title, msg: err.message })
    }
  }

  await ctx.telegram.editMessageText(
    ctx.chat.id, progressMsg.message_id, undefined,
    `☁️ *Sync R2 Ebooks Selesai*\n\n✅ Berhasil: *${success}*\n⏭️ Skip: *${skipped}*\n❌ Gagal: *${failed}*`,
    panelOpts()
  ).catch(() => {})
}

// ─── /deebook <id> ────────────────────────────────────────────────────────────

async function handleDeleteEbook(ctx) {
  if (!isAdmin(ctx)) return

  const idStr = ctx.message.text.split(/\s+/)[1]
  const id    = parseInt(idStr)
  if (!id || isNaN(id)) {
    return ctx.reply('❌ Format: `/delebook <id>`', panelOpts())
  }

  const entry = getEbookById(id)
  if (!entry) {
    return ctx.reply(`❌ Ebook ID \`${id}\` tidak ditemukan\\.`, panelOpts())
  }

  const deleted = deleteEbook(id)
  if (deleted) {
    deleteEbookFromApi(id).catch(() => {})
    await ctx.reply(
      `✅ Dihapus dari DB dan REST API:\n*${escape(entry.title)}* — ${escape(entry.author)}`,
      panelOpts()
    )
  } else {
    await ctx.reply('❌ Gagal menghapus\\.', panelOpts())
  }
}

// ─── /dbstatsebooks ───────────────────────────────────────────────────────────

async function handleEbookStats(ctx) {
  if (!isAdmin(ctx)) return

  const s = getEbookStats()
  const topList = (s.topAuthors || [])
    .map((a, i) => `${i + 1}\\. ${escape(a.author)} \\(${a.total}\\)`)
    .join('\n')

  await ctx.reply(
    `📚 *Ebook Stats*\n\n` +
    `📖 Total: *${s.total_entries || 0}*\n` +
    `✍️ Authors: *${s.total_authors || 0}*\n` +
    `💾 Size: *${((s.total_size_bytes || 0) / 1024 / 1024).toFixed(1)} MB*\n` +
    `☁️ Tanpa R2: *${s.without_r2 || 0}*\n\n` +
    (topList ? `*Top Authors:*\n${topList}` : ''),
    panelOpts()
  )
}

// ─── /listebooks [page] ───────────────────────────────────────────────────────

const PAGE_SIZE = 10

async function handleListEbooks(ctx) {
  if (!isAdmin(ctx)) return

  const arg  = ctx.message.text.split(/\s+/)[1]
  const page = Math.max(1, parseInt(arg) || 1)

  const all    = listEbooks(-1, 0)
  const total  = all.length
  const pages  = Math.ceil(total / PAGE_SIZE)
  const offset = (page - 1) * PAGE_SIZE
  const slice  = all.slice(offset, offset + PAGE_SIZE)

  if (!slice.length) {
    return ctx.reply('❌ Database ebook kosong\\.', panelOpts())
  }

  const lines = slice.map((e, i) => {
    const r2 = e.r2_url ? '☁️' : '❌'
    return (
      `${offset + i + 1}\\. *${escape(e.title)}* — ${escape(e.author)}\n` +
      `    ${escape(e.genres || 'N/A')}  ·  ${r2}\n` +
      `    \`ID: ${e.id}\``
    )
  }).join('\n\n')

  const nav = []
  if (page > 1)     nav.push({ text: '◀️ Prev', callback_data: `eblist:${page - 1}` })
  if (page < pages) nav.push({ text: 'Next ▶️', callback_data: `eblist:${page + 1}` })

  await ctx.reply(
    `📚 *Ebook List* \\(page ${page}/${pages}\\)\n\n${lines}\n\n_Total: ${total} ebooks_`,
    panelOpts({
      reply_markup: nav.length ? { inline_keyboard: [nav] } : undefined,
    })
  )
}

async function handleListEbooksPage(ctx) {
  if (!isAdmin(ctx)) return

  const page = parseInt(ctx.callbackQuery.data.replace('eblist:', ''))
  if (!page || isNaN(page)) return ctx.answerCbQuery()

  const all    = listEbooks(-1, 0)
  const total  = all.length
  const pages  = Math.ceil(total / PAGE_SIZE)
  const offset = (page - 1) * PAGE_SIZE
  const slice  = all.slice(offset, offset + PAGE_SIZE)

  if (!slice.length) return ctx.answerCbQuery('❌ Halaman tidak ditemukan.', { show_alert: true })

  const lines = slice.map((e, i) => {
    const r2 = e.r2_url ? '☁️' : '❌'
    return (
      `${offset + i + 1}\\. *${escape(e.title)}* — ${escape(e.author)}\n` +
      `    ${escape(e.genres || 'N/A')}  ·  ${r2}\n` +
      `    \`ID: ${e.id}\``
    )
  }).join('\n\n')

  const nav = []
  if (page > 1)     nav.push({ text: '◀️ Prev', callback_data: `eblist:${page - 1}` })
  if (page < pages) nav.push({ text: 'Next ▶️', callback_data: `eblist:${page + 1}` })

  await ctx.editMessageText(
    `📚 *Ebook List* \\(page ${page}/${pages}\\)\n\n${lines}\n\n_Total: ${total} ebooks_`,
    panelOpts({
      reply_markup: nav.length ? { inline_keyboard: [nav] } : undefined,
    })
  ).catch(() => {})

  await ctx.answerCbQuery()
}

module.exports = {
  handleEbookUpload,
  handleEbookMetadataInput,
  handleAddEbookCommand,
  handleSyncR2Ebooks,
  handleDeleteEbook,
  handleEbookStats,
  handleListEbooks,
  handleListEbooksPage,
  pendingMetadata,  // export agar bisa dicek di middleware
}