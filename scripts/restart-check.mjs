/**
 * 重启后恢复：**真的杀进程再起**，断言历史与会话都能活过重启。
 *
 * 为什么必须真杀进程：这个场景的所有风险都在「进程生命周期」上——
 * 数据是否真的落盘、`SESSION_SECRET` 是否稳定（否则所有人掉线）、
 * 旧 cookie 是否仍然有效。用 mock 测不出任何一条。
 */
import { spawn, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { assertPortFree } from './lib/port-guard.mjs'
import { startProbeFixture } from './lib/probe-fixture.mjs'

const ROOT = process.cwd()
const PORT = 3993
const BASE = `http://127.0.0.1:${PORT}`
const tmp = path.join(ROOT, '.restart-tmp')

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

fs.rmSync(tmp, { recursive: true, force: true })
fs.mkdirSync(tmp, { recursive: true })
const DB = path.join(tmp, 'restart.sqlite')

const TEST_USER = 'restartuser'
const TEST_PASS = 'restart-password-1234'
const SECRET = 'restart-test-secret-stable'

execFileSync(process.execPath, ['dist/cli/passwd.js', '--user', TEST_USER, '--password', TEST_PASS], {
  cwd: ROOT, env: { ...process.env, DATABASE_PATH: DB }, stdio: 'ignore',
})

const probeFixture = await startProbeFixture()
const targets = [{ id: 'ok', name: '可用', url: probeFixture.url, expectStatus: [200] }]
const baseEnv = {
  ...process.env,
  PORT: String(PORT),
  HOST: '127.0.0.1',
  TARGETS_JSON: JSON.stringify(targets),
  DATABASE_PATH: DB,
  SESSION_SECRET: SECRET,
  SITE_ORIGIN: BASE,
  PROBE_INTERVAL_SECONDS: '1',
  CHECKPOINT_EVERY_ROUNDS: '0', // 本脚本不管备份
  BACKUP_EVERY_ROUNDS: '0',
}

function start() {
  const c = spawn(process.execPath, ['dist/server.js'], { cwd: ROOT, env: baseEnv, stdio: ['ignore', 'pipe', 'pipe'] })
  c._log = ''
  c.stdout.on('data', (d) => (c._log += d))
  c.stderr.on('data', (d) => (c._log += d))
  return c
}

async function waitUp(base = BASE, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try { if ((await fetch(base + '/healthz')).ok) return true } catch {}
    await sleep(250)
  }
  return false
}

async function login(base = BASE) {
  const res = await fetch(base + '/login', {
    method: 'POST', redirect: 'manual',
    // L2 对所有非安全方法 fail-closed，且**按实例的 SITE_ORIGIN 判**：
    // 所以来源头必须跟着 `base` 走（第二台实例的 origin 是 BASE2，不是 BASE）。
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin: base },
    body: new URLSearchParams({ username: TEST_USER, password: TEST_PASS, next: '/' }),
  })
  return { cookie: (res.headers.get('set-cookie') || '').split(';')[0], status: res.status }
}

/** 等一个子进程真的退出——否则下一个实例可能撞端口，而 /healthz 会由旧进程回答，测出假结果。 */
async function waitExit(c, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (c.exitCode !== null || c.signalCode !== null) return true
    await sleep(150)
  }
  return c.exitCode !== null || c.signalCode !== null
}

/**
 * 取某个受保护路径的状态码。
 * ⚠ 探针必须是**需要登录**的路径：2026-10-30 起 `/status` 是公开页，拿它测会话会恒为 200。
 * ⚠ **必须 `redirect: 'manual'`**：否则 fetch 会自己跟随 302 到 /login，
 * 于是「未登录」看起来是 200——第一版就是这样把对照组测成了假失败。
 */
async function statusOf(base, cookie) {
  const res = await fetch(base + '/account', { headers: { cookie }, redirect: 'manual' })
  return res.status
}

/** 等到探够 N 轮（用 timeline 长度当信号），而不是猜睡眠时长。 */
async function waitRounds(cookie, want, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs
  let last = 0
  while (Date.now() < deadline) {
    try {
      const r = await fetch(BASE + '/api/status', { headers: { cookie, accept: 'application/json' } })
      const api = await r.json()
      last = api.targets[0]?.timeline?.length ?? 0
      if (last >= want) return last
    } catch {}
    await sleep(400)
  }
  return last
}

