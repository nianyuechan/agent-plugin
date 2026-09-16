import memoryManager from "../memory/manager.js"
import toolRegistry from "../tools/registry.js"
import skillRegistry from "../skills/registry.js"
import cfg from "../config.js"

/**
 * 计算会话键。
 * 群聊按「用户 + 群」隔离，私聊单独一条 —— 避免私聊内容串到群里、
 * 以及 A 群的上下文在 B 群被复述。
 */
export function sessionKeyOf(event, fallback = "unknown") {
  if (!event) return fallback
  const uid = event.user_id ?? fallback
  if (event.isGroup) return `${uid}:group:${event.group_id ?? "unknown"}`
  if (event.isPrivate) return `${uid}:private`
  return `${uid}:${fallback}`
}

class ContextManager {
  constructor() {
    this._messages = new Map()
    this._sessionMeta = new Map()
  }

  _maxSessions() {
    const n = Number(cfg.maxSessions)
    return Number.isFinite(n) && n > 0 ? n : 500
  }

  /** 把会话移到 Map 末尾（LRU：最近的会话最后被淘汰） */
  _touch(userId) {
    const messages = this._messages.get(userId)
    if (!messages) return
    this._messages.delete(userId)
    this._messages.set(userId, messages)
  }

  /** 超过上限时淘汰最久未活跃的会话，避免常驻进程内存无限增长 */
  _evictIfNeeded() {
    const max = this._maxSessions()
    while (this._messages.size > max) {
      const oldest = this._messages.keys().next().value
      if (oldest === undefined) break
      this._messages.delete(oldest)
      this._sessionMeta.delete(oldest)
    }
  }

  initSession(userId) {
    if (!this._messages.has(userId)) {
      this._messages.set(userId, [])
      this._sessionMeta.set(userId, { turnCount: 0, compressed: false, lastActive: Date.now() })
      this._evictIfNeeded()
    }
    const meta = this._sessionMeta.get(userId)
    if (meta) {
      meta.lastActive = Date.now()
      meta.turnCount = meta.turnCount || 0
      if (meta.compressed === undefined) meta.compressed = false
    } else {
      this._sessionMeta.set(userId, { turnCount: 0, compressed: false, lastActive: Date.now() })
    }
  }

  getMessages(userId) {
    this.initSession(userId)
    this._touch(userId)
    return this._messages.get(userId)
  }

  getTurnCount(userId) {
    this.initSession(userId)
    return this._sessionMeta.get(userId).turnCount
  }

  incrementTurn(userId) {
    this.initSession(userId)
    this._sessionMeta.get(userId).turnCount++
  }

  addMessage(userId, role, content, name, toolCallId, toolCalls) {
    this.initSession(userId)
    const msg = { role }
    if (content) msg.content = content
    if (name) msg.name = name
    if (toolCallId) msg.tool_call_id = toolCallId
    if (toolCalls) msg.tool_calls = toolCalls
    this._messages.get(userId).push(msg)
    this._touch(userId)
  }

  addToolResult(userId, toolCallId, result, toolName) {
    const content = typeof result === "string" ? result : JSON.stringify(result, null, 2)
    this.addMessage(userId, "tool", content, toolName, toolCallId)
  }

  addAssistantToolCalls(userId, textContent, toolCalls) {
    const msg = { role: "assistant" }
    if (textContent) msg.content = textContent
    if (toolCalls && toolCalls.length) msg.tool_calls = toolCalls
    this._messages.get(userId).push(msg)
  }

  clear(userId) {
    this._messages.set(userId, [])
    this._sessionMeta.set(userId, { turnCount: 0, compressed: false, lastActive: Date.now() })
    this._touch(userId)
  }

  clearAll() {
    const userCount = this._messages.size
    this._messages.clear()
    this._sessionMeta.clear()
    return userCount
  }

