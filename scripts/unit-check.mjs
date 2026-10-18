/**
 * 实现①的单元断言：凭据与会话库，**不过 HTTP**。
 *
 * 为什么单独一个脚本：`scripts/e2e-check.mjs` 是 HTTP/端到端验收面，而本票交付的是纯函数层。
 * 判定表（`docs/session-decision.md` §4）的 14 个用例在这里直接断言，
 * 包括「签名长度不对不抛 500」这种在 HTTP 层很难稳定复现的情形。
 *
 * 需要先构建：`npm run build && node scripts/unit-check.mjs`
 */
import { execFileSync, spawnSync } from 'node:child_process'
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
     const row = raw.prepare('SELECT username,token_version,role FROM users').get();
     console.log(JSON.stringify({cols, row}));
     raw.close();`,
    'utf8',
  )
  const out = execFileSync(process.execPath, [probe], { cwd: root, encoding: 'utf8' })
  const { cols, row } = JSON.parse(out.trim().split('\n').pop())
  check('旧库补列后含 token_version', cols.includes('token_version'), cols.join(','))
  check('既有账号 token_version = 1（迁移不掉线）', row.token_version === 1, JSON.stringify(row))
  check('旧库补列后含 role', cols.includes('role'), cols.join(','))
  // 这条是角色迁移的**全部内容**：能跑那句无条件 UPDATE 的唯一时刻，就是 role 列刚被补上的那一刻，
  // 此刻库里的每一行都必然是列诞生之前就存在的账号（`docs/roles-decision.md` §2）。
  check('**既有账号被一次性升为 admin**（迁移的唯一时刻，无条件全表）', row.role === 'admin', JSON.stringify(row))
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
// ════════════════════════════════════════════════════
section('sessions: 判定表 24 用例（docs/session-revoke-decision.md §5）')
// ════════════════════════════════════════════════════
// ⚠ 这张表在产出它的那次会话里**一行都没实测过**（那次没有命令通道，文档 §11 末尾承认了）。
//    本节的职责就是把它**跑成绿**；跑出与文档不一致的行，**改文档**，不要改断言去迁就实现
//    —— 第 13 行（老 cookie 必须 malformed）与第 24 行（登出≠踢所有设备）尤其容易被「顺手放宽」。
{
  const SECRET = config.sessionSecret
  const now = 1_800_000_000_000
  const TTL = 7 * 24 * 60 * 60 * 1000
  const sessionsStore = await import(mod('dist/sessions-store.js'))

  // 拿一个**真实**账号：会话行要 JOIN 得到它（顶层那个 `alice`，用户名已归一为小写）。
  // `pv` 必须**现读**：前面 CLI 那节跑过 `--revoke-sessions`，token_version 已经不是 1 了。
  const aliceId = alice.id
  const pv = users.findById(aliceId).token_version

  /** 判定所需状态的字面量 —— 判定表可以直接构造它，不必造库、不必造 HTTP。 */
  const stateFor = (sid, sessionOver = {}, userOver = {}) => ({
    session: { sid, uid: aliceId, pv, expiresAt: now + TTL, revokedAt: null, ...sessionOver },
    user: { id: aliceId, enabled: 1, tokenVersion: pv, ...userOver },
  })
  const mk = (over = {}) => session.signSession(SECRET, { uid: aliceId, exp: now + TTL, pv, sid: 'S', ...over })
  const d = (token, state, at = now) => session.decideSession(SECRET, token, state, at)
  /** 用**指定的载荷字符串**签名（造畸形载荷用；签名本身仍然是真的）。 */
  const raw = (payloadText) => {
    const pb = Buffer.from(payloadText).toString('base64url')
    return pb + '.' + crypto.createHmac('sha256', SECRET).update(pb).digest().toString('base64url')
  }

  check('1 签名正确、未过期、sid 有行、enabled=1、pv 一致 → ok', d(mk(), stateFor('S')) === 'ok')
  check('2 空 / 缺失 cookie → no-token', d('', null) === 'no-token' && d(undefined, null) === 'no-token' && d(null, null) === 'no-token')
  check('3 无 `.` 分隔符 → malformed', d('garbage', null) === 'malformed')
  check('4 `.` 在开头 → malformed', d('.sig', null) === 'malformed')
  check('5 `.` 在结尾 → malformed', d(mk().split('.')[0] + '.', null) === 'malformed')
  check('6 签名被截断（长度不等）→ bad-signature，**不抛异常**', d(mk().split('.')[0] + '.short', null) === 'bad-signature')
  check('7 签名改一个字符（等长）→ bad-signature', (() => {
    const t = mk()
    const cut = t.lastIndexOf('.') + 1
    const sig = t.slice(cut)
    const flipped = (sig[0] === 'A' ? 'B' : 'A') + sig.slice(1)
    return d(t.slice(0, cut) + flipped, null) === 'bad-signature'
  })())
  check('8 换了 SESSION_SECRET 后验旧 token → bad-signature', (() => {
    const other = session.signSession('k'.repeat(32) + '-other', { uid: aliceId, exp: now + TTL, pv, sid: 'S' })
    return d(other, stateFor('S')) === 'bad-signature'
  })())
  check('9 改了载荷但签名没跟着换 → bad-signature', (() => {
    const t = mk()
    const cut = t.lastIndexOf('.') + 1
    const forged = Buffer.from(JSON.stringify({ uid: aliceId, exp: now + TTL, pv, sid: '另一个' })).toString('base64url')
    return d(forged + '.' + t.slice(cut), stateFor('S')) === 'bad-signature'
  })())
  check('10 载荷不是合法 JSON → malformed', d(raw('这不是 JSON'), null) === 'malformed')
  check('11 载荷缺 exp → malformed', d(raw(JSON.stringify({ uid: aliceId, pv, sid: 'S' })), stateFor('S')) === 'malformed')
  check('12 exp 是字符串（非数字）→ malformed', d(raw(JSON.stringify({ uid: aliceId, exp: String(now + TTL), pv, sid: 'S' })), stateFor('S')) === 'malformed')
  check('13 载荷缺 sid（**这正是上线那一刻的既有 cookie**）→ malformed', d(raw(JSON.stringify({ uid: aliceId, exp: now + TTL, pv })), stateFor('S')) === 'malformed')
  check('14 sid 是空字符串 → malformed', d(raw(JSON.stringify({ uid: aliceId, exp: now + TTL, pv, sid: '' })), stateFor('S')) === 'malformed')
  check('15 now === exp → expired', d(mk({ exp: now }), stateFor('S'), now) === 'expired')
  check('16 now === exp - 1 → ok（边界的另一侧）', d(mk({ exp: now + 1 }), stateFor('S'), now) === 'ok')
  check('17 state === null（会话行与账号行都查不到）→ session-unknown', d(mk(), null) === 'session-unknown')
  check('18 会话行不存在（已清理 / 手改 sid）→ session-unknown', (() => {
    const absent = sessionsStore.findSessionState('这个-sid-库里没有')
    return absent === null && d(mk(), absent) === 'session-unknown'
  })())
  check('19 会话行 revoked_at 非空 → revoked', d(mk(), stateFor('S', { revokedAt: now - 1 })) === 'revoked')
  check('20 会话行 expires_at <= now（载荷窗口内）→ expired', d(mk(), stateFor('S', { expiresAt: now })) === 'expired')
  check('21 会话行在、账号行不在 → unknown-user', d(mk(), { session: stateFor('S').session, user: null }) === 'unknown-user')
  check('22 enabled = 0 → disabled', d(mk(), stateFor('S', {}, { enabled: 0 })) === 'disabled')
  check('23 user.tokenVersion !== session.pv → stale-version', d(mk(), stateFor('S', {}, { tokenVersion: pv + 1 })) === 'stale-version')

  // ── 第 24 行：**这张票存在的理由** ──
  // 它是「登出 = 真吊销」与「登出 ≠ 踢掉所有设备」的**同时**证明。
  // 只断言「登出后原 cookie 失效」是不够的 —— 那样把登出实现成 bumpTokenVersion 也能过，
  // 而用户要的恰恰是**不要**那样（map Notes 第 2 条）。
  {
    const a = sessionsStore.createSession(aliceId, pv, TTL, now)
    const b = sessionsStore.createSession(aliceId, pv, TTL, now)
    const tokenA = session.signSession(SECRET, { uid: aliceId, exp: now + TTL, pv, sid: a.sid })
    const tokenB = session.signSession(SECRET, { uid: aliceId, exp: now + TTL, pv, sid: b.sid })

    // 前提先成立：两台设备**此前都是 ok**（否则下面的断言是恒真的）
    check('24 前提：登出前，A 设备 ok', d(tokenA, sessionsStore.findSessionState(a.sid), now) === 'ok')
    check('24 前提：登出前，B 设备 ok', d(tokenB, sessionsStore.findSessionState(b.sid), now) === 'ok')

    const revoked = sessionsStore.revokeSession(a.sid, now)
    check('24 前提：吊销 A 影响 **1** 行', revoked === 1, 'changes=' + revoked)
    check('24 登出后 A 设备 → revoked', d(tokenA, sessionsStore.findSessionState(a.sid), now) === 'revoked')
    check('24 **登出后 B 设备仍然 ok**（登出 ≠ 踢掉所有设备）', d(tokenB, sessionsStore.findSessionState(b.sid), now) === 'ok')
    check('24 重复吊销是幂等的（changes = 0）', sessionsStore.revokeSession(a.sid, now) === 0)

    // 「登出全部设备」才是账号级的
    check('24 revokeUserSessions 吊销该账号**剩余**的会话（1 行）', sessionsStore.revokeUserSessions(aliceId, now) === 1)
    check('24 账号级吊销后 B 设备也失效', d(tokenB, sessionsStore.findSessionState(b.sid), now) === 'revoked')
  }

  // ── 清理：只删死行（§7）──
  {
    const live = sessionsStore.createSession(aliceId, pv, TTL, now)
    const expired = sessionsStore.createSession(aliceId, pv, 1, now - 1000)
    const removed = sessionsStore.sweepSessions(now)
    check('sweep：删掉了已过期与已吊销的行（计数 > 0）', removed > 0, 'changes=' + removed)
    check('sweep：**活着的行一行不动**', sessionsStore.findSessionState(live.sid) !== null)
    check('sweep：过期的那行真的没了', sessionsStore.findSessionState(expired.sid) === null)
  }
}

// ════════════════════════════════════════════════════
section('roles: 默认只读 · CHECK · 守卫（docs/roles-decision.md §2 §3）')
// ════════════════════════════════════════════════════
{
  const sessionsStore = await import(mod('dist/sessions-store.js'))

  // ── 默认与库约束 ──
  const carol = users.createUser('Carol', 'carol-password-123')
  check('新建账号默认 role = readonly（最小权限）', carol.role === 'readonly', carol.role)

  const raw = new Database(config.databasePath)
  let rejected = ''
  try {
    raw.prepare(`UPDATE users SET role = 'admni' WHERE id = ?`).run(carol.id)
  } catch (err) {
    rejected = String(err.message)
  }
  raw.close()
  // 非法值被**库**挡住，而不是靠每个写路径各自记得校验（§2 的理由）
  check('库的 CHECK 拒绝非法角色', /CHECK constraint failed/.test(rejected), rejected.slice(0, 70))

  // ── 守卫判定表（§3）──
  // 提权永不设卡：这是恢复通道
  users.setRole(carol.id, 'admin')
  check('提权 readonly → admin 允许（恢复通道永不设卡）', users.findById(carol.id).role === 'admin')

  // 此刻其余账号都是 readonly —— 于是 carol 就是「恰好一个启用中的管理员」
  check('前提：库里恰好一个启用中的管理员', users.countEnabledAdmins() === 1, `n=${users.countEnabledAdmins()}`)

  // ⚠ 同一个目标、同一个动作，**带不带 actor 走的是两条判据**：
  //    网页路径知道「谁在操作」，所以先撞「不能改自己」；CLI 没有 actor（运维就是操作者），
  //    于是撞「最后一个管理员」。两条都拦得住，但理由不同 —— 这正是守卫要区分的东西。
  const selfDemote = (() => {
    try {
      users.setRole(carol.id, 'readonly', carol.id)
      return ''
    } catch (err) {
      return String(err.message)
    }
  })()
  check('**不能改自己**（网页路径：自锁里最容易误触的一条）', /不能改自己/.test(selfDemote), selfDemote)

  const lastAdmin = (() => {
    try {
      users.setRole(carol.id, 'readonly')
      return ''
    } catch (err) {
      return String(err.message)
    }
  })()
  check('**最后一个启用中的管理员不可降级**（CLI 路径）', /最后一个启用中的管理员/.test(lastAdmin), lastAdmin)

  const lastDisable = (() => {
    try {
      users.setEnabled(carol.id, false)
      return ''
    } catch (err) {
      return String(err.message)
    }
  })()
  check('**最后一个启用中的管理员不可停用**', /最后一个启用中的管理员/.test(lastDisable), lastDisable)

  // 停用的管理员**不算数** —— 否则守卫形同虚设（一处自锁会被伪装成一处安全）
  const dave = users.createUser('Dave', 'dave-password-123', { enabled: false, role: 'admin' })
  check('停用的 admin 不计入「启用中的管理员」', users.countEnabledAdmins() === 1, `n=${users.countEnabledAdmins()}`)
  users.setEnabled(dave.id, true)
  check('启用账号永不设卡', users.findById(dave.id).enabled === 1)
  check('启用后它计入管理员数', users.countEnabledAdmins() === 2, `n=${users.countEnabledAdmins()}`)

  // 管理员 ≥ 2 时，降级别人是允许的（守卫只防「减到零」）
  users.setRole(carol.id, 'readonly', dave.id)
  check('管理员 ≥ 2 时降级别人允许', users.findById(carol.id).role === 'readonly')

  // ── 改口令 = 递增代次 **且** 级联吊销会话（同一事务，双保险）──
  const mine = sessionsStore.createSession(carol.id, users.findById(carol.id).token_version, 60_000)
  const others = sessionsStore.createSession(dave.id, users.findById(dave.id).token_version, 60_000)
  users.setPassword(carol.id, 'carol-password-456')
  check(
    '改口令**级联吊销**该账号的会话行',
    sessionsStore.findSessionState(mine.sid)?.session.revokedAt !== null,
  )
  check(
    '改口令**不碰**别人的会话行',
    sessionsStore.findSessionState(others.sid)?.session.revokedAt === null,
  )
}

// ════════════════════════════════════════════════════
section('csrf: L2 来源判定 + L3 令牌（docs/write-path-auth-decision.md §9.1）')
// ════════════════════════════════════════════════════
{
  const csrf = await import(mod('dist/csrf.js'))
  const SECRET2 = 'k'.repeat(32)
  const SESSION = 'cGF5bG9hZA.c2lnbmF0dXJl' // 形状正确：最后一个 '.' 之前是载荷
  const ALLOWED = new Set(['http://10.0.0.226:3000', 'https://wiki.example.com'])

  // ── L3 令牌 ──
  const t1 = csrf.csrfToken(SECRET2, SESSION)
  check('token 确定性：同样输入两次得到同一个值', t1 === csrf.csrfToken(SECRET2, SESSION))
  check('token 非空且是 base64url（43 字符 = 32 字节）', typeof t1 === 'string' && t1.length === 43, `len=${t1?.length}`)
  check('换会话即变', csrf.csrfToken(SECRET2, 'b3RoZXI.c2ln') !== t1)
  check('换密钥即变', csrf.csrfToken('x'.repeat(32), SESSION) !== t1)
  check('无 `.` → null（不是空串）', csrf.csrfToken(SECRET2, 'noseparator') === null)
  check('`.` 在开头 → null', csrf.csrfToken(SECRET2, '.sig') === null)

  check('verifyCsrf：正确 token → true', csrf.verifyCsrf(SECRET2, SESSION, t1) === true)
  check('verifyCsrf：长度不对 → false（**不抛**）', csrf.verifyCsrf(SECRET2, SESSION, 'short') === false)
  check(
    'verifyCsrf：等长但改一个字符 → false',
    csrf.verifyCsrf(SECRET2, SESSION, (t1[0] === 'A' ? 'B' : 'A') + t1.slice(1)) === false,
  )
  check(
    'verifyCsrf：非字符串不抛（数组 / 数字 / undefined / null）',
    [['a', 'b'], 42, undefined, null, {}].every((v) => csrf.verifyCsrf(SECRET2, SESSION, v) === false),
  )
  check('verifyCsrf：没有会话 token → false', csrf.verifyCsrf(SECRET2, undefined, t1) === false)
  check('verifyCsrf：会话 token 畸形（无 `.`）→ false', csrf.verifyCsrf(SECRET2, 'nosep', t1) === false)

  // ── L2 来源判定 ──
  const o = (headers) => csrf.checkOrigin(headers, ALLOWED)
  check('Origin 精确相等 → 通过', o({ origin: 'http://10.0.0.226:3000' }) === true)
  check('**端口属于 origin**：少了端口 → 拒绝', o({ origin: 'http://10.0.0.226' }) === false)
  check('多值集合里的另一个也通过', o({ origin: 'https://wiki.example.com' }) === true)
  check('**`example.com.evil.com` 型后缀伪造 → 拒绝**', o({ origin: 'https://wiki.example.com.evil.com' }) === false)
  check('前缀型伪造 → 拒绝', o({ origin: 'https://evil.com#https://wiki.example.com' }) === false)
  check('`Origin: null` → 拒绝（来源不可知，不是没有来源）', o({ origin: 'null' }) === false)
  check('`Origin` 与 `Referer` 都没有 → 拒绝', o({}) === false)
  check('空字符串按「头不存在」处理 → 拒绝', o({ origin: '' }) === false)
  check('`Referer` 回退：同源（带路径与查询）→ 通过', o({ referer: 'http://10.0.0.226:3000/password?x=1' }) === true)
  check('`Referer` 回退：站外 → 拒绝', o({ referer: 'http://evil.example.com/x' }) === false)
  check('`Referer` 回退：不是合法 URL → 拒绝（不抛）', o({ referer: 'not a url' }) === false)
  check('`Origin` 在时**不看** `Referer`', o({ origin: 'http://evil.example.com', referer: 'http://10.0.0.226:3000/' }) === false)

  // ── 配置解析与「非法条目拒绝启动」（用子进程换 env）──
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-csrf-'))
  const probe = path.join(tmp, 'probe-config.mjs')
  const runConfig = (env) => {
    fs.writeFileSync(
      probe,
      `const { config, assertSiteOrigins, assertTrustProxy } = await import(${JSON.stringify('file://' + path.join(root, 'dist/config.js'))});
       assertTrustProxy(); assertSiteOrigins();
       console.log(JSON.stringify([...config.siteOrigins]));`,
      'utf8',
    )
    try {
      const out = execFileSync(process.execPath, [probe], {
        cwd: root,
        encoding: 'utf8',
        env: { ...process.env, SITE_ORIGIN: '', TRUST_PROXY: '', ...env },
      })
      return { ok: true, origins: JSON.parse(out.trim().split('\n').pop()) }
    } catch (err) {
      return { ok: false, out: String(err.stdout ?? '') + String(err.stderr ?? '') }
    }
  }

  const parsed = runConfig({ SITE_ORIGIN: ' http://a.example.com:3000/ , https://b.example.com ' })
  check('配置解析：去空白、去结尾 `/`、按逗号分多值', parsed.ok && parsed.origins.join(',') === 'http://a.example.com:3000,https://b.example.com', JSON.stringify(parsed))
  const withPath = runConfig({ SITE_ORIGIN: 'http://a.example.com/wiki' })
  check('配置校验：带路径的条目**拒绝启动**', withPath.ok === false)
  check('报错里**指出是哪一条**', /http:\/\/a\.example\.com\/wiki/.test(withPath.out), withPath.out.slice(0, 120))
  const missing = runConfig({})
  check('`SITE_ORIGIN` 缺失 → **拒绝启动**', missing.ok === false)
  check('报错里给出示例行', /SITE_ORIGIN=http:\/\//.test(missing.out), missing.out.slice(0, 120))
  const badProxy = runConfig({ SITE_ORIGIN: 'http://a.example.com', TRUST_PROXY: 'true' })
  check('`TRUST_PROXY=true` → **拒绝启动**', badProxy.ok === false)
  check('报错里给出 CIDR 的写法', /CIDR/.test(badProxy.out), badProxy.out.slice(0, 120))
  const cidrProxy = runConfig({ SITE_ORIGIN: 'http://a.example.com', TRUST_PROXY: '127.0.0.1,10.0.0.0/8' })
  check('`TRUST_PROXY` 填 CIDR → 允许', cidrProxy.ok === true)
  fs.rmSync(tmp, { recursive: true, force: true })
}

// ════════════════════════════════════════════════════
section('requireAdmin: 资格守卫（一个守卫 + 一处判定）')
// ════════════════════════════════════════════════════
{
  const auth = await import(mod('dist/auth.js'))
  check('管理员 → 够格', auth.requireAdmin({ allow: true, role: 'admin' }) === true)
  check('**只读 → 不够格**（403，不是 404）', auth.requireAdmin({ allow: true, role: 'readonly' }) === false)
  check('未放行 → 不够格', auth.requireAdmin({ allow: false, role: 'admin' }) === false)
  check('放行但没有角色 → 不够格', auth.requireAdmin({ allow: true }) === false)
}

// ════════════════════════════════════════════════════
section('targets: 首次导入 / id 不可变 / 删除两岔 / enabled_at')
// ════════════════════════════════════════════════════
/*
 * 目标真源是 SQLite（`docs/targets-source-decision.md`），而本文件**顶层已经用 sandbox 的库**
 * 把 `config.databasePath` 冻结了 —— 所以这一节全部在**子进程**里跑：
 * 每个场景自带 `DATABASE_PATH` / `TARGETS_JSON`，互不污染，也正好验「启动时真的没崩」。
 */
{
  const tdir = fs.mkdtempSync(path.join(root, '.unit-targets-'))
  const scenarioFile = path.join(tdir, 'scenario.mjs')
  const fileUrl = (rel) => 'file://' + path.join(root, rel).replace(/\\/g, '/')

  // 场景脚本：只做动作、打成 JSON 交回来。断言全在下面（脚本越笨越好排错）。
  fs.writeFileSync(
    scenarioFile,
    `
