# 用户胶囊、下拉菜单与账户入口（B · 紧凑工作台）

> 票：[#87 落地设计：用户胶囊、下拉菜单与账户入口](https://github.com/Lkyloveaw/lkyloveaw-home/issues/87)（父地图：[公开面换装](https://github.com/Lkyloveaw/lkyloveaw-home/issues/82)）
> 上游：[#86 外壳契约](https://github.com/Lkyloveaw/lkyloveaw-home/issues/86) → `docs/public-shell-decision.md`；[#85 token / 字阶](https://github.com/Lkyloveaw/lkyloveaw-home/issues/85) → `docs/claude-theme-decision.md`；[#84 原型 B](https://github.com/Lkyloveaw/lkyloveaw-home/issues/84)
> 本票**只出契约，不写产品代码**。这是 #88 切实现前的最后一份决定书。
> Grilling 记录：2026-10-22，用户确认：新增 `/account`；胶囊 `button + CSS hover/focus + 小段 JS`；手机 ≤720 只留头像；`/account` 只顶栏、无侧栏。

## 0. 一句话结论

**右上角是「首字母头像 + 用户名」的胶囊；点开是一块 disclosure 面板：身份（用户名 · 管理员/只读）· 修改口令 · 管理后台（仅管理员）· 主题三态 · 登出。**

- 桌面：hover / focus / 点击都能开；手机：点按；CSS hover / `:focus-within` 是无 JS 降级，JS 只补点击开合 / Escape / 点外关闭 / 焦点返回；**不做 focus trap，不用 `role=menu`**。
- 修改口令落到**新增的 `/account`**：仅顶栏（#86 的 `.app-shell--plain`，900 宽），无文章侧栏；`POST /password` 成功 **302 PRG** 到 `/account?notice=password-changed`，失败 **400** 回显同一张账户页。
- 主题 picker 从顶栏收进菜单；**登录后页面 1 个、登录页 1 个**（`themePicker()` 调用点仍是 **2 处**）。
- 用户名走新增的 `currentUserName()`（会话查询多取一列 `u.username`，不新增查询次数）；**不**给 `LayoutOptions` 塞 viewer。
- `/account` 是第 **14** 条 HTML GET 路由，`layout()` 调用点从 #86 的 13 变成 **14**。

---

## 1. 本次敲定的四个分叉

| # | 分叉 | 决定 |
| --- | --- | --- |
| 1 | 修改口令落点 | **新增 `/account`**；不塞进下拉，也不塞进系统可用性页 |
| 2 | 胶囊开合 | **button + CSS hover / focus-within + 小段 JS**；无 JS 也能开；不做 focus trap |
| 3 | 手机胶囊 | **≤720 只留头像**；用户名在展开的面板里显示 |
| 4 | `/account` 外壳 | **只顶栏、无文章侧栏**（`.app-shell--plain`，900 宽） |

---

## 2. 现状与三个必须先修的事实

| 事实 | 现状 | 决定 |
| --- | --- | --- |
| 「修改口令」的 GET 落点 | `POST /password` 存在（`server.ts:1348-1372`），但**没有任何 `action="/password"` 的 GET 页面**；`statusPage()` 里也没有表单 | 新增 `GET /account` + 账户页表单 |
| 账号页文案 | `views.ts:814-815` 写着「改自己的口令请用『系统可用性』页上的那条入口」——**这句话是假的** | 改成「右上角用户菜单 → 修改口令（`/account`）」 |
| 用户名 accessor | `csrf.ts` 只有 `currentIsAdmin()` / `currentUserId()`；`SessionState.user` 只查 `id/enabled/tokenVersion/role` | 会话查询加 `u.username`，新增 `currentUserName()`；不新增查询 |
| 改密完成后的响应 | 成功/失败都回 `statusPage()`（成功 200、失败 400） | 成功 302 PRG；失败 400 回账户页；`statusPage()` 不再收 notice |
| 主题 picker | 顶栏 `themePicker()` + 登录页；页面上各 1 个，共 2 个调用点 | 收进菜单；页面上仍各 1 个，调用点仍 2 个 |

> 另一个已实测约束：**关闭的 `<details>` 不渲染子面板**，hover / `:focus-within` 打不开（#84 原型踩过）。所以胶囊**不能用 `<details>`**，必须是 `button` + 常驻 DOM 的面板。

---

## 3. 胶囊与下拉菜单

### 3.1 DOM

```html
<div class="user-menu" data-user-menu>
  <button class="user-pill" type="button"
          aria-expanded="false" aria-controls="user-panel"
          aria-label="账户菜单：Lkyloveaw" data-user-trigger>
    <span class="avatar" aria-hidden="true">L</span>
    <span class="user-name">Lkyloveaw</span>
    <span class="chev" aria-hidden="true"><!-- chevron --></span>
  </button>

  <div class="user-panel" id="user-panel" data-user-panel>
    <div class="user-identity">
      <span class="avatar avatar-lg" aria-hidden="true">L</span>
      <span class="identity-main">
        <strong>Lkyloveaw</strong>
        <span class="role-tag">管理员</span> <!-- 或 只读 -->
      </span>
    </div>

    <a class="menu-item" href="/account">修改口令</a>
    <a class="menu-item" href="/admin">管理后台</a> <!-- 仅 currentIsAdmin() -->

    <div class="menu-theme">
      <span>主题</span>
      ${themePicker()} <!-- 三态 select；页面仍恰好 1 个 -->
    </div>

    <form class="logout-form" method="post" action="/logout">
      ${csrfField()}
      <button class="menu-item" type="submit">登出</button>
    </form>
  </div>
</div>
```

- 胶囊放在 #86 的 `.header-actions` 里；手机端与汉堡开关并排；面板 `position: absolute; right: 0; top: calc(100% + 8px); width: 284px;`，`z-index: 40`。
- 面板背景 `--bg-card`、1px `--separator`、12px 圆角、**无阴影**；身份行 + 菜单项 + 分割线。
- **没有 `role="menu"`**：面板里有 `<select>` 和 `<form>`，不是 ARIA menu；用普通 landmark/region 语义，按钮只带 `aria-expanded` / `aria-controls`，不加 `aria-haspopup="menu"`。
- 胶囊只在**已登录**时渲染（`currentUserId() !== undefined`）：登录页没有；未登录的 403 / 404（例如登录 POST 的 origin 403）也没有胶囊。已登录的 403/404 有胶囊。
- 头像：28px 圆，底色 `--label`、字色 `--bg`、`--font-display` 13/600、首字母大写；对比度用的是现有 `label/bg` 对（16.52），**不用 accent 做头像底**。面板里的 avatar 36px，同一套色。
- 用户名：桌面显示；`≤720` 隐藏 `.user-name`，按钮的 `aria-label` 仍带用户名；名字在面板身份行里始终可见。
- 角色：`currentIsAdmin()` → 「管理员」；否则「只读」；只读用户**不渲染**管理后台链接（不是渲染后点了 403）。

### 3.2 开合：CSS 降级 + 小段 JS

**CSS（无 JS 也能开）：**

```css
.user-menu { position: relative; }
.user-panel {
  position: absolute; right: 0; top: calc(100% + 8px);
  width: 284px; opacity: 0; visibility: hidden;
  transform: translateY(-4px); pointer-events: none;
  transition: opacity .15s ease, transform .15s ease;
}
.user-menu:hover .user-panel,
.user-menu:focus-within .user-panel,
.user-menu.is-open .user-panel {
  opacity: 1; visibility: visible; transform: none; pointer-events: auto;
}
.user-menu[data-suppress] .user-panel {
  opacity: 0; visibility: hidden; pointer-events: none;
}
```

- 桌面 `@media (hover: hover)` 才启用 `:hover`；触屏靠 `:focus-within` + 点按。
- 面板不用 `hidden` 属性（否则 CSS 无法显示）；`visibility: hidden` 让它脱离可访问性树，也拿不到 Tab 焦点。

**JS（约 40-50 行，内联在 `layout()`，不新增静态文件 / 路由）：**

- 点击 trigger：切换 `.is-open` 与 `aria-expanded`；打开时顺手关掉已开的 `.nav-drawer[open]`（避免两个浮层叠在一起）。
- `Escape`：关闭并把焦点还给 trigger。
- 点外：关闭。
- `focusout`：焦点离开整个 `.user-menu` 时关闭（没有 focus trap）。
- 点击关闭时给根节点加 `data-suppress`，避免 `:hover` / `:focus-within` 立刻又把它打开；`pointerleave` / 焦点离开后清掉。
- 无 JS 降级：hover（桌面）/ `:focus-within` 仍能把面板打开，链接、主题 select、登出表单都能用；**已知限制**：`aria-expanded` 会保持 `false`，Escape / 点外关闭没有。这是「CSS 能开、JS 补键盘与关闭」的取舍，不是完整无 JS 菜单。

**不做：**focus trap、`role="menu"`、方向键 roving tabindex、点击详情页链接后再自动关闭（导航本来就会刷新）。面板是 disclosure，不是 dialog。

### 3.3 手机

- `≤720`：`.user-name` 隐藏，胶囊只留 28px 头像（可带 chevron）；顶栏顺序是 brand → 汉堡 → 胶囊。
- 面板右对齐，284px 宽，在 390px 视口内不溢出；`max-height: calc(100vh - var(--header-h) - 16px); overflow-y: auto`。
- 点按 trigger 时 `:focus-within` 打开；点面板里的链接会导航；点外 / 焦点离开关闭；Escape 由 JS 补。
- 手机用户名只在展开后的身份行里显示。

---

## 4. 菜单项、权限与主题

| 项 | 管理员 | 只读 | 行为 |
| --- | --- | --- | --- |
| 身份行 | 用户名 + 「管理员」 | 用户名 + 「只读」 | 纯文本，不是链接 |
| 修改口令 | 有 | 有 | `<a href="/account">` |
| 管理后台 | 有 | **不渲染** | `<a href="/admin">` |
| 主题 | 有 | 有 | 三态 `<select data-theme-select aria-label="主题">`（复用 `themePicker()`） |
| 登出 | 有 | 有 | `POST /logout` + CSRF；菜单项样式的 submit |

- 顺序固定：身份 → 修改口令 → 管理后台（仅管理员）→ 主题 → 登出。
- 主题 picker 从 `.header-actions` 移进菜单后：**公开页 1 个、登录页 1 个**；`themePicker()` 调用点仍是 2 处（`userMenu()` + `loginPage()`）。`home.body` / `login.body` 的 picker 计数不变。
- 无 JS 时 `<noscript><style>[data-theme-select] { display: none }</style></noscript>` 照旧隐藏 select；菜单仍能用，只是主题切换不可用（改主题本来就需要 JS）。
- 登录页没有胶囊；右上角保留独立的主题 picker。登录成功后按 `next` 回跳（新增 `/account` 要进 `KNOWN_PAGES`）。

---

## 5. `/account` 账户页与改密流

### 5.1 路由与外壳

- **新增 `GET /account`**：受登录闸门保护（不在 `PUBLIC_PATHS`）；未登录 → `302 /login?next=%2Faccount`；`next` 校验要把 `/account` 加进 `KNOWN_PAGES`。
- 外壳：公开顶栏 + **无文章侧栏 / 无 rail**；`.app-shell--plain`（900 宽，复用 #86 的 plain 外壳）；`sidebar: null`、`active` 不传、`bodyClass: 'page-account'`。
- 顶栏四项 + 胶囊；顶栏**零当前项**；面板里的「修改口令」指向当前页。
- 页面主体是一张 `max-width: 520px` 的账户卡：身份（用户名 · 管理员/只读）+ 改密表单 + 成功 / 失败提示。
- 这是第 **14** 条 HTML GET 路由；`layout()` 调用点 **14**（#86 的 13 + `accountPage`）。#86 决定书里的 13 要在这里显式加一。

### 5.2 页面内容

```html
<section class="account-page">
  <h1 class="large-title">我的账户</h1>
  <p class="lede">Lkyloveaw · 管理员</p> <!-- 只读则「只读」 -->

  <div class="account-card">
    <h2>修改口令</h2>
    <p class="stat-sub">改完后其他设备会立即掉线；当前浏览器会重新签发，保持登录。</p>

    <form class="account-form" method="post" action="/password">
      ${csrfField()}
      <label>当前口令
        <input type="password" name="current" autocomplete="current-password" required>
      </label>
      <label>新口令
        <input type="password" name="next" autocomplete="new-password" minlength="8" required>
      </label>
      <label>再输一次
        <input type="password" name="confirm" autocomplete="new-password" minlength="8" required>
      </label>
      <button type="submit">更新口令</button>
    </form>
  </div>
</section>
```

- 表单字段保持 `current` / `next` / `confirm`（现有 e2e 直连 POST 的形状不变）；最短长度用 `MIN_PASSWORD_LENGTH`（当前 8），错误文案沿用「当前口令不正确 / 新口令至少 N 位 / 两次输入的新口令不一致」。
- 口令字段**永不回填**；失败时只回显错误与身份，不回显任何口令。
- 成功提示：「口令已更新。其他设备上的登录已失效。」；成功页 `?notice=password-changed` 是**闭集 key**，未知 key 不渲染任何提示（不反射 query）。
- 失败：`400` + 同一张账户页，错误放在表单上方；**不**回 `statusPage()`，也不重定向（避免把 POST 变 GET 让人误以为成功）。
- 页面身份来自 `currentUserName()` / `currentIsAdmin()`，`views.ts` 不 import store。

### 5.3 `POST /password` 的新语义

| 结果 | 现在 | 改后 |
| --- | --- | --- |
| 成功 | `200` + `statusPage(..., '口令已更新…')` | `setSession(...)` 后 **`302 /account?notice=password-changed`**（PRG；仍然重签当前浏览器） |
| 当前口令错 | `400` + status 页 | `400` + 账户页 +「当前口令不正确」 |
| 新口令太短 | `400` + status 页 | `400` + 账户页 +「新口令至少 N 位」 |
| 两次不一致 | `400` + status 页 | `400` + 账户页 +「两次输入的新口令不一致」 |
| CSRF 缺失 / 旧 token | `403` | `403`，不变 |

- 成功仍要先 `setPassword()`（递增 `token_version`，其他设备失配），再 `setSession()` 重签当前浏览器，最后 redirect。
- `statusPage()` 的 `notice` 参数**删除**（它只被改密用过）；`GET /status` 不再传第三个参数；`statusPage()` 里第 1253 行的 notice 输出一起删。
- 管理台账号页的自述文案同步改：自己的口令走**右上角用户菜单 → 修改口令（`/account`）**，不再指向系统可用性页。
- 现有 e2e 直连 `POST /password` 保留接口形状，只把成功断言从 `200` 改为 `302` 并检查 Location；失败用例新增 400 + 账户页。

---

## 6. 用户名从哪来

**决定：`currentUserName()`，由会话查询的那一列带出来；不把 `{name, role}` 塞进 `LayoutOptions`。**

```
sessions-store.findSessionState()
  SELECT …, u.username AS username        ← 多取一列，不新增查询
        ↓
SessionState.user.username
        ↓
auth.decideRequest() → { allow, userId, role, username }
        ↓
server.ts onRequest: csrfContext.enterWith({ token, isAdmin, userId, userName })
        ↓
csrf.currentUserName()  →  views.userMenu() / accountPage()
```

- `SessionState.user` 加 `username: string`；`sessions-store.ts:70-87` 的 SELECT / row 类型 / 映射各加一列。
- `RequestDecision` 加 `username?: string`；`auth.ts:156` 的 return 带上 `username: state.user.username`。
- `csrfContext` 的类型加 `userName?: string`；新增 `currentUserName()`，无上下文返回 `''`（与 `currentCsrfToken()` 同样的失败方向）。
- `server.ts:461` 的 `enterWith` 加 `userName: decision.username ?? ''`；**不新增查询**，也不改 14 个 `layout()` 调用点的签名。
- `layout()` 用 `currentUserId() !== undefined` 决定是否渲染胶囊；用户名空时退回 `?`，但正常登录路径不会空。

> 为什么不选「server 把 `{name,role}` 塞进 `LayoutOptions`」：那要穿过 14 个调用点和 6 个公开页函数，漏传会静默渲染出没有身份的面板；ALS 已经有 `isAdmin` / `userId`，多一个 `userName` 是同一处、同一次查询的自然延伸。

---

## 7. 主题：收进菜单后的可发现性与移动端

- **一个 picker，两个位置**：登录后只在用户菜单；登录页自己的右上角；公开页不再有独立的顶栏主题控件。
- 可发现性：胶囊身份行下方有可见的「主题」行；select 的 `aria-label="主题"`；当前值（跟随系统 / 浅色 / 深色）就是 select 的选中项。
- 移动端：面板在 390px 内右对齐，主题行在菜单中部；select 原生控件在 iOS / Android 都可点；不另做三段按钮。
- 无 JS：select 被现有 `<noscript>` 隐藏，菜单仍能开；主题不可切换（和现在无 JS 时一样）。
- **不新增颜色 token / 对比度对**：头像用 `label/bg`（16.52），角色标签 `label-2/bg-card`（6.77），菜单项 `label/bg-card`（16.81），hover `label/fill`（15.00），焦点环 `accent/bg-card`（3.17）。这些都在 #85 的表里。
- 主题切换脚本 / boot / `color-scheme` 三态不变；`prefers-reduced-motion` 下菜单过渡关掉。

---

## 8. e2e / style-check / CONTEXT 迁移

### 8.1 `scripts/e2e-check.mjs`（当前 536 条）

**改现有断言**

| 当前行 | 现在 | 改后 |
| --- | --- | --- |
| 607-614 | 改密成功 `200`；设新 cookie | **`302`**；`Location: /account?notice=password-changed`；仍设新 cookie；其他设备 / 旧口令 / 新口令断言保留 |
| 929-934 | 改密成功 `200` | **`302`**；`changed.setCookie` 仍取新会话 |
| 946-955 | 新 token 改密成功 `200` | **`302`** |
| 2414-2418 | 页头 + 登录页各 1 个 picker | 保留：登录后 picker 在菜单里，数量仍是 1 / 1 |
| 1053-1057 | 只读顶栏四项、无「管理」 | 保留；「管理后台」只在管理员菜单里，只读面板不渲染 |
| 1093-1098 | 403 有 rail、无管理组 | #86 已改成「只有顶栏」；**新增**：已登录 403 有胶囊、未登录 403 没有 |
| 2381-2391 | 所有页面 rail + tab bar | #86 已改；本票只加胶囊身份断言，不动外壳矩阵 |

**新增 e2e**

1. `GET /account` 未登录 → `302` 到 `/login?next=%2Faccount`；登录后 → `200`，有 `.account-form`、三个口令字段、CSRF hidden input，**没有** `.docs-side` / `.site-rail`。
2. 账户页身份：管理员看到「管理员」；只读看到「只读」；只读菜单**不渲染** `/admin` 链接，管理员渲染。
3. 菜单结构：`.user-menu` / `.user-pill[aria-expanded="false"]` / `.user-panel`；「修改口令」href=`/account`；主题 select 在面板里；登出 form 在面板里且带 CSRF；胶囊里有用户名。
4. 手机：`≤720` 的 CSS 隐藏 `.user-name`（断点规则存在）；面板宽度 284 / 右对齐规则存在。
5. `POST /password` 失败：当前口令错 / 太短 / 不一致 → `400` + 账户页 + 对应错误文案；口令字段不回填。
6. `POST /password` 成功：`302` + `Location`；新 cookie 可继续访问 `/account`；旧 cookie / 其他设备 302 到登录；`/account?notice=password-changed` 显示成功文案；未知 notice 不显示。
7. 旧 token：改密后旧页面 token 再 POST → `403`（现有断言保留，响应形状从 200 改 302 后仍成立）。
8. 登录回跳：未登录访问 `/account` → 登录 → 回到 `/account`（`KNOWN_PAGES` 生效）。
9. 登录页：没有 `.user-menu`；仍有 1 个主题 picker；没有 `.docs-side`。
10. 403/404：未登录（origin / csrf 403）没有胶囊；已登录 403 有胶囊、身份正确。

> e2e 是 HTTP 级，测不到 hover / Escape / 点外；这三条靠 CSS 规则断言 + 原型 CDP 证据 + 手工验收，不在 e2e 里假装能测。

### 8.2 `scripts/style-check.mjs`（#85 后约 170 条）

- 新增类名都要有 CSS：`.user-menu` / `.user-pill` / `.avatar` / `.user-name` / `.user-panel` / `.user-identity` / `.identity-main` / `.role-tag` / `.menu-item` / `.menu-theme` / `.menu-sep` / `.account-page` / `.account-card` / `.account-form` / `.page-account`。
- 外壳：`/account` 用 `.app-shell--plain`；`#86` 的 `.app-shell--docs` / `--admin` / `--plain` 三态不变；账户页无 `.docs-side` / `.site-rail`。
- 主题：`themePicker()` 调用点仍 2；页面上 picker 1 个；`<noscript>` 字符串不变；`[data-theme-select]` 仍被无 JS 隐藏。
- 登出：`.logout-form` 仍在（现在在面板里），CSRF hidden input 仍在；现有登出 e2e 不变。
- 对比度：**不新增 token / 不新增 pair**；头像 / 菜单 / 角色 / 焦点都用 #85 的现有对；`npm run check:style` 的 17 色 / 对比度段不动。
- 断点：用户菜单只在 `≤720` 隐藏 `.user-name`；`≤560` 的登录 / 顶栏规则不变；不新增断点。
- 打印：用户菜单和顶栏一起被 #86 的打印块隐藏；账户页打印时只留账户卡（表单可打印，但口令输入框不会带值）。

### 8.3 `CONTEXT.md`

在「账号与权限」段落新增两个词：

```markdown
**用户菜单（user menu）** — 右上角用户胶囊展开的 disclosure：身份（用户名 + 管理员 / 只读）、
修改口令、管理后台（仅管理员）、主题三态、登出。桌面 hover / focus / 点按，手机点按；
CSS 负责无 JS 降级，JS 只补点击开合 / Escape / 点外关闭 / 焦点返回；不是 ARIA menu，没有 focus trap。

**我的账户（account page）** — `/account`，登录后改**自己**口令的页面（当前 / 新 / 确认）。
与管理台的「账号」区分：后者是管理员重置**别人**口令、改角色、启停。改密成功走 PRG，
其他设备的会话失效，当前浏览器重签并保持登录。
```

同时把 #85 的「主题」条目里「页头的 `<select>`」改成「右上角用户菜单里的 `<select>`（登录页在右上角单独一个）」；#86 的「导航」「管理台」替换文本继续按 `docs/public-shell-decision.md` §10.3 执行。

### 8.4 旧文档

| 文件 | 动作 |
| --- | --- |
| `docs/public-shell-decision.md` | 追加：`/account` 复用 `.app-shell--plain`；胶囊槽由本票填充；13 → 14 条路由 / layout 调用点 |
| `docs/claude-shell-prototype.md` | 原型用户菜单是 button + disclosure 的证据保留；原型里的「修改口令」toast 由本票的 `/account` 取代 |
| `docs/accounts-decision.md` | 管理台账号页的「改自己口令」指路改为 `/account`；管理别人口令的接口不变 |
| `docs/ios-component-mapping-decision.md` | 不需要新增外壳段落；用户菜单是新组件，以本票为准 |

---

## 9. 风险与边界

| 项 | 说明 |
| --- | --- |
| 无 JS 时 `aria-expanded` 仍是 false | CSS hover / focus 能开面板，但 ARIA 状态不跟着变；这是「CSS 降级 + JS 增强」的已知限制，不假装它是完整无 JS 菜单 |
| 没有 focus trap | 面板是 disclosure，不是 dialog；Tab 可以离开面板，`focusout` 会关；对键盘用户可接受 |
| 面板里有 select / form | 所以不能用 `role="menu"` / 方向键 roving；用普通链接、select、form，语义更诚实 |
| `/account` 是第 14 条路由 | #86 的 13 → 14；`KNOWN_PAGES` 加 `/account`；e2e / 文档的「13」要同步 |
| `POST /password` 200 → 302 | 现有 3 处 e2e 断言要改；改密后旧 token 仍 403；新 token 仍能继续；PRG 不改变会话语义 |
| `statusPage()` 删 notice | 只有改密用过；删掉后 `/status` 不再承载账户提示；失败页改回账户页 |
| 用户名多取一列 | 仍在同一次会话查询里；不新增查询次数；`currentUserName()` 无上下文返回空串 |
| 未登录 403 没有胶囊 | 登录 POST 的 origin 403 这类页面没有用户身份；顶栏仍四项，登录页有主题 picker |
| 主题收进菜单 | 可发现性下降一档，但菜单身份行下方有明确的「主题」行；登录页保留独立 picker |
| 手机头像 only | 用户名只在面板里；按钮 `aria-label` 仍带名字，屏幕阅读器不丢身份 |
| 抽屉与菜单重叠 | 打开菜单时用一行 JS 关掉 `.nav-drawer[open]`；抽屉打开时菜单被点外关闭；不做双向动画 |
| 打印 | 顶栏 / 菜单被 #86 打印块隐藏；账户页表单打印时口令框为空 |
| 用户改名 / 角色变更 | 用户名和角色每请求从库里读，下一请求生效；头像首字母随之变 |

---

## 10. 本票不决定什么

- #88 的批次切分与顺序；本票只给契约。
- 2FA、会话列表 / 设备管理、头像上传、运行时自定义主题 → out of scope。
- 忘记口令 / 邮件重置 → 站点没有邮件通道，仍是 CLI 运维操作。
- 管理台的账号管理（重置**别人**口令 / 改角色 / 启停）→ 现有 `docs/accounts-decision.md`，本票只改「改自己口令」的指路。
- 菜单面板的动画细节 / 方向键导航 → 不实现；focus trap 明确不做。
- 登录页的视觉改版 → #86/#85 已覆盖，本票只确认没有胶囊、主题 picker 保留。

---

## 11. 验收

- 本票**没有改产品代码**；当前 `style-check` / `e2e` 基线未因本文变化。
- 实现后必须满足：
  - 登录后右上角有胶囊；桌面 hover / focus / 点按能开；手机点按能开；Escape / 点外关闭有；无 JS 时 hover / focus 仍能开。
  - 菜单身份、修改口令、管理后台（仅管理员）、主题、登出齐全；只读无管理后台链接。
  - `/account` 登录保护；表单可改密；成功 302 PRG + 新 cookie；失败 400 回账户页；其他设备掉线、当前浏览器保持。
  - 登录页无胶囊、有 1 个主题 picker；公开页仍有 1 个 picker（在菜单里）。
  - 403/404 已登录有胶囊、未登录没有；账户页顶栏无当前项、无侧栏。
- 下一步：**#88 落地切分**；三份决定书（#85 / #86 / #87）关闭后，把 token、公开面外壳、用户菜单切成可独立验收的实现票。

## 实现状态（2026-10-22）

T1–T4（#89–#92）已收口（2026-10-22）。最终以 `check:unit` 245/245、`check:style` 172/172、
`check:e2e` 551/551、全量 `check:all` 全绿与 1440/390 浅深视觉（52 张 + 2 PDF）为准。
