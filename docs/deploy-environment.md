# 部署环境事实：开发服务器

本文件记录**目标部署机器**的实测事实，供后续会话直接引用，避免重复探测、也避免把「静态推断」当「已验证」。

## 当前：2026-10-25 起，开发服务器 = `root@10.0.0.226`

用户明确要求切回 `10.0.0.226`，并检查、部署最新提交。**本节覆盖后面的历史记录；后续开发部署以本节为准。**
部署仍然只有**裸机 + systemd**，机器上的其他容器与本站无关。

### 实测环境与登录

| 项 | 2026-10-25 实测值 |
| --- | --- |
| 地址 / hostname | `10.0.0.226` / `Development` |
| 系统 / CPU | Ubuntu **24.04.5 LTS** / **2 核** |
| 内存 / Swap | **2.0 GiB / 2.0 GiB**；部署后可用内存约 1.3 GiB（历史的 4 GiB 已不适用） |
| 磁盘 | 40G，部署后用 25G、**剩 13G** |
| 系统 Node | `/usr/bin/node` = **18.19.1，不可用于本站** |
| 本站 Node / npm | `/root/.nvm/versions/node/v24.15.0/bin/node` = **24.15.0** / npm **11.12.1** |
| 工具 | git、rsync、curl、gcc、make、python3、systemd 可用；npm registry 返回 200 |
| 服务 / 端口 | `personal-wiki.service`；`0.0.0.0:3000`；启用开机自启 |
| 访问地址 | **<http://10.0.0.226:3000/>**（匿名首页会按现有鉴权规则跳转登录） |

SSH 必须显式使用旧机对应密钥；本次直连成功的命令如下，未修改本地 SSH 配置或密钥：

```bash
ssh -i ~/.ssh/id_ed25519.bak -o IdentitiesOnly=yes -o ProxyCommand=none -o ProxyJump=none root@10.0.0.226
```

非交互式 shell 与 systemd **不会自动加载 nvm**。安装、构建、运维 CLI 都先设置：

```bash
export PATH=/root/.nvm/versions/node/v24.15.0/bin:$PATH
npm_config_nodedir=/root/.nvm/versions/node/v24.15.0 npm ci --include=dev --no-audit --no-fund
```

### 当前部署与数据

- 当前发布的完整提交号、归档 SHA-256 与启用时间以 **`/opt/personal-wiki/.deployment.json`** 为准；部署产物来自 `master` 的固定提交 `git archive`，不包含本地未提交文件。首次切回内网时部署的是 `14666834f9496262255df562a14afccfcc5a061d`（代码归档 SHA-256：`edc88279466f72234a4b4c46864635c9c0da7c54065c70d58f82445276a3e449`），该记录用于迁移追溯。
- 应用目录 / unit：`/opt/personal-wiki` / `/etc/systemd/system/personal-wiki.service`。
- unit 的 `WorkingDirectory=/opt/personal-wiki`，`ExecStart=/root/.nvm/versions/node/v24.15.0/bin/node /opt/personal-wiki/dist/server.js`，并显式配置同一 nvm 的 `PATH`；`NODE_ENV=production`。
- 运行数据：`data/availability.sqlite`、`data/media/`、`data/backups/`；另保留 `.env`、`targets.json`、`content/`。`.env` 为 root 所有、权限 **600**，`data/` 权限 **700**。
- 数据来自原开发服务器 `hw.hyacinthus.cn` 的 SQLite **在线备份**及媒体、配置副本。最终快照时间 **2026-10-25 20:54:10（UTC+8）**，包含 **2 个账号、2 篇文章、1 个目标、3,117 条探测记录**；所有表在启动前逐表比较内容摘要，启动后再次比较业务记录，均一致，数据库 `quick_check=ok`。
- 保留原 `SESSION_SECRET` 和账号口令；`SITE_ORIGIN` 在原值基础上加入 `http://10.0.0.226:3000`，`SESSION_COOKIE_SECURE=0`。新地址可用原账号登录。
- 回退数据快照：`/opt/personal-wiki-import-20261025-1466683/`，权限 **700**；原始压缩包 `/tmp/personal-wiki-state-20261025-1466683-final.tar.gz`，权限 **600**，SHA-256：`72ed911cb1bb58e10c63afff30f7f81998678054c218d756271a1e8fd1acab1e`。快照包含私密配置，不应公开。
- 首次迁移的准备目录：`/opt/personal-wiki-deploy-1466683`；首次迁移日志：`/var/log/personal-wiki-deploy-1466683-*.log`。后续发布目录和回滚位置另行记录。
- 原云服务器服务保留作为回退；开发入口已切换为上述内网地址。后续开发部署不再默认使用 `hw.hyacinthus.cn`。

