// src/utils/logger.js
// Structured logger — satu tempat, konsisten di seluruh codebase.

function log(level, data) {
  const out = JSON.stringify({ ts: new Date().toISOString(), level, ...data })
  if (level === 'error' || level === 'warn') {
    console.error(out)
  } else {
    console.log(out)
  }
}

module.exports = {
  info:  (data) => log('info',  data),
  warn:  (data) => log('warn',  data),
  error: (data) => log('error', data),
}