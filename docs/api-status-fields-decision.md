# `/api/status` 字段收敛：实现决定

本文件是「`/api/status` 字段收敛」这张票的产出。
回答五个问题：**公开字段白名单**、**曲线数据留不留**、**页面 URL 怎么办**、**`lastError` 要不要脱敏**、**投影写在哪**。

票：<https://github.com/Lkyloveaw/personal-wiki/issues/5>

已确认的前提（不再论证）：字段收敛，**URL 不出网**。

---

## 0. 先看现状：实测的字段面

在本机真起服务、真探四个目标（可用 / 状态码不符 / 不可达 / 域名解析不了），抓一份真实响应：

**顶层**：`targets`、`overview`、`incidents`、`generatedAt`、`windowLabel`、`probeIntervalSeconds`

**`targets[]` 每项**：`target`、`stats`、`timeline`、`latency`

| 子对象 | 字段 |
| --- | --- |
| `target` | `id`、`name`、**`url`**、`group`、**`expectStatus`**、`enabled` |
| `stats` | `targetId`、`samples`、`upCount`、`uptime`、`avgLatencyMs`、`p95LatencyMs`、`lastStatus`、`lastCheckedAt`、`lastError`、`upStreakMs` |
| `timeline[]` | `at`、`status`、`latencyMs` |
| `latency[]` | `at`、`avgLatencyMs`、`samples` |

实测确认泄漏面（这三点都必须修）：

```
含 https://example.com/ : true
含 10.255.255.1        : true      ← 内网地址
含 expectStatus 值 999 : true      ← 探测判定口径
```

而前端 `public/status.js` **只读 5 个字段**：`lastStatus`、`uptime`、`avgLatencyMs`、`p95LatencyMs`、`lastError`。

**结论：现在这个端点把「目标清单的内部细节」当成了前端契约。** 收敛不是加个过滤，而是把契约重新画一遍。

---

## 1. ⚠ 实测发现：`lastError` 是一条**独立于 `url` 的泄漏旁路**，而且会漏口令

票里把「URL 不出网」和「`lastError` 是否脱敏」列成了两个问题，实测证明**它们是同一个问题**。

`probe.ts:55` 的兜底是：

```
error: aborted ? `超时（>${timeout}ms）` : (e.cause?.code ?? e.message ?? '未知错误')
```

`e.message` 是**未脱敏的原文**。喂一个带凭证的 URL 进去，实测落库结果：

| 目标 URL | 落库 `error` | 含主机名 | 含口令 |
| --- | --- | --- | --- |
| `http://ops:hunter2@ledger.internal.example/` | `Request cannot be constructed from a URL that includes credentials: http://ops:hunter2@ledger.internal.example/` | **是** | **是** |
| `http://ledger.internal.example:nope/` | `ERR_INVALID_URL` | 否 | 否 |
| `file:///etc/passwd` | `fetch failed` | 否 | 否 |
| `ledger.internal.example:8080`（缺 scheme） | `fetch failed` | 否 | 否 |

更关键的一步验证：**先把 `target.url` 从响应里投影掉，再看还剩什么在漏**。结果是——

```
投影后仍泄漏的叶子字段：
  targets[4].lastError
     -> "Request cannot be constructed from a URL that includes credentials: http://ops:hunter2@ledger.internal.example/"
  incidents[0].error
     -> "...（同上，同一条记录）"
```

**即：把 `url` 删掉之后，主机名与口令照样从 `error` 字段出网。** 所以「`lastError` 必须脱敏」不是附加题，它是「URL 不出网」这个决定的一部分；而且**脱敏必须做在写入侧**——投影层不可能知道某条字符串里嵌着一个 URL 和一个口令。

---

## 2. 公开字段白名单

**结论：`/api/status` 返回一个显式的白名单投影，逐字段列举，新增字段默认不出现。**

设计判据：**每个字段都必须能回答「前端哪个 DOM 更新在用它」。** 答不上来的就是内部细节，删。

### 2.1 `targets[]`：扁平化成一项 10 个键

把 `target` / `stats` / `timeline` / `latency` 四层**压成一层**。现在前端写 `item.stats.lastStatus`，是**为了让渲染层直接吃 `TargetStats` 这个内部结构**——这是内部类型泄漏成外部契约。扁平之后前端写 `item.lastStatus`，内部 `TargetStats` 加字段也不会自动出网。

