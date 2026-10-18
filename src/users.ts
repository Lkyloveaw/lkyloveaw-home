/**
 * 账号存储与口令校验。
 *
 * 为什么单独一个模块：会话（`src/session.ts`）与闸门（`src/server.ts`）都要问「这个 uid 还能不能用」，
 * 而 bcrypt 是唯一需要口令哈希的地方——把它关在这里，别处不需要知道 bcrypt 的存在。
 *
 * 本模块**不碰 HTTP**：所有函数都是纯库函数，可以不过 HTTP 直接断言。
 */
import bcrypt from 'bcryptjs'
import { initStore, isDuplicateColumnError } from './store.js'
import { initSessionsTable, revokeUserSessions } from './sessions-store.js'

/**
 * bcrypt 代价因子。
 * 定为 12：实测本机约 260ms/次。内网个人站、账号以个位计、登录是低频动作，
 * 260ms 在人类感知上等同瞬时，而 cost 10 的 70ms 对离线爆破偏薄。见 `docs/accounts-decision.md` §1。
 */
export const BCRYPT_COST = 12

/** 口令最短长度。见 map Notes：「密码 bcrypt 哈希，最短 8 位」。 */
export const MIN_PASSWORD_LENGTH = 8

/**
 * 角色。用**领域词**当取值而不是 `INTEGER 0/1`：`SELECT` 出来不会记反，
 * 写接口与日志里也不需要一张常量对照表（`docs/roles-decision.md` §2）。
 */
export type Role = 'admin' | 'readonly'

export interface UserRow {
  id: number
  username: string
  password_hash: string
  created_at: number
  enabled: number
  updated_at: number | null
  token_version: number
  role: Role
}

/** 闸门每请求只需要这几项——不要 SELECT *，多余字段是日后泄漏的种子。 */
export interface AuthState {
  id: number
  enabled: number
  tokenVersion: number
  /** **库是唯一真源**：角色不进 cookie，所以降级/提权下一个请求就生效（§2 的理由）。 */
  role: Role
}

/**
 * 用户不存在时用来「假装比对」的哈希。
 *
 * 为什么必须有：若直接返回，「用户不存在」会比「口令错误」快一个数量级，
 * 攻击者靠响应时间就能枚举出哪些用户名是有效的。对固定假哈希也跑一次比对即可抹平这个差异。
 * 惰性求值：cost=12 的哈希约 260ms，没必要让每个进程启动都付这个成本。
 */
let dummyHash: string | null = null
function getDummyHash(): string {
  if (dummyHash === null) {
    dummyHash = bcrypt.hashSync('placeholder-for-constant-time-compare', BCRYPT_COST)
  }
  return dummyHash
}

/**
 * 用户名归一化：`trim()` + 转小写。
 *
 * 双保险：建表已用 `COLLATE NOCASE`，但 `NOCASE` 只覆盖 ASCII `A-Z`，
 * 且「存储时就归一」能让排查时的等值查询符合直觉。见 `docs/accounts-decision.md` §2。
 */
function normalizeUsername(username: string): string {
  return username.trim().toLowerCase()
}

function assertPassword(password: string): void {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`口令至少 ${MIN_PASSWORD_LENGTH} 位`)
  }
}

let initialized = false

/**
 * 建 `users` 表并就地把旧库补上 `token_version` 列。
 *
 * 迁移风格沿用 `store.ts:74-84`（`PRAGMA table_info` 检出 → `ALTER TABLE`）。
 * **必须幂等**：旧库第一次启动就要跑通，否则闸门会在 `no such column: token_version` 上直接 500。
 */