import path from 'node:path'
import Database from 'better-sqlite3'
const T = await import(${JSON.stringify(fileUrl('dist/targets-store.js'))})
const S = await import(${JSON.stringify(fileUrl('dist/store.js'))})
const { config } = await import(${JSON.stringify(fileUrl('dist/config.js'))})
const scenario = process.argv[2]
const out = {}
const rowIds = () => T.rawTargets().map((r) => r.id)
const probeCount = () =>
  new Database(process.env.DATABASE_PATH, { readonly: true }).prepare('SELECT COUNT(*) AS n FROM probes').get().n
const DAY = 24 * 60 * 60 * 1000

if (scenario === 'import') {
  T.initTargets()
  // 与启动顺序一致（server.ts 的 buildServer）：导入之后再打那行「文件不再是输入」的警告。
  T.warnTargetsFileIsNoLongerInput()
  out.rows = T.rawTargets()
  out.enabledCount = T.countEnabledTargets()
  out.allCount = T.countAllTargets()
  out.probeList = T.listEnabledTargets().map((t) => t.id)
  out.source = config.targets.map((t) => t.id)
}

if (scenario === 'list') {
  out.all = T.listAllTargets().map((r) => ({ id: r.id, group: r.group, enabled: r.enabled, hasHistory: r.hasHistory }))
  out.getTarget = T.getTarget('ok') ? T.getTarget('ok').id : null
  out.missing = T.getTarget('nope') === undefined
}

