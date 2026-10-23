# Remaining Issues Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. Track the steps below and record evidence in `docs/remaining-issues-closeout.md`.

**Goal:** 处理当前所有开放 issue（#1、#30、#76、#77、#78、#80、#81），补齐仍有效的需求并准确同步验收状态。

**Architecture:** 现有 Fastify SSR / SQLite / CSS 架构不变；共享导航数据源统一命名，共享管理 rail 调整密度。已有批准的 issue 与 #85–#87 决定提供规格，不提出新的产品方向。

**Tech Stack:** TypeScript、原生 CSS、Node 断言、真实浏览器、gh CLI。

**Spec:** #76–#81；`docs/claude-theme-decision.md`、`docs/public-shell-decision.md`、`docs/user-menu-decision.md`；#1 与 #30 的 Destination 和已关闭子票。

## Global Constraints

- 当前开放票快照 `.dsh-progress/remaining-issues.json`：7 张；最终重新向 GitHub 查询，不能只凭快照关票。
- #85–#87 后续批准决定优先：68ch 正文、1140px 管理外壳、用户菜单 → `/account`、移动原生抽屉；不恢复旧 900/860 栏宽、旧路由或底部 tab bar。
- #80 的非冲突要求继续实现：rail 最小高度 34px、上下 padding 4px、组内 gap 0、组间 gap 20px，子项缩进 38px；移动点击目标 44px 保留。
- #78 仅改命名：模块顺序、分组、路由、概览四卡及 H1 保持。
- 裸机 + systemd 是唯一部署方式；不恢复 Docker 检查或制品。
- 保留接手前及上一轮的未提交改动。不能为收口掺入新功能、重写历史论证或无依据认定生产环境已更新。

## Review Focus

1. 桌面 rail 与移动模块条的名称均为「站点设置」，顺序及当前项不变。
2. 34px 密度必须在实际行高和 padding 下成立，长文字允许自然增高，移动点击目标仍为 44px。
3. #77 账户路径用后续规格验收：三口令字段不回填、CSRF、失败 400、成功 PRG、仅其他设备失效。
4. #1 / #30 的总图收口必须有当前回归和代码能力依据；迷雾中的未批准功能不擅自当成新需求实现。
5. GitHub 记录明确区分已实现、被后续决定覆盖、当前本地验证及未推送/未部署状态。

## Task 1: 补齐 #78 与 #80 的有效代码要求

**Files:** `src/views.ts`、`public/style.css`、`scripts/e2e-check.mjs`、`scripts/style-check.mjs`。

**Interfaces:** `ADMIN_GROUPS` 同时供 `adminRail()` / `adminTabs()` 使用；rail CSS 只影响管理台桌面导航。

- [x] 修改既有 e2e 精确模块名称断言为「站点设置」，加移动模块条同名同序断言；为 rail 的 34/4/0/20 和子项缩进增加静态断言，先观察失败。
- [x] 导航源改一个文案；rail `min-height:34px; padding:4px 10px`、group gap 0。
- [x] `npm run check:style` / `npm run build` / `npm run check:e2e` 通过；浏览器核对 1440 / 1024 / 720 / 390 的管理页、当前项和点击目标。

## Task 2: 文档与验收收口

**Files:** `CONTEXT.md`、`README.md`、`docs/ui-consistency-decision.md`、`docs/remaining-issues-closeout.md`，历史决定文件顶部仅加修订指针。

**Interfaces:** 消费 Task 1 最终契约，沿用 #85–#87 优先级。

- [x] 统一当前领域文档的管理模块名；历史决定登记新名称、账户入口、后续主题/外壳决定的优先级。
- [x] 按 #1、#30、#76、#77、#78、#80、#81 逐条记录验收证据和被替代要求；保留真实设备/生产部署未验证边界。
- [x] `npm run check:all` 全绿，并单独重跑 `npm run build` 核对编辑器产物；`git diff --check` 通过。
- [x] 保存本轮浏览器截图；打印规则未改时复用上一轮已授权 Edge 打印证据，若有影响打印的修改则重打验证。
- [x] 独立最终代码复核，处理重要缺陷；不依赖仅由 CLOSED 推断的完成状态。

## Task 3: GitHub 状态与最终交付

**Files:** 上述报告；GitHub 现有七张票。

**Interfaces:** 仅在 Task 1/2 验收完成后写入准确状态。

- [x] 明确本地实现与远端发布的差异；依据实际授权同步现有 issue 的处理结果，不把未实现项标完成。
- [x] 重新读取 GitHub 总图/子票状态，检查无遗漏；提供报告、验证结果及所有仍需用户决定的事项。

## Progress

- 2026-10-23：已读回 7 张开放票及 #1 / #30 原生子票状态（分别 18 / 15 张，全部 closed）；确认侧栏密度未被 #85–#87 覆盖，栏宽与账户入口已被后续决定替代。原始状态保存在本地快照。
- 最终 check:all exit 0（13 组 1410 项），单独 build / editor 43 通过，7 份最终截图尺寸与当前项验证通过。独立复核与最后一次 GitHub 只读核对均遇账户用量上限；审批动作未执行，未写回或关票。下一步先恢复独立复核，再核对远端、写回七票结论并读回状态。
- 随后工作区出现本轮以外的目标清理/模块命名/图表修改，详见收口报告末节；原样保留。此前回归不能证明这些新增修改通过，恢复后须先整合并复测当前完整工作区，再进入关票阶段。

- 最终：额度恢复后完成整合、独立复核与一轮修复；check:all exit 0，14组1438项，50个源文件哈希不变。8份最终截图与2份共3页PDF验收通过。七票回填关闭并逐票读回，开放issue为0；未推送/部署，保留codex/remaining-issues及混合工作区。
