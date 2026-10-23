# iOS 组件映射与全站导航呈现：一套字阶、一条侧栏、零新增 JS

> **已被 #86 / #87 取代（2026-10-22）**：公开面导航 / 外壳 / 组件 / 打印 / e2e 清单以 `docs/public-shell-decision.md` 和 `docs/user-menu-decision.md` 为准；本文件保留 iOS 时期的历史，不再作为实现依据。

本文件是「落地设计：iOS 组件映射与全站导航呈现」这张票的产出（map：[整站 iOS 化](https://github.com/Lkyloveaw/lkyloveaw-home/issues/64)）。

票：[#68 落地设计：iOS 组件映射与全站导航呈现](https://github.com/Lkyloveaw/lkyloveaw-home/issues/68)

> **本票只出决定，不改产品代码。** 实现由 [#69 落地切分](https://github.com/Lkyloveaw/lkyloveaw-home/issues/69) 切成批次后另起。上游已定：研究方向 **A · 原生 App**（[#66](https://github.com/Lkyloveaw/lkyloveaw-home/issues/66)）、token 架构 **单 `:root` + `light-dark()` + 三态只切 `color-scheme`**（[#67](https://github.com/Lkyloveaw/lkyloveaw-home/issues/67)）、Web 落地事实（[#65](https://github.com/Lkyloveaw/lkyloveaw-home/issues/65)）。

写本文时的基线（`master` @ `13972d5`，工作树有未提交的原型/研究文件）：

- `public/style.css` **666 行**，13 色、浅色单套、一个 `:root`；两套平面（`body.plane-data|plane-prose`）只换排版；页头是 88% 半透明 + `backdrop-filter`。
- `src/views.ts` **1451 行**，两个 HTML 外壳：`layout()`（含 403/404）与 `loginPage()`（唯一不走 `layout()` 的页面）。
- `scripts/style-check.mjs` **72/72 全绿**（本票不改，数字是基线）。
- 客户端 JS：`public/status.js`（面板 30 秒重绘）、`public/chart-path.js`（曲线几何）、`public/article-editor.js`（TipTap 打包产物）。**这三个文件的 DOM 契约是本票的硬约束**。
- 原型：`prototype/ios/`（A/B/C + `base.css` 的组件语言 + 截图），方向 A 已由用户选定。

---

## 0. 一句话结论

| 问题 | 结论 |
| --- | --- |
| 排版 | **退掉两套平面**：`--font-data/prose`、`--fs-data/lh-data`、`--fs-prose/lh-prose`、`plane-data/plane-prose` 全部退役；全站一套 **iOS 字阶**（10 个字号 token + 4 个行高 token），等宽只留给 `code/pre/.mono/`id/slug |
| 导航 | 桌面 = **左侧栏（rail）是唯一导航**：组「站点」+ 组「管理」（仅管理员，内含 #59 的「运维 / 内容」两段）；手机 ≤720 = **底部 tab bar**（4 / 5 项）+ 管理台页面顶部模块条；页头只留 brand / 主题 / 登出，**不透明** |
| 组件 | 四个基元 `card` / `inset-list` + `cell` / `group-title` / 控制件；类名只在新概念确实不同时才改名，**旧名说谎的才改**（`plane-*`、`--fg*`、`--bg-soft`、`--border`、`.admin-table`、`.admin-side*`、`.site-nav`、`.nav-sep`） |
| 表单与确认 | **不引入 `<dialog>`**：管理台用 `<details>` 折叠表单与破坏性动作（零 JS、保留「禁用 JS 也能写」）；确认框保留原生 `required` 复选框 |
| 控件 | 只做**已有控件**的 iOS 呈现：按钮四级（filled / tinted / plain / danger）、原生 checkbox + `accent-color`、`<select>` 主题三态、inset 列表行；**不新增**分段控件 / 开关 / 搜索 / 分页（站点没有对应用例，加了就是新功能） |
| 图标 | **7 个内联 SVG**（`home / doc / pulse / info / sliders / chev / plus`），零图标字体、零外链图片、零 JS 依赖 |
| JS | **本图组件层零新增 JS**；唯一的新脚本是 #67 已定的主题 boot + picker 同步（在两个外壳的 `<head>`/`</body>`）。`status.js` / `chart-path.js` / `article-editor.js` **一行不改** |
| 打印 | `body` 上 17 个灰阶 token；状态格带改**图案**（实心 / 45° 斜线 / 斜网格 / 空心）；导航、页头、按钮、表单、选择器全隐藏 |
| 断言 | `style-check` 72 → **≈151 项**（含 #67 的 62 项对比度；逐段公式见 §13.1）；`e2e` 有 **32 条**落在「两套平面 + 顶栏 + 管理台侧栏」三组，必须同批改写；`panel-check` / `chart-check` / `editor-check` 不动 |

---

## 0.5 票面十问的落点（自查用）

| 票面问题 | 本文落点 |
| --- | --- |
| 1. 导航呈现（顶栏 / 侧栏 / tab bar / 分组列表→详情 / 管理台侧栏 / 当前项 / 窄屏 / 403） | §5（全节）+ §8.1 |
| 2. 公开面（首页 / 分享 / 文章 / 关于 / 标签条 / 大标题 / 分组卡片 / chevron / 空态） | §6 |
| 3. 数据面（格带 / 曲线 / 目标卡 / 状态点徽标 / 统计条 / 渐进披露层级） | §7（含「面板不折叠」的取舍） |
| 4. 管理台（表格→列表 / 行内编辑 / 表单 / 确认框 / notice / 破坏性操作 / 备份 / 设置 / 账号 / 文章） | §8 |
| 5. 控件（按钮四级 / 分段 / 开关 / sheet / alert / search / 分页 / 加载） | §9.1–9.3（含「六个不引入」的清单） |
| 6. 图标（内联 SVG 最小集 / SF Symbols 替代 / 不用图标时的退路） | §9.4 |
| 7. 图表（颜色 / 网格 / 轴标签在深浅两套下的 token 化） | §10 |
| 8. 编辑器（TipTap 工具栏与正文区） | §8.8 |
| 9. 打印（黑白 / 组件降级 / 格带图案） | §11 |
| 10. 每个组件的「现有 → 新 → 只 CSS/改 markup/加 JS → 断言」 | §12（六张表）+ §13（断言迁移） |

---

## 1. 边界：本票决定什么、不决定什么

**决定**：iOS 控件 / 导航 / 密度 / 排版 token 到现有 HTML 的逐项映射；每个组件的「只 CSS / 改 markup / 加 JS」归属；每条现有断言的去向。

**不决定**：

- 实现批次怎么切、每批验收顺序 —— [#69](https://github.com/Lkyloveaw/lkyloveaw-home/issues/69)。
- 17 个颜色 token 的取值与 `light-dark()` 机制 —— [#67](https://github.com/Lkyloveaw/lkyloveaw-home/issues/67) 已定，本文只**重述用法边界**。
- 是否新增功能 / 路由 / 数据 —— map Out of scope。
- 文档最终措辞 —— 本文给修订清单，落笔归 #69。

**四条不可越界的既有约束**（全部来自本仓已落地的决定，不是本文发明）：

1. **禁用 JS 也能读、能写**（`docs/editor-shape-decision.md` / 管理台各页）。读面是 SSR；写面是原生表单 + 服务端守卫。→ 组件映射里任何「模态、客户端确认、客户端校验」都要先过这条。
2. **面板客户端契约**：`public/status.js` 通过 `[data-target]` / `[data-state]` / `[data-timeline]` / `data-cells` / `.dot` / `.badge` / `.uptime` / `.kv dd` / `.target-error` / `.js-cells` / `.js-generated` / `[data-chart]` / `.chart-avg` / `.status-banner` / `#status-root` 定位节点；`STATE_CLASS` 与服务端 `STATUS_CLASS` 是同一套词。→ **这些类名与属性一个都不能改**（改了就同时改 JS，等于给本图加 JS 面）。
3. **状态不许只靠颜色**（CONTEXT.md「状态」词条 + WCAG 1.4.1）：点有形状（圆 / 方 / 三角 / 空心），徽标有文字，打印有图案。
4. **一个 `:root`**（#67）。打印只改 `body`；组件里不写字面量颜色。

---

## 2. 显式修订：本决定取代了什么

map Notes 要求「在新决定书里**显式修订**这四张旧票，不许偷偷改」。逐条列出，落地时同步改对应文档里的措辞：

| 旧决定 | 旧结论 | 被本文改成 | 为什么（不是口味） |
| --- | --- | --- | --- |
| [#21 整站视觉原型：数据面终端化 + 正文面纸感化](https://github.com/Lkyloveaw/lkyloveaw-home/issues/21) · `docs/visual-prototype-decision.md` | 两套**平面**（数据面等宽终端化 / 正文面纸感 68ch），只差排版不差配色 | **一套 iOS 字阶**，不再按「数据 / 正文」换字体；68ch 窄栏保留给长文 | 等宽字体是「终端感」，与 iOS 的系统字体语言直接冲突；A 方向已选定（#66） |
| [#45 实现⑧整站视觉：正文面纸感化与全站推广](https://github.com/Lkyloveaw/lkyloveaw-home/issues/45) | 实现的是 B 暖色纸墨 + 两套平面；「打印保留状态色」 | 全部由本图重做；打印状态色**退役**，改图案 + 文字 + 形状 | 同上；另外 `--ok/--bad` 打印都变 `#000`，只靠色块已分不出状态（#67 §6） |
| [#58 管理台长出左侧导航，整站配色三选一](https://github.com/Lkyloveaw/lkyloveaw-home/issues/58) · `docs/admin-console-sidebar-decision.md` | 管理台**内部**有侧栏，公开页**没有**侧栏；顶栏 4/5 项 + `/` 分隔；403 不长侧栏 | 侧栏**升为全站唯一导航**（rail）；管理台模块成为 rail 里的「管理」组（保留 #59 的运维 / 内容分组）；顶栏导航与 `.nav-sep` 退场；403/404 **也长 rail**（导航始终可用） | A 方向 = 侧栏 + 大标题；桌面站只有一条导航才像 App。信息架构（条目、顺序、URL、模块分组）**一条没改** |
| [#60 主题三选一](https://github.com/Lkyloveaw/lkyloveaw-home/issues/60) · `docs/theme-decision.md` | 13 色、浅色单套、不跟随系统 | 17 色 `light-dark()`、三态（系统 / 浅 / 深）、默认跟随系统 | #67 已接过；本文只负责把「主题」词条与旧文档标注为**已被取代** |
| `CONTEXT.md` 的「主题 / 数据面 / 正文面」词条 | 13 色一套；两个平面 | 「主题」= 17 色 + 三态；「数据面 / 正文面」**删除**，换成「iOS 字阶 / 导航（rail + tab bar）」 | 词汇表不能留着两个已经不存在的概念 |

同时**保留**的既有决定（不要顺手改）：URL 与信息架构、`adminSection` 六模块与两段分组、`aria-current="page"` 作为唯一当前项判据、管理台写路径的 CSRF / 守卫 / notice 闭集、面板的三档状态与定宽格带、TipTap 编辑器引擎。

---

## 3. 三条落地原则

### 3.1 先有基元，再有页面

页面不直接写样式，只组合四个基元 + 控制件：

```
card（--bg-card + hairline + --radius-lg）
inset-list + cell（分组列表；行 ≥ --tap，行间 hairline 内缩）
group-title（组标题，--fs-subhead + --label-2）
stat（指标卡，--fs-title3 数字 + --fs-caption 标签）
```

这不是为了抽象而抽象：`inset-list` / `cell` 一个基元同时覆盖**分享列表、面板目标卡里的键值行、管理台六个列表、异常列表、修订历史、备份文件**。少一种结构，就少一套断言与中间态。

### 3.2 类名改名判据

只改**旧名说谎**的：

| 旧名 | 为什么必须改 | 新名 |
| --- | --- | --- |
| `plane-data` / `plane-prose` | 两个平面不存在了，留着就是两个假概念 | 删除（`<body>` 不再带平面类） |
| `--fg` / `--fg-dim` / `--fg-faint` | 它们对应 label / label-2 / label-3 三档语义，但语义混着用：`--fg-faint` 既当最弱文字（meta、页脚、空态）又当装饰色（`nav-sep`） | `--label` / `--label-2` / `--label-3`（**文字与图标**）与 `--separator` / `--border-strong`（**线**） |
| `--bg-soft` | 它是「填充底」，与 `--bg-elev`（抬升面）是两件事 | `--fill`（+ 新的 `--fill-strong`） |
| `--border` | 一条线同时是 hairline 与控件边界，1.4.11 的 3:1 要求只对后者成立 | 拆成 `--separator` / `--border-strong` |
| `--side-w` | 侧栏从「管理台内部」升为全站 rail，宽度语义变了 | `--rail-w` |
| `.site-nav` / `.nav-sep` | 顶栏 `/` 分隔条目退场 | `.site-rail` + `.tab-bar` |
| `.admin-side*` | 管理台侧栏退场，模块进 rail + 手机模块条 | `.rail-*` + `.admin-tabs` |
| `.admin-table` | 表格改分组列表；留着这个名字会让「表格还能用」的错觉留在断言里 | `.inset-list` + `.cell` |
| `.admin-shell` / `.admin-main` | 外壳不再专属于管理台 | `.app-shell` / `.app-main` |
| `.mini-list` / `.mini-row` | 它就是一组列表行 | `.inset-list` / `.cell` |

**不改名**的（语义仍然成立，且被 JS / 断言钉住）：`.dot` `.badge` `.cell-strip` `.cell-caption` `.kv` `.target-error` `.uptime` `.js-cells` `.js-generated` `.stat*` `.tag*` `.notice*` `.card` `.wrap` `.sr` `.form-row` `.form-actions` `.confirm` `.btn-danger` `.group-title` `.target-*` `.editor-*` `.ProseMirror` `.login-*` `.chart*` `.revision-*` `.article-preview` `.upload-preview` `.media-snippet` `.site-header` `.header-inner` `.brand` `.logout-form` `.site-footer` `.empty` `.back` `.meta` `.summary` `.tags` `.prose` `.post` `.post-header` `.post-card` `.section` `.section-head` `.hero` `.lede` `.more`。

### 3.3 零 JS 优先，JS 只有一处新增

| JS 来源 | 谁负责 | 本票的处置 |
| --- | --- | --- |
| 主题 boot + picker 同步 | #67 已定 | 本文只定**位置**（两个外壳、stylesheet 之前；picker 在页头 / 登录页右上） |
| 面板 30 秒重绘 `status.js` | 已有 | **一行不改**：所有钩子类名与 `data-*` 原样保留 |
| 曲线几何 `chart-path.js` | 已有 | 不改；图表颜色已走 token |
| TipTap `article-editor.js` | 已有 | 不改；工具栏是它自己创建的按钮，样式由 CSS 给 |
| 模态 / 折叠 / 校验 / 筛选 | —— | **不新增**：一律用 `<details>`、原生控件、服务端渲染 |

因此「加 JS」这一列在下面的映射表里**全部是 —**，只有两处注明「由 #67 的脚本承担」。

---

## 4. token 与排版

### 4.1 颜色：沿用 #67 的 17 个，一个不多一个不少

| token | 用途（本文新增的约束） |
| --- | --- |
| `--bg` | 页面底 / 侧栏底 |
| `--bg-card` | 卡片 / inset-list / 页头 / tab bar / 弹层内容面 |
| `--bg-elev` | 抬升面：卡内凹块、侧栏当前项底、分段控件轨道（**不再用于**表格表头） |
| `--fill` | 输入框底、tag 底、tinted 按钮底、空态底、行 hover |
| `--fill-strong` | 更重填充：行内分隔的强调块、当前项 hover |
| `--label` | 正文 / 标题 / 行标题 |
| `--label-2` | 次文字：meta、说明、行副标题、**所有 12–13px 小字**、图表轴标签 |
| `--label-3` | **只做非文字**：chevron、图标装饰；不用于任何正文（含 12px 轴标签） |
| `--separator` | hairline：卡片描边、行分隔、页头底线 |
| `--border-strong` | 控件边界（输入框 / 按钮 / checkbox / 空心点 / 焦点前的地面） |
| `--accent` | 链接、当前项、主按钮底、焦点环 |
| `--on-accent` | 主按钮文字（深色翻黑） |
| `--ok` / `--warn` / `--bad` | 状态文字 / 点 / 徽标 / 格带 / notice 左边条 |
| `--unknown` | **只做填充**：无数据格、无数据点底；有意义的「无数据」轮廓改用 `--border-strong` |
| `--scrim` | 唯一非 hex；本图**没有消费者**（不用 `<dialog>`），保留给将来，打印改 `#000000` |

**token 使用的三条硬规则**（落地时逐条 grep 检查）：

1. 文字所在的底必须是**纯色 token**（`--bg` / `--bg-card` / `--bg-elev` / `--fill`）；`color-mix()` 只许出现在**非文字**的边框、背景装饰、图标上。
2. `--label-3` 不许出现在 `font-size` 小于 20px 的文字规则里（它只有 3.27–4.15:1，只够非文字 3:1）。
3. 组件里不写 `#hex` / `rgb()` / `hsl()`；阴影一律不做（用 hairline + 底色差做层级）。

### 4.2 非颜色 token：16 → 24（#67 §2.2 的 16 个里删 7 加 15）

`:root` 里最终这 24 个（`style-check` 的 `NON_COLOR` 就是这张表）：

| 类别 | token |
| --- | --- |
| 形状 | `--radius-sm: 8px` · `--radius: 12px` · `--radius-lg: 16px` · `--tap: 44px` |
| 栏宽 | `--wrap: 900px` · `--wrap-admin: 1140px` · `--rail-w: 248px` |
| 字体 | `--font`（系统栈，现状保留）· `--mono`（只给 `code/pre/.mono/`id/slug/**图表无**） |
| 字号（10） | `--fs-large: 34px` · `--fs-title1: 28px` · `--fs-title2: 22px` · `--fs-title3: 20px` · `--fs-headline: 17px` · `--fs-body: 17px` · `--fs-callout: 16px` · `--fs-subhead: 15px` · `--fs-footnote: 13px` · `--fs-caption: 12px` |
| 行高（4） | `--lh-tight: 1.25` · `--lh-title: 1.3` · `--lh-ui: 1.55` · `--lh-prose: 1.85` |
| 阅读 | `--measure-prose: 68ch` |

**退役**：`--font-data` `--font-prose` `--fs-data` `--lh-data` `--fs-prose` `--lh-prose` `--side-w`。
**新增**：`--bg-elev` 不在此表（它是颜色）；`--rail-w` `--radius-sm` `--radius-lg` `--tap` `--fs-*`×10 `--lh-*`×4（`--radius` `--wrap` `--wrap-admin` `--font` `--mono` `--measure-prose` 是原有的）。

### 4.3 字阶：iOS text style → token → 落点

行高按 #65 §2.3 的取舍：**CJK 组件文字 1.55、长文 1.85**，不复刻 iOS 的 1.29。

| iOS style | token | 字号 / 行高 | 字重 | 落点（选择器） |
| --- | --- | --- | --- | --- |
| Large Title | `--fs-large` | 34 / `--lh-title` 1.3 | 700 | 页面主标题：`.large-title`（首页 hero、各页 h1） |
| Title 1 | `--fs-title1` | 28 / 1.3 | 700 | 文章页标题 `.post-header h1`；404/403 大标题 |
| Title 2 | `--fs-title2` | 22 / 1.3 | 600 | 区块标题 `.section > h1/h2`、`.prose h2` |
| Title 3 | `--fs-title3` | 20 / 1.3 | 600 | 卡片标题 `.card h2`、`.target-head h3`、`.prose h3`、指标数字 `.stat-num` |
| Headline | `--fs-headline` | 17 / `--lh-ui` | 600 | inset 行标题 `.cell-title`、`.section-head h2`、`.target-row-head strong` |
| Body | `--fs-body` | 17 / `--lh-prose` | 400 | `.prose` 正文、`.post .summary`、首页 lede |
| Callout | `--fs-callout` | 16 / `--lh-ui` | 400 | `<body>` 基准、表单说明、`.notice` 文本 |
| Subhead | `--fs-subhead` | 15 / `--lh-ui` | 400 | 行副标题 `.cell-sub`、组标题 `.group-title`、`.admin-hint`、表格样文本 |
| Footnote | `--fs-footnote` | 13 / `--lh-ui` | 400 | `.meta`、时间戳、`.stat-sub`、`.target-url`、页脚 |
| Caption | `--fs-caption` | 12 / 1.4 | 400 | `.tag`、`.badge`、`.cell-caption`、`.chart-axis`、`.chart figcaption`、tab bar 标签 |

**字重只用 400 / 500 / 600 / 700**（系统栈在 Windows 上没有 650 这种中间值，现状 `.brand` 的 650 会被就近取整）。
**字距**只在 ≥28px 的标题上写 `letter-spacing: -0.02em`；其余不动。
`body { font-size: 16px }` **保留**：字号 token 是 px，跟随浏览器默认字号那条通道本图不接（Dynamic Type 不在范围，见 §15）。

### 4.4 文字 token 分配（现状最容易错的一处）

现状 666 行里 `--fg-faint` 被同时当「最弱文字」和「线」用，`--fg-dim` 又覆盖了 12–15px 的小字。新 token 下这张表是**唯一**的分配依据：

| 角色 | 用什么 | 现状 → 新 |
| --- | --- | --- |
| 正文 / 行标题 / 标题 | `--label` | `--fg` → `--label` |
| meta / 说明 / 行副标题 / 12–13px 小字 / 图表轴 | `--label-2` | `--fg-dim`、`--fg-faint`（文字场合）→ `--label-2` |
| chevron / 图标 / 装饰 | `--label-3` | `--fg-faint`（旧代码里既做弱文字又做装饰）→ `--label-3` |
| 卡片描边 / 行分隔 | `--separator` | `--border` → `--separator` |
| 输入框 / 按钮 / checkbox 边界 | `--border-strong` | `--border` → `--border-strong`（**不许盲替换**） |
| 输入框底 / tag 底 / 空态底 / hover | `--fill` | `--bg-soft` → `--fill` |
| 卡内凹块 / 当前项底 | `--bg-elev` | `--bg-soft`（部分）→ `--bg-elev` |

⚠ `--border` 的两义性是本批**最容易静默坏掉**的点：全局替换成 `--separator` 会让输入框边界掉到 1.6:1 一档（1.4.11 失败），而肉眼几乎看不出来。落地时按**选择器**逐条判，不按 token 批量替换。

### 4.5 形状、间距、点击目标

- 圆角：卡片 / inset-list / 折叠面板 `--radius-lg`；按钮 / 输入框 / 小块 `--radius`；`.tag` / `.badge` / 格带格 `--radius-sm` 或 `999px`。
- 间距：**4px 网格**（4 / 8 / 12 / 16 / 24 / 32），不设间距 token（多一个 token 就多一条断言，换不来什么）。
- 点击目标：**触摸面**（手机 tab 项、列表行、checkbox 行）`min-height: var(--tap)`（44px）；**桌面专用**的 rail 条目 38px、按钮视觉 36px（指针精准，不需要 44）；两者的可点区域都由 padding 撑到实际尺寸，不靠 `::before` 扩边。

### 4.6 层级：不做阴影

现状没有阴影，原型 A 用了极轻的 `box-shadow` 做当前项浮起。本文**明确不做**：

- 卡片 / 行 / 页头的层级靠**底色差 + hairline**（`--bg` → `--bg-card` → `--fill`）；
- 唯一的 `box-shadow` 用法是 `inset 0 0 0 Npx` 的**环**（`.dot.unknown` 的空心环、`.cell-missing` 的空心格），颜色必须是 token；
- 理由：阴影需要颜色字面量或透明度，会破坏「颜色只在 `:root` / 打印块」的纪律；iOS 内容层本身也是实色。

---

## 5. 导航呈现（本票最大的一块）

### 5.1 桌面：一条 rail

`layout()` 输出这个骨架（`active` / `adminSection` 只影响高亮与「管理」组是否渲染；下面的 `aria-current` 是**示意**，实际每页恰好一个）：

```html
<body class="...">
<header class="site-header">
  <div class="wrap header-inner">
    <a class="brand" href="/">个人站</a>
    <div class="header-actions">
      <label class="theme-picker"><span class="sr">主题</span>
        <select data-theme-select aria-label="主题">…系统 / 浅 / 深…</select></label>
      <form class="logout-form" method="post" action="/logout">…csrf…<button type="submit">登出</button></form>
    </div>
  </div>
</header>
<div class="app-shell"><!-- 管理台页加 --admin 修饰 -->
  <nav class="site-rail" aria-label="站内导航">
    <div class="rail-group">
      <span class="rail-group-label">站点</span>
      <a class="rail-link" href="/" aria-current="page"><svg class="icon">…</svg><span>首页</span></a>
      <a class="rail-link" href="/posts"><svg class="icon">…</svg><span>分享</span></a>
      <a class="rail-link" href="/status"><svg class="icon">…</svg><span>系统可用性</span></a>
      <a class="rail-link" href="/about"><svg class="icon">…</svg><span>关于</span></a>
    </div>
    <!-- 仅 currentIsAdmin()： -->
    <div class="rail-group">
      <span class="rail-group-label">管理</span>
      <span class="rail-sub-label">运维</span>
      <a class="rail-link" href="/admin" aria-current="page">…概览…</a>
      <a class="rail-link" href="/admin/targets">…目标…</a>
      <a class="rail-link" href="/admin/accounts">…账号…</a>
      <a class="rail-link" href="/admin/backups">…备份…</a>
      <a class="rail-link" href="/admin/settings">…设置…</a>
      <span class="rail-sub-label">内容</span>
      <a class="rail-link" href="/admin/articles">…文章…</a>
    </div>
  </nav>
  <main class="wrap app-main">…页面 body…</main>
</div>
<nav class="tab-bar" aria-label="站内导航（手机）">…4/5 项…</nav>
<footer class="site-footer"><div class="wrap">…</div></footer>
</body>
```

CSS 骨架（`app-shell` 的两列，内容列 `minmax(0, 1fr)` 保留 —— 宽表 / 长 code 不能把网格撑破）：

```css
.app-shell { display: grid; grid-template-columns: var(--rail-w) minmax(0, 1fr); gap: 0; }
/* 宽度与左右内边距仍由 .wrap 给（900 / 20），这里只补上下 */
.app-main { padding-block: 24px 48px; }
.app-shell--admin .app-main { max-width: var(--wrap-admin); }
.site-rail { padding: 16px 12px; border-inline-end: 1px solid var(--separator); display: flex; flex-direction: column; gap: 20px; }
.rail-group { display: flex; flex-direction: column; gap: 2px; }
.rail-group-label { padding: 0 10px 6px; color: var(--label-2); font-size: var(--fs-caption); font-weight: 600; letter-spacing: .08em; }
.rail-sub-label { padding: 6px 10px 2px; color: var(--label-2); font-size: var(--fs-caption); letter-spacing: .04em; }
.rail-link { display: flex; align-items: center; gap: 10px; min-height: 38px; padding: 6px 10px; border-radius: var(--radius-sm); color: var(--label-2); font-size: var(--fs-subhead); font-weight: 500; }
.rail-link:hover { background: var(--fill); color: var(--label); text-decoration: none; }
.rail-link[aria-current="page"] { background: var(--bg-card); color: var(--label); font-weight: 600; }
.rail-link[aria-current="page"] .icon { color: var(--accent); }
```

判定：

| 问题 | 决定 |
| --- | --- |
| 公开页有没有 rail | **有**。全站唯一导航，公开页与管理台用同一条（这是对 #58/#59「侧栏只在管理台内部」的显式修订） |
| 管理组谁看得见 | 只有 `currentIsAdmin()`。只读用户看不到「管理」组，也就没有点了 403 的入口（沿用原有的角色判据） |
| 管理组里的分组 | 保留 #59 的「运维 5 项 / 内容 1 项」，用 `.rail-sub-label` 表达；**模块顺序一字不改** |
| 当前项 | 仍只认 `aria-current="page"`，由 `key === active`（站点）/ `key === section`（模块）判定，**全站恰好一个** |
| 条目带不带计数 | 不带（#58 Notes 10 仍成立） |
| 403 / 404 的当前项 | 无（不属于任何条目），但 rail 照常渲染 → 用户永远有路回首页 |
| 登录页 | 没有 rail（它本来就不该有站内导航） |
| 编辑器页 | 属于管理台 → rail + 管理组当前项「文章」 |

### 5.2 手机 ≤720：底部 tab bar + 管理模块条

- `.tab-bar`：`position: fixed; inset-inline: 0; bottom: 0`，`background: var(--bg-card)`，`border-block-start: 1px solid var(--separator)`；四项（只读）或五项（管理员，第五项「管理」→ `/admin`）；图标 22px + 标签 `--fs-caption`。
- 页面底部留白：`@media (max-width: 720px) { body:not(.login-body) { padding-bottom: 64px } }`，否则最后一行被遮住。
- 管理台页面（`adminSection` 存在）`<main>` 顶部额外渲染 `.admin-tabs`（横向可滚的模块条，含「运维 / 内容」两段），**只在 ≤720 显示**：桌面用 rail，手机用模块条，二者不会同时出现。
- tab bar 里**不放**管理台模块（站点的全部路由塞不进 5 项 —— #65 §5.6 的结论；模块切换交给 `.admin-tabs`）。

```html
<nav class="admin-tabs" aria-label="管理台模块">
  <div class="admin-tabs-group"><span class="admin-tabs-label">运维</span>
    <a href="/admin" aria-current="page">概览</a><a href="/admin/targets">目标</a>…
  </div>
  <div class="admin-tabs-group"><span class="admin-tabs-label">内容</span>
    <a href="/admin/articles">文章</a>
  </div>
</nav>
```

### 5.3 页头：不透明（A 的落地约束）

```css
.site-header { position: sticky; top: 0; z-index: 20; background: var(--bg); border-block-end: 1px solid var(--separator); }
.header-inner { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: 56px; flex-wrap: wrap; }
```

- **没有 `backdrop-filter`、没有半透明底**（#65 §4：做不出 vibrancy，且对比度无法静态证明）。断言直接钉 `!/backdrop-filter:/`。
- `.brand`：`--fs-headline` 600，不用等宽。
- `.header-actions`：主题 picker + 登出表单，右对齐；≤560 允许换行。
- 主题 picker 就是 #67 的 `<select>`（原生、自带三态语义），在页头 `登出` 之前；`.theme-picker select` 高 34px、`--fill` 底、`--label` 字、`--radius` 圆角。

### 5.4 登录页：独立外壳 + 右上 picker

```html
<body class="login-body">
<div class="login-theme"><label class="theme-picker">…同一份 picker…</label></div>
<main class="login-wrap">…</main>
</body>
```

- `.login-theme { position: fixed; top: 16px; right: 16px; z-index: 10 }`（**fixed 由 CSS 给**，不新增外壳结构）。
- `.login-wrap`：`--bg-card`、`--radius-lg`、`--separator`、宽 360、padding 32/28；标题 `--fs-title1`，lede `--label-2` + `--fs-subhead`，表单控件与按钮见 §9。
- 登录页**不出现** rail / tab bar / 页脚（现状本来就如此，保持）。

### 5.5 403 / 404：错误态 = 居中空态

- 两者都走 `layout()`（#67 已核对），因此自动获得页头、rail、picker；`bodyClass` 传 `page-error`（现有 `layout()` 的 `bodyClass` 选项第一次被用上）。
- 结构：`.large-title`（「404」/「需要管理员权限」）+ `.lede` + 一个 `btn-plain` 或 `btn-primary` 回首页；**不新增路由**。
- 403 页对只读用户同样渲染 rail 的「站点」组（没有管理组），这也修正了「403 不长侧栏」的旧断言。

### 5.6 打印：导航全隐藏

```css
@media print {
  .site-header, .site-rail, .tab-bar, .admin-tabs, .site-footer, .theme-picker, .logout-form { display: none !important; }
  .app-shell { display: block; }
  .app-main { max-width: none; padding: 0; }
  body { padding-bottom: 0; }
}
```

### 5.7 导航相关的断言（新增/改写清单见 §13）

| # | 断言 |
| --- | --- |
| N1 | `layout()` 输出**一个** `<nav class="site-rail" aria-label="站内导航">`，且「站点」组恰好 4 条 `.rail-link` |
| N2 | 管理组只在 `currentIsAdmin()` 时渲染；组内 6 条、顺序 = 概览/目标/账号/备份/设置/文章 |
| N3 | 管理组里有「运维」「内容」两个 `.rail-sub-label` |
| N4 | 当前项恰好一个，且 `aria-current="page"` 出现在 `key === active \|\| key === section` 那一支 |
| N5 | `.tab-bar` 恰好 4 或 5 条 `.tab-item`，且与 rail 同源（同一张 `NAV_ITEMS` 表） |
| N6 | `.admin-tabs` 只在 `adminSection` 存在的页面渲染；且只在 ≤720 显示 |
| N7 | 页头 `background: var(--bg)` 且全站无 `backdrop-filter:` |
| N8 | `[data-theme-select]` 恰好 2 处（layout + login）；三选项；`aria-label="主题"` |
| N9 | `views` 里没有 `matchMedia`、主题脚本里没有 `document.cookie` |
| N10 | 打印隐藏 header / rail / tab-bar / admin-tabs / picker |

---

## 6. 公开面逐页映射

### 6.1 首页（`homePage`）

| 区块 | 现状 | 新呈现 | 改动面 |
| --- | --- | --- | --- |
| hero | `.hero h1` 1.9rem / `.plane-prose` 2.1rem；`.lede` | `.hero > .large-title`（34/700/-0.02em）+ `.lede`（17 / `--label-2` / 62ch） | 改 markup（h1 加 `.large-title`）+ CSS |
| 状态摘要 | `.section-head` + `.stat-strip` + `.mini-list` | `.section-head`（h2 22 / more `--label-2`）+ `.stat-strip`（3 张 `.stat`）+ `.inset-list` 的 `.cell` 行（dot + name + latency + uptime，**不折叠**） | 改 markup（`.mini-*` → `.cell`） |
| 最近分享 | `.post-card`（h2 + meta + summary + tags） | `.inset-list.post-list` 内的 `.cell.post-card`：`.cell-title`（17/600）+ `.meta`（13）+ `.summary`（15）+ `.tags` + 行尾 `.chev` | 改 markup |
| 空态 | `.empty` 虚线框 | `.empty`：`--fill` 底、`--radius-lg`、居中、无虚线；文案不动 | 只 CSS |

**整行可点**：`.post-card .cell-title a::after { content: ''; position: absolute; inset: 0; border-radius: inherit }`，卡片 `position: relative`；卡片里的 `.tags a` 加 `position: relative; z-index: 1` 保持可点。标题仍是 `<h2>`（屏幕阅读器的标题导航不丢），点击目标却是整行。

### 6.2 分享列表（`postsPage`）与标签页

- 标题 `h1` → `.large-title`；列表同上（`.inset-list.post-list`）。
- 标签条 `.tag-bar` → `.chip-row`（横向可滚、无滚动条、`gap: 6px`）；tag 仍是 `.tag`，当前标签 `.tag-active` 用 `--accent`。
- 计数 `.tag-count` 用 `--label-2` + `--fs-caption`（**不是** `--label-3`）。
- 空态：`.empty`。

**`.tag` 的四个语义必须在本次分清**（现状一个 `.tag-active` 同时表示「当前筛选 / 启用中 / 管理员 / 回收站」四件事）：

| 类 | 含义 | 颜色 | 现状谁在用 |
| --- | --- | --- | --- |
| `.tag` | 中性 | `--fill` 底 + `--label-2` 字（5.01） | 草稿、已停用、普通标签 |
| `.tag-active` | **当前选中** | `--bg-card` 底 + `--accent` 字 + inset `--accent` 环（5.80） | 标签条里的当前筛选 |
| `.tag-ok` | **正向状态** | `--bg-card` 底 + `--ok` 字 + inset `--ok` 环（5.42） | 「启用中」「管理员」 |
| `.tag-warn` | **需要注意** | `--bg-card` 底 + `--warn` 字 + inset `--warn` 环（5.22） | 「回收站」 |

> ⚠ 三个彩色档**必须用 `--bg-card` 做底**，不能沿用中性档的 `--fill`：`ok` 在 `--fill` 上只有 **4.27:1**、`warn` 只有 **4.12:1**（都不达 AA），而 `ok/warn/accent` × `--bg-card` 三对都在 #67 的 19 对里（5.42 / 5.22 / 5.80）。

### 6.3 文章页（`postPage`）

- `.post` 收窄到 `--measure-prose` 并居中（#47 的两条断言保留）。
- `.post-header h1` → `--fs-title1` 28 / 1.3；`.meta` 13 / `--label-2`；`.tags` 同 tag。
- 正文 `.prose`：`--fs-body` 17 / `--lh-prose` 1.85；`h2` = 22 / 600，`h3` = 20 / 600；段落间距 16px；`blockquote` 左侧 3px `--separator` + `--label-2`；`code` 用 `--mono` + `--fill` 底、`--radius-sm`；`pre` 同样。
- 表格：`.table-wrap` 横向滚动（#47 决定保留）；表头底 `--fill`、边框 `--separator`、单元格 `min-width: 5.5em`；打印时 `overflow: visible`。
- `.back` 13 / `--label-2`。

### 6.4 关于页（`aboutPage`）

- 结构不变（`.section.prose`）；标题 `.large-title`；`h2` = 22；`pre` 内是 YAML/Markdown 片段 → `--mono` 12.5px（`--fs-footnote`）。

### 6.5 空态与错误态的统一形状

| 状态 | 呈现 |
| --- | --- |
| 没有文章 / 没有目标 | `.empty`（`--fill` 底，`--label-2`，居中，无虚线） |
| 404 | `.page-error` 居中：`.large-title`「404」+ `.lede` + `.btn-plain`「回首页」 |
| 403 | 同上，标题换成具体文案（「请求来源不可信」/「页面已过期」/「需要管理员权限」），文案不动 |
| 面板接口失败 | `status.js` 的 `.status-banner`（`.notice` + warn 左边条），类名不动 |

---

## 7. 面板（`statusPage`）

### 7.1 结构：卡片墙保留，不折叠

| 区块 | 现状 | 新呈现 | 改动面 |
| --- | --- | --- | --- |
| 页名 + live 提示 | `.section-head h1` + `.live-tag` | `.large-title`（34）+ `.live-tag`（13 / `--label-2`，`--ok` 圆点 + pulse 保留，`prefers-reduced-motion` 关掉） | 只 CSS |
| 统计条 | `.stat-strip` 4 张 `.stat` | 同结构；数字 `--fs-title3` 700 tabular，标签 `--fs-caption` `--label-2`；`has-fault` 用 `--bad` | 只 CSS |
| 整体可用率图 | `.chart-wide` | 自己加 `--bg-card` 底 + `--radius-lg`（**不新增包裹元素**）；无网格线，用 `--separator` 的 repeating-linear-gradient 做纸纹式网格（纯 CSS、非文字） | 只 CSS |
| 分组标题 | `.group-title` | 15 / 600 / `--label-2`，与列表间距 8px | 只 CSS |
| 目标卡 | `.card.target-card`（head / url / 56 格带 / caption / 曲线 / kv / error） | **保持全部字段可见**（见 7.2），圆角 `--radius-lg`、`--bg-card`、hairline；head 里 h3 = 17/600，badge 不动 | 只 CSS（结构不变） |
| 异常列表 | `ul.incident-list`（grid 三列） | `ul.inset-list.incident-list`：每行 `.cell`，时间 13 `--label-2`、名称 15/600、错误 13 `--label-2` 右对齐；≤560 折成两行 | 改 markup（只加 `.inset-list` 类 + li 内不改） |
| 空态 | `.empty` | 同 §6.5 | 只 CSS |

### 7.2 面板**不做**渐进披露（这是有意的取舍）

map Notes 第 9 条要求「渐进披露：默认摘要、详情展开」。本文把这条落在**管理台**（§8），**不落在面板**：

- 面板是「一眼扫过」的界面（`public/status.js` 的头注释写的就是这个判据）；目标卡上的格带、曲线、kv 是**互相解释**的四件事（格带看历史、曲线看趋势、kv 看当前、error 看原因），折掉任何一半都要多点一次才开始判断。
- 折叠会带来两件额外代价：① 打印时折叠内容丢失（`<details>` 闭合态在纸上不渲染，且 CSS 无法可靠强制展开），② `status.js` 每 30 秒重绘时必须处理开合状态，等于给本图加 JS 面。
- 管理台的目标行**恰恰相反**：那里一个目标有 3 个表单、十几行输入，默认展开会让页面变成 6 × 大表单；且打印管理台不是使用场景。

### 7.3 `status.js` 契约（一个都不能改）

落地时按这张表自检；任何一行被改，说明组件映射越界了：

| 钩子 | 位置 | 用它的地方 |
| --- | --- | --- |
| `#status-root` / `[data-chart]` / `.chart-avg` / `[data-target]` / `.dot` / `.badge` / `.uptime` / `.kv dd` / `.target-error` / `[data-timeline]` / `data-cells` / `.js-cells` / `.js-generated` | 面板 SSR | `status.js` 的 `paint()` 三件套 |
| `#status-banner` + `.notice.status-banner` | JS 动态插入 | 失败横幅（401 与网络分开） |
| `STATE_CLASS = { up: 'ok', degraded: 'warn', down: 'bad' }` | `status.js` | 与服务端 `STATUS_CLASS` 同词（跨文件断言） |
| `.cell-strip i.up/.degraded/.down/.cell-missing` | CSS | 格带四态 |
| `CELL_STRIP_LEN = 56` | `views.ts` | 定宽格带（横向可比） |

**结论**：面板的改动面只有 CSS + 一个 `.inset-list` 类；`status.js` / `chart-path.js` 零改动。

### 7.4 状态的三层冗余（不许退化）

1. **形状**：`.dot` = 实心圆（up）/ 方块（degraded）/ 三角（down）/ 空心圆（unknown，环用 `--border-strong`）。
2. **文字**：`.badge` = 可用 / 异常 / 故障 / 无数据，颜色用 `--ok/--warn/--bad`（对 `--bg-card` 最低 5.22）。
3. **图案**（仅打印）：见 §11。

---

## 8. 管理台（六页）

### 8.1 外壳与模块导航

- 桌面：`layout()` 的 rail（管理组）+ `.app-shell--admin`（内容列 1140，`minmax(0, 1fr)` 不变）。
- 手机：`.admin-tabs`（§5.2）。
- 六页各自的大标题 `.large-title`；页首说明 `.admin-hint`（15 / `--label-2`）保留（它是这个站「把判据写在页面上」的特色，不删）。
- `notice` 区：`renderNotice()` 的三档**类名不动**（`.notice` / `.notice-bad` / `.notice-warn`），视觉改成 `--bg-card` 底 + 左边 3px 状态色 + 文本 `--label`（bad 档文本 `--bad`）。

### 8.2 概览（`/admin`）

- `.stat-strip` 四张卡 → 每张卡是**一个 `<a class="stat">`**（整卡可点，卡内不再有「进入 →」文本链接）：label 12 / `--label-2`、num 20/700、sub 13 / `--label-2`、行尾 `.chev`。
- 零管理员告警：`.notice.notice-warn`（文本不动）。
- **不渲染目标列表**（既有决定，不改）。

### 8.3 目标（`/admin/targets`）——本页是渐进披露的样板

```html
<h2 class="group-title">办公</h2>
<div class="inset-list">
  <div class="cell-stack target-row">
    <div class="cell target-row-head">
      <span class="dot ok"></span><h3 class="cell-title">知识库</h3>
      <code class="target-id">wiki</code><span class="tag tag-ok">启用中</span>
      <span class="chev" aria-hidden="true">…</span>
    </div>
    <details class="cell-detail">
      <summary>编辑与操作</summary>
      <form class="target-edit">…</form>
      <form class="form-actions">停用 / 启用</form>
      <form class="form-actions">删除 / 停用（有历史时）</form>
    </details>
  </div>
</div>
```

- 新增目标：`<details class="card create-card"><summary>＋ 新增目标</summary><form class="target-new">…</form></details>`（默认折叠）。
- 行内分隔：`.inset-list > * + *`（行与行之间）与 `.cell-stack > * + *`（摘要行与折叠面之间）都用 `border-block-start: 1px solid var(--separator)`；后者让 `details` 展开时也有分组感。
- 每个目标：行首摘要（dot + 名称 + id + 状态 tag）+ 折叠的编辑面（3 个表单原样搬进去）。
- **表单结构、字段名、`hidden`、`readonly id`、`required` 确认框全部不动** —— 只换外壳与折叠。
- 失败回填（`submitted`）照旧；重渲染后如果有 `bad`，`<details open>` 由服务端渲染（**这是本页唯一新增的一个属性**：失败时服务端把 `<details open>` 出来，否则用户看不到错误）。
- 停用/删除的判据（有历史 → 停用）不变。

### 8.4 账号（`/admin/accounts`）

表格 → 分组列表：每个账号一个 `.cell-stack`。

- 第一行（摘要）：用户名（15/600）+ 「id 3」（13 / `--label-2`）。
- 第二行：角色 tag（`.tag-ok` 管理员 / `.tag` 只读）+ 状态 tag（`.tag-ok` 启用中 / `.tag` 已停用）+ 「凭据代次 3」。
- 折叠面（`details.cell-detail`，summary「管理这个账号」）：三个表单原样搬进去。

不做头像位（站内没有头像数据，A 原型里的 `.avatar` 不落地）。

- 自己的那一行仍是**只说明、不给按钮**（守卫不变）。
- 三个确认框仍是 `required` 复选框，文案不动。
- 新增账号表单：`details.create-card`（口令永不回填的规则不变）。
- 表头（用户名/角色/状态/凭据代次/操作）是列语义；列表化后每行自带标签文本（`<span class="cell-sub">角色</span>`），**信息不丢**，只是不再横向对齐。

### 8.5 备份（`/admin/backups`）

- 立即备份按钮：`.btn-primary` + 说明（说明改 13 / `--label-2`）。
- 现有产物 → `.inset-list` 的 `.cell` 行：文件名 `code`（13）+ 大小（13/`--label-2`）+ 时间（13）+ 「N 分钟前」（12/`--label-2`）。
- 三种目录状态（缺失 / 读不了 / 空）保持三种不同文案与色调。
- 「参数（只读）」`dl.kv` → `.inset-list` 两行；恢复/下载的说明与警告保持。

### 8.6 设置（`/admin/settings`）

- 一个 `.card` 包住表单；`label` 15/500、`input` 见 §9、保存按钮 `.btn-primary`。
- `.stat-sub`（字段说明）13 / `--label-2`；`bad-text` 用 `--bad`（对 `--bg-card` 5.88）。
- 「留在 .env 里的（只读）」`dl.kv` → `.inset-list` + `.cell`（每项一行，dt 13/`--label-2`、dd 15）。
- 无「恢复默认」按钮（既有决定）。

### 8.7 文章（`/admin/articles`）

- 列表 → `.inset-list` 行：状态 tag（草稿 / 回收站）+ 标题（15/600，整行链接到 `?edit=slug`）+ slug（12/`--label-2`）+ 日期（13）+ 标签。
- 编辑面：`.card` 包住表单；标题/slug/日期/标签/摘要 用 `.form-row`；写作区见 8.8。
- 回收站：单独一段 `.inset-list`，每行「还原」「彻底删除」两个表单（确认框保留）。
- 修订历史：`.inset-list` 行（时间 13 / 当时状态 tag / 标题 15 / 「看这一版的正文」`<details>` + `pre`）；「退回这一版」按钮在行内。
- 上传块：`.card` + 预览图（`--radius`）+ 片段 `pre`（`--mono` 12.5）+ 原生文件表单。
- 预览：`.card.article-preview` 内部走 `.prose` 字号，避免编辑器预览变小字。

### 8.8 编辑器（TipTap）

- 工具栏 `.editor-toolbar`：`display:flex; flex-wrap:wrap; gap:4px`；每个按钮 28px 高、`--fill` 底、`--radius-sm`、13px、hover `--border-strong`；**结构由 `article-editor.ts` 创建，CSS 只控制外观**。
  > **⚠ 已修订（2026-10-23 · [#79](https://github.com/Lkyloveaw/lkyloveaw-home/issues/79)）**：工具栏改成**六组**
  > （文本 / 块 / 列表 / 插入 / 表格 / 历史）。每组的容器是 `.editor-toolbar-group`（`role="group"` + 可见组标签
  > `.editor-toolbar-label`），组间用 `border-inline-start` 分隔（首组豁免）；按钮本身的外观（`--fill` 底、
  > `--radius-sm`、`--fs-footnote`）**没动**。上一条的 gap 值以 `public/style.css` 为准。
  > 一个已知形状：CSS 感知不到「组是否在行首」，换行到行首的组会带一条 1px 竖线；不为这点加 JS。
- 写作区 `.article-editor`：`--bg-card`、`--radius-lg`、`--separator`、min-height 320、max-height 70vh；`.ProseMirror` 内文字走 `--fs-body` / `--lh-prose`（与读面正文一致，所见即所得），`h2/h3` 用 title2/title3，表格沿用 `.prose` 的边框与单元格规则（含「单元格里的 p 不带下边距」那条既有断言）。
- 保存按钮 `.btn-primary`；「发布 / 撤下 / 移进回收站」三个动作按「主操作 / 危险操作」分色：发布 = filled，撤下/回收站 = danger（文字 `--bad`，描边 `--bad`）。
- `<noscript>` 提示保留（写作区需要 JS 是既有事实）。

### 8.9 确认框与 sheet：为什么不用 `<dialog>`

| 候选 | 结论 | 理由 |
| --- | --- | --- |
| `<dialog>` + `showModal()` 做「新增 / 编辑」sheet | **不采用** | 打开必须执行 JS；页面**禁用 JS 就不能写**，与「禁用 JS 也要能写」直接冲突。`commandfor` 尚未 baseline，不能当降级路径 |
| `<dialog>` 只做破坏性确认（提交仍走表单） | **不采用** | 确认是**提交前**的拦截，服务端守卫已有一层；再叠一层需要 JS 的拦截，等于把「最后一道关卡」放在会失效的地方 |
| `<details>` 折叠的「sheet 式卡」 | **采用** | 零 JS、键盘可用、打印可控（闭合态不打印正好符合管理台不是打印场景）、失败时可服务端 `open` |
| 原生 `required` 复选框确认 | **保留** | 零 JS、服务端同判据、文案已写明后果 |

「sheet」在本站 = **非模态的展开卡**（`--bg-card`、`--radius-lg`、顶部一行小字标题、右上关闭即 summary 本身）。这不是 A 原型里 `showModal` 的模态 sheet，**记录为对原型的落地修订**：原型需要 JS 才能演示 sheet，产品不能在写路径上引入这个依赖。

---

## 9. 控件与图标

### 9.1 按钮：四级 + 两尺寸

| 类 | 用途 | 视觉（全部走已断言的对） |
| --- | --- | --- |
| `.btn-primary` | 主操作（保存 / 登录 / 立即备份 / 发布） | `--accent` 底 + `--on-accent` 字（5.80 / 7.42） |
| `.btn` / `.btn-secondary` | 次操作（取消 / 启用 / 还原 / 退回） | `--fill` 底 + `--label` 字（16.55 / 14.12） |
| `.btn-plain` | 第三级（「回首页」「完整面板 →」「＋ 新建一篇」） | 透明底 + `--accent` 字（对 `--bg` 5.20、对 `--bg-card` 5.80，两底都已断言） |
| `.btn-danger` | 破坏性（停用 / 删除 / 彻底删除 / 撤下） | **`--fill` 底** + `--bad` 字 + `--bad` 描边（bad/fill 4.63 / 5.00 —— 这是 #67 已经断言的第 19 对，不新增对比度预算） |

- 高度：默认 36px（`min-height`），`.btn-sm` 30px；圆角 `--radius`；字 14/600。
- 按下反馈：`:active { transform: scale(.98) }`；`prefers-reduced-motion` 下不写过渡（本来也没有）。
- 焦点：`:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px }`（`--accent` 对四种底 ≥4.57）。
- 禁用：`[disabled] { color: var(--label-2); background: var(--fill); border-color: var(--separator) }`，不靠透明度（静态算不出来）。

### 9.2 不引入的控件（明确记录，否则落地时会被「顺手加上」）

| 控件 | 为什么不做 |
| --- | --- |
| 分段控件 | 站内没有「互斥筛选」用例（标签页是全量导航、面板没有筛选、表格没有排序）；引入即新功能 |
| 开关（switch） | 目标的启用/停用是**表单提交 + 服务端判据**，不是即时生效的二值设置；做成 switch 会假装「点了就生效」 |
| 搜索 | 站内没有搜索功能；`<search>` + GET 表单是**新功能**，超出本图 |
| 分页 / 加载更多 | 列表本来就短；分页会改 URL 契约 |
| 骨架屏 / 加载态 | 读面是 SSR，没有客户端渲染等待；唯一的「加载」是面板每 30 秒的横幅（`.status-banner`），保持现状 |
| 模态 sheet / alert | 见 §8.9 |
| 图标字体 / 图标库运行时 | 见 9.4 |

### 9.3 原生控件的样式（只 CSS）

- `input / select / textarea`：`--fill` 底、`--border-strong` 1px、`--radius`、`--label` 字、`--fs-subhead`；placeholder `--label-2`；focus `outline: 2px solid var(--accent)` + 边框 `--accent`。
- `input[type=checkbox]`：`accent-color: var(--accent)`（原生勾，不重造）；`.confirm` 行 gap 8、`min-height: 44px`。
- `input[type=file]`：`.btn-secondary` 的外观做不了（原生控件），保持原生 + `--label-2` 说明。
- `input[type=date]`：原生。
- `<select>`（主题）：`appearance: none` + 右侧 `.chev` 伪元素（原型做法），键盘与读屏语义不变。

### 9.4 图标：7 个内联 SVG

新增 `src/icons.ts`（服务端专用，零依赖）：

| 名字 | 路径要点 | 用在哪 |
| --- | --- | --- |
| `home` | `M3 10.5 12 3l9 7.5` + `M5 9.5V21h14V9.5` | rail / tab bar「首页」 |
| `doc` | 文档轮廓 + 两条横线 | 「分享」 |
| `pulse` | 折线脉冲 | 「系统可用性」 |
| `info` | 圆 + 感叹点 | 「关于」 |
| `sliders` | 三条横线 + 三个圆 | 「管理」/ 模块 |
| `chev` | `m9 5 7 7-7 7` | 列表行尾（`chevron-right`）；`details` 的 summary 用 `rotate(90deg)` 复用同一个 |
| `plus` | `M12 5v14M5 12h14` | 「＋ 新增目标 / 新建一篇」 |

- 统一 `viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"`，尺寸由 `.icon`（18/16）与 `.tab-item .icon`（22）给。
- 装饰性图标 `aria-hidden="true"`；rail / tab bar 的图标旁边**都有可见文字**，所以图标本身不承担语义。
- **不用图标时的退路**：拿不到合适的内联 SVG 就不放图标（文字标签、`＋` 这类字符、或者 `→` 箭头），**不许**退到图标字体 / 外链图片 / emoji 当控件图标（emoji 在不同平台差异太大，且会破坏 token 化的颜色）。
- 断言：`icons.ts` 里没有 `#hex`（`fill="none"` 与 `currentColor` 之外没有颜色）；`views.ts` 的图标全部来自 `icon()`（不出现 `<img` / 图标字体 / `@font-face`）。

---

## 10. 图表（深浅两套下的 token 化）

- 颜色：`src/charts.ts` 已用 `var(--accent)`（延迟）与 `var(--ok)`（可用率）——**不动**。`light-dark()` 会让描边与渐停在深浅两套自动二选一；`--accent` 对 `--bg-card` = 5.80 / 6.01，`--ok` = 5.42 / 8.42（非文字只需要 3:1，本来就过）。
- 网格：**不加 SVG 网格元素**（那是 `charts.ts` 的 markup 改动，且会让 `chart-check` 的交叉断言多一个变量）。用 CSS 在容器上画纸纹网格：
  ```css
  .chart { background-image: repeating-linear-gradient(to bottom, var(--separator) 0 1px, transparent 1px 24px); background-position: 0 6px; }
  ```
  虚线不画（`repeating-linear-gradient` 做虚线成本高、观感也不稳）。网格是**非文字装饰**，`--separator` 不承诺 3:1 是允许的（#67 §7.3）。
- 轴标签：`.chart-axis`、`.chart figcaption` → `--fs-caption` 12 / `--label-2`（**不是** `--label-3`）。
- 空态：`.chart-empty` → `--fill` 底、`--radius`、`--label-2`、无虚线。
- 打印：`--accent/--ok` 都变 `#000`，曲线变黑线；面积填充的 `stop-opacity` 保留（灰阶）；`break-inside: avoid` 保留。

---

## 11. 打印：全灰阶 + 格带图案

### 11.1 灰阶 token（#67 §6 的 17 个值，一个不少）

`@media print { body { color-scheme: light; --bg…--scrim: 17 个灰阶; background:#fff; color:#000 } }`；打印块里不出现 `light-dark()`；全站仍只有一个 `:root`。

### 11.2 格带图案（本票必须收口的那一条）

旧断言「打印时状态格带保留颜色」**退役**（#67 §6 已定）；`--ok/--bad` 打印都是 `#000`，只靠色块分不出状态。改成图案：

| 状态 | 打印图案 | CSS |
| --- | --- | --- |
| `up` | 实心 | `background: #000` |
| `degraded` | 45° 单向斜线 | `repeating-linear-gradient(45deg, #000 0 2px, #fff 2px 5px)` |
| `down` | 斜网格（两个方向叠加） | 两个 `repeating-linear-gradient(45deg / -45deg, …)` 叠在同一 `background` 里 |
| `cell-missing` | 空心 | `background: #fff; box-shadow: inset 0 0 0 1px #000` |

- 格带容器保留 `print-color-adjust: exact`（否则图案被打印引擎丢掉）；**只对格带**开，不全局开（#65 §4 的省墨理由）。
- 徽标文字（可用/异常/故障）与点的形状照旧 —— 三层冗余里图案是第三层。
- 断言：三条图案规则存在、打印块里 `print-color-adjust` 恰好出现在格带规则里。

### 11.3 其他打印降级

| 元素 | 打印行为 |
| --- | --- |
| 页头 / rail / tab bar / admin-tabs / 页脚 / picker / 登出 / 按钮 / `.form-actions` / `.confirm` | 隐藏 |
| 管理台表单（`input/select/textarea` + 折叠的 `details` 内容） | 隐藏（打印一份空白表单没有意义）；列表行照常打印 |
| `.admin-hint` / `.notice` | 隐藏（现状保留；它们是屏幕上的说明） |
| `.table-wrap` | `overflow: visible`（宽表不被裁） |
| 正文里的站内链接 | 地址写出来（现状保留） |
| 卡片 / 行 / 曲线 / 格带 | `break-inside: avoid` |

---

## 12. 逐组件映射总表

图例：`✅` = 需要；`—` = 不需要。**所有行的「加 JS」都是 —**（唯一例外是「主题 picker」由 #67 的脚本承担，在本表里写作「—（#67）」）。

### 12.1 外壳 / 导航

| 组件 | 现有 → 新 | 只 CSS | 改 markup | 加 JS | 断言 |
| --- | --- | --- | --- | --- | --- |
| 站点外壳 | `.admin-shell`/`.admin-main`（仅管理台）→ `.app-shell`/`.app-main`（全站） | ✅ 网格/宽度 | ✅ `layout()` | — | N1、内容列 `minmax(0,1fr)` |
| 全站导航 | `.site-nav` + `.nav-sep`（顶栏 `/` 分隔）→ `.site-rail`（组 + `.rail-link`） | ✅ | ✅ | — | N1/N2/N3/N4 |
| 管理台模块导航 | `.admin-side` 两段 → rail 管理组（桌面）+ `.admin-tabs`（手机） | ✅ | ✅ | — | N2/N6 |
| 手机主导航 | 无 → `.tab-bar` 4/5 项 | ✅ | ✅ | — | N5 |
| 页头 | 88% 半透明 + blur → `--bg` 不透明 + hairline | ✅ | — | — | N7 |
| 品牌 | `.brand`（等宽 0.98rem）→ `--fs-headline` 600 `--label` | ✅ | — | — | 字号 token |
| 登出 | `.logout-form`（裸按钮）→ 13px `--label-2`，hover `--label` | ✅ | — | — | 打印隐藏 |
| 主题 picker | 无 → `.theme-picker > select[data-theme-select]`（页头 + 登录页右上） | ✅ | ✅ | —（#67） | N8/N9 |
| 页脚 | `.site-footer`（等宽 0.85rem）→ 13 `--label-2` + 顶线 | ✅ | — | — | 打印隐藏 |
| 贴底布局 | `body > main` → `body > .app-shell` | ✅ | — | — | 页脚贴底断言改写 |

### 12.2 基元

| 组件 | 现有 → 新 | 只 CSS | 改 markup | 加 JS | 断言 |
| --- | --- | --- | --- | --- | --- |
| 卡片 | `.card`（`--bg-card` + `--border` + `--radius`）→ 同结构，`--separator` + `--radius-lg` | ✅ | — | — | 类名覆盖 |
| 分组列表 | 无 → `.inset-list`（圆角、裁切、`> * + *` hairline） | ✅ | ✅ | — | 基元存在 |
| 列表行 | `.mini-row` / `.incident-list li` / `.admin-table tr` → `.cell`（44 最小高） | ✅ | ✅ | — | 行高 / 分隔线 |
| 行副标题 | `.stat-sub`（13 `--label-2`）+ 新增 `.cell-sub` | ✅ | ✅ | — | 字号 token |
| 行尾 chevron | 无 → `.chev`（`--label-3`，16px） | ✅ | ✅ | — | 图标来源 |
| 组标题 | `.group-title`（0.95rem）→ 15/600 `--label-2` | ✅ | — | — | 字号 token |
| 指标卡 | `.stat*` → `--bg-card` + `--separator` + `--radius`；整卡可点 | ✅ | ✅ 概览页 | — | 类名覆盖 |
| 空态 | `.empty`（虚线）→ `--fill` 底、无虚线、居中 | ✅ | — | — | 类名覆盖 |
| 标签 | `.tag`（0.78rem 胶囊）→ caption 12 + `--fill` 底；彩色档 `.tag-active` / `.tag-ok` / `.tag-warn` 用 `--bg-card` 底 + inset 同色环（§6.2 的四语义表） | ✅ | ✅ 三处（启用中 / 管理员 / 回收站） | — | 字号 / 四语义 / 对比度 |
| 提示条 | `.notice` 三档 → `--bg-card` + 左侧 3px 状态色；bad 文本 `--bad` | ✅ | — | — | 三档类名保留 |
| 表格 | `.admin-table` → `.inset-list` + `.cell` | ✅ | ✅ 三页 | — | `.admin-table` 不存在 |

### 12.3 公开面

| 组件 | 现有 → 新 | 只 CSS | 改 markup | 加 JS | 断言 |
| --- | --- | --- | --- | --- | --- |
| 页面大标题 | `.hero h1` / `.section h1` → `.large-title` | ✅ | ✅ 各页 h1 加类 | — | 字号 token |
| 引言 | `.lede` → `--fs-body` `--label-2` 62ch | ✅ | — | — | 字号 token |
| 文章列表 | `.post-card` 卡片 → `.inset-list.post-list > .post-card.cell` | ✅ | ✅ | — | 整行链接 |
| 文章页 | `.post` / `.post-header` / `.prose` → 字阶 + 68ch 居中 | ✅ | — | — | 68ch 断言保留 |
| 标签条 | `.tag-bar` → `.chip-row`（横滚） | ✅ | ✅ 类名 | — | 类名覆盖 |
| 空态 / 404 / 403 | 见 §6.5；403/404 用 `bodyClass: 'page-error'` | ✅ | ✅ `bodyClass` | — | 错误页断言 |

### 12.4 面板

| 组件 | 现有 → 新 | 只 CSS | 改 markup | 加 JS | 断言 |
| --- | --- | --- | --- | --- | --- |
| 统计条 / 指标 | `.stat-strip` / `.stat*` → iOS 指标卡 | ✅ | — | — | 4 张卡 |
| live 提示 | `.live-tag` / `.live-dot` → 13px + pulse（reduced-motion 关） | ✅ | — | — | reduced-motion |
| 整体曲线 | `.chart-wide` → 自带卡片底 + CSS 网格 | ✅ | — | — | chart token |
| 目标卡 | `.card.target-card` 全部字段保留；`--radius-lg` | ✅ | — | — | 卡内钩子不变 |
| 状态点 / 徽标 | `.dot` / `.badge` → 形状 + 文字不变 | ✅ | — | — | 4 形状 / 3 档 |
| 格带 | `.cell-strip` → 四态 + 打印图案 | ✅ | — | — | 图案 3 条 |
| 键值 | `.kv` → 行内 dt/dd 13/15 | ✅ | — | — | `.kv dd` 契约 |
| 错误 | `.target-error` → `--fill` 底 + `--bad` 字 | ✅ | — | — | 对比度 |
| 异常列表 | `ul.incident-list` → `ul.inset-list.incident-list` | ✅ | ✅ 加类 | — | 类名覆盖 |
| 失败横幅 | `.notice.status-banner` → 同结构 | ✅ | — | — | 类名保留 |

### 12.5 管理台

| 组件 | 现有 → 新 | 只 CSS | 改 markup | 加 JS | 断言 |
| --- | --- | --- | --- | --- | --- |
| 概览卡片 | `.stat` + 「进入 →」→ 整卡 `<a class="stat">` | ✅ | ✅ | — | 整卡可点 |
| 目标列表 | `.target-row` 平铺 → `.cell-stack` + `<details>` | ✅ | ✅ | — | 失败时 `open` |
| 新增表单 | 常显 `.target-new` → `details.create-card` 折叠 | ✅ | ✅ | — | 字段名不变 |
| 账号列表 | `.admin-table` → `.cell-stack` × N | ✅ | ✅ | — | 三表单仍在 |
| 备份列表 | `.admin-table` → `.inset-list` | ✅ | ✅ | — | 三态文案 |
| 设置 | `.form-row` + `dl.kv` → `.card` + `.inset-list` | ✅ | ✅ | — | 字段名不变 |
| 文章列表 | `.admin-table` → `.inset-list`（整行链接 `?edit=`） | ✅ | ✅ | — | 链接形态 |
| 回收站 / 修订 | 表格 / `ol` → `.inset-list` + `<details>` | ✅ | ✅ | — | 动作字段不变 |
| 编辑器工具栏 | `.editor-toolbar` 按钮 → 28px pill | ✅ | — | — | 类名保留 |
| 写作区 | `.article-editor` / `.ProseMirror` → 字阶 + 表格规则 | ✅ | — | — | 单元格 p 断言 |

### 12.6 打印

| 组件 | 现有 → 新 | 只 CSS | 改 markup | 加 JS | 断言 |
| --- | --- | --- | --- | --- | --- |
| 灰阶 token | 旧 9 个 → 17 个灰阶 | ✅ | — | — | 17 个 / 无 `light-dark()` |
| 格带图案 | 「保留颜色」→ 4 种图案 | ✅ | — | — | 3 条图案 + 空心 |
| 导航 / 页头 / 表单 | 部分隐藏 → 明确清单全隐藏 | ✅ | — | — | 隐藏清单 |
| 宽表 / 卡片 | 保留（`overflow: visible` / `break-inside: avoid`） | ✅ | — | — | 保留 |

---

## 13. 断言迁移

### 13.1 `scripts/style-check.mjs`：72 → ≈151

按段列出（**新项数**是目标；`≈` 的几段因为「一条断言可以拆成两条」的颗粒度差异，落地时以脚本输出为准 —— 真正要钉住的是右列的**内容**）：

| 段 | 现在 | 新 | 变化 |
| --- | --- | --- | --- |
| token 表 | 6 | **10** | 颜色 13→17（精确集合）；非颜色 13→24；按 token 名计数（root 17 + print 17 = 34）；`[data-theme]` 两块只含 `color-scheme`；`color-scheme: light dark`；颜色字面量（`#hex`/`rgb`/`hsl`）只在 root+print；print 不在 `:root` |
| 对比度 | 19 | **62** | 19 对文字 ×2 模式 + 12 对非文字 ×2 模式（#67 §7）；`ALLOWED` 仍为空 |
| 类名覆盖 | 7 | **9** | 扫描 `views.ts` + `status.js` + `icons.ts`；新增「图标只有内联 SVG」；状态值 3 条、样式类 3 条保留 |
| 排版（原「两套平面」） | 17 | **≈23** | 退役 7 条（两个 `body.plane-*` 字体、排版 token 存在、`planeOf`、登录页 `plane-data`、`nav-sep`）；新增 13 条（无 `plane-*`、排版 token 退役、body 用 `--font`、字阶 9 条、`--label-3` 不出现在 <20px 文字规则里、`--label-3` 只做非文字）；保留 10 条（68ch 两条、页脚贴底、登录页排除、print 无 100vh、单元格 p、表格 4 条） |
| 导航 / 外壳 | 9（原管理台侧栏段） | **≈14** | N1–N10 + 720 断点（rail 隐藏 / tab bar 出现 / admin-tabs 出现）+ 560 断点 |
| 组件 / 状态 | 4（原面板段） | **18** | 点 4 形状、徽标 3 档、格带 4 态、打印图案 3 条、`print-color-adjust` 位置、`status.js` 钩子齐全、`STATE_CLASS` 同词、`CELL_STRIP_LEN`、图表 token、按钮四级、控件 token、notice 三档、inset 基元、tag 四语义、编辑器、chevron 来源 |
| 管理台结构 | 0（原并入他段） | **8** | 六页当前项唯一、六个 `adminSection`、目标行 `<details>`、确认框仍 `required`、`.admin-table` 已不存在、内容列 `minmax`、`--wrap-admin`/`--rail-w` 是 px、打印隐藏表单 |
| 窄屏 / 打印其余 | 10 | **≈7** | 560 存在 + 表单竖排、print 存在、纸面、隐藏清单、`break-inside`、链接地址、无 `light-dark()` |
| **合计** | **72** | **≈151** | 62 条是对比度数学（占四成）；±5 的抖动来自「拆分颗粒度」 |

**实测（#75 收口回填）**：`node scripts/style-check.mjs` → **171/171**。比目标 ≈151 多 20 条，来自把「打印隐藏清单」「退场类名清零」「公开面的 inset 行/overlay」「管理台六页结构」拆成独立断言（只增不减，逐批数字见 `docs/ios-implementation-split-decision.md` §2）。`e2e` 最终 **536/536**（写路径全部动作回归），`npm run verify` **exit 0**。

关键实现片段（#67 §8.2 已给；本文补三条）：

```js
// 1) 颜色字面量：剥注释后，root/print 之外不许有 #hex / rgb( / hsl(
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '')
const literals = (stripComments(css).match(/#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(/gi) ?? []).length

// 2) 图标只有内联 SVG
check('图标全部来自 icon()（没有 <img / 图标字体）', !/<img\b/.test(views) && /from '\.\/icons\.js'/.test(views))

// 3) --label-3 只做非文字：20px 以下文字规则里不许出现
const smallTextBlocks = [...] // 逐条选择器判定（见 §4.4 的表）
```

### 13.2 `scripts/e2e-check.mjs`：32 条改写 + 12 条新增

| 段落 | 现有断言 | 处置 |
| --- | --- | --- |
| `[管理台外壳（#39）…]` 侧栏组（约 20 条） | `sidebarOf` 匹配 `<nav class="admin-side">`；六页「有侧栏 + 当前项恰好一个 + 指向本页」；六模块名 + 运维/内容；条目不带计数；只读 403 无侧栏；公开页无侧栏；顶栏「管理」带 `aria-current` | **改写**：`railOf` 匹配 `<nav class="site-rail">`；六页的当前项在**管理组**里；管理组只在管理员出现；只读页（含 403）的 rail **没有**管理组；公开页 rail 有站点组 4 项；「管理」不再是一条顶栏条目（由「概览」承担当前项） |
| `[两套平面（#45）…]`（约 12 条） | body 带 `plane-prose/plane-data`；两套平面各一份；`site-nav` 条目数/分隔符数；分隔符 `aria-hidden`；CSS 里 `body.plane-*` | **改写**：body 无平面类；rail 4 条（只读）/ 管理组 6 条（管理员）；tab bar 4/5 条；CSS 里没有 `plane-`；保留「当前项 `aria-current`」「CSS 可取」「断点 + 打印块存在」 |
| 主题（新增） | 无 | **新增约 12 条**：meta `color-scheme` 两次；boot 在 stylesheet 前；`localStorage.theme='dark'` → 刷新后 `data-theme=dark`；`system` 无 `data-theme`；picker 三项；切换后存储值；`matchMedia` 不出现；无 `document.cookie`；无 JS 时 picker 隐藏（`noscript` 规则在 CSS 里） |
| 其余（文章 / 媒体 / 目标 / 备份 / 账号 / 设置 / 面板 / 图表） | 449 条里的大多数 | **不动**：它们断言的是路由、状态码、notice key、字段名、DOM 钩子，本票一个都不改 |

### 13.3 其他脚本

| 脚本 | 结论 |
| --- | --- |
| `scripts/panel-check.mjs` | **不动**：假 DOM 用 `.dot` / `.badge` / `.cell-strip` / `.chart` / `.js-cells` / `.uptime` / `.kv dd`，全部保留；CSS 断言 `.cell-strip` / `.badge.ok` 也保留 |
| `scripts/chart-check.mjs` | **不动**：只比对几何路径，颜色不参与 |
| `scripts/editor-check.mjs` | **不动**：只断言打包产物与挂载点 |
| `scripts/unit-check.mjs` / `media-check.mjs` / `article-pipeline-check.mjs` / `backup-check.mjs` / `restart-check.mjs` | **不动**（不碰视图字符串） |

### 13.4 中间态：必须同批

`style-check` 有一批断言是**跨文件**的（类名覆盖、平面、侧栏、打印）。任何「先改 CSS 再改 views」「先改 token 再改脚本」的中间态都会让 `verify` 必红。因此实现批次的最小单位是：

> **token 改名 + 全部 `var()` 使用者 + `views.ts` 外壳/导航/picker + `style-check.mjs` + e2e 三组断言 = 一个原子批次。**

不在这一批里的（登录页细节、编辑器外观、打印图案）可以随后进，但**打印图案不能拖到最后**：旧「打印保留状态色」断言退役的那一刻起，纸上就分不出 ok/bad 了。

---

## 14. 交给 #69 的接口（依赖，不是切分）

```
T1 基座：token 17+24 / 字阶 / 打印灰阶 / boot+picker / style-check 第一段
 └─ T2 外壳与导航：app-shell / rail / tab-bar / admin-tabs / 页头 / 403·404 bodyClass
     ├─ T3 公开面：首页 / 分享 / 标签 / 文章 / 关于
     ├─ T4 面板：统计 / 卡片 / 格带 / 异常列表（status.js 零改动）
     ├─ T5 管理台：六页列表化 + details（目标 / 账号 / 备份 / 设置 / 文章）
     └─ T6 登录 / 编辑器 / 打印图案（可并行，但打印图案依赖 T1 的 print token）
```

- **T1 与 T2 必须同一批**（T2 依赖 token 名，且 style-check 的类名/平面/导航段同批改）。
- T3–T6 之间没有代码依赖，只有「同一张 CSS 文件」的写冲突 → 串行或按页拆文件。
- 每批的验收口径：`node scripts/style-check.mjs` 全绿 + `node scripts/e2e-check.mjs` 全绿 + 目视（深浅两套 × 桌面/390px × 打印预览）+ 截图留档。
- 具体切几批、顺序、是否另开 map —— **#69 决定**，本文只给依赖。

---

## 15. 风险与不许做的事

| 风险 | 处置 |
| --- | --- |
| 页头材质回潮 | 断言钉死 `!/backdrop-filter:/`；A 的半透明只活在原型里 |
| `--border` 盲替换 | 按选择器逐条判（§4.4 的表）；`--border-strong` 只给控件边界 |
| `--label-3` 被当小字色 | 断言「20px 以下文字规则不出现 `--label-3`」；12px 轴标签、meta、`tag-count` 一律 `--label-2` |
| 嵌套链接 / 整行可点 | 卡片内 tag 链接 `z-index: 1`；管理台带表单的行**不做**整行链接 |
| 列表化丢表格语义 | 每行自带标签文本（「角色」「凭据代次」）；不追求列对齐 |
| 面板折叠冲动 | 面板不折叠（§7.2）；折叠只用于管理台的「有表单的行」 |
| 打印分不出状态 | 图案三条 + 徽标文字 + 点形状；`print-color-adjust` 只给格带 |
| tab bar 塞进第 6 项 | 断言 4/5 项；管理台模块走 `.admin-tabs` |
| 无 JS 时 picker 假死 | `noscript` 隐藏 picker；主题退回「跟随系统」 |
| 深色下的 `--on-accent` | 主按钮文字必须用 `--on-accent`（深色翻黑），不许写 `#fff` |
| Safari 的 `light-dark()` 元素级解析 | 落地后真机补测一次（#67 已登记，本图不解决） |
| 字号写死 px 切断「浏览器默认字号」通道 | 已知取舍：Dynamic Type 不在范围（map Out of scope），换 rem 会另开票 |
| 打印 `<details>` 闭合 | 管理台打印只打列表行（表单隐藏）；面板不折叠，因此不受影响 |

**不许做的事**（会直接破坏已定的边界）：

- 不引前端框架 / 构建步骤 / 图标库运行时。
- 不新增路由、不改 slug / tag / notice key / 表单字段名 / CSRF 结构。
- 不把管理台确认框改成 JS 模态。
- 不改 `status.js` / `chart-path.js` / `article-editor.js`。
- 不给「状态」加第四档，不把三档退化成红黄绿。
- 不在组件里写颜色字面量或阴影。

---

## 16. 证据与自检

| 项 | 结果 |
| --- | --- |
| 基线 | `node scripts/style-check.mjs` → **72/72**（本票未改任何产品代码） |
| 覆盖 | 全部页面：公开 5 类 + 面板 + 管理台 6 页 + 登录 + 403/404 + 编辑器 + 打印（§6–§11 逐页） |
| 类名 | §3.2 的「不改名」清单 = `status.js` 全部钩子；**附录 A** 把 `views.ts` / `status.js` 里出现的 **93 个类名逐个列了去向**（14 退场 / 79 保留 / 36 新增），不靠「应该都覆盖到了」 |
| 断言 | §13 逐段列出 72 条的去向（保留 / 改写 / 退役 / 新增），给出目标项数公式 |
| 原型一致 | 类名与视觉主要取自 `prototype/ios/base.css` + `a.css`（`.app-side`→`.site-rail`、`.inset-row`→`.cell` 是继承；`.sheet`→`details` 是修订，理由在 §8.9） |
| 未验证 | 真机 Safari / Windows 的 `light-dark()` 观感、打印实际效果、窄屏目视（脚本只能证规则存在） |
| **实测（#75）** | `style-check` **171/171** · `e2e` **536/536** · `verify` **exit 0** · 退场类名 `git grep` = **0** · 截图见 `.ios-batch{1..5}-shots/` 与 #75 的全站矩阵 |

**落地时的自检命令**（谁实现谁跑）：

```bash
node scripts/style-check.mjs          # 全绿（171 项）
node scripts/e2e-check.mjs            # 全绿（改写后的三组 + 主题组）
git grep -n "plane-\|font-data\|font-prose\|bg-soft\|fg-faint\|admin-table\|admin-side\|nav-sep" \
  -- src public scripts                # 期望：只在注释里出现
git grep -n "backdrop-filter\|<dialog\|showModal" -- src public   # 期望：空
git grep -n "'#" -- src/views.ts src/icons.ts | grep -v 'href="#'  # 期望：空
```

---

## 17. 交给 #69 的文档修订清单

| 文件 | 改什么 |
| --- | --- |
| `CONTEXT.md` | 「主题」词条 → 17 色 + 三态 + `light-dark()`；删除「数据面 / 正文面」，新增「**导航（rail / tab bar）**」与「**iOS 字阶**」；「刻意不做的选择」里删掉「不做深色模式」 |
| `docs/theme-decision.md` | 顶部加「已被 #67 取代」横幅（13 色浅色单套 → 17 色三态） |
| `docs/visual-prototype-decision.md` | 顶部加「两套平面已被 #68 取代」横幅，指向本文 |
| `docs/admin-console-sidebar-decision.md` | 修订 §1「侧栏只在管理台内部」→ 全站 rail；§5「403 不长侧栏」→ 403 有 rail、无管理组；保留 §2 的模块分组与 §10 的「条目不带计数」 |
| `docs/research/apple-hig-web.md` · `prototype/ios/` | **保留为历史**（研究/原型证据），不删；在 map 的 Decisions 里已注明「原型不合并」 |
| `AGENTS.md` | 不需要改：它只指路，不含视觉决定 |

---

## 18. 收尾：这张票改变了什么

1. **排版从「两套平面」变成一套 iOS 字阶** —— 这是本图对 #21/#45 的正面修订，影响每一页的字体与字号。
2. **导航从「顶栏条目 + 管理台内部侧栏」变成一条全站 rail + 手机 tab bar** —— 对 #58/#59 的显式修订，信息架构（条目、顺序、分组、URL）一条没动。
3. **表单与破坏性动作走 `<details>`，不引入 `<dialog>`** —— 对 A 原型「sheet」的落地修订，理由是「禁用 JS 也要能写」这条既有硬约束。
4. **打印状态色退役，改图案** —— 这是 #67 留下的欠账，本票用图案 + 文字 + 形状收口。
5. **JS 面零扩大** —— `status.js` / `chart-path.js` / `article-editor.js` 一行不改；新增脚本只有 #67 的主题脚本。

下一步：关闭本票 → 解锁 [#69 落地切分](https://github.com/Lkyloveaw/lkyloveaw-home/issues/69)，由它把 §14 的依赖切成可执行批次。

---

## 附录 A：类名总账（93 个现有 → 14 退场 / 79 保留，另新增 36 个）

**怎么来的**：把 `src/views.ts` 与 `public/status.js` 里所有 `class="…"` 的静态类名与三元分支里的条件类名抽出来去重，去掉状态值（`up/degraded/down/ok/warn/bad/unknown/missing`）与两个行为钩子（`js-cells` / `js-generated`，它们有 `NO_RULE_NEEDED` 例外），得到 **93** 个。这张表是落地时的「一个都不能漏」清单，也是改 `style-check` 类名覆盖断言时的对照物。

### A.1 退场（14）——每个都有明确的替代物

| 旧类 | 替代 | 为什么不是改名 |
| --- | --- | --- |
| `plane-data` | 无（`<body>` 不再带平面类） | 概念消失，不是换个名字 |
| `site-nav` | `.site-rail` + `.tab-bar` | 一份导航变成两个响应式呈现，不是 1:1 |
| `nav-sep` | 无（rail / tab bar 不需要分隔符） | 分隔符这个设计退场 |
| `admin-side` | `.site-rail` 的「管理」组 | 侧栏升为全站 rail |
| `admin-side-group` | `.rail-group` + `.rail-sub-label` | 分组结构变了（两级） |
| `admin-side-group-label` | `.rail-sub-label` | 同上 |
| `admin-main` | `.app-main` | 外壳不再专属管理台 |
| `admin-shell` | `.app-shell` | 同上 |
| `admin-table` | `.inset-list` + `.cell` | 表格改分组列表（三页：账号 / 备份 / 文章） |
| `mini-list` | `.inset-list` | 同一基元 |
| `mini-row` | `.cell` | 同上 |
| `mini-name` | `.cell-title` | 行标题的统一名字 |
| `mini-lat` | `.cell-meta` | 行尾数字的统一名字 |
| `mini-up` | `.cell-meta` | 同上 |

### A.2 保留（79）——按用途分组，全部沿用现名

| 组 | 数量 | 类名 | 变化 |
| --- | --- | --- | --- |
| 外壳 / 框架 | 7 | `site-header` `header-inner` `brand` `logout-form` `site-footer` `wrap` `sr` | 只换 token / 字阶；`header-inner` 里多了 `.header-actions` |
| 排版 / 阅读 | 14 | `hero` `lede` `section` `section-head` `more` `meta` `summary` `post` `post-card` `post-header` `prose` `back` `empty` `group-title` | 只 CSS（字阶 + 底/线） |
| 列表 / 指标 | 13 | `card` `tags` `tag` `tag-active` `tag-count` `tag-bar` `stat` `stat-strip` `stat-num` `stat-label` `stat-sub` `has-fault` `kv` | 只 CSS；`tag-active` 保留但**只表示当前选中**，正向/警告另开 `.tag-ok` / `.tag-warn` |
| 面板 | 21 | `target-card` `target-head` `target-url` `target-error` `target-grid` `target-group` `target-row` `target-row-head` `target-id` `target-edit` `target-new` `cell-strip` `cell-caption` `cell-missing` `uptime` `live-tag` `live-dot` `incident-list` `incident-name` `incident-time` `incident-err` | 只 CSS；`incident-list` 额外挂 `.inset-list`；`target-row` 外包 `.cell-stack` + `<details>` |
| 状态 | 2 | `dot` `badge` | **一行不动**（形状 + 文字 + 三档） |
| 管理台 / 表单 | 16 | `admin-hint` `form-row` `form-actions` `confirm` `btn-danger` `notice` `notice-bad` `notice-warn` `bad-text` `article-form` `article-preview` `revision-list` `revision-body` `upload-preview` `media-snippet` `article-editor` | 只 CSS；`confirm` 仍是 `required` 复选框 |
| 登录 | 6 | `login-body` `login-wrap` `login-form` `login-lede` `login-error` `login-hint` | 只 CSS + 新增 `.login-theme` 容器 |

> `public/article-editor.js` 里的 `.editor-toolbar` 由 JS 创建，不在上面的扫描范围内（`style-check` 只扫 `views.ts` / `status.js` / `icons.ts`），但它在 CSS 里必须有定义（既有事实，保留）。
> **已修订（2026-10-23 · [#79](https://github.com/Lkyloveaw/lkyloveaw-home/issues/79)）**：`style-check` 现在也读
> `src/editor/article-editor.ts`，钉住工具栏的三个类名（`editor-toolbar` / `editor-toolbar-group` /
> `editor-toolbar-label`）在 CSS 里都有定义。
> `status.js` 动态插入的 `.status-banner` 同理，保留且必须有定义。

### A.3 新增（36）

| 组 | 类名 |
| --- | --- |
| 外壳 / 导航（16） | `app-shell` `app-shell--admin` `app-main` `site-rail` `rail-group` `rail-group-label` `rail-sub-label` `rail-link` `tab-bar` `tab-item` `admin-tabs` `admin-tabs-group` `admin-tabs-label` `header-actions` `theme-picker` `login-theme` |
| 基元（12） | `inset-list` `cell` `cell-stack` `cell-detail` `cell-title` `cell-sub` `cell-meta` `chev` `icon` `chip-row` `large-title` `page-error` |
| 按钮（4） | `btn` `btn-primary` `btn-secondary` `btn-plain`（`.btn-danger` 是**现有**类，保留名字、换视觉） |
| 标签语义（2） | `tag-ok` `tag-warn`（`.tag-active` 是**现有**类，语义收窄为「当前选中」） |
| 组合（2） | `post-list`（`.inset-list` 的修饰）`create-card`（折叠式新增卡） |

新增 36 个里，只有 `.cell-detail` / `.create-card` 带结构含义（是 `<details>`），其余都是纯样式钩子。

### A.4 落地时的一条命令

```bash
# 退场清单必须只在注释里出现（注释里允许写「旧类 plane-data」解释历史）
git grep -n "plane-data\|site-nav\|nav-sep\|admin-side\|admin-table\|mini-list\|mini-row\|mini-name\|mini-lat\|mini-up\|admin-shell\|admin-main" -- public/style.css src scripts
```