**实测断言过的完整键集（有且仅有这 10 个）**：

```
["avgLatencyMs","group","id","lastError","lastStatus","latency","name","p95LatencyMs","timeline","uptime"]
```

| 公开字段 | 来源 | 前端用在哪 | 理由 |
| --- | --- | --- | --- |
| `id` | `target.id` | `card.querySelector('[data-target="' + id + '"]')` | 唯一的卡片寻址键，必须留 |
| `name` | `target.name` | 卡片 `<h3>`、首页迷你行 | 给人看的标签，不是地址 |
| `group` | `target.group` | 分组标题 | 面板分区用；与 URL 无关，不敏感 |
| `lastStatus` | `stats.lastStatus` | `.dot` 的 class（ok/warn/bad） | 核心状态 |
| `uptime` | `stats.uptime` | `.uptime` 文本 | 核心指标 |
| `avgLatencyMs` | `stats.avgLatencyMs` | `.kv dd[0]` | 核心指标 |
| `p95LatencyMs` | `stats.p95LatencyMs` | `.kv dd[1]` | 核心指标 |
| `lastError` | `stats.lastError`（**脱敏后**，见 §4） | `.target-error` | 失败要显眼（本仓库既有取舍），但必须脱敏 |
| `timeline` | `getTimeline()` | 状态条（实时重绘票会用） | 见 §3 |
| `latency` | `getLatencyRaw()` | 延迟曲线（实时重绘票会用） | 见 §3 |

**被删掉的字段及理由**：

| 删掉 | 理由 |
| --- | --- |
| `url` | 本票的核心：内网资产台账的地址不出网 |
| `expectStatus` | 暴露探测判定口径；实测值为 `[999]` 这种「故意判失败」的配置，属运维内部细节，前端也不用 |
| `enabled` | 前端不用（被禁用的目标根本不进 `buildSummary`）；暴露运维开关状态无收益 |
| `targetId` | 与 `id` 完全重复 |
| `samples` | 前端不用，是内部统计口径——**注意 e2e 现在拿它当「探够了几轮」的信号，见 §6** |
| `upCount` | 前端不用；`uptime` 已足够 |
| `lastCheckedAt` | 前端**当前不刷新它**（`.kv dd[3]` 由 SSR 渲染）。留在页面里，不进 API |
| `upStreakMs` | 同上：SSR 渲染「连续可用」，前端不刷新 |

> `lastCheckedAt` / `upStreakMs` 被删是本票一个**有意的取舍**：它们在页面上可见，靠的是 SSR，所以「API 里没有」不造成功能回退。若日后要前端刷新它们，那是「曲线实时重绘」票的范围（见 §8），届时按白名单流程加回。

### 2.2 顶层（6 个键）

```
["generatedAt","incidents","overview","probeIntervalSeconds","targets","windowLabel"]
```

| 公开字段 | 前端用在哪 | 理由 |
| --- | --- | --- |
| `targets` | `paint()` 主循环 | 主体 |
| `overview` | `uptimeChart` 的输入 | 整体走势；点只含 `at`/`up`/`total`，**不含任何 URL** |
| `incidents` | 页面「近期异常」列表 | 见下 |
| `generatedAt` | 可见于 `#status-root[data-generated]` | 「数据是什么时候的」——让「数据是旧的」可判定，对可用性面板是刚需 |
| `windowLabel` | 统计窗口说明 | 口径说明，不含内部信息 |
| `probeIntervalSeconds` | 「每 N 秒探测」提示 | 同上 |

`incidents[]` 的元素形状：`{targetId, at, status, statusCode, latencyMs, error}`。
`error` **走与 `lastError` 完全相同的脱敏规则**，否则修了一处、漏了另一处（§1 的实测正是靠这一点抓出来的）。
这里的 `targetId` 保留：它是「把事件关联回目标名」的连接键，与 §2.1 里被删的那个重复字段不是一回事。

---

## 3. 曲线数据（`timeline` / `latency`）留不留

**结论：留**，但要**显式投影**，不能直接透传内部行对象。

理由：本仓库既有取舍是「曲线是服务端内联 SVG，**不引图表库**」，且 map 已定「曲线要真的实时（跟数值一起 30 秒重绘）」。所以「曲线实时重绘」票**必须**能从 API 拿到曲线数据——现在删掉等于把那张票的路堵死，然后再加回来。

