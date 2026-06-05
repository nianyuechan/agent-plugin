import fs from "node:fs"

const files = fs.readdirSync("./plugins/agent-plugin/apps").filter(file => file.endsWith(".js"))

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

// 初始化：扫描全部插件指令并写入全局记忆
;(async () => {
  try {
    const { scanSkills } = await import("./lib/skills/loader.js")
    const skillRegistry = (await import("./lib/skills/registry.js")).default
    const memoryManager = (await import("./lib/memory/manager.js")).default

    await scanSkills()
    const catalog = skillRegistry.getFullSkillCatalog()
    if (catalog) {
      const existing = await memoryManager.getGlobalMemory()
      const marker = "【已安装插件及指令清单】"

      if (!existing || !existing.includes(marker)) {
        // 首次写入：清单放在最前面，保留已有记忆
        const newMemory = existing ? catalog + "\n\n" + existing : catalog
        await memoryManager.updateGlobalMemory(newMemory)
      } else {
        // 替换旧清单：去掉旧清单段落，插入新清单
        const updated = existing.replace(
          new RegExp(marker + "[\\s\\S]*?(?=\\n【|$)"),
          catalog
        )
        // 如果 replace 没有匹配到完整段落，直接前置
        if (updated === existing) {
          const newMemory = catalog + "\n\n" + existing.replace(marker, "")
          await memoryManager.updateGlobalMemory(newMemory)
        } else {
          await memoryManager.updateGlobalMemory(updated)
        }
      }
      await memoryManager.flush()
      const skills = skillRegistry.getEnabled()
      logger.info(`[Agent] 已扫描 ${skills.length} 个插件，指令清单已写入全局记忆`)
    }
  } catch (err) {
    logger.error(`[Agent] 插件指令扫描失败: ${err.message}`)
  }
})()

export { apps }
