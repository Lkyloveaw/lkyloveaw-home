/**
 * HTTP 层：路由 + 组装页面数据 + 登录闸门。
 * 一台进程同时负责页面渲染和周期探测，Docker 里就只有一个容器、一个 volume。
 */
import fs from 'node:fs'
import path from 'node:path'
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify'
import fastifyStatic from '@fastify/static'
import { assertSessionSecret, assertSiteOrigins, assertTrustProxy, config } from './config.js'
import {
  getPublishedPost,
  importArticlesIfEmpty,
  listPublishedPosts,
  listTags,
  warnContentDirIsNoLongerInput,
} from './content.js'
import { getRecentIncidents, getUptimeRaw, getStats, getTimeline, getLatencyRaw, initStore, closeStore, sanitizeStoredErrors } from './store.js'
import { toPublicSummary } from './public-summary.js'
import { startProbing, stopProbing } from './probe.js'
import { listBackups } from './backup.js'
import {
  countEnabledAdmins,
  countUsers,
  ensureFirstUserFromEnv,
  findById,
  initUsers,
  listUsers,
  setPassword,
  verifyPassword,
} from './users.js'
import { decodeSid, issueSession, isSafeNextPath, readSessionCookie, sessionCookieHeader } from './session.js'
import { createSession, revokeSession } from './sessions-store.js'
import { decideRequest, deny, isKnownPath, logoutHeader, requireAdmin } from './auth.js'
import { checkOrigin, csrfContext, csrfToken, currentIsAdmin, verifyCsrf } from './csrf.js'
import {
  aboutPage,
  adminOverviewPage,
  forbiddenPage,
  homePage,
  loginPage,
  notFoundPage,
  postPage,
  postsPage,
  statusPage,
  type AdminOverview,
  type StatusSummary,
} from './views.js'

const WINDOW_MS = 24 * 60 * 60 * 1000
const WINDOW_LABEL = '最近 24 小时'

/** 安全方法不进 L2：它们不改状态（`GET` 全只读是本仓的**设计约束**，不是巧合）。 */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

const site = { title: config.siteTitle, description: config.siteDescription }

/**
 * 概览页的四块摘要（`docs/admin-console-ia-decision.md` §6.1）。
 *
 * **一律现算**：不落库、不缓存 —— 计数是「一眼的状态」，不是账本，
 * 与列表在极短窗口内相差一两条可接受。数据来源是本票定的临时来源
 * （目标读 `config.targets`、账号读 `listUsers()`、备份读 `backup.ts`、设置读 `config`），
 * ④⑤⑥ 各自换成库时**只改这里**。
 */
function buildAdminOverview(): AdminOverview {
  const users = listUsers()
  const backups = listBackups()
  const latest = backups.length ? backups[backups.length - 1]! : null
  let latestAt: number | null = null
  if (latest) {
    try {
      latestAt = fs.statSync(path.join(config.backupDir, latest)).mtimeMs
    } catch {
      latestAt = null // 文件刚被清掉：不是错误，页面显示文件名、不显示时间
    }
  }
  const today = new Date().toISOString().slice(0, 10)

  return {
    targets: {
      enabled: config.targets.filter((t) => t.enabled !== false).length,
      total: config.targets.length,
      groups: new Set(config.targets.map((t) => t.group ?? '未分组')).size,
    },
    accounts: {
      total: users.length,
      admins: users.filter((u) => u.role === 'admin').length,
      disabled: users.filter((u) => u.enabled !== 1).length,
    },
    // 「今天是否已备份」看文件名里的日期戳（备份文件就叫 `YYYY-MM-DD.sqlite`）。
    backup: { latest, latestAt, doneToday: latest === `${today}.sqlite` },
    settings: {
      title: config.siteTitle,
      description: config.siteDescription,
      intervalSeconds: Math.round(config.probeIntervalMs / 1000),
    },
    // 零管理员：**每次渲染现算** —— 启动日志只在重启时看得到，概览页才是它的常驻位置。
    zeroAdmins: users.length > 0 && countEnabledAdmins() === 0,
  }
}

