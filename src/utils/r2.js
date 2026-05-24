const { S3Client, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3')
const { Readable } = require('stream')

const client = new S3Client({
  region:   'auto',
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId:     process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
})

const BUCKET     = process.env.R2_BUCKET
const PUBLIC_URL = process.env.R2_PUBLIC_URL

async function uploadToR2(stream, key, contentType = 'audio/mpeg', contentLength = null) {
  // Kalau stream, buffer dulu — R2 butuh content-length yang akurat
  let body = stream
  if (stream instanceof Readable || typeof stream.pipe === 'function') {
    const chunks = []
    for await (const chunk of stream) chunks.push(chunk)
    body = Buffer.concat(chunks)
  }

  await client.send(new PutObjectCommand({
    Bucket:        BUCKET,
    Key:           key,
    Body:          body,
    ContentType:   contentType,
    ContentLength: contentLength || body.length,
  }))

  return `${PUBLIC_URL}/${key}`
}

async function deleteFromR2(key) {
  await client.send(new DeleteObjectCommand({
    Bucket: BUCKET,
    Key:    key,
  }))
}

function trackKey(trackId, title, artist, type = 'mp3') {
  const safe = (str) => str.replace(/[^a-zA-Z0-9 \-_]/g, '').trim()
  const ext  = type === 'flac' ? 'flac' : 'mp3'
  const dir  = type === 'flac' ? 'flac'  : 'music'
  return `${dir}/${safe(artist)} - ${safe(title)} (${trackId}).${ext}`
}

module.exports = { uploadToR2, deleteFromR2, trackKey }