import { exec } from "node:child_process"
import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import toolRegistry from "../registry.js"

toolRegistry.register({
  name: "execute_code",
  description: "在隔离的临时目录中执行代码。支持 Python 和 JavaScript/Node.js。用于运行计算、数据处理、脚本测试等。",
  usage: 'execute_code(code="print(1+1)", language="python")\nexecute_code(code="console.log(1+1)", language="javascript")',
  parameters: {
    type: "object",
    properties: {
      code: { type: "string", description: "要执行的代码" },
      language: {
        type: "string",
        description: "编程语言: python 或 javascript",
        enum: ["python", "javascript"],
      },
    },
    required: ["code", "language"],
  },
  handler: async args => {
    const { code, language } = args
    if (!code) return { error: "缺少 code 参数" }
    if (!["python", "javascript"].includes(language)) {
      return { error: "language 必须是 python 或 javascript" }
    }

    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-code-"))
    let cmd

    try {
      if (language === "python") {
        const filePath = path.join(tmpDir, "script.py")
        await fs.writeFile(filePath, code, "utf8")
        cmd = `python "${filePath}"`
      } else {
        const filePath = path.join(tmpDir, "script.js")
        await fs.writeFile(filePath, code, "utf8")
        cmd = `node "${filePath}"`
      }

      return new Promise(resolve => {
        const timeout = setTimeout(() => resolve("[超时] 代码执行超过15秒"), 15000)
        exec(cmd, { cwd: tmpDir, maxBuffer: 512 * 1024, shell: true }, (err, stdout, stderr) => {
          clearTimeout(timeout)
          let result = ""
          if (stdout) result += stdout
          if (stderr) result += (result ? "\n" : "") + stderr
          if (err && !result) result = `错误: ${err.message}`
          resolve(result.slice(0, 8000) || "(无输出)")
        })
      })
    } finally {
      try { await fs.rm(tmpDir, { recursive: true, force: true }) } catch {}
    }
  },
})
