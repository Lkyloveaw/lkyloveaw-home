# 公开面外壳与文章侧栏：DOM / 行为契约（B · 紧凑工作台）

> 票：[#86 落地设计：公开面外壳与文章侧栏的导航契约](https://github.com/Lkyloveaw/lkyloveaw-home/issues/86)（父地图：[公开面换装](https://github.com/Lkyloveaw/lkyloveaw-home/issues/82)）
> 上游：[#85 token / 字阶](https://github.com/Lkyloveaw/lkyloveaw-home/issues/85) → `docs/claude-theme-decision.md`；[#84 原型](https://github.com/Lkyloveaw/lkyloveaw-home/issues/84) → 用户选定 **B · 紧凑工作台**
> 本票**只出契约，不写产品代码**。实现由 #88 切批次；用户胶囊 / 下拉 / 账户入口归 #87。
> Grilling 记录：2026-10-22，6 个分叉全部按推荐选定（见 §1）。

## 0. 一句话结论

**公开面 = 56px sticky 不透明顶栏（brand + 四项 + 胶囊槽 + 手机 `<details>` 抽屉）+ 224px 文章侧栏（所有公开内容页常驻，扁平日期倒序、无计数）+ 1360px 外壳。**

- 管理台：**同一公开顶栏 + 左侧 rail + 手机 `.admin-tabs` 模块条**；顶栏不标当前项，rail 标。
- 403 / 404：**只有顶栏，没有文章侧栏**；顶栏也没有当前项。
- 移动端：**没有底部 tab bar**；抽屉是 `<details>` disclosure，不写读面 JS。
- 登录页：仍是唯一独立外壳（无顶栏 / 侧栏 / 抽屉 / 胶囊）。

> 与 B 原型的三处有意差异：**侧栏不显示计数**、**403/404 不带侧栏**、**抽屉用 `<details>` 而不是 JS modal**。其余尺寸与 B 一致（56 / 224 / 28 / 1360）。

---

## 1. 本次敲定的六个分叉

| # | 分叉 | 决定 |
| --- | --- | --- |
| 1 | 顶栏 sticky / fixed / 半透明 | **sticky + 不透明**；56px；当前项 `aria-current` + 2px accent 下划线；登录页无长顶栏 |
| 2 | 管理台顶栏 / 模块条 | **同一公开顶栏**（四项 + 胶囊，无当前项）+ **保留** `.admin-tabs` 模块条 |
| 3 | 403 / 404 外壳 | **只有顶栏，不带文章侧栏**；无当前项；正文居中 + 回首页 / 回上一页 |
| 4 | 文章侧栏列表形态 | **扁平、日期倒序、无计数**；不分组、不置顶；只有文章页高亮当前篇；sticky + 独立滚动；空态一句 |
| 5 | 标签页侧栏 | `/tags/:tag` 的侧栏**列全部已发布文章**；标签只过滤主列表 + chip 高亮 |
| 6 | 移动抽屉 | **`<details>` disclosure，无读面 JS**；公开页 = 四项 + 文章索引，管理台 = 四项（模块条另在 `.admin-tabs`）；无 focus trap / Esc / 点外关闭 |

---

## 2. 路由 × 外壳矩阵

全站 13 条 HTML GET 路由（12 走 `layout()` + `/login` 独立），再加 403/404 两个错误处理。

| 路由 | 视图 | 外壳 | 顶栏当前项 | 公开侧栏 | rail | 侧栏当前文章 |
| --- | --- | --- | --- | --- | --- | --- |
| `/` | `homePage` | 顶栏 + 公开侧栏 | `home` | 有（全量） | — | — |
| `/posts` | `postsPage` | 顶栏 + 公开侧栏 | `posts` | 有（全量） | — | — |
| `/tags/:tag` | `postsPage`（过滤主列表） | 顶栏 + 公开侧栏 | `posts` | 有（全量） | — | — |
| `/posts/:slug` | `postPage` | 顶栏 + 公开侧栏 | `posts` | 有（全量） | — | **当前 slug** |
| `/status` | `statusPage` | 顶栏 + 公开侧栏 | `status` | 有（全量） | — | — |
| `/about` | `aboutPage` | 顶栏 + 公开侧栏 | `about` | 有（全量） | — | — |
| `/login` | `loginPage` | **独立** | — | 无 | — | — |
| `/admin` | `adminOverviewPage` | 顶栏 + rail | 无 | 无 | `overview` | — |
| `/admin/targets` | `adminTargetsPage` | 顶栏 + rail | 无 | 无 | `targets` | — |
| `/admin/accounts` | `adminAccountsPage` | 顶栏 + rail | 无 | 无 | `accounts` | — |
| `/admin/backups` | `adminBackupsPage` | 顶栏 + rail | 无 | 无 | `backups` | — |
| `/admin/settings` | `adminSettingsPage` | 顶栏 + rail | 无 | 无 | `settings` | — |
| `/admin/articles` | `adminArticlesPage` | 顶栏 + rail | 无 | 无 | `articles` | — |
| 403（任意来源） | `forbiddenPage` | **顶栏 only** | 无 | 无 | — | — |
| 404（未知路径 / 文章未命中） | `notFoundPage` | **顶栏 only** | 无 | 无 | — | — |

> `/media/:name`、`/api/status`、`/healthz` 不套外壳，保持不变。

### 2.1 `LayoutOptions` 的新形状

`sidebar` **必填**，用 `null` 表示「这一页没有公开文章侧栏」；不要让 `undefined` 变成第三种状态。

```ts
export interface PublicSidebar {
  /** 只含已发布文章；顺序就是 /posts 的日期倒序。 */
  posts: Array<{ slug: string; title: string }>
  /** 仅文章页传；侧栏据此标 aria-current="page"。 */
  currentSlug?: string
}

export interface LayoutOptions {
  title: string
  description: string
  /** 只允许四个公开项；管理台 / 错误页不传。 */
  active?: 'home' | 'posts' | 'status' | 'about'
  adminSection?: AdminSection
  /** 公开内容页传数据；管理台 / 403/404 传 null。 */
  sidebar: PublicSidebar | null
  body: string
  bodyClass?: string
}
```

外壳分支：

```ts
const shellClass = opts.sidebar
  ? 'app-shell app-shell--docs'
  : opts.adminSection
    ? 'app-shell app-shell--admin'
    : 'app-shell app-shell--plain'
```

- `app-shell--docs`：`224px minmax(0,1fr)`、`--wrap-docs: 1360`。
- `app-shell--admin`：`--rail-w: 248px minmax(0,1fr)`、`--wrap-admin: 1140`。
- `app-shell--plain`：block；`--wrap: 900`；403/404 用。
- 主列统一 `<main class="app-main">`，**不再套 `.wrap`**；`.wrap` 只留给登录 / 页脚 / 错误页的居中容器。`.app-shell--docs .app-main` 的宽度由 1068 主列决定，`.app-shell--admin` 由 832 决定。

### 2.2 13 个调用点要传什么

| 调用点 | `sidebar` | `active` | `adminSection` |
| --- | --- | --- | --- |
| `homePage` | `{ posts: 全量 }` | `home` | — |
| `postsPage` | `{ posts: 全量 }` | `posts` | — |
| `/tags/:tag` | `{ posts: 全量 }`（主列表另外过滤） | `posts` | — |
| `postPage` | `{ posts: 全量, currentSlug: post.slug }` | `posts` | — |
| `statusPage` | `{ posts: 全量 }` | `status` | — |
| `aboutPage` | `{ posts: 全量 }` | `about` | — |
| 6 个管理页 | `null` | 不传 | 各自的 section |
| `forbiddenPage` / `notFoundPage` | `null` | 不传 | — |

- 公开页的 `全量` 来自 `server.ts` 的 `listPublishedPosts()`；`views.ts` 仍然零 store 依赖。
- `/`, `/posts`, `/tags`, `/posts/:slug` 本来就有文章查询；`/status`, `/about` 需要新增一次 `listPublishedPosts()`（SQLite 小表，可接受）。
- `/posts` 与 `/tags/:tag` 共用 `postsPage()` **同一个 `layout()` 调用点**：两者都传全量 `sidebar`，主列表分别全量 / 按 tag 过滤。所以「13 个调用点」是 5 个公开视图函数 + 6 个管理页 + `forbiddenPage` + `notFoundPage`，不是 14 个。
- 管理台与 403/404 不查文章；`sidebar: null`。
- `active` 的联合类型**删掉 `'admin'`**；6 个管理页不再传 `active`。`adminSection` 继续决定 rail / `.admin-tabs` 的当前项。
- `tabBar()` 与 `ADMIN_ITEM` 随底部 tab bar 一起删除；`ADMIN_GROUPS` 保留（rail + `.admin-tabs` 还用）。

---

## 3. 顶栏契约

### 3.1 DOM

```html
<header class="site-header">
  <div class="header-inner">
    <a class="brand" href="/">
      <span class="brand-mark" aria-hidden="true"><!-- 占位 SVG mark --></span>
      <span class="brand-name">{site.title}</span>
    </a>

    <nav class="top-nav" aria-label="主导航">
      <a href="/" aria-current="page">首页</a>
      <a href="/posts">分享</a>
      <a href="/status">系统可用性</a>
      <a href="/about">关于</a>
    </nav>

    <div class="header-actions">
      <!-- 手机：<details class="nav-drawer">…</details>（§5） -->
      <!-- #87：用户胶囊 / 下拉（替换当前的 theme picker + 登出） -->
    </div>
  </div>
</header>
```

- **不新增 `.site-nav`**（`style-check:248` 禁用）；新类名是 `.top-nav`。
- 品牌：`brand-mark` 是占位 SVG（内联、`aria-hidden`），`brand-name` 来自设置里的站名；本期不上传 logo。
- 顶栏四项来自 `NAV_ITEMS`，文本链接，无图标；当前项唯一，`aria-current="page"` + 2px accent 下划线（accent 落在 `--bg` 上，3.11:1）。
- 顶栏是 **sticky + 不透明**：`background: var(--bg)`、`border-bottom: 1px solid var(--separator)`、`min-height: var(--header-h)`（56px）、`z-index: 20`；**没有 `backdrop-filter`**。`.header-inner { max-width: var(--wrap-docs); padding-inline: 20px; }`，与公开主列对齐；管理台 / 错误页仍用这条全宽顶栏（内容列分别是 1140 / 900）。
- 登录页没有 `.site-header`；`loginPage()` 仍是独立外壳。
- 管理台 / 403 / 404 也用同一个 `.site-header`；它们的 `active` 不传，所以 `.top-nav` 里没有当前项（见 §9 计数表）。
- **`#87` 的槽位**：`.header-actions` 最终放用户胶囊 + 手机抽屉开关；主题 picker 与登出从页头移进胶囊。若 #86 先落地、#87 后落地，过渡期**保留现有 theme picker + 登出**，不要把页头清空；#88 的切分要把这两张排在一起。

### 3.2 当前项与 aria

- `.top-nav` 里**恰好一个** `aria-current="page"`（公开六页）；管理台 / 403 / 404 **零个**。
- 文章页的 `<main>` 里侧栏还有**一个** `aria-current="page"`（当前文章）；手机抽屉由于 SSR 也会带一份 top-nav 当前项（以及文章页的当前文章），所以文章页全页 `aria-current` 总数是 **4**（顶栏 / 侧栏 / 抽屉导航 / 抽屉文章），其余公开页是 2。所有断言必须**分容器**统计（`.top-nav` / `.docs-side` / `.site-rail` / `.nav-drawer`），不要用全页计数。
- 当前项文字走 `--label` + 600；不要用 accent 做文字色。
- 品牌链接指向 `/`；不参与 `aria-current`。

### 3.3 窄屏折叠

- `≤720px`：隐藏 `.top-nav`，显示汉堡 `<summary>`；胶囊保留（≤560 只留头像，名字由 #87 决定）。
- 抽屉在顶栏内，展开后从 `--header-h` 下面开始；不压缩顶栏高度。
- 不新增 819 / 1099 断点。

---

## 4. 文章侧栏契约

### 4.1 DOM

```html
<nav class="docs-side" aria-label="公开文章">
  <p class="docs-side-title">文章</p>
  <ul class="docs-side-list">
    <li><a href="/posts/slug" aria-current="page">标题</a></li>
    <!-- …只含已发布文章，日期倒序 -->
  </ul>
  <!-- 或空态：<p class="docs-side-empty">还没有已发布的文章。</p> -->
</nav>
```

- 语义是 `<nav aria-label="公开文章">`；**不是**第二条 `.site-rail`（`.site-rail` 只留给管理台 rail）。
- 组标题是纯文本 `文章`，不是链接、不带计数；`/posts` 的入口是顶栏「分享」。
- 列表只含已发布文章；草稿 / 回收站 / 未发布永不出现。数据来自 `listPublishedPosts()`，**顺序就是日期倒序**，不额外排序、不置顶、不分组。
- 当前文章高亮：`aria-current="page"` + `--label` + `background: var(--bg-card)` + 2px accent 竖条（accent 落在 `--bg-card` 上，3.17:1）。只在 `/posts/:slug` 出现，其他公开页零个。
- 侧栏在**六个公开内容页**常驻：`/`, `/posts`, `/tags/:tag`, `/posts/:slug`, `/status`, `/about`。
- 标签页：侧栏列**全部**已发布文章；主列表按 tag 过滤；顶栏「分享」是当前项；侧栏没有当前文章。
- 空态：一条 `还没有已发布的文章。`；主列表自己的空态文案保留。
- 独立滚动 + sticky：`position: sticky; top: var(--header-h); max-height: calc(100vh - var(--header-h)); overflow-y: auto;`；`border-inline-end: 1px solid var(--separator)`；`≤720` 隐藏。
- **不进**管理台、`/login`、403/404；也不在打印里出现。
- 样式取自 #85：标题 `--fs-caption` / 600 / `--label-2`（不是 `--label-3`）；链接 `--fs-subhead` / `--label-2`；当前项 `--label`；不要显示计数。

### 4.2 数据流

```
server.ts  listPublishedPosts() ──► {slug,title}[] ──► PageFn(..., sidebar) ──► layout({sidebar})
                                                                  │
管理台 / 403/404 ────────────────────────────────► layout({sidebar:null})
```

- `views.ts` 只接收 `{slug,title}` 数组，不 import store。
- `sidebar` 必填是**类型级防漏**：13 个调用点少传一个，`tsc` 直接报错。
- 主页的「最近分享」仍取前 4 篇；侧栏取全量。
- 文章页 `currentSlug` 由 server 传（`post.slug`）；侧栏渲染时匹配，不在视图里重新查库。

---

## 5. 移动端抽屉（`<details>`，无读面 JS）

### 5.1 DOM

```html
<details class="nav-drawer">
  <summary class="drawer-toggle" aria-label="菜单"><!-- 汉堡 SVG --></summary>
  <div class="drawer-panel">
    <nav class="drawer-nav" aria-label="主导航（手机）">
      <a href="/" aria-current="page">首页</a> …
    </nav>
    <div class="drawer-articles">
      <p class="drawer-articles-title">文章</p>
      <ul>… 与侧栏同一份数据 …</ul>
    </div>
  </div>
</details>
```

- **公开页**：四项 + 文章索引（同一份 `sidebar.posts`；文章页也标当前文章）。
- **管理台**：只放四项；模块条继续由 `.admin-tabs` 承担（不重复进抽屉）。
- **403 / 404**：只放四项（没有 `sidebar` 数据）。
- `/login`：没有抽屉。
- 桌面：`.nav-drawer { display: none; }`；`≤720` 显示 summary、隐藏 `.top-nav`。

### 5.2 行为与边界

- 开合是原生 `<details>`：点 summary 开 / 再点关；**没有** `aria-expanded` 属性（原生开放状态由浏览器暴露）；e2e 检查 `details.nav-drawer[open]` 或标记结构。
- **不写读面 JS**：没有 Esc 关闭、没有点外关闭、没有 focus trap。summary 始终在顶栏，用户始终有一个关闭控件。这是本次明确的取舍。
- 面板：`position: fixed; top: var(--header-h); inset-inline: 0; max-height: calc(100vh - var(--header-h)); overflow-y: auto; background: var(--bg); border-bottom: 1px solid var(--separator); z-index: 40;`；不做半透明、不做遮罩层。
- 可选 CSS：`body:has(.nav-drawer[open]) { overflow: hidden; }`；`@supports not (selector(:has(*)))` 时退化为页面可滚，不影响开合。
- 抽屉链接 44px 高；当前项 `aria-current` + 2px accent 竖条（落在 `--bg-card`）；没有计数。
- 删除 `.tab-bar`、`tabBar()`、`ADMIN_ITEM`；`.admin-tabs` 保留。

---

## 6. 403 / 404

- 外壳：`.app-shell--plain`；**只渲染 `.site-header`，不渲染 `.docs-side` / `.site-rail` / `.admin-tabs`**。
- `forbiddenPage()` / `notFoundPage()` 调 `layout({ sidebar: null, active: undefined, bodyClass: 'page-error' })`；没有 `adminSection`，所以 403 也不再显示管理 rail。
- 顶栏：四项 + 胶囊；**零个当前项**；品牌仍指向 `/`。
- 正文：居中，`max-width: 540px` 左右；保留现有文案（「需要管理员权限」「这个页面不存在」）和回首页 / 回上一页链接。
- 403 的三种 kind（origin / csrf / admin）共用这个外壳；CSRF 的「回上一页」仍用 `backPath`。
- 404 的文章未命中（`/posts/:slug`）也走这个外壳，不带侧栏。
- 打印：顶栏隐藏，错误正文照常打印。

---

## 7. 管理台

- 外壳：`.app-shell--admin`；同一个 `.site-header` + `.site-rail` + `.app-main`。
- 顶栏：公开四项 + 胶囊；**没有当前项**（`active` 不传）；「管理后台」入口只在胶囊里（#87），公开侧栏没有管理组。
- rail：`ADMIN_GROUPS` 的「运维 5 + 内容 1」；当前项仍是 `adminSection`；`aria-current="page"` 恰好一个（在 rail 里）。
- 手机：`.site-rail` 隐藏；`.admin-tabs` 模块条出现（保留）；抽屉只有四项；没有底部 tab bar。
- 公开文章侧栏**不进**管理台；`.docs-side` 在管理台为 0。
- 顶栏的「分享 / 系统可用性 / 关于」点击会离开管理台，这是预期行为；管理台没有额外的「返回公开站」链接（胶囊里的品牌 / 管理后台已够）。

---

## 8. 打印

- 隐藏：`.site-header`、`.docs-side`、`.site-rail`、`.admin-tabs`、`.nav-drawer`、`.header-actions`、`.site-footer`。
- 外壳退回单列：`.app-shell, .app-shell--docs, .app-shell--admin, .app-shell--plain { display: block; max-width: none; padding: 0; }`；`.app-main { max-width: none; padding: 24px 0 0; }`。
- `.wrap` / `.prose` 放开限宽；`.prose .table-wrap { overflow: visible; }`。
- 保留：卡片 / 行 `break-inside: avoid`；站内链接 `a[href^="/"]::after`；状态格带图案（up 实心 / degraded 45° / down 斜网格 / missing 空心）。
- 17 个灰阶 token 与 `font-size: 11pt; line-height: 1.5` 来自 #85；打印块里不得出现 `light-dark()`。

---

## 9. 当前项计数契约（e2e 必须按容器统计）

| 页面 | `.top-nav` 当前项 | `.docs-side` 当前项 | `.site-rail` 当前项 | `.nav-drawer` 导航 | `.nav-drawer` 文章 |
| --- | --- | --- | --- | --- | --- |
| `/` | 1（首页） | 0 | 0 | 1（首页） | 0 |
| `/posts` | 1（分享） | 0 | 0 | 1（分享） | 0 |
| `/tags/:tag` | 1（分享） | 0 | 0 | 1（分享） | 0 |
| `/posts/:slug` | 1（分享） | **1（当前文章）** | 0 | 1（分享） | **1（当前文章）** |
| `/status` | 1（系统可用性） | 0 | 0 | 1（系统可用性） | 0 |
| `/about` | 1（关于） | 0 | 0 | 1（关于） | 0 |
| 6 个管理页 | 0 | 0 | **1（模块）** | 0 | 0 |
| 403 / 404 | 0 | 0 | 0 | 0 | 0 |
| `/login` | 没有顶栏 | 0 | 0 | 没有抽屉 | 0 |

> 全页 `aria-current` 总数：公开页 2（文章页 4：顶栏 + 侧栏 + 抽屉导航 + 抽屉文章）；管理台 1（rail）；403/404 0；登录 0。永远按容器统计，不要用全页 `querySelectorAll('[aria-current]')`。

---

## 10. e2e / style-check 迁移清单

### 10.1 `scripts/e2e-check.mjs`（当前 536 条）

**助手（:79-84）**

- 保留 `railOf` / `currentOf`（只给管理台）。
- 新增 `topNavOf(html)`、`docsSideOf(html)`、`currentInTopNav(html)`、`sidebarLinks(html)`。
- 删除 `tabOf` / `tabItems`（随 `.tab-bar` 退场）。

**改写 / 删除 / 新增**

| 当前行 | 现在断言 | 动作 |
| --- | --- | --- |
| 1053-1057 | 只读顶栏四项、无「管理」 | 改为 `.top-nav` 四项；「管理」检查限定 `.top-nav`（胶囊由 #87） |
| 1064-1079 | 管理台六页 rail 当前项 | **保留**（rail 仍是唯一模块导航） |
| 1093-1098 | 403 有 rail、无管理组 | **改写**：403 有 `.site-header`，**没有** `.docs-side` / `.site-rail`；零当前项；文案仍是「需要管理员权限」 |
| 1100-1118 | 公开页 rail 10/4 条 | **改写**：公开页 `.top-nav` 4 条 + `.docs-side` 6 条；顶栏当前项 1；没有管理组；`/status` 当前项指向 `/status` |
| 1121-1124 | tab bar 管理员 5 / 只读 4 | **删除**；换成「`.nav-drawer` 存在 + 公开页四项 + 六篇文章；管理台四项」的 SSR 结构断言 |
| 1125-1129 | 管理台有 `.admin-tabs`、公开页没有 | **保留** |
| 2381-2384 | 所有页面有 rail + tab bar | **改写**：公开页有 `.site-header` + `.top-nav` + `.docs-side`；管理台有 `.site-header` + `.site-rail`；**没有 `.tab-bar`** |
| 2385-2388 | 每页 rail 当前项恰好 1 | **拆分**：公开页 `.top-nav` 恰好 1；文章页 `.docs-side` 恰好 1；管理台 `.site-rail` 恰好 1；403/404 全 0 |
| 2389-2391 | 管理台 tab bar 有「管理」 | **删除** |
| 2394-2395 | 首页/分享列表的 `.cell.post-card` | **保留**（内容块不变；外壳只在外面套侧栏） |
| 2403-2407 | 有 720 断点与打印块 | **保留**；打印块断言更新选择器 |
| 2410-2421 | 主题三态 / picker 两处 | **保留**；picker 两处仍成立（#87 把页头那一个移进胶囊，总数不变） |

**新增 e2e（建议）**

1. 六条公开内容页都有 `.docs-side`，且侧栏文章数 = `listPublishedPosts()`；草稿 / 回收站标题不出现。
2. 文章页 `.docs-side a[aria-current="page"]` 恰好 1，href 指向当前 slug；其他公开页 0。
3. `/tags/:tag` 主列表只含该 tag，侧栏仍是全量；顶栏当前项「分享」。
4. 空文章状态：`/posts` 主列表空态 + `.docs-side-empty`；顶栏仍四项。
5. 403 / 404：`.site-header` 存在；`.docs-side` / `.site-rail` / `.tab-bar` 都不存在；零 `aria-current`。
6. 管理台六页：`.site-header` + `.site-rail`；`.docs-side` 0；`.top-nav` 0 当前项；`.admin-tabs` 在 SSR 里。
7. 手机抽屉 SSR：`.nav-drawer` + `.drawer-panel` + 四项导航 +（公开页）六篇文章；管理台四项；没有 `.tab-bar`。
8. 打印 CSS：隐藏 `.site-header` / `.docs-side` / `.site-rail` / `.nav-drawer`；`.app-shell--docs` 单列。
9. 顶栏无半透明：`background: var(--bg)` 且无 `backdrop-filter`（现有 1134-1135 保留）。

### 10.2 `scripts/style-check.mjs`（#85 后约 170 条）

| 当前段 | 行 | 动作 |
| --- | --- | --- |
| token 表 | 120-158 | #85 已改：17 色 + 29 非色；本票加 `--header-h` / `--side-w` / `--wrap-docs` 已在 #85 |
| 类名 | 211-251 | 新增 `.top-nav` / `.docs-side` / `.nav-drawer` / `.drawer-panel` / `.docs-side-empty` / `.app-shell--docs` / `.app-shell--plain`，都要有 CSS 定义；`.site-nav` 仍禁用 |
| 排版 | 254-290 | #85 已改；本票只确认 `.top-nav` / `.docs-side` 用 #85 的字号 / 行高 |
| 主题三态 | 293-303 | 保留 |
| 打印 | 306-323 | 保留 17 灰阶 / 图案；隐藏清单换成 `.site-header` / `.docs-side` / `.site-rail` / `.nav-drawer` |
| 外壳 | 326-344 | **整段改写**： |
|  | 331 | `.site-rail` 唯一 → 公开 `.docs-side` 唯一 + 管理 `.site-rail` 唯一；删除「全站唯一 rail」 |
|  | 333-334 | 管理组 / 两段 sub-label 保留（rail） |
|  | 336 | **删除**「tab bar 与 rail 同源」 |
|  | 337 | `.admin-tabs` 只 adminSection 保留 |
|  | 338 | `.site-header` 不透明保留；加 `min-height: var(--header-h)` |
|  | 339 | 外壳两列 → `--docs` 的 `var(--side-w) minmax(0,1fr)` + `--admin` 的 `var(--rail-w) minmax(0,1fr)` |
|  | 341 | 720：`.docs-side` / `.site-rail` 隐藏、`.nav-drawer` 出现、**无** `.tab-bar` |
|  | 343 | 打印隐藏 `.site-header` / `.docs-side` / `.site-rail` / `.nav-drawer` |
| 公开面 | 346-358 | `.large-title` 权重由 #85 改；`.empty` 实色块保留；`.post-card` 内容块保留；不要新增「全站 rail」断言 |
| 管理 / 窄屏 / 面板 | 361-405 | 保留；`--rail-w: 248`、`.admin-tabs`、720/560、`CELL_STRIP_LEN`、图表纸纹、`.dot.unknown` 描边（#85） |

**新增 style-check（建议）**

1. 公开六页的 `layout()` 输出 `.app-shell--docs` + `.docs-side`；管理台 `.app-shell--admin`；403/404 `.app-shell--plain`。
2. `.docs-side` 是 `<nav aria-label="公开文章">`，且不含 `管理` 文本 / `rail-group-label`。
3. `.top-nav` 只有 `NAV_ITEMS` 四项；`.top-nav` 不用 `.site-nav`。
4. 文章页 `.docs-side` 恰好一个 `aria-current`；其他公开页零个。
5. `.nav-drawer` 是 `<details>`，summary 是汉堡，面板含四项；公开页面板含文章索引，管理台 / 错误页不含。
6. 没有 `.tab-bar` / `tabBar()` / `ADMIN_ITEM` 的残留（样式、视图、打印清单）。
7. 打印隐藏新外壳（见上）。

> `e2e` 536 与 `style-check` 约 170 的具体条数都会变；以复跑为准，不要为了凑数字保留失效断言。

### 10.3 `CONTEXT.md`

**「导航（navigation）」替换为：**

```markdown
**导航（navigation）** — 公开面：顶栏四项（首页 / 分享 / 系统可用性 / 关于）+ 左侧公开文章侧栏；
文章侧栏在所有公开内容页常驻（首页、分享、标签、文章、系统可用性、关于），只列已发布文章，
当前文章高亮；手机 ≤720 顶栏折成汉堡抽屉（四项 + 文章索引），不再有底部 tab bar。

管理台：同一公开顶栏 + 左侧 rail（运维 / 内容两段）+ 手机模块条 `.admin-tabs`；
管理入口只在用户胶囊里，公开侧栏没有管理组。

当前项判据仍是 `aria-current="page"`：公开页顶栏恰好一个；文章页侧栏再有一个（当前文章）；
管理台 rail 恰好一个；403/404 零个。条目与顺序由 `NAV_ITEMS` / `ADMIN_GROUPS` 同源，条目不带计数。
```

**「管理台（admin console）」替换为：**

```markdown
**管理台（admin console）** — `/admin` 概览页 + 模块页（目标 / 账号 / 备份 / 站点设置 / 文章）。
模块之间走左侧 rail（桌面）或 `.admin-tabs` 模块条（手机）；顶栏是公开四项 + 用户胶囊，
顶栏不标当前项，rail 标。**公开文章侧栏不进管理台**；管理入口只在用户胶囊里（仅管理员可见）。
```

**不改：** 「主题」「字阶」已由 #85 改写；本票只改导航 / 管理台两条。

### 10.4 旧文档标注

| 文件 | 动作 |
| --- | --- |
| `docs/ios-component-mapping-decision.md` | §5 导航 / 外壳被本票取代；§7 面板契约、§11 打印图案仍有效 |
| `docs/admin-console-sidebar-decision.md` | 追加「管理台保留 rail + 模块条，同时有公开顶栏；公开面不再是 rail」 |
| `docs/ios-theme-architecture-decision.md` | 只改注释：视觉取值由 #85 取代；导航不在那里 |
| `docs/claude-shell-prototype.md` | 原型证据保留；本票的差异（无计数 / 403-404 无侧栏 / details 抽屉）以本票为准 |

---

## 11. 与 B 原型的差异（有意）

| 项 | B 原型 | 本票 |
| --- | --- | --- |
| 侧栏计数 | 显示「6」 | **不显示计数**（避免第二份真相） |
| 403/404 | A/B 版带侧栏 | **只有顶栏**（错误页不属于六条公开内容页） |
| 移动抽屉 | JS + 遮罩 + focus trap | **`<details>` + 无读面 JS**（无 Esc / 点外 / trap） |
| 侧栏宽度 | 224 | 224（沿用） |
| 外壳 | 1360 | 1360（沿用） |
| 正文 | 原型 780px / 15px | #85 的 68ch / 17px（本票不改正文） |
| 当前文章 | 有 | 有（文章页 + 抽屉都标） |

---

## 12. 风险与边界

| 项 | 说明 |
| --- | --- |
| `<details>` 抽屉没有 focus trap / Esc / 点外关闭 | 这是本次明确选择；summary 始终可见，是关闭控件。若以后要做「模态抽屉」，另开票，不要在本票里偷偷加 JS |
| 403/404 不带侧栏 | 错误页没有文章索引；顶栏仍给四项，不是死路。e2e 1093-1098 必须先改 |
| 文章页 `aria-current` 四个 | 顶栏 + 侧栏 + 抽屉导航 + 抽屉文章；所有断言必须分容器，全页计数会误报 |
| `sidebar` 必填 | 13 个 `layout()` 调用点少传一个就编译失败；这是故意的 |
| 管理台顶栏公开四项 | 管理员点「分享」会离开管理台；预期行为，不额外加「返回公开站」 |
| `:has` 滚动锁 | 现代浏览器支持；不支持时抽屉仍能开合，只是背景可滚 |
| `#87` 槽位 | `.header-actions` 同时被 #86（抽屉开关）与 #87（胶囊）使用；两张票的实现在 #88 排在一起，避免中途没有主题 / 登出 |
| 1360 在 1024 | 主列 732；目标卡用 auto-fit 退两列；不新增断点 |
| 标签页侧栏全量 | 侧栏稳定，主列表过滤；e2e 要同时断言两边 |
| 文章量增长 | 分组 / 折叠 / 分页仍是地图的「Not yet specified」，本票不提前切 |

---

## 13. 这张票不决定什么

- 用户胶囊、下拉菜单、身份 / 改密 / 管理后台 / 主题 / 登出的菜单项与 `/account` 落点 → **#87**。
- 文章量增长后的侧栏分组 / 折叠 / 分页 → 地图 fog，等真实数据。
- Logo 上传 / 头像上传 → out of scope。
- 搜索 / 多语言切换 → out of scope。
- 实现批次 → **#88**；本票只给 DOM / 行为 / 断言契约。

---

## 14. 验收

- 本票**没有改产品代码**；`npm run check:style` 与 `e2e` 的当前基线（#85 后约 170 / 536）未因本文变化。
- 实现后必须满足：
  - 六条公开内容页有 `.docs-side`；管理台 / 403/404 没有。
  - 顶栏 sticky 56 / 不透明 / 四项；文章页顶栏 + 侧栏各一个 `aria-current`。
  - 移动端没有 `.tab-bar`；`.nav-drawer` 是 `<details>`；管理台 `.admin-tabs` 保留。
  - 403/404 只有顶栏；零当前项。
  - 打印隐藏顶栏 / 侧栏 / rail / 抽屉；正文全宽。
- 下一步：**#87 用户菜单 / 账户入口** 解阻；#88 在 #85/#86/#87 三份决定书关闭后切实现。

## 实现状态（2026-10-22）

T1–T4（#89–#92）已收口（2026-10-22）。最终以 `check:unit` 245/245、`check:style` 172/172、
`check:e2e` 551/551、全量 `check:all` 全绿与 1440/390 浅深视觉（52 张 + 2 PDF）为准。
