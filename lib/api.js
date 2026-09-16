import cfg from "../lib/config.js"

/** 单次请求超时（毫秒），可用 #ai设置 requestTimeout 调整 */
function timeoutOf() {
  const t = Number(cfg.requestTimeout)
  return Number.isFinite(t) && t > 0 ? t : 60000
}

async function post(url, apiKey, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutOf()),
  })
  return res
}

function normalizeError(err) {
  if (err?.name === "TimeoutError" || err?.name === "AbortError") {
    return new Error(`请求超时（${timeoutOf()}ms），请检查 apiUrl 是否可达`)
  }
  return err
}

function cleanKey(key) {
  // 只清理空白与零宽字符，不再按中文字符范围删字符（原实现会静默改坏 apiKey）
  return String(key || "").replace(/[\s\u200b-\u200f\ufeff]/g, "")
}

function cleanUrl(url) {
  // 全角冒号/斜杠还原为半角，其余原样保留
  return String(url || "")
    .replace(/[\s\u200b-\u200f\ufeff]/g, "")
    .replace(/：/g, ":")
    .replace(/／/g, "/")
}

function buildBody(cfgKeyPrefix, messages, options, stream, defaultModel = "deepseek-chat") {
  const pick = name => (cfgKeyPrefix ? cfg[cfgKeyPrefix + name] : undefined) ?? cfg[name]
  const apiKey = cleanKey(pick("apiKey"))
  const apiUrl = cleanUrl(pick("apiUrl") || "https://api.deepseek.com")
  const model = options.model || pick("model") || defaultModel
  const maxTokens = Math.min(options.maxTokens || Number(cfg.maxTokens) || 8192, 393216)
  const url = `${apiUrl.replace(/\/+$/, "")}/chat/completions`
  const body = { model, messages, stream, max_tokens: maxTokens }

  if (options.tools && options.tools.length) {
    body.tools = options.tools
    body.tool_choice = options.tool_choice || "auto"
  }
  return { url, apiKey, body }
}

function parseResult(data) {
  if (data?.error) throw new Error(data.error.message || JSON.stringify(data.error))
  const choice = data?.choices?.[0]
  if (!choice) return ""
  const message = choice.message
  if (message?.tool_calls?.length) {
    return { content: message.content || "", toolCalls: message.tool_calls }
  }
  return message?.content || ""
}

/**
 * #ai 对话模式专用 API
 * @param {Array} messages
 * @param {object} options
 */
export async function chatCompletion(messages, options = {}) {
  const { url, apiKey, body } = buildBody("", messages, options, options.stream ?? false)
  let res
  try {
    res = await post(url, apiKey, body)
  } catch (err) {
    throw normalizeError(err)
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "")
    throw new Error(`API ${res.status}: ${text.slice(0, 200)}`)
  }
  if (body.stream) return res
  return parseResult(await res.json())
}

/**
 * #agent 模式专用 API（支持 tool calling）
 * agentApiKey / agentApiUrl / agentModel 优先，未配置时回落到通用配置
 */
export async function agentChatCompletion(messages, options = {}) {
  const { url, apiKey, body } = buildBody("agent", messages, options, options.stream ?? false, "glm-5.1")
  let res
  try {
    res = await post(url, apiKey, body)
  } catch (err) {
    throw normalizeError(err)
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "")
    throw new Error(`Agent API ${res.status}: ${text.slice(0, 200)}`)
  }
  if (body.stream) return res
  return parseResult(await res.json())
}

export async function* streamChat(messages, options = {}) {
  const { url, apiKey, body } = buildBody("", messages, options, true)
  let res
  try {
    res = await post(url, apiKey, body)
  } catch (err) {
    throw normalizeError(err)
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "")
    throw new Error(`API ${res.status}: ${text.slice(0, 200)}`)
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split("\n")
      buffer = lines.pop() || ""
      for (const line of lines) {
        const trimmed = line.trim()
        // 兼容 `data: {...}` 与 `data:{...}` 两种写法
        if (!trimmed.startsWith("data:")) continue
        const payload = trimmed.slice(5).trim()
        if (!payload) continue
        if (payload === "[DONE]") return
        try {
          const parsed = JSON.parse(payload)
          if (parsed?.error) throw new Error(parsed.error.message || "流式返回错误")
          const delta = parsed.choices?.[0]?.delta?.content
          if (delta) yield delta
        } catch (err) {
          if (err instanceof SyntaxError) continue
          throw err
        }
      }
    }
  } finally {
    try { await reader.cancel() } catch {}
  }
}
