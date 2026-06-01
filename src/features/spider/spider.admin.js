// src/features/spider/spider.admin.js
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { escape } = require('../../formats/utils');
const logger = require('../../utils/logger');
const { getAccessToken } = require('../../utils/spotify');

const { 
  addSpiderSeed, countSpiderQueue, getSpiderQueue, skipSpiderArtist, clearSpiderQueue 
} = require('./spider.repo');

const ADMIN_GROUP = process.env.TELEGRAM_ADMIN_GROUP_ID;
const OWNER_ID = String(process.env.TELEGRAM_OWNER_ID);
const ADMIN_THREAD_SPIDER_PANEL = Number(process.env.TELEGRAM_ADMIN_THREAD_SPIDER_PANEL);

function isAdmin(ctx) {
  return String(ctx.chat?.id) === ADMIN_GROUP && String(ctx.from?.id) === OWNER_ID;
}

function spiderPanelOnly(handler) {
  return async (ctx) => {
    if (!isAdmin(ctx)) return;
    if (ctx.message && ctx.message.message_thread_id !== ADMIN_THREAD_SPIDER_PANEL) {
      const msg = await ctx.reply('❌ Command Spider hanya bisa digunakan di thread Spider Panel.', {
        message_thread_id: ctx.message.message_thread_id
      });
      setTimeout(() => {
        ctx.telegram.deleteMessage(ctx.chat.id, msg.message_id).catch(() => {});
        ctx.telegram.deleteMessage(ctx.chat.id, ctx.message.message_id).catch(() => {});
      }, 5000);
      return;
    }
    return handler(ctx);
  };
}

async function handleSeedArtist(ctx) {
  const keyword = ctx.message.text.split(/\s+/).slice(1).join(' ').trim()
  if (!keyword) {
    return ctx.reply('Gunakan format: /seed nama artis\nAtau: /seed <URL Spotify Artist>', {
      message_thread_id: ADMIN_THREAD_SPIDER_PANEL
    })
  }

  const waitMsg = await ctx.reply('Mencari artis di Spotify...', { message_thread_id: ADMIN_THREAD_SPIDER_PANEL })
  
  try {
    const SPOTIFY_API_URL  = 'https://api.spotify.com/v1'
    const token = await getAccessToken()

    const urlMatch = keyword.match(/artist\/([a-zA-Z0-9]{22})/)
    const exactId = urlMatch ? urlMatch[1] : (keyword.length === 22 && !keyword.includes(' ') ? keyword : null)

    if (exactId) {
      const res = await axios.get(`${SPOTIFY_API_URL}/artists/${exactId}`, {
        headers: { 'Authorization': `Bearer ${token}` },
        timeout: 10000 
      })
      
      const artist = res.data
      const isNew = addSpiderSeed(artist.id, artist.name)
      const pendingCount = countSpiderQueue() 
      
      const statusMsg = isNew 
        ? `✅ Seed berhasil ditambahkan:\nArtis: ${artist.name}\nID: ${artist.id}\n\nSpider bot akan otomatis memproses artis ini.\n⏳ Sisa antrean saat ini: *${pendingCount} Artis*`
        : `ℹ️ Seed sudah ada:\nArtis ${artist.name} sudah berada di dalam antrean atau selesai diproses.`
            
      return ctx.telegram.editMessageText(ctx.chat.id, waitMsg.message_id, undefined, statusMsg)
    }

    const res = await axios.get(`${SPOTIFY_API_URL}/search?q=${encodeURIComponent(keyword)}&type=artist&limit=5`, {
      headers: { 'Authorization': `Bearer ${token}` },
      timeout: 10000 
    })

    const artists = res.data.artists.items
    if (artists.length === 0) {
      return ctx.telegram.editMessageText(ctx.chat.id, waitMsg.message_id, undefined, 
        `Gagal: Artis "${keyword}" tidak ditemukan di Spotify.`)
    }
    
    if (artists.length === 1) {
      const artist = artists[0]
      const isNew = addSpiderSeed(artist.id, artist.name)
      const pendingCount = countSpiderQueue()
      
      const statusMsg = isNew 
        ? `✅ Seed berhasil ditambahkan:\nArtis: ${artist.name}\nID: ${artist.id}\n\nSpider bot akan otomatis memproses artis ini.\n⏳ Sisa antrean saat ini: *${pendingCount} Artis*`
        : `ℹ️ Seed sudah ada:\nArtis ${artist.name} sudah berada di dalam antrean atau selesai diproses.`
      return ctx.telegram.editMessageText(ctx.chat.id, waitMsg.message_id, undefined, statusMsg)
    }

    const ts = Date.now();
    const inlineKeyboard = artists.map(a => ([
      { text: a.name, callback_data: `seed_artist:${a.id}:${ts}` }
    ]))

    await ctx.telegram.editMessageText(ctx.chat.id, waitMsg.message_id, undefined, 
      `Ditemukan beberapa hasil untuk "${keyword}". Pilih artis yang tepat:`,
      { reply_markup: { inline_keyboard: inlineKeyboard } }
    )

  } catch (err) {
    logger.error({ event: 'seed_artist_failed', msg: err.message }) 
    ctx.telegram.editMessageText(ctx.chat.id, waitMsg.message_id, undefined, 
      `Gagal mencari artis: ${err.message}`)
  }
}

