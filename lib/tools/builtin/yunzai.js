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
      const userId = e?.user_id || 10000
      const selfId = e?.self_id || 10001

      // 构造 reply 函数（必须用普通函数以便 .bind() 工作）
      function replyFn(msg) {
        if (!msg) return Promise.resolve({ message_id: Date.now() })
        const text = extractText(msg)
        if (text) replies.push(text)
        return Promise.resolve({ message_id: Date.now() })
      }

      const fakeEvent = {
        // 基础消息
        message: [{ type: "text", text: command }],
        raw_message: command,
        message_id: `agent_${Date.now()}`,

        // 用户信息
        user_id: userId,
        self_id: selfId,
        sender: {
          user_id: userId,
          nickname: "Agent",
          card: "Agent",
        },

        // 消息类型：使用私聊模式避免 onlyReplyAt 检查
        // 私聊模式下 onlyReplyAt 始终返回 true
        message_type: "private",
        post_type: "message",
        sub_type: "friend",
        notice_type: undefined,

        // 权限标志
        isPrivate: true,
        isGroup: false,
        isMaster: true,
        atBot: true,
        hasAlias: true,

        // 消息内容
        img: [],
        at: undefined,
        reply_id: undefined,
        file: undefined,

        // 日志
        logText: `[Agent]`,
        logFnc: "",

        // 群/好友对象（设为 null 避免调用出错）
        friend: null,
        group: null,
        group_id: undefined,
        group_name: undefined,

        // reply 函数（普通函数，支持 .bind()）
        reply: replyFn,
      }

      const PluginsLoader = (await import("../../../../../lib/plugins/loader.js")).default
      await PluginsLoader.deal(fakeEvent)

      // deal() 会 await 插件函数，大多数回复此时已就绪
      // 对少数未 await reply() 的插件，轮询等待
      for (let i = 0; i < 10 && !replies.length; i++) {
        await new Promise(r => setTimeout(r, 300))
      }

      if (!replies.length) return `(插件 ${command} 无回复，可能该指令不存在或需要额外配置)`
      return replies.join("\n").slice(0, 8000)
    } catch (err) {
      return `Yunzai 命令执行失败: ${err.message}`
    }
  },
})
