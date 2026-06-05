// src/features/admin/admin.handler.js
const { v4: uuidv4 } = require('uuid')
const { escape, normalizeUrl } = require('../../formats/utils')
const logger = require('../../utils/logger')
const api = require('../../api/client')
const axios = require('axios')
const mm = require('music-metadata')
const fs = require('fs')
const path = require('path')

// Import sub-modules admin
const { handleAudioUpload } = require('./admin.upload')
const { handleDbStats, handleListTrack, handleListTrackPage, handleFindTrack, handleDelTrack } = require('./admin.manage')
const { handleSyncR2, handleSyncMeta } = require('./admin.sync')

// ✨ IMPORT SPIDER ADMIN
const { 
  spiderPanelOnly, handleSeedArtist, handleSeedArtistCallback, 
  handleSpiderStatus, handleSpiderQueue, handleSpiderSkip, handleSpiderClear 
} = require('../spider/spider.admin')

// ✨ IMPORT SPIDER LK21
const { handleSeedMovs, handleSeedMovsStatus } = require('../../../scripts/spider-lk21')

// Import utilitas & repo
const { uploadToR2, trackKey } = require('../../utils/r2')
const { startTyping } = require('../../utils/typing')
const { enrichMetadata } = require('../../utils/spotify')
const { getTrack, saveTrack, updateTrackR2, findTrackByTitleArtist } = require('../spotify/spotify.repo')
const { syncMp3ToApi } = require('../../utils/api-sync')

const ADMIN_GROUP         = process.env.TELEGRAM_ADMIN_GROUP_ID
const ADMIN_THREAD_NOTIFY = Number(process.env.TELEGRAM_ADMIN_THREAD_NOTIFY)
const ADMIN_THREAD_PANEL  = Number(process.env.TELEGRAM_ADMIN_THREAD_PANEL)
const OWNER_ID            = String(process.env.TELEGRAM_OWNER_ID)

async function parseAudioDuration(buffer) {
  try {
    const meta = await mm.parseBuffer(buffer, { duration: true })
    return meta.format?.duration || null
  } catch {
    return null
  }
}

function parseDurationToSeconds(durationStr) {
  if (!durationStr) return null
  if (String(durationStr).includes(':')) {
    const parts = String(durationStr).split(':').map(Number)
    if (parts.length === 2) return parts[0] * 60 + parts[1]
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2]
  }
  const n = parseFloat(durationStr)
  return isNaN(n) ? null : n
}

function isAdmin(ctx) {
  const chatId = String(ctx.chat?.id)
  const userId = String(ctx.from?.id)
  return chatId === ADMIN_GROUP && userId === OWNER_ID
}

function adminOnly(handler) {
  return async (ctx) => {
    if (!isAdmin(ctx)) return
    return handler(ctx)
  }
}

async function notify(telegram, text) {
  await telegram.sendMessage(ADMIN_GROUP, text, {
    parse_mode: 'MarkdownV2',
    message_thread_id: ADMIN_THREAD_NOTIFY,
  }).catch(() => {})
}

async function handleAdminHelp(ctx) {
  await ctx.reply(
    `🛠 *Admin Panel*\n\n` +
    `*Database*\n\`/dbstats\`  — statistik database\n\`/listtrack [page]\`  — daftar lagu\n\`/findtrack <keyword>\`  — cari lagu\n\`/deltrack <track\\_id>\`  — hapus lagu\n\n` +
    `*Sistem Spider & R2*\n\`/seed <artis>\` — masukan artis ke antrean spider\n\`/queue\` — lihat antrean spider saat ini\n\`/spider_skip <nama>\` — hapus artis dari antrean\n\`/spider_status\` — cek metrik spider\n\`/syncr2\`  — upload R2 massal\n\`/syncmeta\`  — sync metadata`,
    { parse_mode: 'MarkdownV2', message_thread_id: ADMIN_THREAD_PANEL }
  )
}

