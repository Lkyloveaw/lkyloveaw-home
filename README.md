# 个人站（包含内网可用性面板）

一个 Fastify + TypeScript 单进程站点：

- **事情分享**：`content/` 下的 Markdown 文件，带 frontmatter，服务端渲染文章列表与详情页；
- **内网业务系统可用性**：服务端按固定间隔探测 `targets.json` 里的地址，把每次结果写进 SQLite，面板展示当前状态、可用率、延迟、连续可用时长、状态时间线，以及整体可用率曲线与各系统延迟曲线。

一台机器、一个容器、一个 SQLite 文件即可运行。曲线是服务端渲染的内联 SVG，不依赖任何图表库，禁用 JS 也能看。

面板的**数值每 30 秒自动刷新**。

> ⚠ **整个站点需要登录**：首页、分享、面板、`/api/status` 全部要求已登录。
> 匿名只能访问登录页、`/healthz`、`/style.css`、`/status.js`（以及面板用的 `/chart-path.js`）。
> 这是有意为之——首页也会渲染系统名与可用率，只锁面板等于白锁。

## 首次部署：先建一个账号

**没有账号时站点仍会启动**（拒绝启动会让容器陷入重启循环），但所有页面都会跳到登录页。
建号用 CLI：

```bash
node dist/cli/passwd.js --user alice --password '至少八位的口令'
```

口令要求 ≥ 8 位，用 bcrypt（cost=12）哈希后存进 SQLite。**没有邮件找回、没有注册页**——
CLI 是唯一的救援通道，忘记口令时也用它重置。

也可以让服务在启动时自动建首个账号，把下面两项写进环境变量（**仅在库里一个账号都没有时生效**）：

```bash
ADMIN_USERNAME=alice
ADMIN_PASSWORD=至少八位的口令
```

> ⚠ 库里一旦有账号，这两个变量就**被完全忽略**——否则一个残留的环境变量会变成隐藏的后门账号。
> 因此**推荐用 CLI 建号**，环境变量只适合「一键起一个全新环境」。

### 日常运维

```bash
node dist/cli/passwd.js --list                          # 看看有哪些账号
node dist/cli/passwd.js --user alice --password '新口令'  # 改口令（顺带踢掉该账号全部会话）
node dist/cli/passwd.js --user alice --revoke-sessions   # 只踢会话，不改口令
node dist/cli/passwd.js --user alice --disable           # 停用（立刻生效）
node dist/cli/passwd.js --user alice --enable            # 重新启用
```

改口令、重置口令、`--revoke-sessions` 都会递增该账号的**凭据代次**（`users.token_version`），
使**已签发的全部 cookie 立即失效**。登录后也可以直接在面板上自助改密。

### ⚠ 登出**不是**吊销

会话是**签名 cookie**，服务端不存状态。所以：

- 「登出」只让**当前这个浏览器**忘掉 cookie；
- **已经泄漏或被复制走的 cookie，在过期（默认 7 天）之前依然有效**；
- 想让某个账号的所有会话立刻作废，只能用 `--revoke-sessions`（或改口令）。

## 本机运行

```bash
npm install
cp .env.example .env        # 可选，不改也能用默认值
npm run dev                 # 开发模式，改代码自动重启
```

> **必须配 `SESSION_SECRET`**，否则服务拒绝启动。生成一个：
>
> ```bash
> node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
> ```
>
> 为什么不自动生成：那样每次重启所有人都会掉线，而用户看不到任何原因。
> 失败要显眼——所以这里选择不启动，并在报错里直接给出生成命令。

打开 http://localhost:3000

生产模式：

```bash
npm run build
npm start
```

## 配置被监控的系统

编辑 `targets.json`：

```json
[
  {
    "id": "portal",
    "name": "统一门户",
    "url": "http://10.0.0.10/",
    "group": "对内系统",
    "expectStatus": [200, 302]
  }
]
```

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `id` | 是 | 历史库主键。**改 id 等于丢掉该目标的旧历史** |
| `name` | 是 | 面板上显示的名字 |
| `url` | 是 | 被探测地址，服务端直接请求 |
| `group` | 否 | 面板分组，缺省「未分组」 |
| `expectStatus` | 否 | 算作可用的状态码，缺省 200–399 |
| `timeoutMs` | 否 | 单目标超时覆盖，缺省取 `PROBE_TIMEOUT_MS` |
| `enabled` | 否 | 设为 `false` 可临时停用而不删历史 |

