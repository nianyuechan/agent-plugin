import path from "node:path"
import fs from "node:fs/promises"
import cfg from "../config.js"
import oldToolRegistry from "../tools/registry.js"
import { chatCompletion } from "../api.js"
import memoryManager from "../memory/manager.js"
import skillRegistry from "../skills/registry.js"
import { scanSkills } from "../skills/loader.js"
import contextManager, { sessionKeyOf } from "./context.js"
import promptBuilder from "./prompt.js"
import { buildVisionContent, toApiImageUrls } from "../utils/image.js"

import {
  createAgent, ToolRegistry, HookBus, EVENTS,
  SystemPrompt, SessionStore, EVENT,
} from "../agent/index.js"
import { createOpenAIAdapter } from "../agent/model-openai.js"

/* --------------------------- 旧工具 → DSH 风格工具 --------------------------- */

/** 会改变外部世界的工具标记为独占：它们构成排序屏障，不与并行调用重叠 */
const EXCLUSIVE_TOOLS = new Set(["shell", "write_file", "delete_file", "execute_code", "yunzai", "send_image"])

/** 工具 → 配置开关（与 lib/tools/registry.js 的 allow* 约定保持一致） */
const TOOL_POLICY = {
  shell: "allowShell",
  write_file: "allowFileWrite",
  delete_file: "allowFileDelete",
  execute_code: "allowExecuteCode",
  send_image: "allowLocalFileImages",
}

/** 需要主人确认的高危工具 */
const APPROVAL_TOOLS = new Set(["shell", "write_file", "delete_file", "execute_code"])

/**
 * 把插件里已注册的工具适配成引擎的工具定义。
 * 旧工具的参数已经是 JSON Schema，直接透传；执行时把 event/userId/images 交给原 handler。
 */
function buildEngineRegistry(hooks) {
  const registry = new ToolRegistry(hooks)
  for (const tool of oldToolRegistry.getAll()) {
    registry.register({
      name: tool.name,
      description: [tool.description, tool.usage ? `用法: ${tool.usage}` : ""].filter(Boolean).join("\n"),
      parameters: tool.parameters || { type: "object", properties: {} },
      executionMode: EXCLUSIVE_TOOLS.has(tool.name) ? "exclusive" : "parallel",
      execute: async (args, exec) => {
        const context = exec.agent?.context || {}
        const result = await tool.handler(args, {
          event: context.event,
          userId: context.userId,
          images: context.images || (context.images = []),
        })
        return result
      },
    })
  }
  return registry
}

/** 每个会话键复用一个引擎 registry（工具定义无状态，可共享） */
let sharedRegistry = null
let sharedHooks = null

function ensureHooks() {
  if (sharedHooks) return sharedHooks
  sharedHooks = new HookBus()

  // 策略守卫：配置里关掉的危险工具直接拒绝（比旧实现更靠近 DSH 的 tools/pre-execute 语义）
  sharedHooks.on(EVENTS.TOOLS_PRE_EXECUTE, ({ call, decide }) => {
    const key = TOOL_POLICY[call.name]
    if (key && cfg[key] === false) {
      return decide("deny", `工具 ${call.name} 已被配置禁用（${key} = false）`)
    }
    // 高危工具在开启审批时改为「询问」
    if (cfg.toolApproval === true && APPROVAL_TOOLS.has(call.name)) {
      return decide("ask", `即将执行高危工具 ${call.name}`)
    }
    return undefined
  })

  return sharedHooks
}

function ensureRegistry() {
  if (!sharedRegistry) sharedRegistry = buildEngineRegistry(ensureHooks())
  return sharedRegistry
}

/* --------------------------- 模型适配器 --------------------------- */

function buildModel() {
  const apiKey = String(cfg.agentApiKey || cfg.apiKey || "").replace(/\s/g, "")
  const apiUrl = String(cfg.agentApiUrl || cfg.apiUrl || "https://api.deepseek.com")
  const model = cfg.agentModel || cfg.model || "glm-5.1"
  const contextWindow = Number(cfg.contextWindow) > 0 ? Number(cfg.contextWindow) : 128000

  return createOpenAIAdapter({
    apiKey,
    apiUrl,
    model,
    contextWindow,
    maxTokens: Math.min(Number(cfg.maxTokens) || 8192, 393216),
    timeoutMs: Number(cfg.requestTimeout) > 0 ? Number(cfg.requestTimeout) : 60000,
  })
}

/* --------------------------- 系统提示词 --------------------------- */

