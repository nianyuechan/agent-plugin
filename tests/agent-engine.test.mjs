import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import {
  createAgent, HookBus, EVENTS, ToolRegistry, defineTool, SystemPrompt,
  SessionStore, Session, EVENT, TOOL_ABORTED_BEFORE_DISPATCH,
  PRUNE_MARKER, PRUNE_DEFAULTS, COMPACTION_DEFAULTS,
  pruneText, pruneToolResults, planCompaction, compactMessages, estimateMessages,
} from "../lib/agent/index.js"

/* ------------------------------ 测试用模型适配器 ------------------------------ */

function scriptedModel(steps, { contextWindow = 1000 } = {}) {
  let index = 0
  return {
    provider: "fake",
    model: "fake-1",
    contextWindow,
    calls: [],
    async complete({ systemPrompt, messages, tools, signal, onText }) {
      this.calls.push({ systemPrompt, messages, tools })
      const step = steps[Math.min(index++, steps.length - 1)]
      if (typeof step === "function") return await step({ signal, onText, messages })
      if (step.text) onText?.(step.text)
      return { text: step.text || "", toolCalls: step.toolCalls || [], usage: null }
    },
    async summarize() {
      return "摘要：用户要求处理一些文件。"
    },
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

const textTool = (name, extra = {}) => defineTool({
  name,
  description: `测试工具 ${name}`,
  parameters: { value: { type: "string", required: false, description: "值" } },
  async execute() { return `${name}-ok` },
  ...extra,
})

function call(id, name, args = {}) {
  return { id, type: "function", function: { name, arguments: JSON.stringify(args) } }
}

/* ============================== 1. 轮次与步骤 ============================== */

test("轮次与步骤：一次纯文本回复会关闭轮次并留下完整日志", async () => {
  const model = scriptedModel([{ text: "你好，我在。" }])
  const { agent, session } = await createAgent({ model, tools: new ToolRegistry(), config: { maxSteps: 5 } })

  agent.followup("你好")
  await agent.drive()

  const types = session.events.map(e => e.type)
  assert.equal(types[0], EVENT.SESSION_CREATED)
  assert.ok(types.includes(EVENT.TURN_START), "应打开轮次")
  assert.ok(types.includes(EVENT.STEP_START), "应打开步骤")
  assert.ok(types.includes(EVENT.USER_MESSAGE))
  assert.ok(types.includes(EVENT.ASSISTANT_MESSAGE))
  assert.equal(types[types.length - 1], EVENT.TURN_END, "轮次应被关闭")
  assert.equal(session.hasOpenTurn(), false)

  const messages = session.deriveMessages()
  assert.deepEqual(messages.map(m => m.role), ["user", "assistant"])
  assert.equal(messages[1].content, "你好，我在。")
})

test("模型上下文由日志派生：每一步都包含此前的工具结果", async () => {
  const tools = new ToolRegistry()
  tools.register(textTool("probe"))
  const model = scriptedModel([
    { toolCalls: [call("c1", "probe")] },
    { text: "完成。" },
  ])
  const { agent, session } = await createAgent({ model, tools, config: { maxSteps: 5 } })

  agent.followup("跑一下 probe")
  await agent.drive()

  assert.equal(model.calls.length, 2, "应当有两次模型请求（工具调用后继续）")
  const second = model.calls[1].messages
  const roles = second.map(m => m.role)
  assert.deepEqual(roles, ["user", "assistant", "tool"], "第二次请求应看到 user/assistant(tool_calls)/tool")
  assert.equal(second[1].tool_calls[0].id, "c1")
  assert.equal(second[2].tool_call_id, "c1")
  assert.equal(second[2].content, "probe-ok")
  assert.ok(session.events.some(e => e.type === EVENT.TOOL_RESULT))
})

test("工具参数校验失败会变成普通错误结果，而不是异常", async () => {
  const tools = new ToolRegistry()
  let executed = false
  tools.register(defineTool({
    name: "strict",
    parameters: { count: { type: "number", required: true } },
    async execute() { executed = true; return "should-not-run" },
  }))
  const model = scriptedModel([
    { toolCalls: [call("c1", "strict", { count: "不是数字" })] },
    { text: "好" },
  ])
  const { agent, session } = await createAgent({ model, tools, config: { maxSteps: 5 } })
  agent.followup("x")
  await agent.drive()

  assert.equal(executed, false, "参数非法时不应执行工具")
  const result = session.events.find(e => e.type === EVENT.TOOL_RESULT)
  assert.equal(result.data.isError, true)
  assert.match(result.data.content, /参数校验失败/)
})

/* ============================== 2. 工具调度 ============================== */

test("占位与上限：并行安全调用真正重叠，且不超过 maxParallelToolCalls", async () => {
  const tools = new ToolRegistry()
  let inFlight = 0
  let peak = 0
  for (const name of ["p1", "p2", "p3", "p4"]) {
    tools.register(defineTool({
      name,
      parameters: {},
      async execute() {
        inFlight += 1
        peak = Math.max(peak, inFlight)
        await sleep(60)
        inFlight -= 1
        return `${name}-ok`
      },
    }))
  }
  const model = scriptedModel([
    { toolCalls: [call("a", "p1"), call("b", "p2"), call("c", "p3"), call("d", "p4")] },
    { text: "done" },
  ])
  const { agent } = await createAgent({ model, tools, config: { maxParallelToolCalls: 2, maxSteps: 5 } })

  const started = Date.now()
  agent.followup("并行跑")
  await agent.drive()
  const elapsed = Date.now() - started

  assert.equal(peak, 2, `并发峰值应为 2，实际 ${peak}`)
  assert.ok(elapsed < 60 * 4, `不应退化成完全串行（耗时 ${elapsed}ms）`)
})

test("独占调用是排序屏障：并行组不会越过它", async () => {
  const tools = new ToolRegistry()
  const order = []
  tools.register(defineTool({
    name: "slow",
    parameters: {},
    async execute() { order.push("slow:start"); await sleep(80); order.push("slow:end"); return "slow-ok" },
  }))
  tools.register(defineTool({
    name: "exclusive",
    executionMode: "exclusive",
    parameters: {},
    async execute() { order.push("exclusive:start"); await sleep(10); order.push("exclusive:end"); return "exclusive-ok" },
  }))
  tools.register(defineTool({
    name: "after",
    parameters: {},
    async execute() { order.push("after:start"); await sleep(10); order.push("after:end"); return "after-ok" },
  }))

  const model = scriptedModel([
    { toolCalls: [call("a", "slow"), call("b", "exclusive"), call("c", "after")] },
    { text: "done" },
  ])
  const { agent, session } = await createAgent({ model, tools, config: { maxParallelToolCalls: 4, maxSteps: 5 } })
  agent.followup("跑")
  await agent.drive()

  assert.deepEqual(order, ["slow:start", "slow:end", "exclusive:start", "exclusive:end", "after:start", "after:end"])
  // 结果仍按模型顺序落日志，保证配对
  const results = session.events.filter(e => e.type === EVENT.TOOL_RESULT).map(e => e.data.name)
  assert.deepEqual(results, ["slow", "exclusive", "after"])
})

test("未知工具不会中断循环，而是产生错误结果", async () => {
  const model = scriptedModel([
    { toolCalls: [call("a", "不存在的工具")] },
    { text: "结束" },
  ])
  const { agent, session } = await createAgent({ model, tools: new ToolRegistry(), config: { maxSteps: 5 } })
  agent.followup("x")
  await agent.drive()

  const result = session.events.find(e => e.type === EVENT.TOOL_RESULT)
  assert.equal(result.data.isError, true)
  assert.match(result.data.content, /未知工具/)
  assert.equal(session.deriveMessages().at(-1).content, "结束")
})

/* ============================== 3. 钩子与策略 ============================== */

test("tools/pre-execute 的 deny 会阻止执行并给出错误结果", async () => {
  const hooks = new HookBus()
  const tools = new ToolRegistry(hooks)
  let executed = false
  tools.register(defineTool({
    name: "danger",
    parameters: {},
    async execute() { executed = true; return "boom" },
  }))
  hooks.on(EVENTS.TOOLS_PRE_EXECUTE, ({ call, decide }) => {
    if (call.name === "danger") return decide("deny", "该工具被策略禁止")
    return undefined
  })

  const model = scriptedModel([{ toolCalls: [call("a", "danger")] }, { text: "ok" }])
  const { agent, session } = await createAgent({ model, tools, hooks, config: { maxSteps: 5 } })
  agent.followup("x")
  await agent.drive()

  assert.equal(executed, false)
  const result = session.events.find(e => e.type === EVENT.TOOL_RESULT)
  assert.equal(result.data.isError, true)
  assert.match(result.data.content, /该工具被策略禁止/)
})

test("审批：应答者放行才执行，拒绝则不执行（allowed-once 是唯一授权）", async () => {
  const hooks = new HookBus()
  const tools = new ToolRegistry(hooks)
  const executed = []
  tools.register(defineTool({
    name: "needs-approval",
    parameters: {},
    async execute() { executed.push("ran"); return "approved-ok" },
  }))
  hooks.on(EVENTS.TOOLS_PRE_EXECUTE, ({ decide }) => decide("ask", "需要主人确认"))
  hooks.on(EVENTS.APPROVAL_REQUEST, () => "allowed-once")

  const model = scriptedModel([{ toolCalls: [call("a", "needs-approval")] }, { text: "ok" }])
  const { agent, session } = await createAgent({ model, tools, hooks, config: { maxSteps: 5 } })
  agent.followup("x")

  // 审批要求存在未结束的轮次
  await assert.rejects(
    () => agent.approval.request({ agent, tool: "t", callId: "c", reason: "r" }),
    /必须在未结束的轮次内发起/
  )

  await agent.drive()
  assert.deepEqual(executed, ["ran"])
  assert.ok(session.events.some(e => e.type === EVENT.APPROVAL_REQUEST))
  assert.equal(session.events.find(e => e.type === EVENT.APPROVAL_OUTCOME).data.outcome, "allowed-once")
})

test("审批：没有应答者时失败关闭（unavailable）", async () => {
  const hooks = new HookBus()
  const tools = new ToolRegistry(hooks)
  let executed = false
  tools.register(defineTool({ name: "risky", parameters: {}, async execute() { executed = true; return "x" } }))
  hooks.on(EVENTS.TOOLS_PRE_EXECUTE, ({ decide }) => decide("ask", "需要确认"))

  const model = scriptedModel([{ toolCalls: [call("a", "risky")] }, { text: "ok" }])
  const { agent, session } = await createAgent({ model, tools, hooks, config: { maxSteps: 5 } })
  agent.followup("x")
  await agent.drive()

  assert.equal(executed, false, "没有应答者时绝不能执行")
  assert.equal(session.events.find(e => e.type === EVENT.APPROVAL_OUTCOME).data.outcome, "unavailable")
})

test("approvalPolicy=never 时不询问任何人，直接拒绝", async () => {
  const hooks = new HookBus()
  const tools = new ToolRegistry(hooks)
  let asked = false
  tools.register(defineTool({ name: "risky", parameters: {}, async execute() { return "x" } }))
  hooks.on(EVENTS.TOOLS_PRE_EXECUTE, ({ decide }) => decide("ask", "需要确认"))
  hooks.on(EVENTS.APPROVAL_REQUEST, () => { asked = true; return "allowed-once" })

  const model = scriptedModel([{ toolCalls: [call("a", "risky")] }, { text: "ok" }])
  const { agent, session } = await createAgent({
    model, tools, hooks, approvalPolicy: "never", config: { maxSteps: 5 },
  })
  agent.followup("x")
  await agent.drive()

  assert.equal(asked, false, "never 策略不应触达应答者")
  assert.equal(session.events.find(e => e.type === EVENT.APPROVAL_OUTCOME)?.data.outcome, "denied")
})

test("agent/pre-step 可否决拟进入的步骤", async () => {
  const hooks = new HookBus()
  hooks.on(EVENTS.PRE_STEP, () => ({ decision: "deny", reason: "计划模式禁止执行" }))
  const model = scriptedModel([{ text: "不该被调用" }])
  const { agent, session } = await createAgent({
    model, tools: new ToolRegistry(), hooks, config: { maxSteps: 5 },
  })
  agent.followup("x")
  await agent.drive()

  assert.equal(model.calls.length, 0, "被否决的步骤不应调用模型")
  assert.ok(session.events.some(e => e.type === EVENT.ERROR))
})

/* ============================== 4. 取消 ============================== */

test("取消：已流式交付的文本以 interrupted 锚点保留", async () => {
  let aborted = false
  const model = scriptedModel([
    async ({ signal, onText }) => {
      onText("这是一段已经发出的文本")
      await new Promise(resolve => {
        if (signal.aborted) return resolve()
        signal.addEventListener("abort", resolve, { once: true })
      })
      aborted = true
      throw new Error("aborted")
    },
  ])
  const { agent, session } = await createAgent({ model, tools: new ToolRegistry(), config: { maxSteps: 5 } })
  agent.followup("开始长任务")

  const driving = agent.drive()
  await sleep(20)
  agent.cancel("用户取消")
  await driving

  assert.equal(aborted, true)
  const assistant = session.events.find(e => e.type === EVENT.ASSISTANT_MESSAGE)
  assert.equal(assistant.data.interrupted, true)
  assert.equal(assistant.data.message.content, "这是一段已经发出的文本")
  const end = session.events.filter(e => e.type === EVENT.TURN_END).at(-1)
  assert.equal(end.data.interrupted, true)
})

test("取消后未启动的工具调用也会落日志，保持配对完整", async () => {
  const tools = new ToolRegistry()
  tools.register(defineTool({
    name: "hang",
    parameters: {},
    async execute({ signal }) {
      await new Promise(resolve => {
        if (signal.aborted) return resolve()
        signal.addEventListener("abort", resolve, { once: true })
      })
      return "hung"
    },
  }))
  const model = scriptedModel([
    { toolCalls: [call("a", "hang"), call("b", "hang")] },
    { text: "never" },
  ])
  const { agent, session } = await createAgent({ model, tools, config: { maxSteps: 5, maxParallelToolCalls: 1 } })
  agent.followup("x")
  const driving = agent.drive()
  await sleep(30)
  agent.cancel("stop")
  await driving

  const results = session.events.filter(e => e.type === EVENT.TOOL_RESULT)
  const called = session.events.filter(e => e.type === EVENT.ASSISTANT_TOOL_CALLS).flatMap(e => e.data.toolCalls)
  assert.equal(results.length, called.length, "每个 tool_call 都必须有配对的 tool 结果")
  assert.ok(results.every(r => r.data.content.includes("aborted") || r.data.content.length > 0))
  // 派生上下文必须合法（不存在孤立 tool 消息）
  const messages = session.deriveMessages()
  const pending = new Set()
  for (const m of messages) {
    if (m.role === "assistant" && m.tool_calls) m.tool_calls.forEach(c => pending.add(c.id))
    if (m.role === "tool") {
      assert.ok(pending.has(m.tool_call_id), "tool 消息必须能配到对应的 tool_call")
      pending.delete(m.tool_call_id)
    }
  }
})

/* ============================== 5. 压缩与修剪 ============================== */

test("工具结果修剪使用 DSH 的确切阈值与标记", () => {
  assert.deepEqual(PRUNE_DEFAULTS, { thresholdChars: 8192, headChars: 4096, tailChars: 1024 })
  assert.equal(PRUNE_MARKER, "\n\n[... tool result middle pruned ...]\n\n")

  const short = "x".repeat(8192)
  assert.equal(pruneText(short), null, "恰好等于阈值不应修剪")

  const long = "a".repeat(4096) + "M".repeat(9000) + "b".repeat(1024)
  const pruned = pruneText(long)
  assert.ok(pruned, "超阈值应被修剪")
  assert.ok(pruned.text.startsWith("a".repeat(100)))
  assert.ok(pruned.text.includes(PRUNE_MARKER))
  assert.ok(pruned.text.endsWith("b".repeat(100)))
  assert.ok([...pruned.text].length < [...long].length)
  // 头部 + 标记 + 尾部不得超过阈值
  assert.ok([...pruned.text].length <= 8192)

  const { messages, prunedCount } = pruneToolResults([
    { role: "tool", tool_call_id: "1", content: long },
    { role: "user", content: "短消息" },
  ])
  assert.equal(prunedCount, 1)
  assert.equal(messages[1].content, "短消息", "非工具消息不受影响")
})

test("压缩计划：阈值 0.8、逐字保留 0.16，切点只落在轮次边界", () => {
  assert.equal(COMPACTION_DEFAULTS.thresholdRatio, 0.8)
  assert.equal(COMPACTION_DEFAULTS.retainRatio, 0.16)

  const big = "字".repeat(400)   // ≈100 token
  const messages = []
  for (let i = 0; i < 10; i++) {
    messages.push({ role: "user", content: `第${i}轮 ` + big })
    messages.push({ role: "assistant", content: "好的 " + big })
  }

  const below = planCompaction(messages, 100000)
  assert.equal(below.shouldCompact, false)
  assert.equal(below.threshold, 80000)

  const plan = planCompaction(messages, 1500)   // 阈值 1200，保留 240
  assert.equal(plan.shouldCompact, true)
  assert.equal(plan.threshold, 1200)
  assert.equal(plan.retainTokens, 240)
  assert.equal(messages[plan.cutAt].role, "user", "切点必须落在 user 消息处")
})

test("压缩不会拆散 tool_calls 与 tool 结果的配对", async () => {
  const messages = []
  for (let i = 0; i < 8; i++) {
    messages.push({ role: "user", content: `任务 ${i} ` + "字".repeat(200) })
    messages.push({ role: "assistant", tool_calls: [call(`c${i}`, "probe")] })
    messages.push({ role: "tool", tool_call_id: `c${i}`, content: "结果 " + "字".repeat(200) })
  }
  const result = await compactMessages({
    messages,
    contextWindow: 800,
    summarize: async () => "摘要内容",
  })
  assert.equal(result.compacted, true)
  assert.ok(result.summary)

  const pending = new Set()
  for (const m of result.retain) {
    if (m.role === "assistant" && m.tool_calls) m.tool_calls.forEach(c => pending.add(c.id))
    if (m.role === "tool") {
      assert.ok(pending.has(m.tool_call_id), "保留的尾部里 tool 必须配对")
      pending.delete(m.tool_call_id)
    }
  }
  assert.equal(result.retain[0].role, "user")
})

test("阈值越界时压缩会真正发生，并写入替代面事件", async () => {
  const tools = new ToolRegistry()
  tools.register(textTool("probe"))
  const model = scriptedModel([
    { toolCalls: [call("c1", "probe")] },
    { text: "第一轮结束" },
    { text: "第二轮结束" },
  ], { contextWindow: 60 })          // 极小上下文窗口：第二轮一进入就会越过阈值
  const { agent, session } = await createAgent({ model, tools, config: { maxSteps: 4, contextWindow: 60 } })

  agent.followup("开始 " + "字".repeat(300))
  agent.followup("再来一次 " + "字".repeat(300))
  await agent.drive()

  const summary = session.events.find(e => e.type === EVENT.COMPACT_SUMMARY)
  assert.ok(summary, "应写入 compact/summary 替代面事件")
  assert.match(summary.data.summary, /摘要/)
  const messages = session.deriveMessages()
  assert.equal(messages[0].role, "system", "替代面之后第一条应是摘要 system 消息")
  assert.match(messages[0].content, /历史摘要/)
})

/* ============================== 6. 会话持久化 ============================== */

test("JSONL 持久化与恢复：中断的轮次会被语义修复", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dsh-agent-"))
  const sessionId = "s-1"

  // 手工造一个「进程在工具调用中途崩掉」的日志
  const session = new Session({ id: sessionId })
  session.append(EVENT.SESSION_CREATED, { header: {}, createdAt: Date.now() })
  session.openTurn()
  session.nextStep()
  session.appendUserMessage("帮我读文件")
  session.appendAssistantMessage("开始处理")
  session.appendToolCalls([call("c9", "read_file", { path: "/tmp/x" })])
  await fs.writeFile(path.join(dir, `${sessionId}.jsonl`), session.toJSONL(), "utf8")

  const store = new SessionStore(dir)
  const resumed = await store.open(sessionId)

  assert.equal(resumed.hasOpenTurn(), false, "恢复后不应残留未结束的轮次")
  const end = resumed.events.filter(e => e.type === EVENT.TURN_END).at(-1)
  assert.equal(end.data.interrupted, true)
  const repair = resumed.events.filter(e => e.type === EVENT.TOOL_RESULT).at(-1)
  assert.equal(repair.data.toolCallId, "c9")
  assert.equal(repair.data.content, TOOL_ABORTED_BEFORE_DISPATCH)
  assert.equal(repair.data.isError, true)

  // 修复结果已经写回磁盘
  const onDisk = await fs.readFile(path.join(dir, `${sessionId}.jsonl`), "utf8")
  assert.ok(onDisk.includes(TOOL_ABORTED_BEFORE_DISPATCH))
  assert.equal(onDisk.trim().split("\n").length, resumed.seq)
})

test("createAgent(resume) 会接着已有会话继续", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dsh-agent-"))
  const model = scriptedModel([{ text: "第一次回复" }, { text: "第二次回复" }])

  const first = await createAgent({ model, tools: new ToolRegistry(), sessionDir: dir, sessionId: "s-2" })
  first.agent.followup("第一问")
  await first.agent.drive()

  const second = await createAgent({
    model, tools: new ToolRegistry(), sessionDir: dir, sessionId: "s-2", resume: true,
  })
  second.agent.followup("第二问")
  await second.agent.drive()

  const roles = second.session.deriveMessages().map(m => m.role)
  assert.deepEqual(roles, ["user", "assistant", "user", "assistant"])
  const lastRequest = model.calls.at(-1).messages
  assert.ok(lastRequest.some(m => m.content === "第一次回复"), "恢复的会话应带上历史")
})

