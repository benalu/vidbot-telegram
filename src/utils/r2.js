const { S3Client, DeleteObjectCommand } = require('@aws-sdk/client-s3')
const { Upload } = require('@aws-sdk/lib-storage')
const { recordR2Failure } = require('./alerting')

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

async function uploadToR2(streamOrBuffer, key, contentType = 'audio/mpeg', contentLength = null) {
  try {
    const upload = new Upload({
      client,
      params: {
        Bucket: BUCKET,
        Key: key,
        Body: streamOrBuffer,
        ContentType: contentType,
      },
      queueSize: 4,
      partSize: 10 * 1024 * 1024,
    })
    await upload.done()
    return `${PUBLIC_URL}/${key}`
  } catch (err) {
    recordR2Failure({
      track: key.split('/').pop().replace(/\.[^.]+$/, '') || key,
      error: err.message,
      key,
      size:  contentLength,
    })
    throw err
  }
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