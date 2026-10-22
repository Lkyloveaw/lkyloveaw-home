# Claude 风 token / 字阶 / 深浅映射：B · 紧凑工作台的落地规格

> 票：[#85 落地设计：Claude 风 token / 字阶 / 深浅映射与断言迁移](https://github.com/Lkyloveaw/lkyloveaw-home/issues/85)（父地图：[公开面换装](https://github.com/Lkyloveaw/lkyloveaw-home/issues/82)）
> 上游：[#83 研究](https://github.com/Lkyloveaw/lkyloveaw-home/issues/83) → `docs/research/claude-support-shell.md`；[#84 原型](https://github.com/Lkyloveaw/lkyloveaw-home/issues/84) → 用户选定 **B · 紧凑工作台**
> 本票**只出规格，不写产品代码**。落地在 #88 切出的基座批次；外壳 DOM 与断点行为归 #86，用户菜单归 #87。
> 基线（2026-10-22，master `e5434eb`）：`public/style.css` 17 色 + 24 个非色 token；`scripts/style-check.mjs` **171/171**；`e2e` 536/536。

## 0. 一句话结论

**B · 紧凑工作台 = 17 个暖白纸感颜色 + 一套 serif 标题 / sans 正文的 10 字号字阶 + 1360px 外壳（224px 侧栏 + 1068px 主列）。**

| 维度 | 决定 |
| --- | --- |
| 颜色 | 17 色不变，值换成暖白纸感；accent 仍 `#CC785C` / `#D98B6E`，**只做非文字** |
| 对比度 | 16 对文字 ×2 ≥4.5；10 对非文字 ×2 ≥3；`--accent` 禁止落在 `--bg-elev` / `--fill` |
| 字体 | 标题用系统衬线栈 `--font-display`；正文 / UI 用系统无衬线 `--font`；无外部字体 |
| 字阶 | 38 / 32 / 24 / 21 / 18 / 17 / 16 / 15 / 13 / 12；行高 1.25 / 1.2 / 1.55 / 1.8 |
| 正文 | 17px / 1.8；`--measure-prose: 68ch`，居中；**不跟着主列拉宽** |
| 形状 / 栏宽 | 顶栏 56、公开侧栏 224、栏距 28、`--wrap-docs: 1360`；圆角 12 / 8；720 / 560 两个断点 |
| 打印 | 17 个灰阶 token；隐藏顶栏 / 公开侧栏 / 管理 rail / 抽屉 / 页脚；状态格带仍用图案 |
| 断言 | 颜色对 62 条 → 52 条；新增 9 条；预计 style-check **约 170**（#86 改写外壳断言后复核） |

> 为什么是 1360 而不是研究里的 1180：`20 + 224（侧栏）+ 28（栏距）+ 1068（主列）+ 20 = 1360`。1180 是 A 方向的算术（260 + 48 + 832），B 已由用户选定，**以 1360 为准**。`--wrap: 900` 只留给登录 / 403 / 404。

---

## 1. 输入、约束与已经拍板的事

### 1.1 上游输入

- **#83 研究**：参考站顶栏 60 / 侧栏 260 / 正文 830 / 断点 819/1099 / 无深色；Anthropic 字体不可下载；`#CC785C` 不是参考站主色，直接当文字色只有 3.11:1。
- **#84 原型**：用户选定 **B · 紧凑工作台**；B 的起点是 56 顶栏 / 224 侧栏 / 1068 主列 / 780 正文；原型 57 张截图 + `docs/claude-shell-prototype.md`。
- **C1 = A · 品牌忠实**：accent 只做焦点环 / 2px 竖条 / 主按钮底；文字链接走 `--label` + 下划线；按钮字 `--on-accent`。
- **地图 Notes**：保留三态、管理台 rail、固定四项导航、所有公开页常驻侧栏、保留内容 IA。

### 1.2 本票必须守住的硬约束

1. **17 个颜色 token 一个不多、一个不少**；不新增 `--accent-soft`、不新增阴影色、不引入外部字体。
2. 所有颜色写成 `light-dark(浅, 深)`；三态只切 `color-scheme`；全站只有一个 `:root`。
3. 颜色字面量只允许出现在 `:root` 与打印块；组件里用 `var()` / `color-mix()`。
4. `--label-3` **只做非文字**（chevron、分隔、装饰），不得出现在任何带 `font-size` 的规则里。
5. `--separator` 是装饰性细线（浅色约 1.35:1），**不承担控件边界**；控件边界一律用 `--border-strong`。
6. 衬线只给 ≥20px 的标题；中文 Windows 回退宋体，正文保持 sans。
7. 打印仍是黑字白底 + 17 个灰阶；状态格带用图案区分，不靠颜色。

### 1.3 和原型的差异（有意收口）

- 原型 B 的 15px 正文 / 780px 正文栏宽**不进入产品**。B 的密度来自「56 + 224 + 28 + 1068」的骨架，不来自把中文正文缩到 15px。正文取 17px / 1.8，栏宽仍 68ch。
- 原型空态用了虚线框；产品**不采用**——保留现有 `.empty` 的实色 `--fill` 块（style-check 现有断言不变）。
- 原型 `.side-count` 用了 `--label-3` 做文字；产品改为 `--label-2`（label-3 只做非文字）。
- 原型 `details` 面板不继承；用户菜单由 #87 重新决定（#84 已记下「关闭的 details 不渲染子面板」）。

---

## 2. 颜色 token（17 个）

### 2.1 取值表

| token | 浅色 | 深色 | 角色 | 使用纪律 |
| --- | --- | --- | --- | --- |
| `--bg` | `#FAF9F5` | `#141413` | 页面底 | 暖白纸感；顶栏也用这个底 |
| `--bg-card` | `#FCFBF8` | `#1C1B19` | 卡片 / 菜单 / 抽屉 | 比 `--bg` 略亮（参考站做法）；边界靠 1px 线 |
| `--bg-elev` | `#F1EFE4` | `#232220` | 抬升面 / 提示条 / 当前项底 | **accent 禁止落在这里**（浅色 2.84） |
| `--fill` | `#F1F0EC` | `#2A2825` | 输入 / code / 标签 / 淡底 | **accent 禁止落在这里**（浅色 2.87） |
| `--fill-strong` | `#E9E5D3` | `#363330` | hover / 分段轨道 / 重填充 | 不做文字底；若要用文字，先补一对对比度 |
| `--label` | `#1A1A1A` | `#FAF9F5` | 主文字 / 文字链接 | 文字链接 + accent 下划线；不用 accent 做字色 |
| `--label-2` | `#595959` | `#A8A49A` | 次文字 / 导航 / meta | 普通正文可用 |
| `--label-3` | `#767268` | `#8E8A80` | 装饰性非文字 | **不用于文字**；chevron / 分隔 / 装饰点 |
| `--separator` | `#DCD8CA` | `#332F2B` | 细边框 / 行分隔 | 装饰性（约 1.35:1）；控件边界用 `--border-strong` |
| `--border-strong` | `#827D6F` | `#7A756C` | 输入 / 按钮 / 控件边界 | 最小 3.56（浅）/ 3.21（深） |
| `--accent` | `#CC785C` | `#D98B6E` | 焦点环 / 2px 当前项竖条 / 主按钮底 | **只做非文字**；不得落在 `bg-elev` / `fill`；不得做正文色 |
| `--on-accent` | `#1A1A1A` | `#141413` | 主按钮文字 | 5.31 / 6.91；不要白字（3.28 不过） |
| `--ok` | `#1B7A2F` | `#30D158` | 可用 | 徽标 / 点 / 状态文字 |
| `--warn` | `#A35A00` | `#FF9F0A` | 异常 | 同上 |
| `--bad` | `#C1271B` | `#FF6961` | 故障 | 同上 |
| `--unknown` | `#E3DFD0` | `#3A3733` | 无数据填充 | **只做填充**；8px 单点必须加 `--label-3` 描边或可见文字 |
| `--scrim` | `rgba(26,20,16,.40)` | `rgba(0,0,0,.55)` | 遮罩 | 唯一 rgba 例外；不进对比度表 |

### 2.2 关键取舍：accent 不上 `bg-elev` / `fill`（选「删掉并禁止」，不选「调亮」）

C1=A 的代价必须在这里收口：

| 组合 | 浅色 | 深色 | 结论 |
| --- | --- | --- | --- |
| `accent` on `bg` | **3.11** | 6.91 | 保留（非文字） |
| `accent` on `bg-card` | **3.17** | 6.45 | 保留（非文字） |
| `accent` on `bg-elev` | **2.84** | 5.96 | **删除该对并禁用** |
| `accent` on `fill` | **2.87** | 5.51 | **删除该对并禁用** |

**为什么选「禁用」而不是「调亮 `bg-elev` / `fill`」：**

1. 要过 3:1，这两个底必须亮到接近 `--bg` / `--bg-card`，表面层级（卡片 / 抬升面 / 填充）会被抹平；研究 #83 已经指出 `--bg-card` 与 `--bg` 的亮度差只剩 0.018。
2. 本设计里 accent 并没有任何**必须**落在 `bg-elev` / `fill` 上的角色：焦点环在 `bg` / `bg-card` 上，2px 竖条在 `bg` / `bg-card` 上，主按钮是 accent 底。
3. 深色下这两对恰好能过（5.96 / 5.51），但如果只禁浅色，组件在两种模式下行为不一致；**跨模式统一禁用**更好维护。

**落地规则（写进组件注释与 review checklist）：**

- 焦点环只能是 `outline: 2px solid var(--accent)`，且元素必须位于 `--bg` / `--bg-card` 上；若元素在 `--fill` / `--bg-elev` 里，焦点环改用 `--label`，或先把该区域换成 `--bg-card`。
- 当前项竖条只能在 `--bg`（顶栏）或 `--bg-card`（侧栏 / 管理 rail / 抽屉）上；不要在 `--fill` 的行 hover 底上叠加 accent 竖条。
- 主按钮：`background: var(--accent); color: var(--on-accent)`；不要用 accent 做边框、文字或图标色。
- **不要新增 `--accent-soft`**；导航 / 菜单 hover 的淡底用 `--fill`。若确实需要带色淡底，用 `color-mix(in srgb, var(--accent) X%, var(--bg))` 并单独验算，不得写成字面量。

### 2.3 对比度实算（WCAG 2.x 相对亮度）

> 阈值：文字 ≥4.5:1，非文字 ≥3:1。下表是 `style-check` 迁移后的完整 26 对；不是原型脚本的子集。

**文字 16 对 ×2**

| 前景 / 背景 | 浅色 | 深色 |
| --- | --- | --- |
| `label` / `bg` | 16.52 | 17.50 |
| `label` / `bg-card` | 16.82 | 16.34 |
| `label` / `bg-elev` | 15.09 | 15.09 |
| `label` / `fill` | 15.26 | 13.95 |
| `label-2` / `bg` | 6.65 | 7.41 |
| `label-2` / `bg-card` | 6.77 | 6.92 |
| `label-2` / `bg-elev` | 6.07 | 6.39 |
| `label-2` / `fill` | 6.14 | 5.91 |
| `on-accent` / `accent` | **5.31** | **6.91** |
| `ok` / `bg-card` | 5.24 | 8.51 |
| `ok` / `bg-elev` | **4.70** | 7.86 |
| `warn` / `bg-card` | 5.05 | 8.37 |
| `warn` / `bg-elev` | **4.53** | 7.73 |
| `bad` / `bg-card` | 5.68 | 6.10 |
| `bad` / `bg-elev` | 5.09 | 5.64 |
| `bad` / `fill` | 5.15 | **5.21** |

**文字最低：浅色 4.53（warn on bg-elev）· 深色 5.21（bad on fill）。**

**非文字 10 对 ×2**

| 前景 / 背景 | 浅色 | 深色 |
| --- | --- | --- |
| `label-3` / `bg` | 4.55 | 5.35 |
| `label-3` / `bg-card` | 4.64 | 5.00 |
| `label-3` / `bg-elev` | 4.16 | 4.62 |
| `label-3` / `fill` | 4.21 | 4.27 |
| `border-strong` / `bg` | 3.90 | 4.03 |
| `border-strong` / `bg-card` | 3.97 | 3.76 |
| `border-strong` / `bg-elev` | **3.56** | 3.47 |
| `border-strong` / `fill` | 3.60 | **3.21** |
| `accent` / `bg` | **3.11** | 6.91 |
| `accent` / `bg-card` | **3.17** | 6.45 |

**非文字最低：浅色 3.11（accent on bg）· 深色 3.21（border-strong on fill）。**

> ⚠ 原型的 `contrast-check.mjs` 只覆盖了 9 对非文字（没有把 `label-3` / `border-strong` 放到 `bg-elev` / `fill` 上）；这里按 style-check 的完整表复算，所以深色最低是 **3.21**，不是原型报告里的 3.76。两处不矛盾：原型是子集，本文是全表。

**不在对比度表里的东西（必须在 review 时盯住）：**

- `--separator` 约 1.35：装饰线，不承担控件边界；任何「只靠一条 separator 就能识别」的控件都算错。
- `--unknown` 是填充色；8px 点单独不可见，组件必须用 `--label-3` 描边或「无数据」文字。
- `--scrim` 是遮罩 rgba，唯一的 rgba 例外。

---

## 3. 字体与字阶

### 3.1 三套字体栈（不引入外部字体）

```css
--font: -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans SC",
        "PingFang SC", "Microsoft YaHei", Roboto, Helvetica, Arial, sans-serif;
--font-display: ui-serif, "Iowan Old Style", Georgia, Cambria, "Times New Roman",
                "Songti SC", "STSong", "SimSun", "Noto Serif CJK SC", serif;
--mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas,
        "Liberation Mono", monospace;
```

- **标题 / display**：`--font-display`，600；只在 ≥20px 的标题上使用。macOS 会落到 New York / 宋体，Windows 落到 Georgia / 宋体，Linux 落到 Noto Serif。
- **正文 / UI**：`--font`，400；导航 500 / 600；`strong` 600。
- **等宽**：`--mono` 只给 `code` / `pre` / `.mono` / id 类文本。
- **不做**：`@font-face`、字体文件、热链、字体子集化。
- **中文衬线最小的字号是 21px**（`--fs-title3`）；`--fs-headline` 的 18px 只给 sans。

### 3.2 10 字号 / 4 行高（名字与数量不变，只改值）

| token | 旧值 | 新值 | 字族 | 主要落点 |
| --- | --- | --- | --- | --- |
| `--fs-large` | 34 | **38** | serif 600 | 首页 hero / `h1.large-title` / 403/404 标题 |
| `--fs-title1` | 28 | **32** | serif 600 | 文章页 h1 / 登录页 h1 |
| `--fs-title2` | 22 | **24** | serif 600 | `.prose h2` / `.section-head h2` / `.stat-num` |
| `--fs-title3` | 20 | **21** | serif 600 | `.group-title`（状态页分组标题） |
| `--fs-headline` | 17 | **18** | sans 600 | `.cell-title` / 行标题 / `.prose h3`（18 不超过 20，保持 sans） |
| `--fs-body` | 17 | **17** | sans 400 | `.prose` 正文 / `.lede` |
| `--fs-callout` | 16 | **16** | sans 400 | `body` 基准 |
| `--fs-subhead` | 15 | **15** | sans 500 | 顶栏 / 侧栏 / 表单标签 / 行副标题 |
| `--fs-footnote` | 13 | **13** | sans 400 | meta / `stat-sub` / `kv` / 页脚 |
| `--fs-caption` | 12 | **12** | sans 500 | badge / tag / 格带说明 / 图表轴 |

| token | 旧值 | 新值 | 用途 |
| --- | --- | --- | --- |
| `--lh-tight` | 1.25 | 1.25 | 徽标 / 单行紧凑 |
| `--lh-title` | 1.3 | **1.2** | 衬线大标题（CJK 可收紧；1.12 太挤） |
| `--lh-ui` | 1.55 | 1.55 | 组件 / 导航 / 卡片 |
| `--lh-prose` | 1.85 | **1.8** | 长文；比 iOS 的 1.85 略紧 |

### 3.3 字阶的搭配规则

- **serif**：`h1.large-title` / `.hero h1` / `.post-header h1` / `.prose h2` / `.section-head h2` / `.group-title` / `.brand` / 登录页 h1 / 403/404 h1。
- **sans**：`body` / 导航 / `.cell-title` / `.post-card .cell-title` / `.prose h3` / meta / 表单 / badge / tag。
- **标题权重 600**，不用 700；`strong` 600。标题字距 `-0.01em`（只有 ≥24px 才用；正文 0）。
- **正文**：17px / 1.8；`--measure-prose: 68ch`，`.prose` 与 `.post` 在画布里居中（保持 #68 的阅读栏宽断言）。
- **不让主列变宽**：B 的 1068px 主列只让状态面板 / 列表排得更开；文章仍 68ch。主列多出来的宽度不是用来拉长行宽的。
- **原型 B 的 15px 正文不采纳**：B 的紧凑来自 56 / 224 / 28 / 1068，不来自缩小中文正文。
- **`--fs-title3` 21 是衬线下限**；`--fs-headline` 18 只给 sans，不再把 `.prose h3` 放回 21px 衬线。
- **`--label-3` 不用于文字**：侧栏计数、crumb 分隔等小字用 `--label-2`；原型里的 `.side-count` 用 label-3 是原型偏差，落地改正。

---

## 4. 形状 / 栏宽 / 断点

### 4.1 新增与变更的 token

| token | 值 | 状态 | 用途 |
| --- | --- | --- | --- |
| `--header-h` | **56px** | 新增 | 顶栏高度；sticky 顶栏与侧栏 `top` / `max-height` 都用它 |
| `--wrap-docs` | **1360px** | 新增 | 公开面外壳最大宽（B） |
| `--side-w` | **224px** | 新增 | 公开文章侧栏宽 |
| `--gap-docs` | **28px** | 新增 | 公开面侧栏与主列之间的栏距 |
| `--wrap` | 900px | 保留 | 登录 / 403 / 404（不跟公开面变宽） |
| `--wrap-admin` | 1140px | 保留 | 管理台外壳 |
| `--rail-w` | 248px | 保留 | 管理台 rail；不跟公开侧栏混用 |
| `--radius` | 12px | 保留 | 卡片 / 菜单 / 抽屉 / 按钮 |
| `--radius-sm` | 8px | 保留 | 输入框 / 小控件 / tag |
| `--radius-lg` | **12px** | 改值（16→12） | 列表容器 / 统计条 / 编辑器 / 空态 |
| `--tap` | 44px | 保留 | 触控最小高度 |
| `--measure-prose` | 68ch | 保留 | 文章正文栏宽 |

### 4.2 算术

**公开面（B）：**

```text
20（内边距）+ 224（侧栏）+ 28（栏距）+ 1068（主列）+ 20（内边距）= 1360
```

- 侧栏 224 是宽度起点；#86 可以在 224–240 之间微调（如果要消掉最长标题折行），但**不能同时**再加字号；加宽后 `--wrap-docs` 的等式要一起重算。
- 主列 1068 只放宽布局组件；`.prose` / `.post` 仍 `68ch`。
- 1360 是 max-width；1440 视口左右各 40px，1280 视口左右各 −40？不会：`max-width` 只是上限，1280 时外壳宽 1280，主列 = 1280 − 40 − 224 − 28 = 988；仍够三列 300+ 的目标卡。1024 时主列 732，目标卡用 `auto-fit` 退两列；720 及以下切单列。**不加 819 / 1099 断点。**

**管理台（保留）：**

```text
20（内边距）+ 248（rail）+ 20（栏距）+ 832（主列）+ 20（内边距）= 1140
```

> 现行 `style.css` 的注释写的是 `20 + 220 + 20 + 860 + 20`，和实际 token（248 / 1140）对不上；这次一并改成 248 / 832 的等式。管理台主列 832 不变，避免牵动六页表格。

**登录 / 403 / 404：** 继续用 `--wrap: 900`；登录页仍是独立外壳。

### 4.3 形状与断点

- 圆角：卡片 / 菜单 / 抽屉 / 按钮 **12px**；输入框 / 小控件 **8px**；胶囊 / tag / 徽标 999px。`--radius-lg` 从 16 降到 12（列表容器不再比卡片更圆）。
- 边框：统一 `1px solid var(--separator)`；控件边界用 `--border-strong`；**不做阴影**（保持 #68 的决定）。
- 断点：**720 / 560 两个，不新增**。720 以下公开侧栏收起、汉堡抽屉出现、外壳单列；560 以下收紧间距与字号，不改变壳层。
- 顶栏：56px，sticky，不透明 `var(--bg)`；底边 1px separator；侧栏 `top: var(--header-h)`，`max-height: calc(100vh - var(--header-h))`。
- 打印：`.shell` 单列、`max-width: none`；`.content` padding 0；`.prose` max none。类名由 #86 定；若沿用原型的 `.docs-side`，打印隐藏清单要加它。

---

## 5. 打印

### 5.1 17 个灰阶 token（打印块写在 `body` 上，不写 `:root`）

| token | 打印值 | token | 打印值 |
| --- | --- | --- | --- |
| `--bg` | `#FFFFFF` | `--label` | `#000000` |
| `--bg-card` | `#FFFFFF` | `--label-2` | `#222222` |
| `--bg-elev` | `#FFFFFF` | `--label-3` | `#333333` |
| `--fill` | `#FFFFFF` | `--separator` | `#BBBBBB` |
| `--fill-strong` | `#FFFFFF` | `--border-strong` | `#999999` |
| `--accent` | `#000000` | `--on-accent` | `#FFFFFF` |
| `--ok` | `#000000` | `--warn` | `#555555` |
| `--bad` | `#000000` | `--unknown` | `#DDDDDD` |
| `--scrim` | `#000000` | | |

- 全部灰阶；`color-scheme: light`；`font-size: 11pt; line-height: 1.5`；`display: block; min-height: 0`。
- 隐藏：顶栏（`.site-header` 或 #86 的新类）、公开文章侧栏（`.docs-side` 或 #86 的新类）、管理 rail（`.site-rail`）、`.admin-tabs`、抽屉层、页脚、用户胶囊 / 主题 picker、按钮 / 表单 / `details` / 编辑器 / 提示条。
- 放开：`.shell` / `.app-shell` 单列、`max-width: none`；`.content` / `.app-main` 不限宽；`.prose` max none；`.prose .table-wrap` `overflow: visible`。
- 保留：卡片 / 行 `break-inside: avoid`；站内链接 `a[href^="/"]::after { content: " (" attr(href) ")" }`；状态格带图案（up 实心 / degraded 45° 斜线 / down 斜网格 / missing 空心）。
- 打印块里**不允许**出现 `light-dark()`；17 个值都是字面量 hex。

---

## 6. `style-check` 迁移（171 条）

### 6.1 逐段清单

| 段 | 现状 | 动作 | 具体 |
| --- | --- | --- | --- |
| token 表 | 17 色 + 24 非色；section 标题写「21 个非色」 | **保留 + 改写** | `COLOR_TOKENS` 仍 17；`NON_COLOR` 加 `font-display` / `wrap-docs` / `side-w` / `gap-docs` / `header-h`（24→29）；section 标题 21→29 |
| 对比度 | 19 文字 ×2 + 12 非文字 ×2 = 62 | **改写** | 文字 19→16（删 `accent/bg`、`accent/bg-card`、`accent/bg-elev`）；非文字 12→10（删 `accent/bg-elev`、`accent/fill`）；总 52（−10）；`ALLOWED` 仍为空 |
| 类名 / 图标 | 10 | **保留** | 新类名来自 #86；`site-nav` / `tab-bar` 旧类是否退场归 #86 |
| 排版 | 23 | **改写** | 见 §6.2；`.large-title` 700→600，标签 38/600；`.prose h3` 改 `--fs-headline`（18 sans）；`.group-title` 用 `--fs-title3`（21 serif）；新增 serif / ≥20 / 68ch 校验；`.empty` 实色块保留；`label-3` 非文字校验保留 |
| 主题三态 | 6 | **保留** | boot 在 stylesheet 前、picker 两处、无 matchMedia |
| 打印 | 10 | **改写** | 17 灰阶值不变；隐藏清单换成新顶栏 / 公开侧栏 / 抽屉；`light-dark()` 禁令保留 |
| 外壳与导航 | 14 | **移交 #86** | rail / tab bar / 当前项 / 720 断点整组由 #86 重写；#85 只提供 `--header-h` / `--side-w` / `--wrap-docs` / `--gap-docs` 的值校验 |
| 公开面 | 8 | **部分改写** | `.large-title` 权重；`.empty` 实色块保留；`.post-card` 行结构归 #86 |
| 管理 / 窄屏 / 面板 | 28 | **保留 + 小改** | rail 248、720/560、状态格带、`CELL_STRIP_LEN`、图表纸纹都不动；颜色 / 圆角值换 |
| `e2e` 536 | — | **不属本票** | #86 / #87 改；本票只改 `style-check` 的规格 |

### 6.2 排版段的具体改写

- `h1.large-title`：`font-weight: 700` → **600**；检查名「34/700」→ **38/600**。
- `.prose h3`：从 `--fs-title3`（20）改为 `--fs-headline`（18 sans）；新增 `.group-title` 用 `--fs-title3`（21 serif）的检查。
- 新增：`--font-display` 是系统衬线栈（含 `ui-serif` / `Georgia` / `Songti` / `SimSun`）。
- 新增：任何 `font-family: var(--font-display)` 的规则，`font-size` 必须是 `--fs-title3` 及以上（≥20px）。
- 新增：`.prose` 用 `--measure-prose: 68ch`（值也校验），`margin-inline: auto` 保留。
- 保留：`.empty` 是实色 `--fill` 块（**不要**改成原型的虚线框）。
- 保留：`--label-3` 不出现在带 `font-size` 的规则里。
- 保留：`.prose` 的 `--lh-prose`、`body` 的 `--font` / `--fs-callout`。

### 6.3 对比度段的具体改写

```js
// 文字 16 对（删掉的 3 对是 accent 的「文字角色」，不是失败）
['label','bg'], ['label','bg-card'], ['label','bg-elev'], ['label','fill'],
['label-2','bg'], ['label-2','bg-card'], ['label-2','bg-elev'], ['label-2','fill'],
['on-accent','accent'],
['ok','bg-card'], ['ok','bg-elev'],
['warn','bg-card'], ['warn','bg-elev'],
['bad','bg-card'], ['bad','bg-elev'], ['bad','fill']

// 非文字 10 对（删掉 accent/bg-elev、accent/fill）
['label-3','bg'], ['label-3','bg-card'], ['label-3','bg-elev'], ['label-3','fill'],
['border-strong','bg'], ['border-strong','bg-card'], ['border-strong','bg-elev'], ['border-strong','fill'],
['accent','bg'], ['accent','bg-card']
```

- 不新增 `ALLOWED` 条目；没有例外。
- 新增 1 条 guard：`accent/bg-elev`、`accent/fill` **不在** `NON_TEXT_PAIRS` 里（防止有人把失败对加回来）。
- 新增 1 条：`.dot.unknown` 有 `--label-3` 描边（或同时有可见「无数据」文字），不能只靠 `--unknown` 填充。

### 6.4 预计条数

```text
171 − 10（5 对 ×2 颜色检查）
    + 9（NON_COLOR / 形状值 / 圆角 12 / 衬线栈 / 衬线 ≥20 / 68ch 值 / 打印隐藏公开侧栏 / 禁用 accent 对 guard / unknown dot 描边）
  = 170
```

- 这是**预计**；#86 改写外壳段（rail / tab bar / 断点）时总数会再变，最终以复跑为准。
- 不追求「171 这个数字不变」；追求每条断言都有落点。

### 6.5 `CONTEXT.md` 的改法

**「主题（theme）」词条替换为：**

```markdown
**主题（theme）** — 一份完整的颜色 token 取值（17 个），不含排版。
浅色与深色并排写在同一个 light-dark(浅, 深) 里，由 color-scheme 二选一；
三态（跟随系统 / 浅 / 深）只切 :root 的 color-scheme，不复制 token。

暖白纸感：#FAF9F5 / #141413 为底，近黑 / 暖白为文字；陶土 #CC785C / #D98B6E
只做非文字（焦点环、2px 当前项竖条、主按钮底；按钮字用 --on-accent #1A1A1A / #141413）。
文字链接走 --label + 下划线，不用 accent（3.11:1）；accent 禁止落在 --bg-elev / --fill 上
（浅色 2.84 / 2.87），所以非文字对比度只保留 10 对（不复用 12 对）。

入口：用户胶囊下拉里的三态 select（位置由 #87 定；机制不变），偏好存 localStorage 的 theme 键。
换主题 = 改 :root 的 17 个值 + 重跑 npm run check:style（对比度与打印灰阶是算出来的）。
```

**「iOS 字阶」词条替换为：**

```markdown
**字阶（type ramp）** — 全站一套字号与行高：10 个字号 token + 4 个行高 token，都在唯一的 :root 里。
标题用系统衬线栈（--font-display：ui-serif / Georgia / 宋体 / Noto Serif 回退），
正文与 UI 用系统无衬线栈（--font）；衬线只给 ≥20px 的标题，正文、导航、行标题用 sans；
等宽只留给 code / pre / .mono。

字号：38（large）/ 32（title1）/ 24（title2）/ 21（title3）/ 18（headline）/
17（body）/ 16（callout）/ 15（subhead）/ 13（footnote）/ 12（caption）。
行高：1.25（tight）/ 1.2（title）/ 1.55（ui）/ 1.8（prose）。
长文 17px / 1.8，正文栏宽 68ch；标题权重 600，不用 700。
原先的「iOS 字阶」名称与 1.85 行高退役（iOS 视觉被本图取代；机制仍是一套 token）。
```

**不改：**「导航（navigation）」「管理台（admin console）」词条归 #86 / #87（顶栏 + 公开侧栏 + rail 的最终描述由那两张票回填）。

### 6.6 旧文档标注

| 文件 | 动作 |
| --- | --- |
| `docs/ios-theme-architecture-decision.md` | 顶部加「视觉取值已被 `docs/claude-theme-decision.md` 取代；单 `:root` + `light-dark()` + 三态机制仍有效」 |
| `docs/ios-component-mapping-decision.md` | §4 字阶 / §5 导航 / 外壳被取代；§7 面板契约、§11 打印图案仍有效 |
| `docs/admin-console-sidebar-decision.md` | rail 保留；颜色 / 圆角由本票更新，宽度与顶栏由 #86 更新 |
| `docs/theme-decision.md` | 已被 #67 取代，无需再改 |
| `docs/claude-shell-prototype.md` | 作为原型证据保留；B 的像素值是起点，本票为准 |

---

## 7. 给 #88 的应用顺序

1. **基座**：替换 `:root` 的 17 色 + 新增 5 个非色 token + 改 `--radius-lg` / `--lh-title` / `--lh-prose` / 10 个字号值；加 `--font-display`。
2. **打印**：替换 17 个灰阶值；隐藏清单加新顶栏 / 公开侧栏 / 抽屉；`.shell` / `.content` 放开。
3. **断言**：同一批改 `scripts/style-check.mjs`（§6），复跑；当前 171/171，目标约 170，最终以复跑为准。
4. **组件**：按 §3.3 / §6.2 改 `.large-title` 权重、`.prose h3`、`.group-title`、`.section-head h2`；`--label-3` 文字清零；`.dot.unknown` 描边。
5. **CONTEXT / 旧文档**：按 §6.5 / §6.6 回填。
6. **目视**：1440/390 浅深 + 打印；对比 B 原型截图（`prototype/claude-shell/shots/b-*.png`），但以本票的 17px / 68ch 为准。
7. **不在这一批**：顶栏 / 公开侧栏 / 抽屉 DOM（#86）、用户菜单 / 账户页（#87）、`e2e`（#86/#87）。

---

## 8. 风险与未决

| 项 | 说明 |
| --- | --- |
| accent 余量薄 | `accent/bg` 3.11、`accent/bg-card` 3.17，刚过 3:1；**不要**加透明度、渐变或 1px 细线；2px 竖条 / 2px 焦点环是下限 |
| `--separator` 很淡 | 浅色约 1.35:1；只能做装饰线，控件边界必须用 `--border-strong` |
| 卡片 vs 页面底 | `#FCFBF8` vs `#FAF9F5` 只差 0.018 相对亮度；卡片边界靠 1px 线，不靠阴影 |
| 宋体回退 | Windows 中文衬线落到宋体；21px 是最小衬线字号，21px 以下不使用 serif；真机 / 不同 DPI 需目视 |
| 1360 在 1280/1024 | 1280 时主列 988，三列目标卡仍可；1024 时 732，目标卡应自动退两列；720 以下单列。不新增断点 |
| 深色 accent 在 elev/fill 上其实能过 | 5.96 / 5.51，但为跨模式一致**统一禁用**；不要因为深色能过就放回来 |
| 原型 15px / 780px 不采纳 | 如果用户觉得成品不如截图紧凑，调间距 / 栏距，不调正文到 15px |
| `--label-3` 文字 | 原型 `.side-count` 是反例；落地用 `--label-2`，style-check 的「label-3 不出现在 font-size 规则」断言保留 |
| 断言条数 | 预计 170，但 #86 改写外壳断言后会变；不要为了凑 171 而保留失效断言 |
| 管理台栏宽注释 | 现有注释 `220 / 860` 与 token `248 / 1140` 不一致；本票已把正确等式写进 §4.2，落地时一并改注释 |

---

## 9. 验收

- 本文的 26 对颜色值用 WCAG 2.x 相对亮度公式复算；浅色文字最低 **4.53**、非文字最低 **3.11**；深色文字最低 **5.21**、非文字最低 **3.21**。
- 本票**没有改产品代码**；当前 `npm run check:style` 仍是 **171/171**；`e2e` 基线 536/536（本票未复跑，也未触及）。实现后按 §6 重新计数。
- 原型证据：`prototype/claude-shell/shots/b-*.png`；对比 `a-*` / `c-*` 可见 B 的布局差异（本票只把 B 的骨架转成 token）。
- 下一步：**#86 外壳 / 公开文章侧栏 / 断点契约**、**#87 用户菜单 / 账户入口** 可并行；#88 在 #85/#86/#87 三份决定书关闭后切实现。

---

## 附录 A：`:root` 草案（给 #88 的基座批次）

> 这是**规格**，不是已经落地的产品代码。落地时整体替换 `public/style.css` 的唯一 `:root`，并同步 `style-check` 的 `NON_COLOR`。

```css
:root {
  color-scheme: light dark;

  /* 17 色：暖白纸感，浅深并排 */
  --bg: light-dark(#faf9f5, #141413);
  --bg-card: light-dark(#fcfbf8, #1c1b19);
  --bg-elev: light-dark(#f1efe4, #232220);
  --fill: light-dark(#f1f0ec, #2a2825);
  --fill-strong: light-dark(#e9e5d3, #363330);
  --label: light-dark(#1a1a1a, #faf9f5);
  --label-2: light-dark(#595959, #a8a49a);
  --label-3: light-dark(#767268, #8e8a80); /* 只做非文字 */
  --separator: light-dark(#dcd8ca, #332f2b);
  --border-strong: light-dark(#827d6f, #7a756c);
  --accent: light-dark(#cc785c, #d98b6e); /* 只做非文字；禁止落到 bg-elev / fill */
  --on-accent: light-dark(#1a1a1a, #141413);
  --ok: light-dark(#1b7a2f, #30d158);
  --warn: light-dark(#a35a00, #ff9f0a);
  --bad: light-dark(#c1271b, #ff6961);
  --unknown: light-dark(#e3dfd0, #3a3733); /* 只做填充 */
  --scrim: light-dark(rgba(26, 20, 16, 0.4), rgba(0, 0, 0, 0.55));

  /* 形状 / 栏宽 / 断点 */
  --radius: 12px;
  --radius-sm: 8px;
  --radius-lg: 12px;
  --tap: 44px;
  --wrap: 900px;
  --wrap-admin: 1140px; /* 20 + 248 + 20 + 832 + 20 */
  --rail-w: 248px;
  --wrap-docs: 1360px; /* 20 + 224 + 28 + 1068 + 20 */
  --side-w: 224px;
  --gap-docs: 28px;
  --header-h: 56px;

  /* 字体 */
  --font: -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans SC",
    "PingFang SC", "Microsoft YaHei", Roboto, Helvetica, Arial, sans-serif;
  --font-display: ui-serif, "Iowan Old Style", Georgia, Cambria, "Times New Roman",
    "Songti SC", "STSong", "SimSun", "Noto Serif CJK SC", serif;
  --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas,
    "Liberation Mono", monospace;

  /* 10 字号 / 4 行高 */
  --fs-large: 38px;
  --fs-title1: 32px;
  --fs-title2: 24px;
  --fs-title3: 21px;
  --fs-headline: 18px;
  --fs-body: 17px;
  --fs-callout: 16px;
  --fs-subhead: 15px;
  --fs-footnote: 13px;
  --fs-caption: 12px;
  --lh-tight: 1.25;
  --lh-title: 1.2;
  --lh-ui: 1.55;
  --lh-prose: 1.8;
  --measure-prose: 68ch;
}
```

## 附录 B：打印 token 草案

```css
@media print {
  body {
    color-scheme: light;
    --bg: #ffffff;
    --bg-card: #ffffff;
    --bg-elev: #ffffff;
    --fill: #ffffff;
    --fill-strong: #ffffff;
    --label: #000000;
    --label-2: #222222;
    --label-3: #333333;
    --separator: #bbbbbb;
    --border-strong: #999999;
    --accent: #000000;
    --on-accent: #ffffff;
    --ok: #000000;
    --warn: #555555;
    --bad: #000000;
    --unknown: #dddddd;
    --scrim: #000000;
    background: #ffffff;
    color: #000000;
    font-size: 11pt;
    line-height: 1.5;
    display: block;
    min-height: 0;
  }
}
```

- 隐藏清单、表格滚动、状态图案、站内链接地址见 §5；这些由 #88 与 #86 的新类名一起落地。

## 实现状态（2026-10-22）

T1–T4（#89–#92）已收口（2026-10-22）。最终以 `check:unit` 245/245、`check:style` 172/172、
`check:e2e` 551/551、全量 `check:all` 全绿与 1440/390 浅深视觉（52 张 + 2 PDF）为准。
