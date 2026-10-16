# 现有文章的模型与契约（为「网页上写、改、发文章」提供事实基础）

- 票：issue #31（`wayfinder:research`）
- 调研范围：`src/content.ts`、`src/views.ts`、`src/server.ts`、`src/auth.ts`、`src/config.ts`、
  `README.md`、`Dockerfile`、`docker-compose.yml`、`package.json`、`content/`、`scripts/`
- 结论均标注来源文件与行号；查不到的写「未找到」，不做推测。
- 说明：本仓库 `docs/` 现有约定是**扁平**的决定类文档（`docs/*-decision.md`）加 `docs/adr/`。
  本次研究笔记没有既有同类目录，故新建 `docs/research/`，并按票面要求落在这个路径下。

---

## 0. 事实速览

| 项 | 事实 | 来源 |
| --- | --- | --- |
| front-matter 解析 | 第三方库 `gray-matter@4.0.3`（底层 `js-yaml@3.15.2`），**不是自研** | `package.json:31`；`src/content.ts:8`；`node_modules/gray-matter/package.json` |
| 正文渲染 | `markdown-it@15.0.2`，`html:false` / `linkify:true` / `typographer:true` | `package.json:32`；`src/content.ts:26-30` |
| 内容目录 | `config.contentDir` = `CONTENT_DIR` 或 **`./content`**（相对 `process.cwd()`） | `src/config.ts:172`，`src/config.ts:53-55` |
| 支持字段 | `slug` / `title` / `date` / `summary` / `tags` / `draft`，**只有这 6 个** | `src/content.ts:12-19`；`src/content.ts:85-102` |
| 文件发现 | 只扫**顶层一层**，只收 `.md` / `.markdown` | `src/content.ts:108-111` |
| 排序 | `date` 字符串倒序；**无分页** | `src/content.ts:131`；全仓 grep「分页/pagination/page=」未找到内容侧实现 |
| 草稿过滤层 | 内容层（`listPosts()` 出口），两张页面都间接依赖它 | `src/content.ts:131`，`src/content.ts:134-136` |
| 图片 | 无任何处理，Markdown 原文直接进 `src` | `src/content.ts:100`；`node_modules/markdown-it/dist/markdown-it.mjs:832-836` |

---

## 1. front-matter：字段、缺省值、解析方式、draft 语义

### 1.1 解析方式：库解析，手写字段归一

`src/content.ts:82` 调用 `matter(raw)`（`gray-matter`，`src/content.ts:8` 导入），
得到 `parsed.data`（任意键值对象）与 `parsed.content`（正文，`src/content.ts:86`）。

字段**不做 schema 校验**：`parseFile()` 逐字段从 `data` 里取值，
未知的 front-matter 键（例如 `cover:`、`description:`）**被直接丢弃**，不进入 `Post`。
证据：`PostMeta` 只声明 6 个字段（`src/content.ts:12-19`），`parseFile()` 的返回对象只写这 6 个
（`src/content.ts:89-102`），没有任何 `...data` 透传。

gray-matter 底层是 js-yaml，会按 YAML 隐式类型解析标量。实测（本仓库已安装版本）：

```
date: 2026-01-01   → Date 对象（instanceof Date === true）
date: "2026-01-01"  → 字符串
tags: [a, b]        → 数组
tags: "a, b，c"     → 字符串（由 toTags 再切分）
```

### 1.2 字段表（含缺省值）

| 字段 | 类型 | 缺省值 / 缺省规则 | 来源 |
| --- | --- | --- | --- |
| `slug` | string | 空或非字符串时取**文件名**去掉日期前缀：`slugFromFile()` 去掉扩展名，再 `.replace(/^\d{4}-\d{2}-\d{2}[-_]/, '')` | `src/content.ts:85`，`src/content.ts:39-44` |
| `title` | string | 空时用 `slug.replace(/[-_]/g, ' ')`（连字符/下划线换空格） | `src/content.ts:91-94` |
| `date` | string(ISO 日期) | `toIsoDate(data.date, stat.mtimeMs)`：front-matter 的 `Date` 或可解析字符串 → `YYYY-MM-DD`；否则**回落到文件 mtime** | `src/content.ts:95`，`src/content.ts:46-55` |
| `summary` | string | 空时 `deriveSummary(body)`：去代码块/图片/链接语法与标记字符、压空白，**超 120 字截断加 `…`** | `src/content.ts:96-97`，`src/content.ts:67-77` |
| `tags` | string[] | 数组→逐项 `String().trim()` 去空；字符串→按 `/[,，]/` 切分再 trim；其他→`[]` | `src/content.ts:98`，`src/content.ts:57-65` |
| `draft` | boolean | **严格 `data.draft === true`**：`"true"` 字符串、`1`、`yes` **都不算**草稿 | `src/content.ts:99` |

