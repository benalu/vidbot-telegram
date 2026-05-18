const { escape } = require('./utils')

function formatApp(app) {
  const buttons = []

  app.download.forEach(dl => {
    const urlKeys = Object.keys(dl).filter(k => k.startsWith('url_'))
    urlKeys.forEach((key, i) => {
      const label = urlKeys.length > 1
        ? `⬇️ Mirror ${i + 1}  •  v${dl.version}`
        : `⬇️ Download  •  v${dl.version}`
      buttons.push([{ text: label, url: dl[key] }])
    })
  })

  const overview  = app.overview || 'No description available.'
  const truncated = overview.length > 150 ? overview.slice(0, 147) + '...' : overview

  const text = [
    `*${escape(app.name)}*`,
    ``,
    `_${escape(truncated)}_`,
    ``,
    `┌ 📂 *Category* ∙ ${escape(app.category)}`,
    `└ 📱 *Android* ${escape(app.requirements)}\\+`,
  ].join('\n')

  return { text, buttons }
}

module.exports = { formatApp }