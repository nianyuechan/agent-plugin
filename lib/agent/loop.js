import { HookBus, EVENTS } from "./events.js"
import { SessionStore, Session, EVENT, TOOL_ABORTED_BEFORE_DISPATCH } from "./session.js"
import { SystemPrompt } from "./prompt.js"
import { ToolRegistry } from "./registry.js"
import { ApprovalService } from "./approval.js"
import { estimateMessages, estimateTools } from "./tokens.js"
import { pruneToolResults, compactMessages, renderForSummary, COMPACTION_DEFAULTS, PRUNE_DEFAULTS } from "./compaction.js"

export const DEFAULT_MAX_PARALLEL_TOOL_CALLS = 10
export const DEFAULT_MAX_STEPS = 25

const OVERFLOW_PATTERN = /context length|context_length|too many tokens|maximum context|超出.*长度|上下文.*(超|溢出)/i

function safeParseArguments(raw) {
  if (raw === undefined || raw === null || raw === "") return {}
  if (typeof raw === "object") return raw
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === "object" ? parsed : {}
  } catch {
    return {}
  }
}

/**
 * Agent 驱动器（对齐 @deepseek-ai/dsh-agent-loop 的 ReactLoop）
 *
 * 核心不变量：
 * - 会话是只追加的日志；每一步都从日志派生历史，模型看到的内容永远可重放
 * - 轮次（turn）由收件箱驱动；步骤（step）= 一次模型请求 + 其工具调用
 * - 每个被接纳的事实（用户消息、助手消息、工具调用与结果）先落日志，再进入下一步
 * - 取消是协作式的：已送达的文本会以 interrupted 锚点收尾
 * - 独占（exclusive）工具调用构成排序屏障，并行安全调用最多重叠 maxParallelToolCalls 个
 */
export class AgentLoop {
  constructor({
    id = "main",
    model,
    tools,
    prompt,
    store = null,
    approval = null,
    hooks = new HookBus(),
    session = null,
    config = {},
  } = {}) {
    this.id = id
    this.model = model
    this.hooks = hooks
    this.registry = tools instanceof ToolRegistry ? tools : new ToolRegistry(hooks)
    this.tools = this.registry.createScope()
    this.prompt = prompt instanceof SystemPrompt ? prompt : new SystemPrompt()
    this.store = store
    this.session = session || new Session({ id: `${id}-session` })
    this.approval = approval || new ApprovalService({ hooks })
    this.config = {
      maxParallelToolCalls: config.maxParallelToolCalls ?? DEFAULT_MAX_PARALLEL_TOOL_CALLS,
      maxSteps: config.maxSteps ?? DEFAULT_MAX_STEPS,
      contextWindow: config.contextWindow ?? 128000,
      compaction: { ...COMPACTION_DEFAULTS, ...(config.compaction || {}) },
      prune: { ...PRUNE_DEFAULTS, ...(config.prune || {}) },
    }

    this._inbox = { prompts: [], nextStep: [], injections: [] }
    this._controller = null
    this._running = null
    this._idleWaiters = []
    this._disposed = false
    this._wake = null

    if (this.store) this.store.attach(this.session)
  }

  /* ------------------------------ 收件箱 ------------------------------ */

  /** 排队一条普通的下一个轮次提示词并唤醒驱动器 */
  followup(content, meta = {}) {
    this._inbox.prompts.push({ content, meta })
    this._wakeDriver()
    return this
  }

  /** 提交下一步输入并唤醒驱动器（轮次中途插入） */
  steer(content, meta = {}) {
    this._inbox.nextStep.push({ content, meta })
    this._wakeDriver()
    return this
  }

  /** 添加面向模型的上下文但不唤醒驱动器（落在下一个被接纳的步骤中） */
  inject(content) {
    this._inbox.injections.push({ content })
    return this
  }

  _hasWork() {
    return this._inbox.prompts.length > 0 || this._inbox.nextStep.length > 0 || this._inbox.injections.length > 0
  }

  _wakeDriver() {
    if (this._wake) {
      const resolve = this._wake
      this._wake = null
      resolve()
    }
  }

