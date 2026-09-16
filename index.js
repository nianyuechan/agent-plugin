import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

// 用模块自身位置定位 apps 目录，避免依赖 cwd 或插件目录名
const pluginDir = path.dirname(fileURLToPath(import.meta.url))
const appsDir = path.join(pluginDir, "apps")

const files = fs.readdirSync(appsDir).filter(file => file.endsWith(".js"))

let ret = []

files.forEach(file => {
  ret.push(import(`./apps/${file}`))
})

ret = await Promise.allSettled(ret)

let apps = {}
for (let i in files) {
  let name = files[i].replace(".js", "")

  if (ret[i].status != "fulfilled") {
    logger.error(`载入插件错误：${logger.red(name)}`)
    logger.error(ret[i].reason)
    continue
  }
  apps[name] = ret[i].value[Object.keys(ret[i].value)[0]]
}

// 初始化：扫描全部插件指令并写入全局记忆（只替换清单段落，保留其他记忆内容）
;(async () => {
  try {
    const { scanSkills } = await import("./lib/skills/loader.js")
    const skillRegistry = (await import("./lib/skills/registry.js")).default
    const memoryManager = (await import("./lib/memory/manager.js")).default

    await scanSkills()
    const catalog = skillRegistry.getFullSkillCatalog()
    if (!catalog) return

    await memoryManager.upsertSkillCatalog(catalog)
    const skills = skillRegistry.getEnabled()
    logger.info(`[Agent] 已扫描 ${skills.length} 个插件，指令清单已写入全局记忆`)
  } catch (err) {
    logger.error(`[Agent] 插件指令扫描失败: ${err.message}`)
  }
})()

export { apps }
