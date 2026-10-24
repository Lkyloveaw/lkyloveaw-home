/**
 * 历史存储：每次探测写一行，查询时按时间窗口聚合。
 * 为什么用 SQLite：单文件、零运维、可直接放本机目录并随备份打包；个人站这个写入量（分钟级、几十个目标）远未到需要 TSDB 的程度。
 */
import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import { config } from './config.js'
import { needsSanitizing, sanitizeStoredError } from './sanitize.js'

export interface ProbeResult {
  targetId: string
  /** 探测发起时刻（epoch ms），作为历史的时间轴。 */
  at: number
  /**
   * 所属探测轮次的起点（epoch ms）。
   * 为什么要单独存：同一轮里各目标的 at 相差几毫秒，「整体可用率」必须按轮聚合，
   * 按 at 精确分组会把一轮拆成 N 个 total=1 的组，曲线就会在 0% 和 100% 之间乱跳。
   */
  roundAt: number
  /** up = 可用，down = 故障/超时，degraded = 可达但状态码不符合预期。 */
  status: 'up' | 'down' | 'degraded'
  /** 往返耗时毫秒；未拿到响应时为 null。 */
  latencyMs: number | null
  statusCode: number | null
  error: string | null
}

export interface TargetStats {
  targetId: string
  samples: number
  upCount: number
  /** 可用率 0-1；没有样本时为 null，界面显示「暂无数据」而不是假装 100%。 */
  uptime: number | null
  avgLatencyMs: number | null
  p95LatencyMs: number | null
  lastStatus: ProbeResult['status'] | null
  lastCheckedAt: number | null
  lastError: string | null
  /** 从最近一次故障开始、持续到现在的连续可用时长（ms）；当前正故障则为 0。 */
  upStreakMs: number | null
  /** 超过这个缺测间隔时，最新状态只能作为历史记录展示。 */
  staleAfterMs: number
}

export interface TimelinePoint {
  at: number
  status: ProbeResult['status']
  latencyMs: number | null
}

let db: Database.Database | null = null