async function handleAddTrack(ctx, url) {
  const currentThreadId = ctx.message?.message_thread_id || ADMIN_THREAD_PANEL
  const stopTyping = startTyping(ctx, currentThreadId)

  try {
    const data = await api.contentSpotify(url)
    const { data: info, download } = data
    const trackId = info.track_id || null

    if (trackId && getTrack(trackId)) {
      stopTyping()
      return ctx.reply(
        `ℹ️ Track sudah ada di DB:\n*${escape(info.title)}* — ${escape(info.author)}`,
        { parse_mode: 'MarkdownV2', message_thread_id: currentThreadId }
      )
    }

    const safeTitle  = info.title  || 'Track'
    const safeArtist = info.author || 'Unknown'

    const expectedSec = parseDurationToSeconds(info.duration)
    if (expectedSec !== null && expectedSec <= 30) {
      stopTyping()
      logger.info({ event: 'addtrack_skipped_short', track: safeTitle, duration: info.duration })
      if (ctx.isSpider) throw new Error(`Durasi terlalu pendek (${info.duration})`) 
      return ctx.reply(
        `⏭️ Skip: *${escape(safeTitle)}* \\— Durasi terlalu pendek \\(${escape(info.duration)}\\)`,
        { parse_mode: 'MarkdownV2', message_thread_id: currentThreadId }
      )
    }

    const existingByMeta = findTrackByTitleArtist(safeTitle, safeArtist)
    if (existingByMeta) {
      stopTyping()
      return ctx.reply(
        `ℹ️ Track sudah ada di DB \\(via jalur lain\\):\n*${escape(existingByMeta.title)}* — ${escape(existingByMeta.artist)}\n🆔 \`${existingByMeta.track_id}\``,
        { parse_mode: 'MarkdownV2', message_thread_id: currentThreadId }
      )
    }

    const candidates = [download.server_2, download.original, download.server_1].filter(Boolean)
    const userAgents = [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
      'Mozilla/5.0 (Linux; Android 13; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.6099.193 Mobile Safari/537.36'
    ]

    let buffer = null, fileSize = null, downloadSuccess = false
    const downloadErrors = []

    for (let i = 0; i < candidates.length; i++) {
      const candidate = candidates[i]
      try {
        const randomUA = userAgents[Math.floor(Math.random() * userAgents.length)]
        const abortSignal = typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(60000) : undefined;
        const res = await axios.get(candidate, { 
          responseType: 'arraybuffer', 
          timeout: 60_000,
          signal: abortSignal,
          headers: { 'User-Agent': randomUA, 'Accept': '*/*' }
        })
        
        buffer = Buffer.from(res.data)
        fileSize = buffer.length
        downloadSuccess = true
        break 
      } catch (err) {
        const status = err.response ? err.response.status : 'Timeout/Network'
        const errorMsg = err.message.replace('Request failed with status code', 'HTTP')
        downloadErrors.push(`[Server ${i + 1} = ${status}: ${errorMsg}]`)
      }
    }

    if (!downloadSuccess) {
      const finalErrorMessage = downloadErrors.join(' | ')
      logger.warn({ event: 'addtrack_download_failed', msg: `Semua kandidat tumbang: ${finalErrorMessage}` })
      stopTyping()
      if (ctx.isSpider) throw new Error(`Semua kandidat tumbang: ${finalErrorMessage}`)
      return ctx.reply(
        `❌ Gagal download: _${escape(finalErrorMessage)}_`,
        { parse_mode: 'MarkdownV2', message_thread_id: currentThreadId }
      )
    }

    if (expectedSec && expectedSec > 30) {
      const actualSec = await parseAudioDuration(buffer)
      if (actualSec !== null && actualSec < expectedSec * 0.7) {
        logger.warn({
          event:    'audio_duration_mismatch',
          track:    safeTitle,
          expected: Math.round(expectedSec),
          actual:   Math.round(actualSec),
        })
        stopTyping()
        const errMsg = 'Failed to process track - audio file appears incomplete.'
        if (ctx.isSpider) throw new Error(errMsg)
        return ctx.reply(
          `\\[ ERROR \\]\n${errMsg}\n_Please try again later\\._`,
          { parse_mode: 'MarkdownV2', message_thread_id: currentThreadId }
        )
      }
    }

    stopTyping()

    const waitMsg = await ctx.reply(
      `⏳ Uploading ke Telegram\\.\\.\\. \\(${(fileSize / 1024).toFixed(0)} KB\\)`,
      { parse_mode: 'MarkdownV2', message_thread_id: currentThreadId }
    )

    const key = trackKey(trackId || Date.now().toString(), safeTitle, safeArtist, 'mp3')
    const audioOpts = {
      title:     safeTitle,
      performer: safeArtist,
      thumbnail: info.thumbnail ? { url: info.thumbnail } : undefined,
      message_thread_id: currentThreadId,
    }

    const runAdminBackgroundTasks = async () => {
      try {
        const sent = await ctx.replyWithAudio({ source: buffer, filename: `${safeTitle}.mp3` }, audioOpts)
        ctx.telegram.deleteMessage(ctx.chat.id, waitMsg.message_id).catch(() => {})

        if (!sent?.audio?.file_id) return
        const fileId = sent.audio.file_id

        await ctx.reply(
          `✅ Berhasil ditambahkan:\n*${escape(safeTitle)}* — ${escape(safeArtist)}`,
          { parse_mode: 'MarkdownV2', message_thread_id: currentThreadId }
        )

        let enriched = {}
        try {
          enriched = await enrichMetadata(safeTitle, safeArtist)
          logger.info({ event: 'addtrack_enrich_ok', track: safeTitle })
        } catch (err) {
          logger.warn({ event: 'addtrack_enrich_failed', track: safeTitle, msg: err.message })
        }

        const finalTrackId = trackId || uuidv4()

        try {
          saveTrack({
            track_id:  finalTrackId,
            file_id:   fileId,
            title:     safeTitle,
            artist:    safeArtist,
            duration:  info.duration                        || null,
            quality:   info.quality                         || null,
            thumbnail: enriched.thumbnail || info.thumbnail || null,
            file_size: fileSize,
            r2_url:    null,
            type:      'mp3',
            source:    'spotify',
            album:     enriched.album     || info.album     || null,
            year:      enriched.year      || info.year      || null,
            genre:     enriched.genre                       || null,
            file_hash: null,
          })
        } catch (err) {
          logger.error({ event: 'addtrack_save_failed', track: safeTitle, msg: err.message })
          return
        }

        try {
          const r2Url = await uploadToR2(buffer, key, 'audio/mpeg', fileSize)
          if (r2Url) {
            updateTrackR2(finalTrackId, r2Url)
            const fullTrack = getTrack(finalTrackId)
            await syncMp3ToApi({ ...fullTrack, r2_url: r2Url })
          }
        } catch (err) {
          logger.warn({ event: 'r2_upload_failed', track: safeTitle, msg: err.message })
        }

      } catch (err) {
        ctx.telegram.deleteMessage(ctx.chat.id, waitMsg.message_id).catch(() => {})
        logger.error({ event: 'addtrack_upload_failed', msg: err.message })
        ctx.reply(
          `❌ Upload ke Telegram gagal: _${escape(err.message)}_`,
          { parse_mode: 'MarkdownV2', message_thread_id: currentThreadId }
        ).catch(() => {})
      }
    }

    if (ctx.isSpider) {
      await runAdminBackgroundTasks()
    } else {
      runAdminBackgroundTasks()
    }

  } catch (err) {
    stopTyping()
    throw err
  }
}

