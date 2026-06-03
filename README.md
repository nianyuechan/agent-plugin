# agent-plugin

TRSS-Yunzai AI Agent 插件，支持 AI 对话、Agent 模式、Yunzai 插件调用。

## 安装

```bash
# 在 TRSS-Yunzai 目录下
git clone https://github.com/EVA-02-Studio/agent-plugin.git plugins/agent-plugin
```

## 配置

首次使用需设置 API Key：

```
#ai设置 apiKey sk-xxxxxxxx
```

支持所有 OpenAI 兼容 API：

```
#ai设置 apiUrl https://api.openai.com/v1
#ai设置 model gpt-4o
```

## 命令

| 命令 | 说明 |
|------|------|
| `#ai <消息>` | AI 对话 |
| `#ai流式 <消息>` | 流式对话（逐段发送） |
| `#agent <任务>` | Agent 模式（可执行命令/调用插件） |
| `#ai清除` | 清除对话历史 |
| `#ai历史` | 查看对话历史 |
| `#ai设置 <key> <value>` | 修改配置 |
| `#ai配置` | 查看当前配置 |
| `#ai帮助` | 显示帮助 |

## Agent 模式

AI 可通过 XML 标签执行操作：

- `<yunzai>指令</yunzai>` — 调用 Yunzai 插件指令（如 #签到 #帮助 #状态 等）
- `<cmd>Shell命令</cmd>` — 执行系统 Shell 命令
- `<read>文件路径</read>` — 读取文件内容
- `<readdir>目录路径</readdir>` — 列出目录内容
- `<done>总结</done>` — 任务完成

## 配置项

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| apiKey | - | DeepSeek/OpenAI API Key |
| apiUrl | https://api.deepseek.com | API 地址 |
| model | deepseek-chat | 模型名称 |
| systemPrompt | - | 对话系统提示词 |
| agentSystemPrompt | - | Agent 系统提示词 |
| maxTokens | 8192 | 最大输出 Token |
| maxHistoryPairs | 20 | 保留对话轮数 |
| agentMaxRounds | 10 | Agent 最大执行轮数 |
| streamInterval | 1500 | 流式发送间隔(ms) |
| streamChunkSize | 500 | 流式每段字符数 |

## 许可证

GPL-3.0
