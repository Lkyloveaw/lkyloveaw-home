# 深浅双模 token 架构：一个 `:root` + `light-dark()` + 三态只切 `color-scheme`

本文件是「落地设计：深浅双模 token 架构、三态切换与断言迁移」这张票的产出（map：[整站 iOS 化](https://github.com/Lkyloveaw/lkyloveaw-home/issues/64)）。

票：[#67 落地设计：深浅双模 token 架构、三态切换与断言迁移](https://github.com/Lkyloveaw/lkyloveaw-home/issues/67)

> **本票只定 token / theme 层，不改产品代码。** 组件、排版、类名与打印图案归 #68；实现批次由 #69 切。上游已定 **A · 原生 App**（#66），研究事实见 #65。

当前基线（写本文时）：

- `scripts/style-check.mjs` **72/72 全绿**（#47 加了页脚贴底 / 表格滚动等断言，不再是旧的 63）。
- `public/style.css` 666 行，仍是 **13 色、浅色单套、一个 `:root`、无 `prefers-color-scheme`**。
- `src/views.ts` 有两个 HTML 外壳：`layout()`（含 403/404）与 `loginPage()`（唯一不走 `layout()` 的页面）。
- 代码里**没有** CSP；内联脚本可用。
- 颜色 literal（`#hex`）只出现在 `:root` 与打印块；`src/charts.ts` 用 `var(--accent)` / `var(--ok)`，`public/status.js` 不写颜色。

---

## 0. 一句话结论

| 问题 | 结论 |
| --- | --- |
| token 架构 | **一个 `:root`**，17 个颜色 token 全部写成 `light-dark(浅, 深)`（`--scrim` 是唯一 `rgba` 例外） |
| 模式开关 | `color-scheme` 是**唯一**开关：`:root` = `light dark`；`[data-theme=light/dark]` 只改 `color-scheme`，不复制 token |
| 三态 | 页头 `<select>`（跟随系统 / 浅色 / 深色）+ `localStorage` 键 `theme`；**不**监听 `matchMedia`、**不**写 cookie |
| 防闪 | `<head>` 内联 boot 脚本，**在 stylesheet 之前**；`layout()` 与 `loginPage()` 两个外壳都要有 |
| 打印 | `@media print` 在 `body` 上把 17 个 token 全改灰阶 + `color-scheme: light`；状态格带改图案（#68），旧「打印保留状态色」断言退役 |
| 对比度 | **19 对文字 ×2 模式 ≥ 4.5:1** + **12 对非文字 ×2 模式 ≥ 3:1**；`ALLOWED` 仍为空 |
| style-check | 13→17 色、对比度循环改成浅/深各跑；打印灰阶化；新增 6 类 theme/boot 断言；`NON_COLOR` 扩到 16 |
| 不能在本票改的 | 类名、排版 token（`--font-data/prose` 等）、组件选择器、登录页 CSS、状态格带打印图案、编辑器工具栏 —— 都归 #68 |

**验证证据**：`prototype/ios/theme-tokens.css`（可复制的 token 块）+ `prototype/ios/theme-token-check.mjs`（读这份 CSS，17 个 token、19+12 对、打印灰阶全过）。原型交互 15/15 见 #66 的 `prototype/ios/cdp-test.mjs`。

---

## 1. 为什么是 `light-dark()`，不是 `@media` + 覆盖

| 方案 | 问题 |
| --- | --- |
| **两个 `:root`**（旧 #60 前的暗色定义 + light 覆盖） | 同一角色有两个定义，改一处必忘另一处；`style-check` 的「一个 `:root`」纪律直接破掉 |
| `:root` + `@media (prefers-color-scheme)` + `[data-theme]` 覆盖 | 深色值要在两处重复（媒体块 + 属性块），且要写 `:root:not([data-theme=light])` 之类的排除；级联顺序容易出错；三态切换还要和媒体查询打架 |
| JS 把一堆 token 写进 `style` | 首屏闪、SSR 多一套状态、每个 token 都要 JS 管；读面不再是无 JS 可用 |
| **单个 `:root` + `light-dark()` + `color-scheme`**（选中） | 浅深并排一行；系统/强制三态只改一个属性；UA 层（表单控件、滚动条、`<dialog>`）自动跟随；**不新增 `@media` 块**，现有「无 `prefers-color-scheme`」断言可以保留（语义从「深色已删」变成「三态不走媒体查询」） |

`light-dark()` 的语义：在**使用该 token 的元素**上按 `color-scheme` 二选一。因此：

- `:root { color-scheme: light dark; }` → 跟随系统；
- `:root[data-theme="light"] { color-scheme: light; }` → 强制浅；
- `:root[data-theme="dark"] { color-scheme: dark; }` → 强制深；
- 三态切换**只改 `color-scheme`**，不碰任何 token。

浏览器门槛：`light-dark()` Baseline 2024-05（Chrome 123 / Safari 17.5 / Firefox 120 一档），与 map 已定的「最近两年现代浏览器」一致。**不做旧浏览器回退**；如果以后要，另开票加 `@supports` 的浅色兜底，不在本图。

---

## 2. 最终 token 表

### 2.1 颜色（17 个）

| token | 浅色 | 深色 | 角色 | 谁用 |
| --- | --- | --- | --- | --- |
| `--bg` | `#f2f2f7` | `#000000` | 页面底 | body / 页面背景 |
| `--bg-card` | `#ffffff` | `#1c1c1e` | 卡片 / 分组列表 | `.card` / `.inset-list` / sheet |
| `--bg-elev` | `#f2f2f7` | `#2c2c2e` | 抬升面 | 卡内凹块、侧栏、segmented 轨道 |
| `--fill` | `#e4e4e7` | `#2b2b2e` | 填充底 | 输入框、按钮、tag、notice |
| `--fill-strong` | `#d1d1d6` | `#3a3a3c` | 更重的填充 | 开关关态、分段选中外的轨道 |
| `--label` | `#000000` | `#ffffff` | 主文字 | 正文 / 标题 |
| `--label-2` | `#5f5f63` | `#9f9fa5` | 次文字 | meta / 说明 / 状态标签 / 表格 |
| `--label-3` | `#7c7c82` | `#8e8e93` | **非正文** | chevron、装饰、大字号弱文字；不用于普通正文 |
| `--separator` | `#c6c6c8` | `#38383a` | hairline | 行分隔 / 卡片描边 |
| `--border-strong` | `#7c7c82` | `#8e8e93` | 控件边框 | 输入框 / 开关 / 分段边界（1.4.11 的 3:1） |
| `--accent` | `#0062cc` | `#409cff` | 强调 | 链接 / 当前项 / 主按钮底 / 焦点环 |
| `--on-accent` | `#ffffff` | `#000000` | 主按钮文字 | 深色下翻成黑字 |
| `--ok` | `#1b7a2f` | `#30d158` | 可用 | 状态文字 / 点 / 格带 |
| `--warn` | `#a35a00` | `#ff9f0a` | 异常 | 同上 |
| `--bad` | `#c1271b` | `#ff6961` | 故障 | 同上 / 错误条 |
| `--unknown` | `#c4c4c6` | `#5a5a5e` | 无数据**填充** | 只做填充；有意义的不确定指示用 `--border-strong` |
| `--scrim` | `rgba(0,0,0,.38)` | `rgba(0,0,0,.55)` | 弹层遮罩 | `::backdrop`；唯一非 hex |

**与研究的三个取值差异（都是为了过 4.5 / 3:1，不是拍脑袋）：**

1. `--label-2` 用 `#5F5F63`（研究建议 `#6C6C70`）。因为 tag 的底是 `--fill`，`#6C6C70` 在 `#E4E4E7` 上只有 **4.12:1**；`#5F5F63` 是 **5.01:1**。
2. `--border-strong` 用 `#7C7C82 / #8E8E93`（研究建议 `#8A8A8E / #7C7C82`）。因为输入框底也是 `--fill`，`#8A8A8E` 在 `#E4E4E7` 上只有 **2.71:1**；`#7C7C82` 是 **3.27:1**。
3. `--label-3` 用 `#7C7C82 / #8E8E93`（研究建议 `#8A8A8E / #8E8E93`）。它当 chevron 时可能落在 `--fill` 上，`#8A8A8E` 只有 2.71:1；`#7C7C82` 是 3.27:1。它**不当正文**，所以不需要 4.5。

`--scrim` 是唯一非 hex：遮罩的对比度取决于它覆盖的内容，不能作为一对前景/背景来算；弹层**内容**仍按 `--bg-card` 上的文字对来验。

### 2.2 非颜色（16 个）

`:root` 里同时保留这些；颜色数不能把它们算进去。

| 类别 | token |
| --- | --- |
| 形状 | `--radius-sm: 8px` · `--radius: 12px` · `--radius-lg: 16px` · `--tap: 44px` |
| 栏宽 | `--wrap: 900px` · `--wrap-admin: 1140px` · `--side-w: 220px` |
| 字体 | `--font` · `--mono` |
| 排版（**本票不动，归 #68 重定**） | `--font-data` · `--font-prose` · `--fs-data` · `--lh-data` · `--fs-prose` · `--lh-prose` · `--measure-prose` |

> `--font-data` / `--font-prose` 是 A 方向落地时要拆掉的两套平面；但那是 #68 的排版决定。本票只要求在 `:root` 里暂时保留，style-check 的 `NON_COLOR` 里也继续保留。

---

## 3. CSS 骨架

完整可复制版本：`prototype/ios/theme-tokens.css`。核心：

```css
:root {
  color-scheme: light dark;

  --bg: light-dark(#f2f2f7, #000000);
  --bg-card: light-dark(#ffffff, #1c1c1e);
  --bg-elev: light-dark(#f2f2f7, #2c2c2e);
  --fill: light-dark(#e4e4e7, #2b2b2e);
  --fill-strong: light-dark(#d1d1d6, #3a3a3c);
  --label: light-dark(#000000, #ffffff);
  --label-2: light-dark(#5f5f63, #9f9fa5);
  --label-3: light-dark(#7c7c82, #8e8e93);
  --separator: light-dark(#c6c6c8, #38383a);
  --border-strong: light-dark(#7c7c82, #8e8e93);
  --accent: light-dark(#0062cc, #409cff);
  --on-accent: light-dark(#ffffff, #000000);
  --ok: light-dark(#1b7a2f, #30d158);
  --warn: light-dark(#a35a00, #ff9f0a);
  --bad: light-dark(#c1271b, #ff6961);
  --unknown: light-dark(#c4c4c6, #5a5a5e);
  --scrim: light-dark(rgba(0, 0, 0, .38), rgba(0, 0, 0, .55));

  --radius-sm: 8px;
  --radius: 12px;
  --radius-lg: 16px;
  --tap: 44px;
  /* 栏宽 / 字体 / 排版 token 暂时保留，见 §2.2 */
}

:root[data-theme="light"] { color-scheme: light; }
:root[data-theme="dark"] { color-scheme: dark; }
```

要求：

- **只有一个 `:root`**；`[data-theme]` 两个规则只写 `color-scheme`，不写任何颜色 token。
- **不出现** `@media (prefers-color-scheme …)`。
- token 值只用 `light-dark(#hex, #hex)`；唯一例外 `--scrim` 的 `rgba`。
- 组件里可以用 `color-mix(in srgb, var(--…) …)`；但**文字所在的底**必须是纯色 token（不能是 `color-mix` 或半透明），否则对比度无法静态验。
- `--unknown` 只做填充；任何**有意义**的「无数据」指示（空心点边框等）用 `--border-strong`（#68 改）。
- 页头**不透明**（A 的落地约束）；不要在 A 的顶栏上写 `backdrop-filter` + 半透明底。

### `color-scheme` 与原生控件

`color-scheme` 会让 UA 层跟着变：`input` / `select` / `textarea` / `checkbox` / `radio` / `<dialog>` 的默认底色与文字、滚动条、表单验证气泡。因此：

- 不需要给每个控件写 `color-scheme`；`:root` 一处就够。
- 不要用 `background: #fff` 硬覆盖控件的 UA 底；用 `--fill` / `--bg-card` / `--border-strong`。
- 现有 `.plane-data input` 的 `background: var(--bg-soft)` / `border: var(--border)` 在 #68 改成 `--fill` / `--border-strong`；本票不改。
- `<dialog>` 的 `::backdrop` 用 `var(--scrim)`；`dialog` 自身的面用 `--bg-card`。

---

## 4. 三态切换

### 4.1 控件

用**原生 `<select>`**，不用二态开关/循环按钮：三态是「系统 / 浅 / 深」，`<select>` 自带键盘、屏幕阅读器与当前值语义。

```html
<label class="theme-picker">
  <span class="sr">主题</span>
  <select data-theme-select aria-label="主题">
    <option value="system">跟随系统</option>
    <option value="light">浅色</option>
    <option value="dark">深色</option>
  </select>
</label>
```

位置：

- `layout()` 的页头（`.header-inner` 里，登出表单之前）；403/404/管理台/公开页都走 `layout()`，自动获得。
- `loginPage()` **不走** `layout()`：在登录页右上角放一个 `.login-theme` 容器包同一个 picker（fixed 定位由 #68 的 CSS 给）。
- 编辑器页走 `layout()`，不需要第二个 picker。
- 打印时 picker 隐藏（现有 `button`/表单控件打印隐藏规则会覆盖；#68 补 `[data-theme-select]`）。

### 4.2 JS

放在 `</body>` 前，内联；两个外壳共用。**不监听 `matchMedia`**：系统切换由 CSS 的 `light-dark()` 自动处理；只有 UI 想显示「跟随系统（当前：深）」时才需要读它，本图不做。

```html
<script>
(() => {
  const root = document.documentElement
  const KEY = 'theme'
  const selects = document.querySelectorAll('[data-theme-select]')
  const read = () => {
    try { return localStorage.getItem(KEY) || 'system' } catch (e) { return 'system' }
  }
  const apply = (value) => {
    if (value === 'light' || value === 'dark') {
      root.dataset.theme = value
      root.style.colorScheme = value
    } else {
      root.removeAttribute('data-theme')
      root.style.colorScheme = ''
    }
    selects.forEach((s) => { s.value = value })
  }
  apply(read())
  selects.forEach((s) => s.addEventListener('change', () => {
    const value = s.value === 'light' || s.value === 'dark' ? s.value : 'system'
    try {
      if (value === 'system') localStorage.removeItem(KEY)
      else localStorage.setItem(KEY, value)
    } catch (e) {}
    apply(value)
  }))
})()
</script>
```

- localStorage 键：**`theme`**，值只允许 `light` / `dark`；系统 = 键不存在。
- 不写 cookie：会话/写路径的既有决定不动。
- `localStorage` 在 Safari 无痕/企业策略下可能抛错：读与写都 `try/catch`，失败就退回「跟随系统」。
- 多个 picker（页头 + 登录页）用 `querySelectorAll` 同步；同一页只有一个也安全。
- `select` 的 SSR 值是 `system`；boot 脚本已经把颜色主题应用了，末尾脚本只负责把控件值同步到存储值；主题本身不闪（见 §5）。

### 4.3 无 JS

- 没有 JS：`:root { color-scheme: light dark }` 生效，站点**跟随系统**；深/浅都可用。
- picker 在无 JS 时点了没反应，会让人误以为坏：在 `<head>` 放
  ```html
  <noscript><style>[data-theme-select] { display: none }</style></noscript>
  ```
  隐藏它。功能降级为「跟随系统」，不是坏掉。
- 打印/读面不依赖 JS。

---

## 5. 防闪：boot 脚本必须在 stylesheet 之前

### 5.1 顺序

`layout()` 与 `loginPage()` 的 `<head>` 都按这个顺序：

```html
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>…</title>
<meta name="description" content="…">
<script>/* boot */</script>
<link rel="stylesheet" href="/style.css">
<link rel="icon" href="…">
```

`<meta name="color-scheme">` 让 CSS 到达前的 UA 画布也按系统色走（避免深色系统 + 白闪）；boot 脚本在 stylesheet 之前，第一帧前就把 `data-theme` / `color-scheme` 放到 `<html>` 上。

### 5.2 boot 脚本

```html
<script>
try {
  var t = localStorage.getItem('theme');
  if (t === 'light' || t === 'dark') {
    document.documentElement.dataset.theme = t;
    document.documentElement.style.colorScheme = t;
  }
} catch (e) {}
</script>
```

- 内联、同步、在 `<link rel="stylesheet">` 之前；`defer` / `DOMContentLoaded` 都会闪。
- `try/catch` 不是可选的：Safari 无痕下 `localStorage.getItem` 可能抛。
- 现在**没有 CSP**；若以后加，给这段内联脚本 nonce 或 hash。
- SSR 永远按「跟随系统」输出（不读 cookie）；脚本在第一帧前纠正。**不要**为了主题去加 cookie —— 那会动会话/写路径。
- 两个外壳都要有：`layout()`（含 403/404）与 `loginPage()`。建议在 `views.ts` 抽 `head({ title, description, site })` 与 `themeBoot()`，两个模板都调用；不要复制两遍。
- `403` 页**走 `layout()`**（`forbiddenPage()` 返回 `layout(...)`），所以不需要单独处理；只有登录页是独立外壳。这一点修正了 map Notes 里「403 也不走 layout」的旧说法。

### 5.3 断言

- style-check 读 `views.ts`：`<meta name="color-scheme" content="light dark">` 出现 2 次（layout + login）；boot 脚本在 `<link rel="stylesheet">` 之前；`[data-theme-select]` 出现 2 次；`localStorage.getItem('theme')`；`noscript` 隐藏；`matchMedia` 不出现。
- e2e 再加行为断言：设置 `localStorage.theme = 'dark'` → 刷新 → `document.documentElement.dataset.theme === 'dark'`；`system` 时无 `data-theme`；`select` 的三项；切换后存储值变化。无 JS 的「跟随系统」由 CSS 保证，可在禁用 JS 的浏览器里目视。

---

## 6. 打印：纯纸面 + 灰阶，状态改图案

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
  }
}
```

- 仍在**唯一的 `:root`** 之外、改在 `body` 上；全站仍只有一个 `:root`。
- 打印块里的值**全是灰阶**；不写 `light-dark()`。
- `color-scheme: light` 让 UA 层（滚动条/控件）也回浅色。
- 现有打印规则（隐藏页头/导航/按钮、`break-inside: avoid`、链接地址写出来、宽表放开）保留；`print-color-adjust: exact` 保留给状态格带的**图案**。
- **显式修订旧断言**：`style-check` 现在有一条「打印时状态格带保留颜色」。本图改为「打印灰阶」，这条断言改成「打印时状态格带保留填充（`print-color-adjust: exact`）」，颜色是否保留不再断言；三种状态的可区分性由 #68 用**图案 + 文字标签 + 点形状**承担：
  - 徽标本身有「可用 / 异常 / 故障」文字，黑白打印仍可读；
  - 状态点已有形状差异（圆 / 方 / 三角 / 空心）；
  - 格带在打印时改成图案（实心 / 斜线 / 反斜线）——这是 #68 的组件工作，本票只定「打印不再用状态色」。
- `--ok` / `--bad` 打印都 `#000000`、`--warn` `#555555`：单看色块分不出 ok/bad，所以**必须**配文字/形状/图案；这正是 #68 要补的。

