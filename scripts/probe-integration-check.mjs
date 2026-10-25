/**
 * 探测循环集成：真实起服务，断言「降频 checkpoint + 备份」真的会在轮次里触发，
 * 且**备份失败不拖垮探测**。
 *
 * 为什么单独一条：`backup-check.mjs` 直接调 `runBackup()`，证明的是函数本身对；
 * 而「探测循环里到底有没有人调它」只有起真服务才看得到。
 */
import { spawn, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { assertPortFree } from './lib/port-guard.mjs'
import { startProbeFixture } from './lib/probe-fixture.mjs'

const ROOT = process.cwd()
const PORT = 3995
const BASE = `http://127.0.0.1:${PORT}`
const tmp = path.join(ROOT, '.probe-tmp')

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`)
}

fs.rmSync(tmp, { recursive: true, force: true })
fs.mkdirSync(tmp, { recursive: true })
const DB = path.join(tmp, 'probe.sqlite')
const BK = path.join(tmp, 'backups')
// 媒体目录也指到临时目录：备份现在会带一份媒体快照，绝不能读真实 data/。
const MEDIA = path.join(tmp, 'media')
fs.mkdirSync(MEDIA, { recursive: true })

const TEST_USER = 'probeuser'
const TEST_PASS = 'probe-password-1234'
execFileSync(process.execPath, ['dist/cli/passwd.js', '--user', TEST_USER, '--password', TEST_PASS], {
  cwd: ROOT, env: { ...process.env, DATABASE_PATH: DB }, stdio: 'ignore',
})

const probeFixture = await startProbeFixture()
const targets = [{ id: 'ok', name: '可用', url: probeFixture.url, expectStatus: [200] }]

// 端口被占时**先失败**：否则下面的 /healthz 等待会凑到别人起的服务上，
// 然后对着另一个库登录 —— 症状是「登录 401 / timeline=0」，与产品 bug 无法区分。
await assertPortFree(PORT, 'probe-integration-check（端口 3995）')

const child = spawn(process.execPath, ['dist/server.js'], {
  cwd: ROOT,
  env: {
    ...process.env,
    PORT: String(PORT),
    HOST: '127.0.0.1',
    TARGETS_JSON: JSON.stringify(targets),
    DATABASE_PATH: DB,
    SESSION_SECRET: 'probe-integration-secret',
    SITE_ORIGIN: BASE,
    // 每轮都 checkpoint + 备份，好在测试的几秒内触发
    PROBE_INTERVAL_SECONDS: '1',
    CHECKPOINT_EVERY_ROUNDS: '1',
    BACKUP_EVERY_ROUNDS: '1',
    BACKUP_DIR: BK,
    BACKUP_KEEP: '3',
    MEDIA_DIR: MEDIA,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let log = ''
child.stdout.on('data', (d) => (log += d))
child.stderr.on('data', (d) => (log += d))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

try {
  for (let i = 0; i < 40; i++) {
    try { if ((await fetch(BASE + '/healthz')).ok) break } catch {}
    await sleep(250)
  }
  /*
   * `/healthz` 只能证明"这个端口上有东西在听"，证明不了"那是我起的这个"。
   * 本脚本只配了 1 个目标，所以目标数就是它的身份指纹 —— 数不对就说明撞上了别人起的服务，
   * 再往下每条断言都会对着别的库，结论毫无意义（#45 那次「登录 401 / timeline=0」就是这个签名）。
   */
  {
    const hz = await (await fetch(BASE + '/healthz')).json().catch(() => null)
    check(
      '起的是**我这一份**服务（`/healthz` 的目标数 = 本脚本配的 1）',
      hz?.ok === true && hz?.targets === 1,
      JSON.stringify(hz),
    )
  }

  // 轮询等真实探测触发备份，避免机器负载让固定等待只采到一轮。
  const waitFor = async (fn, timeoutMs, label) => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (fn()) return true
      await sleep(400)
    }
    console.log(`  （等待「${label}」超时 ${timeoutMs}ms）`)
    return false
  }

  console.log('\n[探测循环里真的调了备份]')
  const gotBackupLog = await waitFor(() => /备份完成/.test(log), 30000, '备份完成日志')
  const gotBackupFile = fs.existsSync(BK) && fs.readdirSync(BK).some((f) => f.endsWith('.sqlite'))
  check('日志出现探测轮次', /\[probe\]/.test(log), log.split('\n').filter((l) => l.includes('[probe]')).slice(0, 2).join(' | '))
  check('日志出现备份完成', gotBackupLog, log.split('\n').find((l) => l.includes('备份完成')) || `(30s 内没等到) 完整日志：${log.slice(-400)}`)
  check('备份目录里有产物', gotBackupFile, fs.existsSync(BK) ? fs.readdirSync(BK).join(',') : '(目录不存在)')

  if (gotBackupFile) {
    const bkFile = path.join(BK, fs.readdirSync(BK).find((f) => f.endsWith('.sqlite')))
    const out = execFileSync(process.execPath, ['dist/cli/backup.js', '--verify', bkFile], {
      cwd: ROOT, encoding: 'utf8', env: { ...process.env, DATABASE_PATH: DB, BACKUP_DIR: BK, MEDIA_DIR: MEDIA },
    })
    check('产物通过 --verify（表在且有数据）', /✅ 数据库判决/.test(out), out.split('\n')[2] || '')
  } else {
    check('产物通过 --verify（表在且有数据）', false, '没有产物可校验')
  }

  console.log('\n[探测没被备份拖垮]')
  const r = await fetch(BASE + '/api/status', {
    method: 'GET',
    headers: { cookie: await login() },
  })
  const api = await r.json()
  check('探测在持续产出数据（timeline 有内容）', (api.targets[0]?.timeline?.length ?? 0) > 0,
    `timeline=${api.targets[0]?.timeline?.length}`)
  check('服务全程未崩溃', child.exitCode === null && !/启动失败/.test(log))
  check('没有 checkpoint 失败日志', !/checkpoint 失败/.test(log))

  console.log('\n[备份目录不可写时，探测照常]')
  child.kill()
  await sleep(800)

  const badDir = path.join(tmp, 'blocker-file')
  fs.writeFileSync(badDir, 'not a dir')
  const child2 = spawn(process.execPath, ['dist/server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(PORT),
      HOST: '127.0.0.1',
      TARGETS_JSON: JSON.stringify(targets),
      DATABASE_PATH: DB,
      SESSION_SECRET: 'probe-integration-secret',
      SITE_ORIGIN: BASE,
      PROBE_INTERVAL_SECONDS: '1',
      CHECKPOINT_EVERY_ROUNDS: '1',
      BACKUP_EVERY_ROUNDS: '1',
      BACKUP_DIR: path.join(badDir, 'sub'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let log2 = ''
  child2.stdout.on('data', (d) => (log2 += d))
  child2.stderr.on('data', (d) => (log2 += d))

  try {
    for (let i = 0; i < 40; i++) {
      try { if ((await fetch(BASE + '/healthz')).ok) break } catch {}
      await sleep(250)
    }
    await sleep(4000)
    check('备份失败被显眼打出', /备份失败/.test(log2), log2.split('\n').find((l) => l.includes('备份失败')) || '(无)')
    check('备份失败后探测仍在跑（服务没崩）', /\[probe\]/.test(log2) && child2.exitCode === null)
    const api2 = await (await fetch(BASE + '/api/status', { headers: { cookie: await login() } })).json()
    check('面板数据仍在更新（备份坏掉不影响可用性）', (api2.targets[0]?.timeline?.length ?? 0) > 0,
      `timeline=${api2.targets[0]?.timeline?.length}`)
  } finally {
    child2.kill()
    await sleep(500)
  }

  async function login() {
    const res = await fetch(BASE + '/login', {
      method: 'POST', redirect: 'manual',
      // L2 对所有非安全方法 fail-closed：不带来源头的 POST 会被 403（**故意的**）。
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: BASE },
      body: new URLSearchParams({ username: TEST_USER, password: TEST_PASS, next: '/' }),
    })
    return (res.headers.get('set-cookie') || '').split(';')[0]
  }
} finally {
  try { child.kill() } catch {}
  await probeFixture.close()
  await sleep(500)
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