也可以在环境变量里用 `TARGETS_JSON` 直接给一份 JSON 数组，它优先于文件（适合 Docker 部署）。

### ⚠ 探测**不跟随跳转**（这条会改变你的判定结果）

探测请求用 `redirect: 'manual'`，也就是说**被探测系统返回 302 时，探测不会去访问跳转目标**。

为什么：跟随跳转会让探测去请求**跳转指向的地址**（实测 `follow` 让目标被请求 1 次、`manual` 后为 0 次），
于是「被探测系统自己 302 到一个元数据地址」就成了一条越权探测路径。`manual` 从根上关掉它。

**代价是语义变了**：`manual` 之后 302 会**原样返回**，而默认判定区间是 `200–399`，
所以 **302 会被判为「可用」**。这是**故意保留**的默认——改它等于静默改变所有既有部署的语义。

**想让跳转算失败**，给你的目标显式写白名单：

```json
{ "id": "portal", "name": "门户", "url": "http://10.0.0.10/", "expectStatus": [200] }
```

这样只有 200 算可用，302 会被判成「异常」。`targets.json` 里有一条 `demo-redirect` 就是这个用法的示例。

### `targets.json` 是**授权清单**，不是不可信输入

入口会校验每条 URL（详见下），但**不做 SSRF 地址黑名单**：面板的用途**就是**探内网地址，
`127.0.0.1` 与 `10.x` 都是正当目标，黑名单既挡不住 `0x7f.1` 这类变体，也会误伤真实用途。

所以请把它当成**一份授权清单**：能写进这个文件的人，本来就有权让本服务去访问那些地址。
不要把它做成「让不受信任的人提交 URL」的接口。

### 入口校验：三类 URL 会被跳过

每条 URL 必须满足（不满足则 `console.warn` 后**跳过该目标**，服务照常启动）：

| 规则 | 例子 |
| --- | --- |
| `new URL()` 必须可解析 | `not a url` → 拒 |
| 协议必须是 `http:` / `https:` | `file:///etc/passwd`、`javascript:alert(1)`、`gopher://…` → 拒 |
| **不能带凭证**（只有用户名也算） | `http://ops:hunter2@10.0.0.1/` → 拒 |

第三条顺带拦住「没写 scheme」：`ledger.internal.example:8080` 会被解析成
`protocol='ledger.internal.example:'`，于是查协议白名单时就一并拒了。

**为什么必须拒凭证**：异常原文可能把整个 URL 记进历史库，而 URL 里带着口令
（这一点实测过一次：`http://ops:hunter2@…` 的原文含内网主机名与口令）。
出口侧另有脱敏（见「接口」一节），但**入口与出口两道都要做**。

## 备份与恢复

**自动备份**：服务在探测轮次里降频执行「checkpoint + 备份」（默认每 60 轮 ≈ 1 小时），
产物在 `BACKUP_DIR`（默认 `./data/backups`），按日期命名，滚动保留 `BACKUP_KEEP` 份（默认 7）。
备份失败**只记日志、不中断探测**。

### ⚠ 不要用 `cp` 备份数据库

实测三种做法的对照（10000 行）：

| 做法 | 结果 |
| --- | --- |
| **只拷 `.sqlite`** | 副本**打不开 `probes` 表**——数据还在 `-wal` 里，拷到的是空库 |
| 连 `-wal` 一起拷 | 能读，但**只有停服才安全**（拷贝瞬间 WAL 正在写就会得到撕裂的组合） |
| **`db.backup()`（本服务的做法）** | 行数与源库一致，且**不需要停服** |

### 手动操作

```bash
node dist/cli/backup.js                  # 立刻备份一次
node dist/cli/backup.js --list           # 列出备份，并逐个校验能不能用
node dist/cli/backup.js --verify <file>  # 校验一份备份（恢复前必做）
```

### 恢复步骤

