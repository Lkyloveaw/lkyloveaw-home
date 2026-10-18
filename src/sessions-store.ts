/**
 * 会话记录：`sessions` 表的**纯库函数**（不碰 HTTP、不做判定）。
 *
 * 为什么单独一个文件（而不是塞进 `store.ts` 或 `users.ts`）：
 * `store.ts` 是**探测历史**、`users.ts` 是**账号**，会话记录是第三件事。
 * 判定（`session.ts` 的 `decideSession`）与存储（本文件）都是纯的 —— 两者都可以**不过 HTTP 直接断言**，
 * 这正是 `docs/session-revoke-decision.md` §9.1 把它单列的理由（沿用 `verifySession` 当年抽出 `session.ts` 的思路）。
 *
 * 建表入口是 `users.ts` 的 `initUsers()`（「账号域的迁移入口」，`token_version` / `role` 也在那里补），
 * 但 DDL 留在**本文件**里跟会话代码作伴 —— 入口在一处、知识在一处。
 */
import crypto from 'node:crypto'
import { initStore } from './store.js'
import type { SessionRecord, SessionState } from './session.js'
import type { Role } from './users.js'

/** 建表（幂等）。由 `initUsers()` 调用。旧库不需要补列 —— 这张表是全新的。 */
export function initSessionsTable(): void {
  initStore().exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      sid        TEXT    PRIMARY KEY,
      uid        INTEGER NOT NULL,
      pv         INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      revoked_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_uid ON sessions (uid);
  `)
}

/**
 * 建一条会话记录并返回 `sid`（进 cookie 载荷）。
 *
 * `sid` 用 32 字节随机数、**明文存主键**（不做哈希）：本仓库的当面威胁是「内网里有人拿到 cookie」
 * 或「要踢掉一台设备」，不是「攻击者已经能读你的 SQLite 文件」——真到那一步，
 * `password_hash`、目标 URL、历史库**全在同一个文件里**，把 `sid` 哈希掉属于挑一处上锁，
 * 代价是运维再也无法按 `sid` 删一行（`docs/session-revoke-decision.md` §1）。
 */
export function createSession(
  uid: number,
  pv: number,
  ttlMs: number,
  now: number = Date.now(),
): { sid: string; expiresAt: number } {
  const sid = crypto.randomBytes(32).toString('base64url')
  const expiresAt = now + ttlMs
  initStore()
    .prepare(
      `INSERT INTO sessions (sid, uid, pv, created_at, expires_at, revoked_at)
       VALUES (?, ?, ?, ?, ?, NULL)`,
    )
    .run(sid, uid, pv, now, expiresAt)
  return { sid, expiresAt }
}

/**
 * 闸门每请求的**那一次**查询：`sessions LEFT JOIN users`。
 *
 * **为什么 `LEFT JOIN` 而不是 `INNER JOIN`**：要能区分「会话行不存在」（→ `session-unknown`）与
 * 「会话行在、账号行没了」（→ `unknown-user`）—— 两者的排查方向完全不同（一个是清理/伪造，一个是删号/迁移）。
 * `INNER JOIN` 会把它们压成同一个结果。
 *
 * **为什么是一次查询**：`role` / `enabled` / `pv` 都在同一行里拿到，判定、显示、授权共享同一次读，
 * 不会出现「三处各查一次、彼此不一致」（`docs/roles-decision.md` §2 定下「不新增查询次数」）。
 */
export function findSessionState(sid: string): SessionState | null {
  const row = initStore()
    .prepare(
      `SELECT s.sid AS sid, s.uid AS uid, s.pv AS pv,
              s.expires_at AS expiresAt, s.revoked_at AS revokedAt,
              u.enabled AS enabled, u.token_version AS tokenVersion, u.role AS role
         FROM sessions s
         LEFT JOIN users u ON u.id = s.uid
        WHERE s.sid = ?`,
    )
    .get(sid) as
    | {
        sid: string
        uid: number
        pv: number
        expiresAt: number
        revokedAt: number | null
        enabled: number | null
        tokenVersion: number | null
        role: Role | null
      }
    | undefined

  if (!row) return null

  const session: SessionRecord = {
    sid: row.sid,
    uid: row.uid,
    pv: row.pv,
    expiresAt: row.expiresAt,
    revokedAt: row.revokedAt,
  }
  // `LEFT JOIN` 没配上时右侧全是 NULL —— 用它来判「账号行在不在」，而不是把 NULL 当 0。
  const user =
    row.tokenVersion === null || row.role === null
      ? null
      : { id: row.uid, enabled: row.enabled ?? 0, tokenVersion: row.tokenVersion, role: row.role }

  return { session, user }
}

/**
 * 吊销**一条**会话（登出）。
 * 返回 `changes`：重复吊销得到 **0**，这个数字是幂等性的证据，不是装饰。
 */
export function revokeSession(sid: string, now: number = Date.now()): number {
  return initStore()
    .prepare(`UPDATE sessions SET revoked_at = ? WHERE sid = ? AND revoked_at IS NULL`)
    .run(now, sid).changes
}

/** 吊销某个账号的**全部**会话（「登出全部设备」/ 改密级联 / CLI `--revoke-sessions`）。 */
export function revokeUserSessions(uid: number, now: number = Date.now()): number {
  return initStore()
    .prepare(`UPDATE sessions SET revoked_at = ? WHERE uid = ? AND revoked_at IS NULL`)
    .run(now, uid).changes
}

/**
 * 清理**已死**的行（过期的 + 已吊销的）——只删死行，活行一行不动。
 * 挂在已有的探测轮次上（`probe.ts`），与 checkpoint 并列，不新增定时器。
 */
export function sweepSessions(now: number = Date.now()): number {
  return initStore()
    .prepare(`DELETE FROM sessions WHERE expires_at <= ? OR revoked_at IS NOT NULL`)
    .run(now).changes
}