  /** 整个 agent 完全停稳（无在跑轮次且收件箱为空）后兑现 */
  whenIdle() {
    if (!this._running && !this._hasWork()) return Promise.resolve()
    return new Promise(resolve => this._idleWaiters.push(resolve))
  }

  _settleIdle() {
    if (this._running || this._hasWork()) return
    for (const resolve of this._idleWaiters.splice(0)) resolve()
  }

  /** 协作式取消：中止当前活动。已流式交付的文本保留。 */
  cancel(cause = "cancelled") {
    this._cancelCause = cause
    this._controller?.abort(cause)
  }

  /** 启动驱动器，跑到收件箱为空 */
  async drive() {
    if (this._running) return this._running
    this._running = (async () => {
      try {
        while (!this._disposed && this._hasWork()) {
          await this._runTurn()
        }
      } finally {
        this._running = null
        if (this.store) await this.store.flush(this.session).catch(() => {})
        this._settleIdle()
      }
    })()
    return this._running
  }

  /* ------------------------------ 轮次与步骤 ------------------------------ */

  _claimInputs({ includePrompt }) {
    const claimed = []
    claimed.push(...this._inbox.injections.splice(0).map(i => ({ kind: "inject", item: i })))
    claimed.push(...this._inbox.nextStep.splice(0).map(i => ({ kind: "user", item: i })))
    if (includePrompt && this._inbox.prompts.length) {
      claimed.push({ kind: "user", item: this._inbox.prompts.shift() })
    }
    return claimed
  }

  async _runTurn() {
    const inputs = this._claimInputs({ includePrompt: true })
    if (!inputs.some(i => i.kind === "user")) {
      // 没有可进入步骤的用户输入：不打开步骤
      return
    }

    const turn = this.session.openTurn()
    this._controller = new AbortController()
    const signal = this._controller.signal

    let accepted = false
    for (const { kind, item } of inputs) {
      if (kind === "user") {
        this.session.appendUserMessage(item.content)
        accepted = true
      } else {
        this.session.appendUserMessage(item.content)
      }
    }
    if (!accepted) {
      this.session.closeTurn({})
      return
    }

    try {
      for (let step = 0; step < this.config.maxSteps; step++) {
        const done = await this._runStep(turn, step + 1, signal)
        if (done === "stop" || signal.aborted) break
      }
    } catch (err) {
      this.session.append(EVENT.ERROR, { message: err.message })
      this.session.appendAssistantMessage(`执行失败: ${err.message}`)
    } finally {
      // 面向模型之外的收尾钩子
      await this.hooks.emit(EVENTS.TURN_STOPPING, { agent: this, session: this.session, turn })
      if (this.session.hasOpenTurn()) {
        this.session.closeTurn({ interrupted: signal.aborted, cause: signal.aborted ? this._cancelCause : undefined })
      }
      this._controller = null
      if (this.store) await this.store.flush(this.session).catch(() => {})
    }
  }

