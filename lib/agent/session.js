import fs from "node:fs"
import fsp from "node:fs/promises"
import path from "node:path"
import { randomUUID } from "node:crypto"

/**
 * 会话事件类型（对齐 @deepseek-ai/dsh-session 的日志词汇）
 * 会话是一个**只追加的日志**：模型看到的上下文永远由日志派生（deriveMessages），
 * 而不是由内存里的可变消息数组持有。
 */
export const EVENT = {
  SESSION_CREATED: "session/created",
  SESSION_END_SEED: "session/end-seed",
  TURN_START: "turn/start",
  STEP_START: "step/start",
  SYSTEM_MESSAGE: "system/message",
  USER_MESSAGE: "user/message",
  ASSISTANT_MESSAGE: "assistant/message",
  ASSISTANT_TOOL_CALLS: "assistant/tool-calls",
  TOOL_RESULT: "tool/result",
  STEP_END: "step/end",
  TURN_END: "turn/end",
  COMPACT_SUMMARY: "compact/summary",
  APPROVAL_REQUEST: "approval/request",
  APPROVAL_OUTCOME: "approval/outcome",
  USAGE: "usage",
  ERROR: "session/error",
}

/** 中断轮次修复时写入的工具结果文案（与 DSH 一致） */
export const TOOL_ABORTED_BEFORE_DISPATCH = "Error: tool call aborted before dispatch"

export class Session {
  constructor({ id, header = {} } = {}) {
    this.id = id || `session-${randomUUID()}`
    this._events = []
    this._seq = 0
    this._openTurn = null
    this._step = 0
    this._listeners = new Set()
    this.header = header
  }

  get seq() {
    return this._seq
  }

  get events() {
    return this._events
  }

  eventAt(seq) {
    return this._events[seq]
  }

  onAppend(fn) {
    this._listeners.add(fn)
    return () => this._listeners.delete(fn)
  }

  /** 只追加。返回后内存投影已经反映该事件（持久化由 store 缓冲）。 */
  append(type, data = {}) {
    const event = { seq: this._seq, time: Date.now(), type, data }
    this._events.push(event)
    this._seq += 1
    for (const fn of this._listeners) {
      try { fn(event) } catch {}
    }
    return event
  }

  /** 回放已持久化的事件（不触发监听器） */
  _replay(event) {
    this._events.push(event)
    this._seq = Math.max(this._seq, event.seq + 1)
    if (event.type === EVENT.TURN_START) this._openTurn = event.data.turn
    if (event.type === EVENT.TURN_END) this._openTurn = null
  }

  /* ------------------------------ 轮次与步骤 ------------------------------ */

  hasOpenTurn() {
    return this._openTurn !== null
  }

  openTurn() {
    const turn = (this._events.filter(e => e.type === EVENT.TURN_START).length) + 1
    this._openTurn = turn
    this._step = 0
    this.append(EVENT.TURN_START, { turn })
    return turn
  }

  nextStep() {
    this._step += 1
    this.append(EVENT.STEP_START, { turn: this._openTurn, step: this._step })
    return this._step
  }

  closeTurn({ interrupted = false, cause } = {}) {
    if (this._openTurn === null) return null
    const turn = this._openTurn
    const event = this.append(EVENT.TURN_END, { turn, interrupted, ...(cause ? { cause } : {}) })
    this._openTurn = null
    return event
  }

  /* ------------------------------ 消息写入 ------------------------------ */

  setSystemPrompt(text) {
    return this.append(EVENT.SYSTEM_MESSAGE, { message: { role: "system", content: text } })
  }

  appendUserMessage(content) {
    return this.append(EVENT.USER_MESSAGE, { message: { role: "user", content } })
  }

  appendAssistantMessage(content, { interrupted = false } = {}) {
    return this.append(EVENT.ASSISTANT_MESSAGE, { message: { role: "assistant", content }, interrupted })
  }

  appendToolCalls(toolCalls) {
    return this.append(EVENT.ASSISTANT_TOOL_CALLS, { toolCalls })
  }

  appendToolResult({ toolCallId, name, content, isError = false, meta = {} }) {
    return this.append(EVENT.TOOL_RESULT, {
      toolCallId, name, content,
      message: { role: "tool", tool_call_id: toolCallId, name, content },
      isError, meta,
    })
  }

