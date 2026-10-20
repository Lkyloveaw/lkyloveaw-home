# 实现批次怎么切：iOS 化的六批与每批的验收

本文件是「落地切分：iOS 化切成哪几批实现票」这张票的产出（map：[整站 iOS 化](https://github.com/Lkyloveaw/lkyloveaw-home/issues/64)）。

票：[#69 落地切分：iOS 化切成哪几批实现票](https://github.com/Lkyloveaw/lkyloveaw-home/issues/69)

上游决定全部已关闭（写本文时）：

- [#65 研究](https://github.com/Lkyloveaw/lkyloveaw-home/issues/65) → `docs/research/apple-hig-web.md`
- [#66 方向原型](https://github.com/Lkyloveaw/lkyloveaw-home/issues/66) → `docs/ios-direction-prototype.md`（选定 **A · 原生 App**）
- [#67 token 架构](https://github.com/Lkyloveaw/lkyloveaw-home/issues/67) → `docs/ios-theme-architecture-decision.md`
- [#68 组件映射与导航呈现](https://github.com/Lkyloveaw/lkyloveaw-home/issues/68) → `docs/ios-component-mapping-decision.md`

基线（2026-10-20 实测，`master` @ `13972d5`）：

| 项 | 数字 | 怎么来的 |
| --- | --- | --- |
| `public/style.css` | **666 行** | `wc -l` |
| `src/views.ts` | **1451 行** | `wc -l` |
| `scripts/style-check.mjs` | **72/72 全绿** | `node scripts/style-check.mjs` |
| `scripts/e2e-check.mjs` | **524/524 通过** | `node scripts/e2e-check.mjs`（本会话实测） |
| 客户端脚本 | `status.js` / `chart-path.js` / `article-editor.js` | 本图**一行不改**（DOM 契约是硬约束） |

---

## 0. 一句话结论

切 **6 批，一批一张票**，编号 ①–⑥，全部挂在本图下（**不另开 map**）：

```
① 基座（token / 字阶 / 三态主题 / 打印灰阶与图案）
      └─→ ② 外壳与导航（rail / tab bar / 管理模块条 / 基元 / 登录页 / 图标）
              ├─→ ③ 公开面（首页 / 分享 / 标签 / 文章 / 关于 / 空态）
              ├─→ ④ 面板（统计条 / 目标卡 / 格带 / 曲线 / 异常列表）
              └─→ ⑤ 管理台（六页列表化 + details 折叠 + 编辑器外观）
                      └─→ ⑥ 收口（打印降级 / 退场类名清零 / 全站目视与回归）
```

- **票**：[实现① 基座](https://github.com/Lkyloveaw/lkyloveaw-home/issues/70) · [实现② 外壳与导航](https://github.com/Lkyloveaw/lkyloveaw-home/issues/71) · [实现③ 公开面](https://github.com/Lkyloveaw/lkyloveaw-home/issues/72) · [实现④ 面板](https://github.com/Lkyloveaw/lkyloveaw-home/issues/73) · [实现⑤ 管理台](https://github.com/Lkyloveaw/lkyloveaw-home/issues/74) · [实现⑥ 收口](https://github.com/Lkyloveaw/lkyloveaw-home/issues/75)
- **阻塞边按串行接**（原生依赖边，5 条）：`71←70` `72←71` `73←72` `74←73` `75←74`。③④⑤ 逻辑上互不依赖，串行是因为它们改**同一张** `public/style.css`（理由见 §3）。
- **每批合入即站点可用**，且每批都跑 `style-check` + `e2e` + `verify` + 目视，先绿再关票。

---

## 1. 为什么是六批

| 判据 | 结论 |
| --- | --- |
| **能独立验收的最小边界** | 判据是**垂直切片**（用户看得见的一段界面 + 它自己的断言），不是「改了哪个文件」。① 交付「颜色/字号/深色/打印」；② 交付「导航长什么样」；③④⑤ 各交付一组页面的样子；⑥ 交付「纸上与收尾」 |
| **为什么 token 与字阶不能拆** | 两批都要在 666 行 CSS 里把**同一批规则**再走一遍；`--font-data/prose` 一删，`body.plane-*` 立刻失去意义 —— 平面退场必须与字阶同批。拆开会得到两次半张表的中间态 |
| **为什么外壳与页面不能合** | ① 之后全站还是旧顶栏；② 一次把六个页面 + 登录 + 403 的外壳换成同一套 rail/tab bar。页面**内容**（表格、卡片、文章列表）在 ② 里原样不动 —— 这是刻意的：外壳与内容分两批，才能各自回归 |
| **为什么 ③④⑤ 不合成一批** | 三组页面的断言完全不同（阅读 / 数据 / 写路径），合起来一次回归 500+ 条 e2e 会把「哪一批弄坏了什么」糊在一起。分开后每批失败面小、可独立回滚 |
| **为什么 ③④⑤ 不并行** | 逻辑上互不依赖（不同页面函数），但共用 `public/style.css` 与 `views.ts`；两个会话并行改同一张文件，冲突成本高于串行收益。**阻塞边是文件写冲突，不是语义依赖** —— 已在每张票的「依赖」里写明 |
| **为什么收口单独一批** | 打印降级清单、退场类名 grep、全站截图与最终数字登记，都是**跨批**的；放在最后才有东西可收 |

---

## 2. 六批总览

| 批次 | 票 | 交付（用户看得见） | 主要落点 | `style-check` 目标 | `e2e` |
| --- | --- | --- | --- | --- | --- |
| ① 基座 | [#70](https://github.com/Lkyloveaw/lkyloveaw-home/issues/70) | 颜色、字号、深浅三态、打印灰阶与图案 | `style.css` `:root` + 打印块；`views.ts` 两外壳 `<head>`/picker；`style-check` token/对比度/排版；`e2e` 主题组 | **≈134** | 524 → ~536（改写 7 + 新增 ~12） |
| ② 外壳与导航 | [#71](https://github.com/Lkyloveaw/lkyloveaw-home/issues/71) | 左侧 rail、手机 tab bar、管理模块条、不透明页头、按钮/列表基元、登录页、图标 | `views.ts` `layout()`/导航/登录；`icons.ts`；`style.css` 外壳 + 基元；`style-check` 导航段；`e2e` 32 条改写 | **≈142** | ~544（+rail/tab/403 ~8） |
| ③ 公开面 | [#72](https://github.com/Lkyloveaw/lkyloveaw-home/issues/72) | 首页 / 分享 / 标签 / 文章 / 关于 / 空态 | `views.ts` 五个页面函数；`style.css` 阅读面；`style-check` 类名与 overlay | **≈145** | ~546 |
| ④ 面板 | [#73](https://github.com/Lkyloveaw/lkyloveaw-home/issues/73) | 统计条、目标卡、格带、曲线、异常列表 | `views.ts` `statusPage`；`style.css` 面板；`panel-check` 必须仍绿 | **≈147** | ~547 |
| ⑤ 管理台 | [#74](https://github.com/Lkyloveaw/lkyloveaw-home/issues/74) | 六页列表化、折叠表单、确认框、notice、编辑器 | `views.ts` 六个管理页 + 编辑器；`style.css`；`style-check` 管理台结构 8 条 | **≈151** | ~549（写路径全回归） |
| ⑥ 收口 | [#75](https://github.com/Lkyloveaw/lkyloveaw-home/issues/75) | 打印降级、旧类名清零、截图与最终数字 | `style.css` print；`style-check` 隐藏清单；docs 回填 | **≈151** | 最终数登记 |

> 项数是**目标**，落地时以脚本输出为准；纪律是**只许升不许降**（明确退役的断言必须在票面写清是哪几条、为什么）。
> `e2e` 的总数是运行时的 `results.length`，不同批的拆分颗粒度会让它 ±3。

---

## 3. 每批的边界（详细）

### ① 基座 —— token、字阶、三态主题、打印

**交付**：全站换成一套 iOS token 与字阶，深浅三态（跟随系统 / 浅 / 深）可用且**不闪**，打印全灰阶 + 状态格带图案。**页面结构不变**。

**落点**：

| 文件 | 改什么 |
| --- | --- |
| `public/style.css` | `:root` = 17 色（`light-dark()`）+ 21 非颜色（10 字号 + 4 行高 + `radius`/`wrap`/`wrap-admin`/`side-w`/`font`/`mono`/`measure-prose`）；`[data-theme]` 两块只写 `color-scheme`；删 6 个排版 token 及其全部使用者；删 `body.plane-*`；旧 token 逐选择器迁移（`--border` 的两义性见 §10）；打印块 17 灰阶 + 格带 4 种图案 + `print-color-adjust` 只给格带 |
| `src/views.ts` | 两外壳 `<head>`：`<meta name="color-scheme">` + boot 脚本在 stylesheet **之前**；`</body>` 前主题脚本；页头 `.theme-picker` + `.header-actions`；登录页 `.login-theme`；`<noscript>` 隐藏 picker；删 `planeOf()` |
| `scripts/style-check.mjs` | token 10 / 对比度 62 / 排版 ≈23 / 打印图案 3 / 主题 6；`NON_COLOR` = **21** |
| `scripts/e2e-check.mjs` | 改写平面组 7 条（body 类、CSS `plane-`）；新增主题组 ~12 条 |
| 文档 | `docs/theme-decision.md`、`docs/visual-prototype-decision.md` 顶部「已被取代」；`CONTEXT.md` 主题/字阶词条，删两套平面 |

**为什么 `NON_COLOR` 是 21 而不是最终的 24**：`radius-sm` / `radius-lg` / `tap` 在 ② 才被消费，`--side-w` 在 ② 才换成 `--rail-w`。让 token 集合与「真的有人在用」同步，避免 dead token。

**不做**：导航结构、页面内容类名、图标、基元、打印隐藏清单（①②⑤⑥ 各管一段）。

### ② 外壳与导航

**交付**：桌面全站 rail、手机 tab bar、管理台模块条、不透明页头、组件基元（inset list / cell / 按钮四级 / tag 四语义 / chip row）、7 个内联图标、登录页与 403/404 的同一套外壳。

**落点**：

| 文件 | 改什么 |
| --- | --- |
| `src/views.ts` | `layout()` 重写成 `header + .app-shell(.site-rail + .app-main) + .tab-bar + footer`；一份 `NAV_ITEMS` → rail 与 tab bar 两处渲染；管理组（仅管理员）+ 两个 sub-label；`.admin-tabs`；403/404 `bodyClass: 'page-error'`；删 `nav()` / `nav-sep` / `adminSidebar()` |
| `src/icons.ts`（新） | `home/doc/pulse/info/sliders/chev/plus`；`currentColor`、`stroke-width 1.75`、装饰性 `aria-hidden` |
| `public/style.css` | `.app-shell`（`--rail-w: 248px`）、`.site-rail`、`.rail-*`、`.tab-bar`、`.tab-item`、`.admin-tabs*`、`.header-actions`、`.theme-picker`、`.login-theme`、`.inset-list`、`.cell*`、`.chev`、`.icon`、`.btn*`、`.tag-ok/.tag-warn`、`.chip-row`；页头去 `backdrop-filter`；720/560 断点；打印隐藏导航 |
| `scripts/style-check.mjs` | 导航/外壳 14 条（N1–N10 + 断点）；类名扫描加 `icons.ts` + 「图标只有内联 SVG」；`NON_COLOR` = **24** |
| `scripts/e2e-check.mjs` | 改写 32 条（侧栏组 20 + 平面组剩余 12）+ 新增 rail/tab/403 ~8 条 |
| 文档 | `CONTEXT.md` 导航词条 + 管理台词条；`docs/admin-console-sidebar-decision.md` §1/§5 修订 |

**不做**：页面内容结构（`.admin-table` / `.post-card` / `.target-*` 留到 ③④⑤）；不删 `.admin-table`。

### ③ 公开面

**交付**：首页（hero + 状态摘要 + 最近分享）、分享列表（chip row + 整行可点）、标签页、文章页（28/17/1.85 + 68ch 居中）、关于、空态。

**落点**：`views.ts` 的 `homePage`/`statusBlock`/`postCard`/`postsPage`/`postPage`/`aboutPage`；`style.css` 的 `.hero`/`.lede`/`.section*`/`.post*`/`.prose`/`.empty`/`.back`/`.post-list`/整行链接 overlay；`style-check` 类名 + 字阶落点 2 + overlay 2 + `.chip-row` 1；`e2e` +2。

**整行可点**：`.cell-title a::after { inset: 0 }` + `.tags a { position: relative; z-index: 1 }`（标题仍是 `<h2>`，标签仍可点，不嵌套链接）。

**不做**：搜索 / 筛选 / 分页；文章数据与 `.prose` 里由文章渲染的表格规则；面板与管理台。

### ④ 面板

**交付**：统计条、目标卡（全部字段可见、**不折叠**）、CSS 纸纹网格、异常列表进 inset list、live 提示、失败横幅。

**落点**：`views.ts` 的 `statusPage`（`data-target`/`data-state`/`data-timeline`/`data-cells` 与全部钩子类名**一个不动**）；`style.css` 的 `.stat*`/`.target-*`/`.cell-strip`/`.cell-caption`/`.kv`/`.chart*`/`.incident-*`/`.live-*`/`.target-error`/`.has-fault`；`style-check` +2；`e2e` +1。

**不做**：折叠目标卡（面板是扫描面）；加图表库或 SVG 网格（`chart-check` 的几何交叉断言不能多变量）；动 `status.js` / `chart-path.js` / `CELL_STRIP_LEN` / `STATE_CLASS`。

### ⑤ 管理台

**交付**：六页表格 → inset grouped 列表；表单与破坏性动作 `<details>` 折叠（失败时服务端 `open`）；确认框保留 `required`；notice 三档；tag 四语义；TipTap 外观。

**落点**：`views.ts` 的六个管理页（概览整卡链接；目标/账号 `.cell-stack` + 折叠；备份/设置 `.inset-list`；文章列表/回收站/修订/上传/预览）；`style.css` 的 `.admin-hint`/`.form-*`/`.confirm`/`.notice*`/`.target-*`/`.revision-*`/`.article-editor`/`.ProseMirror`；`style-check` 管理台结构 8 条；`e2e` +2（`.admin-table` 消失、`details` 存在）。

**不动**：任何 `action` 值 / 字段名 / `hidden` / CSRF / notice key / 校验规则 / 服务端守卫；不引入 `<dialog>`（理由见组件映射 §8.9）。

### ⑥ 收口

**交付**：打印隐藏清单（页头 / rail / tab / 模块条 / 页脚 / picker / 登出 / 按钮 / `.form-actions` / `.confirm` / `.admin-hint` / `.notice` / 管理台表单与折叠内容）、退场类名清零、全站截图、决定书回填。

**落点**：`style.css` print 块；`style-check` 隐藏清单 5 条 + 无 `light-dark()` 1 条；`docs/ios-component-mapping-decision.md` §13/§16 的实测数与证据；`CONTEXT.md` 最终校对。

**不做**：不改结构、不加功能、不动阈值；真机 Safari / 实际打印的观感只**如实登记**为未验证。

---

## 4. 依赖与顺序

| 顺序 | 票 | 硬依赖（阻塞边） | 逻辑依赖 | 为什么 |
| --- | --- | --- | --- | --- |
| 1 | ① #70 | — | — | 链条头；token 名是后续所有批的词汇表 |
| 2 | ② #71 | ① | ① | `layout()` 用 ① 的 token 与 `.header-actions`；picker 已在 ① 就位 |
| 3 | ③ #72 | ② | ② | 用 ② 的 `.cell` / `.chev` / `.chip-row` / 图标 |
| 4 | ④ #73 | ③ | ② | 只用 ② 的基元；接在 ③ 后面是**文件写冲突**，不是语义依赖 |
| 5 | ⑤ #74 | ④ | ② | 同上；`.admin-table` 在 ⑤ 才删 |
| 6 | ⑥ #75 | ⑤ | ③④⑤ | 跨批收口，必须最后 |

**关于「并行」**：③④⑤ 若拆成三张不同的 CSS 文件（例如按页面分文件），可以并行 —— 但那需要先做一次「CSS 拆文件」的重构，**不在本图范围**。当前顺序是「一个会话改一张文件」的最省摩擦路径。

---

## 5. 每批的验收（同一张表，落地时逐条打勾）

| 项 | 每批都要 | 说明 |
| --- | --- | --- |
| `node scripts/style-check.mjs` | 全绿 | 项数见 §2；**只许升不许降**；退役项写进票面 |
| `node scripts/e2e-check.mjs` | 全绿 | 每批只改/加自己那一段；新断言必须**先证明前提**（先断言「有 rail」，再断言「当前项唯一」） |
| `npm run verify` | 全绿 | 含 typecheck / unit / media / article / editor / leak / chart / panel / backup / restart |
| 目视 · 浅色 | 1440 / 390 两个宽度 | 截图留档 |
| 目视 · 深色 | 1440 / 390 两个宽度 | 切换方式：picker 选「深色」；系统深色用 OS 设置或 CDP `emulateMedia` |
| 目视 · 打印 | 每批涉及的面 | 用浏览器打印预览；看三件事：黑白分不分得开、导航/按钮有没有漏、宽表有没有被裁 |
| 票面 | 进度 + 数字 + 未验证项 | 数字是**实测输出**，不是「应该会」 |

**「未验证」的写法**（本图反复踩过的坑）：不能写「规则已加」代替「看过」。没看就写「未验证：<哪一项>，原因：<没有浏览器 / 没真机>」。

---

## 6. 每批合入后的「坏中间态」检查

| 合入后 | 用户看到什么（必须是连贯的） | 不许出现 |
| --- | --- | --- |
| ① | 新配色 + 新字号 + 深浅三态 + 打印图案；**旧的顶栏与页面结构** | 半套 token（旧 `--fg` 残留）；打印有色块但没图案 |
| ② | 新导航外壳（rail / tab bar）+ 旧页面内容（卡片、表格） | 六个页面中有的有 rail、有的没有；两个当前项 |
| ③ | 公开面新样式；面板与管理台还是旧内容样式 | 公开面里还有 `plane-` / `mini-*` |
| ④ | 面板新样式 | 面板钩子类名被改 → `status.js` 失效（30 秒后数字不更新） |
| ⑤ | 管理台新样式 | 某个表单字段名被改 → e2e 的写路径红；`.admin-table` 半留半删 |
| ⑥ | 全站一致 + 打印干净 | 旧类名还在 CSS 里（死规则） |

---

## 7. 文档修订归哪批

| 文档 | 批次 | 改什么 |
| --- | --- | --- |
| `docs/theme-decision.md` | ① | 顶部「已被 #67 取代」横幅（13 色浅色单套 → 17 色三态） |
| `docs/visual-prototype-decision.md` | ① | 顶部「两套平面已被 #68 取代」；指向组件映射决定书 |
| `CONTEXT.md` | ① + ② + ⑥ | ①「主题」= 17 色 + 三态、删「数据面 / 正文面」、加「iOS 字阶」；② 加「导航（rail / tab bar）」、修管理台词条；⑥ 最终校对 |
| `docs/admin-console-sidebar-decision.md` | ② | §1「侧栏只在管理台内部」→ 全站 rail；§5「403 不长侧栏」→ 403 有 rail、无管理组；保留 §2 模块分组与 §10「条目不带计数」 |
| `docs/ios-component-mapping-decision.md` | ⑥ | §13/§16 回填**实测**项数与证据（写本文时是目标值） |
| `docs/ios-implementation-split-decision.md`（本文） | ⑥ | §2 的目标值换成实测值 |
| `AGENTS.md` | 不改 | 只指路，不含视觉决定 |

---

## 8. 编号、挂载与关闭条件

### 8.1 不另开 map

**决定：不另开**。理由：

1. map #64 的 Destination 已经写明「实现已切成可执行的票并落地」；Notes 第 11 条：「实现票在「落地切分」关闭后作为本图子票毕业，执行另起批次」。
2. 另开一张 map 会把**决定与理由**（#65–#68 的四份文档、Notes 里十条已敲定的约束）留在旧图，实现批次每次都要回来翻 —— 上下文断在错误的地方。
3. 本图的后半程本质就是「执行」，而 map 的规则允许在 Notes 里把执行纳入范围（本图已纳）。

代价：本图子票从 5 张变 11 张，`deck_map_snapshot` 的读数会更长；用 `detail=thin` 取清单即可。

### 8.2 编号与排序

- 批次号 ①–⑥ 写进票标题前缀（沿旧票「实现⑧」的风格），票号由 GitHub 分配（当前 70–75）。
- **创建顺序 = 依赖顺序**：70 → 71 → 72 → 73 → 74 → 75。
- 阻塞边是原生依赖边（`71←70` … `75←74`），因此在**任何** tracker UI 里都能直接看出「现在能拿哪一张」。
- 之后若要加批，**追加编号**（⑦…），不插队；插入会让已有阻塞边与回归记录失真。

### 8.3 每批的关闭条件

一张票只有同时满足下面四条才许关：

1. `style-check` / `e2e` / `verify` 全绿（数字写进票面）。
2. 该批的目视项已看并截图（或如实写「未验证」及原因）。
3. 「不做」清单一条没碰（越界了就拆票，不许悄悄做）。
4. 文档修订（§7 归属本批的）已落地。

---

## 9. 命令通道与执行顺序

当前（2026-10-20）**`danger-full-access` 可用**，所以六批都不受命令通道限制。但保留退化顺序，供以后环境变化时用：

| 环境 | 能做什么 | 不能做什么 |
| --- | --- | --- |
| node + 浏览器 | 全部（含截图与打印预览） | — |
| 只有 node（无浏览器） | `style-check` / `e2e`（纯 HTTP）/ `verify` 全绿；**静态结构可证** | 目视三项：窄屏手感、深色观感、打印实际效果 → 票面登记「未验证」 |
| 无 node / 无 shell | 只能写文档与准备补丁 | 不许开工实现批（验证不了）；不许把「写了代码」当「验过了」 |

结论：**六批都依赖 node**；没有 node 就不开工，不存在「纯静态做完再验」的批次。

---

## 10. 全局约束（六批都适用）

1. **每批合入后站点可用**；一批一次会话做完，做不完如实登记「写到哪、什么没跑」，不拖着关票。
2. **不放宽既有断言**：对比度 AA、一个 `:root`、44px 触摸目标、no `backdrop-filter`、`status.js` 契约 —— 一条都不许借回来。
3. **新类名必须同时进 CSS**（`style-check` 的类名覆盖）；**新颜色必须同时进 `PAIRS`**（本图**不应**新增颜色对；确实需要时在票面写清理由与比值）。
4. **不改**：URL / 字段名 / `action` / notice key / CSRF / `hidden` / `readonly` / `required` / 服务端守卫。
5. **不引**：前端框架、构建步骤、图标库运行时、图表库、`<dialog>` 模态。
6. **不写**：组件里的颜色字面量、阴影、`backdrop-filter`。
7. **提交**：`#<票号> iOS 化<批次>：<一句话>`，一次一批，不把别路（如 #47）的在途改动一起提交。
8. **未验证项必须写在票面** —— 「规则已加」不是「看过」。

---

## 11. 本票关闭时的登记

| 项 | 结果 |
| --- | --- |
| 切分 | **6 批**（①–⑥），每批一张票，父子挂 #64，串行原生阻塞边 5 条 |
| 票 | #70 / #71 / #72 / #73 / #74 / #75（创建于 2026-10-20） |
| 基线 | `style-check` **72/72**；`e2e` **524/524**；`style.css` 666 行；`views.ts` 1451 行 |
| 目标 | `style-check` ≈151（①≈134 → ②≈142 → ③≈145 → ④≈147 → ⑤⑥≈151）；`e2e` 524 → ~549 |
| 未决 | 无。实现细节的偏离由执行批次按「改决定文档，不让代码悄悄偏离」处理 |
| 下一步 | 认领 [实现① 基座](https://github.com/Lkyloveaw/lkyloveaw-home/issues/70)（当前唯一前沿） |
