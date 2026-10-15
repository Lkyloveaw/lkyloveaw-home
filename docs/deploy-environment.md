# 部署环境事实：内网开发服务器 `10.0.0.226`

本文件记录**目标部署机器**的实测事实，供后续会话直接引用，避免重复探测、也避免把「静态推断」当「已验证」。

采集时间：2026-10-15。采集方式：SSH 登入后实跑命令（不是推断）。

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

## 10. 尚未验证的部分

- **本文件只做环境采集，没有部署任何东西**。站点仍是一个 `initial commit`，代码一行没落地。
- `npm ci` 在这台机器上**尚未实际执行过**（Node 24 + 有编译器，理论上无障碍，但未实测）。
- systemd 单元**尚未编写**。
- 端口 3000 空闲是当前快照；部署前应重新确认。
