# Claude 风格化接手审查与验收

日期：2026-10-23。仓库：`Lkyloveaw/lkyloveaw-home`，本地基点 `c53611e`，分支 `master`。

## 结论

此前实现沿着已批准的 **B · 紧凑工作台** 正确推进。以 #84 的选择及 #85–#87 的落地决定为准，当前外壳、字体、主题、文章侧栏、管理入口和账户路由与这些决定一致。本次补齐共享用户菜单的交互缺口，并完成页面、权限与打印验收；没有发现尚未处理的严重或重要实现问题。

这不等于 GitHub 远端已同步：检查时本地 `master` 比 `origin/master` 超前 **23 个提交**；#79、#92 虽已关闭，其对应本地实现尚未全部推送。issue 状态不能代替远端代码与发布状态。本次没有推送、部署或修改 GitHub issue。

## 采用的规格

| 依据 | 要求与审查结论 |
| --- | --- |
| [#82](https://github.com/Lkyloveaw/lkyloveaw-home/issues/82)、[#84](https://github.com/Lkyloveaw/lkyloveaw-home/issues/84) | 采用 B 紧凑工作台；复用批准方案，不重新设计。 |
| [#85](https://github.com/Lkyloveaw/lkyloveaw-home/issues/85)、[主题决定](claude-theme-decision.md) | 17 色、单一 `:root`、暖纸色浅深主题；accent 限非文字用途；系统衬线标题与无衬线正文；正文 17px / 1.8 / 68ch 居中。静态断言与页面检查通过。 |
| [#86](https://github.com/Lkyloveaw/lkyloveaw-home/issues/86)、[外壳决定](public-shell-decision.md) | 顶栏 56px、公开侧栏 224px、栏距 28px、公开外壳 1360px；管理台 1140px。四项公开导航，公开六类页面均有全量已发布文章侧栏。账户与错误页无侧栏，登录独立；移动抽屉，无底部 tab bar。 |
| [#87](https://github.com/Lkyloveaw/lkyloveaw-home/issues/87)、[菜单决定](user-menu-decision.md) | CSS hover/focus 与少量 JS；不引入 ARIA menu 或 focus trap；改密入口 `/account`；管理员独有后台入口；主题三态与登出保留。下述缺口修复后通过。 |
| [#79](https://github.com/Lkyloveaw/lkyloveaw-home/issues/79) | 编辑工具栏 6 组、22 个按钮；窄屏不挤出页面，编辑能力保留。 |
| [#88 实现拆分](claude-shell-implementation-split.md) | 沿用 SSR 和共享组件；裸机 + systemd 部署，以 [部署环境](deploy-environment.md) 为真源。未恢复 Docker 制品。 |

#85–#87 是后续明确决定，覆盖 #76–#80 中冲突的旧正文宽度及改密地址。因此保留 `68ch` 和 `/account`，不按旧票回退至 900px 正文或 `/account/password`。此前仍开放的独立功能票不能因换装验收完成而一并认定完成。

## 本次修复

| 问题 | 修改及验证 |
| --- | --- |
| CSS focus/hover 已显示菜单，`aria-expanded` 却可能仍为 false；Escape 无法可靠关闭纯 hover 打开的面板 | `src/views.ts` 的实际菜单脚本统一计算可见状态，补齐 focus、hover、Escape、再次打开与离开处理。行为用例先失败，修复后通过；真实浏览器核对焦点与展开状态。 |
| 胶囊与面板间隙中断 hover；可触摸输入不应依赖粘滞 hover | `public/style.css` 在支持 hover 的媒体条件中设置根元素透明桥接区；避免桥接区被面板滚动裁切。事件断言和 DOM 命中检查覆盖，纯鼠标路径未用拖拽动作冒充验证。 |
| 短窗口中菜单末尾可能不可达，长用户名可能挤出控件 | 面板限制视口高度并滚动，用户名胶囊截断、面板身份文字可换行；核对 390×260、390×844 与桌面长用户名。 |
| 已打开移动抽屉后，Tab 或 hover 打开用户菜单没有触发互斥 | 独立代码复核发现后，在真实浏览器复现；将关闭抽屉放入共享展开状态同步。新增 focus/hover 两例先失败，修复后 10/10；Tab 复测为抽屉关闭、用户菜单展开。 |
| 胶囊与汉堡边框未采用规定的强边框 token | 两个入口统一使用 `--border-strong`，静态断言覆盖。 |

新增 `scripts/user-menu-check.mjs` 直接执行实际内联脚本，接入 `verify`。主题断言只限制主题脚本中的 `matchMedia`，允许菜单为检测 hover 能力使用它；仍禁止主题脚本监听系统主题或写 cookie。

README 修正过期改密入口、自检说明；两个部署打包命令排除 `.env` 和 `.env.local`，避免覆盖部署环境配置。保留接手前的 19 个未提交改动，没有将混合工作区整体提交。

## 验收证据

- 最终产品修改后 `npm run check:all` 退出码 0，包括 e2e **551/551**、菜单行为 **10/10**、样式 **181/181**、编辑器 **43/43**；完整日志 `.codex-claude-check-all.log`。`git diff --check` 无错误。
- 65 份实际视口截图记录在 `.dsh-progress/claude-review-shots/manifest.json`，全部无文档级横向溢出。桌面 1440×900、移动 390×844 覆盖浅深主题：首页、分享、标签、文章、可用性、关于、管理概览、账户、登录、403、404；补查管理其余模块和编辑器。
- 1024 / 720 宽度补查文章、可用性、管理页；状态卡列数分别验证为桌面 3、1024 时 2、720 时 1。另测长用户名与 260px 高度菜单。
- 已发布文章侧栏完整，草稿不可见；只读菜单不含后台入口，直访后台为 403；匿名账户请求跳登录。编辑器仍为 6 组、22 按钮。
- 键盘 Tab、Escape、焦点返回、点外关闭、抽屉互斥和三态主题均实测；菜单 hover 事件另有行为断言。没有用静态字符串检查替代页面检查。
- 用户授权后使用本机 Edge 无头打印：实际 SSR 去除脚本、内联实际 CSS，以 A4 输出文章 1 页、可用性 2 页。三页均通过 Poppler 渲染目检与文本完整性检查：灰阶、框架隐藏、表格完整、卡片无裁切。文件在 `output/pdf/claude-article-print.pdf` 和 `output/pdf/claude-status-print.pdf`。

截图使用实际视口截图；工具的 full-page 截图曾出现与 DOM 测量不符的重排，已全部替换为视口截图并重看联系表。屏幕验收基于浏览器视口，不代表实体手机、所有操作系统字体或物理打印机验收；生产环境未参与本次测试。原有可用率曲线的范围标签会显示较长小数，本次未调整其数值格式；验收中没有溢出或裁切。

## 重现方式

先 `npm run build`，再 `node scripts/claude-preview.mjs`，默认打开 `http://127.0.0.1:4387`。脚本同时使用下一端口模拟三种探测状态；可用 `CLAUDE_PREVIEW_PORT` 改端口。本次保留的预览为 `http://127.0.0.1:4391`。

合成账户 `preview-admin`、`preview-reader`、`preview-user-with-a-very-long-display-name`，统一密码 `preview-only-pass-123`。脚本为每次运行创建独立 `.dsh-progress/claude-preview-*` 数据库、内容、媒体和备份目录，显式覆盖源地址、密钥与目标配置；不使用真实 `data/`。Ctrl+C 停止。

预览运行时，在另一个 PowerShell 终端执行（使用相同端口）：

```powershell
$env:CLAUDE_PREVIEW_PORT = '4387'
node scripts/claude-print-check.mjs
```

打印脚本仅连接本机合成预览，需本机安装 Edge。输出路径固定，重复运行会更新两份验收 PDF。截图与完整运行日志为本地验收资料，位于忽略目录，不作为生产数据提交。
