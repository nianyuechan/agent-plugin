import test, { before } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

/**
 * 插件级端到端测试：用 stub 的 fetch 模拟 OpenAI 兼容接口，
 * 真正跑通 #agent → 引擎 → 工具 → 结果 → 回复 的全链路，
 * 并验证 DSH 风格的聊天内审批（允许 / 拒绝）。
 *
 * 注意：所有测试都在临时目录里跑（cwd 被切换），不会污染仓库。
 */

let agentCore
let app
let tmpDir
const sseQueue = []

function sse(...chunks) {
  const body = chunks.map(c => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n"
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } })
}

function textDelta(text) {
  return { choices: [{ delta: { content: text } }] }
}

function toolCallDelta(id, name, args) {
  return {
    choices: [{
      delta: {
        tool_calls: [{
          index: 0, id, type: "function",
          function: { name, arguments: JSON.stringify(args) },
        }],
      },
    }],
  }
}

function fakeEvent({ userId = 10001, group = null, replies = [] } = {}) {
  const e = {
    user_id: userId,
    self_id: 99999,
    msg: "#agent 测试",
    isPrivate: !group,
    isGroup: !!group,
    isMaster: true,
    group_id: group || undefined,
    group_name: group ? "测试群" : undefined,
    sender: { nickname: "主人", card: "" },
    member: { is_owner: true, is_admin: true },
    reply: async msg => { replies.push(msg); return { message_id: Date.now() } },
  }
  return e
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

before(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-plugin-e2e-"))
  await fs.mkdir(path.join(tmpDir, "plugins/agent-plugin"), { recursive: true })
  // 必须在 import 插件之前写好配置：config.js 在模块加载时读取它
  await fs.writeFile(
    path.join(tmpDir, "plugins/agent-plugin/config.yaml"),
    "apiKey: sk-test\ntoolApproval: true\nmaxParallelToolCalls: 4\n",
    "utf8"
  )
  process.chdir(tmpDir)

  // 宿主全局桩
  globalThis.logger = { info() {}, error() {}, warn() {}, red: s => s }
  globalThis.Bot = { makeLog() {}, makeForwardMsg: async x => x }
  globalThis.segment = { image: u => ({ type: "image", file: u }) }
  globalThis.plugin = class { constructor(o) { this.o = o } }

  globalThis.fetch = async () => {
    const next = sseQueue.shift()
    if (!next) throw new Error("没有排队的模型响应（测试脚本用完了）")
    return next
  }

  ;({ default: agentCore } = await import("../lib/core/agent.js"))
  const { AiAgent } = await import("../apps/AiAgent.js")
  app = new AiAgent()
})

test("插件可加载：指令表包含 agent 与审批应答", () => {
  const fncs = app.o.rule.map(r => r.fnc)
  assert.ok(fncs.includes("agent"))
  assert.ok(fncs.includes("approvalReply"))
  assert.equal(app.o.rule.find(r => r.fnc === "agent").permission, "master")
})

test("端到端：模型调用工具 → 工具结果进入会话 → 最终回复", async () => {
  await fs.writeFile(path.join(tmpDir, "sample.txt"), "hello-from-file", "utf8")

  sseQueue.push(
    sse(toolCallDelta("call_1", "read_file", { path: path.join(tmpDir, "sample.txt") })),
    sse(textDelta("文件内容是 hello-from-file"))
  )

  const e = fakeEvent({ userId: 20001 })
  const result = await agentCore.run(20001, e, "读一下 sample.txt", "你是测试助手", [])

  assert.match(result.text, /hello-from-file/, "最终回复应包含模型输出")

  const history = agentCore.getEngineHistory("20001:private", 50)
  const toolMessage = history.find(m => m.role === "tool")
  assert.ok(toolMessage, "会话里应有工具结果")
  assert.equal(toolMessage.content.trim(), "hello-from-file", "工具结果应原样进入会话日志")

  const summary = agentCore.getEngineSummary("20001:private")
  assert.ok(summary.seq > 0, "会话日志应已写入事件")
  assert.equal(summary.openTurn, false, "轮次应已关闭")
})

