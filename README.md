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
`draft: true` 的文章不出现在列表里，但可以通过直链访问。

## Docker 部署

```bash
docker compose up -d --build
```

`docker-compose.yml` 已把 `targets.json`、`content/` 只读挂进容器，SQLite 数据落在 `./data`：

- 改 `targets.json` 后重启容器即可生效：`docker compose restart`
- 历史数据在宿主机的 `./data/availability.sqlite`

## 自检

```bash
npm run verify        # = typecheck + check:docker + check:unit
npm run check:unit    # 凭据与会话的纯函数断言（86 项，不需要起服务）
npm run check:e2e     # 真实起服务、真实探测、逐项断言（需要先 npm run build）
```

`check:unit` 用临时数据目录跑，断言的是口令校验、`token_version` 迁移、会话签名与
`next` 逃逸面等纯逻辑——包括「签名长度不对不能抛异常」这类在 HTTP 层很难稳定复现的情形。

`check:e2e` 会临时起一个服务（端口 3997）并写入独立的数据目录，跑完自动清理。
它断言的是真实行为，而不是 mock：未登录是否被拦、登录能否通过、畸形 cookie 会不会打成 500、
改密是否只踢掉其他设备、停用是否立刻生效，以及探测的三种状态、失败点是否不记录延迟、曲线是否真的渲染出来。

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
