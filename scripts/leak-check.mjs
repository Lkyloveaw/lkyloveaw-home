/**
 * 泄漏回归：**真实起服务、真实探测、真实落库**，证明含凭证的 URL 不再出网。
 *
 * 为什么必须端到端而不是纯函数断言：泄漏发生在「写入侧拼接 → 落库 → 投影 → 响应」
 * 这条链上，纯函数断言只能证明其中一环。
 */
import { spawn, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import { startProbeFixture } from './lib/probe-fixture.mjs'
import { assertPortFree } from './lib/port-guard.mjs'

const ROOT = process.cwd()
const PORT = 3996
const BASE = `http://127.0.0.1:${PORT}`

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`)
}

const tmp = path.join(ROOT, '.leak-tmp')
fs.rmSync(tmp, { recursive: true, force: true })
fs.mkdirSync(tmp, { recursive: true })
const DB = path.join(tmp, 'leak.sqlite')

// ⚠ 核心载荷：带用户名与口令的 URL。它会进探测目标清单，
// 探测失败后错误原文**可能含整个 URL**——这正是实测抓到的泄漏。
const SECRET_HOST = 'ledger.internal.example'
const SECRET_USER = 'ops'
const SECRET_PASS = 'hunter2'
const CREDENTIAL_URL = `http://${SECRET_USER}:${SECRET_PASS}@${SECRET_HOST}/`
// 持续产生一条真实的非预期状态码事件，避免依赖已合并进其他故障的历史样本。
const probeFixture = await startProbeFixture()

const targets = [
  { id: 'http-error', name: '状态码异常', url: probeFixture.url + 'status/503', expectStatus: [200] },
  // 这个会被**入口拦截**（URL 带凭证），根本不会进探测流程
  { id: 'leaky', name: '带凭证的目标', url: CREDENTIAL_URL, group: 'G1', timeoutMs: 1200 },
  // 超时分支：必须保住「等了多久」
  { id: 'slow', name: '会超时', url: probeFixture.url + 'timeout', group: 'G1', timeoutMs: 1000 },
  // DNS 失败分支：**运行时异常**，原文含主机名 → 必须被换成类别文案。
  // 这条替换掉「带凭证 URL」原先承担的写侧脱敏覆盖（那个现在被入口拦掉了）。
  { id: 'dnsfail', name: 'DNS 失败', url: `http://${SECRET_HOST}/`, group: 'G2', timeoutMs: 4000 },
]

// ── 先造一个「脏」的旧库：模拟 `?? e.message` 时代写进去的原文 ──
{
  const db = new Database(DB)
  db.exec(`CREATE TABLE IF NOT EXISTS probes (
    id INTEGER PRIMARY KEY AUTOINCREMENT, target_id TEXT NOT NULL, at INTEGER NOT NULL,
    status TEXT NOT NULL, latency_ms INTEGER, status_code INTEGER, error TEXT, round_at INTEGER);`)
  const now = Date.now()
  const stmt = db.prepare(
    `INSERT INTO probes (target_id, at, round_at, status, latency_ms, status_code, error) VALUES (?,?,?,?,?,?,?)`,
  )
  // 含凭证的长句原文（模拟真实的 Node fetch 报错文本）
  stmt.run('leaky', now - 5000, now - 5000, 'down', null, null,
    `Request cannot be constructed from a URL that includes credentials: ${CREDENTIAL_URL}`)
  // 含内网主机名的原文
  stmt.run('leaky', now - 4000, now - 4000, 'down', null, null, `fetch failed to ${SECRET_HOST}:443`)
  // 自己生成的文案：必须原样保留
  stmt.run('slow', now - 3000, now - 3000, 'down', null, null, '超时（>1000ms）')
  stmt.run('slow', now - 2000, now - 2000, 'degraded', 12, 500, '状态码 500 不在预期范围内')
  db.close()
}

const TEST_USER = 'leakuser'
const TEST_PASS = 'leak-password-1234'
execFileSync(process.execPath, ['dist/cli/passwd.js', '--user', TEST_USER, '--password', TEST_PASS], {
  cwd: ROOT, env: { ...process.env, DATABASE_PATH: DB }, stdio: 'ignore',
})

// 端口被占时**先失败**：否则下面的 /healthz 等待会凑到别人起的服务上，
// 然后对着另一个库登录 —— 症状是「登录 401 / timeline=0」，与产品 bug 无法区分。
await assertPortFree(PORT, 'leak-check（端口 3996）')

const child = spawn(process.execPath, ['dist/server.js'], {
  cwd: ROOT,
  env: {
    ...process.env,
    PORT: String(PORT),
    HOST: '127.0.0.1',
    TARGETS_JSON: JSON.stringify(targets),
    DATABASE_PATH: DB,
    PROBE_INTERVAL_SECONDS: '2',
    PROBE_TIMEOUT_MS: '1200',
    SESSION_SECRET: 'leak-test-secret',
    SITE_ORIGIN: BASE,
    SITE_TITLE: '泄漏验收站',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let log = ''
child.stdout.on('data', (d) => (log += d))
child.stderr.on('data', (d) => (log += d))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let cookie = ''
try {
  for (let i = 0; i < 40; i++) {
    try { if ((await fetch(BASE + '/healthz')).ok) break } catch {}
    await sleep(250)
  }

  // 登录（闸门之后一切都要凭证）
  {
    const res = await fetch(BASE + '/login', {
      method: 'POST', redirect: 'manual',
      // L2 对所有非安全方法 fail-closed：不带来源头的 POST 会被 403（**故意的**）。
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: BASE },
      body: new URLSearchParams({ username: TEST_USER, password: TEST_PASS, next: '/' }),
    })
    cookie = (res.headers.get('set-cookie') || '').split(';')[0]
  }
  check('能登录（前置条件）', cookie.startsWith('session='), cookie.slice(0, 20))

  // 等探测跑几轮，让带凭证的目标真的失败一次
  await sleep(6000)

  const res = await fetch(BASE + '/api/status', { headers: { cookie, accept: 'application/json' } })
  const body = await res.text()
  check('API 可访问', res.status === 200, `got ${res.status}`)

  console.log('\n[响应体：不得出现敏感原文]')
  check('响应不含内网主机名', !body.includes(SECRET_HOST), SECRET_HOST)
  check('响应不含口令', !body.includes(SECRET_PASS))
  check('响应不含用户名:口令 形式', !body.includes(`${SECRET_USER}:${SECRET_PASS}`))
  check('响应不含 "includes credentials" 原文', !body.includes('includes credentials'))
  check('响应不含 target url 字段', !/"url"\s*:/.test(body))
  check('响应不含 expectStatus 字段', !/"expectStatus"\s*:/.test(body))
  check('响应不含 samples 字段', !/"samples"\s*:/.test(body))
  check('响应不含 upCount 字段', !/"upCount"\s*:/.test(body))
  check('连续时长用于刷新且为数值或 null', JSON.parse(body).targets.every(t => t.upStreakMs === null || typeof t.upStreakMs === 'number'))
  check('最近探测时间用于新鲜度判定且为数值或 null', JSON.parse(body).targets.every(t => t.lastCheckedAt === null || typeof t.lastCheckedAt === 'number'))

  console.log('\n[公开契约形状]')
  const api = JSON.parse(body)
  check('顶层恰好 7 个键', Object.keys(api).length === 7, Object.keys(api).join(','))
  check(
    '顶层键集正确',
    JSON.stringify(Object.keys(api).sort()) ===
      JSON.stringify(['generatedAt', 'incidents', 'overview', 'probeIntervalSeconds', 'targets', 'windowLabel', 'windowStartAt']),
    Object.keys(api).sort().join(','),
  )
  const t0 = api.targets[0]
  check('targets[] 恰好 13 个键', Object.keys(t0).length === 13, Object.keys(t0).join(','))
  check(
    'targets[] 键集正确',
    JSON.stringify(Object.keys(t0).sort()) ===
      JSON.stringify(['avgLatencyMs', 'group', 'id', 'lastCheckedAt', 'lastError', 'lastStatus', 'latency', 'name', 'p95LatencyMs', 'staleAfterMs', 'timeline', 'upStreakMs', 'uptime']),
    Object.keys(t0).sort().join(','),
  )
  // 拍平：不再有 target / stats 两层
  check('已拍平（无嵌套 target/stats）', t0.target === undefined && t0.stats === undefined)
  check('id 直接在顶层', typeof t0.id === 'string' && t0.id.length > 0, t0.id)
  check('timeline 点只含 3 个键', Object.keys(t0.timeline[0] || {}).length === 3, JSON.stringify(Object.keys(t0.timeline[0] || {})))
  check('latency 点只含 2 个键', Object.keys(t0.latency[0] || {}).length === 2, JSON.stringify(Object.keys(t0.latency[0] || {})))
  check('overview 点只含 3 个键', Object.keys(api.overview[0] || {}).length === 3, JSON.stringify(Object.keys(api.overview[0] || {})))

  console.log('\n[脱敏分流：自有文案必须保住]')
  const slow = api.targets.find((t) => t.id === 'slow')
  const leaky = api.targets.find((t) => t.id === 'leaky')
  check(
    '超时文案原样保留（信息量最大，不能抹成「探测失败」）',
    slow && /^超时（>\d+ms）$/.test(slow.lastError || ''),
    `lastError=${JSON.stringify(slow?.lastError)}`,
  )
  check(
    '状态码文案原样保留',
    api.incidents.some((i) => /^状态码 \d+ 不在预期范围内$/.test(i.error || '')),
    JSON.stringify(api.incidents.map((i) => i.error)),
  )
  // ⚠ 入口拦截（实现④）先一步生效：带凭证的 URL 在**启动时就被跳过**，
  // 根本不会去探测，所以它不会出现在响应里。这是**入口 + 出口两道**都成立的证据，
  // 比「探测失败后脱敏」更干净——凭证 URL 压根没进过探测流程。
  check(
    '带凭证的目标被入口拦截（不出现在响应里）',
    leaky === undefined,
    leaky ? `仍然出现了：${JSON.stringify(leaky.lastError)}` : '已在启动时跳过',
  )
  // 写侧脱敏仍要覆盖：DNS 失败的**运行时异常原文会含主机名**，必须只留类别码。
  const dns = api.targets.find((t) => t.id === 'dnsfail')
  check(
    '运行时异常被换成类别文案（写侧脱敏仍生效）',
    dns !== undefined && dns.lastError !== null && !String(dns.lastError).includes(SECRET_HOST),
    `lastError=${JSON.stringify(dns?.lastError)}`,
  )
  check(
    'incidents[].error 也被脱敏（不能只修 lastError 这一处）',
    api.incidents.every((i) => !(i.error || '').includes(SECRET_HOST) && !(i.error || '').includes(SECRET_PASS)),
    JSON.stringify(api.incidents.map((i) => i.error)),
  )

  console.log('\n[存量脏数据：启动时自动清洗]')
  {
    const db = new Database(DB, { readonly: true })
    const rows = db.prepare(`SELECT target_id, error FROM probes WHERE error IS NOT NULL`).all()
    db.close()
    const all = rows.map((r) => r.error).join(' | ')
    check('库里不再有含凭证的原文', !all.includes(SECRET_PASS), all.slice(0, 120))
    check('库里不再有内网主机名', !all.includes(SECRET_HOST), all.slice(0, 120))
    check('库里的超时文案仍在（清洗不能误伤）', all.includes('超时（>1000ms）'), all.slice(0, 120))
    check('清洗日志已输出', /已清洗 \d+ 条历史错误文案/.test(log), log.split('\n').find((l) => l.includes('清洗')) || '(无)')
  }

  console.log('\n[页面 SSR：URL 仍在（靠鉴权保护，与契约收敛互不替代）]')
  {
    const st = await fetch(BASE + '/status', { headers: { cookie } })
    const html = await st.text()
    check('/status 仍渲染出目标 URL（SSR 不受投影影响）', html.includes(SECRET_HOST) || html.includes('target-url'))
    check('页面渲染正常（200）', st.status === 200, `got ${st.status}`)
  }
} finally {
  child.kill()
  await probeFixture.close()
  await sleep(600)
  try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {}
}

console.log(`\n${'─'.repeat(60)}`)
const failed = results.filter((r) => !r.ok)
if (!failed.length) console.log(`✅ 全部通过：${results.length} 项`)
else {
  console.log(`❌ ${failed.length} 项失败 / 共 ${results.length} 项`)
  for (const f of failed) console.log(`   - ${f.name}`)
}
process.exit(failed.length ? 1 : 0)
