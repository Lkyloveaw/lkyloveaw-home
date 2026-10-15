# 实现批次怎么切：分票清单与边界

本文件是「实现批次怎么切」这张票的产出。
回答一个问题：**Destination 要的写码工作，切成哪几张票、边界在哪、谁先谁后。**

票：<https://github.com/Lkyloveaw/personal-wiki/issues/12>

> ⚠ **本票是 planning 票。** 它只切票，不写实现代码。切完这张票，本 map 上**不再有任何未定的决定**。

---

## 0. 结论一句话

**切 5 张实现票 + 1 张收尾票（#9），按「可独立验收的垂直切片」切。**
每张票合入后**站点必须仍然可用**，只是缺陷少修了几个。

| # | 票 | 覆盖 | 依赖 |
| --- | --- | --- | --- |
| ① | 凭据与会话库 | #2 + #4（纯函数层） | 无（起点） |
| ② | 闸门与登录页 | #3 + #4（接入 HTTP） | ① |
| ③ | 公开契约与错误脱敏 | #5 | 无（可与①并行） |
| ④ | 探测入口约束与备份 | #7 + #6 | ③ |
| ⑤ | 面板：字段、失败态与重绘 | #5（连带）+ #8 + #10 + #11 | ③ |
| ⑥ | 验收补强 | #9 | ②③④⑤ |

---

## 1. 为什么**不**按文件切（数据否决）

实测统计 7 份判定表各自要求改哪些文件，得到碰撞面：

| 文件 | 被几份文档要求改 | 哪几份 |
| --- | --- | --- |
| `scripts/e2e-check.mjs` | **7 / 7（全部）** | #2 #3 #4 #5 #6 #7 #8 |
| `src/server.ts` | 5 | #2 #3 #4 #5 #8 |
| `README.md` | 5 | #2 #3 #4 #6 #7 |
| `src/config.ts` | 4 | #2 #4 #6 #7 |
| `.env.example` | 4 | #2 #3 #4 #6 |
| `src/probe.ts` | 3 | #5 #6 #7 |
| `public/status.js` | 3 | #3 #5（文档漏登记，见 §3）+ #8 |

**按文件切会得到 7 张都改同一个 `e2e-check.mjs` 的票**，合并顺序立刻变成全图瓶颈，且每张票都无法单独验收（改完 e2e 但其他票没做，断言必然红）。

**按「一份判定表一票」切（细切）同样被否**：7 张票全部触碰 `e2e-check.mjs` 与 `server.ts`，同一段代码被七个分支反复改，rebase 冲突的成本超过票变小带来的收益。

→ 故选**垂直切片**：切片的边界刻意避开碰撞点，让每张票只碰自己那段。

---

## 2. 五张票的详细边界

### 票① 凭据与会话库（#2 + #4 的纯函数层）

**为什么 #2 与 #4 合成一票**：`session-decision.md` §11 明确要往 `src/users.ts` 与 `src/cli/passwd.ts` **追加** `getAuthState()` / `bumpTokenVersion()` / `token_version` 列 / `--revoke-sessions`。这两份文档争的是同一批新文件——分开做会让第二张票在同一个文件上重做一遍建表与迁移。

| 项 | 内容 |
| --- | --- |
| 新建 | `src/users.ts`（含 `token_version` 列）、`src/session.ts`、`src/cli/passwd.ts`（含 `--revoke-sessions`） |
| 修改 | `src/config.ts`（`adminUsername`/`adminPassword`/`sessionSecret`/`sessionCookieSecure`/`sessionTtlMs`）、`package.json`（`bcryptjs` + `passwd` script）、`.env.example` |
| **不碰** | **`src/server.ts`（一行不改）**、`scripts/e2e-check.mjs` |
| 验收 | `npm run typecheck` + **纯函数断言**：口令校验正/反、`COLLATE NOCASE` 不能共存、`token_version` 补列幂等且既有账号落 1、`verifySession` 判定表 **14 用例**、`SESSION_SECRET` 为空时退出、CLI 在 `dist/` 下可执行 |
| 依赖 | 无 |

