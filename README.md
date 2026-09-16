# agent-plugin

TRSS-Yunzai AI Agent 插件，支持 AI 对话、Agent 模式（工具调用）、Yunzai 插件调用、持久记忆。

## 特性

- **对话模式** `#ai`：普通聊天，支持图片输入（多模态）
- **流式对话** `#ai流式`：按段落边生成边发送
- **Agent 模式** `#agent`：模型自主调用工具完成多步任务
  - 调用其他 Yunzai 插件指令、执行系统命令、读写文件、执行代码
  - 群成员/管理员查询、持久记忆读写、发送图片
- **持久记忆**：全局记忆 + 按用户记忆，自动注入系统提示词
- **技能自动发现**：扫描 `plugins/` 目录，把已安装插件的指令写进全局记忆
- **上下文管理**：按「用户 + 群」隔离会话，超限自动压缩（不破坏工具调用配对）

## 环境要求

- TRSS-Yunzai（或兼容的 Yunzai 框架）
- Node.js >= 18.17（依赖 `AbortSignal.timeout`）

## 安装

在 TRSS-Yunzai 根目录下执行：

```bash
git clone https://github.com/nianyuechan/agent-plugin.git plugins/agent-plugin
cd plugins/agent-plugin && npm install
```

## 快速开始

```bash
# 1. 配置对话模型（OpenAI 兼容接口均可）
#ai设置 apiKey sk-xxxxxxxx
#ai设置 apiUrl https://api.deepseek.com
#ai设置 model deepseek-chat

# 2. 配置 Agent 模型（需要支持 function calling，可省略则回退上面的配置）
#ai设置 agentApiKey sk-xxxxxxxx
#ai设置 agentApiUrl https://open.bigmodel.cn/api/paas/v4
#ai设置 agentModel glm-4.6

# 3. 使用
#ai 你好
#agent 帮我看看当前目录下有哪些文件，并统计一下代码行数
```

## 命令

| 命令 | 说明 | 权限 |
|------|------|------|
| `#ai <消息>` | AI 对话（可带图片） | 受 `aiRateLimit` / `aiWhitelist` 限制 |
| `#ai流式 <消息>` | 流式对话（逐段发送） | 同上 |
| `#agent <任务>` | Agent 模式，可调用工具 | **仅主人** |
| `#ai清除` | 清除**当前群/当前私聊**的对话上下文 | 所有人 |
| `#ai历史` | 查看当前会话历史 | 所有人 |
| `#aireset` | 清空所有会话并重新初始化（保留记忆内容） | **仅主人** |
| `#ai技能` / `#ai技能 <名>` | 列出技能 / 查看技能详情 | 所有人 |
| `#ai记忆` | 查看全局与个人持久记忆 | 所有人 |
| `#ai设置 <key> <value>` | 修改配置 | **仅主人** |
| `#ai配置` | 查看当前配置（密钥脱敏） | **仅主人** |
| `#ai更新` | 从远端拉取插件更新（`--ff-only`，有本地改动会跳过） | **仅主人** |
| `#ai帮助` | 显示帮助 | 所有人 |

> 对话上下文按「用户 + 群」隔离：私聊内容不会串进群聊，A 群的上下文也不会在 B 群被复述。

## Agent 可用工具

| 工具 | 作用 | 安全开关 |
|------|------|----------|
| `yunzai` | 调用其他 Yunzai 插件指令（如 `#签到`） | — |
| `shell` | 执行系统 Shell 命令 | `allowShell` |
| `execute_code` | 在临时目录执行 Python / Node 代码 | `allowExecuteCode` |
| `read_file` / `list_dir` | 读取文件、列目录 | — |
| `write_file` | 写入/覆盖文件 | `allowFileWrite` |
| `delete_file` | 删除文件（不可撤销） | `allowFileDelete` |
| `send_image` | 发送图片到聊天 | `allowLocalFileImages`（本地文件） |
| `memory` | 保存全局/用户记忆 | — |
| `get_group_members` / `get_group_admins` | 群成员与管理员信息 | — |

