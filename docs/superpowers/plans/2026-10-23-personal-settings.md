# Personal Settings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 `/account` 升级为个人设置，从用户胶囊菜单进入。

**Architecture:** 复用 `accountPage()`、`themePicker()` 与已有的多控件同步脚本；不新增路由、数据表或依赖。改密接口及权限保护保持不变。

**Tech Stack:** TypeScript、Fastify SSR、原生 HTML/CSS/JavaScript。

**Spec:** `docs/superpowers/specs/2026-10-23-personal-settings-design.md`

## Global Constraints

- 页面只展示设置项、必要的状态和提交反馈，不添加功能介绍、维护指南或实现说明。
- 主题仍只保存在当前浏览器；所有登录角色均可使用个人设置。
- 保留 `/account` 和 `POST /password`；不修改已批准的其他工作区改动。

## Review Focus

- 两个主题选择器不能互相覆盖或显示不同状态。
- 存储不可用时切换仍在当前页生效。
- 只读账号仍可进入设置，但不能看到管理后台。
- 口令失败回显不得丢失设置界面或泄露口令。
- 长用户名和窄屏下，设置行仍能换行而不溢出。

### Task 1: 个人设置页面、菜单与回归

**Files:** `src/views.ts`、`public/style.css`、`scripts/e2e-check.mjs`、`scripts/style-check.mjs`、`scripts/user-menu-check.mjs`；更新 `CONTEXT.md` 及现有菜单/账户决定的当前契约。

**Interfaces:** `accountPage(opts, site): string`、`themePicker(): string`、`themeScript(): string` 保持签名；无新服务端接口。

- [x] 在现有 HTTP 检查中验证菜单入口、账户信息、设置区域和两处主题控件；先确认旧页面不满足这些要求。
- [x] 修改账户页和菜单；新增最少的设置行样式，窄屏可换行；更新过时的主题控件数量检查。
- [x] 执行实际主题脚本验证初始化、双向同步、恢复系统、跨页记忆及存储失败降级。
- [x] 运行 `npm run check:all`，要求所有检查通过；复核桌面、窄屏与深色显示。
- [x] 更新领域文档当前入口，完成独立审阅并记录结果；保留本地改动供用户验收。

## 验证结果

`npm run check:all` 退出码 0，共 1442 项通过，其中 HTTP 端到端 565 项，菜单/主题行为 12 项，样式 187 项。日志：`.dsh-progress/personal-settings-check-all.log`。

真实浏览器验收：1440px 桌面、390px 窄屏、长用户名、深色、恢复系统后刷新；窄屏无横向溢出，主题在两个控件间同步。截图：`.dsh-progress/personal-settings-shots/`。

独立审阅：Critical 0 / Important 0 / Minor 0。无 JavaScript 降级依据 HTML/CSS 及原生改密 HTTP 回归核查，未在浏览器中禁用 JavaScript。

## Execution rulings

- 复用当前 `codex/remaining-issues` 工作分支：此功能依赖本轮已经批准且尚未提交的胶囊菜单和公开文案修改，新工作树不会包含它们。
- 用户已批准设计并要求执行，直接在本会话完成，不再询问执行方式；不自行推送或部署。
