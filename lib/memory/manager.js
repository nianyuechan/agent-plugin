import fs from "node:fs/promises"
import fsSync from "node:fs"
import path from "node:path"

const MEMORY_DIR = path.join(process.cwd(), "plugins/agent-plugin/data/memory")
const MEMORY_FILE = "MEMORY.txt"
const CATALOG_MARKER = "【已安装插件及指令清单】"
const GLOBAL_LIMIT = 8000
const USER_LIMIT = 4000

function logError(msg, err) {
  try {
    if (globalThis.logger?.error) globalThis.logger.error(`[Agent] ${msg}`, err?.message || "")
    else console.error(`[Agent] ${msg}`, err?.message || "")
  } catch {}
}

function getGlobalMemoryPath() {
  return path.join(MEMORY_DIR, MEMORY_FILE)
}

function getUserMemoryPath(userId) {
  return path.join(MEMORY_DIR, `user_${userId}.txt`)
}

async function ensureDir() {
  await fs.mkdir(MEMORY_DIR, { recursive: true })
}

class MemoryManager {
  constructor() {
    this._dirty = false
    this._writeTimer = null
    this._globalMemory = null
    this._userMemories = new Map()
    this._pendingWrites = { global: false, users: new Set() }
    this._installExitHooks()
  }

  /**
   * 进程退出前同步落盘，避免 debounce 期间被 kill 导致记忆丢失
   */
  _installExitHooks() {
    if (this._hooksInstalled) return
    this._hooksInstalled = true
    const sync = () => {
      try { this.flushSync() } catch (err) { logError("退出前写入记忆失败", err) }
    }
    process.on("exit", sync)
    process.on("beforeExit", () => {
      this.flush().catch(err => logError("beforeExit 写入记忆失败", err))
    })
  }

  async loadGlobalMemory() {
    try {
      await ensureDir()
      const content = await fs.readFile(getGlobalMemoryPath(), "utf8")
      this._globalMemory = content.slice(0, GLOBAL_LIMIT)
      return this._globalMemory
    } catch (err) {
      if (err.code !== "ENOENT") logError("读取全局记忆失败", err)
      this._globalMemory = ""
      return ""
    }
  }

  async loadUserMemory(userId) {
    try {
      await ensureDir()
      const content = await fs.readFile(getUserMemoryPath(userId), "utf8")
      this._userMemories.set(userId, content.slice(0, USER_LIMIT))
      return this._userMemories.get(userId)
    } catch (err) {
      if (err.code !== "ENOENT") logError(`读取用户记忆失败 (${userId})`, err)
      this._userMemories.set(userId, "")
      return ""
    }
  }

  async getGlobalMemory() {
    if (this._globalMemory === null) {
      await this.loadGlobalMemory()
    }
    return this._globalMemory
  }

  async getUserMemory(userId) {
    if (!this._userMemories.has(userId)) {
      await this.loadUserMemory(userId)
    }
    return this._userMemories.get(userId)
  }

  async updateGlobalMemory(content) {
    this._globalMemory = String(content).slice(0, GLOBAL_LIMIT)
    this._pendingWrites.global = true
    this._markDirty()
  }

  async updateUserMemory(userId, content) {
    this._userMemories.set(userId, String(content).slice(0, USER_LIMIT))
    this._pendingWrites.users.add(userId)
    this._markDirty()
  }

  /**
   * 把「插件指令清单」写入全局记忆：已有清单则原地替换，没有则前置。
   * 关键点：**绝不覆盖用户/AI 保存的其他记忆内容**。
   */
  async upsertSkillCatalog(catalog) {
    if (!catalog) return false
    const existing = (await this.getGlobalMemory()) || ""

    let merged
    if (!existing.includes(CATALOG_MARKER)) {
      merged = existing ? `${catalog}\n\n${existing}` : catalog
    } else {
      const start = existing.indexOf(CATALOG_MARKER)
      const after = existing.indexOf("\n【", start + CATALOG_MARKER.length)
      const head = existing.slice(0, start)
      const tail = after === -1 ? "" : existing.slice(after + 1)
      merged = `${head}${catalog}${tail ? "\n" + tail : ""}`
    }

    await this.updateGlobalMemory(merged.trim())
    await this.flush()
    return true
  }

  /**
   * 丢弃内存缓存并重新从磁盘加载（用于 #aireset）。
   * 会先落盘未保存的改动，避免丢数据。
   */
  async reload() {
    await this.flush()
    this._globalMemory = null
    this._userMemories.clear()
    this._pendingWrites = { global: false, users: new Set() }
    return this.getGlobalMemory()
  }

  _markDirty() {
    this._dirty = true
    this._scheduleFlush()
  }

  _scheduleFlush() {
    if (this._writeTimer) clearTimeout(this._writeTimer)
    this._writeTimer = setTimeout(() => {
      this.flush().catch(err => logError("定时写入记忆失败", err))
    }, 2000)
  }

  async flush() {
    if (!this._dirty) return
    this._dirty = false
    if (this._writeTimer) {
      clearTimeout(this._writeTimer)
      this._writeTimer = null
    }

    try {
      await ensureDir()
      if (this._globalMemory !== null && this._pendingWrites.global) {
        await fs.writeFile(getGlobalMemoryPath(), this._globalMemory, "utf8")
        this._pendingWrites.global = false
      }
      for (const userId of this._pendingWrites.users) {
        const data = this._userMemories.get(userId)
        if (data !== undefined) {
          await fs.writeFile(getUserMemoryPath(userId), data, "utf8")
        }
      }
      this._pendingWrites.users.clear()
    } catch (err) {
      // 写失败必须可见：重新标记为待写入，下次还会尝试
      this._dirty = true
      logError("写入记忆失败", err)
    }
  }

  /** 同步落盘版本，供 process 'exit' 钩子调用 */
  flushSync() {
    if (!this._dirty) return
    try {
      fsSync.mkdirSync(MEMORY_DIR, { recursive: true })
      if (this._globalMemory !== null && this._pendingWrites.global) {
        fsSync.writeFileSync(getGlobalMemoryPath(), this._globalMemory, "utf8")
        this._pendingWrites.global = false
      }
      for (const userId of this._pendingWrites.users) {
        const data = this._userMemories.get(userId)
        if (data !== undefined) {
          fsSync.writeFileSync(getUserMemoryPath(userId), data, "utf8")
        }
      }
      this._pendingWrites.users.clear()
      this._dirty = false
    } catch (err) {
      logError("同步写入记忆失败", err)
    }
  }

  getMemoryPrompt() {
    const parts = []
    if (this._globalMemory && this._globalMemory.trim()) {
      parts.push("### 全局记忆\n" + this._globalMemory.trim())
    }
    return parts.length ? parts.join("\n\n") : ""
  }

  getMemoryPromptForUser(userId) {
    const parts = []
    if (this._globalMemory && this._globalMemory.trim()) {
      parts.push("### 全局记忆\n" + this._globalMemory.trim())
    }
    const userMem = this._userMemories.get(userId)
    if (userMem && userMem.trim()) {
      parts.push("### 用户信息\n" + userMem.trim())
    }
    return parts.length ? parts.join("\n\n") : ""
  }
}

export const memoryManager = new MemoryManager()
export { CATALOG_MARKER }
export default memoryManager
