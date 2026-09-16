/**
 * DSH 风格钩子总线（对应 dsh 的 cordis 事件瀑布）。
 *
 * 两种分发语义：
 * - dispatch()：瀑布（waterfall）。监听器拿到 (payload, next)，
 *   调用 next() 委托给下游并返回其结果，或直接返回自己的结果作为最终答案。
 *   没有监听器作答时返回 undefined（调用方自行决定默认值 → 「缺省即失败关闭」）。
 * - emit()：观察者。忽略返回值，单个监听器抛错不影响其他监听器。
 */
export class HookBus {
  constructor() {
    this._listeners = new Map()
  }

  /** @returns {() => void} 取消订阅 */
  on(name, fn) {
    const list = this._listeners.get(name) || []
    list.push(fn)
    this._listeners.set(name, list)
    return () => {
      const idx = list.indexOf(fn)
      if (idx >= 0) list.splice(idx, 1)
    }
  }

  count(name) {
    return (this._listeners.get(name) || []).length
  }

  /** 瀑布分发：第一个「作答」的监听器胜出 */
  async dispatch(name, payload) {
    const list = [...(this._listeners.get(name) || [])]
    let index = -1
    const next = async () => {
      index += 1
      if (index >= list.length) return undefined
      return await list[index](payload, next)
    }
    return await next()
  }

  /** 观察者分发 */
  async emit(name, payload) {
    for (const fn of [...(this._listeners.get(name) || [])]) {
      try {
        await fn(payload, async () => undefined)
      } catch (err) {
        // 观察者失败不影响主流程
        try { globalThis.logger?.warn?.(`[Agent] hook ${name} 失败: ${err.message}`) } catch {}
      }
    }
  }
}

/** 与 DSH 对齐的事件词汇表 */
export const EVENTS = {
  /** agent/pre-step：可否决或替换即将进入的步骤消息 */
  PRE_STEP: "agent/pre-step",
  /** agent/request：分派前补齐/改写 provider+model 路由 */
  REQUEST: "agent/request",
  /** tools/pre-execute：决定 allow / deny / ask */
  TOOLS_PRE_EXECUTE: "tools/pre-execute",
  /** tools/execute：包装分发（超时、重试） */
  TOOLS_EXECUTE: "tools/execute",
  /** tools/post-execute：检查或替换结果 */
  TOOLS_POST_EXECUTE: "tools/post-execute",
  /** tools/result：观察冻结后的最终结果 */
  TOOLS_RESULT: "tools/result",
  /** approval/request：应答者 */
  APPROVAL_REQUEST: "approval/request",
  /** agent/request-error：让监听器重试失败的模型请求 */
  REQUEST_ERROR: "agent/request-error",
  /** agent/turn-stopping：轮次结束前的最后机会 */
  TURN_STOPPING: "agent/turn-stopping",
  /** agent/assistant-stream：流式增量 */
  ASSISTANT_STREAM: "agent/assistant-stream",
}