export function initStore(): Database.Database {
  if (db) return db
  fs.mkdirSync(path.dirname(config.databasePath), { recursive: true })
  db = new Database(config.databasePath)
  /*
   * 显式设忙等（better-sqlite3 的默认 `timeout` 也是 5000ms —— 写出来是为了让
   * 「并发首启要等锁、不是立刻失败」这件事在代码里看得见，而不是依赖驱动的默认值）。
   *
   * ⚠ 真正会在并发首启时炸的**不是**开 WAL，而是**补列迁移**：
   * 两个进程同时读到「缺列」，先到的补完，后到的就拿到 `duplicate column name`
   * （实测：负载下 100 次并发首启里必现 1 次，服务直接起不来）。处置见 `isDuplicateColumnError()`。
   */
  db.pragma('busy_timeout = 5000')
  db.pragma('journal_mode = WAL')
  // 先建表（不含新列），保证旧库升级路径也能走到补列那一步。
  db.exec(`
    CREATE TABLE IF NOT EXISTS probes (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      target_id   TEXT    NOT NULL,
      at          INTEGER NOT NULL,
      status      TEXT    NOT NULL,
      latency_ms  INTEGER,
      status_code INTEGER,
      error       TEXT
    );
  `)
  // 兼容旧库：早期版本没有 round_at 列。必须在下标之前补上，
  // 否则「CREATE INDEX ... (round_at)」会在旧库上直接报 no such column，服务起不来。
  const cols = db.prepare(`PRAGMA table_info(probes)`).all() as Array<{ name: string }>
  const hasRound = cols.some((c) => c.name === 'round_at')
  if (!hasRound) {
    // 并发首启：另一个进程可能刚补完这一列，我们这边就会拿到 `duplicate column name`。
    // 那不是失败（目标状态已达成）—— 见 `isDuplicateColumnError()`。回填与建索引照常，
    // 两者都是幂等的。
    try {
      db.exec(`ALTER TABLE probes ADD COLUMN round_at INTEGER`)
      console.log('[store] 已为历史表补上 round_at 列')
    } catch (err) {
      if (!isDuplicateColumnError(err)) throw err
    }
    // 旧数据的每一轮就是当时的单条记录，回填成 at 即可（`WHERE IS NULL` 让它天然幂等）。
    db.exec(`UPDATE probes SET round_at = at WHERE round_at IS NULL`)
  }
  // 补列之后再建索引。
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_probes_target_at ON probes (target_id, at DESC);
    CREATE INDEX IF NOT EXISTS idx_probes_round   ON probes (round_at ASC);
  `)

  /*
   * 文章的两张表（规格 #48 的「存储」一节）。
   *
   * `body` 存**结构化文档 JSON**，不是 Markdown、也不是 HTML —— 读面按闭集 schema 在服务端渲染
   * （`src/article-html.ts`），那条「不可信输入不直接进页面」的属性和它绑在一起（ADR 0006）。
   *
   * `deleted_at` **正交**于 `draft`：它不是第三个状态，不覆盖「原来是草稿还是已发布」，
   * 所以还原不需要 WordPress 那种 `_wp_trash_meta_status` 旁路（研究 #36 时核过）。
   */
  db.exec(`
    CREATE TABLE IF NOT EXISTS articles (
      slug       TEXT PRIMARY KEY,
      title      TEXT    NOT NULL,
      body       TEXT    NOT NULL,
      summary    TEXT,
      date       TEXT    NOT NULL,
      tags       TEXT    NOT NULL DEFAULT '[]',
      draft      INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      deleted_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_articles_read ON articles (draft, deleted_at, date DESC);

    CREATE TABLE IF NOT EXISTS article_revisions (
      id       INTEGER PRIMARY KEY AUTOINCREMENT,
      slug     TEXT    NOT NULL,
      title    TEXT    NOT NULL,
      body     TEXT    NOT NULL,
      summary  TEXT,
      date     TEXT    NOT NULL,
      tags     TEXT    NOT NULL,
      draft    INTEGER NOT NULL,
      saved_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_article_revisions_slug ON article_revisions (slug, saved_at DESC);
  `)

  return db
}

function handle(): Database.Database {
  return db ?? initStore()
}

/**
 * 「这一列已经有了」—— 在**并发首启**时这是正常结果，不是失败。
 *
 * 形状：两个进程同时启动、同时读 `PRAGMA table_info` 都以为缺列，先到的那个补完，
 * 后到的那个执行 `ALTER TABLE` 就拿到 `duplicate column name`。
 * 实测：负载下 100 次子进程并发首启里必现 1 次（服务直接起不来）；容忍之后同样 100 次为 0。
 * 迁移的**目标状态已经达成**，所以这一种措辞被容忍。
 *
 * ⚠ 只容忍这一种：别的错误照旧抛出去。**失败要显眼，不要静默降级**是本仓的既有取舍，
 * 把整个 `ALTER` 包进 `catch {}` 就等于把「迁移真的坏了」也吞掉。
 */
export function isDuplicateColumnError(err: unknown): boolean {
  return /duplicate column name/i.test((err as Error | undefined)?.message ?? '')
}

const insertStmt = () => handle().prepare(
  `INSERT INTO probes (target_id, at, round_at, status, latency_ms, status_code, error)
   VALUES (@targetId, @at, @roundAt, @status, @latencyMs, @statusCode, @error)`,
)

/** 批量写入一轮探测结果：包在事务里，避免每分钟几十次独立 fsync。 */
export function recordResults(results: ProbeResult[]): void {
  if (!results.length) return
  const stmt = insertStmt()
  const tx = handle().transaction((rows: ProbeResult[]) => {
    for (const r of rows) stmt.run(r)
  })
  tx(results)
}

/** 清理超期历史，返回删除行数。 */
export function pruneOldProbes(): number {
  const cutoff = Date.now() - config.retentionDays * 24 * 60 * 60 * 1000
  const info = handle().prepare('DELETE FROM probes WHERE at < ?').run(cutoff)
  return info.changes
}

export interface CheckpointResult {
  /** SQLite 返回的 busy 标志。**非 0 表示没搬干净，绝不能当成功。** */
  busy: number
  /** 搬了多少页（诊断用）。 */
  pages: number
}

/**
 * 把 WAL 内容搬回主库。
 *
 * ⚠ **必须校验 `busy`，不能只看「没抛异常」。** 已实测：另一个连接持有读事务时，
 * `PASSIVE` 会返回 **`busy:0` 却只搬了 2/33 页**——返回值本身就骗人；
 * 而 `FULL`/`TRUNCATE` 在这种情形下返回 `busy:1`，搬不动。
 * 所以「返回 busy 非 0 → 记日志、不算成功」是必须的，否则就是一个静默降级。
 *
 * 为什么用 `TRUNCATE`：`FULL` 把内容搬回主库但**不截断 WAL 文件**，
 * 而「WAL 被截断」正是「只拷 `.sqlite` 也能拿到完整库」的前提。
 */
export function checkpoint(mode: 'PASSIVE' | 'FULL' | 'TRUNCATE' = 'TRUNCATE'): CheckpointResult {
  const row = handle().prepare(`PRAGMA wal_checkpoint(${mode})`).get() as
    | { busy: number; log: number; checkpointed: number }
    | undefined
  return { busy: row?.busy ?? 1, pages: row?.checkpointed ?? 0 }
}

/**
 * 用 SQLite 的**在线备份 API** 产出一份一致的副本。
 *
 * ⚠ **不要用 `cp`。** 实测三路对照（10000 行）：
 * - 只拷 `.sqlite` → 副本是**空库**（`no such table: probes`），因为数据还在 WAL 里；
 * - 连 `-wal` 一起拷 → 能读，但**只有停服才安全**（拷贝瞬间 WAL 正在写就会得到撕裂的组合）；
 * - `db.backup()` → 行数与源库一致，且**不需要停服**。
 *
 * 另实测：`db.backup()` **不改动源库的 WAL**，所以 checkpoint 不能靠备份顺带完成——
 * 必须**先 checkpoint 再备份**。
 */
export async function backupTo(file: string): Promise<void> {
  await handle().backup(file)
}

/**
 * 存量脏数据清洗：把历史 `error` 列里可能含 URL/凭证的原文改写成类别文案。
 *
 * 为什么必须做：`probe.ts` 的写入侧修好，**只影响新写入的行**。
 * 已经被 `?? e.message` 写进去的原文（实测本机库里就有一条带口令的）会一直漏下去——
 * 写侧修好了、读侧还在漏。
 *
 * 三个实现约束：
 * 1. **可重复执行**：二次运行无行可改（幂等）；
 * 2. **按主键分页**：历史原文可能极长，一次性 `SELECT` 全部会撑爆内存；
 * 3. **在启动路径上自动跑**（已定：不让运维多记一个步骤，也不给「忘了跑」留口子）。
 */
export function sanitizeStoredErrors(batchSize = 500): number {
  const db = handle()
  let changed = 0
  let lastId = 0

  const page = db.prepare(
    `SELECT id, error FROM probes
      WHERE id > ? AND error IS NOT NULL
      ORDER BY id ASC LIMIT ?`,
  )
  const update = db.prepare(`UPDATE probes SET error = ? WHERE id = ?`)

  for (;;) {
    const rows = page.all(lastId, batchSize) as Array<{ id: number; error: string | null }>
    if (!rows.length) break
    const tx = db.transaction((batch: Array<{ id: number; error: string | null }>) => {
      for (const row of batch) {
        if (!needsSanitizing(row.error)) continue
        update.run(sanitizeStoredError(row.error), row.id)
        changed++
      }
    })
    tx(rows)
    lastId = rows[rows.length - 1]!.id
    if (rows.length < batchSize) break
  }

  // 顺带截断异常长的历史文本：即使内容已安全，超长字符串也没有展示价值，
  // 只会拖慢前端渲染。
  const trimmed = db
    .prepare(`UPDATE probes SET error = substr(error, 1, 200) WHERE error IS NOT NULL AND length(error) > 200`)
    .run().changes
  changed += trimmed

  return changed
}

interface StatsRow {
  targetId: string
  samples: number
  upCount: number
  avgLatencyMs: number | null
  lastStatus: string | null
  lastCheckedAt: number | null
  lastError: string | null
}

/**
 * 统计某个目标在窗口内的可用率与延迟。窗口内没数据时各项为 null。
 *
 * `enabledAt`：目标**当前启用状态的起始时刻**（`targets.enabled_at`，`docs/targets-source-decision.md` §5）。
 * 传进来只用于一件事：给「连续可用时长」设下界，修掉「停用两个月再启用 → 显示连续可用 60 天」的静默谎。
 * 省略即不设下界（从文件读来的目标、以及不过库的调用方走这条）。
 */
export function getStats(targetId: string, windowMs: number, enabledAt = 0, maxGapMs = Number.MAX_SAFE_INTEGER, now = Date.now()): TargetStats {
  const since = now - windowMs
  const row = handle()
    .prepare(
      `SELECT
         target_id                                        AS targetId,
         COUNT(*)                                         AS samples,
         SUM(CASE WHEN status = 'up' THEN 1 ELSE 0 END)   AS upCount,
         AVG(CASE WHEN latency_ms IS NOT NULL THEN latency_ms END) AS avgLatencyMs,
         (SELECT status FROM probes WHERE target_id = ? AND at >= ? AND at <= ? ORDER BY at DESC, id DESC LIMIT 1) AS lastStatus,
         (SELECT at FROM probes WHERE target_id = ? AND at >= ? AND at <= ? ORDER BY at DESC, id DESC LIMIT 1) AS lastCheckedAt,
         (SELECT error FROM probes WHERE target_id = ? AND at >= ? AND at <= ? ORDER BY at DESC, id DESC LIMIT 1) AS lastError
       FROM probes p1
       WHERE target_id = ? AND at >= ? AND at <= ?`,
    )
    .get(targetId, enabledAt, now, targetId, enabledAt, now, targetId, enabledAt, now, targetId, since, now) as StatsRow | undefined

  const samples = row?.samples ?? 0
  const p95 = percentileLatency(targetId, since, 0.95)

  return {
    targetId,
    samples,
    upCount: row?.upCount ?? 0,
    uptime: samples > 0 ? (row!.upCount ?? 0) / samples : null,
    avgLatencyMs: row?.avgLatencyMs != null ? Math.round(row.avgLatencyMs) : null,
    p95LatencyMs: p95,
    lastStatus: (row?.lastStatus as ProbeResult['status'] | null) ?? null,
    lastCheckedAt: row?.lastCheckedAt ?? null,
    lastError: row?.lastError ?? null,
    upStreakMs: computeUpStreak(targetId, enabledAt, maxGapMs, now),
    staleAfterMs: maxGapMs,
  }
}

function percentileLatency(targetId: string, since: number, q: number): number | null {
  const rows = handle()
    .prepare(
      `SELECT latency_ms AS latency FROM probes
        WHERE target_id = ? AND at >= ? AND latency_ms IS NOT NULL
        ORDER BY latency_ms ASC`,
    )
    .all(targetId, since) as Array<{ latency: number }>
  if (!rows.length) return null
  // 用最近秩法：ceil(q*n)-1。直接 floor(q*n) 在 n=20 时会取到第 20 个（即最大值），
  // 把 P95 悄悄变成 max，是个很容易被忽略的偏差。
  const idx = Math.max(0, Math.min(rows.length - 1, Math.ceil(q * rows.length) - 1))
  return rows[idx]!.latency
}

/**
 * 连续可用时长：从最近一次非 up 记录之后的第一条 up 记录算起。
 * 为什么不用「最后 N 条」近似：可用性承诺（"连续稳定 3 天"）必须经得起回看，近似值会撒谎。
 *
 * `enabledAt`（`docs/targets-source-decision.md` §5）是下界的第二个来源：
 * 目标停用两个月（这段时间自然没有探测记录、也没有「非 up」记录）再启用，
 * 只按「最近一次非 up」算就会把停用的那两个月算进连续可用 —— 界面显示「连续可用 60 天」，
 * 而它其实停了 60 天。取 `max(最近一次非 up, enabled_at)` 之后，
 * 重新启用后的连续可用从**重新启用那一刻**算起。
 */
function computeUpStreak(targetId: string, enabledAt: number, maxGapMs: number, now: number): number | null {
  const lastBad = handle()
    .prepare(
      `SELECT at FROM probes WHERE target_id = ? AND status != 'up' AND at <= ? ORDER BY at DESC LIMIT 1`,
    )
    .get(targetId, now) as { at: number } | undefined

  const since = Math.max(lastBad ? lastBad.at : 0, enabledAt)
  const row = handle().prepare(`
    WITH ordered AS (
      SELECT at, LAG(at) OVER (ORDER BY at, id) AS previous
      FROM probes WHERE target_id = ? AND status = 'up' AND at > ? AND at <= ?
    ), boundary AS (SELECT MAX(at) AS start FROM ordered WHERE at - previous > ?)
    SELECT MIN(at) AS first, MAX(at) AS last FROM ordered
    WHERE at >= COALESCE((SELECT start FROM boundary), 0)
  `).get(targetId, since, now, maxGapMs) as { first: number | null; last: number | null }
  // 只计算已经观测到的连续时长，页面刷新本身不能增加可用时长。
  return row.first == null || row.last == null ? 0 : row.last - row.first
}

/** 时间线：给界面画状态条用。按桶取窗口内最近 limit 条记录。 */
export function getTimeline(targetId: string, windowMs: number, limit = 60): TimelinePoint[] {
  const since = Date.now() - windowMs
  const rows = handle()
    .prepare(
      `SELECT at, status, latency_ms AS latencyMs FROM probes
        WHERE target_id = ? AND at >= ? ORDER BY at DESC LIMIT ?`,
    )
    .all(targetId, since, limit) as TimelinePoint[]
  return rows.reverse()
}

export interface IncidentEvent {
  targetId: string
  at: number
  lastSeenAt: number
  endedAt: number | null
  durationMs: number
  outcome: 'ongoing' | 'recovered' | 'unknown'
  status: ProbeResult['status']
  statusCode: number | null
  latencyMs: number | null
  error: string | null
}

/** 连续失败合并成事件。缺测是未知，不能当成恢复，也不能把两端故障连成整段故障。 */
export function getIncidentEvents(
  windowMs: number,
  targets: Array<{ id: string; enabledAt?: number; maxGapMs: number }>,
  now = Date.now(),
  limit = 8,
): IncidentEvent[] {
  const events: IncidentEvent[] = []
  const query = handle().prepare(`SELECT at, status, latency_ms AS latencyMs, status_code AS statusCode, error
    FROM probes WHERE target_id = ? AND at >= MAX(?, COALESCE(
      (SELECT MAX(at) FROM probes WHERE target_id = ? AND status = 'up' AND at < ?), 0))
      AND at <= ? ORDER BY at, id`)
  for (const target of targets) {
    const rows = query.all(target.id, target.enabledAt ?? 0, target.id, now - windowMs, now) as Array<ProbeResult>
    let event: IncidentEvent | null = null
    const finish = () => {
      if (event && (event.endedAt ?? event.lastSeenAt) >= now - windowMs) events.push(event)
      event = null
    }
    for (const row of rows) {
      if (event && row.at - event.lastSeenAt > target.maxGapMs) {
        event.outcome = 'unknown'
        finish()
      }
      if (row.status === 'up') {
        if (event) {
          event.endedAt = row.at
          event.durationMs = row.at - event.at
          event.outcome = 'recovered'
          finish()
        }
      } else if (event) {
        event.lastSeenAt = row.at
        event.durationMs = row.at - event.at
        event.status = row.status
        event.statusCode = row.statusCode
        event.latencyMs = row.latencyMs
        event.error = row.error
      } else {
        event = { targetId: target.id, at: row.at, lastSeenAt: row.at, endedAt: null, durationMs: 0,
          outcome: 'ongoing', status: row.status, statusCode: row.statusCode, latencyMs: row.latencyMs, error: row.error }
      }
    }
    if (event && now - event.lastSeenAt > target.maxGapMs) event.outcome = 'unknown'
    finish()
  }
  return events.sort((a, b) => (b.endedAt ?? b.lastSeenAt) - (a.endedAt ?? a.lastSeenAt)).slice(0, limit)
}

/**
 * 每个目标**最近一条**探测的状态 —— 管理台目标页那排「状态点」用它。
 *
 * 为什么单独一个函数而不是逐目标 `getStats()`：后者一个目标要跑四条查询（含 p95 与连续可用），
 * 而管理台只要一个点。一条 SQL 拿全：`MAX(id)` 是「最近一条」的可靠判据
 * （自增主键即写入顺序，比按 `at` 排更稳 —— 同一毫秒内的两条 `at` 相同）。
 */
export function getLatestStatuses(): Map<string, ProbeResult['status']> {
  const rows = handle()
    .prepare(
      `SELECT p.target_id AS targetId, p.status AS status
         FROM probes p
         JOIN (SELECT target_id, MAX(id) AS id FROM probes GROUP BY target_id) m ON m.id = p.id`,
    )
    .all() as Array<{ targetId: string; status: ProbeResult['status'] }>
  return new Map(rows.map((r) => [r.targetId, r.status]))
}

export interface OverviewPoint {
  at: number
  up: number
  total: number
}

/** 全局可用率走势：把窗口切成 buckets 段，算每段「可用目标占比」。 */
export function getOverview(windowMs: number, buckets = 48): OverviewPoint[] {
  const now = Date.now()
  const since = now - windowMs
  const bucketMs = Math.max(1, Math.floor(windowMs / buckets))
  const rows = handle()
    .prepare(
      `SELECT (at - ?) / ? AS bucket, COUNT(*) AS total,
              SUM(CASE WHEN status = 'up' THEN 1 ELSE 0 END) AS up
         FROM probes WHERE at >= ?
        GROUP BY bucket ORDER BY bucket ASC`,
    )
    .all(since, bucketMs, since) as Array<{ bucket: number; total: number; up: number }>

  return rows.map((r) => ({ at: since + r.bucket * bucketMs, up: r.up, total: r.total }))
}

export interface LatencyPoint {
  at: number
  /** 该桶内的平均延迟；桶内全是失败时为 null，图上断开而不是画成 0。 */
  avgLatencyMs: number | null
  samples: number
}

/**
 * 单目标的延迟曲线数据：把窗口切成 buckets 段，每段取平均延迟。
 * 为什么失败时回 null 而不是 0：0ms 会在曲线上画成「飞快」，与「探测失败」正好相反，
 * 是那种一眼看不出、却会误导决策的错。缺数据就断线。
 */
export function getLatencySeries(targetId: string, windowMs: number, buckets = 48): LatencyPoint[] {
  const since = Date.now() - windowMs
  const bucketMs = Math.max(1, Math.floor(windowMs / buckets))
  const rows = handle()
    .prepare(
      `SELECT (at - ?) / ? AS bucket,
              AVG(latency_ms) AS avgLatencyMs,
              COUNT(*)        AS samples
         FROM probes
        WHERE target_id = ? AND at >= ?
        GROUP BY bucket ORDER BY bucket ASC`,
    )
    .all(since, bucketMs, targetId, since) as Array<{
    bucket: number
    avgLatencyMs: number | null
    samples: number
  }>

  return rows.map((r) => ({
    at: since + r.bucket * bucketMs,
    avgLatencyMs: r.avgLatencyMs == null ? null : Math.round(r.avgLatencyMs),
    samples: r.samples,
  }))
}

/** 正常区间分桶取包络；每段异常/缺测的边界额外保留，不能为了固定点数跨故障连线。 */
function sampleChart<T extends { at: number }>(points: T[], since: number, windowMs: number, buckets: number, value: (p: T) => number | null, failed = (p: T) => value(p) == null): T[] {
  const groups = new Map<number, T[]>()
  const width = windowMs / Math.max(1, buckets)
  for (const p of points) {
    const bucket = Math.min(Math.max(1, buckets) - 1, Math.floor((p.at - since) / width))
    const group = groups.get(bucket) ?? []
    group.push(p)
    groups.set(bucket, group)
  }
  const sampled = [...groups.values()].flatMap((group) => {
    let min = group[0]!, max = group[0]!
    for (const p of group) {
      const v = value(p)
      if (v == null) continue
      if (value(min) == null || v < value(min)!) min = p
      if (value(max) == null || v > value(max)!) max = p
    }
    return [...new Set([group[0]!, min, max, group.find(p => value(p) == null), group.at(-1)!])]
      .filter((p): p is T => p != null).sort((a, b) => a.at - b.at)
  })
  const keep = new Set(sampled)
  for (let i = 1; i < points.length; i++) {
    const previous = points[i - 1]!, current = points[i]!
    if (failed(previous) !== failed(current) || (value(previous) == null) !== (value(current) == null)) {
      keep.add(previous)
      keep.add(current)
    }
  }
  return points.filter(p => keep.has(p))
}

function withGaps<T extends { at: number }>(points: T[], maxGapMs: number, gap: (at: number) => T): T[] {
  const result: T[] = []
  for (const p of points) {
    const previous = result.at(-1)
    if (previous && p.at - previous.at > maxGapMs) result.push(gap(previous.at + maxGapMs))
    result.push(p)
  }
  return result
}

/** 单目标完整窗口的曲线。保留失败及缺测断点，且首尾覆盖真实采样时间。 */
export function getLatencyRaw(targetId: string, windowMs: number, buckets = 120, maxGapMs = Number.MAX_SAFE_INTEGER, now = Date.now()): LatencyPoint[] {
  const since = now - windowMs
  const rows = handle()
    .prepare(
      `SELECT at, latency_ms AS avgLatencyMs, 1 AS samples
         FROM probes
        WHERE target_id = ? AND at >= ? AND at <= ?
        ORDER BY at ASC, id ASC`,
    )
    .all(targetId, since, now) as LatencyPoint[]
  return sampleChart(withGaps(rows, maxGapMs, at => ({ at, avgLatencyMs: null, samples: 0 })), since, windowMs, buckets, p => p.avgLatencyMs)
}

/**
 * 全局可用率走势：按探测轮次聚合，每个点 = 该轮「可用目标数 / 参与目标数」。
 *
 * 只保留「参与目标数 >= 当前目标数」的轮次。原因：从旧库迁移来的记录每轮只有 1 个目标，
 * 它们的 1/1 会画成 100%、0/1 画成 0%，与现在每轮的 1/3=33% 混在一张图里就是锯齿，
 * 且会让人误以为可用率曾经大幅波动。宁可少几个点，也不要给出含义不一致的曲线。
 *
 * ⚠ `expectedCount` **必须由调用方传进来**（`docs/targets-source-decision.md` §7）：
 * 目标清单的真源已经是库，而本函数的调用方（`buildSummary()`）也刚读过一次 ——
 * 若这里自己去读，就会出现「本函数读库的那一刻」与「buildSummary 读库的那一刻」两次读，
 * 两个口径一旦分叉，表现为**可用率曲线上少了几个点**，没人会立刻发现。
 * 所以：**同一请求内清单只读一次，同一个数组喂两个函数。**
 */
export function getUptimeRaw(
  windowMs: number,
  expectedCount: number,
  buckets = 120,
  maxGapMs = Number.MAX_SAFE_INTEGER,
  now = Date.now(),
): OverviewPoint[] {
  const since = now - windowMs
  const expected = Math.max(1, expectedCount)
  const rows = handle()
    .prepare(
      `SELECT round_at AS at, COUNT(*) AS total,
              SUM(CASE WHEN status = 'up' THEN 1 ELSE 0 END) AS up
         FROM probes
        WHERE at >= ? AND at <= ?
        GROUP BY round_at
       HAVING total >= ?
        ORDER BY round_at ASC`,
    )
    .all(since, now, expected) as OverviewPoint[]
  return sampleChart(withGaps(rows, maxGapMs, at => ({ at, up: 0, total: 0 })), since, windowMs, buckets,
    p => p.total ? p.up / p.total : null, p => p.total === 0 || p.up < p.total)
}

// ── 文章：SQL 都留在这里，领域规则（渲染 / 派生摘要 / 出口分组）在 src/content.ts ──

export interface ArticleRow {
  slug: string
  title: string
  /** **结构化文档 JSON**（字符串形态）。 */
  body: string
  summary: string | null
  /** `YYYY-MM-DD` 定长文本，保留字符串排序语义。 */
  date: string
  /** JSON 数组字符串。 */
  tags: string
  /** 1 = 草稿，0 = 已发布。 */
  draft: number
  createdAt: number
  updatedAt: number
  /** 非空 = 在回收站。**正交于 draft**，不覆盖它。 */
  deletedAt: number | null
}

export interface ArticleInput {
  slug: string
  title: string
  body: string
  summary: string | null
  date: string
  tags: string
  draft: number
  /** 下一次写库的时间戳（created_at 只在首次写入时用它）。 */
  now: number
}

const toArticleRow = (r: Record<string, unknown>): ArticleRow => ({
  slug: String(r.slug),
  title: String(r.title),
  body: String(r.body),
  summary: r.summary === null || r.summary === undefined ? null : String(r.summary),
  date: String(r.date),
  tags: String(r.tags),
  draft: Number(r.draft),
  createdAt: Number(r.created_at),
  updatedAt: Number(r.updated_at),
  deletedAt: r.deleted_at === null || r.deleted_at === undefined ? null : Number(r.deleted_at),
})

/** 库里有任何一篇文章吗（首次导入的前提）。 */
export function hasAnyArticle(): boolean {
  const row = handle().prepare(`SELECT COUNT(*) AS n FROM articles`).get() as { n: number }
  return row.n > 0
}

/** 不做读者过滤的取行 —— 只给导入路径用（它要判断「有没有变化」）。 */
export function getArticleForAdmin(slug: string): ArticleRow | undefined {
  const row = handle().prepare(`SELECT * FROM articles WHERE slug = ?`).get(slug) as
    | Record<string, unknown>
    | undefined
  return row ? toArticleRow(row) : undefined
}

/**
 * **读面出口（读者视角）**：滤掉草稿、滤掉回收站，按日期倒序。
 * 「零布尔参数」这条纪律就是为了这个函数存在 —— 需要「带草稿」的调用方必须去用管理台/回收站的出口，
 * 而不是给这里传一个 `includeDrafts`（那种参数在调用点读不出意图，草稿泄漏就靠 diff 时一眼可审来防）。
 */
export function listArticlesForReaders(): ArticleRow[] {
  const rows = handle()
    .prepare(
      `SELECT * FROM articles
        WHERE draft = 0 AND deleted_at IS NULL
        ORDER BY date DESC, slug ASC`,
    )
    .all() as Array<Record<string, unknown>>
  return rows.map(toArticleRow)
}

/** **读面出口（读者视角）**：单篇。找不到 / 是草稿 / 在回收站 → `undefined`（调用方给 404）。 */
export function getArticleForReaders(slug: string): ArticleRow | undefined {
  const row = handle()
    .prepare(`SELECT * FROM articles WHERE slug = ? AND draft = 0 AND deleted_at IS NULL`)
    .get(slug) as Record<string, unknown> | undefined
  return row ? toArticleRow(row) : undefined
}

/**
 * 写一篇文章，**并在同一事务里留一条修订**（#32：每次保存都留一行全文快照）。
 *
 * 内容与库里那一行**完全相同时不写**：否则每次「重导一遍没改过的文件」都会堆一条无意义的修订，
 * 「退回上一版」就会被自己重复的版本淹没。返回值告诉调用方到底写没写。
 */
export function upsertArticleWithRevision(input: ArticleInput): 'inserted' | 'updated' | 'unchanged' {
  const db = handle()
  const existing = getArticleForAdmin(input.slug)

  if (
    existing &&
    existing.title === input.title &&
    existing.body === input.body &&
    existing.summary === input.summary &&
    existing.date === input.date &&
    existing.tags === input.tags &&
    existing.draft === input.draft &&
    existing.deletedAt === null
  ) {
    return 'unchanged'
  }

  const run = db.transaction(() => {
    db.prepare(
      `INSERT INTO articles (slug, title, body, summary, date, tags, draft, created_at, updated_at, deleted_at)
       VALUES (@slug, @title, @body, @summary, @date, @tags, @draft, @now, @now, NULL)
       ON CONFLICT(slug) DO UPDATE SET
         title = excluded.title, body = excluded.body, summary = excluded.summary,
         date = excluded.date, tags = excluded.tags, draft = excluded.draft,
         updated_at = excluded.updated_at, deleted_at = NULL`,
    ).run({
      slug: input.slug,
      title: input.title,
      body: input.body,
      summary: input.summary,
      date: input.date,
      tags: input.tags,
      draft: input.draft,
      now: input.now,
    })
    db.prepare(
      `INSERT INTO article_revisions (slug, title, body, summary, date, tags, draft, saved_at)
       VALUES (@slug, @title, @body, @summary, @date, @tags, @draft, @now)`,
    ).run({
      slug: input.slug,
      title: input.title,
      body: input.body,
      summary: input.summary,
      date: input.date,
      tags: input.tags,
      draft: input.draft,
      now: input.now,
    })
  })
  run()
  return existing ? 'updated' : 'inserted'
}

/** 库里全部文章的概览（CLI 的 `--list` 用；不做读者过滤，因为它就是给管理员看的）。 */
export function listArticlesForAdmin(): Array<
  Pick<ArticleRow, 'slug' | 'title' | 'date' | 'draft' | 'deletedAt' | 'tags'>
> {
  const rows = handle()
    .prepare(`SELECT slug, title, date, draft, deleted_at, tags FROM articles ORDER BY date DESC, slug ASC`)
    .all() as Array<Record<string, unknown>>
  return rows.map((r) => ({
    slug: String(r.slug),
    title: String(r.title),
    date: String(r.date),
    draft: Number(r.draft),
    deletedAt: r.deleted_at === null || r.deleted_at === undefined ? null : Number(r.deleted_at),
    tags: String(r.tags ?? '[]'),
  }))
}

/** 回收站里的一行（与 `listArticlesForAdmin` 同形，便于视图复用）。 */
export type TrashedArticleRow = Pick<ArticleRow, 'slug' | 'title' | 'date' | 'draft' | 'deletedAt' | 'tags'>

/**
 * 回收站里的文章（`deleted_at` 非空），**按删除时间倒序**（最近删的在最上面）。
 *
 * 规格 #48 的出口表把它单列成一个具名出口：**回收站是给管理员看的第三个读者面**，
 * 与读面、管理台都不共用名字。
 */
export function listTrashedArticles(): TrashedArticleRow[] {
  const rows = handle()
    .prepare(
      `SELECT slug, title, date, draft, deleted_at, tags FROM articles
        WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC`,
    )
    .all() as Array<Record<string, unknown>>
  return rows.map((r) => ({
    slug: String(r.slug),
    title: String(r.title),
    date: String(r.date),
    draft: Number(r.draft),
    deletedAt: Number(r.deleted_at),
    tags: String(r.tags ?? '[]'),
  }))
}

/**
 * 移进回收站（**软删除**）。返回 `changes`（重复移入得到 0，那是幂等性的证据）。
 *
 * `deleted_at` **正交**于 `draft`：它不覆盖「原来是草稿还是已发布」，
 * 所以还原时**自动回到删除前那个状态** —— 不需要 WordPress 那种 `_wp_trash_meta_status` 旁路。
 */
export function trashArticle(slug: string, now: number = Date.now()): number {
  return handle()
    .prepare(`UPDATE articles SET deleted_at = ? WHERE slug = ? AND deleted_at IS NULL`)
    .run(now, slug).changes
}

/** 从回收站还原。**只清 `deleted_at`，不碰 `draft`** —— 这就是「回到删除前那个状态」。 */
export function restoreArticle(slug: string): number {
  return handle()
    .prepare(`UPDATE articles SET deleted_at = NULL WHERE slug = ? AND deleted_at IS NOT NULL`)
    .run(slug).changes
}

/**
 * **彻底删除**：文章行 + 它的**全部修订行**，同一事务（规格 #48 的两个单元缝之一）。
 *
 * ⚠ 只对**回收站里**的文章生效（`deleted_at IS NOT NULL` 是硬条件）。
 * 不在回收站时**什么都不删**并返回 `article: 0` —— 调用方看计数，而不是靠一个会抛的异常。
 * 这个顺序是刻意的：**先确认删到了文章行，才去删修订** —— 否则一次误调用会把一篇活文章的
 * 历史全部抹掉，而文章还在。
 */
export function purgeArticle(slug: string): { article: number; revisions: number } {
  const db = handle()
  return db.transaction(() => {
    const article = db.prepare(`DELETE FROM articles WHERE slug = ? AND deleted_at IS NOT NULL`).run(slug).changes
    if (article !== 1) return { article, revisions: 0 }
    const revisions = db.prepare(`DELETE FROM article_revisions WHERE slug = ?`).run(slug).changes
    return { article, revisions }
  })()
}

/** 某篇文章的修订条数（「彻底删除」把它一起带走 —— 断言要用）。 */
export function countArticleRevisions(slug: string): number {
  const row = handle().prepare(`SELECT COUNT(*) AS n FROM article_revisions WHERE slug = ?`).get(slug) as { n: number }
  return row.n
}

/** 一条修订的**完整内容**（「逐版全文」要给用户看的就是这些）。 */
export interface ArticleRevisionRow {
  id: number
  slug: string
  title: string
  body: string
  summary: string | null
  date: string
  tags: string
  draft: number
  savedAt: number
}

function toRevisionRow(r: Record<string, unknown>): ArticleRevisionRow {
  return {
    id: Number(r.id),
    slug: String(r.slug),
    title: String(r.title),
    body: String(r.body),
    summary: r.summary === null || r.summary === undefined ? null : String(r.summary),
    date: String(r.date),
    tags: String(r.tags),
    draft: Number(r.draft),
    savedAt: Number(r.saved_at),
  }
}

/**
 * 某篇文章的全部修订，**最近的在最上面**。
 *
 * 修订**永久保留、永不清理**（#32 明确拒绝了 WordPress 那种 30 天自动清空）——
 * 所以这里没有 limit，也没有清理任务。代价是库会慢慢长，而那是被明确接受的代价。
 */
export function listRevisions(slug: string): ArticleRevisionRow[] {
  const rows = handle()
    .prepare(
      `SELECT id, slug, title, body, summary, date, tags, draft, saved_at
         FROM article_revisions WHERE slug = ? ORDER BY saved_at DESC, id DESC`,
    )
    .all(slug) as Array<Record<string, unknown>>
  return rows.map(toRevisionRow)
}

/** 取一条修订。**带上 `slug` 让调用方能核对它属不属于这篇文章**（退回时的第一道检查）。 */
export function getRevision(id: number): ArticleRevisionRow | undefined {
  const row = handle()
    .prepare(
      `SELECT id, slug, title, body, summary, date, tags, draft, saved_at FROM article_revisions WHERE id = ?`,
    )
    .get(id) as Record<string, unknown> | undefined
  return row ? toRevisionRow(row) : undefined
}

/**
 * 退回某一版：把那一版的**内容**复制回当前文章。
 *
 * ⚠ **不移指针、不删任何修订** —— 退回本身就是一次保存，所以它**自己也留一条修订**。
 * 否则「退回」会成为一个**不留痕迹**的动作，而它恰恰是最需要留痕的那个。
 *
 * ⚠ **保留当前的 `draft` 状态**：退回的是**内容**，不是「当时是草稿还是已发布」。
 * 把一篇已发布的文章退回某个草稿时期的版本，不该顺手把它撤下来 ——
 * 那会是一次没人要求的、读者可见的变化。
 */
export function revertToRevision(
  slug: string,
  revisionId: number,
  now: number = Date.now(),
): 'reverted' | 'unchanged' | 'missing' {
  const rev = getRevision(revisionId)
  if (!rev || rev.slug !== slug) return 'missing'
  const current = getArticleForAdmin(slug)
  if (!current) return 'missing'
  const out = upsertArticleWithRevision({
    slug,
    title: rev.title,
    body: rev.body,
    summary: rev.summary,
    date: rev.date,
    tags: rev.tags,
    draft: current.draft,
    now,
  })
  return out === 'unchanged' ? 'unchanged' : 'reverted'
}

/**
 * 全部文章与**全部修订**的正文（孤图判定要的「引用全集」）。
 *
 * ⚠ 修订也算引用：退回旧版时不能断图（规格 user story 38）。
 * ⚠ 这里**不吞异常** —— 读失败必须让调用方知道（孤图清理最怕把「读失败」当成「没有引用」）。
 */
export function allArticleBodies(): string[] {
  const rows = handle()
    .prepare(`SELECT body FROM articles UNION ALL SELECT body FROM article_revisions`)
    .all() as Array<{ body: string }>
  return rows.map((r) => r.body)
}

export function closeStore(): void {
  db?.close()
  db = null
}
