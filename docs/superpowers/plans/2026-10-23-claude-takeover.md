# Claude 风格化接手与完整验收计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 依据已经批准的 B「紧凑工作台」完成整站 Claude 风格化的实现复核、缺口修复与真实页面验收。

**Architecture:** 沿用 Fastify SSR、同一套主题 token 和现有公开 / 管理 / plain 三种外壳。已有 #84–#87 设计与 #88 实现计划是设计依据；不重新选择方向。修复共享组件的根因，保留管理台能力、鉴权、数据模型、现有 URL 与内容 IA。

**Tech Stack:** TypeScript、Fastify、SQLite、原生 CSS / DOM、现有 Node 验收脚本；浏览器验证通过 CUA，无新增依赖。

**Spec:** `docs/claude-theme-decision.md`、`docs/public-shell-decision.md`、`docs/user-menu-decision.md`、`docs/claude-shell-implementation-split.md`；GitHub #82、#84–#92。

## Global Constraints

- 17 个颜色 token、一个 `:root`，颜色只在 token 表与打印块定义；accent 只作非文字；文字 ≥4.5:1、非文字 ≥3:1。
- B 外壳 56 / 224 / 28 / 1360px；正文 17px / 1.8 / 68ch 居中；管理台保留 1140px 外壳。#85–#87 的后续决定覆盖 #76–#80 中冲突的旧方案。
- 标题系统衬线、正文/UI 系统无衬线，无外部字体；保留 system/light/dark。
- 公开六页常驻全量已发布文章侧栏；管理台保留 rail 与移动模块条；账户/403/404 无侧栏；登录独立。
- 四项公开导航来自同一数据源；移动端 ≤720 汉堡抽屉，无 tab bar；仅 720/560 布局断点。
- 用户菜单支持桌面 hover / keyboard / click、手机点按、无 JS 降级；不引 ARIA menu / focus trap。
- 打印灰阶、框架隐藏、正文与宽表不裁切；减少动画偏好生效。
- 仅裸机 + systemd 部署；不恢复 Docker 制品。保留接手前的 19 个未提交改动，不推送、不部署、不改 GitHub issue。

## Review Focus

1. 鼠标从胶囊跨过面板间距时仍可进入菜单；不能只测试点击打开。
2. Escape、点外、Tab 离开与再次打开一致；键盘展开状态不能与可见状态相反。
3. 手机/短窗口/长用户名不能把登出项或页面宽度挤出视口；两个浮层不同时覆盖操作区。
4. 管理员、只读、匿名分别验证入口；草稿不进入公开文章侧栏。
5. 真实文章、宽表、面板三列和打印均需渲染证据，字符串检查不能替代视觉验收。

---

### Task 1: 当前实现与既有规格逐项核对

**Files:** `src/views.ts`、`src/server.ts`、`src/csrf.ts`、`src/auth.ts`、`src/session.ts`、`src/sessions-store.ts`、`public/style.css`、现有验收脚本。

**Interfaces:** 消费已批准的三份规格；产出差异清单、临时数据预览和页面矩阵。

- [x] 读取 GitHub #82/#84/#87/#91 与本地设计，确认 B 已批准，68ch 与 `/account` 是后续真源。
- [x] 保存当前 git 状态；已知基线 `npm run check:all` exit 0，e2e 551/551。
- [x] 新增可重复的本地预览入口 `scripts/claude-preview.mjs`：独立临时 SQLite、媒体/备份目录、合成账号与本地探测目标，绝不使用真实 data/。
- [x] 通过浏览器复现菜单疑点；检查公开六页、管理六页、账户、登录、403/404 的外壳、当前项、权限和横向溢出。

### Task 2: 修复与规格不符的共享组件

**Files:** 仅按实证修改 `src/views.ts` / `public/style.css`；行为回归放 `scripts/user-menu-check.mjs`，接入现有 verify。

**Interfaces:** 保留 `userMenu()` 与 `userMenuScript()` 调用和 HTML 数据属性；继续复用原生 details 抽屉。

- [x] 为复现到的菜单事件缺陷先添加最小可运行行为断言，运行并确认当前实现失败。
- [x] 用 CSS 连通胶囊与面板的 hover 命中区域，hover 限定可 hover 的输入；为面板添加视口高度限制与滚动。
- [x] 按复现结果修复展开状态/关闭/浮层互斥，保留无 JS hover/focus 降级和无 focus trap。
- [x] 运行新增行为断言、`check:style`、`check:e2e`，再通过浏览器逐项复测。
- [x] 若发现其他规格缺口，记录根因与依据，加入本任务修复与相应验收；不以现有测试已绿为完成依据。

### Task 3: 整站验证与接手文档

**Files:** `docs/claude-takeover-review.md`、`README.md`，本地截图在忽略的 `.dsh-progress/` 中。

**Interfaces:** 产出按要求逐项对照的完成证据、运行方式与剩余限制。

- [x] 1440×900 / 390×844 浅深：首页、分享、标签、文章、可用性、关于、管理概览、账户、403、404、登录；管理各模块与编辑器补查。
- [x] 1024 与 720 断点补查；短窗口菜单滚动、宽表、抽屉、键盘交互、主题切换、只读与匿名补查。
- [x] 检查打印规则与文章/可用性打印渲染；如当前工具不支持打印，明确登记未验证并继续寻找可用验证途径。
- [x] 修正 README 的过期改密入口与自检说明；部署文档已证实的 `.env` 覆盖风险做最小修复，保留用户此前 systemd 改动。
- [x] `npm run check:all` exit 0、`git diff --check` 无错误；检查最终 diff，逐要求填写证据与限制。
- [x] 提供可打开的预览、截图与接手报告；不把 issue CLOSED 或旧截图当成本次验收证据。
