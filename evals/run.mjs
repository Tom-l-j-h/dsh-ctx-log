// dsh-ctx-log evals — fake-ctx harness
//
// 用法（在仓库根目录）：node evals/run.mjs
//
// 公开仓库约束：
//   - 源码里不写任何本机绝对路径；临时目录一律 mkdtemp(tmpdir())，用例结束即删。
//   - 除 Node 内置模块外只 import 仓库内的 ../index.js，不装依赖、不连网。
//   - 不打印运行期路径 / 日志原文，避免把本机信息带进输出。
//
// 覆盖 8 组行为：落盘、注入、脱敏、新鲜度、噪声过滤、跨天摘要、skipTypes、成本测量。

import assert from 'node:assert/strict'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../index.js'

const DAY_MS = 86_400_000

function dayKey(d) {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

const TODAY = dayKey(new Date())
const YESTERDAY = dayKey(new Date(Date.now() - DAY_MS))

// ── fake ctx：只实现本插件用到的 on / inject / systemPrompt.context / effect ──
function makeCtx() {
  const handlers = new Map()
  const blocks = []
  return {
    blocks,
    /** 触发一次 session/event（session 固定 id） */
    emit(type, data, seq) {
      const h = handlers.get('session/event')
      assert.ok(h, 'session/event handler 未注册')
      h({ id: 's-eval' }, { type, seq, time: Date.now(), data })
    },
    /** 触发一次 agent/created */
    created(payload) {
      const h = handlers.get('agent/created')
      assert.ok(h, 'agent/created handler 未注册')
      h(payload)
    },
    ctx: {
      on(name, fn) {
        handlers.set(name, fn)
      },
      inject(_deps, cb) {
        const systemPrompt = {
          context(entry) {
            blocks.push(entry)
            return () => {}
          },
        }
        cb({ systemPrompt, effect: (fn) => fn() })
      },
    },
  }
}

/** 每个用例独立临时目录 + 独立 apply 实例（插件内部有 60s 缓存，实例不能复用） */
function withCase(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-ctx-log-eval-'))
  try {
    return fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
}

function readJsonl(dir, key = TODAY) {
  const file = join(dir, `ctx_${key}.jsonl`)
  assert.ok(existsSync(file), `期望生成当天日志 ctx_${key}.jsonl`)
  const raw = readFileSync(file, 'utf8')
  return raw
    .split('\n')
    .filter(Boolean)
    .map((line, i) => {
      try {
        return JSON.parse(line)
      } catch (err) {
        throw new Error(`第 ${i + 1} 行不是合法 JSON：${err.message}`)
      }
    })
}

function blockText(blocks, name) {
  const b = blocks.find((x) => x && x.name === name)
  assert.ok(b, `未注册注入块 ${name}`)
  const text = b.text()
  assert.equal(typeof text, 'string', `${name}.text() 应返回字符串`)
  return text
}

// ── 合成日志：给成本测量用（不依赖真实会话数据） ─────────────────────
function syntheticLog(n) {
  const lines = []
  for (let i = 1; i <= n; i += 1) {
    const isUser = i % 2 === 1
    lines.push(
      JSON.stringify({
        ts: new Date().toISOString(),
        sess: 's-cost',
        seq: i,
        type: isUser ? 'user/message' : 'assistant/message',
        role: isUser ? 'user' : 'assistant',
        text: `第 ${i} 条合成记录：用于评估系统提示注入成本，长度接近一条日常对话消息。`,
      }),
    )
  }
  return lines.join('\n') + '\n'
}

const cases = []

// ── 1. 落盘 ───────────────────────────────────────────────────────────
cases.push({
  name: '落盘：5 类事件 + agent/created → 当天 JSONL 6 行，逐行可解析且字段齐全',
  fn() {
    return withCase((dir) => {
      const h = makeCtx()
      apply(h.ctx, { logDir: dir })

      h.emit('user/message', { content: '你好，这是评估消息' }, 1)
      h.emit('assistant/message', { message: { content: '收到' } }, 2)
      h.emit('tool/call', { name: 'pwsh', arguments: '{"command":"echo hi"}' }, 3)
      h.emit('tool/result', { message: { content: [{ type: 'text', text: 'hi' }] }, error: null }, 4)
      h.emit('turn/end', { turn: 1, reason: { kind: 'completed' } }, 5)
      h.created({ agent: { session: { id: 's-eval' } }, source: 'startup' })

      const recs = readJsonl(dir)
      assert.equal(recs.length, 6, '应有 6 行（5 类事件 + session/start）')

      const byType = Object.fromEntries(recs.map((r) => [r.type, r]))
      for (const t of ['user/message', 'assistant/message', 'tool/call', 'tool/result', 'turn/end', 'session/start']) {
        assert.ok(byType[t], `缺少 ${t} 行`)
      }
      assert.equal(byType['user/message'].role, 'user')
      assert.match(byType['user/message'].text, /评估消息/)
      assert.equal(byType['assistant/message'].role, 'assistant')
      assert.equal(typeof byType['assistant/message'].text, 'string')
      assert.equal(byType['tool/call'].tool, 'pwsh')
      assert.equal(typeof byType['tool/call'].args, 'string')
      assert.equal(typeof byType['tool/result'].isError, 'boolean')
      assert.equal(typeof byType['tool/result'].result, 'string')
      assert.match(byType['tool/result'].result, /hi/)
      assert.equal(byType['turn/end'].turn, 1)
      assert.equal(byType['turn/end'].reason, 'completed')
      assert.equal(byType['session/start'].source, 'startup')
      assert.ok(recs.every((r) => typeof r.ts === 'string' && r.sess === 's-eval'))

      // 5 类 session 事件按触发顺序拿到 seq 1..5；session/start 来自 agent/created，无 seq
      assert.deepEqual(
        recs.slice(0, 5).map((r) => r.seq),
        [1, 2, 3, 4, 5],
        '5 类 session 事件的 seq 应依次为 1..5',
      )
      const seqByType = [
        ['user/message', 1],
        ['assistant/message', 2],
        ['tool/call', 3],
        ['tool/result', 4],
        ['turn/end', 5],
      ]
      for (const [t, seq] of seqByType) {
        assert.equal(byType[t].seq, seq, `${t} 行的 seq 应为 ${seq}`)
      }
      assert.ok(!('seq' in byType['session/start']), 'session/start 行不应带 seq')
    })
  },
})

// ── 2. 注入 ───────────────────────────────────────────────────────────
cases.push({
  name: '注入：注册 2 段上下文（trail + clock），trail 含当天文件名与已记条数，clock 含当前时间',
  fn() {
    return withCase((dir) => {
      const h = makeCtx()
      apply(h.ctx, { logDir: dir })
      h.emit('user/message', { content: '评估注入' }, 1)

      assert.equal(h.blocks.length, 2, '应注册 2 段 context')
      assert.deepEqual(
        h.blocks.map((b) => b.name),
        ['dsh-ctx-log-trail', 'dsh-clock-now'],
      )

      const trail = blockText(h.blocks, 'dsh-ctx-log-trail')
      assert.ok(trail.includes(`ctx_${TODAY}.jsonl`), 'trail 应含当天日志文件名')
      assert.ok(trail.includes('本会话已记'), 'trail 应含「本会话已记」')
      assert.ok(trail.includes('本会话已记 1 条'), 'trail 应反映已记条数')

      const clock = blockText(h.blocks, 'dsh-clock-now')
      assert.ok(clock.includes('【当前时间】'), 'clock 应含【当前时间】')
    })
  },
})

// ── 3. 脱敏 ───────────────────────────────────────────────────────────
cases.push({
  name: '脱敏：password / api_key / Bearer / URL 密码段全部打码为 ***',
  fn() {
    return withCase((dir) => {
      const h = makeCtx()
      apply(h.ctx, { logDir: dir })
      h.emit(
        'user/message',
        {
          content:
            '请处理 password=SECRET123 api_key=AKIA123 Authorization: Bearer tok_abc 地址 https://user:pw@host/x',
        },
        1,
      )

      const [rec] = readJsonl(dir)
      for (const leaked of ['SECRET123', 'AKIA123', 'tok_abc', 'pw@host']) {
        assert.ok(!rec.text.includes(leaked), `敏感值 ${leaked} 不应出现在落盘文本里`)
      }
      assert.ok(rec.text.includes('***'), '应出现打码占位 ***')
      assert.ok(rec.text.includes('password=***'), 'password 值应打码')
      assert.ok(rec.text.includes('api_key=***'), 'api_key 值应打码')
      assert.ok(rec.text.includes('Bearer ***'), 'Bearer token 应打码')
      assert.ok(rec.text.includes('user:***@host'), 'URL 密码段应打码')
    })
  },
})

// ── 4. 新鲜度 ─────────────────────────────────────────────────────────
cases.push({
  name: '新鲜度：watchFiles 为空不注入；文件 mtime 10 天前 → 注入 label 与 ⚠️',
  fn() {
    // a) 不配置 watchFiles → 不出现【信息新鲜度】
    withCase((dir) => {
      const h = makeCtx()
      apply(h.ctx, { logDir: dir, watchFiles: [] })
      const clock = blockText(h.blocks, 'dsh-clock-now')
      assert.ok(!clock.includes('【信息新鲜度】'), '未配置 watchFiles 时不应有新鲜度段')
    })

    // b) mtime 设为 10 天前 → label + ⚠️
    withCase((dir) => {
      const watched = join(dir, 'note.txt')
      writeFileSync(watched, 'x')
      const tenDaysAgo = (Date.now() - 10 * DAY_MS) / 1000
      utimesSync(watched, tenDaysAgo, tenDaysAgo)

      const h = makeCtx()
      apply(h.ctx, { logDir: dir, watchFiles: [{ path: watched, label: '测试文件' }] })
      const clock = blockText(h.blocks, 'dsh-clock-now')
      assert.ok(clock.includes('【信息新鲜度】'), '配置后应注入新鲜度段')
      assert.ok(clock.includes('测试文件'), '应出现 watchFiles 的 label')
      assert.ok(clock.includes('⚠️'), '超过 7 天应带 ⚠️')
    })
  },
})

// ── 5. 噪声过滤 ───────────────────────────────────────────────────────
cases.push({
  name: '噪声过滤：运行时上下文样板文字不进最近摘要',
  fn() {
    return withCase((dir) => {
      const file = join(dir, `ctx_${TODAY}.jsonl`)
      const noise = [
        {
          ts: new Date().toISOString(),
          sess: 's-eval',
          type: 'user/message',
          role: 'user',
          text: 'Current runtime context. platform=win32; cwd=workspace; shell=pwsh',
        },
        {
          ts: new Date().toISOString(),
          sess: 's-eval',
          type: 'user/message',
          role: 'user',
          text: 'Time sampled while preparing turn 1, step 1: 2026-01-01T00:00:00+08:00',
        },
        {
          ts: new Date().toISOString(),
          sess: 's-eval',
          type: 'user/message',
          role: 'user',
          text: '真实用户消息：请检查噪声过滤是否生效',
        },
      ]
      writeFileSync(file, noise.map((o) => JSON.stringify(o)).join('\n') + '\n')

      const h = makeCtx()
      apply(h.ctx, { logDir: dir })
      const trail = blockText(h.blocks, 'dsh-ctx-log-trail')
      assert.ok(!trail.includes('Current runtime context'), '摘要不应含运行时上下文样板')
      assert.ok(!trail.includes('Time sampled while preparing turn'), '摘要不应含采样时间样板')
      assert.ok(trail.includes('真实用户消息'), '摘要应保留真实消息')
    })
  },
})

// ── 6. 跨天摘要 ───────────────────────────────────────────────────────
cases.push({
  name: '跨天摘要：今天消息不足 trailRecentLines 时回看昨天',
  fn() {
    return withCase((dir) => {
      const yesterdayFile = join(dir, `ctx_${YESTERDAY}.jsonl`)
      writeFileSync(
        yesterdayFile,
        JSON.stringify({
          ts: new Date(Date.now() - DAY_MS).toISOString(),
          sess: 's-eval',
          type: 'user/message',
          role: 'user',
          text: '昨天的问题：检查跨天摘要是否回看前一天',
        }) + '\n',
      )
      // 今天只有 1 条，少于默认 6 条
      writeFileSync(
        join(dir, `ctx_${TODAY}.jsonl`),
        JSON.stringify({
          ts: new Date().toISOString(),
          sess: 's-eval',
          type: 'user/message',
          role: 'user',
          text: '今天的消息：只有一条',
        }) + '\n',
      )

      const h = makeCtx()
      apply(h.ctx, { logDir: dir })
      const trail = blockText(h.blocks, 'dsh-ctx-log-trail')
      assert.ok(trail.includes('昨天的问题'), 'trail 应回看昨天的消息')
      assert.ok(trail.includes('今天的消息'), 'trail 也应含今天的消息')
    })
  },
})

// ── 7. skipTypes ──────────────────────────────────────────────────────
cases.push({
  name: "skipTypes：跳过 tool/call 与 tool/result 后不落盘这两类",
  fn() {
    return withCase((dir) => {
      const h = makeCtx()
      apply(h.ctx, { logDir: dir, skipTypes: ['tool/call', 'tool/result'] })

      h.emit('user/message', { content: '只记对话' }, 1)
      h.emit('tool/call', { name: 'pwsh', arguments: 'echo hi' }, 2)
      h.emit('tool/result', { message: { content: 'hi' }, error: null }, 3)
      h.emit('turn/end', { turn: 1, reason: { kind: 'completed' } }, 4)

      const recs = readJsonl(dir)
      assert.equal(recs.length, 2, '只应落盘 user/message 与 turn/end')
      const types = recs.map((r) => r.type)
      assert.deepEqual(types, ['user/message', 'turn/end'])
      assert.ok(!types.includes('tool/call'))
      assert.ok(!types.includes('tool/result'))
    })
  },
})

// ── 8. 成本测量 ───────────────────────────────────────────────────────
cases.push({
  name: '成本：0 / 50 / 500 行日志下两段注入文本的 chars 与 estTokens（chars÷1.6）',
  fn() {
    const tiers = [0, 50, 500]
    const rows = tiers.map((n) =>
      withCase((dir) => {
        const file = join(dir, `ctx_${TODAY}.jsonl`)
        if (n > 0) writeFileSync(file, syntheticLog(n))

        const h = makeCtx()
        apply(h.ctx, { logDir: dir, trailRecentLines: 6 })
        const trailChars = blockText(h.blocks, 'dsh-ctx-log-trail').length
        const clockChars = blockText(h.blocks, 'dsh-clock-now').length
        const chars = trailChars + clockChars
        return { n, trailChars, clockChars, chars, estTokens: Math.round(chars / 1.6) }
      }),
    )

    console.log('')
    console.log('  | 日志行数 | trail chars | clock chars | 合计 chars | estTokens |')
    console.log('  |---:|---:|---:|---:|---:|')
    for (const r of rows) {
      console.log(`  | ${r.n} | ${r.trailChars} | ${r.clockChars} | ${r.chars} | ${r.estTokens} |`)
    }
    console.log('')

    const zero = rows[0]
    const full = rows[2]
    assert.ok(
      full.estTokens > zero.estTokens,
      `500 行档 estTokens 应大于 0 行档（${full.estTokens} vs ${zero.estTokens}）`,
    )
    // 区间 sanity：数字随 logDir 路径长度/时区偏移小幅浮动，但不应整体漂移（防止成本表悄悄失真）
    assert.ok(
      zero.estTokens >= 150 && zero.estTokens <= 250,
      `0 行档 estTokens 应在 150–250（实测 ${zero.estTokens}）`,
    )
    assert.ok(
      full.estTokens >= 350 && full.estTokens <= 500,
      `500 行档 estTokens 应在 350–500（实测 ${full.estTokens}）`,
    )
  },
})

// ── 跑用例 ───────────────────────────────────────────────────────────
console.log('dsh-ctx-log evals · fake ctx harness')
console.log(`node ${process.version} · ${TODAY}`)
console.log('')

let passed = 0
let failed = 0
for (let i = 0; i < cases.length; i += 1) {
  const c = cases[i]
  try {
    c.fn()
    passed += 1
    console.log(`PASS  ${i + 1}/${cases.length}  ${c.name}`)
  } catch (err) {
    failed += 1
    console.log(`FAIL  ${i + 1}/${cases.length}  ${c.name}`)
    console.log(`      ${err && err.message ? err.message : String(err)}`)
  }
}

console.log('')
console.log(`PASS ${passed} / FAIL ${failed}`)
if (failed > 0) process.exitCode = 1