### 验证结果及后续更新注意事项

- 新机器完成依赖安装、原生 SQLite 内存查询、类型检查及 `verify` 的全部验证组。因测试环境前提不同，泄漏测试在独立网络命名空间中为 `10.255.255.1:80` 提供确定超时的服务；探测备份与重启测试仅给测试进程设置 `PROBE_TIMEOUT_MS=500`；为在途删除测试建立 `.dsh-progress/` 临时目录。**应用代码未修改，正式探测超时未调整。** 重启检查 17/17、在途删除检查 3/3 通过。
- 本机与局域网实测 `/healthz` **200**、`/login` **200**；匿名 `/` 与 `/status` **302**、`/api/status` **401**，符合当前鉴权规则。部署验收不要把匿名首页写成 200。
- 四个模块 `status.js`、`chart-path.js`、`html.js`、`status-model.js` 的 `?v=esm` 响应与部署文件一致，MIME 正确，`Cache-Control: no-cache`。
- 2026-10-25 **21:00:08（UTC+8）**复查：`active/running`、`enabled`、`NRestarts=0`、错误日志 0；探测记录 **3,120 → 3,121**，业务记录未变化。只验证了服务与测试进程的重启，未重启整台机器。
- 更新时先在独立目录安装和构建，再备份、切换。保留数据与配置；`dist/` 与 `public/` 必须来自同一提交，服务端现在也会导入 `public/` 下的共享 JS 模块。不要将测试临时目录同步到应用目录。

### 2026-10-25 动效版本发布

- 用户授权把 `codex/interface-motion` 合并到 `master`、推送 GitHub 并部署至本机。原型存档分支不随本次推送。
- 本次准备目录：`/opt/personal-wiki-deploy-motion-20261025`；切换前的完整现场备份：`/opt/personal-wiki-backups/20261025-motion/app`。发布标记中的 `backup` 指向该目录；完整提交、归档校验和和启用时间读取发布标记。
- 日志：`/var/log/personal-wiki-motion-20261025-prepare.log`、`/var/log/personal-wiki-motion-20261025-activate.log`；备份目录的 `before.json` / `after.json` 保存数据完整性与内容摘要，权限限制在 root。
- 在独立目录安装依赖并运行全量检查，确认通过后停止服务、完整备份、同步代码并重启。同步明确排除 `data/`、`.env`、`targets.json`、`content/` 等持久数据；不恢复早前云服务器的旧快照，因此不会覆盖迁移后的改密和内容修改。失败时恢复上一版代码并启动原服务。
- 动效版本增加匿名可读 `/motion.js`，登录页改为 `/style.css?v=motion`；两项均要求缓存重新验证。发布后除原有健康/鉴权检查外，还核对这两项实际响应与新文件一致，以及 JSON 登录失败契约、原生 HTML 降级和业务数据保持一致。
- 探测验收脚本已改用真实本机 HTTP 夹具；现在无需首次迁移时的网络命名空间或测试超时覆盖。新准备目录仍先建立 `.dsh-progress/`，供在途删除测试保存临时数据。

---

## 历史记录（不作为当前部署目标）

