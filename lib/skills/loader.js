import fs from "node:fs/promises"
import path from "node:path"
import skillRegistry from "./registry.js"

/**
 * 扫描 plugins/ 目录，自动发现 Yunzai 插件作为技能
 * 对齐 Hermes 的 skill 自动发现机制
 */
export async function scanSkills() {
  const now = Date.now()
  if (skillRegistry.lastScan > 0 && now - skillRegistry.lastScan < skillRegistry.scanTTL) {
    return
  }

  const pluginsDir = path.join(process.cwd(), "plugins")
  skillRegistry.clear()

  try {
    const entries = await fs.readdir(pluginsDir, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (entry.name === "agent-plugin") continue

      const pluginPath = path.join(pluginsDir, entry.name)
      const hasIndex = await fileExists(path.join(pluginPath, "index.js"))
      const hasApps = await fileExists(path.join(pluginPath, "apps"))

      if (hasIndex || hasApps) {
        const skill = {
          name: entry.name,
          path: pluginPath,
          enabled: true,
          description: await guessDescription(entry.name, pluginPath),
          commands: [],
        }

        await enrichSkill(skill, pluginPath)
        skillRegistry.register(entry.name, skill)
      }
    }
  } catch (err) {
    console.error("[Skills] 扫描失败:", err.message)
  }

  skillRegistry.lastScan = now
}

/**
 * 通过读取插件的 apps/ 下的文件来丰富 skill 信息
 */
async function enrichSkill(skill, pluginPath) {
  try {
    const appsPath = path.join(pluginPath, "apps")
    const hasApps = await fileExists(appsPath)

    if (hasApps) {
      const appFiles = await fs.readdir(appsPath)
      for (const file of appFiles) {
        if (!file.endsWith(".js")) continue
        try {
          const content = await fs.readFile(path.join(appsPath, file), "utf8")

          const nameMatch = content.match(/name:\s*["']([^"']+)["']/)
          const dscMatch = content.match(/dsc:\s*["']([^"']+)["']/)

          const cmdMatches = content.matchAll(/reg:\s*["']([^"']+)["']/g)
          const commands = []
          for (const m of cmdMatches) {
            const cmd = m[1].replace(/\\s\+\(\.\+\)/, "").replace(/\$$/, "")
              .replace(/\\\\/g, "\\")
            if (cmd && !commands.includes(cmd)) commands.push(cmd)
          }

          if (nameMatch && !skill.description) {
            skill.description = dscMatch ? `${nameMatch[1]}: ${dscMatch[1]}` : nameMatch[1]
          }
          skill.commands.push(...commands)
        } catch {}
      }
    }

    if (!skill.description) {
      const packageJsonPath = path.join(pluginPath, "package.json")
      if (await fileExists(packageJsonPath)) {
        try {
          const pkg = JSON.parse(await fs.readFile(packageJsonPath, "utf8"))
          if (pkg.description) skill.description = pkg.description
        } catch {}
      }
    }

    if (!skill.description) {
      skill.description = "Yunzai 插件"
    }
  } catch {}
}

async function guessDescription(name, pluginPath) {
  const guessMap = {
    "genshin": "原神插件 - 游戏数据查询",
    "xingqiong": "星穹铁道插件 - 游戏数据查询",
    "miao-plugin": "喵喵插件 - 多功能",
    "guoba-plugin": "锅巴插件 - Web 管理面板",
    "TRSS-Plugin": "TRSS 插件 - 多平台",
    "file-manager": "文件管理器 - 文件操作",
    "system-status": "系统状态 - 系统监控",
    "zhiqi-plugin": "知启插件 - AI绘画/语音",
    "chatgpt-plugin": "ChatGPT 插件",
    "py-plugin": "Python 插件",
  }
  return guessMap[name] || null
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath)
    return true
  } catch {
    return false
  }
}

export default { scanSkills }