已核对它们**不含 URL 类敏感信息**：

- `timeline[]` = `{at, status, latencyMs}` —— 时间、三态、耗时
- `latency[]` = `{at, avgLatencyMs}` —— 时间、均值

**但这里有个契约维护上的坑**：曲线数据现在是 `getTimeline()` / `getLatencyRaw()` 的**原始返回**，也就是说 `store.ts` 改一下 SELECT 就会**自动改变公开 API 的字段面**，白名单于是形同虚设。

**决定：曲线点也要挑字段**（`timeline` 丢掉多余列、`latency` 丢掉 `samples`），与 §2 一样是白名单。这样新增一个内部列不会自动出网。
注意 `latency[]` 丢掉的 `samples` 与 §2.1 里 `stats.samples` 被删是**同一类东西**：内部统计口径。

**容量代价**（已核对，可接受）：`timeline` 是 `getTimeline(…, 60)`、`latency` 是 `getLatencyRaw(…, 120)`，都**有硬上限**，响应体不随运行时长增长。本票只需保证这个上限不被打破。

---

## 4. `lastError` 脱敏：写入侧分流（这一节被自己的实测推翻过一次）

**结论：脱敏，但必须先在写入侧把「两类错误」分开**——probe.ts 自己生成的分类文案**原样保留**，运行时异常的原文**一律不许落库**。

### 4.1 先看清 `error` 列里混装了两类东西

实测（复刻 `probe.ts` 各分支的写入语义后逐条跑）：

| 场景 | 谁生成的 | 有没有 code | 落库原文 |
| --- | --- | --- | --- |
| 目标超时 | **probe.ts 自己**（`超时（>${timeout}ms）`） | **没有** | `超时（>1500ms）` |
| 状态码不符 | **probe.ts 自己** | **没有** | `状态码 200 不在预期范围内` |
| DNS 失败 | 运行时异常 | 有 `ENOTFOUND` | `ENOTFOUND` |
| 连接被拒 | 运行时异常 | 有 `ECONNREFUSED` | `ECONNREFUSED` |
| 带凭证 URL | 运行时异常，**无 code** | 没有 | 长句原文，**含主机名与口令** |

根因：`error` 这一列同时承担了「给人看的分类文案」与「异常的原始文本」两个职责。

### 4.2 ⚠ 第一版草案被实测推翻（记录在案，不要重走）

第一版草案是一条 `classifyError(code)`：没有 code 就兜底成「探测失败」。套到上表上是这样：

```
"超时（>3000ms）"                                     -> "探测失败"   ★信息丢失
"超时（>1500ms）"                                     -> "探测失败"   ★信息丢失
"ENOTFOUND"                                          -> "DNS 解析失败（ENOTFOUND）"
"Request cannot be constructed ... hunter2@... "      -> "探测失败"   （这条收敛对了）
```

**超时的目标拿不到 code，于是「等了多久」被抹掉了**——正好摧毁 §4.4 要保住的那个排障线索。
所以：**单靠「类别码白名单」是错的，分类必须按「谁生成的」分流。**

### 4.3 修正后的规则

**在 `probe.ts` 写入侧**做（不是渲染侧、不是投影侧）：

1. **probe.ts 自己拼的文案 → 原样保留。** 它本来就只含状态码与超时值，天然安全，且是信息量最大的部分：
   - `超时（>1500ms）`
   - `状态码 200 不在预期范围内`
2. **运行时异常 → 白名单类别映射，兜底绝不回原文**：

| 情形 | 落库/出网文本 | 为什么安全 |
| --- | --- | --- |
| DNS 失败 | `DNS 解析失败（ENOTFOUND）` | 只留类别码 |
| 连接被拒 | `连接被拒（ECONNREFUSED）` | 同上 |
| 连接重置 / 网络不可达 / 主机不可达 | `连接被重置（ECONNRESET）` 等 | 同上 |
| TLS 证书问题 | `证书已过期（CERT_HAS_EXPIRED）` 等 | 同上 |
| URL 非法 | `URL 非法（ERR_INVALID_URL）` | 同上 |
| 未映射的新 code | `探测失败（SOMETHING_NEW）` | 只带 code，不带文本 |
| **没有 code** | **`探测失败`** | 兜底，绝不含原文 |