> ## 0. 2026-10-19—2026-10-24：开发服务器 = `root@hw.hyacinthus.cn`
>
> 用户在这一天通知「开发服务器设置为 `root@hw.hyacinthus.cn`」。**下面 §1–§10 是旧机 `10.0.0.226` 的存档**，
> 它的登录方式（错位的 `id_ed25519.bak`）、Docker 29.5.1、nvm Node 24 —— **在新机上一个都不适用**。
>
> **新机实测（2026-10-19，SSH 登入实跑，不是推断）**
>
> | 项 | 实测值 |
> | --- | --- |
> | 登录 | `ssh root@hw.hyacinthus.cn`（**免密可用**，不需要旧机那把密钥） |
> | DNS | `hw.hyacinthus.cn` → `124.70.160.90`（华为云 ECS） |
> | hostname | `hcss-ecs-66f5` |
> | 系统 | Ubuntu 24.04.4 LTS（kernel 6.8） |
> | CPU / 内存 | **2 核 / 1.7 GiB**（比旧机 4 GiB 小，别并行跑重活） |
> | 磁盘 | `/dev/vda1` 40G，用 3.5G，**剩 35G**（比旧机的 14G 宽裕） |
> | Node | **没有预装**；本次装了 **NodeSource Node 22.23.3 → `/usr/bin/node`**（npm 10.9.9），满足 `engines: >=22` |
> | Docker | **没有** → 部署方式只剩**裸机 systemd**（票 #19 里「由用户拍板」那张对比表被机器裁掉了） |
> | 工具链 | git / rsync / curl / systemctl / gcc / make / python3 齐；**`sqlite3` CLI 没有** |
> | 端口 | 22 + 华为云 uniagent（29338/29339）+ resolved；**3000 / 80 都空闲** |
> | 应用目录 | `/opt`、`/srv` 都是空的，没有既有应用 |
> | 出口 | `registry.npmjs.org` 200、`github.com` 200 ✅ |
> | **入向** | ⚠ **云安全组把 80 与 3000 都挡着**：机器上 `ss` 能看到监听，外网仍连不上。要用浏览器看，得先在华为云控制台放行端口（或用 SSH 隧道） |
>
> **两条教训（这台机上不存在，别再照搬旧机的坑）**：
> - 旧机「`ssh 'node -v'` 给 18」是因为 Node 在 nvm 里、非交互式不加载 `.bashrc`。
>   新机 Node 装在 `/usr/bin/node`，**systemd 与 ssh 都直接拿到 22** —— 不需要 `Environment=PATH=` 那套弯路了。
> - 旧机的 Docker 属主问题（`backup-checkpoint-decision.md` §4）在裸机上**不适用**（无容器 → 无跨 UID 错配）。
>
> **第三条教训（新机才有的，2026-10-20 实测）：边缘上有一层华为云 WAF。**
> 请求一密（批量验收、CDP 轮询）就会被它拦成**空 body 的 403**，`Server: ADM/2.1.1`，
> **连 `/healthz` 都拦**；而在机器本机 `curl 127.0.0.1:3000` 仍是 200 ——
> 所以排查第一件事是分辨「应用坏了」还是「边缘挡了」。
> 跑批量验证时走 **SSH 隧道**绕开边缘：`ssh -N -L 3999:127.0.0.1:3000 root@hw.hyacinthus.cn`，
> 之后对 `http://127.0.0.1:3999` 操作（注意 `SITE_ORIGIN` 里的白名单是 `http://127.0.0.1:3000`，
> 经隧道发 POST 时 `Origin` 头要写白名单里的那个，否则 L2 会拦）。
>
> **部署形状（本文件后续会话可照抄）**：`/opt/personal-wiki` 放代码与数据（`data/` 由默认路径生成），
> `git` 不进部署产物、用 **tar over ssh 同步工作树**（仓库有未推送提交，不为了部署去 push），
> `npm ci` + `npm run build` 在机器上跑，`systemd` 单元托管，`SESSION_SECRET` 写进 `/opt/personal-wiki/.env`。
>
> **2026-10-22：部署方式收敛为「仅 systemd」。** 仓库里的 Docker 制品（`Dockerfile`、`docker-compose.yml`、
> `.dockerignore`、`scripts/check-docker-context.mjs`）已删除，`npm run verify` 不再包含 `check:docker`。
> 下面 §1–§10 里关于 Docker 的分析（旧机有 Docker、属主问题、`Dockerfile` 行号）保留为**历史记录**：
> 它们解释的是「当时为什么选裸机」，不是当前可执行路径。当前部署**只有**本节这一段。

