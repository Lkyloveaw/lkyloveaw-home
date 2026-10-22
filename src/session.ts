/**
 * 会话：自签的 HMAC-SHA256 cookie。
 *
 * 为什么自己签而不引 `@fastify/cookie`：实测手写 `Cookie` 头解析 10 行够用（7 组边界输入全过），
 * 而签名本身 Node 内置 `crypto` 就能做。本仓库的既有取舍是尽量不引新依赖。
 *
 * ⚠ 载荷是**签名的、不是加密的**：任何人拿到 cookie 都能 base64url 解出明文。
 * 签名只保护**完整性**（改不了），不保护**机密性**（看得见）。所以载荷里不放用户名等敏感值。
 *
 * 本模块**不依赖 Fastify**：`verifySession()` 是纯函数，判定表可以不过 HTTP 直接断言。
 * 见 `docs/session-decision.md`。
 */
import crypto from 'node:crypto'
/**
 * 角色类型从 `users.ts` 借来 —— 用 `import type` 是**刻意的**：它编译后完全消失，
 * 所以本模块在运行期**仍然只依赖 `node:crypto`**（纯函数、不过 HTTP、不碰库），
 * 那正是「判定表可以不过 HTTP 直接断言」的前提。
 */
import type { Role } from './users.js'

export const SESSION_COOKIE_NAME = 'session'

/** cookie 默认存活 7 天。与 `exp` 必须一致，否则会出现「浏览器留着但服务端判过期」。 */
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000

/**
 * 载荷。**仍然不放 username / role**（见 `docs/session-decision.md` §5）—— 角色在库里查，不进 cookie。
 *
 * `sid` 是 #37 加的（`docs/session-revoke-decision.md` §2）：它指向 `sessions` 表的一行，
 * 让「登出」能变成**真吊销**而不只是清本机 cookie。
 */
export interface SessionPayload {
  /** `users.id`。存 id 而不是 username：用户名可改，id 不可改。 */
  uid: number
  /** 绝对过期时刻（epoch ms）。签发时写死，不滑动续期。 */
  exp: number
  /** 凭据代次快照，与 `sessions.pv` 同值；判定时比的是「`sessions.pv` vs 当前 `users.token_version`」。 */
  pv: number
  /** 会话记录的主键。**没有它的 token 一律 `malformed`**（那正是升级前的老 cookie）。 */
  sid: string
}

/** 校验结果。闸门只需判断 `=== 'ok'`，其余值仅用于日志与排查。 */
export type SessionFailure =
  | 'no-token'
  | 'malformed'
  | 'bad-signature'
  | 'expired'
  | 'unknown-user'
  | 'disabled'
  | 'stale-version'

export type SessionCheck = 'ok' | SessionFailure

function b64url(buf: Buffer): string {
  return buf.toString('base64url')
}

function sign(secret: string, payloadB64: string): string {
  return b64url(crypto.createHmac('sha256', secret).update(payloadB64).digest())
}

/**
 * 签发 token：`base64url(JSON payload)` + `.` + `HMAC-SHA256(payload)`。
 * 分隔符用**最后一个** `.` 切分（见 `verifySession`），所以载荷里出现 `.` 也不会错位。
 */
export function signSession(secret: string, payload: SessionPayload): string {
  const pb = b64url(Buffer.from(JSON.stringify(payload)))
  return `${pb}.${sign(secret, pb)}`
}

/**
 * 便捷封装：按当前时间 + TTL 造一个载荷并签发。
 *
 * ⚠ **`sid` 由调用方先建好**（`sessions-store.createSession()`）再传进来 ——
 * 签发与建记录不在同一个事务里是有意的：cookie 是**无状态**的，屏幕上那一串必须先于库里的行成立，
 * 反过来的顺序会在「建了行但签发失败」时留下一条谁也认领不了的会话。
 */
