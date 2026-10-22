# iOS 化方向原型：A 原生 App / B 桌面 Console / C 编辑风

本文件是「iOS 化方向三选一」这张票的产出之一（map：[整站 iOS 化](https://github.com/Lkyloveaw/lkyloveaw-home/issues/64)）。

票：[#66 原型：iOS 化方向三选一](https://github.com/Lkyloveaw/lkyloveaw-home/issues/66)

> 这是**抛弃式原型**，不是产品代码。选定后原型不合并进产品；只留本文件与截图。产品实现仍在后面的 #67 / #68 / #69。

---

## 0. 怎么看

```bash
node prototype/ios/serve.mjs    # http://127.0.0.1:4173/
```

- 索引：`prototype/ios/index.html`
- 三个方向：`a.html` / `b.html` / `c.html`
- URL 参数：`?frag=home|status|admin`、`?device=desktop|phone`、`?theme=system|light|dark`
- 截图：`.prototype-ios-shots/`（A/B/C 桌面、A/B 手机、深色、A sheet、索引；**本地产物，不入库**）

## 1. 三个方向在争什么

| | A · 原生 App | B · 桌面 Console | C · 编辑风 |
| --- | --- | --- | --- |
| 一句话 | 最接近 iPhone / iPad App | 把 iOS 语言落在桌面工作台上 | 更接近 Apple 官网 / 编辑风 |
| 桌面导航 | 左侧栏 + 半透明页头 | 常驻侧栏 + 不透明页头 | 顶栏，无侧栏 |
| 手机导航 | 底部 tab bar | 顶部横向导航（表格横向滚） | 顶栏 + 大标题 |
| 内容容器 | inset grouped 列表 + 圆角卡片 | 表格 + 卡片 + 行内表单 | 平面列表 + 超大标题 + 留白 |
| 管理台 | 列表 → sheet 表单 | 表格 + 行内编辑 | 纵向设置页，下划线表单 |
| 密度 | 中（iOS 疏朗） | 高（接近现有面板） | 最低（编辑式） |
| 主操作 | 右上「新增目标」/ 行尾 chevron | 表格行 + 行内编辑 | 顶部「新增目标」details |
| 最强的地方 | 一打开就像 iOS；层级清楚 | 数据密度与桌面效率最好 | 阅读气质最好，最不「后台」 |
| 最大的代价 | 半透明页头有对比度风险；表格类信息被卡片化 | 手机端表格必须横向滚；最不像「原生 App」 | 管理台很长；高密度数据被拉平 |

三个方向都覆盖同样的三块真实片段：

1. **首页**：真实首页的 hero / 状态摘要 / 最近分享；
2. **系统可用性**：真实 `/status` 的统计条、状态格带、目标明细、异常列表；
3. **管理台 · 目标**：真实 `/admin/targets` 的字段、行内编辑、停用/删除语义。

## 2. 什么被验证了

| 检查 | 结果 |
| --- | --- |
| 交互（Edge CDP 真跑） | **15/15 全过**：片段切换、标题同步、管理台按钮显示、A sheet `showModal`/关闭、桌面↔手机、侧栏收起、tab bar 出现、三态深浅 + localStorage、B「编辑」展开 |
| 对比度（原型 token 实际用对） | **26/26 全过**（浅/深各 13 对，最低 4.63:1） |
| 截图目视 | A/B/C 桌面 + A/B/C 手机 + 深色 + A sheet + 索引；已修：C 重复图注、A 按钮重复、B 手机布局、浮点图注、tab bar 不出现 |
| 产品代码 | `src/` / `public/` / `scripts/` **一行未改** |
| 真机 / Safari / 打印 | **未验证**（本会话只有 Edge headless） |

比较时建议：

1. 先看 **A 首页**，再点「可用性」「管理台」，感受「像不像一个 App」；
2. 看 **B 状态页**，感受表格密度与桌面效率；
3. 看 **C 首页 / 管理台**，感受阅读气质与留白；
4. 每个方向都切一次深色、再切手机宽度；A 的半透明页头是故意的材料试验，B/C 是不透明对照。

## 3. 已知边界 / 取舍

- **A 的半透明页头**：这是材料观感试验，不是默认推荐。研究 #65 §4 的结论是 `backdrop-filter` 做不出 vibrancy，半透明页头有无法自证的对比度风险；选 A 时要在落地阶段做一次人眼验收，或退回不透明。
- **B 的手机表格**：B 是桌面 Console，390px 下表格横向滚动是预期行为；它不追求「手机上也像 App」。
- **C 的管理台**：一条纵向设置页，页面会很长；它用留白和下划线换掉 App 壳，适合「读」不适合「高频操作」。
- **原型需要 JS**：片段切换、sheet、三态切换都是原型工具；产品的读面仍是 SSR、无 JS。
- **弹层的手机预览**：`<dialog>` 在 top layer，手机框里打开时它按视口居中，不严格贴在手机框底部；真实手机上会按底 sheet 处理。
- **对比度**：原型 token 已按 4.5:1 校验；正式断言迁移归 #67，不能拿这个脚本替代 `style-check`。

## 4. 用户选定

**状态：已选定 A · 原生 App。**

| 项 | 结果 |
| --- | --- |
| 选定方向 | **A · 原生 App** |
| 选定理由 | 你要求「全面 iOS 化」，A 最接近 iPhone / iPad App；桌面侧栏 + 大标题 + inset grouped 列表 + 手机底部 tab bar + 管理台 sheet 都成立。 |
| 需要保留的细节 | 落地时 A 的**页头默认改不透明**（研究 #65 §4：半透明页头有无法自证的对比度风险）；手机保留底部 tab bar；管理台保留 sheet 表单；列表继续用 inset grouped。 |
| 备注 | 用户先误点 B，随后更正为 **A**；以本行为准。 |

已收口：关闭 [#66](https://github.com/Lkyloveaw/lkyloveaw-home/issues/66) → 地图 Decisions so far 追加一行 → 下一张接 [#67 token 架构](https://github.com/Lkyloveaw/lkyloveaw-home/issues/67)；#68 组件映射要等 #67 关闭后解锁。

## 5. 文件清单

- `prototype/ios/index.html` · `a.html` · `b.html` · `c.html`
- `prototype/ios/base.css` · `a.css` · `b.css` · `c.css` · `index.css`
- `prototype/ios/lib.mjs` · `build.mjs` · `app.js` · `serve.mjs`
- `prototype/ios/contrast-check.mjs` · `cdp-test.mjs`
- `.prototype-ios-shots/`（截图）
