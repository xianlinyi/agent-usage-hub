# 内置来源

来源清单按 [ccusage 20.0.26](https://github.com/ccusage/ccusage/tree/main/rust/adapters) 的 18 个适配器整理。本项目独立实现读取逻辑；npm 包不包含 ccusage。下表的路径均可通过 `collector.json` 的 `paths.<source>` 指定其他目录，值可为字符串或目录数组。默认也识别对应应用的数据目录环境变量。

| 来源 | 默认读取位置 | 用量结构 |
| --- | --- | --- |
| Claude Code | `~/.claude/projects`、`~/.config/claude/projects` | assistant JSONL 的 `message.usage` |
| Codex | `${CODEX_HOME:-~/.codex}/sessions`、`archived_sessions` | JSONL `token_count` 的单次用量，必要时从累计量求差 |
| OpenCode | `~/.local/share/opencode` | `opencode*.db` 的 message 表、旧版 storage/message JSON |
| Amp | `~/.local/share/amp/threads` | 线程 JSON 的 `usageLedger.events` 或 `messages.usage` |
| Droid | `~/.factory/sessions` | `.settings.json` 的 `tokenUsage` |
| Codebuff | `~/.config/manicode*` | `chat-messages.json` 的 assistant metadata usage |
| Hermes | `~/.hermes/state.db` | sessions SQLite 的累计用量 |
| Pi | `~/.pi/agent/sessions` | assistant message JSONL 的 usage |
| Goose | `~/.local/share/goose/sessions` 等 | sessions SQLite 的累计用量 |
| Kilo | `~/.local/share/kilo/kilo.db` | message SQLite 的 assistant data |
| Copilot CLI | `~/.copilot` | session shutdown 和 OTel JSONL |
| Gemini CLI | `~/.gemini/tmp` 下的 JSON/JSONL | Gemini 消息的 tokens 或 stats |
| Antigravity | `~/.gemini/antigravity*/conversations` 等 | gen_metadata / steps SQLite protobuf |
| Kimi | `~/.kimi`、`~/.kimi-code` | wire JSONL 的 turn usage |
| Qwen Code | `~/.qwen/projects`、`chats` | JSONL `usageMetadata` |
| OpenClaw | `~/.openclaw` 及旧名称目录 | assistant JSONL 或 agent SQLite transcript |
| Grok Build | `~/.grok/sessions` | updates JSONL 的 `turn_completed` |
| ZCode | `~/.zcode/cli/db/db.sqlite` | completed `model_usage` SQLite ledger |

## 准确性口径

- 每个来源都有独立的发现规则和格式样例测试。测试涵盖累计量差值、SQLite 读取、protobuf 字段、文件内容更新与删除的服务端同步。
- 缓存、推理和总量按源日志字段映射；缺失的模型与费用保持空值或来源默认值。没有模型价目表，因此费用不会和 ccusage 的价格估算完全一致。
- 已覆盖 Codex 单次用量及累计量求差与有边界标记的子会话重放、OpenCode v2 有效 fork 边界的复制行、Claude 单文件 sidechain 与 advisor、Copilot shutdown 累计量差值。Droid、Gemini、Qwen 独立记录的思考 Token 计入输出，同时在 `reasoningTokens` 标记。仍需对账的边界包括无边界标记的 Codex/Pi fork、Claude 跨文件 sidechain、OpenCode v2 仅有 session 汇总而缺消息的情况，以及 Copilot 多路 OTel 的交叉重复。当前代表性格式测试不能代替这些应用的真实安装验证。
- 源日志格式会变化；发生兼容问题时可通过 `paths` 指向测试目录重现，并为相应读取器添加回归样例。