采集时间：2026-10-15（旧机 `10.0.0.226`）。采集方式：SSH 登入后实跑命令（不是推断）。

票：<https://github.com/Lkyloveaw/personal-wiki/issues/12>（本文件由「实现批次怎么切」的会话顺带采集）

---

## 1. 结论摘要

**这台机器可以裸机自建运行环境，不必用 Docker。**

它同时具备 Docker（29.5.1）与原生 Node 24，但**项目的两份 ADR 一次都没提 Docker**——
Docker 在本项目里只是**部署方式之一**，不是架构约束（见 §5）。用 systemd 直接跑更贴合这台机器的现状。

---

## 2. 主机事实（实测）

| 项 | 实测值 |
| --- | --- |
| hostname | `Development` |
| 系统 | Ubuntu 24.04.4 LTS (noble) |
| CPU | 2 核 |
| 内存 | 4.0 GiB（已用 863 MiB，可用约 3.2 GiB） |
| 磁盘 | `/dev/mapper/pve-vm--108--disk--0` 40G，**已用 65%（24G），剩 14G** |
| 虚拟化 | 从卷名看是 Proxmox VM（`pve-vm-108`） |

⚠ **磁盘剩 14G 不算宽裕**：`npm ci` + `dist` + 备份滚动（7 份 ≈ 1.4 MB）占用很小，
但若要在这台机上同时保留 Docker 镜像与 node_modules，值得留意。

## 3. 运行时（实测）

| 运行时 | 版本 | 判断 |
| --- | --- | --- |
| **nvm Node** | **v24.15.0** + npm 11.12.1 | ✅ **满足 `package.json` 的 `engines: node >=22`** |
| nvm 位置 | `/root/.nvm/versions/node/v24.15.0` | 已在 `/root/.bashrc:159-161` 自动加载 |
| **系统 Node** | **v18.19.1**（`/usr/bin/node`，apt 装的） | ❌ **不满足 `>=22`** |
| Docker | 29.5.1 + compose 插件 | 可用，但本项目不必用 |
| systemd | 255 | ✅ 用它托管服务 |
| git | 2.43.0 | ✅ |

⚠ **这是最容易踩的一个坑**：`/usr/bin/node` 是 **18**，而项目要 **>=22**。
`ssh root@host 'node -v'` 在**非交互式** shell 里不会加载 `.bashrc`，
所以会拿到 **18**——**必须显式用 nvm 的路径**，否则 `npm ci` / `node dist/server.js` 会以错误版本运行。

非交互式调用应写成（或在自己的脚本里 `export PATH`）：

```
export PATH=/root/.nvm/versions/node/v24.15.0/bin:$PATH
```

这条在写 systemd 单元时同样关键：**systemd 不加载 `.bashrc`**，
单元的 `ExecStart` 要么写绝对路径 `/root/.nvm/versions/node/v24.15.0/bin/node`，
要么在 `Environment=PATH=...` 里显式给出。

## 4. 编译工具链（实测，全部存在）

| 工具 | 版本 |
| --- | --- |
| gcc | 13.3.0 |
| g++ | 13.3.0 |
| make | GNU Make 4.3 |
| python3 | 3.12.3 |

**这条反转了一个已关闭决定的论据，必须记下来**：

`docs/accounts-decision.md` §1 选 `bcryptjs` 而非 `bcrypt` 的**决定性理由**是
「运行期镜像里没有编译器（`Dockerfile:23-25` 清掉了 `python3/make/g++`），
`node-gyp-build` 一旦回退去现场编译，构建当场失败」。

**在裸机上这条论据不成立**——编译器全都在。所以**若将来改为裸机部署**，
「`bcrypt` 会炸」这个理由消失。

**但不改已关闭的决定**（#2 已定 `bcryptjs@3.0.3`，cost=12）：