## 配置项

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| `apiKey` / `apiUrl` / `model` | - / `https://api.deepseek.com` / `deepseek-chat` | 对话模式 |
| `agentApiKey` / `agentApiUrl` / `agentModel` | 回退到上面三项 / `glm-5.1` | Agent 模式 |
| `systemPrompt` / `agentSystemPrompt` | - | 自定义系统提示词 |
| `personality` | - | 人格设定 |
| `maxHistoryPairs` | 20 | 保留对话轮数 |
| `maxContextTokens` | 64000 | 触发上下文压缩的阈值 |
| `agentMaxRounds` | 10 | Agent 单次任务最大工具轮数 |
| `agentTaskTimeout` | 300000 | Agent 任务兜底超时（ms），防止锁死 |
| `requestTimeout` | 60000 | 单次 API 请求超时（ms） |
| `streamInterval` / `streamChunkSize` | 1500 / 500 | 流式发送间隔与分段大小 |
| `maxSessions` | 500 | 内存中保留的最大会话数（LRU 淘汰） |
| `shellTimeout` / `codeTimeout` | 30000 / 15000 | 命令与代码执行超时（ms） |
| `aiRateLimit` | 10 | 每用户每分钟 AI 请求上限，`0` 表示不限 |
| `aiWhitelist` | 空（所有人） | 允许使用 `#ai` 的 QQ 号，逗号分隔，`all` 表示所有人 |
| `aiRequireMaster` | false | 设为 true 后仅主人可用 `#ai` |
| `allowShell` / `allowExecuteCode` | true | 危险工具开关 |
| `allowFileWrite` / `allowFileDelete` | true | 文件写/删开关 |
| `allowLocalFileImages` | true | 是否允许把本地文件当图片发送 |

## 安全须知（重要）

1. **`#agent` 拥有等同于主人的权限**，且执行哪条指令由模型决定。任何被 Agent 读取的内容（文件、网页、图片文字）都可能影响它的决策，形成**间接提示词注入**。建议：
   ```bash
   #ai设置 allowShell false
   #ai设置 allowFileDelete false
   #ai设置 allowFileWrite false
   ```
   只在你盯着的时候临时打开。
2. **`#ai` 默认对所有人开放**，会消耗你的 API 额度。建议设置白名单或限流：
   ```bash
   #ai设置 aiWhitelist 你的QQ号,信任的QQ号
   #ai设置 aiRateLimit 5
   ```
3. **API Key 以明文保存在 `plugins/agent-plugin/config.yaml`**（已被 `.gitignore` 排除）。不要把它提交进任何仓库。
4. `send_image` 与文本中的图片链接会拒绝内网/本机地址（防 SSRF），本地文件发送可用 `allowLocalFileImages false` 关闭。

## 数据与隐私

持久记忆存放在 `plugins/agent-plugin/data/memory/`：

```
data/memory/MEMORY.txt          # 全局记忆（含插件指令清单）
data/memory/user_<QQ>.txt       # 每个用户的记忆
```

该目录已被 `.gitignore` 排除，**不会被提交**。如果想把用户数据彻底清掉，删除 `data/` 目录后执行 `#aireset`。

## 更新

```bash
#ai更新
```

等价于 `git pull --ff-only`：有未提交改动时会跳过并提示，不会自动 `stash`。**更新后需要重启机器人**才会生效。

## 目录结构

```
agent-plugin/
├── index.js                  # 插件入口：加载 apps/、初始化技能清单
├── apps/AiAgent.js           # 指令注册与消息处理
├── lib/
│   ├── config.js             # 配置读写与类型校验
│   ├── api.js                # OpenAI 兼容 API（含超时、流式解析）
│   ├── core/
│   │   ├── agent.js          # Agent 主循环
│   │   ├── context.js        # 会话上下文、压缩、LRU
│   │   └── prompt.js         # 系统提示词构建
│   ├── memory/manager.js     # 持久记忆
│   ├── skills/               # 插件技能扫描与注册
│   ├── tools/
│   │   ├── registry.js       # 工具注册与安全策略
│   │   └── builtin/          # 内置工具
│   └── utils/image.js        # 图片归一化与内网地址拦截
└── data/                     # 运行时数据（不入库）
```

## 许可证与来源

GPL-3.0（见 [LICENSE](LICENSE)）。

本插件派生自 [EVA-02-Studio/agent-plugin](https://github.com/EVA-02-Studio/agent-plugin)，遵循 GPL-3.0 保留原作者版权。当前维护者：[nianyuechan](https://github.com/nianyuechan)。
