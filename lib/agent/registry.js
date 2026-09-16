import { defineTool, validateArgs } from "./tool.js"
import { EVENTS } from "./events.js"

const DEFAULT_TOOL_TIMEOUT_MS = 120000

/** 把任意工具返回值归一化成统一结果形状 */
export function normalizeResult(name, raw) {
  if (raw === undefined || raw === null) return { content: "(无输出)", isError: false, meta: {} }
  if (typeof raw === "string") return { content: raw, isError: false, meta: {} }
  if (typeof raw === "object") {
    if (raw.error !== undefined) {
      const text = typeof raw.error === "string" ? raw.error : JSON.stringify(raw.error)
      return { content: `Error: ${text}`, isError: true, meta: raw.meta || {} }
    }
    if (raw.content !== undefined) {
      const content = typeof raw.content === "string" ? raw.content : JSON.stringify(raw.content, null, 2)
      return { content, isError: raw.isError === true, meta: raw.meta || {} }
    }
  }
  try {
    return { content: JSON.stringify(raw, null, 2), isError: false, meta: {} }
  } catch {
    return { content: String(raw), isError: false, meta: {} }
  }
}

export function errorResult(text, meta = {}) {
  return { content: `Error: ${text}`, isError: true, meta }
}

function withTimeout(promise, ms, onTimeout) {
  if (!ms) return promise
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      onTimeout?.()
      reject(new Error(`工具执行超时（${ms}ms）`))
    }, ms)
    timer.unref?.()
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

/**
 * 工具注册表（对齐 DSH 的 `ctx.tools`）。
 * 全局注册的工具对每个 agent 可见；每个 agent 通过 createScope() 获得自己的
 * 作用域：可局部注册工具、应用 restrict 掩码，dispose 时全部撤销。
 */
export class ToolRegistry {
  constructor(hooks) {
    this._tools = new Map()
    this._hooks = hooks
  }

  register(tool) {
    const def = tool && typeof tool.execute === "function" && Object.isFrozen(tool) ? tool : defineTool(tool)
    this._tools.set(def.name, def)
    return def
  }

  unregister(name) {
    return this._tools.delete(name)
  }

  get(name) {
    return this._tools.get(name)
  }

  has(name) {
    return this._tools.has(name)
  }

  names() {
    return [...this._tools.keys()]
  }

  getAll() {
    return [...this._tools.values()]
  }

  /** 面向模型的工具 schema（不含 execute） */
  schemas() {
    return this.getAll().filter(t => t.enabled !== false).map(toolSchema)
  }

  createScope() {
    return new ToolScope(this, this._hooks)
  }
}

export function toolSchema(tool) {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description || "",
      parameters: tool.parameters || { type: "object", properties: {} },
    },
  }
}

/** 单个 agent 的工具视图 */
export class ToolScope {
  constructor(registry, hooks) {
    this.registry = registry
    this.hooks = hooks
    this._local = new Map()
    this._masks = []
    this._disposed = false
  }

  register(tool) {
    const def = tool && typeof tool.execute === "function" && Object.isFrozen(tool) ? tool : defineTool(tool)
    this._local.set(def.name, def)
    return def
  }

  /**
   * 应用允许/拒绝掩码；掩码取交集。
   * @param {{allow?: string[], deny?: string[]}} filter
   * @returns {() => void} 解除限制
   */
  restrict(filter = {}) {
    const mask = { allow: filter.allow ? [...filter.allow] : null, deny: filter.deny ? [...filter.deny] : [] }
    this._masks.push(mask)
    return () => {
      const idx = this._masks.indexOf(mask)
      if (idx >= 0) this._masks.splice(idx, 1)
    }
  }

  resolve(name) {
    return this._local.get(name) || this.registry.get(name)
  }

  visible() {
    const all = new Map()
    for (const tool of this.registry.getAll()) all.set(tool.name, tool)
    for (const tool of this._local.values()) all.set(tool.name, tool)

    let out = [...all.values()]
    for (const mask of this._masks) {
      if (mask.allow) out = out.filter(t => mask.allow.includes(t.name))
      if (mask.deny?.length) out = out.filter(t => !mask.deny.includes(t.name))
    }
    return out.filter(t => t.enabled !== false)
  }

  schemas() {
    return this.visible().map(toolSchema)
  }