派生字段（非 front-matter，写入路径也必须知道它们不是持久化字段）：

| 派生字段 | 计算 | 来源 |
| --- | --- | --- |
| `html` | `md.render(body)`，`body = parsed.content.trim()` | `src/content.ts:100`，`src/content.ts:86` |
| `readingMinutes` | `Math.max(1, Math.round(words / 400))`，`words` = 正文去掉所有空白后的字符数（**按字符，不按词**） | `src/content.ts:87`，`src/content.ts:101` |

### 1.3 slug 的细节与陷阱

- front-matter 的 `slug` 优先，但**只做 `.trim()`**：不去空格、不转小写、不做 URL 编码
  （`src/content.ts:85`）。实测 `slug: "  My Slug "` → `"My Slug"`。
- 文件名前缀只认 `YYYY-MM-DD-` 或 `YYYY-MM-DD_`（`src/content.ts:43`）。仓库两份真实样本正好命中：
  `content/2026-02-18-why-single-process.md` → `why-single-process`，
  `content/2026-02-20-uptime-metrics.md` → `uptime-metrics`。
- **同名 slug 无去重、无冲突处理**：`getPost()` 用 `find()` 在已排序列表里取**第一个**
  （`src/content.ts:135`），所以重复 slug 时胜出的是 `date` 较大的那篇（`date` 相同则不确定，见 §2.3）。
  列表页会把两个同名 slug 渲染成两张指向同一 URL 的卡片。既有实现没有任何「slug 唯一性」检查
  （`src/content.ts` 全文无 `Set`/重复校验）——网页化新增「创建文章」时必须自己补。

### 1.4 draft 的实际语义与过滤层

- **过滤发生在内容层的出口**：`listPosts()` 最后一步 `.filter((p) => !p.draft)`（`src/content.ts:131`）。
- `getPost()` 只从 `listPosts()` 的结果里找（`src/content.ts:134-136`），所以**草稿详情页是 404**，
  不是「可以凭链接访问」。这条有 README 明文与历史记录：`README.md:220-227`
  （旧 README 曾写「可通过直链访问」，实测 404，2026-10-15 改的是文档而不是实现）。
- 列表页与首页都调用 `listPosts()`：`src/server.ts:220`（首页）、`src/server.ts:225`（`/posts`）、
  `src/server.ts:230`（标签页先 `listPosts()` 再按 tag 过滤）。因此草稿不出现在这三处。

> ⚠ **唯一过滤点**：`src/content.ts` 里对草稿的过滤只出现一次，即 `listPosts()` 的
> `src/content.ts:131`。首页、`/posts`、`/tags/:tag`、`/posts/:slug` 四条路径全部（直接或间接）经过它，
> 所以 README 的「不出现在任何列表里 + 直链 404」成立。
> 推论（对网页化的要求）：**任何绕过 `listPosts()` 直接读文件或读库的新代码都会漏出草稿**——
> 这是新增「文章后台/预览」时最容易破的一条。

### 1.5 缓存与失效（会直接影响「网页上写完立刻能不能看到」）

- 进程内 `Map` 缓存，键是**绝对文件路径**，失效条件是 `stat.mtimeMs` 相等
  （`src/content.ts:37`，`src/content.ts:116-123`）。
- 过期条目**永不淘汰**（无 LRU、无删除分支）；文件被删后缓存条目仍在内存里，但不会被引用
  （`src/content.ts:113-129` 只遍历当前 `readdirSync` 结果）。
- **风险点**：若网页写入路径出现「改了内容但 `mtimeMs` 未变」的情形，页面会读旧内容，
  直到进程重启。正常 `writeFileSync` 会更新 mtime，故这不是既有缺陷，但新写入路径需要留意。
- 解析失败的单篇会被 `try/catch` 跳过并打日志（`src/content.ts:125-128`），
  **坏文章不会让整站 500**——这个性质对「网页提交一段坏 front-matter」同样重要。

