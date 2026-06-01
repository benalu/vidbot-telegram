// src/features/movies/movies.admin.js
const fs           = require('fs')
const crypto       = require('crypto')
const { execSync } = require('child_process')
const logger       = require('../../utils/logger')
const { escape }   = require('../../formats/utils')
const { uploadToR2 } = require('../../utils/r2')
const { fetchMovieMeta } = require('../../utils/tmdb')
const { syncMovieToApi } = require('../../utils/api-sync-movies')
const { saveMovieLocal, getMovieByHash, updateMovieR2 } = require('./movies.repo')

const ADMIN_GROUP     = process.env.TELEGRAM_ADMIN_GROUP_ID
const OWNER_ID        = String(process.env.TELEGRAM_OWNER_ID)
const ARCHIVE_CHANNEL = process.env.TELEGRAM_ARCHIVE_MOVS_CHANNEL_ID;
const TG_DOWNLOAD_LIMIT = 4000 * 1024 * 1024 // 4GB

const pendingMovieMeta = new Map()

function isAdmin(ctx) {
  return String(ctx.chat?.id) === String(ADMIN_GROUP) && String(ctx.from?.id) === OWNER_ID
}

// ─── Tahap 1: Tangkap Video & Kirim ke Archive ────────────────────────
async function handleMovieUpload(ctx) {
  if (!isAdmin(ctx) || !ARCHIVE_CHANNEL) return
  const video = ctx.message.video || ctx.message.document
  if (!video) return

  const mime = video.mime_type || ''
  if (!mime.includes('video/')) return

  const fileHash = crypto.createHash('sha256').update(`${video.file_id}:${video.file_size || 0}`).digest('hex')
  const existing = getMovieByHash(fileHash)
  if (existing) {
    return ctx.reply(`ℹ️ Film ini sudah ada di DB:\n*${escape(existing.title)}*\n\`TMDB: ${existing.tmdb_id}\``, { parse_mode: 'MarkdownV2' })
  }

  const waitMsg = await ctx.reply('⏳ Menyimpan ke Archive Channel...', { parse_mode: 'MarkdownV2' })

  try {
    // ✨ BOT MENGIRIM KE ARCHIVE CHANNEL
    const copied = await ctx.telegram.copyMessage(ARCHIVE_CHANNEL, ctx.chat.id, ctx.message.message_id)
    const archiveMsgId = copied.message_id

    // Hapus video asli dari grup admin agar obrolan bersih!
    ctx.deleteMessage().catch(() => {})

    let localFilePath = null
    const fileData = await ctx.telegram.getFile(video.file_id)
    if (fileData.file_path) {
      localFilePath = fileData.file_path.replace('/var/lib/telegram-bot-api', '/home/ubuntu/telegram-api-server/data')
    }

    const userIdStr = String(ctx.from.id);
    pendingMovieMeta.set(userIdStr, {
      fileId: video.file_id,
      archiveMsgId: archiveMsgId, 
      fileSize: video.file_size || 0,
      fileHash,
      mimeType: mime,
      localPath: localFilePath,
      ext: video.file_name ? video.file_name.split('.').pop() : 'mp4'
    })

    setTimeout(() => {
      if (pendingMovieMeta.has(userIdStr)) {
        const stale = pendingMovieMeta.get(userIdStr);
        if (stale.localPath && fs.existsSync(stale.localPath)) {
          try { require('child_process').execSync(`sudo rm -f "${stale.localPath}"`) } catch (e) {}
        }
        pendingMovieMeta.delete(userIdStr);
        logger.info({ event: 'pending_movie_timeout', user_id: userIdStr });
      }
    }, 30 * 60 * 1000); // 30 Menit

    ctx.telegram.deleteMessage(ctx.chat.id, waitMsg.message_id).catch(() => {})
    await ctx.reply(
      `🎬 *Video Berhasil Diarsipkan*\nSilakan balas pesan ini dengan *ID TMDB* untuk film ini:\n_(Contoh: 157336)_`,
      { parse_mode: 'MarkdownV2' }
    )
  } catch (err) {
    logger.error({ event: 'archive_failed', msg: err.message })
    ctx.reply(`❌ Gagal menyimpan ke archive: ${err.message}`)
  }
}

// ─── Tahap 2: Input TMDB ID & Proses Lanjutan ─────────────────────────
async function handleMovieTmdbInput(ctx) {
  if (!isAdmin(ctx)) return
  const userId = String(ctx.from.id)
  const state = pendingMovieMeta.get(userId)
  if (!state) return

  const tmdbId = ctx.message.text.trim()
  if (!/^\d+$/.test(tmdbId)) {
    return ctx.reply('❌ TMDB ID harus berupa angka.', { parse_mode: 'MarkdownV2' })
  }

  pendingMovieMeta.delete(userId)
  const waitMsg = await ctx.reply('⏳ Mengambil metadata & sinkronisasi...', { parse_mode: 'MarkdownV2' })

  try {
    const meta = await fetchMovieMeta(tmdbId)
    
    // ✨ Simpan ke SQLite beserta message_id dari Archive Channel
    const dbId = saveMovieLocal({
      ...meta,
      file_size: state.fileSize,
      file_hash: state.fileHash,
      r2_url: '',
      file_id: state.fileId,
      message_id: state.archiveMsgId // ✨
    })

    ctx.telegram.deleteMessage(ctx.chat.id, waitMsg.message_id).catch(() => {})
    await ctx.reply(
      `✅ *Database Diperbarui*\n🎬 *${escape(meta.title)}* (${meta.year})\n_Upload R2 berjalan di background..._`,
      { parse_mode: 'MarkdownV2' }
    )

    // Upload R2 Background & Auto-Delete VPS
    ;(async () => {
      if (state.fileSize > TG_DOWNLOAD_LIMIT) return
      try {
        if (!state.localPath || !fs.existsSync(state.localPath)) throw new Error('File lokal tidak ditemukan')
        
        const fileStream = fs.createReadStream(state.localPath)
        const key = `movies/${meta.tmdb_id}_${meta.title.replace(/[^a-zA-Z0-9]/g, '')}.${state.ext}`
        const r2Url = await uploadToR2(fileStream, key, state.mimeType, state.fileSize)
        
        if (r2Url) {
          updateMovieR2(dbId, r2Url)
          await syncMovieToApi({ ...meta, r2_url: r2Url })
          logger.info({ event: 'movie_r2_sync_ok', title: meta.title })
        }
      } catch (err) {
        logger.error({ event: 'movie_bg_process_failed', msg: err.message })
      } finally {
        if (state.localPath && fs.existsSync(state.localPath)) {
          try {
            execSync(`sudo rm -f "${state.localPath}"`)
          } catch (e) {}
        }
      }
    })()

  } catch (err) {
    ctx.telegram.deleteMessage(ctx.chat.id, waitMsg.message_id).catch(() => {})
    ctx.reply(`❌ Gagal: ${escape(err.message)}`, { parse_mode: 'MarkdownV2' })
  }
}

module.exports = { handleMovieUpload, handleMovieTmdbInput, pendingMovieMeta }