import fs from "node:fs/promises"
import path from "node:path"

const EXT_MIME = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
}

/** 从文件头判断图片 MIME，比扩展名可靠 */
export function sniffMime(buf) {
  if (!buf || buf.length < 4) return null
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "image/png"
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg"
  if (buf.slice(0, 3).toString("latin1") === "GIF") return "image/gif"
  if (buf.slice(0, 4).toString("latin1") === "RIFF" && buf.slice(8, 12).toString("latin1") === "WEBP") return "image/webp"
  if (buf.slice(0, 2).toString("latin1") === "BM") return "image/bmp"
  return null
}

/**
 * 是否为内网 / 本机地址（防止把内网 URL 交给机器人去请求，形成 SSRF）
 */
export function isPrivateHost(urlStr) {
  let u
  try {
    u = new URL(urlStr)
  } catch {
    return true
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return true

  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, "")
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return true
  if (host === "::1" || host === "0.0.0.0") return true

  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (v4) {
    const [a, b] = v4.slice(1).map(Number)
    if (a === 127 || a === 10 || a === 0) return true
    if (a === 192 && b === 168) return true
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 169 && b === 254) return true
  }
  // 纯数字/十进制形式的 IPv4（如 2130706433）也拒绝
  if (/^\d+$/.test(host)) return true
  return false
}

/**
 * 把各种来源的图片地址转成大模型 API 可接受的格式
 * 支持 http(s)、data:、base64://、file://、本地绝对路径
 * @returns {Promise<string|null>} 无法识别时返回 null
 */
export async function toApiImageUrl(src) {
  if (!src || typeof src !== "string") return null
  const s = src.trim()
  if (!s) return null

  if (/^https?:\/\//i.test(s)) return s
  if (/^data:image\//i.test(s)) return s

  if (/^base64:\/\//i.test(s)) {
    const raw = s.slice("base64://".length).replace(/^\/+/, "")
    const buf = Buffer.from(raw, "base64")
    const mime = sniffMime(buf) || "image/png"
    return `data:${mime};base64,${buf.toString("base64")}`
  }

  let filePath = s
  if (/^file:\/\//i.test(s)) {
    try {
      filePath = decodeURIComponent(new URL(s).pathname)
      // Windows: /C:/xxx → C:/xxx
      if (/^\/[A-Za-z]:/.test(filePath)) filePath = filePath.slice(1)
    } catch {
      return null
    }
  }

  try {
    const buf = await fs.readFile(path.resolve(filePath))
    const mime = sniffMime(buf) || EXT_MIME[path.extname(filePath).toLowerCase()] || "image/png"
    return `data:${mime};base64,${buf.toString("base64")}`
  } catch {
    return null
  }
}

/** 批量归一化，丢弃无法识别的项 */
export async function toApiImageUrls(list) {
  if (!list) return []
  const arr = Array.isArray(list) ? list : [list]
  const out = []
  for (const item of arr) {
    const url = await toApiImageUrl(typeof item === "string" ? item : item?.file)
    if (url) out.push(url)
  }
  return out
}

/** 将图片数组构造成 OpenAI 兼容的多模态 content */
export function buildVisionContent(text, imageUrls) {
  return [
    { type: "text", text: text || "请描述这张图片" },
    ...imageUrls.map(url => ({ type: "image_url", image_url: { url } })),
  ]
}
