const axios = require('axios')

class VidBotClient {
  constructor() {
  this.baseURL = process.env.API_URL
  this.apiKey = process.env.API_KEY
  this.accessToken = null
  this.tokenPromise = null  // ← tambah ini
}

  async getAccessToken() {
    const res = await axios.get(`${this.baseURL}/auth/verify`, {
      headers: { 'X-API-Key': this.apiKey }
    })
    this.accessToken = res.data.access_token
    // token berlaku 5 menit, refresh sebelum expire
    setTimeout(() => { this.accessToken = null }, 4 * 60 * 1000)
    return this.accessToken
  }

  async getHeaders() {
    if (!this.accessToken) {
      if (!this.tokenPromise) {
        this.tokenPromise = this.getAccessToken().finally(() => {
          this.tokenPromise = null
        })
      }
      await this.tokenPromise
    }
    return {
      'X-API-Key': this.apiKey,
      'X-Access-Token': this.accessToken,
      'Content-Type': 'application/json'
    }
  }

  async leakcheck(id) {
    const headers = await this.getHeaders()
    const res = await axios.post(`${this.baseURL}/leakcheck/search`,
      { id }, { headers })
    return res.data
  }
  async leakcheckCount() {
    const headers = await this.getHeaders()
    const res = await axios.get(`${this.baseURL}/leakcheck/count`, { headers })
    return res.data
  }

  async contentTiktok(url) {
    const headers = await this.getHeaders()
    const res = await axios.post(`${this.baseURL}/content/tiktok`,
      { url }, { headers })
    return res.data
  }

  async contentSpotify(url) {
    const headers = await this.getHeaders()
    const res = await axios.post(`${this.baseURL}/content/spotify`,
      { url }, { headers })
    return res.data
  }

  async contentInstagram(url) {
    const headers = await this.getHeaders()
    const res = await axios.post(`${this.baseURL}/content/instagram`,
      { url }, { headers })
    return res.data
  }

  async contentTwitter(url) {
    const headers = await this.getHeaders()
    const res = await axios.post(`${this.baseURL}/content/twitter`,
      { url }, { headers })
    return res.data
  }

  async contentThreads(url) {
    const headers = await this.getHeaders()
    const res = await axios.post(`${this.baseURL}/content/threads`,
      { url }, { headers })
    return res.data
  }

  async vidhub(site, url) {
    const headers = await this.getHeaders()
    const res = await axios.post(`${this.baseURL}/vidhub/${site}`,
      { url }, { headers })
    return res.data
  }
  async appAndroid(keyword) {
    const headers = await this.getHeaders()
    const res = await axios.post(`${this.baseURL}/app/android`,
      { apk: keyword }, { headers })
    return res.data
  }
  async moviesSearch(keyword) {
    const headers = await this.getHeaders()
    const res = await axios.post(`${this.baseURL}/downloader/movies/search`,
      { movies: keyword }, { headers })
    return res.data
  }
  async flacSearch(keyword) {
    const headers = await this.getHeaders()
    const res = await axios.post(`${this.baseURL}/downloader/flac/search`,
      { q: keyword }, { headers })
    return res.data
  }
}

module.exports = new VidBotClient()