**命门一条：`probe.ts:55` 的 `?? e.message` 必须删掉。** 任何「保留原文兜底」的写法都会把 §1 实测的那条泄漏重新打开。**白名单生成 + 兜底不回原文**，两个条件缺一不可。

**为什么把脱敏放在写入侧而不是渲染侧**：`lastError`（页面 `.target-error`、前端 `paint()`）与 `incidents[].error`（页面 `.incident-err`）都从**同一列**读。写入侧做一次，三处都干净；渲染侧做要记得做三遍——而 §1 的实测正是「差点漏掉 incidents 那一处」。

**存量脏数据**：库里已经写进去的原文不会自己变干净（本机库里已实测存在一条带口令的）。落库侧清洗要先按 `stripRuntimeError()` 分流再写回，且要**可重复执行**（跑两次结果一致）。

### 4.4 边界

- **不**把 `lastError` 变成结构化对象（`{kind, code}`）：那要同时改 SSR 渲染、前端 `paint()` 与历史库格式，超出「字段收敛」的范围；渲染成人话字符串已满足「不出网 + 可排障」。日后若要按类别筛选/统计，另开一票。
- 本节只保证**出口**不泄漏原文；**入口**（`redirect`、scheme 白名单、凭证类 URL 根本不该进清单）属「探测请求约束」票。**两票共用一个洞**：入口收敛 + 出口脱敏，两边都要做。

---

## 5. 投影写在哪

**结论：抽成 `toPublicSummary()`，放独立模块 `src/public-summary.ts`；`server.ts` 只调用它。**

| 方案 | 判断 |
| --- | --- |
| 写在 `server.ts` 路由里 | 否决。`buildSummary()` 已经把内部结构拼好了，路由里再做投影等于把「内部形状」和「公开形状」写在同一处，改内部结构时很容易忘掉投影那一半 |
| `src/public-summary.ts` + `toPublicSummary()` | **选它**。投影是纯函数（`StatusSummary` → `PublicSummary`），**可以不过 HTTP 直接断言**；也让「公开契约」在代码里有一个唯一、可检索的落点 |

配套：导出 `PublicSummary` 类型，给投影函数**显式标注返回类型**。这样**新增内部字段不会静默出网**——只有改这个文件才可能改变公开契约，review 时一眼可见。

`buildSummary()` 保持原样继续给**服务端渲染**用（页面本来就要渲染 URL、`lastCheckedAt`、`upStreakMs`），只有 `GET /api/status` 走投影。

**这就是「鉴权」与「字段收敛」的边界**：

- **页面（`/status`、`/`）** 渲染 URL 是**可以**的，因为闸门落地后整站要登录——靠**鉴权**保护。
- **`/api/status`** 不再回 URL——靠**契约收敛**保护。
- 两件事**互不替代**：只做收敛，页面照样匿名泄漏；只做鉴权，API 一旦被已登录账号（或未来加角色后）拿到就还是全量内部细节。**本票只做收敛这一半**，鉴权那一半是已关闭的「给整个站点加登录闸门」票的产出。

---

## 6. 验收：可被 e2e 断言的字段清单

### 6.1 清单（这就是票要的那份）

```jsonc
{
  "targets": [{
    "id": "…", "name": "…", "group": "…|null",
    "lastStatus": "up|degraded|down|null",
    "uptime": 0.0, "avgLatencyMs": 0, "p95LatencyMs": 0, "lastError": "…|null",
    "timeline": [{ "at": 0, "status": "…", "latencyMs": 0 }],
    "latency":  [{ "at": 0, "avgLatencyMs": 0 }]
  }],
  "overview":  [{ "at": 0, "up": 0, "total": 0 }],
  "incidents": [{ "targetId": "…", "at": 0, "status": "…", "statusCode": 0, "latencyMs": 0, "error": "…" }],
  "generatedAt": 0, "windowLabel": "…", "probeIntervalSeconds": 0
}
```

**禁止出现的键**（回归用，实测断言过）：`url`、`expectStatus`、`enabled`、`samples`、`upCount`、`lastCheckedAt`、`upStreakMs`，以及 `targets[].` 下的 `target`/`stats`/`targetId` 这三个旧层级/重复字段。

### 6.2 断言怎么写（三条，各有分工）

