# 四项共享模块重构设计

用户要求落实上一轮的四项建议：上传流程、HTML 转义、状态展示规则、图表几何计算。沿用已批准的评审范围，完整处理四项；不扩展到标签解码或新的页面设计。

## 方案与取舍

选用原生 ES module：在 public/ 保存三份无 DOM 的共享 JS（html.js、status-model.js、chart-path.js），由 Node 和浏览器直接导入，配套 .d.ts 给服务端类型检查。status.js 作为 module 加载，新增纯计算资源逐一加入匿名白名单。继续 SSR，无 JS 时仍可读，不增加依赖或只读页面打包步骤。

不采用两份源码加交叉断言，因为它不能消除重复规则；不采用增加全站打包流水线，因为现有浏览器支持原生 module。现有 esbuild 仅用于测试中把模块加载进隔离的 DOM 环境，不新增运行时产物。

## 接口与不变量

- html.js：escapeHtml(input) 统一处理 &、<、>、双引号、单引号和空值。views 与 article-html 保留原导出供现有调用者使用；charts 直接导入纯模块，不产生循环依赖。
- src/upload-image.ts：readFormField(body, name) 和 receiveImageUpload(body)。上传结果携带 name、created，错误区分缺文件、过大、格式拒绝、保存失败。media.ts 提供具名输入错误，不靠中文错误正则分类。头像、徽标、文章和友联均使用此接口。
- 上传鉴权继续是来源、资格、CSRF 的既有顺序；路由保留引用写入、回跳、头像所有权及友联上传后再次检查条目存在的职责。文章写盘失败统一提示 image-save-failed；不把存储错误说成格式错误。
- status-model.js：visibleState(item, now)、summarizeStatus(items, now)、stateClass、stateText、formatTime、formatUptime、observedDuration、incidentOutcome、incidentDetails。纯计算显式传 now，时间校正仍由客户端调用层负责；不改变公开 API 的白名单。
- chart-path.js：统一 linePath、areaPath、hash、expandDomain、clampY；SSR 使用 expandDomain(null, values) 求初始域，客户端保留只扩不缩的已用域；缺失/非有限/负数断线，空路径统一空字符串。
- 浏览器资源使用明确的 module 入口，新增资源精确放行；源码声明文件不进入匿名白名单。

## 验证

先固化上传存储失败的 HTTP 回归并观察旧实现失败。共享模块用公开接口验证转义、状态/统计/事件边界与几何固定预期；保留图表 SSR、动态刷新、文章安全和权限回归。浏览器测试适配原生模块导入，并以真实浏览器核对首屏和自动刷新。完成后执行 npm run check:all、git diff --check 和一次独立分支审查。

## 执行约定

用户已明确要求处理评审中的四项，视为对该具体方案范围的执行授权，不再次询问是否开始。当前 checkout 创建 codex/shared-modules 分支，保留 output/。本轮交付为本地可验证实现；外部发布仍按用户后续指示执行。