---

## 7. 对比度预算

### 7.1 文字 19 对（≥ 4.5:1）

| # | 前景 / 背景 | 用途 | 浅色 | 深色 |
| --- | --- | --- | --- | --- |
| 1 | `label` / `bg` | 正文（页面） | 18.82 | 21.00 |
| 2 | `label` / `bg-card` | 正文（卡片） | 21.00 | 17.01 |
| 3 | `label` / `bg-elev` | 正文（抬升面） | 18.82 | 13.94 |
| 4 | `label` / `fill` | 正文（填充） | 16.55 | 14.12 |
| 5 | `label-2` / `bg` | 次文字（页面） | 5.70 | 7.98 |
| 6 | `label-2` / `bg-card` | 次文字（卡片） | 6.36 | 6.46 |
| 7 | `label-2` / `bg-elev` | 次文字（抬升面） | 5.70 | 5.29 |
| 8 | `label-2` / `fill` | 次文字（tag 底） | 5.01 | 5.36 |
| 9 | `accent` / `bg` | 链接（页面） | 5.20 | 7.42 |
| 10 | `accent` / `bg-card` | 链接（卡片） | 5.80 | 6.01 |
| 11 | `accent` / `bg-elev` | 链接（抬升面） | 5.20 | 4.92 |
| 12 | `on-accent` / `accent` | 主按钮文字 | 5.80 | 7.42 |
| 13 | `ok` / `bg-card` | 状态 ok（卡片） | 5.42 | 8.42 |
| 14 | `ok` / `bg-elev` | 状态 ok（抬升面） | 4.86 | 6.89 |
| 15 | `warn` / `bg-card` | 状态 warn（卡片） | 5.22 | 8.28 |
| 16 | `warn` / `bg-elev` | 状态 warn（抬升面） | 4.68 | 6.78 |
| 17 | `bad` / `bg-card` | 状态 bad（卡片） | 5.88 | 6.03 |
| 18 | `bad` / `bg-elev` | 状态 bad（抬升面） | 5.27 | 4.94 |
| 19 | `bad` / `fill` | 错误条（填充） | 4.63 | 5.00 |