1. **停服务**（避免恢复过程中有写入）。
2. **先校验备份**：`node dist/cli/backup.js --verify <备份文件>`。
   ⚠ **不要跳过这一步**——把一份空库盖到好库上是最常见的恢复事故，而空库「看起来」是正常的文件。
3. 移走当前主库**以及残留的 `-wal` / `-shm`**：

   ```bash
   mv data/availability.sqlite /tmp/availability.broken.sqlite
   rm -f data/availability.sqlite-wal data/availability.sqlite-shm
   ```

   ⚠ **必须一起移走**。旧的 `-wal` 配上新的主库，SQLite 会把旧 WAL 当成自己的，
   实测结果是**读到了另一个库的数据**（不是报错，是静默给错数据）。
4. 把备份拷回 `DATABASE_PATH` 的位置。
5. 起服务，确认面板/`/api/status` 能看到历史数据。

### 关于 `-wal` 与 checkpoint

数据先写 WAL，再靠 checkpoint 搬回主库。所以「拷 `.sqlite` 就能拿到完整库」
**只在 WAL 已被截断时成立**。服务会定期 `wal_checkpoint(TRUNCATE)` 把 WAL 截断，
而 `busy` 非 0 时会**显眼地记日志**（那时它其实没搬干净——实测这个返回值会说谎）。

## 写一篇文章

在 `content/` 下放一个 `.md`：

```markdown
---
title: 标题
date: 2026-01-01
tags: [运维, 网络]
summary: 可选的一句话摘要
---

正文用 Markdown 写。
```

文件名形如 `2026-01-01-hello.md` 时，日期前缀会被去掉，slug 为 `hello`。

**`draft: true` 的文章不出现在任何列表里，也（按设计）不能通过直链访问**——
直接访问 `/posts/<slug>` 会得到 **404**。原因是 `getPost()` 只从 `listPosts()` 的结果里找，
而后者已经过滤掉草稿。

> 这条曾经与实现矛盾：旧版 README 写着「不出现在列表里，**但可以通过直链访问**」，
> 而实测是 404。**实现比文档更严格**，所以改的是文档（2026-10-15 决定）。
> 若将来想要「可凭链接预览的草稿」，那是一个**新特性**（需要引入「未发布但可访问」的概念，
> 并想清它该如何受登录与索引约束），不在「只修缺陷」的范围内。

## Docker 部署

```bash
docker compose up -d --build
```

`docker-compose.yml` 已把 `targets.json`、`content/` 只读挂进容器，SQLite 数据落在 `./data`：

- 改 `targets.json` 后重启容器即可生效：`docker compose restart`
- 历史数据在宿主机的 `./data/availability.sqlite`

## 自检

```bash
npm run verify        # typecheck + docker + unit + leak + chart + backup + restart
npm run check:all     # = verify + check:e2e（全量）
npm run check:unit    # 凭据与会话的纯函数断言（86 项，不需要起服务）
npm run check:leak    # 真实起服务，断言含凭证的 URL 不会从 /api/status 出网（32 项）
npm run check:chart   # 曲线几何的交叉断言 + 面板行为（61 项）
npm run check:backup  # 入口校验、checkpoint、备份与恢复，含探测循环集成（60 项）
npm run check:restart # 真杀进程再起：历史与会话是否活过重启（17 项）
npm run check:e2e     # 真实起服务、真实探测、逐项断言（152 项，需要先 npm run build）
```

### ⚠ 写安全断言时的一条硬规矩

**每一条安全断言都必须先证明载荷真的出现在页面上，再断言它没有被当成代码执行。**

理由是踩过的坑：旧版 e2e 有两条断言是 `!/<script>alert/` 与 `!/href="javascript:/`。
被测页面里**本来就没有**这些字面量，它们**不注入任何载荷**，所以永远通过——
这是「38 项通过」里最没含金量的一条，**会给放行提供虚假信心**。

现在的写法是先断言 `&lt;script&gt;` 出现在页面里（证明载荷真的渲染过、注入面确实有效），
然后才断言它没有被执行。同理，断言「属性内逃逸」时不能写「页面上没有 `onmouseover`」——
转义后那段文本仍然存在、只是无害，要断言的是**带真实引号的属性断裂序列不存在**。