export function issueSession(
  secret: string,
  uid: number,
  tokenVersion: number,
  sid: string,
  ttlMs = SESSION_TTL_MS,
): string {
  return signSession(secret, { uid, exp: Date.now() + ttlMs, pv: tokenVersion, sid })
}

/** 校验所需的最小用户状态。与 `users.getAuthState()` 的返回形状一致。 */
export interface SessionUser {
  id: number
  enabled: number
  tokenVersion: number
}

/**
 * 校验 token。**不做任何 I/O**，用户状态由调用方查好后传进来。
 *
 * ⚠ **闸门已经不再调用它**（#55 起改走 `decideSession` + 库里的会话行）。
 * 保留它有两个理由，都不是「留着好看」：
 * 1. `docs/session-decision.md` §4 那张 **14 行判定表**仍在 `scripts/unit-check.mjs` 里跑着，
 *    删掉它等于把那份回归面一起删掉（`docs/session-revoke-decision.md` §3 明确要求「回归面不缩小」）；
 * 2. 它守着**签名与载荷形状**这一层，与 `decideSession` 是同一套判断的两种输入形态。
 * 要不要把两者合一，是收口票的事，不是这张票顺手做的。
 *
 * 判定顺序是有意的：
 * 1. **先比签名长度再 `timingSafeEqual`** —— 实测长度不等会抛
 *    `ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH`，直接用会把畸形 cookie 打成 500；
 * 2. **载荷形状必须显式校验** —— `exp` 若不是数字，`now < NaN` 恒为 `false`，
 *    会**看起来像「永久有效」**，是个静默的安全洞；
 * 3. 边界取 `now < exp`，即 `now === exp` 判过期。
 */
export function verifySession(
  secret: string,
  token: string | undefined | null,
  user: SessionUser | null | undefined,
  now: number = Date.now(),
): SessionCheck {
  if (!token || typeof token !== 'string') return 'no-token'

  const dot = token.lastIndexOf('.')
  if (dot <= 0 || dot === token.length - 1) return 'malformed'

  const pb = token.slice(0, dot)
  const sig = token.slice(dot + 1)
  const expected = sign(secret, pb)

  // ⚠ 长度先行：timingSafeEqual 对不等长输入会抛异常。
  const a = Buffer.from(sig)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return 'bad-signature'
  if (!crypto.timingSafeEqual(a, b)) return 'bad-signature'

  let payload: unknown
  try {
    payload = JSON.parse(Buffer.from(pb, 'base64url').toString('utf8'))
  } catch {
    return 'malformed'
  }
  if (!payload || typeof payload !== 'object') return 'malformed'

  const p = payload as Partial<SessionPayload>
  // 形状校验不能省：见上面第 2 条。
  if (typeof p.uid !== 'number' || !Number.isInteger(p.uid)) return 'malformed'
  if (typeof p.exp !== 'number' || !Number.isFinite(p.exp)) return 'malformed'
  if (typeof p.pv !== 'number' || !Number.isInteger(p.pv)) return 'malformed'

  if (!(now < p.exp)) return 'expired'

  if (!user || user.id !== p.uid) return 'unknown-user'
  if (user.enabled !== 1) return 'disabled'
  if (user.tokenVersion !== p.pv) return 'stale-version'

  return 'ok'
}

/**
 * 解析 `Cookie` 头。实测覆盖：空段、无等号、重复同名（取后者）、空值、编码等号、引号值。
 *
 * **不做 URL 解码**：base64url 里没有 `%`，解码反而会把合法值弄坏。
 * 无等号或键为空的片段直接丢弃；同名后者覆盖。
 */
export function parseCookies(header: string | undefined | null): Record<string, string> {
  const out: Record<string, string> = {}
  if (!header) return out
  for (const part of header.split(';')) {
    const i = part.indexOf('=')
    if (i < 0) continue
    const key = part.slice(0, i).trim()
    if (!key) continue
    out[key] = part.slice(i + 1).trim()
  }
  return out
}

