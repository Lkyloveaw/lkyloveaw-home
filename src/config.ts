/**
 * 运行期配置：全部来自环境变量，带安全默认值。
 * 为什么集中在这一处：Docker 部署时只靠环境变量区分环境，配置散落会让「本机跑通、服务器跑不通」难以排查。
 */
import fs from 'node:fs'
import path from 'node:path'

/** 一个被探测的业务系统。id 用作历史库主键，改 id 等于丢掉旧历史。 */
export interface ProbeTarget {
  id: string
  name: string
  url: string
  /** 分组名，用于面板分区展示；缺省归到「未分组」。 */
  group?: string
  /** 判定为「可用」的 HTTP 状态码集合；缺省 200-399 都算可用。 */
  expectStatus?: number[]
  /** 单目标超时覆盖（毫秒）。 */
  timeoutMs?: number
  /** 显式关掉这个目标而不必删历史。 */
  enabled?: boolean
}

const ROOT = process.cwd()

function readEnvFile(): void {
  const file = path.join(ROOT, '.env')
  if (!fs.existsSync(file)) return
  // 极简 .env 解析：不引入 dotenv，避免多一个依赖。
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    const key = line.slice(0, eq).trim()
    let value = line.slice(eq + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    if (process.env[key] === undefined) process.env[key] = value
  }
}

readEnvFile()

function num(key: string, fallback: number): number {
  const parsed = Number(process.env[key])
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function resolveFromRoot(p: string): string {
  return path.isAbsolute(p) ? p : path.join(ROOT, p)
}

/** 布尔环境变量：只有 `1`/`true`/`yes`/`on` 算真，其余（含未设置）算假。 */
function bool(key: string, fallback = false): boolean {
  const raw = process.env[key]?.trim().toLowerCase()
  if (raw === undefined || raw === '') return fallback
  return ['1', 'true', 'yes', 'on'].includes(raw)
}

/**
 * 目标清单来源：文件优先，其次 TARGETS_JSON。
 * 两个都没有就返回空数组——面板显示「尚未配置目标」，而不是崩溃。
 */
function loadTargets(): ProbeTarget[] {
  const json = process.env.TARGETS_JSON?.trim()
  if (json) {
    try {
      const parsed: unknown = JSON.parse(json)
      if (Array.isArray(parsed)) return normalizeTargets(parsed)
    } catch (err) {
      console.error('[config] TARGETS_JSON 解析失败：', (err as Error).message)
    }
  }

  const file = resolveFromRoot(process.env.TARGETS_PATH?.trim() || './targets.json')
  if (!fs.existsSync(file)) return []
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (Array.isArray(parsed)) return normalizeTargets(parsed)
    console.error('[config] 目标清单必须是数组：', file)
  } catch (err) {
    console.error('[config] 目标清单读取失败：', (err as Error).message)
  }
  return []
}

/** 允许被探测的协议。**白名单**，不是黑名单——黑名单挡不住 `0x7f.1` 这类变体。 */
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:'])

/**
 * 校验一条目标 URL。返回 `null` 表示合规，否则返回拒绝原因（会进日志）。
 *
 * 三条校验（`docs/probe-request-constraints-decision.md` §2.2）：
 * 1. `new URL()` 必须可解析；
 * 2. `protocol` 必须在白名单里；
 * 3. **`username`/`password` 必须为空**——只有用户名也算凭证。
 *
 * 第 2 条顺带拦住「没有 scheme」这种写法：实测 `new URL('ledger.internal.example:8080')`
 * 解析成 `protocol='ledger.internal.example:'`，所以查协议白名单就够了，不需要额外规则。
 *
 * 为什么不合规是「warn + 跳过」而不是「拒绝启动」：与「零账号允许启动」同一原则——
 * 一条脏配置不该让整个站点起不来，显眼告警即可。
 */
function validateTargetUrl(url: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return 'URL 无法解析'
  }
  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    return `协议不被允许（${parsed.protocol}），只接受 http/https`
  }
  if (parsed.username || parsed.password) {
    return 'URL 里含凭证（用户名/口令），请改用其他方式授权'
  }
  return null
}

/** 过滤掉缺 id/name/url 的坏条目：宁可少探一个，也不要让整轮探测因为一条脏数据挂掉。 */
function normalizeTargets(raw: unknown[]): ProbeTarget[] {
  const out: ProbeTarget[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const t = item as Record<string, unknown>
    const id = typeof t.id === 'string' ? t.id.trim() : ''
    const name = typeof t.name === 'string' ? t.name.trim() : ''
    const url = typeof t.url === 'string' ? t.url.trim() : ''
    if (!id || !name || !url) {
      console.warn('[config] 跳过不完整的目标条目（需要 id/name/url）：', JSON.stringify(t))
      continue
    }
    // ⚠ 入口拦截：URL 里的凭证会让探测请求带上 Authorization，
    // 而异常原文可能把整个 URL 记进日志与历史库（出口脱敏是另一道，两边都要做）。
    const reason = validateTargetUrl(url)
    if (reason) {
      console.warn(`[config] 跳过目标「${id}」：${reason} —— ${url}`)
      continue
    }
    if (seen.has(id)) {
      console.warn('[config] 跳过重复的目标 id：', id)
      continue
    }
    seen.add(id)
    out.push({
      id,
      name,
      url,
      group: typeof t.group === 'string' && t.group.trim() ? t.group.trim() : undefined,
      expectStatus: Array.isArray(t.expectStatus)
        ? t.expectStatus.filter((n): n is number => typeof n === 'number')
        : undefined,
      timeoutMs: typeof t.timeoutMs === 'number' ? t.timeoutMs : undefined,
      enabled: t.enabled !== false,
    })
  }
  return out
}