---

## 2. slug 与 URL 规则、排序、分页、各页面依赖的字段

### 2.1 路由表（含鉴权）

| 路径 | 渲染函数 | 需要的字段 | 来源 |
| --- | --- | --- | --- |
| `GET /` | `homePage(listPosts(), …)` | 列表卡：`slug`/`title`/`date`/`summary`/`tags`；**只取前 4 篇** | `src/server.ts:218-221`；`src/views.ts:175` |
| `GET /posts` | `postsPage(listPosts(), listTags(), …)` | 同上 + 标签栏（`tag`/`count`） | `src/server.ts:223-226` |
| `GET /tags/:tag` | `listPosts().filter(p => p.tags.includes(tag))` | 同上；`heading = 标签：<tag>` | `src/server.ts:228-233` |
| `GET /posts/:slug` | `getPost(slug)` → `postPage` | `title`/`date`/`readingMinutes`/`tags`/`html`/`summary`（`summary` 进 `<meta description>`） | `src/server.ts:235-243`；`src/views.ts:269-284` |
| `GET /about` | `aboutPage` | 无（静态文案里内嵌了 front-matter 示例） | `src/server.ts:257-260`；`src/views.ts:286-312` |
| 未匹配 | `notFoundPage`（404） | 无 | `src/server.ts:265-268`；`src/views.ts:430-433` |

### 2.2 URL 生成与参数解析（不对称，网页化要注意）

- 生成链接时 `encodeURIComponent`：
  `/posts/${encodeURIComponent(post.slug)}`（`src/views.ts:154`）、
  `/tags/${encodeURIComponent(t)}`（`src/views.ts:151`、`src/views.ts:257`、`src/views.ts:271`）。
- 解析参数时：**`/tags/:tag` 做了 `decodeURIComponent`**（`src/server.ts:229`），
  而 **`/posts/:slug` 没有**（`src/server.ts:236` 直接用 `req.params.slug`）。
  Fastify 默认不做 URL 解码，故 slug 含 `%`、非 ASCII、空格时，链接与查询两侧的行为不一致
  （`/tags/运维` 正常，`/posts/中文 slug` 会拿不到）。既有两份样本都是纯 ASCII 短横线 slug，
  所以这条从未被触发。**网页化若允许自由 slug，这里必须一起定。**
- 鉴权：`/posts/:slug`、`/tags/:tag`、`/posts` 都在登录闸门后面，
  匿名白名单是**精确匹配**集合，只有 `/login`/`/healthz`/`/style.css`/`/status.js`/`/chart-path.js`/`/favicon.ico`
  （`src/auth.ts:22-31`，`src/server.ts:149-153`）。`next` 回跳的合法性判定对 `/posts/`、
  `/tags/` 用**前缀匹配**（`src/auth.ts:42-47`）。

### 2.3 排序与分页

- 排序：唯一键 `date`，**倒序**，用纯字符串 `<`/`>` 比较（`a.date < b.date ? 1 : a.date > b.date ? -1 : 0`）；
  `date` 是等长 `YYYY-MM-DD`，故等价于时间序；**`date` 相同时无二级键**，顺序取决于 `Array.prototype.sort`
  的稳定性与 readdir 顺序（现代 V8 的 sort 稳定，但这是实现细节而非本仓库的契约）。来源：`src/content.ts:131`。
  （标签列表另有一处排序用了 `localeCompare`：`src/content.ts:148`，与文章排序无关。）
- 分页：**未找到任何分页实现**。列表页一次性渲染全部文章（`src/views.ts:264`
  是 `posts.map(postCard).join('\n')`，无 slice/offset）；唯一「截断」是首页 `posts.slice(0, 4)`
  （`src/views.ts:175`）。`page=`/`limit`/`offset` 类参数在内容侧全仓 grep 无匹配
  （`src/store.ts:162` 的「按主键分页」是 SQLite 历史库清理，与文章无关）。

### 2.4 列表卡与详情页的渲染细节

- 列表卡 `postCard()`：`<h2><a href="/posts/…">title</a></h2>` + `<time datetime="date">date</time>`
  + `summary` + 标签链接（`src/views.ts:149-159`）。
