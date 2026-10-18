/**
 * 闸门：把「谁在问、他登录了吗、该回什么」集中在一处。
 *
 * 为什么单独一个模块而不是全塞进 `server.ts`：判定逻辑（白名单、分流、next 校验）
 * 与路由注册是两件事，混在一起会让闸门既难读也难测。
 * 这里只依赖 `users` / `session` / `config`，不 import Fastify——
 * 于是 `decideRequest()` 可以当纯函数直接断言。
 *
 * 判定表见 `docs/login-gate-decision-table.md`。
 */
import type { FastifyReply, FastifyRequest } from 'fastify'
import { config } from './config.js'
import type { Role } from './users.js'
import { findSessionState } from './sessions-store.js'
import {
  clearCookieHeader,
  decideSession,
  decodeSid,
  isSafeNextPath,
  readSessionCookie,
  type SessionState,
} from './session.js'

/**
 * 匿名白名单：**精确匹配**，不是前缀匹配。
 *
 * 为什么静态资源也要显式列出：全局 `onRequest` 钩子**会**拦到 `@fastify/static`
 * 的资源，且与注册顺序无关（实测）。不在白名单里，登录页自己就拿不到 `/style.css`。
 */
export const PUBLIC_PATHS: ReadonlySet<string> = new Set([
  '/login',
  '/healthz',
  '/style.css',
  '/status.js',
  // ⚠ 由「面板」票交付的几何核心。此刻文件可能还不存在——先放行一个不存在的路径无害，
  // 漏了它则面板合入后未登录时拿不到该文件（`chart-redraw-decision.md` §6 点名的联动点）。
  '/chart-path.js',
  '/favicon.ico',
])

/** 已知页面路由：`next` 的落点必须在这里面，否则会把用户送去 404。 */
export const KNOWN_PAGES: ReadonlySet<string> = new Set([
  '/',
  '/posts',
  '/status',
  '/about',
  // 管理台（#39）。它**不在** PUBLIC_PATHS 里 —— `/admin*` 本来就该受闸门保护，
  // 这里登记只是为了 `next` 校验能把它当成一个「登录后可以回跳的站内地址」。
  '/admin',
])

/** 已知路由判定，供 `next` 校验使用（前缀匹配 `:slug` / `:tag` 这类动态段）。 */
export function isKnownPath(pathname: string): boolean {
  if (KNOWN_PAGES.has(pathname)) return true
  if (pathname.startsWith('/posts/')) return true
  if (pathname.startsWith('/tags/')) return true
  return false
}

export interface RequestDecision {
  /** 是否放行（已登录 or 在白名单里）。 */
  allow: boolean
  /** 未放行时的响应形态。 */
  deny?: 'redirect' | 'unauthorized'
  /** 放行时的当前用户 id（用于渲染「你是谁」与改密）。 */
  userId?: number
  /**
   * 放行时的角色。它来自闸门**那一次**查询，**不进 cookie**（`docs/roles-decision.md` §2）——
   * 所以降级/提权在下一个请求就生效，不需要踢会话。
   */
  role?: Role
}

/**
 * 客户端要的是 HTML 还是 JSON。
 * **看请求头，不看路径前缀**——`/api/` 前缀是个巧合，不是契约。
 */
function wantsJson(req: FastifyRequest): boolean {
  const accept = String(req.headers.accept ?? '')
  if (accept.includes('application/json')) return true
  // 明确只接受 HTML（浏览器导航）时按页面处理
  if (accept.includes('text/html')) return false
  // 没声明 Accept（curl 默认是 */*）时，按路径前缀兜底
  return req.url.startsWith('/api/')
}

