# 手写 cookie + SSR 表单下的 CSRF 最小防护（研究笔记）

> **下游已定（2026-10-16，票 [#25](https://github.com/Lkyloveaw/lkyloveaw-home/issues/25) 已关）**：
> 本笔记的最小集被**取满配**（L1+L2+L3），且两处按本仓取舍做了修订——
> 期望 origin **不回退** `req.headers.host`（`SITE_ORIGIN` 缺失即拒绝启动）、
> `trustProxy` 改默认 `false`。落地方案见 [`docs/write-path-auth-decision.md`](../write-path-auth-decision.md) §1 / §3。
> 本文其余内容与全部证据保持原样。

- 票：issue #28（`wayfinder:research`），父任务「网页上写、改、发文章」的写路径票要先拿这张表。
- 问题：在**不引 `@fastify/cookie`、无构建步骤、站点还是 HTTP、写接口是普通表单 POST** 的前提下，
  SameSite=Lax / Origin·Referer 校验 / 同步器 token 各自能挡什么，最小可行组合是什么。
- 证据口径：规范原文（WHATWG / IETF）、厂商一手文档（Chromium、Fastify、Node）、OWASP Cheat Sheet。
  逐条带链接；**没有实测浏览器行为**（本机没跑真机验证），凡是规范推断的都标出来。
- 说明：本仓库 `docs/` 既有约定是扁平的决定类文档（`docs/*-decision.md`）+ `docs/adr/`。
  按票面要求落在 `docs/research/`（与同批的 `article-content-model.md` 同目录）。

---

## 0. 事实速览

### 0.1 本仓现状（行号为当前工作树）

| 项 | 事实 | 来源 |
| --- | --- | --- |
| 会话 cookie 属性 | `Path=/; HttpOnly; SameSite=Lax; Max-Age=…`（`Secure` 只在 `SESSION_COOKIE_SECURE` 打开时追加，默认关） | `src/session.ts:159-176` |
| 会话载荷 | `{uid, exp, pv}`，签名不加密；`HMAC-SHA256(secret, base64url(payload))` | `src/session.ts:20-62` |
| Cookie 解析 | 手写，**同名后者覆盖**（`out[key] = …`） | `src/session.ts:131-142`（覆盖在 `:139`） |
| 闸门 | `onRequest` 钩子，默认拒绝 + 显式白名单 | `src/server.ts:149-153`；`src/auth.ts:22-47`、`:78-110` |
| 现有写接口 | `POST /login`、`POST /logout`、`POST /password`——**全是普通表单 POST，无任何 CSRF 校验** | `src/server.ts:164-214` |
| 现有 GET 路由 | `/`、`/posts`、`/posts/:slug`、`/tags/:tag`、`/status`、`/api/status`、`/about`、`/healthz`、`/login` 全部**只读**（无状态改动） | `src/server.ts:157-263` |
| 表单体解析 | 自写 `application/x-www-form-urlencoded` 解析器（不引 `@fastify/formbody`） | `src/server.ts:74-81`、`:122-134` |
| `trustProxy` | **`true`** | `src/server.ts:112` |
| 部署现状 | 目标机**没有 nginx/caddy，无反代**；直连 `:3000`；HTTPS 是后续需求 | `docs/deploy-environment.md:121-123` |

### 0.2 三条最关键的结论（后面逐条给证据）

1. **SameSite=Lax 只挡「跨站 + 非安全方法」**，而且挡不住同 registrable domain 的兄弟子域，
   也挡不住忽略该属性的旧浏览器。规范自己写着它「does not offer a robust defense」。
2. **Origin / Referer 校验可用，但必须 fail-closed**：攻击者**能主动把 Origin 变成 `null` 或让 `Referer` 消失**；
   而反代/中间层「可能移除或修改 Origin」。另外本仓 `trustProxy: true` 使 `request.hostname` **可被任意直连客户端伪造**，
   所以「期望 origin」只能来自配置常量或原始 `Host`，不能用 Fastify 派生值。
3. **在不引依赖的前提下，token 最省的形态是「从已签名的会话 token 派生」**：
   `csrf = HMAC(SESSION_SECRET, 'csrf|' + 会话 payload 的 base64url)`。它天然绑定会话、每次登录自动换新、
   **不需要新增 cookie 字段、不需要迁移**，且比 naive double-submit 更强——后者在本仓（HTTP、无 `__Host-`）是被 OWASP 明确劝阻的。

---

## 1. SameSite=Lax 到底挡住哪些跨站写

### 1.1 规范对 Lax 的定义（决定性原文）

RFC 6265bis（`draft-ietf-httpbis-rfc6265bis-latest`，2026-10-15 版，2027-04-18 过期）§5.6.7.1：

> "Same-site cookies in 'Strict' enforcement mode will not be sent along with top-level navigations which are
> triggered from a cross-site document context. … developers may set the SameSite attribute in a 'Lax'
> enforcement mode that carves out an exception which sends same-site cookies along with cross-site requests
> if and only if they are **top-level navigations which use a 'safe' … HTTP method**."

同一节紧接着自我限定：

> "Lax enforcement provides reasonable defense in depth against CSRF attacks that rely on unsafe HTTP methods
> (like POST), but **does not offer a robust defense against CSRF as a general category of attack**:
> attackers can still pop up new windows or trigger top-level navigations in order to create a 'same-site'
> request … Features like `<link rel='prerender'>` can be exploited to create 'same-site' requests without the
> risk of user detection."

检索算法的**精确条件**（§5.8.3）——`same-site-flag` 不是 `None` 且本次请求是 cross-site 时，
只有**四条同时成立**才会带上 cookie：

> "The retrieval's type is 'HTTP'. The same-site-flag is 'Lax' or 'Default'. The HTTP request associated with
> the retrieval uses a 'safe' method. The target browsing context of the HTTP request associated with the
> retrieval is the active browsing context or a top-level traversable."

链接：<https://httpwg.org/http-extensions/draft-ietf-httpbis-rfc6265bis.html>（§5.6.7.1、§5.8.3）

**据此得到的判定**：

| 跨站请求形态（现代浏览器，cookie 显式 `SameSite=Lax`） | cookie 是否发送 | 原因 |
| --- | --- | --- |
| 跨站 `<form method="POST">` 提交 | **不发** | 非安全方法，四条条件里的第三条不成立 |
| 跨站顶层导航 `GET`（点外链、`window.location`、`window.open`） | **发** | 顶层导航 + safe 方法 |
| 跨站 `GET` 子资源（`<img>`、`<script>`、`<iframe>` 里的请求） | **不发** | 条件四：目标 browsing context 既不是活动上下文也不是顶层可遍历上下文 |
| 跨站 `fetch`/XHR（含 `POST`） | **不发** | 既不是导航，也不是安全方法（若同站则照发） |
| 用户点浏览器刷新按钮触发的重载 | 视原导航判定 | §5.2 明确把「UI 触发的 reload」单独拎出来判 |

### 1.2 「Lax + POST 两分钟宽限」对我们**不适用**（重要）

`SameSite=Lax` 是**显式写进 Set-Cookie** 的（`src/session.ts:164`），不是「没写属性、浏览器替你按 Lax 处理」。
规范 §5.6.7.2 说明这个兼容模式的门槛：

> "'Lax-allowing-unsafe' is **not a distinct value of the SameSite attribute**. Rather, user agents MAY apply
> 'Lax-allowing-unsafe' enforcement **only to cookies that did not explicitly specify a SameSite attribute** …
> SHOULD restrict the enforcement to cookies which were created recently. Deployment experience has shown a
> cookie age of 2 minutes or less to be a reasonable limit."

Chromium 的说法更直白（<https://www.chromium.org/updates/same-site/>）：

> "'Lax + POST' is an intervention for Lax-by-default cookies (cookies that don't specify a `SameSite`
> attribute) … 'Normal' Lax cookies are not sent on cross-site POST requests (or any other cross-site requests
> with a non-idempotent HTTP method such as PUT)."

