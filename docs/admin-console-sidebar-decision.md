# 管理台侧栏：形状、契约与两条边界的处置

本文件是「管理台侧栏的落地设计」这张票的产出（map：[管理台长出左侧导航，整站配色三选一](https://github.com/Lkyloveaw/lkyloveaw-home/issues/58)）。

票：<https://github.com/Lkyloveaw/lkyloveaw-home/issues/59>

它把 map 目的地第 ① 条（「管理台从**两次点击**变成**一条左侧导航点即达**」）落到**看得见的那一层**：
侧栏挂在 DOM 的哪一层、当前项怎么判定、窄屏怎么折、403 页长不长它、要改哪些旧文档。
**不管**配色取值（[主题三选一](https://github.com/Lkyloveaw/lkyloveaw-home/issues/60)），
也**不切实现批次**（[落地切分](https://github.com/Lkyloveaw/lkyloveaw-home/issues/61)）。

> ⚠ **本票只产决定**（map 目的地：本图只产决定）。本文**不含实现代码**；
> 下面出现的类名、token 名与 HTML 骨架是**契约**，实现由 61 切出的批次票执行。

---

## 0. 五个决定（一句话版）

| 问题 | 结论 |
| --- | --- |
| 当前项怎么判定 | `active` **一个字节不动**（六页仍传 `'admin'`）；**新增** `LayoutOptions.adminSection`：`'overview' \| 'targets' \| 'accounts' \| 'backups' \| 'settings' \| 'articles'` |
| DOM 与类名契约 | **不写 `adminLayout()`**：在 `layout()` 里加**一个分支**；侧栏是 `<nav class="admin-side" aria-label="管理台导航">`，挂在 `<main class="wrap admin-shell">` 里、正文列 `.admin-main` **之前** |
| 栏宽 | 新 token **`--wrap-admin: 1140px`** 与 **`--side-w: 220px`**；`1140 = 20 + 220 + 20 + 860 + 20`，正文列**严格等于今天**（不是「感觉没被压缩」） |
| 窄屏 / 打印 | ≤720px 折成**折行**的横向条目条（组标签各起一行）；打印时 `.admin-side` 整块隐藏、外壳退回单列 |
| 403 页 | **不长侧栏**，`forbiddenPage()` 一行不改（它对只读用户长的 6 个链接，点下去全是 403） |

**两条贯穿全篇的判据**（不是这一票才有的）：

1. **一处真相**：全站已经有一份 token 表、一处平面判定、一处导航渲染。侧栏不新增第二份——它复用 `layout()`、复用 `aria-current` 这个既有判据、复用 `--fg/--bg-soft/--accent` 这几对已断言的配色。
2. **推出来的不手写**：能由既有字段推出来的东西不新增输入；推不出来的（「这一页是哪个模块」）就**显式声明 + 断言**，而不是靠约定。

---

## 1. 高亮判定：加 `adminSection`，不动 `active`

**现状（已核实）**：`LayoutOptions.active` 是五值联合 `'home' | 'posts' | 'status' | 'about' | 'admin'`（`views.ts:63-70`），
六个管理台页面函数**全部**传 `active: 'admin'`（`views.ts:290` / `453` / `546` / `644` / `787` / `1395`）。
`active` 身兼两职：顶栏哪一项高亮（`nav()`，`views.ts:94-108`）与页面属于哪个平面（`planeOf()`，`views.ts:81-83`）。
所以侧栏没法从 `active` 知道「现在在哪个模块」。

**决定**：新增一个**独立**字段，六值闭合枚举：

```ts
type AdminSection = 'overview' | 'targets' | 'accounts' | 'backups' | 'settings' | 'articles'
interface LayoutOptions { /* … */ adminSection?: AdminSection }
```

- 六个页面函数在**它们今天已经在传 `active: 'admin'` 的那一行**补上自己的字面量，`server.ts` **零改动**。
- `planeOf()` **一行不动**：平面仍由 `active` 推出，管理台六页仍是数据面 —— `CONTEXT.md` 的
  「平面由 `layout()` 按导航项推出来」（`CONTEXT.md:123`）这句继续是真话。
- 高亮用 **`aria-current="page"`**，与顶栏同一判据（`.site-nav a[aria-current="page"]`，`style.css:150`）：
  不引入第二套「哪一项是当前项」的表示法。

### 1.1 为什么不是「把 `active` 拆成六个值」

不拆的理由是它让**一个字段有两种读法**：

- 顶栏只有**一项**「管理」，六页都属于它 —— 拆开之后 `nav()` 必须写一张反查表把六个值映回 `'admin'`，
  于是「顶栏怎么亮」多了第二处定义；漏一处就是「进了子页顶栏不亮了」。
- `planeOf()` 要跟着接纳六个新值，而 `scripts/style-check.mjs:249` 断言的正是那条表达式的原文
  （`active === 'status' || active === 'admin' ? 'data' : 'prose'`）。为了省一个字段去动两条既有契约，不划算。
- 顶栏的「管理」在子页上必须**继续**带 `aria-current="page"`（`e2e-check.mjs:1019` 断言这一条）——
  拆开之后这个行为要额外维持。

### 1.2 为什么不是「由请求 URL 推导」（走 ALS）

那条路能保证**忘不了**（页面没得传），代价是视图层多一个隐藏输入：`csrf.ts` 的 ALS 今天带的是
**用户与角色**（`currentIsAdmin()`），把「当前路径」也塞进去，等于让视图函数依赖路由。
而且侧栏属于哪个模块是**页面函数自己的属性**——它已经知道，只是没说出来。

**选显式 + 断言**：忘了传的后果是「这一页没有侧栏」——肉眼可见、且 §8 有一条按六个路由逐个断言
「侧栏里恰好一项 `aria-current`，且它的 `href` 就是当前路径」把它钉死。**不靠约定，靠断言。**

---

## 2. DOM 与类名契约

侧栏挂在 `layout()` 里、**正文之前**，页头页脚不动：

```html
<header class="site-header">…（一个字节不改）…</header>
<main class="wrap admin-shell">                          <!-- ← 只有管理台带 admin-shell -->
  <nav class="admin-side" aria-label="管理台导航">
    <div class="admin-side-group">
      <span class="admin-side-group-label">运维</span>
      <a href="/admin" aria-current="page">概览</a>
      <a href="/admin/targets">目标</a>
      <a href="/admin/accounts">账号</a>
      <a href="/admin/backups">备份</a>
      <a href="/admin/settings">设置</a>
    </div>
    <div class="admin-side-group">
      <span class="admin-side-group-label">内容</span>
      <a href="/admin/articles">文章</a>
    </div>
  </nav>
  <div class="admin-main">…今天那个 body 原样塞进来…</div>
</main>
<footer class="site-footer">…（一个字节不改）…</footer>
```

**类名契约**（六个新类名，落地时**必须**同步进 `public/style.css`：`style-check.mjs:206-229` 会断言
「`views.ts` 里渲染的类名都有 CSS 定义」，漏一个就红）：

| class | 角色 |
| --- | --- |
| `.admin-shell` | 两列网格 + 管理台宽栏；**只在** `adminSection` 存在时挂到 `<main>` 上 |
| `.admin-side` | 侧栏本身（一个 `<nav>`，不是一列 `<div>`） |
| `.admin-side-group` | 一组（运维 / 内容） |
| `.admin-side-group-label` | 组标签（「运维」「内容」） |
| `.admin-main` | 正文列 |
| `.admin-side a[aria-current="page"]` | 当前项高亮 |

**几个不能再解释一遍的选择**：

- **在 `layout()` 里分支，不写 `adminLayout()`**。后者要复制页头、页脚、`nav()`、登出表单 ——
  那就是**第二套页面外壳**，此后的每一次 chrome 改动都要改两处（本仓反复否掉的东西）。分支只由
  `adminSection` 触发，**非管理台页面渲染结果与今天逐字节相同**（首页/分享/文章/关于/面板/登录都不受影响）。
- **`<nav>` 而不是 `<aside>`**（原票面的草图写的是 `<aside class="admin-side">`，此处修订）：这是管理台的
  **主导航**，`<nav>` 才是导航地标，`<aside>` 是「补充内容」。`aria-label` **必须带** —— 页头已经有一个
  `<nav class="site-nav">`（`views.ts:127`，今天没有标签），一个文档里两个导航地标得能分辨。
- **`<main>` 不新增、也不嵌套**：`admin-shell` 加在既有的 `<main class="wrap">` 上，侧栏与正文列是它的
  两个子元素。不是「在页面里再套一个 main」，也不是把侧栏放到 `<main>` 外面（那样它就不在内容流里了）。
- **条目不带计数、不带徽标**（map Notes 第 10 条）：侧栏只渲染「标签 + href + 当前项标记」。
  计数会造出第二份真相，而概览页已经有那一份。

### 2.1 高亮用哪几个 token（结构定死，取值归主题）

| 状态 | 文字 | 底 | 左边框 |
| --- | --- | --- | --- |
| 当前项 | `--fg` | `--bg-soft` | `--accent` |
| 其他项 | `--fg-dim` | 透明（`--bg`） | 无 |

这三对（`fg/bg-soft`、`fg-dim/bg`、`accent/bg-soft`）**都已经在** `style-check.mjs:121-142` 的 `PAIRS` 里，
所以**不需要往 PAIRS 加新对**。落地若要引入任何**新的**前景/背景组合，必须把那一对同时加进 `PAIRS` ——
这是本仓的颜色纪律（对比度是**算出来的**，不许估：`style.css:9-10`）。

---

## 3. 栏宽：1140px，让「正文不被压缩」在算术上为真

map Notes 第 12 条定的是「栏宽约 1120px（侧栏占 220–240px，正文不被压缩）」。把实数代进去：

```
今天：.wrap = 900px 含左右各 20px 内边距（* { box-sizing: border-box }，style.css:67）→ 正文列 = 860px
1120：1120 − 20 − 220 − 20 − 20 = 840px   ← 正文反而比今天窄 20px
1140：1140 − 20 − 220 − 20 − 20 = 860px   ← 正文与今天严格等宽
```

**决定：`--wrap-admin: 1140px`**，并在此登记这处**对 map 数字的微调（+20px）**：
「约 1120」的余量给了这 20px，换来的是「正文不被压缩」这条硬约束**不是感觉**，而是能算出来的等式。
侧栏宽取 `--side-w: 220px`（map 给的 220–240 区间的下沿：正文列保住），栏距 20px。

- 两个都是**非颜色** token，落在 `:root`（`style.css:13-43`）。⚠ **落地时必须把 `wrap-admin` 与 `side-w`
  同时加进 `scripts/style-check.mjs:92-95` 的 `NON_COLOR` 集合** —— 不加的话，脚本会把它们当成颜色 token
  去要求 light 覆盖（`style-check.mjs:96-102`），`check:style` 直接红。
- 列定义写成 `grid-template-columns: var(--side-w) minmax(0, 1fr)`。**`minmax(0, 1fr)` 不是可选写法**：
  `.admin-table` 是 `width: 100%` 的宽表（`style.css:467`），写成 `1fr`（= `minmax(auto, 1fr)`）时，
  列的 min-content 会把网格撑出容器，整页长出横向滚动条 —— 而 `#45` 的窄屏断言只管 ≤720px 的表格横滚
  （`style-check.mjs:263`），管不了这个。
- **只有管理台宽**：`.admin-shell` 只由 `adminSection` 触发；`--wrap: 900px` 与首页 / 分享 / 文章 / 关于
  的窄栏一个字节不动（map Notes 第 3 条）。

---

## 4. 窄屏与打印

- **断点复用 720px**（`style.css:560`），**不新增第三个断点** —— `style.css:557-559` 已经写着这条纪律。
- **≤720px：折行，组标签各起一行**。`.admin-shell` 退成单列，`.admin-side` 从竖排变横排
  （`display: flex; flex-wrap: wrap`），`.admin-side-group` 各占满一行（`flex-basis: 100%`），
  组标签独占自己那一行 → 「运维」一行 5 项、「内容」一行 1 项，更窄就继续折行。
  **分组这条 IA 决定在窄屏也活着**（地图 Notes 第 9 条不是宽屏限定）。
- **不横向滚动**（`overflow-x: auto` 那条路否掉）：它会把右侧条目推出屏幕，等于把「点即达」在窄屏
  悄悄收回一半；折行让每一项始终可见。`.site-nav` 今天也是 `flex-wrap`（`style.css:145`），同一手法。
- **焦点顺序 = DOM 顺序 = 视觉顺序**：运维组 → 内容组 → 正文。两种宽度下都不用 `order`、不用绝对定位，
  所以**不产生焦点陷阱**，也不会出现「Tab 顺序和眼睛看到的不一样」。
- **打印**：把 `.admin-side` 加进打印块的隐藏清单（`style.css:601-602`，与 `.site-nav` 同一行），
  并把 `.admin-shell` 在打印块里退回 `display: block; max-width: none`。打印出来的管理台**只有正文列**，
  与今天打印管理台的样子一致。

---

## 5. 403 页：不长侧栏

`forbiddenPage()`（`views.ts:155-181`）**一行不改**，`forbiddenPage('admin')` 不传 `adminSection`
→ 403 页没有侧栏。理由是**读者是谁**：

- 能读到这条 403 的只有只读用户（`server.ts:497-501`）。侧栏那 6 项对他**每一项都是 403** ——
  画出来就是 6 个「点了就吃一次错」的入口，而「入口不渲染成点了会错的东西」正是管理台入口那条既有决定
  （`docs/admin-console-ia-decision.md` §2：只读用户顶栏不渲染「管理」项）的同一判据。
- 这页唯一的工作是**说明 + 回首页**（§3.1：403 要说清自己是谁）。
- `forbiddenPage()` 被三种来源共用（`origin` / `csrf` / `admin`），为一个读者加分支买不到什么。

**顺带登记一处已知的观感不一致（本票不改）**：403 页不传 `active`，`planeOf(undefined)` → `prose`，
所以只读用户看到的 403 用的是**正文面**排版。今天就是这样；改它要给 `kind === 'admin'` 加分支
并动既有断言，收益是纯观感，故记在 §10 而不是顺手改掉。

**也不给 403 页「只读版侧栏」**：只读视图在 `docs/roles-decision.md` §1 已被否掉，本票不重开。

---

## 6. 显式修订：为什么现在可以加侧栏，而当时不能

`docs/admin-console-ia-decision.md` 是 #23 的产出，它否掉过两个相邻的形状。本票**就地修订**它（见 §7 落点）：

| 旧文档 | 原文 | 本票 |
| --- | --- | --- |
| §1.1 表格 | 只比较了「一个长页面分区块」与「标签页」，第二个否掉的理由包含「`--wrap` 是 900px，没有侧栏空间」 | **补一行「左侧导航」**：当时否掉的正是这个形状，理由是栏宽；**现在采纳**（栏宽算术见 §3，方法见本文件） |
| §2 | 「子页之间靠**页面内的返回链接**导航，不引入第二层顶栏」 | **修订**：六个模块走左侧导航；页头不动，**仍不引入第二层顶栏**（侧栏不是顶栏 —— 它不新增横向 chrome，只把一栏垂直导航放进同一个 `<main>`） |
| §0 表 / §6 开头 | 「四个子页」/「每页 `active: 'admin'`」 | 加一条**指向本文件的修订说明**；`active` 那句仍然成立，`adminSection` 是**新增**字段 |

**「为什么当时不能」的三条，逐条回答**（不是「当时的判断错了」）：

1. **当时否的是「第二层顶栏」**：另一条横在内容上面的导航条，会与页头争同一块视觉层级。侧栏不是那个形状。
2. **当时「900px 没有侧栏空间」是真话**：今天管理台有了**自己的**栏宽（1140px），侧栏占的那 240px
   **不来自正文**（§3 的等式）。
3. **当时「分页 + 概览 + 页面内返回链接」够用**，因为管理台只有 5 个短页面。现在是 **6 个页面**、
   含文章编辑这种长页面，而**六个模块之间今天仍然没有一处互跳**（`views.ts` 里对 `/admin` 的链接只有
   文章页自己那几处 `?edit=` 自链接）—— 互跳必须先回概览再点卡片。**判断的输入变了**（页数与栏宽），
   所以结论跟着变。

---

## 7. 实现落点（交给 61 切分，本票不动手）

> ✅ **已交付**：[#62](https://github.com/Lkyloveaw/lkyloveaw-home/issues/62)（提交 `8980b06`）+ #63（收口，本票）。
> **未发现与本文不符之处** —— 契约照原样落到了地上。两处**文案/文档**落点（`CONTEXT.md` 管理台词条、
> 概览页自述）在 #63 里清掉了。下表保持原样，作为当时的清单留档。

| 文件 | 改动 |
| --- | --- |
| `src/views.ts` | `LayoutOptions` 加 `adminSection?: AdminSection`；`layout()` 加**那一个分支**；新增侧栏片段（组表：运维 = overview/targets/accounts/backups/settings，内容 = articles）；六个页面函数各自的 `layout()` 调用补上自己的 `adminSection`（290 / 453 / 546 / 644 / 787 / 1395 六行）。`nav()` / `planeOf()` / `forbiddenPage()` **不动** |
| `public/style.css` | `:root` 加 `--wrap-admin: 1140px` 与 `--side-w: 220px`（非颜色）；新增六个类名与高亮规则；720px 断点加折行规则；打印块加 `.admin-side` 隐藏与 `.admin-shell` 退单列 |
| `scripts/style-check.mjs` | `NON_COLOR` 加 `wrap-admin`、`side-w`（**不加就红**）；新增断言：`layout()` 的分支存在、`.admin-side` 有 CSS 定义、720px 断点里 `.admin-side` 折行规则存在 |
| `scripts/e2e-check.mjs` | 新增断言（§8）；改概览页自述文案时必须同步改 `e2e-check.mjs:1024-1028` |
| `CONTEXT.md` | **管理台** 词条今天写「`/admin` 及其下的**四个**子页（目标 / 账号 / 备份 / 站点设置）」（`CONTEXT.md:113`）—— #50 加了文章页之后这句**已经是假的**；落地时改成六个模块 + 侧栏这条导航 |
| `src/views.ts`（文案） | 概览页自述写着「四页**都能写**：目标 / 站点设置 / 备份 / 账号」（`views.ts:281-282`）—— 文章页也能写。侧栏把文章摆到明面上之后，这句更显眼是假的 |
| `docs/admin-console-ia-decision.md` | **本票已就地改完**（§6），落地时不需要再改；若实现时发现与本文不符，回来改这份**决定**文档，而不是让它悄悄偏离 |

---

## 8. 验收：落地时的断言（HTTP 层，落 `scripts/e2e-check.mjs` 与 `scripts/style-check.mjs`）

| # | 前置 | 操作 | 预期 |
| --- | --- | --- | --- |
| 1 | 管理员已登录 | 逐个 `GET` 六个管理台路由（`/admin`、`/admin/targets`、`/admin/accounts`、`/admin/backups`、`/admin/settings`、`/admin/articles`） | 每个响应里都有 `.admin-side`，且**恰好一项**带 `aria-current="page"`，它的 `href` **等于当前路径** |
| 2 | 管理员已登录 | 同上 | 六个模块名全在侧栏里（概览 / 目标 / 账号 / 备份 / 设置 / 文章），两个组标签都在 |
| 3 | 只读已登录 | `GET /admin/targets` | `403`，且响应里**没有** `.admin-side`（回归 §5） |
| 4 | 已登录 | `GET /`、`GET /status`、`GET /posts` | 响应里**没有** `.admin-side`（侧栏只在管理台内部：map Notes 第 3 条） |
| 5 | 管理员已登录 | `GET /admin` | 顶栏「管理」**仍**带 `aria-current="page"`（§1.1：这条不动） |
| 6 | 管理员已登录 | `GET /admin/articles?edit=<某篇>` | 侧栏仍渲染，且高亮**文章**（不是「概览」）—— 文章页的编辑态同属这一个模块 |
| 7 | — | `npm run check:style` | 全绿：新 token 进了 `NON_COLOR`，六个类名都有 CSS 定义，`:root` 仍**恰好一个**（#60 之后就是「一个」；本文起草时写的「两个」已按事实改） |
| 8 | — | `npm run check:e2e` | 全绿（含上面 1–6 条） |

**断言质量要求**（沿用既有原则）：第 1 条必须**逐路由**比 `href` 与当前路径，不能只断言「页面里有
`aria-current`」—— 后者在「六个模块全都标成当前项」这种坏实现下恒真。
第 3 / 4 条必须先证明前提成立（同一响应是 403 / 是那个页面），否则「没有侧栏」在空响应上恒真。

✅ **目视已验（#62）**：≤720px 折行后的可用性，用 CDP `Emulation.setDeviceMetricsOverride` 精确设视口
（`--window-size` 在 Windows 上会被夹到约 500px，那样拍出的「390px 溢出」是**裁切**、不是溢出）：
360 / 390 / 500 / 700 / 721 / 1100 六个宽度 × 两页 `scrollWidth == innerWidth` **全部成立**；
断点正好在 720/721 翻；**390px 观感：不挤**（组标签各占一行、字号小且淡，代价约 40px 垂直 —— 这是 §4 定的形状）。
截图：`.theme-preview-shots/cdp-targets-390.png`（未跟踪，随时可删）。

### 8.1 落地回填（2026-10-19 · #62 + #63）

| # | 落在哪 |
| --- | --- |
| 1 | `scripts/e2e-check.mjs` 管理台外壳段：六个路由各两条（有侧栏 + 当前项**恰好一个且 `href` 等于路径**） |
| 2 | 同段：六个模块名 + 两个组标签；`!/\d/` 断言「侧栏里一个数字都没有」（= 不带计数） |
| 3 | 同段：只读 `GET /admin/targets` → 403 且无 `.admin-side` |
| 4 | 同段：`/`、`/status`、`/about`、`/posts` 都无 `.admin-side`（比本文多覆盖 `/about`） |
| 5 | 同段：顶栏「管理」仍带 `aria-current="page"` |
| 6 | 同段：文章编辑态（`?edit=uptime-metrics`）高亮「文章」 |
| 7 | `scripts/style-check.mjs` 新段「管理台侧栏：契约落在地上了吗」9 条（分支 / 地标名 / 六个值 / **只在当前项**贴 `aria-current` / 720 折行两条 / 打印两条 / `minmax(0,1fr)`）→ 63 项 |
| 8 | `npm run verify` **10 段全绿（678 项）** + `npm run check:e2e` **522/522** |

---

## 9. 边界（本票不定）

- **配色取值**：本票只定结构（当前项 `--fg` on `--bg-soft` + `--accent` 左边框，其他项 `--fg-dim`）。
  换主题只换**值**，侧栏的 CSS 规则不重写 —— 取值归 [主题三选一](https://github.com/Lkyloveaw/lkyloveaw-home/issues/60)。
- **侧栏条目不带计数 / 徽标**：map Notes 第 10 条已定，这里只重申它是**硬约束**（不是「第一版先不做」）。
- **切分**：本票不切实现批次，归 [落地切分](https://github.com/Lkyloveaw/lkyloveaw-home/issues/61)。
- **粘性侧栏**：**不做**。唯一的长页面是文章编辑页，它自己有滚动区；再加一层 `position: sticky`
  要引入一个 sticky 上下文与打印豁免，收益不明。落地后若长页面真的需要，那是新的一票，不是本票漏掉的。
- **管理台的审计**（谁在什么时候改了什么）：仍不在本图。

## 10. 刻意不动（记录了才不是漏）

- **顶栏 `nav()` 与 `.site-nav` 的 HTML**：一个字节不改（`e2e-check.mjs:1019`、`2294-2305` 依赖它的形状）。
- **`planeOf()` 与平面判定**：不改，`style-check.mjs:249` 断言的那条表达式原样存在。
- **`forbiddenPage()`**：不改（§5）。
- **顶栏「管理」项在子页上的 `aria-current="page"` 语义**：不改。更字面的做法是在子页上写
  `aria-current="true"`，但那要同时改 CSS 规则与既有断言，用户看不到差别，收益为零。
  于是管理台页面上会有**两个** current 标记（顶栏「管理」= 你在管理台里，侧栏某一项 = 你在哪个模块），
  这是**有意**的：它们回答的是不同粒度的问题。
- **登录页不共用站内导航**：既有决定不动（它本来也不该有管理台侧栏）。
