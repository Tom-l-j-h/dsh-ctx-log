# dsh-ctx-log · 上下文轨迹记录器

> DeepSeek Harness 插件：把会话事件逐条落盘为按日 JSONL，并在系统提示里注入轨迹位置、最近摘要与当前时间 —— **上下文被自动压缩后，细节还能捞回来**。

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

---

## 它解决什么问题

DSH 的上下文会自动压缩。压缩之后，早期的对话原文、工具调用的参数与结果会从模型视野里消失，于是开始出现：

- 忘记刚才查到的结论，重复造轮子；
- 把两周前的旧信息当成"现在"；
- 跨会话接手时，完全不知道上一轮发生了什么。

Claude Code / Codex 有会话钩子可以把原始轨迹落盘；**DSH 没有内置钩子，但它的 Host Event 足够做等价的事**。本插件订阅 `session/event`，把 5 类事件逐条追加到按日 JSONL，并在每一轮的系统提示里告诉模型"轨迹文件在哪、最近发生了什么、现在几点"。

## 功能

| # | 功能 | 说明 |
|---|------|------|
| 1 | **全量记录**（核心） | `session/event` → `user/message` / `assistant/message` / `tool/call` / `tool/result` / `turn/end` 五类逐条落盘，单条截断（默认 4000 字 / 1500 字）控制体积 |
| 2 | **轨迹注入** | 每轮系统提示注入：轨迹文件绝对路径、本会话记录条数、最近 N 条（默认 6）用户/助手消息摘要（跨天自动回看上一天） |
| 3 | **时间与新鲜度** | 每轮注入准确当前时间（避免一轮跑到一半不知道几点）；`watchFiles` 可监控关键文件 mtime，超 3 天标 ⏳、超 7 天标 ⚠️ 并提示"引用前先核实" |
| 4 | **会话开始行** | `agent/created` → 记 `session/start` 一行（含来源与 cwd），便于事后按会话聚合 |

落盘格式（每行一条，JSONL）：

```json
{"ts":"2026-11-06T07:31:22.123Z","sess":"session-…","seq":42,"type":"user/message","role":"user","text":"…"}
{"ts":"2026-11-06T07:31:25.456Z","sess":"session-…","seq":44,"type":"tool/call","tool":"pwsh","args":"…"}
{"ts":"2026-11-06T07:31:26.789Z","sess":"session-…","seq":45,"type":"tool/result","isError":false,"result":"…"}
```

默认目录：`~/.dsh/ctx-log/ctx_YYYY-MM-DD.jsonl`（Windows：`C:\Users\<你>\.dsh\ctx-log\`）。

## 安装

> DSH 桌面端的 profile 由 Electron 独占管理，**命令行装不了**，请走插件页。

1. 拿到本仓库目录：`git clone https://github.com/Tom-l-j-h/dsh-ctx-log.git`（或下载 zip 解压）；
2. DSH 桌面端 → 侧栏 **插件** → **添加插件** → 填本目录的**绝对路径**（也支持 git 地址 / npm 包名 / zip）；
3. 应用后等一次重载；
4. 验证：新开一轮对话，系统提示应出现 `【上下文轨迹】…` 行；同时 `~/.dsh/ctx-log/` 下出现当天的 `ctx_*.jsonl`。

本插件是 **Host 插件**，装进 profile 后对**所有会话**生效。改配置后：插件管理器里 disable → enable（热重载），或重启应用。

## 配置

插件通过 `cordis.patch.yml` 传配置（装好后也可在 profile 对应条目里改）：

```yaml
- insert:
    - id: dsh-ctx-log
      name: 'dsh-ctx-log'
      config:
        logDir: ''                 # 留空 = ~/.dsh/ctx-log
        maxTextChars: 4000         # 用户/助手消息单条上限
        maxToolChars: 1500         # 工具参数/结果单条上限
        injectTrail: true          # 是否注入轨迹路径与摘要
        trailRecentLines: 6        # 摘要条数
        skipTypes: []              # 例：['tool/call','tool/result'] 可显著降低落盘敏感度
        watchFiles: []             # 例：[{ path: 'D:/notes/TODO.md', label: '笔记' }]
```

