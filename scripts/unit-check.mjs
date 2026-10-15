/**
 * 实现①的单元断言：凭据与会话库，**不过 HTTP**。
 *
 * 为什么单独一个脚本：`scripts/e2e-check.mjs` 是 HTTP/端到端验收面，而本票交付的是纯函数层。
 * 判定表（`docs/session-decision.md` §4）的 14 个用例在这里直接断言，
 * 包括「签名长度不对不抛 500」这种在 HTTP 层很难稳定复现的情形。
 *
 * 需要先构建：`npm run build && node scripts/unit-check.mjs`
 */
import { execFileSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'

const root = path.resolve(import.meta.dirname, '..')

// ── 独立数据目录：绝不碰仓库里的 data/ ──
// ⚠ 必须放在**仓库内**：临时探针脚本要用 `better-sqlite3`，
// 放在 os.tmpdir() 下解析不到 node_modules（实测 ERR_MODULE_NOT_FOUND）。
const sandbox = fs.mkdtempSync(path.join(root, '.unit-sandbox-'))
process.env.DATABASE_PATH = path.join(sandbox, 'u.sqlite')
process.env.SESSION_SECRET = 'test-secret-not-for-production-use-only'
process.env.ADMIN_USERNAME = ''
process.env.ADMIN_PASSWORD = ''

let passed = 0
let failed = 0
const failures = []

function check(label, cond, detail = '') {
  if (cond) {
    passed++
    console.log(`  ✅ ${label}`)
  } else {
    failed++
    failures.push(label)
    console.log(`  ❌ ${label}${detail ? '  → ' + detail : ''}`)
  }
}

function section(name) {
  console.log(`\n[${name}]`)
}

// ── 动态 import：必须在设好环境变量之后（config 在 import 时读 env）──
// Windows 下动态 import 需要 file:// URL，不能直接给盘符路径。
const { pathToFileURL } = await import('node:url')
const mod = (rel) => pathToFileURL(path.join(root, rel)).href
const users = await import(mod('dist/users.js'))
const session = await import(mod('dist/session.js'))
const configMod = await import(mod('dist/config.js'))
const { config } = configMod

// ════════════════════════════════════════════════════
section('users: 建表与迁移幂等')
// ════════════════════════════════════════════════════
users.initUsers()
check('initUsers() 首次可执行', true)
users.initUsers()
check('initUsers() 二次执行幂等（不报错、不重复补列）', true)

{
  const raw = new Database(process.env.DATABASE_PATH)
  const cols = raw.prepare('PRAGMA table_info(users)').all().map((c) => c.name)
  check('users 表含 token_version 列', cols.includes('token_version'), cols.join(','))
  const ddl = raw.prepare(`SELECT sql FROM sqlite_master WHERE name='users'`).get().sql
  check('username 带 COLLATE NOCASE', /COLLATE\s+NOCASE/i.test(ddl), ddl)
  check('username 带 UNIQUE', /UNIQUE/i.test(ddl))
  raw.close()
}

// ════════════════════════════════════════════════════
section('users: 旧库补列（既有账号落 1，不掉线）')
// ════════════════════════════════════════════════════
{
  // 造一个「按 #2 建好、但没有 token_version」的旧库
  const oldPath = path.join(sandbox, 'old.sqlite')
  const old = new Database(oldPath)
  old.exec(`CREATE TABLE users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    updated_at INTEGER
  );`)
  old.prepare(`INSERT INTO users (username,password_hash,created_at) VALUES (?,?,?)`).run('legacy', 'x', Date.now())
  old.close()

  // 用子进程以旧库为 DATABASE_PATH 跑一次 initUsers，再看列与既有行
  const probe = path.join(sandbox, 'probe-old.mjs')
  fs.writeFileSync(
    probe,
    `process.env.DATABASE_PATH=${JSON.stringify(oldPath)};
     const u = await import(${JSON.stringify('file://' + path.join(root, 'dist/users.js'))});
     u.initUsers(); u.initUsers();
     const raw = (await import('better-sqlite3')).default(${JSON.stringify(oldPath)});
     const cols = raw.prepare('PRAGMA table_info(users)').all().map(c=>c.name);
     const row = raw.prepare('SELECT username,token_version FROM users').get();
     console.log(JSON.stringify({cols, row}));
     raw.close();`,
    'utf8',
  )
  const out = execFileSync(process.execPath, [probe], { cwd: root, encoding: 'utf8' })
  const { cols, row } = JSON.parse(out.trim().split('\n').pop())
  check('旧库补列后含 token_version', cols.includes('token_version'), cols.join(','))
  check('既有账号 token_version = 1（迁移不掉线）', row.token_version === 1, JSON.stringify(row))
  check('旧库上重复执行 initUsers() 不报错', true)
}

// ════════════════════════════════════════════════════
section('users: 建号 / 口令校验')
// ════════════════════════════════════════════════════
const alice = users.createUser('Alice', 'correct-horse-battery')
check('建号成功且用户名归一为小写', alice.username === 'alice', alice.username)
check('新号 enabled = 1', alice.enabled === 1)
check('新号 token_version = 1', alice.token_version === 1)
check('口令以 bcrypt 串存储（$2b$）且非明文', alice.password_hash.startsWith('$2b$') && !alice.password_hash.includes('correct-horse'))
check('cost 为 12', alice.password_hash.startsWith('$2b$12$'), alice.password_hash.slice(0, 7))

check('正确口令通过', users.verifyPassword('alice', 'correct-horse-battery')?.id === alice.id)
check('大写用户名也能登录（COLLATE NOCASE）', users.verifyPassword('ALICE', 'correct-horse-battery')?.id === alice.id)
check('错误口令拒绝', users.verifyPassword('alice', 'wrong-password-here') === null)
check('不存在的用户拒绝', users.verifyPassword('nobody', 'whatever12345') === null)

// 时序枚举：失败路径耗时应当与真实比对相当（不要求精确，只要不是数量级差距）
{
  const t0 = process.hrtime.bigint()
  users.verifyPassword('nobody', 'whatever12345')
  const unknownMs = Number(process.hrtime.bigint() - t0) / 1e6
  const t1 = process.hrtime.bigint()
  users.verifyPassword('alice', 'wrong-password-here')
  const wrongMs = Number(process.hrtime.bigint() - t1) / 1e6
  const ratio = Math.max(unknownMs, wrongMs) / Math.max(0.001, Math.min(unknownMs, wrongMs))
  check(
    `不存在用户也跑假哈希（耗时同量级：unknown=${unknownMs.toFixed(0)}ms wrong=${wrongMs.toFixed(0)}ms）`,
    ratio < 5,
    `ratio=${ratio.toFixed(1)}`,
  )
}

check('Alice/alice 不能共存（重复建号被拒）', (() => {
  try {
    users.createUser('alice', 'another-password-x')
    return false
  } catch (e) {
    return /已存在/.test(e.message)
  }
})())
check('口令短于 8 位被拒', (() => {
  try {
    users.createUser('shorty', '1234567')
    return false
  } catch (e) {
    return /至少 8 位/.test(e.message)
  }
})())

// 停用后口令正确也不放行
const bob = users.createUser('bob', 'bob-password-123')
users.setEnabled(bob.id, false)
check('停用后即使口令正确也拒绝', users.verifyPassword('bob', 'bob-password-123') === null)
check('停用后 getAuthState.enabled = 0', users.getAuthState(bob.id)?.enabled === 0)
users.setEnabled(bob.id, true)
check('重新启用后可以登录', users.verifyPassword('bob', 'bob-password-123')?.id === bob.id)

// ════════════════════════════════════════════════════
section('users: 凭据代次（改密/踢会话）')
// ════════════════════════════════════════════════════
{
  const before = users.findById(alice.id)
  users.setPassword(alice.id, 'brand-new-password')
  const after = users.findById(alice.id)
  check('改密递增 token_version', after.token_version === before.token_version + 1, `${before.token_version} → ${after.token_version}`)
  check('改密后新口令可用', users.verifyPassword('alice', 'brand-new-password')?.id === alice.id)
  check('改密后旧口令失效', users.verifyPassword('alice', 'correct-horse-battery') === null)
  check('改密写入 updated_at', after.updated_at !== null)

  const hashBefore = after.password_hash
  const pvBefore = after.token_version
  const returned = users.bumpTokenVersion(alice.id)
  const afterRevoke = users.findById(alice.id)
  check('--revoke-sessions 递增 token_version 并返回新值', returned === pvBefore + 1 && afterRevoke.token_version === returned)
  check('--revoke-sessions **不改动口令哈希**', afterRevoke.password_hash === hashBefore)
}

// ════════════════════════════════════════════════════
section('users: 零账号 / 环境变量引导（防后门）')
// ════════════════════════════════════════════════════
{
  check('countUsers 统计正确', users.countUsers() === 2, String(users.countUsers()))
  // 表非空时，环境变量必须被完全忽略
  const created = users.ensureFirstUserFromEnv('backdoor', 'backdoor-password')
  check('表非空时环境变量**不创建**账号（防后门回归）', created === false && users.findByUsername('backdoor') === undefined)
}

// ════════════════════════════════════════════════════
section('session: 判定表 14 用例（docs/session-decision.md §4）')
// ════════════════════════════════════════════════════
{
  const SECRET = config.sessionSecret
  const now = 1_800_000_000_000
  const DAY = 86_400_000
  const state = { id: 7, enabled: 1, tokenVersion: 3 }

  const mk = (payload) => session.signSession(SECRET, payload)
  const v = (token, user = state, at = now) => session.verifySession(SECRET, token, user, at)

  check('1 有效 token → ok', v(mk({ uid: 7, exp: now + 7 * DAY, pv: 3 })) === 'ok')
  check('2 已过期 → expired', v(mk({ uid: 7, exp: now - 1, pv: 3 })) === 'expired')
  check('3 篡改 uid 但签名没换 → bad-signature', (() => {
    const t = mk({ uid: 7, exp: now + DAY, pv: 3 })
    const forged = Buffer.from(JSON.stringify({ uid: 8, exp: now + DAY, pv: 3 })).toString('base64url') + '.' + t.slice(t.lastIndexOf('.') + 1)
    return v(forged) === 'bad-signature'
  })())
  check('4 换密钥后旧 token → bad-signature', (() => {
    const other = session.signSession('a-completely-different-secret', { uid: 7, exp: now + DAY, pv: 3 })
    return v(other) === 'bad-signature'
  })())
  check('5 pv 失配（改密后旧 cookie）→ stale-version', v(mk({ uid: 7, exp: now + DAY, pv: 2 })) === 'stale-version')
  check('6 账号已停用 → disabled', v(mk({ uid: 7, exp: now + DAY, pv: 3 }), { ...state, enabled: 0 }) === 'disabled')
  check('7 用户已不存在 → unknown-user', v(mk({ uid: 7, exp: now + DAY, pv: 3 }), null) === 'unknown-user')
  check('8 空 token → no-token', v('') === 'no-token' && v(undefined) === 'no-token')
  check('9 无点号 → malformed', v('garbage') === 'malformed')
  check('10 点号在开头 → malformed', v('.sig') === 'malformed')
  check('11 签名长度不对 → bad-signature（**不是抛异常**）', v(mk({ uid: 7, exp: now + DAY, pv: 3 }).split('.')[0] + '.short') === 'bad-signature')
  check('12 载荷不是 JSON → malformed', (() => {
    const pb = Buffer.from('not-json').toString('base64url')
    const s = crypto.createHmac('sha256', SECRET).update(pb).digest('base64url')
    return v(pb + '.' + s) === 'malformed'
  })())
  check('13 载荷缺 exp → malformed', v(mk({ uid: 7, pv: 3 })) === 'malformed')
  check('14 exp 非数字 → malformed（**不是「永久有效」**）', v(mk({ uid: 7, exp: 'x', pv: 3 })) === 'malformed')

  // 边界
  check('边界：now === exp 判过期', v(mk({ uid: 7, exp: now, pv: 3 })) === 'expired')
  check('边界：now === exp-1 仍有效', v(mk({ uid: 7, exp: now + 1, pv: 3 })) === 'ok')
}

// ════════════════════════════════════════════════════
section('session: Cookie 解析与响应头')
// ════════════════════════════════════════════════════
{
  const p = session.parseCookies
  check('两个 cookie', JSON.stringify(p('a=1; b=2')) === JSON.stringify({ a: '1', b: '2' }))
  check('空格与空段容忍', JSON.stringify(p('  a = 1 ;; b=2 ')) === JSON.stringify({ a: '1', b: '2' }))
  check('不做 URL 解码', p('session=abc%3D%3D').session === 'abc%3D%3D')
  check('空值保留为 ""', p('a=').a === '')
  check('无等号整段丢弃', Object.keys(p('novalue')).length === 0)
  check('同名取后者', p('a=1; a=2').a === '2')
  check('undefined/空头返回空对象', Object.keys(p(undefined)).length === 0 && Object.keys(p('')).length === 0)

  const token = session.issueSession(config.sessionSecret, 1, 1)
  const h = session.sessionCookieHeader(token)
  check('会话 cookie 含 HttpOnly', h.includes('HttpOnly'))
  check('会话 cookie 含 SameSite=Lax', h.includes('SameSite=Lax'))
  check('会话 cookie 含 Path=/', h.includes('Path=/'))
  check('**默认不含 Secure**（HTTP 下开着会导致登录不上）', !h.includes('Secure'))
  check('显式开启时含 Secure', session.sessionCookieHeader(token, { secure: true }).includes('Secure'))
  check('Max-Age 为 7 天', h.includes(`Max-Age=${7 * 24 * 3600}`), h)
  check('Max-Age 与 ttlMs 一致', session.sessionCookieHeader(token, { ttlMs: 3600_000 }).includes('Max-Age=3600'))

  const c = session.clearCookieHeader()
  check('清除 cookie 带 Max-Age=0 且值为空', c.startsWith('session=;') && c.includes('Max-Age=0'), c)
}

// ════════════════════════════════════════════════════
section('session: next 回跳逃逸面（闸门票 §4）')
// ════════════════════════════════════════════════════
{
  const known = (p) => ['/', '/status', '/posts', '/about'].includes(p)
  const bad = ['//evil.com/path', '/\\evil.com/path', '\\/evil.com', '////evil.com', 'https://evil.com/path', 'http://evil.com', '/status\r\nX: y', 'status', '']
  for (const b of bad) {
    check(`拒绝 ${JSON.stringify(b)}`, session.isSafeNextPath(b, known) === false)
  }
  check('放行 /status', session.isSafeNextPath('/status', known) === true)
  check('放行 /status?x=1#frag（查询与片段不影响）', session.isSafeNextPath('/status?x=1#frag', known) === true)
  check('拒绝未知路由（避免送到 404）', session.isSafeNextPath('/random-junk', known) === false)
}

// ════════════════════════════════════════════════════
section('config: 会话密钥')
// ════════════════════════════════════════════════════
{
  check('sessionSecret 从环境变量读入', config.sessionSecret === 'test-secret-not-for-production-use-only')
  check('sessionCookieSecure 默认关', config.sessionCookieSecure === false)
  check('sessionTtlMs 默认 7 天', config.sessionTtlMs === 7 * 24 * 3600 * 1000, String(config.sessionTtlMs))
  check('有密钥时 assertSessionSecret() 不退出', (() => {
    configMod.assertSessionSecret()
    return true
  })())

  // 无密钥时应当以退出码 1 结束进程
  const probe = path.join(sandbox, 'no-secret.mjs')
  fs.writeFileSync(
    probe,
    `process.env.SESSION_SECRET='';
     const m = await import(${JSON.stringify('file://' + path.join(root, 'dist/config.js'))});
     m.assertSessionSecret();
     console.log('NOT_EXITED');`,
    'utf8',
  )
  let out = ''
  let code = 0
  try {
    out = execFileSync(process.execPath, [probe], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (e) {
    out = String(e.stdout || '') + String(e.stderr || '')
    code = e.status
  }
  check('SESSION_SECRET 为空 → 进程退出（码 1）', code === 1 && !out.includes('NOT_EXITED'), `code=${code}`)
  check('报错里给出生成密钥的命令', out.includes('randomBytes'), out.slice(0, 120))
}

// ════════════════════════════════════════════════════
section('CLI: dist 下存在且可执行（回归：防止放进 scripts/）')
// ════════════════════════════════════════════════════
{
  const cli = path.join(root, 'dist/cli/passwd.js')
  check('dist/cli/passwd.js 存在', fs.existsSync(cli), cli)

  const out = execFileSync(process.execPath, [cli, '--list'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, DATABASE_PATH: process.env.DATABASE_PATH },
  })
  check('--list 能跑并列出现有账号', out.includes('alice') && out.includes('bob'), out.split('\n')[1] || '')

  // 新库上建号 → 再 --revoke-sessions 不改口令
  const fresh = path.join(sandbox, 'cli.sqlite')
  const cliEnv = { ...process.env, DATABASE_PATH: fresh }
  execFileSync(process.execPath, [cli, '--user', 'carol', '--password', 'carol-password-1'], { cwd: root, encoding: 'utf8', env: cliEnv })
  const listed = execFileSync(process.execPath, [cli, '--list'], { cwd: root, encoding: 'utf8', env: cliEnv })
  check('CLI 能建号', listed.includes('carol'), listed)

  const revoke = execFileSync(process.execPath, [cli, '--user', 'carol', '--revoke-sessions'], { cwd: root, encoding: 'utf8', env: cliEnv })
  check('CLI --revoke-sessions 明确说明口令未改', revoke.includes('未改动'), revoke.trim())

  const raw = new Database(fresh)
  const row = raw.prepare(`SELECT token_version FROM users WHERE username='carol'`).get()
  raw.close()
  check('--revoke-sessions 后 token_version = 2', row.token_version === 2, String(row.token_version))

  // 短口令必须被拒
  let shortRejected = false
  try {
    execFileSync(process.execPath, [cli, '--user', 'dave', '--password', 'short'], { cwd: root, encoding: 'utf8', env: cliEnv, stdio: 'pipe' })
  } catch {
    shortRejected = true
  }
  check('CLI 拒绝短于 8 位的口令', shortRejected)
}

// ════════════════════════════════════════════════════
// 清理。Windows 上 sqlite 句柄可能还没释放（EPERM），失败不应让整体判负——
// 沙箱目录有固定前缀，可由 .gitignore 兜底，且下次运行会新建一个。
try {
  fs.rmSync(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
} catch {
  console.log(`\n（提示：沙箱目录未能删除，可手动清理：${sandbox}）`)
}

console.log(`\n${'─'.repeat(60)}`)
if (failed === 0) {
  console.log(`✅ 全部通过：${passed} 项`)
} else {
  console.log(`❌ ${failed} 项失败 / 共 ${passed + failed} 项`)
  for (const f of failures) console.log(`   - ${f}`)
}
process.exit(failed === 0 ? 0 : 1)