最低：**4.63:1**（`bad` on `fill`，浅色）。全部过 AA。

### 7.2 非文字 12 对（≥ 3:1，1.4.11）

| # | 前景 / 背景 | 用途 | 浅色 | 深色 |
| --- | --- | --- | --- | --- |
| 1 | `label-3` / `bg` | chevron / 装饰 | 3.72 | 6.44 |
| 2 | `label-3` / `bg-card` | 同上 | 4.15 | 5.22 |
| 3 | `label-3` / `bg-elev` | 同上 | 3.72 | 4.27 |
| 4 | `label-3` / `fill` | 同上 | 3.27 | 4.33 |
| 5 | `border-strong` / `bg` | 控件边框 | 3.72 | 6.44 |
| 6 | `border-strong` / `bg-card` | 控件边框 | 4.15 | 5.22 |
| 7 | `border-strong` / `bg-elev` | 控件边框 | 3.72 | 4.27 |
| 8 | `border-strong` / `fill` | 控件边框 | 3.27 | 4.33 |
| 9 | `accent` / `bg` | 焦点环 | 5.20 | 7.42 |
| 10 | `accent` / `bg-card` | 焦点环 | 5.80 | 6.01 |
| 11 | `accent` / `bg-elev` | 焦点环 | 5.20 | 4.92 |
| 12 | `accent` / `fill` | 焦点环 | 4.57 | 4.99 |

