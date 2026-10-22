# 交接文档：代码扫描发现项 & 实现票起手指南

> **产出时间**：2026-10-17
> **产出方式**：全量扫描 `src/` 13 个源文件 + 22 个 open issue，交叉比对决议文档
> **交接目的**：列出可立即动手的改动项，按优先级排好，执行者逐条处理即可

---

## 一、立即可修的代码改动（独立提交，不阻塞任何实现票）

以下 8 项**互不依赖**，可以一次提交或分批提交。每项给出**文件、行号、现状、改法**。

### 改动 1 ▸ 密码最大长度校验（安全）

| | |
|---|---|
| **文件** | `src/users.ts` |
| **位置** | `assertPassword` 函数（约第 64–68 行） |
| **现状** | 只校验 `>= 8`，无上限。bcrypt 内部截断到 72 字节，超长密码被**静默截断**，用户不知情 |
| **改法** | 加最大长度检查 |

```ts
// 改前
function assertPassword(password: string): void {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`口令至少 ${MIN_PASSWORD_LENGTH} 位`)
  }
}

// 改后
const MAX_PASSWORD_LENGTH = 72

function assertPassword(password: string): void {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`口令至少 ${MIN_PASSWORD_LENGTH} 位`)
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    throw new Error(`口令最长 ${MAX_PASSWORD_LENGTH} 位`)
  }
}
```

**验证**：`npm run check:unit` 全过 + 手动测试超长密码被拒。

---

### 改动 2 ▸ `setPassword` 返回成功指示（正确性）

| | |
|---|---|
| **文件** | `src/users.ts` |
| **位置** | `setPassword` 函数（约第 177–182 行） |
| **现状** | 返回 `void`。传入不存在的 id 时 UPDATE 匹配 0 行，**静默无操作**，调用方不知道密码没改成 |
| **改法** | 改返回 `boolean`，调用方按需处理 |

```ts
// 改前
export function setPassword(id: number, password: string): void {
  assertPassword(password)
  db()
    .prepare(`UPDATE users SET password_hash = ?, updated_at = ?, token_version = token_version + 1 WHERE id = ?`)
    .run(bcrypt.hashSync(password, BCRYPT_COST), Date.now(), id)
}

// 改后
export function setPassword(id: number, password: string): boolean {
  assertPassword(password)
  const result = db()
    .prepare(`UPDATE users SET password_hash = ?, updated_at = ?, token_version = token_version + 1 WHERE id = ?`)
    .run(bcrypt.hashSync(password, BCRYPT_COST), Date.now(), id)
  return result.changes > 0
}
```

**注意**：改完后检查 `src/server.ts` 和 `src/cli/passwd.ts` 中调用 `setPassword` 的地方，当前调用方已经提前校验了用户存在性，所以**不需要改调用方逻辑**，但如果想更健壮可以加 `if (!setPassword(...)) { ... }` 的分支。

---

### 改动 3 ▸ 删除死代码 `getOverview` 和 `getLatencySeries`（卫生）

| | |
|---|---|
| **文件** | `src/store.ts` |
| **位置** | `getOverview`（约第 326–340 行）、`getLatencySeries`（约第 354–377 行） |
| **现状** | 两个导出函数**全项目无人调用**（已 grep 确认），是被 `getUptimeRaw` 和 `getLatencyRaw` 取代的旧实现 |
| **改法** | 直接删除这两个函数。同时检查 `OverviewPoint` 和 `LatencyPoint` 类型是否也无人引用，有则一并删 |

**验证**：`npm run typecheck` 编译通过即可证明无引用。

---

### 改动 4 ▸ `charts.ts` 的 `esc()` 统一到 `views.ts` 的 `escapeHtml`（卫生+安全）

| | |
|---|---|
| **文件** | `src/charts.ts` |
| **位置** | 第 8–14 行的 `esc()` 函数 |
| **现状** | 与 `views.ts` 的 `escapeHtml` 几乎一样，但**少了单引号转义**（`'` → `&#39;`）。属于弱化重复 |
| **改法** | 删除 `esc()`，从 `views.js` 导入 |

```ts
// 改前：charts.ts 顶部
function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

// 改后：charts.ts 顶部
import { escapeHtml as esc } from './views.js'
```

**验证**：`npm run check:chart` 全过。

---

### 改动 5 ▸ `uptimeChart` figcaption 浮点数格式化（显示 bug）

| | |
|---|---|
| **文件** | `src/charts.ts` |
| **位置** | 约第 152 行，`uptimeChart` 的 `<figcaption>` |
| **现状** | `Math.min(...nums)` 和 `Math.max(...nums)` 直接插值，可能输出 `33.33333333333333%` |
| **改法** | 加 `.toFixed(1)` |

