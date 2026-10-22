# Apple HIG 落到 Web 的事实与取舍（研究笔记）

> **这是研究票 #65 的产出，不是决定书；方向由原型票 #66 定。**
> 本文逐条回答「HIG 说什么 / Web 能做什么 / 本仓建议」，不选方向、不写产品代码、不动 `src/`、`public/`、`scripts/`。

- 票：[#65 研究：Apple HIG 的 Web 落地事实](https://github.com/Lkyloveaw/lkyloveaw-home/issues/65)（父图 [#64 整站 iOS 化](https://github.com/Lkyloveaw/lkyloveaw-home/issues/64)）
- 下游：本文阻塞 [#68 组件映射与导航呈现](https://github.com/Lkyloveaw/lkyloveaw-home/issues/68)；同批还有 [#66 方向原型](https://github.com/Lkyloveaw/lkyloveaw-home/issues/66)、[#67 token 架构与断言迁移](https://github.com/Lkyloveaw/lkyloveaw-home/issues/67)
- 证据口径：**Apple 一手文档**（HIG 正文、WebKit 博客、Apple 字体页）、**MDN / W3C 规范**、**WCAG 2.2**。逐条带链接；凡是我自己算的、自己判断的，都单独标出来。
- 标记约定：**【事实】** = 有来源可查；**【取舍】** = 本仓怎么选、为什么；**【不确定】** = 没核实/没实测，别当结论用。
- ⚠ 本会话**没有命令通道**（`ops_bash` 报缺 bash IPC 收据），因此：**没有跑过任何测试**、没有跑过 `npm run check:style`、没有在真机浏览器里看过渲染。文中所有对比度比值是**按 WCAG 公式手算**的，已经逐对写出算式因子，等 #67 用脚本复核。

---

## 0. 一句话速览

| # | 问题 | 结论（详见对应章节） | 性质 |
| --- | --- | --- | --- |
| 1 | SF 字体 | **不能**在网页里发 SF 的 webfont；只能用 `system-ui` / `-apple-system` 取**本机已装**的系统字体。非 Apple 平台会落到 Segoe UI / Roboto，**「像 iOS」不能靠字形**。中文靠 PingFang SC / 微软雅黑 / Noto 回退 | 事实 + 取舍 |
| 2 | 字阶 | iOS 默认正文 17pt、最小 11pt；11 档 text style 的 size/leading 可 1:1 映射成 px（1pt≈1 CSS px），但 **CJK 行高必须放宽**（iOS 的 1.29 对中文太挤） | 事实 + 取舍 |
| 3 | 语义色 | HIG **不发布** iOS 语义色的数值，并明确「别硬编码，数值会随版本浮动」。生态里通行的取值中，**系统蓝/红/绿/橙与 secondaryLabel 全都过不了 AA 4.5:1**；需要按本仓的 AA 底线重新压深 | 事实（+ 手算） |
| 4 | 材质 | `backdrop-filter` 只能做出「模糊 + 半透明」，做不出 iOS 的 vibrancy（文字随背景自动变色）。半透明页头是**对比度风险**，默认应给不透明底 | 事实 + 取舍 |
| 5 | 控件 | 按钮 / 分段控件 / 开关 / inset grouped 列表 / search 都能**纯 CSS**；sheet 与 alert 用原生 `<dialog>`（Baseline 2022-03）；**tab bar 不建议照搬到桌面** | 事实 + 取舍 |
| 6 | SF Symbols | 是 Apple 专有素材，授权随 SF Symbols App/DMG，**本会话没读到授权原文**。Web 用**内联 SVG**（`currentColor`），别用图标字体 | 事实 + 不确定 |
| 7 | 深浅模式 | `light-dark()` Baseline 2024-05，**必须**配 `color-scheme`；三态可以做到「一个 `:root` 块、零 `@media prefers-color-scheme`」——恰好不违反现有断言 | 事实 |
| 8 | 可访问性 | HIG：44×44pt 默认控件、至少 200% 放大；WCAG 2.2 AA：4.5:1、非文本 3:1、目标 24×24。`prefers-reduced-motion` 与 `prefers-contrast` 是 HIG「减弱动态/增强对比」的 Web 对应物 | 事实 |
| 9 | 不该照搬 | iOS 手势、动态岛/安全区、底部 tab bar、大标题折叠、Liquid Glass、haptics —— **明确不建议** | 取舍 |

---

## 1. 字体：授权边界、字体栈、中文回退

### 1.1 HIG 说什么

- **【事实】** iOS / iPadOS / macOS 的系统字体是 **SF Pro**；SF 家族还有 SF Compact（watchOS）、SF Mono、SF Arabic/Armenian/Georgian/Hebrew、New York（衬线）等变体。系统字体是**可变字体**，带 *dynamic optical sizing*（在小字号自动用 Text 设计、大字号自动用 Display 设计），并且**系统会在每个 point size 上动态调 tracking**。
  来源：[HIG Typography](https://developer.apple.com/design/human-interface-guidelines/typography)（对应 JSON：[typography.json](https://developer.apple.com/tutorials/data/design/human-interface-guidelines/typography.json)）
- **【事实】** HIG 给了硬底线：iOS/iPadOS **正文默认 17 pt、最小 11 pt**（macOS 13/10、visionOS 17/12、watchOS 16/12）。并建议「避免 Ultralight/Thin/Light，优先 Regular / Medium / Semibold / Bold」。
  来源：同上；同样的表也出现在 [HIG Accessibility](https://developer.apple.com/design/human-interface-guidelines/accessibility)。
- **【事实】** HIG 在开发者注记里写得很直白：**"don't embed system fonts in your app or game"**（用 `Font.Design` 之类的 API 取，而不是把字体文件打进包里）。
  来源：同上（typography 的 Developer note）。
- **【事实】** Apple 的字体下载页把 SF/NY 定位为「给你的 **Apple 平台** App 做界面用」的字体，并引导去读 HIG。
  来源：[Fonts for Apple platforms](https://developer.apple.com/fonts/)

### 1.2 Web 能做什么

- **【事实】** Web 端没有一个可以合法分发的「SF webfont」。正路是让**浏览器去用本机已装的系统字体**：
  - `-apple-system` 是 WebKit 的历史关键字（非标准），在 Apple 平台映射到系统字体；在不支持的平台**自动回退到列表里的下一个**。
    来源：[WebKit: Using the System Font in Web Content](https://webkit.org/blog/3709/using-the-system-font-in-web-content/)（2015）
  - `system-ui` 是 CSS Fonts 4 的通用族，语义是「当前操作系统的 UI 字体」。在 Windows 上是 Segoe UI，Android 上是 Roboto，Linux 上通常是 Cantarell/Ubuntu 一类。
    来源：[CSS Fonts 4 §generic-font-families](https://www.w3.org/TR/css-fonts-4/#generic-font-families)、[MDN font-family](https://developer.mozilla.org/en-US/docs/Web/CSS/font-family)
- **【事实/推论】** 所以「在 Windows 桌面上看这个站」= **Segoe UI**，不是 SF。iOS 感只能来自**字阶、行高、字重、圆角、留白、语义色**，不能来自字形。
- **【不确定】** SF 的授权原文在字体 DMG 里的许可协议中（点击同意），本会话**没有读到逐字条款**，Apple 字体页也只有「for apps on Apple platforms」的定位。稳妥口径：**不要把 SF 下载下来做成 `@font-face` 发到站点上**。要精确结论，需下载 DMG 读许可原文，或问法务——但这条不影响方案：用系统栈本来就更优（零字节、零 FOUT）。
- 中文回退（**事实**层面的常识，无单一规范来源）：Apple 平台 `PingFang SC`（旧系统 `Hiragino Sans GB`）、Windows `Microsoft YaHei`、Linux/Android `Noto Sans CJK SC` / `Source Han Sans SC`。**不要**为了「统一观感」去自托管 Noto Sans SC 全量字重：CJK 字体动辄几 MB，且本仓没有构建步骤做字形子集化（subset）。

### 1.3 本仓建议

**【取舍】** 字体栈（Latin 在前、CJK 在后，后面的只在前面的字体缺字时兜底）：

```css
--font: system-ui, -apple-system, "Segoe UI", "Noto Sans SC",
        "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei",
        Roboto, Helvetica, Arial, sans-serif;
```

- 现有 `public/style.css:42-45` 的栈把 `-apple-system` 放第一位；把它换成 `system-ui` 打头、`-apple-system` 的第二位即可（老 Safari 才需要后者，而本图已经放弃「两年以前的浏览器」）。
- **保留 `--mono`**（`ui-monospace, SFMono-Regular, "SF Mono", Menlo, …`）：即便数据面的「终端化」被 iOS 语言取代，`<code>/<pre>` 与面板的 tabular 数字仍然要用等宽。
- `<html lang="zh-CN">` 已经在 `src/views.ts:169` / `:863` 写死——**保留**，它决定 CJK 用简体字形（否则某些环境会挑到日文字形）。
- 如果 #66 认为「非 Apple 平台上字形差异太大」，可选项是自托管 **Inter**（SIL OFL，可商用、可子集化）只覆盖 Latin。但注意 Inter 与 SF 的 x-height/字宽并不相同，**先量再决定**；这条属于原型的判断，不在本文结论里。
- 保持 `-webkit-text-size-adjust: 100%`（`style.css:57`）；它防的是 iOS 横屏自动放大字号。

---

## 2. 字阶：iOS text style → Web 的 px/rem/line-height/weight

### 2.1 HIG 说什么

- **【事实】** text style = 「字号 + 字重 + leading」的组合；用内置 text style 才自动获得 Dynamic Type（含「更大文字」辅助功能档位）。
- **【事实】** 「强调」（emphasized）不是简单加粗一档：在 iOS 默认档位里，Large Title / Title 1 / Title 2 的 emphasized 是 **Bold**，Title 3 / Headline / Body / Callout / Subhead / Footnote / Caption 是 **Semibold**。
- **【事实】** leading 是随字号给定值（不是百分比）：例如 17 pt 正文配 22 pt leading（≈1.29），34 pt 大标题配 41 pt（≈1.21）。
  来源：[HIG Typography](https://developer.apple.com/design/human-interface-guidelines/typography)（iOS built-in text styles 表；我读的是同一页的 DocC JSON，页面本身是客户端渲染，纯 HTML 抓不到正文）

### 2.2 Web 能做什么

- **【事实】** iOS 的 point 与 Web 的 CSS px 在布局语义上可视为 1:1（同一个逻辑坐标体系），所以 **34 pt ≈ 34px**。这不是物理尺寸等价，只是「设计稿数值可以直接搬」。
- **【事实】** 浏览器有两条独立放大通道：(a) 页面缩放（zoom，全部放大，含布局）；(b) 默认字号设置（只影响 `rem`/`em` 与未设 px 的文字）。**在 `body` 上写死 `font-size: 16px`（现状 `style.css:64`）会切断 (b)**。
- **【事实】** Safari on iOS 有一个非标准钩子可以直接吃到 Dynamic Type：`font: -apple-system-body` 等一整套 `-apple-system-*` 值。
  来源：[WebKit 博客](https://webkit.org/blog/3709/using-the-system-font-in-web-content/)。**【不确定】** 它在今天的 Safari 上是否仍完整生效、以及是否与 `prefers-reduced-motion` 之外的辅助功能档位联动——本会话无法实测；而且它只影响声明了该 `font` 简写的元素，不适合当全局方案。

### 2.3 本仓建议

**【取舍】** 建议的映射表（`rem` 以 16px 为基准；行高给两列：Latin/DOM 组件用 iOS 比例，**CJK 长文**用本仓现有比例）：

| iOS style | pt / leading | Web 字号 | rem | 组件行高（iOS 比例） | 长文行高（CJK） | 字重 | 本仓落点 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Large Title | 34 / 41 | 34px | 2.125 | 1.21 | 1.3 | 400（强调 700） | 首页 hero `h1` |
| Title 1 | 28 / 34 | 28px | 1.75 | 1.21 | 1.3 | 400（强调 700） | 文章页 `h1` |
| Title 2 | 22 / 28 | 22px | 1.375 | 1.27 | 1.35 | 400（强调 700） | 区块标题 |
| Title 3 | 20 / 25 | 20px | 1.25 | 1.25 | 1.35 | 400（强调 600） | 卡片标题 / 管理台分组 |
| Headline | 17 / 22 | 17px | 1.0625 | 1.29 | 1.5 | **600** | 列表主行、`section-head h2` |
| Body | 17 / 22 | 17px | 1.0625 | 1.29 | **1.7–1.85** | 400 | 正文（现状 `--fs-prose: 17px` 恰好一致） |
| Callout | 16 / 21 | 16px | 1.0 | 1.31 | 1.6 | 400 | 提示 / 表单说明 |
| Subhead | 15 / 20 | 15px | 0.9375 | 1.33 | 1.6 | 400 | 次级说明（现状 `--fs-data: 15px`） |
| Footnote | 13 / 18 | 13px | 0.8125 | 1.38 | 1.55 | 400 | meta / 时间戳 / 页脚 |
| Caption 1 | 12 / 16 | 12px | 0.75 | 1.33 | 1.5 | 400 | 徽标、图表轴 |
| Caption 2 | 11 / 13 | 11px | 0.6875 | 1.18 | 1.4 | 400 | **不建议**：Web 上 <12px 在 1.4.4 缩放下更难读，统一并入 Caption 1 |

**四条取舍，理由写清楚：**

1. **CJK 行高必须比 iOS 宽。** iOS 的 1.29 是给拉丁文（有 ascender/descender 的呼吸空间）调的；方块汉字把 em 框填满，1.29 会挤成一堵墙。建议**组件类文字 1.5–1.6、长文 1.7–1.85**——后者正好是本仓 `--lh-prose: 1.85` 的现状，别为了「像 iOS」牺牲可读性。
2. **正文 17px 而不是 16px**:iOS body 是 17pt，本仓正文面已经是 17px，二者天然对齐；数据面 15px 对应 Subhead。
3. **字重只用 400 / 500 / 600 / 700**。系统栈在 Windows 上不一定有 650 这种中间值（现状 `style.css:125` 的 `font-weight: 650` 会被就近取整或合成），别依赖它。
4. **不要逐字号复刻 iOS 的 tracking**。SF 的 tracking 表是给 SF 写的；Segoe UI / PingFang 的最优字距不同。只在 ≥28px 的标题上加 `letter-spacing: -0.01em ~ -0.015em`（现状 `style.css:154` 已有 -0.015em，可保留），其余不动。
5. `font-optical-sizing: auto` 只有在**可变字体**上有效，而系统栈在多数平台上是静态字体或不可控——**不要指望它**，也不用写。

---

## 3. 语义色：标准值、对比度、可用取值

### 3.1 HIG 说什么

- **【事实】** 系统色是**按语义**定义的动态色（不是按外观），会随浅/深外观与「增强对比度」设置变化。iOS 有两套背景色：**system** 与 **grouped**，各有 primary / secondary / tertiary 三级；层级用法是「primary = 整个视图，secondary = 视图内分组，tertiary = 分组内再分组」。
  来源：[HIG Color](https://developer.apple.com/design/human-interface-guidelines/color)（JSON 版同上法可读）
- **【事实】** 前景色是 label / secondaryLabel / tertiaryLabel / quaternaryLabel / placeholderText / separator / fill 等，语义分别是「主内容 / 次内容 / 三级内容 / 四级内容 / 占位符 / 分隔线 / 填充」。
- **【事实·关键】** HIG 明确写：**"Avoid hard-coding system color values in your app. Documented color values are for your reference during the app design process. The actual color values may fluctuate from release to release, based on a variety of environmental variables."**
  → 翻译成工程语言：**HIG 不承诺任何数值**，照着「标准值」写死颜色，本质上是在抄一个会被 Apple 单方面改掉的参考值。
- **【事实】** 还明确禁止混用语义：「别把 `separator` 当文字色，别把 `secondaryLabel` 当背景色」。
- **【事实】** 「不能只靠颜色传达信息」，要配文字或形状（本仓的 `.dot` 四形状 + `.badge` 文案已经是这条的正面例子，见 `style.css:284-305`）。

**关于 systemBlue 的两个不同数值（容易踩）：**
- HIG 在线色彩资源里，iOS 的 *unified* 蓝是 **浅色 `#0088FF` / 深色 `#0091FF`**（来源：color 页的颜色资源 alt 文本 `R-0,G-136,B-255` / `R-0,G-145,B-255`）。
- 生态里通行的 UIKit `systemBlue` 是 **浅色 `#007AFF` / 深色 `#0A84FF`**。
- map #64 已定「浅 `#007AFF` / 深 `#0A84FF`」。**【取舍】** 建议维持 #64 的取值（更广为人知），但**必须**按下节压深才能当正文链接用。

### 3.2 Web 能做什么

- **【事实】** Web 没有「动态语义色」这层运行时。`light-dark()` 只能按 `color-scheme` 二选一，不会像 iOS 那样为「增强对比度」再给一套值。**WCAG AA 是硬底线，不是可选项**——所以不能原样抄 iOS 的透明度档位。
- **【事实】** iOS 的 label 三档是**带 alpha 的 rgba**（`rgba(60,60,67,0.6)` 之类），合成结果取决于底下是什么。Web 上如果也写 rgba，最终对比度会随背景漂移；而本仓 `scripts/style-check.mjs:163` 的对比度断言**只接受 `#hex`**（`!fg.startsWith('#')` 直接判失败）。→ **把 alpha 预合成成不透明 hex**，一举解决「可算」和「不漂移」两件事。

### 3.3 通行的 iOS 语义色取值 + 我手算的对比度

> **【参考值】** 下表数值不在 HIG 正文里（HIG 只给语义与 API 名）。它们来自 Apple 设计资源/UIKit 运行时在生态中的通行镜像。**拿它们当「起点」，不要当「规范」**。
> **【手算】** 比值按 WCAG 2.2 相对亮度公式算（`c<=0.03928 ? c/12.92 : ((c+0.055)/1.055)^2.4`，`L=0.2126R+0.7152G+0.0722B`）；**没有跑脚本**，请 #67 复核。
> 大字号门槛：WCAG 的「large text」= ≥18pt（24px）常规，或 ≥14pt（18.66px）**粗体**。

**浅色（surface = `#FFFFFF`；组背景 `#F2F2F7`）**

| token | iOS 名义值 | 合成后 hex | 对比度（白底 / 组背景） | 当正文能用吗 |
| --- | --- | --- | --- | --- |
| systemBackground | `#FFFFFF` | `#FFFFFF` | — | 背景 |
| secondarySystemBackground | `#F2F2F7` | `#F2F2F7` | — | 背景 |
| tertiarySystemBackground | `#FFFFFF` | `#FFFFFF` | — | 背景 |
| systemGroupedBackground | `#F2F2F7` | `#F2F2F7` | — | 背景 |
| secondarySystemGroupedBackground | `#FFFFFF` | `#FFFFFF` | — | 卡片 |
| tertiarySystemGroupedBackground | `#F2F2F7` | `#F2F2F7` | — | 卡片内凹 |
| label | `#000000` | `#000000` | 21.0 / 20.5 | ✅ |
| secondaryLabel | `rgba(60,60,67,.6)` | `#8A8A8E` | **3.44** / **3.08** | ❌ 只过大字号 |
| tertiaryLabel | `rgba(60,60,67,.3)` | `#C4C4C6` | **1.74** / 1.63 | ❌ |
| quaternaryLabel | `rgba(60,60,67,.18)` | `#DCDCDE` | ≈1.35 | ❌ 纯装饰 |
| placeholderText | 同 tertiary | `#C4C4C6` | 1.74 | ❌（见 §8.4） |
| separator | `rgba(60,60,67,.29)` | `#C6C6C8` | **1.71** | 装饰性 hairline |
| systemFill | `rgba(120,120,128,.2)` | `#E4E4E7` | 1.27（对白底） | 控件底 |
| systemBlue | `#007AFF` | `#007AFF` | **4.02** | ❌ 正文链接；大字号 ✅ |
| systemRed | `#FF3B30` | `#FF3B30` | **3.55** | ❌ 正文；大字号 ✅ |
| systemGreen | `#34C759` | `#34C759` | **2.22** | ❌ |
| systemOrange | `#FF9500` | `#FF9500` | **2.20** | ❌ |

**深色（surface = `#000000`；卡片 `#1C1C1E`；抬升面 `#2C2C2E`）**

| token | iOS 名义值 | 合成后 hex | 对比度（黑 / 卡片 / 抬升） | 当正文能用吗 |
| --- | --- | --- | --- | --- |
| systemBackground | `#000000` | `#000000` | — | 背景 |
| secondarySystemBackground | `#1C1C1E` | `#1C1C1E` | — | 背景 |
| tertiarySystemBackground | `#2C2C2E` | `#2C2C2E` | — | 背景 |
| label | `#FFFFFF` | `#FFFFFF` | 21.0 / 19.8 / 18.2 | ✅ |
| secondaryLabel | `rgba(235,235,245,.6)` | `#8D8D93` / `#98989F` / `#9F9FA5` | **6.36** / 5.90 / **5.30** | ✅（深色反而达标） |
| tertiaryLabel | `rgba(235,235,245,.3)` | `#464649` / `#5A5A5E` / `#65656A` | **2.60** / 2.48 / 2.41 | ❌ |
| separator | `rgba(84,84,88,.6)` | `#323235` / `#3E3E42` | ≈1.70 | 装饰性 hairline |
| systemFill | `rgba(120,120,128,.36)` | `#2B2B2E` | 1.35（对黑） | 控件底 |
| systemBlue（dark） | `#0A84FF` | `#0A84FF` | **5.76** / 4.67 / **3.82** | ❌ 抬升面上不行 |
| systemRed（dark） | `#FF453A` | `#FF453A` | 6.16 / 5.50 / **4.09** | ❌ 抬升面上不行 |
| systemGreen（dark） | `#30D158` | `#30D158` | 10.4 / 9.6 / **6.89** | ✅ |
| systemOrange（dark） | `#FF9F0A` | `#FF9F0A` | 10.2 / 9.4 / **6.78** | ✅ |

### 3.4 结论：iOS 的「标准色」过不了本仓的 AA 线

| 失效项 | 事实 | 影响 |
| --- | --- | --- |
| 浅色 secondaryLabel | 3.44:1（白底） | 现站大量「次要文字」（`.summary` / `.meta` / `.kv dt`）如果照搬，**全部掉到 AA 以下** |
| 浅色 tertiaryLabel / placeholder | 1.74:1 | 占位符与「更弱的字」必须换值，或只用于装饰 |
| 浅色 separator | 1.71:1 | 分隔线本来就不受 1.4.11 约束（不是控件边界），但**不能**拿它当输入框边框 |
| 浅色 systemBlue 链接 | 4.02:1 | 链接是正文文本，**必须 ≥4.5** |
| 浅色 systemRed / Green / Orange | 3.55 / 2.22 / 2.20 | 状态文字必须换深色档 |
| 深色 systemBlue 在 `#2C2C2E` 上 | 3.82:1 | 深色下链接落在卡片上会不达标 |
| 深色 systemRed 在 `#2C2C2E` 上 | 4.09:1 | 同上，差一点点 |
| 深色 tertiaryLabel | 2.41–2.60 | 同浅色：不能当正文 |

**这不是「HIG 错了」，而是两套标准的目标不同**：iOS 用透明度 + 加粗 + 系统级「增强对比度」开关来兜底；Web 上我们没有那层运行时，只能把颜色本身压到 AA。

### 3.5 我建议的 AA 可行值（每档都写清「对最差的那块底」的比值）

| 用途 | 浅色 | 对 `#FFFFFF` | 对 `#F2F2F7` | 深色 | 对 `#2C2C2E`（最差） |
| --- | --- | --- | --- | --- | --- |
| 主文字 | `#000000` | 21.0 | 20.5 | `#FFFFFF` | 18.2 |
| 次文字（正文可用） | `#6C6C70` | **5.23** | **4.69** | `#9F9FA5` | **5.30** |
| 三级文字（**仅 ≥24px 或粗体 ≥18.66px**） | `#8A8A8E` | 3.44 | 3.08 | `#8E8E93` | 4.28 |
| 禁用 / 装饰（不承诺 AA） | `#C4C4C6` | 1.74 | — | `#5A5A5E` | 2.48 |
| 链接 / 强调 | `#0062CC` | **5.80** | **5.20** | `#409CFF` | **4.92** |
| 状态 ok | `#1B7A2F` | **5.42** | **4.86** | `#30D158` | **6.89** |
| 状态 warn | `#A35A00` | **5.23** | **4.68** | `#FF9F0A` | **6.78** |
| 状态 bad | `#C1271B` | **5.88** | **5.26** | `#FF6961` | **4.94** |
| 装饰 hairline | `#C6C6C8` | 1.71 | — | `#38383A` | 1.80 |
| 控件边框（要过 1.4.11 的 3:1） | `#8A8A8E` | 3.44 | **3.08** | `#7C7C82` | **3.36** |

推导要点（便于复核）：
- `#6C6C70` 是「在 `#F2F2F7` 上仍 ≥4.5」的临界灰；再浅一点（`#757579`）就会掉到 ~4.2。
- `#8A8A8E` 恰好同时满足「白底 3.44」与「组背景 3.08」的 3:1，所以它一物两用：**大字号文字** 与 **控件边框**。
- `#0062CC` 是把 `#007AFF` 压深到「白底 5.80 / 组背景 5.20」的蓝色，色相仍在 212° 左右，不偏紫。
- 深色的 `#409CFF` 比 `#0A84FF` 亮一档，专门为了在 `#2C2C2E` 上也 ≥4.5（iOS 的 `#0A84FF` 在抬升面上只有 3.82）。
- 深色 `#FF6961` 同理：iOS `#FF453A` 在抬升面 4.09，压亮一点才 4.94。

**【取舍】filled 按钮的文字方向**：`#0062CC` 底 + 白字 = 5.80 ✅；但深色下 `#409CFF` 底 + 白字只有 2.83 ❌，必须**反成黑字**（7.42 ✅）。也就是说 `--on-accent` 在深色下要翻成深色字——这与本仓 `style.css:398-401` 现有的注释同一套逻辑（那里的 `--on-accent` 就是为对比度翻面的）。如果更想保留「深色蓝底白字」的 iOS 观感，另一条路是深色下把填充蓝压到 `#0057C2`（白字 ≈6.9）——**这两种都是 #66 的观感选择**，本文只把对比度账算清。

---

## 4. 材质：backdrop-filter / 半透明页头 / vibrancy

### 4.1 HIG 说什么

- **【事实】** Apple 平台有两类材质：**Liquid Glass**（iOS 26 起的控件/导航层）与 **standard materials**（内容层内的分层感）。
- **【事实】** iOS 有四种标准材质：**ultraThin / thin / regular（默认）/ thick**。`regular` 会「模糊并调整背景亮度」以维持可读性；材质**越厚（越不透明）**，对细小文字越友好；越薄越能透出上下文。
- **【事实】** 文字/图形在材质上要用 **vibrancy** 档位（label / secondaryLabel / tertiaryLabel / quaternaryLabel；fill / secondaryFill / tertiaryFill；separator 只有一档）。并明确：**quaternary 不要用在 thin / ultraThin 上，对比度太低**。
- **【事实】** clear 变体在亮背景上建议叠加 **35% 的 dimming 层**。
- **【事实】** 材质外观会随系统设置变化，包括 **Reduce Transparency** 与 **Increase Contrast**。
  来源：[HIG Materials](https://developer.apple.com/design/human-interface-guidelines/materials)

### 4.2 Web 能做什么

- **【事实】** `backdrop-filter: blur(Npx) saturate(x)` 可以模糊「元素背后」的像素；但它**只做光学效果**，不会像 vibrancy 那样**根据背景动态改文字颜色**。→ iOS 的「文字自动在亮玻璃上变深、暗玻璃上变浅」在 CSS 里**没有等价物**。
  来源：[MDN `backdrop-filter`](https://developer.mozilla.org/en-US/docs/Web/CSS/backdrop-filter)（Baseline 2024-09，即 Safari 18 才无前缀；更老的 Safari 需要 `-webkit-backdrop-filter`）
- **【事实·坑】** 这个属性会引入 **backdrop root**：任何祖先带 `filter`、`opacity < 1`、`mask`/`clip-path`、`mix-blend-mode`、`will-change`（这些属性）或自身带 `backdrop-filter`，都会**截断**模糊范围。→ 「页头模糊着模糊着就不糊了」多半是某个祖先加了 `opacity` 或 `transform` 之外的合成属性。
- **【事实】** 无 `backdrop-filter` 支持时，半透明背景就等于「和内容混在一起的纯色块」，可读性会崩。必须有 **`@supports not (backdrop-filter: blur(1px))` 的不透明兜底**。
- **【事实】** `prefers-reduced-transparency: reduce` 存在，但 MDN 标注为 **Limited availability / 实验性**（不是 Baseline）。→ 可以写，因为**不认识的媒体特性求值为假**，不会误触发；但**不能**把它当唯一兜底。
  来源：[MDN prefers-reduced-transparency](https://developer.mozilla.org/en-US/docs/Web/CSS/@media/prefers-reduced-transparency)
- **【事实·推论】** 性能：`backdrop-filter` 每次滚动都要重新采样背景，面积越大越贵。放在**固定/粘性页头**（高度 50–70px）是常见且可接受的做法；铺满全屏、或跟着长列表滚动的卡片上**不要用**。

### 4.3 本仓建议

**【取舍】** 分三档，按「背后内容是否可控」决定：

| 场景 | 做法 |
| --- | --- |
| 桌面端页头（背后是任意滚动内容） | **默认不透明**：`background: var(--bg)` + 一条 hairline。理由：这是唯一能保证 `nav` 文字在任意滚动位置都 ≥4.5 的形态。现状 `style.css:114-119` 的 88% + blur 是本仓既有观感，但**它没有对「最坏背景」做过对比度证明** |
| 移动端页头 / 需要「漂浮感」的短条 | 半透明 + blur，但底色 alpha **≥ 0.8**，并叠一层 theme 底：`color-mix(in oklab, var(--bg) 82%, transparent)`；同时保留 `@supports` 兜底 |
| 卡片 / 列表行 | **不用**材质。iOS 内容层的卡片本来就是实色（`secondarySystemGroupedBackground`），只有控件/导航层才上材质 |

近似配方（写在注释里即可，不要急着实现）：

```css
.site-header {
  background: var(--bg);                 /* 默认：不透明，AA 可证 */
  border-block-end: 1px solid var(--separator);
}
@supports (backdrop-filter: blur(1px)) {
  .site-header--material {
    background: color-mix(in oklab, var(--bg) 82%, transparent);
    -webkit-backdrop-filter: blur(20px) saturate(180%);
    backdrop-filter: blur(20px) saturate(180%);
  }
}
@media (prefers-reduced-transparency: reduce) {
  .site-header--material { background: var(--bg); backdrop-filter: none; }
}
```

- **不要**在 `body`/`main` 上写 `filter` 或 `opacity`（会成为 backdrop root，页头就不糊了）。
- **不要**尝试复刻 Liquid Glass 的折射/高光；`backdrop-filter` 做不到，做出来是「磨砂塑料」。
- 如果坚持半透明页头：**必须**在深度深浅两套、以及「白色文章页面滚到页头后面」这个最坏组合下各测一次 `nav` 文字对比度；这种情况静态脚本测不出来，只能靠浏览器。

---

## 5. 控件：哪些纯 CSS、哪些要 JS、哪些用 `<dialog>`

先给总表，再逐项。

| 控件 | HIG 要点 | Web 手段 | 纯 CSS？ | 本仓建议 |
| --- | --- | --- | --- | --- |
| 按钮 | 层级（filled / tinted / gray / plain）；按下有反馈；最小 44×44pt | `<button>` / `<a>` + `:hover/:active/:focus-visible` | ✅ | 纯 CSS；按下用 `transform: scale(.97)` + 底色变化 |
| 分段控件 | 2–5 个互斥选项，始终有一段选中 | `<fieldset>` + 原生 radio + `label` | ✅ | 纯 CSS（选中段变底色，不做滑块） |
| 开关 | 二值、即时生效 | `<input type="checkbox" role="switch">` + `label` | ✅ | 纯 CSS；`appearance: none`，轨道要有 3:1 边框 |
| inset grouped 列表 | 圆角分组卡 + 内缩分隔线 + 可点行 | `<ul>/<li>` + `border-radius` + `li + li` 内缩边框 | ✅ | 纯 CSS；行高 ≥44px |
| Sheet / Alert | 模态、拦截交互、Esc/点外部可关 | `<dialog>` + `showModal()` | ⚠️ 需要一个 `showModal()` 调用（或 `commandfor`） | 用 `<dialog>`；进场动画可省 |
| Tab bar | 3–5 个顶层目的地，常驻、图标 + 文字 | `<nav>` + 链接 + `position: sticky/fixed` | ✅（但**不建议**用） | 桌面端不用；移动端若要，另外开票 |
| Search field | 带放大镜、清除按钮、即时过滤 | `<search>` + `<input type="search">` + SSR `GET` 表单 | ✅（服务端过滤）/ 需 JS（即时） | 先做 SSR GET；即时过滤留作增强 |

### 5.1 按钮

- **【事实】** `<button>` 自带键盘/回车/Space、焦点、禁用语义；用 `<div>` 重造要自己补一堆 ARIA。
- **【取舍】** 三种层级够用：`filled`（主操作，`--accent` 底）、`tinted`（`color-mix` 的淡蓝底 + 蓝字）、`plain`（只有字）。圆角：普通按钮 **10px**（iOS 17pt 控件的观感），胶囊形 `999px` 留给标签/分段。
- **【取舍】** 焦点环必须是**独立可见**的：`:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px }`，别用 `outline: none` + 只改底色（1.4.11 要求焦点指示 3:1）。本仓现有 `outline: 2px solid var(--accent)`（`style.css:396`）思路正确，保留。
- 触摸目标：`min-height: 44px`（移动端）；桌面端可以 32–36px，但**点击区域**用 padding 补到 44（见 §8.1）。

### 5.2 分段控件（segmented control）

纯 CSS 方案（**无 JS**、键盘可用、屏幕阅读器读作一组 radio）：

```html
<fieldset class="segmented">
  <legend class="sr">范围</legend>
  <label><input type="radio" name="range" value="24h" checked><span>24 小时</span></label>
  <label><input type="radio" name="range" value="7d"><span>7 天</span></label>
  <label><input type="radio" name="range" value="30d"><span>30 天</span></label>
</fieldset>
```

```css
.segmented { display: flex; gap: 2px; padding: 2px; border-radius: 9px; background: var(--fill-strong); }
.segmented input { position: absolute; opacity: 0; }        /* 视觉隐藏但仍在焦点序列里 */
.segmented span { display: block; padding: 6px 12px; border-radius: 7px; }
.segmented input:checked + span { background: var(--bg-card); box-shadow: 0 1px 2px rgb(0 0 0 / .12); }
.segmented input:focus-visible + span { outline: 2px solid var(--accent); outline-offset: 1px; }
```

- **不要**用 `display: none` 藏 radio（会丢键盘可达性）；用 `opacity: 0` + 绝对定位，或用 `appearance: none` 直接画在 input 上。
- **【取舍】** 不做「滑块动画」：要在纯 CSS 里滑动，得靠 `:has()` + 每个 label 的 `--i`，复杂度换来的只是 150ms 的位移；**建议直接切换底色**，reduced-motion 也不用特殊处理。
- 数量 >5 时不要用分段控件（iOS 也不建议），改用 `<select>`。

### 5.3 开关（switch）

- **【事实】** `role="switch"` 可以加在原生 checkbox 上，屏幕阅读器会读「开关，开/关」；**不要**自己维护 `aria-checked`（原生 checkbox 已经给出状态，双写会不一致）。
- **【取舍】** 纯 CSS：`appearance: none` 画轨道，`::before` 画滑块。关键点是**关闭态轨道要在页面上看得见**：iOS 用内阴影+高光解决，Web 上最简单是给轨道 `border: 1px solid var(--border-strong)`（3:1）。这正是 `#8A8A8E` 那个值的第二个用途。
- 滑块过渡 `transform .2s`，在 `prefers-reduced-motion: reduce` 下关掉。
- 标签点击区域 ≥44px：把 input 包在 `<label>` 里，label 给 `min-height: 44px; display:flex; align-items:center`。

### 5.4 inset grouped 列表

- **【事实】** iOS 16+ 的 inset grouped 列表 = 页面底色（grouped）× 白色圆角卡片 × 行间内缩分隔线 × 右侧 chevron。Web 上完全是 CSS：

```css
.list { margin: 0; padding: 0; list-style: none; background: var(--bg-card);
        border-radius: 12px; overflow: hidden; }
.list li + li { border-block-start: 1px solid var(--separator); margin-inline-start: 16px; }
```

- `overflow: hidden` 是为了圆角裁切，但注意它**不会**创建 backdrop root（只有 `filter/opacity/mask/clip-path` 等会），所以和 §4 不冲突。
- 行内 chevron 用**内联 SVG**（16×16、`currentColor`、`stroke-width: 2`），不要用 `::after` 的 CSS 三角——三角在不同 DPR 下会毛边。
- **【取舍】** 列表行同时是链接时，整行 `<a>` 要 `display:block` 且 `min-height: 44px`；不要把链接只包在文字上（点击区域太小）。

### 5.5 Sheet / Alert：用原生 `<dialog>`

- **【事实】** `<dialog>` 自 2022-03 起 Baseline；`showModal()` 会让页面其余部分 **inert**（不可聚焦、不可点），`Esc` 关闭，焦点被限制在对话框内——这三件事正是 sheet/alert 最容易被手写做错的点。
  来源：[MDN `<dialog>`](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/dialog)
- **【事实】** `closedby` 属性（点外部关闭）与 `commandfor/command`（声明式开关）是**更新的**能力，MDN 明确标了「部分特性支持不一」。→ **不要依赖**；点 `::backdrop` 关闭要自己写一行 JS（`event.target === dialog` 时 `close()`）。
- **【事实】** `<form method="dialog">` 提交会关闭对话框并把按钮的 `value` 作为 `returnValue`，**零 JS** 就能做「确认/取消」。
- **【取舍】** 本仓的「破坏性操作确认」（后台删目标/删文章）建议统一走一个 `<dialog>` 组件；`alert`（纯告知、一个按钮）与 `sheet`（表单）用同一套 CSS，只换宽度/圆角/内边距。
- **不要**手写 `div` + `position: fixed` + 自己实现焦点陷阱——那是 30 行容易漏的 JS，`<dialog>` 已经内置。
- 进场动画（`@starting-style` + `transition-behavior: allow-discrete`）**可选**；本仓 `prefers-reduced-motion` 有底线，建议直接不做动画，省掉兼容问题。

### 5.6 Tab bar：能做，但**不建议**

- **【事实】** iOS tab bar 是「3–5 个顶层目的地 + 常驻 + 图标与文字」的移动端导航模型。
- **【取舍】** 见 §9：桌面优先的站，底部常驻条会浪费黄金区域、和浏览器底栏打架、且 12 条路由塞不进 5 个 tab。若要服务手机，另开票做「分组列表 → 详情」而不是 tab bar。

### 5.7 Search field

- **【事实】** HTML 有 `<search>` 元素（Baseline 2023）作为搜索区域的地标；`<input type="search">` 会带上平台原生的清除按钮与 `Esc` 清空行为。
- **【事实】** Safari 的 `::-webkit-search-cancel-button` 只能有限定制（`appearance: none` 后自己画），不同浏览器表现不一致——**不要**把「清除按钮长什么样」当成验收项。
- **【取舍】** 本仓的搜索应该是 **SSR GET 表单**（`<form role="search" action="/posts"><input name="q">`），这样：无 JS 可用、URL 可分享、刷新可复现——符合 map #64「保留 URL」。即时过滤（边打边筛）作为**增强**再上 JS，且必须有「无 JS 时按回车也能搜」的路径。

---

## 6. SF Symbols：授权与 Web 替代

### 6.1 HIG 说什么

- **【事实】** SF Symbols 是 7000+ 个符号的库，设计目标是和 SF 字体「无缝配合」（九种字重、三种 scale、自动与文字对齐、随 Dynamic Type 缩放、支持 RTL 与 20+ 种本地化字形）。HIG 的符号页是使用规范（语义、变体、与文字混排）。
  来源：[SF Symbols 页](https://developer.apple.com/sf-symbols/)、[HIG SF Symbols](https://developer.apple.com/design/human-interface-guidelines/sf-symbols)
- **【不确定】** 授权条款：SF Symbols 的分发是 App/DMG，许可协议在包内（点击同意）。本会话**没有读到逐字条款**。通行的理解是「仅限用于 Apple 平台 App」，因此**不应**把它们导出成 SVG 放到公开网站上。要精确结论必须读许可证原文——但结论不依赖它：成本上也不该用（见下）。

### 6.2 Web 能做什么 / 本仓建议

- **【取舍】** 用**内联 SVG**，不引图标字体、不引图标库运行时：
  - `viewBox="0 0 24 24"`、`fill="none"`、`stroke="currentColor"`、`stroke-width="1.75"`、`stroke-linecap="round"`、`stroke-linejoin="round"`。
  - 装饰性图标 `aria-hidden="true"`；独立表达的图标配 `aria-label`，或旁边补可见文字。
  - 需要的其实很少：`chevron-right`、`chevron-down`、`search`、`check`、`xmark`、`plus`、`arrow-up-right`（外链）、`arrow-clockwise`（刷新）、`exclamationmark.triangle`、`ellipsis`、`sun/moon/gear`（三态切换）。**十个出头**，手写比引库便宜。
- 可商用的库（如确实需要更多图标）：**Lucide（ISC）**、**Heroicons（MIT）**、**Phosphor（MIT）**、**Bootstrap Icons（MIT）**、**Material Symbols（Apache-2.0）**。用的时候只**按需内联**，不要整包引入。
- **【取舍】** 状态语义**继续用形状 + 文字**（`.dot` 的实心圆/方块/三角/空心圆 + `.badge` 文案）。这是本仓已经做对的事（`style.css:284-305`），iOS 化时**不要**把它简化成「红黄绿三个圆点」——那会同时违反 HIG「不要只靠颜色」和 WCAG 1.4.1。

---

## 7. 深浅双模：`light-dark()` / `color-scheme` / 无闪首屏

### 7.1 三个特性各自管什么（事实）

| 能力 | 管什么 | 支持 | 坑 |
| --- | --- | --- | --- |
| `prefers-color-scheme` | **只读**：操作系统/浏览器偏好 | 全绿 | 页面自己切主题时，这个媒体查询**不会**变；不能拿它当三态的开关 |
| `color-scheme` (CSS) | 让 UA 把**画布底色、滚动条、表单控件、系统色**按浅/深渲染 | Baseline（2022-01 起 widely available） | 它**只管 UA 那层**；页面自己的颜色仍要自己处理。`only light` 可关掉 Chrome 的 Auto Dark Theme |
| `light-dark()` | 在**计算值阶段**按 `color-scheme` 二选一（颜色或图片） | Baseline 2024-05（Chrome 123 / Safari 17.5 / Firefox 120 一档） | **没设 `color-scheme` 时永远取 light 那支**（静默失败，最难查） |

来源：[MDN `color-scheme`](https://developer.mozilla.org/en-US/docs/Web/CSS/color-scheme)、[MDN `light-dark()`](https://developer.mozilla.org/en-US/docs/Web/CSS/color_value/light-dark)、[CSS Color 5](https://www.w3.org/TR/css-color-5/#light-dark)

### 7.2 三态架构：一个 `:root`、零 `@media prefers-color-scheme`

**这是本文最重要的架构发现**（#67 可直接用）：

```css
:root { color-scheme: light dark; }              /* 跟随系统 = 两支持 */
:root[data-theme="light"] { color-scheme: light; }  /* 强制浅 */
:root[data-theme="dark"]  { color-scheme: dark; }   /* 强制深 */

:root {
  --bg:  light-dark(#ffffff, #000000);
  --fg:  light-dark(#000000, #ffffff);
  /* …每个语义 token 一条 light-dark() */
}
```

为什么这比「两个 `:root`」或「`@media` + `[data-theme]` 覆盖」好：

1. **色值只有一份**，浅深并排写在同一行，改一处不会忘另一处；三态切换只改 `color-scheme`，**不改任何 token**。
2. **恰好不违反现有断言**：`scripts/style-check.mjs:90` 断言「CSS 里没有 `@media … prefers-color-scheme` 块」——这套方案本来就不需要那个媒体查询，**那条断言可以原样保留**（它本来是为了钉住 #60「去掉深色」，现在语义变成「三态不走媒体查询」，仍然成立）。
3. `scripts/style-check.mjs:85` 的「`:root` 恰好一个」也**照样成立**（两个属性选择器块不算新的 `:root` 令牌表）。
4. UA 层（滚动条、表单控件、原生 `<dialog>` 的底色）会跟着三态一起变——这是纯 CSS 的 `@media` 覆盖做不到的。

**代价 / 要迁移的地方**（归 #67，本文只登记）：
- `style-check.mjs:163` 的对比度循环要求 token 是 `#hex`（`!fg.startsWith('#')` → 失败）。`light-dark(#a,#b)` 会让 19 对**全部判失败**。需要把解析改成「按 `light-dark(` 拆成深浅两值，两套各算一遍」。
- `style-check.mjs:110-114` 的「颜色只定义在 `:root` 与打印块」用正则 `--[\w-]+:\s*#[0-9a-fA-F]{3,8}\s*;` 数数——`light-dark()` 里的 hex 数不到，这条断言会**变得空转**（仍然通过但没在验证任何东西）。要么扩展正则，要么改写断言。
- 现状 `style.css:116` / `:328` / `:408` 用了 `color-mix(in srgb, …)`，与 `light-dark()` 组合是可行的（`color-mix` 可以在 `light-dark()` 外层，也可以反过来），但**断言要能解析**。

**【不确定】** `light-dark()` 在自定义属性里的解析时机：规范是「在**使用**该属性的元素上解析」。所以如果某个后代被单独设了 `color-scheme`，同一个 `--bg` 在它那里的取值可能不同。这既是能力（局部强制亮/暗）也是坑（打印时要在 `body` 上显式设 `color-scheme: light` 才稳）。本会话无法用浏览器验证，请实现时实测。

### 7.3 无闪首屏的最小脚本

**位置非常重要**：必须在 `<head>` 里、**在 `<link rel="stylesheet">` 之前**同步执行。放 `defer` 或 `DOMContentLoaded` 都会闪。

```html
<!-- 放在 <meta charset> 之后、<link rel="stylesheet"> 之前 -->
<script>
try {
  var t = localStorage.getItem('theme');
  if (t === 'light' || t === 'dark') {
    document.documentElement.dataset.theme = t;
    document.documentElement.style.colorScheme = t;   /* 覆盖 CSS 到达前的第一帧 */
  }
} catch (e) { /* 隐私模式下 localStorage 可能抛错：静默退回「跟随系统」 */ }
</script>
```

配套的 `<meta>`（CSS 到达前的 UA 画布色，避免「深色系统 + 白闪」）：

```html
<meta name="color-scheme" content="light dark">
```

要点：
- **`try/catch` 不是可选的**：Safari 无痕、部分企业策略下 `localStorage` 读取会抛异常，一个未捕获异常会打断后续 head 里的脚本。
- 脚本必须**内联**：外链会多一次请求，等于必然闪一下。本仓**没有 CSP**（`src/` 里搜不到 `Content-Security-Policy`），所以内联脚本可以直接用；若日后加 CSP，需要 nonce 或 hash。
- **本仓有两个 HTML 外壳**：`src/views.ts:168` 的 `layout()` 与 `src/views.ts:863` 的登录页（它不走 `layout()`）。**两处都要加**，否则登录页会闪。建议顺手抽一个 `head()` 片段函数，别复制两遍。
- SSR 不知道用户的 `localStorage`，所以服务端永远只能按「跟随系统」渲染；脚本在第一帧前纠正。**不要**为了这个去加 cookie（会动到会话/写路径的既有决定，且不在本图范围内）。

### 7.4 三态切换控件

| 形态 | 可访问性 | 成本 | 评价 |
| --- | --- | --- | --- |
| 原生 `<select>`（跟随系统 / 浅色 / 深色） | ✅ 原生、键盘、屏幕阅读器、无需 ARIA | 最低 | **推荐**：桌面优先，且「三态」本质就是三选一 |
| 分段控件（radio 组） | ✅ 但占三倍宽度，页头会挤 | 中 | 页头空间够时的可选项 |
| 单按钮循环切换 | ⚠️ 三态循环的「当前值」只能靠 `aria-label` 播报，容易困惑 | 低 | 不建议（三态不是二值） |

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

JS（一小段，不引框架）：

```js
const sel = document.querySelector('[data-theme-select]');
const KEY = 'theme';
const root = document.documentElement;

const apply = (v) => {
  if (v === 'light' || v === 'dark') {
    root.dataset.theme = v;
    root.style.colorScheme = v;
  } else {
    root.removeAttribute('data-theme');
    root.style.colorScheme = '';       /* 回到 CSS 的 light dark */
  }
};

sel.value = localStorage.getItem(KEY) ?? 'system';
sel.addEventListener('change', () => {
  const v = sel.value;
  try { v === 'system' ? localStorage.removeItem(KEY) : localStorage.setItem(KEY, v); } catch {}
  apply(v);
});
```

- **【取舍】**「跟随系统」时**不要**去监听 `matchMedia('(prefers-color-scheme: dark)')`：纯 CSS 方案下系统切换会自动生效，加监听反而多一条要维护的路径。只有当 UI 上要显示「跟随系统（当前：深）」这种文案时才需要读它。
- 页头空间：本仓页头已有 brand / nav / 登出表单（`views.ts:179-185`），再塞一个 `<select>` 在桌面宽度够；**≤560px 断点**下建议收进 `<details>` 或移到页脚，别把导航挤换行。

### 7.5 打印：强制浅色 + 黑白

现状 `@media print`（`style.css:608-635`）已经在 `body` 上覆盖 token 为纯黑白，方向正确。深色加入后要补两点：

```css
@media print {
  body {
    color-scheme: light;      /* ① 让 UA 层（滚动条/控件/系统色）也回到浅色 */
    --bg: #ffffff; --fg: #000000; /* ② 现状保留：print 用字面 hex，别依赖 light-dark() 的解析 */
    background: #fff; color: #000;
  }
}
```

- `print-color-adjust: exact`（现状 `style.css:634`）只对**有意要印出来的色块**用（状态格带），别全局开——那会连卡片底色一起印，费墨。
- 打印时不该出现半透明材质：已经 `display:none` 的页头无所谓；如果将来保留，加 `backdrop-filter: none; background: #fff`。

---

## 8. 可访问性底线

### 8.1 触摸/点击目标：44pt 与 24px 是两套线

- **【事实】** HIG：iOS **默认控件 44×44 pt，最小 28×28 pt**；并建议「有 bezel 的元素周围约 12pt 间距、无 bezel 约 24pt」。
  来源：[HIG Accessibility](https://developer.apple.com/design/human-interface-guidelines/accessibility)
- **【事实】** WCAG 2.2：**2.5.8 Target Size (Minimum) 是 AA，24×24 CSS px**；**2.5.5 Target Size (Enhanced) 是 AAA，44×44**。另有「间距」豁免（目标外接 24px 圆不与别的目标相交即可）。
  来源：[Understanding 2.5.8](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html)、[2.5.5](https://www.w3.org/WAI/WCAG22/Understanding/target-size-enhanced.html)
- **【取舍】** 本仓**桌面优先**：桌面鼠标目标 32–36px 高可接受（WCAG AA 只要 24），但**同一个控件在窄屏/触摸设备上必须到 44**。实现方式不要用两套 class，用 `min-height: 44px` + `@media (pointer: fine) { min-height: 32px }`（或反过来：默认 44，桌面收紧）。
- 页头导航现在 `padding: 5px 0`（`style.css:136`）——文字行高大约 24px，**低于 44**。若 #66 保留顶栏导航，需要给 `a` 补垂直 padding 或 `min-height`。

### 8.2 Dynamic Type 的 Web 对应物

- **【事实】** HIG 要求「至少支持放大到 200%」；WCAG 1.4.4 Resize Text 同样是 200%，且 1.4.10 Reflow 要求 320 CSS px 宽不出现二维滚动。
  来源：[HIG Accessibility](https://developer.apple.com/design/human-interface-guidelines/accessibility)、[1.4.4](https://www.w3.org/WAI/WCAG22/Understanding/resize-text.html)、[1.4.10](https://www.w3.org/WAI/WCAG22/Understanding/reflow.html)
- **【取舍】** 三条实操：
  1. `html { font-size: 100% }`，**所有字号用 `rem`**；把 `body { font-size: 16px }`（`style.css:64`）改成 `1rem`，否则浏览器「默认字号」设置被切断。
  2. **不要**在 `<meta viewport>` 里加 `maximum-scale=1, user-scalable=no`（现状 `views.ts:172` 没有，保持）。
  3. 200% 下布局必须能重排：现有 720 / 560 两个断点（`style.css:576` / `:591`）能承接，但**验收时要在 200% 缩放下真看一眼**——这不是脚本能证明的。

### 8.3 reduced-motion

- **【事实】** HIG 的「Reduce Motion」是系统级辅助功能；Web 对应物是 `prefers-reduced-motion: reduce`。
- **【取舍】** 不要用「全局 `* { animation: none !important }`」这种锤子——它会把加载指示器也停掉，用户反而看不出在加载。按用途关：
  - 装饰性位移/缩放/脉冲 → 关（现状 `style.css:341` 对 `.live-dot` 的 `animation: none` 是正确写法，保留）。
  - 状态变化的过渡（开关滑块、颜色） → 保留颜色过渡、去掉位移；
  - `<dialog>` 进场 → 不做动画最省事；
  - `scroll-behavior: smooth` → reduce 下改 `auto`。
- **【事实】** 另有 `prefers-reduced-transparency`（见 §4），支持面有限，只能当增强。

### 8.4 对比度与「增强对比度」

- **【事实】** WCAG 1.4.3：正文 4.5:1；大字号 3:1（≥24px 常规 / ≥18.66px 粗体）。1.4.11：UI 组件与状态指示 3:1。HIG 给的数值表与 WCAG 基本一致（≤17pt → 4.5:1；18pt → 3:1；粗体 → 3:1）。
  来源：[1.4.3](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html)、[1.4.11](https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast.html)
- **【事实】** **禁用态**控件不受 1.4.3 约束；但**占位符**（enabled 输入框里的灰字）**不受豁免**——iOS 的 placeholderText 只有 1.74:1，照搬到 Web 就是不合规。**【取舍】** 占位符改用「次文字色」（`#6C6C70` / `#9F9FA5`），或干脆用可见 label 代替占位符。
- **【事实】** `prefers-contrast: more` 对应 iOS 的 Increase Contrast（`more` / `less` / `custom` / `no-preference`）。**【取舍】** 可作为增强：给 `--separator`、`--border-strong` 各压深一档，不做第二套完整主题（成本高、验证难）。
- **【取舍】** 焦点环必须 ≥3:1 且**不被 `overflow: hidden` 裁掉**：`outline-offset` 用正值时，父级 `overflow:hidden` 会剪掉外圈——列表行、卡片里要改用 `box-shadow: 0 0 0 2px` 或把 outline 画在内侧。

### 8.5 本仓现状里与 iOS 化无关、但必须保住的三条

1. **状态不只靠颜色**：`.dot` 四形状 + `.badge` 文字（`style.css:284-305`）。
2. **跳过导航**：目前**没有** skip link（`views.ts:179` 之后直接是 `<header>`）。这不是 iOS 化引入的问题，但重做页头是顺手补上的最好时机。
3. **`aria-current="page"`** 是当前项的唯一判据（`views.ts:119`、`:154`、`:289`），导航改版时不要换成「靠 class 高亮」。

---

## 9. 哪些 HIG 的东西**不该**照搬到 Web

逐条给「为什么」和「替代」。

| 不建议 | 理由 | 替代 |
| --- | --- | --- |
| **iOS 手势**（左滑删除、右滑返回、下拉刷新、长按菜单） | 桌面没有等价手势；HIG 自己也要求「给手势提供替代路径」；隐藏手势对键盘/读屏用户等于不存在 | 显式按钮 + `<dialog>` 确认；返回用链接 |
| **底部 tab bar** | 移动端导航模型；桌面浪费纵向黄金区、与浏览器底栏冲突；12 条路由塞不进 5 个 tab | 顶栏 / 侧栏 + 分组列表→详情（#66 定） |
| **动态岛 / 安全区适配** | 桌面优先；`env(safe-area-inset-*)` 只对刘海机有意义，且本仓不做 iPhone 专项（map 明确 out of scope） | 需要时在移动端加 `padding-bottom: env(safe-area-inset-bottom)` 一行即可 |
| **大标题随滚动折叠** | 依赖滚动位置 + 移动端地址栏高度变化，容易跳、容易和 `position: sticky` 打架 | 静态标题（`Title 1/2`），滚动时只保留粘性小页头 |
| **Liquid Glass** | `backdrop-filter` 做不出折射/镜面高光/内容自适应；追这个会得到「磨砂塑料」 | 不透明表面 + hairline + 圆角；最多一层模糊材质 |
| **真 vibrancy**（文字随背景变色） | CSS 没有等价物；半透明上的文字对比度无法自证 | 不透明底 + 固定语义色 |
| **SF Symbols 原样导出** | 授权边界（§6）；且符号与 SF 字重绑定，Segoe UI 下会显得细 | 内联 SVG + `currentColor` |
| **SF 字体 webfont** | 授权 + 体积 + FOUT；系统栈更好 | `system-ui` 栈 |
| **haptics / 3D Touch / 力反馈** | Web 没有（`navigator.vibrate` 在 iOS Safari 不可用） | 视觉反馈（`scale(.97)` + 底色） |
| **iOS 的 44pt 间距照搬到桌面** | 桌面鼠标精度高，44 的密度会让管理台表格/列表变成一屏三条 | 桌面 32–36，触摸 44（`@media (pointer: coarse)`） |
| **「无按钮」的纯手势列表行** | 删除/编辑靠滑动，键盘用户无法操作 | 每行显式操作按钮或 `<details>` 展开 |

---

## 10. 对下游票的输入（不是决定，只是把问题变成必答题）

### 给 #66（方向原型）

原型必须能在真页面片段上回答：
1. 导航模型：顶栏 / 侧栏 / 分组列表→详情，公开面与管理台是否同一套。
2. 密度：iOS 的疏朗（行高 44+、卡片间距 16）与「一眼看出什么坏了」的仪表盘密度如何折中；建议原型里**至少一屏**用真实格带 + 曲线，不要用占位方块。
3. 材质：页头到底透不透明（这会直接决定 §4 的对比度验证成本）。
4. 深色下的「filled 按钮」是黑字蓝底还是深蓝底白字（§3.5 的取舍）。

### 给 #67（token 架构与断言迁移）

- 建议的 token 组织：**一个 `:root` + `light-dark()` + 三个 `color-scheme` 状态**（§7.2），这样「一个 `:root`」与「无 `prefers-color-scheme` 块」两条断言都能保留。
- 必须迁移的三处断言（行号对应当前工作树）：`scripts/style-check.mjs:163`（hex-only）、`:110-114`（hex 计数会空转）、以及 19 对 PAIRS 要变成「浅 19 对 + 深 19 对」。
- 新的断言建议（供参考）：无闪脚本存在于**两个** HTML 外壳；三态属性选择器存在；`color-scheme` 在 `:root` 上；打印块含 `color-scheme: light`。

### 给 #68（组件映射）

§5 的总表就是输入：哪些纯 CSS、哪些需要一行 `showModal()`、哪些明确不做（tab bar）。另外两个本仓特有的点：
- 面板的 `.cell-strip` / `.dot` / `.badge` 是**跨文件契约**（`status.js` 的 `STATE_CLASS`），样式可以换皮，**类名不要动**。
- 文章编辑器的 `.ProseMirror` 目前只继承 token（`style.css:488-506`）。深色下粘贴进来的内容若带**行内颜色**，可能出现深底深字。**【不确定】** TipTap 的 schema 是否丢弃 inline color——本会话没有核实（`src/editor/` 里搜不到 `color`/`style`/`sanitize`），留给 #68 实测。

---

## 11. 可直接抄进 CSS 的 token 草案（**待对比度校验**）

> ⚠ **这些值是按 §3.5 手算出来的，没有跑过 `npm run check:style`。** 落地前必须让脚本按浅/深各跑一遍 19 对，并以脚本结果为准。
> 约定：`light-dark(浅, 深)`；所有值都是**不透明 hex**（为了能被现有对比度函数解析）。

```css
:root {
  color-scheme: light dark;

  /* ── 表面（iOS 的 system / grouped 两套，取我们真正用到的三档）────────── */
  --bg:            light-dark(#ffffff, #000000); /* systemBackground */
  --bg-grouped:    light-dark(#f2f2f7, #000000); /* systemGroupedBackground：页面底 */
  --bg-card:       light-dark(#ffffff, #1c1c1e); /* secondarySystemGroupedBackground：卡片 */
  --bg-elevated:   light-dark(#f2f2f7, #2c2c2e); /* 卡片内凹 / sheet */
  --fill:          light-dark(#e4e4e7, #2b2b2e); /* systemFill：输入框、控件底 */
  --fill-strong:   light-dark(#d1d1d6, #3a3a3c); /* 分段控件轨道、开关关态 */

  /* ── 文字（AA 已压过；括号内是「对最差底的比值」）───────────────────── */
  --label-1:       light-dark(#000000, #ffffff); /* 21.0 / 18.2 */
  --label-2:       light-dark(#6c6c70, #9f9fa5); /* 5.23 / 4.69 · 5.30 */
  --label-3:       light-dark(#8a8a8e, #8e8e93); /* 3.44 / 3.08 · 4.28 —— 仅 ≥24px 或粗体 ≥18.66px */
  --label-disabled:light-dark(#c4c4c6, #5a5a5e); /* 1.74 / 2.48 —— 不承诺 AA，只用于禁用态 */

  /* ── 线（hairline 是装饰；控件边框必须过 1.4.11 的 3:1）─────────────── */
  --separator:      light-dark(#c6c6c8, #38383a); /* 1.71 / 1.80 —— 装饰 */
  --border-strong:  light-dark(#8a8a8e, #7c7c82); /* 3.08 / 3.36 —— 输入框、开关轨道边框 */

  /* ── 强调与状态 ─────────────────────────────────────────────────── */
  --accent:         light-dark(#0062cc, #409cff); /* 5.80 / 5.20 · 4.92 */
  --on-accent:      light-dark(#ffffff, #000000); /* 深色下必须翻成深字（§3.5） */
  --ok:             light-dark(#1b7a2f, #30d158); /* 5.42 / 4.86 · 6.89 */
  --warn:           light-dark(#a35a00, #ff9f0a); /* 5.23 / 4.68 · 6.78 */
  --bad:            light-dark(#c1271b, #ff6961); /* 5.88 / 5.26 · 4.94 */

  /* ── 形状 / 排版（非颜色，供参考；数值来自 iOS 观感，不是 HIG 硬性规定）── */
  --radius-control: 10px;
  --radius-card:    12px;
  --radius-sheet:   16px;
  --tap:            44px;  /* 触摸目标；桌面可降到 32–36 */
}

/* 强制三态：只改 color-scheme，不碰任何 token */
:root[data-theme="light"] { color-scheme: light; }
:root[data-theme="dark"]  { color-scheme: dark; }

/* 打印：回到纸面（保留现状「改在 body 上、不在 :root 上」的纪律） */
@media print {
  body {
    color-scheme: light;
    --bg: #ffffff; --bg-grouped: #ffffff; --bg-card: #ffffff; --bg-elevated: #ffffff;
    --fill: #ffffff; --fill-strong: #ffffff;
    --label-1: #000000; --label-2: #222222; --label-3: #333333;
    --separator: #bbbbbb; --border-strong: #999999;
    --accent: #000000; --on-accent: #ffffff;
    --ok: #1f4d1f; --warn: #4d3a00; --bad: #6b1410;
  }
}
```

**仍需校验/补的：**
- 深色 `--label-3` 对 `--bg-elevated` 是 4.28（>3 但 <4.5）——只能用于大字号，脚本要能表达「大字号 3:1」这条规则，否则要么改值要么登记豁免（现有 `ALLOWED` 表就是干这个的，`style-check.mjs:157`）。
- `--on-accent` 在深色下翻成黑字是**观感取舍**，需要 #66 点头；不接受的话，把深色 `--accent` 压到 `#0057c2` 并保留白字。
- 半透明页头若保留，它上面文字的对比度**不在**这 19 对里（因为底是变的），需要单独一条「最坏背景」的人眼验收。

---

## 12. 我没能确认 / 没实测的（不要当结论）

1. **没有任何真机/浏览器实测**：所有渲染结论（字体回退长什么样、`backdrop-filter` 在目标机器上的帧率、`light-dark()` 的实际解析）都是基于文档的推断。
2. **SF 字体与 SF Symbols 的授权原文**：分别在各 DMG 的许可协议里，本会话没有逐字读到。结论（不要分发）是稳妥推断，不是引用。
3. **iOS 语义色的数值**：不在 HIG 正文里；本文的「标准值」是生态通行镜像（UIKit 运行时/设计资源），Apple 明确说会随版本浮动。
4. **手算的对比度**：公式与因子都写了，但**没有脚本复核**；`scripts/style-check.mjs` 的算法（`:68-78`）与本文一致，落地时以它为准。
5. **`font: -apple-system-body`** 在今天的 Safari 是否仍生效、是否受用户 Dynamic Type 档位影响：没实测，且它是 WebKit 私有行为。
6. **`light-dark()` 在自定义属性里的元素级解析**：规范如此，但没有浏览器验证；打印与局部强制浅色时要留意。
7. **Safari 无前缀 `backdrop-filter` 的起始版本**：MDN Baseline 写的是 2024-09，我据此推断 Safari 18 起无前缀、更老需 `-webkit-`；具体版本号请以 MDN BCD 表为准。
8. **TipTap 是否会保留粘贴内容里的行内颜色**：没核实（`src/editor/` 搜不到相关关键字），深色下的编辑器内容可读性需要 #68 实测。
9. **`prefers-contrast` 的支持面**：仅从 MDN 文档记忆，未逐页核对 BCD。
10. **票面说 `style.css` 628 行，当前工作树是 635 行**（read 工具读到 `total 635 lines`）。差异不影响结论，但引用行号时以当前工作树为准。

---

## 13. 来源清单

**Apple 一手**

- Human Interface Guidelines：Typography — <https://developer.apple.com/design/human-interface-guidelines/typography>
  （客户端渲染；正文可读同源 JSON：<https://developer.apple.com/tutorials/data/design/human-interface-guidelines/typography.json>）
- HIG：Color — <https://developer.apple.com/design/human-interface-guidelines/color>
  （JSON：<https://developer.apple.com/tutorials/data/design/human-interface-guidelines/color.json>）
- HIG：Materials — <https://developer.apple.com/design/human-interface-guidelines/materials>
  （JSON：<https://developer.apple.com/tutorials/data/design/human-interface-guidelines/materials.json>）
- HIG：Layout — <https://developer.apple.com/design/human-interface-guidelines/layout>
- HIG：Accessibility — <https://developer.apple.com/design/human-interface-guidelines/accessibility>
- HIG：SF Symbols — <https://developer.apple.com/design/human-interface-guidelines/sf-symbols>
- Fonts for Apple platforms — <https://developer.apple.com/fonts/>
- SF Symbols — <https://developer.apple.com/sf-symbols/>
- WebKit：Using the System Font in Web Content（`-apple-system`、Dynamic Type 的 `font:` 值）— <https://webkit.org/blog/3709/using-the-system-font-in-web-content/>

**Web 平台 / 规范**

- MDN `color-scheme` — <https://developer.mozilla.org/en-US/docs/Web/CSS/color-scheme>
- MDN `light-dark()` — <https://developer.mozilla.org/en-US/docs/Web/CSS/color_value/light-dark>
- MDN `backdrop-filter`（含 backdrop root）— <https://developer.mozilla.org/en-US/docs/Web/CSS/backdrop-filter>
- MDN `prefers-reduced-transparency` — <https://developer.mozilla.org/en-US/docs/Web/CSS/@media/prefers-reduced-transparency>
- MDN `<dialog>` — <https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/dialog>
- MDN `font-family` — <https://developer.mozilla.org/en-US/docs/Web/CSS/font-family>
- CSS Fonts 4（`system-ui` 通用族）— <https://www.w3.org/TR/css-fonts-4/#generic-font-families>
- CSS Color 5（`light-dark()`）— <https://www.w3.org/TR/css-color-5/#light-dark>
- CSS Color Adjust 1（`color-scheme`）— <https://drafts.csswg.org/css-color-adjust-1/>
- Media Queries 5（`prefers-reduced-transparency`）— <https://drafts.csswg.org/mediaqueries-5/#prefers-reduced-transparency>

**WCAG 2.2**

- 1.4.3 Contrast (Minimum) — <https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html>
- 1.4.4 Resize Text — <https://www.w3.org/WAI/WCAG22/Understanding/resize-text.html>
- 1.4.10 Reflow — <https://www.w3.org/WAI/WCAG22/Understanding/reflow.html>
- 1.4.11 Non-text Contrast — <https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast.html>
- 2.5.5 Target Size (Enhanced) — <https://www.w3.org/WAI/WCAG22/Understanding/target-size-enhanced.html>
- 2.5.8 Target Size (Minimum) — <https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html>

**本仓（行号对应当前工作树）**

- `public/style.css:18-54`（唯一 `:root`、13 色 + 11 排版 token）、`:107-110`（`.sr`）、`:114-119`（页头：88% + `backdrop-filter: blur(8px)`）、`:136`（导航 `padding: 5px 0`）、`:284-305`（形状 + 文字双冗余的状态点/徽标）、`:341`（reduced-motion 关脉冲）、`:396-401`（焦点环与 `--on-accent` 的翻面注释）、`:576` / `:591`（720 / 560 断点）、`:608-635`（打印块）
- `src/views.ts:160-194`（`layout()` 外壳）、`:169` / `:863`（`<html lang="zh-CN">`，两处 head）、`:179-185`（页头 brand / nav / 登出表单）、`:119` / `:154` / `:289`（`aria-current`）
- `scripts/style-check.mjs:84-90`（一个 `:root`、无 `prefers-color-scheme`）、`:110-114`（颜色只住两处）、`:130-176`（19 对对比度、hex-only）、`:157`（`ALLOWED` 豁免表）
- `docs/theme-decision.md`（#60 的「浅色单套」，本图将推翻；本文只引用其纪律：一个 `:root`、对比度是算出来的）