if (scenario === 'write') {
  const now = Date.now()
  const base = { name: '新目标', url: 'https://example.com/', enabled: true }
  out.create = T.createTarget({ id: 'fresh', ...base })
  out.duplicate = T.createTarget({ id: 'fresh', ...base })
  // 更新时混进一个 id 字段：**不该被采纳**（updateTarget 的签名里根本没有它）
  out.updateChanges = T.updateTarget('fresh', { name: '改过名', url: 'https://example.com/x', id: 'hijack' })
  const afterUpdate = T.getTarget('fresh')
  out.afterUpdate = { id: afterUpdate.id, name: afterUpdate.name, url: afterUpdate.url }

  // 删除两岔之一：**没有历史** → 物理删行，id 可以再用
  out.deleteNoHistory = T.removeOrDisableTarget('fresh')
  out.afterDelete = rowIds()
  out.reCreate = T.createTarget({ id: 'fresh', name: '再来一次', url: 'https://example.com/', enabled: true })

  // 删除两岔之二：**有历史** → 只停用，probes 行数一行不变
  S.initStore()
  out.probesBefore = probeCount()
  S.recordResults([{ targetId: 'fresh', at: now, roundAt: now, status: 'up', latencyMs: 3, statusCode: 200, error: null }])
  out.probesAfterInsert = probeCount()
  out.deleteWithHistory = T.removeOrDisableTarget('fresh')
  out.probesAfterDelete = probeCount()
  const row = T.getTarget('fresh')
  out.rowAfter = { exists: !!row, enabled: row ? row.enabled : null, hasHistory: row ? row.hasHistory : null }
  // 停用后的目标不再进探测清单
  out.probeListAfterDisable = T.listEnabledTargets().map((t) => t.id).includes('fresh')
}

