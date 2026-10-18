// 端到端验收：从干净构建到真实 HTTP 请求，逐项断言。
// 独立脚本而不是口头验证——每次改完都能重跑。
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import { csrfToken } from '../dist/csrf.js'
import path from 'node:path'

const PORT = 3997
const BASE = `http://127.0.0.1:${PORT}`
const ROOT = process.cwd()

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`)
}

const get = async (p, opts = {}) => {
  const res = await fetch(BASE + p, { redirect: 'manual', headers: opts.cookie ? { cookie: opts.cookie } : {} })
  return {
    status: res.status,
    body: await res.text(),
    type: res.headers.get('content-type') || '',
    location: res.headers.get('location') || '',
    setCookie: res.headers.get('set-cookie') || '',
  }
}

/** 带会话 cookie 的取数（登录后的常规访问）。 */
let sessionCookie = ''
const authed = (p) => get(p, { cookie: sessionCookie })

/**
 * 会话密钥。**e2e 知道它**，所以能自己算 L3 token（与服务器同一个纯函数）——
 * 这是「本票可独立验收、不需要管理台存在」的关键（`docs/write-path-auth-decision.md` §9.2）。
 */
const SECRET = 'e2e-only-secret-not-used-anywhere-else'

/**
 * 写请求的统一入口。
 *
 * ⚠ **刻意不叫 `post`**：本文件后面的块里有 `const post = await authed('/posts/…')`，
 * 同名会让这个顶层绑定在**那个块里**被遮蔽 —— 块内早于它执行的地方会报
 * `Cannot access 'post' before initialization`（TDZ），而报错点离原因很远。
 *
 * **所有 POST 默认带 `Origin`** —— L2 是 fail-closed 的，不带来源头的 POST 会被 403
 * （那是**故意的**：直连 IP 调用写接口正是要拒绝的形状）。
 * 需要 L3 的路由（`/logout`、`/password`）由调用方传 `csrf`。
 * `origin: null` / `referer` 这些参数是给 L2 的**反例**用的。
 */
const postForm = async (path, opts = {}) => {
  const { cookie = '', form = {}, csrf = null, origin = BASE, referer = null } = opts
  const body = new URLSearchParams(form)
  if (csrf !== null) body.set('csrf', csrf)
  const headers = { 'content-type': 'application/x-www-form-urlencoded' }
  if (cookie) headers.cookie = cookie
  if (origin !== null) headers.origin = origin
  if (referer !== null) headers.referer = referer
  const res = await fetch(BASE + path, { method: 'POST', redirect: 'manual', headers, body })
  return {
    status: res.status,
    setCookie: res.headers.get('set-cookie') || '',
    location: res.headers.get('location') || '',
    body: await res.text(),
    cacheControl: res.headers.get('cache-control') || '',
  }
}

/**
 * 从会话 cookie（形如 `session=<token>`）算 L3 token —— 与服务器**同一个函数**。
 *
 * ⚠ 必须剥掉 `session=` 前缀：服务器那边 `readSessionCookie()` 交出来的就是**纯 token**，
 * 派生用的也是它。差这一个前缀，算出来的 HMAC 完全对不上 —— 而且从代码上看「哪都对」。
 */
const csrfFor = (cookie) => csrfToken(SECRET, cookie.replace(/^session=/, ''))

// 准备一个独立的临时数据目录与目标清单
const tmpData = path.join(ROOT, '.e2e-tmp')
fs.rmSync(tmpData, { recursive: true, force: true })
fs.mkdirSync(tmpData, { recursive: true })

/** 验收用的账号口令（仅本脚本内的临时库）。 */
const TEST_USER = 'e2euser'
const TEST_PASS = 'e2e-password-1234'
const TEST_DB = path.join(tmpData, 'e2e.sqlite')

// 先用 CLI 建号：这同时回归「CLI 在 dist 下可用」这条约束
// （`scripts/` 不进部署产物，运维入口必须编译进 `dist/`）。
{
  const { execFileSync } = await import('node:child_process')
  execFileSync(process.execPath, ['dist/cli/passwd.js', '--user', TEST_USER, '--password', TEST_PASS], {
    cwd: ROOT,
    env: { ...process.env, DATABASE_PATH: TEST_DB },
    stdio: 'ignore',
  })
}

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
    DATABASE_PATH: TEST_DB,
    PROBE_INTERVAL_SECONDS: '3',
    PROBE_TIMEOUT_MS: '4000',
    SITE_TITLE: '验收站',
    // 闸门落地后必需：没配会拒绝启动。
    SESSION_SECRET: SECRET,
    // L2 的判据来源（#38）：缺失即拒绝启动，所以 e2e 也必须给。
    SITE_ORIGIN: BASE,
    // 保持默认关，顺便回归「HTTP 下 Secure 必须是关的」。
    SESSION_COOKIE_SECURE: '0',
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

  // ══════════════════════════════════════════════════════════
  console.log('\n[闸门：未登录]')
  // ══════════════════════════════════════════════════════════
  // 受保护的页面：一律 302 到登录页，且带上 next
  const protectedPages = ['/', '/posts', '/status', '/about', '/tags/运维', '/posts/why-single-process']
  for (const p of protectedPages) {
    const r = await get(p)
    check(
      `未登录 GET ${p} -> 302 到 /login`,
      r.status === 302 && r.location.startsWith('/login'),
      `got ${r.status} ${r.location}`,
    )
  }
  // API：必须 401 JSON，**不是 302** —— fetch 默认跟随跳转会拿到登录页 HTML，r.json() 会抛错
  {
    const r = await get('/api/status')
    check('未登录 GET /api/status -> 401（不是 302）', r.status === 401, `got ${r.status}`)
    check('未登录 API 回 JSON error', r.body.includes('unauthorized'), r.body.slice(0, 60))
  }
  // 白名单：必须匿名可达
  for (const p of ['/login', '/healthz', '/style.css', '/status.js']) {
    const r = await get(p)
    check(`白名单 ${p} 匿名 200`, r.status === 200, `got ${r.status}`)
  }
  // 登录页自己需要样式，否则渲染成裸 HTML
  {
    const r = await get('/login')
    check('登录页引用了 /style.css', r.body.includes('/style.css'))
    check('登录页含表单', r.body.includes('<form') && r.body.includes('name="password"'))
  }

  // next 逃逸面：所有站外变体都必须被丢弃并回退到 /
  for (const bad of ['//evil.com/path', '/\\evil.com/path', '////evil.com', 'https://evil.com/x', '/unknown-junk']) {
    const r = await get('/login?next=' + encodeURIComponent(bad))
    const hidden = (r.body.match(/name="next" value="([^"]*)"/) || [])[1]
    check(`next 逃逸被丢弃：${JSON.stringify(bad)} -> /`, hidden === '/', `hidden=${JSON.stringify(hidden)}`)
  }
  {
    const r = await get('/login?next=' + encodeURIComponent('/status'))
    const hidden = (r.body.match(/name="next" value="([^"]*)"/) || [])[1]
    check('合法的 next 被保留', hidden === '/status', `hidden=${JSON.stringify(hidden)}`)
  }

  // ══════════════════════════════════════════════════════════
  console.log('\n[登录]')
  // ══════════════════════════════════════════════════════════
  const postLogin = async (username, password, next = '/') => {
    // `POST /login` 按 §5.2 **只受 L2**（没有会话可派生 L3 token），所以这里不带 csrf。
    const res = await postForm('/login', { form: { username, password, next } })
    return { status: res.status, setCookie: res.setCookie, body: res.body }
  }

  {
    const bad = await postLogin(TEST_USER, 'wrong-password-here')
    check('错误口令 -> 401（不回 cookie）', bad.status === 401 && !bad.setCookie, `got ${bad.status}`)
    check('错误口令不泄漏账号是否存在', bad.body.includes('用户名或口令不正确'))
  }
  {
    const nobody = await postLogin('no-such-user', 'whatever-123456')
    check('不存在的用户 -> 401', nobody.status === 401, `got ${nobody.status}`)
  }
  {
    const ok = await postLogin(TEST_USER, TEST_PASS)
    check('正确口令 -> 302', ok.status === 302, `got ${ok.status}`)
    check('登录下发了会话 cookie', /session=/.test(ok.setCookie), ok.setCookie.slice(0, 40))
    check('cookie 是 HttpOnly', /HttpOnly/i.test(ok.setCookie))
    check('cookie 是 SameSite=Lax', /SameSite=Lax/i.test(ok.setCookie))
    // HTTP 下开着 Secure 会让浏览器根本不存 cookie，表现为「输对密码又跳回登录页」
    check('**cookie 不含 Secure**（HTTP 部署下的正确默认）', !/Secure/i.test(ok.setCookie), ok.setCookie)
    sessionCookie = ok.setCookie.split(';')[0]
  }
  {
    const r = await get('/login', { cookie: sessionCookie })
    check('已登录访问 /login 不报错', r.status === 200, `got ${r.status}`)
  }

  // ══════════════════════════════════════════════════════════
  console.log('\n[会话校验：畸形与失效 cookie 不得 500]')
  // ══════════════════════════════════════════════════════════
  const badCookies = [
    ['session=', '空值'],
    ['session=garbage', '无分隔符'],
    ['session=abc.def', '签名长度不对'],
    ['session=.sig', '点号在开头'],
    ['session=' + 'A'.repeat(200) + '.short', '超长载荷 + 短签名'],
    ['other=1', '没有 session 键'],
    ['session=%E4%B8%AD%E6%96%87.bad', '非 ASCII'],
  ]
  for (const [ck, label] of badCookies) {
    const r = await get('/status', { cookie: ck })
    check(`畸形 cookie（${label}）-> 302 而非 500`, r.status === 302, `got ${r.status}`)
    const api = await get('/api/status', { cookie: ck })
    check(`畸形 cookie（${label}）API -> 401 而非 500`, api.status === 401, `got ${api.status}`)
  }
  {
    const r = await get('/api/status', { cookie: sessionCookie })
    check('登录后 API 正常 200', r.status === 200, `got ${r.status}`)
  }

  // 等到「累计足够多轮探测」再断言，而不是猜一个睡眠时长：
  // 首轮耗时取决于最慢的目标，固定 sleep 会随机地只采到 1 轮。
  const waitForSamples = async (id, want, timeoutMs = 40000) => {
    const deadline = Date.now() + timeoutMs
    let last = 0
    while (Date.now() < deadline) {
      try {
        const api = JSON.parse((await authed('/api/status')).body)
        // 注意：`/api/status` 已拍平，id 在顶层（`stats.samples` 也被删了，
        // 所以改用 timeline 长度当「探够了几轮」的信号）。
        const t = api.targets.find((x) => x.id === id)
        // ⚠ `stats.samples` 已被字段收敛票删掉，改用 timeline 长度当「探够了几轮」的信号。
        last = t?.timeline?.length ?? 0
        if (last >= want) return last
      } catch {}
      await sleep(500)
    }
    return last
  }
  const samples = await waitForSamples('ok', 3)
  check('累计多轮探测', samples >= 3, `timeline=${samples}`)

  console.log('\n[路由（已登录，原有覆盖不缩水）]')
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
    const r = await authed(p)
    check(`GET ${p} -> ${want}`, r.status === want, `got ${r.status}`)
  }
  const tag = await authed('/tags/' + encodeURIComponent('运维'))
  check('GET /tags/运维 -> 200', tag.status === 200, `got ${tag.status}`)
  const post = await authed('/posts/why-single-process')
  check('GET /posts/:slug -> 200', post.status === 200)
  check('文章渲染出 pre/code', post.body.includes('<pre><code'))

  console.log('\n[可用性面板]')
  const st = await authed('/status')
  check('面板有内联 SVG 曲线', st.body.includes('<svg viewBox'))
  check('延迟曲线存在', st.body.includes('stroke="var(--accent)"'))
  check('可用率曲线存在', st.body.includes('stroke="var(--ok)"'))
  check('曲线横轴时间标注', st.body.includes('class="chart-axis"'))
  check('三态状态点齐全(ok/warn/bad)', st.body.includes('dot ok') && st.body.includes('dot warn') && st.body.includes('dot bad'))
  check('分组标题渲染', st.body.includes('G1') && st.body.includes('G2'))
  check('不可达目标显示无曲线(而非0)', st.body.includes('chart-empty'))
  check('失败原因展示', st.body.includes('超时') && st.body.includes('不在预期范围内'))

  // ── 面板重绘所需的钩子（本票新增，缺一个前端就静默失效）──
  check('曲线容器带 data-chart 钩子', (st.body.match(/data-chart[\s>]/g) || []).length >= 2)
  check('曲线容器带 data-chart-kind', st.body.includes('data-chart-kind="latency"') && st.body.includes('data-chart-kind="uptime"'))
  check('延迟曲线把首屏值域写进 DOM', /data-chart-kind="latency"[\s\S]{0,160}data-y-min="[-\d.]+" data-y-max="[-\d.]+"/.test(st.body))
  check('可用率值域固定 0-100', /data-chart-kind="uptime"[\s\S]{0,120}data-y-min="0" data-y-max="100"/.test(st.body))
  check('时序条带 data-timeline 钩子', st.body.includes('data-timeline'))
  check('引入了 /chart-path.js', st.body.includes('src="/chart-path.js"'))
  check('/chart-path.js 在 status.js **之前**（否则 CP 未定义）', st.body.indexOf('/chart-path.js') < st.body.indexOf('src="/status.js"'))
  {
    // 空态也要带 data-chart，否则「空 → 有数据」时前端找不到容器
    const empty = (st.body.match(/chart-empty[^>]*data-chart|data-chart[^>]*chart-empty/g) || []).length
    check('空态容器也带 data-chart（否则双向切换失败）', empty >= 1 || !st.body.includes('chart-empty'), `命中 ${empty}`)
  }

  console.log('\n[API 数据（本票断言依赖闸门 + 拍平后的形状）]')
  const apiRes = await authed('/api/status')
  const apiBody = apiRes.body
  const api = JSON.parse(apiBody)
  check('目标数正确', api.targets.length === 3, `got ${api.targets.length}`)

  // ── 公开契约形状：显式白名单，逐键钉住 ──
  check('顶层恰好 6 个键', Object.keys(api).length === 6, Object.keys(api).join(','))
  const t0 = api.targets[0]
  check('targets[] 恰好 10 个键', Object.keys(t0).length === 10, Object.keys(t0).join(','))
  check(
    'targets[] 键集符合白名单',
    JSON.stringify(Object.keys(t0).sort()) ===
      JSON.stringify(['avgLatencyMs', 'group', 'id', 'lastError', 'lastStatus', 'latency', 'name', 'p95LatencyMs', 'timeline', 'uptime']),
    Object.keys(t0).sort().join(','),
  )
  check('已拍平（不再有嵌套 target/stats 两层）', t0.target === undefined && t0.stats === undefined)

  // ── 泄漏断言：用**响应体子串搜索**，逐字段检查抓不住旁路 ──
  // 实测过：只投影掉 target.url 之后，仍泄漏的叶子字段是 targets[].lastError 与 incidents[].error。
  // 注意 `incidents[].targetId` 是**有意保留**的（把事件关联回目标名的连接键，见判定表 §2.2），
  // 与 targets[] 里被删掉的那个重复字段不是一回事 —— 所以这里不把它当泄漏。
  for (const word of ['"url"', 'expectStatus', 'samples', 'upCount', 'lastCheckedAt', 'upStreakMs', 'enabled']) {
    check(`响应体不含内部字段 ${word}`, !apiBody.includes(word), word)
  }

  const byId = Object.fromEntries(api.targets.map((t) => [t.id, t]))
  check('ok -> up', byId.ok.lastStatus === 'up', byId.ok.lastStatus)
  check('bad -> degraded', byId.bad.lastStatus === 'degraded', byId.bad.lastStatus)
  check('dead -> down', byId.dead.lastStatus === 'down', byId.dead.lastStatus)
  check('down 不记录延迟', byId.dead.avgLatencyMs === null)
  check('degraded 仍记录延迟', byId.bad.avgLatencyMs !== null)
  check('可用率为 0-1 之间', byId.ok.uptime !== null && byId.ok.uptime <= 1)
  check('时间线有数据', byId.ok.timeline.length >= 2, `tl=${byId.ok.timeline.length}`)
  check('延迟序列有数据', byId.ok.latency.length >= 2, `lat=${byId.ok.latency.length}`)
  check('可用率走势有数据', api.overview.length >= 2)
  check('timeline 点只含 3 个键', Object.keys(byId.ok.timeline[0]).length === 3, JSON.stringify(Object.keys(byId.ok.timeline[0])))
  check('latency 点只含 2 个键', Object.keys(byId.ok.latency[0]).length === 2, JSON.stringify(Object.keys(byId.ok.latency[0])))
  // 回归：整体可用率必须按「轮」聚合。若按 at 精确分组，每轮会被拆成 total=1 的点，
  // 百分比就只在 0 和 100 之间跳，永远看不到 33% 这种真实值。
  const totals = [...new Set(api.overview.map((p) => p.total))]
  check('可用率按轮聚合(每轮含全部目标)', totals.length === 1 && totals[0] === 3, `totals=${JSON.stringify(totals)}`)
  const pcts = [...new Set(api.overview.map((p) => Math.round((p.up / p.total) * 100)))]
  check('可用率不是 0/100 二值', !pcts.every((v) => v === 0 || v === 100), `pcts=${JSON.stringify(pcts)}`)
  // 回归：P95 不能退化成 max（floor(n*q) 的经典偏差）
  check('P95 >= 平均延迟', byId.ok.p95LatencyMs >= byId.ok.avgLatencyMs, `p95=${byId.ok.p95LatencyMs} avg=${byId.ok.avgLatencyMs}`)

  // ── 脱敏分流：自有文案必须保住，不能让「统一按 code 分类」把它抹掉 ──
  check(
    '排障信息不回归：超时文案仍是原文（不是「探测失败」）',
    /^超时（>\d+ms）$/.test(byId.dead.lastError || ''),
    `lastError=${JSON.stringify(byId.dead.lastError)}`,
  )
  check(
    '排障信息不回归：状态码文案仍是原文',
    /^状态码 \d+ 不在预期范围内$/.test(byId.bad.lastError || ''),
    `lastError=${JSON.stringify(byId.bad.lastError)}`,
  )
  // 允许的形态：自有文案（超时/状态码）、类别映射（`连接被重置（ECONNRESET）`）、兜底「探测失败」。
  // 不允许的：任何含 URL/主机名/异常的原文。
  check(
    'incidents[].error 与 lastError 走同一套脱敏（不能只修一处）',
    api.incidents.every(
      (i) =>
        i.error === null ||
        /^超时（>\d+ms）$|^状态码 \d+ 不在预期范围内$|^探测失败/.test(i.error) ||
        /^[^（）]{2,20}（[A-Z][A-Z0-9_]{2,63}）$/.test(i.error),
    ),
    JSON.stringify(api.incidents.map((i) => i.error).slice(0, 5)),
  )
  console.log('\n[安全性：真实载荷注入]')
  // ⚠ **断言质量原则**（本票定下的规矩，写在这里以免日后又写出恒真断言）：
  //   每一条安全断言都必须**先证明载荷真的出现在页面上**，再断言它没有被当成代码执行。
  //   否则「页面上没出现 `<script>`」这种断言，在**根本没有注入**时也永远通过——
  //   旧版那两条 `!/<script>alert/` 与 `!/href="javascript:/` 就是这样：恒真，零含金量。
  // 载荷同时覆盖「标签闭合逃逸」与「属性内逃逸」两种形态。
  const xss = '<script>alert(1)</script><img src=x onerror=alert(2)>'
  const attrXss = '" onmouseover="alert(3)" x="'
  // ⚠ 真源搬进 SQLite 之后（票 #54），**往 `content/` 写文件根本没有读者** —— 那是老夹具的做法。
  // 现在直接往库里写一行，并用**同一个** markdown → 文档的转换器造 body：
  // 这样这一面对「导入器」也顺带是一次回归，而不是绕过它造一条只有渲染器认得的数据。
  const { markdownToDoc } = await import('../dist/article-import.js')
  const { default: Database } = await import('better-sqlite3')
  const XSS_SLUG = 'xss-probe'
  const insertArticleFixture = () => {
    const db = new Database(TEST_DB)
    const now = Date.now()
    const body = JSON.stringify(markdownToDoc(xss).doc.toJSON())
    db.prepare(
      `INSERT INTO articles (slug, title, body, summary, date, tags, draft, created_at, updated_at, deleted_at)
       VALUES (@slug, @title, @body, @summary, @date, @tags, 0, @now, @now, NULL)
       ON CONFLICT(slug) DO UPDATE SET
         title = excluded.title, body = excluded.body, summary = excluded.summary,
         tags = excluded.tags, draft = 0, deleted_at = NULL, updated_at = excluded.updated_at`,
    ).run({ slug: XSS_SLUG, title: xss, body, summary: attrXss, date: '2026-01-02', tags: JSON.stringify([xss]), now })
    db.close()
  }
  const deleteArticleFixture = () => {
    const db = new Database(TEST_DB)
    db.prepare(`DELETE FROM articles WHERE slug = ?`).run(XSS_SLUG)
    db.close()
  }
  insertArticleFixture()
  try {
    // ── 注入面 1：文章标题 / 摘要 / 标签（列表页）──
    const listPage = await authed('/posts')
    check('注入面1 列表页：载荷**确实被渲染**（证明注入生效，否则下面的断言恒真）',
      listPage.body.includes('&lt;script&gt;'), '页面里找不到转义后的载荷')
    check('注入面1 列表页：标题未被注入为脚本', !/<script>alert\(1\)<\/script>/.test(listPage.body))
    check('注入面1 列表页：onerror 属性未被注入', !/<img src=x onerror=/.test(listPage.body))
    // ⚠ 属性内逃逸的判据要精确：转义后页面上仍会出现**无害的**文本 ` onmouseover=`，
    // 因为真正起作用的是引号被换成了 `&quot;`——它不再是属性分隔符。
    // 所以不能断言「页面上没有 onmouseover」，而要断言：**带真实引号的属性断裂序列不存在**，
    // 且载荷的引号**确实**被转义了（否则这条断言又变成恒真）。
    check('注入面1 列表页：真实引号的属性断裂序列不存在', !listPage.body.includes('" onmouseover="'))
    check('注入面1 列表页：载荷里的引号确实被转义（&quot;）', listPage.body.includes('&quot; onmouseover=&quot;'))

    // ── 注入面 2：文章正文（详情页，markdown-it html:false）──
    const detail = await authed('/posts/xss-probe')
    check('注入面2 详情页：渲染了该文章', detail.status === 200, `status=${detail.status}`)
    check('注入面2 详情页：正文载荷**确实被渲染**', detail.body.includes('&lt;script&gt;'))
    check('注入面2 详情页：正文未执行 HTML', !/<script>alert\(1\)<\/script>/.test(detail.body))

    // ── 注入面 3：标签路由把 tag **回显进 <h1>**（`标签：<payload>`）──
    // 这条以前只断言「不 500」，而「不 500」完全不能说明转义对不对。
    const tagPage = await authed('/tags/' + encodeURIComponent(xss))
    check('注入面3 标签路由：未 500', tagPage.status === 200 || tagPage.status === 404, `status=${tagPage.status}`)
    if (tagPage.status === 200) {
      check('注入面3 标签路由：h1 里的载荷**确实被渲染**', tagPage.body.includes('&lt;script&gt;'))
      check('注入面3 标签路由：h1 未被注入为脚本', !/<script>alert\(1\)<\/script>/.test(tagPage.body))
    }

    // ── 注入面 4：登录页的 `next` 隐藏域（未登录即可见，是闸门带来的**新**回显面）──
    // `next` 先过 `isSafeNextPath`，所以逃逸值会被丢弃；这里测的是**万一被保留**时渲染也必须转义。
    {
      const loginPage = await get('/login?next=' + encodeURIComponent('/posts/xss-probe'))
      check('注入面4 登录页：合法 next 被保留并渲染', loginPage.body.includes('value="/posts/xss-probe"'))
      const evilNext = await get('/login?next=' + encodeURIComponent('"><script>alert(9)</script>'))
      check('注入面4 登录页：逃逸 next 被丢弃（回退 /）', /name="next" value="\/"/.test(evilNext.body), '未回退')
      check('注入面4 登录页：响应里没有可执行脚本', !/<script>alert\(9\)<\/script>/.test(evilNext.body))
    }

    // ── 注入面 5：目标名（来自 targets.json，属运维输入而非用户输入，仍须转义）──
    {
      const panel = await authed('/status')
      check('注入面5 面板：目标名**确实被渲染**', panel.body.includes('状态码不符'), '找不到已知目标名')
      check('注入面5 面板：目标名未被当成 HTML', !/<script>alert\(1\)<\/script>/.test(panel.body))
    }

    // ── 注入面 6：错误文案上屏（写入侧已脱敏，上屏仍要转义）──
    {
      const panel = await authed('/status')
      check('注入面6 面板：失败原因可见（证明这条通路在用）', panel.body.includes('target-error') || panel.body.includes('超时'))
      check('注入面6 面板：错误文案里没有可执行标记', !/onerror=alert/.test(panel.body))
    }

    // ── 注入面 7：站点标题/描述（来自环境变量 SITE_TITLE）──
    check('注入面7 站点标题被正确渲染', listPage.body.includes('验收站'), 'SITE_TITLE 未出现在页面')
  } finally {
    deleteArticleFixture()
  }

  // ══════════════════════════════════════════════════════════
  console.log('\n[草稿纪律（迁移后必须一字不变）]')
  // ══════════════════════════════════════════════════════════
  // 为什么这条断言归本票（#54）：草稿过滤原来在 `listPosts()` 的内存里，本票把它挪进了 SQL
  // （`listArticlesForReaders()` 的 `WHERE draft = 0`）—— 挪动过滤位置正是最容易漏草稿的动作。
  //
  // ⚠ 写法按 ADR 0004 的纪律：**「草稿不在列表里」是一条否定断言，如果那篇根本没入库，它也照样通过。**
  // 所以下面配了**对照组**：把它改成已发布，它必须**当场出现**。少了对照组，前两条是恒真的
  // ——研究 §4 核实过，本仓此前一条草稿断言都没有，正是这种恒真断言留下的空档。
  {
    const DRAFT_SLUG = 'draft-probe'
    const DRAFT_TITLE = '草稿探针'
    const DRAFT_TAG = '草稿标记'
    const setDraftState = (draft) => {
      const db = new Database(TEST_DB)
      const now = Date.now()
      const body = JSON.stringify(markdownToDoc('这一篇用来验证草稿纪律。').doc.toJSON())
      db.prepare(
        `INSERT INTO articles (slug, title, body, summary, date, tags, draft, created_at, updated_at, deleted_at)
         VALUES (?, ?, ?, '', '2026-01-03', ?, ?, ?, ?, NULL)
         ON CONFLICT(slug) DO UPDATE SET draft = excluded.draft, deleted_at = NULL, updated_at = excluded.updated_at`,
      ).run(DRAFT_SLUG, DRAFT_TITLE, body, JSON.stringify([DRAFT_TAG]), draft, now, now)
      db.close()
    }
    const dropDraftProbe = () => {
      const db = new Database(TEST_DB)
      db.prepare(`DELETE FROM articles WHERE slug = ?`).run(DRAFT_SLUG)
      db.close()
    }

    setDraftState(1)
    try {
      const list = await authed('/posts')
      check('草稿：**不在**文章列表里', !list.body.includes(DRAFT_TITLE), '列表页出现了草稿标题')
      const byTag = await authed('/tags/' + encodeURIComponent(DRAFT_TAG))
      check('草稿：标签页里也没有它', !byTag.body.includes(DRAFT_TITLE))
      // ⚠ 判据不能写成「标签页里搜不到这个标签名」——那个页面的 `<h1>` 回显的正是 URL 里的标签
      // （`标签：草稿标记`），所以字符串**按设计**就该出现。要在**标签条**上验：
      // 标签条取的是 `listTags()`（读面出口），草稿的标签不该进得去。
      check('草稿：它的标签也不在列表页的标签条里', !list.body.includes(DRAFT_TAG))
      const direct = await authed('/posts/' + DRAFT_SLUG)
      check('草稿：直链 **404**（不是「凭链接可预览」）', direct.status === 404, `status=${direct.status}`)

      // ── 对照组：证明上面三条不是恒真 ──
      setDraftState(0)
      const listAfter = await authed('/posts')
      check('对照组：**改成已发布后它当场出现**（证明前三条不是恒真）', listAfter.body.includes(DRAFT_TITLE))
      const directAfter = await authed('/posts/' + DRAFT_SLUG)
      check('对照组：已发布的直链 200', directAfter.status === 200, `status=${directAfter.status}`)
      check('对照组：正文真的渲染了', directAfter.body.includes('验证草稿纪律'))
    } finally {
      dropDraftProbe()
    }
  }

  // ══════════════════════════════════════════════════════════
  console.log('\n[中文 slug（规格 #48 的「前提条件」）]')
  // ══════════════════════════════════════════════════════════
  // 规格把「`/posts/:slug` 补 `decodeURIComponent`」写成「允许中文 slug」的**前提条件**：
  // 「不修这条，『允许中文』就是假的」。
  // #54 修它的时候只**人工**验过一次 —— 这里把它钉成常驻断言：少了它，
  // 这条前提随时可能被下一次重构悄悄推翻，而没人会发现（因为所有既有断言都用 ASCII slug）。
  {
    const CN_SLUG = '中文标题探针'
    const CN_TEXT = '中文 slug 的正文'
    const insertCnProbe = () => {
      const db = new Database(TEST_DB)
      const now = Date.now()
      const body = JSON.stringify(markdownToDoc(CN_TEXT).doc.toJSON())
      db.prepare(
        `INSERT INTO articles (slug, title, body, summary, date, tags, draft, created_at, updated_at, deleted_at)
         VALUES (?, '中文 slug 探针', ?, '', '2026-01-04', '[]', 0, ?, ?, NULL)
         ON CONFLICT(slug) DO UPDATE SET draft = 0, deleted_at = NULL, updated_at = excluded.updated_at`,
      ).run(CN_SLUG, body, now, now)
      db.close()
    }
    const dropCnProbe = () => {
      const db = new Database(TEST_DB)
      db.prepare(`DELETE FROM articles WHERE slug = ?`).run(CN_SLUG)
      db.close()
    }

    insertCnProbe()
    try {
      const encoded = await authed('/posts/' + encodeURIComponent(CN_SLUG))
      check(
        '中文 slug：**编码后的直链 200**（这条就是 decodeURIComponent 的回归）',
        encoded.status === 200,
        `status=${encoded.status}`,
      )
      check('中文 slug：正文真的渲染了（证明 200 不是因为落到别的页面）', encoded.body.includes(CN_TEXT))
      const listWithCn = await authed('/posts')
      check('中文 slug：列表页的链接也是编码过的', listWithCn.body.includes(encodeURIComponent(CN_SLUG)))
    } finally {
      dropCnProbe()
    }
  }

  // ══════════════════════════════════════════════════════════
  console.log('\n[改密与吊销（会话语义）]')
  // ══════════════════════════════════════════════════════════
  const NEW_PASS = 'e2e-password-5678'
  {
    // 另一台「设备」先登录，稍后应当被踢掉
    const otherLogin = await postLogin(TEST_USER, TEST_PASS)
    const otherCookie = otherLogin.setCookie.split(';')[0]
    check('第二台设备能登录（前置条件成立）', (await get('/status', { cookie: otherCookie })).status === 200)

    // 改密：当前浏览器重新签发，其他设备失效
    const res = await postForm('/password', {
      cookie: sessionCookie,
      form: { current: TEST_PASS, next: NEW_PASS, confirm: NEW_PASS },
      csrf: csrfFor(sessionCookie),
    })
    const newCookieHeader = res.setCookie
    check('改密成功（200）', res.status === 200, `got ${res.status}`)
    check('改密后重新下发了 cookie（自己不掉线）', /session=/.test(newCookieHeader), newCookieHeader.slice(0, 30))
    const rotated = newCookieHeader ? newCookieHeader.split(';')[0] : sessionCookie

    check('改密后当前浏览器仍登录', (await get('/status', { cookie: rotated })).status === 200)
    // 关键语义：改密递增 token_version，其他设备的旧 cookie 立刻失配
    const kicked = await get('/status', { cookie: otherCookie })
    check('**改密后其他设备被踢下线**（旧 cookie 失效）', kicked.status === 302, `got ${kicked.status}`)

    sessionCookie = rotated

    // 旧口令不能再登录
    const oldPass = await postLogin(TEST_USER, TEST_PASS)
    check('改密后旧口令不能登录', oldPass.status === 401, `got ${oldPass.status}`)
    // 新口令可以
    const newPassLogin = await postLogin(TEST_USER, NEW_PASS)
    check('改密后新口令可以登录', newPassLogin.status === 302, `got ${newPassLogin.status}`)
    sessionCookie = newPassLogin.setCookie.split(';')[0]
  }

  // ══════════════════════════════════════════════════════════
  console.log('\n[登出]')
  // ══════════════════════════════════════════════════════════
  {
    // 第二台「设备」先登录 —— 稍后它**必须仍然有效**（判定表 §5 第 24 行：登出 ≠ 踢掉所有设备）
    const otherDevice = await postLogin(TEST_USER, NEW_PASS)
    const otherCookie = otherDevice.setCookie.split(';')[0]
    check('登出前提：第二台设备此前是登录态', (await get('/status', { cookie: otherCookie })).status === 200)

    const res = await postForm('/logout', { cookie: sessionCookie, csrf: csrfFor(sessionCookie) })
    const cleared = res.setCookie
    check('登出 -> 302 到登录页', res.status === 302, `got ${res.status}`)
    check('登出清了 cookie（Max-Age=0）', /Max-Age=0/.test(cleared), cleared)

    /*
     * ⚠ **#55 起：登出 = 真吊销。这条断言此前断言的正好相反。**
     *
     * 旧版写的是「已知局限：登出后原 cookie 重放仍有效」—— 当时登出只清本机 cookie，
     * 服务端没有失效名单，所以那是**如实的**记录。现在它是 bug：登出把 `sessions` 那一行
     * 标记 `revoked_at`，重放必须失效。
     * **反转它，而不是删掉它** —— 删掉就没人再守着「登出到底有没有真吊销」这件事了。
     */
    const replayed = await get('/status', { cookie: sessionCookie })
    check(
      '**登出后原 cookie 重放已失效**（登出 = 真吊销，不再是「本机遗忘」）',
      replayed.status === 302,
      `got ${replayed.status}`,
    )
    // 第 24 行：只吊销**这一份**，同账号其他设备不受影响。
    // 少了这条，「把登出实现成 bumpTokenVersion」也能通过上面那条 —— 而用户要的**恰恰是不要**那样。
    check(
      '**登出后第二台设备仍然有效**（登出 ≠ 踢掉所有设备）',
      (await get('/status', { cookie: otherCookie })).status === 200,
    )

    // ⑦ 升级前的老 cookie（签名**合法**、载荷里没有 sid）→ 302，**不是 500**
    {
      const { signSession } = await import('../dist/session.js')
      const legacy = signSession('e2e-only-secret-not-used-anywhere-else', {
        uid: 1,
        exp: Date.now() + 3_600_000,
        pv: 1,
      })
      check(
        '旧格式 cookie（无 sid）→ 302 而不是 500',
        (await get('/status', { cookie: 'session=' + legacy })).status === 302,
      )
      check(
        '旧格式 cookie 走 API 也是 401 而不是 500',
        (await get('/api/status', { cookie: 'session=' + legacy })).status === 401,
      )
    }
    // 真吊销通道：CLI --revoke-sessions
    const { execFileSync } = await import('node:child_process')
    execFileSync(process.execPath, ['dist/cli/passwd.js', '--user', TEST_USER, '--revoke-sessions'], {
      cwd: ROOT,
      env: { ...process.env, DATABASE_PATH: TEST_DB },
      stdio: 'ignore',
    })
    const afterRevoke = await get('/status', { cookie: sessionCookie })
    check('CLI --revoke-sessions 之后旧 cookie 真失效', afterRevoke.status === 302, `got ${afterRevoke.status}`)
    // ⚠ 用**第二台设备**的 cookie 断言才有意义：登出已经把 sessionCookie 吊销过了，
    // 拿它来验「账号级吊销」是**恒真**的 —— 那正是「断言必须先证明前提」要防的东西。
    check(
      'CLI --revoke-sessions 踢掉**该账号剩余**的会话（第二台设备也失效）',
      (await get('/status', { cookie: otherCookie })).status === 302,
    )
    // 且口令未被改，仍能登录
    const stillWorks = await postLogin(TEST_USER, NEW_PASS)
    check('--revoke-sessions 不改口令，原口令仍可登录', stillWorks.status === 302, `got ${stillWorks.status}`)
    sessionCookie = stillWorks.setCookie.split(';')[0]
  }

  // ══════════════════════════════════════════════════════════
  console.log('\n[停用账号立即生效]')
  // ══════════════════════════════════════════════════════════
  {
    const live = await get('/status', { cookie: sessionCookie })
    check('停用前是登录态（前置条件成立）', live.status === 200, `got ${live.status}`)
    const { execFileSync } = await import('node:child_process')
    const cliEnv = { ...process.env, DATABASE_PATH: TEST_DB }
    execFileSync(process.execPath, ['dist/cli/passwd.js', '--user', TEST_USER, '--disable'], { cwd: ROOT, env: cliEnv, stdio: 'ignore' })
    const disabled = await get('/status', { cookie: sessionCookie })
    check('**停用后立刻失效**（enabled 每请求被查）', disabled.status === 302, `got ${disabled.status}`)
    const apiDisabled = await get('/api/status', { cookie: sessionCookie })
    check('停用后 API 也 401', apiDisabled.status === 401, `got ${apiDisabled.status}`)
    // 停用账号即使口令正确也不放行
    const loginDisabled = await postLogin(TEST_USER, NEW_PASS)
    check('停用账号不能登录（口令正确也不行）', loginDisabled.status === 401, `got ${loginDisabled.status}`)
    execFileSync(process.execPath, ['dist/cli/passwd.js', '--user', TEST_USER, '--enable'], { cwd: ROOT, env: cliEnv, stdio: 'ignore' })
    const reLogin = await postLogin(TEST_USER, NEW_PASS)
    check('重新启用后可以登录', reLogin.status === 302, `got ${reLogin.status}`)
    sessionCookie = reLogin.setCookie.split(';')[0]
  }

  // ══════════════════════════════════════════════════════════
  console.log('\n[并发访问]')
  // ══════════════════════════════════════════════════════════
  // 并发下最容易出问题的是「每请求查一次库」的会话校验：并发读写同一个 SQLite 连接，
  // 以及「同一个 cookie 被 N 个请求同时校验」。这里断言全部成功且数据一致。
  {
    const N = 24
    const paths = ['/status', '/api/status', '/', '/posts', '/healthz', '/login']
    const results2 = await Promise.all(
      Array.from({ length: N }, (_, i) => {
        const p = paths[i % paths.length]
        const isPublic = p === '/healthz' || p === '/login'
        return (isPublic ? get(p) : authed(p)).then((r) => ({ p, status: r.status, body: r.body }))
      }),
    )
    const bad = results2.filter((r) => r.status !== 200 && r.status !== 302)
    check(`并发 ${N} 个请求全部成功（无 5xx）`, bad.length === 0, bad.map((b) => `${b.p}=${b.status}`).join(','))
    // 并发会话校验必须一致：受保护路径在**同一个有效 cookie** 下不该有的 200 有的 302
    const protectedOnes = results2.filter((r) => !['/healthz', '/login'].includes(r.p))
    const statuses = [...new Set(protectedOnes.map((r) => r.status))]
    check('并发下会话校验结果一致（同一 cookie 不会时而有效时而失效）', statuses.length === 1, `statuses=${statuses.join(',')}`)
    // 并发下 API 数据也要自洽
    const apis = results2.filter((r) => r.p === '/api/status')
    const shapes = new Set(
      apis.map((r) => {
        try { return Object.keys(JSON.parse(r.body)).sort().join(',') } catch { return 'PARSE_FAIL' }
      }),
    )
    check('并发下 API 形状自洽（没有半个响应）', shapes.size === 1 && !shapes.has('PARSE_FAIL'), [...shapes].join(' | '))
  }

  console.log('\n[进程健壮性]')
  check('服务全程未崩溃', child.exitCode === null && !/启动失败/.test(serverLog))
  check('探测日志正常输出', /\[probe\]/.test(serverLog))

  // ══════════════════════════════════════════════════════════
  console.log('\n[无目标清单：面板不崩，明说「还没配置」]')
  // ══════════════════════════════════════════════════════════
  // 单独起一个实例（端口 3994）而不是复用主实例：主实例有 3 个目标，改不了。
  {
    const PORT2 = 3994
    const BASE2 = `http://127.0.0.1:${PORT2}`
    const child2 = spawn(process.execPath, ['dist/server.js'], {
      cwd: ROOT,
      env: {
        ...process.env,
        PORT: String(PORT2),
        HOST: '127.0.0.1',
        TARGETS_JSON: '[]',
        DATABASE_PATH: TEST_DB, // 复用同一个库：账号建在那个库里，换库会登不上
        SESSION_SECRET: 'e2e-empty-targets-secret',
        SITE_ORIGIN: BASE2,
        SITE_TITLE: '空目标站',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let log2 = ''
    child2.stdout.on('data', (d) => (log2 += d))
    child2.stderr.on('data', (d) => (log2 += d))
    try {
      let up = false
      for (let i = 0; i < 40; i++) {
        try { if ((await fetch(BASE2 + '/healthz')).ok) { up = true; break } } catch {}
        await sleep(250)
      }
      check('无目标清单时服务仍能启动（不因空清单崩溃）', up, '未起来')
      if (up) {
        // 未登录仍应被闸门拦住
        const anon = await fetch(BASE2 + '/status', { redirect: 'manual' })
        check('无目标时闸门仍生效（未登录 302）', anon.status === 302, `got ${anon.status}`)
        // 登录后看面板
        const lr = await fetch(BASE2 + '/login', {
          method: 'POST', redirect: 'manual',
          // L2 对**所有**非安全方法 fail-closed：这个实例的允许来源是 BASE2，所以必须带上它。
          headers: { 'content-type': 'application/x-www-form-urlencoded', origin: BASE2 },
          body: new URLSearchParams({ username: TEST_USER, password: NEW_PASS, next: '/status' }),
        })
        const ck = (lr.headers.get('set-cookie') || '').split(';')[0]
        check('无目标实例也能登录（共用同一个库，账号在）', ck.startsWith('session='), `login=${lr.status}`)
        const panel = await fetch(BASE2 + '/status', { headers: { cookie: ck } })
        const html = await panel.text()
        check('无目标时面板 200（不是 500）', panel.status === 200, `got ${panel.status}`)
        check('面板明说「还没有配置被监控的系统」而不是空白', /还没有配置被监控的系统/.test(html), html.slice(0, 200).replace(/\s+/g, ' '))
        const api = await fetch(BASE2 + '/api/status', { headers: { cookie: ck } })
        const body = await api.json()
        check('空清单时 API 返回空数组（不是 null/undefined）', Array.isArray(body.targets) && body.targets.length === 0, JSON.stringify(body.targets))
        check('空清单时 overview 也是数组', Array.isArray(body.overview))
        check('空清单时服务未崩溃', child2.exitCode === null && !/启动失败/.test(log2), log2.slice(-200))
        check('启动时给出「还没有配置被监控的系统」提示', /还没有配置被监控的系统/.test(log2), log2.split('\n').find((l) => l.includes('配置')) || '(无)')
      }
    } finally {
      child2.kill('SIGTERM')
      await sleep(600)
    }
  }
  // ══════════════════════════════════════════════════════════
  console.log('\n[写路径：L2 来源校验 + L3 令牌（#38）]')
  // ══════════════════════════════════════════════════════════
  {
    // **先证明前提**：同源 POST 是通的 —— 否则下面每一条「拒绝」都可能是恒真的。
    const ok = await postForm('/login', { form: { username: TEST_USER, password: NEW_PASS, next: '/' } })
    check('前提：同源 POST 通（302 下发 cookie）', ok.status === 302, `got ${ok.status}`)
    const cookieA = ok.setCookie.split(';')[0]
    check('前提：能从会话 cookie 算出非空 token', csrfFor(cookieA).length > 0)

    // ── L2 的反例 ──
    const form = { username: TEST_USER, password: NEW_PASS }
    check(
      '**删掉 Origin 与 Referer → 403**（直连 IP 调写接口正是要拒绝的形状）',
      (await postForm('/login', { form, origin: null })).status === 403,
    )
    check(
      '`Origin: null` → 403（它不是「没有来源」，是「来源不可知」）',
      (await postForm('/login', { form, origin: 'null' })).status === 403,
    )
    check(
      '站外 Origin → 403',
      (await postForm('/login', { form, origin: 'http://evil.example.com' })).status === 403,
    )
    check(
      '**后缀型伪造 → 403**（`includes` 型比较会把它放进来）',
      (await postForm('/login', { form, origin: BASE + '.evil.com' })).status === 403,
    )
    check(
      '前缀型伪造 → 403',
      (await postForm('/login', { form, origin: 'http://evil.com#' + BASE })).status === 403,
    )
    check(
      'Origin 缺失但 Referer 同源 → 放行（回退只取 origin 部分）',
      (await postForm('/login', { form, origin: null, referer: BASE + '/login?x=1' })).status === 302,
    )
    check(
      'Referer 站外 → 403',
      (await postForm('/login', { form, origin: null, referer: 'http://evil.example.com/login' })).status === 403,
    )
    // 判定**不读** req.hostname / req.protocol：伪造 X-Forwarded-* 不该改变结果
    {
      const res = await fetch(BASE + '/login', {
        method: 'POST',
        redirect: 'manual',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          origin: BASE,
          'x-forwarded-host': 'evil.com',
          'x-forwarded-proto': 'https',
        },
        body: new URLSearchParams(form),
      })
      check('加 `X-Forwarded-Host: evil.com` 判定不变（trustProxy 默认关、判定也不读它）', res.status === 302, `got ${res.status}`)
    }

    // ── L3 的反例 ──
    check('前提：这个会话此刻是登录态', (await get('/status', { cookie: cookieA })).status === 200)
    check('缺 csrf → 403', (await postForm('/logout', { cookie: cookieA })).status === 403)
    check(
      'csrf 长度不对 → 403（**不是 500**：先比长度再 timingSafeEqual）',
      (await postForm('/logout', { cookie: cookieA, csrf: 'short' })).status === 403,
    )
    check(
      'csrf 等长但不对 → 403',
      (await postForm('/logout', { cookie: cookieA, csrf: 'x'.repeat(43) })).status === 403,
    )
    {
      const other = await postForm('/login', { form: { username: TEST_USER, password: NEW_PASS, next: '/' } })
      const cookieB = other.setCookie.split(';')[0]
      check(
        '**用另一个会话算的 token → 403**',
        (await postForm('/logout', { cookie: cookieA, csrf: csrfFor(cookieB) })).status === 403,
      )
    }
    check(
      '前提：几次被拒之后会话仍然有效（**拒绝不产生副作用**）',
      (await get('/status', { cookie: cookieA })).status === 200,
    )

    // ── 页面里真的渲染了 token（这两条证明 ALS 那条路是通的）──
    const page = await get('/status', { cookie: cookieA })
    const m = page.body.match(/<form class="logout-form"[^>]*>[\s\S]*?name="csrf" value="([^"]*)"/)
    check('登出表单**带上了非空 token**（ALS 生效）', !!m && m[1].length > 0, m ? `len=${m[1].length}` : '没匹配到表单')
    check('表单里那枚 token 就是本会话的那一枚', !!m && m[1] === csrfFor(cookieA))
    // 用**页面里那枚**（而不是自己算的）提交 —— 浏览器走的就是这条路
    const viaForm = await postForm('/logout', { cookie: cookieA, csrf: m ? m[1] : '' })
    check('用页面里那枚 token 登出成功（浏览器走的就是这条路）', viaForm.status === 302, `got ${viaForm.status}`)
    check('带 token 的响应有 `Cache-Control: no-store`', /no-store/.test(viaForm.cacheControl), viaForm.cacheControl)

    // ── 改密后**旧页面的** token 失效 ──
    {
      const c = await postForm('/login', { form: { username: TEST_USER, password: NEW_PASS, next: '/' } })
      const cookieC = c.setCookie.split(';')[0]
      const oldToken = csrfFor(cookieC)
      const changed = await postForm('/password', {
        cookie: cookieC,
        form: { current: NEW_PASS, next: NEW_PASS, confirm: NEW_PASS },
        csrf: oldToken,
      })
      check('前提：改密成功', changed.status === 200, `got ${changed.status}`)
      const cookieD = changed.setCookie.split(';')[0]
      check(
        '**改密成功后，旧页面那枚 token → 403**（会话重签，token 随之全变）',
        (
          await postForm('/password', {
            cookie: cookieD,
            form: { current: NEW_PASS, next: NEW_PASS, confirm: NEW_PASS },
            csrf: oldToken,
          })
        ).status === 403,
      )
      check(
        '新会话的新 token 可用（证明上一条不是恒真）',
        (
          await postForm('/password', {
            cookie: cookieD,
            form: { current: NEW_PASS, next: NEW_PASS, confirm: NEW_PASS },
            csrf: csrfFor(cookieD),
          })
        ).status === 200,
      )
    }
  }

  // ══════════════════════════════════════════════════════════
  console.log('\n[角色：默认只读与守卫（走 CLI 那条路）]')
  // ══════════════════════════════════════════════════════════
  // ⚠ 为什么在 e2e 里再测一遍：unit-check 测的是 `setRole()` / `setEnabled()` **函数**，
  //    而这里是**命令行**那条路 —— 参数解析、退出码，以及「CLI 不是绕过守卫的后门」。
  {
    const { execFileSync } = await import('node:child_process')
    const cliEnv = { ...process.env, DATABASE_PATH: TEST_DB }
    const runCli = (...args) => {
      try {
        const out = execFileSync(process.execPath, ['dist/cli/passwd.js', ...args], {
          cwd: ROOT,
          env: cliEnv,
          encoding: 'utf8',
        })
        return { code: 0, out }
      } catch (err) {
        return { code: err.status ?? 1, out: String(err.stdout ?? '') + String(err.stderr ?? '') }
      }
    }

    // 新建账号默认只读 —— 最小权限，不是「顺手给的默认值」
    runCli('--user', 'roleprobe', '--password', 'roleprobe-password-1')
    const listed = runCli('--list')
    check(
      'CLI 新建的账号默认是**只读**',
      /roleprobe\s+id=\d+\s+只读/.test(listed.out),
      listed.out.split('\n').find((l) => l.includes('roleprobe')) ?? '',
    )

    // 提权是恢复通道，永不设卡
    const promoted = runCli('--user', 'roleprobe', '--role', 'admin')
    check('CLI 提权成功（恢复通道永不设卡）', promoted.code === 0 && /改为 admin/.test(promoted.out), promoted.out.trim())

    // 前提先成立：此刻恰好一个管理员，否则下面的两条「拒绝」不成立
    const adminCount = (runCli('--list').out.match(/管理员/g) ?? []).length
    check('前提：此刻恰好一个启用中的管理员', adminCount === 1, `n=${adminCount}`)

    // 降级 / 停用最后一个管理员会被拒 —— 而且**退出码非零**（脚本里能判、cron 里能停）
    const demote = runCli('--user', 'roleprobe', '--role', 'readonly')
    check(
      'CLI 拒绝降级最后一个管理员（退出码非零）',
      demote.code !== 0 && /最后一个启用中的管理员/.test(demote.out),
      `code=${demote.code}`,
    )
    const disable = runCli('--user', 'roleprobe', '--disable')
    check(
      'CLI 拒绝停用最后一个管理员（退出码非零）',
      disable.code !== 0 && /最后一个启用中的管理员/.test(disable.out),
      `code=${disable.code}`,
    )

    // 非法角色在参数解析处就挡住（库里的 CHECK 是第二道）
    const bad = runCli('--user', 'roleprobe', '--role', 'admni')
    check('CLI 拒绝非法角色取值', bad.code !== 0 && /只能是 admin 或 readonly/.test(bad.out), bad.out.trim())
  }

  // ══════════════════════════════════════════════════════════
  console.log('\n[管理台外壳（#39）：入口 · 403 · 回跳 · notice 闭集]')
  // ══════════════════════════════════════════════════════════
  {
    // 管理员用角色那节刚提权的 roleprobe（它此刻是**唯一**启用中的管理员）。
    const adm = await postForm('/login', {
      form: { username: 'roleprobe', password: 'roleprobe-password-1', next: '/' },
    })
    const adminCookie = adm.setCookie.split(';')[0]
    check('前提：管理员能登录', adminCookie.startsWith('session='), `status=${adm.status}`)

    const overview = await get('/admin', { cookie: adminCookie })
    check('管理员 GET /admin → 200', overview.status === 200, `got ${overview.status}`)
    check('管理员顶栏含「管理」', />管理</.test(overview.body))
    check('「管理」被标成当前页（aria-current）', /aria-current="page"[^>]*>管理</.test(overview.body))
    check('概览页有四块摘要卡', (overview.body.match(/class="stat"/g) || []).length >= 4)
    check('概览页**不渲染目标列表**（不造第二份真相）', !/ledger\.internal\.example/.test(overview.body))
    check('页面上明说这一版是只读的', /<strong>只读<\/strong>/.test(overview.body))

    // ── 只读：**先断言同一响应里另外 4 项在**，再断言「管理」不在 ──
    // 少了前一条，「没有管理」在「整页都没渲染出来」时也会通过 —— 那是恒真断言。
    //
    // ⚠ 自己拿一个**新鲜**的只读会话，不复用模块级 `sessionCookie`：它在前面几节里
    // 被改密与吊销反复动过（改密会级联吊销该账号的全部会话），到这儿早就是死的了。
    const roLogin = await postForm('/login', {
      form: { username: TEST_USER, password: NEW_PASS, next: '/' },
    })
    const roCookie = roLogin.setCookie.split(';')[0]
    const ro = await get('/status', { cookie: roCookie })
    check('只读前提：这个会话是登录态', ro.status === 200, `got ${ro.status}`)
    check(
      '只读前提：同一响应里另外 4 项**都在**',
      ['首页', '分享', '系统可用性', '关于'].every((t) => ro.body.includes(`>${t}<`)),
    )
    check('只读顶栏**没有**「管理」这一项', !/>管理</.test(ro.body))
    const roAdmin = await get('/admin', { cookie: roCookie })
    check('只读 GET /admin → **403**（不是 404，也不是只读视图）', roAdmin.status === 403, `got ${roAdmin.status}`)
    check('403 页明说「需要管理员权限」', /需要管理员权限/.test(roAdmin.body))

    // ── 未登录 → 302 → /login?next=/admin，登录后回跳 ──
    const anon = await get('/admin')
    check(
      '未登录 /admin → 302 到 /login?next=/admin',
      anon.status === 302 && anon.location.includes('next=%2Fadmin'),
      `${anon.status} ${anon.location}`,
    )
    const back = await postForm('/login', {
      form: { username: 'roleprobe', password: 'roleprobe-password-1', next: '/admin' },
    })
    check('登录后回跳到 /admin', back.status === 302 && back.location === '/admin', `${back.status} ${back.location}`)

    // ── notice 闭集：**两个方向都要断言** ──
    // 只断言「乱编的不渲染」是空的（那时根本没有 notice 消费者）；先证明**有效 key 真的渲染**。
    const good = await get('/admin?notice=settings-saved', { cookie: adminCookie })
    check('有效 notice key → 渲染出对应文案', /class="notice"/.test(good.body) && /已保存设置/.test(good.body))
    const bogus = await get(
      '/admin?notice=' + encodeURIComponent('<script>alert(1)</script>'),
      { cookie: adminCookie },
    )
    check(
      '乱编的 notice key → **什么都不渲染**（提示文本不来自 URL）',
      bogus.status === 200 && !/alert\(1\)/.test(bogus.body) && !/class="notice/.test(bogus.body),
    )
    check(
      '合法但未登记的 key（`nonexistent`）也不渲染',
      !/class="notice/.test((await get('/admin?notice=nonexistent', { cookie: adminCookie })).body),
    )
  }


  // ══════════════════════════════════════════════════════════
  console.log('\n[管理台文章写路径（#50）：写 · 改 · 发 · 撤 + 草稿纪律]')
  // ══════════════════════════════════════════════════════════
  {
    // 用角色那节提权的 roleprobe（管理员），壳那节已经证明它能登进管理台
    const adm = await postForm('/login', {
      form: { username: 'roleprobe', password: 'roleprobe-password-1', next: '/' },
    })
    const admin = adm.setCookie.split(';')[0]
    const csrf = () => csrfFor(admin)
    const SLUG = 'e2e-写路径探针'
    const TITLE = 'e2e 写路径探针标题'
    const MD = '# 一级标题\n\n正文**加粗**与 `代码`。\n\n- 甲\n- 乙\n'

    // 前置：管理台文章页在
    const list0 = await get('/admin/articles', { cookie: admin })
    check('前提：管理员能打开 /admin/articles', list0.status === 200, `got ${list0.status}`)
    check('前提：页面上有「新建一篇」入口', /新建一篇/.test(list0.body))

    // ① 新建（**默认草稿**）
    const created = await postForm('/admin/articles', {
      cookie: admin,
      csrf: csrf(),
      form: { action: 'article-create', slug: SLUG, title: TITLE, date: '2026-03-01', tags: '探针, 验收', summary: '', body_md: MD },
    })
    check('① 新建 → 302（PRG，刷新不重复提交）', created.status === 302, `got ${created.status}`)
    check('① 回跳到编辑面并带 notice', /edit=.*notice=article-created/.test(created.location), created.location)

    // ② 草稿纪律：读面三处都看不见它
    const posts = await get('/posts', { cookie: admin })
    check('② 草稿**不在** /posts 列表里', !posts.body.includes(TITLE))
    const tagsPage = await get('/tags/' + encodeURIComponent('探针'), { cookie: admin })
    check('② 草稿的标签也翻不到它', !tagsPage.body.includes(TITLE))
    const direct = await get('/posts/' + encodeURIComponent(SLUG), { cookie: admin })
    check('② 草稿直链 **404**（不是「凭链接可预览」）', direct.status === 404, `got ${direct.status}`)

    // ③ 但在管理台里能打开，且**正文被还原成 Markdown**（docToMarkdown 的用处）
    const editPage = await get('/admin/articles?edit=' + encodeURIComponent(SLUG), { cookie: admin })
    check('③ ?edit= 能打开草稿', editPage.status === 200 && editPage.body.includes(TITLE))
    check('③ **正文回填**（文档 JSON 还原成了 Markdown）', editPage.body.includes('# 一级标题') && editPage.body.includes('**加粗**'))
    check('③ 草稿在管理台内**有预览**（读者看不到）', /article-preview/.test(editPage.body) && /一级标题/.test(editPage.body))
    check('③ slug 对已有文章是只读的（发布后不可改）', /name="slug"[^>]*readonly/.test(editPage.body))

    // ④ 保存（改标题 + 改正文）→ 仍是草稿
    const saved = await postForm('/admin/articles', {
      cookie: admin,
      csrf: csrf(),
      form: { action: 'article-save', orig_slug: SLUG, slug: SLUG, title: TITLE + '（改过）', date: '2026-03-01', tags: '探针', summary: '', body_md: MD + '\n新增一段。\n' },
    })
    check('④ 保存 → 302 + notice', saved.status === 302 && /notice=article-saved/.test(saved.location), saved.location)
    const stillDraft = await get('/posts/' + encodeURIComponent(SLUG), { cookie: admin })
    check('④ 保存**不改状态**（还是草稿，直链仍 404）', stillDraft.status === 404, `got ${stillDraft.status}`)

    // ⑤ 发布 → 读面立刻可见
    const pub = await postForm('/admin/articles', {
      cookie: admin,
      csrf: csrf(),
      form: { action: 'article-publish', orig_slug: SLUG },
    })
    check('⑤ 发布 → 302 + notice', pub.status === 302 && /notice=article-published/.test(pub.location), pub.location)
    const live = await get('/posts/' + encodeURIComponent(SLUG), { cookie: admin })
    check('⑤ 发布后直链 **200**', live.status === 200, `got ${live.status}`)
    check('⑤ 正文真的渲染了（加粗成了 <strong>）', /<strong>加粗<\/strong>/.test(live.body))
    check('⑤ 出现在列表里', (await get('/posts', { cookie: admin })).body.includes(TITLE + '（改过）'))

    // ⑥ 撤下 → 回到草稿
    const unpub = await postForm('/admin/articles', {
      cookie: admin,
      csrf: csrf(),
      form: { action: 'article-unpublish', orig_slug: SLUG },
    })
    check('⑥ 撤下 → 302 + notice', unpub.status === 302 && /notice=article-unpublished/.test(unpub.location), unpub.location)
    check('⑥ 撤下后直链又 **404**', (await get('/posts/' + encodeURIComponent(SLUG), { cookie: admin })).status === 404)
    check('⑥ 但文章还在（管理台里打开得到）', (await get('/admin/articles?edit=' + encodeURIComponent(SLUG), { cookie: admin })).status === 200)

    // ⑦ 撞名 → 400，**正文必须还在**（票面：这是这个页面能犯的最贵的一次错）
    const LONG = '这是一段很长很长的正文。'.repeat(40)
    const dup = await postForm('/admin/articles', {
      cookie: admin,
      csrf: csrf(),
      form: { action: 'article-create', slug: SLUG, title: '撞名的那篇', date: '2026-03-02', tags: '', summary: '', body_md: LONG },
    })
    check('⑦ 撞名 → **400**', dup.status === 400, `got ${dup.status}`)
    check('⑦ 文案给出占用者标题', dup.body.includes(TITLE), '没看到占用者标题')
    check('⑦ **正文还在**（三千字被打回、正文却空了，是最贵的一次错）', dup.body.includes('这是一段很长很长的正文。'))
    check('⑦ 失败页也带 notice-bad 横幅', /notice notice-bad/.test(dup.body))

    // ⑧ 非法标签（名字即 URL，禁 `/`）→ 400
    const badTag = await postForm('/admin/articles', {
      cookie: admin,
      csrf: csrf(),
      form: { action: 'article-create', slug: SLUG + '-2', title: '标签不合法', date: '2026-03-03', tags: 'a/b', summary: '', body_md: '正文' },
    })
    check('⑧ 标签含 `/` → 400', badTag.status === 400, `got ${badTag.status}`)
    check('⑧ 文案说明为什么', /标签名/.test(badTag.body))

    // ⑨ 未知 action → 400（闭集）
    const badAction = await postForm('/admin/articles', {
      cookie: admin,
      csrf: csrf(),
      form: { action: 'article-drop-table', orig_slug: SLUG },
    })
    check('⑨ 未知 action → 400（闭集，不拼进 SQL）', badAction.status === 400, `got ${badAction.status}`)

    // ⑩ 缺 L3 token → 403（写路由全都过同一个守卫）
    const noCsrf = await postForm('/admin/articles', {
      cookie: admin,
      form: { action: 'article-publish', orig_slug: SLUG },
    })
    check('⑩ 缺 csrf → 403', noCsrf.status === 403, `got ${noCsrf.status}`)

    // ⑪ 只读 → 403（不是 404、不是重定向）
    const roLogin2 = await postForm('/login', { form: { username: TEST_USER, password: NEW_PASS, next: '/' } })
    const roCookie2 = roLogin2.setCookie.split(';')[0]
    check('⑪ 只读 GET /admin/articles → **403**', (await get('/admin/articles', { cookie: roCookie2 })).status === 403)
    const roWrite = await postForm('/admin/articles', {
      cookie: roCookie2,
      csrf: csrfFor(roCookie2),
      form: { action: 'article-publish', orig_slug: SLUG },
    })
    check('⑪ 只读写 → **403**（且不是重定向）', roWrite.status === 403, `got ${roWrite.status}`)


    // ── 回收站（#51 前半）：软删除 · 还原回原状态 · slug 仍占位 · 彻底删除 ──
    // 先发布，好验证「还原回**已发布**」这一侧
    await postForm('/admin/articles', { cookie: admin, csrf: csrf(), form: { action: 'article-publish', orig_slug: SLUG } })
    check('回收站前提：文章此刻是已发布（直链 200）', (await get('/posts/' + encodeURIComponent(SLUG), { cookie: admin })).status === 200)

    const trashed = await postForm('/admin/articles', { cookie: admin, csrf: csrf(), form: { action: 'article-trash', orig_slug: SLUG } })
    check('⑫ 移进回收站 → 302 + notice', trashed.status === 302 && /notice=article-trashed/.test(trashed.location), trashed.location)
    check('⑫ 读者立刻看不到（直链 404）', (await get('/posts/' + encodeURIComponent(SLUG), { cookie: admin })).status === 404)
    check('⑫ 列表里也没有它', !(await get('/posts', { cookie: admin })).body.includes(TITLE))
    const withTrash = await get('/admin/articles', { cookie: admin })
    check('⑫ 管理台里能看到它在回收站（带「删除前状态」）', /回收站（1）/.test(withTrash.body) && withTrash.body.includes(TITLE))
    check(
      '⑫ 回收站里**不给编辑表单**（想改就先还原）',
      /这篇在<strong>回收站<\/strong>里/.test(
        (await get('/admin/articles?edit=' + encodeURIComponent(SLUG), { cookie: admin })).body,
      ),
    )

    // ⑬ slug 仍被占着 —— 免得旧链接被别人捡去用
    const dupTrashed = await postForm('/admin/articles', {
      cookie: admin,
      csrf: csrf(),
      form: { action: 'article-create', slug: SLUG, title: '想抢这个 slug', date: '2026-03-04', tags: '', summary: '', body_md: '正文' },
    })
    check('⑬ 回收站里的 slug **仍被占用**（撞名 400）', dupTrashed.status === 400, `got ${dupTrashed.status}`)
    check('⑬ 文案**明说它在回收站里**', /回收站/.test(dupTrashed.body))

    // ⑭ 回收站里的文章**不能改** —— 保存会悄悄还原它，那是坑
    const editTrashed = await postForm('/admin/articles', {
      cookie: admin,
      csrf: csrf(),
      form: { action: 'article-save', orig_slug: SLUG, slug: SLUG, title: '偷改回收站里的文章', date: '2026-03-01', tags: '', summary: '', body_md: '不该写进去' },
    })
    check('⑭ 对回收站里的文章「保存」→ **400**（不许悄悄还原）', editTrashed.status === 400, `got ${editTrashed.status}`)
    check('⑭ 文案告诉用户先还原', /先还原/.test(editTrashed.body))

    // ⑮ 还原 → **回到删除前那个状态**（`deleted_at` 正交于 `draft` 的证明）
    const restored = await postForm('/admin/articles', { cookie: admin, csrf: csrf(), form: { action: 'article-restore', orig_slug: SLUG } })
    check('⑮ 还原 → 302 + notice', restored.status === 302 && /notice=article-restored/.test(restored.location), restored.location)
    check('⑮ **还原回「已发布」**（不用重新判断一遍）', (await get('/posts/' + encodeURIComponent(SLUG), { cookie: admin })).status === 200)
    check('⑮ 回收站空了', !/回收站（/.test((await get('/admin/articles', { cookie: admin })).body))

    // ⑯ 正交的另一侧：草稿进回收站、还原后**仍是草稿**
    await postForm('/admin/articles', { cookie: admin, csrf: csrf(), form: { action: 'article-unpublish', orig_slug: SLUG } })
    await postForm('/admin/articles', { cookie: admin, csrf: csrf(), form: { action: 'article-trash', orig_slug: SLUG } })
    await postForm('/admin/articles', { cookie: admin, csrf: csrf(), form: { action: 'article-restore', orig_slug: SLUG } })
    check('⑯ 草稿进回收站、还原后**仍是草稿**（直链 404）', (await get('/posts/' + encodeURIComponent(SLUG), { cookie: admin })).status === 404)

    // ⑰ 彻底删除：**不勾确认框 → 400**（判据在服务端 —— 禁用 JS 也要拦得住）
    await postForm('/admin/articles', { cookie: admin, csrf: csrf(), form: { action: 'article-trash', orig_slug: SLUG } })
    const noConfirm = await postForm('/admin/articles', { cookie: admin, csrf: csrf(), form: { action: 'article-purge', orig_slug: SLUG } })
    check('⑰ 彻底删除**不勾确认框 → 400**', noConfirm.status === 400, `got ${noConfirm.status}`)
    check('⑰ 文章还在（没被删掉）', (await get('/admin/articles?edit=' + encodeURIComponent(SLUG), { cookie: admin })).status === 200)

    // ⑱ 勾了 → 真的删掉，**连同它的全部修订**（规格 #48 的单元缝之一）
    const { default: Database } = await import('better-sqlite3')
    const countRevs = () => {
      const db = new Database(TEST_DB, { readonly: true })
      const n = db.prepare('SELECT COUNT(*) AS n FROM article_revisions WHERE slug = ?').get(SLUG).n
      db.close()
      return n
    }
    check('⑱ 前提：它确实有修订行（保存/发布各留过）', countRevs() > 0, `n=${countRevs()}`)
    const purged = await postForm('/admin/articles', {
      cookie: admin,
      csrf: csrf(),
      form: { action: 'article-purge', orig_slug: SLUG, confirm: 'yes' },
    })
    check('⑱ 彻底删除 → 302 + notice', purged.status === 302 && /notice=article-purged/.test(purged.location), purged.location)
    check('⑱ 管理台里也打不开了（真的没了）', !(await get('/admin/articles')).body.includes(TITLE))
    check('⑱ **修订也一起被带走**', countRevs() === 0, `n=${countRevs()}`)

    // ── 修订历史（#51 后半）：每版全文 · 退回 · 退回本身也留痕 ──
    const RSLUG = 'e2e-修订探针'
    const revCount = () => {
      const db = new Database(TEST_DB, { readonly: true })
      const n = db.prepare('SELECT COUNT(*) AS n FROM article_revisions WHERE slug = ?').get(RSLUG).n
      db.close()
      return n
    }
    const revForm = (action, extra) => ({ action, orig_slug: RSLUG, slug: RSLUG, date: '2026-03-05', tags: '', summary: '', ...extra })

    await postForm('/admin/articles', { cookie: admin, csrf: csrf(), form: revForm('article-create', { title: '第一版标题', body_md: '第一版正文' }) })
    await postForm('/admin/articles', { cookie: admin, csrf: csrf(), form: revForm('article-save', { title: '第二版标题', body_md: '第二版正文' }) })
    await postForm('/admin/articles', { cookie: admin, csrf: csrf(), form: revForm('article-save', { title: '第三版标题', body_md: '第三版正文' }) })
    check('⑲ 保存三次 → 三条修订（**新建那次也留了**）', revCount() === 3, `n=${revCount()}`)

    const revPage = await get('/admin/articles?edit=' + encodeURIComponent(RSLUG), { cookie: admin })
    check('⑲ 编辑面列出修订历史', /修订历史（3）/.test(revPage.body))
    check('⑲ 每一版都能看全文', revPage.body.includes('第三版正文') && revPage.body.includes('第一版正文'))
    const order = ['第三版标题', '第二版标题', '第一版标题'].map((t) => revPage.body.indexOf(t))
    check('⑳ **最近的在最上面**（倒序）', order[0] < order[1] && order[1] < order[2], JSON.stringify(order))

    // 从页面上取「最早那版」的修订号（倒序列表 → 最后一个），不猜
    const revIds = [...revPage.body.matchAll(/name="revision" value="(\d+)"/g)].map((x) => Number(x[1]))
    const firstRevId = revIds[revIds.length - 1]
    check('⑳ 从页面上拿到了最早那版的修订号', Number.isInteger(firstRevId) && firstRevId > 0, `id=${firstRevId}`)

    // ㉑ 退回那一版
    const beforeRevert = revCount()
    const reverted = await postForm('/admin/articles', {
      cookie: admin,
      csrf: csrf(),
      form: { action: 'article-revert', orig_slug: RSLUG, revision: String(firstRevId) },
    })
    check('㉑ 退回 → 302 + notice', reverted.status === 302 && /notice=article-reverted/.test(reverted.location), reverted.location)
    const afterRevert = await get('/admin/articles?edit=' + encodeURIComponent(RSLUG), { cookie: admin })
    const textarea = (afterRevert.body.match(/name="body_md"[^>]*>([\s\S]*?)<\/textarea>/) || [])[1] ?? ''
    check('㉑ **当前正文等于那一版**', textarea.includes('第一版正文') && !textarea.includes('第三版正文'), textarea.slice(0, 40))
    check('㉒ **退回本身也留了一条修订**（条数 +1）', revCount() === beforeRevert + 1, `${beforeRevert} → ${revCount()}`)
    check('㉓ **退回不删任何版本**（第三版仍在列表里）', /第三版标题/.test(afterRevert.body))

    // ㉔ 退回**保留当前的 draft 状态** —— 退回的是内容，不是「当时是草稿还是已发布」
    await postForm('/admin/articles', { cookie: admin, csrf: csrf(), form: { action: 'article-publish', orig_slug: RSLUG } })
    await postForm('/admin/articles', { cookie: admin, csrf: csrf(), form: { action: 'article-revert', orig_slug: RSLUG, revision: String(firstRevId) } })
    check(
      '㉔ 退回**不把已发布的文章撤下来**（退回的是内容，不是状态）',
      (await get('/posts/' + encodeURIComponent(RSLUG), { cookie: admin })).status === 200,
    )

    // ㉕ 编号不合法 / 不属于这篇 → 400
    check(
      '㉕ 修订编号不合法 → 400',
      (await postForm('/admin/articles', { cookie: admin, csrf: csrf(), form: { action: 'article-revert', orig_slug: RSLUG, revision: 'not-a-number' } })).status === 400,
    )
    check(
      '㉕ 不存在 / 不属于这篇的修订 → 400',
      (await postForm('/admin/articles', { cookie: admin, csrf: csrf(), form: { action: 'article-revert', orig_slug: RSLUG, revision: '999999' } })).status === 400,
    )

    // ㉖ 回收站里的文章不能退回（想改就先还原）
    await postForm('/admin/articles', { cookie: admin, csrf: csrf(), form: { action: 'article-trash', orig_slug: RSLUG } })
    const revTrashed = await postForm('/admin/articles', {
      cookie: admin,
      csrf: csrf(),
      form: { action: 'article-revert', orig_slug: RSLUG, revision: String(firstRevId) },
    })
    check('㉖ 回收站里的文章退回 → **400**（先还原）', revTrashed.status === 400 && /先还原/.test(revTrashed.body), `got ${revTrashed.status}`)
    await postForm('/admin/articles', { cookie: admin, csrf: csrf(), form: { action: 'article-restore', orig_slug: RSLUG } })
  }
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