| 字段 | 默认 | 说明 |
|---|---|---|
| `logDir` | `~/.dsh/ctx-log` | 落盘目录，不存在会自动创建 |
| `maxTextChars` | `4000` | 用户/助手消息截断长度 |
| `maxToolChars` | `1500` | 工具参数/结果截断长度 |
| `injectTrail` | `true` | 关闭则只记录、不注入（系统提示保持干净） |
| `trailRecentLines` | `6` | 注入的最近消息条数 |
| `skipTypes` | `[]` | 跳过的 session 事件类型（如只记对话不记工具） |
| `watchFiles` | `[]` | 信息新鲜度监控：`[{ path, label }]`，按 mtime 提示多久没更新 |

## ⚠️ 隐私与安全（必读）

- 本插件**默认记录对话全文 + 工具参数/结果**，这些内容里可能有密钥、个人信息、业务数据。
- `scrub()` 只是**兜底**：覆盖常见 `password=…`、`api_key=…`、`Bearer …`、URL 里 `//user:pass@` 的密码段，**不保证覆盖所有敏感信息**。
- 建议：
  - `logDir` 指到本机专用目录，**不要放进云同步盘 / 共享目录**；
  - 敏感环境用 `skipTypes: ['tool/call','tool/result']` 只留对话；
  - 定期清理（默认保留 7 天）：
    - Windows：`Get-ChildItem $env:USERPROFILE\.dsh\ctx-log\*.jsonl | Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-7) } | Remove-Item`
    - Linux/macOS：`find ~/.dsh/ctx-log -name 'ctx_*.jsonl' -mtime +7 -delete`
- 插件运行在 Harness Host 进程内，**拥有与应用同级的文件访问能力** —— 只装可信来源的插件。

## 兼容性

- 纯 Node 内置模块（`node:fs` / `node:path` / `node:os`），**无第三方依赖**；
- 不声明 `@deepseek-ai/*` 的 `peerDependencies` → 不会触发 DSH 的插件版本闸门；
- 在 **DSH Desktop 0.2.x（Windows）** 实测；其他版本请自测；
- 注入文本为中文（系统提示效果），英文界面下功能不受影响。

## 给插件作者的踩坑记录

这四条是开发本插件时**真实踩过**的坑，做 DSH 插件可直接参考：

1. **不要导出 `Config` 为纯 JSON Schema**：Cordis 期待的是 schemastery Schema（带 `.validate()`），否则激活时报 `Cannot read properties of undefined (reading 'validate')`。最省事：不导出 Config，`cordis.patch.yml` 里的 `config` 会直接作为 `apply(ctx, config)` 第二参传入。
2. **冷启动时注入会静默消失**：必须在 `apply()` 里用 `ctx.inject(['systemPrompt'], (sctx) => { … })` 延迟注册。若直接 `ctx.get('systemPrompt')` 判空后 `return`，冷启动会**记录正常、注入全无**（半瘫，极难察觉）。
3. **首次写入日期键为空**：生成 `ctx_.jsonl` 垃圾文件。每次写入时重算日期即可，顺便天然处理跨天翻转。
4. **运行时上下文会污染摘要**：DSH 每轮注入的 `Current runtime context…` 是 user 角色但非真人消息，需要过滤。
5. **目录链接安装的插件改代码不热更**：`plugin_manager` 里 disable → enable 会重新 apply 新代码，不用重启整个应用。
6. **观察者必须全 try/catch**：`session/event` 是 fire-and-forget；另外**不要 append 新的事件类型**（会让 Session 无法重开）。

## 工作原理

```
session/event ──(5 类过滤)──> appendFileSync ──> ~/.dsh/ctx-log/ctx_YYYY-MM-DD.jsonl
                                                        │
systemPrompt.context() ──每轮──> 读尾部 400 行 ──> 最近 6 条摘要 + 轨迹路径 + 当前时间/新鲜度
```

- 60 秒缓存，避免每轮读盘；
- 单行 ≤ 约 5.5 KB，一天几百行 ≈ 1~3 MB；
- 只按日分文件，不做轮转（用清理命令控制总量）。

## English

`dsh-ctx-log` is a DeepSeek Harness plugin that records every session event (user/assistant messages, tool calls/results, turn ends) into daily JSONL files and injects the log path, a short recent-message summary, and the current time into the system prompt — so details survive automatic context compaction. Built with Node built-ins only, no peer dependencies. **Privacy:** it stores conversation content by default; scrubbing is best-effort — use a local-only `logDir`, `skipTypes` for tool events, and retention cleanup. MIT licensed.

## License

[MIT](LICENSE) © 2026 Tom-l-j-h