最低：**3.27:1**（`label-3` / `border-strong` on `fill`，浅色）。全部过 3:1。

### 7.3 不进表的三类

- **`--unknown`**：填充色，不是文字；无数据格/点的「缺失」由空心形状 + 文案说明。有意义的「无数据」边框改用 `--border-strong`（#68）。
- **`--separator`**：装饰性 hairline，不是控件边界；不承诺 3:1。
- **`--scrim`**：覆盖层；有效对比度取决于背后的内容，不能做静态对。弹层内容按 `--bg-card` 上的文字对验。

`ALLOWED` 例外表继续为空；不要为了某对颜色加「大字号豁免」——`label-3` 不当正文，`label-2` 已在 4.5 以上。

### 7.4 证据

```bash
node prototype/ios/theme-token-check.mjs
# → ALL PASS（17 token / 19×2 文字 / 12×2 非文字 / 17 打印灰阶）
```

脚本读 `prototype/ios/theme-tokens.css`，并核对 CSS 里的值 == 校验表；不是两套数字。

---

## 8. `style-check.mjs` 迁移清单

当前 **72 项**。本票只定目标；实现时按下面改。**不要**在 CSS/views 还没迁移时先改脚本 —— 那会让中间态必红。

### 8.1 保留（语义不变）

- `:root` 恰好一个。
- CSS 里没有 `@media (prefers-color-scheme …)`（语义改成「三态不走媒体查询」）。
- 打印块不在 `:root` 上改 token。
- 服务端类名都有 CSS 定义（新增 `.theme-picker` / `.login-theme`）。
- 两套平面 / 侧栏 / 窄屏 / 打印内容 / 面板契约 / 图表 token 等现有断言：**#67 不动**；等 #68 的排版/类名批再改。
- `src/charts.ts` 的 `var(--accent)` / `var(--ok)` 继续成立。

