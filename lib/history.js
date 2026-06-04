import cfg from "./config.js"

const conversations = {}

export function getHistory(userId) {
  if (!conversations[userId]) conversations[userId] = []
  return conversations[userId]
}

export function clearHistory(userId) {
  conversations[userId] = []
}

export function addMessage(userId, role, content) {
  const history = getHistory(userId)
  history.push({ role, content })
  trimIfNeeded(userId)
}

export function buildContext(userId, systemPrompt) {
  const messages = []
  if (systemPrompt) messages.push({ role: "system", content: systemPrompt })
  messages.push(...getHistory(userId))
  return messages
}

function estimateTokens(content) {
  if (!content) return 0
  let cjk = 0
  let other = 0
  for (const ch of content) {
    const code = ch.codePointAt(0)
    if (
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0x3400 && code <= 0x4dbf) ||
      (code >= 0xf900 && code <= 0xfaff)
    )
      cjk++
    else other++
  }
  return Math.floor(cjk * 0.6 + other * 0.25)
}

function trimIfNeeded(userId) {
  const history = getHistory(userId)
  const maxTokens = cfg.maxTokens || 900000
  const maxPairs = (cfg.maxHistoryPairs || 20) * 2
  let total = 0
  let cutAt = 0
  for (let i = 0; i < history.length; i++) {
    total += estimateTokens(history[i].content)
    if (total > maxTokens) {
      cutAt = i
      break
    }
  }
  if (cutAt > 0) {
    const removeCount = Math.min(cutAt, history.length - maxPairs)
    if (removeCount > 0) history.splice(0, removeCount)
  }
  while (history.length > maxPairs) history.shift()
}