  appendCompactSummary({ summary, compactedEvents, freedTokens }) {
    return this.append(EVENT.COMPACT_SUMMARY, { summary, compactedEvents, freedTokens })
  }

  /* ------------------------------ 派生模型上下文 ------------------------------ */

  /** 最新的非空 system/message 即有效提示词 */
  effectiveSystemPrompt() {
    for (let i = this._events.length - 1; i >= 0; i--) {
      const event = this._events[i]
      if (event.type === EVENT.SYSTEM_MESSAGE) {
        const text = event.data?.message?.content
        if (typeof text === "string" && text.length > 0) return text
      }
    }
    return ""
  }

  /** 最近一次「替代面」事件的序号（system/message 或 compact/summary） */
  _surfaceStart() {
    for (let i = this._events.length - 1; i >= 0; i--) {
      const type = this._events[i].type
      if (type === EVENT.SYSTEM_MESSAGE || type === EVENT.COMPACT_SUMMARY) return i
    }
    return 0
  }

  /**
   * 把日志派生为 OpenAI 兼容的消息数组。
   * 规则：
   * - 最新的 system/message 是提示词，不进入数组（由请求头单独携带）
   * - compact/summary 是替代面事件：它之前的历史被丢弃，摘要以 system 消息置于数组头部
   * - assistant/message 与紧随其后的 assistant/tool-calls 合并为一条 assistant 消息
   * - 孤立的 tool/result（没有配对的 tool-call）会被丢弃，保证配对合法
   */
  deriveMessages() {
    const start = this._surfaceStart()
    const messages = []
    const pendingCallIds = new Set()
    let lastAssistant = null

    const pushAssistant = () => {
      lastAssistant = { role: "assistant" }
      messages.push(lastAssistant)
      return lastAssistant
    }

    const startEvent = this._events[start]
    if (startEvent?.type === EVENT.COMPACT_SUMMARY) {
      messages.push({ role: "system", content: `[历史摘要]\n${startEvent.data.summary}` })
    }

    for (let i = start + 1; i < this._events.length; i++) {
      const event = this._events[i]
      switch (event.type) {
        case EVENT.USER_MESSAGE:
          messages.push({ role: "user", content: event.data.message.content })
          lastAssistant = null
          pendingCallIds.clear()
          break
        case EVENT.ASSISTANT_MESSAGE: {
          const content = event.data?.message?.content
          if (typeof content === "string" && content.length > 0) {
            const msg = pushAssistant()
            msg.content = content
          } else {
            lastAssistant = null
          }
          break
        }
        case EVENT.ASSISTANT_TOOL_CALLS: {
          const toolCalls = event.data.toolCalls || []
          const target = lastAssistant && !lastAssistant.tool_calls ? lastAssistant : pushAssistant()
          target.tool_calls = toolCalls
          for (const call of toolCalls) pendingCallIds.add(call.id)
          lastAssistant = null
          break
        }
        case EVENT.TOOL_RESULT: {
          const callId = event.data.toolCallId
          if (!pendingCallIds.has(callId)) break   // 孤立结果，丢弃
          pendingCallIds.delete(callId)
          messages.push({
            role: "tool",
            tool_call_id: callId,
            content: event.data.content ?? "",
          })
          break
        }
        default:
          break
      }
    }
    return messages
  }

  /** 尚未收到结果的工具调用（用于中断修复） */
  danglingToolCalls() {
    const called = new Map()
    for (const event of this._events) {
      if (event.type === EVENT.ASSISTANT_TOOL_CALLS) {
        for (const call of event.data.toolCalls || []) called.set(call.id, call)
      }
      if (event.type === EVENT.TOOL_RESULT) called.delete(event.data.toolCallId)
    }
    return [...called.values()]
  }

