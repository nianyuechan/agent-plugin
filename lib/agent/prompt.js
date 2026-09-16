/**
 * 系统提示词装配（对齐 @deepseek-ai/dsh-system-prompt 的段落模型）
 *
 * 提示词 = 有序段落（section）渲染后用 "\n\n" 连接。
 * 每个段落有稳定 name 与 order；persona 前缀/后缀是两个特殊段落。
 * 段落文本是模板，`{{var}}` 在**渲染**时解析；未注册的变量直接报错（不静默留空）。
 */

export const PERSONA_PREFIX_SECTION = "deployment:persona-prefix"
export const PERSONA_SUFFIX_SECTION = "deployment:persona-suffix"

const ORDER = {
  [PERSONA_PREFIX_SECTION]: 0,
  identity: 5,
  runtime: 10,
  memory: 20,
  skills: 30,
  tools: 40,
  instructions: 50,
  [PERSONA_SUFFIX_SECTION]: 90,
}

/** 段落文本用 "\n\n" 连接（与 DSH 的 joinContextSections 一致） */
export function joinContextSections(sections) {
  return sections.map(s => s.text).filter(text => text && text.length > 0).join("\n\n")
}

export function interpolate(template, variables, kind = "section") {
  return String(template).replace(/\{\{([^}]+)\}\}/g, (raw, name) => {
    const key = name.trim()
    if (!(key in variables)) {
      throw new Error(`unknown prompt variable "{{${key}}}" in ${kind}; registered: ${Object.keys(variables).join(", ") || "(none)"}`)
    }
    const value = variables[key]
    return typeof value === "function" ? String(value()) : String(value)
  })
}

export class SystemPrompt {
  constructor() {
    this._sections = new Map()
    this._variables = new Map()
    this._persona = { prefix: "", suffix: "", complete: false, includeRuntimeContext: true }
  }

  registerSection({ name, text, order, runtime = false }) {
    if (!name || typeof text !== "string") throw new Error("段落需要 name 与非空 text")
    this._sections.set(name, { name, text, runtime, order: order ?? ORDER[name] ?? 60 })
    return () => this._sections.delete(name)
  }

  removeSection(name) {
    this._sections.delete(name)
  }

  registerVariable(name, value) {
    this._variables.set(name, value)
    return () => this._variables.delete(name)
  }

  /** 遮蔽或替换该 agent 的身份 */
  setPersona({ prefix = "", suffix = "", complete = false, includeRuntimeContext = true } = {}) {
    this._persona = { prefix, suffix, complete, includeRuntimeContext }
    return this
  }

  /**
   * 把组装结果渲染成最终系统提示词。
   * - complete: true → 只有 persona 前缀生效（身份、工具引导都无法再追加文本）
   * - includeRuntimeContext: false → 丢弃所有 runtime 段落
   */
  render(variables = {}) {
    const vars = Object.fromEntries(this._variables)
    for (const [k, v] of Object.entries(variables)) vars[k] = v

    let sections = [...this._sections.values()]
    if (!this._persona.includeRuntimeContext) sections = sections.filter(s => !s.runtime)
    sections.sort((a, b) => a.order - b.order)

    const active = []
    if (this._persona.prefix) {
      active.push({ name: PERSONA_PREFIX_SECTION, text: interpolate(this._persona.prefix, vars, "persona prefix") })
    }
    if (!this._persona.complete) {
      active.push(...sections)
      if (this._persona.suffix) {
        active.push({ name: PERSONA_SUFFIX_SECTION, text: interpolate(this._persona.suffix, vars, "persona suffix") })
      }
    }

    const rendered = active.map(section => ({
      name: section.name,
      text: interpolate(section.text, vars, `section "${section.name}"`),
    }))

    const completeCount = rendered.filter(s => s.name === PERSONA_PREFIX_SECTION).length
    if (this._persona.complete && completeCount > 1) {
      throw new Error("multiple complete prompt sections are active")
    }

    return joinContextSections(rendered)
  }

  sectionNames() {
    return [...this._sections.keys()]
  }
}

/** 便捷构造：按 DSH 默认顺序注册一组段落 */
export function buildDefaultPrompt({ persona, runtime, memory, skills, tools, instructions } = {}) {
  const prompt = new SystemPrompt()
  prompt.setPersona(persona || {})
  if (runtime) prompt.registerSection({ name: "runtime", text: runtime, runtime: true })
  if (memory) prompt.registerSection({ name: "memory", text: memory, runtime: true })
  if (skills) prompt.registerSection({ name: "skills", text: skills })
  if (tools) prompt.registerSection({ name: "tools", text: tools })
  if (instructions) prompt.registerSection({ name: "instructions", text: instructions })
  return prompt
}
