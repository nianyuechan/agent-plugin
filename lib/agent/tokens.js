/**
 * token 计量（对齐 @deepseek-ai/dsh-token-meter 的固定密度估算）
 * 在需要精确分词之前使用：文本密度估算 = 字符数 / 4，每个结构化块固定 4 tokens 开销。
 */

export const CHARS_PER_TOKEN = 4
export const BLOCK_OVERHEAD = 4

export function estimateText(text) {
  if (!text) return 0
  return Math.ceil(String(text).length / CHARS_PER_TOKEN)
}

/** 内容可以是字符串，也可以是块数组（{type:'text'|'image'|'tool-call'...}） */
export function estimateContent(content) {
  if (content === undefined || content === null) return 0
  if (typeof content === "string") return estimateText(content)
  if (!Array.isArray(content)) return BLOCK_OVERHEAD + estimateText(JSON.stringify(content))

  let tokens = 0
  for (const block of content) {
    if (!block || typeof block !== "object") {
      tokens += estimateText(String(block ?? ""))
      continue
    }
    if (block.type === "text") tokens += estimateText(block.text) + BLOCK_OVERHEAD
    else if (block.type === "tool-call") {
      tokens += estimateText(block.name) + estimateText(block.arguments) + BLOCK_OVERHEAD
    } else if (block.type === "image" || block.type === "image_url") tokens += BLOCK_OVERHEAD
    else tokens += BLOCK_OVERHEAD + estimateText(JSON.stringify(block))
  }
  return tokens
}

export function estimateMessage(message) {
  if (!message) return 0
  let tokens = estimateContent(message.content) + BLOCK_OVERHEAD
  if (message.tool_calls) {
    for (const call of message.tool_calls) {
      tokens += estimateText(call?.function?.name) + estimateText(call?.function?.arguments) + BLOCK_OVERHEAD
    }
  }
  if (message.role === "system") tokens += BLOCK_OVERHEAD
  return tokens
}

export function estimateMessages(messages) {
  let total = 0
  for (const message of messages || []) total += estimateMessage(message)
  return total
}

/** 工具 schema 本身也占用上下文 */
export function estimateTools(tools) {
  if (!tools || !tools.length) return 0
  return estimateText(JSON.stringify(tools)) + BLOCK_OVERHEAD
}

export function estimateRequest({ systemPrompt, messages, tools }) {
  return estimateText(systemPrompt) + estimateMessages(messages) + estimateTools(tools)
}
