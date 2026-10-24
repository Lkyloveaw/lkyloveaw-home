/**
 * HTTP 层：路由 + 组装页面数据 + 登录闸门。
 * 一台进程同时负责页面渲染和周期探测，部署时就只有一个 systemd 服务、一个数据目录。
 */
import fs from 'node:fs'
import path from 'node:path'
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify'
import fastifyStatic from '@fastify/static'
import fastifyMultipart from '@fastify/multipart'
import { assertSessionSecret, assertSiteOrigins, assertTrustProxy, config, normalizeTargets, validateTargetUrl, type ProbeTarget } from './config.js'
import {
  getPublishedPost,
  importArticlesIfEmpty,
  listPublishedPosts,
  listTags,
  warnContentDirIsNoLongerInput,
} from './content.js'
import { getIncidentEvents, getUptimeRaw, getStats, getTimeline, getLatencyRaw, getLatestStatuses, initStore, closeStore, sanitizeStoredErrors } from './store.js'
import {
  countAllTargets,
  countEnabledTargets,
  createTarget,
  initTargets,
  listAllTargets,
  listEnabledTargets,
  purgeTarget,
  removeOrDisableTarget,
  setTargetEnabled,
  updateTarget,
  warnTargetsFileIsNoLongerInput,
  type TargetRecord,
} from './targets-store.js'
import { getArticleForAdmin, listArticlesForAdmin, upsertArticleWithRevision } from './store.js'
import { listTrashedArticles, purgeArticle, restoreArticle, trashArticle } from './store.js'
import { listRevisions, revertToRevision } from './store.js'
import { isSafeMediaName, MEDIA_MAX_BYTES, mediaMime, mediaPath, mediaSnippet } from './media.js'
import { getIdentityImage, setIdentityImage, type IdentityImageKey } from './identity-images.js'
import { listFriendLinks, saveFriendLink, deleteFriendLink, setFriendLinkIcon, type FriendLink } from './friend-links.js'
import { toPublicSummary } from './public-summary.js'
import { readFormField, receiveImageUpload } from './upload-image.js'
import { startProbing, stopProbing } from './probe.js'
import { listBackupFiles, listBackups, runBackup } from './backup.js'
import {
  getProbeIntervalSeconds,
  getSiteDescription,
  getSiteTitle,
  initSettings,
  listSettings,
  SETTINGS_SPEC,
  setSetting,
  specOf,
  getSettingRaw,
  validateSettingValue,
} from './settings-store.js'
import {
  countEnabledAdmins,
  countUsers,
  createUser,
  ensureFirstUserFromEnv,
  findById,
  initUsers,
  listUsers,
  MIN_PASSWORD_LENGTH,
  setEnabled,
  setPassword,
  setRole,
  verifyPassword,
} from './users.js'
import { decodeSid, issueSession, isSafeNextPath, readSessionCookie, sessionCookieHeader } from './session.js'
import { createSession, revokeSession } from './sessions-store.js'
import { decideRequest, deny, isKnownPath, logoutHeader, requireAdmin } from './auth.js'
import { checkOrigin, csrfContext, csrfToken, currentIsAdmin, currentUserId, verifyCsrf } from './csrf.js'
import { docToMarkdown } from './article-import.js'
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
  accountPage,
  adminAccountsPage,
  adminArticlesPage,
  adminBackupsPage,
  adminOverviewPage,
  adminSettingsPage,
  adminTargetsPage,
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
  type PublicSidebar,
  type StatusSummary,
} from './views.js'

const WINDOW_MS = 24 * 60 * 60 * 1000
const WINDOW_LABEL = '最近 24 小时'

/** 安全方法不进 L2：它们不改状态（`GET` 全只读是本仓的**设计约束**，不是巧合）。 */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

/**
 * 站点的呈现信息：**每请求从库里读一次**（`docs/settings-source-decision.md` §6.1）。
 *
 * ⚠ 原来是模块加载时求值的 `const site = {...}`，被十几个路由共享 —— 那样标题改完之后
 * **有的页面变、有的不变**（取决于那个路由何时求值），正是本仓最防的那种静默失败。
 * 所以这里没有任何缓存：一次单表主键 SELECT 是微秒级，而缓存要引入失效逻辑。
 */
function siteOf(): { title: string; description: string; logo: string | null; friendLinks: FriendLink[] } {
  return { title: getSiteTitle(), description: getSiteDescription(), logo: getIdentityImage('site-logo'), friendLinks: listFriendLinks() }
}

/** 公开文章侧栏的数据：只传 slug / title；当前文章页再传 currentSlug。 */
function sidebarOf(posts: Array<{ slug: string; title: string }>, currentSlug?: string): PublicSidebar {
  return { posts: posts.map(({ slug, title }) => ({ slug, title })), ...(currentSlug ? { currentSlug } : {}) }
}

/**
 * 概览页的四块摘要（`docs/admin-console-ia-decision.md` §6.1）。
 *
 * **一律现算**：不落库、不缓存 —— 计数是「一眼的状态」，不是账本，
 * 与列表在极短窗口内相差一两条可接受。数据来源：目标与（将来的）设置读库，
 * 账号读 `listUsers()`、备份读 `backup.ts` —— ④⑤⑥⑦ 各自把自己那一块换成库。
 */
