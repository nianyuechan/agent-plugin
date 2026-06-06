import memoryManager from "../memory/manager.js"
import skillRegistry from "../skills/registry.js"
import toolRegistry from "../tools/registry.js"

class PromptBuilder {
  constructor() {
    this._personality = ""
    this._customInstructions = ""
  }

  setPersonality(text) {
    this._personality = text
  }

  setCustomInstructions(text) {
    this._customInstructions = text
  }

  /**
   * 构建完整的系统提示词
   * 对齐 Hermes 的 prompt_builder: personality → memory → skills → tools → instructions
   */
  async build(userId, overrides = {}) {
    const sections = []

    // 1. 人格/角色定义
    const personality = overrides.personality || this._personality
    if (personality) {
      sections.push(personality)
    }

    // 2. 系统环境信息
    sections.push(this._buildSystemInfo())

    // 3. 聊天上下文（群号、QQ号、@对象等）
    const chatContext = this._buildChatContext(overrides.event)
    if (chatContext) sections.push(chatContext)

    // 3. 记忆层
    const memory = await memoryManager.getGlobalMemory()
    const userMemory = await memoryManager.getUserMemory(userId)
    if (memory || userMemory) {
      const memParts = []
      if (memory) memParts.push("## 全局记忆\n" + memory.trim())
      if (userMemory) memParts.push("## 用户信息\n" + userMemory.trim())
      sections.push(memParts.join("\n\n"))
    }

    // 4. 可用工具
    const tools = toolRegistry.getAll().filter(t => t.enabled !== false)
    if (tools.length) {
      const toolSection = this._buildToolSection(tools)
      sections.push(toolSection)
    }

    // 5. 可用技能（Yunzai 插件）
    const skills = skillRegistry.getEnabled()
    if (skills.length) {
      const skillSection = this._buildSkillSection(skills)
      sections.push(skillSection)
    }

    // 6. 操作指令
    const instructions = overrides.instructions || this._customInstructions
    if (instructions) {
      sections.push(instructions)
    }

    return sections.join("\n\n---\n\n")
  }

  _buildSystemInfo() {
    const now = new Date()
    return [
      "## 系统信息",
      `- 当前时间: ${now.toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}`,
      `- 操作系统: Windows`,
      `- 运行环境: TRSS-Yunzai (QQ机器人)`,
      `- 当前目录: ${process.cwd()}`,
      `- 桌面路径: ${process.env.USERPROFILE || process.env.HOME}\\Desktop`,
    ].join("\n")
  }

  /**
   * 构建聊天上下文（群号、QQ号、@对象等）
   */
  _buildChatContext(event) {
    if (!event) return ""
    const lines = ["## 聊天上下文"]

    // 聊天类型
    if (event.isGroup) {
      lines.push(`- 聊天类型: 群聊`)
      const groupName = event.group_name || "未知群名"
      lines.push(`- 群号: ${event.group_id || "未知"}`)
      lines.push(`- 群名: ${groupName}`)
    } else if (event.isPrivate) {
      lines.push(`- 聊天类型: 私聊`)
    } else {
      lines.push(`- 聊天类型: 未知`)
    }

    // 发送者信息
    const senderName = event.sender?.card || event.sender?.nickname || "未知"
    lines.push(`- 发送者QQ: ${event.user_id || "未知"}`)
    lines.push(`- 发送者昵称: ${senderName}`)

    // 发送者身份
    if (event.member?.is_owner) {
      lines.push(`- 发送者身份: 👑群主`)
    } else if (event.member?.is_admin) {
      lines.push(`- 发送者身份: 🛡️管理员`)
    } else {
      lines.push(`- 发送者身份: 👤普通成员`)
    }

    // 机器人自身
    lines.push(`- 机器人QQ: ${event.self_id || "未知"}`)

    // 机器人身份
    if (event.group?.is_owner) {
      lines.push(`- 机器人身份: 👑群主`)
    } else if (event.group?.is_admin) {
      lines.push(`- 机器人身份: 🛡️管理员`)
    } else {
      lines.push(`- 机器人身份: 👤普通成员`)
    }

    // @对象
    if (event.at) {
      lines.push(`- 被@的用户QQ: ${event.at}`)
    }
    if (event.atBot) {
      lines.push(`- 机器人被@: 是`)
    }

    return lines.join("\n")
  }

  _buildToolSection(tools) {
    const lines = ["## 可用工具", ""]
    for (const tool of tools) {
      lines.push(`### ${tool.name}`)
      lines.push(`描述: ${tool.description || "无"}`)
      lines.push(`用法: ${tool.usage || ""}`)
      const params = tool.parameters?.properties
      if (params && Object.keys(params).length) {
        const paramList = Object.entries(params)
          .map(([k, v]) => `  - ${k}: ${v.description || v.type}`)
          .join("\n")
        lines.push(`参数:\n${paramList}`)
      }
      lines.push("")
    }
    return lines.join("\n")
  }

  _buildSkillSection(skills) {
    const lines = ["## 可用技能（Yunzai 插件指令）", ""]
    lines.push("使用 yunzai 工具调用以下技能的命令。插件指令以 # 开头。")
    lines.push("")
    for (const skill of skills) {
      lines.push(`- **${skill.name}**: ${skill.description || skill.helpText || "无描述"}`)
    }
    return lines.join("\n")
  }
}

export const promptBuilder = new PromptBuilder()
export default promptBuilder
