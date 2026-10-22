# Claude 支持中心式外壳：现状契约、参考站视觉事实与映射草案（研究笔记）

> **这是研究票 [#83](https://github.com/Lkyloveaw/lkyloveaw-home/issues/83) 的产出，不是决定书。**
> 它只回答两件事：① 今天的公开面外壳**实际长什么样**（含每一条钉住它的断言）；② `support.claude.com` **实际是什么数值**。
> 第三部分是我给的**映射草案**，供下游「落地设计」票取用或推翻。
>
> **不写产品代码**、不改 `src/` / `public/` / `scripts/`、不提交 git。本文是 `docs/research/` 里唯一新增的文件。

- 票：[#83 研究：公开面外壳现状契约与 Claude 支持中心视觉事实](https://github.com/Lkyloveaw/lkyloveaw-home/issues/83)（父图 [#82 公开面换装](https://github.com/Lkyloveaw/lkyloveaw-home/issues/82)）
- 下游：本文阻塞 [#84 三版公开面外壳原型](https://github.com/Lkyloveaw/lkyloveaw-home/issues/84)；其后是 #85/#86/#87（token、外壳、用户菜单），最后 #88 切分。
- 基线：`master` @ `e5434eb`（2026-10-21）。工作树**不干净**：有 14 项与本票无关的既有未跟踪产物（`.ios-*-shots/`、`.theme-preview-shots/`、`prototype/`、`docs/ios-*-decision.md` 等），本文只新增了 `docs/research/claude-support-shell.md` 一个文件。
- 标记约定：**【事实】** = 可在代码 / 抓取到的 CSS 里逐字核对；**【取舍】** = 本仓怎么选、为什么；**【不确定】** = 没实测，别当结论。
- **本文的 171 / 536 是跑出来的，不是抄票面的**：本会话执行了 `node scripts/style-check.mjs`（**171/171 通过**）与 `node scripts/e2e-check.mjs`（**536/536 通过**），与 #82 记录的基线一致。

---

## 0. 一句话速览

| # | 问题 | 结论 | 性质 |
| --- | --- | --- | --- |
| 1 | 「12 条路由」 | **实测是 13 条 HTML GET 路由**：12 条走 `layout()`，`/login` 是唯一独立外壳。另有 3 条非 HTML 路由（`/media/:name`、`/api/status`、`/healthz`）不套外壳。票面的「12」少算了一条 | 事实（**与票面差 1**） |
| 2 | 403/404 | 都走 `layout()`，都带 `bodyClass: 'page-error'`，都**不传** `active`/`adminSection` → 没有任何当前项 | 事实 |
| 3 | 参考站「主色 #CC785C」 | **不是主色，而且从未被渲染**。它只是 Intercom 主题里的 `--header-subheader-background-color`（副头带），三个页面类型的顶栏都没有 `data-subheader="true"`。参考站真正的 accent 是 `hsl(60,3%,8%)` ≈ `#151514`（近黑） | 事实（**与票面冲突**） |
| 4 | 陶土色能不能当 accent | **`#CC785C` 直接当 `--accent` 过不了本仓的对比度预算**：文字 3.11:1 / 非文字在 `--bg-elev`、`--fill` 上只有 2.84 / 2.87（<3:1）。要么加深（`#9C4B35`），要么改断言语义（把 accent 移出文字对） | 事实（算出来的） |
| 5 | 字体 | AnthropicSerif **只做标题**（16–48px），AnthropicSans 做正文与 UI（13–17px），JetBrains Mono 做 code/kbd。两个 Anthropic 字体是**自托管私有字体，不能下载 / 自托管 / 热链**；衬线只能用系统栈近似 | 事实 + 取舍 |
| 6 | 参考站深色模式 | **没有**（6 个 CSS 文件里 0 处 `prefers-color-scheme`）。深色等价映射没有参考可抄，只能自造 | 事实 |
| 7 | 顶栏尺寸 | 高 **60px**，`position: fixed` + 60px 占位块；左右内边距 16px；标签 14px；搜索键 30px 高；品牌图形 32px（≤819 变 40px） | 事实 |
| 8 | 左侧栏 | 轨道 **260px**；固定版宽 `calc(260px + 16px)` = **276px**；右侧 1px `ink 12%` 细线；条目 14px、内边距 8px、圆角 12px；分组标题 14px/600；当前项 = accent 文字 + **2px 竖条**；滚动区独立，细滚动条 | 事实 |
| 9 | 正文栏 | `max-width: 830px` 居中；标题 36px 衬线/600；正文 15px / 1.55；`h3` 17px **无衬线**；表格 14px；圆角 12px | 事实 |
| 10 | 断点 | **819px**（侧栏消失、顶栏标签藏进抽屉、标题 32px）与 **1099px**（右侧目录消失、三列变两列）。本仓现行纪律是 **720 / 560**，两者对不上 | 事实（**与制度冲突**） |
| 11 | `style-check` 迁移量 | 171 条里 **157 条可原样复用**、**13 条必须改**（多数只改选择器或值）、**1 条可删**（tab bar 同源）。若新增颜色 token 或想沿用被禁的类名，必须改会升到 15；若走「品牌忠实」的 accent 路线，对比度那 62 条里还有 8 对要改归属 | 取舍（逐条见 §2.1） |
| 12 | `e2e` 迁移量 | 536 条里与外壳直接相关的 **51 条**：**37 条复用**、**12 条必须改**、**2 条可删**（都是 tab bar） | 取舍（逐条见 §2.2） |

---

## 1. 现状契约（逐字节可核对）

### 1.1 `layout()` 输出什么

`layout()`（`src/views.ts:195-232`）是**唯一**的站内外壳。逐节点：

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>                                   ← views.ts:201-211
  <meta charset> <meta viewport>
  <meta name="color-scheme" content="light dark">
  <title>{title} · {site.title}</title>
  <meta name="description">
  ${themeBoot()}                         ← views.ts:100-102（必须在 stylesheet 之前）
  <link rel="stylesheet" href="/style.css">
  <link rel="icon" href="data:image/svg+xml,...">   ← 内联 emoji 📓
  <noscript><style>[data-theme-select] { display: none }</style></noscript>
</head>
<body class="{bodyClass}">               ← 只有 403/404 传 `page-error`，其余为空串
<header class="site-header">              ← views.ts:213-218
  <div class="header-inner">
    <a class="brand" href="/">{site.title}</a>
    <div class="header-actions">
      {themePicker}                       ← <label class="theme-picker"><select data-theme-select>
      <form class="logout-form" method="post" action="/logout">{csrf}<button>登出</button></form>
    </div>
  </div>
</header>
<div class="app-shell [app-shell--admin]">   ← views.ts:219-222；`--admin` 仅 adminSection 存在时
  <nav class="site-rail" aria-label="站内导航">{rail()}</nav>
  <main class="wrap app-main">{adminTabs?}{body}</main>
</div>
<nav class="tab-bar" aria-label="站内导航（手机）">{tabBar()}</nav>   ← views.ts:223
<footer class="site-footer"><div class="wrap">{site.description}</div></footer>
${themeScript()}                          ← views.ts:105-107
</body></html>
```

要点（都是断言或后续设计的硬约束）：

- **页头只有一个动作区** `header-actions`：主题 picker + 登出表单。**没有站内导航项、也没有「当前用户是谁」的身份显示**。顶栏今天不显示用户名——`views.ts` 里没有任何地方渲染它。
- `<main>` 上挂了 `wrap`（`max-width: var(--wrap)` = 900px，`padding: 0 20px`），**侧栏在 `wrap` 之外**、是 `.app-shell` 网格的第一列。这一点与参考站结构同构（`grid > aside + main`），是好消息（见 §4.6）。
- 主题脚本与 picker 的设计是 #67 定的：`[data-theme-select]` **恰好 2 处**（`layout()` + `loginPage()`）。若把 picker 收进用户下拉，仍然只要 `themePicker()` 在 `layout()` 里调用一次，这个「2 处」契约不变。
- 页脚在 `body:not(.login-body)` 下是 flex 贴底布局的一部分（`public/style.css:92-99`）。

### 1.2 三张数据表（唯一数据源）

| 东西 | 位置 | 形状 | 谁在用 |
| --- | --- | --- | --- |
| `NAV_ITEMS` | `views.ts:124-129` | 4 项：首页 `/`、分享 `/posts`、系统可用性 `/status`、关于 `/about`，每项 `{key, href, label, icon}` | 桌面 rail 的「站点」组 + 手机 tab bar |
| `ADMIN_ITEM` | `views.ts:130` | `{key:'admin', href:'/admin', label:'管理', icon:'sliders'}` | **只**给 tab bar 用（rail 里管理组走 `ADMIN_GROUPS`） |
| `ADMIN_GROUPS` | `views.ts:137-149` | `[组名, [[section, href, label]...]]`；运维 5 项（概览/目标/账号/备份/设置）+ 内容 1 项（文章） | rail 的管理组 + 手机 `.admin-tabs` |

判定当前项的条件只有一个：**`aria-current="page"`**，由 `key === active`（站点）与 `key === section`（模块）产生（`views.ts:153-155` / `178-180` / `190`）。全站每页恰好一个（403/404 是零个）。

`LayoutOptions`（`views.ts:72-85`）今天只有：`title` / `description` / `active?` / `adminSection?` / `body` / `bodyClass?`。**没有承载「文章侧栏数据」的字段** —— 这是本图最大的接口改动（见 §5.3）。

### 1.3 13 条 HTML 路由：谁走 `layout()`、谁独立

【事实】**HTML GET 路由共 13 条**（`src/server.ts` 注册 + `setNotFoundHandler`）：**12 条走 `layout()`，1 条（`/login`）是独立外壳**。

> ⚠ **与票面的差异**：票面写「12 条路由」。逐条数注册点，HTML 页面是 **13 条**。若把 `/tags/:tag` 并进 `/posts`、或把 `/admin` 与 5 个模块合成一句，就会得到 12——但它们是**独立的 GET 注册点与独立视图调用**，换装时要逐个改（`/tags/:tag` 也长着侧栏与当前项）。**按 13 条做，别按 12 条做。**

| # | 路由 | 视图函数 | 外壳 | 行号 | `active` | `adminSection` | 未登录时 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | `GET /` | `homePage` | `layout()` | server.ts:1376 / views.ts:960 | `home` | — | 302 → `/login?next=/` |
| 2 | `GET /posts` | `postsPage` | `layout()` | 1381 / 1054 | `posts` | — | 302 |
| 3 | `GET /tags/:tag` | `postsPage(heading=标签：x)` | `layout()` | 1386 / 1054 | `posts` | — | 302 |
| 4 | `GET /posts/:slug` | `postPage`（未命中 → 404 页） | `layout()` | 1393 / 1076 | `posts` | — | 302 |
| 5 | `GET /status` | `statusPage` | `layout()` | 1405 / 1165 | `status` | — | 302 |
| 6 | `GET /about` | `aboutPage` | `layout()` | 1417 / 1093 | `about` | — | 302 |
| 7 | **`GET /login`** | `loginPage` | **独立外壳** | 1302 / 905 | — | — | 200（白名单） |
| 8 | `GET /admin` | `adminOverviewPage` | `layout()` | 497 / 349 | `admin` | `overview` | 302 |
| 9 | `GET /admin/targets` | `adminTargetsPage` | `layout()` | 937 / 425 | `admin` | `targets` | 302 |
| 10 | `GET /admin/accounts` | `adminAccountsPage` | `layout()` | 1203 / 779 | `admin` | `accounts` | 302 |
| 11 | `GET /admin/backups` | `adminBackupsPage` | `layout()` | 1121 / 688 | `admin` | `backups` | 302 |
| 12 | `GET /admin/settings` | `adminSettingsPage` | `layout()` | 1040 / 593 | `admin` | `settings` | 302 |
| 13 | `GET /admin/articles` | `adminArticlesPage` | `layout()` | 666 / 1346 | `admin` | `articles` | 302 |

> 计数方式：公开 6（含两条动态段）+ 登录 1 + 管理台 6（`/admin` 与 5 个模块）= **13**。**唯一独立外壳是 `/login`**，这点票面正确；「12 条」那一处是少算。

**不属于这 13 条的**（不套外壳，容易被漏算）：

| 路由 | 形态 | 行号 | 外壳 |
| --- | --- | --- | --- |
| `GET /media/:name` | 二进制图片（登录后可见，长缓存） | server.ts:826 | 无 |
| `GET /api/status` | JSON（未登录 401，不是 302） | 1413 | 无 |
| `GET /healthz` | JSON，匿名 200 | 1423 | 无 |
| 未知路径 | `notFoundPage()` → `layout()` + `page-error` | 1425-1428 / views.ts:1274 | `layout()` |

### 1.4 403 / 404 / 登录 / 管理台：四个差异

| 面 | 外壳 | 导航 | 当前项 | 主题 picker | 备注 |
| --- | --- | --- | --- | --- | --- |
| 公开页（1-6） | `layout()` | rail 站点组 4 项（管理员再多管理组 6 项）+ 手机 tab bar 4/5 项 | 有，恰好 1 | 页头 | 顶栏只有品牌 + picker + 登出 |
| 管理台（8-13） | `layout()` + `app-shell--admin` | rail 站点组 + 管理组；`<main>` 顶部多一条 `.admin-tabs` | rail 里 1 个（模块）+ tab bar 里 1 个（管理） | 页头 | `<main>` 限宽 1140；`.admin-tabs` 只在 ≤720 显示 |
| 403 | `layout()` + `page-error` | rail 照常（只读用户只有站点组；管理员会看到管理组） | **零个**（不传 `active`） | 页头 | 三个 kind 共用：`origin` / `csrf` / `admin`（views.ts:248-274） |
| 404 | `layout()` + `page-error` | 同上 | **零个** | 页头 | "这个页面不存在" + 回首页 |
| 登录 | **`loginPage()`** | **没有** rail / tab bar / 页脚 | 无 | 右上 `.login-theme`（fixed） | 唯一不走 `layout()` 的页面；`body.login-body` 不走贴底 flex |

- 403 的判定在路由里：`if (!currentIsAdmin()) reply.code(403)`（server.ts:498-501），**不是 404**。
- 已登录访问 `/login` 仍是 200（e2e 断言：`e2e-check.mjs:231`）。
- 未登录访问受保护页是 **302 到 `/login?next=...`**，不是 403（`src/auth.ts` 的 `PUBLIC_PATHS` 精确白名单）。

### 1.5 类名与选择器：谁钉着它们

| 类 / 属性 | 定义处 | 被谁钉住 |
| --- | --- | --- |
| `.site-header` / `.header-inner` / `.brand` / `.header-actions` | style.css:133-147 / 701 | style-check:338；e2e:1135 |
| `.theme-picker` / `[data-theme-select]` / `.login-theme` | style.css:702-713 | style-check:300-301；e2e:2415-2418 |
| `.logout-form` | style.css:577-587 | style-check:387（打印隐藏） |
| `.app-shell` / `.app-shell--admin` / `.app-main` | style.css:151-157 | style-check:330/339/343；e2e:2381 |
| `.site-rail` / `.rail-group` / `.rail-group-label` / `.rail-sub-label` / `.rail-link` / `.rail-link--sub` | style.css:165-188 | style-check:331/333/334/341/343；e2e:79-82 的 `railOf()/currentOf()` 全部依赖它 |
| `.tab-bar` / `.tab-item` | style.css:191-205 | style-check:336/341/343；e2e:83-84 的 `tabOf()/tabItems()` |
| `.admin-tabs` / `.admin-tabs-group` / `.admin-tabs-label` | style.css:208 / 733-737 | style-check:337/342；e2e:1125-1129 |
| `.inset-list` / `.cell` / `.cell-main` / `.cell-title` / `.cell-sub` / `.cell-meta` / `.cell-detail` / `.create-card` | style.css:214-253 | style-check:236（**所有渲染类名必须有 CSS 定义**）、350-357、365-366 |
| `.post-card` / `.post-list` / `.post` / `.post-header` / `.prose` / `.tags` / `.tag*` / `.chip-row` | style.css:272-387 | style-check:350-357；e2e:2394-2395 |
| `.large-title` / `.hero` / `.lede` / `.section` / `.section-head` / `.more` / `.empty` / `.back` | style.css:284-304 | style-check:355 |
| 面板契约类名（`.dot` `.badge` `.cell-strip` `.kv` `.uptime` `[data-target]` `data-cells` …） | style.css / views.ts | style-check:243-246/400-405；`public/status.js` **一行都不能改** |

### 1.6 文章读出口

| 出口 | 位置 | 结构 | 受什么约束 |
| --- | --- | --- | --- |
| 列表卡 `postCard()` | views.ts:945-958 | `<article class="cell post-card">` → `.cell-main` > `h2.cell-title > a` + `p.meta > time` + `p.summary` + `p.tags > a.tag`；行尾 `.chev`（`aria-hidden`） | 整行可点靠 `.cell-title a::after { inset:0 }`（style.css:366）；标签 `z-index:1`（:368） |
| 首页「最近分享」 | views.ts:969-979 | `.section` > `.section-head`（h2 + `.more`）+ `.inset-list.post-list`（**只取前 4 篇**） | style-check:350；e2e:2394 |
| 分享/标签列表 | views.ts:1063-1072 | `.section` > `h1.large-title` + `.chip-row`（标签条）+ `.inset-list.post-list` | style-check:354；e2e:2395 |
| 文章页 | views.ts:1080-1090 | `article.post` > `header.post-header`（`h1` + `p.meta` + `p.tags`）+ `div.prose`；外部 `p.back` | `.post` 与 `.prose` 各自 `max-width: var(--measure-prose)`（68ch）并居中（style.css:322/385；style-check:277-278） |

**读出口的数据来源全在 `server.ts`**：`listPublishedPosts()` / `getPublishedPost()`（草稿永不出现），`views.ts` 只负责渲染。要新增「公开文章侧栏」的数据，**必须由 server 传进来**，不要在 `views.ts` 里直接读库（现在 `views.ts` 只 import `charts` / `csrf` / `icons` / `users` 与类型，零 store 依赖）。

---

## 2. 断言清单：`style-check` 171 条 · `e2e` 536 条

> 复现：`node scripts/style-check.mjs` → `✅ 全部通过：171 项`；`node scripts/e2e-check.mjs` → `536/536 通过`（2026-10-21 实测）。
> `style-check` 的 171 是**运行期计数**（源码里 109 处 `check()` 调用，对比度 62 条与状态 9 条由循环展开）。
> `e2e` 的 536 同理（源码里 461 处调用，路由/管理台页/令牌等循环展开）。

### 2.1 `scripts/style-check.mjs`：逐段分类

标记：**复用** = 换装后语义不变，一行不用改；**必须改** = 选择器/数值/结构必须同批改，否则必红；**可删** = 只服务于即将退场的结构。

#### A. token 表（:120-158，10 条）

| 行 | 断言 | 分类 | 换装后怎么处理 |
| --- | --- | --- | --- |
| 124 | `:root` 恰好一个 | **复用** | 仍是单 `:root` + `light-dark()` |
| 126 | 没有 `@media (prefers-color-scheme)` | **复用** | 三态机制不动 |
| 131 | 颜色 token 恰好 17 个（**精确集合**） | **复用（条件）** | 换值不用改这条；但**新增任何颜色 token（如 `--accent-soft`）= 必红**，要同步改 `COLOR_TOKENS` 与计数。推荐方案保持 17 个不变 |
| 132 | 21 个非颜色 token 全在 | **必须改** | 新增 `--font-display` / `--wrap-docs` 等**必须同时加进 `NON_COLOR`**，否则会被当成颜色 token 去要求 `light-dark()`（与 #59 给 `wrap-admin`/`side-w` 的警告同款坑） |
| 142 | 颜色 token 只在 `:root` 与打印块（17+17） | **复用** | 用 `parseLightDark` 解析，改值无感 |
| 145 | 颜色字面量只在 `:root`/打印块 | **复用（但限制设计）** | 参考站的极轻阴影 `0 1px 2px rgb(0 0 0 / .05)` 和 `rgba(26,26,26,.15)` 细线**都不能写进组件规则**——要么写成 token，要么不做（见冲突 C12） |
| 147 | 打印块改在 `body` 上 | **复用** | — |
| 149 | `:root` 有 `color-scheme: light dark` | **复用** | — |
| 154/155 | `[data-theme=light/dark]` 只写 `color-scheme` | **复用** | — |

#### B. 对比度（:161-208，62 条 = 19 文字 ×2 + 12 非文字 ×2）

| 行 | 断言 | 分类 | 换装后怎么处理 |
| --- | --- | --- | --- |
| 190/195 | 19 对文字 ×2 ≥ 4.5 | **必须改（值）/ 结构可复用** | 只要 `--accent` 仍是文字色（链接/按钮字），这 19 对的**形状可以原样保留**，换值即可（§4.2 已验算）。若走「陶土只做非文字」路线，`accent/bg`、`accent/bg-card`、`accent/bg-elev` 三对要从 `TEXT_PAIRS` 移到 `NON_TEXT_PAIRS` |
| 201/205 | 12 对非文字 ×2 ≥ 3 | **必须改（值）** | `label-3` / `border-strong` / `accent` 全部要给暖色新值并重算 |
| 184 | `ALLOWED` 为空 | **复用** | 不要为陶土开口子 |

#### C. 类名/图标（:211-251，10 条）

| 行 | 断言 | 分类 | 备注 |
| --- | --- | --- | --- |
| 236 | views/status.js 渲染的类名都有 CSS 定义 | **复用（会自然变严）** | 新外壳的每个新类（`.top-nav`、`.user-menu`、`.docs-side` …）都必须有 CSS，否则红 |
| 243/246 | 状态值 `up/degraded/down`、`ok/warn/bad` 有规则 | **复用** | 面板不动 |
| 248 | 退场类名清零：`plane-` / **`site-nav`** / `nav-sep` / `admin-side` / `admin-table` / `mini-` / `admin-shell` / `admin-main` | **复用（条件）** | 只要新类名避开名单（`.top-nav` / `.docs-side`）就不用改。⚠ 这条**禁用 `site-nav`**：顶栏导航若想叫这个名字，得先改名单 |
| 249/250 | 图标只来自 `icon()`；`icons.ts` 无颜色字面量 | **复用** | 汉堡菜单要新增第 8 个图标（`menu`），仍走 `icon()` |

#### D. 排版（:254-290，23 条）

| 行 | 断言 | 分类 | 备注 |
| --- | --- | --- | --- |
| 257-259 | 平面 / 两套字体全退役 | **复用** | — |
| 261/262 | `body` 用 `var(--font)` + `--fs-callout`；10 字号 + 4 行高都在 | **复用（值可改）** | 字阶的**名字与数量**是契约，px 值不是 |
| 264-270 | 字阶落点（`h1.large-title`→`--fs-large`、`.post-header h1`→`--fs-title1`、`.prose h2`/`.stat-num`→`--fs-title2`、`.prose h3`→`--fs-title3`、`.prose`→`--fs-body`+`--lh-prose`、`.badge/.tag/.cell-caption/.chart-axis`→`--fs-caption`、`.post-card .meta/.stat-sub/.kv dd`→`--fs-footnote`） | **复用** | 只换 px 值不动选择器。**改成衬线也不需要动**（断言只看 `font-size`），但「标题用 `--font-display`」要**新增**一条断言（建议） |
| 275 | `--label-3` 不出现在任何带 `font-size` 的规则里 | **复用（更危险了）** | 参考站的 faint 色（`ink 68%`）合成后是 **3.04–3.21:1**，刚好压在 3:1 线上、没有余量；照抄它当 `label-3` 会让 12 对非文字全部贴线。用本文的 `#767268`（≥3.81）留出余量 |
| 277/278 | 68ch 栏宽 + `.prose`/`.post` 居中 | **复用** | 与参考站「830px 居中」同构，不必改 |
| 279/280/281 | 页脚贴底 / 登录页排除 / 打印不留 100vh | **复用（需复核）** | 若顶栏从 `sticky` 改 `fixed`，要给 `body` 加 `padding-top: 60px` 并在打印块里清掉——`body:not(.login-body)` 这条规则会跟着变 |
| 282-289 | 表格滚动容器 / 最小列宽 / 打印放开 | **复用** | 文章正文不动 |

#### E. 主题三态（:293-303，6 条）

| 行 | 断言 | 分类 | 备注 |
| --- | --- | --- | --- |
| 296 | `<meta name="color-scheme">` 出现 2 次 | **复用** | 两个外壳都保留 |
| 298 | boot 在 stylesheet 之前（2 处） | **复用** | — |
| 299 | boot 只读 `theme` 键 + `dataset.theme` + try/catch | **复用** | — |
| 300 | picker 是原生 select、3 项、`aria-label="主题"`、**`${themePicker()}` 调用 2 次** | **复用** | 把 picker 挪进用户下拉后，`layout()` 里仍只调用一次 → 计数仍是 2。⚠ 若改成「下拉里一个 + 登录页一个 + 页头一个」就会变 3 |
| 301 | 无 JS 时 picker 隐藏（`<noscript>` 2 处） | **复用** | 若下拉整体靠 CSS `:hover`/`:focus-within`，无 JS 下依然可用 |
| 302 | 不监听 `matchMedia`、不写 cookie | **复用** | 下拉若加 JS 也不许碰这两个 |

#### F. 打印（:306-323，10 条）

| 行 | 断言 | 分类 |
| --- | --- | --- |
| 311/313/315/316/317 | 17 色全在打印块、纯 hex、灰阶、`color-scheme: light`、无 `light-dark()` | **复用** |
| 318-322 | 格带四种打印图案 + `print-color-adjust` 只给格带 | **复用**（面板不动） |

#### G. 外壳与导航（:326-344，14 条）——**重灾区**

| 行 | 断言 | 分类 | 换装后 |
| --- | --- | --- | --- |
| 330 | `layout()` 输出 `.app-shell`，管理台加 `--admin` | **复用** | 公开面可以再加 `--docs` 修饰 |
| 331 | 桌面 rail 是唯一的 `<nav class="site-rail" aria-label="站内导航">` | **必须改** | 公开面要换成文章侧栏；管理台保留 rail。断言得变成「两套外壳各自的侧栏 + 各自的地标名」 |
| 332 | `NAV_ITEMS` 4 项、标签固定 | **复用** | 四项拉到顶栏，表还是那张表 |
| 333 | 管理组只在 `currentIsAdmin()` 时渲染、六模块顺序写死 | **必须改（限定）** | 管理组只该出现在**管理台外壳**里；公开面不再有管理组 |
| 334 | 「运维」「内容」两个 sub-label | **复用（限定到管理台）** | — |
| 335 | 当前项判据唯一 | **复用** | 仍是 `aria-current` |
| 336 | tab bar 与 rail 同源、只读 4 / 管理员 5 | **可删** | 地图要移除 tab bar。若移除，这一条与 `tabBar()`/`ADMIN_ITEM` 一起退场 |
| 337 | `.admin-tabs` 只在 `adminSection` 存在时渲染 | **复用** | — |
| 338 | `.site-header { background: var(--bg) }` 且无 `backdrop-filter` | **必须改（值/选择器）** | 参考站顶栏底色 = 纸色（与页面同色）+ 1px 细线。若新顶栏用 `--bg`，这条原样成立；若用 `--bg-card`，要改字面 |
| 339 | 外壳两列 `var(--rail-w) minmax(0, 1fr)` | **必须改** | 公开面：侧栏列 + 正文列（同写法可留）；管理台：不变。若公开面用 260px 而管理台用 248px，用 `.app-shell--docs { --rail-w: 260px }` 这种**作用域覆盖**就能保住这条断言的原文 |
| 340 | `--wrap-admin` 与 `--rail-w` 都在且是 px | **必须改** | 公开面需要更宽的容器（见 §4.5 的算术），要加 `--wrap-docs` |
| 341 | 720px：rail 隐藏、tab bar 出现、外壳单列 | **必须改** | tab bar 退场；若断点改 819 则整条重写 |
| 342 | 720px：`.admin-tabs` 出现且横向可滚 | **复用** | 管理台手机端方案不变 |
| 343 | 打印隐藏 `.site-rail`/`.tab-bar`/`.admin-tabs`、外壳单列 | **必须改** | 换成新侧栏类名 + 顶栏类名 |

#### H. 公开面（:347-358，8 条）

| 行 | 断言 | 分类 | 备注 |
| --- | --- | --- | --- |
| 350 | 文章卡是 `.inset-list` 里的 `.cell.post-card` | **复用** | 视觉换皮不影响结构 |
| 351 | 行尾 chevron `aria-hidden` | **复用** | — |
| 352/353 | 整行可点 + 标签仍可点 | **复用** | — |
| 354 | 标签条是 `.chip-row`（`.tag-bar` 已退役） | **复用** | — |
| 355 | `large-title` ≥3 处，且 34/700 | **必须改（值）** | 若标题改衬线 + 40px，这里只改数值；若首页 hero 结构变，改数量 |
| 356 | 空态实色块、无虚线 | **复用** | — |
| 357 | 状态摘要行用 `.cell` | **复用** | — |

#### I. 管理台 / 窄屏 / 面板（:361-405，28 条）

| 行 | 断言 | 分类 |
| --- | --- | --- |
| 364-371 | 六模块 `adminSection`、`.cell-detail` 折叠、`required` 确认、`.admin-table` 退役、账号三表单、`target-id`、打印留行 | **全部复用**（管理台保留 rail，不重做） |
| 380 | 存在 720px 断点 | **必须改（若换断点）** |
| 381 | 720：目标卡与 kv 单列 | **复用** |
| 382 | 560px 断点存在 + 表单单列 | **必须改（若换断点）** |
| 383-393 | 打印全套 | **复用**，除 385/387 的隐藏清单要加新类名 |
| 400-405 | 格数 56 / `.cell-missing` / `.cell-strip`/`.badge`/`.dot` / `STATE_CLASS` / 纸纹网格 / charts 无颜色字面量 | **全部复用**（面板零改动） |

**小结（按运行期 171 条计）**：

| 分类 | 条数 | 分布 |
| --- | --- | --- |
| **复用** | **157** | A 9 + B 62 + C 10 + D 23 + E 6 + F 10 + G 6 + H 7 + I 24 |
| **必须改** | **13** | A 1（132 `NON_COLOR`）+ G 7（331/333/338/339/340/341/343）+ H 1（355）+ I 4（380/382/385/387） |
| **可删** | **1** | 336（tab bar 与 rail 同源） |
| 合计 | **171** | 与实测一致 |

这张表按**推荐路线**计（B 路线 + 保持 17 色 + 新类名避开退场名单）。另外两组条件项：
- 若**新增颜色 token**（131）或想复用 `.site-nav` 名字（248）→ 必须改变成 **15**。
- 若改走 **A / C 路线**（`#CC785C` 只做非文字、文字链接改走 `--label`）→ B 段那 62 条里至少 **8 对**要改归属（`accent` 三对从 `TEXT_PAIRS` 移到 `NON_TEXT_PAIRS`，`accent/bg-elev`、`accent/fill` 还要么删、要么把底调亮），必须改变成 **21 上下**。

### 2.2 `scripts/e2e-check.mjs`：与外壳相关的断言

`e2e` 是真实 HTTP 验收，共 536 条。与本次换装**直接相关**的是 **51 条**（行号为断言起始行）。下表把「周边契约」也列出来但**不计入 51**——它们不因换装而变，列在这里是为了让下游知道哪些**不要顺手改**：

| 行 | 断言 | 分类 | 说明 |
| --- | --- | --- | --- |
| 162-170 | 未登录 6 个受保护页 → 302 `/login` | 周边（6 条，不计数） | 闸门不动 |
| 178-181 | 白名单 4 条匿名 200 | 周边（4 条） | — |
| 185-186 | 登录页引用 `/style.css`、含表单 | 周边（2 条） | — |
| 279-309 | 路由冒烟 + 老 URL 契约（含 `/nope`→404） | 周边（16 条） | 换装不该动它们；红了说明改坏了 |
| 1029 | 管理员看得到管理组 | **必须改（限定）** | 管理组只该在管理台外壳出现 |
| 1030 | `/admin` 的「概览」带 `aria-current` | **复用** | — |
| 1053-1054 | 只读页「另外四项都在」 | **必须改** | 四项现在在顶栏；改成断言顶栏有四个 `href` |
| 1057 | 只读顶栏**没有**「管理」 | **必须改** | 新顶栏本就没有管理项；重写成「公开顶栏不含 `/admin`」更严 |
| 1064-1079 | 六个管理台路由：有 rail、管理组恰好一项当前且 `href === route` | **复用（12 条）** | 管理台保留 rail，原样成立 |
| 1082 | rail 管理组六模块 + 两个组标签 | **复用** | — |
| 1088 | rail 条目不带计数 | **复用** | — |
| 1094 | 只读 `GET /admin/targets` → 403 且**有 rail、无管理组** | **必须改** | 403 属于哪套外壳要先定 |
| 1100-1108 | 公开 4 页 rail 恰好 10 条（站点 4 + 管理 6） | **必须改（4 条）** | 公开面不再有管理组 |
| 1111 | 只读用户 rail 只有 4 项 | **必须改** | 换成「公开侧栏 + 无管理入口」 |
| 1115 | `/status` 的当前项恰好一个且指向本页 | **必须改（容器）** | 判据不变，容器从 rail 变侧栏 |
| 1121 | tab bar 管理员 5 / 只读 4 | **可删** | tab bar 退场 |
| 1125 | 管理台有 `.admin-tabs`、公开页没有 | **复用** | — |
| 1131 | `.admin-table` 已退役 | **复用** | — |
| 1132 | 目标页用 `<details class="cell-detail">` | **复用** | — |
| 1135 | 页头不透明、无 `backdrop-filter` | **复用** | 参考站顶栏也不透明 |
| 1143 | 文章编辑态高亮「文章」 | **复用** | — |
| 2375-2376 | 五页 `<body>` 无平面类、登录页只有 `login-body` | **复用（2 条）** | — |
| 2381 | **所有页面都带一条 rail 与一个 tab bar** | **必须改** | 公开面换侧栏、tab bar 移除 |
| 2385 | 当前项每页恰好一个 | **复用** | — |
| 2389 | 管理台 tab bar 里的「管理」项是唯一当前项 | **可删** | tab bar 退场 |
| 2394-2395 | 首页 inset 列表 / 分享页 chip row + 整行可点 | **复用（2 条）** | — |
| 2405-2406 | `/style.css` 可取、无平面选择器 | **复用（2 条）** | — |
| 2407 | 有 720px 断点与打印块 | **复用（断点若改则改）** | — |
| 2411-2413 | 两外壳有 `color-scheme` meta；boot 在 stylesheet 前 | **复用（3 条）** | — |
| 2415-2419 | 页头 + 登录页各一个 picker（三项中文）、SSR 无 `data-theme`、无 JS 隐藏、无 matchMedia/cookie | **复用（5 条）** | 见 §2.1-E 的「picker 计数」 |
| 2420-2421 | 三态只切 `color-scheme`；颜色 token 是 `light-dark()` | **复用（2 条）** | — |

**小结（e2e 相关子集，51 条）**：

| 分类 | 条数 | 明细 |
| --- | --- | --- |
| **复用** | **37** | 1030、1064-1079（12）、1082、1088、1125、1131、1132、1135、1143、2375-2376（2）、2385、2394-2395（2）、2405-2406（2）、2407、2411-2413（3）、2415-2419（5）、2420-2421（2） |
| **必须改** | **12** | 1029、1053、1054、1057、1094、1100-1108（4）、1111、1115、2381 |
| **可删** | **2** | 1121、2389 |
| 合计 | **51** | — |

---

## 3. 参考事实：`support.claude.com`

抓取方式（2026-10-21）：

```bash
curl -sSL https://support.claude.com/ -o home.html
curl -sSL https://support.claude.com/en/articles/9015913-how-to-get-support -o article.html
curl -sSL https://support.claude.com/en/collections/4078531-claude -o collection.html
# HTML 里引用了 6 个 CSS；其中体积最大的两个承载设计 token 与布局：
#   https://static.intercomassets.com/_next/static/css/fe3431c5c27bda33.css   （73 KB，token + TopBar/Sidebar/Shell/Article）
#   https://static.intercomassets.com/_next/static/css/b6a44ee60459e446.css   （132 KB，Tailwind + Intercom 组件）
```

**性质**：它是 Intercom 托管的 help center（Next.js + 生成的 `Docs*__hash` 类名 + 一层 `tokens_docsRoot__1XQPC` 自定义属性）。所以「事实」只能按**渲染出来的 CSS 值**记，不按类名含义猜。

### 3.1 顶栏（`.DocsTopBar_bar__i14eF`）

| 项 | 值 | 来源 |
| --- | --- | --- |
| 高度 | **60px** | `height:60px`；另有 `.barSpacer{height:60px}` |
| 定位 | `position: fixed; top: 0; z-index: 50` | 同上 |
| 底色 | `var(--paper)` = `rgb(250,249,245)`（**与页面同色**） | `background:var(--paper)` |
| 分隔 | `border-bottom: 1px solid color-mix(in srgb, var(--ink) 15%, transparent)` ≈ `#D8D7D4` | `--border` |
| 内层 | `display:flex; justify-content:space-between; align-items:center; gap:16px; padding:0 16px` | `.inner` |
| 左 | 只放**品牌**：`<a class="brand"><img class="logo"></a>`，logo 高 **32px**（≤819 时 40px），无文字站名 | DOM + CSS |
| 右 | 三枚文本链接（API docs / Release notes / How to get support，14px、`ink-muted`、padding 8/12、圆角 12px）+ 语言下拉（14px）+ 搜索按钮 | DOM + CSS |
| 搜索按钮 | 高 **30px**、最小宽 140px、`ink 5%` 底、1px `ink 15%` 边、圆角 12px，右侧 `⌘K`（JetBrains Mono 12px） | `.search` |
| 标签 hover | `background: var(--accent-soft)`（= accent 6% 透明） | `@media(hover:hover)` 里 |
| 移动 ≤819 | 标签整块 `display:none`；搜索按钮隐藏；出现**汉堡**（32×38）与移动搜索图标；抽屉从 60px 下展开、高 `calc(100vh - 60px)`、带 `ink 40%` 遮罩 | 媒体查询 |
| 副头带 | `data-subheader="true"` 时底色切 `--header-subheader-background-color: #CC785C`、字色 `#F0F0EB`；**三个页面类型都没有这个属性** | DOM 对照 |
| 遗留变量 | 内联 `#header{--header-height:245px}`，但**页面里没有 `id="header"` 的元素** → 245px 是个死值，别当顶栏高度 | HTML |

### 3.2 左侧栏（`.DocsSidebar_*` / `.DocsShell_grid__w_wa8`）

| 项 | 值 | 来源 |
| --- | --- | --- |
| 轨道宽 | **260px**（`grid-template-columns: 260px 1fr 240px`，`[data-with-sidebar=true]`） | `.DocsShell_grid` |
| 固定版宽 | `calc(260px + 16px)` = **276px**，`position: fixed; top: 60px; inset-inline-start: 0`，右下 1px `ink 12%` | `.DocsSidebar_sidebarPinned` |
| 高度 / 滚动 | `height: calc(100vh - 60px)`；内部 `.nav { overflow-y: auto; padding: 24px 16px 32px }`；`scrollbar-width: thin`，滑块 `ink 18%`、hover `34%` | `.nav` |
| 分组标题 | 14px / 600 / `--ink`，带 20px 图标位，行内 padding 8px，圆角 12px | `.collectionHeader` |
| 子项 | 14px / `--ink-muted`，padding 8px，圆角 12px；行内嵌套再缩进 `--space-4` | `.link` |
| 当前项 | 文字 `color: var(--accent)` + 左侧 **2px 竖条**（`height:16px`、`border-radius:1px`、`background: var(--accent)`，绝对定位在行外） | `:has([aria-current=page]):before` |
| hover | 整行 `:before` 铺满 `--accent-soft` 底（不是改文字色） | `:hover:before` |
| 展开/折叠 | `<button aria-expanded>` + 16px 箭头 `rotate(90deg)`，`.2s ease-out` | `.toggle` / `.chevron` |
| 段落分隔 | 行间 `gap: 1px`；嵌套列表左侧 1px `ink 12%` 竖线 | `.list` / `:before` |

### 3.3 正文栏与文章排版

| 项 | 值 | 来源 |
| --- | --- | --- |
| 主列 | `max-width: 830px; margin-inline: auto; padding: 32px 0 64px` | `.DocsShell_main` |
| 网格 | `padding: 0 16px; gap: 48px; align-items: start` | `.DocsShell_grid` |
| 右目录 | `width: 240px`，`position: fixed; top: 60px; max-height: calc(100vh - 60px)`，≤1099 隐藏 | `.DocsShell_toc` |
| 文章标题 | `font-family: var(--font-display)`（衬线）/ 600 / **36px** / `line-height: 1.12` / `letter-spacing: 0`；≤819 降 32px | `.DocsArticle_title` |
| 面包屑 | 13px / `ink-muted`；移动端横向可滚 + 右侧 24px 渐隐遮罩 | `.breadcrumbs` |
| 正文 | `font-size: 15px` / `line-height: 1.55` / `color: var(--ink)` | `.DocsArticleBody_body` |
| 正文内 h1 / h2 | 26px / 22px，**衬线** / 600 / `margin-top: 48px / 32px`；锚点 `scroll-margin-top: 80px` | 同上 |
| 正文内 h3 / h4 | **17px 无衬线** / 600 | 同上 |
| 链接 | 下划线（`underline-offset: 2px`、`1px`），颜色走 `--link-color`（= accent） | 同上 |
| 引用 | 左侧 2px accent 竖线 + `ink-muted` 文字 | 同上 |
| code | `paper-muted` 底 + 1px 边 + 4px 圆角 + `0.875em` 等宽 | 同上 |
| pre | 13px / 1.55 / 6px 圆角 / 16px 内边距 | 同上 |
| 表格 | 14px，`border-collapse: separate`，1px 外框 + 6px 圆角，单元格 8/12，表头 `paper-muted` | 同上 |
| 列表行（首页卡片/集合文章） | 标题 14px/600，摘要 13px `ink-muted`，行尾 20px 箭头，行 hover `accent-soft`，行间 1px `ink 10%` 且 hover 时隐藏分隔 | `.DocsHome_row` / `.DocsCollection_articleRow` |

### 3.4 字体：实际用法与授权边界

| 角色 | 字体 | 用在哪（实际规则） | 能否合法近似 |
| --- | --- | --- | --- |
| 标题 / display | `AnthropicSerif-Regular-Web`（400/500/600 三个 `@font-face`） | 顶栏站名 16/600、首页大标题 48/500、集合标题 40/600、文章标题 36/600、正文 h1 26/600、h2 22/600、卡片标题 20/500、区块标题 19–22/600 | **不能**加载该文件；只能用**系统衬线栈**近似 |
| 正文 / UI | `AnthropicSans-Regular-Web`（400/500/600/700 + italic） | 一切 UI（13–15px）、正文 15px、正文 h3/h4 17/600、表格 14px、导航 14px、meta 13px | **不能**加载；系统无衬线栈即可 |
| 等宽 | `JetBrains Mono`（**OFL 授权**） | `code` / `pre` / `⌘K` 键帽 | 文件本身可合法分发，但本仓「无外部字体 / 离线部署」的约束仍在 → 保持 `ui-monospace` 栈 |

【事实】字体文件是**自托管在参考站自己的域**上（`https://support.claude.com/assets/font/943401…943403`、`943396…943400`、`938266`），`@font-face` 只有 `src: url(...)`、没有 `format()` 提示，`font-display: swap`，`crossorigin="anonymous"` 预加载。

【取舍】**不下载、不自托管、不热链**。理由三条：① 这是 Anthropic 的私有字体，站点自己托管不等于授权我们分发；② 热链会引入外部依赖，与「离线部署 / 不新增外部请求」直接冲突；③ 中文字形本来就不在 AnthropicSerif/Sans 里，中文必然回退，自托管只能改善拉丁字母。

【取舍】衬线栈（拉丁在前、中文衬线兜底）建议：

```css
--font-display: ui-serif, "Iowan Old Style", Georgia, Cambria, "Times New Roman",
                "Songti SC", "STSong", "SimSun", "Noto Serif CJK SC", serif;
```

- Windows 上会落到 **Georgia / Cambria**（有 Georgia 时更接近参考站的过渡衬线观感），中文落到 **宋体**；macOS 是 New York / 宋体-简；Linux 是 Noto Serif。
- **宋体在 <16px 会发虚**：所以衬线只配给 ≥20px 的标题（与参考站的 20–48px 区间一致），正文一律无衬线。这正是参考站自己的分工（它的 `h3/h4` 17px 都特意切回了无衬线）。
- 【不确定】`ui-serif` 的浏览器支持不如 `ui-monospace` 一致；不支持时会继续落到下一项，不影响可用性。

### 3.5 色值（全部实测）

| 角色 | 值 | 出处 |
| --- | --- | --- |
| 页面底 / 顶栏底 `--body-bg` / `--header-bg` | `rgb(250,249,245)` = **#FAF9F5** | 内联 `:root` |
| 卡片底 `--card-bg` | `rgb(252,251,248)` = **#FCFBF8** | 同上 |
| 代码/表头底 `--paper-muted` | `color-mix(paper 96%, ink 4%)` ≈ **#F1F0EC** | `.tokens_docsRoot` |
| 反应块底 `--body-reaction-bg` | `rgb(241,239,228)` = **#F1EFE4** | 内联 `:root` |
| 暖边框 `--body-border` | `rgb(233,229,211)` = **#E9E5D3** | 同上（只用于 `#footer` 上边线） |
| 表格边框 `--body-table-border` | `rgb(216,208,177)` = **#D8D0B1** | 同上 |
| hairline（真正到处在用的那条） | `color-mix(ink 15%, transparent)` ≈ **#D8D7D4** | `--border` |
| 主文字 `--body-primary-color` | `#1A1A1A`（16.52:1 on #FAF9F5） | 内联 `:root` |
| 次文字 `--body-secondary-color` | `#595959`（6.65:1） | 同上 |
| 最弱（chevron / 装饰）`--ink-faint` | `color-mix(ink-muted 68%, transparent)` → 合成后 ≈ **#8D8C8B**，3.04–3.21:1（**贴着 3:1，没有余量**；落在 `--fill-strong` 上只有 2.89） | `.tokens_docsRoot` |
| 强调 `--primary-color` | `hsl(60,3%,8%)` ≈ **#151514**（近黑） | 内联 `:root` |
| 次级强调 `--secondary-color` | `hsl(51,3%,44%)` ≈ **#73736D** | 同上 |
| **陶土带** `--header-subheader-background-color` | **#CC785C**（配字 `#F0F0EB`，**页面里从不渲染**） | 同上 |
| 页脚 | 底 `rgb(20,20,19)` = **#141413**，字 `hsl(50,17%,93%)` ≈ **#F0EFEA** | 同上 |
| 卡片描边 / 圆角 | `rgba(26,26,26,.15)` / `12px`（内圆角 9px） | 同上 |
| 卡片阴影 | `0 1px 2px 0 rgb(0 0 0 / .05)`（只有内容块用，顶栏/侧栏都没有） | 同上 |

【事实】**整个参考站的「强调色」其实是近黑**（`#151514`），次强调是中性灰（`#73736D`）。有彩度的颜色只剩：陶土带（未渲染）、页脚近黑、`#D8D0B1` 表格线、`#E9E5D3` 暖边框。所以「暖白纸感」是真的，「陶土强调」**不是**参考站 UI 的事实——它是品牌色被配置进来但没启用。

### 3.6 圆角 / 间距 / 层级

| 类别 | 值 |
| --- | --- |
| 圆角 | `4 / 6 / 8 / 12px`；卡片 = 12（内圆角 9）；按钮 = 卡片圆角；导航项圆角 = `min(card-radius, 12)` = 12 |
| 间距 | `4 / 8 / 12 / 16 / 24 / 32 / 48 / 64`（8 档，4px 网格） |
| 阴影 | 三级 token：`0 1px 2px rgba(28,32,38,.04)` / `0 2px 8px …06` / `0 8px 24px …08`；**顶栏、侧栏、正文栏都不用**，只给内容块与移动抽屉 |
| 层级 | 靠「底色差 + hairline」：paper → card（更亮）→ muted（更暗）；与 #68 §4.6 的做法一致 |

### 3.7 响应式断点（实测全站 @media）

| 断点 | 行为 |
| --- | --- |
| `max-width: 1099px` | 隐藏右侧目录（`.toc`）；`[data-with-sidebar]` 从三列变两列（260px 1fr）；首页侧栏整体隐藏 |
| `min-width: 1100px` | 语言选择器的「侧栏版」出现 |
| `max-width: 819px` | 顶栏标签与搜索按钮隐藏、出现汉堡 + 移动搜索；侧栏 `display:none`（抽屉版除外）；网格单列；文章标题 36→32、集合标题 40→32；首页标题 48→40 |
| 其它 | `1023 / 768 / 640 / 600 / 500 / 400` 零散（Tailwind 工具类与组件），**不是导航主结构断点** |
| hover | 13 处 `@media (hover:hover)` 包着 hover 样式 → **触屏不触发 hover，不会「点一下卡住」** |
| 动效 | 17 处 `@media (prefers-reduced-motion: reduce)` 直接把 `transition: none` |

### 3.8 hover / focus / 当前项

| 状态 | 做法 |
| --- | --- |
| 链接 hover | 正文链接：颜色从 accent → `accent-strong`，始终带下划线；导航链接：整行 `accent-soft` 底 |
| focus-visible | `outline: 2px solid var(--focus-ring); outline-offset: 2px`（`--focus-ring` = accent）；侧栏内用 `-2px` 偏移避免被裁 |
| 当前项 | **不是彩色高亮**：文字从 `ink-muted` 变 `ink`（在多数主题里两者都近黑）+ 左侧 2px accent 竖条 + `aria-current="page"` |
| 触屏 | 所有 hover 都在 `(hover:hover)` 里；移动端只是「点开抽屉 / 点开下拉」 |
| 动效 | 颜色 `.15s ease`，箭头 `.2s ease-out`；reduced-motion 全关；抽屉 `.28s cubic-bezier(.16,1,.3,1)` |

### 3.9 能合法近似 vs 不能

| 项 | 结论 |
| --- | --- |
| 暖白底、近黑字、细线、12px 圆角、间距节奏 | **能**（纯 CSS 值） |
| 衬线标题 / 无衬线正文的分工 | **能**（系统字体栈，拉丁与 CJK 各自回退） |
| `#CC785C` 作为**装饰性**强调（焦点环、2px 竖条、填充按钮底、悬停淡底） | **勉强能**：3.11:1 on 纸色、3.17 on 卡片，但 **2.84 on `--bg-elev`、2.87 on `--fill` → 不过 3:1**。用的时候不能落在后两种底上（§4.2） |
| `#CC785C` 作为**文字色**（链接、按钮文字） | **不能**（3.11:1 < 4.5），除非加深（§4.2 的 B 路线） |
| AnthropicSerif / AnthropicSans 文件本身 | **不能**（下载 / 自托管 / 热链都不做） |
| JetBrains Mono | 文件授权允许（OFL），但**本仓不加外部字体** → 继续用 `ui-monospace` |
| 搜索框 / 多语言切换 | **明确不做**（#82 out of scope），只借鉴「行高 30px、圆角 12、ink 5% 底」这种形态语言 |
| 侧栏的展开/折叠箭头 | 参考站有（`<button aria-expanded>` + 旋转箭头）；我们的文章索引短，不需要，但**分组标题 + 子项缩进**这套层级语言可以照用 |
| 极轻卡片阴影 | 技术上能做，但撞本仓「不做阴影 + 颜色字面量只在 `:root`」两条纪律（§6-C12） |

---

## 4. token / 组件映射草案（供下游决定，不是决定）

### 4.1 17 色 token 的映射方向

角色一一对应，值按「暖白纸感」重算；下表左列是现有 token，右列是参考站的对应物。

| token | 参考站对应 | 映射说明 |
| --- | --- | --- |
| `--bg` | `--body-bg` #FAF9F5 | 直接取 |
| `--bg-card` | `--card-bg` #FCFBF8 | 直接取（**比页面底更亮**，这是参考站的做法） |
| `--bg-elev` | `--body-reaction-bg` #F1EFE4 / `paper-muted` #F1F0EC | 取更暖的那档做「卡内凹块 / 当前项底」 |
| `--fill` | `paper-muted` #F1F0EC | 输入框 / tag / tinted 按钮 / 空态 |
| `--fill-strong` | `--body-border` #E9E5D3 | 更重的填充（分段轨道、hover 强调块） |
| `--label` | `#1A1A1A` | 直接取 |
| `--label-2` | `#595959` | 直接取 |
| `--label-3` | `--ink-faint`（合成后 3.04–3.21:1，贴线） | **不建议照抄**——本仓 `label-3` 要 ≥3:1 且不能没有余量；取 `#767268`（4.55 on paper，3.81 最小） |
| `--separator` | `ink 15%` 的实色等价 #D8D7D4 | 加一点暖：`#DCD8CA`（1.35:1，装饰性，不承诺 3:1） |
| `--border-strong` | 无直接对应（控件边框） | `#827D6F`（最小 3.56:1，暖灰） |
| `--accent` | `--primary-color` ≈ #151514（近黑） | **冲突点**：地图要陶土。见 §4.2 的三条路线 |
| `--on-accent` | `--text-on-primary-color` #FFFFFF | 若 accent 加深到 5.7:1，白字仍是 6.05:1；若 accent 用 #CC785C，则必须换 `#1A1A1A`（5.31） |
| `--ok` / `--warn` / `--bad` | 无（参考站没有状态色） | 保留语义色相，按新底重算（下表已验算） |
| `--unknown` | 无 | 只做填充：`#E3DFD0` |
| `--scrim` | 遮罩 `ink 30%` | 唯一 rgba 例外，保持；可转暖 `rgba(26,20,16,.40)` |

### 4.2 `#CC785C` 的三条路线（对比度全部实算）

先给硬数字（WCAG 2.x 公式，浅色面用本草案的 `--bg/#FAF9F5`、`--bg-card/#FCFBF8`、`--bg-elev/#F1EFE4`、`--fill/#F1F0EC`）：

| 组合 | 比值 | 用途要求 | 判定 |
| --- | --- | --- | --- |
| `#CC785C` on `#FAF9F5` | **3.11** | 文字 4.5 / 非文字 3 | 非文字勉强过，文字**不过** |
| `#CC785C` on `#FCFBF8` | **3.17** | 同上 | 同上 |
| `#CC785C` on `#F1EFE4`（elev） | **2.84** | 非文字 3 | **不过** |
| `#CC785C` on `#F1F0EC`（fill） | **2.87** | 非文字 3 | **不过** |
| `#FFFFFF` on `#CC785C`（白字按钮） | **3.28** | 文字 4.5 | **不过** |
| `#1A1A1A` on `#CC785C`（黑字按钮） | 5.31 | 文字 4.5 | 过 |
| `#F0F0EB` on `#CC785C`（参考站配置的副头带） | **2.87** | 文字 4.5 | **不过**（参考站自己这一对也不达标，只是没渲染） |
| `#9C4B35` on `#FAF9F5` | **5.74** | 文字 4.5 | 过 |
| `#FFFFFF` on `#9C4B35` | **6.05** | 文字 4.5 | 过 |
| `#D98B6E` on `#141413` | **6.91** | 文字 4.5 | 过（深色模式用） |

| 路线 | 做法 | 断言代价 | 观感 | 评 |
| --- | --- | --- | --- | --- |
| **A · 品牌忠实** | `--accent: #CC785C`；**文字链接改用 `--label` + 下划线**（参考站就是这样）；accent 只做焦点环 / 2px 竖条 / 按钮底（按钮字用 `--on-accent:#1A1A1A`） | 大：`accent/bg`、`accent/bg-card`、`accent/bg-elev` 三对从 `TEXT_PAIRS` 移到 `NON_TEXT_PAIRS`；`accent/bg-elev`、`accent/fill` 仍不过 3:1 → 要么把 `bg-elev`/`fill` 调亮到 ≥#FAF9F5 一档，要么删掉这两对 | 最像 Claude | 推给原型票评估 |
| **B · 加深陶土（推荐）** | `--accent` 浅 `#9C4B35` / 深 `#D98B6E`，`--on-accent` 浅白 / 深近黑；链接、按钮、当前项**全走 accent** | 小：19/12 对的**形状一条不改**，只换值（§4.3 已全绿） | 偏砖红，仍属陶土色族 | 断言成本最低、AA 最稳 |
| **C · 折中** | `--accent: #C86B4F`（3.21 最小，仅做非文字）+ 文字走 `--label` | 中：与 A 同构，但 elev/fill 两对能过 3:1 | 比 B 亮、比 A 暗 | 想要「看得出的陶土」又不想加深太多时 |

> **我的建议是 B，把 A 作为原型的对照版本。** 理由：本仓的对比度纪律是「算出来的、不许估」，A 要动 8 对以上；而 B 只改值，能让「换装」这件事的断言改动集中在**外壳**（§2 的 G 段）而不是颜色。

### 4.3 一套已验证的 17 色草案（浅/深并排，全部过预算）

【取舍】下表是我按参考站色阶 + 陶土强调推的一版，**已用 WCAG 公式逐对验算**（19 文字 ×2 + 12 非文字 ×2）：

| token | 浅 | 深 | 浅色实测 | 深色实测 |
| --- | --- | --- | --- | --- |
| `--bg` | `#FAF9F5` | `#141413` | — | — |
| `--bg-card` | `#FCFBF8` | `#1C1B19` | — | — |
| `--bg-elev` | `#F1EFE4` | `#232220` | — | — |
| `--fill` | `#F1F0EC` | `#2A2825` | — | — |
| `--fill-strong` | `#E9E5D3` | `#363330` | — | — |
| `--label` | `#1A1A1A` | `#FAF9F5` | 15.09–16.82 | 13.95–17.50 |
| `--label-2` | `#595959` | `#A8A49A` | 6.07–6.77 | 5.91–7.41 |
| `--label-3` | `#767268` | `#8E8A80` | ≥3.81 | ≥4.27 |
| `--separator` | `#DCD8CA` | `#332F2B` | 1.35（装饰） | — |
| `--border-strong` | `#827D6F` | `#7A756C` | ≥3.56 | ≥3.21 |
| `--accent` | `#9C4B35` | `#D98B6E` | 5.24–5.85 | 5.96–6.91 |
| `--on-accent` | `#FFFFFF` | `#141413` | 6.05 | 6.91 |
| `--ok` | `#1B7A2F` | `#30D158` | 4.70 / 5.24 | 7.86 / 8.51 |
| `--warn` | `#A35A00` | `#FF9F0A` | 4.53 / 5.05 | 7.73 / 8.37 |
| `--bad` | `#C1271B` | `#FF6961` | 5.09 / 5.68 / 5.15 | 5.21 / 5.64 / 6.10 |
| `--unknown` | `#E3DFD0` | `#3A3733` | 填充 | 填充 |
| `--scrim` | `rgba(26,20,16,.40)` | `rgba(0,0,0,.55)` | 遮罩 | 遮罩 |

**最低值：浅色文字 4.53:1（`warn` on `--bg-elev`）、非文字 3.56:1（`border-strong` on `--bg-elev`）；深色文字 5.21:1、非文字 3.21:1。`ALLOWED` 仍可为空。**

需要注意的是：
- `--bg-card` 比 `--bg` **更亮**（参考站做法）。方向与现行 iOS 版一致（纯白卡片 + 浅灰页面），但**差值只剩约 1/6**（相对亮度差 0.109 → 0.018）：卡片的边界几乎全靠那 1px 线撑着。若觉得太淡，把 `--bg` 压到 `#F5F3EC`（`accent` 会升到 5.45，其余对只会更好），或卡片保持纯白。
- `--fill` 与 `--bg-elev` 是两档温度不同的浅色（`#F1F0EC` 偏中性、`#F1EFE4` 偏暖），差得很小；若觉得分不开，把 `--fill` 调到 `#EDEAE0` 即可（`accent/fill` 仍有 5.03、`border-strong/fill` 3.41、`label-3/fill` 3.99，全部仍过）。
- 状态三色沿用 iOS 的语义色相没动，只因为它们在新底上仍然达标；如果要求「整套色盘都暖」，需要重新选色并重跑这 6 对。

### 4.4 字号 / 行高：10 + 4 的映射草案

现有 10 个字号 token 的名字与落点是断言契约（§2.1-D），**只有 px 值可改**。参考站的层级（15 正文 / 36 文章标题 / 48 首页大标题 / 13 meta）与本仓的 CJK 需求（正文不能太小）之间要折中：

| token | 现值 | 参考站近似值 | 草案值 | 理由 |
| --- | --- | --- | --- | --- |
| `--fs-large` | 34 | 40–48（首页大标题） | **40** | 衬线在大字号才像参考站；CJK 40px 不夸张 |
| `--fs-title1` | 28 | 36（文章标题） | **34** | 文章页标题；≤720 可降 28 |
| `--fs-title2` | 22 | 26（正文 h1） | **26** | 区块标题 / `.prose h2` |
| `--fs-title3` | 20 | 22（正文 h2）/ 20（卡片标题） | **22** | — |
| `--fs-headline` | 17 | 19–20（区块标题）/ 15（行标题） | **19** | 行标题与 `.section-head h2` |
| `--fs-body` | 17 | 15 | **17 保留** | 中文正文 15px 偏小；参考站是英文 15px。**这一档不建议照抄** |
| `--fs-callout` | 16 | 15（body 根字号） | **16 保留** | `body` 基准 |
| `--fs-subhead` | 15 | 14（导航 / 卡片标题） | **15** | 导航与行副标题 |
| `--fs-footnote` | 13 | 13（meta / 面包屑 / kbd） | **13 保留** | — |
| `--fs-caption` | 12 | 12（分组小标题） | **12 保留** | tag / badge / 图表轴 |
| `--lh-prose` | 1.85 | 1.55（参考站正文） | **1.8** | 中文长文；1.55 对 CJK 太挤（与 #65 的结论一致） |
| `--lh-title` | 1.3 | 1.12（`--display-line`） | **1.2** | 衬线大标题可以收紧，但 1.12 对中文标点不友好 |
| `--lh-ui` | 1.55 | 1.55 | 1.55 | 一致 |
| `--lh-tight` | 1.25 | — | 1.25 | 保留 |

新增非颜色 token（**必须同步进 `style-check` 的 `NON_COLOR`**，否则会被当成颜色 token 去要求 `light-dark()`）：

```css
--font-display: ui-serif, Georgia, Cambria, "Times New Roman",
                "Songti SC", "STSong", "SimSun", "Noto Serif CJK SC", serif;
--wrap-docs: 1180px;   /* 20 + 260 + 48 + 830 + 20 = 1178，取整 1180 */
```

### 4.5 栏宽算术（把「正文不被压缩」写成等式）

参考站：`16（内边距）+ 260（侧栏）+ 48（栏距）+ ≤830（正文）+ 16 = 1170`（有右目录时再加 48+240）。

本仓现状：`--wrap: 900px`，`.wrap` 左右各 20px → 正文列 860px；侧栏在 `.wrap` **之外**，所以 900 里没有侧栏的位置。若公开面要「260 侧栏 + 正文」，容器必须变宽，否则正文只剩 `900 − 20 − 260 − 20 = 600px`——比今天的 860 少 260px，正是 #59 §3 论证过的那种「感觉没被压缩」（那里为侧栏专门重算过 `--wrap-admin`，同一条方法论）。

【取舍】建议：公开面用**单独的**宽栏 token，管理台继续 `--wrap-admin: 1140px`；两者都由 `.app-shell` 的修饰类切换，**不覆盖 `--wrap`**（`--wrap` 还给登录页/403/404 用）。

把数字代进去（沿用本仓 20px 内边距 + 参考站的 260 侧栏 / 48 栏距 / 830 正文上限）：

```
20（内边距）+ 260（侧栏）+ 48（栏距）+ 830（正文）+ 20（内边距）= 1178px
```

→ `--wrap-docs: 1180px`（向上取整 2px 余量）。若要更紧凑，把栏距降到 24px 就是 `20+260+24+830+20 = 1154`；两种都在 1140–1180 一档，比 `--wrap: 900` 宽得多，**必须新增 token 而不是复用 `--wrap`**。

⚠ 若把 `--rail-w` 从 248 调到 260，`--wrap-admin` 的等式 `20+220+20+860+20` 就要重算（现行注释写在 `style.css:46`）。两条路：① 管理台仍 248、公开面用 260（`.app-shell--docs { --rail-w: 260px }` 作用域覆盖，`grid-template-columns: var(--rail-w) minmax(0,1fr)` 的断言原文可保）；② 统一 260 并改宽栏等式 + 改注释。**推荐 ①**：断言改动最小，且管理台 rail 本来也不是参考站的东西。

### 4.6 组件映射草案

| 目标组件 | 现状 | 参考站 | 草案 | 改动面 |
| --- | --- | --- | --- | --- |
| 顶栏 | `.site-header`（sticky，min-height 56，左品牌 + 右 picker/登出） | 60px fixed，左 logo，右 3 链接 + 语言 + 搜索 | 60px（sticky 即可，fixed 要加占位块），左「占位徽标 + 站名」，右「四项导航 + 用户胶囊」 | markup + CSS + 断言 |
| 顶栏导航 | 无（在 rail 里） | 14px 文本链接，hover `accent-soft` | 复用 `NAV_ITEMS` 渲染，`.top-nav` / `.header-nav`（**不要叫 `.site-nav`**，被 style-check:248 禁用） | 新增片段 + 复用数据表 |
| 用户胶囊 | 无（页头只有 picker + 登出） | **参考站没有** | 首字母圆 + 用户名 + 下拉（身份 / 修改口令 / 管理后台[仅管理员] / 主题 / 登出） | **纯新增**；需要新 accessor（见 §5.3） |
| 主题 picker | `.theme-picker`（页头 + 登录页） | 无（参考站没有主题） | 挪进下拉；`themePicker()` 仍在 `layout()` 调一次 → 断言计数不变 | 位置变、代码不变 |
| 公开侧栏 | `.site-rail`（站点 4 + 管理 6） | 260px，分组 + 折叠 + 当前项 2px 竖条 + 独立滚动 | 新 `.docs-side`（或复名 `.site-rail` 但内容换成文章索引）；分组「文章」；当前项同判据 | markup + CSS + 数据接口 |
| 管理台 rail | `.site-rail` + 管理组 | — | **保留**（#82 明确），可能要把宽度/视觉换成同一套纸感 | 只 CSS |
| 手机导航 | 底部 `.tab-bar` + `.admin-tabs` | 顶栏 + 汉堡抽屉 | 抽屉（导航四项 + 文章索引）；`.admin-tabs` 保留 | markup + CSS + 断言（tab bar 退场） |
| 文章行 | `.cell.post-card` + `.chev` | 行标题 14/600 + 摘要 13 muted + 20px 箭头 + 行 hover | 结构可留，改字号/间距/圆角/分隔线 | 只 CSS（+ 标题字族） |
| 文章页 | `.post` + `.post-header h1` + `.prose` | 面包屑 + 36 衬线标题 + 15 正文 + 右目录 | 加面包屑；标题衬线 34；正文保持 17/1.8；**不做右目录**（无需求） | 小 markup + CSS |
| 卡片 / 列表 | `.card` / `.inset-list` / `.cell` | 12px 圆角、1px 暖线、纸色底、无阴影 | 改 token 值 + 圆角 16→12 | 只 CSS |

### 4.7 与「单 `:root` + `light-dark()` + 三态」的兼容性

- 全部是 `light-dark(#hex, #hex)`，**不需要动机制**；`--scrim` 继续是唯一 rgba 例外（`parseLightDark` 对它放行）。
- 打印块：17 个值换灰阶即可（`--accent` 打印成 `#000`，和现在一样）。
- **不要**为了「参考站没有深色」就把深色砍掉——#82 已定保留三态。
- 深色没有参考可抄这件事要写进设计说明：本文的深色值是按「参考站唯一深色面（页脚 #141413）+ 同一色相提亮」推的，留给原型票目视复核。

---

## 5. 影响清单（按文件）

### 5.1 `scripts/style-check.mjs`

| 动作 | 条目 |
| --- | --- |
| **加进 `COLOR_TOKENS`** | 只有新增颜色 token 时才需要（草案不新增，**保持 17**） |
| **加进 `NON_COLOR`** | `font-display`；若引入 `wrap-docs` 或 `docs-w` 之类也要加（`style-check.mjs:99-108`） |
| **改常量/名单** | `:248` 的退场名单（若新类名想复用 `site-nav`）；`:331/333` 的「rail 唯一」；`:339/340` 的列定义与栏宽 token；`:341` 的 720 断点三元组；`:343/385/387` 的打印隐藏清单 |
| **改阈值表** | `TEXT_PAIRS`（19）/`NON_TEXT_PAIRS`（12）只在走 A/C 路线时改；B 路线只换 `:root` 值 |
| **新增断言（建议）** | ① 公开面侧栏恰好一个 `<nav aria-label="公开文章">` 且只列已发布文章；② 顶栏四项来自 `NAV_ITEMS`（同源）；③ 用户胶囊只在已登录时渲染，管理入口只在 `currentIsAdmin()`；④ 标题用 `var(--font-display)`；⑤ 顶栏 60px + `--rail-w: 260px` |
| **删** | `:336`（tab bar 同源）、`:341`/`:343` 里的 `.tab-bar` 片段（若 tab bar 退场） |

### 5.2 `scripts/e2e-check.mjs`

| 动作 | 条目 |
| --- | --- |
| **改** | `:1053-1057`（只读顶栏无管理）、`:1093-1098`（403 的外壳）、`:1100-1114`（公开页 rail 10/4 条）、`:1115-1118`（容器从 rail 换侧栏）、`:2381-2384`（所有页面带 rail + tab bar）、`:2389-2391`（tab bar 管理项） |
| **删** | `:1121-1124`（tab bar 5/4 项）、`:2389-2391` |
| **复用** | `:162-186` 闸门与白名单、`:279-309` 路由、`:1029-1030`（限定到管理台）、`:1064-1091` 管理台六路由、`:1125-1135`、`:2375-2376`、`:2385-2388`、`:2394-2395`、`:2405-2421` |
| **新增（建议）** | 公开四页都有侧栏且当前项指向本页 / 文章页高亮本篇 / 未登录 302 后 `next` 不变 / 用户下拉在无 JS 时仍可开（若 CSS-only）/ 管理后台入口对只读不可见 |

### 5.3 `src/views.ts`（接口面）

1. **`LayoutOptions` 要能带「公开侧栏数据」**：`sidebar: Array<{slug,title}>`（或 `posts`）与「当前 slug」。现在 `layout()` 签名只有 `(opts, site)`，且 `views.ts` 不读 store → 由 `server.ts` 传。**13 个 `layout()` 调用点**（6 个公开页 + 6 个管理台页 + 403/404 共用的 `forbiddenPage()`）都要处理：管理台可以不传或传空，但「不传」与「传空」应当是**同一个**显式值，不要靠 `undefined` 区分（那会造出第三种状态）。
2. **身份**：`csrf.ts` 只有 `currentIsAdmin()` / `currentUserId()`，**没有用户名**。用户胶囊要显示名，需新增 `currentUserName()`（或让 server 把 `{name, role}` 塞进 `LayoutOptions`）。
3. **`/password` 的落点**：`POST /password`（server.ts:1348）存在，但 `views.ts` 里**没有任何表单**。更糟：`views.ts:814-815` 的文案已经写着「改自己的口令请用『系统可用性』页上的那条入口」——而那个入口**不存在**。用户的「修改口令」菜单项必须先补一个 GET 落点（或把表单放进下拉/独立页）。
4. **tab bar 退场**：`tabBar()`（views.ts:173-183）、`ADMIN_ITEM`（:130）、`LayoutOptions.active` 里 `'admin'` 在 tab bar 的用途、以及 `layout()` 里的 `<nav class="tab-bar">`（:223）都要处理。`ADMIN_GROUPS` 继续被管理台 rail 与 `.admin-tabs` 使用，不能删。
5. **403/404 归属**：`forbiddenPage()`/`notFoundPage()` 目前都走 `layout()`。换装后要明确它们属于**公开外壳**（有顶栏 + 侧栏？还是只有顶栏）。这会影响 e2e:1093-1098。

### 5.4 `public/style.css`

| 区域 | 改动 |
| --- | --- |
| `:root`（:18-70） | 17 色换值 + 新增 `--font-display` / `--wrap-docs`；`--radius-lg` 16→12；`--rail-w` 248→260（或作用域覆盖） |
| 页头（:133-147） | 高度 56→60、加导航项样式、加胶囊样式；sticky 偏移从 56 改 60（`.site-rail{top:56px}`，:166） |
| 外壳（:151-157） | `.app-shell--docs` 修饰：宽 1180、栅格 `260px minmax(0,1fr)` |
| 侧栏（:165-188） | 公开侧栏换一套（分组标题 14/600、子项 14、圆角 12、当前项 2px 竖条）；管理台 rail 保留但换色 |
| tab bar（:191-205） | 整块删除（若确认移除） |
| 断点（:718-738 / :740-750） | 若改 819：新增/替换媒体查询；建议**保留 720/560 不动**（见冲突 C10） |
| 打印（:756-806） | 隐藏清单加顶栏导航/胶囊/公开侧栏，删 `.tab-bar` |

### 5.5 `CONTEXT.md`

| 词条 | 现状 | 要改成 |
| --- | --- | --- |
| **导航（navigation）**（:118-121） | 「全站只有一条导航：桌面 rail，手机 ≤720 折成底部 tab bar；管理台六模块是 rail 里的管理组」 | 公开面：顶栏四项 + 文章侧栏；管理台：顶栏 + rail + 模块条；tab bar 退场。当前项判据仍是 `aria-current="page"` |
| **主题（theme）**（:128-132） | 17 色 + `light-dark()` + 三态 | 机制不变，**值**改成暖白/陶土（若采纳草案） |
| **iOS 字阶**（:123-126） | 10 字号 + 4 行高 | 名字与数量可留，**值**改；可能要改名为「字阶（type ramp）」并去掉「iOS」 |
| **管理台**（:113-116） | 「模块之间走全站导航里的『管理』组」 | 管理组只在管理台外壳出现；公开面入口在用户下拉里 |
| 「刻意不做的选择」（:169-175） | 「不做运行时自定义主题」「不引图表库」 | 保持；但若采纳参考站的轻阴影，要在这里登记例外 |

### 5.6 管理台 rail（保留，但要跟着换皮）

- 结构不变：`ADMIN_GROUPS` 六模块 + 「运维 / 内容」两段 + `aria-current` 唯一当前项 + 手机 `.admin-tabs`。
- 视觉要跟同一套纸感：rail 底色从 `--bg` 变成同色 + 1px 暖线；当前项从「`--bg-card` 底 + accent 图标」改成「`--fill` 底 + 左侧 2px 竖条」（与公开侧栏同一语言，减少两套观感）。
- `--rail-w` 若从 248→260，`--wrap-admin: 1140px` 的等式要重算（`style.css:46` 的注释要一起改）。
- e2e 的六路由断言（1064-1079）**不用动**，只要 rail 还叫 `.site-rail`、当前项还是 `aria-current`。

### 5.7 文档

| 文件 | 动作 |
| --- | --- |
| `docs/ios-theme-architecture-decision.md` | 视觉部分被取代；把「17 色取值」标注为**已由新票取代**（机制仍有效） |
| `docs/ios-component-mapping-decision.md` | §5 导航（rail 唯一 / tab bar）与 §4 字阶被取代；§7 面板契约、§11 打印仍然有效 |
| `docs/admin-console-sidebar-decision.md` | 已被 #68 标注过一次「已被修订」；再补一行：管理台 rail 保留，但公开面不再是 rail |
| `CONTEXT.md` | 见 §5.5 |
| 新增（下游票产出） | token / 公开外壳 / 用户菜单三份决定书 |

---

## 6. 与票面假设冲突之处（显式）

> 这一节是本文最重要的部分。#82 的 Notes 里有一句「已核实的事实（直接用，不要重新论证）」——其中**两条是事实性错误**（C1 主色、C4 路由数），**四条是未写明的决策冲突**（C8 tab bar、C9 侧栏、C10 断点、C12 阴影），其余是需要在原型前补齐的边界（C2/C3/C5/C6/C7/C11/C13/C14）。不改这些，原型会照着错的数去画。

### C1. 「主色 `#CC785C`」——错。它不是主色，也从未渲染过。

- 参考站 `--primary-color: hsl(60,3%,8%)` ≈ `#151514`（近黑），`--secondary-color` ≈ `#73736D`。
- `#CC785C` 只出现在 `--header-subheader-background-color`，配套 `--header-subheader-font-color: #F0F0EB`；要生效必须有 `data-subheader="true"`。首页、集合页、文章页的 `<header>` **都没有**这个属性（三份 HTML 都查过）。
- 所以「陶土色强调」是**我们要新造的品牌选择**，不是复刻参考站。这一条不纠正，会导致「为什么参考站看起来没那么橘」的反复。

### C2. 「顶栏右侧导航」——对；但参考站**没有登录态、没有用户菜单、没有主题切换**。

用户胶囊 + 三态主题 + 「管理后台」入口在本图里都是**纯新增设计**，参考站给不了任何现成答案（它的顶栏只有 3 个外链 + 语言 + 搜索）。

### C3. 「参考站没有深色模式」——对，所以「深色等价映射」没有参考可抄。

6 个 CSS 文件 0 处 `prefers-color-scheme`。深色值只能按品牌推（本文 §4.3 是候选，不是事实）。#82 把「深色做等价映射」写进决定了，那就要接受「深色是自造的」这件事，并在验收里目视过一遍。

### C4. 「12 条路由」——**不对，是 13 条**（12 条 `layout()` + 1 条独立登录页）。

票面把 `/tags/:tag` 并进 `/posts`（或把 `/admin` 与 5 个模块合成一句）就会得到 12。但它们是**独立的 GET 注册点**：`/tags/:tag` 也要长侧栏与当前项，`/admin` 与 5 个模块各有自己的 `adminSection`。另外**还有 3 条不套外壳的路由**（`/media/:name`、`/api/status`、`/healthz`）和 403/404（走 `layout()`）。逐条见 §1.3。

### C5. 「403/404 也走 layout()」——对，但两者**不传 `active`，所以没有任何当前项**。

换装后要回答一个票面没问的问题：**403/404 属于公开外壳还是管理台外壳？** 它现在是「共享的第三个外壳状态」（`page-error`），既没有顶栏导航的当前项，也没有侧栏当前项。若不决定，e2e:1093-1098 那条「403 有 rail」会先红。

### C6. 「当前没有修改口令的页面入口」——对，而且比票面写的更糟：文案已经在撒谎。

`views.ts:814-815` 的账号页文案写着「改自己的口令请用『系统可用性』页上的那条入口」，而 `statusPage()` 里**根本没有这个表单**，`views.ts` 里也没有任何 `action="/password"`。用户菜单要加「修改口令」，就得**先补一个落点**（下拉内联表单 / 独立页 / 面板上的入口三选一），这不是「把已有入口挪进菜单」。

### C7. 「管理台保留现有 rail，同时也有顶栏」——对，但现状**本来就有顶栏**。

`layout()` 对所有页面都渲染 `.site-header`，管理台只是多了 rail 与 `.admin-tabs`。所以这一条不是「新增顶栏」，而是「**换掉顶栏内容**（加公开四项 + 胶囊）」。区别很重要：不涉及外壳分支，只涉及页头片段。

### C8. 「移动端移除底部 tab bar」——对，但它与**文档 + 两组断言**冲突，必须同批改。

- `CONTEXT.md:118-121`（导航词条）把 tab bar 写成了定义的一部分。
- `docs/ios-component-mapping-decision.md` §5.2 整节在讲 tab bar。
- `style-check:336/341/343`、`e2e:1121-1124/2381-2391` 钉着它。
- 结论：删 tab bar 是一次**显式修订**（像 #68 修订 #58 那样写在决定书里），不能「顺手删」。

### C9. 「公开侧栏在所有公开页常驻」——这是改动面最大的一条，票面低估了。

它同时撞上：`style-check:331`（rail 唯一）、`:339`（两列）、`:341`（移动折叠）、`e2e:1100-1114`（公开页 rail 条数），以及 **`layout()` 的数据接口**（现在根本没有「文章列表」入参）。后一条是架构级改动：要在 `server.ts` 的 6 个公开路由里都查一次文章列表并传进视图（或给 `layout()` 一个可选字段并接受「某些页没有侧栏」——不建议）。

### C10. 断点：参考站是 819 / 1099，本仓制度是 720 / 560。

- `style.css:715-717` 的注释明确写着「两个断点，别再加第三个：720 与 560」。
- `style-check:380/382` 把这两个断点**钉成断言**。
- 若照搬参考站断点，要改 2 条断言 + 那条注释，并解释「为什么加断点」。
- 【取舍】我倾向**保留 720/560**：我们的导航项只有 4 个，顶栏在 720px 还有空间；819 是参考站为了放搜索框+语言选择器才需要的。

### C11. 圆角：参考站卡片是 12px，本仓 `--radius-lg: 16px`。

`--radius: 12px` 恰好一致，但**卡片化的容器用的是 `--radius-lg`（16）**：`.inset-list`（style.css:216）、`.stat`（:397）、`.create-card`（:243）、`.article-editor`（:631）、`.empty`（:301）都是 16；只有 `.card`（:309）用的是 `--radius`（12）。要像参考站就得把 `--radius-lg` 降到 12 —— 值改动，但影响所有列表/卡片/编辑器，属于「换装」范围，不是纯 token。

### C12. 阴影：参考站有极轻阴影，本仓明确「不做阴影」。

`docs/ios-component-mapping-decision.md` §4.6：「不做阴影，层级靠底色差 + hairline」。参考站的 `--card-shadow: 0 1px 2px 0 rgb(0 0 0 / .05)` 若照抄，① 违反那条决定，② 撞 `style-check:145`（颜色字面量只许在 `:root`/打印）。要抄就得显式修订 §4.6，并把阴影色做成 token（17 色预算又不允许）。**建议不抄**——参考站的卡片本来也主要靠 1px 边和底色差分层。

### C13. 顶栏高度别抄错：`--header-height: 245px` 是死值。

参考站内联样式有 `#header{--header-height:245px}`，但页面里**没有 `id="header"` 的元素**。渲染出来的顶栏是 **60px**（`.DocsTopBar_bar`）。245 是旧版 hero 头的遗留变量。

### C14. 字体：`AnthropicSerif`/`AnthropicSans` 不能下载、不能自托管、不能热链。

#82 的约束里已经写了「不新增外部字体」，本文只是补一条事实：参考站自己托管了这些文件，但那是它的授权范围，不是我们的。衬线只能系统栈近似（§3.4），并且**中文衬线在 Windows 上是宋体**，小字号发虚 —— 所以衬线只给 ≥20px 的标题，正文保持无衬线。

---

## 7. 未验证 / 风险

| 项 | 说明 |
| --- | --- |
| 参考站的**目视观感** | 本文只读 HTML/CSS，**没有用浏览器截图或量布局**；所有尺寸来自 CSS 声明，不排除被内联样式或 JS 覆盖 |
| 参考站的**字体渲染** | 没装 Anthropic 字体，无法判断它在真机上的字重与字距观感；系统衬线栈的近似效果需要原型票目视 |
| 深色等价映射 | 没有参考；本文的深色值是按页脚 `#141413` 推的，必须目视复核 |
| 系统衬线在 Windows 上的中文回退 | 【不确定】宋体在大字号下的可用性；Georgia 与宋体的 x-height 差异会让中英混排的基线看起来跳 |
| `fixed` 顶栏的打印行为 | 现顶栏是 `sticky`，打印块靠 `display:none` 处理；若改 `fixed` + `body` 占位，打印时占位块要一并清掉（否则第一页顶部会多一条空白） |
| 断点改动的观感 | 720 → 819 之间的 360–818px 区间没有真机验证；#59 的经验是必须用 CDP `setDeviceMetricsOverride` 精确设视口 |
| 用户下拉的键盘行为 | 「hover / focus / 点击三开」在没有 JS 的前提下要靠 `:hover` + `:focus-within` + `<details>` 组合，状态可能打架（鼠标移开但 `details` 仍开）。这是 #87 的题目，本文不给实现 |
| 文章侧栏的规模 | 现在只有几篇文章；几十篇之后要不要分组/折叠/分页，地图已列为「未定」，本文不展开 |

---

## 8. 来源

**本仓（逐行核对）**

- `src/views.ts`（1520 行）：`layout()` 195-232、`themePicker()` 91-97、`themeBoot()` 100-102、`themeScript()` 105-107、`NAV_ITEMS` 124-129、`ADMIN_ITEM` 130、`ADMIN_GROUPS` 137-149、`railLink()` 152-156、`rail()` 159-170、`tabBar()` 173-183、`adminTabs()` 186-193、`forbiddenPage()` 248-274、`loginPage()` 905-943、`postCard()` 945-958、`postPage()` 1076-1091、`notFoundPage()` 1274-1277。
- `public/style.css`（807 行）：`:root` 18-70、页头 133-147、外壳 151-157、rail 165-188、tab bar 191-205、文章/`.prose` 317-387、登录页 520-563、控件 684-713、断点 715-750、打印 752-806。
- `scripts/style-check.mjs`（415 行；运行 **171/171**）。
- `scripts/e2e-check.mjs`（2435 行；运行 **536/536**）。
- `src/server.ts`（1470 行）：路由注册 497-1428、闸门 416、`/password` 1348、`setNotFoundHandler` 1425。
- `src/auth.ts`：`PUBLIC_PATHS` 30-43、`KNOWN_PAGES` 45-62、`isKnownPath()` 64-72。
- `src/csrf.ts`：`currentCsrfToken()` 34、`currentIsAdmin()` 43、`currentUserId()` 56（**无用户名字 accessor**）。
- `src/icons.ts`：7 个图标（无 `menu` / 无用户图标）。
- `CONTEXT.md`：导航 118-121、字阶 123-126、主题 128-132、管理台 113-116。
- `docs/ios-theme-architecture-decision.md`（17 色 / `light-dark()` / 三态 / 对比度表）。
- `docs/ios-component-mapping-decision.md`（§5 导航、§4 字阶、§7 面板契约、§11 打印）。
- `docs/admin-console-sidebar-decision.md`（管理台 rail；已带一次「已被修订」标注）。
- `docs/research/apple-hig-web.md`（本文的写法与「事实 / 取舍 / 不确定」约定沿用自它）。

**参考站（2026-10-21 抓取，只读，未下载字体）**

- <https://support.claude.com/>（首页）、<https://support.claude.com/en/articles/9015913-how-to-get-support>（文章页）、<https://support.claude.com/en/collections/4078531-claude>（集合页）。
- 内联主题：`<style id="__jsx-3643504029">` 的 `:root`（底色/边框/页脚/陶土副头带/卡片圆角/阴影/`--header-height`）。
- 字体声明：`<style id="__jsx-1959275087">`、`__jsx-1148311373`、`__jsx-426406894`（Serif 400/500/600）；`__jsx-1023138944`、`__jsx-4283962659`、`__jsx-110214924`、`__jsx-669161996`、`__jsx-3239542441`（Sans 700/italic/500/400/600）；`__jsx-1746666974` / `__jsx-3355093836`（`--font-family-primary/secondary`）。
- `https://static.intercomassets.com/_next/static/css/fe3431c5c27bda33.css`：`.tokens_docsRoot__1XQPC`（token 全集）、`.DocsTopBar_*`、`.DocsSidebar_*`、`.DocsShell_*`、`.DocsArticle*`、`.DocsArticleBody_*`。
- `https://static.intercomassets.com/_next/static/css/b6a44ee60459e446.css`：Tailwind 工具类（`bg-footer-bg`、`text-footer-color`）与 Intercom 组件。
- 其余 4 个 CSS：`a36d49340c3b5f22`、`aca6b59773c71079`、`b116545afd082284`、`c3ba261aae91eb22`（组件级细节，未逐条引用）。

**规范**

- WCAG 2.2：1.4.3 对比度（文字 4.5:1）、1.4.11 非文字对比度（3:1）——本文所有比值均按相对亮度公式手算后与脚本口径对齐（`style-check.mjs:76-86` 的 `luminance` / `contrast`）。