**关键：本票不接 HTTP。** 判据是 `session-decision.md` 把 `verifySession()` 定义成**纯函数**（不依赖 Fastify），所以它可以在没有闸门的情况下被完整断言。这让①成为整批工作的**起点**，且不制造任何"半坏的中间态"——站点行为完全不变。

⚠ **`scripts/` 不进镜像**（`Dockerfile:27` 只 `COPY dist`）：CLI 必须在 `src/cli/` 下，本票的验收要断言 `dist/cli/passwd.js` 存在。

### 票② 闸门与登录页（#3 + #4 接入 HTTP）

| 项 | 内容 |
| --- | --- |
| 新建 | 无 |
| 修改 | `src/server.ts`（全局 `onRequest` 钩子 + 精确白名单 + `/login` GET/POST + 登出 + 改密路由）、`src/views.ts`（`loginPage()`）、`scripts/e2e-check.mjs`（**登录辅助 + 未登录断言**）、`.env.example`、`README.md` |
| 验收 | 未登录：页面 302→`/login?next=…`、API 401；已登录：全站 200；`next` 逃逸面全拒；`/healthz` 保持匿名 200；**改密后当前浏览器不掉线、其他设备掉线** |
| 依赖 | ① |

**本票是唯一大规模改 e2e 的票**（登录流程是全局性的，只能在这里一次做完）。

⚠ **白名单必须含 `/chart-path.js`**——否则⑤合入后未登录时拿不到它。⑤交付该文件，**白名单条目由⑤追加、由②建立**。落地⑤时若白名单已存在，记得追加（`chart-redraw-decision.md` §6 点名的"容易漏的联动点"）。

⚠ **连带改动**：`public/status.js` 的静默 `.catch()` 改显眼失败（`login-gate-decision-table.md` §3 定它是"落地时的连带改动，不是新票"）。但该文件同时被⑤重写——**避免两票争同一段**：②只做**最小改动**（让 catch 不再静默），⑤在此基础上重写 `paint()`。若②先合、⑤后合，⑤覆盖②的改动是预期行为。

### 票③ 公开契约与错误脱敏（#5）

| 项 | 内容 |
| --- | --- |
| 新建 | `src/public-summary.ts`、`docs/adr/0003-*.md` |
| 修改 | `src/server.ts`（`/api/status` → `toPublicSummary(buildSummary())`）、`src/probe.ts`（**删 `?? e.message`** + `classifyRuntimeError(code)`）、`src/store.ts`（存量脏数据清洗）、`scripts/e2e-check.mjs`（**扁平化后的形状断言**） |
| **不改** | `src/views.ts`（URL 渲染不动）、`public/status.js`（归⑤，见 §3） |
| 验收 | 响应体**子串搜索**断言 `url`/`expectStatus`/口令**不出现**；`lastError` 脱敏按"谁生成"分流（自有文案原样、异常走类别码白名单）；存量脏数据清洗可重复执行 |
| 依赖 | 无（可与①并行） |

⚠ `probe.ts` 的 `?? e.message` 删除是**安全命门**（`api-status-fields-decision.md` §4.3）：不删则脱敏洞重新打开。**票④的 `redirect` 改动依赖本票先合**。

### 票④ 探测入口约束与备份（#7 + #6）

**为什么合成一票**：两者都改 `src/probe.ts` 的探测轮次（④加校验入口、⑥加 checkpoint 调用），且都不碰 HTTP 层。分开做会让第二张在同一个 tick 函数上重做。