  /**
   * 构建完整的 messages 数组（OpenAI 格式）
   */
  async buildMessages(userId, systemPrompt) {
    this.initSession(userId)
    const messages = []

    if (systemPrompt) {
      messages.push({ role: "system", content: systemPrompt })
    }

    const memory = await memoryManager.getGlobalMemory()
    const userMemory = await memoryManager.getUserMemory(userId)
    if (memory || userMemory) {
      const memParts = []
      if (memory) memParts.push("### 全局记忆\n" + memory.trim())
      if (userMemory) memParts.push("### 用户信息\n" + userMemory.trim())
      messages.push({ role: "system", content: memParts.join("\n\n") })
    }

    const skills = skillRegistry.getEnabled()
    if (skills.length) {
      const skillList = skills.map(s => `- ${s.name}: ${s.description || ""}`).join("\n")
      messages.push({
        role: "system",
        content: "### 可用技能（Yunzai插件）\n" + skillList
          + "\n\n使用 yunzai 工具调用这些技能的命令（如 #签到、#帮助等）。",
      })
    }

    const toolDesc = toolRegistry.getSystemPrompt()
    if (toolDesc) {
      messages.push({ role: "system", content: toolDesc })
    }

    messages.push(...(this._messages.get(userId) || []))

    return messages
  }

  /**
   * 估算 message 数组的 token 数（粗略：中文字符≈0.6 token，英文≈0.25 token）
   */
  estimateTokens(messages) {
    let total = 0
    for (const msg of messages) {
      total += 4
      const content = typeof msg.content === "string"
        ? msg.content
        : JSON.stringify(msg.content || "")
      const chineseChars = (content.match(/[\u4e00-\u9fff]/g) || []).length
      const otherChars = content.length - chineseChars
      total += chineseChars * 0.6 + otherChars * 0.25
      if (msg.tool_calls) {
        total += JSON.stringify(msg.tool_calls).length * 0.25
      }
    }
    return Math.ceil(total)
  }

  /**
   * 上下文压缩：只压缩「完整的对话轮次」，绝不拆散 assistant.tool_calls 与 tool 结果。
   * 切点一律取在 user 消息处，因此保留下来的每一段都是自洽的。
   */
  compress(userId, maxTokens = 64000) {
    const messages = this._messages.get(userId)
    if (!messages || messages.length < 6) return false

    const estimated = this.estimateTokens(messages)
    if (estimated < maxTokens * 0.7) return false

    const roundStarts = []
    for (let i = 0; i < messages.length; i++) {
      if (messages[i].role === "user") roundStarts.push(i)
    }
    if (roundStarts.length < 3) return false

    const keepHeadRounds = 1
    const keepTailRounds = 2
    const headEnd = roundStarts[Math.min(keepHeadRounds, roundStarts.length - 1)]
    const tailStart = roundStarts[Math.max(0, roundStarts.length - keepTailRounds)]
    if (tailStart <= headEnd) return false

    const toCompress = messages.slice(headEnd, tailStart)
    let summary = "[上下文压缩] "
    for (const msg of toCompress) {
      if (msg.role === "user") {
        summary += `用户: ${String(msg.content || "").slice(0, 100)}; `
      } else if (msg.role === "assistant" && msg.tool_calls) {
        summary += `调用了工具: ${msg.tool_calls.map(t => t.function?.name).join(", ")}; `
      } else if (msg.role === "assistant" && msg.content) {
        summary += `助手: ${String(msg.content).slice(0, 100)}; `
      } else if (msg.role === "tool") {
        summary += `工具结果: ${String(msg.content || "").slice(0, 80)}; `
      }
    }

    this._messages.set(userId, [
      ...messages.slice(0, headEnd),
      { role: "system", content: summary.slice(0, 1000) },
      ...messages.slice(tailStart),
    ])
    this._sessionMeta.get(userId).compressed = true
    return true
  }

  getSummary(userId) {
    const messages = this._messages.get(userId) || []
    return {
      messageCount: messages.length,
      turnCount: this.getTurnCount(userId),
      estimatedTokens: this.estimateTokens(messages),
      compressed: this._sessionMeta.get(userId)?.compressed || false,
    }
  }
}

export const contextManager = new ContextManager()
export default contextManager
