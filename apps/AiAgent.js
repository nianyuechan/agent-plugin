import cfg, { hasApiKey, getMaskedKey, saveConfig } from "../lib/config.js"
import { chatCompletion, streamChat } from "../lib/api.js"
import agentCore from "../lib/core/agent.js"
import contextManager from "../lib/core/context.js"
import promptBuilder from "../lib/core/prompt.js"
import memoryManager from "../lib/memory/manager.js"
import skillRegistry from "../lib/skills/registry.js"
import { scanSkills } from "../lib/skills/loader.js"
import toolRegistry from "../lib/tools/registry.js"

// 注册所有内置工具（自注册模式）
import "../lib/tools/builtin/cmd.js"
import "../lib/tools/builtin/yunzai.js"
import "../lib/tools/builtin/file.js"
import "../lib/tools/builtin/code.js"
import "../lib/tools/builtin/memory.js"

import { exec } from "node:child_process"
import path from "node:path"

const processing = new Set()

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

async function sendMultiMsg(e, parts) {
  for (const part of parts) {
    await e.reply(part)
    if (parts.length > 1) await new Promise(r => setTimeout(r, 500))
  }
}

export class AiAgent extends plugin {
  constructor() {
    super({
      name: "AI Agent",
      dsc: "AI 智能助手，支持对话、Agent模式、记忆管理",
      event: "message",
      priority: 1000,
      rule: [
        { reg: "^#ai\\s+(.+)", fnc: "chat", permission: "master" },
        { reg: "^#agent\\s+(.+)", fnc: "agent", permission: "master" },
        { reg: "^#ai流式\\s+(.+)", fnc: "streamChatCmd", permission: "master" },
        { reg: "^#ai清除", fnc: "clearChat", permission: "master" },
        { reg: "^#ai历史", fnc: "showHistory", permission: "master" },
        { reg: "^#ai设置\\s+(.+)", fnc: "setConfig", permission: "master" },
        { reg: "^#ai配置", fnc: "showConfig", permission: "master" },
        { reg: "^#ai更新$", fnc: "updatePlugin", permission: "master" },
        { reg: "^#ai技能$", fnc: "listSkills", permission: "master" },
        { reg: "^#ai技能\\s+(\\S+)", fnc: "showSkillHelp", permission: "master" },
        { reg: "^#ai记忆", fnc: "showMemory", permission: "master" },
        { reg: "^#ai帮助", fnc: "showHelp", permission: "master" },
      ],
    })
  }