  executionMode(tool) {
    return tool?.executionMode === "exclusive" ? "exclusive" : "parallel"
  }

  /**
   * 工具执行流水线（顺序对齐 DSH）：
   *   解析 → 参数校验 → tools/pre-execute（allow/deny/ask）→ 审批 → tools/execute → tools/post-execute → tools/result
   * 任何失败都转成**普通结果**返回，绝不抛给调用方（保证会话日志里永远有配对的工具结果）。
   */
  async execute(name, args, execContext = {}) {
    if (this._disposed) return errorResult(`工具作用域已释放，无法执行 ${name}`)

    const tool = this.resolve(name)
    if (!tool) return errorResult(`未知工具: ${name}`)
    if (tool.enabled === false) return errorResult(`工具 ${name} 已禁用`)
    if (!this.visible().some(t => t.name === name)) return errorResult(`工具 ${name} 被作用域限制禁止使用`)

    const validation = validateArgs(tool.parameters, args)
    if (!validation.ok) return errorResult(`参数校验失败: ${validation.errors.join("; ")}`)

    const call = { name, args: validation.value, toolCallId: execContext.toolCallId, agent: execContext.agent }
    const signal = execContext.signal

    // 1) 策略裁决
    let decision = "allow"
    let reason = ""
    if (this.hooks) {
      const verdict = await this.hooks.dispatch(EVENTS.TOOLS_PRE_EXECUTE, {
        call, tool, agent: execContext.agent, signal,
        decide: (d, r = "") => ({ decision: d, reason: r }),
      })
      if (verdict) {
        decision = verdict.decision || "allow"
        reason = verdict.reason || ""
      }
    }
    if (decision === "deny") return errorResult(reason || `工具 ${name} 被策略拒绝`)
    if (decision === "ask") {
      const outcome = await this._requestApproval({ call, tool, reason, execContext })
      // 只有 'allowed-once' 是授权；denied / cancelled / unavailable / timeout 一律拒绝
      if (outcome !== "allowed-once") {
        return errorResult(`审批未通过（${outcome}）: ${reason || name}`)
      }
    }

    if (signal?.aborted) return errorResult("工具调用在分发前被中止")

    // 2) 执行（可被 tools/execute 包装，用于超时/重试）
    const run = async () => {
      const raw = await tool.execute(validation.value, {
        signal,
        toolCallId: execContext.toolCallId,
        agent: execContext.agent,
        call,
      })
      return raw
    }
    const wrapped = async () => {
      if (!this.hooks || this.hooks.count(EVENTS.TOOLS_EXECUTE) === 0) return await run()
      const handled = await this.hooks.dispatch(EVENTS.TOOLS_EXECUTE, {
        call, tool, agent: execContext.agent, signal,
        run,
        next: undefined,
      })
      return handled === undefined ? await run() : handled
    }

    let result
    try {
      const timeoutMs = tool.timeoutMs || DEFAULT_TOOL_TIMEOUT_MS
      result = normalizeResult(name, await withTimeout(wrapped(), timeoutMs, () => execContext.onTimeout?.()))
    } catch (err) {
      result = errorResult(`${name} 执行失败: ${err.message}`, { name: err.name })
    }

    // 3) 结果后处理
    if (this.hooks && this.hooks.count(EVENTS.TOOLS_POST_EXECUTE) > 0) {
      const replaced = await this.hooks.dispatch(EVENTS.TOOLS_POST_EXECUTE, { call, tool, result, signal })
      if (replaced) result = replaced
    }
    if (this.hooks) {
      const frozen = Object.freeze({ ...result, meta: Object.freeze({ ...result.meta }) })
      await this.hooks.emit(EVENTS.TOOLS_RESULT, { call, tool, result: frozen })
      return frozen
    }
    return result
  }

  async _requestApproval({ call, tool, reason, execContext }) {
    const approval = execContext.agent?.approval
    if (!approval) return "unavailable"
    return await approval.request({
      agent: execContext.agent,
      tool: tool.name,
      callId: execContext.toolCallId,
      reason: reason || `工具 ${tool.name} 需要审批`,
      signal: execContext.signal,
    })
  }

  dispose() {
    this._disposed = true
    this._local.clear()
    this._masks.length = 0
  }
}