`check:e2e` 覆盖 7 个注入面：文章标题/摘要/标签、文章正文、标签路由的 `<h1>` 回显、
登录页 `next` 隐藏域、目标名、错误文案上屏、站点标题。

`check:restart` 是唯一**真的杀进程再起**的套件：断言历史活过重启、**旧 cookie 仍有效**
（`SESSION_SECRET` 稳定，不会每次重启把所有人踢下线），并带一个**对照组**——
换个密钥重启，旧 cookie 必须失效（否则前一条断言是恒真的）。

`check:unit` 用临时数据目录跑，断言的是口令校验、`token_version` 迁移、会话签名与
`next` 逃逸面等纯逻辑——包括「签名长度不对不能抛异常」这类在 HTTP 层很难稳定复现的情形。

`check:leak` 专门盯**数据外泄**：造一个带 `http://user:pass@内网主机/` 的目标与一个含凭证原文的
历史库，然后断言响应体里搜不到主机名、口令、`url`、`expectStatus` 等任何一项——
同时断言**超时文案仍然是原文**（脱敏不能把排障信息一起抹掉）。

`check:chart` 里最要紧的是**交叉断言**：同一份输入，服务端渲染出的折线 `d` 必须与
`node:vm` 里 `public/chart-path.js` 算出的 `d` **逐字符相等**——否则「两份实现漂移」只会在
「刷新一次曲线就跳一下」时暴露，极难归因。

`check:backup` 里有一半是**防静默降级**的断言：checkpoint 在并发时返回 `busy !== 0`
（实测它可能报 `busy:0` 却只搬了 2/33 页）、只拷 `.sqlite` 的副本**打不开 `probes` 表**、
残留 `-wal` 会让恢复**读到另一个库的数据**。

`check:e2e` 还会断言并发访问（24 个并发请求全部成功且数据自洽）与**无目标清单**时
面板不崩、明说「还没有配置被监控的系统」。

## Docker 部署中的原生模块

`better-sqlite3` 是原生模块，但 **v13 自带 N-API 预编译产物**（`prebuilds/linux-x64.node`、`linuxmusl-x64.node` 等），
且 lockfile 中不含 install script，所以 Linux 上 `npm ci` 不会触发 node-gyp，运行期镜像无需保留编译器。

Dockerfile 在 `npm ci --omit=dev` 之后加了一条断言，直接 `require('better-sqlite3')` 并执行一次查询：
如果预编译产物缺失，**构建阶段就会失败**，而不是等到容器起来才发现连不上数据库。

> 注意：在 **Windows 上直接 `npm ci` 可能失败**（回退到 node-gyp 去找 Visual Studio）。这是本地环境的差异，
> 与容器内行为无关——`prebuilds/win32-x64.node` 存在时用预编译产物，不存在时才需要编译工具链。

## 环境变量

