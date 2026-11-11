# 评测结果 — dsh-ctx-log evals

- **运行命令**：`cd dsh-ctx-log && node evals/run.mjs`
- **运行日期**：2026-11-11
- **Node**：v24.14.1
- **结果**：**PASS 8 / FAIL 0**，退出码 0

## 实际输出

```text
dsh-ctx-log evals · fake ctx harness
node v24.14.1 · 2026-11-11

PASS  1/8  落盘：5 类事件 + agent/created → 当天 JSONL 6 行，逐行可解析且字段齐全
PASS  2/8  注入：注册 2 段上下文（trail + clock），trail 含当天文件名与已记条数，clock 含当前时间
PASS  3/8  脱敏：password / api_key / Bearer / URL 密码段全部打码为 ***
PASS  4/8  新鲜度：watchFiles 为空不注入；文件 mtime 10 天前 → 注入 label 与 ⚠️
PASS  5/8  噪声过滤：运行时上下文样板文字不进最近摘要
PASS  6/8  跨天摘要：今天消息不足 trailRecentLines 时回看昨天
PASS  7/8  skipTypes：跳过 tool/call 与 tool/result 后不落盘这两类

  | 日志行数 | trail chars | clock chars | 合计 chars | estTokens |
  |---:|---:|---:|---:|---:|
  | 0 | 229 | 68 | 297 | 186 |
  | 50 | 566 | 68 | 634 | 396 |
  | 500 | 572 | 68 | 640 | 400 |

PASS  8/8  成本：0 / 50 / 500 行日志下两段注入文本的 chars 与 estTokens（chars÷1.6）

PASS 8 / FAIL 0
```

## 成本表与解读

测量口径：两段注入文本（`dsh-ctx-log-trail` + `dsh-clock-now`）的 `chars` 相加，`estTokens = round(chars / 1.6)`；`trailRecentLines` 用默认 6，`watchFiles` 为空。

| 日志行数 | trail chars | clock chars | 合计 chars | estTokens | 说明 |
|---:|---:|---:|---:|---:|---|
| 0 | 229 | 68 | 297 | **186** | 无摘要 = 每轮固定注入开销（轨迹路径 + 已记条数 + 当前时间） |
| 50 | 566 | 68 | 634 | **396** | 摘要取满 6 条 |
| 500 | 572 | 68 | 640 | **400** | 摘要仍只取尾部 6 条 |

- **每轮固定注入** ≈ **186 estTokens**（无摘要）；带默认 6 条摘要时 ≈ **400 estTokens/轮**，即 100 轮会话约 **40,000 estTokens**。
- 50 行与 500 行两档几乎相同（396 vs 400）：摘要固定取尾部 `trailRecentLines` 条，**注入成本由 `trailRecentLines` 决定，不随日志体积线性增长**。注意第 8 组是直接写合成日志、不经 `emit` 事件，两档的 `counters.total` 都是 0，所以「本会话已记 0 条」两档相同；这 +6 chars 来自合成消息编号本身——尾部 6 条由 `第 45..50` 变成 `第 495..500`，每条多 1 位数字（6 条 × 1 字符）。
- 精确字符数依赖 `logDir` 路径长度与时区偏移串（本表口径：Windows TEMP 下的 `mkdtemp` 路径 + UTC+8），换环境会有 ±几字符差异。
- `injectTrail: false` 时两段注入都不注册（`ctx.inject` 回调直接 return），成本为 0，落盘照常。

## 局限

- **代理估算，非分词器**：`chars ÷ 1.6` 只是量级参考；同一段中文在不同 tokenizer 下的真实 token 数可能差 ±20%，本仓库不加载 tokenizer、不联网。
- **未做模型 A/B**：没有衡量注入是否真的提升回答质量/任务成功率，也就无法判断 400 token/轮是否"值"。
- **摘要长度随配置与真实消息变化**：合成消息每条约 36 字，而插件单条摘要上限 110 字；真实长消息会让每轮成本高于本表。`trailRecentLines` 调大也线性增加成本。
- **路径长度差异**：实测中的轨迹路径是系统临时目录（`mkdtemp`），比真实的 `~/.dsh/ctx-log/…` 略长，实际固定开销会略低于 186。
- **未测真实宿主/跨进程**：fake ctx 不覆盖 Cordis 生命周期、多会话并发写、真实 DSH 冷启动顺序。

## 评测发现

- 第 3 组最初失败：`scrub()` 的 Bearer 规则要求 token ≥ 12 字符，`Bearer tok_abc`（7 字符）会**明文落盘**。已把阈值改为 ≥ 6 字符（`index.js` 一行），复跑全绿——这是本轮 eval 实际抓到的脱敏缺口。