test("端到端审批：主人回复「允许」后高危工具才执行", async () => {
  sseQueue.push(
    sse(toolCallDelta("call_shell_1", "shell", { command: "echo approved-shell-ok" })),
    sse(textDelta("命令已执行"))
  )

  const replies = []
  const e = fakeEvent({ userId: 30001, replies })
  const running = agentCore.run(30001, e, "跑个命令", "你是测试助手", [])

  // 等待机器人发出审批提问
  for (let i = 0; i < 60 && !replies.some(r => String(r).includes("需要你确认")); i++) {
    await sleep(20)
  }
  const asked = replies.find(r => String(r).includes("需要你确认"))
  assert.ok(asked, "应发出审批提问")
  assert.match(asked, /shell/)

  // 主人回复「允许」（与 approvalReply 的规则一致）
  const replied = await app.approvalReply({ ...e, msg: "允许", reply: async () => {} })
  assert.equal(replied, true, "有挂起审批时应接管该消息")

  const result = await running
  assert.ok(result)

  const history = agentCore.getEngineHistory("30001:private", 50)
  const toolMessage = history.find(m => m.role === "tool")
  assert.ok(toolMessage, "审批通过后应产生工具结果")
  assert.match(toolMessage.content, /approved-shell-ok/, "shell 应真正执行（审批前不得执行）")
})

test("端到端审批：主人回复「拒绝」时工具绝不执行（失败关闭）", async () => {
  sseQueue.push(
    sse(toolCallDelta("call_shell_2", "shell", { command: "echo should-never-run" })),
    sse(textDelta("已取消"))
  )

  const replies = []
  const e = fakeEvent({ userId: 30002, replies })
  const running = agentCore.run(30002, e, "跑个命令", "你是测试助手", [])

  for (let i = 0; i < 60 && !replies.some(r => String(r).includes("需要你确认")); i++) {
    await sleep(20)
  }
  assert.ok(replies.some(r => String(r).includes("需要你确认")), "应发出审批提问")

  await app.approvalReply({ ...e, msg: "拒绝", reply: async () => {} })
  await running

  const history = agentCore.getEngineHistory("30002:private", 50)
  const toolMessage = history.find(m => m.role === "tool")
  assert.ok(toolMessage, "被拒绝也要有工具结果（保证配对完整）")
  assert.match(toolMessage.content, /审批未通过/, "应返回审批未通过")
  assert.doesNotMatch(toolMessage.content, /should-never-run/, "被拒绝的命令绝不能执行")
})

test("没有挂起审批时，审批应答规则会交回其它插件", async () => {
  const handled = await app.approvalReply({
    user_id: 40001, isPrivate: true, msg: "允许",
    reply: async () => { throw new Error("不应回复") },
  })
  assert.equal(handled, false, "无挂起审批时应返回 false，避免抢占普通消息")
})

test("工具开关仍然生效：allowShell=false 时 shell 被拒绝", async () => {
  const { saveConfig } = await import("../lib/config.js")
  saveConfig({ allowShell: false })

  sseQueue.push(
    sse(toolCallDelta("call_shell_3", "shell", { command: "echo blocked-by-policy" })),
    sse(textDelta("被策略拦截"))
  )

  const e = fakeEvent({ userId: 50001 })
  await agentCore.run(50001, e, "跑个命令", "你是测试助手", [])

  const history = agentCore.getEngineHistory("50001:private", 50)
  const toolMessage = history.find(m => m.role === "tool")
  assert.match(toolMessage.content, /已被配置禁用/, "配置开关应在新引擎里继续生效")
  assert.doesNotMatch(toolMessage.content, /blocked-by-policy/)

  saveConfig({ allowShell: true })
})
