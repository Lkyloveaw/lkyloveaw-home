# 实现批次怎么切：分票清单与边界（个人站自管化）

本文件是「实现批次怎么切」这张票的产出（map：[个人站自管化](https://github.com/Lkyloveaw/lkyloveaw-home/issues/20)）。

票：<https://github.com/Lkyloveaw/lkyloveaw-home/issues/27>

它回答一个问题：**map 目的地要的写码工作，切成哪几张票、边界在哪、谁先谁后。**

> ⚠ **本票是 planning 票**：它只切票，不写实现代码。切完这张票，本图上**不再有任何未定的决定**，剩下的全是执行。

方法原样沿用 map #1 的 [实现批次怎么切](https://github.com/Lkyloveaw/lkyloveaw-home/issues/12)（产物 `docs/implementation-split-decision.md`）：
按**可独立验收的垂直切片**切、**一票一次会话**、**每票合入后站点仍可用**、**不按文件切**。

---

## 0. 结论一句话

**切 8 张实现票 + 1 张收口票 + 1 张真机验收票。**

| # | 票 | 覆盖哪些已关的决定 | 依赖 |
| --- | --- | --- | --- |
| ① | 会话记录与角色基座 | [#29](https://github.com/Lkyloveaw/lkyloveaw-home/issues/29) + [#24](https://github.com/Lkyloveaw/lkyloveaw-home/issues/24) | 无（起点） |
| ② | 写路径鉴权与 CSRF | [#25](https://github.com/Lkyloveaw/lkyloveaw-home/issues/25) | ① |
| ③ | 管理台外壳与只读页面 | [#23](https://github.com/Lkyloveaw/lkyloveaw-home/issues/23) 的 GET 侧 | ① ② |
| ④ | 目标网页化 | [#26](https://github.com/Lkyloveaw/lkyloveaw-home/issues/26) | ③ |
| ⑤ | 站点设置进库 | [#22](https://github.com/Lkyloveaw/lkyloveaw-home/issues/22) 的设置半 | ③ |
| ⑥ | 备份页与手动备份一次 | [#22](https://github.com/Lkyloveaw/lkyloveaw-home/issues/22) 的备份半 | ③ |
| ⑦ | 账号管理页 | [#24](https://github.com/Lkyloveaw/lkyloveaw-home/issues/24) 的写入口 + [#23](https://github.com/Lkyloveaw/lkyloveaw-home/issues/23) §5 | ③ |
| ⑧ | 整站视觉：正文面纸感化 | [#21](https://github.com/Lkyloveaw/lkyloveaw-home/issues/21) 剩下的那一半 | 无（可与 ①② 并行） |
| ⑨ | 验收收口 | —（#12 的票⑥ 同位票） | ①–⑧ |
| ⑩ | 真机验收与上线切换 | —（map #1 的 [#19](https://github.com/Lkyloveaw/lkyloveaw-home/issues/19) 同位票） | ⑨ |

```
① ──→ ② ──→ ③ ──┬──→ ④ ──┐
                 ├──→ ⑤ ──┤
                 ├──→ ⑥ ──┼──→ ⑨ ──→ ⑩
                 └──→ ⑦ ──┘
⑧（独立；**建议早于 ③ 合入**，见 §5）
```

**为什么有 ⑩**（本票新发现的一处覆盖缺口）：map 目的地第 ③ 条是"整站视觉**定稿并落地**"，而 `docs/visual-prototype-decision.md` §6 自己登记了"**没有真机浏览器 PoC**：没有目视过渲染结果，也没测过窄屏断点与打印样式"；本批其余票的验收全部是**命令行与 HTTP 层**的。没有 ⑩，这批票做完了也只能说"断言是绿的"，说不出"人看着是对的"。map #1 在同类情形下开的就是 #19，本票沿用同一形状。

---

## 1. 为什么**不**按文件切（实测数据）

实测统计 7 份已关决定文档各自要求改哪些文件，得到碰撞面：

| 文件 | 被几份文档要求改 | 哪几份 |
| --- | --- | --- |
| `src/server.ts` | **5** | #29 #23 #25 #26 #22 |
| `src/views.ts` | **5** | #23 #25 #26 #22 #21 |
| `scripts/e2e-check.mjs` | **5** | #29 #23 #25 #26 #22 |
| `scripts/unit-check.mjs` | **4** | #29 #25 #26 #22 |
| `src/auth.ts` | 3（含 #24 只写在叙述里的那条则 **4**） | #29 #23 #25 #24 |
| `src/config.ts` | 3 | #25 #26 #22 |
| `src/probe.ts` | 3 | #29 #26 #22 |
| `CONTEXT.md` / `.env.example` | 3 | #29 #24 #23 / #25 #26 #22 |
| `src/users.ts` · `src/cli/passwd.ts` | 2 | #29 #24 |
| `public/style.css` | 2 | #23 #21 |
| `README.md` · `docs/session-decision.md` | 2 | #25 #22 / #29 #24 |

**按文件切会得到 7 张都改同一个 `e2e-check.mjs`、5 张都改同一个 `server.ts` 的票**，合并顺序立刻变成全图瓶颈，且每张票都无法单独验收（断言写进同一份文件，别的票没做就必然红）。

**按「一份决定文档一票」（细切）同样被否**：`#29` 与 `#24` 争的是同一次闸门查询与同一个 `initUsers()` 迁移入口；`#23` 与 `#25` 争的是同一批 `views.ts` 表单片段与同一个判定顺序；`#22` 的两半虽可分，但它们的页面骨架都由 `#23` 产生。

→ 故选**垂直切片**。注意本批的切片边界**不是文件**，而是**函数与页面**：

- `src/views.ts` 会被 **7 张票**碰到（②③④⑤⑥⑦⑧），但每张票碰的是**不同的渲染函数或表单片段**（② 只加 `csrfField()` 与 403 页；③ 只加 5 个 admin 页与 `nav()` 的第 5 项；④⑤⑥⑦ 各改自己那一页；⑧ 重写正文面页面与呈现）。**文件是共享的，函数不是。**
- `src/server.ts` 同理：每张票加的是**自己的路由与自己的那段 handler**；被人人共享的只有顶部那 20 行（`const site` / `buildSummary`），两条 ⚠ 写在 §5。

---

## 2. 十张票的详细边界

票面一律包含：**新建 / 修改 / 明确不做 / 必须遵守的既定决定（照抄判定表）/ 验收 / 关系**。本节是那些票面的来源。

### 票① 会话记录与角色基座（#29 + #24）

**为什么 #29 与 #24 合成一票**：两份决定争的是**同一批代码**——

| 争的东西 | #29 要做的 | #24 要做的 |
| --- | --- | --- |
| `users.ts` 的 `initUsers()` | 建 `sessions` 表 | 补 `role` 列（PRAGMA + ALTER + 无条件一次性 `UPDATE … = 'admin'`） |
| `auth.ts` 的 `decideRequest` | 改成 `decodePayload → sid → findSessionState → decideSession` | 要求 `role` **并进同一次查询**、不新增查询次数 |
| `cli/passwd.ts` | `--revoke-sessions` 追加 `revokeUserSessions` 并打印行数 | 新增 `--role`、`--list` 印角色 |
| `server.ts` | 登录先 `createSession` 再签发、`/logout` 真吊销、改密重签新 `sid` | 启动检出零管理员 → `console.warn` |

分开做，第二张票要在同一个 `initUsers()` 与同一条 JOIN 上重做一遍迁移与查询——与 #12 把 #2+#4 合成票①是同一条理由。

| 项 | 内容 |
| --- | --- |
| 新建 | `src/sessions-store.ts`（`createSession` / `findSessionState` / `revokeSession` / `revokeUserSessions` / `sweepSessions`，纯 SQLite 不碰 HTTP） |
| 修改 | `src/session.ts`（载荷加 `sid`、`issueSession` 收 `sid`、新增纯函数 `decideSession()`）、`src/users.ts`（建 `sessions` 表 + `role` 列迁移 + `getAuthState` 交出角色 + 最后管理员/不改自己守卫 + `setPassword` 与 `revokeUserSessions` 同事务）、`src/auth.ts`（闸门走新判定、`RequestDecision` 带 `role`）、`src/server.ts`（登录/登出/改密 + 零管理员告警）、`src/probe.ts`（每 `checkpointEveryRounds` 轮 `sweepSessions()`）、`src/cli/passwd.ts`、`CONTEXT.md`（吊销/登出/会话记录/角色/管理员/只读 词条）、`docs/session-decision.md` 与 `docs/accounts-decision.md` 就地留修订指针 |
| **不碰** | 管理台页面（归 ③）、CSRF 与 `requireAdmin` 的判定形态（归 ②）、会话管理 UI（map 迷雾） |
| 验收 | `unit-check` 判定表 **24 行**（`docs/session-revoke-decision.md` §5）+ `sweepSessions` 删除行数；schema 断言（**旧库无 `sessions` 表 / 空库**两种情形建表幂等、JOIN 返回形状、重复吊销 `changes = 0`）；`role` 迁移幂等且**既有账号一次性升 admin**；e2e：登录 200 → 登出后同一 cookie 失效 → **同账号第二台设备的 cookie 仍 200**（第 24 行，本票的核心理由）→ 改密后旧 cookie 失效且当前浏览器不掉线 → 停用后旧 cookie 失效 → **旧格式 cookie（无 `sid`）→ 302 而非 500** |
| 依赖 | 无（本批起点；站点在合入前行为完全不变） |

⚠ **两个写得出来的后果**：①**上线那一刻全部既有 cookie 失效**（用户重登一次）——这是 `sid` 迁移不可绕过的代价；②停用中的既有账号也会被一次性升成 admin（#24 已登记，接受）。

### 票② 写路径鉴权与 CSRF（#25）

| 项 | 内容 |
| --- | --- |
| 新建 | `src/csrf.ts`（`csrfToken()` / `verifyCsrf()` / `checkOrigin()`，**全是纯函数**） |
| 修改 | `src/auth.ts`（`requireAdmin(decision)`：只读 → 403）、`src/config.ts`（`siteOrigins: Set<string>` + 缺失即拒绝启动、`trustProxy` 默认 `false`）、`src/server.ts`（`onRequest` 接 L2、写路由自己的 `preValidation` 接 L3、`als.run()` 注入 token、`Cache-Control: no-store`）、`src/views.ts`（`csrfField()` 读 ALS + L2/L3 的 403 页 + 既有表单插入 token）、`.env.example` 与 `README.md`（`SITE_ORIGIN` / `TRUST_PROXY` 两行） |
| **不碰** | `src/users.ts`（#25 §8 明写「不动，本票只是调用方」） |
| 验收 | 判定顺序固定：L2 → 资格 → L3 → action → 字段 → 对象守卫（`docs/write-path-auth-decision.md` §5.3）；`unit-check` **16 条**（token 派生确定性/换会话即变、先比长度不抛、`Origin` 精确相等含端口、`null` 拒绝、`Referer` 回退、配置解析）；e2e **12 条**（同源 POST 正常、删掉来源头 → 403、`X-Forwarded-Host` 不影响判定、缺 `csrf` → 403、改密后旧页面 token → 403、`Cache-Control: no-store`、**全仓无 `req.hostname` / `req.protocol` 读取点**） |
| 依赖 | ①（`requireAdmin` 读 `decision.role`；L3 派生用会话 token，① 之后形态才定） |

⚠ **升级须知**：本票之后 `.env` 缺 `SITE_ORIGIN` **服务起不来**（配置错误，重启不自愈）。这一行必须同步进 `.env.example`、`README.md` 与真机升级步骤。
⚠ 本票**可独立验收**：用**既有**的 `/login`、`/logout`、`/password` 三条写路由就能把 L2 与 L3 全跑通，不需要管理台存在。

### 票③ 管理台外壳与只读页面（#23 的 GET 侧）

| 项 | 内容 |
| --- | --- |
| 新建 | 无（页面函数加在 `src/views.ts` 里） |
| 修改 | `src/views.ts`（`active` 加 `'admin'`、`nav()` 第 5 项**只对管理员渲染**、`adminOverviewPage()` + 四个子页、`forbiddenPage()`、`NOTICE_TEXT` 闭集与 `renderNotice(key, tone)`、确认框类名约定 `.confirm`、`aboutPage()` 的旧文案）、`src/server.ts`（5 条 GET 路由）、`src/auth.ts`（`KNOWN_PAGES` 追加 5 条）、`public/style.css`（`.notice-bad` `.notice-warn` `.confirm` `.form-row` `.form-actions` `.btn-danger`，复用既有 `.card` `.stat-strip` `.stat` `.empty` `.tag`）、`scripts/e2e-check.mjs` |
| **不碰** | **任何 POST 写动作**（④⑤⑥⑦ 各自加自己的）、正文页视觉（归 ⑧）、`status.js`（管理台不挂它） |
| 数据来源 | 本票**不新建表**：目标页读 `config.targets`（④ 换成库）、账号页读 `listUsers()`、备份页读备份目录（⑥ 换 `backup.ts`）、设置页读 `config`（⑤ 换成库）、概览页计数**一律现算不缓存** |
| 验收 | `docs/admin-console-ia-decision.md` §9 的 11 条里 GET 侧那一半：管理员顶栏含「管理」且 5 页 200 + `aria-current`；**只读不含入口**（先证同一响应里另外 4 项在）且 5 页 **403**（不是 404、不是 302）；未登录 302 → `/login?next=/admin` 且登录后回跳；`/admin` 概览的零管理员告警**每次渲染现算**；乱编的 `?notice=` key **不渲染** |
| 依赖 | ①（角色）、②（`requireAdmin` 与 403 形态） |

⚠ 本票交付的是**只读的管理台**：5 个页面都能看到真实数据，但**还没有任何写按钮生效**——这是刻意的切片边界，不是半成品（④⑤⑥⑦ 各自把自己那一页变成可写）。

### 票④ 目标网页化：targets 表、首次导入、探测热加载与增删改（#26）

| 项 | 内容 |
| --- | --- |
| 新建 | `src/targets-store.ts`（`initTargets` / `listEnabledTargets` / `listAllTargets` / `getTarget` / `createTarget` / `updateTarget` / `removeOrDisableTarget` / `setTargetEnabled`） |
| 修改 | `src/config.ts`（`validateTargetUrl()` / `normalizeTargets()` 改为导出、`loadTargets` 降级为首次导入来源）、`src/probe.ts`（一轮开头读一次库，不再读 `config.targets`）、`src/server.ts`（每请求读一次清单、**同一数组**喂 `buildSummary()` 与 `getUptimeRaw()`、`/healthz` 与启动日志改读库、`POST /admin/targets` 的 action 闭集）、`src/store.ts`（`getUptimeRaw()` 改收参、不再自读 targets）、`src/views.ts`（targets 页表单 + `aboutPage()` **与首页空态**的文案）、`.env.example`（`TARGETS_PATH` 注释改为「只用于首次导入」）、`CONTEXT.md` |
| **不碰** | `targets.json` 的内容与格式（只作导入来源，导入后完全忽略）、彻底删除含历史（out of scope）、探测引擎本身 |
| 验收 | `docs/targets-source-decision.md` §9：库与导入 **12 条**（首次导入一次、二次启动不重复导、库非空即忽略文件、带凭证 URL 与重复 id 被拦且**其余条目照常入库**、有历史删除 = 停用且 probes 行数不变、无历史允许物理删、改 id → 400、`getUptimeRaw` 口径回归、停用再启用后 `upStreakMs` 从重启用起算、双进程同启无重复）+ HTTP **6 条**（302 后写后读、**一个探测间隔后新目标真的被探到**（热加载）、重复 id → 400、只改 name 时 id 不变、停用后 `/status` 与 `/api/status` 都不含它、**全仓运行时无 `config.targets` 读取点**） |
| 依赖 | ③（页面骨架、notice 闭集、400 就地重渲染）、②（写路径） |

⚠ 本票是全批**改动面最大**的一张（新建一个 store + 换掉 5 处运行时读取点 + 一页表单），也是最该在会话中途回头看尺寸的一张。
⚠ **与票⑤ 在 `src/server.ts` 顶部同一段**（`const site` 37 行、`buildSummary` 40-57 行）——见 §5。

### 票⑤ 站点设置进库：标题 / 描述 / 探测间隔（#22 的设置半）

| 项 | 内容 |
| --- | --- |
| 新建 | `src/settings-store.ts`（`initSettings` / `getSetting` / `setSetting` / `listSettings`）+ `settings` 表（`key` PK / `value` / `updated_at`） |
| 修改 | `src/config.ts`（导出 `DEFAULT_SETTINGS`，三个 env 降级为首次值来源）、`src/probe.ts`（每轮重读间隔，**不打断正在等的那一轮**）、`src/server.ts`（`const site` 改**每请求** `siteOf()`、`buildSummary()` 的 `probeIntervalSeconds` 读库、`POST /admin/settings`）、`src/views.ts`（设置页表单 + 「每 N 秒探测」文案）、`.env.example`（三行**改注释不删行**）、`README.md`（设置在哪改） |
| **不碰** | `PROBE_RETENTION_DAYS` / `BACKUP_KEEP` / `SITE_ORIGIN` / `TRUST_PROXY` / 会话安全参数（**留 `.env`**，#22 §0.1 的边界）；不做「恢复默认值」按钮 |
| 验收 | `docs/settings-source-decision.md` §8.1 库 **7 条**（首启落 3 行取 env 值、二次启动幂等无二次日志、库值优先并对被忽略的 env 打警告、坏值回退默认 + `console.error`、未知键忽略不渲染）+ HTTP **5 条**（写后立即 GET 首页 title 是新值、空标题/超长/越界间隔 → 400 且库不变、合法间隔 → 302 且**下一轮**生效、只读 403） |
| 依赖 | ③ |

⚠ 与票④ 同段（见 §5）；`const site` 今天被 12 处共享（`server.ts:37`），改成每请求解析是本票最容易漏的地方。

### 票⑥ 备份页与「立即备份一次」（#22 的备份半）

| 项 | 内容 |
| --- | --- |
| 新建 | 无 |
| 修改 | `src/backup.ts`（**#22 落点表漏登记**：备份页要产物**大小**与时间，今天的 `listBackups()` 只返回文件名；另需区分「空目录」与「不可读」）、`src/server.ts`（`POST /admin/backups`：进程内布尔 `backupRunning` 防重入，第二次 → `?notice=backup-skipped`）、`src/views.ts`（备份页：列表按时间倒序 + 「立即备份一次」+ `BACKUP_DIR`/`BACKUP_KEEP` 两行只读参数 + 失败说明）、`CONTEXT.md` |
| **不碰** | 备份产物的**下载 / 恢复 / 单份删除**（#23 与 #22 都已判 out of scope）、`runBackup()` 的既有语义 |
| 验收 | 手动备份**真的产出文件**（写后读）→ 再点一次**不新增产物**（`?notice=backup-skipped`）；失败要**看 `runBackup()` 的 `ok`**，不能只看 `note` 有没有内容（**跳过在代码里是 `ok:true` + note**，靠 note 分型才能让这两条断言不互斥）；目录不可写 → 屏幕上看得见 |
| 依赖 | ③ |

⚠ 本票要**顺手还掉一笔债**：`docs/session-revoke-decision.md` §10.1-2 点出「**恢复一份旧备份会让当时的会话继续有效**」——这条的用户可见后果属于备份页的说明文字，写进页面，不要留在文档里（§3.5）。

### 票⑦ 账号管理页：新增 / 停用 / 重置口令 / 改角色（#24 的写入口 + #23 §5）

| 项 | 内容 |
| --- | --- |
| 新建 | 无 |
| 修改 | `src/views.ts`（账号页表单：列表 + 新增 + 角色 + 启停 + 重置口令；**口令字段永不回填**）、`src/server.ts`（`POST /admin/accounts` 的 action 闭集，接 ① 的守卫）、`scripts/e2e-check.mjs` |
| **不碰** | 守卫本身的实现（① 已交付，本票只是调用方——**不许在路由里抄一份**，否则 CLI 就成了绕过守卫的后门） |
| 验收 | #23 §9 里 POST 侧那几条：**最后管理员降级 → 400 且仍是 admin**；**停用自己 → 400 且仍启用**；三类动作（重置口令 · 停用账号 · 降级角色）**未勾确认框 → 400 且未写**；正常 POST → 302 后**写后读**见新状态 + notice；非法输入 → 400 就地重渲染且**保留其他字段** |
| 依赖 | ③（+ ① 的守卫） |

### 票⑧ 整站视觉：正文面纸感化与全站推广（#21 剩下的那一半）

**#21 交付了什么、还欠什么**：面板那一半**已进产品代码**（`views.ts` 的 `cellStrip()` / `CELL_STRIP_LEN` / `STATUS_CLASS`、`style.css` 的 `.badge` / `.cell-strip`、`status.js` 的重建与 `panel-check.mjs` 的 47 项，定稿文档 §6 记录当时 `npm run verify` 282 项全过）。**欠的是**：面板那套排版语言只落在面板那一段；`style.css` 里正文面（首页 / 分享 / 文章 / 关于 / 登录）仍是原主题的排版规则（#21 §6 末段与 §8 自己登记的边界）。⚠ #21 §8 说的「两套东西暂时并存」指**面板的新样式与原主题的正文面排版规则**并存，**不是两份变量表**——实测 `style.css` 只有一套 token（`:root` 暗色 16 个 + `prefers-color-scheme: light` 覆盖 12 个 = 28 处定义，`:root` 只出现在第 3、25 行）。

| 项 | 内容 |
| --- | --- |
| 新建 | 无 |
| 修改 | `public/style.css`（**复用同一份 token，别去找第二个 `:root`**；数据面终端化 / 正文面纸感化的两套排版规则；窄屏断点；打印样式）、`src/views.ts`（首页 / 分享 / 文章 / 关于 / 登录的呈现与 `layout()` 的站内框架；`nav()` 重写为最终呈现）、`scripts/panel-check.mjs` 或新增样式断言脚本（**对比度实测**：把用到的前景/背景对逐对算比值，不再"估"） |
| **不碰** | 面板的既有跨文件契约（`#status-root` / `data-target` / `data-timeline` / `data-cells` / `.js-cells`；`panel-check` 的 47 项**不许退**）、管理台页面的结构（③④⑤⑥⑦ 的产出，本票只把它们纳入 token 覆盖）、配色 token 的"全局推行方式"这个**决定**（已在 #21 判过，本票只执行） |
| 验收 | `npm run check:all` 不退（现有 282 项 + 面板 47 项）；登录页与正文页在**深/浅两套**下都有断言覆盖；窄屏断点与打印样式有断言或显式登记为未验证；**对比度**每一对都给得出比值（#21 §6 登记的那条"估的"作废） |
| 依赖 | 无。#21 的面板定稿**已合入**，本票是它的第二半 |

⚠ **建议早于 ③ 合入**（理由见 §5）：管理台是数据面，页面直接建在统一后的 token 上，省掉一次"全站扫一遍"。

### 票⑨ 验收收口：e2e 最终形态、README 与实现一致、断言质量

| 项 | 内容 |
| --- | --- |
| 新建 | 无 |
| 修改 | `scripts/e2e-check.mjs`（最终形态：去重、跨票断言统一、把各票"本地断言"收成一套）、`README.md`、`.env.example`、`CONTEXT.md`、`docs/` 与实现不一致处 |
| 验收 | `npm run check:all` 全绿；**安全断言必须先用真实载荷证明前提成立**（#12 §4 第 3 条，`e2e-check.mjs` 原来那两条恒真断言是反例）；README / `.env.example` / `CONTEXT.md` 与实现**逐条对得上**；batch 期间所有"未实测"登记逐条清账或如实留档；真机项（浏览器目视、窄屏/打印观感、部署机 `SITE_ORIGIN`）**登记为未验证**而不是默认通过 |
| 依赖 | ①–⑧ 全部关闭 |

**为何独立且放最后**：各实现票自带**本地、不冲突**的断言；⑨ 在全部落地后统一收口，避免每张票各写一套再互相覆盖（判据与 #12 §6 相同：**一张实现票自带的断言，不能依赖另一张实现票的产出**；若依赖，归后落地的那张票）。

### 票⑩ 真机验收与上线切换（**等待用户通知**）

| 项 | 内容 |
| --- | --- |
| 新建 | 无 |
| 修改 | 部署机 `10.0.0.226` 的 `.env`（补 `SITE_ORIGIN`）与部署产物；`README.md` 的升级步骤（若 ⑨ 没写完，本票补） |
| 验收 | ① `npm run check:all` **在真机上**全绿；② `.env` 补 `SITE_ORIGIN` 后服务起得来（缺它就是起不来，见票②），旧 cookie 失效要求重登一次；③ **浏览器目视**：登出后另一台设备仍在线（①的核心语义）、管理台五页、改标题/描述/间隔立即生效、手动备份真的出产物、只读账号撞 `/admin` 得 403；④ 窄屏断点与打印样式目视；⑤ 对比度的目视复核（⑧ 已经给出比值，这里只是看一眼） |
| 依赖 | ⑨（全部断言先绿，才轮到真机） |

⚠ **本票等用户通知**（与 map #1 的 [真机部署与验收](https://github.com/Lkyloveaw/lkyloveaw-home/issues/19) 同一状态）：它要一台真机 + 一个人看屏幕，agent 单独做不到。⑨ 没关之前不启动。
⚠ 部署机上若 `docker-compose.yml` / 裸机自建路径与 `docs/deploy-environment.md` 有出入，**如实登记**，不要顺手改部署方式（那是另一个决定）。

---

## 3. 本票新发现的不一致（charting 时没看到）

### 3.1 `docs/targets-source-decision.md` §7 漏了首页空态那处文案

该文档只列了 `views.ts:301-308`（关于页）教人「编辑 `targets.json`」，但**首页空态 `views.ts:216` 也在教同一件事**。④ 落地后文件已完全被忽略，两处文案都会变成谎话。
→ **处置**：两处（`216` 首页空态、`302` 关于页）都归票④（已写进它的票面）。实测还有第三处 `views.ts:455`（面板空态），它**已经**写着「在管理台的「目标」里新增，或首次启动时写 `targets.json` 导入」——④ 落地后它仍然成立，不用改。

### 3.2 `docs/settings-source-decision.md` 的行号写错了

文档写 `views.ts:406` 是「每 N 秒探测」那行，实际在 `views.ts:441`。
→ **处置**：票⑤ 落地按代码走（照文档走会改错地方）。这不是需要决策的问题。

### 3.3 备份「跳过」在代码里是 `ok: true`

`runBackup()` 在「今天已备份过」时返回 `ok: true` + note，而 #22 §8.2 的 #13/#14 两条断言（"产物真出现" / "再点不新增"）只看 `ok` 会互斥。
→ **处置**：票⑥ 的 UI 与断言**必须按 note 分型**（已写进它的票面）。

### 3.4 `docs/targets-source-decision.md` §5 的算法名与代码不符

文档把"连续可用时长"写成 `getStats` 的算法，实际在 `store.ts:270-290` 的 `computeUpStreak`（`getStats` 在 213 行调用它）。
→ **处置**：票④ 落地以代码为准，改的是 `computeUpStreak` 的输入口径。**位置对、名字错**，不构成决策问题。

### 3.5 「恢复旧备份会让当时的会话复活」没有落点

`docs/session-revoke-decision.md` §10.1-2 自己把这条挂给了 #22 与批次票，但 #22 的落点表里没有它。
→ **处置**：归票⑥（备份页说明文字）。这是**用户可见的后果**，不该只活在决定文档里。

### 3.6 `#24`（roles）**没有落点表**

7 份文档里只有它没有。它的落点只能从 §2/§3/§4 的叙述里抽（`users.ts` / `cli/passwd.ts` / `CONTEXT.md` / 两个 docs 指针）。
→ **处置**：已如实计入 §1 的碰撞矩阵（`src/auth.ts` 因此从 3 升到 4）；票① 的票面把落点写全，避免"照文档落地漏掉 `--list` 印角色"这类事。

---

## 4. 全局约束（每张票都适用）

1. **每张票合入后站点必须可用**（用户选定）。本批只有两个**用户看得见**的变化，都已写在票面：① 合入时**既有 cookie 全部失效，重登一次**；② 合入后 `.env` **必须**有 `SITE_ORIGIN`，否则拒绝启动。
2. **一票一次会话做完**（用户选定）。若发现超出一票的尺寸，**当场再拆一票**，不在票内拖。
3. **断言必须先证明前提成立**。本批依据的判定表**全部是未实测的**（产出它们的会话没有命令通道，五份文档各自写明"待验证的断言清单"）——所以**落地第一件事就是把本票的判定表跑成绿**；跑出与文档不一致的，**改文档**，不要改断言去迁就实现（`docs/session-revoke-decision.md` §5 第 13/24 行尤其容易被"顺手放宽"）。
4. **不引新依赖**（`node:async_hooks` 与 `node:crypto` 都是内置）。
5. **`scripts/` 不进生产镜像**（`Dockerfile:27` 只 `COPY dist`）：任何运维 CLI 必须写在 `src/cli/` 下。
6. **失败要显眼不要静默降级**（本仓库既有取舍）。
7. ⚠ **命令通道**：本批的验收要跑 `npm run build` / `check:unit` / `check:e2e`。**若某张票的会话仍无可用命令通道（`ops_bash` 缺 bash IPC 收据 / `pwsh` 被执行策略拦），该票不得标记完成**——如实登记"代码已写、断言未跑"，并把缺口留给 ⑨。
8. 每张票只加**自己的、本地的**断言；不要改别的票写的断言（收口归 ⑨）。

---

## 5. 顺序与「每票可用」的关系

```
① ──→ ② ──→ ③ ──┬──→ ④ ──┐
                 ├──→ ⑤ ──┤
                 ├──→ ⑥ ──┼──→ ⑨ ──→ ⑩
                 └──→ ⑦ ──┘
⑧（独立）
```

**硬依赖（就是要写进阻塞边的那几条）**：

- ② ← ①：`requireAdmin` 要读 `decision.role`，角色在 ① 才进闸门。
- ③ ← ①②：管理台要 `requireAdmin` 与 403 形态。
- ④⑤⑥⑦ ← ③：四页的骨架、notice 闭集、400 就地重渲染都是 ③ 交付的。
- ⑨ ← ①②③④⑤⑥⑦⑧：收口。
- ⑩ ← ⑨：断言先绿，才轮到真机。

**软约束（写在票面上、不写进阻塞边）**：

1. **④ 与 ⑤ 在 `src/server.ts` 顶部同一段**（`const site` 37 行 / `buildSummary` 40-57 行，都要改成每请求读库）。串行建议 **④ → ⑤**；若并行，④ 只动 targets 的读取与 `getUptimeRaw` 口径，⑤ 只动 `site` 与间隔，**不要各自重排这一段**。
2. **③ 与 ⑧ 都改 `nav()`（`views.ts:58-71`）与 `public/style.css`**：⑧ 重写呈现，③ 只**追加**第 5 项与 admin 页类名；谁后合谁适配（沿用 #12 票② 对 `status.js` 的处置手法）。
3. **⑧ 建议早于 ③**：管理台是数据面，页面直接建在统一后的 token 上，省掉一次全站回扫。⑧ 若晚于 ③④⑤⑥⑦，必须把管理台五页一并纳入 token 覆盖，但**不重写它们的结构**。
4. **④⑤⑥⑦ 之间不阻塞**，串行推荐 ④ → ⑤ → ⑥ → ⑦（④ 动面最大；⑤ 与它同段）。
5. **⑦ 不许复制 ① 的守卫**：路由只调用 `users.ts` 的守卫函数（否则网页与 CLI 的规则会分叉，CLI 变成后门）。

**「每票可用」在本批的含义**：不存在"登不进/面板全坏"的中间态。唯一一次全体重登是 ① 的 `sid` 迁移，唯一一次配置动作是 ② 的 `SITE_ORIGIN`。

---

## 6. 落点归属与断言归属

### 6.1 落点归属（每个文件归哪张票）

| 文件 | 票 | 说明 |
| --- | --- | --- |
| `src/sessions-store.ts`（新）· `src/session.ts` | ① | 会话域 |
| `src/users.ts` · `src/cli/passwd.ts` | ① | 账号域（含 role 迁移与守卫） |
| `src/csrf.ts`（新） | ② | 写路径真实性与资格 |
| `src/config.ts` | ②（`siteOrigins`/`trustProxy`）· ④（导出校验）· ⑤（`DEFAULT_SETTINGS`） | 三段互不重叠 |
| `src/auth.ts` | ①（闸门与 role）· ②（`requireAdmin`）· ③（`KNOWN_PAGES`） | 三次改动落在三个位置 |
| `src/probe.ts` | ①（`sweepSessions`）· ④（一轮读一次清单）· ⑤（每轮重读间隔） | 三段互不重叠 |
| `src/store.ts` | ④（`getUptimeRaw` 收参） | 只此一处 |
| `src/targets-store.ts`（新） · `src/settings-store.ts`（新） | ④ · ⑤ | 天然切片 |
| `src/backup.ts` | ⑥ | 列表要给大小与时间 |
| `src/server.ts` | ①（登录/登出/改密）· ②（L2/ALS/`no-store`）· ③（5 条 GET）· ④⑤⑥⑦（各自的 POST） | **每票只加自己那几条与自己那段 handler** |
| `src/views.ts` | ②（`csrfField` + 403 页）· ③（admin 五页 + nav 第 5 项）· ④⑤⑥⑦（各自那一页）· ⑧（正文面呈现与 framework） | **文件共享、函数不共享** |
| `public/style.css` | ③（admin 类名）· ⑧（正文面排版与全站推广） | 见 §5 第 2 条 |
| `scripts/unit-check.mjs` | ① ② ④ ⑤ ⑥ | 各票只加自己的断言块 |
| `scripts/e2e-check.mjs` | ① ② ③ ④ ⑤ ⑥ ⑦ ⑨ | ⑨ 收口 |
| `scripts/schema-check.mjs`（新，或并入 unit-check） | ① | 建表幂等与 JOIN 形状 |
| `CONTEXT.md` · `README.md` · `.env.example` | ①③（词汇）· ②⑤（设置与环境）· ⑨（一致性收口）· ⑩（部署机升级步骤） | 收口在 ⑨ |

### 6.2 断言归属（判据同 #12 §6）

**一张实现票自带的断言，不能依赖另一张实现票的产出。** 若依赖，归后落地的那张票。

| 断言面 | 归属 |
| --- | --- |
| `decideSession` 24 行 · 建表/迁移幂等 · CLI 行数 · 单设备登出 | ① |
| CSRF token 派生 / origin 判定（纯函数）· L2/L3 的 HTTP 面（打既有三条写路由） | ② |
| 管理台 GET 侧断言（入口、403、notice 闭集、未登录回跳） | ③ |
| targets 导入/删除两岔/口径回归 · 热加载 | ④ |
| settings 落值/优先级/改间隔下一轮生效 | ⑤ |
| 备份产出与防重复（**按 note 分型**） | ⑥ |
| 账号写入口的四类断言（守卫、确认框、写后读、保留输入） | ⑦ |
| 视觉：面板 47 项不退 · 对比度比值 · 深浅两套 · 窄屏/打印 | ⑧ |
| e2e 最终形态 · README/文档一致 · 断言质量原则 · 未实测清账 | ⑨ |
| 真机：全量断言在部署机跑绿 · `.env` 与重启 · 浏览器目视 · 窄屏/打印目视 | ⑩ |

---

## 7. `## 进度` 登记

本票切定后，map 上**不再有任何未定的决定**——剩下的全是执行。8 张实现票 + 收口票 + 真机票按 §2 逐张创建并挂到 map 20，阻塞边按 §5 的硬依赖连。

⚠ **本票关闭 ≠ 站点自管了。** 代码仍然一行没落地：登出还没真吊销、管理台还不存在、目标还在 `targets.json`、视觉只落在面板。真正的状态变化发生在 ①–⑨ 全部合入、并由 ⑩ 在真机上确认之后。