- `bcryptjs` 仍然**零依赖、纯 JS、实测 cost=12 约 260ms/次**，对个位数账号的内网个人站完全够用；
- 为一个**已经不痛的痛点**重开一张已关票，是纯浪费；
- 日后若真要换 `bcrypt`，理由应从「编译会炸」改为「**性能**」——那是另一个取舍，需重新评估。

## 5. Docker 在本项目里的真实地位（核实）

统计 8 份判定文档里 "docker" 的出现次数：

| 次数 | 文档 | 性质 |
| --- | --- | --- |
| 15 | `backup-checkpoint-decision.md` | 几乎全是「属主问题待验证」的**未验证声明** |
| 7 | `accounts-decision.md` | 论证「**为什么选 bcryptjs**」（§4 已说明该论据在裸机上反转） |
| 3 | `implementation-split-decision.md` | 「`scripts/` 不进镜像」的约束来源 |
| 2 | `session-decision.md` | 同上（CLI 必须放 `src/`） |
| 1 | `login-gate-decision-table.md` | HEALTHCHECK 打 `/healthz` 的来源 |
| **0** | `probe-request-constraints-decision.md`、`chart-redraw-decision.md`、`api-status-fields-decision.md` | — |

**两份 ADR（0001 单进程 SSR+探测、0002 按轮聚合）一次都没提 Docker。**

→ **Docker 是部署方式之一，不是架构约束。** 换裸机部署**不需要重开任何架构决定**。

⚠ 但**有一条约束的措辞依赖 Docker 的存在**，裸机部署时要重新表述（不是推翻，是换说法）：

> **「`scripts/` 目录不进生产镜像」**（`accounts-decision.md` §3b、map Notes）

这条约束的**真实意图**是「**运维 CLI 必须随服务一起部署**」，Docker 只是它当时的载体。
裸机部署时，`dist/` 是 `tsc` 从 `src/` 编译来的，所以**结论完全一样**：
**CLI 写在 `src/cli/` 下就能进 `dist/` 被部署**，写在 `scripts/` 下就不会。
**约束保持，理由换成「`tsc` 只编译 `src/`」即可。**

## 6. 端口与服务现状（实测）

| 端口 | 占用 |
| --- | --- |
| **3000 / 80 / 443** | ✅ **全部空闲**（本项目默认端口 3000 不冲突） |
| 22 | sshd |
| 25 | 本地 master |
| 53 | systemd-resolve |
| 5000 / 6185 / 7833 / 10245 | `astrbot` 容器 |
| 6099 | `napcat` 容器 |
| 6379 | redis-server（宿主） |

已运行的容器：`astrbot`、`napcat`。**没有 nginx / caddy**（无反向代理）。

→ 站点直连 `:3000` 即可；**HTTPS 与反向代理属后续需求**（与 map Notes 第 9 条一致）。

## 7. `/healthz` 这条约束在裸机上的变化

`docs/login-gate-decision-table.md` §2 把 `/healthz` 放进白名单，理由是
`Dockerfile:41-42` 与 `docker-compose.yml:25-30` 的 **HEALTHCHECK 打它且不带凭证**。

**裸机部署时**：健康检查的来源变成 systemd 或运维脚本。**`/healthz` 仍应保持匿名**
（否则任何健康检查都会把「未登录」当成「服务不健康」，导致误判重启）。
→ **结论不变，白名单条目保持**，只是调用方换人。

## 8. 对 map 上「未验证」项的影响

map 的 Not yet specified 里长期挂着一条：

> 「容器以 root 运行、`./data` volume 属主问题：等有 docker 环境时才能实测。」

**在裸机部署下，这个问题直接不适用**——没有容器，就没有「容器内 root 写宿主 volume」这层错配。
服务以 root 跑、数据写 `./data`，属主就是 root，不存在跨 UID 问题。

→ 可选处置：**判定为「不适用」并记进 Out of scope**，或保留一句「若日后改回 Docker 部署，此问题重新成立」。
本文件只记录事实，具体归类由 map 主理人在推进时定。