  async chat(e) {
    if (!hasApiKey()) return e.reply("❌ 未配置 API Key")
    const userId = e.user_id
    if (processing.has(userId)) return e.reply("⏳ 正在处理中，请稍候...")
    const userMessage = e.msg.replace(/^#ai\s+/, "").trim()
    if (!userMessage) return e.reply("❌ 请输入内容: #ai <消息>")

    processing.add(userId)
    try {
      const response = await agentCore.quickChat(userId, userMessage, cfg.systemPrompt)
      const parts = splitMessage(response)
      await sendMultiMsg(e, parts)
    } catch (err) {
      await e.reply(`❌ AI 调用失败: ${err.message}`)
    } finally {
      processing.delete(userId)
    }
  }

  async agent(e) {
    if (!hasApiKey()) return e.reply("❌ 未配置 API Key")
    const userId = e.user_id
    if (processing.has(userId)) return e.reply("⏳ 正在处理中，请稍候...")
    const userMessage = e.msg.replace(/^#agent\s+/, "").trim()
    if (!userMessage) return e.reply("❌ 请输入任务: #agent <任务描述>")

    processing.add(userId)
    try {
      await e.reply("🤖 Agent 开始执行...")
      const result = await agentCore.run(userId, e, userMessage, cfg.agentSystemPrompt)
      const parts = splitMessage(result)
      await sendMultiMsg(e, parts)
    } catch (err) {
      await e.reply(`❌ Agent 执行失败: ${err.message}`)
    } finally {
      processing.delete(userId)
    }
  }

  async streamChatCmd(e) {
    if (!hasApiKey()) return e.reply("❌ 未配置 API Key")
    const userId = e.user_id
    if (processing.has(userId)) return e.reply("⏳ 正在处理中，请稍候...")
    const userMessage = e.msg.replace(/^#ai流式\s+/, "").trim()
    if (!userMessage) return e.reply("❌ 请输入内容: #ai流式 <消息>")

    processing.add(userId)
    try {
      contextManager.initSession(userId)
      const systemPrompt = await promptBuilder.build(userId, { personality: cfg.systemPrompt })
      contextManager.addMessage(userId, "user", userMessage)

      const apiMessages = [{ role: "system", content: systemPrompt }, ...contextManager.getMessages(userId)]
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
      contextManager.addMessage(userId, "assistant", fullResponse)
    } catch (err) {
      await e.reply(`❌ 流式调用失败: ${err.message}`)
    } finally {
      processing.delete(userId)
    }
  }

  async clearChat(e) {
    const userId = e.user_id
    agentCore.clearSession(userId)
    contextManager.clear(userId)
    await e.reply("✅ 已清除对话历史和上下文")
  }

  async showHistory(e) {
    const userId = e.user_id
    const state = agentCore.getSessionState(userId)
    const messages = contextManager.getMessages(userId)

    if (!messages.length) return e.reply("📭 暂无对话历史")

    const lines = []
    for (const msg of messages) {
      if (msg.role === "system") continue
      const role =
        msg.role === "user" ? "👤"
        : msg.role === "assistant" ? "🤖"
        : msg.role === "tool" ? "🔧"
        : "📋"
      const content = String(msg.content || "").slice(0, 200).replace(/\n/g, " ")
      const toolInfo = msg.tool_calls
        ? ` [调用: ${msg.tool_calls.map(t => t.function?.name).join(", ")}]`
        : ""
      lines.push(`${role} ${content}${toolInfo}`)
    }

    const header = `📜 对话历史 (${state.messageCount}条, ~${state.estimatedTokens} tokens${state.compressed ? ", 已压缩" : ""})\n${"─".repeat(24)}`
    const result = splitMessage(lines.join("\n"), 2500)
    if (result.length <= 1) {
      await e.reply(`${header}\n${lines.join("\n")}`)
    } else {
      result[0] = `${header}\n${result[0]}`
      await sendMultiMsg(e, result)
    }
  }

  async setConfig(e) {
    const content = e.msg.replace(/^#ai设置\s+/, "").trim()
    const [key, ...valueParts] = content.split(/\s+/)
    const value = valueParts.join(" ")
    if (!key) return e.reply("❌ 格式: #ai设置 <key> <value>")

    const allowedKeys = [
      "apiKey", "apiUrl", "model",
      "systemPrompt", "agentSystemPrompt",
      "maxHistoryPairs", "maxTokens", "agentMaxRounds",
      "streamInterval", "streamChunkSize",
      "personality",
    ]
    if (!allowedKeys.includes(key)) return e.reply(`❌ 未知配置项: ${key}\n可用: ${allowedKeys.join(", ")}`)

    const saveValue = [
      "maxHistoryPairs", "maxTokens", "agentMaxRounds",
      "streamInterval", "streamChunkSize",
    ].includes(key) ? Number(value) : value

    saveConfig({ [key]: saveValue })
    const displayValue = key === "apiKey" ? getMaskedKey() : saveValue
    await e.reply(`✅ 已设置 ${key} = ${displayValue}`)
  }

  async showConfig(e) {
    const lines = [
      "⚙️ AI Agent 配置",
      "═".repeat(20),
      `apiKey: ${getMaskedKey()}`,
      `apiUrl: ${cfg.apiUrl || "未设置"}`,
      `model: ${cfg.model || "未设置"}`,
      `personality: ${(cfg.personality || "未设置").slice(0, 60)}...`,
      `systemPrompt: ${(cfg.systemPrompt || "未设置").slice(0, 60)}...`,
      `agentSystemPrompt: ${(cfg.agentSystemPrompt || "未设置").slice(0, 60)}...`,
      `maxHistoryPairs: ${cfg.maxHistoryPairs || 20}`,
      `maxTokens: ${cfg.maxTokens || 900000}`,
      `agentMaxRounds: ${cfg.agentMaxRounds || 10}`,
      `streamInterval: ${cfg.streamInterval || 1500}`,
      `streamChunkSize: ${cfg.streamChunkSize || 500}`,
    ]
    await e.reply(lines.join("\n"))
  }

  async updatePlugin(e) {
    const pluginDir = path.join(process.cwd(), "plugins/agent-plugin")
    await e.reply("⏳ 正在更新 agent-plugin...")
    exec("git pull", { cwd: pluginDir }, (err, stdout, stderr) => {
      if (err) {
        e.reply(`❌ 更新失败: ${err.message}`)
        return
      }
      const output = (stdout || "").trim()
      if (output === "Already up to date.") {
        e.reply("✅ agent-plugin 已是最新版本")
      } else {
        e.reply(`✅ agent-plugin 更新成功\n${output}`)
      }
    })
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
    if (globalMemory) {
      lines.push("📌 全局记忆:", globalMemory.slice(0, 500))
    } else {
      lines.push("📌 全局记忆: (空)")
    }
    lines.push("─".repeat(22))
    if (userMemory) {
      lines.push("👤 用户记忆:", userMemory.slice(0, 500))
    } else {
      lines.push("👤 用户记忆: (空)")
    }
    await sendMultiMsg(e, splitMessage(lines.join("\n"), 2500))
  }

  async showHelp(e) {
    const help = [
      "🤖 AI Agent 帮助",
      "═".repeat(22),
      "#ai <消息>         AI 对话",
      "#agent <任务>      Agent 模式（可调用工具）",
      "#ai流式 <消息>     流式对话（逐段发送）",
      "#ai清除            清除对话历史",
      "#ai历史            查看对话历史",
      "#ai设置 <k> <v>    修改配置",
      "#ai配置            查看当前配置",
      "#ai更新            更新插件",
      "#ai技能            列出可用技能",
      "#ai技能 <名>       查看技能详情",
      "#ai记忆            查看持久记忆",
      "═".repeat(22),
      "⚙️ 可设置项:",
      "apiKey, apiUrl, model,",
      "systemPrompt, agentSystemPrompt,",
      "personality,",
      "maxHistoryPairs, maxTokens,",
      "agentMaxRounds,",
      "streamInterval, streamChunkSize",
      "═".repeat(22),
      "🤖 Agent 模式可用工具:",
      ...toolRegistry.getNames().map(n => `  • ${n}`),
      "═".repeat(22),
      "⚠️ 仅限主人使用",
    ]
    await sendMultiMsg(e, help)
  }
}
