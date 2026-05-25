// src/utils/typing.js

function startTyping(ctx, threadId) {
  const opts = threadId ? { message_thread_id: threadId } : {}
  ctx.sendChatAction('typing', opts).catch(() => {})
  const interval = setInterval(() => {
    ctx.sendChatAction('typing', opts).catch(() => {})
  }, 4000)
  return () => clearInterval(interval)
}

module.exports = { startTyping }