**但这带来一个真实收益**：`backup-checkpoint-decision.md` §7 的 7 条回归用例里，
有 3 条（恢复流程、残留 WAL、滚动保留）此前只能「纸上验证」，
**现在可以在真机上实跑**——包括那条最关键的「移走 `-wal`/`-shm` 才能恢复」。

## 9. SSH 接续方式（⚠ 密钥文件名具有误导性）

**当前可用的登录方式**：

```
ssh -i ~/.ssh/id_ed25519.bak -o IdentitiesOnly=yes root@10.0.0.226
```

**为什么必须带 `-i`**：客户端本地密钥**文件名与内容错位了**（实测，非推断）：

| 文件 | 私钥实际对应的公钥指纹 | 服务器 `authorized_keys` 里是否有 |
| --- | --- | --- |
| `id_ed25519` | `SHA256:tz44WkHg…`（= `id_rsa.pub`） | ❌ 无 |
| `id_rsa` | `SHA256:tz44WkHg…`（与上同一个键） | ❌ 无 |
| **`id_ed25519.bak`** | **`SHA256:J+g6iuPt…`** | ✅ **有** |

即：**`id_ed25519` 的私钥内容其实是另一把钥匙**，而 `id_ed25519.pub` 声称的 `J+g6iu…` 与它不符。
所以 SSH 默认拿 `id_ed25519` 去登会被拒（`Permission denied (publickey,password)`）。

⚠ **这不是服务器的问题，也不是密钥失效**——服务器 `authorized_keys` 里确实有可用公钥。
**用户已知悉并选择暂不改本地文件**（2026-10-15）。

**影响**：后续任何服务器操作**都要显式带 `-i ~/.ssh/id_ed25519.bak`**。
将来接手的人极易被这个文件名误导，建议日后修正（把 `id_ed25519.bak` 扶正、修正 `id_ed25519.pub`）。

服务器 `authorized_keys` 里现有 3 条：
`SHA256:fhaJZ9fCS0GmZ…`(RSA, `16907@Hyacinthus`)、`SHA256:J+g6iuPt…`(ED25519, `1690711850@qq.com`)、`SHA256:J+g6iuPt…`(ED25519, 无注释——与上一条重复)。

---

## 10. 尚未验证的部分（旧机 10.0.0.226 的存档）

> ✅ **2026-10-19：这些在新机 `hw.hyacinthus.cn` 上已经全部验过了**（裸机 systemd 路线）。
> 实测结果写在 §0 与票 [#19](https://github.com/Lkyloveaw/lkyloveaw-home/issues/19)，要点：
> - `npm ci` **跑过**：但 `better-sqlite3` 没有匹配 Node 22.23.3 的预编译包 → 回退 `node-gyp` →
>   拉 `nodejs.org` 的 Node 头文件 **ETIMEDOUT**（该机到 nodejs.org 不通）→ 解药是
>   **`npm_config_nodedir=/usr/include/node`**（NodeSource 的 deb 自带头文件），随后编译通过。
> - systemd 单元**已写**（`/etc/systemd/system/personal-wiki.service`，`WorkingDirectory=/opt/personal-wiki`，
>   `ExecStart=/usr/bin/node …`）；**真重启过一次**：20 秒回来、服务自启、`/healthz` 匿名 200、探测轮自动续跑。
> - 端口快照：3000 / 80 在机器上**都空闲**，但**云安全组把两个都挡着**（外网连不上）—— 要用浏览器看必须先放行。
> - 顺手抓到一条**只在 Linux 现形**的仓内 bug：`scripts/unit-check.mjs` 的沙箱清理夹在文件中间，
>   后面的小节会去开已被删掉的库 → `TypeError`，整套中断（Windows 上因为「删不掉正在被打开的目录」而侥幸通过）。已修。

- **本文件只做环境采集，没有部署任何东西**。站点仍是一个 `initial commit`，代码一行没落地。
- `npm ci` 在这台机器上**尚未实际执行过**（Node 24 + 有编译器，理论上无障碍，但未实测）。
- systemd 单元**尚未编写**。
- 端口 3000 空闲是当前快照；部署前应重新确认。
