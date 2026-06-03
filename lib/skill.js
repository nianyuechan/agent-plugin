import fs from "node:fs/promises"
import path from "node:path"

const skillCache = {
  skills: new Map(),
  lastScan: 0,
  ttl: 60000 // 60秒缓存
}

/**
 * Skill 配置
 * 每个 skill 对应 plugins 目录下的一个插件
 */
const skillConfig = {
  // 插件名: { enabled: true, prefix: "#", helpCmd: "#帮助" }
}

/**
 * 扫描 plugins 目录获取可用 skill
 */
export async function scanPlugins() {
  const now = Date.now()
  if (skillCache.skills.size > 0 && now - skillCache.lastScan < skillCache.ttl) {
    return skillCache.skills
  }

  const pluginsDir = path.join(process.cwd(), "plugins")
  skillCache.skills.clear()

  try {
    const entries = await fs.readdir(pluginsDir, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const pluginName = entry.name
      const pluginPath = path.join(pluginsDir, pluginName)

      // 跳过 agent-plugin 自身
      if (pluginName === "agent-plugin") continue

      // 检查插件是否有效（有 index.js 或 apps/ 目录）
      const hasIndex = await fileExists(path.join(pluginPath, "index.js"))
      const hasApps = await fileExists(path.join(pluginPath, "apps"))

      if (hasIndex || hasApps) {
        const skill = {
          name: pluginName,
          path: pluginPath,
          enabled: skillConfig[pluginName]?.enabled !== false,
          prefix: skillConfig[pluginName]?.prefix || "#",
          commands: []
        }

        // 尝试获取插件帮助信息
        if (skillConfig[pluginName]?.helpCmd) {
          skill.helpCmd = skillConfig[pluginName].helpCmd
        }

        skillCache.skills.set(pluginName, skill)
      }
    }
  } catch (err) {
    console.error("[Skill] 扫描插件失败:", err.message)
  }

  skillCache.lastScan = now
  return skillCache.skills
}

/**
 * 获取所有可用 skill
 */
export async function getSkills() {
  const skills = await scanPlugins()
  return Array.from(skills.values()).filter(s => s.enabled)
}

/**
 * 获取指定插件的 skill 信息
 */
export async function getSkill(pluginName) {
  const skills = await scanPlugins()
  return skills.get(pluginName)
}

/**
 * 执行 skill（通过 Yunzai 虚拟事件）
 */
export async function executeSkill(pluginName, command, e) {
  const skill = await getSkill(pluginName)
  if (!skill) {
    return `未找到 skill: ${pluginName}`
  }

  if (!skill.enabled) {
    return `skill ${pluginName} 已禁用`
  }

  // 构造完整的命令
  const fullCommand = command.startsWith(skill.prefix)
    ? command
    : `${skill.prefix}${command}`

  // 使用已有的 executeYunzai 逻辑
  return await executeYunzaiCommand(fullCommand, e)
}

/**
 * 列出所有可用 skill
 */
export async function listSkills() {
  const skills = await getSkills()
  if (skills.length === 0) {
    return "暂无可用 skill"
  }

  const lines = ["📦 可用 Skill 列表", "═".repeat(22)]
  for (const skill of skills) {
    lines.push(`• ${skill.name}`)
  }
  lines.push("═".repeat(22), "使用 <skill>插件名 命令</skill> 调用")

  return lines.join("\n")
}

/**
 * 获取 skill 详细帮助
 */
export async function getSkillHelp(pluginName) {
  const skill = await getSkill(pluginName)
  if (!skill) {
    return `未找到 skill: ${pluginName}`
  }

  const lines = [`📦 Skill: ${pluginName}`, "═".repeat(22)]

  // 尝试获取插件帮助
  if (skill.helpCmd) {
    const helpResult = await executeYunzaiCommand(skill.helpCmd, null)
    if (helpResult && !helpResult.includes("执行失败")) {
      lines.push(helpResult)
    }
  } else {
    lines.push("路径: " + skill.path)
    lines.push("前缀: " + skill.prefix)
  }

  return lines.join("\n")
}

/**
 * 内部: 执行 Yunzai 命令
 */
async function executeYunzaiCommand(command, e) {
  try {
    const replies = []
    const fakeEvent = {
      message: [{ type: "text", text: command }],
      raw_message: command,
      msg: command,
      user_id: e?.user_id || 0,
      self_id: e?.self_id || 0,
      sender: e?.sender || { user_id: 0, nickname: "Agent" },
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
      logText: `[Skill:${command}]`,
      friend: e?.friend || null,
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
    return `Skill 执行失败: ${err.message}`
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

async function fileExists(filePath) {
  try {
    await fs.access(filePath)
    return true
  } catch {
    return false
  }
}

/**
 * 清除 skill 缓存
 */
export function clearSkillCache() {
  skillCache.skills.clear()
  skillCache.lastScan = 0
}

export default {
  getSkills,
  getSkill,
  executeSkill,
  listSkills,
  getSkillHelp,
  clearSkillCache
}