| 项 | 内容 |
| --- | --- |
| 新建 | `src/backup.ts`、`src/cli/backup.ts` |
| 修改 | `src/probe.ts`（`redirect:'manual'` + **轮次降频调 checkpoint/backup**）、`src/config.ts`（`normalizeTargets` 三条校验 + `backupDir`/`backupKeep`）、`src/store.ts`（`checkpoint(mode)` 暴露 `busy`、`backupTo(file)`）、`README.md`、`.env.example`、`targets.json`、`docker-compose.yml`（条件性）、`scripts/e2e-check.mjs` |
| 验收 | 校验器 18 用例；**`busy !== 0` 必须记日志不许当成功**；空库陷阱回归（只拷 `.sqlite` 打不开）；恢复流程可执行；滚动保留 7 份 |
| 依赖 | ③（**先合脱敏再改 `redirect`**） |

⚠ **顺序硬约束**：`redirect` 与 `?? e.message` 在 `probe.ts` 同一个 catch/try 区域。`probe-request-constraints-decision.md` §3 要求**先合脱敏**。本票依赖③正是此意；落地时两件事**分成两个 hunk**，避免一个 revert 带走另一个。

⚠ **先 checkpoint 再备份**（`backup-checkpoint-decision.md` §5，运行时顺序）。Docker 属主一节**无 docker 不可验证**，必须标"未验证"。

### 票⑤ 面板：字段、失败态与重绘（#5 连带 + #8 + #10 + #11）

**为什么四件事合成一票**：它们全部改 `public/status.js` 的 `paint()`。实测 `status.js` 只有 73 行，`paint()` 是唯一入口——分开做等于让四张票在同一段代码上叠罗汉。

| 项 | 内容 |
| --- | --- |
| 新建 | `public/chart-path.js` |
| 修改 | `public/status.js`（**重写 `paint()`**）、`src/charts.ts`（`data-chart` + `data-y-min/max`）、`src/views.ts`（引入 `chart-path.js`、给 `.tl` 加 `data-timeline`）、`src/server.ts`（**白名单追加 `/chart-path.js`**）、`scripts/e2e-check.mjs` |
| 验收 | ①**交叉断言**：服务端 SSR 的 `d` == `node:vm` 里 `chart-path.js` 算的 `d`（7 组）；②值域不抖动（老点位移恒 0）；③断开不被连上；④空态双向可切；⑤`.tl-cell` 跟着刷新；⑥**401 时显眼失败**（区分"要重新登录"与"网络抖动"，恢复后提示自动消失）；⑦`.js-generated` 显示真实时间戳 |
| 依赖 | ③（需先知道扁平后的字段名） |

⚠ **本票负责修一处已核实的文档缺陷**（见 §3）：`public/status.js:16,23` 读 `item.target.id` / `item.stats`，而③把它们压平了。**③合入到⑤合入之间，面板的自动刷新是坏的**——这是实现顺序的必然代价，且**不违反 §4 的"每票合入即可用"**：因为③与⑤必须**紧接着**落地（见 §5）。

### 票⑥ 验收补强（#9）

| 项 | 内容 |
| --- | --- |
| 修改 | `scripts/e2e-check.mjs`（最终形态）、`README.md`（修 `draft` 语义矛盾）、`.env.example` |
| 验收 | 安全断言**必须先用真实载荷证明前提成立**；补未覆盖场景（无目标清单、跨天、重启恢复、并发）；README 与实现一致 |
| 依赖 | ②③④⑤ |

**为何独立且放最后**：它是"e2e 要真的在测 + 文档不撒谎"的票。各实现票自带**本地、不冲突**的断言；⑥在全部落地后**统一收口**，避免每张票各写一套断言再互相覆盖。

⚠ `README.md` 写「`draft: true` 可以直链访问」，实测是 **404**——**实现比文档严格**，是文档在撒谎。⑥要定 `draft` 语义（改文档还是改实现），**这是产品决定**。

---

## 3. 本票新发现的缺陷（charting 时没看到）

### 3.1 `api-status-fields-decision.md` 漏登记 `public/status.js`

**已读码核实**（不是推断）：

