import toolRegistry from "../registry.js"

toolRegistry.register({
  name: "memory",
  description: "保存重要信息到记忆。用于记住用户偏好、重要决定、任务背景等信息，在后续对话中自动加载。",
  usage: 'memory(type="user", key="preference", value="喜欢用简洁方式回答")\nmemory(type="global", key="project_path", value="C:/project")',
  parameters: {
    type: "object",
    properties: {
      type: {
        type: "string",
        description: "记忆类型: user（用户相关）或 global（全局）",
        enum: ["user", "global"],
      },
      key: {
        type: "string",
        description: "记忆键名",
      },
      value: {
        type: "string",
        description: "记忆内容",
      },
    },
    required: ["type", "key", "value"],
  },
  handler: async (args, context) => {
    const { type, key, value } = args
    if (!type || !key || value === undefined) {
      return "❌ 缺少必要参数: type, key, value"
    }

    const { default: memoryManager } = await import("../memory/manager.js")

    if (type === "user") {
      const userId = context?.userId || "unknown"
      await memoryManager.updateUserMemory(userId, `## ${key}\n${value}`)
      return `✅ 已保存用户记忆: ${key}`
    }

    if (type === "global") {
      await memoryManager.updateGlobalMemory(`## ${key}\n${value}`)
      return `✅ 已保存全局记忆: ${key}`
    }

    return `❌ 未知记忆类型: ${type} (应为 user 或 global)`
  },
})
