import { exec } from "node:child_process"
import toolRegistry from "../registry.js"

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

    return new Promise(resolve => {
      const cwd = process.cwd()
      const timeout = setTimeout(() => resolve(`[超时] 命令执行超过30秒: ${command}`), 30000)
      exec(command, { cwd, maxBuffer: 1024 * 1024, shell: true }, (err, stdout, stderr) => {
        clearTimeout(timeout)
        let result = ""
        if (stdout) result += stdout
        if (stderr) result += (result ? "\n" : "") + stderr
        if (err) {
          if (!result) result = ""
          result += (result ? "\n" : "") + `[退出码: ${err.code}]`
        }
        return resolve(result.slice(0, 8000) || "(无输出)")
      })
    })
  },
})
