import YAML from "yaml"
import fs from "node:fs"
import path from "node:path"

const configFile = path.join(process.cwd(), "plugins/agent-plugin/config.yaml")

let config = {}

function loadConfig() {
  try {
    config = YAML.parse(fs.readFileSync(configFile, "utf8")) || {}
  } catch {
    config = {}
  }
}

loadConfig()

export default new Proxy(config, {
  get(target, prop) {
    return config[prop]
  },
})

export function hasApiKey() {
  return !!config.apiKey && typeof config.apiKey === "string" && config.apiKey.trim().length > 0
}

export function getMaskedKey() {
  if (!config.apiKey || config.apiKey.length <= 8) return "****"
  return config.apiKey.slice(0, 4) + "****" + config.apiKey.slice(-4)
}

export function saveConfig(updates) {
  if (updates.apiKey) {
    updates.apiKey = String(updates.apiKey).replace(/[\u4e00-\u9fff\s]/g, "").trim()
  }
  if (updates.apiUrl) {
    updates.apiUrl = String(updates.apiUrl).replace(/[\u4e00-\u9fff]/g, "").trim()
  }
  Object.assign(config, updates)
  try {
    fs.writeFileSync(configFile, YAML.stringify(config), "utf8")
  } catch (err) {
    Bot.makeLog("error", ["保存配置失败", err], "AiAgent")
  }
}