if (scenario === 'streak') {
  const now = Date.now()
  // 100 天前的一次 up：老算法会把它当成「连续可用 100 天」的起点
  S.initStore()
  S.recordResults([{ targetId: 'ok', at: now - 100 * DAY, roundAt: now - 100 * DAY, status: 'up', latencyMs: 5, statusCode: 200, error: null }])
  // 停用再启用（enabled_at 刷新到现在），然后**重新启用后的第一轮探测**是 up
  T.setTargetEnabled('ok', false)
  T.setTargetEnabled('ok', true)
  S.recordResults([{ targetId: 'ok', at: now, roundAt: now, status: 'up', latencyMs: 5, statusCode: 200, error: null }])
  const enabledAt = T.getTarget('ok').enabledAt
  out.enabledAtRecent = now - enabledAt < 5000
  // 同一批数据、两个答案：不带下界 = 老行为（会说「连续可用 100 天」，而它停了 100 天）
  out.withoutFloor = S.getStats('ok', 365 * DAY).upStreakMs
  out.floored = S.getStats('ok', 365 * DAY, enabledAt).upStreakMs
}

if (scenario === 'uptime') {
  const now = Date.now()
  S.initStore()
  const rows = []
  for (const round of [now - 2000, now - 1000]) {
    for (const id of ['ok', 'bad', 'dead']) {
      rows.push({ targetId: id, at: round, roundAt: round, status: id === 'ok' ? 'up' : 'down', latencyMs: 4, statusCode: 200, error: null })
    }
  }
  S.recordResults(rows)
  out.pointsWith3 = S.getUptimeRaw(60 * 60 * 1000, 3).length
  out.pointsWith4 = S.getUptimeRaw(60 * 60 * 1000, 4).length
  out.totalsWith3 = S.getUptimeRaw(60 * 60 * 1000, 3).map((p) => p.total)
}

if (scenario === 'dupcol') {
  // 「这一列已经有了」在并发首启时是**正常结果**；别的错误一律照抛（失败要显眼）。
  out.duplicate = S.isDuplicateColumnError(new Error('duplicate column name: round_at'))
  out.other = S.isDuplicateColumnError(new Error('no such table: probes'))
  out.undefined = S.isDuplicateColumnError(undefined)
}

