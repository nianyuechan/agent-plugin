class ToolRegistry {
  constructor() {
    this._tools = new Map()
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

  getOpenAITools() {
    return this.getAll()
      .filter(t => t.enabled !== false)
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
    const tools = this.getAll().filter(t => t.enabled !== false)
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

    try {
      const result = await tool.handler(args, context)
      return result
    } catch (err) {
      return { error: `${name} 执行失败: ${err.message}` }
    }
  }
}

export const toolRegistry = new ToolRegistry()
export default toolRegistry
