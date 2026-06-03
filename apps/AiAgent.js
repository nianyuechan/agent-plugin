import cfg, { hasApiKey, getMaskedKey, saveConfig } from "../lib/config.js"
import { chatCompletion, streamChat } from "../lib/api.js"
import { getHistory, addMessage, clearHistory, buildContext } from "../lib/history.js"
import { runAgent } from "../lib/agent.js"
import { getSkills, getSkillHelp } from "../lib/skill.js"
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
      dsc: "AI 智能助手，支持对话和 Agent 模式",
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
        { reg: "^#ai帮助", fnc: "showHelp", permission: "master" },
      ],
    })
  }

  async chat(e) {
    if (!hasApiKey()) return e.reply("❌ 未配置 API Key，请使用 #ai设置 apiKey <key>")
    const userId = e.user_id
    if (processing.has(userId)) return e.reply("⏳ 正在处理中，请稍候...")
    const userMessage = e.msg.replace(/^#ai\s+/, "").trim()
    if (!userMessage) return e.reply("❌ 请输入内容: #ai <消息>")

    processing.add(userId)
    try {
      addMessage(userId, "user", userMessage)
      const messages = buildContext(userId, cfg.systemPrompt)
      const response = await chatCompletion(messages)
      addMessage(userId, "assistant", response)

      const TAG_REGEX = /<(cmd|yunzai|read|readdir|done)>([\s\S]*?)<\/\1>/g
      const hasTags = TAG_REGEX.test(response)
      TAG_REGEX.lastIndex = 0

      if (hasTags) {
        const result = await runAgent(e, null, null, response)
        const parts = splitMessage(result)
        await sendMultiMsg(e, parts)
      } else {
        const parts = splitMessage(response)
        await sendMultiMsg(e, parts)
      }
    } catch (err) {
      await e.reply(`❌ AI 调用失败: ${err.message}`)
    } finally {
      processing.delete(userId)
    }
  }

  async agent(e) {
    if (!hasApiKey()) return e.reply("❌ 未配置 API Key，请使用 #ai设置 apiKey <key>")
    const userId = e.user_id
    if (processing.has(userId)) return e.reply("⏳ 正在处理中，请稍候...")
    const userMessage = e.msg.replace(/^#agent\s+/, "").trim()
    if (!userMessage) return e.reply("❌ 请输入任务: #agent <任务描述>")

    processing.add(userId)
    try {
      await e.reply("🤖 Agent 开始执行...")
      const result = await runAgent(e, userMessage, cfg.agentSystemPrompt)
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
      addMessage(userId, "user", userMessage)
      const messages = buildContext(userId, cfg.systemPrompt)
      let fullResponse = ""
      let chunk = ""
      let lastSendTime = Date.now()
      const interval = cfg.streamInterval || 1500
      const chunkSize = cfg.streamChunkSize || 500

      for await (const delta of streamChat(messages)) {
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
      addMessage(userId, "assistant", fullResponse)
    } catch (err) {
      await e.reply(`❌ 流式调用失败: ${err.message}`)
    } finally {
      processing.delete(userId)
    }
  }

  async clearChat(e) {
    clearHistory(e.user_id)
    await e.reply("✅ 已清除对话历史")
  }

  async showHistory(e) {
    const history = getHistory(e.user_id)
    if (!history.length) return e.reply("📭 暂无对话历史")
    const lines = history.map((msg, i) => {
      const role = msg.role === "user" ? "👤" : msg.role === "assistant" ? "🤖" : "⚙️"
      const content = msg.content.slice(0, 200).replace(/\n/g, " ")
      return `${role} ${content}${msg.content.length > 200 ? "..." : ""}`
    })
    const header = `📜 对话历史 (${history.length} 条)\n${"─".repeat(24)}`
    const messages = splitMessage(lines.join("\n"), 2500)
    if (messages.length <= 1) {
      await e.reply(`${header}\n${lines.join("\n")}`)
    } else {
      messages[0] = `${header}\n${messages[0]}`
      await sendMultiMsg(e, messages)
    }
  }

  async setConfig(e) {
    const content = e.msg.replace(/^#ai设置\s+/, "").trim()
    const [key, ...valueParts] = content.split(/\s+/)
    const value = valueParts.join(" ")
    if (!key) return e.reply("❌ 格式: #ai设置 <key> <value>")

    const allowedKeys = [
      "apiKey",
      "apiUrl",
      "model",
      "systemPrompt",
      "agentSystemPrompt",
      "maxHistoryPairs",
      "maxTokens",
      "agentMaxRounds",
      "streamInterval",
      "streamChunkSize",
    ]
    if (!allowedKeys.includes(key)) return e.reply(`❌ 未知配置项: ${key}\n可用: ${allowedKeys.join(", ")}`)

    const saveValue = ["maxHistoryPairs", "maxTokens", "agentMaxRounds", "streamInterval", "streamChunkSize"].includes(
      key,
    )
      ? Number(value)
      : value
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
      `systemPrompt: ${(cfg.systemPrompt || "未设置").slice(0, 80)}...`,
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
    const skills = await getSkills()
    if (!skills.length) return e.reply("📭 暂无可用技能")

    const lines = ["📦 可用技能列表", "═".repeat(22)]
    for (const skill of skills) {
      lines.push(`• ${skill.name}`)
    }
    lines.push("═".repeat(22), "使用 #ai技能 <插件名> 查看详情")
    await e.reply(lines.join("\n"))
  }

  async showSkillHelp(e) {
    const pluginName = e.msg.replace(/^#ai技能\s+/, "").trim()
    const help = await getSkillHelp(pluginName)
    await e.reply(help)
  }

  async showHelp(e) {
    const help = [
      "🤖 AI Agent 帮助",
      "═".repeat(22),
      "#ai <消息>         AI 对话",
      "#ai流式 <消息>     流式对话（逐段发送）",
      "#agent <任务>      Agent 模式（可执行命令）",
      "#ai清除            清除对话历史",
      "#ai历史            查看对话历史",
      "#ai设置 <k> <v>    修改配置",
      "#ai配置            查看当前配置",
      "#ai更新            更新插件",
      "#ai技能            列出可用技能",
      "#ai技能 <名>       查看技能详情",
      "═".repeat(22),
      "⚙️ 可设置项:",
      "apiKey, apiUrl, model,",
      "systemPrompt, agentSystemPrompt,",
      "maxHistoryPairs, maxTokens,",
      "agentMaxRounds,",
      "streamInterval, streamChunkSize",
      "═".repeat(22),
      "⚠️ 仅限主人使用",
    ]
    await sendMultiMsg(e, help)
  }
}