/**
 * `SITE_ORIGIN` → 允许来源集合。逗号分隔多值；每条 `trim()` 并去掉结尾的 `/`。
 * **这里不做合法性校验** —— 那在 `assertSiteOrigins()` 里做，因为那里能一次说出**是哪一条**不合法。
 */
function parseSiteOrigins(raw: string | undefined): Set<string> {
  const out = new Set<string>()
  for (const part of (raw ?? '').split(',')) {
    const v = part.trim().replace(/\/+$/, '')
    if (v) out.add(v)
  }
  return out
}

/**
 * `TRUST_PROXY` → `false`（默认）或 CIDR 列表。
 * 真值写法（`1`/`true`/…）在这里**归成 `false`**，真正的拒绝在 `assertTrustProxy()` —— 那里能报错退出。
 */
function parseTrustProxy(raw: string | undefined): string[] | false {
  const v = (raw ?? '').trim()
  if (!v) return false
  if (['0', 'false', 'no', 'off'].includes(v.toLowerCase())) return false
  if (['1', 'true', 'yes', 'on'].includes(v.toLowerCase())) return false // 见 assertTrustProxy()
  const list = v
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  return list.length ? list : false
}

export const config = {
  port: num('PORT', 3000),
  host: process.env.HOST?.trim() || '0.0.0.0',
  siteTitle: process.env.SITE_TITLE?.trim() || '我的个人站',
  siteDescription:
    process.env.SITE_DESCRIPTION?.trim() || '事情分享，以及内网各业务系统的可用性',
  databasePath: resolveFromRoot(process.env.DATABASE_PATH?.trim() || './data/availability.sqlite'),
  contentDir: resolveFromRoot(process.env.CONTENT_DIR?.trim() || './content'),
  publicDir: resolveFromRoot('./public'),
  probeIntervalMs: num('PROBE_INTERVAL_SECONDS', 60) * 1000,
  probeTimeoutMs: num('PROBE_TIMEOUT_MS', 5000),
  retentionDays: num('PROBE_RETENTION_DAYS', 30),
  targets: loadTargets(),

  /**
   * 会话签名密钥。**为空即拒绝启动**（见 `assertSessionSecret`）。
   * 不自动生成：自动生成 = 容器每次重启所有人掉线，而用户看不到任何原因。
   */
  sessionSecret: process.env.SESSION_SECRET?.trim() || '',
  /** `Secure` 属性开关，**默认关**。站点还是 HTTP 时开着它会让浏览器不存 cookie。 */
  sessionCookieSecure: bool('SESSION_COOKIE_SECURE', false),
  /** 会话存活毫秒，默认 7 天。 */
  sessionTtlMs: num('SESSION_TTL_SECONDS', 7 * 24 * 60 * 60) * 1000,
  /** 零账号时用它建首个号；表非空则**完全忽略**（防后门）。 */
  adminUsername: process.env.ADMIN_USERNAME?.trim() || '',
  adminPassword: process.env.ADMIN_PASSWORD?.trim() || '',

  /**
   * 备份目录。**默认与数据库同目录**（同一个 volume），这样 Docker 与裸机部署都不需要加挂载点。
   * 刻意不写死 `/app/data`：备份逻辑要**部署方式无关**。
   */
  backupDir: resolveFromRoot(process.env.BACKUP_DIR?.trim() || './data/backups'),
  /** 滚动保留几份。实测产物 ≈ 主库大小，7 份约 1.4 MB，故不压缩。 */
  backupKeep: num('BACKUP_KEEP', 7),
  /** 每几轮探测做一次 checkpoint（约每小时；探测轮次是本进程唯一心跳，不另开定时器）。 */
  checkpointEveryRounds: num('CHECKPOINT_EVERY_ROUNDS', 60),
  /** 每几轮探测尝试一次备份（默认与 checkpoint 同频，靠「今天是否已备份」去重）。 */
  backupEveryRounds: num('BACKUP_EVERY_ROUNDS', 60),

  /**
   * L2 的允许来源集合（**精确匹配**，`docs/write-path-auth-decision.md` §3.1）。
   * 逗号分隔多值；每条 `trim()` 并去掉**结尾的 `/`**（浏览器地址栏里带斜杠是常态）。
   * **为空即拒绝启动** —— 见 `assertSiteOrigins()`。
   */
  siteOrigins: parseSiteOrigins(process.env.SITE_ORIGIN),

  /**
   * 反向代理信任开关。**默认关**；要开就填具体 CIDR（逗号分隔）。
   *
   * ⚠ **不许填 `true`**（`assertTrustProxy()` 会拒绝启动）：打开它之后
   * `req.hostname` / `req.protocol` 可被**任意直连客户端**用 `X-Forwarded-*` 伪造。
   * 而本仓的判定**根本不用这两个值**（§3.3）—— 没有理由冒这个险。
   */
  trustProxy: parseTrustProxy(process.env.TRUST_PROXY),
} as const

