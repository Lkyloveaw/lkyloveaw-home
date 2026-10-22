# 公开面换装：实现切分（#88）

> 票：[#88 落地切分：公开面换装切成哪些实现票](https://github.com/Lkyloveaw/lkyloveaw-home/issues/88)（父地图：[#82 公开面换装](https://github.com/Lkyloveaw/lkyloveaw-home/issues/82)）
> 上游三份决定书：[#85 token / 字阶](https://github.com/Lkyloveaw/lkyloveaw-home/issues/85) → `docs/claude-theme-decision.md`；[#86 外壳](https://github.com/Lkyloveaw/lkyloveaw-home/issues/86) → `docs/public-shell-decision.md`；[#87 用户菜单](https://github.com/Lkyloveaw/lkyloveaw-home/issues/87) → `docs/user-menu-decision.md`
> 本文只做**切分**，不写产品代码。实现票在本文关闭后作为 #82 的子票毕业；每票一次会话做完。

## 0. 一句话

**4 批、串行：基座 → 公开面外壳 → 用户菜单 / 管理台 → 收口。**

```
T1 基座（只 CSS + style-check）
  └─ T2 公开面外壳（顶栏 / 侧栏 / 抽屉 / 403-404 / 登录）
       └─ T3 用户菜单 + /account + 管理台顶栏
            └─ T4 收口（全量 e2e / 文档 / 视觉 / 旧名清零 / 关地图）
```

**一个关键修正：e2e 不在 T4 一次性迁移。** 每批改到自己那一段断言，保持每批可独立验收；T4 只做**全量总跑**与跨批残余，否则 T2 删掉 tab bar 后 e2e 会红到 T4，所谓「可独立验收」就是假的。

---

## 1. 为什么是这 4 批

| 原则 | 落法 |
| --- | --- |
| 每批能单独验收 | 每批结束跑 `build` + 本批相关 `style-check` / `e2e` 段，绿了才下一批 |
| 先基座后组件 | T1 只换 token / 字阶 / 圆角 / 打印；DOM 不变，出问题只可能是颜色 / 排版 |
| 外壳先于用户菜单 | T2 把顶栏槽位、文章侧栏、抽屉、错误页搭好；T3 再把临时 theme / logout 换成胶囊 |
| 临时状态不丢功能 | T2 保留现有 theme picker + 登出（可能在 390 略挤，**不花时间打磨**）；T3 才换成菜单 |
| 收口单独一票 | 文档、视觉、旧名清零、地图关闭是跨批工作，混进 T3 会让 T3 的 diff 不可读 |
| e2e 跟着行为走 | T2 改外壳断言，T3 改改密 / 账户 / 菜单断言；T4 全量复跑 |

> 4 批是 #88 的建议；如果执行中发现 T2 或 T3 单票超过一次会话的合理体量，**在开工前**再拆，不要在实现中途临时改切分。

---

## 2. 依赖与毕业

| 批 | 票号 | 标题 | 父 | 阻塞 |
| --- | --- | --- | --- | --- |
| T1 | `#89` | 基座：Claude token / 字阶 / 圆角 / 打印换装 | #82 | — |
| T2 | `#90` | 公开面外壳：顶栏 / 文章侧栏 / 抽屉 / 403-404 / 登录 | #82 | T1 |
| T3 | `#91` | 用户菜单与管理台：胶囊 / 下拉 / `/account` / 主题 / rail 共存 | #82 | T2 |
| T4 | `#92` | 收口：全量 e2e / 文档回填 / 1440-390 视觉 / 旧名清零 | #82 | T3 |

- 四张都加 `wayfinder:task`，都挂在 #82 下；T4 通过后由它关闭 #82。
- 阻塞边是**串行**的：T2 依赖 T1 的 token / 字阶；T3 依赖 T2 的顶栏槽位；T4 依赖前三批全部绿。
- 每票的写集有重叠（`views.ts` / `style.css` / `style-check` / `e2e` 会被多批改），这是**顺序票**，不是并行票；不要按文件所有权拆。

---

## 3. T1 · 基座

**目标：** 把 #85 的 17 色、字体 / 字阶、圆角、打印与 `style-check` 迁移落地；**不改 DOM / 路由 / HTML 结构**。

### 3.1 写集

- `public/style.css`
- `scripts/style-check.mjs`

### 3.2 具体改什么

**颜色 / 非色 token（按 #85 §2.1 / §4.1 / 附录 A）**

- 17 个颜色 token 全部换成 `light-dark(浅, 深)`：`--bg`、`--bg-card`、`--bg-elev`、`--fill`、`--fill-strong`、`--label`、`--label-2`、`--label-3`、`--separator`、`--border-strong`、`--accent`、`--on-accent`、`--ok`、`--warn`、`--bad`、`--unknown`、`--scrim`。
- 新增 / 更新 5 个非色 token：`--font-display`（系统衬线栈）、`--wrap-docs: 1360px`、`--side-w: 224px`、`--gap-docs: 28px`、`--header-h: 56px`。
- `--radius-lg: 16px → 12px`；`--lh-title` / `--lh-prose` 按 #85 §3.2 改；10 个字号值按 #85 §3.2 改。
- 保留 `--wrap: 900px` / `--wrap-admin: 1140px` / `--rail-w: 248px`（T2 才用 `--wrap-docs` / `--side-w`）；顺手修正 `--wrap-admin` 的旧注释，等式用 #85 §4.2 的正确写法。
- `--label-3` 只做非文字（描边 / 分隔），不出现在带 `font-size` 的文字规则里。

**排版 / 组件**

- `.large-title`：38/600（700 → 600）。
- `.prose h3`：`--fs-headline` 18 sans（不再用 serif 的 title3）。
- `.group-title`：`--fs-title3` 21 serif。
- `.prose` 的 `--measure-prose: 68ch` 与 `margin-inline: auto` 保留并校验值。
- `.empty` 仍是实色 `--fill` 块（**不**改成原型的虚线框）。
- `.dot.unknown` 加 `--label-3` 描边（或同时带可见「无数据」文字），不能只靠 `--unknown` 填充。

**打印（按 #85 §5 / 附录 B）**

- 打印块仍在 `body` 上，不写 `:root`；17 个灰阶值替换；`light-dark()` 禁令保留。
- 隐藏清单先加上新外壳选择器：`.site-header`、`.docs-side`、`.site-rail`、`.nav-drawer`、`.header-actions`、`.site-footer`、`.admin-tabs`（T2 才会出现这些元素；T1 先让规则就位）。
- `.wrap` / `.prose` 放开限宽；表格 `overflow: visible`；卡片 / 行 `break-inside: avoid`；状态格图案保留。

**`scripts/style-check.mjs`（按 #85 §6）**

- `COLOR_TOKENS` 仍 17；`NON_COLOR` 24 → 29；section 标题 21 → 29。
- `TEXT_PAIRS` 19 → 16（删 `accent/bg`、`accent/bg-card`、`accent/bg-elev`）。
- `NON_TEXTS_PAIRS` 12 → 10（删 `accent/bg-elev`、`accent/fill`）；`ALLOWED` 仍为空。
- 新增 guard：`accent/bg-elev` / `accent/fill` **不在** `NON_TEXT_PAIRS` 里。
- 排版段：`large-title` 38/600；`.prose h3` 18 sans；`.group-title` 21 serif；serif ≥20；68ch；`label-3` 非文字；`.dot.unknown` 描边。
- 打印段：17 灰阶、隐藏新外壳、`light-dark()` 禁令、图案。
- **G 段（外壳 / 导航 / 720 / tab bar）先不动**：那是 T2 的写集；T1 保持现有 `site-rail` / `tab-bar` 断言，等 T2 一起改写。

### 3.3 验收

```bash
npm run build
npm run check:style
npm run check:e2e
git diff --check
```

- `check:style` 全过；条数不承诺 170（G 段还没改，最终以复跑为准）。
- `check:e2e` 536 基线应仍绿：T1 不改 HTML，只改 CSS；主题 token / picker / 打印断言都在。
- 目视只做快速确认（颜色 / 字号 / 圆角 / 打印没有明显崩）；完整 1440/390 视觉在 T4。

### 3.4 不要做

- 不改 `src/views.ts` / `src/server.ts`；不改 DOM / 路由 / 顶栏 / 侧栏 / 抽屉。
- 不改 `scripts/e2e-check.mjs`；e2e 迁移从 T2 开始。
- 不加外部字体、不加新依赖、不改内容 IA / URL / 登录闸门。
- `CONTEXT.md` 与旧文档留 T4。

---

## 4. T2 · 公开面外壳

**目标：** 按 #86 落地顶栏、公开文章侧栏、移动 `<details>` 抽屉、403/404 的 plain 外壳、登录页独立；13 个 `layout()` 调用点全部接上 `sidebar`。

### 4.1 写集

- `src/views.ts`
- `src/server.ts`
- `public/style.css`
- `scripts/style-check.mjs`
- `scripts/e2e-check.mjs`

### 4.2 具体改什么

**`src/views.ts`（按 #86 §2-§7）**

- `LayoutOptions.sidebar` **必填**：`{ posts: Array<{slug,title}>; currentSlug?: string } | null`。
- `active` 只保留 `'home' | 'posts' | 'status' | 'about'`；管理页不再传 `active`。
- 外壳三态：`app-shell--docs` / `app-shell--admin` / `app-shell--plain`；`<main class="app-main">` 不再套 `.wrap`。
- 顶栏：`.site-header` + `.header-inner` + `.brand`（占位 SVG mark + 站名）+ `.top-nav`（四项）+ `.header-actions`。
- `.header-actions` **T2 临时保留现有 `themePicker()` + 登出 form**（不要清空；T3 才换成胶囊）。390 上会略挤，T2 不磨。
- 新增公开侧栏 `<nav class="docs-side" aria-label="公开文章">`：标题「文章」、全量已发布文章、日期倒序、无计数、无分组、当前文章 `aria-current="page"`、空态一句、sticky / 独立滚动。
- 新增移动抽屉 `<details class="nav-drawer">` + `<summary>` + `.drawer-panel`；公开页四项 + 文章索引；管理台四项；403/404 四项；登录页没有。
- 删除 `tabBar()` / `ADMIN_ITEM` / `<nav class="tab-bar">`；`.admin-tabs` 保留。
- 403/404：`.app-shell--plain`，只顶栏、无 `.docs-side` / `.site-rail`，零当前项；`sidebar: null`。
- 管理台：同一顶栏 + `.site-rail` + `.admin-tabs`；顶栏零当前项；rail 当前项由 `adminSection` 决定；公开侧栏为 `null`。
- 登录页：没有顶栏 / 侧栏 / 抽屉；`loginPage()` 仍是独立外壳。
- 公开页函数接收 / 转发 `sidebar`；管理台 / 错误页内部传 `null`；13 个调用点：5 个公开视图函数（`postsPage` 同时服务 `/posts` 与 `/tags/:tag`）+ 6 个管理页 + `forbiddenPage` + `notFoundPage`。

**`src/server.ts`（按 #86 §2.2）**

- 公开六条路由把 `listPublishedPosts()` 的全量映射成 `{slug,title}` 传进页面函数；`/tags/:tag` 主列表过滤、侧栏全量；`/posts/:slug` 加 `currentSlug`；`/status`、`/about` 新增一次全量查询（SQLite 小表）。
- 管理页 / 403 / 404 传 `sidebar: null`；不查文章。
- `views.ts` 仍零 store 依赖；不把 `listPublishedPosts` 塞进视图。

**`public/style.css`（按 #86 §3-§8）**

- 顶栏 sticky 56、`background: var(--bg)`、1px `--separator`、`.header-inner` max `--wrap-docs` 1360；`.top-nav` 文本四项、当前项 2px accent 下划线；无 `backdrop-filter`。
- `.app-shell--docs`：`224px minmax(0,1fr)`、gap 28、max 1360；`.app-main` 1068；`.docs-side` sticky / 独立滚动 / 当前项 accent 竖条 / 空态。
- `.app-shell--admin`：`248px minmax(0,1fr)`、max 1140；`.site-rail` 只在管理台；`.admin-tabs` 保留；无 `.docs-side`。
- `.app-shell--plain`：900 宽、单列、403/404 居中。
- `.nav-drawer`：summary 汉堡；`≤720` 才显示；面板 fixed 在 56 之下、284/全宽、独立滚动；`body:has(.nav-drawer[open])` 滚动锁；无 JS。
- `≤720`：`.top-nav` / `.docs-side` / `.site-rail` 隐藏；`.nav-drawer` 出现；`.admin-tabs` 出现；外壳单列；**没有** `.tab-bar`。
- 打印：隐藏顶栏 / `.docs-side` / `.site-rail` / `.nav-drawer` / `.header-actions` / `.site-footer` / `.admin-tabs`；外壳退回单列。
- 删除 `.tab-bar` 的全部 CSS（屏幕 / 720 / 打印）。

**`scripts/style-check.mjs`（按 #86 §10.2）**

- G 段整段改写：公开 `.docs-side` 唯一 + 管理 `.site-rail` 唯一；`.top-nav` 四项；`.app-shell--docs/--admin/--plain`；720 抽屉；打印隐藏；删除 tab bar 同源 / `.tab-bar` 检查。
- 新类名 `.top-nav` / `.docs-side` / `.nav-drawer` / `.drawer-panel` / `.docs-side-empty` / `.app-shell--docs` / `.app-shell--plain` 加 CSS 定义；`.site-nav` 仍禁用。
- `ADMIN_ITEM` / `tabBar` 的断言删除；`ADMIN_GROUPS` / `.admin-tabs` 保留。
- 当前项：公开 `.top-nav` 恰好 1；文章页 `.docs-side` 再 1；管理 rail 1；403/404 0（按容器，不按全页）。

**`scripts/e2e-check.mjs`（按 #86 §10.1）**

- 助手：保留 `railOf` / `currentOf`；新增 `topNavOf` / `docsSideOf` / `currentInTopNav` / `sidebarLinks`；删除 `tabOf` / `tabItems`。
- 改 1053-1057（只读 top-nav 四项、无管理）、1093-1098（403 只顶栏、无 rail / docs-side、零当前项）、1100-1118（公开页 top-nav 4 + docs-side 6）、1121-1124（删 tab bar；改 drawer SSR）、2381-2391（公开页 / 管理台外壳、当前项拆分、删管理 tab bar）。
- 新增：六公开页侧栏；文章页当前文章；tag 页全量侧栏；403/404；管理台六页；drawer 结构；无 `.tab-bar`。
- theme picker / logout 仍按临时状态断言（页头 + 登录页各 1；`logout-form` 仍在）；T3 再改。

### 4.3 验收

```bash
npm run build
npm run check:style
npm run check:e2e
git diff --check
```

- e2e 外壳段必须绿；全量 536 的条数会因删 / 增断言变化，不承诺原数。
- 390 / 1440 快速目视：顶栏不换行、侧栏在、抽屉能开、403 只有顶栏；完整视觉在 T4。
- 临时 theme / logout 仍可用；不要为了好看在 T2 做用户菜单。

### 4.4 不要做

- 不写用户菜单 / 胶囊 / `/account` / 改密 PRG（T3）。
- 不删临时的 theme picker / 登出；不把顶栏右侧清空。
- 不改 `csrf.ts` / `session.ts` / `auth.ts`。
- 不改文档 / CONTEXT（T4）。

---

## 5. T3 · 用户菜单与管理台

**目标：** 按 #87 落地右上角胶囊 / 下拉、`/account`、改密 PRG、主题入口、管理台顶栏 + rail 共存；14 个 `layout()` 调用点。

### 5.1 写集

- `src/views.ts`
- `src/server.ts`
- `src/auth.ts`
- `src/csrf.ts`
- `src/session.ts`
- `src/sessions-store.ts`
- `public/style.css`
- `scripts/style-check.mjs`
- `scripts/e2e-check.mjs`

### 5.2 具体改什么

**用户名（#87 §6）**

- `sessions-store.findSessionState()` 的同一 SELECT 加 `u.username AS username`；`SessionState.user` 加 `username: string`。
- `RequestDecision` 加 `username?: string`；`decideRequest()` 的 `ok` 返回带上。
- `csrfContext` 类型加 `userName?: string`；新增 `currentUserName()`（无上下文返回 `''`）；`server.ts` 的 `enterWith` 加 `userName`。
- **不新增查询**；不给 `LayoutOptions` 塞 viewer；14 个调用点签名不变。

**胶囊 / 菜单（#87 §3-§4）**

- `.header-actions` 里移除临时的 `themePicker()` + 登出 form，换成 `.user-menu` + `.user-pill` + `.user-panel`。
- 胶囊只在 `currentUserId() !== undefined` 时渲染；未登录 403/404 没有胶囊；登录页没有。
- 面板：身份（用户名 · 管理员/只读）· 修改口令（`/account`）· 管理后台（仅 `currentIsAdmin()` 渲染）· 主题（`themePicker()`）· 登出（POST + CSRF）。
- `button` + `aria-expanded` / `aria-controls`；CSS hover / `:focus-within` 无 JS 降级；内联小段 JS 补点击 / Escape / 点外 / 焦点返回 / `data-suppress`；**没有 focus trap / 没有 `role=menu`**；打开菜单时顺手关掉 `.nav-drawer[open]`。
- ≤720 只留头像；用户名在面板身份行；面板 284 右对齐。
- 主题 picker：登录后 1 个（菜单里）+ 登录页 1 个；`themePicker()` 调用点仍 2；`<noscript>` 字符串不变；不新增颜色 / 对比度对。

**`/account`（#87 §5）**

- 新增 `GET /account`：受登录保护；不在 `PUBLIC_PATHS`；`KNOWN_PAGES` 加 `/account`；未登录 302 `/login?next=%2Faccount`。
- 外壳：公开顶栏 + 无 `.docs-side` / `.site-rail`；`.app-shell--plain` 900；`sidebar: null`；`active` 不传；`bodyClass: 'page-account'`；零当前项。
- 账户页：身份 + 当前 / 新 / 确认表单 + CSRF；`minlength` 用 `MIN_PASSWORD_LENGTH`；口令不回填；错误在表单上方；成功 `?notice=password-changed` 闭集 key。
- `POST /password`：成功 **302 PRG** `/account?notice=password-changed`（`setPassword` → `setSession` → redirect）；失败 **400** 回账户页；CSRF 失败仍 403；`statusPage()` 的 `notice` 参数删除。
- 管理台账号页 `views.ts:814-815` 的「改自己口令」文案改成「右上角用户菜单 → 修改口令（`/account`）」。
- 14 条 HTML GET 路由 / 14 个 layout 调用点（#86 的 13 + `accountPage`）。

**`public/style.css` / `scripts/style-check.mjs`（#87 §7-§8）**

- 新类名：`.user-menu` / `.user-pill` / `.avatar` / `.user-name` / `.user-panel` / `.user-identity` / `.identity-main` / `.role-tag` / `.menu-item` / `.menu-theme` / `.menu-sep` / `.account-page` / `.account-card` / `.account-form` / `.page-account`；全部有 CSS 定义。
- 胶囊 / 面板 284 / 12 圆角 / `--bg-card` / 无阴影；头像 28 / `--label` 底 / `--bg` 字；≤720 隐藏 `.user-name`；`prefers-reduced-motion` 关过渡。
- 账户页 `max-width: 520px`；表单输入用 `--border-strong`；面板 / 表单不新增 token / pair。
- `style-check`：`themePicker()` 仍 2；页面上 picker 1；`logout-form` 仍在（现在在面板里）；新类名有 CSS；无新对比度对。

**`scripts/e2e-check.mjs`（#87 §8.1）**

- 607-614 / 929-934 / 946-955：改密成功 `200 → 302`；检查 `Location`；仍取新 cookie；其他设备 / 旧口令 / 新口令断言保留。
- 新增：`GET /account` 未登录 302 / 登录 200；表单 / CSRF；管理员 / 只读身份；只读菜单没有 `/admin`；菜单结构；主题 select；登出 form；手机隐藏 `.user-name` 的 CSS；失败 400（三种错误）；成功 302 + notice；旧 token 403；登录回跳；未登录 403 无胶囊 / 已登录 403 有胶囊；登录页无胶囊、picker 1。
- 2414-2418 的主题 picker 计数保持（登录后 1 + 登录页 1）；T3 只是位置从页头变成菜单。
- 1053-1057 / 1093-1098 / 2381-2391 的外壳断言沿用 T2，补胶囊身份断言。

### 5.3 验收

```bash
npm run build
npm run check:unit
npm run check:style
npm run check:e2e
git diff --check
```

- 手工：桌面 hover / Tab focus / 点击开；Escape / 点外关；手机 390 点按；无 JS 时 hover / focus 仍能开；只读看不到管理后台；`/account` 改密成功 / 失败；主题切换。
- 改密会话语义：其他设备掉线、当前浏览器保持；旧 token 403；新 token 可用。
- 账户页 / 菜单不新增颜色对；`check:style` 全过。

### 5.4 不要做

- 不写文档 / CONTEXT（T4）。
- 不做 2FA / 会话列表 / 头像上传 / 忘记口令 / 运行时自定义主题。
- 不加 focus trap / ARIA menu；不加第二个主题入口。
- 不改 URL / 内容 IA / 登录闸门之外的东西。

---

## 6. T4 · 收口

**目标：** 全量复跑、文档回填、1440/390 浅深目视、旧类名清零，并在全部通过后关闭地图 #82。

### 6.1 写集

- `CONTEXT.md`
- `docs/ios-component-mapping-decision.md`
- `docs/admin-console-sidebar-decision.md`
- `docs/accounts-decision.md`
- `docs/claude-shell-prototype.md`
- `docs/claude-theme-decision.md` / `docs/public-shell-decision.md` / `docs/user-menu-decision.md`（只加「实现状态」行）
- `src/` / `public/` / `scripts/e2e-check.mjs` 的旧名残余
- `scripts/product-shots.mjs`（可选，仅当现有 CDP 脚本不能直接对产品跑）
- 地图 #82 的收口

### 6.2 文档回填

| 文件 | 做什么 |
| --- | --- |
| `CONTEXT.md` | 按 #85 §6.5 替换「主题」「字阶」；按 #86 §10.3 替换「导航」「管理台」；按 #87 §8.3 加「用户菜单」「我的账户」；主题条目里的「页头 `<select>`」改「用户菜单 + 登录页各 1 个」 |
| `docs/ios-component-mapping-decision.md` | 顶部加「§5 导航 / §7 组件 / §11 打印 / §13 e2e 清单被 #86/#87 取代」的 banner；§5 的 rail + tab bar 方案、§312 的 `.tab-bar`、§363 的隐藏清单、§378 的 N5 标注 superseded；不要整篇删，保留历史 |
| `docs/admin-console-sidebar-decision.md` | 追加：管理台保留 rail + `.admin-tabs`，同时有公开顶栏；顶栏不标当前项；公开 `.docs-side` 不进管理台；403 不显示 rail |
| `docs/accounts-decision.md` | 管理台账号页的「改自己口令」指路改为 `/account`；管理别人口令的接口不变 |
| `docs/claude-shell-prototype.md` | 记录最终差异：侧栏不显示计数、403/404 无侧栏、抽屉是 `<details>` 无 JS、改密落 `/account`、14 条路由 |
| 三份决定书 | 末尾各加一行「实现：T1–T4（#89–#92）；完成于 <日期>」；不改正文 |
| 本文 | 回填实际票号；T1–T4 状态 |

### 6.3 全量验收

```bash
npm run check:all        # verify + check:e2e
git diff --check
git status --short
```

- `check:all` = `verify`（typecheck / docker / unit / media / article / editor / leak / chart / style / backup / restart）+ `check:e2e`。
- 若 `check:docker` 因环境没有 Docker 上下文而失败：记录**确切失败原因**，其余 `verify` 子命令必须全过；不要静默跳过。
- e2e 的最终条数以复跑为准；`style-check` 同理，不为了凑 171 / 536 保留失效断言。

### 6.4 1440 / 390 浅深目视

- 用现有 `prototype/claude-shell/browser.mjs` / `shots.mjs` 的 CDP 方式对**产品**跑（必要时才落 `scripts/product-shots.mjs`；不引入新前端依赖）。
- 1440×900：首页 / 分享 / 标签 / 文章 / 系统可用性 / 关于 / 管理台概览 / 管理台目标 / `/account` / 403 / 404，浅 + 深。
- 390×844：首页 / 文章 / 登录 / 管理台目标 / 菜单展开 / 抽屉展开，浅 + 深。
- 打印：文章页 + 系统可用性页各一张 PDF / 截图。
- 对照 `prototype/claude-shell/shots/b-*.png`：布局 / 密度 / 层级；正文按 #85 的 17px / 68ch，不按原型的 15px / 780px。
- 产物放 `tmp/shots/` 或 `prototype/claude-shell/shots/product/`（untracked）；附 `manifest.json`；**不做像素级 diff**，人工目视 + 记录偏差。

### 6.5 旧名清零

```bash
rg -n 'tab-bar|tabBar|ADMIN_ITEM|site-nav|nav-sep|plane-|admin-table|admin-side|mini-|admin-shell|admin-main' \
  src public scripts/e2e-check.mjs
```

- 期望 **0**；`scripts/style-check.mjs` 的「退场类名」guard 里允许出现这些字符串（它是禁用名单），不纳入 0 检查。
- `.site-rail` / `.theme-picker` / `.logout-form` / `.header-actions` / `.wrap` **保留**（管理台 rail、菜单主题、菜单登出、顶栏工具区、页脚 / 登录），不在清零名单。
- `docs/` 里的旧名保留在历史文档；由 6.2 标 superseded，不删。

### 6.6 关闭地图

- T4 全绿、目视通过、文档回填、旧名清零后：`deck_issue_patch` 关闭 #82（地图），在 #82 的进度写最终状态；`deck_issue_report` #92。
- 地图关闭条件：T1–T4 全 closed；#82 的 Destination（暖白纸感 / 顶栏 / 文章侧栏 / 用户菜单 / 管理台 rail / 三态 / 打印）逐条满足；没有遗留实现票。
- 若 T4 发现必须新增第 5 票：**不要**在地图关闭前偷偷扩容；先开票、补阻塞边、更新本文，再决定地图是否继续。

---

## 7. 每批共同的纪律

- **范围**：URL 不变、内容 IA 不变、登录闸门不变、管理台写路径不变；只换外壳 / 视觉 / 用户菜单 / 账户页。
- **依赖**：不新增前端框架、构建步骤、外部字体、运行时依赖；不把原型代码搬进产品。
- **断言**：每批都跑 `build` + 本批相关 `check:style` / `check:e2e`；不把红着的 e2e 留给下一批。
- **提交**：每批一个可回滚的 diff；不要混入未跟踪的 `prototype/` 产物；`git diff --check`。
- **文档**：代码注释跟着代码改；`CONTEXT.md` / 旧文档统一 T4，避免每批都改词表。
- **视觉**：T1 快速确认；T2/T3 390 / 1440 快速看；T4 全量浅深 + 打印。
- **失败方向**：类型 / 断言优先（`sidebar` 必填、`active` 四值、`themePicker` 2 次、`POST /password` 302）；不要用「运行时再看」兜底。

---

## 8. 验收命令速查

| 批 | 命令 |
| --- | --- |
| T1 | `npm run build && npm run check:style && npm run check:e2e` |
| T2 | `npm run build && npm run check:style && npm run check:e2e` |
| T3 | `npm run build && npm run check:unit && npm run check:style && npm run check:e2e` |
| T4 | `npm run check:all && git diff --check` + 截图 + `rg` 旧名 |

> `check:e2e` 会起临时 DB / server；每批都在干净工作树上跑，失败先看第一条红，不要并行改多个批次。

---

## 9. 风险与边界

| 项 | 说明 |
| --- | --- |
| T1 颜色 / 字阶影响全站 | 只改 CSS；e2e 不测像素；T4 目视兜底；出问题回滚单批 |
| T2 临时 theme / logout 挤 | 390 上可能挤；T2 不磨，T3 换胶囊；不要为此提前做用户菜单 |
| T2 删 tab bar 后 e2e 红 | T2 自己改外壳断言；不要留到 T4 |
| T2 侧栏数据 | 六公开页全量；`/tags` 主列表过滤、侧栏全量；`/status` `/about` 新增一次查询 |
| T2 403 无 rail | e2e 1093-1098 先改；只读 403 仍可看顶栏 + 临时 theme / logout |
| T3 改密 200 → 302 | 三处 e2e 改；其他设备掉线、当前浏览器重签；旧 token 403 |
| T3 用户名一列 | 同一次会话查询；不新增查询；无上下文返回空串；胶囊只在已登录渲染 |
| T3 无 JS 菜单 | `aria-expanded` 可能 false；Escape / 点外需 JS；无 focus trap；这是取舍 |
| T3 `/account` 第 14 条路由 | `KNOWN_PAGES` 加；`PUBLIC_PATHS` 不加；e2e 登录回跳 |
| T4 文档 / 视觉 | 旧文档标 superseded 不删；截图 untracked；不像素 diff |
| T4 地图关闭 | 先全绿再关；不偷偷扩容第 5 票 |

---

## 10. 本文不决定什么

- 实现中的具体函数名 / 行号 / CSS 细节；以三份决定书为准。
- 是否把实现票再拆成 5 批；开工前可议，开工后不临时改。
- 2FA / 会话列表 / 头像上传 / 忘记口令 / 运行时自定义主题 / logo 上传 / 搜索 / 多语言 → out of scope。
- 其他地图（#76 / #1 / #30）的推进；本文只服务 #82。

## 11. 收口状态（2026-10-22）

- T1 #89 基座：已关闭，`check:style` 170/170。
- T2 #90 公开面外壳：已关闭，`check:style` 172/172、`check:e2e` 536/536。
- T3 #91 用户菜单 / 账户入口：已关闭，`check:unit` 245/245、`check:style` 172/172、`check:e2e` 551/551。
- T4 #92 收口：已关闭；全量 `check:all` 全绿、1440/390 浅深 52 张截图 + 2 张打印 PDF、旧名清零；地图 #82 关闭。
- 工作树 tracked 修改 13 个文件（9 个代码/断言 + `CONTEXT.md` + 3 份旧文档）；三份决定书 / 原型报告 / 切分文档与截图产物未跟踪；未提交。
- **与 6.4 的偏差（据实记录）**：视觉验收脚本没有落成 `scripts/product-shots.mjs`，而是仓库根目录的 `.tmp-t4-shots.mjs`（untracked，201 行，真库 + 真登录 + Edge CDP）。产物在 `.t4-shots/`，含 `manifest.json`。要复跑视觉门就靠这个临时脚本，别再写第二份。
- **`scripts/` 未进视觉门**：`npm run check:all` 覆盖不到截图，视觉结论只能是「当时目视过」，不能作为每轮门禁复现——这是本期接受的代价。
