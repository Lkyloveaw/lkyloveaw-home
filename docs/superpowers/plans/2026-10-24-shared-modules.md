# 四项共享模块 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 使上传、转义、状态规则和图表计算各有一份可被真实调用者复用的实现。
**Architecture:** 原生共享 ES module + TypeScript 声明；上传适配器集中读取和错误分类，权限及业务引用保留在路由。
**Tech Stack:** TypeScript、原生 JS module、Fastify、SQLite、现有 esbuild 测试工具。
**Spec:** docs/superpowers/specs/2026-10-24-shared-modules-design.md

## Global Constraints
- 四项都要完成；不加入标签重构或新依赖。
- 公开数据白名单、三档状态及独立 freshness 保持；无 JS 的 SSR 仍可读。
- 缺测断线与只扩不缩值域保持；上传后友联存在性检查保持。
- 在当前 checkout 的 codex/shared-modules 分支执行，output/ 保留。

## Review Focus
- Node 与浏览器确实导入同一源码；不能用测试通过掩盖两份算法仍在。
- module 脚本顺序、资源白名单和 MIME 允许真实浏览器正常加载。
- 存储失败、过大、格式错误不可混淆；引用写入不得绕过权限。
- 零目标、无样本、过期边界、时钟校正、持续事件变未知与 SSR/刷新保持一致。
- 图表分段、空态恢复、首屏值域及已有域扩张不能改变。

### Task 1: HTML 与上传接口
Files: public/html.js, public/html.d.ts, src/upload-image.ts, src/media.ts, src/server.ts, src/views.ts, src/charts.ts, src/article-html.ts, scripts/shared-modules-check.mjs, package.json.
Interfaces: escapeHtml(input): string; readFormField(body,name): string | undefined; receiveImageUpload(body): Promise<UploadResult>; MediaInputError.kind.
- [x] 写上传写盘失败和错误分型回归；运行并记录旧实现失败。
- [x] 提取 HTML 与上传实现，接入全部四种上传路径；统一 multipart 字段读取及守卫接线。
- [x] 运行共享回归、媒体、友联、文章检查并提交本项。

### Task 2: 共享图表几何
Files: public/chart-path.js, public/chart-path.d.ts, src/charts.ts, scripts/chart-check.mjs, scripts/panel-check.mjs, scripts/lib/browser-module.mjs.
Interfaces: linePath, areaPath, hash, expandDomain, clampY 原有参数及返回约定。
- [x] 保留固定几何和断点预期，改 Node 测试为真实模块导入。
- [x] 去掉 charts.ts 中对应算法，调用唯一共享实现。
- [x] 浏览器测试用现有 esbuild 在内存中加载 module；运行几何/面板回归。

### Task 3: 共享状态展示
Files: public/status-model.js, public/status-model.d.ts, public/status.js, src/views.ts, src/auth.ts, scripts/shared-modules-check.mjs, scripts/style-check.mjs, scripts/e2e-check.mjs.
Interfaces: visibleState/summarizeStatus、状态标签和样式、时间与可用率格式、事件状态与明细。
- [x] 添加过期边界、无样本、平均口径、持续事件缺测、首屏与刷新行为回归。
- [x] 首页、状态页及客户端删除对应重复实现，导入纯模块。
- [x] 更新 module 资源接线、静态白名单及现有测试；运行相关检查。

### Task 4: 验证和交付
- [x] 更新 CONTEXT.md 与 ADR，解释共享模块和不变的 SSR 约束。
- [x] npm run check:all 全绿；真实浏览器核对 module 加载、布局和自动刷新。
- [x] 按 executing-plans 要求进行一次新上下文独立审查，修复实质问题并回归。
- [x] 检查四项唯一实现和所有调用者已迁移；记录证据，完成本地交付。

## Execution ledger
- Ruling: 用户明确授权落实前一轮四项具体建议，直接执行，避免重复方案确认。
- Ruling: 使用现有 checkout 新分支；本轮工作区源码干净，原有 output/ 不纳入改动。
- Baseline: master 9087127；本轮前评审刚完成的 chart 43、status 15、panel 68 共 126 项通过；上传故障差异已在四个真实注入请求中复现。
- Task 1: HTML 统一到 public/html.js；上传回归 18/19 RED → 19/19 GREEN；媒体、友联、文章流水线检查通过。
- Task 2: 共享几何 Node 导入回归 1/5 RED → 5/5 GREEN；原有几何 43、状态可靠性 15、面板 68 全绿。为使本项独立可用，module 入口、html.js 白名单与 e2e 资源接线随 Task 2 一并迁移。
- Task 3: 状态模块接口回归 5/11 RED → 11/11 GREEN；首页、SSR 与真实刷新对照已替换旧双表源码比较，面板 72/72、样式 187/187 通过。

- Final review: 独立审查确认四项已真实复用，发现旧 classic HTTP 缓存的升级问题。三个 HTTP 回归先红 19/22；入口与依赖均加迁移 URL，最终响应统一 no-cache。
- Ruling: 时间显示继续沿用环境本地时区（与基线一致）；本轮重构不改变时区产品策略，不同地区刷新后的时间文字仍可能不同。
- Ruling: 首次完整验证只在 e2e 探测间隔前提失败（最新间隔 6212ms）；改为读取两轮新的安静样本，保留原 2000–5500ms 范围及后续间隔增长断言，避免同步口令校验的测试负载污染基线。

## Final verification
- `npm run check:all` 最终通过，完整日志 `.dsh-progress/shared-final-check-all.log`；e2e 584/584。
- 新上传与缓存 HTTP 回归 22/22，共享呈现接口 11/11；原有图表 43、状态可靠性 15、面板 72、样式 187 均通过。
- 最终浏览器在 localhost:43964/43965 的隔离临时数据上检查。真实预热 master 旧 classic 入口和几何缓存，再切到新页面；四个带迁移参数的模块均实际请求成功，自动刷新已运行 10 次，无 warning/error。手机 375px 内容宽度等于视口宽度；桌面与手机截图在 `.dsh-progress/shared-shots/`。
- 独立审查（gpt-6-astra）确认四项实际共用、无 Critical/Minor；唯一 Important 为缓存升级，已由三个 HTTP 回归 RED→GREEN 和真实浏览器预热升级验证修复。跨时区文字继续保留基线的本地显示策略；未创建新时区产品约定。
- 完成审计：src/server.ts 不再直接读取图片 Buffer 或调用 saveMedia；views/article-html/charts/status 共用 public/html.js；首页/SSR/刷新共用 status-model；SSR 和浏览器共用 chart-path.js，算法仅一份。公开状态投影未改。
- 本轮交付保留在 codex/shared-modules，本地提交；原有 output/ 保留。
