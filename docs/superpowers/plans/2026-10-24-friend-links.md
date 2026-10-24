# 导航徽标与友联 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 放大导航徽标，实现后台统一管理、公开内容页共享的图文友联。

**Architecture:** 复用 SSR 共用布局；`friend-links.ts` 负责 SQLite 条目与校验，视图只消费记录，路由复用管理员与 CSRF 守卫。图标复用现有媒体上传及显式清理。

**Tech Stack:** TypeScript、Fastify、better-sqlite3、CSS；无新增依赖。

**Spec:** `docs/superpowers/specs/2026-10-24-friend-links-design.md`

## Global Constraints

- 徽标桌面 40px、手机 32px；网站名称字号保持现状。
- 名称 1–60 字、简介 0–200 字、网址最长 2048 字符，仅 HTTP/HTTPS。
- 六类公开内容页共享；初始为空隐藏，外链新标签页打开。
- 图标上传本站，缺省用首字；有效图标不能被孤图清理误删。
- 裸机 + systemd；沿用现有权限和上传规则。

## Review Focus

- 重启或重新打开数据库后，数据和顺序保留。
- 非法 URL、畸形 id/排序值和未知动作被拒绝，失败保留文本输入。
- 只读账号、缺 CSRF 或来源错误不能修改友联。
- 图标上传失败不破坏已有引用，更换与清除后的旧图交由显式清理。
- 文章/标签动态页也展示相同内容，后台、账户、错误页不展示；手机无横向溢出。

### Task 1: 友联存储

**Files:** 新增 `src/friend-links.ts`、`scripts/friend-links-check.mjs`。
**Interfaces:** `FriendLink`（id/name/url/description/icon/sortOrder）；`listFriendLinks()`、`saveFriendLink(input, id?)`、`deleteFriendLink(id)`、`setFriendLinkIcon(id, name)`、`friendLinkImageReferences()`。

- [x] 写并运行临时库行为断言，确认缺少功能时失败。
- [x] 建表、验证输入、增删改排序、媒体引用；默认空列表、按 sortOrder/id 排序。
- [x] 运行 `npm run build` 和 `node scripts/friend-links-check.mjs`，确认存储断言通过。

### Task 2: 后台管理与共用展示

**Files:** 修改 `src/server.ts`、`src/views.ts`、`src/cli/media.ts`、`public/style.css`；扩展 `scripts/friend-links-check.mjs`。
**Interfaces:** Task 1 的存储 API；站点信息携带 `friendLinks`；`/admin/settings/friends` 表单动作 save/delete，`/admin/settings/friends/:id/icon` 上传/清除。

- [x] 写真实 Fastify 请求断言，覆盖 CRUD、失败回填、权限、CSRF、来源、上传与六类页面一致性；先观察失败。
- [x] 设置页新增独立表单，数字排序；共享 layout 仅在 sidebar 非空时插入友联。
- [x] 接通图标上传和孤图引用；徽标 40/32px，图文卡片响应式，外链含 noopener/noreferrer。
- [x] 执行专用断言，通过后将 `check:friends` 加入 `npm run verify`。

### Task 3: 验收与文档

**Files:** 更新 `CONTEXT.md` 与本计划进度。

- [x] 跑 `npm run verify` 和 `npm run check:e2e`；检查实际宽屏/手机、浅深色与无 JS 页面。
- [x] 独立评审实现，处理实质问题，按需求逐项核验；记录测试结果与限制。
- [x] 提交本次功能及设计/计划文档，保留用户原有 `output/` 文件。

## Execution ledger

- Ruling: 用户已明确授权按设计实施，直接执行，无需重复确认实施方式。
- Ruling: 在当前目录创建 `codex/friend-links` 分支，保持讨论中设计稿和本地依赖可用，不另建工作树。
- Wayfinder: 设计已明确且无未决问题，按技能的 no-fog 分支直接执行，无需建立决策地图。

## Verification evidence (2026-10-24)

- Task 1: complete. Storage check observed ERR_MODULE_NOT_FOUND before implementation, then passed with CRUD, sorting, validation, icon references and persistence read from a second Node process.
- Task 2: complete. HTTP check observed 404 before routing, then passed for all six public content page types, exclusion pages, authentication, CSRF, origin, escaping, image upload/replacement/clear, limits and orphan cleanup.
- Final review: independent reviewer found two P2 issues. Missing-record form refill reproduced with a failing assertion, then passed after preserving inputs in the new-link form. Desktop container shrinkage reproduced in browser (364px at 971px viewport), then fixed with explicit width and verified with actual card row positions.
- npm run verify: exit 0. Full repository verification, including check:friends, passed. Tests needing network were run outside the network-restricted sandbox; the earlier EACCES and preview-port collision were environmental, not accepted as passing results.
- npm run check:e2e: exit 0, 584/584 passed.
- Browser: desktop 1920px and 2560px use 40px mark; mobile 390px and 320px use 32px mark. No document horizontal overflow. Cards share a row on desktop and stack on mobile; light/dark themes and mobile admin forms inspected. Keyboard Tab moves between friend links.
- No-JavaScript basics: cards and admin forms arrive in server-rendered HTML; the HTTP checks submit ordinary forms without executing client scripts.
- Local screenshots: .dsh-progress/friend-links-shots/desktop-light.png, mobile-light.png, mobile-dark.png. Preview records are stored only in a temporary preview database, not in real site data.
- Existing output/ remains untouched. No dependency or deployment changes.