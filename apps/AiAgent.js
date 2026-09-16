import cfg, { hasApiKey, getMaskedKey, maskSecret, saveConfig } from "../lib/config.js"
import { streamChat } from "../lib/api.js"
import agentCore, { onApprovalRequest } from "../lib/core/agent.js"
import contextManager, { sessionKeyOf } from "../lib/core/context.js"
import promptBuilder from "../lib/core/prompt.js"
import memoryManager from "../lib/memory/manager.js"
import skillRegistry from "../lib/skills/registry.js"
import { scanSkills } from "../lib/skills/loader.js"
import toolRegistry from "../lib/tools/registry.js"
import { toApiImageUrls, buildVisionContent, isPrivateHost } from "../lib/utils/image.js"

// 注册所有内置工具（自注册模式）
import "../lib/tools/builtin/cmd.js"
import "../lib/tools/builtin/yunzai.js"
import "../lib/tools/builtin/file.js"
import "../lib/tools/builtin/code.js"
import "../lib/tools/builtin/memory.js"
import "../lib/tools/builtin/send_image.js"
import "../lib/tools/builtin/group.js"

import { exec } from "node:child_process"
import path from "node:path"

let agentRunning = false        // #agent 全局锁，同一时间只能有一个任务
let agentWatchdog = null        // 兜底定时器，防止异常情况下锁死

/* ------------------------------ 聊天内审批 ------------------------------ */
/**
 * DSH 的 approval/request 应答者在聊天场景下的实现：
 * 高危工具被挂起 → 机器人提问 → 主人回复「允许/拒绝」→ 决议写回会话审计。
 * 没有应答者作答时引擎会失败关闭（unavailable），绝不静默执行。
 */
const pendingApprovals = new Map()

function approvalKey(e) {
  return sessionKeyOf(e, e.user_id)
}

onApprovalRequest(async ({ agent, tool, reason }) => {
  const e = agent?.context?.event
  if (!e?.reply) return "unavailable"

  const key = approvalKey(e)
  const timeoutMs = Number(cfg.approvalTimeout) > 0 ? Number(cfg.approvalTimeout) : 120000

  await e.reply([
    "⚠️ Agent 请求执行高危操作，需要你确认",
    "═".repeat(20),
    `工具: ${tool}`,
    `原因: ${reason || "-"}`,
    "═".repeat(20),
    "回复「允许」执行一次，或「拒绝」取消",
    `（${Math.round(timeoutMs / 1000)} 秒后自动拒绝）`,
  ].join("\n"))

  return await new Promise(resolve => {
    const timer = setTimeout(() => {
      pendingApprovals.delete(key)
      resolve("timeout")
    }, timeoutMs)
    timer.unref?.()
    pendingApprovals.set(key, { resolve, timer, tool })
  })
})

