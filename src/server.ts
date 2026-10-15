/**
 * HTTP 层：路由 + 组装页面数据 + 登录闸门。
 * 一台进程同时负责页面渲染和周期探测，Docker 里就只有一个容器、一个 volume。
 */
import path from 'node:path'
import Fastify from 'fastify'
import fastifyStatic from '@fastify/static'
import { assertSessionSecret, config } from './config.js'
import { getPost, listPosts, listTags } from './content.js'
import { getRecentIncidents, getUptimeRaw, getStats, getTimeline, getLatencyRaw, initStore, closeStore, sanitizeStoredErrors } from './store.js'
import { toPublicSummary } from './public-summary.js'
import { startProbing, stopProbing } from './probe.js'
import {
  countUsers,
  ensureFirstUserFromEnv,
  findById,
  initUsers,
  setPassword,
  verifyPassword,
} from './users.js'
import { issueSession, isSafeNextPath, sessionCookieHeader } from './session.js'
import { decideRequest, deny, isKnownPath, logoutHeader } from './auth.js'
import {
  aboutPage,
  homePage,
  loginPage,
  notFoundPage,
  postPage,
  postsPage,
  statusPage,
  type StatusSummary,
} from './views.js'

const WINDOW_MS = 24 * 60 * 60 * 1000
const WINDOW_LABEL = '最近 24 小时'

const site = { title: config.siteTitle, description: config.siteDescription }

/** 汇总面板需要的数据。每次请求现算：SQLite 聚合在这个数据量下是毫秒级，不值得再加缓存层。 */
function buildSummary(): StatusSummary {
  const targets = config.targets
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
  const token = issueSession(config.sessionSecret, userId, pv, config.sessionTtlMs)
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

  initStore()
  initUsers()

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

  const app = Fastify({
    logger: false,
    trustProxy: true,
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
    if (decision.allow) return
    return deny(reply, req, decision.deny ?? 'redirect')
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

  app.post('/logout', async (_req, reply) => {
    reply.header('set-cookie', logoutHeader(config.sessionCookieSecure))
    // ⚠ 登出只清本机 cookie，**不是吊销**：签名 cookie 无状态，
    // 已泄漏的 token 在过期前仍有效。真吊销走 CLI --revoke-sessions。
    return reply.redirect('/login', 302)
  })

  /**
   * 改密：验证旧口令 → 写新口令（递增 token_version）→ **重新签发当前浏览器**。
   * 若不重签，用户会把自己也踢下线（改密后 token_version 变了）。
   */
  app.post('/password', async (req, reply) => {
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
    return homePage(listPosts(), buildSummary(), site)
  })

  app.get('/posts', async (_req, reply) => {
    reply.type('text/html; charset=utf-8')
    return postsPage(listPosts(), listTags(), site)
  })

  app.get('/tags/:tag', async (req, reply) => {
    const tag = decodeURIComponent((req.params as { tag: string }).tag)
    const posts = listPosts().filter((p) => p.tags.includes(tag))
    reply.type('text/html; charset=utf-8')
    return postsPage(posts, listTags(), site, `标签：${tag}`, tag)
  })

  app.get('/posts/:slug', async (req, reply) => {
    const post = getPost((req.params as { slug: string }).slug)
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
