/**
 * DSH 风格工具契约（对应 @deepseek-ai/dsh-tools 的 defineTool + JSON Schema 协议）。
 *
 * 参数声明支持两种写法：
 * 1. 声明式 DSL（DSH 风格，作者友好）：
 *      parameters: { path: { type: 'string', required: true, description: '文件路径' } }
 * 2. 原始 JSON Schema（协议级，便于和其它 agent/子代理共享 schema）：
 *      parameters: { type: 'object', properties: {...}, required: [...] }
 *
 * 约定（与 DSH 一致）：
 * - 参数在执行前校验，非法输入变成**普通错误结果**而不是抛异常
 * - execute(args, exec) 中 exec.signal 是可取消信号，exec.toolCallId / exec.agent 供实现使用
 * - 工具返回字符串，或返回 { content, isError } 结构化结果
 */

const DSL_TYPES = new Set(["string", "number", "integer", "boolean", "null", "array", "object", "json"])

function dslNodeToSchema(node) {
  if (node === null || typeof node !== "object") return { type: "string" }
  // 已是 JSON Schema 片段
  if (node.type && !DSL_TYPES.has(node.type)) return node
  if (node.type === "json") return {}                       // 任意 JSON
  if (node.oneOf) return { oneOf: node.oneOf.map(dslNodeToSchema) }
  if (node.type === "array") {
    return { type: "array", ...(node.items ? { items: dslNodeToSchema(node.items) } : {}), ...(node.description ? { description: node.description } : {}) }
  }
  if (node.type === "object" && node.properties) {
    return {
      type: "object",
      properties: Object.fromEntries(Object.entries(node.properties).map(([k, v]) => [k, dslNodeToSchema(v)])),
      ...(node.required ? { required: node.required } : {}),
      ...(node.description ? { description: node.description } : {}),
    }
  }
  const out = { type: node.type || "string" }
  if (node.description) out.description = node.description
  if (node.enum) out.enum = node.enum
  return out
}

/** 把 defineTool 的 parameters 归一化成 JSON Schema */
export function toJsonSchema(parameters) {
  if (!parameters) return { type: "object", properties: {} }
  // 原始 JSON Schema：顶层就是 object + properties
  if (parameters.type === "object" && parameters.properties) return parameters

  const properties = {}
  const required = []
  for (const [name, node] of Object.entries(parameters)) {
    properties[name] = dslNodeToSchema(node)
    if (node && node.required) required.push(name)
  }
  return { type: "object", properties, ...(required.length ? { required } : {}) }
}

function typeOf(value) {
  if (value === null) return "null"
  if (Array.isArray(value)) return "array"
  return typeof value
}

function checkType(expected, value) {
  const actual = typeOf(value)
  if (expected === "json") return true
  if (expected === "integer") return actual === "number" && Number.isInteger(value)
  if (expected === "number") return actual === "number" && Number.isFinite(value)
  if (expected === "array") return actual === "array"
  if (expected === "object") return actual === "object"
  return actual === expected
}

/**
 * 校验参数。返回 { ok, errors, value }。
 * 校验失败不会抛错——调用方把它转成普通工具错误结果。
 */
export function validateArgs(schema, args) {
  const errors = []
  const value = args && typeof args === "object" && !Array.isArray(args) ? { ...args } : {}
  const properties = schema?.properties || {}
  const required = schema?.required || []

  for (const key of required) {
    if (value[key] === undefined || value[key] === null) errors.push(`缺少必需参数 "${key}"`)
  }
  for (const [key, node] of Object.entries(properties)) {
    if (value[key] === undefined) continue
    if (node.type && !checkType(node.type, value[key])) {
      errors.push(`参数 "${key}" 类型应为 ${node.type}，实际是 ${typeOf(value[key])}`)
      continue
    }
    if (node.enum && !node.enum.includes(value[key])) {
      errors.push(`参数 "${key}" 只能是 ${node.enum.join(" / ")} 之一`)
    }
  }
  if (schema?.additionalProperties === false) {
    for (const key of Object.keys(value)) {
      if (!(key in properties)) errors.push(`未知参数 "${key}"`)
    }
  }
  return { ok: errors.length === 0, errors, value }
}

/**
 * 构建一个工具定义。
 * @param {object} def
 * @param {string} def.name 面向模型的名称
 * @param {string} [def.description]
 * @param {object} [def.parameters] 参数 DSL 或 JSON Schema
 * @param {'parallel'|'exclusive'} [def.executionMode] 执行模式；exclusive 构成排序屏障
 * @param {number} [def.timeoutMs]
 * @param {string} [def.permission] 需要的权限名（由 approval 服务裁决）
 * @param {boolean} [def.enabled]
 * @param {(args: object, exec: object) => Promise<any>} def.execute
 */
export function defineTool(def) {
  if (!def || typeof def !== "object") throw new Error("defineTool 需要一个工具定义对象")
  if (typeof def.name !== "string" || !def.name.trim()) throw new Error("工具必须有 name")
  if (typeof def.execute !== "function") throw new Error(`工具 ${def.name} 必须有 execute`)

  const schema = toJsonSchema(def.parameters)
  return Object.freeze({
    name: def.name,
    description: def.description || "",
    usage: def.usage || "",
    parameters: schema,
    executionMode: def.executionMode === "exclusive" ? "exclusive" : "parallel",
    timeoutMs: Number.isFinite(def.timeoutMs) && def.timeoutMs > 0 ? def.timeoutMs : undefined,
    permission: def.permission,
    enabled: def.enabled !== false,
    output: def.output,
    execute: def.execute,
  })
}