  async _runStep(turn, step, signal) {
    this.session.nextStep()

    // 1) 组装：提示词 + 由日志派生的历史 + 可见工具 schema
    let systemPrompt = this.prompt.render({ model: this.model?.model || "", cwd: this.config.cwd || process.cwd() })
    let messages = this.session.deriveMessages()
    const tools = this.tools.schemas()

    // 2) agent/pre-step：可否决或替换拟进入的步骤
    const verdict = await this.hooks.dispatch(EVENTS.PRE_STEP, {
      agent: this, session: this.session, turn, step, systemPrompt, messages,
      deny: reason => ({ decision: "deny", reason }),
    })
    if (verdict?.decision === "deny") {
      this.session.append(EVENT.ERROR, { message: `步骤被拒绝: ${verdict.reason || ""}` })
      return "stop"
    }
    if (verdict?.systemPrompt !== undefined) systemPrompt = verdict.systemPrompt
    if (verdict?.messages !== undefined) messages = verdict.messages

    // 3) 压缩：先修剪超大工具结果，再按需摘要压缩（只在越过阈值后动手）
    const compaction = this.config.compaction
    if (compaction.auto) {
      const estimated = estimateMessages(messages) + estimateTools(tools)
      const threshold = Math.floor(this.config.contextWindow * compaction.thresholdRatio)
      if (estimated >= threshold) {
        const pruned = pruneToolResults(messages, this.config.prune)
        if (pruned.prunedCount) {
          messages = pruned.messages
          this.session.append("compact/prune", { prunedCount: pruned.prunedCount, freedTokens: pruned.freedTokens })
        }
        if (estimateMessages(messages) + estimateTools(tools) >= threshold) {
          const result = await this._compact(messages)
          if (result.compacted) messages = this.session.deriveMessages()
        }
      }
    }

    // 4) 分派前补齐模型路由
    await this.hooks.dispatch(EVENTS.REQUEST, { agent: this, session: this.session, model: this.model, systemPrompt, messages, tools })

    // 5) 模型调用（重试复用同一份组装结果，不重复 pre-step 与用户消息准入）
    let response
    let overflowRetries = compaction.maxOverflowRetries
    let attempts = 0
    while (true) {
      attempts += 1
      let delivered = ""
      try {
        response = await this._callModel({
          systemPrompt, messages, tools, signal,
          onText: chunk => {
            delivered += chunk
            this.hooks.emit(EVENTS.ASSISTANT_STREAM, { agent: this, turn, step, chunk })
          },
        })
        break
      } catch (err) {
        if (signal.aborted) {
          if (delivered) this.session.appendAssistantMessage(delivered, { interrupted: true })
          return "stop"
        }
        const retried = await this.hooks.dispatch(EVENTS.REQUEST_ERROR, { agent: this, error: err, attempt: attempts, session: this.session })
        if (retried === true) continue

        if (OVERFLOW_PATTERN.test(err.message) && overflowRetries > 0) {
          overflowRetries -= 1
          const result = await this._compact(this.session.deriveMessages())
          if (result.compacted) {
            messages = this.session.deriveMessages()
            continue
          }
        }
        if (delivered) this.session.appendAssistantMessage(delivered, { interrupted: true })
        this.session.appendAssistantMessage(`模型调用失败: ${err.message}`)
        return "stop"
      }
    }

    // 6) 落日志：助手消息锚点 + 工具调用
    const text = response.text || ""
    const toolCalls = response.toolCalls || []
    if (text) this.session.appendAssistantMessage(text)
    if (!toolCalls.length) {
      if (!text) this.session.appendAssistantMessage("(空回复)")
      return "stop"
    }
    this.session.appendToolCalls(toolCalls)

    // 7) 工具执行
    await this._executeToolCalls(toolCalls, { signal, turn, step })

    if (signal.aborted) return "stop"
    return "continue"
  }

  async _callModel({ systemPrompt, messages, tools, signal, onText }) {
    if (!this.model?.complete) throw new Error("未配置模型适配器（model.complete 缺失）")
    return await this.model.complete({ systemPrompt, messages, tools, signal, onText })
  }

  /* ------------------------------ 工具执行 ------------------------------ */