```ts
// 改前
`范围 ${Math.min(...nums)}% – ${Math.max(...nums)}%`

// 改后
`范围 ${Math.min(...nums).toFixed(1)}% – ${Math.max(...nums).toFixed(1)}%`
```

---

### 改动 6 ▸ `dayStamp()` 改用 UTC 时间（跨时区一致性）

| | |
|---|---|
| **文件** | `src/backup.ts` |
| **位置** | `dayStamp` 函数（约第 32–35 行） |
| **现状** | 用本地时区方法（`getFullYear`/`getMonth`/`getDate`），Docker 容器或部署机时区不同时，同一天可能产出两份备份或跳过 |
| **改法** | 换成 UTC 方法 |

```ts
// 改前
function dayStamp(d = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

// 改后
function dayStamp(d = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`
}
```

**验证**：`npm run check:backup` 全过。

---

### 改动 7 ▸ `config.ts` 的 `num()` 支持零值（配置灵活性）

| | |
|---|---|
| **文件** | `src/config.ts` |
| **位置** | `num` 函数（约第 48–51 行） |
| **现状** | `parsed > 0` 导致 `PORT=0` 或 `CHECKPOINT_EVERY_ROUNDS=0` 等合法零值被静默忽略 |
| **改法** | 默认允许非负数 |

```ts
// 改前
function num(key: string, fallback: number): number {
  const parsed = Number(process.env[key])
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

// 改后
function num(key: string, fallback: number, positive = false): number {
  const parsed = Number(process.env[key])
  const ok = Number.isFinite(parsed) && (positive ? parsed > 0 : parsed >= 0)
  return ok ? parsed : fallback
}
```

**注意**：改完后检查所有 `num()` 调用点。`PORT`、`PROBE_TIMEOUT_MS`、`PROBE_INTERVAL_MS` 等不应为 0 的场景需传 `positive = true`。逐个确认后再提交。

---

### 改动 8 ▸ `store.ts` prepared statement 缓存（性能）

| | |
|---|---|
| **文件** | `src/store.ts` |
| **位置** | `insertStmt` 箭头函数（约第 91–94 行） |
| **现状** | 每次 `recordResults()` 都 `handle().prepare(...)` 创建新的 prepared statement，热路径上浪费 |
| **改法** | 改为懒初始化单例 |

```ts
// 改前
const insertStmt = () => handle().prepare(
  `INSERT INTO probes (...) VALUES (...)`,
)

// 改后
let _insertStmt: ReturnType<ReturnType<typeof handle>['prepare']> | null = null
const insertStmt = () => _insertStmt ??= handle().prepare(
  `INSERT INTO probes (...) VALUES (...)`,
)
```

---

## 二、不改的项（已有实现票覆盖或刻意保持）

| 发现项 | 不改的理由 |
|--------|-----------|
| **CSRF 保护缺失** | 已纳入 **#38**（写路径鉴权与 CSRF），#37 完成后紧接实现 |
| **登录无速率限制** | 用户已判定本次不做，保留在 map 迷雾 |
| **`content.ts` 全目录扫描 + 缓存不释放** | **#49** 正在把文章真源迁到 SQLite，此文件即将被替换 |
| **`probe.ts` 无并发上限** | 当前内网目标个位数，不是问题；**#40** 上线后目标可增删时再评估 |
| **`views.ts` 468 行模板字符串** | 项目刻意不引模板引擎（CONTEXT.md 决定）；**#45** 视觉改版时会重构 |

---

## 三、实现票起手指南

### 当前可并行的三条线

```
线路 A（关键路径）:  #37 会话记录与角色基座
                      ↓
                    #38 写路径鉴权与 CSRF
                      ↓
                    #39 管理台外壳与只读页面
                      ↓
                    #40 / #42 / #43 / #44（并行）
                      ↓
                    #46 验收收口 → #47 真机验收

线路 B（独立）:     #45 整站视觉：正文面纸感化
                    无依赖、无文件交叠，可与 A 完全并行

线路 C（独立）:     #49 文章引库与文档模型
                    无跨 map 依赖（②起才需要 #37/#38/#39）
```

### #37 是最大阻塞点

它阻塞了 Map #20 全部后续票 + Map #30 的 #50（文章管理台）。**建议最先认领**。

### #48 和 #41 是 `ready-for-agent` 的规格票

已经写好、标了 `ready-for-agent`，是 #49 和 #52 的实现参考依据，**不需要再做决定，直接当 spec 引用**。

---

## 四、执行者检查清单

- [ ] 改动 1–8 逐条完成
- [ ] 每条改完跑对应验证命令（文档中已标注）
- [ ] 全部改完跑一次 `npm run verify`（不含 e2e，e2e 需要起服务）
- [ ] 提交信息格式：`chore: <改了什么>` 或 `fix: <修了什么>`
- [ ] 推送前确认 `npm run typecheck` 零错误
- [ ] 推送后开始认领 #37 / #45 / #49（按线路分配）
