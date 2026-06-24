// src/features/movies/movies.helpers.js
// Helper terkait video quality, caption builder, dan upload ke archive channel.
// Dipakai oleh spider-movs.js agar file utama tidak terlalu panjang.

'use strict';

const fs           = require('fs');
const { execSync } = require('child_process');
const axios        = require('axios');
const logger       = require('../../utils/logger');
const { randomDelay } = require('../../utils/http');

/**
 * Deteksi resolusi video pakai ffprobe.
 * Return string seperti "1080p", atau null kalau gagal.
 */
function getVideoQuality(filePath) {
  try {
    const ffprobePath = process.env.FFPROBE_PATH || '/usr/bin/ffprobe';
    const out = execSync(
      `"${ffprobePath}" -v error -select_streams v:0 -show_entries stream=height -of csv=p=0 "${filePath}"`,
      {
        timeout: 15000,
        env: { ...process.env, PATH: `/usr/bin:/usr/local/bin:/bin:${process.env.PATH || ''}` },
      }
    ).toString().trim();
    const height = parseInt(out);
    return isNaN(height) ? null : `${height}p`;
  } catch (err) {
    logger.warn({ event: 'ffprobe_failed', msg: err.message });
    return null;
  }
}

/**
 * Build caption dan thumbnail untuk upload Telegram.
 * Return { richCaption, thumbBuffer, qualityLabel }
 */
async function buildUploadPayload(title, quality, fileStats, tmdbMeta) {
  const qualityLabel = (() => {
    if (!quality) return 'HD';
    if (/^\d+p$/i.test(quality)) return quality;
    const h = parseInt(quality.split('x').pop());
    return (!isNaN(h) && h > 0) ? `${h}p` : 'HD';
  })();

  const sizeMb = (fileStats.size / 1024 / 1024).toFixed(1);

  let thumbBuffer = null;
  if (tmdbMeta?.poster) {
    try {
      const res = await axios.get(
        tmdbMeta.poster.replace('/original/', '/w500/'),
        { responseType: 'arraybuffer', timeout: 8000 }
      );
      thumbBuffer = Buffer.from(res.data);
    } catch (err) {
      logger.warn({ event: 'poster_fetch_failed', title, msg: err.message });
    }
  }

  let richCaption;
  if (tmdbMeta) {
    const ov      = tmdbMeta.overview || '';
    const ovTrunc = ov.length > 300 ? ov.slice(0, 297) + '...' : ov;
    richCaption = [
      `🎬 ${tmdbMeta.title} (${tmdbMeta.year})`,
      '',
      ovTrunc || null,
      '',
      tmdbMeta.rating   ? `⭐ Rating: ${tmdbMeta.rating}`   : null,
      tmdbMeta.duration ? `⏱ Durasi: ${tmdbMeta.duration}` : null,
      tmdbMeta.genre    ? `🎭 Genre: ${tmdbMeta.genre}`     : null,
      qualityLabel      ? `🎞 Kualitas: ${qualityLabel}`    : null,
      `📦 Ukuran: ${sizeMb} MB`,
    ].filter(v => v !== null && v !== undefined).join('\n');
  } else {
    richCaption = [
      `🎬 ${title}`,
      qualityLabel ? `🎞 Kualitas: ${qualityLabel}` : null,
      `📦 Ukuran: ${sizeMb} MB`,
    ].filter(Boolean).join('\n');
  }

  if (richCaption.length > 1024) richCaption = richCaption.slice(0, 1021) + '...';
  return { richCaption, thumbBuffer, qualityLabel };
}

/**
 * Upload video ke archive channel Telegram dengan retry 3x.
 * Return sent message object.
 */
async function uploadVideoToArchive(ctx, archiveChannel, localFilePath, richCaption, thumbBuffer) {
  let sent, attempt = 0;
  while (attempt < 3) {
    try {
      const sendOpts = { caption: richCaption, supports_streaming: true };
      if (thumbBuffer?.length > 1000) sendOpts.thumbnail = { source: thumbBuffer, filename: 'thumb.jpg' };
      fs.accessSync(localFilePath, fs.constants.R_OK);
      sent = await ctx.telegram.sendVideo(archiveChannel, { source: localFilePath }, sendOpts);
      break;
    } catch (err) {
      attempt++;
      logger.warn({ event: 'telegram_upload_retry', attempt, msg: err.message });
      if (attempt >= 3) throw new Error(`Gagal upload ke Telegram setelah 3 percobaan: ${err.message}`);
      await randomDelay(3000, 6000);
    }
  }
  return sent;
}

module.exports = { getVideoQuality, buildUploadPayload, uploadVideoToArchive };