- 详情页 `postPage()`：`title`、`<time>`、`约 N 分钟`、标签、`<div class="prose">{post.html}</div>`；
  页面 `<title>` 与 `<meta description>` 分别用 `post.title` / `post.summary`（`src/views.ts:269-284`）。
- **所有动态文本过 `escapeHtml()`**（`src/views.ts:12-19`，逐处调用见 `149-159`、`269-284`）；
  正文 HTML 由 markdown-it 在 `html:false` 下生成（`src/content.ts:26-30`）。

---

## 3. 文章内图片：现状与 `public/` 的关系

### 3.1 现状：完全无处理

- 内容层只做 `md.render(body)`，**没有自定义 image 渲染规则、没有路径重写、没有图片目录约定**：
  `src/content.ts` 全文无 `image`/`img`/`public`/`assets` 字样（grep 无匹配）。
- markdown-it 的默认 image 规则只是填 `alt` 再交给通用 `renderToken`（
  `node_modules/markdown-it/dist/markdown-it.mjs:832-836`），`src` 原样保留。
- 因此三种写法都「能用」，语义各不相同——**实测输出**（用本仓库安装的 markdown-it 15.0.2，
  同一组 `html:false`/`linkify:true`/`typographer:true` 选项；复现命令见本节末尾）：

  | Markdown | 渲染结果 |
  | --- | --- |
  | `![a](images/x.png)` | `<img src="images/x.png" alt="a">`（**相对**，浏览器按详情页 URL `/posts/<slug>` 解析 → `/posts/images/x.png`，实际取不到） |
  | `![a](/img/x.png)` | `<img src="/img/x.png" alt="a">`（根相对） |
  | `![a](../public/x.png)` | `<img src="../public/x.png" alt="a">`（原样保留，不规范化） |
  | `![a](https://e.com/x.png)` | 原样保留（外链） |
  | `![a](<my file.png>)` | `src="my%20file.png"`（仅空格被 percent-encode） |
  | `![a](javascript:alert(1))` | **整段不解析**，输出字面文本 `![a](javascript:alert(1))` |
  | `![a](vbscript:x)` / `![a](file:///etc/passwd)` | 同上，整段不解析 |
  | `![a](data:image/png;base64,AAAA)` | **原样输出** `src="data:image/png;base64,AAAA"`（`data:` 在白名单里，见 `BAD_PROTO_RE` / `GOOD_DATA_RE`：`markdown-it.mjs:3531-3562`） |

  说明：「不解析」与「原样输出」这一对差异来自 markdown-it 的 URL 校验规则
  （`md.validateLink`：`BAD_PROTO_RE = /^(vbscript|javascript|file|data):/`，命中后再看 `GOOD_DATA_RE`，
  `markdown-it.mjs:3531`、`markdown-it.mjs:3560-3562`）。注意 image 令牌的渲染规则本身
  不调用 `validateLink`（`markdown-it.mjs:832-836` 只有 alt 填充 + `renderToken`），
  校验发生在解析阶段（`markdown-it.mjs:2661-2662` 附近的 image 解析器）。
  对本仓库的实际影响：正文是**自己写的**（`src/content.ts:27` 的注释也这么写），
  所以内联 `data:` 图片可用而不是漏洞；详情页也没有 CSP 响应头（`src/server.ts` 全文无 `content-security-policy`）。

  上表与 §1.1 的 gray-matter 实测，用仓库已安装的依赖复现（`node -e`，在仓库根执行）：

  ```js
  // 图片/HTML 渲染
  const MarkdownIt = require('markdown-it')
  const md = new MarkdownIt({ html: false, linkify: true, typographer: true })
  console.log(md.render('![a](data:image/png;base64,AAAA)'))  // 原样输出
  console.log(md.render('![a](javascript:alert(1))'))         // 整段不解析
  console.log(md.render('<img src=x onerror=1>'))             // 转义为文本

  // front-matter
  const matter = require('gray-matter')
  const r = matter('---\ndate: 2026-01-01\ndraft: true\n---\nbody')
  console.log(r.data.date instanceof Date, r.data.draft)      // true true
  ```

- `content/` 两份真实样本里**没有任何图片引用**（grep `!\[`/`.png`/`.jpg`/`.webp`/`../` 在 `content/`
  下无匹配）。所以「文章内图片现在怎么引用」在事实层面是：**没有先例，也没有约定**。

### 3.2 `public/` 与 `CONTENT_DIR` 的关系：平级、无关

