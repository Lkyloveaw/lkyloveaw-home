# 系统可用性第一轮 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 使系统可用性面板如实反映最近探测、历史故障与缺测。
**Architecture:** 在既有 SQLite 查询、SSR 视图、白名单 API 和原生刷新脚本内修复；用真实临时数据库及 DOM 回归验证。无新增依赖。
**Tech Stack:** TypeScript / Fastify / SQLite / SSR / SVG。
**Spec:** `docs/superpowers/specs/2026-10-24-status-reliability-design.md`

## Global Constraints
- 保留三档探测状态；数据新鲜度为独立属性。
- 最近 24 小时统计、最近 56 次格带、3 个间隔加超时的过期阈值。
- 不更改部署或鉴权；保留 output/；此次在已有功能分支原位完成。

## Review Focus
- 超过 120 次探测后的末尾故障必须可见，短故障不能被平均掉。
- 长缺测、跨窗口事件、停用再启用及恢复不能产生虚假的连续时长。
- 刷新失败和会话过期时，保留数据但明确其旧状态。
- 当前目标增删或重命名时，页面不得展示互相矛盾的汇总和旧卡片。
- 公开 API 新字段仍必须经过白名单，所有错误文本保持脱敏。

### Task 1: 统计与历史
Files: src/store.ts, src/server.ts, scripts/status-reliability-check.mjs.
Interfaces: getStats 增加缺测阈值与统一 now；getLatencyRaw/getUptimeRaw 在完整窗口做有界采样；getIncidentEvents 返回有起止和恢复状态的事件。
- [x] 先写并运行末尾故障、缺测时长、事件合并及跨窗口回归，确认红灯。
- [x] 修正查询及聚合，运行新回归至绿。

### Task 2: SSR 与刷新
Files: src/views.ts, src/public-summary.ts, src/charts.ts, public/status.js, public/style.css, scripts/panel-check.mjs, scripts/leak-check.mjs, scripts/e2e-check.mjs.
Interfaces: API 增加 lastCheckedAt/upStreakMs/staleAfterMs 和事件起止字段；视图使用一致 freshness 判据。
- [x] 添加刷新汇总、事件、时间、过期及恢复行为断言。
- [x] 补全刷新、过期状态、事件显示及数字口径；目标清单变化提示用户重载。
- [x] 运行统计、图表、面板及泄漏断言；更新对应公开契约文档。

### Task 3: 验证与交付
- [x] 运行 npm run verify 和 npm run check:e2e，检查真实浏览器桌面和手机。
- [x] 独立审查本轮 diff，修复有实质影响的问题并回归。
- [x] 更新 CONTEXT.md 与此计划，提供结果和验证记录；不部署。

## Execution ledger
- Ruling: 用户已明确要求实施第一轮，沿用其授权执行，不再次请求计划批准。已有功能分支保留上轮实现，无需另建 checkout。
- Final review: 首个审查模型遇额度限制，替换审查员完成独立只读审查。发现同桶第二次短故障可能被降采样删掉；回归已观察到红灯，改为保留每段异常边界。
- Ruling: 为避免频繁抖动被隐藏，点数上限适用于普通分桶包络，异常边界额外保留；优先保证故障真实性。
- Verification: 首批真实数据库回归从 0/10 到 10/10；同桶重复故障专项回归先失败再修复，最终状态检查 15/15、面板检查 68/68。
- Verification: `npm run verify` 完整通过；`npm run check:e2e` 582/582 通过；`git diff --check` 无空白错误。泄漏测试增加真实本地 503 服务，避免依赖已被合并或过滤的历史样本。
- Browser: 使用独立临时数据库检查 1440px 桌面与 390px 手机视口。四种状态、自动刷新和异常事件展示正常，无横向溢出，浏览器无 error/warn。截图保存在 `.dsh-progress/status-shots/`；测试数据不进入真实站点。
- Delivery: 本轮改动保留在当前 `codex/friend-links` 分支的工作区，未合并、推送或部署。
- Follow-up (2026-10-24): 用户明确要求合并到 `master` 并部署至服务器；按 `docs/deploy-environment.md` 执行提交、合并后验证、服务器预构建、备份切换和上线检查。
