/**
 * 一个模仿 DSH（DeepSeek Harness）架构的 agent 引擎。
 *
 * 与 DSH 的对应关系：
 *   dsh-agent-loop                          → ./loop.js       （轮次/步骤状态机、收件箱、有界并行工具池、取消）
 *   dsh-session / -persistence-jsonl        → ./session.js    （只追加日志、派生上下文、JSONL 落盘、中断轮次修复）
 *   dsh-tools / -tool-*                     → ./tool.js + ./registry.js（defineTool 契约、参数校验、执行流水线、作用域限制）
 *   dsh-system-prompt / dsh-persona         → ./prompt.js     （有序段落、persona 前缀/后缀、{{var}} 模板）
 *   dsh-token-meter                         → ./tokens.js     （字符密度估算）
 *   dsh-compaction-basic / -tool-result-pruner → ./compaction.js（阈值/保留比例、修剪标记）
 *   dsh-user-approval / -permission-presets → ./approval.js   （ask/never 策略、allowed-once、失败关闭）
 *   dsh-agent（agent/* 事件词汇）            → ./events.js     （瀑布与观察者两种分发语义）
 */

import { randomUUID } from "node:crypto"
import { HookBus, EVENTS } from "./events.js"
import { AgentLoop } from "./loop.js"
import { Session, SessionStore, EVENT } from "./session.js"
import { ToolRegistry } from "./registry.js"
import { SystemPrompt } from "./prompt.js"
import { ApprovalService } from "./approval.js"

export { AgentLoop, DEFAULT_MAX_PARALLEL_TOOL_CALLS, DEFAULT_MAX_STEPS } from "./loop.js"
export { ToolRegistry, ToolScope, normalizeResult, errorResult, toolSchema } from "./registry.js"
export { defineTool, toJsonSchema, validateArgs } from "./tool.js"
export { HookBus, EVENTS } from "./events.js"
export { Session, SessionStore, EVENT, TOOL_ABORTED_BEFORE_DISPATCH } from "./session.js"
export {
  SystemPrompt, PERSONA_PREFIX_SECTION, PERSONA_SUFFIX_SECTION,
  joinContextSections, interpolate, buildDefaultPrompt,
} from "./prompt.js"
export { ApprovalService, APPROVAL_OUTCOMES, NEVER_SENTENCE, ASK_SENTENCE } from "./approval.js"
export {
  PRUNE_MARKER, PRUNE_DEFAULTS, COMPACTION_DEFAULTS,
  pruneText, pruneToolResults, planCompaction, compactMessages, renderForSummary,
} from "./compaction.js"
export {
  CHARS_PER_TOKEN, BLOCK_OVERHEAD,
  estimateText, estimateContent, estimateMessage, estimateMessages, estimateTools, estimateRequest,
} from "./tokens.js"

/**
 * 创建一个 agent（对齐 DSH 的 ctx.agents.create / resume）。
 *
 * @param {object} options
 * @param {string} [options.id]
 * @param {object} options.model 模型适配器：{ provider, model, contextWindow, complete(), summarize() }
 * @param {ToolRegistry} [options.tools]
 * @param {SystemPrompt} [options.prompt]
 * @param {HookBus} [options.hooks]
 * @param {string} [options.sessionDir] 给了就落盘为 JSONL
 * @param {string} [options.sessionId]
 * @param {boolean} [options.resume] 恢复已有会话而不是新建
 * @param {string} [options.approvalPolicy] 'ask' | 'never'
 * @param {object} [options.config]
 * @param {(agent: AgentLoop) => void|Promise<void>} [options.setup] 发布前做作用域内注册
 * @returns {Promise<{agent: AgentLoop, session: Session, handle: {dispose: Function, whenIdle: Function}}>}
 */
export async function createAgent({
  id = "main",
  model,
  tools,
  prompt,
  hooks = new HookBus(),
  sessionDir,
  sessionId,
  resume = false,
  approvalPolicy = "ask",
  config = {},
  setup,
} = {}) {
  const registry = tools instanceof ToolRegistry ? tools : new ToolRegistry(hooks)
  const store = sessionDir ? new SessionStore(sessionDir) : null
  const promptBuilder = prompt instanceof SystemPrompt ? prompt : new SystemPrompt()

  let session
  if (store && resume && sessionId && await store.exists(sessionId)) {
    session = await store.open(sessionId)          // 恢复：含中断轮次的语义修复
  } else if (store) {
    session = await store.create({ id: sessionId || `${id}-session-${randomUUID()}` })
  } else {
    session = new Session({ id: sessionId || `${id}-session` })
    session.append(EVENT.SESSION_CREATED, { header: {}, createdAt: Date.now() })
  }

  const approval = new ApprovalService({ hooks, policy: approvalPolicy })
  const agent = new AgentLoop({ id, model, tools: registry, prompt: promptBuilder, store, approval, hooks, session, config })

  if (setup) await setup(agent)

  return {
    agent,
    session,
    handle: {
      dispose: () => agent.dispose(),
      whenIdle: () => agent.whenIdle(),
    },
  }
}
