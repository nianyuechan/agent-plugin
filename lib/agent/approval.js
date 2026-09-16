import { EVENTS } from "./events.js"
import { EVENT } from "./session.js"

/**
 * 审批服务（对齐 @deepseek-ai/dsh-user-approval）
 *
 * 规则：
 * - 有效策略 = 会话自身设置的策略，回退到配置默认值
 * - `ask`：委托给应答者（approval/request 瀑布监听器）
 * - `never`：在分发之前确定性地拒绝每个请求（CI / 无人值守姿态）
 * - 没有应答者作答 → `unavailable`，**失败关闭**（服务自己绝不弹窗问人）
 * - 中止会撤回问题：以 `cancelled` 结算，迟到的回答被丢弃
 * - 只有 `allowed-once` 是授权；每次 ask 与 outcome 都写入会话审计
 */

export const APPROVAL_OUTCOMES = ["allowed-once", "denied", "cancelled", "unavailable", "timeout"]

export const NEVER_SENTENCE =
  "Approval prompts are disabled in this session: actions that require approval are rejected automatically — do not request escalation."
export const ASK_SENTENCE =
  "Approval policy: ask. Operations that require approval may ask through the configured answerers; without an available answerer, the request fails closed."

export const APPROVAL_DEFAULT_TIMEOUT_MS = 120000

export class ApprovalService {
  constructor({ hooks, policy = "ask", defaultTimeoutMs = APPROVAL_DEFAULT_TIMEOUT_MS } = {}) {
    this.hooks = hooks
    this.policy = policy === "never" ? "never" : "ask"
    this.defaultTimeoutMs = defaultTimeoutMs
    this._sessionPolicy = new Map()
    this.pending = new Map()
  }

  effectivePolicy(session) {
    if (!session) return this.policy
    return this._sessionPolicy.get(session.id) || this.policy
  }

  /** 切换会话策略，并给该会话记一条面向模型的策略变更消息 */
  setPolicy(agent, policy) {
    if (policy !== "ask" && policy !== "never") throw new Error(`未知审批策略: ${policy}`)
    const session = agent?.session
    if (!session) throw new Error("setPolicy 需要带 session 的 agent")
    this._sessionPolicy.set(session.id, policy)
    session.append("approval/policy", { policy })
    session.appendUserMessage(
      policy === "never" ? `（系统）${NEVER_SENTENCE}` : `（系统）${ASK_SENTENCE}`
    )
  }

  /** 当前策略的完整含义，注入 runtime context 快照 */
  policySentence(session) {
    return this.effectivePolicy(session) === "never" ? NEVER_SENTENCE : ASK_SENTENCE
  }

  /**
   * 请求一次决定。必须在未结束的轮次中进行。
   * @returns {Promise<string>} APPROVAL_OUTCOMES 之一；只有 'allowed-once' 是授权
   */
  async request({ agent, tool, callId, reason, signal, timeoutMs }) {
    const session = agent?.session
    if (!session) throw new Error("审批请求需要一个会话")
    if (!session.hasOpenTurn()) throw new Error("审批请求必须在未结束的轮次内发起")

    // 审计：请求
    session.append(EVENT.APPROVAL_REQUEST, { tool, callId, reason })

    const settle = outcome => {
      const normalized = APPROVAL_OUTCOMES.includes(outcome) ? outcome : "unavailable"
      session.append(EVENT.APPROVAL_OUTCOME, { tool, callId, outcome: normalized, reason })
      return normalized
    }

    // 中止已发生
    if (signal?.aborted) return settle("cancelled")

    // never 策略：确定性地拒绝，不问任何人
    if (this.effectivePolicy(session) === "never") return settle("denied")

    if (!this.hooks || this.hooks.count(EVENTS.APPROVAL_REQUEST) === 0) {
      return settle("unavailable")   // 失败关闭
    }

    const ms = Number.isFinite(timeoutMs) ? timeoutMs : this.defaultTimeoutMs
    let timer
    const timeoutPromise = new Promise(resolve => {
      timer = setTimeout(() => resolve("timeout"), ms)
      timer.unref?.()
    })
    const abortPromise = new Promise(resolve => {
      if (!signal) return
      if (signal.aborted) resolve("cancelled")
      else signal.addEventListener("abort", () => resolve("cancelled"), { once: true })
    })

    try {
      const answer = await Promise.race([
        this.hooks.dispatch(EVENTS.APPROVAL_REQUEST, { agent, session, tool, callId, reason, signal }),
        timeoutPromise,
        abortPromise,
      ])
      // 迟到的回答：已中止则丢弃
      if (signal?.aborted) return settle("cancelled")
      if (answer === undefined || answer === null) return settle("unavailable")
      const outcome = typeof answer === "string" ? answer : answer.outcome
      return settle(outcome)
    } catch {
      return settle("unavailable")
    } finally {
      clearTimeout(timer)
    }
  }
}