/**
 * 判定一个请求该不该放行。
 *
 * 流程（`docs/session-revoke-decision.md` §4）：
 * 1. 白名单命中 → 放行（精确匹配，不动）；
 * 2. 解 cookie → 无 token 即拒绝（**不查库**）；
 * 3. 取载荷里的 `sid`；取不到（含**升级前的老 cookie**）即拒绝，**不查库**；
 * 4. **一次** `sessions ⋈ users` 查询拿判定所需的全部状态；
 * 5. 纯函数 `decideSession()` 判定（判定表见 §5）；
 * 6. 非 `ok` → 按页面/API 分流拒绝，并把**判决值**写进日志（排查「为什么我掉线了」时第一个要看的东西）。
 *
 * 关键行为（`docs/session-decision.md` §7.6 沿用）：**查库失败 = 未登录，但不 fail-open，也不清 cookie**。
 * DB 一挂就整站无鉴权，与 Destination 直接冲突；而清 cookie 会把一次抖动升级成一次登出
 * —— 用户的会话其实还是有效的。
 */
export function decideRequest(req: FastifyRequest): RequestDecision {
  const pathname = req.url.split('?')[0] ?? req.url
  const denyShape = (): RequestDecision => ({
    allow: false,
    deny: wantsJson(req) ? 'unauthorized' : 'redirect',
  })

  // 白名单：精确匹配
  if (PUBLIC_PATHS.has(pathname)) return { allow: true }

  const token = readSessionCookie(req.headers.cookie)
  if (!token) return denyShape()

  // ⚠ 这一步**不验签**（`decodeSid` 的契约），只为拿到查库用的键。
  // 取不到就说明载荷畸形 —— 这正是老 cookie 走的路，它们没有 `sid`。
  const sid = decodeSid(token)
  if (!sid) {
    console.warn('[auth] 载荷里没有 sid（升级前的老 cookie，或手改），按未登录处理')
    return denyShape()
  }

  let state: SessionState | null
  try {
    state = findSessionState(sid)
  } catch (err) {
    console.error('[auth] 查询会话状态失败，按未登录处理：', (err as Error).message)
    return denyShape()
  }

  const verdict = decideSession(config.sessionSecret, token, state, Date.now())
  if (verdict !== 'ok') {
    console.warn(`[auth] 会话判决：${verdict}`)
    return denyShape()
  }
  // 判定表的第 17 / 21 行保证 `ok` 蕴含两者都在；这里只是让类型收窄，真走到就是 bug。
  if (!state || !state.user) {
    console.error('[auth] 判决为 ok 但状态缺失 —— 不该发生')
    return denyShape()
  }

  return { allow: true, userId: state.session.uid, role: state.user.role }
}

/** 从 token 里取出 uid（不校验签名，仅用于查库；签名由 verifySession 负责）。 */
/**
 * 资格守卫：这个决策够不够格做**管理**动作（`docs/write-path-auth-decision.md` §5.1）。
 *
 * 它只回答「**够不够格**」这一个问题 —— **对象级规则**（不能改自己、最后管理员）
 * 由 `users.ts` 的守卫回答（`docs/roles-decision.md` §3）。两处分开是因为它们失败的理由不同：
 * 「你不是管理员」和「你不能把最后一个管理员降级」要给用户看不同的话。
 *
 * 只读 → **403，不是 404**（`docs/admin-console-ia-decision.md` §3）：用户该知道这是权限问题，
 * 而不是地址敲错了。
 */
export function requireAdmin(decision: RequestDecision): boolean {
  return decision.allow && decision.role === 'admin'
}

/**
 * 处理一个未放行的请求。
 *
 * ⚠ 这里**不下发清 cookie 的头**：查询失败可能只是 DB 抖动，
 * 用户的会话其实有效。清了 cookie 等于把一次抖动升级成一次登出。
 */
export function deny(reply: FastifyReply, req: FastifyRequest, deny: 'redirect' | 'unauthorized'): FastifyReply {
  if (deny === 'unauthorized') {
    return reply.code(401).send({ error: 'unauthorized' })
  }
  const raw = req.url
  const next = isSafeNextPath(raw, isKnownPath) ? raw : '/'
  return reply.redirect(`/login?next=${encodeURIComponent(next)}`, 302)
}

/** 登出用的清 cookie 响应头。 */
export function logoutHeader(secure: boolean): string {
  return clearCookieHeader({ secure })
}