### 8.2 改写

| 断言 | 旧 | 新 |
| --- | --- | --- |
| 颜色 token 数 | 13 | **17**（精确集合见 §2.1） |
| `NON_COLOR` | 13 个 | **16 个**（加 `radius-sm` / `radius-lg` / `tap`） |
| 颜色定义位置 | `--x: #hex;` 正则，root + print | 按**color token 名**计数；`:root` 17 + print 17 = **34**；别处 0 |
| 对比度循环 | 19 对、每对单值、hex-only | **19 对文字 ×2 模式 + 12 对非文字 ×2 模式**；解析 `light-dark(#a,#b)`；`scrim` 跳过 |
| 打印 token 值 | `--bg`/`--fg` 两条 + 状态色 | **17 个全部在 print**；全部**灰阶**；`body` 有 `color-scheme: light`；print 里没有 `light-dark()` |
| 打印状态色 | 「状态格带保留颜色」 | 改成「状态格带保留填充（`print-color-adjust: exact`）」；颜色不再要求；图案归 #68 |
| 主按钮文字 | `on-accent`/`accent` | 同名保留；深色下 `on-accent` 翻黑，已有 7.42 |

新增/替换的关键实现：

```js
const COLOR_TOKENS = new Set([
  'bg','bg-card','bg-elev','fill','fill-strong',
  'label','label-2','label-3','separator','border-strong',
  'accent','on-accent','ok','warn','bad','unknown','scrim',
])
const NON_COLOR = new Set([
  'radius','radius-sm','radius-lg','tap','wrap','wrap-admin','side-w',
  'font','mono','font-data','font-prose','fs-data','lh-data','fs-prose','lh-prose','measure-prose',
])

const parseLightDark = (v) => {
  const m = /^light-dark\(\s*(#[0-9a-f]{3,8})\s*,\s*(#[0-9a-f]{3,8})\s*\)$/i.exec(v.trim())
  return m ? [m[1], m[2]] : null
}
const colorValue = (tokens, name, mode) => {
  if (name === 'scrim') return null // 覆盖层，不进对比度
  const pair = parseLightDark(tokens[name] ?? '')
  if (!pair) return null
  return pair[mode === 'light' ? 0 : 1]
}
```