  /**
   * 语义崩溃修复（对齐 DSH 的 interruptedTurnClosers）：
   * 日志停在轮次中途时，补齐被中止的工具结果并关闭轮次，
   * 使下一次请求包含的是一段自洽的历史。
   */
  closeInterruptedTurn() {
    if (!this.hasOpenTurn()) return false

    // 1) 最后一个 turns/assistant 消息如果被截断，标记 interrupted
    for (let i = this._events.length - 1; i >= 0; i--) {
      const event = this._events[i]
      if (event.type === EVENT.ASSISTANT_MESSAGE) {
        if (!event.data.interrupted) event.data = { ...event.data, interrupted: true }
        break
      }
      if (event.type === EVENT.USER_MESSAGE || event.type === EVENT.TURN_END) break
    }

    // 2) 补齐悬挂的工具调用结果
    const turn = this._openTurn
    for (const call of this.danglingToolCalls()) {
      this.appendToolResult({
        toolCallId: call.id,
        name: call.function?.name || "",
        content: TOOL_ABORTED_BEFORE_DISPATCH,
        isError: true,
        meta: { aborted: true },
      })
    }

    // 3) 关闭轮次
    this.closeTurn({ interrupted: true, cause: "process-restart" })
    return { turn }
  }

  toJSONL() {
    return this._events.map(e => JSON.stringify(e)).join("\n") + "\n"
  }
}

/**
 * JSONL 会话存储（对齐 @deepseek-ai/dsh-session-persistence-jsonl 的落盘方式）
 * 目录布局：<baseDir>/<sessionId>.jsonl，首行是 session/created 头事件。
 */
export class SessionStore {
  constructor(baseDir) {
    this.baseDir = baseDir
    this._buffers = new Map()
    this._flushTimer = null
    this._installExitHook()
  }

  _file(id) {
    return path.join(this.baseDir, `${id}.jsonl`)
  }

  _installExitHook() {
    if (this._hooked) return
    this._hooked = true
    process.on("exit", () => {
      try { this.flushSync() } catch {}
    })
  }

  async create({ id, header = {} } = {}) {
    const session = new Session({ id, header })
    await fsp.mkdir(this.baseDir, { recursive: true })
    session.append(EVENT.SESSION_CREATED, { header, createdAt: Date.now() })
    this._buffer(session, session.events[session.seq - 1])
    await this.flush(session)
    return session
  }

  async open(id) {
    const file = this._file(id)
    const raw = await fsp.readFile(file, "utf8")
    const lines = raw.split("\n").filter(Boolean)
    const headerEvent = JSON.parse(lines[0])
    const session = new Session({ id, header: headerEvent.data?.header || {} })
    for (const line of lines) {
      try { session._replay(JSON.parse(line)) } catch {}
    }
    // 崩溃修复：语义上的收尾属于 agent 层职责，而不是存储入口
    const replayed = session.seq
    session.closeInterruptedTurn()
    const added = session.events.slice(replayed)
    if (added.length) {
      await fsp.appendFile(file, added.map(e => JSON.stringify(e)).join("\n") + "\n", "utf8")
    }
    return session
  }

  async exists(id) {
    try { await fsp.access(this._file(id)); return true } catch { return false }
  }

  async list() {
    try {
      const entries = await fsp.readdir(this.baseDir)
      return entries.filter(f => f.endsWith(".jsonl")).map(f => f.replace(/\.jsonl$/, ""))
    } catch {
      return []
    }
  }

  _buffer(session, event) {
    const lines = this._buffers.get(session.id) || []
    lines.push(JSON.stringify(event))
    this._buffers.set(session.id, lines)
    if (!this._flushTimer) {
      this._flushTimer = setTimeout(() => {
        this._flushTimer = null
        this.flushAll().catch(() => {})
      }, 200)
      this._flushTimer.unref?.()
    }
  }

  /** 让 session.append 之后自动落盘 */
  attach(session) {
    session.onAppend(event => this._buffer(session, event))
    return session
  }

  async flush(session) {
    const lines = this._buffers.get(session?.id)
    if (!lines?.length) return
    this._buffers.set(session.id, [])
    await fsp.mkdir(this.baseDir, { recursive: true })
    await fsp.appendFile(this._file(session.id), lines.join("\n") + "\n", "utf8")
  }

  async flushAll() {
    for (const id of [...this._buffers.keys()]) {
      const lines = this._buffers.get(id)
      if (!lines?.length) continue
      this._buffers.set(id, [])
      await fsp.mkdir(this.baseDir, { recursive: true })
      await fsp.appendFile(this._file(id), lines.join("\n") + "\n", "utf8")
    }
  }

  flushSync() {
    for (const [id, lines] of this._buffers) {
      if (!lines?.length) continue
      this._buffers.set(id, [])
      fs.mkdirSync(this.baseDir, { recursive: true })
      fs.appendFileSync(this._file(id), lines.join("\n") + "\n", "utf8")
    }
  }
}
