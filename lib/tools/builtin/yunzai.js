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

toolRegistry.register({
  name: "yunzai",
  description: "调用 TRSS-Yunzai 机器人插件指令。用于执行 Yunzai 的功能，如签到、查询、游戏数据等。",
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
      const fakeEvent = {
        message: [{ type: "text", text: command }],
        raw_message: command,
        msg: command,
        user_id: e?.user_id || 0,
        self_id: e?.self_id || 0,
        sender: e?.sender || { user_id: 0, nickname: "Agent" },
        message_type: "private",
        post_type: "message",
        sub_type: "friend",
        isPrivate: true,
        isGroup: false,
        isMaster: true,
        atBot: true,
        hasAlias: true,
        only_reply_at: true,
        img: [],
        logText: `[Agent:yunzai]`,
        friend: e?.friend || null,
        group: null,
        group_id: undefined,
        group_name: undefined,
        reply: async msg => {
          if (!msg) return
          const text = extractText(msg)
          if (text) replies.push(text)
          return { message_id: Date.now() }
        },
      }

      const PluginsLoader = (await import("../../../lib/plugins/loader.js")).default
      await PluginsLoader.deal(fakeEvent)

      if (!replies.length) return "(插件无回复)"
      return replies.join("\n").slice(0, 8000)
    } catch (err) {
      return `Yunzai 命令执行失败: ${err.message}`
    }
  },
})