| `public/status.js` | 读的字段 | #5 决定 |
| --- | --- | --- |
| `:16` | `item.target.id` | 压平为 `item.id` |
| `:23` | `item.stats` | 压平为 `item` 自身 |
| `:27,41` | `s.lastStatus` | `item.lastStatus` |
| `:32` | `s.uptime` | `item.uptime` |
| `:36,37` | `s.avgLatencyMs` / `s.p95LatencyMs` | 同名，上一层 |

#5 的落点表里**没有 `public/status.js`**，但它决定的压平**恰好拆掉了这个文件读取的两层**。照文档落地，面板的 30 秒刷新会**静默失效**（`byId[id]` 永远找不到卡片 → `return` 早退）。

→ **处置**：归⑤（面板票），作为"压平后的连带修改"。理由：⑤本来就要重写 `paint()`；让③去改前端字段路径会制造③⑤对同一文件的双改。

### 3.2 `chart-redraw-decision.md` §7 的交叠说法与 #5 落点表不符

该文档 §7 称自己与字段收敛票"在 `src/charts.ts` 上有交叠"，但 #5 的落点表（§7）**不含 `src/charts.ts`**，且 #5 明确写 `src/views.ts` 的 URL 渲染"不动"。

→ **处置**：以**落点表**为准（`charts.ts` 只归⑤）。这不是需要决策的问题，是记录一处文档不一致，落地时按落点表执行。

---

## 4. 全局约束（每张票都适用）

1. **每张票合入后站点必须可用**（用户选定）。只是缺陷少修了几个，不允许出现"登不进/面板全坏"的中间态。
2. **一票一次会话做完**（用户选定）。若发现超出一票的尺寸，**当场再拆一票**，不在票内拖。
3. **断言质量**：安全断言必须**先证明前提成立**，否则就是恒真断言（`e2e-check.mjs` 原来那两条 `!/<script>alert/` 就是反例）。
4. **不引新依赖**（`bcryptjs` 是唯一例外，已由 #2 定）。
5. **`scripts/` 不进镜像**：任何运维 CLI 必须放 `src/`。
6. **失败要显眼不要静默降级**（本仓库既有取舍）。

---

## 5. 顺序与"每票可用"的关系

用户要求每票合入即可用，但③（压平字段）与⑤（改前端路径）之间存在**真实的技术依赖**。处置：

```
① ──→ ② ──┐
            ├──→ ⑥（验收收口）
③ ──┬──→ ④ ─┘
     └──→ ⑤
```

**③ 与 ⑤ 必须相邻落地**：③ 改服务端形状，⑤ 立刻跟上改前端路径。两者之间不插入其他票的合并。这不违反"每票可用"——违反的是"每票可**长期**停留在中间态"，而本约束只要求**不存在被发布出去的坏状态**。

**并行性**：① 与 ③ 互不依赖，可并行；② 依赖 ①；④ 与 ⑤ 都依赖 ③，可并行。

---

## 6. 验收面归属

| 验收面 | 归属 |
| --- | --- |
| 单元/纯函数断言（`verifySession`、口令校验、投影、校验器、值域策略） | **各自的实现票**，不过 HTTP |
| e2e 登录流程改造 | **②**（唯一大改 e2e 的票） |
| e2e 扁平化字段断言 | **③**（形状变了，③负责断言新形状） |
| e2e 其余实现票的本地断言 | **各自**，不冲突 |
| e2e 最终形态 + README 一致性 + 断言质量原则 | **⑥（#9）** 收口 |

**判据**：一张实现票自带的断言，**不能依赖另一张实现票的产出**。若依赖，则该断言归后落地的那张票。

---

## 7. `## 进度` 登记

本票切定后，map 上**不再有任何未定的决定**——剩下的全是执行。实现票按 §2 逐张创建并挂到 map 1，阻塞边按 §5 的箭头连。

⚠ **本票关闭 ≠ 站点安全了。** 代码仍然一行没落地。真正的状态变化发生在①②③④⑤⑥全部合入之后。
