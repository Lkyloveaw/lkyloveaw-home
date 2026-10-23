# 历史原型归档

2026-10-23，用户要求在无开放 issue 后，将 GitHub 仓库中未合并的分支全部合入 master。
两个历史分支原先明确标记为抛弃式原型，其正式功能已经由后续实现取代。本次保留完整分支历史，
并将原型变更存为独立源代码档案，避免旧页面和旧构建入口覆盖当前产品。

| 分支 | 合并源提交 | 当前归档目录 |
| --- | --- | --- |
| prototype/editor-shape | a6a2642e67e1ab5a0ca31ae91d16fd54083f2457 | editor-shape/ |
| prototype/status-variants | 3cd3db2cf7df6ab88852e9dd828eac25befda2f4 | status-variants/ |

路径对应：原 src/prototype/ 保存在各自 source/ 下；原 scripts/ 保存在各自 scripts/ 下；
可用性原型的 prototype/ 静态页面保存在 status-variants/static/ 下。
编辑器分支修改过的 package.json 完整保存在 editor-shape/package.json 中，正式根目录不加入旧原型启动命令。

合并时核对了两个分支全部 23 个变更文件的 Git blob，归档内容与源分支逐字节一致。
正式 src/、public/、scripts/、根 package.json 和构建配置仍与已验收的 b2364d8 一致。
归档文件不参与产品编译，不注册旧原型路由，也不提供匿名预览服务。

归档中的 NOTES、路径、命令及部署描述是当时的历史记录，不能直接作为当前操作说明。
当前产品构建和部署请阅读根 README.md 与 docs/deploy-environment.md。
