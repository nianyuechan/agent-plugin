import { estimateMessages, estimateText } from "./tokens.js"

/**
 * 压缩（对齐 @deepseek-ai/dsh-compaction-basic 与 dsh-compaction-tool-result-pruner）
 *
 * 两个独立机制：
 * 1. 工具结果修剪（无模型调用）：文本超过 thresholdChars 的结果，替换为
 *    「头部 + 中间标记 + 尾部」。只有模型看到的内容变短，原始内容仍完整保留在会话日志里。
 * 2. 会话压缩（需要模型写摘要）：越过阈值后，把**最旧的平衡范围**替换成一条摘要消息，
 *    近期尾部逐字保留。切点只取在轮次边界，绝不拆散 tool_calls 与 tool 结果的配对。
 */

export const PRUNE_MARKER = "\n\n[... tool result middle pruned ...]\n\n"

export const PRUNE_DEFAULTS = {
  thresholdChars: 8192,
  headChars: 4096,
  tailChars: 1024,
}

export const COMPACTION_DEFAULTS = {
  thresholdRatio: 0.8,
  retainRatio: 0.16,
  maxTokens: 8192,
  compactionRetries: 1,
  maxOverflowRetries: 1,
  auto: true,
}

/** 以 Unicode 码点计数并切片，避免拆开 emoji 代理对 */
function codePoints(text) {
  return [...text]
}

/**
 * 修剪一条工具结果文本。未超预算返回 null。
 * @returns {{text: string, before: number, after: number}|null}
 */
export function pruneText(text, config = {}) {
  const { thresholdChars, headChars, tailChars } = { ...PRUNE_DEFAULTS, ...config }
  if (headChars + tailChars > thresholdChars) {
    throw new Error("修剪配置非法：headChars + tailChars 不能超过 thresholdChars")
  }
  if (typeof text !== "string") return null
  const points = codePoints(text)
  if (points.length <= thresholdChars) return null

  const head = points.slice(0, headChars).join("")
  const tail = points.slice(points.length - tailChars).join("")
  return {
    text: head + PRUNE_MARKER + tail,
    before: points.length,
    after: head.length + PRUNE_MARKER.length + tail.length,
  }
}

/**
 * 修剪消息数组里的工具结果。返回新数组，不修改入参。
 * @returns {{messages: Array, prunedCount: number, freedTokens: number}}
 */
export function pruneToolResults(messages, config = {}) {
  let prunedCount = 0
  let freedTokens = 0
  const out = messages.map(message => {
    if (message.role !== "tool" || typeof message.content !== "string") return message
    const pruned = pruneText(message.content, config)
    if (!pruned) return message
    prunedCount += 1
    freedTokens += estimateText(message.content) - estimateText(pruned.text)
    return { ...message, content: pruned.text, _pruned: true }
  })
  return { messages: out, prunedCount, freedTokens }
}

/**
 * 找出所有「平衡」切点：在该处切断不会拆散 tool_calls 与 tool 结果的配对。
 * 做法是线性扫描并跟踪未配对的调用集合——只有集合为空的位置才算平衡。
 */
function safeBoundaries(messages) {
  const boundaries = []
  const pending = new Set()
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]
    if (message.role === "tool") {
      pending.delete(message.tool_call_id)
      continue
    }
    if (pending.size === 0 && i > 0) boundaries.push(i)
    if (message.role === "assistant" && message.tool_calls) {
      for (const call of message.tool_calls) pending.add(call.id)
    }
  }
  return boundaries
}

/**
 * 计算压缩方案。
 * @param {Array} messages 派生出的模型消息
 * @param {number} contextWindow 已路由模型的上下文窗口（token）
 * @returns {{shouldCompact: boolean, cutAt: number, threshold: number, retainTokens: number, reason?: string}}
 */
export function planCompaction(messages, contextWindow, config = {}) {
  const cfg = { ...COMPACTION_DEFAULTS, ...config }
  const threshold = Math.floor(contextWindow * cfg.thresholdRatio)
  const retainTokens = Number.isFinite(cfg.retainTokens)
    ? cfg.retainTokens
    : Math.floor(contextWindow * cfg.retainRatio)

  if (retainTokens >= threshold) {
    throw new Error("压缩配置非法：逐字保留量不得低于阈值")
  }

  const estimated = estimateMessages(messages)
  if (estimated < threshold) {
    return { shouldCompact: false, cutAt: 0, threshold, retainTokens, estimated, reason: "below-threshold" }
  }

  // 从后往前找能满足「保留预算」的最早安全切点
  const boundaries = safeBoundaries(messages)
  if (!boundaries.length) {
    return { shouldCompact: false, cutAt: 0, threshold, retainTokens, estimated, reason: "no-safe-boundary" }
  }

  let cutAt = 0
  for (const boundary of boundaries) {
    const tailTokens = estimateMessages(messages.slice(boundary))
    if (tailTokens <= retainTokens) {
      cutAt = boundary
      break
    }
  }
  if (cutAt === 0) {
    // 尾部本身已超预算：退化为保留最后一个安全边界之后的内容
    cutAt = boundaries[boundaries.length - 1]
  }
  if (cutAt <= 0 || cutAt >= messages.length) {
    return { shouldCompact: false, cutAt: 0, threshold, retainTokens, estimated, reason: "nothing-compactable" }
  }

  return { shouldCompact: true, cutAt, threshold, retainTokens, estimated }
}

/**
 * 执行压缩：调用 summarize 生成摘要，返回摘要与需要逐字保留的尾部消息。
 * 会话日志的写入由调用方（AgentLoop）负责，这里保持纯函数。
 */
export async function compactMessages({ messages, contextWindow, summarize, config = {} }) {
  const plan = planCompaction(messages, contextWindow, config)
  if (!plan.shouldCompact) return { compacted: false, ...plan }

  const toCompact = messages.slice(0, plan.cutAt)
  const retain = messages.slice(plan.cutAt)
  const freedTokens = estimateMessages(toCompact) - estimateText("") // 摘要本身的成本由调用方再算

  const summary = await summarize(toCompact, { maxTokens: (config.maxTokens ?? COMPACTION_DEFAULTS.maxTokens) })
  if (!summary || !String(summary).trim()) {
    return { compacted: false, ...plan, reason: "empty-summary" }
  }

  return {
    compacted: true,
    summary: String(summary).trim(),
    retain,
    compactedMessages: toCompact.length,
    freedTokens: Math.max(0, freedTokens - estimateText(String(summary).trim())),
    threshold: plan.threshold,
    retainTokens: plan.retainTokens,
  }
}

/** 把待压缩消息渲染成喂给摘要模型的文本 */
export function renderForSummary(messages) {
  const lines = []
  for (const message of messages) {
    const role = { user: "用户", assistant: "助手", tool: "工具结果", system: "系统" }[message.role] || message.role
    const content = typeof message.content === "string"
      ? message.content
      : JSON.stringify(message.content ?? "")
    const calls = message.tool_calls?.length
      ? ` [调用工具: ${message.tool_calls.map(c => c.function?.name).join(", ")}]`
      : ""
    lines.push(`${role}${calls}: ${content.slice(0, 2000)}`)
  }
  return lines.join("\n")
}