async function handleSeedArtistCallback(ctx) {
  const artistId = ctx.match[1]
  const timestamp = parseInt(ctx.match[2], 10)

  if (Date.now() - timestamp > 60 * 60 * 1000) {
    return ctx.answerCbQuery('❌ Tombol sudah kedaluwarsa. Silakan cari ulang.', { show_alert: true })
  }
  
  await ctx.answerCbQuery('Memproses artis...').catch(() => {})

  try {
    const SPOTIFY_API_URL = 'https://api.spotify.com/v1'
    const token = await getAccessToken()
    
    const res = await axios.get(`${SPOTIFY_API_URL}/artists/${artistId}`, {
      headers: { 'Authorization': `Bearer ${token}` },
      timeout: 10000
    })

    const artist = res.data
    const isNew = addSpiderSeed(artist.id, artist.name)
    const pendingCount = countSpiderQueue()

    const statusMsg = isNew 
        ? `✅ Seed berhasil ditambahkan:\nArtis: ${artist.name}\nID: ${artist.id}\n\nSpider bot akan otomatis memproses artis ini.\n⏳ Sisa antrean saat ini: *${pendingCount} Artis*`
        : `ℹ️ Seed sudah ada:\nArtis ${artist.name} sudah berada di dalam antrean atau selesai diproses.`

    await ctx.editMessageText(statusMsg)

  } catch (err) {
    logger.error({ event: 'seed_artist_callback_failed', msg: err.message })
    await ctx.editMessageText(`Gagal memproses artis pilihan: ${err.message}`).catch(() => {})
  }
}

async function handleSpiderStatus(ctx) {
  try {
    const statsPath = path.join(__dirname, '../../../data/spotify/spider-stats.json')
    
    if (!fs.existsSync(statsPath)) {
      return ctx.reply('⚠️ Data statistik Spider belum tersedia. Mungkin Spider belum selesai memproses artis pertamanya.', { message_thread_id: ADMIN_THREAD_SPIDER_PANEL })
    }

    const statsRaw = await fs.promises.readFile(statsPath, 'utf8')
    const stats = JSON.parse(statsRaw)
    
    const lastUpdate = new Date(stats.timestamp || stats.last_updated).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })
    const statusIcon = stats.status === 'ONLINE' || stats.status === 'PROCESSING_ARTIST' ? '🟢' : (stats.status === 'DEEP_SLEEP' || stats.status === 'SLEEPING' ? '🛌' : '🔴')
    
    const shiftTotal = (stats.shift_elapsed_minutes || 0) + (stats.shift_remaining_minutes || 0);
    const shiftDisplay = (stats.status === 'SLEEPING' || stats.status === 'DEEP_SLEEP')
      ? `⏸️ *Shift:* Menunggu jadwal bangun\\.\\.\\.\n`
      : `📅 *Mulai Shift:* ${stats.current_shift_started_at ? escape(stats.current_shift_started_at) : '\\-'}\n` +
        `⏱️ *Shift Berjalan:* ${stats.shift_elapsed_minutes || 0} / ${shiftTotal} Menit\n`;

    const message = `🕸️ *SPIDER BOT STATUS* 🕸️\n\n` +
      `${statusIcon} *Status:* ${escape(stats.status)}\n` +
      (stats.sleep_started_at ? `💤 *Tidur Sejak:* ${escape(stats.sleep_started_at)}\n` : '') +
      (stats.next_wake_time ? `⏰ *Bangun Pada:* ${escape(new Date(stats.next_wake_time).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta'}))}\n` : '') +
      `👤 *Artis Terakhir:* ${escape(stats.last_artist_processed || '-')}\n` +
      `✅ *Total Selesai \\(DB\\):* ${stats.done || 0}\n` +
      `⏳ *Sisa Antrean:* ${stats.pending || 0}\n` +
      shiftDisplay +
      `⏱️ *Durasi Terakhir:* ${escape(String(stats.last_duration_minutes || 0))} Menit\n` +
      `🔮 *ETA Selesai:* \\~${escape(String(stats.estimated_time_remaining_hours || 0))} Jam\n\n` +
      `*🖥️ Metrik Sesi Saat Ini:*\n` +
      `• Uptime Spider: ${escape(String(stats.uptime_hours || stats.uptime_minutes / 60 || 0))} Jam\n` +
      `• Siklus Tidur: ${stats.total_deep_sleep_count || stats.deep_sleep_count || 0} Kali\n` +
      `• RAM \\(RSS\\): ${stats.memory_rss_mb || 0} MB\n` +
      `• Album Disisir: ${stats.total_albums_scanned || stats.albums_scanned_session || 0}\n` +
      `• Lagu Sukses Sesi Ini: ${stats.total_session_tracks_success || stats.tracks_success_session || 0}\n\n` +
      (stats.last_shutdown_reason || stats.shutdown_reason ? `🛑 *Alasan Mati Terakhir:*\n_${escape(stats.last_shutdown_reason || stats.shutdown_reason)}_\n\n` : '') +
      `_🔄 Diperbarui: ${escape(lastUpdate)}_`

    return ctx.reply(message, { parse_mode: 'MarkdownV2', message_thread_id: ADMIN_THREAD_SPIDER_PANEL })
  } catch (err) {
    logger.error({ event: 'spider_status_failed', msg: err.message })
    return ctx.reply(`❌ Terjadi kesalahan saat membaca status Spider: ${err.message}`, { message_thread_id: ADMIN_THREAD_SPIDER_PANEL })
  }
}

