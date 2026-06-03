import { exec } from "node:child_process"
import fs from "node:fs/promises"
import path from "node:path"
import { chatCompletion } from "../lib/api.js"
import cfg from "../lib/config.js"
import { addMessage, buildContext } from "../lib/history.js"

const TAG_REGEX = /<(cmd|yunzai|read|readdir|done)>([\s\S]*?)<\/\1>/g

function parseActions(text) {
  const actions = []
  let match
  while ((match = TAG_REGEX.exec(text)) !== null) {
    actions.push({ type: match[1], content: match[2].trim() })
  }
  return actions
}

function stripTags(text) {
  return text.replace(TAG_REGEX, "").trim()
}

async function executeAction(action, e) {
  switch (action.type) {
    case "cmd":
      return await executeCommand(action.content, e)
    case "yunzai":
      return await executeYunzai(action.content, e)
    case "read":
      return await readFile(action.content)
    case "readdir":
      return await readDir(action.content)
    case "done":
      return null
    default:
      return `未知操作: ${action.type}`
  }
}

async function executeCommand(cmd, e) {
  return new Promise(resolve => {
    const cwd = process.cwd()
    const timeout = setTimeout(() => resolve("命令超时（30秒）"), 30000)
    exec(cmd, { cwd, maxBuffer: 1024 * 1024, shell: true }, (err, stdout, stderr) => {
      clearTimeout(timeout)
      let result = ""
      if (stdout) result += stdout
      if (stderr) result += (result ? "\n" : "") + stderr
      if (err && !result) result = `退出码: ${err.code}`
      resolve(result.slice(0, 8000) || "(无输出)")
    })
  })
}

async function executeYunzai(command, e) {
  try {
    const replies = []
    const fakeEvent = {
      message: [{ type: "text", text: command }],
      raw_message: command,
      msg: command,
      user_id: e.user_id,
      self_id: e.self_id,
      sender: { ...e.sender },
      message_type: "private",
      post_type: "message",
      sub_type: "friend",
      isPrivate: true,
      isGroup: false,
      isMaster: true,
      atBot: true,
      hasAlias: true,
      only_reply_at: true,
      img: [],
      logText: `[Agent]`,
      friend: e.friend || null,
      group: null,
      group_id: undefined,
      group_name: undefined,
      reply: async msg => {
        if (!msg) return
        const text = extractText(msg)
        if (text) replies.push(text)
        return { message_id: Date.now() }
      },
    }

    const PluginsLoader = (await import("../../lib/plugins/loader.js")).default
    await PluginsLoader.deal(fakeEvent)

    if (!replies.length) return "(插件无回复)"
    return replies.join("\n").slice(0, 8000)
  } catch (err) {
    return `Yunzai 命令执行失败: ${err.message}`
  }
}

function extractText(msg) {
  if (typeof msg === "string") return msg
  if (Array.isArray(msg)) {
    return msg
      .map(item => {
        if (typeof item === "string") return item
        if (item?.type === "text") return item.text
        if (item?.type === "at") return `@${item.qq || item.user_id || ""}`
        if (item?.type === "image") return "[图片]"
        if (item?.type === "face") return "[表情]"
        if (item?.type === "reply") return ""
        return item?.text || item?.data?.text || ""
      })
      .filter(Boolean)
      .join("")
  }
  if (msg?.type === "text") return msg.text
  if (msg?.type === "image") return "[图片]"
  if (msg?.text) return msg.text
  return String(msg)
}

async function readFile(filePath) {
  try {
    const resolved = path.resolve(filePath)
    const stat = await fs.stat(resolved)
    if (stat.size > 512 * 1024) return `文件过大: ${stat.size} 字节`
    const content = await fs.readFile(resolved, "utf8")
    return content.slice(0, 8000)
  } catch (err) {
    return `读取失败: ${err.message}`
  }
}

async function readDir(dirPath) {
  try {
    const resolved = path.resolve(dirPath)
    const entries = await fs.readdir(resolved, { withFileTypes: true })
    const lines = []
    for (const entry of entries.slice(0, 200)) {
      const icon = entry.isDirectory() ? "📁" : entry.isFile() ? "📄" : "🔗"
      let size = ""
      if (entry.isFile()) {
        try {
          const stat = await fs.stat(path.join(resolved, entry.name))
          size = ` (${formatSize(stat.size)})`
        } catch {}
      }
      lines.push(`${icon} ${entry.name}${size}`)
    }
    return lines.join("\n") || "(空目录)"
  } catch (err) {
    return `列目录失败: ${err.message}`
  }
}

function formatSize(bytes) {
  if (bytes === 0) return "0B"
  const units = ["B", "KB", "MB", "GB"]
  const i = Math.floor(Math.log(bytes) / Math.log(1024))
  return (bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0) + units[i]
}

export async function runAgent(e, userMessage, systemPrompt) {
  const userId = e.user_id
  addMessage(userId, "user", userMessage)

  const maxRounds = cfg.agentMaxRounds || 10
  const allResponses = []

  for (let round = 0; round < maxRounds; round++) {
    const messages = buildContext(userId, systemPrompt)
    let response
    try {
      response = await chatCompletion(messages)
    } catch (err) {
      const errMsg = `API 调用失败: ${err.message}`
      allResponses.push(errMsg)
      break
    }

    const actions = parseActions(response)
    const textPart = stripTags(response)

    if (!actions.length || actions.every(a => a.type === "done")) {
      if (textPart) allResponses.push(textPart)
      addMessage(userId, "assistant", response)
      break
    }

    if (textPart) allResponses.push(textPart)

    let observation = ""
    for (const action of actions) {
      if (action.type === "done") {
        addMessage(userId, "assistant", response)
        return allResponses.join("\n")
      }
      const result = await executeAction(action, e)
      observation += `[${action.type}] ${action.content}\n→ ${result}\n\n`
    }

    addMessage(userId, "assistant", response)
    addMessage(userId, "user", `操作结果:\n${observation.trim()}`)
  }

  return allResponses.join("\n") || "Agent 执行完毕"
}
