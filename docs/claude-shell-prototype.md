# 公开面外壳原型：A / B / C 三版与选定结果

> 票：[#84](https://github.com/Lkyloveaw/lkyloveaw-home/issues/84)（父地图 [#82](https://github.com/Lkyloveaw/lkyloveaw-home/issues/82)）
> 研究输入：[#83](https://github.com/Lkyloveaw/lkyloveaw-home/issues/83) → `docs/research/claude-support-shell.md`
> 产物：`prototype/claude-shell/` + `prototype/claude-shell/shots/`（57 张）——**本地产物，不入库**（`.gitignore` 忽略 `prototype/`），下文的截图链接只在产出这台机器上可开
> 状态：**已选定 B · 紧凑工作台**（2026-10-21）

## 0. 选定结果

| 项 | 值 |
| --- | --- |
| 选定方向 | **B · 紧凑工作台**（用户 2026-10-21 选定） |
| 选定依据 | 侧栏仍全站常驻；224px 侧栏 + 1068px 主列让可用性页排成三列（1421px），明显短于 A 的单列（2235px）；正文收到 780px 仍可读。 |
| 对地图 Notes 第 3 条（公开侧栏所有公开页常驻）的影响 | **无冲突**：B 的公开文章侧栏仍在所有公开页常驻，只是宽度从 260 → 224。 |
| 落地起点（不是最终数值） | 顶栏 56px / 侧栏 224px / 主列 1068px / 正文 780px；#85 定 token 与字阶、#86 定栏宽与断点后可以微调（例如侧栏 224→236 消除最长标题折行）。 |
| 下一步 | #85 / #86 / #87 解除阻塞；#88 仍被三份决定书阻塞。 |

### 0.1 选定 B 之后的落地口径

1. **侧栏在所有公开页常驻**：B 与地图 Notes 第 3 条一致，不需要改地图的 Destination / Notes。C 被排除，地图也不用登记「混合外壳」的例外。
2. **可用性页三列是 B 的核心收益**：`target-grid` 在 1068 主列里排三列；#86 要把「≥三列的宽度门槛」写进外壳契约，并决定 1280 / 1024 窗口下怎么退化（两列还是单列）。
3. **正文 780px 是阅读栏宽**：主列 1068 不等于正文 1068；文章页与 `.prose` 在 B 里都收在 780。这条要写进 #85 的栏宽 token。
4. **224px 侧栏的长标题折行是已知代价**：最长标题「用 Node 单进程同时做站点和探活」在 B 里折成两行（见 `b-posts-1440-light.png`）。#86 可以二选一：侧栏加宽到 236–240，或把侧栏字号从 13 降到 12.5；不要既加宽又加字号。
5. **原型 JS 不继承**：B 的胶囊用「button + div disclosure」验证了 hover / focus / 点按三态；#87 仍需决定产品在无 JS 时的降级（可保留 CSS hover/focus，点按由 JS 增强，或给独立 `/account` 落点）。

## 1. 这张票要回答什么

不是「做实现」，而是用真实页面片段把公开面外壳的**三种布局方向**摆到用户面前，让用户挑一个，然后 #85（token / 字阶）、#86（外壳与侧栏契约）、#87（用户菜单）才开工。

三版都必须带：

- 顶栏：占位徽标 + 站名；固定四项（首页 / 分享 / 系统可用性 / 关于）+ 用户胶囊。
- 公开文章侧栏：只列已发布文章、当前文章高亮、草稿永不出现（A/B 全公开页常驻；C 只在分享/文章页）。
- 用户胶囊：hover / 键盘 focus / 点按三态；菜单 = 身份 · 修改口令 · 管理后台（仅管理员）· 主题三态 · 登出。
- 移动端：≤760px 汉堡抽屉（四项导航 + 文章索引），**没有底部 tab bar**。
- 403 / 404 / 登录页；管理台顶栏 + rail 共存；空文章列表。

## 2. 三版是什么

| | A · 忠实支持中心 | B · 紧凑工作台 | C · 混合 |
| --- | --- | --- | --- |
| 顶栏高度 | **60px** | **56px** | **60px** |
| 公开侧栏 | **260px，所有公开页** | **224px，所有公开页** | **260px，仅分享 / 文章 / 空态** |
| 外壳宽度 | 1180px（20+260+48+832+20） | 1360px（20+224+28+1068+20） | 分享/文章 1180；首页/关于 960；可用性 1180 |
| 正文栏宽 | 832px（整列） | 780px（正文收窄，主列 1068） | 760px |
| 密度 | 松；字号 16 / 节间距 56 | 紧；字号 15 / 节间距 34 | 中；字号 16 / 节间距 64（编辑式页面） |
| 可用性页 | 单列卡片，2235px 高 | **三列卡片，1421px 高** | 三列卡片，1691px 高 |
| 首页 | 侧栏 + 830 正文 | 侧栏 + 1068 主列 | **无侧栏、居中 780 编辑式** |
| 403 / 404 | 公开外壳（含文章侧栏） | 公开外壳（含文章侧栏） | 只有顶栏（无侧栏） |
| 特点 | 最像参考站；阅读节奏最好 | 状态面板 / 列表拿到最多宽度 | 视觉最有编辑感；外壳按页面变形 |

> 高度是 1440×浅色整页截图的实际高度，用来比较密度；不是产品指标。

## 3. 三版共用的决定（原样保留）

- **C1 = A · 品牌忠实 `#CC785C`**：文字链接走 `--label` + 下划线；accent 只做焦点环、2px 当前项竖条、主按钮底；按钮字用 `--on-accent: #1A1A1A`。
- 暖白纸感底、近黑文字、衬线标题 + 无衬线正文、细边框、12px 圆角；深浅双模；无阴影。
- 固定四项导航；公开侧栏不出现任何管理项；管理后台入口只在用户下拉里且仅管理员可见。
- 保留现有 URL / 内容 IA / 登录闸门；不引入外部字体、前端框架或构建步骤。
- 登录页是唯一独立外壳；403/404 没有当前项。

## 4. C1=A 在原型里的具体用法

研究 #83 已经把 A 路线的代价算清楚，原型照它执行：

| 用途 | 用什么 | 为什么 |
| --- | --- | --- |
| 正文链接 | `--label` + accent 下划线 | `#CC785C` 文字只有 3.11:1，不过 4.5 |
| 顶栏当前项 | 文字加粗 + 2px accent 下划线（on `--bg`，3.11:1） | 非文字 ≥3，且不把 accent 当文字色 |
| 侧栏当前文章 | `--bg-card` 底 + 2px accent 竖条（on card，3.17:1） | 同上；不在 `--fill` / `--bg-elev` 上放 accent |
| 焦点环 | accent，仅在 `--bg` / `--bg-card` 上 | 避开 `accent on bg-elev = 2.84`、`accent on fill = 2.87` |
| 主按钮 | accent 底 + `#1A1A1A` 字（5.31:1） | 白字只有 3.28:1 |
| 状态徽标 / 点 | `--ok / --warn / --bad` | 五对在两种模式下都 ≥5.0 |

原型脚本 `contrast-check.mjs` 只检查**实际用到的组合**：浅色文字最低 4.55:1、非文字最低 3.11:1；深色文字最低 5.00:1、非文字最低 3.76:1。它不替代 #85 的 17 色全表。

## 5. 截图

57 张全在 `prototype/claude-shell/shots/`，`manifest.json` 记录尺寸 / 主题 / 页面 / 状态。下表是票面要求的覆盖矩阵：

| 覆盖项 | A | B | C |
| --- | --- | --- | --- |
| 首页 1440 浅 | [A](../prototype/claude-shell/shots/a-home-1440-light.png) | [B](../prototype/claude-shell/shots/b-home-1440-light.png) | [C](../prototype/claude-shell/shots/c-home-1440-light.png) |
| 首页 1440 深 | [A](../prototype/claude-shell/shots/a-home-1440-dark.png) | [B](../prototype/claude-shell/shots/b-home-1440-dark.png) | [C](../prototype/claude-shell/shots/c-home-1440-dark.png) |
| 首页 390 浅 | [A](../prototype/claude-shell/shots/a-home-390-light.png) | [B](../prototype/claude-shell/shots/b-home-390-light.png) | [C](../prototype/claude-shell/shots/c-home-390-light.png) |
| 首页 390 深 | [A](../prototype/claude-shell/shots/a-home-390-dark.png) | [B](../prototype/claude-shell/shots/b-home-390-dark.png) | [C](../prototype/claude-shell/shots/c-home-390-dark.png) |
| 当前项（分享页） | [A](../prototype/claude-shell/shots/a-posts-1440-light.png) | [B](../prototype/claude-shell/shots/b-posts-1440-light.png) | [C](../prototype/claude-shell/shots/c-posts-1440-light.png) |
| 当前文章（文章页） | [A](../prototype/claude-shell/shots/a-post-1440-light.png) | [B](../prototype/claude-shell/shots/b-post-1440-light.png) | [C](../prototype/claude-shell/shots/c-post-1440-light.png) |
| 可用性 1440 浅 / 深 | [A 浅](../prototype/claude-shell/shots/a-status-1440-light.png) / [深](../prototype/claude-shell/shots/a-status-1440-dark.png) | [B 浅](../prototype/claude-shell/shots/b-status-1440-light.png) / [深](../prototype/claude-shell/shots/b-status-1440-dark.png) | [C 浅](../prototype/claude-shell/shots/c-status-1440-light.png) / [深](../prototype/claude-shell/shots/c-status-1440-dark.png) |
| 关于 | [A](../prototype/claude-shell/shots/a-about-1440-light.png) | [B](../prototype/claude-shell/shots/b-about-1440-light.png) | [C](../prototype/claude-shell/shots/c-about-1440-light.png) |
| 空文章列表 | [A](../prototype/claude-shell/shots/a-empty-1440-light.png) | [B](../prototype/claude-shell/shots/b-empty-1440-light.png) | [C](../prototype/claude-shell/shots/c-empty-1440-light.png) |
| 胶囊 hover | [A](../prototype/claude-shell/shots/a-menu-hover-1440-light.png) | [B](../prototype/claude-shell/shots/b-menu-hover-1440-light.png) | [C](../prototype/claude-shell/shots/c-menu-hover-1440-light.png) |
| 胶囊 focus（深色） | [A](../prototype/claude-shell/shots/a-menu-focus-1440-dark.png) | [B](../prototype/claude-shell/shots/b-menu-focus-1440-dark.png) | [C](../prototype/claude-shell/shots/c-menu-focus-1440-dark.png) |
| 胶囊点按（390） | [A](../prototype/claude-shell/shots/a-menu-click-390-light.png) | [B](../prototype/claude-shell/shots/b-menu-click-390-light.png) | [C](../prototype/claude-shell/shots/c-menu-click-390-light.png) |
| 只读菜单 | [A](../prototype/claude-shell/shots/a-menu-readonly-1440-light.png) | [B](../prototype/claude-shell/shots/b-menu-readonly-1440-light.png) | [C](../prototype/claude-shell/shots/c-menu-readonly-1440-light.png) |
| 移动抽屉 390 | [A](../prototype/claude-shell/shots/a-drawer-390-light.png) | [B](../prototype/claude-shell/shots/b-drawer-390-light.png) | [C](../prototype/claude-shell/shots/c-drawer-390-light.png) |
| 403 | [A](../prototype/claude-shell/shots/a-403-1440-light.png) | [B](../prototype/claude-shell/shots/b-403-1440-light.png) | [C](../prototype/claude-shell/shots/c-403-1440-light.png) |
| 404 | [A](../prototype/claude-shell/shots/a-404-1440-light.png) | [B](../prototype/claude-shell/shots/b-404-1440-light.png) | [C](../prototype/claude-shell/shots/c-404-1440-light.png) |
| 登录 | [A](../prototype/claude-shell/shots/a-login-1440-light.png) | [B](../prototype/claude-shell/shots/b-login-1440-light.png) | [C](../prototype/claude-shell/shots/c-login-1440-light.png) |
| 管理台（顶栏 + rail） | [A](../prototype/claude-shell/shots/a-admin-1440-light.png) | [B](../prototype/claude-shell/shots/b-admin-1440-light.png) | [C](../prototype/claude-shell/shots/c-admin-1440-light.png) |

## 6. 怎么复跑

```bash
node prototype/claude-shell/build.mjs        # 30 个页面 + index.html
node prototype/claude-shell/serve.mjs        # http://127.0.0.1:4174/
node prototype/claude-shell/cdp-test.mjs     # 真开 Edge：118/118 通过
node prototype/claude-shell/shots.mjs        # 57 张 + shots/manifest.json
node prototype/claude-shell/contrast-check.mjs # 实际用到的颜色对全部通过
```

原型需要现代浏览器（`light-dark()`、容器查询）。`shots.mjs` / `cdp-test.mjs` 会自己起临时静态服务器，不依赖 `serve.mjs` 常驻；浏览器默认找 Edge，可用 `EDGE_PATH` 指定。

## 7. 建原型时暴露的四个真问题（给 #86 / #87）

1. **`<details>` 不能做「hover / focus 打开」**：关闭的 `<details>` 不渲染子内容，即使 CSS 把子面板算成 `display:block` 也没用（`checkVisibility()` 为 false、`elementFromPoint` 命中的是页面内容）。原型改成普通 `button + div` disclosure：hover 由 `:hover`、focus 由 `:focus-within`、点按由 `.is-open` + `aria-expanded`，三者共用一个 `[data-suppress]` 处理「点按关闭时 hover/focus 仍撑着」的打架。**#87 必须选这个形状，不要选 details。**
2. **手机顶栏工具区必须右对齐**：`.topnav` 隐藏后，`.topbar-tools` 没有 `margin-left:auto` 会把胶囊挤到品牌旁边，面板向左溢出 123px（实测）。已在 `@container (max-width:760px)` 修掉。
3. **管理台不能套 `shell--full`**：`shell--full` 是 block，rail 与正文会上下堆叠（A 版管理台一度出现 1000px 空白）。管理台必须是 `shell--admin` 网格。
4. **空文章列表时标签也要空**：空态页一开始仍渲染 9 个带计数的标签，与「还没有内容」矛盾；已改成空态不渲染标签条。

## 8. 三版取舍与风险（选型时的依据）

### A · 忠实支持中心

- 优点：最接近参考站的阅读节奏；260px 侧栏 + 832 正文在 1440 上最舒展；和地图 Destination 的字面描述最一致。
- 代价：可用性页单列、2235px 高，四个目标要滚很久；日常看面板不如 B 高效。
- 风险：832 正文在 1024/1280 窗口下会随 `minmax(0,1fr)` 缩水；#86 要定 819 / 1099 断点还是保留 720 / 560。

### B · 紧凑工作台

- 优点：侧栏仍常驻（满足「所有公开页」），主列 1068 让可用性三列、列表更高效；正文收窄到 780，阅读不牺牲。
- 代价：224px 侧栏会把最长标题折成两行（「用 Node 单进程同时做站点和探活」实测）；纸感弱于 A。
- 风险：1360 容器在 1280 窗口下侧栏 + 主列会挤；#86 要决定 1360 是否只在 ≥1280 生效。

### C · 混合

- 优点：首页/关于的编辑式排版最有气质；可用性全宽三列最实用；分享/文章仍保留侧栏。
- 代价：**与地图 Notes 第 3 条冲突**（公开侧栏在所有公开页常驻）；同一站三套骨架，实现与 e2e 断言都更复杂；顶栏宽度在 960 / 1180 之间跳。
- 风险：选 C 必须先改地图的第 3 条决定，否则 #86 会在「侧栏在不在首页」上直接撞车。

> **选定 B 之后**：A 与 C 保留为对照材料，不再推进；原型目录不并入产品。B 的像素值只作为 #85 / #86 的起点，最终 token 与断点以决定书为准。

## 9. 这张票不证明什么

- 数据是演示值，不是真实库；文章链接都指向同一篇演示文章。
- 字体是系统栈近似，不是 AnthropicSerif/Sans；中文衬线在 Windows 上落到宋体。
- 没有做真实打印截图；`@media print` 只写了隐藏外壳与全宽正文的规则。
- 没有真机验证；390 是 headless 视口，不是 iPhone 实机。
- 原型的 JS 不是产品方案；产品读面仍应 SSR、无 JS（#86 / #87 决定降级方式）。

## 10. 实现收口（#92，2026-10-22）

- A/B/C 原型已收口；B 的 56 / 224 / 28 / 1360 已落地为产品 token 与外壳。
- 最终与原型的有意差异：侧栏不显示计数、403/404 不带侧栏、移动抽屉用 `<details>` 无读面 JS、改密落 `/account`、
  14 条 HTML GET 路由、头像首字母 13px。
- 视觉回归以产品 1440/390 浅深截图为准；原型截图只作对照，不做像素级 diff。