/** 汇总面板需要的数据。每次请求现算：SQLite 聚合在这个数据量下是毫秒级，不值得再加缓存层。 */
function buildSummary(): StatusSummary {  const targets = config.targets
    .filter((t) => t.enabled !== false)
    .map((target) => ({
      target,
      stats: getStats(target.id, WINDOW_MS),
      timeline: getTimeline(target.id, WINDOW_MS, 60),
      latency: getLatencyRaw(target.id, WINDOW_MS, 120),
    }))
  return {
    targets,
    overview: getUptimeRaw(WINDOW_MS, 120),
    incidents: getRecentIncidents(8),
    generatedAt: Date.now(),
    windowLabel: WINDOW_LABEL,
    probeIntervalSeconds: Math.round(config.probeIntervalMs / 1000),
  }
}

/** 当前账号的凭据代次，用于签发 cookie。 */
function tokenVersionOf(id: number): number {
  return findById(id)?.token_version ?? 1
}

/** 给响应挂上会话 cookie。 */
function setSession(reply: { header: (k: string, v: string) => unknown }, userId: number, tokenVersion?: number): void {
  const pv = tokenVersion ?? tokenVersionOf(userId)
  // 先建会话记录再签发：cookie 是无状态的，屏幕上那串必须先于库里的行成立
  // （反过来的顺序会在「建了行但签发失败」时留下一条谁也认领不了的会话）。
  const { sid } = createSession(userId, pv, config.sessionTtlMs)
  const token = issueSession(config.sessionSecret, userId, pv, sid, config.sessionTtlMs)
  reply.header(
    'set-cookie',
    sessionCookieHeader(token, { secure: config.sessionCookieSecure, ttlMs: config.sessionTtlMs }),
  )
}

function parseFormBody(body: unknown): Record<string, string> {
  if (!body || typeof body !== 'object') return {}
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
    out[k] = typeof v === 'string' ? v : String(v ?? '')
  }
  return out
}

