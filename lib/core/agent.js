import { chatCompletion, agentChatCompletion } from "../api.js"
import contextManager, { sessionKeyOf } from "./context.js"
import promptBuilder from "./prompt.js"
import toolRegistry from "../tools/registry.js"
import memoryManager from "../memory/manager.js"
import { scanSkills } from "../skills/loader.js"
import cfg from "../config.js"
import { toApiImageUrls, buildVisionContent } from "../utils/image.js"

const DEFAULT_MAX_ROUNDS = 15

/**
 * AgentCore - 核心对话引擎
 *
 * 职责:
 * - 构建系统提示词（personality + memory + skills + tools）
 * - 管理对话循环（Turn Lifecycle）
 * - 工具调用与结果处理
 * - 上下文压缩
 * - 记忆自动刷新
 *
 * 说明：对话上下文按 sessionKey（用户+群 / 用户+私聊）隔离，
 * 而记忆仍然按真实 userId 读写。
 */
class AgentCore {
  async run(userId, event, userMessage, personality, imageUrls = []) {
    const sessionKey = sessionKeyOf(event, userId)
    contextManager.initSession(sessionKey)

    try {
      await scanSkills()
      const systemPrompt = await promptBuilder.build(userId, {
        personality: personality || cfg.agentSystemPrompt,
        event,
      })

      if (imageUrls?.length) {
        const urls = await toApiImageUrls(imageUrls)
        const content = urls.length
          ? buildVisionContent(userMessage, urls)
          : userMessage
        contextManager.addMessage(sessionKey, "user", content)
      } else {
        contextManager.addMessage(sessionKey, "user", userMessage)
      }
      contextManager.incrementTurn(sessionKey)

      return await this._agentLoop(sessionKey, userId, event, systemPrompt)
    } catch (err) {
      return { text: `Agent 执行失败: ${err.message}`, images: [] }
    }
  }

  /**
   * 快速对话模式（无工具调用，直接回答）
   */
  async quickChat(userId, userMessage, personality, imageUrls = [], event = null) {
    const sessionKey = sessionKeyOf(event, userId)
    contextManager.initSession(sessionKey)
    await scanSkills()

    const systemPrompt = await promptBuilder.build(userId, {
      personality: personality || cfg.systemPrompt,
      event,
    })

    if (imageUrls?.length) {
      const urls = await toApiImageUrls(imageUrls)
      const content = urls.length
        ? buildVisionContent(userMessage, urls)
        : userMessage
      contextManager.addMessage(sessionKey, "user", content)
    } else {
      contextManager.addMessage(sessionKey, "user", userMessage)
    }
    contextManager.incrementTurn(sessionKey)

    const messages = contextManager.getMessages(sessionKey)
    const apiMessages = [{ role: "system", content: systemPrompt }, ...messages]

    const response = await chatCompletion(apiMessages)
    const text = typeof response === "string" ? response : response.content || ""

    contextManager.addMessage(sessionKey, "assistant", text)
    return text
  }

  /**
   * Agent 主循环
   *   1. 检查上下文压缩
   *   2. 构建 messages
   *   3. API 调用（带工具）
   *   4. 解析 tool_calls
   *   5. 执行工具
   *   6. 循环或返回
   */
  async _agentLoop(sessionKey, userId, event, systemPrompt) {
    let finalContent = ""
    const collectedImages = []
    const toolContext = { event, userId, images: collectedImages }

    const maxRounds = Number(cfg.agentMaxRounds) > 0 ? Number(cfg.agentMaxRounds) : DEFAULT_MAX_ROUNDS
    const maxContextTokens = Number(cfg.maxContextTokens) > 0 ? Number(cfg.maxContextTokens) : 64000

    for (let round = 0; round < maxRounds; round++) {
      contextManager.compress(sessionKey, maxContextTokens)

      const messages = contextManager.getMessages(sessionKey)
      const apiMessages = [{ role: "system", content: systemPrompt }, ...messages]

      const tools = toolRegistry.getOpenAITools()
      const options = { tools, tool_choice: tools.length ? "auto" : undefined }
      let response

      try {
        response = await agentChatCompletion(apiMessages, options)
      } catch (err) {
        contextManager.addMessage(sessionKey, "assistant", `[错误] ${err.message}`)
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
          contextManager.addMessage(sessionKey, "assistant", textContent)
          finalContent += (finalContent ? "\n" : "") + textContent
        }
        break
      }

      contextManager.addAssistantToolCalls(sessionKey, textContent, toolCalls)
      if (textContent) finalContent += (finalContent ? "\n" : "") + textContent

      const toolResults = []
      for (const toolCall of toolCalls) {
        const fnName = toolCall.function?.name
        let fnArgs = {}

        try {
          fnArgs = JSON.parse(toolCall.function?.arguments || "{}")
        } catch {}

        const result = await toolRegistry.execute(fnName, fnArgs, toolContext)
        contextManager.addToolResult(sessionKey, toolCall.id, result, fnName)

        toolResults.push({
          name: fnName,
          result: typeof result === "string" ? result.slice(0, 200) : JSON.stringify(result).slice(0, 200),
        })
      }

      const progressLines = toolResults.map(t => `🔧 **${t.name}** → ${t.result.slice(0, 100)}`)
      if (toolResults.length <= 3) {
        finalContent += "\n\n" + progressLines.join("\n")
      }
      // toolCallsHistory 已移除（原本只 push 不使用）

      const hasMemoryTool = toolCalls.some(t => t.function?.name === "memory")
      if (hasMemoryTool) {
        await memoryManager.flush()
      }
    }

    await memoryManager.flush()
    return { text: finalContent || "Agent 执行完毕", images: collectedImages }
  }

  getSessionState(userId) {
    return contextManager.getSummary(userId)
  }

  clearSession(userId) {
    contextManager.clear(userId)
  }

  clearAllSessions() {
    return contextManager.clearAll()
  }
}

export const agentCore = new AgentCore()
export default agentCore
