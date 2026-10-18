/**
 * 站点设置：`settings` 表的**纯库函数**（不碰 HTTP、不做页面）。
 *
 * 为什么单独一个文件：`store.ts` 是**探测历史**、`targets-store.ts` 是**目标清单**、
 * `sessions-store.ts` 是**会话记录**，设置是第四件事（`docs/settings-source-decision.md` §7）。
 *
 * 真源规则（§2）：**首次启动把「当前生效值」落库，此后 `.env` 完全不再参与这个键**。
 * 所以读值顺序是 **DB → env（只用于首次落值）→ 代码默认值**。
 * 为什么不做「env 永远优先」：那等于网页上的保存按钮在下次重启后**悄悄失效**
 * （用户改了标题、重启、发现改回来了，且没有任何提示）—— 静默 + 反复，是最坏的一类失败。
 *
 * 谁的键能进这张表，判据是 §0.1 的三条**都**满足：
 * 只影响渲染或节奏 · 改错了当场看得出来 · 不需要先有另一条通道才能救。
 * 所以标题 / 描述 / 探测间隔进库；会删数据的（`PROBE_RETENTION_DAYS` / `BACKUP_KEEP`）与
 * 会锁人的（`SITE_ORIGIN` / `TRUST_PROXY` / 会话安全参数）**一律留在 `.env`**。
 */
import { config, DEFAULT_SETTINGS } from './config.js'
import { initStore } from './store.js'

/** 白名单里的键。**合法键的集合是这个程序理解的键**，不是「库里恰好有哪些行」（§1）。 */
export type SettingKey = 'site.title' | 'site.description' | 'probe.intervalSeconds'

interface SettingSpec {
  key: SettingKey
  /** 页面上的中文标签。 */
  label: string
  kind: 'string' | 'int'
  /** 首次落值的来源（`.env` 的名字）。 */
  envVar: string
  /** 代码默认值（键缺行、或库里的值坏掉时用它）。 */
  def: string
  /** 仅 int：合法区间（写路径 400、读路径回退默认都用它）。 */
  min?: number
  max?: number
  /** 页面上的说明。 */
  hint: string
}

/**
 * 白名单与逐键规则（§3）。
 *
 * ⚠ `probe.intervalSeconds` 的下界 5 秒（【默认】）：内网个人站，1 秒一探对被监控系统不友好。
 * 上界 86400（一天）比「不小心填 0 导致探测停摆」多点余地。
 */
export const SETTINGS_SPEC: readonly SettingSpec[] = [
  {
    key: 'site.title',
    label: '站点标题',
    kind: 'string',
    envVar: 'SITE_TITLE',
    def: DEFAULT_SETTINGS['site.title'],
    min: 1,
    max: 60,
    hint: '顶栏、页签与页脚都用它。1–60 字。',
  },
  {
    key: 'site.description',
    label: '站点描述',
    kind: 'string',
    envVar: 'SITE_DESCRIPTION',
    def: DEFAULT_SETTINGS['site.description'],
    min: 0,
    max: 200,
    hint: '页脚的说明文字，也是页面的 meta description。0–200 字。',
  },
  {
    key: 'probe.intervalSeconds',
    label: '探测间隔（秒）',
    kind: 'int',
    envVar: 'PROBE_INTERVAL_SECONDS',
    def: DEFAULT_SETTINGS['probe.intervalSeconds'],
    min: 5,
    max: 86400,
    hint: '5–86400 秒。保存后**从下一轮开始**按新值探测；正在等的那一轮不会被打断。',
  },
] as const

export function specOf(key: string): SettingSpec | undefined {
  return SETTINGS_SPEC.find((s) => s.key === key)
}

const DDL = `
CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
`

let ddlReady = false
let seeded = false

/**
 * 建表 + 首次落值（与 `initTargets()` / `initUsers()` 同一条「每个导出函数都先走一遍」的写法）。
 *
 * 幂等：`INSERT` 只在键不存在时发生 ⇒ 重复启动不改动任何已有值，
 * 这也意味着**升级不会覆盖用户在网页上改过的任何东西**（§2）。
 */