function buildAdminOverview(): AdminOverview {
  // 目标清单**只读一次**，四个数字都从同一个数组里算（同一请求内不许出现两个口径）。
  const targets = listAllTargets()
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
      enabled: targets.filter((t) => t.enabled).length,
      total: targets.length,
      groups: new Set(targets.map((t) => t.group ?? '未分组')).size,
    },
    accounts: {
      total: users.length,
      admins: users.filter((u) => u.role === 'admin').length,
      disabled: users.filter((u) => u.enabled !== 1).length,
    },
    // 「今天是否已备份」看文件名里的日期戳（备份文件就叫 `YYYY-MM-DD.sqlite`）。
    backup: { latest, latestAt, doneToday: latest === `${today}.sqlite` },
    settings: {
      // 概览页这一块显示的是**当前生效值**，所以走 `settings-store`（真源是数据库）。
      title: getSiteTitle(),
      description: getSiteDescription(),
      intervalSeconds: getProbeIntervalSeconds(),
    },
    // 零管理员：**每次渲染现算** —— 启动日志只在重启时看得到，概览页才是它的常驻位置。
    zeroAdmins: users.length > 0 && countEnabledAdmins() === 0,
  }
}

/**
 * 汇总面板需要的数据。每次请求现算：SQLite 聚合在这个数据量下是毫秒级，不值得再加缓存层。
 *
 * ⚠ **目标清单只读一次**（`docs/targets-source-decision.md` §7 那条警告的落点）：
 * 同一个数组既喂 `buildSummary` 的卡片，又喂 `getUptimeRaw()` 的「期望目标数」。
 * 若两处各读一次，可用率曲线的口径就可能与卡片分叉 ——
 * 表现为「曲线上少了几个点」这种没人会立刻发现的偏差。
 */