console.log(JSON.stringify(out))
`,
    'utf8',
  )

  /** 跑一个场景：env 覆盖 DATABASE_PATH / TARGETS_JSON / TARGETS_PATH，返回 {status,stdout,stderr}。 */
  const run = (scenario, db, env = {}, extraArgs = []) =>
    spawnSync(process.execPath, [scenarioFile, scenario, ...extraArgs], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        DATABASE_PATH: db,
        TARGETS_JSON: '',
        TARGETS_PATH: '',
        SESSION_SECRET: 'unit-targets-secret',
        ...env,
      },
    })
  const json = (r) => {
    try {
      return JSON.parse(String(r.stdout).trim().split('\n').pop())
    } catch {
      return { __parseError: String(r.stdout).slice(-300) + String(r.stderr).slice(-300) }
    }
  }

  const FILE3 = [
    { id: 'ok', name: '可用', url: 'https://example.com/', group: 'G1', expectStatus: [200] },
    { id: 'bad', name: '状态码不符', url: 'https://example.com/', group: 'G1', expectStatus: [999] },
    { id: 'dead', name: '不可达', url: 'http://10.255.255.1/', group: 'G2', timeoutMs: 1500 },
  ]

  // ── ① 空库 + 3 条合法目标 → 3 行且字段一致 ──
  const db1 = path.join(tdir, 't1.sqlite')
  const first = run('import', db1, { TARGETS_JSON: JSON.stringify(FILE3) })
  const firstOut = json(first)
  check('首次导入：空库 + 3 条 → 3 行', firstOut.allCount === 3, JSON.stringify(firstOut.rows?.map?.((r) => r.id)))
  const byId = Object.fromEntries((firstOut.rows ?? []).map((r) => [r.id, r]))
  check(
    '首次导入：字段逐个落对（group/expect_status/timeout_ms/enabled）',
    byId.ok?.grp === 'G1' &&
      byId.ok?.expect_status === '[200]' &&
      byId.dead?.timeout_ms === 1500 &&
      byId.dead?.grp === 'G2' &&
      byId.bad?.expect_status === '[999]' &&
      byId.ok?.enabled === 1,
    JSON.stringify(firstOut.rows),
  )
  check('首次导入：探测清单只含启用中的', String(firstOut.probeList) === 'bad,dead,ok', String(firstOut.probeList))
  check('首次导入：日志一行说清来源与「此后真源是 SQLite」', /首次导入 3 个目标/.test(first.stdout) && /此后真源是 SQLite/.test(first.stdout), first.stdout.trim().split('\n').pop())
  check('首次导入：导入时**不打**「文件不再是输入」的警告', !/不再是输入/.test(first.stderr), first.stderr.trim())

  // ── ② 再启动一次 → 仍 3 行、没有第二次导入日志 ──
  const second = run('import', db1, { TARGETS_JSON: JSON.stringify(FILE3) })
  const secondOut = json(second)
  check('幂等：再启动一次仍 3 行', secondOut.allCount === 3, String(secondOut.allCount))
  check('幂等：**没有**第二份导入日志', !/首次导入/.test(second.stdout), second.stdout.trim())
  check('幂等：这次打出了「文件不再是输入」的警告（真源是库）', /不再是输入/.test(second.stderr) && /管理台/.test(second.stderr), second.stderr.trim().slice(0, 200))

  // ── ③ 库非空 + 文件另 3 条 → 库里不动 ──
  const OTHER3 = FILE3.map((t) => ({ ...t, id: t.id + '-other' }))
  const third = run('import', db1, { TARGETS_JSON: JSON.stringify(OTHER3) })
  const thirdOut = json(third)
  check('库非空：文件里的新条目**一条都不进来**', thirdOut.allCount === 3 && !String(thirdOut.rows.map((r) => r.id)).includes('other'), String(thirdOut.rows.map((r) => r.id)))
  check('库非空：忽略文件时打警告', /不再是输入/.test(third.stderr), third.stderr.trim().slice(0, 160))

  // ── ④ 带凭证的 URL：该条不入库，其余照常 ──
  const credFile = [
    { id: 'ok2', name: '好的', url: 'https://example.com/' },
    { id: 'creds', name: '带凭证', url: 'http://ops:hunter2@ledger.internal.example/' },
    { id: 'bad2', name: '也好', url: 'https://example.com/' },
  ]
  const cred = json(run('import', path.join(tdir, 't2.sqlite'), { TARGETS_JSON: JSON.stringify(credFile) }))
  check('带凭证的 URL **不入库**，其余两条照常入库', String(cred.rows.map((r) => r.id)) === 'bad2,ok2', String(cred.rows.map((r) => r.id)))
  check('带凭证的那条有 `console.warn`（复用 validateTargetUrl）', cred.rows.length === 2)

  // ── ⑤ 文件里两条同 id → 只入第一条 ──
  const dupFile = [
    { id: 'same', name: '第一条', url: 'https://example.com/1' },
    { id: 'same', name: '第二条', url: 'https://example.com/2' },
  ]
  const dup = json(run('import', path.join(tdir, 't3.sqlite'), { TARGETS_JSON: JSON.stringify(dupFile) }))
  check('同 id 只入第一条（重复条目被跳过）', dup.rows.length === 1 && dup.rows[0].name === '第一条', JSON.stringify(dup.rows.map((r) => r.name)))

  // ── ⑥ 文件不是数组 / 不存在 → 0 行、有警告、**服务照常启动** ──
  const notArray = path.join(tdir, 'not-array.json')
  fs.writeFileSync(notArray, '{"id":"x"}', 'utf8')
  const na = run('import', path.join(tdir, 't4.sqlite'), { TARGETS_PATH: notArray })
  check('文件不是数组 → 0 行，但**进程正常退出**（不抛）', na.status === 0 && json(na).allCount === 0, `status=${na.status}`)
  check('文件不是数组 → 打出了警告', /必须是数组/.test(na.stderr), na.stderr.trim().slice(0, 160))
  const missingFile = run('import', path.join(tdir, 't5.sqlite'), { TARGETS_PATH: path.join(tdir, 'nope.json') })
  check('文件不存在 → 0 行、不报错、照常启动', missingFile.status === 0 && json(missingFile).allCount === 0, `status=${missingFile.status}`)

  // ── ⑦⑧⑨ 删除两岔 / id 不可变 / 重复 id ──
  const w = json(run('write', db1, { TARGETS_JSON: JSON.stringify(FILE3) }))
  check('新增 → `created`', w.create === 'created', String(w.create))
  check('同 id 再新增 → `duplicate`（靠主键约束，不是先查再插）', w.duplicate === 'duplicate', String(w.duplicate))
  check('编辑只改传入的字段，`changes=1`', w.updateChanges === 1, String(w.updateChanges))
  check('**提交里混进的 `id` 被忽略**（id 不可变）', w.afterUpdate.id === 'fresh' && w.afterUpdate.name === '改过名', JSON.stringify(w.afterUpdate))
  check('无历史 → **物理删行**', w.deleteNoHistory === 'deleted' && !String(w.afterDelete).includes('fresh'), `${w.deleteNoHistory} · ${JSON.stringify(w.afterDelete)}`)
  check('删掉之后同一个 id 可以再新增', w.reCreate === 'created', String(w.reCreate))
  check('有历史 → **只停用**，probes 行数一行不变', w.deleteWithHistory === 'disabled' && w.probesAfterDelete === w.probesBefore + 1, `${w.deleteWithHistory} · ${w.probesBefore}→${w.probesAfterInsert}→${w.probesAfterDelete}`)
  check('停用后该行还在（enabled=0、hasHistory=true）', w.rowAfter.exists && w.rowAfter.enabled === false && w.rowAfter.hasHistory === true, JSON.stringify(w.rowAfter))
  check('停用后不再进探测清单', w.probeListAfterDisable === false, String(w.probeListAfterDisable))

  // ── ⑩ getUptimeRaw 的口径回归（期望目标数由调用方给）──
  const up = json(run('uptime', db1, { TARGETS_JSON: JSON.stringify(FILE3) }))
  check('getUptimeRaw：期望 3 → 两轮都留下、每轮 total=3', up.pointsWith3 === 2 && String(up.totalsWith3) === '3,3', JSON.stringify(up))
  check('getUptimeRaw：期望 4 → 同一批数据被 `HAVING total >= ?` 滤掉（口径真的跟着参数走）', up.pointsWith4 === 0, String(up.pointsWith4))

  // ── ⑪ enabled_at 下界：停用再启用后连续可用从**重新启用**起算 ──
  const st = json(run('streak', db1, { TARGETS_JSON: JSON.stringify(FILE3) }))
  check('前提：**同一批数据**不带下界时会说「连续可用约 100 天」（这就是要修的谎）', st.withoutFloor > 90 * 24 * 3600 * 1000, String(st.withoutFloor))
  check('设了 enabled_at 之后，连续可用从重新启用那一刻起算（< 5 秒）', st.enabledAtRecent === true && st.floored < 5000, JSON.stringify(st))

  // ── ⑫ 双进程同时首次启动 → 无重复 id、不抛异常 ──
  /*
   * 这条曾经**真的会偶发失败**（负载下 100 次并发首启必现 1 次）：
   * 两个进程同时读 `PRAGMA table_info` 以为缺列，先到的补完，后到的执行 `ALTER TABLE`
   * 拿到 `duplicate column name` → 进程直接退出 1（服务起不来）。
   * 处置：`isDuplicateColumnError()` 容忍这一种错（补列迁移因此幂等），其余错误照抛。
   * 这里跑 4 个进程（更接近 `docker restart` 与 `up` 撞在一起的真实形状），并**把 stderr 读走**，
   * 失败时原文就摆在 detail 里。
   */
  const raceDb = path.join(tdir, 't7.sqlite')
  const raceEnv = { ...process.env, DATABASE_PATH: raceDb, TARGETS_JSON: JSON.stringify(FILE3), TARGETS_PATH: '' }
  // 前置对照：**单进程**在另一个库上跑一遍，证明场景本身可复现（不是「四进程才有输出」）。
  const p1 = run('import', path.join(tdir, 't6.sqlite'), { TARGETS_JSON: JSON.stringify(FILE3) })
  const { spawn } = await import('node:child_process')
  const both = await Promise.all(
    [0, 1, 2, 3].map(
      () =>
        new Promise((resolve) => {
          const c = spawn(process.execPath, [scenarioFile, 'import'], { cwd: root, env: raceEnv })
          let out = ''
          let err = ''
          c.stdout.on('data', (d) => (out += d))
          // stderr 也要读走：管道写满会把子进程堵住，而失败时的原文正是排查依据。
          c.stderr.on('data', (d) => (err += d))
          c.on('close', (code) => resolve({ code, out, err }))
        }),
    ),
  )
  check(
    '四进程同启：全部正常退出（补列迁移在并发下幂等，不抛异常）',
    both.every((r) => r.code === 0),
    JSON.stringify(both.map((r) => ({ code: r.code, err: r.err.trim().slice(-200) }))),
  )
  const raced = json(run('import', raceDb, { TARGETS_JSON: JSON.stringify(FILE3) }))
  check('四进程同启：库里恰好 3 行、无重复 id', raced.allCount === 3 && new Set(raced.rows.map((r) => r.id)).size === 3, JSON.stringify(raced.rows.map((r) => r.id)))
  check('（前置）单进程那份数据也建好了，说明场景本身可复现', p1.status === 0)
  const dc = json(run('dupcol', raceDb, { TARGETS_JSON: JSON.stringify(FILE3) }))
  check('补列容错只认这一种错：`duplicate column name` → 容忍', dc.duplicate === true, JSON.stringify(dc))
  check('别的错（`no such table`）**照旧抛**，不静默降级', dc.other === false && dc.undefined === false, JSON.stringify(dc))

  // ── hasHistory 与 listAllTargets（页面按它决定按钮文案）──
  const l = json(run('list', db1, { TARGETS_JSON: JSON.stringify(FILE3) }))
  check(
    'listAllTargets：带 group 与 hasHistory，且未分组的排最后',
    l.all.length === 4 &&
      l.all.some((r) => r.id === 'fresh' && r.hasHistory === true && r.enabled === false) &&
      l.all[l.all.length - 1].id === 'fresh' &&
      l.all[0].group === 'G1',
    JSON.stringify(l.all),
  )
  check('getTarget：存在拿到、不存在给 undefined', l.getTarget === 'ok' && l.missing === true, JSON.stringify(l))

  fs.rmSync(tdir, { recursive: true, force: true })
}

// ════════════════════════════════════════════════════
section('settings: 首次落值 / DB 优先 / 坏值回退')
// ════════════════════════════════════════════════════
/*
 * 与 target 那节同一条理由：`config` 在 import 时读 env 并冻结，所以每个场景都在**子进程**里跑，
 * 自带 `DATABASE_PATH` / `SITE_TITLE` / `SITE_DESCRIPTION` / `PROBE_INTERVAL_SECONDS`。
 */
{
  const sdir = fs.mkdtempSync(path.join(root, '.unit-settings-'))
  const sfile = path.join(sdir, 'scenario.mjs')
  const fileUrl = (rel) => 'file://' + path.join(root, rel).replace(/\\/g, '/')

  fs.writeFileSync(
    sfile,
    `