export async function buildServer(): Promise<ReturnType<typeof Fastify>> {
  // 先查密钥：没配就拒绝启动（不会因重启自愈的配置错误，必须显眼地停）。
  assertSessionSecret()
  // 写路径的 L2 判据来源。与密钥同一条判据：**不会因重启自愈**，所以拒绝启动。
  // ⚠ 这是**部署契约的一部分**：升级时 .env 里没有 SITE_ORIGIN，服务起不来（已同步进 .env.example / README）。
  assertSiteOrigins()
  // TRUST_PROXY=true 被拒（§3.3）：它会让人能伪造 X-Forwarded-*，而本仓的判定根本不用那两个值。
  assertTrustProxy()

  initStore()
  initUsers()
  // 首次导入：**库里一篇文章都没有时**才读 content/*.md（与 targets.json、.env 同一条规则）。
  // 之后那些文件就不再是输入 —— 改它们对站点没有任何影响，只由下面这行提醒一次。
  importArticlesIfEmpty()
  warnContentDirIsNoLongerInput()

  // 存量脏数据清洗：历史 `error` 列里可能残留含 URL/凭证的异常原文。
  // 写入侧已修，但那只影响新行——已落库的得在这里洗掉。幂等，启动时自动跑。
  try {
    const cleaned = sanitizeStoredErrors()
    if (cleaned > 0) console.log(`[store] 已清洗 ${cleaned} 条历史错误文案（脱敏/截断）`)
  } catch (err) {
    // 清洗失败不该阻止服务启动：闸门与会话都不依赖它。
    console.error('[store] 历史错误文案清洗失败（不影响启动）：', (err as Error).message)
  }

  // 零账号时用环境变量建首个号；表非空则**完全忽略**（防后门）。
  // 零账号**允许启动**——拒绝启动会进 restart: unless-stopped 的重启循环。
  ensureFirstUserFromEnv(config.adminUsername, config.adminPassword)
  if (countUsers() === 0) {
    console.warn(
      '\n  ⚠ 尚未创建任何账号：所有页面都会跳转到登录页。\n' +
        '     请执行 node dist/cli/passwd.js --user <名字> --password <口令>\n',
    )
  }

  /*
   * 零管理员：**只告警，不自愈，也不拒启**（`docs/roles-decision.md` §5）。
   *
   * - 不自动提权：静默改权限比锁死更难排查 —— 运维会看到「权限自己变了」而找不到是谁改的。
   * - 不拒绝启动：零管理员是**运行状态**（服务本身健康，只是没人能进管理台），
   *   拒启会进 `restart: unless-stopped` 的崩溃重启循环，把真正的原因刷没。
   *   这与「`users` 表为空允许启动 + 告警」是同一条判据的两个实例。
   *
   * 进这个状态只可能来自手工改库：守卫拦住了全部 API 通道，CLI 的提权/启用方向也不造成它。
   */
  if (countUsers() > 0 && countEnabledAdmins() === 0) {
    console.warn(
      '\n  ⚠ 库里没有「启用中的管理员」：管理台没人能进（读面不受影响）。\n' +
        '     修复：node dist/cli/passwd.js --user <名字> --role admin\n' +
        '     （本服务不会自动提权 —— 静默改权限比锁死更难排查）\n',
    )
  }

  const app = Fastify({
    logger: false,
    trustProxy: config.trustProxy,
  })

  /**
   * 解析 `application/x-www-form-urlencoded` 表单体。
   *
   * 为什么自己写而不是引 `@fastify/formbody`：登录表单只有三个字段，
   * 用内置的 `URLSearchParams` 五行就够，不值得为此多一个依赖（本仓库的既有取舍是尽量不引新依赖）。
   * 注意 Fastify 默认**不解析**表单体，不注册这个解析器时 `req.body` 是 undefined。
   */
  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string' },
    (_req, body: string, done) => {
      try {
        const out: Record<string, string> = {}
        for (const [k, v] of new URLSearchParams(body)) out[k] = v
        done(null, out)
      } catch (err) {
        done(err as Error, undefined)
      }
    },
  )

  await app.register(fastifyStatic, {
    root: config.publicDir,
    prefix: '/',
    // 静态资源不带 hash，交给浏览器短缓存即可。
    maxAge: '1h',
  })

  /**
   * 全局闸门。默认拒绝、白名单显式放行——失败安全的形状。
   *
   * 实测：这个钩子**会**拦到 `@fastify/static` 的资源，且与注册顺序无关，
   * 所以静态资源必须在 `PUBLIC_PATHS` 里显式列出（见 `auth.ts`）。
   */
  app.addHook('onRequest', async (req, reply) => {
    const decision = decideRequest(req)
    if (!decision.allow) return deny(reply, req, decision.deny ?? 'redirect')

    /*
     * L2：所有**非安全方法**的来源校验，fail-closed（`docs/write-path-auth-decision.md` §2）。
     *
     * 位置是**有意的**：紧接闸门之后、且在**任何资格判定之前**（§5.3）。
     * 它说的不是「你不够格」，而是「这个请求不可能来自本站」—— 与身份无关。
     * 放到资格之后，攻击者就能从 403 的差异里读出「这个路由存在、且需要一个管理员会话」。
     *
     * 判据只看 `Origin` / `Referer` 与 `SITE_ORIGIN` **精确**比较，
     * **不碰 `req.hostname` / `req.protocol`**（`trustProxy` 打开时它们可被任意直连客户端伪造）。
     */
    if (!SAFE_METHODS.has(req.method)) {
      const ok = checkOrigin({ origin: req.headers.origin, referer: req.headers.referer }, config.siteOrigins)
      if (!ok) {
        // 记 method / path / origin / referer / host —— **不记 token、不记表单体**。
        console.warn(
          `[auth] L2 拒绝来源不可信的写请求：method=${req.method} path=${req.url} ` +
            `origin=${req.headers.origin ?? '-'} referer=${req.headers.referer ?? '-'} host=${req.headers.host ?? '-'}`,
        )
        reply.code(403).type('text/html; charset=utf-8')
        return reply.send(forbiddenPage('origin', site))
      }
    }

    // 带 token 的响应**不进共享缓存**（§4.3）。今天是动态 SSR、本来没有共享缓存，
    // 但「已登录页面不进共享缓存」本身就该是响应的属性 —— 一行头的事。
    if (!req.url.startsWith('/static/')) reply.header('Cache-Control', 'no-store')

    /*
     * L3 的 token 从**会话 token 派生**：零新 cookie、不加载荷字段、旧 cookie 不迁移。
     * `POST /login` 没有会话可派生 → 空串（它按 §5.2 只受 L2）。
     *
     * ⚠ **与文档措辞的一处偏差**：文档写 `als.run({ csrf }, () => handler())`，
     * 但在 Fastify 里 `onRequest` 钩子**无法把后续 handler 包进回调**（钩子返回后由框架继续调用）。
     * 这里用 `enterWith()`：它让**本请求后续的异步链**都看得到这个 store，效果相同。
     * 而这个「相同」**由 e2e 断言证明**（登出表单里的 token 非空、且提交成功），不靠对机制的信任。
     */
    const csrf = csrfToken(config.sessionSecret, readSessionCookie(req.headers.cookie) ?? '') ?? ''
    // 角色一并进上下文：顶栏据此决定要不要渲染「管理」那一项（IA §2），
    // 管理台路由也据此判资格 —— **不重复查库**（闸门那次查询已经把角色带出来了）。
    csrfContext.enterWith({ token: csrf, isAdmin: decision.role === 'admin' })
  })

  /**
   * L3 的接线：**写在写路由自己的 `preValidation` 里**，不是全局（§4.2）。
   *
   * 为什么必须是 `preValidation`：`onRequest` 时表单体**还没解析**，读不到 `csrf` 字段；
   * 本仓自写的 urlencoded 解析器在 `Parsing` 阶段生效，`preValidation` 在它之后。
   * 为什么不做成全局：L3 需要**会话 token**（闸门刚算出来的那枚），
   * 放进全局就得把所有 `GET` 也过一遍，而 `GET` 没有表单体、也没有必要。
   *
   * 失败给**回本页**的链接：最常见的真实原因是「开着两个标签页，在另一个标签改了口令」
   * （`token_version` 变了 → 会话重签 → 这个页面的 token 失效），给一条刷新路径比只给 403 少一次困惑。
   * 但文案**不解释**这个内部原因。
   */
  const csrfGuard = async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const submitted = parseFormBody(req.body).csrf
    if (!verifyCsrf(config.sessionSecret, readSessionCookie(req.headers.cookie), submitted)) {
      // 记 path 与失败原因，**不记 token 值**（OWASP 明文要求 token 不进日志）。
      console.warn(`[auth] L3 拒绝：path=${req.url}（token 缺失或不匹配）`)
      reply.code(403).type('text/html; charset=utf-8')
      await reply.send(forbiddenPage('csrf', site, req.url))
    }
  }

  // ── 管理台（只读外壳，#39）────────────────────────────────

  /**
   * `/admin`：只读的概览页。
   *
   * 资格用**闸门刚算出来的那个角色**（在请求上下文里）—— 不重复查库。
   * 拿不到上下文（没走闸门的路径）→ 非管理员 → **403**，fail-closed。
   *
   * **403 而不是 404**：用户该知道这是**权限**问题，不是地址敲错了
   * （`docs/admin-console-ia-decision.md` §3.1）。
   */
  app.get('/admin', async (req, reply) => {
    if (!currentIsAdmin()) {
      reply.code(403).type('text/html; charset=utf-8')
      return forbiddenPage('admin', site)
    }
    reply.type('text/html; charset=utf-8')
    // `?notice=<key>` 原样交给视图：**闭集判定在 views 里**（未知 key 什么都不渲染），
    // 路由不解释它 —— 否则「哪些 key 有效」会长出第二份名单。
    const query = req.query as { notice?: unknown }
    return adminOverviewPage(buildAdminOverview(), site, query.notice)
  })

  // ── 登录 / 登出 / 改密 ───────────────────────────────────

  app.get('/login', async (req, reply) => {
    const query = req.query as { next?: string }
    const next = isSafeNextPath(query.next, isKnownPath) ? (query.next as string) : '/'
    reply.type('text/html; charset=utf-8')
    return loginPage({ next, noAccounts: countUsers() === 0 }, site)
  })

  app.post('/login', async (req, reply) => {
    const form = parseFormBody(req.body)
    const next = isSafeNextPath(form.next, isKnownPath) ? form.next! : '/'

    const user = verifyPassword(form.username ?? '', form.password ?? '')
    if (!user) {
      // 不区分「用户不存在」「口令错」「账号已停用」——统一一句提示。
      reply.code(401).type('text/html; charset=utf-8')
      return loginPage({ next, error: '用户名或口令不正确', noAccounts: countUsers() === 0 }, site)
    }

    setSession(reply, user.id, user.token_version)
    return reply.redirect(next, 302)
  })

  app.post('/logout', { preValidation: csrfGuard }, async (req, reply) => {
    /*
     * **真吊销**（#55）：把这一条会话行标成已吊销，而不只是清掉本机 cookie。
     * 只清 cookie 的话，已经泄漏出去的那串签名 token 在过期前照样能用 —— 那正是「登出」这个词
     * 在过去名不副实的地方。
     *
     * **幂等**：不管有没有吊销到（没登录 / 已经吊销过 / 老 cookie 没有 sid），
     * 都**永远**清 cookie + 302。登出是用户的意图，不能因为查不到会话行就失败。
     */
    try {
      const sid = decodeSid(readSessionCookie(req.headers.cookie))
      if (sid && revokeSession(sid) > 0) console.log('[auth] 已吊销会话（登出）')
    } catch (err) {
      // 库抖动不该让「登出」失败：清 cookie 那一半永远要发生。
      console.error('[auth] 吊销会话失败（仍然清 cookie）：', (err as Error).message)
    }
    reply.header('set-cookie', logoutHeader(config.sessionCookieSecure))
    return reply.redirect('/login', 302)
  })

  /**
   * 改密：验证旧口令 → 写新口令（递增 token_version）→ **重新签发当前浏览器**。
   * 若不重签，用户会把自己也踢下线（改密后 token_version 变了）。
   */
  app.post('/password', { preValidation: csrfGuard }, async (req, reply) => {
    const decision = decideRequest(req)
    const userId = decision.userId
    if (userId === undefined) return reply.code(401).send({ error: 'unauthorized' })

    const user = findById(userId)
    if (!user) return reply.code(401).send({ error: 'unauthorized' })

    const form = parseFormBody(req.body)
    const fail = (notice: string): string => {
      reply.code(400).type('text/html; charset=utf-8')
      return statusPage(buildSummary(), site, notice)
    }

    if (!verifyPassword(user.username, form.current ?? '')) return fail('当前口令不正确')
    if ((form.next ?? '').length < 8) return fail('新口令至少 8 位')
    if (form.next !== form.confirm) return fail('两次输入的新口令不一致')

    setPassword(userId, form.next!)
    // 改密已递增 token_version（其他设备全部失配掉线），
    // 这里用**新版本**重新签发，自己才不会掉线。
    setSession(reply, userId, tokenVersionOf(userId))
    reply.type('text/html; charset=utf-8')
    return statusPage(buildSummary(), site, '口令已更新。其他设备上的登录已失效。')
  })

  // ── 页面 ────────────────────────────────────────────────

  app.get('/', async (_req, reply) => {
    reply.type('text/html; charset=utf-8')
    return homePage(listPublishedPosts(), buildSummary(), site)
  })

  app.get('/posts', async (_req, reply) => {
    reply.type('text/html; charset=utf-8')
    return postsPage(listPublishedPosts(), listTags(), site)
  })

  app.get('/tags/:tag', async (req, reply) => {
    const tag = decodeURIComponent((req.params as { tag: string }).tag)
    const posts = listPublishedPosts().filter((p) => p.tags.includes(tag))
    reply.type('text/html; charset=utf-8')
    return postsPage(posts, listTags(), site, `标签：${tag}`, tag)
  })

  app.get('/posts/:slug', async (req, reply) => {
    // ⚠ **必须解码**，与 /tags/:tag 对齐。少了这一步，「slug 允许中文」就是假的：
    // /posts/中文slug 会 404，而库里明明有那一篇（研究 §2.2 记过这个不对称）。
    const post = getPublishedPost(decodeURIComponent((req.params as { slug: string }).slug))
    if (!post) {
      reply.code(404).type('text/html; charset=utf-8')
      return notFoundPage(site)
    }
    reply.type('text/html; charset=utf-8')
    return postPage(post, site)
  })

  app.get('/status', async (_req, reply) => {
    reply.type('text/html; charset=utf-8')
    return statusPage(buildSummary(), site)
  })

  /** 给前端自动刷新用的 JSON。
   *  ⚠ 必须过 `toPublicSummary()`：内部结构里有 `url`/`expectStatus` 等不该出网的字段。
   *  真实攻击者最多是「已登录的用户」，所以「要求登录」不能替代字段收敛。 */
  app.get('/api/status', async (_req, reply) => {
    return reply.send(toPublicSummary(buildSummary()))
  })

  app.get('/about', async (_req, reply) => {
    reply.type('text/html; charset=utf-8')
    return aboutPage(site)
  })

  /** 健康检查：**保持匿名 200**（HEALTHCHECK / systemd 都不带凭证）。 */
  app.get('/healthz', async () => ({ ok: true, targets: config.targets.length }))

  app.setNotFoundHandler(async (_req, reply) => {
    reply.code(404).type('text/html; charset=utf-8')
    return notFoundPage(site)
  })

  return app
}

async function main(): Promise<void> {
  const app = await buildServer()
  await app.listen({ port: config.port, host: config.host })

  const shown = config.host === '0.0.0.0' ? 'localhost' : config.host
  console.log(`\n  站点已启动  http://${shown}:${config.port}`)
  console.log(`  监控目标    ${config.targets.length} 个（清单：${process.env.TARGETS_PATH ?? 'targets.json'}）`)
  console.log(`  登录账号    ${countUsers()} 个`)
  if (!config.targets.length) {
    console.warn('  提示：还没有配置被监控的系统，编辑 targets.json 后重启即可。')
  }
  console.log('')

  startProbing()

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`\n[server] 收到 ${signal}，正在退出…`)
    stopProbing()
    await app.close()
    closeStore()
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
}

// 只有作为入口直接运行时才启动监听：被 import（测试、脚本）时不该自己起服务。
// 同时兼容 dev（src/server.ts，走 tsx）与 prod（dist/server.js）两种入口。
const entry = process.argv[1] ? path.resolve(process.argv[1]) : ''
const invokedDirectly = /[/\\]server\.(ts|js)$/.test(entry)

if (invokedDirectly) {
  main().catch((err) => {
    console.error('[server] 启动失败：', err)
    process.exit(1)
  })
}