export type Config = typeof config

/** 生成密钥的命令，报错信息里直接给出，省得运维去翻文档。 */
const SECRET_HINT = `  node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`

/**
 * 启动前检查会话密钥。
 *
 * 判据是「**重启能不能自愈**」：
 * - `users` 表为空 → 允许启动（拒绝会进 `restart: unless-stopped` 的重启循环，
 *   日志被刷屏、`docker ps` 一直重启，排查者反而看不出真正原因；而服务本身是健康的）。
 * - `SESSION_SECRET` 为空 → **拒绝启动**：它不会因重启而自行好转，反复重启只会掩盖原因。
 */
export function assertSessionSecret(): void {
  if (config.sessionSecret) return
  console.error(
    [
      '',
      '[config] 缺少 SESSION_SECRET，拒绝启动。',
      '',
      '  会话 cookie 用它签名，没它就无法安全地维持登录态。请生成一个（≥32 字节随机）',
      '  并写进环境变量或 .env：',
      '',
      SECRET_HINT,
      '',
    ].join('\n'),
  )
  process.exit(1)
}

/**
 * 启动前检查 `SITE_ORIGIN`（L2 的判据）。
 *
 * 判据沿用 `assertSessionSecret()` 的「**重启能不能自愈**」：
 * 缺失或写错**不会**因重启而好转，反复重启只会掩盖原因 —— 所以**拒绝启动**，并把
 * 「怎么写、写成什么样」直接印在报错里。
 *
 * ⚠ 这一条是**部署契约的一部分**：升级到本版时 `.env` 里没有 `SITE_ORIGIN` 服务就起不来。
 * 已经同步进 `.env.example` 与 `README.md`。
 */
export function assertSiteOrigins(): void {
  const raw = (process.env.SITE_ORIGIN ?? '').trim()
  if (config.siteOrigins.size === 0) {
    console.error(
      [
        '',
        '[config] 缺少 SITE_ORIGIN，拒绝启动。',
        '',
        '  它是「哪些来源算本站」的白名单，写路径的来源校验（L2）靠它 fail-closed。',
        '  写**浏览器地址栏里那个 origin**（协议 + 主机 + 端口，不带路径、不带结尾斜杠）：',
        '',
        '    SITE_ORIGIN=http://10.0.0.226:3000',
        '',
        '  多个来源用逗号分隔（例如同时用 IP 与域名访问）：',
        '',
        '    SITE_ORIGIN=http://10.0.0.226:3000,https://wiki.example.com',
        '',
      ].join('\n'),
    )
    process.exit(1)
  }

  // 逐条校验，**指出是哪一条**：一次说清比让运维逐条试强。
  for (const part of raw.split(',')) {
    const v = part.trim().replace(/\/+$/, '')
    if (!v) continue
    let ok = false
    try {
      const u = new URL(v)
      // `u.origin === v` 一次挡掉：带路径/查询/片段、结尾斜杠、以及非 http(s) 协议。
      ok = (u.protocol === 'http:' || u.protocol === 'https:') && u.origin === v
    } catch {
      ok = false
    }
    if (!ok) {
      console.error(
        [
          '',
          `[config] SITE_ORIGIN 里的这一条不是合法 origin：「${v}」`,
          '',
          '  要的是「协议://主机[:端口]」，不带路径、不带结尾斜杠。例如：',
          '    http://10.0.0.226:3000',
          '    https://wiki.example.com',
          '',
        ].join('\n'),
      )
      process.exit(1)
    }
  }
}

/**
 * `TRUST_PROXY` **不许填 `true`**（§3.3）。
 *
 * 打开它之后，`req.hostname` / `req.protocol` 可被任意直连客户端用 `X-Forwarded-*` 伪造。
 * 本仓的判定**根本不用这两个值**，所以没有理由冒这个险；要开就填具体 CIDR。
 */
export function assertTrustProxy(): void {
  const raw = (process.env.TRUST_PROXY ?? '').trim().toLowerCase()
  if (!['1', 'true', 'yes', 'on'].includes(raw)) return
  console.error(
    [
      '',
      '[config] TRUST_PROXY=true 被拒绝，拒绝启动。',
      '',
      '  它会让任意直连客户端能用 X-Forwarded-* 伪造主机与协议。',
      '  要信任反向代理就填**具体的** CIDR（逗号分隔）：',
      '',
      '    TRUST_PROXY=127.0.0.1,10.0.0.0/8',
      '',
      '  不信任任何代理（默认）就不写这一项。',
      '',
    ].join('\n'),
  )
  process.exit(1)
}
