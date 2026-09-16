import YAML from "yaml"
import fs from "node:fs"
import path from "node:path"

const configFile = path.join(process.cwd(), "plugins/agent-plugin/config.yaml")

let config = {}

/** 通过 saveConfig 改过的键：写盘时只覆盖这些键，其余磁盘内容原样保留 */
const locallyChanged = new Set()

const NUMERIC_KEYS = new Set([
  "maxHistoryPairs", "maxTokens", "agentMaxRounds",
  "streamInterval", "streamChunkSize", "requestTimeout",
  "shellTimeout", "codeTimeout", "aiRateLimit", "maxSessions",
  "agentTaskTimeout", "maxContextTokens",
])

const BOOLEAN_KEYS = new Set([
  "allowShell", "allowFileWrite", "allowFileDelete", "allowExecuteCode",
  "allowLocalFileImages", "aiRequireMaster",
])

const TRUE_WORDS = ["true", "1", "on", "yes", "开", "启用", "是"]
const FALSE_WORDS = ["false", "0", "off", "no", "关", "禁用", "否"]

function loadConfig() {
  try {
    config = YAML.parse(fs.readFileSync(configFile, "utf8")) || {}
  } catch {
    config = {}
  }
}

loadConfig()

function logError(msg, err) {
  try {
    if (globalThis.Bot?.makeLog) globalThis.Bot.makeLog("error", [msg, err], "AiAgent")
    else console.error(msg, err)
  } catch {}
}

function logWarn(msg) {
  try {
    if (globalThis.logger?.warn) globalThis.logger.warn(msg)
    else console.warn(msg)
  } catch {}
}

/**
 * 字符串清洗：只去掉零宽字符与首尾空白。
 * 旧实现按 [\u4e00-\u9fff] 删除「中文」，会把用户粘贴时带入说明文字的
 * apiKey/apiUrl 静默改坏，排错极难，已移除。
 */
function normalizeString(key, value) {
  let s = String(value ?? "").replace(/[\u200b-\u200f\ufeff]/g, "")
  if (key === "apiUrl" || key === "agentApiUrl") {
    s = s.replace(/：/g, ":").replace(/／/g, "/").replace(/\s+/g, "")
  }
  if (key === "apiKey" || key === "agentApiKey") {
    s = s.replace(/\s+/g, "")
  }
  return s.trim()
}

function coerce(key, value) {
  if (NUMERIC_KEYS.has(key)) {
    const n = Number(value)
    if (!Number.isFinite(n) || n < 0) {
      throw new Error(`配置项 ${key} 需要数值（≥0），收到: "${value}"`)
    }
    return n
  }
  if (BOOLEAN_KEYS.has(key)) {
    if (typeof value === "boolean") return value
    const s = String(value).trim().toLowerCase()
    if (TRUE_WORDS.includes(s)) return true
    if (FALSE_WORDS.includes(s)) return false
    throw new Error(`配置项 ${key} 需要 true/false，收到: "${value}"`)
  }
  return normalizeString(key, value)
}

export default new Proxy({}, {
  get(_target, prop) {
    return config[prop]
  },
  has(_target, prop) {
    return prop in config
  },
  ownKeys() {
    return Reflect.ownKeys(config)
  },
  getOwnPropertyDescriptor(_target, prop) {
    if (!(prop in config)) return undefined
    return { value: config[prop], enumerable: true, configurable: true, writable: false }
  },
})

export function getRawConfig() {
  return config
}

/** 手动编辑 config.yaml 后可调用它重新载入 */
export function reloadConfig() {
  loadConfig()
  locallyChanged.clear()
  return config
}

export function hasApiKey() {
  return typeof config.apiKey === "string" && config.apiKey.trim().length > 0
}

export function maskSecret(value) {
  const s = String(value || "")
  if (s.length <= 8) return "****"
  return s.slice(0, 4) + "****" + s.slice(-4)
}

export function getMaskedKey() {
  return maskSecret(config.apiKey)
}

/**
 * 写入配置。
 * - 数值/布尔项做类型校验，非法值直接抛错（不再写进 NaN 毒化配置）
 * - 落盘时先合并磁盘上的最新内容，只覆盖本次改动的键，
 *   避免把用户手动编辑的内容整文件覆盖掉
 * @param {Record<string, unknown>} updates
 */
export function saveConfig(updates) {
  const cleaned = {}
  for (const [key, value] of Object.entries(updates)) {
    cleaned[key] = coerce(key, value)
  }

  Object.assign(config, cleaned)
  for (const key of Object.keys(cleaned)) locallyChanged.add(key)

  try {
    let disk = {}
    try {
      disk = YAML.parse(fs.readFileSync(configFile, "utf8")) || {}
    } catch {}

    const merged = { ...disk }
    for (const key of locallyChanged) merged[key] = config[key]

    fs.writeFileSync(configFile, YAML.stringify(merged), "utf8")
    config = merged
    locallyChanged.clear()

    if (cleaned.apiKey && !String(cleaned.apiKey).startsWith("sk-")) {
      logWarn("[Agent] apiKey 未以 sk- 开头，如果服务商不要求前缀可忽略此提示")
    }
  } catch (err) {
    logError("[Agent] 保存配置失败", err)
    throw err
  }
  return cleaned
}
