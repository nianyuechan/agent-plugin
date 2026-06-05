import { chatCompletion } from "../api.js"
import contextManager from "./context.js"
import promptBuilder from "./prompt.js"
import toolRegistry from "../tools/registry.js"
import skillRegistry from "../skills/registry.js"
import memoryManager from "../memory/manager.js"
import { scanSkills } from "../skills/loader.js"
import cfg from "../config.js"

const DEFAULT_MAX_ROUNDS = 15
const COMPRESSION_THRESHOLD = 0.7

/**
 * AgentCore - 核心对话引擎
 * 对齐 Hermes AIAgent.run_conversation() 的设计模式
 *
 * 职责:
 * - 构建系统提示词（personality + memory + skills + tools）
 * - 管理对话循环（Turn Lifecycle）
 * - 工具调用与结果处理
 * - 上下文压缩
 * - 记忆自动刷新
 * - 会话状态追踪
 */
class AgentCore {
  constructor() {
  }

  async run(userId, event, userMessage, personality, imageUrls = []) {
    contextManager.initSession(userId)

    try {
      await scanSkills()
      const systemPrompt = await promptBuilder.build(userId, {
        personality: personality || cfg.agentSystemPrompt,
      })

      if (imageUrls.length) {
        const content = [
          { type: "text", text: userMessage },
          ...imageUrls.map(url => ({ type: "image_url", image_url: { url } })),
        ]
        contextManager.addMessage(userId, "user", content)
      } else {
        contextManager.addMessage(userId, "user", userMessage)
      }
      contextManager.incrementTurn(userId)

      return await this._agentLoop(userId, event, systemPrompt)
    } catch (err) {
      return { text: `Agent 执行失败: ${err.message}`, images: [] }
    }
  }

  /**
   * 快速对话模式（无工具调用，直接回答）
   */
  async quickChat(userId, userMessage, personality, imageUrls = []) {
    contextManager.initSession(userId)
    await scanSkills()

    const systemPrompt = await promptBuilder.build(userId, {
      personality: personality || cfg.systemPrompt,
    })

    if (imageUrls.length) {
      const content = [
        { type: "text", text: userMessage },
        ...imageUrls.map(url => ({ type: "image_url", image_url: { url } })),
      ]
      contextManager.addMessage(userId, "user", content)
    } else {
      contextManager.addMessage(userId, "user", userMessage)
    }
    contextManager.incrementTurn(userId)

    const messages = contextManager.getMessages(userId)
    const apiMessages = [{ role: "system", content: systemPrompt }, ...messages]

    const response = await chatCompletion(apiMessages)
    const text = typeof response === "string" ? response : response.content || ""

    contextManager.addMessage(userId, "assistant", text)
    return text
  }

  /**
   * Agent 主循环
   * 对齐 Hermes agent loop:
   *   1. 检查上下文压缩
   *   2. 构建 messages
   *   3. API 调用（带工具）
   *   4. 解析 tool_calls
   *   5. 执行工具
   *   6. 循环或返回
   */
  async _agentLoop(userId, event, systemPrompt) {
    let finalContent = ""
    const collectedImages = []
    const toolCallsHistory = []
    const toolContext = { event, userId, images: collectedImages }

    for (let round = 0; round < (cfg.agentMaxRounds || DEFAULT_MAX_ROUNDS); round++) {
      contextManager.compress(userId, cfg.maxTokens || 900000)

      const messages = contextManager.getMessages(userId)
      const apiMessages = [{ role: "system", content: systemPrompt }, ...messages]

      const tools = toolRegistry.getOpenAITools()
      const options = { tools, tool_choice: tools.length ? "auto" : undefined }
      let response

      try {
        response = await chatCompletion(apiMessages, options)
      } catch (err) {
        contextManager.addMessage(userId, "assistant", `[错误] ${err.message}`)
        return { text: `API 调用失败: ${err.message}`, images: collectedImages }
      }

      let textContent = ""
      let toolCalls = []

      if (typeof response === "string") {
        textContent = response
      } else if (response && typeof response === "object") {
        textContent = response.content || ""
        toolCalls = response.toolCalls || []
      }

      if (!toolCalls.length) {
        if (textContent) {
          contextManager.addMessage(userId, "assistant", textContent)
          finalContent += (finalContent ? "\n" : "") + textContent
        }
        break
      }

      contextManager.addAssistantToolCalls(userId, textContent, toolCalls)
      if (textContent) finalContent += (finalContent ? "\n" : "") + textContent

      const toolResults = []
      for (const toolCall of toolCalls) {
        const fnName = toolCall.function?.name
        let fnArgs = {}

        try {
          fnArgs = JSON.parse(toolCall.function?.arguments || "{}")
        } catch {}

        const result = await toolRegistry.execute(fnName, fnArgs, toolContext)
        contextManager.addToolResult(userId, toolCall.id, result, fnName)

        toolResults.push({
          name: fnName,
          args: fnArgs,
          result: typeof result === "string" ? result.slice(0, 200) : JSON.stringify(result).slice(0, 200),
        })

        toolCallsHistory.push({ name: fnName, args: fnArgs, result })
      }

      const progressLines = toolResults.map(t =>
        `🔧 **${t.name}** → ${t.result.slice(0, 100)}`
      )
      if (toolResults.length <= 3) {
        finalContent += "\n\n" + progressLines.join("\n")
      }

      const hasMemoryTool = toolCalls.some(t => t.function?.name === "memory")
      if (hasMemoryTool) {
        await memoryManager.flush()
      }
    }

    await memoryManager.flush()
    return { text: finalContent || "Agent 执行完毕", images: collectedImages }
  }

  /**
   * 获取会话状态
   */
  getSessionState(userId) {
    return contextManager.getSummary(userId)
  }

  /**
   * 清除会话
   */
  clearSession(userId) {
    contextManager.clear(userId)
  }
}

export const agentCore = new AgentCore()
export default agentCore