→ **结论：本仓显式 Lax 的会话 cookie 不会因为「刚登录不到 2 分钟」而在跨站 POST 里被带上。**
这条宽限只影响那些漏写属性的站点。（同页还记录：该 2 分钟窗口是临时干预，计划移除。）

### 1.3 旧浏览器 / 忽略该属性的客户端

caniuse 的 SameSite 条目（<https://caniuse.com/same-site-cookie-attribute>，数据源
<https://github.com/Fyrd/caniuse/blob/main/features-json/same-site-cookie-attribute.json>）的顶注是本条最好的表述：

> "This feature is backwards compatible. Browsers not supporting this feature will simply use the cookie as a
> regular cookie. There is no need to deliver different cookies to clients."

同一份数据里的已知缺口（实测数据，非推断）：

| 客户端 | 状态 | 说明（caniuse notes） |
| --- | --- | --- |
| Opera Mini | **全版本 `n`** | 完全不支持 → cookie 照发 |
| UC Browser for Android | 15.5 起 `n`（更早亦无完整支持） | 同上 |
| IE 11 | 仅 `a`（部分） | 只在 Win10 RS3（2017 Fall Creators Update）及更新版本支持；Win7 等**不支持** |
| Safari（macOS） | 12–14 为 `a` | 12 起部分支持（macOS 10.14 Mojave 之前缺支持） |
| iOS Safari | 12.x 为 `a`，13.0 起 `y` | 另有 bug：`SameSite=None` 与非法值在 iOS 13 之前被当成 `Strict` |
| Edge | 16 起 `y` | 12–14 不支持 |

OWASP 的表述与此一致（<https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html>，"Limitations of SameSite"）：

> "While current mainstream browsers enforce `SameSite=Lax` by default, users on older browsers, embedded
> browsers, or non-mainstream clients may receive cookies that behave as if no `SameSite` value were set.
> **Do not assume all traffic enjoys the protection.**"

### 1.4 「同站不同源」与子域：Lax 不管

HTML 规范定义的是 **site**（不是 origin）（<https://html.spec.whatwg.org/multipage/browsers.html#concept-site-same-site>）：

> "A **site** is an opaque origin or a scheme-and-host. To obtain a site, given an origin origin … If origin's
> host's **registrable domain** is null, then return (origin's scheme, origin's host). Return (origin's scheme,
> origin's host's registrable domain)."
> "Two sites, A and B, are said to be **same site** if … If A's and B's scheme values are different, then return
> false. If A's and B's host values are not equal, then return false."

→ `http://a.example.com` 与 `http://b.example.com`：registrable domain 都是 `example.com`、scheme 相同 ⇒ **same site**，
**Lax cookie 在非安全方法上也会被发送**（§5.8.3 的四条条件只在 cross-site 时才检查）。
→ `http://example.com` 与 `https://example.com`：scheme 不同 ⇒ **cross-site**（这就是 Chromium 说的
「Schemeful Same-Site」，见 <https://www.chromium.org/updates/same-site/> 的 modern behavior 描述；
HTML 规范另有一个 `schemelessly same site` 概念，别混用）。
→ 注意 **端口不参与** site 计算（site 只有 scheme + host）。

OWASP 同样点名：

> "**`SameSite` is scoped to the registrable domain, not the origin.** A cookie set on `app.example.com` with
> any `SameSite` value is still considered 'same-site' when the request originates from `anything.example.com`."

本仓实际影响：站点是单主机部署（cookie 无 `Domain` 属性 ⇒ host-only），当前没有兄弟子域，
所以这条现在是**潜在**风险（日后加子域、或把站点挪到共享父域的域名下就会变成现实风险）。

