import toolRegistry from "../registry.js"

toolRegistry.register({
  name: "send_image",
  description: "向聊天发送图片。支持本地文件路径(file://...)、base64编码(base64://...)和网络URL(http(s)://...)格式。当需要展示图片结果时使用此工具。",
  usage: 'send_image(url="file:///path/to/image.png")',
  parameters: {
    type: "object",
    properties: {
      url: {
        type: "string",
        description: "图片地址，支持本地文件(file://...)、base64(base64://...)、网络URL(http(s)://...)",
      },
    },
    required: ["url"],
  },
  handler: async (args, context) => {
    const url = args.url
    if (!url) return { error: "缺少 url 参数" }

    const imageSegment = { type: "image", file: url }

    if (!context.images) context.images = []
    context.images.push(imageSegment)

    return `已添加图片到回复: ${url.slice(0, 200)}`
  },
})