function registerAdminHandlers(bot) {
  bot.command('adminhelp',  adminOnly(handleAdminHelp))
  bot.command('dbstats',    adminOnly(handleDbStats))
  bot.command('listtrack',  adminOnly(handleListTrack))
  bot.command('findtrack',  adminOnly(handleFindTrack))
  bot.command('deltrack',   adminOnly(handleDelTrack))
  bot.command('syncr2',     adminOnly(handleSyncR2))
  bot.command('syncmeta',   adminOnly(handleSyncMeta))
  
  // ✨ Fungsi Spider sekarang dipanggil dari spider.admin.js
  bot.command('seed', spiderPanelOnly(handleSeedArtist))
  bot.command('queue', spiderPanelOnly(handleSpiderQueue))
  bot.command('spider_skip', spiderPanelOnly(handleSpiderSkip))
  bot.command('spider_status', spiderPanelOnly(handleSpiderStatus))
  bot.command('spider_clear', spiderPanelOnly(handleSpiderClear))
  bot.action(/^seed_artist:([a-zA-Z0-9]{22}):(\d+)$/, adminOnly(handleSeedArtistCallback))

  bot.command('seedmovs', spiderPanelOnly(handleSeedMovs))
  bot.command('seedmovs_status', spiderPanelOnly(handleSeedMovsStatus))
  
  bot.on('audio',    handleAudioUpload)
  bot.on('document', handleAudioUpload)

  bot.action(/^lt:\d+$/, handleListTrackPage)

  bot.on('text', async (ctx) => {
    if (!isAdmin(ctx)) return
    const text = ctx.message.text.trim()
    if (text.startsWith('/')) return
    
    const url = normalizeUrl(text)
    if (!url || !url.includes('/track/')) return
    
    try {
      await handleAddTrack(ctx, url)
    } catch (err) {
      logger.error({ event: 'addtrack_error', msg: err.message })
      ctx.reply(`❌ ${escape(err.message)}`, { parse_mode: 'MarkdownV2', message_thread_id: ADMIN_THREAD_PANEL }).catch(() => {})
    }
  })
}

module.exports = { registerAdminHandlers, notify, handleAddTrack }