- `--scrim` 的 CSS 值用 `light-dark(rgba(...), rgba(...))`；颜色 token 值检查对 `scrim` 单独放行 `rgba`。
- `countColorDefs` 不再数 `#hex`，而是数 `--<colorToken>:` 定义；这样 `light-dark()` 也能数到，`--scrim` 也算一份。
- 若保留「颜色 literal 只能在 root/print」这条更强的纪律：先剥 `/* … */` 注释，再在 root/print 之外搜 `#hex`；当前 CSS 已经满足（`rgba` 只在注释里），实现时保持。
- `:root[data-theme="light"]` / `dark` 的块体只允许 `color-scheme`：
  ```js
  const themeBody = (name) => blockAfter(css, css.indexOf(`:root[data-theme="${name}"]`))
  check('light 只切 color-scheme', /^\s*color-scheme:\s*light;\s*$/.test(themeBody('light').trim()))
  check('dark 只切 color-scheme', /^\s*color-scheme:\s*dark;\s*$/.test(themeBody('dark').trim()))
  ```

### 8.3 新增

| 检查 | 条件 |
| --- | --- |
| `:root` 的 `color-scheme` | `color-scheme: light dark` |
| `[data-theme=light/dark]` | 只含 `color-scheme: light/dark`；不含颜色 token |
| meta | `views` 里 `<meta name="color-scheme" content="light dark">` **2 次**（layout + login） |
| boot 顺序 | `<script>` 在 `<link rel="stylesheet">` **之前**；两个外壳都有 |
| boot 内容 | `localStorage.getItem('theme')` + `dataset.theme` + `try/catch` |
| picker | `[data-theme-select]` **2 次**；三选项；`aria-label="主题"` |
| 无 JS 降级 | `<noscript>` 里 `[data-theme-select] { display: none }` |
| 不监听系统 | `views` 里没有 `matchMedia` |
| 不写 cookie | theme JS 里没有 `document.cookie` |
| 打印灰阶 | print 的 17 个值 `isGrayscale()`；`body` 有 `color-scheme: light`；无 `light-dark()` |
| 对比度阈值 | 文字 19×2 ≥4.5；非文字 12×2 ≥3；`ALLOWED` 为空 |

