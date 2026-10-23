# Identity Images Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 在个人设置提供头像，在管理台站点设置提供导航栏网站徽标。

**Architecture:** 用身份图片引用表记录用户头像和站点徽标，文件复用现有媒体存储；沿用认证和 CSRF 守卫，扩展媒体清理引用集。

**Tech Stack:** TypeScript / Fastify / SQLite / HTML 原生表单。

**Spec:** `docs/superpowers/specs/2026-10-23-identity-images-design.md`

## Global Constraints

- 继续在当前已有未提交批准功能的工作分支实现；不重置、推送或部署。
- 登录保护不变，只有管理员可更改徽标；用户只可更新自己的头像。
- 复用媒体格式与 8 MiB 限制，无新增依赖或用户页面解释性附注。

## Review Focus

- 上传超限在解析阶段失败时须返回正确页面。
- 伪造用户 ID 不得改变其他账号头像。
- 媒体清理不可删掉仍被头像或徽标引用的图片。
- 恢复默认及失败上传不得改变会话或其他设置。
- 正方形/横向图片和长用户名在窄屏不撑破布局。

### Task 1: 存储、页面、上传与回归

- [x] 补充真实 HTTP / 存储 / 清理引用测试，确认旧代码不具备头像上传入口。
- [x] 新增 `src/identity-images.ts`；连接 `csrf.ts`、`server.ts`、`views.ts`、`public/style.css` 与 `cli/media.ts`。
- [x] 执行针对性检查与 `npm run check:all`，检查用户隔离、权限、失败与持久化。
- [x] 浏览器验收头像、徽标与默认恢复，完成独立审阅并更新领域文档。

## 验证记录

- RED：旧头像接口返回 404，新接口的缺 CSRF 用例预期 403；按预期失败。
- 最终 `npm run check:all` 退出 0，14 组共 1470 项，包括媒体 44 项、HTTP 584 项。日志 `.dsh-progress/identity-final-check-all.log`。
- 额外验证当前用户更换头像引用时，另一个用户的引用保持原样。
- 浏览器实测只读账号上传真实 PNG，胶囊、菜单、账户区三张图片均解码成功；恢复默认成功。390px 时页面宽度 375px，无横向溢出。
- 浏览器核对管理员网站徽标入口与预览在桌面和窄屏的布局；徽标上传、拒绝及恢复默认由真实 HTTP 回归验证。
- 独立审阅：Critical 0 / Important 0 / Minor 1。Minor 为徽标失败提示样式，已以 RED → GREEN 修正，并加入 HTTP 回归；未进行第二轮审阅。
- 截图 `.dsh-progress/identity-shots/`；保留本地修改，未提交、推送或部署。