async function buildPrompt({ userId, event, personality, policySentence }) {
  const prompt = new SystemPrompt()

  prompt.setPersona({
    prefix: personality || cfg.agentSystemPrompt || "你是一个运行在 QQ 机器人里的助手，可以直接调用工具完成任务。",
    suffix: cfg.agentPromptSuffix || "",
  })

  // 运行时上下文（每步重新求值）
  prompt.registerVariable("cwd", () => process.cwd())
  prompt.registerVariable("model", () => cfg.agentModel || cfg.model || "")
  prompt.registerSection({
    name: "runtime",
    runtime: true,
    text: await buildRuntimeContext({ event, policySentence }),
  })

  const memory = await memoryManager.getGlobalMemory()
  const userMemory = await memoryManager.getUserMemory(userId)
  const memParts = []
  if (memory) memParts.push("## 全局记忆\n" + memory.trim())
  if (userMemory) memParts.push("## 用户信息\n" + userMemory.trim())
  if (memParts.length) {
    prompt.registerSection({ name: "memory", runtime: true, text: memParts.join("\n\n") })
  }

  const skills = skillRegistry.getEnabled()
  if (skills.length) {
    prompt.registerSection({
      name: "skills",
      text: "## 已安装的 Yunzai 插件\n" + skills.map(s => `- ${s.name}: ${s.description || ""}`).join("\n") +
        "\n\n用 yunzai 工具调用它们的指令（如 #签到）。",
    })
  }

  const tools = ensureRegistry().schemas()
  if (tools.length) {
    prompt.registerSection({ name: "tools", text: renderToolGuide(tools) })
  }

  prompt.registerSection({
    name: "instructions",
    text: [
      "## 工作方式",
      "- 先判断是否需要工具；能一次做完就不要拆成多轮。",
      "- 工具报错时读清错误原因再决定是否重试，不要重复同样的失败调用。",
      "- 需要读文件范围很大时，先用 list_dir 或搜索缩小范围。",
      "- 你不确定的信息不要编造；用工具查证，查不到就直说。",
    ].join("\n"),
  })

  return prompt
}

function renderToolGuide(tools) {
  const lines = ["## 可用工具", ""]
  for (const t of tools) {
    const params = t.function.parameters?.properties || {}
    const required = t.function.parameters?.required || []
    const paramText = Object.entries(params)
      .map(([name, node]) => `${name}${required.includes(name) ? "(必填)" : ""}: ${node.description || node.type || ""}`)
      .join("; ")
    lines.push(`- **${t.function.name}**: ${t.function.description || ""}`)
    if (paramText) lines.push(`  参数: ${paramText}`)
  }
  return lines.join("\n")
}

async function buildRuntimeContext({ event, policySentence }) {
  const lines = ["## 运行环境", `- 当前时间: ${new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}`]
  if (event?.isGroup) {
    lines.push(`- 场景: 群聊 ${event.group_id || ""}（${event.group_name || "未知群名"}）`)
  } else if (event?.isPrivate) {
    lines.push("- 场景: 私聊")
  }
  if (event?.user_id) lines.push(`- 发送者: ${event.sender?.card || event.sender?.nickname || ""} (${event.user_id})`)
  if (event?.member?.is_owner) lines.push("- 发送者身份: 群主")
  else if (event?.member?.is_admin) lines.push("- 发送者身份: 管理员")
  if (policySentence) lines.push(`- 审批策略: ${policySentence}`)
  return lines.join("\n")
}

/* --------------------------- 会话管理 --------------------------- */

const SESSION_DIR = path.join(process.cwd(), "plugins/agent-plugin/data/sessions")
const agents = new Map()   // sessionKey → { agent, session }

function sessionIdOf(sessionKey) {
  return String(sessionKey).replace(/[^A-Za-z0-9._-]/g, "_")
}

async function getOrCreateAgent({ sessionKey, userId, event, personality, policySentence, callbacks = {} }) {
  const existing = agents.get(sessionKey)
  if (existing && !existing.agent._disposed) return existing

  const hooks = ensureHooks()
  const registry = ensureRegistry()
  const prompt = await buildPrompt({ userId, event, personality, policySentence })

  const { agent, session } = await createAgent({
    id: sessionIdOf(sessionKey),
    model: buildModel(),
    tools: registry,
    prompt,
    hooks,
    sessionDir: SESSION_DIR,
    sessionId: sessionIdOf(sessionKey),
    resume: true,
    approvalPolicy: "ask",
    config: {
      maxSteps: Number(cfg.agentMaxRounds) > 0 ? Number(cfg.agentMaxRounds) : 25,
      maxParallelToolCalls: Number(cfg.maxParallelToolCalls) > 0 ? Number(cfg.maxParallelToolCalls) : 10,
      contextWindow: Number(cfg.contextWindow) > 0 ? Number(cfg.contextWindow) : 128000,
      cwd: process.cwd(),
    },
  })

  agent.context = { event, userId, images: callbacks.images || [] }
  agent.callbacks = callbacks

  const entry = { agent, session }
  agents.set(sessionKey, entry)
  return entry
}

