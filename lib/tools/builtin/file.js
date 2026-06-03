import fs from "node:fs/promises"
import path from "node:path"
import toolRegistry from "../registry.js"

function formatSize(bytes) {
  if (bytes === 0) return "0B"
  const units = ["B", "KB", "MB", "GB"]
  const i = Math.floor(Math.log(bytes) / Math.log(1024))
  return (bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0) + units[i]
}

const MAX_READ_SIZE = 100 * 1024

toolRegistry.register({
  name: "read_file",
  description: "读取文件内容。用于查看代码、配置、日志等文本文件。最大100KB。",
  usage: 'read_file(path="/path/to/file.txt")',
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "文件绝对路径" },
    },
    required: ["path"],
  },
  handler: async args => {
    try {
      const filePath = path.resolve(args.path)
      const stat = await fs.stat(filePath)
      if (stat.isDirectory()) return `"${args.path}" 是一个目录，请使用 list_dir`
      if (stat.size > MAX_READ_SIZE) return `文件过大: ${formatSize(stat.size)} (最大 ${formatSize(MAX_READ_SIZE)})`
      const content = await fs.readFile(filePath, "utf8")
      return content.slice(0, 8000)
    } catch (err) {
      return `读取失败: ${err.message}`
    }
  },
})

toolRegistry.register({
  name: "write_file",
  description: "写入文件内容。用于创建或覆盖文件。注意：此操作不可撤销。",
  usage: 'write_file(path="/path/to/file.txt", content="文件内容")',
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "文件绝对路径" },
      content: { type: "string", description: "要写入的内容" },
    },
    required: ["path", "content"],
  },
  handler: async args => {
    try {
      const filePath = path.resolve(args.path)
      await fs.mkdir(path.dirname(filePath), { recursive: true })
      await fs.writeFile(filePath, args.content, "utf8")
      return `✅ 已写入: ${filePath}`
    } catch (err) {
      return `写入失败: ${err.message}`
    }
  },
})

toolRegistry.register({
  name: "list_dir",
  description: "列出目录内容。显示文件和子目录。",
  usage: 'list_dir(path="/path/to/dir")',
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "目录绝对路径" },
    },
    required: ["path"],
  },
  handler: async args => {
    try {
      const dirPath = path.resolve(args.path)
      const entries = await fs.readdir(dirPath, { withFileTypes: true })
      if (!entries.length) return "(空目录)"

      const lines = []
      for (const entry of entries.slice(0, 200)) {
        const icon = entry.isDirectory() ? "📁" : entry.isFile() ? "📄" : "🔗"
        let size = ""
        if (entry.isFile()) {
          try {
            const stat = await fs.stat(path.join(dirPath, entry.name))
            size = ` (${formatSize(stat.size)})`
          } catch {}
        }
        lines.push(`${icon} ${entry.name}${size}`)
      }
      return lines.join("\n")
    } catch (err) {
      return `列目录失败: ${err.message}`
    }
  },
})

toolRegistry.register({
  name: "delete_file",
  description: "删除文件。注意：此操作不可撤销。",
  usage: 'delete_file(path="/path/to/file.txt")',
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "文件绝对路径" },
    },
    required: ["path"],
  },
  handler: async args => {
    try {
      const filePath = path.resolve(args.path)
      await fs.unlink(filePath)
      return `✅ 已删除: ${filePath}`
    } catch (err) {
      return `删除失败: ${err.message}`
    }
  },
})