### 1.5 OWASP 眼里「只靠 SameSite 够不够」

OWASP 给了「SameSite 单独可用」的**全部**前提（"When SameSite May Be Sufficient On Its Own"）：

> - "The application does not share a registrable domain with any host, subdomain, or service you do not fully control.
> - No `GET` (or other safe-method) endpoint in the application performs a state-changing action. All state changes
>   require `POST`, `PUT`, `PATCH`, or `DELETE`.
> - The session cookie is set with `SameSite=Strict`, or `SameSite=Lax` **combined with the `__Host-` prefix** and a
>   strict audit of every `GET` handler.
> - Origin or Referer verification … is in place for defense in depth on state-changing endpoints.
> - You are comfortable excluding users whose browsers do not enforce `SameSite` …"

本仓**不满足**其中两条：cookie 没有（也用不了，见 §3.1）`__Host-` 前缀；也没有 Origin/Referer 校验。
→ 按 OWASP 自己的判据，**不能只靠 SameSite=Lax**。

### 1.6 本节的不确定项

- **`SameSite=Lax` 在真实旧浏览器里的精确行为**只从 caniuse 数据 + OWASP 表述得到，我没在真机/真浏览器上跑过。
- §5.8.3 里「target browsing context 是 active browsing context 或 top-level traversable」对
  `window.open` 出的新窗口、`<link rel=prerender>` 预渲染的具体落点，我没做浏览器实测，只按规范文字推断。

---

## 2. Origin / Referer 校验：可行性与反代穿越后的可靠性

### 2.1 什么时候**有** Origin，什么时候**没有**

Fetch 标准 §3.2（<https://fetch.spec.whatwg.org/#origin-header>）给的是总则：

> "The `Origin` header … is used for all HTTP fetches whose request's response tainting is 'cors', as well as
> those where request's method is neither `GET` nor `HEAD`. **Due to compatibility constraints it is not included
> in all fetches.**"

具体赋值算法（<https://fetch.spec.whatwg.org/#append-a-request-origin-header>，逐条关键分支）：

> "Otherwise, if request's method is neither `GET` nor `HEAD`, then: If request's mode is not 'cors', then switch
> on request's referrer policy:
> - 'no-referrer' → **Set serializedOrigin to `null`.**
> - … 'strict-origin-when-cross-origin' → If request's origin is a tuple origin, its scheme is 'https', and
>   request's current URL's scheme is not 'https', then **set serializedOrigin to `null`.**
> - 'same-origin' → If request's origin is not same origin with request's current URL's origin, then set
>   serializedOrigin to `null`."

**推导出的三条硬事实**（都直接落在我们的表单 POST 上）：

1. **同源普通表单 POST 会带 Origin**（方法是 POST ⇒ 进上面那个分支；默认 referrer policy 下不会被置 null）
   ⇒ 「Origin 与期望 origin 相等」这个判据在正常路径上**是能通过的**，不会误拒。
2. **攻击者可以主动把自己的 Origin 抹成 `null`**：在攻击页里写 `<meta name="referrer" content="no-referrer">`
   （referrer policy 作用于**发起方文档**），跨站 POST 就会带 `Origin: null`。
   同理，sandbox iframe 之类的 opaque origin 也是 `null`。
3. **HTTPS→HTTP 降级场景下 Origin 也会是 `null`**（上面第二条分支）。对本仓（HTTP 站点）而言，
   从 HTTPS 攻击页发起的跨站 POST 拿到的是 `Origin: null`——**看起来像"没有来源"**。

RFC 6454（<https://www.rfc-editor.org/rfc/rfc6454.html>）§7.3 同时提醒「有 Origin」本身不是保证：

> "The user agent **MAY** include an Origin header field in any HTTP request."
> "Whenever a user agent issues an HTTP request from a 'privacy-sensitive' context, the user agent **MUST** send
> the value 'null' in the Origin header field."

补充：`Origin` 与 `Referer` 都在 Fetch 的 **forbidden request-header** 名单里
（<https://fetch.spec.whatwg.org/#forbidden-request-header>：`… Host` / `Keep-Alive` / `Origin` / `Referer` / `Set-Cookie` …，
"These are forbidden so the user agent remains in full control over them."）——
所以**页面脚本改不了它**（这正是 OWASP 说它「cannot be altered programmatically」的依据）。
但注意这句只对浏览器成立：**非浏览器客户端可以随意伪造任何头**（对本仓无所谓：伪造头也得先有合法会话 cookie，那是认证问题不是 CSRF 问题）。

### 2.2 Referer 的默认表现（本仓没有设 `Referrer-Policy` 响应头）

MDN（<https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Referrer-Policy>）对默认值的表述：

> "**strict-origin-when-cross-origin (default)** … Send the origin, path, and query string when performing a
> same-origin request. For cross-origin requests **send the origin (only)** when the protocol security level stays
> same (HTTPS→HTTPS). **Don't send the Referer header to less secure destinations (HTTPS→HTTP)**."
> "Note: This is the default policy if no policy is specified…"

→ 判据可以只用 **origin 部分**（`scheme://host[:port]`），不要依赖 path；
→ **HTTPS→HTTP 时 Referer 会完全没有**，而 HTTP→HTTP 的跨站来源只会看到对方 origin（例如 `http://evil.example/`）——
对本仓（HTTP 站点）来说，跨站 POST **通常两者至少有其一**，但**都不保证**（见 §2.1）。

OWASP 对「缺失怎么办」给了明确答案（"Checking the Referer Header if Origin Header Is Not Present"）：

