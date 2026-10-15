/**
 * 历史存储：每次探测写一行，查询时按时间窗口聚合。
 * 为什么用 SQLite：单文件、零运维、可直接挂 Docker volume；个人站这个写入量（分钟级、几十个目标）远未到需要 TSDB 的程度。
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
    db.exec(`ALTER TABLE probes ADD COLUMN round_at INTEGER`)
    // 旧数据的每一轮就是当时的单条记录，回填成 at 即可。
    db.exec(`UPDATE probes SET round_at = at WHERE round_at IS NULL`)
    console.log('[store] 已为历史表补上 round_at 列并回填')
  }
  // 补列之后再建索引。
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_probes_target_at ON probes (target_id, at DESC);
    CREATE INDEX IF NOT EXISTS idx_probes_round   ON probes (round_at ASC);
  `)
  return db
}

function handle(): Database.Database {
  return db ?? initStore()
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

/** 统计某个目标在窗口内的可用率与延迟。窗口内没数据时各项为 null。 */
export function getStats(targetId: string, windowMs: number): TargetStats {
  const since = Date.now() - windowMs
  const row = handle()
    .prepare(
      `SELECT
         target_id                                        AS targetId,
         COUNT(*)                                         AS samples,
         SUM(CASE WHEN status = 'up' THEN 1 ELSE 0 END)   AS upCount,
         AVG(CASE WHEN latency_ms IS NOT NULL THEN latency_ms END) AS avgLatencyMs,
         (SELECT status FROM probes p2
            WHERE p2.target_id = p1.target_id ORDER BY at DESC LIMIT 1)      AS lastStatus,
         (SELECT at FROM probes p3
            WHERE p3.target_id = p1.target_id ORDER BY at DESC LIMIT 1)      AS lastCheckedAt,
         (SELECT error FROM probes p4
            WHERE p4.target_id = p1.target_id AND p4.error IS NOT NULL
            ORDER BY at DESC LIMIT 1)                                        AS lastError
       FROM probes p1
       WHERE target_id = ? AND at >= ?`,
    )
    .get(targetId, since) as StatsRow | undefined

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
    upStreakMs: computeUpStreak(targetId),
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
 */
function computeUpStreak(targetId: string): number | null {
  const lastBad = handle()
    .prepare(
      `SELECT at FROM probes WHERE target_id = ? AND status != 'up' ORDER BY at DESC LIMIT 1`,
    )
    .get(targetId) as { at: number } | undefined

  const since = lastBad ? lastBad.at : 0
  const firstUpAfter = handle()
    .prepare(
      `SELECT at FROM probes WHERE target_id = ? AND status = 'up' AND at > ? ORDER BY at ASC LIMIT 1`,
    )
    .get(targetId, since) as { at: number } | undefined

  if (!firstUpAfter) return 0
  const last = handle()
    .prepare(`SELECT at, status FROM probes WHERE target_id = ? ORDER BY at DESC LIMIT 1`)
    .get(targetId) as { at: number; status: string } | undefined
  if (last && last.status !== 'up') return 0
  return Date.now() - firstUpAfter.at
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

/** 全局事件流（最近的故障），给首页「最近异常」用。 */
export function getRecentIncidents(limit = 8): Array<ProbeResult & { at: number }> {
  const rows = handle()
    .prepare(
      `SELECT target_id AS targetId, at, status, latency_ms AS latencyMs,
              status_code AS statusCode, error
         FROM probes
        WHERE status != 'up'
        ORDER BY at DESC
        LIMIT ?`,
    )
    .all(limit) as Array<ProbeResult>
  return rows
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

/** 单目标在窗口内的原始探测序列（只取有延迟的那些点），用于「按实际采样密度」画曲线。 */
export function getLatencyRaw(targetId: string, windowMs: number, limit = 120): LatencyPoint[] {
  const since = Date.now() - windowMs
  const rows = handle()
    .prepare(
      `SELECT at, latency_ms AS avgLatencyMs, 1 AS samples
         FROM probes
        WHERE target_id = ? AND at >= ?
        ORDER BY at ASC
        LIMIT ?`,
    )
    .all(targetId, since, limit) as LatencyPoint[]
  // 失败点保留为 null，让曲线断开——把失败画成 0 会让图看起来"更快了"。
  return rows.map((r) => ({ at: r.at, avgLatencyMs: r.avgLatencyMs, samples: 1 }))
}

/**
 * 全局可用率走势：按探测轮次聚合，每个点 = 该轮「可用目标数 / 参与目标数」。
 *
 * 只保留「参与目标数 >= 当前目标数」的轮次。原因：从旧库迁移来的记录每轮只有 1 个目标，
 * 它们的 1/1 会画成 100%、0/1 画成 0%，与现在每轮的 1/3=33% 混在一张图里就是锯齿，
 * 且会让人误以为可用率曾经大幅波动。宁可少几个点，也不要给出含义不一致的曲线。
 */
export function getUptimeRaw(windowMs: number, limit = 120): OverviewPoint[] {
  const since = Date.now() - windowMs
  const expected = Math.max(1, config.targets.filter((t) => t.enabled !== false).length)
  const rows = handle()
    .prepare(
      `SELECT round_at AS at, COUNT(*) AS total,
              SUM(CASE WHEN status = 'up' THEN 1 ELSE 0 END) AS up
         FROM probes
        WHERE at >= ?
        GROUP BY round_at
       HAVING total >= ?
        ORDER BY round_at ASC
        LIMIT ?`,
    )
    .all(since, expected, limit) as Array<{ at: number; total: number; up: number }>
  return rows.map((r) => ({ at: r.at, up: r.up, total: r.total }))
}

export function closeStore(): void {
  db?.close()
  db = null
}