/* ============================== 7. 提示词装配 ============================== */

test("提示词：段落按序用 \\n\\n 连接，persona complete 会遮蔽其他段落", () => {
  const prompt = new SystemPrompt()
  prompt.setPersona({ prefix: "你是 {{name}}。", suffix: "工作目录 {{cwd}}" })
  prompt.registerSection({ name: "tools", text: "## 工具\n- read_file" })
  prompt.registerSection({ name: "memory", text: "## 记忆\n- 无", runtime: true })

  const rendered = prompt.render({ name: "助手", cwd: "/work" })
  assert.match(rendered, /^你是 助手。/)
  assert.ok(rendered.includes("\n\n"))
  assert.ok(rendered.endsWith("工作目录 /work"))

  const complete = new SystemPrompt()
  complete.setPersona({ prefix: "只有我", complete: true })
  complete.registerSection({ name: "tools", text: "不该出现" })
  assert.equal(complete.render(), "只有我")

  const noRuntime = new SystemPrompt()
  noRuntime.registerSection({ name: "memory", text: "记忆段", runtime: true })
  noRuntime.registerSection({ name: "tools", text: "工具段" })
  noRuntime.setPersona({ includeRuntimeContext: false })
  assert.equal(noRuntime.render(), "工具段")
})

test("提示词：未注册的变量直接报错，不静默留空", () => {
  const prompt = new SystemPrompt()
  prompt.registerSection({ name: "x", text: "模型是 {{model}}" })
  assert.throws(() => prompt.render(), /unknown prompt variable "\{\{model\}\}"/)
  assert.match(prompt.render({ model: "deepseek-chat" }), /deepseek-chat/)
})

