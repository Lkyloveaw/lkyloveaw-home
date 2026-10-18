/**
 * HTTP 层：路由 + 组装页面数据 + 登录闸门。
 * 一台进程同时负责页面渲染和周期探测，Docker 里就只有一个容器、一个 volume。
 */
import fs from 'node:fs'
import path from 'node:path'
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify'
import fastifyStatic from '@fastify/static'
import fastifyMultipart from '@fastify/multipart'
import { assertSessionSecret, assertSiteOrigins, assertTrustProxy, config } from './config.js'
import {
  getPublishedPost,
  importArticlesIfEmpty,
  listPublishedPosts,
  listTags,
  warnContentDirIsNoLongerInput,
} from './content.js'
import { getRecentIncidents, getUptimeRaw, getStats, getTimeline, getLatencyRaw, initStore, closeStore, sanitizeStoredErrors } from './store.js'
import { getArticleForAdmin, listArticlesForAdmin, upsertArticleWithRevision } from './store.js'
import { listTrashedArticles, purgeArticle, restoreArticle, trashArticle } from './store.js'
import { listRevisions, revertToRevision } from './store.js'
import { isSafeMediaName, MEDIA_MAX_BYTES, mediaMime, mediaPath, mediaSnippet, saveMedia } from './media.js'
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
import { docToMarkdown, markdownToDoc } from './article-import.js'
import { docToHtml } from './article-html.js'
import { docFromJson } from './article-doc.js'
import {
  checkSlugAvailable,
  normalizeTags,
  slugConflictMessage,
  validateBodySize,
  validateSlug,
  validateTitle,
} from './article-rules.js'
import {
  aboutPage,
  adminArticlesPage,
  adminOverviewPage,
  forbiddenPage,
  homePage,
  loginPage,
  notFoundPage,
  postPage,
  postsPage,
  statusPage,
  type AdminArticleForm,
  type AdminArticleListItem,
  type AdminOverview,
  type AdminRevisionItem,
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
    // 第一层上限（#52 规格要求两层）：Fastify 的表单体上限 9 MiB。
    // 第二层是 multipart 插件的 `limits.fileSize` 8 MiB（见下面的注册）。
    bodyLimit: 9 * 1024 * 1024,
  })


  // 上传通道（#52）：规格指定用**官方插件**，不手写解析器（解析不可信请求体是安全面）。
  // 两层上限都要设：插件这边 8 MiB，且 `throwFileSizeLimit` 为真 —— **禁止截断**
  // （截断的 PNG 头部仍是合法魔数，会被误收成半张图）。另一层在 Fastify 的 bodyLimit。
  await app.register(fastifyMultipart, {
    limits: { fileSize: MEDIA_MAX_BYTES, files: 1, fields: 8 },
    throwFileSizeLimit: true,
    attachFieldsToBody: true,
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

  // ── 管理台 · 文章（#50）──────────────────────────────────

  /** 文章的 `action` **闭集**（`docs/article-write-api-decision.md` §3.2）。未知值 → 400，**不拼进 SQL**。 */
  const ARTICLE_ACTIONS = new Set([
    'article-create',
    'article-save',
    'article-publish',
    'article-unpublish',
    // 回收站（#51）：**只做「还原 / 彻底删除」两件事** —— 想改就先还原
    'article-trash',
    'article-restore',
    'article-purge',
    // 修订（#51 后半）：退回某一版
    'article-revert',
  ])

  /** `tags` 列是 JSON 数组字符串。解析失败就当作没有标签 —— **不抛**（一篇脏数据不该让整页 500）。 */
  const parseTagList = (json: string): string[] => {
    try {
      const v = JSON.parse(json) as unknown
      return Array.isArray(v) ? v.map(String) : []
    } catch {
      return []
    }
  }

  const todayStamp = (): string => new Date().toISOString().slice(0, 10)

  /**
   * 列表 + 编辑面的数据（**一律现算**）。
   *
   * ⚠ `opts.submitted` 是**失败重渲染**的关键：400 时以**用户刚提交的**为准，
   * 而不是库里的旧值 —— 票面原话：一篇三千字因为 slug 重名被打回、正文却空了，
   * 是这个页面能犯的**最贵**的一次错。
   */
  const buildArticlesPage = (
    editSlug: string | undefined,
    opts: {
      notice?: unknown
      bad?: string | null
      submitted?: Record<string, string>
      uploaded?: { name: string; snippet: string } | null
    },
  ): string => {
    const list: AdminArticleListItem[] = listArticlesForAdmin().map((r) => ({
      slug: r.slug,
      title: r.title,
      date: r.date,
      draft: r.draft === 1,
      trashed: r.deletedAt !== null,
      tags: parseTagList(r.tags),
    }))

    const trash: AdminArticleListItem[] = listTrashedArticles().map((r) => ({
      slug: r.slug,
      title: r.title,
      date: r.date,
      draft: r.draft === 1,
      trashed: true,
      tags: parseTagList(r.tags),
    }))

    let edit: AdminArticleForm | null = null
    let revisions: AdminRevisionItem[] = []
    let preview: string | null = null
    if (editSlug !== undefined) {
      const row = editSlug ? getArticleForAdmin(editSlug) : undefined
      const sub = opts.submitted
      if (row) {
        edit = {
          slug: row.slug,
          title: sub?.title ?? row.title,
          date: sub?.date ?? row.date,
          tags: sub?.tags ?? parseTagList(row.tags).join(', '),
          summary: sub?.summary ?? (row.summary ?? ''),
          // 没有提交内容时，把库里的**文档 JSON 还原成 Markdown**（`docToMarkdown` 的用处就在这）
          markdown: sub?.body_md ?? docToMarkdown(docFromJson(JSON.parse(row.body))),
          draft: row.draft === 1,
          isNew: false,
          trashed: row.deletedAt !== null,
        }
        // 草稿预览：**同一页面、同一鉴权**（不在 `/posts/*` 下开任何预览入口）
        if (row.draft === 1 && !sub) {
          try {
            preview = docToHtml(docFromJson(JSON.parse(row.body)))
          } catch (err) {
            console.error('[articles] 草稿预览渲染失败：', (err as Error).message)
          }
        }
        // 修订历史：最近的在最上面。**每一版的正文也还原成 Markdown**，放在 `<details>` 里给人看全文。
        // ⚠ 只在「没提交内容」时算（失败重渲染时以用户刚填的为准，不必把 N 版正文都转一遍）。
        if (!sub) {
          revisions = listRevisions(row.slug).map((rev) => ({
            id: rev.id,
            savedAt: rev.savedAt,
            title: rev.title,
            markdown: docToMarkdown(docFromJson(JSON.parse(rev.body))),
            draft: rev.draft === 1,
          }))
        }
      } else if (sub || editSlug === '') {
        edit = {
          slug: sub?.slug ?? '',
          title: sub?.title ?? '',
          date: sub?.date ?? todayStamp(),
          tags: sub?.tags ?? '',
          summary: sub?.summary ?? '',
          markdown: sub?.body_md ?? '',
          draft: true,
          isNew: true,
          trashed: false,
        }
      }
    }
    return adminArticlesPage(
      list,
      trash,
      edit,
      { notice: opts.notice, bad: opts.bad ?? null, preview, revisions, uploaded: opts.uploaded ?? null },
      site,
    )
  }

  /**
   * 管理台写路由的守卫：**资格（只读 → 403）→ L3**（`docs/write-path-auth-decision.md` §5.3 的顺序）。
   * 两件事写在**同一个 `preValidation`** 里就是为了保住这个顺序 —— 分成两个钩子的话
   * L3 会先跑（`preValidation` 早于 handler，而资格判定本该在它之前）。
   */
  const adminWriteGuard = async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (!currentIsAdmin()) {
      reply.code(403).type('text/html; charset=utf-8')
      await reply.send(forbiddenPage('admin', site))
      return
    }
    await csrfGuard(req, reply)
  }

  /**
   * 上传超限的兜底（#52）。
   *
   * ⚠ **它必须在错误处理器里兜**：`throwFileSizeLimit: true` 时插件在**它自己的解析阶段**就抛，
   * 那时**还没进路由 handler** —— 我原来那句「捕获后回跳 media-too-big」根本走不到。
   * 失败要显眼，但不是 500：转成一句人话 + PRG 回跳。
   *
   * 只兜这一类错误；**其它错误照旧 500**（不吞、不假装成功）。
   */
  app.setErrorHandler(async (err: Error & { code?: string }, _req, reply) => {
    const code = err.code ?? ''
    if (code === 'FST_REQ_FILE_TOO_LARGE' || code === 'FST_FILES_LIMIT' || /file size limit|too large/i.test(err.message)) {
      console.warn('[media] 上传被拒（超过上限）：' + err.message)
      return reply.redirect('/admin/articles?notice=media-too-big', 302)
    }
    console.error('[server] 未处理的请求错误：', err.message)
    reply.code(500).type('text/plain; charset=utf-8')
    return '服务器内部错误'
  })

  app.get('/admin/articles', async (req, reply) => {
    if (!currentIsAdmin()) {
      reply.code(403).type('text/html; charset=utf-8')
      return forbiddenPage('admin', site)
    }
    const q = req.query as { notice?: unknown; edit?: unknown; uploaded?: unknown }
    reply.type('text/html; charset=utf-8')
    // ⚠ 回跳里的文件名**必须过 `isSafeMediaName`**：URL 是用户可控的，
    // 形状校验是它进页面的唯一入口（否则就是「URL 让页面显示任意文本」）。
    const upName = typeof q.uploaded === 'string' && isSafeMediaName(q.uploaded) ? q.uploaded : null
    const uploaded = upName ? { name: upName, snippet: mediaSnippet(upName, '图片') } : null
    return buildArticlesPage(typeof q.edit === 'string' ? q.edit : undefined, { notice: q.notice, uploaded })
  })

  app.post('/admin/articles', { preValidation: adminWriteGuard }, async (req, reply) => {
    const form = parseFormBody(req.body)
    const action = String(form.action ?? '')
    const origSlug = String(form.orig_slug ?? '').trim()
    const back = (bad: string, slug?: string): unknown => {
      reply.code(400).type('text/html; charset=utf-8')
      return buildArticlesPage(slug ?? origSlug ?? undefined, { bad, submitted: form })
    }

    if (!ARTICLE_ACTIONS.has(action)) return back('未知的动作，已拒绝。')

    // ── 回收站的三个动作（#51）──
    if (action === 'article-trash' || action === 'article-restore' || action === 'article-purge') {
      const row = getArticleForAdmin(origSlug)
      if (!row) return back('找不到这篇文章：' + origSlug)

      if (action === 'article-trash') {
        // 幂等：已经在回收站里时 changes = 0，仍然回跳成功（用户的意图已经达成）
        const n = trashArticle(origSlug)
        console.log('[articles] 移进回收站 ' + origSlug + '（changes=' + n + '）')
        return reply.redirect('/admin/articles?notice=article-trashed', 302)
      }

      if (action === 'article-restore') {
        const n = restoreArticle(origSlug)
        console.log('[articles] 从回收站还原 ' + origSlug + '（changes=' + n + '）')
        return reply.redirect('/admin/articles?edit=' + encodeURIComponent(origSlug) + '&notice=article-restored', 302)
      }

      // **彻底删除**：必勾确认框（`docs/admin-console-ia-decision.md` §5.1：不用 JS confirm()，
      // 禁用 JS 也要拦得住 —— 所以判据在**服务端**）
      if (String(form.confirm ?? '') !== 'yes') {
        return back('彻底删除需要勾选确认框。', undefined)
      }
      const out = purgeArticle(origSlug)
      if (out.article !== 1) return back('它不在回收站里，已拒绝彻底删除。', undefined)
      console.log('[articles] 彻底删除 ' + origSlug + '（连带 ' + out.revisions + ' 条修订）')
      return reply.redirect('/admin/articles?notice=article-purged', 302)
    }

    // ⚠ **回收站里的文章不能改**：`upsertArticleWithRevision` 的 ON CONFLICT 会清掉 `deleted_at`
    //（那是给导入逃生口留的），所以这里必须先拦住 —— 否则「保存」会**悄悄把它还原**，
    // 而用户在回收站里看到的应该是「只做还原/彻底删除两件事」。
    if (getArticleForAdmin(origSlug)?.deletedAt !== null && action !== 'article-create') {
      return back('这篇在回收站里：先还原，再改。', origSlug)
    }

    // ── 退回某一版（#51 后半）──
    // **不移指针、不删任何修订**：退回本身走 `upsertArticleWithRevision()`，所以它自己也留一条。
    if (action === 'article-revert') {
      const revId = Number(form.revision)
      if (!Number.isInteger(revId) || revId <= 0) return back('修订编号不合法。', origSlug)
      const out = revertToRevision(origSlug, revId)
      if (out === 'missing') return back('找不到这一版修订（或者它不属于这篇文章）。', origSlug)
      console.log('[articles] 退回修订 ' + origSlug + ' → #' + revId + '（' + out + '）')
      return reply.redirect('/admin/articles?edit=' + encodeURIComponent(origSlug) + '&notice=article-reverted', 302)
    }

    // 发布 / 撤下：只改状态，**不碰正文**（正文要改先「保存」）
    if (action === 'article-publish' || action === 'article-unpublish') {
      const row = getArticleForAdmin(origSlug)
      if (!row) return back('找不到这篇文章：' + origSlug)
      upsertArticleWithRevision({
        slug: row.slug,
        title: row.title,
        body: row.body,
        summary: row.summary,
        date: row.date,
        tags: row.tags,
        draft: action === 'article-publish' ? 0 : 1,
        now: Date.now(),
      })
      const notice = action === 'article-publish' ? 'article-published' : 'article-unpublished'
      return reply.redirect('/admin/articles?edit=' + encodeURIComponent(row.slug) + '&notice=' + notice, 302)
    }

    // 新建 / 保存：**校验 → 转文档 → 落库**
    const title = String(form.title ?? '').trim()
    const slug = String(form.slug ?? '').trim()
    const markdown = String(form.body_md ?? '')
    const summary = String(form.summary ?? '').trim()
    const date = String(form.date ?? '').trim() || todayStamp()
    const { tags, rejected } = normalizeTags(form.tags)

    const t = validateTitle(title)
    if (!t.ok) return back(t.reason, slug || undefined)
    const s = validateSlug(slug)
    if (!s.ok) return back(s.reason, slug || undefined)

    if (action === 'article-create') {
      const avail = checkSlugAvailable(slug)
      // 撞名 → 400，文案**给出占用者标题**；占用者在回收站时要**明说**（`article-rules.ts` 已就位）
      if (!avail.available) return back(slugConflictMessage(slug, { title: avail.title, inTrash: avail.inTrash }), slug)
    } else if (slug !== origSlug) {
      // 表单里那个字段对已有文章是只读的，但**服务端也要拦** —— 前端只读不是规则
      return back('slug 不可修改：对外链接已经发出去了。', origSlug)
    }
    if (rejected.length) {
      return back('标签名不合法：' + rejected.join('、') + '（标签名就是 URL，不能含 /）', slug || undefined)
    }

    const { doc, warnings } = markdownToDoc(markdown)
    const bodyJson = JSON.stringify(doc.toJSON())
    const size = validateBodySize(bodyJson)
    if (!size.ok) return back(size.reason, slug || undefined)

    const existing = action === 'article-create' ? undefined : getArticleForAdmin(origSlug)
    const result = upsertArticleWithRevision({
      slug,
      title,
      body: bodyJson,
      summary: summary || null,
      date,
      tags: JSON.stringify(tags),
      // **新建一律草稿**（票面的第一条规矩）；保存**不改状态** —— 发布是另一个动作
      draft: existing ? existing.draft : 1,
      now: Date.now(),
    })
    if (warnings.length) console.warn('[articles] 转换告警：' + warnings.slice(0, 3).join('；'))
    console.log('[articles] ' + result + ' ' + slug + (existing ? '' : '（新建，默认草稿）'))
    const notice = action === 'article-create' ? 'article-created' : 'article-saved'
    return reply.redirect('/admin/articles?edit=' + encodeURIComponent(slug) + '&notice=' + notice, 302)
  })

  // ── 媒体服务（#52）──────────────────────────────────────

  /**
   * `GET /media/<name>` —— 媒体服务（规格 [#41](https://github.com/Lkyloveaw/lkyloveaw-home/issues/41)）。
   *
   * - **不在 `PUBLIC_PATHS` 里**：永远在登录闸门后 —— 与文章**同一条可见性边界**（未登录看到的
   *   和文章一样是「去登录」，不是一个能白拿图片的口子）。
   * - 名字先过 `isSafeMediaName`：**拒 `../`、拒编码斜杠、拒 `.svg`** —— 目录穿越在**形状**这一层就断了，
   *   不靠 `path.join` 自觉（它会把 `..` 老老实实拼上去）。
   * - 不合法或不存在 → **404**（不是 500、不是目录列表、不是 Fastify 默认 JSON）。
   * - `nosniff`：被替换的文件不会被当脚本执行。
   * - **长缓存**：文件名就是内容哈希，内容**永不改变**（改图 = 新文件 + 新 URL）。
   *   这一行会覆盖 `onRequest` 里那句全局 `no-store` —— 那是**有意的**：动态页面不进共享缓存，
   *   而内容寻址的媒体**恰恰应该**被长期缓存。
   */
  app.get('/media/:name', async (req, reply) => {
    const name = (req.params as { name: string }).name
    const mime = mediaMime(name)
    if (!mime) {
      reply.code(404).type('text/plain; charset=utf-8')
      return 'not found'
    }
    let buf: Buffer
    try {
      buf = fs.readFileSync(mediaPath(name))
    } catch {
      // 名字合法但文件不在（被孤图清理删了、或手工挪走了）—— 同样是 404，不泄漏磁盘状态。
      reply.code(404).type('text/plain; charset=utf-8')
      return 'not found'
    }
    reply
      .type(mime)
      .header('X-Content-Type-Options', 'nosniff')
      .header('Cache-Control', 'public, max-age=31536000, immutable')
    return reply.send(buf)
  })

  /**
   * 上传路由的守卫：**资格 → L3**（与其它写路由同一个顺序）。
   *
   * ⚠ multipart 的 `csrf` 在**字段对象**里（`attachFieldsToBody` 的形状：`{ value: '…' }`），
   * 与 urlencoded 那条路的 `parseFormBody` 不同 —— 所以这里单独读一次。
   * 这也正是规格说的「**L3 必须在任何写之前读到 token**，解析模式决定钩子位置」。
   */
  const uploadGuard = async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (!currentIsAdmin()) {
      reply.code(403).type('text/html; charset=utf-8')
      await reply.send(forbiddenPage('admin', site))
      return
    }
    const raw = (req.body as Record<string, unknown> | undefined)?.csrf
    const submitted = typeof raw === 'string' ? raw : (raw as { value?: string } | undefined)?.value
    if (!verifyCsrf(config.sessionSecret, readSessionCookie(req.headers.cookie), submitted)) {
      console.warn('[media] L3 拒绝上传：token 缺失或不匹配')
      reply.code(403).type('text/html; charset=utf-8')
      await reply.send(forbiddenPage('csrf', site, '/admin/articles'))
    }
  }

  /**
   * `POST /admin/articles/media` —— 上传一张图（规格 [#41](https://github.com/Lkyloveaw/lkyloveaw-home/issues/41)）。
   *
   * 契约：`multipart/form-data`、**一次一个文件**、字段名 `file`、CSRF 字段名 `csrf`。
   * 落在**同一鉴权面**内（`uploadGuard`：资格 + L3）—— 不新开第二个鉴权面。
   *
   * **失败一律显眼**：全部走 PRG 回跳 + `notice` 闭集键，**不静默插一个坏链接**。
   */
  app.post('/admin/articles/media', { preValidation: uploadGuard }, async (req, reply) => {
    const file = (req.body as Record<string, unknown> | undefined)?.file as
      | { toBuffer?: () => Promise<Buffer>; filename?: string }
      | undefined
    if (!file || typeof file.toBuffer !== 'function') {
      console.warn('[media] 上传请求里没有文件字段')
      return reply.redirect('/admin/articles?notice=media-no-file', 302)
    }

    let buf: Buffer
    try {
      // 超过 `limits.fileSize` 且 `throwFileSizeLimit` 为真时，这里会抛（**不截断**）。
      buf = await file.toBuffer()
    } catch (err) {
      console.warn('[media] 读取上传内容失败：' + (err as Error).message)
      return reply.redirect('/admin/articles?notice=media-too-big', 302)
    }

    try {
      const saved = saveMedia(buf)
      console.log('[media] ' + (saved.created ? '已保存' : '已存在') + ' ' + saved.name)
      // 回跳带上文件名 —— 它的形状**受 `isSafeMediaName` 校验**，所以它不是「URL 里的自由文本」。
      const notice = saved.created ? 'media-uploaded' : 'media-duplicate'
      return reply.redirect('/admin/articles?notice=' + notice + '&uploaded=' + encodeURIComponent(saved.name), 302)
    } catch (err) {
      // 类型不对 / 空文件 / 超限 —— 全都在 `saveMedia` 里判掉，这里只负责**显眼地**说出去。
      console.warn('[media] 拒绝：' + (err as Error).message)
      return reply.redirect('/admin/articles?notice=media-rejected', 302)
    }
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