/* --------------------------- 对外接口（保持旧签名） --------------------------- */

export class AgentCore {
  /**
   * Agent 模式：用 DSH 风格引擎跑一个轮次。
   * @returns {Promise<{text: string, images: Array}>}
   */
  async run(userId, event, userMessage, personality, imageUrls = []) {
    const sessionKey = sessionKeyOf(event, userId)
    const images = []
    const progress = []

    await scanSkills()

    const { agent } = await getOrCreateAgent({
      sessionKey, userId, event, personality,
      callbacks: { images },
    })

    // 每次运行的实时上下文（事件、用户、图片收集器）都要刷新；
    // 系统提示词也重建一次，让记忆/技能/运行环境保持最新（对应 DSH 每步重新快照 runtime context）
    agent.context = { event, userId, images }
    agent.prompt = await buildPrompt({
      userId, event, personality,
      policySentence: agent.approval.policySentence(agent.session),
    })
    const hooks = ensureHooks()

    const offResult = hooks.on(EVENTS.TOOLS_RESULT, ({ call, result }) => {
      const brief = String(result.content || "").replace(/\s+/g, " ").slice(0, 100)
      progress.push(`🔧 ${call.name} → ${brief}${result.isError ? "（失败）" : ""}`)
    })

    try {
      const content = imageUrls?.length
        ? buildVisionContent(userMessage, await toApiImageUrls(imageUrls))
        : userMessage

      agent.followup(content)
      await agent.drive()
      await agent.whenIdle()
    } finally {
      offResult()
    }

    const text = this._lastAssistantText(agent.session)
    const progressText = progress.length && progress.length <= 6
      ? "\n\n" + progress.join("\n")
      : ""

    return {
      text: (text || "Agent 执行完毕") + progressText,
      images,
    }
  }

  _lastAssistantText(session) {
    const messages = session.deriveMessages()
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "assistant" && typeof messages[i].content === "string" && messages[i].content.trim()) {
        return messages[i].content
      }
    }
    return ""
  }

  /** 快速对话：无工具，直接问答（不走 agent 引擎） */
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
      const content = urls.length ? buildVisionContent(userMessage, urls) : userMessage
      contextManager.addMessage(sessionKey, "user", content)
    } else {
      contextManager.addMessage(sessionKey, "user", userMessage)
    }
    contextManager.incrementTurn(sessionKey)

    const messages = contextManager.getMessages(sessionKey)
    const response = await chatCompletion([{ role: "system", content: systemPrompt }, ...messages])
    const text = typeof response === "string" ? response : response.content || ""
    contextManager.addMessage(sessionKey, "assistant", text)
    return text
  }

  /** 引擎会话的历史（DSH 风格：由日志派生） */
  getEngineHistory(sessionKey, limit = 40) {
    const entry = agents.get(sessionKey)
    if (!entry) return []
    return entry.session.deriveMessages().slice(-limit)
  }

  getEngineSummary(sessionKey) {
    const entry = agents.get(sessionKey)
    if (!entry) return null
    return {
      sessionId: entry.session.id,
      seq: entry.session.seq,
      ...entry.agent.getSummary(),
    }
  }

  /** 清除某个会话：释放引擎 agent 并删除持久化日志 */
  async clearSession(sessionKey) {
    const entry = agents.get(sessionKey)
    if (entry) {
      agents.delete(sessionKey)
      await entry.agent.dispose()
    }
    contextManager.clear(sessionKey)
    try {
      await fs.rm(path.join(SESSION_DIR, `${sessionIdOf(sessionKey)}.jsonl`), { force: true })
    } catch {}
  }

  async clearAllSessions() {
    const count = agents.size + contextManager.clearAll()
    for (const [key, entry] of [...agents.entries()]) {
      agents.delete(key)
      await entry.agent.dispose().catch(() => {})
    }
    return count
  }

  getSessionState(sessionKey) {
    const summary = this.getEngineSummary(sessionKey)
    if (summary) {
      const messages = this.getEngineHistory(sessionKey, 1000)
      return {
        messageCount: messages.length,
        turnCount: 0,
        estimatedTokens: 0,
        compressed: false,
        engine: summary,
      }
    }
    return contextManager.getSummary(sessionKey)
  }
}

export const agentCore = new AgentCore()
export default agentCore
export { EVENT, SessionStore, EVENTS }

/** 注册审批应答者（DSH 的 approval/request 瀑布） */
export function onApprovalRequest(handler) {
  return ensureHooks().on(EVENTS.APPROVAL_REQUEST, handler)
}

/** 观察工具结果（用于进度提示） */
export function onToolResult(handler) {
  return ensureHooks().on(EVENTS.TOOLS_RESULT, handler)
}

/** 注册步骤/请求级钩子 */
export function onAgentEvent(name, handler) {
  return ensureHooks().on(name, handler)
}
