import cfg from "../config.js"

class ToolRegistry {
  constructor() {
    this._tools = new Map()
    // 危险工具 → 对应配置开关。开关显式设为 false 时工具不可用，
    // 未配置时保持原行为（可用），以便平滑升级。
    this._policyKeys = {
      shell: "allowShell",
      write_file: "allowFileWrite",
      delete_file: "allowFileDelete",
      execute_code: "allowExecuteCode",
    }
  }
  register(tool) {
    if (!tool.name || !tool.handler) {
      throw new Error("Tool must have name and handler")
    }
    this._tools.set(tool.name, tool)
  }

  get(name) {
    return this._tools.get(name)
  }

  has(name) {
    return this._tools.has(name)
  }

  getAll() {
    return Array.from(this._tools.values())
  }

  getNames() {
    return Array.from(this._tools.keys())
  }

  /** 该工具是否被配置禁用 */
  isDisabledByPolicy(name) {
    const key = this._policyKeys[name]
    if (!key) return false
    return cfg[key] === false
  }

  getOpenAITools() {
    return this.getAll()
      .filter(t => t.enabled !== false && !this.isDisabledByPolicy(t.name))
      .map(t => ({
        type: "function",
        function: {
          name: t.name,
          description: t.description || "",
          parameters: t.parameters || { type: "object", properties: {}, required: [] },
        },
      }))
  }

  getSystemPrompt() {
    const tools = this.getAll().filter(t => t.enabled !== false && !this.isDisabledByPolicy(t.name))
    if (!tools.length) return ""
    const lines = ["## 可用工具", ""]
    for (const tool of tools) {
      lines.push(`### ${tool.name}`)
      lines.push(`- 描述: ${tool.description || "无"}`)
      lines.push(`- 用法: ${tool.usage || ""}`)
      lines.push(`- 参数: ${JSON.stringify(tool.parameters?.properties || {})}`)
      lines.push("")
    }
    return lines.join("\n")
  }

  async execute(name, args, context) {
    const tool = this._tools.get(name)
    if (!tool) return { error: `未知工具: ${name}` }
    if (tool.enabled === false) return { error: `工具 ${name} 已禁用` }
    if (this.isDisabledByPolicy(name)) {
      return { error: `工具 ${name} 已被配置禁用（${this._policyKeys[name]} = false）` }
    }

    try {
      return await tool.handler(args, context)
    } catch (err) {
      return { error: `${name} 执行失败: ${err.message}` }
    }
  }
}

export const toolRegistry = new ToolRegistry()
export default toolRegistry
