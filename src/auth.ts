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
import { getAuthState } from './users.js'
import { clearCookieHeader, isSafeNextPath, readSessionCookie, verifySession } from './session.js'

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
 * 关键行为（`docs/session-decision.md` §7.6）：**查库失败 = 未登录，但不 fail-open**。
 * DB 一挂就整站无鉴权，与 Destination 直接冲突；宁可 302 到登录页。
 * 区别只体现在日志里，不影响对外行为。
 */
export function decideRequest(req: FastifyRequest): RequestDecision {
  const pathname = req.url.split('?')[0] ?? req.url

  // 白名单：精确匹配
  if (PUBLIC_PATHS.has(pathname)) return { allow: true }

  const token = readSessionCookie(req.headers.cookie)
  if (!token) return { allow: false, deny: wantsJson(req) ? 'unauthorized' : 'redirect' }

  // 先验签名拿到 uid，再查库比对 pv/enabled。
  // 两步分开是因为 verifySession 刻意不做 I/O（它是纯函数，便于断言）。
  let uid: number | undefined
  try {
    const payload = decodePayload(token)
    uid = payload
  } catch {
    uid = undefined
  }
  if (uid === undefined) return { allow: false, deny: wantsJson(req) ? 'unauthorized' : 'redirect' }

  let state
  try {
    state = getAuthState(uid)
  } catch (err) {
    // 查库失败：按未登录处理，显眼记日志。**不** fail-open。
    console.error('[auth] 查询账号状态失败，按未登录处理：', (err as Error).message)
    return { allow: false, deny: wantsJson(req) ? 'unauthorized' : 'redirect' }
  }

  const verdict = verifySession(config.sessionSecret, token, state)
  if (verdict !== 'ok') return { allow: false, deny: wantsJson(req) ? 'unauthorized' : 'redirect' }
  return { allow: true, userId: uid }
}

/** 从 token 里取出 uid（不校验签名，仅用于查库；签名由 verifySession 负责）。 */
function decodePayload(token: string): number | undefined {
  const dot = token.lastIndexOf('.')
  if (dot <= 0) return undefined
  const raw = JSON.parse(Buffer.from(token.slice(0, dot), 'base64url').toString('utf8')) as unknown
  if (!raw || typeof raw !== 'object') return undefined
  const uid = (raw as { uid?: unknown }).uid
  return typeof uid === 'number' && Number.isInteger(uid) ? uid : undefined
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
