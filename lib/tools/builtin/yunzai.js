import toolRegistry from "../registry.js"

function extractText(msg) {
  if (typeof msg === "string") return msg
  if (Array.isArray(msg)) {
    return msg
      .map(item => {
        if (typeof item === "string") return item
        if (item?.type === "text") return item.text
        if (item?.type === "at") return `@${item.qq || item.user_id || ""}`
        if (item?.type === "image") return "[图片]"
        if (item?.type === "face") return "[表情]"
        if (item?.type === "reply") return ""
        return item?.text || item?.data?.text || ""
      })
      .filter(Boolean)
      .join("")
  }
  if (msg?.type === "text") return msg.text
  if (msg?.type === "image") return "[图片]"
  if (msg?.text) return msg.text
  return String(msg)
}

function extractImages(msg) {
  if (!msg || typeof msg === "string") return []
  if (msg?.type === "image") return [msg]
  if (Array.isArray(msg)) return msg.filter(item => item?.type === "image")
  return []
}

toolRegistry.register({
  name: "yunzai",
  description: "调用 TRSS-Yunzai 机器人插件指令。用于执行 Yunzai 的功能，如签到、查询、游戏数据等。可返回图片结果并转发到聊天。",
  usage: 'yunzai(command="#签到")',
  parameters: {
    type: "object",
    properties: {
      command: {
        type: "string",
        description: "Yunzai 插件指令，如 #签到 #帮助 #状态 等",
      },
    },
    required: ["command"],
  },
  handler: async (args, context) => {
    const command = args.command || ""
    if (!command) return { error: "缺少 command 参数" }

    const e = context?.event
    try {
      const replies = []
      const capturedImages = []

      function replyFn(msg) {
        if (!msg) return Promise.resolve({ message_id: Date.now() })
        const text = extractText(msg)
        if (text) replies.push(text)
        const imgs = extractImages(msg)
        for (const img of imgs) {
          capturedImages.push(img)
        }
        return Promise.resolve({ message_id: Date.now() })
      }

      // 基于原始事件构建，保留 group_id / group / friend 等完整上下文
      const fakeEvent = {
        ...e,
        // 仅覆盖消息相关字段
        message: [{ type: "text", text: command }],
        raw_message: command,
        message_id: `agent_${Date.now()}`,
        msg: command,

        isMaster: true,
        atBot: true,
        hasAlias: true,

        img: [],
        at: undefined,
        reply_id: undefined,
        file: undefined,

        logText: `[Agent]`,
        logFnc: "",

        reply: replyFn,
      }

      const PluginsLoader = (await import("../../../../../lib/plugins/loader.js")).default
      await PluginsLoader.deal(fakeEvent)

      for (let i = 0; i < 10 && !replies.length && !capturedImages.length; i++) {
        await new Promise(r => setTimeout(r, 300))
      }

      if (!context.images) context.images = []
      context.images.push(...capturedImages)

      const imgNote = capturedImages.length ? `\n[包含 ${capturedImages.length} 张图片，已转发至聊天]` : ""

      if (!replies.length && !capturedImages.length) {
        return `(插件 ${command} 无回复，可能该指令不存在或需要额外配置)`
      }
      if (!replies.length && capturedImages.length) {
        return `(插件 ${command} 返回了 ${capturedImages.length} 张图片)${imgNote}`
      }
      return replies.join("\n").slice(0, 8000) + imgNote
    } catch (err) {
      return `Yunzai 命令执行失败: ${err.message}`
    }
  },
})