const IMAGE_EXT = /\.(?:jpg|jpeg|png|gif|webp|bmp)(?:\?[^\s<>"']*)?$/i

/* ------------------------------ 限流与准入 ------------------------------ */

const rateBuckets = new Map()

function checkRate(userId) {
  const limit = Number(cfg.aiRateLimit) > 0 ? Number(cfg.aiRateLimit) : 0
  if (!limit) return { ok: true }

  const now = Date.now()
  const windowMs = 60_000
  const bucket = (rateBuckets.get(userId) || []).filter(t => now - t < windowMs)

  if (bucket.length >= limit) {
    rateBuckets.set(userId, bucket)
    return { ok: false, retryAfter: Math.max(1, Math.ceil((windowMs - (now - bucket[0])) / 1000)) }
  }

  bucket.push(now)
  rateBuckets.set(userId, bucket)

  // 顺手清理过期桶，避免无限增长
  if (rateBuckets.size > 2000) {
    for (const [k, v] of rateBuckets) {
      if (!v.length || now - v[v.length - 1] > windowMs) rateBuckets.delete(k)
    }
  }
  return { ok: true }
}

function isAllowedUser(e) {
  if (cfg.aiRequireMaster === true) return e.isMaster === true
  const raw = String(cfg.aiWhitelist || "").trim()
  if (!raw) return true
  const list = raw.split(/[\s,，]+/).filter(Boolean)
  return list.includes("all") || list.includes(String(e.user_id))
}

/** 统一的 #ai / #ai流式 准入检查，通过返回 null，否则返回提示语 */
function guardAi(e) {
  if (!hasApiKey()) return "❌ 未配置 API Key（主人可发送 #ai设置 apiKey <你的Key>）"
  if (!isAllowedUser(e)) return "❌ 你不在 AI 使用白名单内"
  const rate = checkRate(e.user_id)
  if (!rate.ok) return `⏳ 请求过于频繁，请 ${rate.retryAfter} 秒后再试`
  return null
}

/* ------------------------------ 发送辅助 ------------------------------ */

function splitMessage(text, maxLen = 2500) {
  if (!text) return []
  const messages = []
  while (text.length > 0) {
    if (text.length <= maxLen) {
      messages.push(text)
      break
    }
    let splitAt = text.lastIndexOf("\n", maxLen)
    if (splitAt < maxLen * 0.3) splitAt = text.lastIndexOf(" ", maxLen)
    if (splitAt < maxLen * 0.3) splitAt = maxLen
    messages.push(text.slice(0, splitAt))
    text = text.slice(splitAt).replace(/^\n+/, "")
  }
  return messages
}

/**
 * 从文本中提取图片 URL，返回清理后的文本和 segment.image 数组
 * 支持：markdown 图片、独立行图片 URL、base64 图片
 * 内网/本机地址会被拒绝（防止模型诱导机器人请求内网资源）
 */
function extractImageUrls(text) {
  if (!text) return { cleanedText: "", images: [] }
  const images = []
  let cleaned = text

  const accept = url => {
    if (/^base:\/\//i.test(url) || /^base64:\/\//i.test(url) || /^data:image\//i.test(url)) {
      images.push(segment.image(url))
      return true
    }
    if (/^https?:\/\//i.test(url)) {
      if (isPrivateHost(url)) return false
      images.push(segment.image(url))
      return true
    }
    return false
  }

  // 1. Markdown 图片：![alt](url)
  cleaned = cleaned.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_, alt, url) => (accept(url.trim()) ? "" : _))

  // 2. 独立行的网络图片 URL（以图片扩展名结尾，可带 query 参数）
  cleaned = cleaned.replace(
    /(?:^|\n)\s*(https?:\/\/[^\s<>"']+)\s*(?:\n|$)/gi,
    (matched, url) => (IMAGE_EXT.test(url) && accept(url) ? "\n" : matched)
  )

  // 3. 独立行的 base64 图片
  cleaned = cleaned.replace(
    /(?:^|\n)\s*(base(?:64)?:\/\/[^\s<>"']+)\s*(?:\n|$)/gi,
    (matched, url) => (accept(url) ? "\n" : matched)
  )

  cleaned = cleaned.replace(/\n{3,}/g, "\n\n").trim()
  return { cleanedText: cleaned, images }
}

async function sendAsForward(e, title, text, images = []) {
  const parts = splitMessage(text)
  const hasImages = images && images.length > 0

  if (!hasImages && parts.length <= 1 && text.length <= 800) {
    return e.reply(text)
  }

  const forwardMsg = []
  if (title) forwardMsg.push({ message: title })
  for (const part of parts) forwardMsg.push({ message: part })
  for (const img of images) forwardMsg.push({ message: [img] })

  try {
    if (e?.group?.makeForwardMsg) {
      return await e.reply(await e.group.makeForwardMsg(forwardMsg))
    } else if (e?.friend?.makeForwardMsg) {
      return await e.reply(await e.friend.makeForwardMsg(forwardMsg))
    } else {
      return await e.reply(await Bot.makeForwardMsg(forwardMsg))
    }
  } catch {
    for (const part of parts) {
      await e.reply(part)
      if (parts.length > 1) await new Promise(r => setTimeout(r, 500))
    }
    for (const img of images) {
      await e.reply(img)
    }
  }
}

/* ------------------------------ 主插件 ------------------------------ */

export class AiAgent extends plugin {
  constructor() {
    super({
      name: "AI Agent",
      dsc: "AI 智能助手，支持对话、Agent模式、记忆管理",
      event: "message",
      priority: 1000,
      rule: [
        { reg: "^#ai\\s+(.+)", fnc: "chat" },
        { reg: "^#agent\\s+(.+)", fnc: "agent", permission: "master" },
        { reg: "^#ai流式\\s+(.+)", fnc: "streamChatCmd" },
        { reg: "^#aireset$", fnc: "resetAll", permission: "master" },
        { reg: "^#ai清除", fnc: "clearChat" },
        { reg: "^#ai历史", fnc: "showHistory" },
        { reg: "^#ai设置\\s+(.+)", fnc: "setConfig", permission: "master" },
        { reg: "^#ai配置", fnc: "showConfig", permission: "master" },
        { reg: "^#ai更新$", fnc: "updatePlugin", permission: "master" },
        { reg: "^#ai技能$", fnc: "listSkills" },
        { reg: "^#ai技能\\s+(\\S+)", fnc: "showSkillHelp" },
        { reg: "^#ai记忆", fnc: "showMemory" },
        { reg: "^#ai帮助", fnc: "showHelp" },
        // 审批应答（仅在确有挂起的审批时才接管，否则交回其它插件）
        { reg: "^(允许|拒绝)$", fnc: "approvalReply", permission: "master" },
        // 兜底：识别 #ai消息（漏了空格）并给出提示，放在最后避免抢占上面的指令
        { reg: "^#ai\\S", fnc: "usageHint" },
        { reg: "^#agent\\S", fnc: "usageHint" },
      ],
    })
  }

  async approvalReply(e) {
    const key = approvalKey(e)
    const pending = pendingApprovals.get(key)
    if (!pending) return false          // 没有待审批项：让其它插件处理这条消息

    pendingApprovals.delete(key)
    clearTimeout(pending.timer)
    const allowed = /允许|同意|approve|yes/i.test(String(e.msg || ""))
    pending.resolve(allowed ? "allowed-once" : "denied")
    await e.reply(allowed ? `✅ 已允许本次操作（${pending.tool}）` : `⛔ 已拒绝本次操作（${pending.tool}）`)
    return true
  }

  async usageHint(e) {
    const head = String(e.msg || "").slice(0, 12)
    await e.reply(`💡 指令需要空格分隔：${head} → 试试 \`#ai 你的问题\`\n发送 #ai帮助 查看全部用法`)
  }

  async chat(e) {
    const denied = guardAi(e)
    if (denied) return e.reply(denied)

    const userId = e.user_id
    const userMessage = e.msg.replace(/^#ai\s+/, "").trim()
    if (!userMessage && !e.img?.length) return e.reply("❌ 请输入内容: #ai <消息>")

    // #ai 支持并行：不检查 processing，直接执行
    try {
      const imageUrls = e.img || []
      const response = await agentCore.quickChat(userId, userMessage || "请描述这张图片", cfg.systemPrompt, imageUrls, e)
      const { cleanedText, images } = extractImageUrls(response)
      await sendAsForward(e, `🤖 AI 回复`, cleanedText, images)
    } catch (err) {
      await e.reply(`❌ AI 调用失败: ${err.message}`)
    }
  }

  async agent(e) {
    if (!hasApiKey()) return e.reply("❌ 未配置 API Key")
    if (agentRunning) return e.reply("⏳ Agent 正在执行任务中，请等待当前任务完成...")
    const userId = e.user_id
    const userMessage = e.msg.replace(/^#agent\s+/, "").trim()
    if (!userMessage && !e.img?.length) return e.reply("❌ 请输入任务: #agent <任务描述>")

    agentRunning = true
    const limitMs = Number(cfg.agentTaskTimeout) > 0 ? Number(cfg.agentTaskTimeout) : 300000
    agentWatchdog = setTimeout(() => { agentRunning = false }, limitMs)
    agentWatchdog.unref?.()

    try {
      await e.reply("🤖 Agent 开始执行...")
      const imageUrls = e.img || []
      const result = await agentCore.run(userId, e, userMessage || "请描述这张图片", cfg.agentSystemPrompt, imageUrls)
      await sendAsForward(e, `🤖 Agent 执行结果`, result.text, result.images)
    } catch (err) {
      await e.reply(`❌ Agent 执行失败: ${err.message}`)
    } finally {
      if (agentWatchdog) clearTimeout(agentWatchdog)
      agentWatchdog = null
      agentRunning = false
    }
  }

  async streamChatCmd(e) {
    const denied = guardAi(e)
    if (denied) return e.reply(denied)

    const userId = e.user_id
    const sessionKey = sessionKeyOf(e, userId)
    const userMessage = e.msg.replace(/^#ai流式\s+/, "").trim()
    if (!userMessage) return e.reply("❌ 请输入内容: #ai流式 <消息>")

    try {
      contextManager.initSession(sessionKey)
      const systemPrompt = await promptBuilder.build(userId, { personality: cfg.systemPrompt, event: e })

      // 支持用户发送的图片（多模态输入）——统一归一化成 API 可接受的格式
      const imageUrls = e.img?.length ? await toApiImageUrls(e.img) : []
      const content = imageUrls.length
        ? buildVisionContent(userMessage, imageUrls)
        : userMessage
      contextManager.addMessage(sessionKey, "user", content)
      contextManager.incrementTurn(sessionKey)

      const apiMessages = [{ role: "system", content: systemPrompt }, ...contextManager.getMessages(sessionKey)]
      let fullResponse = ""
      let chunk = ""
      let lastSendTime = Date.now()
      const interval = cfg.streamInterval || 1500
      const chunkSize = cfg.streamChunkSize || 500

      for await (const delta of streamChat(apiMessages)) {
        fullResponse += delta
        chunk += delta
        const now = Date.now()
        if (chunk.length >= chunkSize || now - lastSendTime >= interval) {
          await e.reply(chunk)
          chunk = ""
          lastSendTime = now
        }
      }
      if (chunk) await e.reply(chunk)

      const { cleanedText, images } = extractImageUrls(fullResponse)
      if (images.length) {
        for (const img of images) {
          await e.reply(img)
        }
      }
      contextManager.addMessage(sessionKey, "assistant", cleanedText)
    } catch (err) {
      await e.reply(`❌ 流式调用失败: ${err.message}`)
    }
  }

  async clearChat(e) {
    // 只清除当前会话（本群 / 本私聊），包括引擎的持久化会话日志
    const sessionKey = sessionKeyOf(e, e.user_id)
    await agentCore.clearSession(sessionKey)
    await e.reply("✅ 已清除当前会话的对话上下文（含 Agent 会话日志）")
  }

  async resetAll(e) {
    // 1. 清空所有会话（引擎 agent + 轻量上下文）
    const userCount = await agentCore.clearAllSessions()

    // 2. 丢弃内存缓存并重新从磁盘加载（先落盘，避免丢数据）
    await memoryManager.reload()
    await memoryManager.flush()

    // 3. 重新扫描技能
    skillRegistry.clear()
    await scanSkills()

    // 4. 只替换全局记忆里的「插件指令清单」段落，保留其他记忆（修：原先会整体覆盖）
    const catalog = skillRegistry.getFullSkillCatalog()
    let catalogUpdated = false
    if (catalog) {
      catalogUpdated = await memoryManager.upsertSkillCatalog(catalog)
    }

    const lines = [
      "🔄 AI Agent 已重置",
      "═".repeat(22),
      `✅ 已清空 ${userCount} 个会话的对话缓存`,
      `✅ 已重新从磁盘加载记忆（原有记忆保留）`,
      `✅ 已重新扫描 ${skillRegistry.getEnabled().length} 个插件技能`,
      catalogUpdated ? "✅ 已更新全局记忆中的插件指令清单" : "ℹ️ 未生成插件指令清单",
      "═".repeat(22),
      "Agent 已恢复到初始化状态",
    ]
    await e.reply(lines.join("\n"))
    logger.info(`[Agent] #aireset: 已清空 ${userCount} 个会话缓存，重新初始化完成`)
  }

  async showHistory(e) {
    const sessionKey = sessionKeyOf(e, e.user_id)
    const state = agentCore.getSessionState(sessionKey)

    // Agent 会话优先用引擎日志派生（DSH 风格：历史永远由日志派生）
    const engineMessages = agentCore.getEngineHistory(sessionKey, 40)
    const messages = engineMessages.length ? engineMessages : contextManager.getMessages(sessionKey)

    if (!messages.length) return e.reply("📭 暂无对话历史")

    const lines = []
    for (const msg of messages) {
      if (msg.role === "system") continue
      const role =
        msg.role === "user" ? "👤"
        : msg.role === "assistant" ? "🤖"
        : msg.role === "tool" ? "🔧"
        : "📋"
      const content = typeof msg.content === "string"
        ? msg.content.slice(0, 200).replace(/\n/g, " ")
        : "[多模态内容]"
      const toolInfo = msg.tool_calls
        ? ` [调用: ${msg.tool_calls.map(t => t.function?.name).join(", ")}]`
        : ""
      lines.push(`${role} ${content}${toolInfo}`)
    }

    const engineInfo = state.engine ? ` | 引擎 seq=${state.engine.seq}` : ""
    const header = `📜 对话历史 (${messages.length}条${engineInfo})`
    await sendAsForward(e, header, lines.join("\n"))
  }

  async setConfig(e) {
    const content = e.msg.replace(/^#ai设置\s+/, "").trim()
    const [key, ...valueParts] = content.split(/\s+/)
    const value = valueParts.join(" ")
    if (!key) return e.reply("❌ 格式: #ai设置 <key> <value>")

    const allowedKeys = [
      "apiKey", "apiUrl", "model",
      "agentApiKey", "agentApiUrl", "agentModel",
      "systemPrompt", "agentSystemPrompt", "personality",
      "maxHistoryPairs", "maxTokens", "agentMaxRounds", "maxContextTokens",
      "streamInterval", "streamChunkSize", "requestTimeout",
      "shellTimeout", "codeTimeout", "agentTaskTimeout", "maxSessions",
      "aiRateLimit", "aiWhitelist", "aiRequireMaster",
      "allowShell", "allowFileWrite", "allowFileDelete", "allowExecuteCode",
      "allowLocalFileImages",
      "toolApproval", "approvalTimeout", "maxParallelToolCalls", "contextWindow",
    ]
    if (!allowedKeys.includes(key)) {
      return e.reply(`❌ 未知配置项: ${key}\n可用: ${allowedKeys.join(", ")}`)
    }
    if (value === "" && !["aiWhitelist", "systemPrompt", "agentSystemPrompt", "personality"].includes(key)) {
      return e.reply(`❌ 请提供值，例如: #ai设置 ${key} <值>`)
    }

    try {
      // 类型校验与转换统一在 config.js 完成，非法值会抛错而不会写进配置
      saveConfig({ [key]: value })
    } catch (err) {
      return e.reply(`❌ ${err.message}`)
    }

    const masked = ["apiKey", "agentApiKey"].includes(key)
    const displayValue = masked ? maskSecret(cfg[key]) : cfg[key]
    await e.reply(`✅ 已设置 ${key} = ${displayValue}`)
  }

  async showConfig(e) {
    const lines = [
      "⚙️ AI Agent 配置",
      "═".repeat(20),
      "[对话模式]",
      `apiKey: ${getMaskedKey()}`,
      `apiUrl: ${cfg.apiUrl || "未设置"}`,
      `model: ${cfg.model || "未设置"}`,
      "[Agent 模式]",
      `agentApiKey: ${cfg.agentApiKey ? maskSecret(cfg.agentApiKey) : "未设置(回退 apiKey)"}`,
      `agentApiUrl: ${cfg.agentApiUrl || "未设置(回退 apiUrl)"}`,
      `agentModel: ${cfg.agentModel || "未设置(回退 model)"}`,
      "[行为]",
      `personality: ${(cfg.personality || "未设置").slice(0, 60)}`,
      `systemPrompt: ${(cfg.systemPrompt || "未设置").slice(0, 60)}`,
      `agentSystemPrompt: ${(cfg.agentSystemPrompt || "未设置").slice(0, 60)}`,
      `maxHistoryPairs: ${cfg.maxHistoryPairs ?? 20}`,
      `maxContextTokens: ${cfg.maxContextTokens ?? 64000}`,
      `agentMaxRounds: ${cfg.agentMaxRounds ?? 10}`,
      `maxSessions: ${cfg.maxSessions ?? 500}`,
      `streamInterval: ${cfg.streamInterval ?? 1500}`,
      `streamChunkSize: ${cfg.streamChunkSize ?? 500}`,
      `requestTimeout: ${cfg.requestTimeout ?? 60000}`,
      "[限制与安全]",
      `aiRateLimit: ${cfg.aiRateLimit ?? 10} 次/分钟/用户（0 = 不限）`,
      `aiWhitelist: ${cfg.aiWhitelist || "(空 = 所有人可用)"}`,
      `aiRequireMaster: ${cfg.aiRequireMaster === true}`,
      `allowShell: ${cfg.allowShell !== false}`,
      `allowFileWrite: ${cfg.allowFileWrite !== false}`,
      `allowFileDelete: ${cfg.allowFileDelete !== false}`,
      `allowExecuteCode: ${cfg.allowExecuteCode !== false}`,
      `allowLocalFileImages: ${cfg.allowLocalFileImages !== false}`,
      "[DSH 风格引擎]",
      `toolApproval: ${cfg.toolApproval === true}（高危工具需在聊天里确认）`,
      `approvalTimeout: ${cfg.approvalTimeout ?? 120000} ms`,
      `maxParallelToolCalls: ${cfg.maxParallelToolCalls ?? 10}`,
      `contextWindow: ${cfg.contextWindow ?? 128000}`,
    ]
    await e.reply(lines.join("\n"))
  }

  async updatePlugin(e) {
    const pluginDir = path.join(process.cwd(), "plugins/agent-plugin")
    await e.reply("⏳ 正在检查 agent-plugin 更新...")

    const run = cmd => new Promise(resolve => {
      exec(cmd, { cwd: pluginDir, shell: true, timeout: 30000, killSignal: "SIGKILL" }, (err, stdout, stderr) => {
        resolve({ err, out: `${stdout || ""}${stderr || ""}`.trim() })
      })
    })

    // 有未提交改动时不再自动 stash（原实现会丢改动/制造冲突）
    const status = await run("git status --porcelain")
    if (status.err && !status.out) {
      return e.reply(`❌ 更新失败: ${status.err.message}`)
    }
    if (status.out) {
      return e.reply(
        "⚠️ 插件目录存在未提交的改动，已跳过自动更新。\n" +
        "请先手动提交或备份后再执行 #ai更新：\n" +
        status.out.slice(0, 800)
      )
    }

    const before = (await run("git rev-parse --short HEAD")).out
    const pull = await run("git pull --ff-only")

    if (pull.err) {
      return e.reply(`❌ 更新失败（未做任何本地改动）: ${pull.err.message}\n${pull.out.slice(0, 500)}`)
    }

    const after = (await run("git rev-parse --short HEAD")).out
    if (before === after) {
      return e.reply(`✅ agent-plugin 已是最新版本 (${after})\n${pull.out.slice(0, 500)}`)
    }
    return e.reply(
      `✅ agent-plugin 已更新：${before} → ${after}\n` +
      "⚠️ 新代码需要重启机器人后才会生效\n" +
      pull.out.slice(0, 800)
    )
  }

  async listSkills(e) {
    await scanSkills()
    const skills = skillRegistry.getEnabled()
    if (!skills.length) return e.reply("📭 暂无可用技能")

    const lines = ["📦 可用技能列表", "═".repeat(22)]
    for (const skill of skills) {
      const cmdInfo = skill.commands?.length ? ` | 指令: ${skill.commands.slice(0, 3).join(", ")}` : ""
      lines.push(`• ${skill.name}${cmdInfo}`)
    }
    lines.push("═".repeat(22), `共 ${skills.length} 个技能`, "AI Agent 可自动调用这些技能")
    await e.reply(lines.join("\n"))
  }

  async showSkillHelp(e) {
    await scanSkills()
    const pluginName = e.msg.replace(/^#ai技能\s+/, "").trim()
    const skill = skillRegistry.get(pluginName)
    if (!skill) return e.reply(`❌ 未找到技能: ${pluginName}`)

    const lines = [`📦 技能: ${pluginName}`, "═".repeat(22)]
    if (skill.description) lines.push(`描述: ${skill.description}`)
    if (skill.commands?.length) lines.push(`指令:\n  ${skill.commands.join("\n  ")}`)
    lines.push(`路径: ${skill.path}`)
    lines.push(`状态: ${skill.enabled ? "✅ 启用" : "❌ 禁用"}`)
    await e.reply(lines.join("\n"))
  }

  async showMemory(e) {
    const userId = e.user_id
    const globalMemory = await memoryManager.getGlobalMemory()
    const userMemory = await memoryManager.getUserMemory(userId)

    const lines = ["🧠 记忆状态", "═".repeat(22)]
    lines.push(globalMemory ? `📌 全局记忆:\n${globalMemory.slice(0, 500)}` : "📌 全局记忆: (空)")
    lines.push("─".repeat(22))
    lines.push(userMemory ? `👤 用户记忆:\n${userMemory.slice(0, 500)}` : "👤 用户记忆: (空)")
    await sendAsForward(e, "🧠 记忆状态", lines.join("\n"))
  }

  async showHelp(e) {
    const disabled = Object.entries({
      shell: "allowShell",
      write_file: "allowFileWrite",
      delete_file: "allowFileDelete",
      execute_code: "allowExecuteCode",
    }).filter(([name]) => toolRegistry.isDisabledByPolicy(name)).map(([, key]) => key)

    const help = [
      "🤖 AI Agent 帮助",
      "═".repeat(22),
      "#ai <消息>         AI 对话",
      "#agent <任务>      Agent 模式（可调用工具，仅主人）",
      "#ai流式 <消息>     流式对话（逐段发送）",
      "#aireset           重置所有会话并重新初始化（仅主人）",
      "#ai清除            清除当前会话的对话上下文",
      "#ai历史            查看当前会话的对话历史",
      "#ai设置 <k> <v>    修改配置（仅主人）",
      "#ai配置            查看当前配置（仅主人）",
      "#ai更新            更新插件（仅主人）",
      "#ai技能            列出可用技能",
      "#ai技能 <名>       查看技能详情",
      "#ai记忆            查看持久记忆",
      "═".repeat(22),
      "⚙️ 常用设置项:",
      "apiKey, apiUrl, model (对话)",
      "agentApiKey, agentApiUrl, agentModel (Agent)",
      "aiRateLimit, aiWhitelist, aiRequireMaster (准入)",
      "requestTimeout, maxContextTokens, maxSessions",
      "allowShell, allowFileWrite, allowFileDelete,",
      "allowExecuteCode, allowLocalFileImages (安全开关)",
      "═".repeat(22),
      "🤖 Agent 可用工具:",
      ...toolRegistry.getNames().map(n => `  • ${n}${toolRegistry.isDisabledByPolicy(n) ? " (已禁用)" : ""}`),
      ...(disabled.length ? ["", `⚠️ 当前被禁用的安全开关: ${disabled.join(", ")}`] : []),
      "═".repeat(22),
      "⚠️ #agent/#aireset/#ai设置/#ai配置/#ai更新 仅限主人使用",
    ]
    await sendAsForward(e, "🤖 AI Agent 帮助", help.join("\n"))
  }
}
