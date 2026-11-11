# evals — dsh-ctx-log 行为与成本评测

用 fake ctx 直接驱动 `index.js` 的 `apply()`：**不需要安装插件、不需要真实 DSH 宿主、不联网、不装依赖**。

## 跑法

```bash
cd dsh-ctx-log
node evals/run.mjs
```

- 退出码：全绿 `0`，任一失败 `1`（`process.exitCode = 1`）。
- 每个用例用 `mkdtemp(tmpdir())` 建独立临时目录，结束即删；不写仓库、不写 `~/.dsh`。
- 只用 Node 内置模块（`node:assert/strict`、`node:fs`、`node:os`、`node:path`），无需 `npm install`。
- 成本数字与完整结果见 [`RESULTS.md`](RESULTS.md)。

## 覆盖（8 组）

| # | 组 | 断言要点 |
|---|---|---|
| 1 | **落盘** | 5 类 `session/event` + `agent/created` → 当天 `ctx_<today>.jsonl` 共 6 行；逐行 `JSON.parse`；`user/message` 有 `role/text`、`assistant/message` 有 `role:'assistant'/text`、`tool/call` 有 `tool/args`、`tool/result` 有 `isError:boolean/result`、`turn/end` 有 `turn/reason`、`session/start` 有 `source`；5 类 session 事件 `seq` 依次为 1–5（`session/start` 无 `seq`） |
| 2 | **注入** | `systemPrompt.context()` 注册 2 段，name 为 `dsh-ctx-log-trail` / `dsh-clock-now`；trail 含当天文件名与「本会话已记」；clock 含「【当前时间】」 |
| 3 | **脱敏** | 含 `password=…` / `api_key=…` / `Bearer …` / `https://user:pw@host/x` 的消息落盘后敏感值消失、出现 `***` |
| 4 | **新鲜度** | `watchFiles: []` 时 clock 不含「【信息新鲜度】」；配置 tmp 文件且 mtime 设为 10 天前 → clock 含 label 与 `⚠️` |
| 5 | **噪声过滤** | 日志里预先写入 `Current runtime context. …` 与 `Time sampled while preparing turn …` → 最近摘要不出现这两个短语，真实消息保留 |
| 6 | **跨天摘要** | 昨天日志含「昨天的问题」、今天条数不足 `trailRecentLines` → trail 文本回看昨天 |
| 7 | **skipTypes** | `skipTypes: ['tool/call','tool/result']` → 这两类不落盘，仅 `user/message` + `turn/end` |
| 8 | **成本测量** | 日志 0 / 50 / 500 行三档，各算两段注入文本的 `chars` 与 `estTokens = round(chars/1.6)`，打印 markdown 表；断言 500 行档 estTokens > 0 行档，并用区间 sanity（0 行档 150–250、500 行档 350–500）防止成本表静默漂移 |

## 不覆盖什么（按设计）

- **没有 A/B 模型效果评测**：只验证插件行为与注入体积，不衡量「有摘要 vs 无摘要」对回答质量/任务成功率的影响。
- **estTokens 是代理值**：`chars ÷ 1.6`，不是 DeepSeek 分词器的真实 token 数；没有加载 tokenizer，也不联网调用分词接口。
- **没有真实 DSH 宿主**：fake ctx 只实现 `on` / `inject` / `systemPrompt.context` / `effect`，不覆盖 Cordis 生命周期、冷启动时服务晚于插件加载的顺序、profile 热重载、多会话并发。
- **没有跨进程/并发写**：`appendFileSync` 的原子性与多进程竞争未测。
- **没有边界穷举**：`maxTextChars` / `maxToolChars` 截断边界、时区/DST、超长工具输出只被间接触及。