- `public/` 是静态资源根，固定**相对 `process.cwd()`**，**不可用环境变量覆盖**：
  `publicDir: resolveFromRoot('./public')`（`src/config.ts:173`，`resolveFromRoot` 见 `src/config.ts:53-55`），
  由 `@fastify/static` 挂在 `/` 前缀、`maxAge: '1h'`（`src/server.ts:136-141`）。
  目前 `public/` 只有 `chart-path.js`、`status.js`、`style.css`（目录列表）。
- `CONTENT_DIR` 只被内容层用于读 Markdown（`src/content.ts:107-111`），**与 `public/` 没有任何交集**：
  没有任何代码把 `content/` 下的文件映射成静态 URL，也没有把图片从内容目录搬到 `public/` 的逻辑。
- 落地结论：**当前唯一走得通的站内插图写法是：先把图片放进 `public/`，再在 Markdown 里写根相对路径
  `/xxx.png`**（或直接写外部 URL）。但要注意闸门：匿名白名单 `PUBLIC_PATHS` 是**精确匹配**的 6 个路径
  （`src/auth.ts:22-31`），**图片路径不在其中**，因此未登录用户取不到图片——而文章 URL 同样要求登录，
  所以「已登录读者能看图」是成立的；真正受影响的是任何未来想做「公开可分享的文章/图片」的场景。
- `Dockerfile` 把 `public` 拷进镜像（`Dockerfile:28`），`content/` 不进镜像、靠 compose 挂载
  （`Dockerfile` 无 `COPY content`）。

### 3.3 部署侧的硬约束（会直接决定「网页上发文章」是否可行）


`docker-compose.yml` 把内容目录**只读**挂进容器：

```yaml
volumes:
  - ./targets.json:/app/targets.json:ro
  - ./content:/app/content:ro
```

来源：`docker-compose.yml` 的 `volumes` 段（`content:/app/content:ro`）。
容器内 `WORKDIR /app`（`Dockerfile:19`），故默认 `CONTENT_DIR=./content` 解析到 `/app/content`。
**`:ro` 意味着现有的容器化部署下，进程无法往内容目录写任何文件**——网页创建/发布文章必须改这个挂载
（或改为把文章写进可写的 `./data` 卷，或改走数据库）。README 也把这层关系写成「只读挂进容器」
（`README.md:235`）。

---

## 4. 现有测试对内容契约的断言

先给结论：**内容契约的全部自动化断言集中在 `scripts/e2e-check.mjs`，且都走 HTTP；
`unit-check.mjs` 完全不测内容层**（全仓 grep `slug|draft|listPosts|getPost|listTags|contentDir`
在 `scripts/` 下无匹配）。`chart-check`/`panel-check`/`backup-check`/`leak-check`/`restart-check`/
`probe-integration-check` 都不请求 `/posts`、`/tags/`（grep `/posts`、`/tags/` 只命中 `e2e-check.mjs`
与 `unit-check.mjs:273` 的 `KNOWN_PAGES` 列表）。