见 `.env.example`。常用几项：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PORT` | `3000` | 监听端口 |
| `DATABASE_PATH` | `./data/availability.sqlite` | 历史库位置（`users` 表也在这个库里） |
| `PROBE_INTERVAL_SECONDS` | `60` | 探测间隔 |
| `PROBE_TIMEOUT_MS` | `5000` | 单次请求超时 |
| `PROBE_RETENTION_DAYS` | `30` | 历史保留天数，超期自动清理 |
| `SITE_TITLE` / `SITE_DESCRIPTION` | — | 站点标题与描述 |
| `SESSION_SECRET` | **无（必填）** | 会话 cookie 的签名密钥。**没配就拒绝启动** |
| `SESSION_TTL_SECONDS` | `604800` | 会话存活时间（7 天）。绝对过期，不滑动续期 |
| `SESSION_COOKIE_SECURE` | `0` | cookie 的 `Secure` 属性。**HTTP 部署时必须保持 0** |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | — | 首个账号，**仅当库里没有任何账号时生效** |
| `BACKUP_DIR` | `./data/backups` | 备份目录。默认与数据库同目录，两种部署方式都不用加挂载 |
| `BACKUP_KEEP` | `7` | 滚动保留几份 |
| `CHECKPOINT_EVERY_ROUNDS` | `60` | 每几轮探测做一次 checkpoint（0 = 关闭） |
| `BACKUP_EVERY_ROUNDS` | `60` | 每几轮探测尝试一次备份（0 = 关闭） |

> ⚠ **`SESSION_COOKIE_SECURE` 与 HTTPS**：站点还是 HTTP 时把它设成 `1`，浏览器**不会保存**带
> `Secure` 的 cookie，表现为「**输对密码又跳回登录页**」，现象极具误导性。
> 等上了 HTTPS 再改。

## 接口

| 路径 | 登录要求 | 说明 |
| --- | --- | --- |
| `/` | **要** | 首页：最近分享 + 可用性摘要 |
| `/posts`、`/posts/:slug` | **要** | 分享列表与详情 |
| `/tags/:tag` | **要** | 按标签筛选 |
| `/status` | **要** | 完整可用性面板 |
| `/api/status` | **要**（未登录回 **401 JSON**） | 面板数据 JSON（前端每 30 秒拉一次） |

`/api/status` 的响应是**显式白名单投影**（`src/public-summary.ts`），不是内部结构直接序列化的结果：

- 顶层**恰好 6 个键**：`targets` / `overview` / `incidents` / `generatedAt` / `windowLabel` / `probeIntervalSeconds`；
- `targets[]` 由内部四层**压平成恰好 10 个键**：`id` / `name` / `group` / `lastStatus` / `uptime` /
  `avgLatencyMs` / `p95LatencyMs` / `lastError` / `timeline` / `latency`；
- **`url` 与 `expectStatus` 不在其中**——内网资产地址与判定口径不出网（页面上仍显示，那是靠鉴权保护，两者互补而非互相替代）；
- 错误文案经脱敏：**超时/状态码这类本服务自己生成的文案原样保留**（排障最需要它），
  运行时异常只留类别码（如 `连接被拒（ECONNREFUSED）`），无 code 时兜底为 `探测失败`，**绝不回异常原文**
  （实测原文可能含完整 URL 与口令）。

新增内部字段**默认不会出网**——要出网必须在投影里显式加一行。见 [ADR 0003](docs/adr/0003-public-contract-is-not-internal-structure.md)。
| `/login` | 匿名 | 登录页（GET 表单 / POST 校验） |
| `/logout` | 已登录 | 登出（POST；只清本机 cookie） |
| `/password` | 已登录 | 自助改密（POST） |
| `/healthz` | **匿名** | 健康检查。**必须保持匿名**，否则 HEALTHCHECK / systemd 会误判服务不健康 |
| `/style.css`、`/status.js`、`/chart-path.js`、`/favicon.ico` | 匿名 | 静态资源。**登录页自己要用，必须放行** |

未登录时：页面请求 `302 → /login?next=<原路径>`；API 请求（`Accept: application/json`）
回 `401 {"error":"unauthorized"}`。**分流看请求要什么，不看路径前缀**——
若 API 也回 302，`fetch` 会跟随跳转拿到登录页的 HTML，`r.json()` 直接抛错。

`next` 只接受**站内相对路径**（且落点必须在已知路由内），`//evil.com`、`/\evil.com`、
`https://evil.com` 之类的变体一律丢弃并回退到 `/`。

## 面板怎么看

| 元素 | 含义 |
| --- | --- |
| 状态点 | 绿=可用，黄=异常（能连上但状态码不符预期），红=故障（连不上/超时） |
| 状态时间线 | 每格一次探测，从左到右由旧到新 |
| 延迟曲线 | 横轴是真实时间。**失败处曲线断开**，不会画成 0——0ms 会看起来"更快了"，与事实相反 |
| 可用率曲线 | 每个探测时刻的「可用目标占比」，断点同理 |
| 连续可用 | 从最近一次故障之后开始累计，当前正故障则为 0 |
| P95 | 比平均延迟更能暴露"少数请求特别慢" |

曲线横轴共用一个时间范围，所以同一页里各系统的曲线长度可以直接横向比较。

## 目录结构

```
src/
  config.ts    环境变量与目标清单
  content.ts   Markdown 读取与解析
  store.ts     SQLite 历史存储与聚合
  probe.ts     探测引擎
  charts.ts    内联 SVG 曲线
  views.ts     服务端 HTML 渲染
  server.ts    路由与启动
public/        样式与面板数值刷新脚本
content/       文章
targets.json   被监控的系统清单
```
