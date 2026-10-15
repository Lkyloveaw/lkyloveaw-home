// 端到端验收：从干净构建到真实 HTTP 请求，逐项断言。
// 独立脚本而不是口头验证——每次改完都能重跑。
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const PORT = 3997
const BASE = `http://127.0.0.1:${PORT}`
const ROOT = process.cwd()

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`)
}

const get = async (p) => {
  const res = await fetch(BASE + p, { redirect: 'manual' })
  return { status: res.status, body: await res.text(), type: res.headers.get('content-type') || '' }
}

// 准备一个独立的临时数据目录与目标清单
const tmpData = path.join(ROOT, '.e2e-tmp')
fs.rmSync(tmpData, { recursive: true, force: true })
fs.mkdirSync(tmpData, { recursive: true })

const targets = [
  { id: 'ok', name: '可用系统', url: 'https://example.com/', group: 'G1', expectStatus: [200] },
  { id: 'bad', name: '状态码不符', url: 'https://example.com/', group: 'G1', expectStatus: [999] },
  { id: 'dead', name: '不可达', url: 'http://10.255.255.1/', group: 'G2', timeoutMs: 1500 },
]

const child = spawn(process.execPath, ['dist/server.js'], {
  cwd: ROOT,
  env: {
    ...process.env,
    PORT: String(PORT),
    HOST: '127.0.0.1',
    TARGETS_JSON: JSON.stringify(targets),
    DATABASE_PATH: path.join(tmpData, 'e2e.sqlite'),
    PROBE_INTERVAL_SECONDS: '3',
    PROBE_TIMEOUT_MS: '4000',
    SITE_TITLE: '验收站',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let serverLog = ''
child.stdout.on('data', (d) => (serverLog += d))
child.stderr.on('data', (d) => (serverLog += d))

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

try {
  // 等服务起来
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(BASE + '/healthz')
      if (r.ok) break
    } catch {}
    await sleep(250)
  }

  // 等到「累计足够多轮探测」再断言，而不是猜一个睡眠时长：
  // 首轮耗时取决于最慢的目标，固定 sleep 会随机地只采到 1 轮。
  const waitForSamples = async (id, want, timeoutMs = 40000) => {
    const deadline = Date.now() + timeoutMs
    let last = 0
    while (Date.now() < deadline) {
      try {
        const api = JSON.parse((await get('/api/status')).body)
        const t = api.targets.find((x) => x.target.id === id)
        last = t?.stats?.samples ?? 0
        if (last >= want) return last
      } catch {}
      await sleep(500)
    }
    return last
  }
  const samples = await waitForSamples('ok', 3)
  check('累计多轮探测', samples >= 3, `samples=${samples}`)

  console.log('\n[路由]')
  const routes = [
    ['/', 200],
    ['/posts', 200],
    ['/about', 200],
    ['/status', 200],
    ['/api/status', 200],
    ['/healthz', 200],
    ['/style.css', 200],
    ['/status.js', 200],
    ['/nope', 404],
  ]
  for (const [p, want] of routes) {
    const r = await get(p)
    check(`GET ${p} -> ${want}`, r.status === want, `got ${r.status}`)
  }
  const tag = await get('/tags/' + encodeURIComponent('运维'))
  check('GET /tags/运维 -> 200', tag.status === 200, `got ${tag.status}`)
  const post = await get('/posts/why-single-process')
  check('GET /posts/:slug -> 200', post.status === 200)
  check('文章渲染出 pre/code', post.body.includes('<pre><code'))

  console.log('\n[可用性面板]')
  const st = await get('/status')
  check('面板有内联 SVG 曲线', st.body.includes('<svg viewBox'))
  check('延迟曲线存在', st.body.includes('stroke="var(--accent)"'))
  check('可用率曲线存在', st.body.includes('stroke="var(--ok)"'))
  check('曲线横轴时间标注', st.body.includes('class="chart-axis"'))
  check('三态状态点齐全(ok/warn/bad)', st.body.includes('dot ok') && st.body.includes('dot warn') && st.body.includes('dot bad'))
  check('分组标题渲染', st.body.includes('G1') && st.body.includes('G2'))
  check('不可达目标显示无曲线(而非0)', st.body.includes('chart-empty'))
  check('失败原因展示', st.body.includes('超时') && st.body.includes('不在预期范围内'))

  console.log('\n[API 数据]')
  const api = JSON.parse((await get('/api/status')).body)
  check('目标数正确', api.targets.length === 3, `got ${api.targets.length}`)
  const byId = Object.fromEntries(api.targets.map((t) => [t.target.id, t]))
  check('ok -> up', byId.ok.stats.lastStatus === 'up', byId.ok.stats.lastStatus)
  check('bad -> degraded', byId.bad.stats.lastStatus === 'degraded', byId.bad.stats.lastStatus)
  check('dead -> down', byId.dead.stats.lastStatus === 'down', byId.dead.stats.lastStatus)
  check('down 不记录延迟', byId.dead.stats.avgLatencyMs === null)
  check('degraded 仍记录延迟', byId.bad.stats.avgLatencyMs !== null)
  check('可用率为 0-1 之间', byId.ok.stats.uptime !== null && byId.ok.stats.uptime <= 1)
  check('时间线有数据', byId.ok.timeline.length >= 2, `tl=${byId.ok.timeline.length}`)
  check('延迟序列有数据', byId.ok.latency.length >= 2, `lat=${byId.ok.latency.length}`)
  check('可用率走势有数据', api.overview.length >= 2)
  // 回归：整体可用率必须按「轮」聚合。若按 at 精确分组，每轮会被拆成 total=1 的点，
  // 百分比就只在 0 和 100 之间跳，永远看不到 33% 这种真实值。
  const totals = [...new Set(api.overview.map((p) => p.total))]
  check('可用率按轮聚合(每轮含全部目标)', totals.length === 1 && totals[0] === 3, `totals=${JSON.stringify(totals)}`)
  const pcts = [...new Set(api.overview.map((p) => Math.round((p.up / p.total) * 100)))]
  check('可用率不是 0/100 二值', !pcts.every((v) => v === 0 || v === 100), `pcts=${JSON.stringify(pcts)}`)
  // 回归：P95 不能退化成 max（floor(n*q) 的经典偏差）
  const s = byId.ok.stats
  check('P95 >= 平均延迟', s.p95LatencyMs >= s.avgLatencyMs, `p95=${s.p95LatencyMs} avg=${s.avgLatencyMs}`)

  console.log('\n[安全性]')
  // 真实转义测试：把攻击载荷放进「文章内容/标题」这条真实数据通路，再断言它没有被当成 HTML 执行。
  // 旧版本是 `!/<script>alert/.test(body)`——页面里本来就没有那个字面量，恒真，等于没测。
  const xss = '<script>alert(1)</script><img src=x onerror=alert(2)>'
  const evilDir = path.join(ROOT, 'content')
  const evilFile = path.join(evilDir, '2026-01-02-xss-probe.md')
  fs.writeFileSync(
    evilFile,
    `---\ntitle: ${JSON.stringify(xss)}\ntags: [${JSON.stringify(xss)}]\nsummary: ${JSON.stringify(xss)}\n---\n\n${xss}\n`,
    'utf8',
  )
  try {
    // 列表页：标题/摘要/标签必须被转义
    const listPage = await get('/posts')
    check('XSS: 标题未被注入为脚本', !/<script>alert\(1\)<\/script>/.test(listPage.body))
    check('XSS: 转义后的载荷仍在页面上（证明真的渲染过）', listPage.body.includes('&lt;script&gt;'))
    check('XSS: onerror 属性未被注入', !/<img src=x onerror=/.test(listPage.body))
    // 详情页：正文里的 HTML 也必须被当成文本（markdown-it html:false）
    const detail = await get('/posts/xss-probe')
    check('XSS: 详情页正文未执行 HTML', !/<script>alert\(1\)<\/script>/.test(detail.body))
    check('XSS: 详情页渲染了该文章', detail.status === 200, `status=${detail.status}`)
    // 标签路由：标签名进 URL 也必须安全
    const tagPage = await get('/tags/' + encodeURIComponent(xss))
    check('XSS: 标签路由未 500', tagPage.status === 200 || tagPage.status === 404, `status=${tagPage.status}`)
  } finally {
    fs.rmSync(evilFile, { force: true })
  }

  console.log('\n[进程健壮性]')
  check('服务全程未崩溃', child.exitCode === null && !/启动失败/.test(serverLog))
  check('探测日志正常输出', /\[probe\]/.test(serverLog))
} finally {
  child.kill('SIGTERM')
  await sleep(800)
  fs.rmSync(tmpData, { recursive: true, force: true })
}

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} 通过`)
if (failed.length) {
  console.log('失败项：')
  for (const f of failed) console.log('  - ' + f.name + (f.detail ? '  (' + f.detail + ')' : ''))
  process.exit(1)
}
