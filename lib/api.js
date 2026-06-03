import cfg from "../lib/config.js"

export async function chatCompletion(messages, options = {}) {
  const apiKey = cfg.apiKey
  const apiUrl = cfg.apiUrl || "https://api.deepseek.com"
  const model = options.model || cfg.model || "deepseek-chat"
  const stream = options.stream ?? false

  const maxTokens = options.maxTokens || cfg.maxTokens || 8192
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
  const result = { content: message?.content || null }

  if (message?.tool_calls && message.tool_calls.length) {
    result.toolCalls = message.tool_calls
  }

  if (choice.finish_reason === "tool_calls") {
    return result
  }

  return message?.content || ""
}

export async function* streamChat(messages, options = {}) {
  const apiKey = cfg.apiKey
  const apiUrl = cfg.apiUrl || "https://api.deepseek.com"
  const model = options.model || cfg.model || "deepseek-chat"

  const maxTokens = options.maxTokens || cfg.maxTokens || 8192
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