> "If neither header establishes a trusted source origin, **reject the protected state-changing request** unless
> another configured CSRF defense, such as a valid CSRF token, succeeds. **Missing headers and `Origin: null` are
> not evidence of a same-origin request.**"
> "Do not bypass CSRF validation merely to preserve compatibility with missing or `null` source origins."
> 以及目标 origin 的取法里最推荐的一条："**Configure your application to simply know its target origin** … This
> would be the most secure approach as its defined server side, so it is a trusted value."

同时 OWASP 也点名了反代这条风险（同一节）：

> "**Use the `X-Forwarded-Host` header value only from trusted proxies** … Do not trust the header merely because
> it is present."
> "Intermediaries (proxies, gateways, load balancers) **may remove or modify `Origin` and `Sec-*` headers** —
> whether due to privacy filters, network optimizations, or simple misconfiguration — which can break
> fetch-metadata-based protections."

### 2.3 「反代穿越」到底会动到什么

**(a) Origin 本身不是 hop-by-hop 头。** RFC 9110 §7.6.1 定义的 hop-by-hop 机制是「`Connection` 里列出的字段 + 已知需移除的字段」
（<https://www.rfc-editor.org/rfc/rfc9110.html#section-7.6.1>）：

> "…intermediaries SHOULD remove or replace fields that are known to require removal before forwarding … This
> includes but is not limited to: `Proxy-Connection`, `Keep-Alive`, `TE`, `Transfer-Encoding`, `Upgrade` …"

`Origin` 不在这份名单里 ⇒ **规范意义上它是端到端字段，正常反代会原样转发**。
但「正常转发」是配置事实，不是规范保证（§2.2 的 OWASP 警告），所以**缺失时必须 fail closed，而不是放行**。

**(b) `Forwarded` / `X-Forwarded-*` 不可信。** RFC 7239 §8.1（<https://www.rfc-editor.org/rfc/rfc7239.html#section-8.1>）：

> "The 'Forwarded' HTTP header field **cannot be relied upon to be correct**, as it may be modified, whether
> mistakenly or for malicious reasons, by **every node on the way to the server, including the client** making the request."
> "…the chain of IP addresses listed before the request came to the proxy cannot be trusted."

**(c) 本仓的具体坑：`trustProxy: true` 让派生 host 可被伪造。** 这不是推断，是装了的那份 Fastify 的源码
（`node_modules/fastify/lib/request.js:122-136`）：

```js
host: {
  get () {
    const socket = this.raw.socket
    if (this.headers['x-forwarded-host'] && socket != null && proxyFn(socket.remoteAddress, 0)) {
      return getLastEntryInMultiHeaderValue(this.headers['x-forwarded-host'])
    }
    return this.headers.host ?? this.headers[':authority'] ?? ''
  }
}
```

`trustProxy: true` ⇒ `proxyFn` 恒真 ⇒ **任何能直连 `:3000` 的客户端只要加一个 `X-Forwarded-Host` 就能决定
`request.hostname`**（`protocol` 同理看 `x-forwarded-proto`）。Fastify 文档自己也警告
（<https://fastify.dev/docs/latest/Reference/Server/#trustproxy>）：

> "⚠️ Security: These values are derived from socket/forwarding metadata and must be treated as **untrusted input**
> unless your proxy chain is explicitly trusted and validated. Do not use them directly for authorization or other
> security-sensitive decisions without explicit validation."
> "If a request contains multiple `x-forwarded-host` or `x-forwarded-proto` headers, it is only the **last** one that
> is used to derive `request.hostname` and `request.protocol`."

因为目标机当前**没有反向代理**（`docs/deploy-environment.md:121-123`），`trustProxy: true` 现在只有坏处没有好处。
→ **期望 origin 绝不能取自 `req.hostname` / `req.protocol`**：
优先**配置常量**（`SITE_ORIGIN` 之类，OWASP 首推）；退一步用**原始 `req.headers.host`** 并做白名单精确匹配
（`Host` 由 HTTP/1.1 客户端可控，但没有代理时它就是权威主机名，且比 `X-Forwarded-Host` 少一层可伪造）。

### 2.4 `Sec-Fetch-Site`（Fetch Metadata）在当前 HTTP 部署下**用不了**

W3C Fetch Metadata 规范（<https://www.w3.org/TR/fetch-metadata/> §2.3 等）里每个 `Sec-Fetch-*` 的设置算法
第一行都是断言：

> "To set the `Sec-Fetch-Site` header for a request r: **Assert: r's current URL is a potentially trustworthy URL.**"

OWASP 把这条落成实践口径：

> "Your application must be served over trustworthy URLs. Fetch Metadata request headers are **only sent to
> potentially trustworthy URLs**. In practice, this includes `https`, `wss`, `file`, and `localhost` (including
> `127.0.0.0/8` and `::1/128`)."

站点是 `http://10.0.0.226:3000` 这类**非 localhost 的 HTTP 地址** ⇒ 浏览器**不会发** `Sec-Fetch-*`
（高置信：规范断言 + OWASP 明文；但我**没有真机实测**）。
→ **Fetch Metadata 这条现代路线要等 HTTPS 之后才能用**，现在不能写进方案。这也顺带说明：
OWASP 说这套东西「简单可靠、98% 覆盖」，前提是 HTTPS；我们不在这个前提里。

### 2.5 本节结论