import Database from 'better-sqlite3'
const St = await import(${JSON.stringify(fileUrl('dist/settings-store.js'))})
const scenario = process.argv[2]
const out = {}
const rawRows = () => {
  const db = new Database(process.env.DATABASE_PATH, { readonly: true })
  const rows = db.prepare('SELECT key, value FROM settings ORDER BY key').all()
  db.close()
  return rows
}

if (scenario === 'start') {
  // 与启动顺序一致：initSettings() 就是那个「首次落值」的入口
  St.initSettings()
  out.rows = rawRows()
  out.title = St.getSiteTitle()
  out.description = St.getSiteDescription()
  out.intervalSeconds = St.getProbeIntervalSeconds()
  out.list = St.listSettings().map((s) => ({ key: s.key, value: s.value, bad: s.bad, outOfFormRange: s.outOfFormRange }))
}

if (scenario === 'corrupt') {
  // 手工把库改坏（手工改库 / 旧版本留下的值都长这样），再读
  const db = new Database(process.env.DATABASE_PATH)
  db.prepare("UPDATE settings SET value = 'abc' WHERE key = 'probe.intervalSeconds'").run()
  db.prepare("INSERT INTO settings (key, value, updated_at) VALUES ('site.unknown', 'x', 1)").run()
  db.close()
  St.initSettings()
  out.intervalSeconds = St.getProbeIntervalSeconds()
  out.unknownInList = St.listSettings().some((s) => s.key === 'site.unknown')
  out.listKeys = St.listSettings().map((s) => s.key)
}

