# 个人站（包含内网可用性面板）

一个 Fastify + TypeScript 单进程站点：

- **事情分享**：`content/` 下的 Markdown 文件，带 frontmatter，服务端渲染文章列表与详情页；
- **内网业务系统可用性**：服务端按固定间隔探测 `targets.json` 里的地址，把每次结果写进 SQLite，面板展示当前状态、可用率、延迟、连续可用时长、状态时间线，以及整体可用率曲线与各系统延迟曲线。

一台机器、一个容器、一个 SQLite 文件即可运行。曲线是服务端渲染的内联 SVG，不依赖任何图表库，禁用 JS 也能看。

面板的**数值每 30 秒自动刷新**；**曲线随页面刷新更新**（曲线不引入前端图表库，所以不做客户端重绘）。

## 本机运行

```bash
npm install
cp .env.example .env        # 可选，不改也能用默认值
npm run dev                 # 开发模式，改代码自动重启
```

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
npm run typecheck     # 类型检查
npm run check:docker  # 校验 .dockerignore 后构建上下文是否完整
npm run check:e2e     # 真实起服务、真实探测、逐项断言（需要先 npm run build）
```

`check:e2e` 会临时起一个服务（端口 3997）并写入独立的数据目录，跑完自动清理。
它断言的是真实行为，而不是 mock：三种状态是否都能出现、失败点是否不记录延迟、曲线是否真的渲染出来。

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
| `DATABASE_PATH` | `./data/availability.sqlite` | 历史库位置 |
| `PROBE_INTERVAL_SECONDS` | `60` | 探测间隔 |
| `PROBE_TIMEOUT_MS` | `5000` | 单次请求超时 |
| `PROBE_RETENTION_DAYS` | `30` | 历史保留天数，超期自动清理 |
| `SITE_TITLE` / `SITE_DESCRIPTION` | — | 站点标题与描述 |

## 接口

| 路径 | 说明 |
| --- | --- |
| `/` | 首页：最近分享 + 可用性摘要 |
| `/posts`、`/posts/:slug` | 分享列表与详情 |
| `/tags/:tag` | 按标签筛选 |
| `/status` | 完整可用性面板 |
| `/api/status` | 面板数据 JSON（前端每 30 秒拉一次） |
| `/healthz` | 健康检查 |

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