| 判据 | 可行性 | 可靠性风险 | 处理 |
| --- | --- | --- | --- |
| `Origin` 与期望 origin **精确相等**（`scheme://host[:port]`，禁止前缀/包含匹配） | 同源表单 POST 必带，正常路径零误拒 | 攻击者可造 `Origin: null`；降级/沙箱也是 `null`；中间层可能改写 | **`null`/缺失一律拒绝**（fail closed），拒绝要显眼（403 + 日志） |
| `Origin` 缺失时回退 `Referer` 的 origin 精确相等 | 可用 | HTTPS→HTTP 时 Referer 也没有；有隐私工具会剥 | 同上，fail closed |
| 期望 origin 的取法 | 配置常量最稳 | `request.hostname`（`trustProxy: true`）**可被任意直连客户端伪造** | 用配置常量；`trustProxy` 改回 `false` 或收窄成具体 IP/CIDR |
| 反代上线后 | 需要复核 | 反代若改写/剥头会**误拒**（表现为「写操作全 403」，显眼，符合本仓取舍）；若反代改写 Host 而我们用 Host 推导，则会**误放行**（危险） | 反代必须**覆盖**（而非追加）`X-Forwarded-Host/Proto`；上线时把 `SITE_ORIGIN` 显式配上 |
| `Sec-Fetch-Site` | **当前不可用（HTTP）** | — | 等 HTTPS；届时作为 L2 的补充，不可替代 fallback |

---

## 3. 同步器 token 的最小实现（无引依赖，绑在无状态签名 cookie 上）

### 3.1 先排除 naive double-submit（本仓条件下它明确不行）

OWASP 对 naive double-submit 的警告（"Naive Double-Submit Cookie Pattern (DISCOURAGED)"）：

> "The Naive Double-Submit Cookie pattern is **bypassable by an attacker who can write cookies on the target
> domain** (e.g., via a vulnerable sibling subdomain, DNS takeover, or **plaintext-HTTP cookie injection on a
> non-`__Host-` cookie**)."
> "Though the Naive Double-Submit Cookie method is simple and scalable, it remains vulnerable to cookie injection
> attacks…"

而 `__Host-` 前缀在本仓**用不了**，RFC 6265bis §4.1.3.2 要求它必须带 `Secure`：

> "If a cookie's name begins with a case-sensitive match for the string `__Host-`, then the cookie will have been
> set with a **`Secure` attribute**, a `Path` attribute with a value of `/`, and **no `Domain` attribute**."
> "…the following would be accepted **if set from a secure origin** (e.g. 'https://site.example/'), and **rejected
> otherwise**: `Set-Cookie: __Host-SID=12345; Secure; Path=/`"

站点是 HTTP ⇒（a）`__Host-` 会被浏览器直接丢掉；（b）OWASP 点名的「plaintext-HTTP cookie injection」在本仓是**现实威胁**。
→ **不要用 naive double-submit**。要么 HTML 里带 token（synchronizer），要么用 OWASP 的
**Signed Double-Submit**（HMAC + 显式绑会话）。

OWASP 对「怎么绑」的原文（"Signed Double-Submit Cookie (RECOMMENDED)"）：

> "The most secure implementation … **explicitly ties tokens to the user's authenticated session** (e.g., session ID).
> **Simply signing tokens without session binding provides minimal protection and remains vulnerable to cookie
> injection attacks. Always bind the CSRF token explicitly to session-specific data.**"
> "To generate HMAC CSRF tokens (with a session-dependent user value), the system must have: **A session-dependent
> value that changes with each login session** … **A secret cryptographic key** … **A random value for anti-collision purposes**."
> 以及校验伪码："Recompute the HMAC using the current authenticated session, and **compare digests in the same
> representation with a constant-time function**"，"Do not log token values"。

另外两条与本仓直接相关的禁令：

> "**A CSRF token should not be transmitted in a cookie for synchronized patterns.** A CSRF token must not be
> leaked in the server logs or in the URL."
> "It's worth noting that **updating the CSRF token too frequently, such as for each request, is a misconception**
> that assumes it adds substantial security while actually harming the user experience … The 'Back' button
> capability can be hindered by a per-request token."
> "CSRF tokens should be: **Unique per user session. Secret. Unpredictable** (large random value generated by a
> secure method)."

### 3.2 推荐的最省形态：**从会话 token 派生**（零额外 cookie、零迁移）

本仓的「会话」就是那枚签名 cookie（`uid`/`exp`/`pv`，`src/session.ts:20-62`）。
无状态条件下，「服务端已有的会话相关值」就是**服务端自己算出来的会话 payload**，于是：

```
payloadB64 = 会话 token 里 '.' 之前的那段（服务端已验签，见 src/session.ts:81-100）
csrf       = base64url( HMAC-SHA256(SESSION_SECRET, "csrf|" + payloadB64) )
```

- **渲染时**（`GET /status`、`GET /login` 之后的各页面）：闸门已经解析并验签过 cookie，直接把 `csrf`
  塞进每个表单的 `<input type="hidden" name="csrf" value="…">`。
- **校验时**（`POST /password`、以及将来的写接口）：用请求里那枚**已验签**的会话 token 重算 `csrf`，
  与表单里的值**同时长后 `timingSafeEqual`** 比较；不等 → 403 + 显眼日志。
- **为什么满足 OWASP 的「会话绑定」**：HMAC 的 message 是**本次会话独有的** payload（`exp` 每次签发都不同），
  所以 token 与这枚会话强绑定；token 本身只是摘要，**不含 payload 明文**（符合「session ID 不该出现在 token 里」）。
- **为什么不需要额外 cookie**：没有第二枚 cookie 可被注入/覆盖，也就绕开了 §3.1 的 cookie-injection 面。
  这一点在本仓尤其有价值：`parseCookies` 是**同名后者覆盖**（`src/session.ts:139`），
  任何「多一枚可被同域写覆盖的 cookie」的做法都要重新审一遍这个覆盖顺序。
- **旧 cookie 无需迁移**：不新增载荷字段，`verifySession` 的形状校验（`src/session.ts:110-114`）不用改，
  已经下发的 cookie 也不会失效——**这是它比「往 payload 里加一个随机 nonce」更省的地方**。
- **XSS 例外**：OWASP 首页就写着 "Cross-Site Scripting (XSS) can defeat all CSRF mitigation techniques"。
  本仓 `views.ts` 的模板若有注入点，token 一样会被读走——这层不是 XSS 的替代品。

