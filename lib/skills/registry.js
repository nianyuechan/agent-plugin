class SkillRegistry {
  constructor() {
    this._skills = new Map()
    this._lastScan = 0
    this._scanTTL = 60000
  }

  register(name, skill) {
    this._skills.set(name, {
      name,
      ...skill,
      registeredAt: Date.now(),
    })
  }

  get(name) {
    return this._skills.get(name)
  }

  has(name) {
    return this._skills.has(name)
  }

  getAll() {
    return Array.from(this._skills.values())
  }

  getEnabled() {
    return Array.from(this._skills.values()).filter(s => s.enabled !== false)
  }

  getNames() {
    return Array.from(this._skills.keys())
  }

  enable(name) {
    const skill = this._skills.get(name)
    if (skill) skill.enabled = true
  }

  disable(name) {
    const skill = this._skills.get(name)
    if (skill) skill.enabled = false
  }

  remove(name) {
    this._skills.delete(name)
  }

  clear() {
    this._skills.clear()
    this._lastScan = 0
  }

  get lastScan() {
    return this._lastScan
  }

  set lastScan(val) {
    this._lastScan = val
  }

  get scanTTL() {
    return this._scanTTL
  }

  getSkillPrompt() {
    const skills = this.getEnabled()
    if (!skills.length) return ""

    const lines = ["## 可用技能（Yunzai 插件）", ""]
    lines.push("这些是已安装的 Yunzai 插件，通过 yunzai 工具调用它们的指令。")
    lines.push("")

    for (const skill of skills) {
      lines.push(`### ${skill.name}`)
      if (skill.description) lines.push(`- 描述: ${skill.description}`)
      if (skill.commands && skill.commands.length) {
        lines.push(`- 常用指令: ${skill.commands.join(", ")}`)
      }
      lines.push("")
    }

    return lines.join("\n")
  }

  /**
   * 生成完整的插件指令清单文本，用于存入全局记忆
   */
  getFullSkillCatalog() {
    const skills = this.getAll()
    if (!skills.length) return ""

    const lines = ["【已安装插件及指令清单】", ""]
    for (const skill of skills) {
      lines.push(`■ ${skill.name}`)
      if (skill.description) lines.push(`  描述: ${skill.description}`)
      if (skill.commands && skill.commands.length) {
        lines.push(`  指令:`)
        for (const cmd of skill.commands) {
          lines.push(`    ${cmd}`)
        }
      }
      lines.push("")
    }
    lines.push(`共 ${skills.length} 个插件`)
    return lines.join("\n")
  }
}

export const skillRegistry = new SkillRegistry()
export default skillRegistry