if (scenario === 'zero') {
  const db = new Database(process.env.DATABASE_PATH)
  db.prepare("UPDATE settings SET value = '0' WHERE key = 'probe.intervalSeconds'").run()
  db.close()
  St.initSettings()
  out.intervalSeconds = St.getProbeIntervalSeconds()
  out.intervalMs = St.getProbeIntervalMs()
}

console.log(JSON.stringify(out))
`,
    'utf8',
  )

  const srun = (scenario, db, env = {}) =>
    spawnSync(process.execPath, [sfile, scenario], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        DATABASE_PATH: db,
        SESSION_SECRET: 'unit-settings-secret',
        SITE_TITLE: '',
        SITE_DESCRIPTION: '',
        PROBE_INTERVAL_SECONDS: '',
        ...env,
      },
    })
  const sjson = (r) => {
    try {
      return JSON.parse(String(r.stdout).trim().split('\n').pop())
    } catch {
      return { __parseError: String(r.stdout).slice(-200) + String(r.stderr).slice(-300) }
    }
  }

  const sdb = path.join(sdir, 's1.sqlite')

  // ── ① 空库 + env → 3 行、值取 env ──
  const first = srun('start', sdb, { SITE_TITLE: '验收标题', SITE_DESCRIPTION: '验收描述', PROBE_INTERVAL_SECONDS: '42' })
  const firstOut = sjson(first)
  check('首启落 3 行（白名单就这 3 个键）', firstOut.rows?.length === 3, JSON.stringify(firstOut.rows))
  check(
    '首启的三个生效值都取自 env',
    firstOut.title === '验收标题' && firstOut.description === '验收描述' && firstOut.intervalSeconds === 42,
    JSON.stringify(firstOut),
  )
  check('首启日志说清「已固定为 X」与来源', /已固定为/.test(first.stdout) && /来源：\.env/.test(first.stdout), first.stdout.trim().split('\n').slice(-1)[0])
  check('三个键一个都不缺', String(firstOut.list.map((s) => s.key)) === 'site.title,site.description,probe.intervalSeconds', JSON.stringify(firstOut.list))

  // ── ② 再启动一次：幂等、且没有第二次落值日志 ──
  const second = srun('start', sdb, { SITE_TITLE: '验收标题', SITE_DESCRIPTION: '验收描述', PROBE_INTERVAL_SECONDS: '42' })
  check('二次启动仍 3 行（幂等）', sjson(second).rows?.length === 3)
  check('二次启动**没有**第二份落值日志', !/已固定为/.test(second.stdout), second.stdout.trim())
  check('二次启动 env 与库一致 → **不**打「被忽略」的警告（不凭空吓人）', !/已被忽略/.test(second.stderr), second.stderr.trim())

  // ── ③ env 与库不同 → 读库值 + 警告 ──
  const third = srun('start', sdb, { SITE_TITLE: 'env 里改过的标题', SITE_DESCRIPTION: '验收描述', PROBE_INTERVAL_SECONDS: '99' })
  const thirdOut = sjson(third)
  check('**库值优先**：env 改成别的，读出来还是库里那个', thirdOut.title === '验收标题' && thirdOut.intervalSeconds === 42, JSON.stringify(thirdOut))
  check('并且打出「env 已被忽略」的警告', /已被忽略/.test(third.stderr) && /真源是数据库/.test(third.stderr), third.stderr.trim().slice(0, 180))
  check('警告里给出「要改去管理台」的落点', /管理台 → 站点设置/.test(third.stderr), third.stderr.trim().slice(-80))

  // ── ④ 再改一次 env：仍然无效（env 确实不再参与）──
  const fourth = srun('start', sdb, { SITE_TITLE: '第三次改 env', PROBE_INTERVAL_SECONDS: '7' })
  check('再改 env 仍然无效（库值不动）', sjson(fourth).title === '验收标题' && sjson(fourth).intervalSeconds === 42, JSON.stringify(sjson(fourth)))

  // ── ⑤ 坏值回退默认 + console.error ──
  const corrupt = srun('corrupt', sdb)
  const corruptOut = sjson(corrupt)
  check('库里 `"abc"` → 回退默认 60 秒，不抛', corruptOut.intervalSeconds === 60, JSON.stringify(corruptOut))
  check('坏值回退时打出 `console.error`（不是静默用 NaN 跑）', /已回退默认值/.test(corrupt.stderr), corrupt.stderr.trim().slice(-160))

  // ── ⑥ 代码不认识的键：忽略 + 警告，且**不进页面清单** ──
  check('未知键被忽略、不进 `listSettings()`', corruptOut.unknownInList === false && !String(corruptOut.listKeys).includes('unknown'), JSON.stringify(corruptOut.listKeys))
  check('未知键在启动时警告一次', /不认识的设置键/.test(corrupt.stderr), corrupt.stderr.trim().slice(0, 160))

  // ── ⑦ 库里 0 → 回退默认（不是 0 秒空转）──
  const zero = sjson(srun('zero', sdb))
  check('库里 `intervalSeconds = 0` → 回退默认 60（不是 0 秒空转）', zero.intervalSeconds === 60 && zero.intervalMs === 60000, JSON.stringify(zero))

  // ── 写路径的逐键校验（区间只有一个来源）──
  {
    const St = await import(mod('dist/settings-store.js'))
    check('校验：空标题 → 拒', typeof St.validateSettingValue('site.title', '') === 'string')
    check('校验：60 字标题 → 过', St.validateSettingValue('site.title', '标'.repeat(60)) === null)
    check('校验：61 字标题 → 拒', typeof St.validateSettingValue('site.title', '标'.repeat(61)) === 'string')
    check('校验：描述可以为空（0–200）', St.validateSettingValue('site.description', '') === null)
    check('校验：201 字描述 → 拒', typeof St.validateSettingValue('site.description', '描'.repeat(201)) === 'string')
    check('校验：间隔 5 与 86400 → 过', St.validateSettingValue('probe.intervalSeconds', '5') === null && St.validateSettingValue('probe.intervalSeconds', '86400') === null)
    check('校验：间隔 3 → 拒，且文案给出区间', /5–86400/.test(String(St.validateSettingValue('probe.intervalSeconds', '3'))), String(St.validateSettingValue('probe.intervalSeconds', '3')))
    check('校验：间隔非整数 → 拒', typeof St.validateSettingValue('probe.intervalSeconds', '3.5') === 'string')
    check('校验：未知键 → 拒', typeof St.validateSettingValue('site.nope', 'x') === 'string')
  }

  // ── ⑧ 低于**表单**下界的值（来自 .env 的首次落值）照用，不回退 ──
  /*
   * 这是落地时踩到的一个真坑：读路径一开始拿**表单区间**（5–86400）当「值坏没坏」的判据，
   * 于是 `PROBE_INTERVAL_SECONDS=3` 的部署升级后被**静默**改成每 60 秒探一次
   * （实测：整个 e2e 的探测节奏被它打乱、面板曲线全空）。
   * 表单区间管的是「有人手打的值」，读路径只管「这个值坏了没有」—— 两件事。
   */
  {
    const low = sjson(srun('start', path.join(sdir, 'low.sqlite'), { PROBE_INTERVAL_SECONDS: '3' }))
    check('env 里 3 秒（低于表单下界 5）→ **照用 3**，不回退成 60', low.intervalSeconds === 3, JSON.stringify(low.intervalSeconds))
    check('但页面上会标出「超出表单区间」（想改就得落回区间内）', low.list.some((s) => s.key === 'probe.intervalSeconds' && s.outOfFormRange === true), JSON.stringify(low.list))
    check('它不算「坏值」（`bad=false`）', low.list.every((s) => s.key !== 'probe.intervalSeconds' || s.bad === false), JSON.stringify(low.list))
  }

  // ── ⑨ 写路径的「不改就不拦」例外 ──
  {
    const St = await import(mod('dist/settings-store.js'))
    check('校验：间隔仍是库里那个 3（一字不差）→ **放行**（用户只是在改标题）', St.validateSettingValue('probe.intervalSeconds', '3', '3') === null, String(St.validateSettingValue('probe.intervalSeconds', '3', '3')))
    check('校验：把它从 5 改成 3 → **拒**（要改就必须守区间）', typeof St.validateSettingValue('probe.intervalSeconds', '3', '5') === 'string')
    check('校验：不改标题时超长也一样放行（原值一字不差）', St.validateSettingValue('site.title', '标'.repeat(61), '标'.repeat(61)) === null)
  }

  fs.rmSync(sdir, { recursive: true, force: true })
}

// ════════════════════════════════════════════════════
section('backups: 目录三态与产物清单（#43）')
// ════════════════════════════════════════════════════
/*
 * `config.backupDir` 在 import 时冻结，所以每个情形都在**子进程**里跑，`BACKUP_DIR` 由父进程给。
 * 三种状态必须分得开 —— 一个「空数组」既可能是「还没备份过」，也可能是「目录配错了」，
 * 而后者正是备份页最该帮人看出来的事。
 */
{
  const bdir = fs.mkdtempSync(path.join(root, '.unit-backups-'))
  const bfile = path.join(bdir, 'scenario.mjs')
  const fileUrl = (rel) => 'file://' + path.join(root, rel).replace(/\\/g, '/')

  fs.writeFileSync(
    bfile,
    `