（对照项：OWASP 的 Signed Double-Submit 伪码把 token 放进 cookie 并「Set Cookie without HttpOnly」，
那是给「拿不到服务端会话状态、还要兼容 JS 客户端」的场景。我们 SSR 表单 + 有服务端验签能力，
用 synchronizer 形态更直接，也不需要放开 HttpOnly。）

### 3.3 备选形态与它的代价（供写路径票取舍）

| 形态 | 实现 | 代价 |
| --- | --- | --- |
| **A. 派生式（推荐）** | `HMAC(secret, 'csrf|' + payloadB64)` | 每登录自动换新；无新 cookie；**旧 cookie 不失效**；无法「只作废 token 不作废会话」 |
| B. payload 内随机 nonce | `SessionPayload` 加 `csrf: <random>`，签发时随机 | 需改 `SessionPayload`/`verifySession` 形状校验；**部署那一刻已下发的旧 cookie 缺字段 → 一律判失败 → 用户需重登**（本仓「失败要显眼」，可以接受但要写进发布说明） |
| C. 独立 CSRF cookie（naive double-submit） | 第二枚 cookie + 表单字段相等 | **本仓禁用**：HTTP + 无 `__Host-` → §3.1 明文注入/子域覆盖面 |
| D. 服务端会话表存 token | 建表/内存 Map | 与「无状态签名 cookie」的既有决定（`docs/session-decision.md` §8.2 不建吊销名单）冲突，最贵 |

### 3.4 轮换成本表（这是票面点名要的）

| 触发 | A（派生式）成本 | B（nonce）成本 |
| --- | --- | --- |
| 用户登录 | **0**：payload 的 `exp` 变了 → token 自然变 | 0：签发新 cookie 时生成新 nonce |
| 用户改密 / `--revoke-sessions`（`token_version` 递增） | **0**：`pv` 变 → payload 变 → token 变 | 0 |
| 想让 token 与已有会话解绑（只作废 token） | **做不到**（无状态固有代价；只能换 `SESSION_SECRET`，代价是踢掉所有人） | 做不到（同上） |
| 每次请求轮换 | **不做**（OWASP 明说这是误解，且破坏后退按钮） | 不做 |
| 部署新版本 | **0**（旧 cookie 继续可用） | 一次全体重登（或写兼容分支：缺 `csrf` 字段时降级） |

### 3.5 比较必须是恒定时间，且**先比长度**

Node 文档（<https://nodejs.org/api/crypto.html#cryptotimingsafeequala-b>）：

> "This function compares the underlying bytes … using a constant-time algorithm. This function does not leak
> timing information… This is suitable for comparing HMAC digests or secret values like authentication cookies…"
> "a and b must both be `Buffer`s, `TypedArray`s, or `DataView`s, and they **must have the same byte length. An
> error is thrown if a and b have different byte lengths.**"

本仓已有同款先例：`src/session.ts:96-100` 先比长度再 `timingSafeEqual`（注释记录了长度不等会抛
`ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH`，直接把畸形输入变成 500）。token 校验要照抄这个形状：
**长度先比 → 不等直接判失败（不要抛）→ 相等再 `timingSafeEqual`**。

### 3.6 落点：**不能放在 `onRequest`**

Fastify 生命周期（<https://fastify.dev/docs/latest/Reference/Lifecycle/>）：

```
Incoming Request → Routing → onRequest Hook → preParsing Hook → Parsing → preValidation Hook
                 → Validation → preHandler Hook → User Handler
```

本仓的闸门在 `onRequest`（`src/server.ts:149-153`），那时**表单体还没解析**。
→ **Origin/Referer 校验（只看头）可以留在 `onRequest`**；
→ **token 校验必须放到 `preValidation` / `preHandler`（或各 handler 内部）**，否则读不到表单字段。
（本仓自写的 `application/x-www-form-urlencoded` 解析器在 `src/server.ts:122-134`，`Parsing` 阶段生效。）

其余落点约束（来自 §3.1 的 OWASP 原文）：token **不进 cookie、不进 URL、不进日志**；
token 出现在 HTML 里 ⇒ 建议给带 token 的响应加 `Cache-Control: no-store`
（本仓动态页面目前没有任何缓存头；因为 token 与会话绑定，即使被缓存泄漏，单靠 token 也换不到别人的会话，
但「已登录页面不进共享缓存」本身是应该有的属性）。

---

## 4. 判定表（可直接落成写路径票的验收项）

层级代号：**L1** = 现状 `SameSite=Lax`；**L2** = Origin/Referer fail-closed 校验（非安全方法）；
**L3** = 会话绑定的同步器 token。「✅」= 该层能拦，「⛔」= 该层拦不住。

