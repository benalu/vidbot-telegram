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
    // Menggunakan Upload dari lib-storage untuk Streaming & Multipart Upload Otomatis
    const upload = new Upload({
      client,
      params: {
        Bucket: BUCKET,
        Key: key,
        Body: streamOrBuffer, // R2 akan menyedot langsung dari aliran data, tidak menumpuk di RAM
        ContentType: contentType,
      },
      queueSize: 4,               // Mengunggah 4 potongan secara bersamaan (paralel)
      partSize: 10 * 1024 * 1024, // Ukuran per potongan adalah 10 MB
    })

    await upload.done()
    return `${PUBLIC_URL}/${key}`
  } catch (err) {
    const trackName = key.split('/').pop().replace(/\.[^.]+$/, '') || key
    recordR2Failure(trackName)   
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