let first = null
let cookie = ''
try {
  // ── 第一次启动 ──
  console.log('\n[第一次启动：产生历史与会话]')
  // 只在**第一次**起服务前检查端口：后面几次重启是我们自己杀掉的旧实例，不该再拦。
  await assertPortFree(PORT, 'restart-check（端口 3993）')
  first = start()
  check('服务启动', await waitUp(), first._log.slice(-200))
  const l1 = await login()
  cookie = l1.cookie
  check('能登录并拿到 cookie', l1.status === 302 && cookie.startsWith('session='), `status=${l1.status}`)

  const rounds = await waitRounds(cookie, 3)
  check(`探测产出历史（timeline=${rounds}）`, rounds >= 3, `只拿到 ${rounds}`)

  const before = await (await fetch(BASE + '/api/status', { headers: { cookie } })).json()
  const beforeRows = before.targets[0].timeline.length
  check('重启前 API 有数据', beforeRows > 0, `${beforeRows} 点`)

  // ── 杀进程 ──
  console.log('\n[杀进程 → 重启]')
  first.kill('SIGTERM')
  await sleep(1500)
  check('进程确实退出了', first.exitCode !== null || first.signalCode !== null, `exit=${first.exitCode} signal=${first.signalCode}`)

  // ── 第二次启动（同一个库、同一个密钥）──
  const second = start()
  try {
    // ⚠ 用**旧的 cookie**访问：这同时验证「SESSION_SECRET 稳定」与「会话不因重启失效」
    check('重启后服务起来', await waitUp(), second._log.slice(-200))
    check('**旧 cookie 仍然有效**（密钥稳定，没把所有人踢下线）', (await statusOf(BASE, cookie)) === 200)

    const after = await (await fetch(BASE + '/api/status', { headers: { cookie, accept: 'application/json' } })).json()
    check('**历史活过了重启**（timeline 没清零）', after.targets[0].timeline.length >= beforeRows,
      `重启前 ${beforeRows} → 重启后 ${after.targets[0].timeline.length}`)
    check('可用率走势也还在', Array.isArray(after.overview) && after.overview.length > 0, `${after.overview.length} 点`)
    check('目标清单没变（来自同一个 TARGETS_JSON）', after.targets.length === 1, `${after.targets.length} 个`)

    // 重启后继续探测（说明探测循环真的又跑起来了，不是只读启动）
    const grown = await waitRounds(cookie, beforeRows + 1)
    check('重启后探测继续推进（不是只起不探）', grown > beforeRows, `${beforeRows} → ${grown}`)

    check('重启后服务未崩溃', second.exitCode === null && !/启动失败/.test(second._log), second._log.slice(-200))

    // ── 反向对照：换个密钥重启，旧 cookie 必须失效 ──
    // ⚠ 用**另一个端口**：如果撞端口，`/healthz` 会由旧进程回答，
    // 于是「旧 cookie 仍有效」会被误判成密钥没换——第一版就是这个坑。
    second.kill('SIGTERM')
    const died = await waitExit(second)
    check('第二个进程确实退出了（避免端口串台）', died, `exit=${second.exitCode} signal=${second.signalCode}`)

    const PORT2 = 3992
    const BASE2 = `http://127.0.0.1:${PORT2}`
    const third = spawn(process.execPath, ['dist/server.js'], {
      cwd: ROOT,
      env: { ...baseEnv, PORT: String(PORT2), SESSION_SECRET: 'a-different-secret-entirely', SITE_ORIGIN: BASE2 },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let log3 = ''
    third.stdout.on('data', (d) => (log3 += d))
    third.stderr.on('data', (d) => (log3 += d))
    try {
      check('换密钥后服务仍能起（新端口）', await waitUp(BASE2), log3.slice(-200))
      check('**换密钥后旧 cookie 失效**（对照组，证明上一条不是恒真）',
        (await statusOf(BASE2, cookie)) === 302, `got ${await statusOf(BASE2, cookie)}`)
      // 而账号还在，能重新登录
      const l3 = await login(BASE2)
      check('换密钥后账号仍在，可重新登录', l3.status === 302, `status=${l3.status}`)
      // 新登录拿到的 cookie 在新密钥下能用
      check('新 cookie 在新密钥下有效', (await statusOf(BASE2, l3.cookie)) === 200)
    } finally {
      third.kill('SIGTERM')
      await waitExit(third)
    }
  } finally {
    try { second.kill('SIGTERM') } catch {}
    await sleep(600)
  }
} finally {
  try { first.kill('SIGTERM') } catch {}
  await probeFixture.close()
  await sleep(600)
  try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }) } catch {}
}

console.log(`\n${'─'.repeat(60)}`)
const failed = results.filter((r) => !r.ok)
if (!failed.length) console.log(`✅ 全部通过：${results.length} 项`)
else {
  console.log(`❌ ${failed.length} 项失败 / 共 ${results.length} 项`)
  for (const f of failed) console.log(`   - ${f.name}  ${f.detail}`)
}
process.exit(failed.length ? 1 : 0)