### 8.4 交给 #68 的

- `--font-data` / `--font-prose` / `--fs-*` / `--lh-*` / `--measure-prose` 的存废与改名；`plane-data/prose` 的退场。**#67 的 style-check 继续保留这些断言**，直到 #68 的批次一起改。
- 类名迁移（`--fg` → `--label`、`--border` → `--separator`/`--border-strong`、`--bg-soft` → `--fill` 等）与所有组件选择器。
- `.theme-picker` / `.login-theme` 的 CSS、页头位置、手机折叠。
- 状态格带的打印图案（实心/斜线/反斜线）与 `print-color-adjust` 的最终规则。
- 编辑器工具栏 / ProseMirror / 图表 / 表格 / 表单的 iOS 样式。
- 403/404 的页头 picker 样式（它们走 `layout`，只差 CSS）。

> ⚠ 迁移必须在**一个批次**里完成：CSS token 改名 + 所有 `var()` 使用者 + `views.ts` 的 head/picker + `style-check.mjs`。不要先改 token 再把旧 var 留成别名（那会造出第二份真相）。批次边界归 #69。

---

## 9. 覆盖清单

| 面 | 外壳 | boot | picker | 备注 |
| --- | --- | --- | --- | --- |
| 首页 / 分享 / 文章 / 关于 | `layout()` | ✅ | ✅ 页头 | 读面无 JS 也能跟随系统 |
| 面板 `/status` | `layout()` | ✅ | ✅ 页头 | `status.js` 每 30 秒重绘，只改类名；无颜色 |
| 管理台六页 | `layout()` | ✅ | ✅ 页头 | 侧栏保留；#68 再改排版 |
| 登录页 | `loginPage()` | ✅ | ✅ 右上 `.login-theme` | **唯一**独立外壳；无导航 |
| 403 | `layout()` | ✅ | ✅ 页头 | `forbiddenPage()` 返回 `layout(...)`；不单独处理 |
| 404 | `layout()` | ✅ | ✅ 页头 | `notFoundPage()` 返回 `layout(...)` |
| 编辑器 | `layout()` | ✅ | ✅ 页头 | 工具栏/正文面用 token；无独立外壳 |
| 打印 | `@media print` | — | 隐藏 | `body` 上 17 个灰阶 token；状态图案 #68 |
| `status.js` / `chart-path.js` | 依附页面 | — | — | 不写颜色；无需改 |
| Fastify 默认 4xx/5xx | 非本项目模板 | — | — | 不在本图；若以后要，单独票 |