/* ============================== 8. 工具作用域 ============================== */

test("作用域 restrict 掩码取交集，并可解除", async () => {
  const registry = new ToolRegistry()
  registry.register(textTool("a"))
  registry.register(textTool("b"))
  registry.register(textTool("c"))

  const scope = registry.createScope()
  assert.equal(scope.visible().length, 3)

  const liftAllow = scope.restrict({ allow: ["a", "b"] })
  assert.deepEqual(scope.visible().map(t => t.name).sort(), ["a", "b"])

  scope.restrict({ deny: ["b"] })
  assert.deepEqual(scope.visible().map(t => t.name), ["a"], "掩码应取交集")

  liftAllow()
  assert.deepEqual(scope.visible().map(t => t.name).sort(), ["a", "c"], "解除 allow 后应恢复 c，但仍受 deny 限制")

  const blocked = await scope.execute("b", {}, {})
  assert.equal(blocked.isError, true)
  assert.match(blocked.content, /作用域限制/)
})

test("defineTool：DSL 转 JSON Schema，必填项与枚举被正确表达", () => {
  const tool = defineTool({
    name: "demo",
    parameters: {
      path: { type: "string", required: true, description: "路径" },
      mode: { type: "string", enum: ["read", "write"] },
      limit: { type: "integer" },
      tags: { type: "array", items: { type: "string" } },
    },
    async execute() { return "ok" },
  })
  assert.deepEqual(tool.parameters.required, ["path"])
  assert.equal(tool.parameters.properties.path.type, "string")
  assert.deepEqual(tool.parameters.properties.mode.enum, ["read", "write"])
  assert.equal(tool.parameters.properties.tags.items.type, "string")
  assert.equal(tool.executionMode, "parallel")
})

