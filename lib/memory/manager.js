import fs from "node:fs/promises"
import path from "node:path"

const MEMORY_DIR = path.join(process.cwd(), "plugins/agent-plugin/data/memory")
const MEMORY_FILE = "MEMORY.txt"

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
  }

  async loadGlobalMemory() {
    try {
      await ensureDir()
      const content = await fs.readFile(getGlobalMemoryPath(), "utf8")
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
      const content = await fs.readFile(getUserMemoryPath(userId), "utf8")
      this._userMemories.set(userId, content.slice(0, 4000))
      return this._userMemories.get(userId)
    } catch {
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
    this._globalMemory = String(content).slice(0, 8000)
    this._pendingWrites.global = true
    this._markDirty()
  }

  async updateUserMemory(userId, content) {
    this._userMemories.set(userId, String(content).slice(0, 4000))
    this._pendingWrites.users.add(userId)
    this._markDirty()
  }

  _markDirty() {
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
    } catch {}
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

  memoryToolHandler(args) {
    const { type, key, value } = args
    if (type === "global") {
      return this.updateGlobalMemory(value)
    }
    if (type === "user") {
      return this.updateUserMemory(this._currentUserId, value)
    }
    return `未知记忆类型: ${type}`
  }
}

export const memoryManager = new MemoryManager()
export default memoryManager