/** 从 `Cookie` 头里取会话 token。 */
export function readSessionCookie(header: string | undefined | null): string | undefined {
  return parseCookies(header)[SESSION_COOKIE_NAME]
}

export interface CookieOptions {
  /**
   * 是否加 `Secure`。**默认关** —— HTTPS 是后续需求，且站点还是 HTTP 时开着它，
   * 浏览器不会存 cookie，表现为「输对密码又跳回登录页」，现象极具误导性。
   */
  secure?: boolean
  ttlMs?: number
}

/** 下发会话 cookie。`Max-Age` 与载荷 `exp` 必须用同一个 `ttlMs`。 */
export function sessionCookieHeader(token: string, opts: CookieOptions = {}): string {
  const parts = [
    `${SESSION_COOKIE_NAME}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.floor((opts.ttlMs ?? SESSION_TTL_MS) / 1000)}`,
  ]
  if (opts.secure) parts.push('Secure')
  return parts.join('; ')
}

/** 清除会话 cookie（登出）。⚠ 这**不是吊销**：只影响当前浏览器，已泄漏的 token 在 `exp` 前仍有效。 */
export function clearCookieHeader(opts: CookieOptions = {}): string {
  const parts = [`${SESSION_COOKIE_NAME}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0']
  if (opts.secure) parts.push('Secure')
  return parts.join('; ')
}

/**
 * 判断一个 `next` 回跳值是否安全（只接受站内相对路径）。
 *
 * 实测的逃逸面：`//evil.com`、`/\evil.com`、`\/evil.com`、`////evil.com`、`https://evil.com` 都会逃到站外。
 * 另外带 `\r\n` 的值塞进 `Location` 会被 Node 抛 `ERR_INVALID_CHAR` 变成 500，
 * 所以显式拒绝控制字符，让它优雅回退而不是 500。
 *
 * `isKnownPath` 由调用方注入「已知路由」判定，避免本模块耦合路由表。
 */
export function isSafeNextPath(next: unknown, isKnownPath: (p: string) => boolean): boolean {
  if (typeof next !== 'string' || !next) return false
  // 控制字符（含 CR/LF）直接拒绝
  if (/[\u0000-\u001f\u007f]/.test(next)) return false
  // 必须以「单个 /」开头；第二个字符不能是 / 或 \（协议相对与反斜杠变体）
  if (next[0] !== '/') return false
  if (next[1] === '/' || next[1] === '\\') return false
  if (next.includes('\\')) return false
  // 解析后 origin 不变（防御编码变体）
  let parsed: URL
  try {
    parsed = new URL(next, 'http://placeholder.invalid')
  } catch {
    return false
  }
  if (parsed.origin !== 'http://placeholder.invalid') return false
  // 落点必须在已知路由内，否则会把用户送到 404
  return isKnownPath(parsed.pathname)
}

// ── 会话判定（#37）：闸门每请求的那一次判决 ──────────────────────

/** 一条会话记录（`sessions` 表的一行）。 */
export interface SessionRecord {
  sid: string
  uid: number
  /** 签发时的凭据代次**快照** —— 判定时比的是它与当前 `users.token_version`。 */
  pv: number
  expiresAt: number
  revokedAt: number | null
}

/**
 * 判定所需的最小状态：闸门那**一次** `LEFT JOIN` 查询的全部结果。
 * `user` 为 `null` = 会话行在、账号行不在 —— 它与「会话行不存在」是两件事，排查方向也不同。
 *
 * `role` 并进**同一次**查询：`docs/roles-decision.md` §2 定下「取角色的成本是零，不新增查询次数」。
 * **角色不进 cookie**（库是唯一真源），所以降级/提权在下一个请求就生效，不需要踢会话。
 */
export interface SessionState {
  session: SessionRecord
  user: { id: number; username: string; enabled: number; tokenVersion: number; role: Role } | null
}

/** 判决值。闸门只判断 `=== 'ok'`，其余全部进日志。 */
export type SessionVerdict =
  | 'ok'
  | 'no-token'
  | 'malformed'
  | 'bad-signature'
  | 'expired'
  | 'session-unknown'
  | 'revoked'
  | 'unknown-user'
  | 'disabled'
  | 'stale-version'

/**
 * 取出载荷里那个 `sid`，**不验签名** —— 供排查与日志用。
 * ⚠ 所以**绝不能拿它的结果去授权**：授权只走 `decideSession()`。
 */
export function decodeSid(token: string | undefined | null): string | undefined {
  if (!token) return undefined
  const dot = token.lastIndexOf('.')
  if (dot <= 0) return undefined
  try {
    const payload = JSON.parse(Buffer.from(token.slice(0, dot), 'base64url').toString('utf8')) as unknown
    if (!payload || typeof payload !== 'object') return undefined
    const sid = (payload as { sid?: unknown }).sid
    return typeof sid === 'string' && sid ? sid : undefined
  } catch {
    return undefined
  }
}

/**
 * 判定一次请求。**纯函数、不做任何 I/O** —— `state` 由调用方查好后传进来。
 *
 * 判定顺序是**有意**的（`docs/session-revoke-decision.md` §5 的注解）：
 * 1. 无 token → 不查库；
 * 2. 形状（`.` 的位置）→ 不查库；
 * 3. 签名 —— **先比长度再 `timingSafeEqual`**：长度不等它会抛，直接用就把畸形 cookie 打成 500；
 * 4. 载荷形状 —— `exp` 缺失或非数字会让 `now < exp` 恒为 `false`（看起来像「永久有效」，**是个静默的安全洞**）；
 *    `sid` 缺失或为空若不显式拒绝，会把「老 cookie / 手改载荷」与「记录被清理」混成一类，日志里再难分辨；
 * 5. 载荷 `exp` → 不查库就挡掉过期 cookie；
 * 6. 会话行 —— **先看显式吊销，再看记录过期**（「我把它踢了」比「它到期了」更值得进日志）；
 * 7. 账号行 → `unknown-user` / `disabled` / `stale-version`。
 *
 * ⚠ `now` 可注入：判定表里有 `now === exp` 与 `now === exp - 1` 这种**边界行**，
 * 用 `Date.now()` 直接写的函数没法稳定测那一毫秒。
 */
export function decideSession(
  secret: string,
  token: string | undefined | null,
  state: SessionState | null | undefined,
  now: number = Date.now(),
): SessionVerdict {
  if (!token) return 'no-token'

  const dot = token.lastIndexOf('.')
  if (dot <= 0 || dot === token.length - 1) return 'malformed'
  const pb = token.slice(0, dot)
  const sig = token.slice(dot + 1)

  const expected = sign(secret, pb)
  const a = Buffer.from(sig)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return 'bad-signature'
  if (!crypto.timingSafeEqual(a, b)) return 'bad-signature'

  let payload: unknown
  try {
    payload = JSON.parse(Buffer.from(pb, 'base64url').toString('utf8'))
  } catch {
    return 'malformed'
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return 'malformed'

  const p = payload as Partial<SessionPayload>
  if (typeof p.uid !== 'number' || !Number.isFinite(p.uid)) return 'malformed'
  if (typeof p.pv !== 'number' || !Number.isFinite(p.pv)) return 'malformed'
  if (typeof p.exp !== 'number' || !Number.isFinite(p.exp)) return 'malformed'
  if (typeof p.sid !== 'string' || !p.sid) return 'malformed'

  // 边界取 now < exp：now === exp 判过期（与 verifySession 同一条）。
  if (!(now < p.exp)) return 'expired'

  if (!state) return 'session-unknown'
  const s = state.session
  if (s.revokedAt !== null) return 'revoked'
  if (s.expiresAt <= now) return 'expired'

  const u = state.user
  if (!u) return 'unknown-user'
  if (u.enabled !== 1) return 'disabled'
  if (u.tokenVersion !== s.pv) return 'stale-version'

  return 'ok'
}