test("工具抛出异常会被转成错误结果，不会打断会话", async () => {
  const tools = new ToolRegistry()
  tools.register(defineTool({
    name: "boom",
    parameters: {},
    async execute() { throw new Error("内部炸了") },
  }))
  const model = scriptedModel([{ toolCalls: [call("a", "boom")] }, { text: "继续" }])
  const { agent, session } = await createAgent({ model, tools, config: { maxSteps: 5 } })
  agent.followup("x")
  await agent.drive()

  const result = session.events.find(e => e.type === EVENT.TOOL_RESULT)
  assert.equal(result.data.isError, true)
  assert.match(result.data.content, /内部炸了/)
  assert.equal(session.deriveMessages().at(-1).content, "继续")
})

/* ============================== 9. 收件箱 ============================== */

test("steer 在步骤之间插入输入，inject 不唤醒驱动器", async () => {
  const tools = new ToolRegistry()
  tools.register(textTool("probe"))
  const model = scriptedModel([
    { toolCalls: [call("c1", "probe")] },
    { text: "完成" },
  ])
  const { agent, session } = await createAgent({ model, tools, config: { maxSteps: 5 } })

  agent.followup("开始")
  agent.steer("补充：只看 tests 目录")
  agent.inject("（系统提示：现在时间 12:00）")
  await agent.drive()

  const users = session.deriveMessages().filter(m => m.role === "user")
  assert.equal(users.length, 3, "followup + steer + inject 都应进入上下文")
  assert.ok(users[1].content.includes("补充"))
})

test("whenIdle 在完全停稳后兑现", async () => {
  const model = scriptedModel([{ text: "好" }])
  const { agent } = await createAgent({ model, tools: new ToolRegistry(), config: { maxSteps: 3 } })
  agent.followup("x")
  const driving = agent.drive()
  await agent.whenIdle()
  await driving
  const summary = agent.getSummary()
  assert.equal(summary.openTurn, false)
  assert.deepEqual(summary.inbox, { prompts: 0, nextStep: 0, injections: 0 })
})
