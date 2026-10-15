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
    SESSION_SECRET: 'e2e-only-secret-not-used-anywhere-else',
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
    const body = new URLSearchParams({ username, password, next })
    const res = await fetch(BASE + '/login', {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    })
    return { status: res.status, setCookie: res.headers.get('set-cookie') || '', body: await res.text() }
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
  check(
    'incidents[].error 与 lastError 走同一套脱敏（不能只修一处）',
    api.incidents.every((i) => i.error === null || /^超时（>\d+ms）$|^状态码 \d+ 不在预期范围内$|^探测失败/.test(i.error)),
    JSON.stringify(api.incidents.map((i) => i.error).slice(0, 4)),
  )

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
    const listPage = await authed('/posts')
    check('XSS: 标题未被注入为脚本', !/<script>alert\(1\)<\/script>/.test(listPage.body))
    check('XSS: 转义后的载荷仍在页面上（证明真的渲染过）', listPage.body.includes('&lt;script&gt;'))
    check('XSS: onerror 属性未被注入', !/<img src=x onerror=/.test(listPage.body))
    // 详情页：正文里的 HTML 也必须被当成文本（markdown-it html:false）
    const detail = await authed('/posts/xss-probe')
    check('XSS: 详情页正文未执行 HTML', !/<script>alert\(1\)<\/script>/.test(detail.body))
    check('XSS: 详情页渲染了该文章', detail.status === 200, `status=${detail.status}`)
    // 标签路由：标签名进 URL 也必须安全
    const tagPage = await authed('/tags/' + encodeURIComponent(xss))
    check('XSS: 标签路由未 500', tagPage.status === 200 || tagPage.status === 404, `status=${tagPage.status}`)
  } finally {
    fs.rmSync(evilFile, { force: true })
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
    const body = new URLSearchParams({ current: TEST_PASS, next: NEW_PASS, confirm: NEW_PASS })
    const res = await fetch(BASE + '/password', {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: sessionCookie },
      body,
    })
    const newCookieHeader = res.headers.get('set-cookie') || ''
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
    const res = await fetch(BASE + '/logout', {
      method: 'POST',
      redirect: 'manual',
      headers: { cookie: sessionCookie },
    })
    const cleared = res.headers.get('set-cookie') || ''
    check('登出 -> 302 到登录页', res.status === 302, `got ${res.status}`)
    check('登出清了 cookie（Max-Age=0）', /Max-Age=0/.test(cleared), cleared)
    // ⚠ 登出**不是吊销**：签名 cookie 无状态，服务端没有失效名单，
    // 所以理论上把原 cookie 再拿回来仍然有效。这条断言把这个已知局限钉住，
    // 防止日后有人误以为登出=吊销。
    const replayed = await get('/status', { cookie: sessionCookie })
    check(
      '已知局限：登出后原 cookie 重放仍有效（登出=本机遗忘，不是吊销）',
      replayed.status === 200,
      `got ${replayed.status}`,
    )
    // 真吊销通道：CLI --revoke-sessions
    const { execFileSync } = await import('node:child_process')
    execFileSync(process.execPath, ['dist/cli/passwd.js', '--user', TEST_USER, '--revoke-sessions'], {
      cwd: ROOT,
      env: { ...process.env, DATABASE_PATH: TEST_DB },
      stdio: 'ignore',
    })
    const afterRevoke = await get('/status', { cookie: sessionCookie })
    check('CLI --revoke-sessions 之后旧 cookie 真失效', afterRevoke.status === 302, `got ${afterRevoke.status}`)
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