---

## 10. 风险与边界

- **`light-dark()` 的元素级解析**：规范是在使用 token 的元素上解析；打印/局部强制浅色时要在 `body` 上显式 `color-scheme: light`（本文已做）。没有在 Safari 真机实测，落地时补一次。
- **浏览器门槛**：Safari 17.5+；不做旧浏览器回退。老浏览器会退化成「无颜色」；如果要兼容，另开 `@supports` 票。
- **`color-mix`**：组件可用，但文字所在的底必须是纯 token；`style-check` 不能算混合后的对比度。混合色只用于非文字装饰。
- **`--scrim`**：唯一 `rgba` 颜色；`style-check` 对它放行，不参与对比度。
- **改名规模**：旧 token (`bg-soft`/`border`/`fg`/`fg-dim`/`fg-faint`) 在 666 行 CSS 里散落很多；必须一次迁完，不要留别名。
- **中间态**：token/theme 批次完成前 `style-check` 必红；#69 要把「token + views head/picker + style-check」切在同一批。
- **A 的页头**：不透明；不要因为原型 A 的半透明材质把 `backdrop-filter` 带进产品。
- **`theme` 键是公开契约**：改名会让用户偏好丢失；保持 `theme` / `light` / `dark` / 缺省=system。
- **无 CSP**：内联脚本现在可用；以后加 CSP 要给 boot/toggle 加 nonce 或 hash。
- **打印状态色退役**：这是对旧 #45 断言的有意修订。三种状态在纸上靠文字标签 + 点形状 + 格带图案；#68 不做图案就等于「打印分不出状态」，必须在 #68 收口。
- **`--unknown`**：只做填充；#68 把空心点边框从 `--unknown` 改用 `--border-strong`。

---

## 11. 验证与证据

| 项 | 结果 |
| --- | --- |
| 提议 token 值 | `node prototype/ios/theme-token-check.mjs` → **ALL PASS**（17 token / 19×2 文字 / 12×2 非文字 / 17 打印灰阶） |
| token CSS | `prototype/ios/theme-tokens.css`（可直接复制） |
| 机制原型 | `prototype/ios/a.html` + `app.js`；Edge CDP **15/15**（#66） |
| 当前产品基线 | `node scripts/style-check.mjs` → **72/72**（旧 token/浅色单套；本票未改） |
| 产品代码 | `src/` / `public/` / `scripts/` **一行未改** |
| 未验证 | Safari 真机、打印实际效果、`light-dark()` 的 Safari 元素级解析 |

落地顺序建议：**token/theme 批次**（CSS token 改名 + 所有 var 使用者 + views head/picker + style-check）→ **组件/排版批次**（#68）→ **打印图案/收口**（#68/#69）。具体切分归 #69。
