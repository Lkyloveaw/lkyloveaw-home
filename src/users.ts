/**
 * 账号存储与口令校验。
 *
 * 为什么单独一个模块：会话（`src/session.ts`）与闸门（`src/server.ts`）都要问「这个 uid 还能不能用」，
 * 而 bcrypt 是唯一需要口令哈希的地方——把它关在这里，别处不需要知道 bcrypt 的存在。
 *
 * 本模块**不碰 HTTP**：所有函数都是纯库函数，可以不过 HTTP 直接断言。
 */
import bcrypt from 'bcryptjs'
import { initStore } from './store.js'

/**
 * bcrypt 代价因子。
 * 定为 12：实测本机约 260ms/次。内网个人站、账号以个位计、登录是低频动作，
 * 260ms 在人类感知上等同瞬时，而 cost 10 的 70ms 对离线爆破偏薄。见 `docs/accounts-decision.md` §1。
 */
export const BCRYPT_COST = 12

/** 口令最短长度。见 map Notes：「密码 bcrypt 哈希，最短 8 位」。 */
export const MIN_PASSWORD_LENGTH = 8

export interface UserRow {
  id: number
  username: string
  password_hash: string
  created_at: number
  enabled: number
  updated_at: number | null
  token_version: number
}

/** 闸门每请求只需要这三项——不要 SELECT *，多余字段是日后泄漏的种子。 */
export interface AuthState {
  id: number
  enabled: number
  tokenVersion: number
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
      token_version INTEGER NOT NULL DEFAULT 1
    );
  `)

  // 兼容旧库：早期按「账号存储」票建的 users 表没有 token_version。
  // 补列带 DEFAULT 1，既有账号全部落到 1 —— 与新建号一致，**不会因迁移把所有人踢下线**。
  const cols = db.prepare(`PRAGMA table_info(users)`).all() as Array<{ name: string }>
  if (!cols.some((c) => c.name === 'token_version')) {
    db.exec(`ALTER TABLE users ADD COLUMN token_version INTEGER NOT NULL DEFAULT 1`)
    console.log('[users] 已为 users 表补上 token_version 列（既有账号落 1，不会掉线）')
  }
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
}

/** 建号。用户名重复时抛出可读错误（底层是 `SQLITE_CONSTRAINT_UNIQUE`）。 */
export function createUser(username: string, password: string, opts: CreateUserOptions = {}): UserRow {
  const name = normalizeUsername(username)
  if (!name) throw new Error('用户名不能为空')
  assertPassword(password)

  try {
    const info = db()
      .prepare(
        `INSERT INTO users (username, password_hash, created_at, enabled, token_version)
         VALUES (?, ?, ?, ?, 1)`,
      )
      .run(name, bcrypt.hashSync(password, BCRYPT_COST), Date.now(), opts.enabled === false ? 0 : 1)
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
export function setPassword(id: number, password: string): void {
  assertPassword(password)
  db()
    .prepare(`UPDATE users SET password_hash = ?, updated_at = ?, token_version = token_version + 1 WHERE id = ?`)
    .run(bcrypt.hashSync(password, BCRYPT_COST), Date.now(), id)
}

/** 启停账号。`enabled` 每请求都被闸门查，所以它立刻生效，**不需要**动 token_version。 */
export function setEnabled(id: number, enabled: boolean): void {
  db()
    .prepare(`UPDATE users SET enabled = ?, updated_at = ? WHERE id = ?`)
    .run(enabled ? 1 : 0, Date.now(), id)
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
    .prepare(`SELECT id, enabled, token_version FROM users WHERE id = ?`)
    .get(id) as { id: number; enabled: number; token_version: number } | undefined
  if (!row) return null
  return { id: row.id, enabled: row.enabled, tokenVersion: row.token_version }
}

/** 列出全部账号（CLI 用），不含口令哈希。 */
export function listUsers(): Array<Omit<UserRow, 'password_hash'>> {
  return db()
    .prepare(
      `SELECT id, username, created_at, enabled, updated_at, token_version
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
  createUser(username, password)
  console.warn(
    `[users] 已用环境变量创建首个账号「${normalizeUsername(username)}」，请立即用网页改密或 CLI 重置口令。`,
  )
  return true
}
