import { exec } from "node:child_process"
import toolRegistry from "../registry.js"
import cfg from "../../config.js"

const MAX_OUTPUT = 8000

toolRegistry.register({
  name: "shell",
  description: "执行系统 Shell 命令。用于运行系统命令、脚本、编译代码、管理系统等。返回命令输出（最多8000字符）。",
  usage: 'shell(command="echo hello")',
  parameters: {
    type: "object",
    properties: {
      command: {
        type: "string",
        description: "要执行的 Shell 命令",
      },
    },
    required: ["command"],
  },
  handler: async (args, context) => {
    const command = args.command || args.cmd || ""
    if (!command) return { error: "缺少 command 参数" }

    const timeoutMs = Number(cfg.shellTimeout) > 0 ? Number(cfg.shellTimeout) : 30000
    const cwd = cfg.shellCwd ? String(cfg.shellCwd) : process.cwd()

    return new Promise(resolve => {
      let settled = false
      const done = text => {
        if (settled) return
        settled = true
        resolve(text)
      }

      const child = exec(
        command,
        { cwd, maxBuffer: 1024 * 1024, shell: true, timeout: timeoutMs, killSignal: "SIGKILL" },
        (err, stdout, stderr) => {
          let result = ""
          if (stdout) result += stdout
          if (stderr) result += (result ? "\n" : "") + stderr
          if (err) {
            if (err.killed || err.signal) {
              result += (result ? "\n" : "") + `[已超时并被终止，上限 ${timeoutMs}ms]`
            } else {
              result += (result ? "\n" : "") + `[退出码: ${err.code}]`
            }
          }
          done(result.slice(0, MAX_OUTPUT) || "(无输出)")
        }
      )

      // 兜底：即使回调没来也要释放，并真正杀掉子进程树
      const guard = setTimeout(() => {
        try { child.kill("SIGKILL") } catch {}
        done(`[超时] 命令执行超过 ${timeoutMs}ms，已终止: ${command}`)
      }, timeoutMs + 3000)
      guard.unref?.()

      child.on("error", err => done(`执行失败: ${err.message}`))
    })
  },
})
