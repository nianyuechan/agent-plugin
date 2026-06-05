import cfg from "../lib/config.js"

/**
 * #ai 对话模式专用 API（DeepSeek）
 */
export async function chatCompletion(messages, options = {}) {
  const apiKey = String(cfg.apiKey || "").replace(/[一-鿿\s]/g, "").trim()
  const apiUrl = String(cfg.apiUrl || "https://api.deepseek.com").replace(/[一-鿿]/g, "").trim()
  const model = options.model || cfg.model || "deepseek-chat"
  const stream = options.stream ?? false

  const maxTokens = Math.min(options.maxTokens || cfg.maxTokens || 8192, 393216)
  const url = `${apiUrl.replace(/\/+$/, "")}/chat/completions`
  const body = { model, messages, stream, max_tokens: maxTokens }

  if (options.tools && options.tools.length) {
    body.tools = options.tools
    body.tool_choice = options.tool_choice || "auto"
  }

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  })

  if (!res.ok) {
    const text = await res.text().catch(() => "")
    throw new Error(`API ${res.status}: ${text.slice(0, 200)}`)
  }

  if (stream) return res
  const data = await res.json()
  if (data.error) throw new Error(data.error.message || JSON.stringify(data.error))

  const choice = data.choices?.[0]
  if (!choice) return ""

  const message = choice.message
  const result = { content: message?.content || "" }

  if (message?.tool_calls && message.tool_calls.length) {
    result.toolCalls = message.tool_calls
  }

  if (result.toolCalls && result.toolCalls.length) {
    return result
  }

  return message?.content || ""
}

/**
 * #agent 模式专用 API（GLM，支持 tool calling）
 */
export async function agentChatCompletion(messages, options = {}) {
  const apiKey = String(cfg.agentApiKey || cfg.apiKey || "").replace(/[一-鿿\s]/g, "").trim()
  const apiUrl = String(cfg.agentApiUrl || cfg.apiUrl || "https://api.deepseek.com").replace(/[一-鿿]/g, "").trim()
  const model = options.model || cfg.agentModel || cfg.model || "glm-5.1"
  const stream = options.stream ?? false

  const maxTokens = Math.min(options.maxTokens || cfg.maxTokens || 8192, 393216)
  const url = `${apiUrl.replace(/\/+$/, "")}/chat/completions`
  const body = { model, messages, stream, max_tokens: maxTokens }

  if (options.tools && options.tools.length) {
    body.tools = options.tools
    body.tool_choice = options.tool_choice || "auto"
  }

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  })

  if (!res.ok) {
    const text = await res.text().catch(() => "")
    throw new Error(`Agent API ${res.status}: ${text.slice(0, 200)}`)
  }

  if (stream) return res
  const data = await res.json()
  if (data.error) throw new Error(data.error.message || JSON.stringify(data.error))

  const choice = data.choices?.[0]
  if (!choice) return ""

  const message = choice.message
  const result = { content: message?.content || "" }

  if (message?.tool_calls && message.tool_calls.length) {
    result.toolCalls = message.tool_calls
  }

  if (result.toolCalls && result.toolCalls.length) {
    return result
  }

  return message?.content || ""
}

export async function* streamChat(messages, options = {}) {
  const apiKey = String(cfg.apiKey || "").replace(/[一-鿿\s]/g, "").trim()
  const apiUrl = String(cfg.apiUrl || "https://api.deepseek.com").replace(/[一-鿿]/g, "").trim()
  const model = options.model || cfg.model || "deepseek-chat"

  const maxTokens = Math.min(options.maxTokens || cfg.maxTokens || 8192, 393216)
  const url = `${apiUrl.replace(/\/+$/, "")}/chat/completions`
  const body = { model, messages, stream: true, max_tokens: maxTokens }

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  })

  if (!res.ok) {
    const text = await res.text().catch(() => "")
    throw new Error(`API ${res.status}: ${text.slice(0, 200)}`)
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split("\n")
    buffer = lines.pop() || ""
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed || !trimmed.startsWith("data: ")) continue
      const data = trimmed.slice(6)
      if (data === "[DONE]") return
      try {
        const parsed = JSON.parse(data)
        const delta = parsed.choices?.[0]?.delta?.content
        if (delta) yield delta
      } catch {}
    }
  }
}