export function initUsers(): void {
  const db = initStore()
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      username      TEXT    NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT    NOT NULL,
      created_at    INTEGER NOT NULL,
      enabled       INTEGER NOT NULL DEFAULT 1,
      updated_at    INTEGER,
      token_version INTEGER NOT NULL DEFAULT 1,
      role          TEXT    NOT NULL DEFAULT 'readonly' CHECK (role IN ('admin','readonly'))
    );
  `)

  // 兼容旧库：早期按「账号存储」票建的 users 表没有 token_version。
  // 补列带 DEFAULT 1，既有账号全部落到 1 —— 与新建号一致，**不会因迁移把所有人踢下线**。
  // 并发首启时另一个进程可能刚补完这一列：那一种错被容忍（`isDuplicateColumnError`），
  // 因为迁移的目标状态已经达成 —— 见 `store.ts` 那段的实测记录。
  const cols = db.prepare(`PRAGMA table_info(users)`).all() as Array<{ name: string }>
  if (!cols.some((c) => c.name === 'token_version')) {
    try {
      db.exec(`ALTER TABLE users ADD COLUMN token_version INTEGER NOT NULL DEFAULT 1`)
      console.log('[users] 已为 users 表补上 token_version 列（既有账号落 1，不会掉线）')
    } catch (err) {
      if (!isDuplicateColumnError(err)) throw err
    }
  }

  /*
   * 角色列（`docs/roles-decision.md` §2）。`CHECK` 让非法值被**库**挡住，
   * 而不是靠每个写路径各自记得校验。
   *
   * ⚠ 补列时那句 `UPDATE ... SET role='admin'` 是**无条件全表**的，而且只能在这里跑：
   * 能执行它的唯一时刻就是「role 列刚被补上」的那一刻 —— 此刻库里的每一行都必然是列诞生之前
   * 就存在的账号。**已知后果**（§2 写在明面上）：停用中的既有账号也会成为管理员；
   * 它登不进来所以眼下无害，但日后 `--enable` 会让它**直接是管理员**。这是「既有账号 = 当时信任的人」
   * 的自然外延，接受；要改成「只升启用中的」就是给这条 UPDATE 加个 WHERE，代价一行。
   */
  if (!cols.some((c) => c.name === 'role')) {
    // ⚠ 只有**本进程真的补上这一列**时才跑那次全表 UPDATE：并发首启时另一个进程可能刚补完
    // 并已经提过权，这时再无条件 `UPDATE ... = 'admin'` 会把它之后新建的只读账号一起提权。
    // 「补列」与「一次性提权」必须是同一件事的两个半边 —— `added` 就是这条绑定。
    let added = false
    try {
      db.exec(`ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'readonly' CHECK (role IN ('admin','readonly'))`)
      added = true
    } catch (err) {
      if (!isDuplicateColumnError(err)) throw err
    }
    if (added) {
      db.exec(`UPDATE users SET role = 'admin'`)
      console.log('[users] 已补上 role 列，并把既有账号一次性升为 admin')
    } else {
      console.log('[users] role 列已由另一个进程补上（并发首启），跳过一次性提权')
    }
  }
  // 会话记录表：**入口留在本函数**（它已经是「账号域的迁移入口」——`token_version` 也在这里补），
  // 而 DDL 留在 `sessions-store.ts` 跟会话代码作伴：入口在一处、知识在一处。
  initSessionsTable()

  initialized = true
}

function db(): ReturnType<typeof initStore> {
  if (!initialized) initUsers()
  return initStore()
}

/** 按用户名查（大小写不敏感）。查不到返回 undefined，不抛。 */
export function findByUsername(username: string): UserRow | undefined {
  return db()
    .prepare(`SELECT * FROM users WHERE username = ?`)
    .get(normalizeUsername(username)) as UserRow | undefined
}

/** 按主键查。会话 cookie 里存的就是 id（用户名可改，id 不可改）。 */
export function findById(id: number): UserRow | undefined {
  return db().prepare(`SELECT * FROM users WHERE id = ?`).get(id) as UserRow | undefined
}

/** 账号总数。零账号时服务仍允许启动（拒绝启动会进 `restart: unless-stopped` 的重启循环）。 */
export function countUsers(): number {
  const row = db().prepare(`SELECT COUNT(*) AS n FROM users`).get() as { n: number }
  return row.n
}

export interface CreateUserOptions {
  enabled?: boolean
  /**
   * 角色。**默认 `readonly`（最小权限）** —— 要给人管理权，是一次**显式**的提权动作。
   * 唯一的例外是「零账号首启」（`ensureFirstUserFromEnv`）：那时必须显式传 `admin`，
   * 否则全新部署开箱就锁死管理台。例外写在调用点上，不靠 `DEFAULT` 蒙出来（`docs/roles-decision.md` §4）。
   */
  role?: Role
}

/** 建号。用户名重复时抛出可读错误（底层是 `SQLITE_CONSTRAINT_UNIQUE`）。 */
export function createUser(username: string, password: string, opts: CreateUserOptions = {}): UserRow {
  const name = normalizeUsername(username)
  if (!name) throw new Error('用户名不能为空')
  assertPassword(password)

  try {
    const info = db()
      .prepare(
        `INSERT INTO users (username, password_hash, created_at, enabled, token_version, role)
         VALUES (?, ?, ?, ?, 1, ?)`,
      )
      .run(
        name,
        bcrypt.hashSync(password, BCRYPT_COST),
        Date.now(),
        opts.enabled === false ? 0 : 1,
        opts.role ?? 'readonly',
      )
    return findById(Number(info.lastInsertRowid))!
  } catch (err) {
    if (String((err as Error).message).includes('UNIQUE')) {
      throw new Error(`用户名已存在：${name}`)
    }
    throw err
  }
}

/**
 * 校验口令。
 *
 * 两条安全要求（`docs/accounts-decision.md` §4）：
 * 1. 用户不存在时**也要跑一次假哈希比对**，否则响应时间会泄漏账号是否存在；
 * 2. 失败**不区分**「用户不存在」「口令错」「账号已停用」——调用方统一回同一句提示。
 */
export function verifyPassword(username: string, password: string): UserRow | null {
  const user = findByUsername(username)
  if (!user) {
    // 只为消耗与真实比对相当的时间，结果丢弃。
    bcrypt.compareSync(password, getDummyHash())
    return null
  }
  if (!bcrypt.compareSync(password, user.password_hash)) return null
  // 停用的账号即使口令正确也不放行；对调用方与「口令错」不可区分。
  if (user.enabled !== 1) return null
  return user
}

/**
 * 改口令，并**递增 `token_version`** —— 这是让「改密立刻踢掉其他设备」生效的关键。
 *
 * 调用方（闸门）在成功后要**用新版本给当前响应重新签发 cookie**，
 * 否则用户会把自己也踢下线。见 `docs/session-decision.md` §8.3。
 */
/**
 * 改口令。
 *
 * **递增 `token_version` 与「级联吊销该账号全部会话」放进同一事务**（`docs/session-revoke-decision.md` §6.4 的双保险）：
 * 前者让旧 cookie 在签名/代次那一层失配，后者让它在库里也立刻作废。两条一起，
 * 半途失败不会留下「口令换了但旧 cookie 还能用」的窗口。
 */
export function setPassword(id: number, password: string): void {
  assertPassword(password)
  const conn = db()
  conn.transaction(() => {
    conn
      .prepare(`UPDATE users SET password_hash = ?, updated_at = ?, token_version = token_version + 1 WHERE id = ?`)
      .run(bcrypt.hashSync(password, BCRYPT_COST), Date.now(), id)
    revokeUserSessions(id)
  })()
}

export type RoleChangeDecision = { ok: true } | { ok: false; reason: string }

/**
 * 启用中的管理员数 —— 守卫**只数这个**。
 * 停用的管理员登不进来，若把他算作「还有管理员」，守卫就等于形同虚设：一处自锁会被伪装成一处安全。
 */
export function countEnabledAdmins(): number {
  const row = db()
    .prepare(`SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND enabled = 1`)
    .get() as { n: number }
  return row.n
}

/**
 * 角色 / 启停的守卫 —— **一个函数，网页写路径与 CLI 共用**。
 * 两条通道规则不一致时，CLI 就成了绕过守卫的后门（`docs/roles-decision.md` §3）。
 *
 * 判据：
 * - **提权与启用永不设卡** —— 它们是恢复通道，锁死了总得有出路；
 * - 只有「会减少启用中的管理员」的改动才检查：降级一个 `admin`、或停用一个启用中的 `admin`；
 * - 检查两条：**不能改自己**（自锁里最容易误触的一条，直接不给这个按钮）、**不能减到零**。
 */
export function checkRoleChange(
  targetId: number,
  next: { role?: Role; enabled?: boolean },
  actorId?: number,
): RoleChangeDecision {
  const target = findById(targetId)
  if (!target) return { ok: false, reason: '账号不存在' }

  const demoting = next.role === 'readonly' && target.role === 'admin'
  const disabling = next.enabled === false && target.role === 'admin' && target.enabled === 1
  if (!demoting && !disabling) return { ok: true }

  if (actorId !== undefined && actorId === targetId) {
    return { ok: false, reason: '不能改自己的角色，也不能停用自己' }
  }
  if (countEnabledAdmins() <= 1) {
    return { ok: false, reason: '这是最后一个启用中的管理员：降级或停用会让管理台没人能进' }
  }
  return { ok: true }
}

/** 改角色。**守卫在函数内部**，不靠调用方记得查 —— 这样它绕不过去。 */
export function setRole(id: number, role: Role, actorId?: number): void {
  const decision = checkRoleChange(id, { role }, actorId)
  if (!decision.ok) throw new Error(decision.reason)
  db().prepare(`UPDATE users SET role = ?, updated_at = ? WHERE id = ?`).run(role, Date.now(), id)
}

/**
 * 启停账号。`enabled` 每请求都被闸门查，所以它立刻生效，**不需要**动 `token_version`
 * （要立刻踢人是**改口令**的动作，不是改启停的动作）。
 */
export function setEnabled(id: number, enabled: boolean, actorId?: number): void {
  const decision = checkRoleChange(id, { enabled }, actorId)
  if (!decision.ok) throw new Error(decision.reason)
  db().prepare(`UPDATE users SET enabled = ?, updated_at = ? WHERE id = ?`).run(enabled ? 1 : 0, Date.now(), id)
}

/**
 * 轮换凭据代次：递增后该账号**全部已签发 cookie 立刻失配**。
 * 这就是「真吊销」通道（签名 cookie 无状态，登出只能清本机 cookie）。
 */
export function bumpTokenVersion(id: number): number {
  db().prepare(`UPDATE users SET token_version = token_version + 1 WHERE id = ?`).run(id)
  const row = db().prepare(`SELECT token_version FROM users WHERE id = ?`).get(id) as
    | { token_version: number }
    | undefined
  return row?.token_version ?? 0
}

/**
 * 闸门每请求调用：拿到「这个 uid 现在还算不算已登录」所需的最小状态。
 * 查不到（用户被删）返回 null——与「停用」同样按未登录处理。
 */
export function getAuthState(id: number): AuthState | null {
  const row = db()
    .prepare(`SELECT id, enabled, token_version, role FROM users WHERE id = ?`)
    .get(id) as { id: number; enabled: number; token_version: number; role: Role } | undefined
  if (!row) return null
  return { id: row.id, enabled: row.enabled, tokenVersion: row.token_version, role: row.role }
}

/** 列出全部账号（CLI 用），不含口令哈希。 */
export function listUsers(): Array<Omit<UserRow, 'password_hash'>> {
  return db()
    .prepare(
      `SELECT id, username, created_at, enabled, updated_at, token_version, role
         FROM users ORDER BY username ASC`,
    )
    .all() as Array<Omit<UserRow, 'password_hash'>>
}

/**
 * 零账号时用环境变量建首个账号。
 *
 * ⚠ **只在表为空时生效**：一旦有任何账号，这两个变量被**完全忽略**。
 * 否则一个残留的环境变量就是一个隐藏的后门账号——环境变量会长期留在
 * `docker-compose.yml` 与 shell 历史里，是最容易被忘记的泄漏面。
 */
export function ensureFirstUserFromEnv(username: string, password: string): boolean {
  if (countUsers() > 0) return false
  if (!username || !password) return false
  // ⚠ **必须显式传 `admin`**，不能靠默认值：表里一个账号都没有时，若首个账号是只读，
  // 全新部署就**开箱锁死**管理台（`docs/roles-decision.md` §4）。这里不会变成后门管理员 ——
  // 上一行的 `countUsers() > 0` 已经保证「表非空时环境变量被完全忽略」。
  createUser(username, password, { role: 'admin' })
  console.warn(
    `[users] 已用环境变量创建首个账号「${normalizeUsername(username)}」（角色 admin），请立即用网页改密或 CLI 重置口令。`,
  )
  return true
}
