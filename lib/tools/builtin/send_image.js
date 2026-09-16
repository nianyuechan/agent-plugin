import toolRegistry from "../registry.js"
import cfg from "../../config.js"
import { isPrivateHost } from "../../utils/image.js"

toolRegistry.register({
  name: "send_image",
  description: "向聊天发送图片。支持本地文件路径(file://...)、base64编码(base64://...)、data:URL 和网络URL(http(s)://...)。当需要展示图片结果时使用此工具。",
  usage: 'send_image(url="file:///path/to/image.png")',
  parameters: {
    type: "object",
    properties: {
      url: {
        type: "string",
        description: "图片地址，支持本地文件(file://...)、base64(base64://...)、data:URL、网络URL(http(s)://...)",
      },
    },
    required: ["url"],
  },
  handler: async (args, context) => {
    const url = args.url
    if (!url || typeof url !== "string") return { error: "缺少 url 参数" }
    const trimmed = url.trim()

    const isRemote = /^https?:\/\//i.test(trimmed)
    const isInline = /^base64:\/\//i.test(trimmed) || /^data:image\//i.test(trimmed)
    const isLocal = !isRemote && !isInline

    // 本地文件（file:// 或裸路径）：模型不应把服务器上的任意文件发到聊天里
    if (isLocal && cfg.allowLocalFileImages === false) {
      return { error: "已禁用本地文件发送图片（allowLocalFileImages = false）" }
    }
    if (isLocal && /(^|[\\/])\.(ssh|aws|config|git)([\\/]|$)/i.test(trimmed)) {
      return { error: "拒绝发送敏感目录下的文件" }
    }
    // 远端 URL：拒绝内网/本机地址，避免借机器人发起 SSRF 请求
    if (isRemote && isPrivateHost(trimmed)) {
      return { error: "拒绝请求内网或本机地址（防 SSRF）" }
    }

    const imageSegment = { type: "image", file: trimmed }

    if (!context.images) context.images = []
    context.images.push(imageSegment)

    return `已添加图片到回复: ${trimmed.slice(0, 200)}`
  },
})