| # | 攻击向量 | L1 SameSite=Lax | L2 Origin/Referer（fail closed） | L3 会话绑定 token | 建议的层 |
| --- | --- | --- | --- | --- | --- |
| 1 | 跨站表单 POST（现代浏览器，cookie 显式 Lax） | ✅ cookie 不发 → 请求变未认证 | ✅ Origin 是攻击者 origin | ✅ | **L1 已够**；加 L2 作兜底（便宜） |
| 2 | 跨站表单 POST（忽略 SameSite 的旧客户端：Opera Mini 全版本、UC 15.5、IE11 部分、旧 Safari/iOS） | ⛔ 属性被当普通 cookie，照发 | ✅（前提：该请求有 Origin 或 Referer；**IE11 是否在跨站 POST 上发 Origin 未确认**） | ✅ | **必须 L2 或 L3**——只靠 L1 在这一行是假的 |
| 3 | 攻击者主动抹掉来源头（`<meta name="referrer" content="no-referrer">` → `Origin: null`；sandbox iframe → `null`；HTTPS→HTTP 降级 → `Origin: null` / 无 Referer） | ✅（现代浏览器里 cookie 本来就不发，等于没这请求） | ✅ **只有在「null/缺失 = 拒绝」时才成立** | ✅ | L2 **必须 fail closed**；L3 是唯一**不依赖请求头**的层 |
| 4 | 同 registrable domain 的兄弟子域（`evil.example.com` → `example.com`） | ⛔ same-site，cookie 照发（含非安全方法） | ✅ Origin 与「配置的期望 origin」不等（必须精确匹配，禁止前缀/包含） | ✅ | **必须 L2 或 L3**；L1 永远管不了这行 |
| 5 | 状态改动的 `GET`（若将来越界引入） | ⛔ 顶层导航 + safe 方法正是 Lax 的例外 | ⛔（只查 POST 时）；查 GET 也只能靠 Referer（no-cors GET 通常不带 Origin） | ⛔（token 不该进 URL） | **靠设计禁止**：GET 一律只读。本仓当前满足（`src/server.ts:157-263` 全只读） |
| 6 | 登录 CSRF（`POST /login`，此时还没有会话 cookie） | ⛔ 不适用（没有 cookie 可挡） | ✅ 不需要会话即可校验 | ⚠️ 需要 pre-session（额外 cookie + 额外状态） | **L2 是这里最便宜的层**；OWASP 的 pre-session 方案更贵，本仓不建议先做 |
| 7 | 登出 CSRF（`POST /logout`） | ✅ | ✅ | ✅ | 影响低；L1 已够，顺手被 L2 覆盖 |
| 8 | 反代/中间层改写了判定来源（用 `request.hostname`/`protocol` 当期望 origin） | — | ⛔→✅ 取决于取法：`trustProxy: true` 下 `X-Forwarded-Host` 可被**任意直连客户端**伪造 | ✅ | L2 的期望 origin **必须**来自配置常量或原始 `Host`+白名单（§2.3c） |
| 9 | 纯 HTTP 上的网络中间人（可注入 cookie、可读明文） | ⛔ | ⛔ | ⛔（能直接偷会话） | 不在 CSRF 层解决 → **HTTPS**（后续需求）；在此之前**禁用 naive double-submit** |
| 10 | XSS / 同源客户端 CSRF | ⛔ | ⛔ | ⛔ | **无解于本表**（OWASP：XSS 可击穿所有 CSRF 防护） |

---

## 5. 最小可行组合（结论）

**建议落地顺序（也是给写路径票的建议）：**

1. **L1 维持现状**：`SameSite=Lax` 不动（零成本、挡掉绝大多数跨站 POST）。
2. **L2 做掉（本次的最小新增）**：在 `onRequest` 里对**非安全方法**（`POST`/`PUT`/`PATCH`/`DELETE`）做
   fail-closed 的 origin 校验：
   - 有 `Origin` → 必须与**期望 origin**精确相等；`Origin: null` **视为不通过**。
   - 无 `Origin` → 用 `Referer` 的 origin 精确相等。
   - 两者都不可用 → **403 + 显眼日志**（日志内容按本仓口径脱敏，不记 token/口令）。
   - 期望 origin 来源：**配置常量优先**（新增 `SITE_ORIGIN`），缺省回退**原始 `req.headers.host`**；
     **禁止** `req.hostname`/`req.protocol`。顺手把 `trustProxy: true`（`src/server.ts:112`）收窄或关掉。
3. **设计约束**：写操作一律 POST（当前已满足）；任何 GET 都不改状态——这条要写进写路径票的验收。
4. **L3 与写接口一起做**：SSR 表单下成本是「一个 hidden input + 一个 verify 函数」，
   而它是**唯一不依赖请求头、也不依赖浏览器 SameSite 实现**的层。只要写接口包含「发布/删除文章」这类
   真实破坏性动作，就建议 L1+L2+L3 全上；若只想先上最小集合，则 **L1+L2 是可用的最小集**，
   但必须接受判定表第 8 行（中间层改写）与「L2 判据本身依赖两头都在的请求头」这两条残余风险。

**明确不建议的**：naive double-submit；把 token 放进 URL/query；用 `Sec-Fetch-*` 当主判据（当前 HTTP 下不会出现）；
用 `request.hostname` 推导期望 origin。

---

## 6. 建议的回归用例（给写路径票）

1. 正常同源提交（浏览器）→ 2xx/3xx，不被 403。
2. 同源提交但**手工删掉** `Origin` 与 `Referer`（curl）→ 403 且日志显眼（验证 fail closed）。
3. 同源提交但 `Origin: null` → 403。
4. `Origin: http://example.com.evil.com`、`http://evil.com#@example.com` 之类**后缀/包含型**伪造 → 403
   （验证是精确 origin 比较，不是 `includes`）。
5. `Origin`/`Referer` 是**合法值的超集或子串**（如 `http://example.com:3000` vs 配置 `http://example.com`）→ 按设计判定
   （端口属于 origin，必须一致；这条要有断言，避免日后配错）。
6. 带 `X-Forwarded-Host: evil.com` 的直连请求 → 不影响判定结果（验证没有用 Fastify 派生 host）。
7. L3 相关（若实施）：token 缺失/为空/长度不符/恒等改写 → 403 不 500（对齐 `src/session.ts:96-100` 的先比长度）。
8. L3 相关：同一枚会话 cookie 在两个浏览器里渲染出的 token 相同（派生式的确定性）；
   换一次登录（新 `exp`）后旧 token 失效。

---

## 7. 我无法确认 / 未实测的地方（不要当结论用）

1. **没有任何真机浏览器实测**。§1、§2 的行为全部来自规范 + 厂商文档 + OWASP，我没跑过跨站 PoC。
2. **IE11 在跨站表单 POST 上是否发送 `Origin`**：没找到一手确认（Fetch 标准按现状描述，不回溯旧实现）。
   因此判定表第 2 行标了「前提」；工程上应假定它不可靠。
