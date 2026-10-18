/**
 * 目标清单：`targets` 表的**纯库函数**（不碰 HTTP、不做页面）。
 *
 * 为什么单独一个文件（而不是塞进 `store.ts`）：与 #29 开 `sessions-store.ts` 同一条理由 ——
 * `store.ts` 是**探测历史**，`targets` 是**目标清单**，两件事。
 * 建表风格照抄 `users.ts` 的「建表 + 就地补列」；DDL 留在本文件里跟目标代码作伴。
 *
 * 真源规则（`docs/targets-source-decision.md` §2）：**`targets` 表为空时才导入一次**
 * `targets.json` / `TARGETS_JSON`，此后**文件被完全忽略**（只打一行警告）。
 * 这与文章的「首次导入」是同一条纪律，命名也刻意对称（`importTargetsIfEmpty` /
 * `warnTargetsFileIsNoLongerInput` ↔ `content.ts` 的 `importArticlesIfEmpty` /
 * `warnContentDirIsNoLongerInput`）。
 */
import { config, targetsSourceLabel, type ProbeTarget } from './config.js'
import { initStore } from './store.js'

/**
 * 库里一行目标的完整样子（管理台要）：`ProbeTarget` 的字段 + 状态变更时刻 + 「有没有历史」。
 *
 * `hasHistory` 是**删除两岔的判据**（§4）：没历史才能物理删，有历史只能停用。
 * 它在同一条 SQL 里用 `EXISTS` 现算 —— 不落库、不缓存（计数/存在性是「一眼的状态」）。
 */
export interface TargetRecord {
  id: string
  name: string
  url: string
  group?: string
  expectStatus?: number[]
  timeoutMs?: number
  enabled: boolean
  /** 当前启用状态的起始时刻（§5）：停用/启用都会刷新它。 */
  enabledAt: number
  updatedAt: number
  hasHistory: boolean
}

/**
 * 表结构（§1）。
 *
 * - 列名叫 `grp` 不叫 `group`：`GROUP` 是 SQL 保留字，用它当列名每条 SQL 都要加引号，
 *   而**漏加一处**的报错会变成日常维护里的常客。领域词仍是「分组」（`CONTEXT.md`）。
 * - `expect_status` 存 JSON 文本：它最长就是 `[200,301]` 这种几元素数组，
 *   拆表要引 join 与排序，而用法只是「整取整存、判断包含」。
 * - 没有指向 `probes` 的外键：历史行可能比目标活得久（停用只置 `enabled=0`），
 *   而我们的答案就是「不删有历史的目标」（§4），外键挡不住任何真实情形。
 */
const DDL = `
CREATE TABLE IF NOT EXISTS targets (
  id            TEXT    PRIMARY KEY,
  name          TEXT    NOT NULL,
  url           TEXT    NOT NULL,
  grp           TEXT,
  expect_status TEXT,
  timeout_ms    INTEGER,
  enabled       INTEGER NOT NULL DEFAULT 1,
  enabled_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_targets_enabled ON targets (enabled);
`

interface RawRow {
  id: string
  name: string
  url: string
  grp: string | null
  expect_status: string | null
  timeout_ms: number | null
  enabled: number
  enabled_at: number
  updated_at: number
}

let ddlReady = false
let importDone = false
/** 本进程刚做过一次**真的**首次导入（导入了 ≥1 行）—— 用来避免把同一件事说两遍。 */
let importedThisProcess = false

/**
 * 建表 + 首次导入。启动顺序 `initStore → initUsers → initTargets`（§2）；
 * 每个导出函数也都会走一遍（幂等、廉价），这样直接 import 本模块的脚本不会因为
 * 「忘了先调 initTargets」而撞上 `no such table: targets`。
 */
export function initTargets(): void {
  const db = initStore()
  if (!ddlReady) {
    db.exec(DDL)
    ddlReady = true
  }
  if (!importDone) {
    importDone = true
    importTargetsIfEmpty()
  }
}

