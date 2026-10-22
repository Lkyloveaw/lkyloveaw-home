/**
 * 写路径三道防线里**可以纯函数化的那两道**：
 *
 * - **L2 origin 校验**（`checkOrigin`）——「这个请求可能来自本站吗」，与身份无关；
 * - **L3 会话派生 token**（`csrfToken` / `verifyCsrf`）——「提交里那枚 token 是本会话的吗」。
 *
 * L1 是 cookie 的 `SameSite=Lax`（在 `session.ts` 的 cookie 属性里），本模块不管它。
 *
 * 为什么全是纯函数：判定表可以**不过 HTTP 直接断言**（`docs/write-path-auth-decision.md` §9.1 的 16 条）。
 * 本模块不 import Fastify、不碰库、不读 env —— 只依赖 `node:crypto`。
 */
import crypto from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'

/**
 * 本次请求的渲染事实：L3 token + 当前角色。
 *
 * **为什么不给视图函数加参数**（§4.3）：不是为了少改代码，而是**失败方向不同**。
 * 加参数时漏传 = 静默渲染出一个**没有 hidden input** 的表单（或漏掉顶栏那一项），
 * 用户提交拿到 403，而原因在渲染侧（要从「为什么这个表单少了一段 HTML」开始查）。
 * ALS 未初始化时（脚本或测试里直接调 `views`）拿到的是**空 token / 非管理员** →
 * 提交必 403、入口不渲染，同样是显眼失败，但**只有一处**要查。
 *
 * ⚠ 放在本模块而不是 `server.ts`：`views.ts` 要读它，而 `views.ts` **不能** import `server.ts`
 * （那是循环依赖）。本模块两边都能 import，且它本来就只依赖 `node:crypto`。
 */
export const csrfContext = new AsyncLocalStorage<{
  token: string
  isAdmin: boolean
  /** 当前登录者的 `users.id`。管理台的账号页要它来判「这一行是不是你自己」（#44）。 */
  userId?: number
  /** 当前登录者的用户名；顶栏胶囊用它显示身份。 */
  userName?: string
}>()
/** 当前请求的 token；**没有上下文时返回空串**（渲染出的表单会提交失败，而不是悄悄放行）。 */
export function currentCsrfToken(): string {
  return csrfContext.getStore()?.token ?? ''
}

/**
 * 当前请求是不是管理员 —— 顶栏据此决定要不要渲染「管理」那一项
 * （`docs/admin-console-ia-decision.md` §2：**只读用户看不到入口**，
 * 而不是看到一个点了就 403 的项 —— 那等于每次点都吃一次错）。
 */
export function currentIsAdmin(): boolean {
  return csrfContext.getStore()?.isAdmin === true
}

/**
 * 当前登录者的 `users.id`（**没有上下文时给 `undefined`**）。
 *
 * 用途有两处，都在管理台的账号页：渲染时判「这一行是不是你自己」（自己的行不给改角色/停用按钮），
 * 写路径把它当 `actorId` 交给 `users.ts` 的守卫（「不能改自己」那一条）。
 *
 * ⚠ 拿不到时（脚本 / 测试直接调用）守卫里那条**只跳过「不能改自己」**——
 * 「不能把启用中的管理员减到零」照旧生效（它不依赖 actor）。网页路径上上下文一定在。
 */
export function currentUserId(): number | undefined {
  return csrfContext.getStore()?.userId
}

/** 当前登录者的用户名；无上下文返回空串（胶囊据此决定是否渲染）。 */
export function currentUserName(): string {
  return csrfContext.getStore()?.userName ?? ''
}

/**
 * L3 token 的前缀。把「这个 HMAC 是干什么用的」写进**被签的原文**里（域分隔）：
 * 同一把密钥在别处也做 HMAC，前缀让两处的输出不可能互相顶替。
 */
const CSRF_LABEL = 'csrf|'

function b64url(buf: Buffer): string {
  return buf.toString('base64url')
}

/**
 * 会话派生 token：`HMAC-SHA256(SESSION_SECRET, 'csrf|' + 会话 token 里最后一个 '.' 之前那段)`。
 *
 * **为什么派生而不是另发一枚 cookie**（§4.1）：零新 cookie、不加载荷字段、**旧 cookie 不迁移** ——
 * 会话一换（改密、重登、被踢），token 自动全变，不需要任何失效名单。
 *
 * 载荷段拿不到时（没有 `.`，或 `.` 在开头）返回 `null`：调用方据此**拒绝**，
 * 不要把它当成「空 token」——那会把畸形输入与「没带 token」混成一类。
 */
export function csrfToken(secret: string, sessionToken: string): string | null {
  if (typeof sessionToken !== 'string') return null
  const dot = sessionToken.lastIndexOf('.')
  if (dot <= 0) return null
  return b64url(crypto.createHmac('sha256', secret).update(CSRF_LABEL + sessionToken.slice(0, dot)).digest())
}

/**
 * 校验提交上来的 token。
 *
 * **必须先比长度再 `timingSafeEqual`**：不等长时它会抛 `ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH`，
 * 直接用就把畸形输入打成 500。形状照抄 `src/session.ts` 的既有先例。
 * 非字符串（表单里同名多值 → 数组、`undefined`、数字）一律判假，**不抛**。
 */
export function verifyCsrf(secret: string, sessionToken: string | undefined, submitted: unknown): boolean {
  if (typeof submitted !== 'string' || !submitted) return false
  if (!sessionToken) return false
  const expected = csrfToken(secret, sessionToken)
  if (expected === null) return false
  const a = Buffer.from(submitted)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return false
  return crypto.timingSafeEqual(a, b)
}

/**
 * L2：这个请求的来源可信吗（§2.1 的判据，**fail-closed**）。
 *
 * 顺序：`Origin` 在 → 精确匹配（`null` 一律拒）；`Origin` 不在 → 回退 `Referer` 的 **origin**；
 * 两者都不可用 → 拒。
 *
 * ⚠ **禁止 `includes` / 前缀 / 后缀匹配**：`http://example.com.evil.com`、`http://evil.com#@example.com`
 * 那组伪造正是为**包含型比较**准备的。这里只有 `Set.has()`（精确相等）。
 *
 * ⚠ **`Origin: null` 不是「没有来源」，是「来源不可知」**（`no-referrer`、sandbox iframe、
 * HTTPS→HTTP 降级都能造出它），所以它和缺失一样**不构成同源证据**。
 *
 * ⚠ **禁止用 `req.hostname` / `req.protocol`**：`trustProxy` 打开时它们可被任意直连客户端伪造（§3.3）。
 * 本函数只看头，不看请求对象。
 *
 * 空字符串按「头不存在」处理：空 `Origin` 不是一个可比较的来源。
 */
export function checkOrigin(
  headers: { origin?: string; referer?: string },
  allowed: ReadonlySet<string>,
): boolean {
  const origin = headers.origin
  if (origin !== undefined && origin !== '') {
    if (origin === 'null') return false
    return allowed.has(origin)
  }

  const referer = headers.referer
  if (referer !== undefined && referer !== '') {
    try {
      // 回退只取 **origin 部分**，不看 path（跨源时默认 policy 也只给 origin）。
      return allowed.has(new URL(referer).origin)
    } catch {
      return false
    }
  }

  return false
}