function buildSummary(): StatusSummary {
  const targets = listEnabledTargets()
  const now = Date.now()
  const interval = getProbeIntervalSeconds()
  const freshness = (target: ProbeTarget) => interval * 3000 + (target.timeoutMs ?? config.probeTimeoutMs)
  return {
    targets: targets.map((target) => ({
      target,
      // `enabledAt` 给「连续可用时长」设下界（§5）：停用再启用后从重新启用那一刻算起。
      stats: getStats(target.id, WINDOW_MS, target.enabledAt, freshness(target), now),
      timeline: getTimeline(target.id, WINDOW_MS, 56),
      latency: getLatencyRaw(target.id, WINDOW_MS, 120, freshness(target), now),
    })),
    overview: getUptimeRaw(WINDOW_MS, targets.length, 120, Math.max(interval * 3000, ...targets.map(freshness)), now),
    incidents: getIncidentEvents(WINDOW_MS, targets.map(t => ({ id: t.id, enabledAt: t.enabledAt, maxGapMs: freshness(t) })), now),
    generatedAt: now,
    windowStartAt: now - WINDOW_MS,
    windowLabel: WINDOW_LABEL,
    // 面板上写「每 N 秒自动刷新」用的是它 —— 这里读的是**库里的配置值**，
    // 而不是「刚过去那一轮的间隔」。改完后的一个间隔内两者可能不一致，这是对的（§4 末段）。
    probeIntervalSeconds: interval,
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

/** 单目标超时的上界（毫秒）。全局默认 5 秒、`targets.json` 的示例最多 8 秒，60 秒留足余量。 */
const TARGET_TIMEOUT_MAX_MS = 60000

interface TargetFormFields {
  id: string
  name: string
  url: string
  group?: string
  expectStatus?: number[]
  timeoutMs?: number
  /** 只有「新增」用得上；编辑不动启用状态（那是 `target-enable` / `target-disable` 的事）。 */
  enabled: boolean
}

type TargetFormParse = { ok: true; value: TargetFormFields } | { ok: false; message: string }

/**
 * 目标表单的**字段校验**（`docs/write-path-auth-decision.md` §5.3 的第 6 步）。
 *
 * ⚠ URL 复用 `config.validateTargetUrl()`、整条形状最后再过一遍 `config.normalizeTargets()` ——
 * **不在这里重写一套**（`docs/targets-source-decision.md` §8）：重写会让「文件里被拒的 URL
 * 在网页上能存进去」（协议白名单、URL 里的凭证、缺字段三条都会漏）。
 * 上面那些逐字段检查只为了一件事：**给人话的报错**（它会原样出现在顶部的 `notice-bad` 横幅里）。
 */
function parseTargetForm(form: Record<string, string>, requireId: boolean): TargetFormParse {
  const id = String(form.id ?? '').trim()
  const name = String(form.name ?? '').trim()
  const url = String(form.url ?? '').trim()

  if (requireId && !id) return { ok: false, message: 'id 不能为空。' }
  if (!name) return { ok: false, message: '名称不能为空。' }
  if (!url) return { ok: false, message: 'URL 不能为空。' }
  const reason = validateTargetUrl(url)
  if (reason) return { ok: false, message: `URL 不合规：${reason}` }

  const rawCodes = String(form.expectStatus ?? '').trim()
  let expectStatus: number[] | undefined
  if (rawCodes) {
    const parts = rawCodes.split(',').map((s) => s.trim()).filter(Boolean)
    const codes = parts.map((p) => Number(p))
    // ⚠ 上界是 **999 而不是 599**：导入路径不校验这个区间，而 `targets.json` 的演示条目
    // 与测试都用一个「永不匹配」的哨兵值（`demo-degraded` 就是 `[999]`）。
    // 写路径若只收 100–599，那条目标就**永远存不回去** —— 改个名字也会被 400 拒掉。
    // 100–599 是真实 HTTP 状态码；600 以上只可能是哨兵。
    if (!codes.length || codes.some((n) => !Number.isInteger(n) || n < 100 || n > 999)) {
      return {
        ok: false,
        message: `状态码只能是 100–999 的整数、逗号分隔（收到：${rawCodes}）。100–599 是真实状态码；600 以上只用于「永不匹配」。`,
      }
    }
    // 去重：`200,200` 与 `200` 是同一件事，没必要让库里的 JSON 记住重复项。
    expectStatus = [...new Set(codes)]
  }

  const rawTimeout = String(form.timeoutMs ?? '').trim()
  let timeoutMs: number | undefined
  if (rawTimeout) {
    const n = Number(rawTimeout)
    if (!Number.isInteger(n) || n < 1 || n > TARGET_TIMEOUT_MAX_MS) {
      return {
        ok: false,
        message: `超时只能是 1–${TARGET_TIMEOUT_MAX_MS} 的整数毫秒（收到：${rawTimeout}）。`,
      }
    }
    timeoutMs = n
  }

  // 最后以**既有校验器**为准（`normalizeTargets()`：缺 id/name/url、URL 合规、id 唯一一站式）。
  // 走到这里它不该再拒绝任何东西；真拒了说明上面漏了一条 —— 那也要**显眼地 400**，不能悄悄存进去。
  const [normalized] = normalizeTargets([
    {
      id,
      name,
      url,
      group: String(form.group ?? '').trim(),
      expectStatus,
      timeoutMs,
      enabled: form.enabled === 'yes',
    },
  ])
  if (!normalized) {
    return { ok: false, message: '这条目标没通过校验：请检查 id / 名称 / URL。' }
  }
  return { ok: true, value: { ...normalized, enabled: normalized.enabled !== false } }
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
  // 目标清单的真源是 SQLite（`docs/targets-source-decision.md` §2）：
  // **表为空时**才从 targets.json / TARGETS_JSON 导入一次，此后文件被完全忽略（只打一行警告）。
  initTargets()
  warnTargetsFileIsNoLongerInput()
  // 设置的首次落值（`docs/settings-source-decision.md` §2）：**库里有行就什么都不做**，
  // 所以升级不会覆盖用户在网页上改过的任何东西；`.env` 从此只作首次值的来源。
  initSettings()
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
        return reply.send(forbiddenPage('origin', siteOf()))
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
    // `userId` 一并进上下文：#44 的账号页要它来判「这一行是不是你自己」，
    // 写路径把它当 `actorId` 交给 users.ts 的守卫（**不重复查库**）。
    csrfContext.enterWith({
      token: csrf,
      isAdmin: decision.role === 'admin',
      userId: decision.userId,
      userName: decision.username ?? '',
      avatar: decision.userId === undefined ? null : getIdentityImage(`avatar:${decision.userId}`),
    })
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
    const submitted = readFormField(req.body, 'csrf')
    if (!verifyCsrf(config.sessionSecret, readSessionCookie(req.headers.cookie), submitted)) {
      // 记 path 与失败原因，**不记 token 值**（OWASP 明文要求 token 不进日志）。
      console.warn(`[auth] L3 拒绝：path=${req.url}（token 缺失或不匹配）`)
      reply.code(403).type('text/html; charset=utf-8')
      await reply.send(forbiddenPage('csrf', siteOf(), req.url.split('?')[0] === '/admin/articles/media' ? '/admin/articles' : req.url))
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
      return forbiddenPage('admin', siteOf())
    }
    reply.type('text/html; charset=utf-8')
    // `?notice=<key>` 原样交给视图：**闭集判定在 views 里**（未知 key 什么都不渲染），
    // 路由不解释它 —— 否则「哪些 key 有效」会长出第二份名单。
    const query = req.query as { notice?: unknown }
    return adminOverviewPage(buildAdminOverview(), siteOf(), query.notice)
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
          // 编辑器的初次内容 = 库里的**文档 JSON 原文**；400 回填时用用户刚提交的那份。
          bodyJson: sub?.body_json ?? row.body,
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
          bodyJson: sub?.body_json ?? '',
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
      siteOf(),
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
      await reply.send(forbiddenPage('admin', siteOf()))
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
  app.setErrorHandler(async (err: Error & { code?: string }, req, reply) => {
    const code = err.code ?? ''
    if (code === 'FST_REQ_FILE_TOO_LARGE' || code === 'FST_FILES_LIMIT' || /file size limit|too large/i.test(err.message)) {
      console.warn('[media] 上传被拒（超过上限）：' + err.message)
      const pathname = req.url.split('?')[0] ?? ''
      const back = pathname === '/account/avatar' ? '/account'
        : pathname === '/admin/settings/logo' || pathname.startsWith('/admin/settings/friends/') ? '/admin/settings' : '/admin/articles'
      return reply.redirect(back + '?notice=media-too-big', 302)
    }
    console.error('[server] 未处理的请求错误：', err.message)
    reply.code(500).type('text/plain; charset=utf-8')
    return '服务器内部错误'
  })

  for (const image of [
    { path: '/account/avatar', back: '/account', kind: 'avatar', admin: false },
    { path: '/admin/settings/logo', back: '/admin/settings', kind: 'logo', admin: true },
  ]) {
    app.post(image.path, { preValidation: image.admin ? adminWriteGuard : csrfGuard }, async (req, reply) => {
      const userId = currentUserId()
      if (userId === undefined) return reply.code(401).send('请先登录')
      const owner: IdentityImageKey = image.admin ? 'site-logo' : `avatar:${userId}`
      const action = readFormField(req.body, 'action')
      if (action === 'clear') {
        setIdentityImage(owner, null)
        return reply.redirect(image.back + '?notice=' + image.kind + '-cleared', 302)
      }
      if (action !== undefined && action !== 'upload') return reply.code(400).send('未知的动作')
      const uploaded = await receiveImageUpload(req.body)
      if (!uploaded.ok) return reply.redirect(image.back + '?notice=' + uploaded.notice, 302)
      setIdentityImage(owner, uploaded.name)
      return reply.redirect(image.back + '?notice=' + image.kind + '-saved', 302)
    })
  }

  app.get('/admin/articles', async (req, reply) => {
    if (!currentIsAdmin()) {
      reply.code(403).type('text/html; charset=utf-8')
      return forbiddenPage('admin', siteOf())
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
    const bodyJsonRaw = String(form.body_json ?? '')
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

    // 正文是**文档 JSON**（#34/#57）：编辑器把 hidden 字段同步成它。畸形输入 → 400（不是 500）。
    let bodyJson: string
    try {
      const doc = docFromJson(JSON.parse(bodyJsonRaw))
      // 用 schema **归一化**：TipTap 的额外属性（link.target/rel、image.width/height、cell.align…）
      // 在这里被丢掉 —— 存进库的永远是闭集 schema 认的那一份。
      bodyJson = JSON.stringify(doc.toJSON())
    } catch (err) {
      return back('正文不是合法的文档 JSON：' + (err as Error).message, slug || undefined)
    }
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

  /** 文章图片与身份图片共用读取、校验及错误分类，引用与回跳留在路由。 */
  app.post('/admin/articles/media', { preValidation: adminWriteGuard }, async (req, reply) => {
    const uploaded = await receiveImageUpload(req.body)
    if (!uploaded.ok) return reply.redirect('/admin/articles?notice=' + uploaded.notice, 302)
    console.log('[media] ' + (uploaded.created ? '已保存' : '已存在') + ' ' + uploaded.name)
    const notice = uploaded.created ? 'media-uploaded' : 'media-duplicate'
    const editSlug = readFormField(req.body, 'edit_slug') ?? ''
    const backTo = editSlug && getArticleForAdmin(editSlug) ? '?edit=' + encodeURIComponent(editSlug) + '&' : '?'
    return reply.redirect('/admin/articles' + backTo + 'notice=' + notice + '&uploaded=' + encodeURIComponent(uploaded.name), 302)
  })

  // ── 管理台 · 目标（#40）──────────────────────────────────

  /**
   * 目标的 `action` **闭集**（`docs/write-path-auth-decision.md` §5.3 第 5 步）。
   *
   * ⚠ 里面**没有**「改 id」这个动作：`id` 是历史库的关联键（`docs/targets-source-decision.md` §3），
   * 换 id 要在页面上走「新增一个 + 停用旧的」两步。没有的动作就是 400。
   */
  const TARGET_ACTIONS = new Set([
    'target-create',
    'target-update',
    'target-enable',
    'target-disable',
    'target-delete',
    'target-purge',
  ])

  /** 页面数据：清单与状态点**各读一次**（两个 map 一次请求，不给列表逐行查库）。 */
  const buildTargetsPage = (opts: {
    notice?: unknown
    bad?: string | null
    submitted?: Record<string, string> | null
  }): string => adminTargetsPage(listAllTargets(), { ...opts, statuses: getLatestStatuses() }, siteOf())

  app.get('/admin/targets', async (req, reply) => {
    // 资格用闸门刚算出来的那个角色（请求上下文里）—— 不重复查库；拿不到即非管理员 → 403（fail-closed）。
    if (!currentIsAdmin()) {
      reply.code(403).type('text/html; charset=utf-8')
      return forbiddenPage('admin', siteOf())
    }
    const query = req.query as { notice?: unknown }
    reply.type('text/html; charset=utf-8')
    return buildTargetsPage({ notice: query.notice })
  })

  app.post('/admin/targets', { preValidation: adminWriteGuard }, async (req, reply) => {
    const form = parseFormBody(req.body)
    const action = String(form.action ?? '')
    // 失败一律 **400 + 就地重渲染**（顶部横幅 + 保留刚填的输入），成功才 302 + 闭集 notice（#23 §4.1/§4.2）。
    const back = (bad: string): unknown => {
      reply.code(400).type('text/html; charset=utf-8')
      return buildTargetsPage({ bad, submitted: form })
    }

    if (!TARGET_ACTIONS.has(action)) return back('未知的动作，已拒绝。')

    const id = String(form.id ?? '').trim()

    // 启用 / 停用：只认 id + 对象在不在（没有别的字段可校验）。
    if (action === 'target-enable' || action === 'target-disable') {
      if (!id) return back('缺少 id。')
      const enabled = action === 'target-enable'
      const n = setTargetEnabled(id, enabled)
      if (n !== 1) return back(`找不到这个目标：${id}`)
      console.log(`[targets] ${enabled ? '启用' : '停用'} ${id}`)
      return reply.redirect(
        `/admin/targets?notice=${enabled ? 'target-enabled' : 'target-disabled'}`,
        302,
      )
    }

    // 删除：**两岔由库里有没有历史决定**（§4）。页面上的按钮文案用的是同一条判据，
    // 所以用户看到的「删除」与这里真做的事永远一致。
    if (action === 'target-delete') {
      if (!id) return back('缺少 id。')
      const out = removeOrDisableTarget(id)
      if (out === 'missing') return back(`找不到这个目标：${id}`)
      console.log(`[targets] ${out === 'deleted' ? '删除' : '停用（有历史，不删）'} ${id}`)
      return reply.redirect(
        `/admin/targets?notice=${out === 'deleted' ? 'target-deleted' : 'target-disabled'}`,
        302,
      )
    }

    // 「删除并清空历史」：**唯一的逃生口**（§4 的显式例外）。必须勾确认框，
    // 服务端独立校验 —— 与「重置口令」同一档，不依赖前端的 `required`。
    if (action === 'target-purge') {
      if (!id) return back('缺少 id。')
      if (form.confirm !== 'yes') {
        return back('删除并清空历史不可恢复，请先勾选确认框。')
      }
      const out = purgeTarget(id)
      if (out.status === 'missing') return back(`找不到这个目标：${id}`)
      console.log(`[targets] 删除并清空历史 ${id}（${out.probes} 条探测记录）`)
      return reply.redirect('/admin/targets?notice=target-purged', 302)
    }

    // 字段校验（第 6 步）—— URL 复用 `config.validateTargetUrl()`，**不在这里重写一份**。
    const parsed = parseTargetForm(form, action === 'target-create')
    if (!parsed.ok) return back(parsed.message)
    const fields = parsed.value

    if (action === 'target-create') {
      const out = createTarget(fields)
      // 「先查再插」是 TOCTOU 的形状；这里靠主键约束兜底（§6.1）。
      if (out === 'duplicate') {
        return back(`id 已存在：${fields.id} —— id 不可改，要换 id 就新增一个再停用旧的。`)
      }
      console.log(`[targets] 新增 ${fields.id}`)
      return reply.redirect('/admin/targets?notice=target-saved', 302)
    }

    // `target-update`：对象守卫在字段之后（第 7 步）—— 否则「找不到这个目标」
    // 会淹没在「URL 没填」里（§5.3 的顺序理由）。
    const n = updateTarget(fields.id, fields)
    if (n !== 1) return back(`找不到这个目标：${fields.id}`)
    console.log(`[targets] 保存 ${fields.id}`)
    return reply.redirect('/admin/targets?notice=target-saved', 302)
  })

  // ── 管理台 · 站点设置（#42）──────────────────────────────

  /**
   * 设置的 `action` **闭集**（`docs/write-path-auth-decision.md` §5.3 第 5 步）。
   * 三个字段一次提交（是同一张表单），所以这里只有一个动作。
   */
  const SETTINGS_ACTIONS = new Set(['settings-save'])

  /**
   * 留在 `.env` 里的那些（页面上**只读展示**，`docs/settings-source-decision.md` §0）。
   *
   * ⚠ **绝不渲染 `SESSION_SECRET` 的值** —— 只列名字。密钥进不了页面，与它进不进库是同一条纪律。
   */
  const envOnlyFacts = (): Array<{ label: string; value: string; note: string }> => [
    { label: '单次探测超时', value: `${config.probeTimeoutMs} ms`, note: '它决定单次探测的成败判定，改错会让全站误报 —— 留在 .env' },
    { label: '历史保留天数', value: `${config.retentionDays} 天`, note: '它会**删数据**（超期清理），不是展示参数 —— 留在 .env' },
    { label: '备份目录 / 保留份数', value: '见「备份」页', note: '它们决定文件写在哪、删几份 —— 留在 .env' },
    {
      label: '会话与来源安全参数',
      value: 'SESSION_SECRET · SESSION_TTL_SECONDS · SESSION_COOKIE_SECURE · SITE_ORIGIN · TRUST_PROXY',
      note: '安全判据与签名密钥 —— 留在 .env（这里只列名字，不显示值）',
    },
  ]

  const buildSettingsPage = (opts: {
    notice?: unknown
    bad?: string | null
    submitted?: Record<string, string> | null
    friendBad?: string | null
    friendSubmitted?: Record<string, string> | null
  }): string => adminSettingsPage(listSettings(), envOnlyFacts(), opts, siteOf(), listFriendLinks())

  app.post('/admin/settings/friends', { preValidation: adminWriteGuard }, async (req, reply) => {
    const form = parseFormBody(req.body)
    const back = (bad: string): string => {
      reply.code(400).type('text/html; charset=utf-8')
      return buildSettingsPage({ friendBad: bad, friendSubmitted: form })
    }
    if (!['save', 'delete'].includes(form.action ?? '')) return back('未知的友联操作。')
    const id = form.id ? Number(form.id) : undefined
    if (form.id && (!/^[1-9]\d*$/.test(form.id) || !Number.isSafeInteger(id))) return back('友联编号不合法，请刷新页面。')
    if (form.action === 'delete') {
      if (id === undefined || !deleteFriendLink(id)) return back('找不到这条友联，请刷新页面。')
    } else {
      try {
        saveFriendLink({ name: form.name ?? '', url: form.url ?? '', description: form.description, sortOrder: form.sortOrder }, id)
      } catch (err) { return back((err as Error).message) }
    }
    return reply.redirect('/admin/settings?notice=friend-saved#friend-links-admin', 302)
  })

  app.post('/admin/settings/friends/:id/icon', { preValidation: adminWriteGuard }, async (req, reply) => {
    const rawId = (req.params as { id: string }).id
    const id = Number(rawId)
    if (!/^[1-9]\d*$/.test(rawId) || !Number.isSafeInteger(id) || !listFriendLinks().some(link => link.id === id)) {
      return reply.code(404).send('找不到这条友联，请刷新页面。')
    }
    const back = (notice: string) => reply.redirect(`/admin/settings?notice=${notice}#friend-links-admin`, 302)
    const action = readFormField(req.body, 'action')
    if (action === 'clear') {
      setFriendLinkIcon(id, null)
      return back('friend-saved')
    }
    if (action !== 'upload') return reply.code(400).send('未知的友联图片操作。')
    const uploaded = await receiveImageUpload(req.body)
    if (!uploaded.ok) return back(uploaded.notice)
    // 上传期间条目可能被另一个请求删除；不把它重新创建出来。
    if (!listFriendLinks().some(link => link.id === id)) return reply.code(404).send('这条友联已删除，请刷新页面。')
    setFriendLinkIcon(id, uploaded.name)
    return back('friend-saved')
  })

  app.get('/admin/settings', async (req, reply) => {
    if (!currentIsAdmin()) {
      reply.code(403).type('text/html; charset=utf-8')
      return forbiddenPage('admin', siteOf())
    }
    const query = req.query as { notice?: unknown }
    reply.type('text/html; charset=utf-8')
    return buildSettingsPage({ notice: query.notice })
  })

  app.post('/admin/settings', { preValidation: adminWriteGuard }, async (req, reply) => {
    const form = parseFormBody(req.body)
    const action = String(form.action ?? '')
    const back = (bad: string): unknown => {
      reply.code(400).type('text/html; charset=utf-8')
      return buildSettingsPage({ bad, submitted: form })
    }
    if (!SETTINGS_ACTIONS.has(action)) return back('未知的动作，已拒绝。')

    // 字段校验（第 6 步）：逐键走 `SETTINGS_SPEC` 的区间，**先把三个字段都验完再写**，
    // 否则「标题存进去了、间隔被拒」会让用户以为整张表都没生效（实际上是半生效）。
    // 传 `getSettingRaw(spec.key)` 是「不改就不拦」那条例外（库里可能有低于表单下界的值）。
    const next: Array<{ key: (typeof SETTINGS_SPEC)[number]['key']; value: string }> = []
    for (const spec of SETTINGS_SPEC) {
      const raw = String(form[spec.key] ?? '').trim()
      const bad = validateSettingValue(spec.key, raw, getSettingRaw(spec.key))
      if (bad) return back(bad)
      next.push({ key: spec.key, value: raw })
    }
    for (const { key, value } of next) setSetting(key, value)
    console.log(
      `[settings] 已保存：${next.map((n) => `${n.key}=${n.value}`).join(' · ')}` +
        `（探测间隔下一轮生效）`,
    )
    return reply.redirect('/admin/settings?notice=settings-saved', 302)
  })

  // ── 管理台 · 备份（#43）────────────────────────────────

  /**
   * 手动备份的 `action` 闭集（只有一个动作：这张页面上没有别的写操作）。
   */
  const BACKUP_ACTIONS = new Set(['backup-now'])

  /**
   * **进程内的重入守卫**（`docs/settings-source-decision.md` §5）。
   *
   * 为什么不引真正的锁：`runBackup()` 先写 `.tmp` 再改名，同时跑两次的结果是
   * 「一个成功、另一个搬同一个库」—— **不会损坏已有产物**。加文件锁/行锁换来的正确性提升，
   * 抵不过它引入的失败模式（锁没释放 = 备份永久停摆）。
   */
  let backupRunning = false

  /**
   * 最近一次手动备份的失败原因（**进程内记忆，重启即清空**）。
   *
   * 它不是审计、也不落库：只是让「失败」在屏幕上留一行**真正的原因**，
   * 而不是让用户对着「备份失败」四个字去猜（失败要显眼，是本仓的既有取舍）。
   */
  let lastBackupError: string | null = null

  const buildBackupsPage = (opts: {
    notice?: unknown
    bad?: string | null
  }): string => {
    const listing = listBackupFiles()
    return adminBackupsPage(
      listing.files,
      {
        ...opts,
        missing: listing.missing,
        unreadable: listing.unreadable,
        listingNote: listing.note,
        lastError: lastBackupError,
        backupDir: config.backupDir,
        backupKeep: config.backupKeep,
      },
      siteOf(),
    )
  }

  app.get('/admin/backups', async (req, reply) => {
    if (!currentIsAdmin()) {
      reply.code(403).type('text/html; charset=utf-8')
      return forbiddenPage('admin', siteOf())
    }
    const query = req.query as { notice?: unknown }
    reply.type('text/html; charset=utf-8')
    return buildBackupsPage({ notice: query.notice })
  })

  app.post('/admin/backups', { preValidation: adminWriteGuard }, async (req, reply) => {
    const form = parseFormBody(req.body)
    const action = String(form.action ?? '')
    if (!BACKUP_ACTIONS.has(action)) {
      reply.code(400).type('text/html; charset=utf-8')
      return buildBackupsPage({ bad: '未知的动作，已拒绝。' })
    }
    if (backupRunning) {
      return reply.redirect('/admin/backups?notice=backup-running', 302)
    }

    backupRunning = true
    try {
      const r = await runBackup()
      /*
       * ⚠ **看 `ok`，不是看 `note` 有没有内容**（票面点名的坑）：
       * 「今天已备份过，跳过」在 `runBackup()` 里是 **`ok: true` + note**，
       * 而成功时的 note 也常有内容（「清理了 N 份旧备份」）。
       * 所以判据是 `ok` 决定成败、`note` 只用来**分型**（跳过 / 真产出）。
       */
      if (!r.ok) {
        lastBackupError = r.note ?? '未知原因'
        console.error(`[backup] 手动备份失败：${lastBackupError}`)
        // 用 200 而不是 400：请求本身没问题，是**这台机器上的操作失败**了（400 会说成用户的错）。
        reply.type('text/html; charset=utf-8')
        return buildBackupsPage({ notice: 'backup-failed' })
      }
      lastBackupError = null
      const skipped = /跳过/.test(r.note ?? '')
      console.log(
        `[backup] 手动备份：${skipped ? '今天已有可用产物，跳过' : `产出 ${r.file}（${r.bytes} B，${r.rows} 行）`}`,
      )
      return reply.redirect(`/admin/backups?notice=${skipped ? 'backup-skipped' : 'backup-started'}`, 302)
    } finally {
      backupRunning = false
    }
  })

  // ── 管理台 · 账号（#44）────────────────────────────────

  /**
   * 账号的 `action` **闭集**（`docs/write-path-auth-decision.md` §5.3 第 5 步）。
   * 五个动作对应 §6.3 的四件事：新增 · 改角色 · 启停 · 重置口令（**没有删除账号**）。
   */
  const ACCOUNT_ACTIONS = new Set([
    'account-create',
    'account-role',
    'account-enable',
    'account-disable',
    'account-reset-password',
  ])

  const buildAccountsPage = (opts: {
    notice?: unknown
    bad?: string | null
    submitted?: Record<string, string> | null
  }): string => {
    const selfId = currentUserId()
    return adminAccountsPage(
      listUsers().map((u) => ({
        id: u.id,
        username: u.username,
        role: u.role,
        enabled: u.enabled === 1,
        tokenVersion: u.token_version,
        isSelf: u.id === selfId,
      })),
      opts,
      siteOf(),
    )
  }

  app.get('/admin/accounts', async (req, reply) => {
    if (!currentIsAdmin()) {
      reply.code(403).type('text/html; charset=utf-8')
      return forbiddenPage('admin', siteOf())
    }
    const query = req.query as { notice?: unknown }
    reply.type('text/html; charset=utf-8')
    return buildAccountsPage({ notice: query.notice })
  })

  app.post('/admin/accounts', { preValidation: adminWriteGuard }, async (req, reply) => {
    const form = parseFormBody(req.body)
    const action = String(form.action ?? '')
    // 失败一律 **400 + 就地重渲染**（保留输入；口令字段永不回填）—— §4.2。
    const back = (bad: string): unknown => {
      reply.code(400).type('text/html; charset=utf-8')
      return buildAccountsPage({ bad, submitted: form })
    }
    if (!ACCOUNT_ACTIONS.has(action)) return back('未知的动作，已拒绝。')

    const actorId = currentUserId()

    // ── 新增（字段全部在对象之前：§5.3 的 5 → 6 → 7）──
    if (action === 'account-create') {
      const username = String(form.username ?? '').trim()
      const password = String(form.password ?? '')
      const again = String(form.password2 ?? '')
      if (!username) return back('用户名不能为空。')
      if (password.length < MIN_PASSWORD_LENGTH) return back(`口令至少 ${MIN_PASSWORD_LENGTH} 位。`)
      if (password !== again) return back('两次输入的口令不一致。')
      try {
        // 角色**不从这里给**：新账号一律只读，提权是另一个显式动作（`docs/roles-decision.md` §4）。
        createUser(username, password)
      } catch (err) {
        return back((err as Error).message) // 用户名重复 / 口令不合规（users.ts 给的是人话）
      }
      console.log(`[accounts] 新增账号 ${username}（只读）`)
      return reply.redirect('/admin/accounts?notice=account-created', 302)
    }

    // ── 其余动作都要一个**存在**的对象 ──
    const idNum = Number(String(form.id ?? '').trim())
    const target = Number.isInteger(idNum) ? findById(idNum) : undefined
    if (!target) return back('找不到这个账号（它可能刚被删掉，刷新看看）。')

    if (action === 'account-role') {
      const role = String(form.role ?? '')
      if (role !== 'admin' && role !== 'readonly') return back('角色只能是「管理员」或「只读」。')
      // §5.1：**降级**要必勾确认框；提权不设卡（恢复通道）。
      if (role === 'readonly' && String(form.confirm ?? '') !== 'yes') {
        return back('降为只读需要勾选确认框：降级后对方下一个请求就进不了管理台。')
      }
      try {
        // ⚠ 守卫在 `users.ts` 里（**网页与 CLI 共用同一个函数**）——这里只调用，不重写一份。
        setRole(target.id, role, actorId)
      } catch (err) {
        return back((err as Error).message)
      }
      console.log(`[accounts] ${target.username} → ${role === 'admin' ? '管理员' : '只读'}`)
      return reply.redirect('/admin/accounts?notice=role-changed', 302)
    }

    if (action === 'account-enable' || action === 'account-disable') {
      const enabled = action === 'account-enable'
      if (!enabled && String(form.confirm ?? '') !== 'yes') {
        return back('停用账号需要勾选确认框：对方下一个请求就会被挡在登录页外。')
      }
      try {
        setEnabled(target.id, enabled, actorId)
      } catch (err) {
        return back((err as Error).message)
      }
      console.log(`[accounts] ${enabled ? '启用' : '停用'}账号 ${target.username}`)
      return reply.redirect(
        `/admin/accounts?notice=${enabled ? 'account-enabled' : 'account-disabled'}`,
        302,
      )
    }

    // ── 重置口令（§6.3：就地输入新口令，不生成随机口令；必勾确认框）──
    const password = String(form.password ?? '')
    const again = String(form.password2 ?? '')
    if (password.length < MIN_PASSWORD_LENGTH) return back(`口令至少 ${MIN_PASSWORD_LENGTH} 位。`)
    if (password !== again) return back('两次输入的口令不一致。')
    if (String(form.confirm ?? '') !== 'yes') {
      return back('重置口令需要勾选确认框：这会让对方所有设备上的登录立刻失效。')
    }
    try {
      // `setPassword` 内部：改哈希 + `token_version + 1` + 级联吊销该账号全部会话（同一事务）。
      setPassword(target.id, password)
    } catch (err) {
      return back((err as Error).message)
    }
    console.log(`[accounts] 重置口令 ${target.username}（该账号全部会话已失效）`)
    return reply.redirect('/admin/accounts?notice=password-reset', 302)
  })

  // ── 登录 / 登出 / 改密 ───────────────────────────────────

  app.get('/login', async (req, reply) => {
    const query = req.query as { next?: string }
    const next = isSafeNextPath(query.next, isKnownPath) ? (query.next as string) : '/'
    reply.type('text/html; charset=utf-8')
    return loginPage({ next, noAccounts: countUsers() === 0 }, siteOf())
  })

  app.post('/login', async (req, reply) => {
    const form = parseFormBody(req.body)
    const next = isSafeNextPath(form.next, isKnownPath) ? form.next! : '/'

    const user = verifyPassword(form.username ?? '', form.password ?? '')
    if (!user) {
      // 不区分「用户不存在」「口令错」「账号已停用」——统一一句提示。
      reply.code(401).type('text/html; charset=utf-8')
      return loginPage({ next, error: '用户名或口令不正确', noAccounts: countUsers() === 0 }, siteOf())
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
      return accountPage({ error: notice }, siteOf())
    }

    if (!verifyPassword(user.username, form.current ?? '')) return fail('当前口令不正确')
    if ((form.next ?? '').length < MIN_PASSWORD_LENGTH) return fail(`新口令至少 ${MIN_PASSWORD_LENGTH} 位`)
    if (form.next !== form.confirm) return fail('两次输入的新口令不一致')

    setPassword(userId, form.next!)
    // 改密已递增 token_version（其他设备全部失配掉线），
    // 这里用**新版本**重新签发，自己才不会掉线。
    setSession(reply, userId, tokenVersionOf(userId))
    return reply.redirect('/account?notice=password-changed', 302)
  })

  // ── 页面 ────────────────────────────────────────────────

  app.get('/', async (_req, reply) => {
    const all = listPublishedPosts()
    reply.type('text/html; charset=utf-8')
    return homePage(all, buildSummary(), siteOf(), sidebarOf(all))
  })

  app.get('/posts', async (_req, reply) => {
    const all = listPublishedPosts()
    reply.type('text/html; charset=utf-8')
    return postsPage(all, listTags(), siteOf(), sidebarOf(all))
  })

  app.get('/tags/:tag', async (req, reply) => {
    const tag = decodeURIComponent((req.params as { tag: string }).tag)
    const all = listPublishedPosts()
    const posts = all.filter((p) => p.tags.includes(tag))
    reply.type('text/html; charset=utf-8')
    return postsPage(posts, listTags(), siteOf(), sidebarOf(all), `标签：${tag}`, tag)
  })

  app.get('/posts/:slug', async (req, reply) => {
    // ⚠ **必须解码**，与 /tags/:tag 对齐。少了这一步，「slug 允许中文」就是假的：
    // /posts/中文slug 会 404，而库里明明有那一篇（研究 §2.2 记过这个不对称）。
    const all = listPublishedPosts()
    const post = getPublishedPost(decodeURIComponent((req.params as { slug: string }).slug))
    if (!post) {
      reply.code(404).type('text/html; charset=utf-8')
      return notFoundPage(siteOf())
    }
    reply.type('text/html; charset=utf-8')
    return postPage(post, siteOf(), sidebarOf(all, post.slug))
  })

  /** 我的账户（#87）：登录后改自己的口令；GET 只渲染；POST 走 /password 的 PRG。 */
  app.get('/account', async (req, reply) => {
    const notice =
      (req.query as { notice?: string }).notice === 'password-changed'
        ? '口令已更新。其他设备上的登录已失效。'
        : undefined
    reply.type('text/html; charset=utf-8')
    return accountPage({ notice, noticeKey: (req.query as { notice?: unknown }).notice }, siteOf())
  })

  app.get('/status', async (_req, reply) => {
    reply.type('text/html; charset=utf-8')
    return statusPage(buildSummary(), siteOf(), sidebarOf(listPublishedPosts()))
  })

  /** 给前端自动刷新用的 JSON。
   *  ⚠ 必须过 `toPublicSummary()`：内部结构里有 `url`/`expectStatus` 等不该出网的字段。
   *  真实攻击者最多是「已登录的用户」，所以「要求登录」不能替代字段收敛。 */
  app.get('/api/status', async (_req, reply) => {
    return reply.send(toPublicSummary(buildSummary()))
  })

  app.get('/about', async (_req, reply) => {
    reply.type('text/html; charset=utf-8')
    return aboutPage(siteOf(), sidebarOf(listPublishedPosts()))
  })

  /** 健康检查：**保持匿名 200**（HEALTHCHECK / systemd 都不带凭证）。计数读库（§7），不是读启动时的那份配置。 */
  app.get('/healthz', async () => ({ ok: true, targets: countEnabledTargets() }))

  app.setNotFoundHandler(async (_req, reply) => {
    reply.code(404).type('text/html; charset=utf-8')
    return notFoundPage(siteOf())
  })

  return app
}

async function main(): Promise<void> {
  const app = await buildServer()
  await app.listen({ port: config.port, host: config.host })

  const shown = config.host === '0.0.0.0' ? 'localhost' : config.host
  const targetCount = countEnabledTargets()
  console.log(`\n  站点已启动  http://${shown}:${config.port}`)
  console.log(`  监控目标    ${targetCount} 个（真源：SQLite · 共 ${countAllTargets()} 条，含停用）`)
  console.log(`  登录账号    ${countUsers()} 个`)
  if (!targetCount) {
    console.warn('  提示：还没有启用中的被监控系统 —— 登录后在 管理台 → 系统可用性 里新增。')
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