| 断言 | 内容契约含义 | 来源 |
| --- | --- | --- |
| `GET /posts` → 200 | 列表页存在 | `scripts/e2e-check.mjs:222` |
| `GET /tags/运维` → 200 | **依赖真实样本里有 `运维` 这个标签** | `scripts/e2e-check.mjs:235-236` |
| `GET /posts/why-single-process` → 200 | **依赖真实文件的 slug**（"why-single-process" 是硬编码） | `scripts/e2e-check.mjs:237-238` |
| 详情页 body 含 `<pre><code` | 正文里代码块必须渲染成 `<pre><code>` | `scripts/e2e-check.mjs:239` |
| 未登录访问 `/tags/运维`、`/posts/why-single-process` → 302 `/login` | 文章 URL 全部在闸门后 | `scripts/e2e-check.mjs:97-103` |
| 注入面 1：列表页出现 `&lt;script&gt;`，且无 `<script>alert(1)</script>`、无 `<img src=x onerror=`、无 `" onmouseover="`、有 `&quot; onmouseover=&quot;` | 标题/摘要/标签必须转义；**载荷必须先证明真的渲染出来**（ADR 0004 立的规矩） | `scripts/e2e-check.mjs:353-363`；`docs/adr/0004-security-assertions-must-prove-the-payload.md` |
| 注入面 2：`/posts/xss-probe` → 200，正文出现 `&lt;script&gt;`，无 `<script>alert(1)</script>` | 正文走 `html:false`；**依赖临时文件 slug `xss-probe`** | `scripts/e2e-check.mjs:366-369` |
| 注入面 3：`/tags/<xss>` → 200 或 404（不 500），h1 里载荷被转义 | 标签路由与「标签：<tag>」标题的转义/健壮性 | `scripts/e2e-check.mjs:373-378` |
| 注入面 4：`/login?next=/posts/xss-probe` 保留在 hidden input；逃逸值回落 `/` | `isKnownPath` 对 `/posts/` 前缀放行 | `scripts/e2e-check.mjs:383-387` |
| 夹具：e2e **直接往真实 `content/` 写文件再删** | 测试假设内容目录 = 仓库 `./content`（e2e **没有设置 `CONTENT_DIR`**，故走默认值） | `scripts/e2e-check.mjs:344-350`（写）、`scripts/e2e-check.mjs:407`（`finally` 删除）、`scripts/e2e-check.mjs:61-74`（spawn env 无 `CONTENT_DIR`） |
| `KNOWN_PAGES` 单元断言 | `/`、`/status`、`/posts`、`/about` 属已知页 | `scripts/unit-check.mjs:273` |

**没有测试**（网页化会失去回归保护的点）：slug 生成/日期前缀剥离、`date` 回落 mtime、
`summary` 派生与 120 字截断、`tags` 的字符串/数组两种形态、`draft` 过滤（**全仓无一条草稿断言**）、
排序、首页只取 4 篇、无分页、图片引用。

---

## 5. 网页化之后：必须保持 vs 可以变

### 5.1 必须保持（有代码或文档层的硬依赖，破坏即回归）

1. **老 URL 不能断**：`/posts/:slug` 与 `/tags/:tag` 必须继续按 slug / 标签名解析
   （`src/server.ts:228-243`；`scripts/e2e-check.mjs:235-238` 直接硬编码了
   `/posts/why-single-process` 与 `/tags/运维`）。已发布文章的 slug 一旦被网页端改写，
   老链接、测试、以及任何外部引用同时失效。
2. **slug 的推导规则向后兼容**：`content/2026-01-01-hello.md` → `hello`
   （`src/content.ts:39-44`；`README.md:218`）。网页新建文章时若不写 slug，
   必须沿用「文件名去日期前缀」或等价地落到同一个 slug 上。
3. **front-matter 仍是唯一的持久化契约**（至少在一段过渡期内）：`title`/`date`/`tags`/`summary`/`draft`
   六个键的语义与缺省值必须保持（§1.2），并且**未知键会被丢弃**这一事实要求网页编辑器
   要么只写这 6 个键，要么先扩展 `parseFile()` 的读写两侧（`src/content.ts:12-19`、`89-102`）。
4. **`draft: true` 的语义**：不出现在任何列表，**直链也 404**（`src/content.ts:131`、`134-136`；
   `README.md:220-227`）。网页化最容易在这一条上失守——「预览草稿」是 README 明确点名的**新特性**
   （`README.md:226-227`），不能顺手当成 bug 修掉。注意 `draft` 只认严格 `=== true`（`src/content.ts:99`），
   网页端提交 `"true"` 字符串会静默变成「已发布」。
5. **标签页与计数**：`/tags/:tag` 按 `tags.includes(tag)` 过滤、标签栏 `tag + count` 由
   `listTags()` 按出现次数倒序给出（`src/server.ts:228-233`；`src/views.ts:251-258`；`src/content.ts:139-149`）。
6. **两个渲染层的安全性质**：
   - 正文必须继续由 markdown-it 在 `html:false` 下渲染（`src/content.ts:26-30`），e2e 的
     注入面 2 直接钉住（`scripts/e2e-check.mjs:366-369`）；
   - 标题/摘要/标签必须继续过 `escapeHtml()`（`src/views.ts:12-19`），e2e 注入面 1/3 钉住
     （`scripts/e2e-check.mjs:353-363`、`373-378`）。
   - 引用 ADR 0004 的硬规矩：新增安全断言**必须先证明载荷出现在页面上**。
7. **单篇坏内容不拖垮整站**：解析失败只跳过该篇并打日志（`src/content.ts:125-128`）。
   网页提交非法 front-matter 时同样不能 500。
