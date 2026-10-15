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

export const SESSION_COOKIE_NAME = 'session'

/** cookie 默认存活 7 天。与 `exp` 必须一致，否则会出现「浏览器留着但服务端判过期」。 */
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000

/** 载荷。注意只有这三个字段——不放 username / role，见 `docs/session-decision.md` §5。 */
export interface SessionPayload {
  /** `users.id`。存 id 而不是 username：用户名可改，id 不可改。 */
  uid: number
  /** 绝对过期时刻（epoch ms）。签发时写死，不滑动续期。 */
  exp: number
  /** 凭据代次，与 `users.token_version` 比对。失配即视为未登录。 */
  pv: number
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

/** 便捷封装：按当前时间 + TTL 造一个载荷并签发。 */
export function issueSession(secret: string, uid: number, tokenVersion: number, ttlMs = SESSION_TTL_MS): string {
  return signSession(secret, { uid, exp: Date.now() + ttlMs, pv: tokenVersion })
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
