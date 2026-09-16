import { exec } from "node:child_process"
import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import toolRegistry from "../registry.js"
import cfg from "../../config.js"

const MAX_OUTPUT = 8000

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

    const timeoutMs = Number(cfg.codeTimeout) > 0 ? Number(cfg.codeTimeout) : 15000
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-code-"))

    let cmd
    if (language === "python") {
      const filePath = path.join(tmpDir, "script.py")
      await fs.writeFile(filePath, code, "utf8")
      cmd = `python "${filePath}"`
    } else {
      const filePath = path.join(tmpDir, "script.js")
      await fs.writeFile(filePath, code, "utf8")
      cmd = `node "${filePath}"`
    }

    // 注意：清理必须发生在命令真正执行完之后，
    // 不能放在 finally 里（return 的 Promise 未被 await 时会先执行 finally，
    // 导致脚本文件在进程读取前就被删除）。
    return await new Promise(resolve => {
      let settled = false
      const finish = async text => {
        if (settled) return
        settled = true
        try { await fs.rm(tmpDir, { recursive: true, force: true }) } catch {}
        resolve(text)
      }

      const child = exec(
        cmd,
        { cwd: tmpDir, maxBuffer: 512 * 1024, shell: true, timeout: timeoutMs, killSignal: "SIGKILL" },
        (err, stdout, stderr) => {
          let result = ""
          if (stdout) result += stdout
          if (stderr) result += (result ? "\n" : "") + stderr
          if (err) {
            if (err.killed || err.signal) {
              result += (result ? "\n" : "") + `[已超时并被终止，上限 ${timeoutMs}ms]`
            } else if (!result) {
              result = `错误: ${err.message}`
            }
          }
          finish(result.slice(0, MAX_OUTPUT) || "(无输出)")
        }
      )

      const guard = setTimeout(() => {
        try { child.kill("SIGKILL") } catch {}
        finish(`[超时] 代码执行超过 ${timeoutMs}ms，已终止`)
      }, timeoutMs + 3000)
      guard.unref?.()

      child.on("error", err => finish(`执行失败: ${err.message}`))
    })
  },
})