8. **页面对登录闸门的位置不变**：文章列表/详情/标签页都在闸门后（`src/auth.ts:22-31`；
   `scripts/e2e-check.mjs:97-103`）；`/healthz` 必须继续匿名（`README.md:350`）。
9. **列表页与详情页的字段来源不变**：尤其 `summary` 既上列表卡也进 `<meta description>`
   （`src/views.ts:156`、`src/views.ts:283`），首页只取前 4 篇（`src/views.ts:175`）。
10. **e2e 夹具依赖真实内容目录**：测试往 `content/` 写临时 `.md`
    （`scripts/e2e-check.mjs:344-350`，且未设 `CONTENT_DIR`），若网页化后内容目录改到别处
    （如数据库或 `data/`），这些断言与夹具必须同步改，否则「全绿」是假的。

### 5.2 可以变（当前没有依赖，改动代价低）

1. **存储位置与形态**：现有实现只认「`CONTENT_DIR` 下的顶层 `.md` 文件」
   （`src/content.ts:107-111`）。改成 SQLite 表、或改成 `content/<slug>/index.md` 这类子目录布局，
   只需要重写内容层——路由和视图只依赖 `Post` 对象（`src/views.ts:6` 只 import 类型）。
   代价是 §5.1 第 10 条（e2e 夹具）要一起改。
2. **slug 的唯一性与合法性策略**：现在完全没有（§1.3），可以新增校验、小写化、保留字、长度上限。
   收紧的唯一约束是 §5.1 第 1、2 条：不能改动已发布文章的现有 slug。
3. **`/posts/:slug` 的参数解码**：现在与 `/tags/:tag` 不对称（§2.2），
   补 `decodeURIComponent` 属于纯修复，但要把 URL 生成侧一起对齐。
4. **分页/排序二级键**：完全没有分页（§2.3），date 相同无二级键。
   可加 `?page=`、可加 `slug` 或文件名的二级排序键；会影响 `/posts` 的 HTML 形状，
   但现有 e2e 只断言 200（`scripts/e2e-check.mjs:222`），不钉 HTML。
5. **未知 front-matter 键**：现在被丢弃（§1.1）。要支持封面图/描述/作者等，
   需要同时改 `PostMeta`（`src/content.ts:12-19`）与 `parseFile()`（`src/content.ts:89-102`）两侧。
6. **图片方案**：现状无约定（§3.1）。可自由选择「写进 `public/` + 根相对路径」「新增专用图片路由」
   「上传后改写 Markdown 链接」等；但也意味着**要同时解决两件事**：
   (a) 图片 URL 如何通过 `PUBLIC_PATHS` 的**精确匹配**白名单（`src/auth.ts:22-31`），
   (b) 容器内 `content` 卷是 `:ro`（`docker-compose.yml`）——写入侧要么换卷，要么写进 `data/`。
7. **`readingMinutes` 口径**：现在是「去空白后的字符数 / 400」（`src/content.ts:87`、`101`），
   对中文大致合理，可改；只有详情页展示依赖它（`src/views.ts:277`），无测试钉住。

---

## 6. 查不到 / 未有定论的项（如实记录）

- **文章内图片的既有用法**：`content/` 两份样本无任何图片引用，全仓无图片目录约定，
  无自定义 image 渲染规则（grep 无匹配）。**未找到**任何先例。
- **`CONTENT_DIR` 的文档**：`src/config.ts:172` 支持该环境变量，但 `.env.example` **没有列出它**
  （`.env.example` 的 18 个键里无 `CONTENT_DIR`），`README.md` 的环境变量表也未提及，全仓 grep `CONTENT_DIR`
  在 `*.yml`/`*.json`/`*.md` 下无匹配。默认值 `./content` 只在源码里。
- **`draft` 的测试**：全仓**未找到**任何针对草稿过滤的断言（`scripts/` 下 grep `draft` 无匹配）。
- **分页**：全仓**未找到**内容侧分页实现或参数。
- **slug 唯一性/冲突处理**：**未找到**任何校验（`src/content.ts` 无重复检测）。
- **写入路径**：仓库里**未找到**任何写 `content/` 的**产品代码**——只有
  `scripts/e2e-check.mjs:346` 的测试夹具会写。内容目录对进程而言目前是纯只读输入。