const B = await import(${JSON.stringify(fileUrl('dist/backup.js'))})
const l = B.listBackupFiles()
console.log(JSON.stringify({
  dir: l.dir,
  missing: l.missing,
  unreadable: l.unreadable,
  note: l.note ?? null,
  files: l.files.map((f) => ({ name: f.name, bytes: f.bytes })),
  ascending: B.listBackups(),
}))
`,
    'utf8',
  )
  const brun = (dir) =>
    spawnSync(process.execPath, [bfile], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, BACKUP_DIR: dir, SESSION_SECRET: 'unit-backup-secret' },
    })
  const bjson = (r) => {
    try {
      return JSON.parse(String(r.stdout).trim().split('\n').pop())
    } catch {
      return { __parseError: String(r.stdout).slice(-200) + String(r.stderr).slice(-300) }
    }
  }

  // ① 目录还不存在（正常初始状态，不是错误）
  const missing = bjson(brun(path.join(bdir, 'nope')))
  check('目录不存在 → `missing:true`（这是正常初始态，不是故障）', missing.missing === true && missing.unreadable === false && missing.files.length === 0, JSON.stringify(missing))

  // ② 目录存在但空
  const emptyDir = path.join(bdir, 'empty')
  fs.mkdirSync(emptyDir, { recursive: true })
  const empty = bjson(brun(emptyDir))
  check('空目录 → 三态里「在、可读、没有产物」', empty.missing === false && empty.unreadable === false && empty.files.length === 0, JSON.stringify(empty))

  // ③ 路径不是目录（父级是个文件）：**这是要显眼说出来的故障**，不是「还没有备份」
  const asFile = path.join(bdir, 'blocker')
  fs.writeFileSync(asFile, 'not a dir')
  const broken = bjson(brun(path.join(asFile, 'sub')))
  check('父级是文件 → `unreadable:true` 且带原因（**不**伪装成「还没有备份」）', broken.unreadable === true && broken.missing === false && typeof broken.note === 'string' && broken.note.length > 0, JSON.stringify(broken))

  // ④ 三份产物 + 一个杂项文件：只列产物、**最新在前**、带大小
  const fullDir = path.join(bdir, 'full')
  fs.mkdirSync(fullDir, { recursive: true })
  for (const [name, size] of [['2026-01-01.sqlite', 10], ['2026-03-01.sqlite', 20], ['2026-02-01.sqlite', 30]]) {
    fs.writeFileSync(path.join(fullDir, name), Buffer.alloc(size, 7))
  }
  fs.writeFileSync(path.join(fullDir, 'README.txt'), 'x')
  fs.writeFileSync(path.join(fullDir, '2026-04-01.sqlite.tmp'), 'x')
  const full = bjson(brun(fullDir))
  check('只列 `YYYY-MM-DD.sqlite`（杂项与 `.tmp` 残留都不算产物）', full.files.length === 3 && !full.files.some((f) => /tmp|txt/.test(f.name)), JSON.stringify(full.files.map((f) => f.name)))
  check('**最新在前**（页面就按这个顺序渲染）', String(full.files.map((f) => f.name)) === '2026-03-01.sqlite,2026-02-01.sqlite,2026-01-01.sqlite', JSON.stringify(full.files.map((f) => f.name)))
  check('带真实大小（页面上要显示）', full.files.find((f) => f.name === '2026-02-01.sqlite').bytes === 30, JSON.stringify(full.files))
  check('`listBackups()` 仍是**升序**（`pruneBackups()` 靠它删最旧的）', String(full.ascending) === '2026-01-01.sqlite,2026-02-01.sqlite,2026-03-01.sqlite', JSON.stringify(full.ascending))

  fs.rmSync(bdir, { recursive: true, force: true })
}

if (failed === 0) {
  console.log(`✅ 全部通过：${passed} 项`)
} else {
  console.log(`❌ ${failed} 项失败 / 共 ${passed + failed} 项`)
  for (const f of failures) console.log(`   - ${f}`)
}
process.exit(failed === 0 ? 0 : 1)
