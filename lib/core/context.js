import memoryManager from "../memory/manager.js"
import toolRegistry from "../tools/registry.js"
import skillRegistry from "../skills/registry.js"

class ContextManager {
  constructor() {
    this._messages = new Map()
    this._sessionMeta = new Map()
  }

  initSession(userId) {
    if (!this._messages.has(userId)) {
      this._messages.set(userId, [])
      this._sessionMeta.set(userId, { turnCount: 0, compressed: false })
    }
  }

  getMessages(userId) {
    this.initSession(userId)
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
    this._sessionMeta.set(userId, { turnCount: 0, compressed: false })
  }

  /**
   * 构建完整的 messages 数组（OpenAI 格式）
   * 对齐 Hermes: 严格 message 角色交替、tool call 配对
   */
  async buildMessages(userId, systemPrompt) {
    this.initSession(userId)
    const messages = []

    // 系统提示词
    if (systemPrompt) {
      messages.push({ role: "system", content: systemPrompt })
    }

    // 加载记忆
    const memory = await memoryManager.getGlobalMemory()
    const userMemory = await memoryManager.getUserMemory(userId)
    if (memory || userMemory) {
      const memParts = []
      if (memory) memParts.push("### 全局记忆\n" + memory.trim())
      if (userMemory) memParts.push("### 用户信息\n" + userMemory.trim())
      messages.push({ role: "system", content: memParts.join("\n\n") })
    }

    // 加载可用技能
    const skills = skillRegistry.getEnabled()
    if (skills.length) {
      const skillList = skills.map(s => `- ${s.name}: ${s.description || ""}`).join("\n")
      messages.push({
        role: "system",
        content: "### 可用技能（Yunzai插件）\n" + skillList
          + "\n\n使用 yunzai 工具调用这些技能的命令（如 #签到、#帮助等）。",
      })
    }

    // 工具列表
    const toolDesc = toolRegistry.getSystemPrompt()
    if (toolDesc) {
      messages.push({ role: "system", content: toolDesc })
    }

    // 对话历史
    const history = this._messages.get(userId) || []
    messages.push(...history)

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
   * 上下文压缩（Hermes 风格：压缩中间轮次，保留首尾）
   */
  compress(userId, maxTokens = 64000) {
    const messages = this._messages.get(userId)
    if (!messages || messages.length < 6) return false

    const estimated = this.estimateTokens(messages)
    if (estimated < maxTokens * 0.7) return false

    const keepFirst = 2
    const keepLast = 10

    if (messages.length <= keepFirst + keepLast) return false

    const toCompress = messages.slice(keepFirst, -keepLast)
    const toolPairs = []
    let summary = "[上下文压缩] "

    for (let i = 0; i < toCompress.length;) {
      const msg = toCompress[i]
      if (msg.role === "user") {
        summary += `用户: ${String(msg.content || "").slice(0, 100)}; `
        i++
      } else if (msg.role === "assistant" && msg.tool_calls) {
        summary += `调用了工具: ${msg.tool_calls.map(t => t.function?.name).join(", ")}; `
        i++
        while (i < toCompress.length && toCompress[i].role === "tool") {
          summary += `工具结果: ${String(toCompress[i].content || "").slice(0, 80)}; `
          i++
        }
      } else {
        i++
      }
    }

    const compressed = [
      ...messages.slice(0, keepFirst),
      { role: "system", content: summary.slice(0, 1000) },
      ...messages.slice(-keepLast),
    ]

    this._messages.set(userId, compressed)
    this._sessionMeta.get(userId).compressed = true
    return true
  }

  /**
   * 获取会话摘要
   */
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