export function initSettings(): void {
  const db = initStore()
  if (!ddlReady) {
    db.exec(DDL)
    ddlReady = true
  }
  if (seeded) return
  seeded = true

  const now = Date.now()
  const insert = db.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)`,
  )
  const rows = db.prepare(`SELECT key FROM settings`).all() as Array<{ key: string }>
  const present = new Set(rows.map((r) => r.key))

  for (const spec of SETTINGS_SPEC) {
    if (!present.has(spec.key)) {
      const value = effectiveFromEnv(spec)
      insert.run(spec.key, value, now)
      console.log(
        `[settings] ${spec.key} 已固定为「${value}」（来源：${envIsSet(spec) ? '.env' : '代码默认值'}）；` +
          `此后真源是 SQLite（改它请在 管理台 → 站点设置）`,
      )
      continue
    }
    // 库里有值 ⇒ `.env` 不再参与。**只在 env 真的设了、且与库值不同时说一句**——
    // 静默忽略 env 是最难排查的形状（§2 的那条警告是与 #26「文件被忽略」同一形状的配套）。
    if (envIsSet(spec) && effectiveFromEnv(spec) !== getSettingRaw(spec.key)) {
      console.warn(
        `[settings] ${spec.envVar} 已被忽略：${spec.key} 的真源是数据库（当前值「${getSettingRaw(spec.key)}」，` +
          `env 里写的是「${effectiveFromEnv(spec)}」）；要改请去 管理台 → 站点设置`,
      )
    }
  }

  // 代码不认识的键：忽略 + 警告，**绝不渲染**（§1）。
  for (const key of present) {
    if (!specOf(key)) {
      console.warn(`[settings] 忽略库里一个本程序不认识的设置键：${key}（它不会出现在页面上）`)
    }
  }
}

/** 库里那一行的原始文本；未知键或没有这行时给 `undefined`。 */
export function getSettingRaw(key: SettingKey): string | undefined {
  initSettings()
  const row = initStore().prepare(`SELECT value FROM settings WHERE key = ?`).get(key) as
    | { value: string }
    | undefined
  return row?.value
}

/** 写一个设置（键必须已在白名单里；值按字符串存，类型转换在读的时候做）。 */
export function setSetting(key: SettingKey, value: string, now: number = Date.now()): void {
  initSettings()
  initStore()
    .prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .run(key, value, now)
}

/**
 * 管理台要的清单：**只有白名单键**，按 `SETTINGS_SPEC` 的顺序，带上标签与说明。
 *
 * `bad` 与 `outOfFormRange` 是两件事，页面要分开说：
 * - `bad`：值**坏了**（空标题 / 非正整数）—— 读的时候已经回退默认，页面必须让人知道；
 * - `outOfFormRange`：值**能用但超出表单区间**（`.env` 首次落值来的 3 秒）——
 *   仍按它探测，但要提醒「想改就得守区间」，否则用户会对着 3 打出 400 一头雾水。
 */
export function listSettings(): Array<
  SettingSpec & { value: string; bad: boolean; outOfFormRange: boolean }
> {
  initSettings()
  return SETTINGS_SPEC.map((spec) => {
    const raw = getSettingRaw(spec.key)
    const value = raw ?? spec.def
    return {
      ...spec,
      value,
      bad: !isReadable(spec, raw),
      outOfFormRange: raw !== undefined && isReadable(spec, raw) && !withinFormRange(spec, raw),
    }
  })
}

/** 站点的呈现信息：**每请求读一次库**（改完标题下一次请求就生效）。 */
export function getSiteTitle(): string {
  return readSetting('site.title')
}

export function getSiteDescription(): string {
  return readSetting('site.description')
}

/** 探测间隔（毫秒）。探测循环每轮开始前读它（§4）。 */
export function getProbeIntervalMs(): number {
  return readSetting('probe.intervalSeconds') * 1000
}

export function getProbeIntervalSeconds(): number {
  return readSetting('probe.intervalSeconds')
}

/**
 * 读一个设置并按类型转换。
 *
 * **转换失败或越界 = 数据坏了**（手工改库、旧版本留下的值）→ 回退默认值 + `console.error`，
 * 绝不静默用 `NaN` 跑下去（`docs/settings-source-decision.md` §3）。
 * 注意这一条与 `.env` 的容错**故意不一致**：env 是启动期的容错（`PROBE_INTERVAL_SECONDS=0` →
 * 得到默认 60 秒），而库里的值是**有人正在看着的输入**，回去看就该看见一行 error。
 */
function readSetting(key: 'site.title' | 'site.description'): string
function readSetting(key: 'probe.intervalSeconds'): number
function readSetting(key: SettingKey): string | number {
  const spec = specOf(key)!
  const raw = getSettingRaw(key)
  if (raw === undefined) return spec.kind === 'int' ? Number(spec.def) : spec.def
  if (spec.kind === 'string') {
    if (!isReadable(spec, raw)) {
      console.error(`[settings] ${key} 的值不可用（空值），已回退默认值`)
      return spec.def
    }
    return raw
  }
  if (!isReadable(spec, raw)) {
    console.error(`[settings] ${key} 的值不是正整数（「${raw}」），已回退默认值 ${spec.def} 秒`)
    return Number(spec.def)
  }
  return Number(raw)
}

/** 表单区间（`spec.min`/`spec.max`）：**写路径**的判据，与读路径的「坏没坏」是两件事。 */
function withinFormRange(spec: SettingSpec, raw: string): boolean {
  if (spec.kind === 'string') {
    const len = raw.trim().length
    return len >= (spec.min ?? 0) && len <= (spec.max ?? Number.MAX_SAFE_INTEGER)
  }
  const n = Number(raw)
  return Number.isInteger(n) && n >= (spec.min ?? 0) && n <= (spec.max ?? Number.MAX_SAFE_INTEGER)
}

/**
 * 写路径的逐键校验：返回**人话的拒绝原因**（`null` = 通过）。
 *
 * 与读路径共用同一份 `SETTINGS_SPEC`；区间判据就是 `withinFormRange()`（一个来源）。
 *
 * `current` 是**库里当前那份值**：与原值一字不差时**直接放行**。
 * 为什么需要这一条：库里可能有一个合法但低于表单下界的值（`.env` 首次落值来的，见 `isReadable()`），
 * 没有它的话，用户只想改标题也会被「间隔 5–86400」拦下 400 —— 等于逼他去改一个他并不想动的值。
 */
export function validateSettingValue(key: string, raw: string, current?: string): string | null {
  const spec = specOf(key)
  if (!spec) return `未知的设置项：${key}`
  if (current !== undefined && raw === current) return null
  if (spec.kind === 'int') {
    if (!/^-?\d+$/.test(raw.trim())) return `${spec.label}必须是整数（${spec.min}–${spec.max}）。`
    const n = Number(raw)
    if (n < (spec.min ?? 0) || n > (spec.max ?? Number.MAX_SAFE_INTEGER)) {
      return `${spec.label}超出范围：只能是 ${spec.min}–${spec.max}（收到 ${n}）。`
    }
    return null
  }
  if (!withinFormRange(spec, raw)) {
    const len = raw.trim().length
    return len < (spec.min ?? 0)
      ? `${spec.label}不能为空（${spec.min}–${spec.max} 字）。`
      : `${spec.label}太长了：最多 ${spec.max} 字（收到 ${len} 字）。`
  }
  return null
}

/**
 * 读路径的可用性判据：**只问「这个值坏了没有」**，不问「它守不守表单的规矩」。
 *
 * ⚠ 这两件事必须分开（落地时踩到过）：`spec.min/max` 是**网页表单**的区间（防止有人手打 1 秒
 * 把被监控系统打爆），而库里可能有一个**合法但低于下界**的值 —— 它来自 `.env` 的首次落值
 * （`PROBE_INTERVAL_SECONDS=3` 是部署者的明确选择）。若读路径也按 5 秒判，升级之后探测间隔会
 * **静默变成 60 秒**（实测：整个 e2e 的探测节奏被这一条打乱，面板曲线全空）。
 * 所以：坏值（非整数 / ≤0 / 标题为空）才回退 + `console.error`；低于表单下界的值**照用**。
 */
function isReadable(spec: SettingSpec, raw: string | undefined): boolean {
  if (raw === undefined) return false
  if (spec.kind === 'string') return raw.trim().length >= (spec.min ?? 0)
  const n = Number(raw)
  return Number.isInteger(n) && n >= 1
}

/** 这个键的 `.env` 值是否真的被设置了（用来决定要不要打「env 被忽略」那行警告）。 */
function envIsSet(spec: SettingSpec): boolean {
  return Boolean(process.env[spec.envVar]?.trim())
}

/**
 * 首次落值时用的「当前生效值」——**取自 `config`**，也就是「已按 env 解析过、缺省已落到代码默认」的那份。
 * 这样 `.env` 里写坏的值（`PROBE_INTERVAL_SECONDS=abc`）在落库时就已经是容错后的 60，
 * 而不是把一个坏值搬进数据库。
 */
function effectiveFromEnv(spec: SettingSpec): string {
  switch (spec.key) {
    case 'site.title':
      return config.siteTitle
    case 'site.description':
      return config.siteDescription
    case 'probe.intervalSeconds':
      return String(Math.round(config.probeIntervalMs / 1000))
  }
}
