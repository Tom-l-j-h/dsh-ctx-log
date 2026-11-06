// dsh-ctx-log — 全量会话上下文轨迹记录器（DeepSeek Harness Host 插件）
//
// 把 DSH 会话事件逐条落盘为按日 JSONL，并在系统提示里注入轨迹文件位置、最近摘要与当前时间，
// 使上下文被自动压缩后仍能回读原始细节。
//
// 设计依据（DSH 0.2.x 文档与实测）：
//   - `session/event`：commit 后触发的 append feed，事件类型含 user/message · assistant/message ·
//     tool/call · tool/result · turn/end …
//   - `systemPrompt.context()`：每轮渲染的动态上下文（order 小的在前）
//   - 纯观察者：不 append 新事件类型（否则 Session 无法重开）、不改工具结果、不拦截调用
//
// 就绪顺序注意：systemPrompt 服务可能晚于本插件加载（冷启动）。
// 必须用 ctx.inject(['systemPrompt'], …) 延迟注册；在 apply() 里直接 ctx.get('systemPrompt')
// 判空后 return 会在冷启动时静默放弃注入（记录照常、注入消失，很难察觉）。

import { appendFileSync, mkdirSync, existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

export const name = 'dsh-ctx-log'

// 不导出 Config：Cordis 期待 schemastery Schema（带 .validate()），
// 纯 JSON Schema 会在激活时抛 `Cannot read properties of undefined (reading 'validate')`。
// 不声明 Config 即不校验，patch 里的 config 直接作为 apply 的第二参传入。

const DEFAULT_LOG_DIR = join(homedir(), '.dsh', 'ctx-log')

const DEFAULTS = {
  logDir: DEFAULT_LOG_DIR,
  maxTextChars: 4000,
  maxToolChars: 1500,
  injectTrail: true,
  trailRecentLines: 6,
  skipTypes: [], // 例：['tool/call', 'tool/result'] 可显著降低落盘敏感度
  watchFiles: [], // 例：[{ path: '/path/to/notes.md', label: '笔记' }]，用于「信息新鲜度」
}

/** 安全取文本：content 可能是 string / block[] / 其它结构，任何异常都退化为空串 */
function extractText(msg) {
  try {
    if (!msg) return ''
    const c = msg.content
    if (typeof c === 'string') return c
    if (Array.isArray(c)) {
      return c
        .map((b) => {
          if (typeof b === 'string') return b
          if (b && typeof b.text === 'string') return b.text
          if (b && typeof b.type === 'string') return `<${b.type}>`
          return ''
        })
        .filter(Boolean)
        .join(' ')
    }
    if (c == null) return ''
    return JSON.stringify(c)
  } catch {
    return ''
  }
}

/** 截断 */
function clip(s, n) {
  if (typeof s !== 'string') s = s == null ? '' : String(s)
  if (s.length <= n) return s
  return s.slice(0, n) + `…[+${s.length - n}]`
}

/** 脱敏：明显口令/密钥/令牌/URL 密码段一律打码（只是兜底，不保证覆盖所有敏感数据） */
const SCRUB = [
  [/((?:password|passwd|pwd|secret|token|pass)\s*[=:：]\s*)(\S+)/gi, '$1***'],
  [/((?:密码|口令|密钥)\s*[=:：]?\s*)(\S{3,})/g, '$1***'],
  [/(ANTHROPIC_(?:AUTH_TOKEN|API_KEY)\s*[=:：]\s*)(\S+)/gi, '$1***'],
  [/((?:api[_-]?key|access[_-]?key)\s*[=:：]\s*)(\S+)/gi, '$1***'],
  [/(bearer\s+)([A-Za-z0-9._~+/-]{12,})/gi, '$1***'],
  [/(\/\/[^/\s:@]+:)([^@\s]+)(@)/g, '$1***$3'],
]
function scrub(s) {
  if (!s) return s
  let out = s
  for (const [re, rep] of SCRUB) out = out.replace(re, rep)
  return out
}

export function apply(ctx, config) {
  const cfg = { ...DEFAULTS, ...(config || {}) }
  if (!cfg.logDir) cfg.logDir = DEFAULT_LOG_DIR
  const skip = new Set(Array.isArray(cfg.skipTypes) ? cfg.skipTypes : [])
  const counters = { total: 0, byType: Object.create(null) }
  let dayKey = ''
  let ready = false

  function currentFile() {
    const d = new Date()
    const y = d.getFullYear()
    const m = String(d.getMonth() + 1).padStart(2, '0')
    const day = String(d.getDate()).padStart(2, '0')
    dayKey = `${y}-${m}-${day}`
    return join(cfg.logDir, `ctx_${dayKey}.jsonl`)
  }

  function write(rec) {
    try {
      if (!ready) {
        mkdirSync(cfg.logDir, { recursive: true })
        ready = true
      }
      // 每次写入都重算日期：既避免「首次写入 dayKey 为空 → ctx_.jsonl」，
      // 又天然处理跨天翻转（不必额外定时器）。
      const path = currentFile()
      appendFileSync(path, JSON.stringify(rec) + '\n', 'utf8')
      counters.total += 1
      counters.byType[rec.type] = (counters.byType[rec.type] || 0) + 1
    } catch {
      // fire-and-forget 观察者失败不能影响主流程
    }
  }

  // ── 功能 1：全量记录 ────────────────────────────────────────────────
  ctx.on('session/event', (session, event) => {
    try {
      const type = event && event.type
      if (!type || skip.has(type)) return
      const ts = new Date(typeof event.time === 'number' ? event.time : Date.now()).toISOString()
      const sess = (() => {
        try {
          return session?.id ?? 'unknown'
        } catch {
          return 'unknown'
        }
      })()
      const base = { ts, sess, seq: event.seq, type }
      let rec = null

      switch (type) {
        case 'user/message':
          rec = { ...base, role: 'user', text: clip(scrub(extractText(event.data)), cfg.maxTextChars) }
          break
        case 'assistant/message':
          rec = {
            ...base,
            role: 'assistant',
            text: clip(scrub(extractText(event.data && event.data.message)), cfg.maxTextChars),
          }
          break
        case 'tool/call':
          rec = {
            ...base,
            tool: event.data && event.data.name,
            args: clip(scrub(String((event.data && event.data.arguments) ?? '')), cfg.maxToolChars),
          }
          break
        case 'tool/result': {
          const d = event.data || {}
          rec = {
            ...base,
            isError: !!d.error,
            errName: d.error && d.error.name,
            errCode: d.error && d.error.code,
            result: clip(scrub(extractText(d.message)), cfg.maxToolChars),
          }
          break
        }
        case 'turn/end':
          rec = {
            ...base,
            turn: event.data && event.data.turn,
            reason: event.data && event.data.reason && event.data.reason.kind,
          }
          break
        default:
          return // 只记这 5 类，其余丢弃（控制体积）
      }
      write(rec)
    } catch {
      // 观察者失败不影响主流程
    }
  })

  // ── 功能 2：系统提示注入轨迹位置 + 最近轨迹摘要（动态上下文） ─────
  // 摘要思路：按日分文件 → 一个文件里混着多个会话，因此不区分会话，
  // 直接取「最近落盘的 user/assistant 消息」尾部 N 条 —— 新会话/压缩后能立刻看到刚发生了什么。
  function dayKeyOf(d) {
    const y = d.getFullYear()
    const m = String(d.getMonth() + 1).padStart(2, '0')
    const day = String(d.getDate()).padStart(2, '0')
    return `${y}-${m}-${day}`
  }

  // 噪声过滤：DSH 每轮会注入一段运行时上下文（user 角色），它不是真人说的话。
  // 不过滤的话，摘要里全是 "Current runtime context..." 之类的样板文字。
  function isNoise(text) {
    const t = text.trim()
    if (!t) return true
    if (t.length < 8) return true
    if (/^Current runtime context\b/i.test(t)) return true
    if (/^Time sampled while preparing turn\b/i.test(t)) return true
    if (/^\{\s*"platform"\s*:/.test(t)) return true
    return false
  }

  function readTailMessages(key, maxLines) {
    const f = join(cfg.logDir, `ctx_${key}.jsonl`)
    if (!existsSync(f)) return []
    try {
      const lines = readFileSync(f, 'utf8').split('\n').filter(Boolean)
      const out = []
      for (const line of lines.slice(-maxLines)) {
        try {
          const o = JSON.parse(line)
          if (o && (o.type === 'user/message' || o.type === 'assistant/message')) {
            const text = String(o.text || '')
            if (isNoise(text)) continue
            out.push({
              ts: String(o.ts || ''),
              role: o.role === 'user' ? 'user' : 'assistant',
              text: text.replace(/\s+/g, ' ').slice(0, 110),
            })
          }
        } catch {
          /* 跳过坏行 */
        }
      }
      return out
    } catch {
      return []
    }
  }

  let sumCache = null
  let sumCacheAt = 0
  function getTrailSummary() {
    const now = Date.now()
    if (sumCache && now - sumCacheAt < 60_000) return sumCache // 60s 缓存，避免每轮读盘
    try {
      const d = new Date()
      let msgs = readTailMessages(dayKeyOf(d), 400)
      if (msgs.length < cfg.trailRecentLines) {
        const y = new Date(d.getTime() - 86400_000)
        msgs = readTailMessages(dayKeyOf(y), 400).concat(msgs)
      }
      sumCache = msgs.slice(-cfg.trailRecentLines)
      sumCacheAt = now
      return sumCache
    } catch {
      return []
    }
  }

  // ── 功能 3：注入「当前时间 + 信息新鲜度」 ────────────────────────────
  // 动机：模型只有每轮开头的采样时间，一轮跑到一半就不知道现在几点；
  // 更危险的是把两周前的旧信息当"现在"用。watchFiles 可监控关键文件的 mtime。
  let freshCache = null
  let freshCacheAt = 0

  function humanAge(ms) {
    const m = Math.floor(ms / 60000)
    if (m < 1) return '刚刚'
    if (m < 60) return `${m} 分钟前`
    const h = Math.floor(m / 60)
    if (h < 24) return `${h} 小时前`
    const d = Math.floor(h / 24)
    return `${d} 天前`
  }

  function buildFreshness() {
    const list = Array.isArray(cfg.watchFiles) ? cfg.watchFiles : []
    if (!list.length) return { lines: [], worst: 0 }
    const now = Date.now()
    if (freshCache && now - freshCacheAt < 60_000) return freshCache
    const lines = []
    let worst = 0
    for (const w of list) {
      const p = typeof w === 'string' ? w : w && w.path
      const label = (typeof w === 'object' && w && w.label) || String(p)
      if (!p) continue
      try {
        const st = statSync(p)
        const age = now - st.mtimeMs
        worst = Math.max(worst, age)
        const flag = age > 7 * 86400_000 ? ' ⚠️' : age > 3 * 86400_000 ? ' ⏳' : ''
        lines.push(`  · ${label}：${humanAge(age)}${flag}`)
      } catch {
        lines.push(`  · ${label}：⚠️ 读不到（文件不存在？）`)
        worst = Math.max(worst, 99 * 86400_000)
      }
    }
    freshCache = { lines, worst }
    freshCacheAt = now
    return freshCache
  }

  function buildNowBlock() {
    const d = new Date()
    const p2 = (n) => String(n).padStart(2, '0')
    const wd = '日一二三四五六'[d.getDay()]
    const pad = (n, l = 2) => String(n).padStart(l, '0')
    const off = -d.getTimezoneOffset() / 60
    const tz = `UTC${off >= 0 ? '+' : ''}${off}`
    const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
    let out = `【当前时间】${stamp}（星期${wd}，${tz}）`
    try {
      const { lines, worst } = buildFreshness()
      if (lines.length) {
        out += `\n【信息新鲜度】\n${lines.join('\n')}`
        if (worst > 7 * 86400_000) {
          out += `\n  ⚠️ **有信息已超过 7 天未更新 —— 引用前先核实，不要当成当前状态。**`
        }
      }
    } catch {
      /* 新鲜度拿不到不影响时间 */
    }
    out += `\n  提示：以上为每轮实时注入的时间，不要用旧记忆里的时间推算。`
    return out
  }

  // ⚠️ 用 ctx.inject 延迟注册，不能用 ctx.get('systemPrompt') 判空后 return：
  // 冷启动时本插件可能先于 systemPrompt 服务加载 → 注入会被静默跳过。
  ctx.inject(['systemPrompt'], (sctx) => {
    if (!cfg.injectTrail) return
    const sp = sctx.systemPrompt
    if (!sp || typeof sp.context !== 'function') return
    sctx.effect(() =>
      sp.context({
        name: 'dsh-ctx-log-trail',
        order: 500,
        text: () => {
          try {
            if (!dayKey) currentFile()
            const file = join(cfg.logDir, `ctx_${dayKey}.jsonl`)
            let out =
              `【上下文轨迹】本会话事件正全量落盘：\`${file}\`（本会话已记 ${counters.total} 条）。\n` +
              `用途：上下文被压缩或新会话丢失细节时，可直接 read 此文件回读原始记录（JSONL，每行一条：user/assistant/tool/turn 四类）。\n` +
              `注意：原始轨迹只是线索，不是结论；需要长期保留的内容请另行沉淀到笔记/记忆文件。`

            const recent = getTrailSummary()
            if (recent && recent.length) {
              out +=
                `\n\n【最近轨迹摘要·压缩后可回读全文】` +
                recent
                  .map((m) => {
                    const hhmm = m.ts.length >= 16 ? m.ts.slice(11, 16) : ''
                    const who = m.role === 'user' ? '👤用户' : '🤖助手'
                    return `\n  · ${hhmm} ${who}：${m.text}`
                  })
                  .join('')
            }
            return out
          } catch {
            return ''
          }
        },
      }),
    )

    // 独立的「当前时间 + 信息新鲜度」上下文（order 501，紧跟轨迹之后）
    sctx.effect(() =>
      sp.context({
        name: 'dsh-clock-now',
        order: 501,
        text: () => {
          try {
            return buildNowBlock()
          } catch {
            return ''
          }
        },
      }),
    )
  })

  // ── 功能 4：会话开始记录一行（便于事后按会话聚合） ─────────────────
  ctx.on('agent/created', (payload) => {
    try {
      const agent = payload && payload.agent
      write({
        ts: new Date().toISOString(),
        sess: (() => {
          try {
            return agent?.session?.id ?? 'unknown'
          } catch {
            return 'unknown'
          }
        })(),
        type: 'session/start',
        source: payload && payload.source,
        cwd: process.cwd(),
      })
    } catch {
      /* ignore */
    }
  })
}
