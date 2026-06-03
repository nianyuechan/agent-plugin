import fs from "node:fs/promises"
import path from "node:path"

const MEMORY_DIR = path.join(process.cwd(), "plugins/agent-plugin/data/memory")
const MEMORY_FILE = "MEMORY.txt"
const USER_FILE = "USER.txt"

function getGlobalMemoryPath() {
  return path.join(MEMORY_DIR, MEMORY_FILE)
}

function getUserMemoryPath() {
  return path.join(MEMORY_DIR, USER_FILE)
}

async function ensureDir() {
  await fs.mkdir(MEMORY_DIR, { recursive: true })
}

class MemoryManager {
  constructor() {
    this._dirty = false
    this._writeTimer = null
    this._globalMemory = null
    this._userMemory = null
  }

  async loadGlobalMemory() {
    try {
      await ensureDir()
      const p = getGlobalMemoryPath()
      const content = await fs.readFile(p, "utf8")
      this._globalMemory = content.slice(0, 8000)
      return this._globalMemory
    } catch {
      this._globalMemory = ""
      return ""
    }
  }

  async loadUserMemory(userId) {
    try {
      await ensureDir()
      const p = path.join(MEMORY_DIR, `user_${userId}.txt`)
      const content = await fs.readFile(p, "utf8")
      this._userMemory = content.slice(0, 4000)
      return this._userMemory
    } catch {
      this._userMemory = ""
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
    if (this._userMemory === null) {
      await this.loadUserMemory(userId)
    }
    return this._userMemory
  }

  async updateGlobalMemory(content) {
    this._globalMemory = String(content).slice(0, 8000)
    this.markDirty()
  }

  async updateUserMemory(userId, content) {
    this._userMemory = String(content).slice(0, 4000)
    this._userId = userId
    this.markDirty()
  }

  markDirty() {
    this._dirty = true
    this._scheduleFlush()
  }

  _scheduleFlush() {
    if (this._writeTimer) clearTimeout(this._writeTimer)
    this._writeTimer = setTimeout(() => this.flush(), 2000)
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
      if (this._globalMemory !== null) {
        await fs.writeFile(getGlobalMemoryPath(), this._globalMemory, "utf8")
      }
      if (this._userMemory !== null && this._userId) {
        const p = path.join(MEMORY_DIR, `user_${this._userId}.txt`)
        await fs.writeFile(p, this._userMemory, "utf8")
      }
    } catch {}
  }

  getMemoryPrompt() {
    const parts = []
    if (this._globalMemory && this._globalMemory.trim()) {
      parts.push("### 全局记忆\n" + this._globalMemory.trim())
    }
    if (this._userMemory && this._userMemory.trim()) {
      parts.push("### 用户信息\n" + this._userMemory.trim())
    }
    return parts.length ? parts.join("\n\n") : ""
  }

  /**
   * 让 AI 更新记忆的工具回调
   */
  memoryToolHandler(args) {
    const { type, key, value } = args
    if (type === "global") {
      return this.updateGlobalMemory(value)
    }
    if (type === "user") {
      return this.updateUserMemory(this._userId, value)
    }
    return `未知记忆类型: ${type}`
  }
}

export const memoryManager = new MemoryManager()
export default memoryManager