async function handleSpiderQueue(ctx) {
  const pendingCount = countSpiderQueue()
  if (pendingCount === 0) {
    return ctx.reply('📭 Antrean Spider kosong saat ini.', { message_thread_id: ADMIN_THREAD_SPIDER_PANEL })
  }

  const queue = getSpiderQueue(15)
  const lines = queue.map((a, i) => `${i + 1}\\. *${escape(a.name)}* \\(\`${a.artist_id}\`\\)`).join('\n')

  await ctx.reply(
    `🕸️ *Spider Queue* \\(${pendingCount} Pending\\)\n_Menampilkan 15 antrean teratas:_\n\n${lines}`, 
    { parse_mode: 'MarkdownV2', message_thread_id: ADMIN_THREAD_SPIDER_PANEL }
  )
}

async function handleSpiderSkip(ctx) {
  const keyword = ctx.message.text.split(/\s+/).slice(1).join(' ').trim()
  if (!keyword) {
    return await ctx.reply('❌ Masukkan nama artis atau ID untuk di\\-skip\\.\nContoh: `/spider_skip Nirvana`', { parse_mode: 'MarkdownV2', message_thread_id: ADMIN_THREAD_SPIDER_PANEL })
  }

  const success = skipSpiderArtist(keyword)
  if (success) {
    const pendingCount = countSpiderQueue()
    return await ctx.reply(`✅ Berhasil menghapus *${escape(keyword)}* dari antrean\\.\n⏳ Sisa antrean: ${pendingCount}`, { parse_mode: 'MarkdownV2', message_thread_id: ADMIN_THREAD_SPIDER_PANEL })
  } else {
    return await ctx.reply(`❌ Artis *${escape(keyword)}* tidak ditemukan di antrean\\.`, { parse_mode: 'MarkdownV2', message_thread_id: ADMIN_THREAD_SPIDER_PANEL })
  }
}

async function handleSpiderClear(ctx) {
  try {
    const deletedCount = clearSpiderQueue()
    return await ctx.reply(
      `🧹 *Antrean Dikosongkan*\nBerhasil menghapus ${deletedCount} artis dari antrean Spider\\.`, 
      { parse_mode: 'MarkdownV2', message_thread_id: ADMIN_THREAD_SPIDER_PANEL }
    )
  } catch (err) {
    logger.error({ event: 'spider_clear_failed', msg: err.message })
    return await ctx.reply(`❌ Gagal membersihkan antrean: ${escape(err.message)}`, { parse_mode: 'MarkdownV2', message_thread_id: ADMIN_THREAD_SPIDER_PANEL })
  }
}

module.exports = {
  spiderPanelOnly, handleSeedArtist, handleSeedArtistCallback, 
  handleSpiderStatus, handleSpiderQueue, handleSpiderSkip, handleSpiderClear
};