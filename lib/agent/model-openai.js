/**
 * OpenAI 兼容的模型适配器（engine 只依赖这个契约，不关心是哪家服务）
 *
 * 契约：
 *   model.complete({ systemPrompt, messages, tools, signal, onText })
 *     → { text, toolCalls, usage }
 *   model.summarize({ messages, rendered, maxTokens })
 *     → string（摘要文本）
 */

const DEFAULT_TIMEOUT_MS = 60000

function normalizeError(err, timeoutMs) {
  if (err?.name === "TimeoutError" || err?.name === "AbortError") {
    return new Error(`请求超时或已取消（${timeoutMs}ms）`)
  }
  return err
}

/** 累积流式 tool_calls 增量（按 index 合并，arguments 是字符串分片） */
export class ToolCallAccumulator {
  constructor() {
    this._byIndex = new Map()
  }

  push(deltas) {
    for (const delta of deltas || []) {
      const index = delta.index ?? 0
      const existing = this._byIndex.get(index) || { id: "", type: "function", function: { name: "", arguments: "" } }
      if (delta.id) existing.id = delta.id
      if (delta.type) existing.type = delta.type
      if (delta.function?.name) existing.function.name += delta.function.name
      if (delta.function?.arguments) existing.function.arguments += delta.function.arguments
      this._byIndex.set(index, existing)
    }
  }

  finish() {
    return [...this._byIndex.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([index, call]) => ({
        id: call.id || `call_${index}_${Date.now()}`,
        type: "function",
        function: {
          name: call.function.name,
          arguments: call.function.arguments || "{}",
        },
      }))
      .filter(call => call.function.name)
  }
}

export function createOpenAIAdapter({
  apiKey,
  apiUrl = "https://api.deepseek.com",
  model = "deepseek-chat",
  contextWindow = 128000,
  maxTokens = 8192,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  provider = "openai-compatible",
  extraHeaders = {},
  fetchImpl = globalThis.fetch,
} = {}) {
  const endpoint = `${String(apiUrl).replace(/\/+$/, "")}/chat/completions`

  async function request(body, { signal, timeout = timeoutMs } = {}) {
    const controller = new AbortController()
    const onAbort = () => controller.abort(signal?.reason)
    if (signal) {
      if (signal.aborted) controller.abort(signal.reason)
      else signal.addEventListener("abort", onAbort, { once: true })
    }
    const timer = setTimeout(() => controller.abort(new Error("timeout")), timeout)
    timer.unref?.()

    try {
      return await fetchImpl(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
          ...extraHeaders,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
    } catch (err) {
      throw normalizeError(err, timeout)
    } finally {
      clearTimeout(timer)
      if (signal) signal.removeEventListener?.("abort", onAbort)
    }
  }

  function buildMessages(systemPrompt, messages) {
    const out = []
    if (systemPrompt) out.push({ role: "system", content: systemPrompt })
    out.push(...messages)
    return out
  }

  return {
    provider,
    model,
    contextWindow,
    maxTokens,

    async complete({ systemPrompt, messages, tools, signal, onText }) {
      const body = {
        model,
        messages: buildMessages(systemPrompt, messages),
        stream: true,
        max_tokens: maxTokens,
      }
      if (tools?.length) {
        body.tools = tools
        body.tool_choice = "auto"
      }

      const res = await request(body, { signal })
      if (!res.ok) {
        const text = await res.text().catch(() => "")
        throw new Error(`API ${res.status}: ${text.slice(0, 300)}`)
      }

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      const accumulator = new ToolCallAccumulator()
      let buffer = ""
      let text = ""
      let usage = null

      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          const lines = buffer.split("\n")
          buffer = lines.pop() || ""
          for (const line of lines) {
            const trimmed = line.trim()
            if (!trimmed.startsWith("data:")) continue
            const payload = trimmed.slice(5).trim()
            if (!payload || payload === "[DONE]") continue
            let parsed
            try {
              parsed = JSON.parse(payload)
            } catch {
              continue
            }
            if (parsed.error) throw new Error(parsed.error.message || "流式返回错误")
            if (parsed.usage) usage = parsed.usage
            const delta = parsed.choices?.[0]?.delta
            if (!delta) continue
            if (delta.content) {
              text += delta.content
              onText?.(delta.content)
            }
            if (delta.tool_calls) accumulator.push(delta.tool_calls)
          }
        }
      } finally {
        try { await reader.cancel() } catch {}
      }

      return { text, toolCalls: accumulator.finish(), usage }
    },

    async summarize({ rendered, maxTokens: summaryMax }) {
      if (!rendered) return ""
      const body = {
        model,
        messages: [
          {
            role: "system",
            content: [
              "你是对话历史压缩器。把给定的历史压缩成一段简洁的中文摘要，只保留：",
              "用户的目标与约束、已确认的决定、已完成的操作与关键结果、尚未完成的事项、关键文件路径与数值。",
              "不要编造，不要输出建议或客套话。直接输出摘要正文。",
            ].join("\n"),
          },
          { role: "user", content: rendered },
        ],
        stream: false,
        max_tokens: summaryMax || 8192,
      }
      const res = await request(body, { timeout: timeoutMs * 2 })
      if (!res.ok) {
        const text = await res.text().catch(() => "")
        throw new Error(`摘要 API ${res.status}: ${text.slice(0, 200)}`)
      }
      const data = await res.json()
      if (data.error) throw new Error(data.error.message || "摘要失败")
      return data.choices?.[0]?.message?.content || ""
    },
  }
}