  /**
   * 有界并行工具池 + 独占屏障（对齐 DSH 的 tool-call scheduler）。
   * 并行的结果按**模型顺序**回填日志，保证 tool_calls 与 tool 结果严格配对。
   */
  async _executeToolCalls(toolCalls, { signal, turn, step }) {
    const maxParallel = Math.max(1, this.config.maxParallelToolCalls)
    const results = new Array(toolCalls.length)
    const modeOf = call => this.tools.executionMode(this.tools.resolve(call.function?.name))

    const runOne = async index => {
      const call = toolCalls[index]
      const name = call.function?.name
      const args = safeParseArguments(call.function?.arguments)
      const result = await this.tools.execute(name, args, {
        toolCallId: call.id,
        agent: this,
        signal,
      })
      results[index] = { call, result }
    }

    let next = 0
    while (next < toolCalls.length) {
      if (signal.aborted) break

      if (modeOf(toolCalls[next]) === "exclusive") {
        await runOne(next)          // 独占调用前无并行残留：它是排序屏障
        next += 1
        continue
      }

      // 连续的并行安全调用组成一个有界滚动池
      const group = []
      while (next < toolCalls.length && modeOf(toolCalls[next]) === "parallel") {
        group.push(next)
        next += 1
      }

      const inFlight = new Map()
      const fill = () => {
        while (!signal.aborted && group.length && inFlight.size < maxParallel) {
          const index = group.shift()
          const promise = runOne(index).then(() => index)
          inFlight.set(index, promise)
        }
      }
      fill()
      while (inFlight.size > 0) {
        const settled = await Promise.race(inFlight.values())
        inFlight.delete(settled)
        if (signal.aborted) break
        fill()
      }
      if (signal.aborted) {
        // 未启动的调用也要落日志，保持配对完整
        for (const index of group) {
          results[index] = {
            call: toolCalls[index],
            result: { content: TOOL_ABORTED_BEFORE_DISPATCH, isError: true, meta: { aborted: true } },
            skipped: true,
          }
        }
        await Promise.allSettled(inFlight.values())
      }
    }

    // 按模型顺序落日志
    for (let i = 0; i < toolCalls.length; i++) {
      const entry = results[i]
      if (!entry) {
        results[i] = {
          call: toolCalls[i],
          result: { content: TOOL_ABORTED_BEFORE_DISPATCH, isError: true, meta: { aborted: true } },
          skipped: true,
        }
      }
      const { call, result } = results[i]
      this.session.appendToolResult({
        toolCallId: call.id,
        name: call.function?.name,
        content: result.content,
        isError: result.isError,
        meta: result.meta,
      })
    }
    return results
  }

  /* ------------------------------ 压缩 ------------------------------ */

  async _compact(messages) {
    if (!this.model?.summarize) return { compacted: false, reason: "no-summarizer" }
    const result = await compactMessages({
      messages,
      contextWindow: this.config.contextWindow,
      config: this.config.compaction,
      summarize: async toCompact => this.model.summarize({
        messages: toCompact,
        rendered: renderForSummary(toCompact),
        maxTokens: this.config.compaction.maxTokens,
      }),
    })
    if (!result.compacted) return result

    // 替代面事件：摘要之前的日志不再进入模型上下文
    this.session.appendCompactSummary({
      summary: result.summary,
      compactedEvents: result.compactedMessages,
      freedTokens: result.freedTokens,
    })
    // 逐字保留的尾部重新写入日志，使其在新的替代面之后继续有效
    this._replayMessages(result.retain)
    return result
  }

  /** 把消息数组重新写回日志（压缩后保留尾部用） */
  _replayMessages(messages) {
    for (const message of messages) {
      if (message.role === "user") this.session.appendUserMessage(message.content)
      else if (message.role === "assistant") {
        if (message.content) this.session.appendAssistantMessage(message.content)
        if (message.tool_calls?.length) this.session.appendToolCalls(message.tool_calls)
      } else if (message.role === "tool") {
        this.session.appendToolResult({
          toolCallId: message.tool_call_id,
          name: message.name || "",
          content: typeof message.content === "string" ? message.content : JSON.stringify(message.content),
          isError: false,
          meta: { replayed: true },
        })
      }
    }
  }

  /* ------------------------------ 生命周期 ------------------------------ */

  getSummary() {
    return {
      sessionId: this.session.id,
      seq: this.session.seq,
      openTurn: this.session.hasOpenTurn(),
      inbox: {
        prompts: this._inbox.prompts.length,
        nextStep: this._inbox.nextStep.length,
        injections: this._inbox.injections.length,
      },
      toolCount: this.tools.visible().length,
    }
  }

  async dispose() {
    this._disposed = true
    this.cancel("disposed")
    try { await this._running } catch {}
    this.tools.dispose()
    if (this.store) await this.store.flush(this.session).catch(() => {})
    this._settleIdle()
  }
}

export { Session, SessionStore, EVENT }