3. **HTTP（非 localhost）下浏览器确实不发 `Sec-Fetch-*`**：规范是 `Assert`、OWASP 明文，但我没实测。
4. **将来反代会不会改写/剥离 `Origin`**：无法预知（`docs/deploy-environment.md:121-123` 现在无反代）。
   上线反代时必须实测一遍，并同步核对 `SITE_ORIGIN`。
5. **同 site 兄弟子域对本仓的现实可达性**：当前单主机部署、无子域。风险是「将来会成立」，不是「现在已成立」。
6. **`SameSite=Lax` 在 `window.open`/预渲染等边界上的精确行为**：规范只给「这会带来 same-site 请求」的定性判断，
   我没做浏览器验证。
7. **派生式 token 的密码学安全性**：依赖 `SESSION_SECRET` 的保密与强度（本仓要求 ≥32 字节随机，
   `src/config.ts:207-232` 给了生成命令）。我没有做形式化分析；也不排除我漏看了某个与
   `exp` 精度/时区相关的边界（`exp` 是 `Date.now()` 毫秒，同毫秒内两次签发会得到同一个 payload ⇒ 同一个 token，
   这在本设计里是无害的，但值得知道）。

---

## 8. 来源清单

**规范 / 一手标准**

- RFC 6265bis（Cookies: HTTP State Management Mechanism，`draft-ietf-httpbis-rfc6265bis-latest`，2026-10-15）：
  <https://httpwg.org/http-extensions/draft-ietf-httpbis-rfc6265bis.html>
  —— §5.2 / §5.2.1（same-site 定义入口）、§4.1.3.2（`__Host-`）、§5.6.7.1（Strict/Lax enforcement）、
  §5.6.7.2（Lax-allowing-unsafe）、§5.7（Storage Model）、§5.8.3（Retrieval Algorithm）
- WHATWG HTML Standard §7.1.1.1 Sites（site / same site / schemelessly same site）：
  <https://html.spec.whatwg.org/multipage/browsers.html#concept-site-same-site>
- WHATWG Fetch Standard §3.2 `Origin` header：<https://fetch.spec.whatwg.org/#origin-header>
  · append a request `Origin` header：<https://fetch.spec.whatwg.org/#append-a-request-origin-header>
  · forbidden request-header：<https://fetch.spec.whatwg.org/#forbidden-request-header>
- RFC 6454（The Web Origin Concept）§7.2/§7.3：<https://www.rfc-editor.org/rfc/rfc6454.html>
- RFC 9110 §7.6.1（Connection / hop-by-hop）：<https://www.rfc-editor.org/rfc/rfc9110.html#section-7.6.1>
- RFC 7239（Forwarded HTTP Extension）§8.1：<https://www.rfc-editor.org/rfc/rfc7239.html#section-8.1>
- W3C Fetch Metadata Request Headers：<https://www.w3.org/TR/fetch-metadata/>
- W3C Secure Contexts（potentially trustworthy URL）：
  <https://www.w3.org/TR/secure-contexts/#is-origin-trustworthy>

**厂商一手文档**

- Chromium：SameSite updates / "Lax + POST" / Schemeful Same-Site：<https://www.chromium.org/updates/same-site/>
  （FAQ 页：<https://www.chromium.org/updates/same-site/faq/>）
- Fastify Server 选项 `trustProxy`：<https://fastify.dev/docs/latest/Reference/Server/#trustproxy>
- Fastify Lifecycle：<https://fastify.dev/docs/latest/Reference/Lifecycle/>
- Node.js `crypto.timingSafeEqual`：<https://nodejs.org/api/crypto.html#cryptotimingsafeequala-b>
- MDN `Referrer-Policy`（默认值与跨站表现）：
  <https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Referrer-Policy>
- MDN `Set-Cookie`（属性与 cookie 前缀）：<https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Set-Cookie>
- caniuse "SameSite cookie attribute"：<https://caniuse.com/same-site-cookie-attribute>
  （数据源：<https://github.com/Fyrd/caniuse/blob/main/features-json/same-site-cookie-attribute.json>）

**OWASP**

- Cross-Site Request Forgery Prevention Cheat Sheet：
  <https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html>
  —— Token-Based Mitigation / Signed Double-Submit Cookie (RECOMMENDED) / Naive Double-Submit (DISCOURAGED) /
  Fetch Metadata headers / SameSite 的 Limitations 与 When SameSite May Be Sufficient On Its Own /
  Using Standard Headers to Verify Origin / Possible CSRF Vulnerabilities in Login Forms

**本仓（行号对应当前工作树）**

- `src/session.ts:20-62`（载荷与签名）、`:81-100`（先比长度再 `timingSafeEqual`）、`:131-142`（手写 cookie 解析，同名后者覆盖）、
  `:159-176`（cookie 属性，`SameSite=Lax` 固定）、`:187-205`（`next` 逃逸面）
- `src/server.ts:112`（`trustProxy: true`）、`:122-134`（自写表单解析）、`:149-153`（`onRequest` 闸门）、
  `:157-263`（GET 全只读）、`:164-214`（三个 POST 写接口）
- `src/auth.ts:22-47`、`:78-110`（白名单与闸门判定）
- `src/config.ts:183-187`（`SESSION_SECRET` / `SESSION_COOKIE_SECURE` / TTL）、`:207-233`（密钥缺失拒绝启动）
- `node_modules/fastify/lib/request.js:122-136`（`trustProxy` 下 `host` getter 取 `x-forwarded-host`）
- `docs/deploy-environment.md:121-123`（无反代、直连 `:3000`）、`docs/session-decision.md`（会话的既有决定）