/**
 * **首次导入**：`targets` 表为空时才读 `targets.json` / `TARGETS_JSON`。
 *
 * 判据是「表为空」而不是一个持久化的标志位（§2）：标志位自己也会被「恢复了一份旧备份」
 * 「手工改库」搞坏，而 `COUNT(*) = 0` 是从数据本身推出来的。代价是把表清空后再启动会**再导一次** ——
 * 那恰好是「我把目标删光了、想回到文件」的合理期望。
 *
 * 整段包在一个事务里、用 `INSERT OR IGNORE`：要么全进要么全不进，重复执行（并发启动两个进程）
 * 也不会出现重复行。返回导入的行数。
 */
export function importTargetsIfEmpty(): number {
  const db = initStore()
  if (countAllTargets() > 0) return 0
  const incoming = config.targets
  if (!incoming.length) return 0

  const now = Date.now()
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO targets
       (id, name, url, grp, expect_status, timeout_ms, enabled, enabled_at, updated_at)
     VALUES (@id, @name, @url, @grp, @expect_status, @timeout_ms, @enabled, @enabled_at, @updated_at)`,
  )
  try {
    const inserted = db.transaction((rows: ProbeTarget[]) => {
      let n = 0
      for (const t of rows) n += stmt.run(toParams(t, now)).changes
      return n
    })(incoming)
    console.log(
      `[targets] 首次导入 ${inserted} 个目标（来源：${targetsSourceLabel()}）；此后真源是 SQLite`,
    )
    // 这一次导入已经把「文件退休了」说清楚了，启动时那行警告不必再说一遍（见下面的函数）。
    if (inserted > 0) importedThisProcess = true
    return inserted
  } catch (err) {
    // 并发启动可能撞上 SQLITE_BUSY：主键 + INSERT OR IGNORE 保证了一行都不会重复，
    // 而这里**不能把它变成启动失败** —— 目标暂时没得探，远好过站点起不来。
    console.warn('[targets] 首次导入失败（不影响启动）：' + (err as Error).message)
    return 0
  }
}

/**
 * 启动时的那行警告：文件不再是输入了（§2 的配套）。
 *
 * **静默忽略才是最难排查的形状**：用户改了文件、重启，发现「没生效也没报错」。
 * 提示要说清三件事：文件被忽略、真源是数据库、要改就去管理台。
 * 只在真有输入时打 —— 全新部署（没有文件也没有 `TARGETS_JSON`）不该被吓一跳；
 * **刚做过首次导入的那一次也不打**（上面那行日志已经说了同一件事，两行会互相打脸）。
 */
export function warnTargetsFileIsNoLongerInput(): void {
  if (importedThisProcess) return
  if (!config.targets.length) return
  console.warn(
    `[targets] ${targetsSourceLabel()} 里的 ${config.targets.length} 个目标**不再是输入**` +
      `（真源已搬到 SQLite）；要增删改目标请在 管理台 → 目标 里改`,
  )
}

/** 探测轮次要的清单：只取启用中的，映射回 `ProbeTarget`（带 `enabledAt`，供连续可用下界用）。 */
export function listEnabledTargets(): ProbeTarget[] {
  initTargets()
  const rows = initStore()
    .prepare(`SELECT * FROM targets WHERE enabled = 1 ORDER BY id`)
    .all() as RawRow[]
  return rows.map(toProbeTarget)
}

/** 管理台要的清单：**全部**目标（含停用的），带 `hasHistory`。按分组排序，未分组排最后。 */
export function listAllTargets(): TargetRecord[] {
  initTargets()
  const rows = initStore()
    .prepare(
      `SELECT t.*, EXISTS (SELECT 1 FROM probes p WHERE p.target_id = t.id) AS hasHistory
         FROM targets t
        ORDER BY (t.grp IS NULL OR t.grp = ''), t.grp ASC, t.id ASC`,
    )
    .all() as Array<RawRow & { hasHistory: number }>
  return rows.map((r) => ({ ...toTargetRecord(r), hasHistory: r.hasHistory === 1 }))
}

export function getTarget(id: string): TargetRecord | undefined {
  initTargets()
  const row = initStore()
    .prepare(
      `SELECT t.*, EXISTS (SELECT 1 FROM probes p WHERE p.target_id = t.id) AS hasHistory
         FROM targets t WHERE t.id = ?`,
    )
    .get(id) as (RawRow & { hasHistory: number }) | undefined
  return row ? { ...toTargetRecord(row), hasHistory: row.hasHistory === 1 } : undefined
}

export function countAllTargets(): number {
  initTargets()
  return (initStore().prepare(`SELECT COUNT(*) AS n FROM targets`).get() as { n: number }).n
}

export function countEnabledTargets(): number {
  initTargets()
  return (
    initStore().prepare(`SELECT COUNT(*) AS n FROM targets WHERE enabled = 1`).get() as { n: number }
  ).n
}

/**
 * 新增一个目标。
 *
 * 「id 已存在」靠**主键唯一约束 + 捕获 `SQLITE_CONSTRAINT_PRIMARYKEY`** 兜底，而不是「先查再插」——
 * 后者是 TOCTOU 的形状：今天单进程串行使它不会触发，但依赖「今天不会并发」是脆的（§6.1）。
 */
export function createTarget(t: ProbeTarget, now: number = Date.now()): 'created' | 'duplicate' {
  initTargets()
  try {
    initStore()
      .prepare(
        `INSERT INTO targets
           (id, name, url, grp, expect_status, timeout_ms, enabled, enabled_at, updated_at)
         VALUES (@id, @name, @url, @grp, @expect_status, @timeout_ms, @enabled, @enabled_at, @updated_at)`,
      )
      .run(toParams(t, now))
    return 'created'
  } catch (err) {
    if (isPrimaryKeyError(err)) return 'duplicate'
    throw err
  }
}

/**
 * 编辑一个目标：**不含 `id`**（§3）。
 *
 * 不是「忘了写」，而是刻意没有这个参数：`id` 是 `probes.target_id` 的关联键，
 * 改它等于把旧历史全变成孤儿。要换 id 就是「新增一个 + 停用旧的」两步显式动作。
 * 返回 `changes`（0 = 这个 id 已经不在库里，调用方据此报 400 而不是假装成功）。
 */
export function updateTarget(
  id: string,
  patch: {
    name: string
    url: string
    group?: string
    expectStatus?: number[]
    timeoutMs?: number
  },
  now: number = Date.now(),
): number {
  initTargets()
  return initStore()
    .prepare(
      `UPDATE targets
          SET name = ?, url = ?, grp = ?, expect_status = ?, timeout_ms = ?, updated_at = ?
        WHERE id = ?`,
    )
    .run(
      patch.name,
      patch.url,
      patch.group ?? null,
      patch.expectStatus?.length ? JSON.stringify(patch.expectStatus) : null,
      patch.timeoutMs ?? null,
      now,
      id,
    ).changes
}

/**
 * 启用 / 停用。**永不设卡的恢复通道**（`docs/roles-decision.md` §3 的同一精神）。
 *
 * 两个方向都刷新 `enabled_at`（§5）：它的定义就是「**当前**启用状态的起始时刻」，
 * 而一次状态变更就是当前状态的起点。这样「停用两个月再启用」之后的连续可用
 * 从重新启用那一刻算起，说的是实话。
 */
export function setTargetEnabled(
  id: string,
  enabled: boolean,
  now: number = Date.now(),
): number {
  initTargets()
  return initStore()
    .prepare(`UPDATE targets SET enabled = ?, enabled_at = ?, updated_at = ? WHERE id = ?`)
    .run(enabled ? 1 : 0, now, now, id).changes
}

/**
 * 「删除」的两岔（§4）：**没有历史**才物理删（收拾打错的 id），有历史一律停用。
 *
 * 判据是「有没有东西可丢」—— 所以这条规则没有任何需要用户判断的地方。
 * `COUNT(*)`/`EXISTS` 与随后的 `DELETE`/`UPDATE` **必须在同一个事务里**：
 * 否则「查的时候没历史、删的时候已经多了一行探测记录」就漏了（§6.1）。
 */
export function removeOrDisableTarget(
  id: string,
  now: number = Date.now(),
): 'deleted' | 'disabled' | 'missing' {
  initTargets()
  const db = initStore()
  const tx = db.transaction((targetId: string): 'deleted' | 'disabled' | 'missing' => {
    const row = db.prepare(`SELECT id FROM targets WHERE id = ?`).get(targetId)
    if (!row) return 'missing'
    const hist = db
      .prepare(`SELECT EXISTS (SELECT 1 FROM probes p WHERE p.target_id = ?) AS h`)
      .get(targetId) as { h: number }
    if (hist.h === 1) {
      db.prepare(`UPDATE targets SET enabled = 0, enabled_at = ?, updated_at = ? WHERE id = ?`).run(
        now,
        now,
        targetId,
      )
      return 'disabled'
    }
    db.prepare(`DELETE FROM targets WHERE id = ?`).run(targetId)
    return 'deleted'
  })
  return tx(id)
}

/** 库里每一行 `targets` 的原始形态（测试与诊断用）。 */
export function rawTargets(): Array<Record<string, unknown>> {
  initTargets()
  return initStore().prepare(`SELECT * FROM targets ORDER BY id`).all() as Array<
    Record<string, unknown>
  >
}

/** 主键冲突的两种写法都认：better-sqlite3 给扩展码，个别版本只给 `SQLITE_CONSTRAINT`。 */
function isPrimaryKeyError(err: unknown): boolean {
  const code = String((err as { code?: string })?.code ?? '')
  return code === 'SQLITE_CONSTRAINT_PRIMARYKEY' || code === 'SQLITE_CONSTRAINT'
}

function toParams(t: ProbeTarget, now: number): Record<string, unknown> {
  return {
    id: t.id,
    name: t.name,
    url: t.url,
    grp: t.group ?? null,
    expect_status: t.expectStatus?.length ? JSON.stringify(t.expectStatus) : null,
    timeout_ms: t.timeoutMs ?? null,
    enabled: t.enabled === false ? 0 : 1,
    // `enabled_at`：导入/新增那一刻就是「当前启用状态」的起点。
    // 对**升级上来的库**这会重置连续可用的起算点（历史还在，只是「这一段连续」从迁移起算）——
    // 这是 §5 那条规则的一次性代价，且方向是保守的（少报而不是多报）。
    enabled_at: t.enabledAt ?? now,
    updated_at: now,
  }
}

function toProbeTarget(r: RawRow): ProbeTarget {
  return {
    id: r.id,
    name: r.name,
    url: r.url,
    group: r.grp ?? undefined,
    expectStatus: parseExpectStatus(r.expect_status),
    timeoutMs: r.timeout_ms ?? undefined,
    enabled: r.enabled === 1,
    enabledAt: r.enabled_at,
  }
}

function toTargetRecord(r: RawRow): Omit<TargetRecord, 'hasHistory'> {
  return {
    id: r.id,
    name: r.name,
    url: r.url,
    group: r.grp ?? undefined,
    expectStatus: parseExpectStatus(r.expect_status),
    timeoutMs: r.timeout_ms ?? undefined,
    enabled: r.enabled === 1,
    enabledAt: r.enabled_at,
    updatedAt: r.updated_at,
  }
}

/** `expect_status` 是一列 JSON 文本；脏值当作「没写」——一条坏数据不该让整页 500。 */
function parseExpectStatus(raw: string | null): number[] | undefined {
  if (!raw) return undefined
  try {
    const v: unknown = JSON.parse(raw)
    if (!Array.isArray(v)) return undefined
    const codes = v.filter((n): n is number => typeof n === 'number' && Number.isFinite(n))
    return codes.length ? codes : undefined
  } catch {
    return undefined
  }
}