1. **形状断言**：对 `toPublicSummary()` 的返回值断言**有且仅有**上述键（`Object.keys(...).sort()` 全等）。纯函数，**不需要登录、不需要 HTTP**。
2. **「不出网」断言**：**对整个响应体做子串搜索**，断言不含 `target.url` 的字面量、不含主机名、不含凭证串。
   **为什么用子串搜索而不是逐字段检查**：逐字段只能证明「我想到的字段」不漏，子串搜索能抓住我没想到的字段——**§1 那条 `incidents[].error` 旁路正是这样抓出来的**。
3. **排障不回归断言**：断言 `lastError` 里仍能看到 `超时（>1500ms）`（超时值）与`状态码`（状态码不符）——防的是 §4.2 那种「收敛收敛把信息收没了」的回归。**这条必须写**，因为它正是本票第一版草案的翻车点。

### 6.3 ⚠ 顺序陷阱（实现前必读）

现状：`scripts/e2e-check.mjs:83-101` 逐个断言 `/`、`/posts`、`/about`、`/status`、`/api/status` 匿名返回 **200**，且**整个脚本没有登录步骤**；随后还断言 `api.targets[0].target.id`、`byId.ok.stats.lastStatus`、`byId.ok.timeline`、`byId.ok.latency`、`api.overview`。

于是有两件事会同时把 e2e 打红，**且与本票的投影改动无关的那件不要在本票里顺手改**：

1. **闸门落地**会让那五条匿名 200 全红。这**不是本票**造成的，修它（加登录辅助 + 未登录断言 + 保留 `/healthz` 匿名 200 护栏）是闸门落地与「验收补强」票的整块工作。
2. **本票的扁平化**会让 `api.targets[0].target.id`（→ `api.targets[0].id`）、`byId.ok.stats.lastStatus`（→ `byId.ok.lastStatus`）这类断言失效——**无论闸门是否落地都已经不对**，必须一并改。
3. **`stats.samples` 被删**会让 e2e 的 `waitForSamples()`（它拿 `samples` 当「探够了几轮」的信号）失效 → 改用 `targets[0].timeline.length` 或 `lastCheckedAt` 的替代口径（`timeline` 点数是「窗口内有几轮」的等价值）。

**决定：本票的断言按扁平化后的形状写，并显式标注「本票断言依赖闸门」。** 不顺手重写整套 e2e 的登录流程。

---

## 7. 实现落点

| 文件 | 改动 |
| --- | --- |
| `src/public-summary.ts`（新） | `toPublicSummary(summary: StatusSummary): PublicSummary` + `PublicSummary` 类型。**公开契约的唯一落点** |
| `src/probe.ts` | 删 `?? e.message` 兜底（§4.3 命门）；加 `classifyRuntimeError(code)` 类别映射；超时/状态码两处自有文案原样保留 |
| `src/store.ts` | 存量脏数据清洗：按分流规则重写历史 `error` 列（可重复执行，§4.3）。`getStats`/`getTimeline`/`getLatencyRaw` 的**行为不变**——裁字段由 `public-summary.ts` 负责，不在这层裁 |
| `src/server.ts` | `GET /api/status` 改为 `reply.send(toPublicSummary(buildSummary()))` |
| `src/views.ts` | URL 渲染**不动**（页面靠鉴权保护，§5） |
| `scripts/e2e-check.mjs` | 按 §6.2 加三条断言；修 §6.3 第 2、3 条被改形的既有断言 |
| `docs/adr/0003-*.md` | 本票锁定「公开契约 ≠ 内部结构」这条边界，属架构决定（与 map Notes 里「本次新锁定的时点，结束后应补 ADR」一致） |

---

## 8. 边界

- 本票**只定公开契约与错误脱敏**，不实现鉴权。页面上 URL 的可见性由**闸门 + 登录**决定（§5）。
- **不**改 session/cookie（属「会话维持」票）。
- **不**让曲线在浏览器里重绘（属「曲线实时重绘」票）；本票只保证**曲线数据留在 API 里、形状稳定、有上限**。
- **不**改探测目标的配置形态（把 `url` 从配置里去掉是另一回事，且会丢历史）。
- 探测的 `redirect` / scheme 白名单 / 凭证类 URL 入口拦截属「探测请求约束」票（§4.4）。
- 本票**不改** `lastError` 的数据类型（仍是字符串，§4.4）。
