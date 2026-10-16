# 写路径的鉴权面：角色判定、CSRF、校验与错误呈现

本文件是「写路径的鉴权面」这张票的产出（map：[个人站自管化](https://github.com/Lkyloveaw/lkyloveaw-home/issues/20)）。

票：<https://github.com/Lkyloveaw/lkyloveaw-home/issues/25>

它把三张已关的票**粘起来**：权限模型（[#24](https://github.com/Lkyloveaw/lkyloveaw-home/issues/24)，谁能写）·
CSRF 最小集（[#28](https://github.com/Lkyloveaw/lkyloveaw-home/issues/28) 的研究，怎么证明「这是本人从本站发的」）·
管理台信息架构（[#23](https://github.com/Lkyloveaw/lkyloveaw-home/issues/23)，写失败在屏幕上长什么样），
落到 `src/` 里那一层可以照着写的东西：**一个守卫、一个 CSRF 校验、一处错误渲染**。

> ⚠ **本票只产决定**（map 目的地：本图只产决定）。本文**不含实现代码**；判定表是**待验证的断言清单**。
> 落地由 [实现批次怎么切](https://github.com/Lkyloveaw/lkyloveaw-home/issues/27) 切出的批次票执行。

---

## 0. 七个决定（一句话版）

| # | 问题 | 结论 |
| --- | --- | --- |
| 1 | CSRF 用哪几层 | **L1 `SameSite=Lax` 维持 + L2 origin fail-closed（所有非安全方法）+ L3 会话派生 token（所有写路由）**。三层都上，不取"最小 L1+L2" |
| 2 | L2 判据 | `Origin` 必须**精确等于**配置里的允许 origin；`Origin: null` 视为不通过；`Origin` 缺失回退 `Referer` 的 origin；**两者都不可用 → 403** |
| 3 | 期望 origin 从哪来 | **新增 `SITE_ORIGIN`（逗号分隔多值，精确匹配），缺失即拒绝启动**。**禁止** `req.hostname` / `req.protocol`（`trustProxy: true` 下任意直连客户端可伪造） |
| 4 | `trustProxy` 怎么办 | **改成 `TRUST_PROXY=false` 默认关**；要开就填具体 CIDR，不许 `true` |
| 5 | L3 token 形态 | `HMAC-SHA256(SESSION_SECRET, 'csrf\|' + `会话 token 里 `'.'` 之前那段`)`，**不新增 cookie、不加载荷字段、旧 cookie 不迁移** |
| 6 | token 校验位置 | **`preValidation`**（`onRequest` 时表单体还没解析）；校验用**先比长度再 `timingSafeEqual`** |
| 7 | 授权判定 | **一个守卫 + 一处判定**：`requireAdmin` 只回答「够不够格」，**对象级规则**（不能改自己、最后管理员）由 `users.ts` 的守卫回答；写路由**只返回 403，不重定向、不落任何写** |

---

## 1. 三层各挡什么、为什么三层都要

判定表与逐条规范引用见 [`docs/research/csrf-minimal-protection.md`](research/csrf-minimal-protection.md) §4。
本票只做选择与落点，不重新论证。

| 层 | 挡什么 | 挡不住什么 | 本票要不要 |
| --- | --- | --- | --- |
| **L1 `SameSite=Lax`** | 现代浏览器的跨站表单 POST（cookie 根本不发） | 忽略该属性的旧客户端（Opera Mini 全版本 / UC 15.5 / 部分 IE11 / 旧 Safari）· **同 registrable domain 的兄弟子域**（same-site，cookie 照发） | **维持**（零成本） |
| **L2 origin 校验** | 上面两条 L1 漏掉的；攻击者主动造 `Origin: null` 时也拦（**前提是 fail-closed**） | 依赖请求头在场（中间层可能剥/改） | **做** |
| **L3 会话派生 token** | 同上，且**唯一不依赖请求头、也不依赖浏览器实现**的一层 | 状态改动的 GET（token 不该进 URL） | **做** |

**为什么不上"最小集（只用 L1+L2）"**：研究 §5 把取舍摊开了——L2 的判据本身依赖两头的请求头都在，
而本仓**已经确定要引入真实破坏性动作**（停用账号、重置口令、降级角色、改目标）。
上 L3 的增量成本是「SSR 表单里一个 hidden input + 一个纯函数」，收益是**唯一不依赖请求头的那层**。
用「一个 input」换掉「一条只能靠请求头成立的防线」，这笔账不需要犹豫。

**为什么 `POST /login` 不要求 L3**（判定表第 6 行）：这时还没有会话，L3 无从派生；
要做就得引入 pre-session cookie + 额外状态（OWASP 的 pre-session 方案），是**三层里最贵的一条**。
L1 + L2 覆盖它（跨站 POST 在 L1 就不带任何 cookie，在 L2 因 origin 不等被拒）。
**登录 CSRF 的残余风险要写下来**：攻击者若能强制受害者登录**攻击者的账号**，
受害者之后的输入（内容、口令）就落进攻击者的账号。本仓的实际暴露面是「一个内网个人站」，
且 L1/L2 已挡住现代浏览器与带 origin 的请求；**剩余的窄路径接受，并在 §11 记为未解项**（不要假装它不存在）。

---

## 2. L2：origin 校验

### 2.1 判据（fail-closed，精确比较）

```
对每个非安全方法（POST / PUT / PATCH / DELETE）：
  if Origin 头存在:
      Origin === "null" → 拒绝
      Origin ∈ SITE_ORIGIN 集合 → 通过
      否则 → 拒绝
  else if Referer 头存在:
      new URL(Referer).origin ∈ SITE_ORIGIN 集合 → 通过
      否则 → 拒绝
  else:
      → 拒绝
```

- **精确相等**（`===`），**禁止** `includes` / 前缀 / 后缀匹配：
  研究 §6 第 4 条那组伪造（`http://example.com.evil.com`、`http://evil.com#@example.com`）
  正是为**包含型比较**准备的。
- **端口属于 origin**：`http://10.0.0.226:3000` ≠ `http://10.0.0.226`（研究 §6 第 5 条）。
- **`Origin: null` 一律拒绝**：它不是"没有来源"，它是**来源不可知**（`<meta name="referrer" content="no-referrer">`、
  sandbox iframe、HTTPS→HTTP 降级都能造出它）。研究 §2.1 的原文与 OWASP 的口径一致：
  「缺失头与 `Origin: null` **都不是**同源请求的证据」。
- **为什么允许 `Referer` 回退**：不是所有客户端都在 POST 上带 `Origin`（研究 §2.1 的兼容性保留条款）。
  回退只取 **origin 部分**，不看 path（默认 policy 跨源时只给 origin）。
- **实测口径**：`curl -d ... ` 不带任何来源头 → **403**。这是**故意的**：
  「直连 IP 不带 Origin 调用写接口」是我们要拒绝的形状，不是要兼容的形状。
  在服务器上用 CLI 做运维动作（`node dist/cli/passwd.js`）**不经过 HTTP**，不受这条影响。

### 2.2 挂在哪一层

**全局 `onRequest` 钩子里**（与既有闸门同一个钩子，紧接在 `decideRequest` 之后）：
这时只看头、不碰表单体，位置正确；而且**默认拒绝**的形状与既有闸门一致
（`docs/login-gate-decision-table.md` §1 的「全局默认拒绝、白名单显式放行」）。

- **白名单不需要**：`GET` / `HEAD` / `OPTIONS` 是安全方法，不进这段判定。
  今天全仓 `POST` 只有 `/login`、`/logout`、`/password` 与将来的 `/admin/*`，全都要过 L2。
- **拒绝形态**：`403` + 站内页面（说明「请求来源不可信，已拒绝」）+ `console.warn` 记
  `method` / `path` / `origin` / `referer` / `host`（**不记 token、不记表单体**）。
- ⚠ **`onRequest` 阶段拿不到解析后的 host，也不该去拿**：判据只用 `headers.origin` / `headers.referer`，
  与 `SITE_ORIGIN` 比。**不碰 `req.hostname`**（§3）。

---

## 3. 期望 origin：`SITE_ORIGIN`，缺失即拒绝启动

### 3.1 配置形状

```
SITE_ORIGIN=http://10.0.0.226:3000,http://localhost:3000
```

- **逗号分隔多值**，解析成 `Set<string>` 精确匹配。为什么允许多值：
  这个站的日常访问形态就是「局域网 IP」；而**本机调试**（面板/管理台刚写完时）用的是 `localhost`，
  `localhost` 与 `127.0.0.1` 又是**不同 origin**。只允许一个值，就会出现
  「本机测一次就得改一次 `.env`」——而这种摩擦的最终结果是**有人把它配成一个宽松值**，比多值更糟。
- **取值必须是一个 origin**（`scheme://host[:port]`）：不带 path、不带结尾 `/`、不带 query。
  解析时 `trim()` + 去掉结尾 `/`；非法条目**拒绝启动并指出是哪一条**。

### 3.2 缺失即拒绝启动（沿用 `SESSION_SECRET` 的判据）

`docs/session-decision.md` §6 立过的判据是「**重启能不能自愈**」：

| 情形 | 处理 | 理由 |
| --- | --- | --- |
| `SITE_ORIGIN` 缺失 | **拒绝启动**，报错里给出示例行 | 它是**配置错误**，重启不会自愈（与 `SESSION_SECRET` 同类） |
| `users` 表为空 | 允许启动 + 告警 | 运行状态，重启可能自愈（既有决定，不动） |

**为什么不像 `SESSION_SECRET` 那样给一条生成命令**：它没有"随机"可言，只有"你实际怎么访问这个站"。
所以报错里给的是**示例**（`SITE_ORIGIN=http://<你的IP>:3000`）并提示「浏览器地址栏里那个 origin 就是它」。

**为什么不用「原始 `Host` 白名单」当缺省回退**（研究 §2.3c 给的退路）：
那需要**再维护一份主机名列表**，`Host` 又是客户端可控的（无反代时它是权威的，但那是"当前部署恰好如此"的假设）。
一个显式变量 + 拒绝启动，比"两个变量互相回退"少一个失败模式。
**代价写在明面上**：升级到本版本时，`.env` 少了这一行就起不来——这是**显眼的**失败，符合本仓取舍。

### 3.3 `trustProxy`：改成默认关

```ts
trustProxy: config.trustProxy,     // TRUST_PROXY，默认 false（可填 "127.0.0.1" 或 CIDR）
```

- 今天的值是 `true`（`src/server.ts:112`），而目标机**没有反向代理**（`docs/deploy-environment.md:121-123`）
  → `true` 现在**只有坏处没有好处**：任意直连客户端加一个 `X-Forwarded-Host` 就能决定 `req.hostname`
  （Fastify `lib/request.js:122-136`），`X-Forwarded-Proto` 同理决定 `req.protocol`。
- **默认 `false`**：`req.ip` 变成直连地址、`req.hostname` 变成 `Host` 头。今天没有任何代码读这三样
  （已 grep 核实），所以关掉它**零行为变化**。
- **将来加反代**：把 `TRUST_PROXY` 填成反代的**具体地址/CIDR**（Haraka 风格的点号列表由 Fastify 直接支持），
  **不要填 `true`**——`true` 的语义是"信任任何上游"，而互联网上任何直连客户端都是我们的上游。
- 这一条与研究 §2.5 的处置栏、§5 第 2 条一致：**期望 origin 绝不从派生值来**。

---

## 4. L3：会话派生 token

### 4.1 形态

```
payloadB64 = 会话 token 里最后一个 '.' 之前那段（服务端已验签）
csrf       = base64url( HMAC-SHA256(SESSION_SECRET, "csrf|" + payloadB64) )
```

**为什么是这个形态**（研究 §3.2 已论证，这里只记结论与代价）：

| 性质 | 结果 |
| --- | --- |
| 绑会话 | HMAC 的 message 是**本次会话独有的 payload**（`exp` 每次签发都不同 ⇒ token 每次登录自动换新） |
| 不新增 cookie | 没有第二枚可被同域写入覆盖的 cookie → 绕开 naive double-submit 的注入面（**本仓 HTTP + 无 `__Host-`，那条路明确禁用**） |
| 旧 cookie 不迁移 | 不改 `SessionPayload` 形状 ⇒ 已下发的 cookie 继续可用（与 #29 的决定**不同**：#29 要加 `sid`，那次迁移是**不可避免**的；这次是可避免的，就避免） |
| 无法单独作废 token | 无状态固有代价；「作废凭据」这件事由 #29 的 `sessions` 行与 `token_version` 负责 |
| 确定性 | 同一枚 cookie 在两个浏览器里算出**同一个** token（可断言，见 §9） |

**`payloadB64` 就是那一段**，不是整个 token：整个 token 含签名，含签名也没错（签名是 payload 的函数），
但用 payload 段更干净——**重新编码整个 token 容易在 base64url/百分号编码上引入 bug**。

### 4.2 校验：`preValidation`，先比长度

```ts
// 纯函数，可不过 HTTP 直接断言
export function csrfToken(secret: string, sessionToken: string): string | null   // malformed → null
export function verifyCsrf(secret: string, sessionToken: string | undefined, submitted: unknown): boolean
```

- **位置**：`preValidation` 钩子（写在写路由**自己的** `preValidation` 里，不是全局）。
  理由（研究 §3.6）：`onRequest` 时表单体**还没解析**，读不到 `csrf` 字段；
  本仓自写的 `application/x-www-form-urlencoded` 解析器在 `Parsing` 阶段生效。
- **为什么放路由自己的 `preValidation` 而不是全局**：L3 需要**会话 token**（闸门刚算出来的那枚），
  放进全局钩子就得把所有 GET 也过一遍，而 GET 没有表单体也没有必要（`GET` 全只读，是**设计约束**不是巧合）。
- **比较必须**：先比 `Buffer` 长度 → 不等**直接判假**（**不要抛**，`timingSafeEqual` 对不等长输入抛
  `ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH`，会把畸形输入打成 500）→ 等长再 `timingSafeEqual`。
  形状照抄 `src/session.ts:96-100` 的既有先例。
- **失败形态**：`403` + 站内页面 + `console.warn`（记 `path` 与失败原因，**不记 token 值**，
  OWASP 明文要求 token 不进日志）。

### 4.3 token 怎么进 HTML：`AsyncLocalStorage`

今天 `views.ts` 的渲染函数签名是 `(data, site)`——没有 `req`。要给每个表单塞一个 hidden input，
**两条路**：

| 方案 | 代价 |
| --- | --- |
| 给每个 `*Page()` 加一个 `csrf` 参数 | 改 `views.ts` 全部签名 + 全部调用点；**漏一个表单就是一个没有 token 的表单**（而且是静默漏） |
| **`AsyncLocalStorage` 存本次请求的 token，视图里读** | `node:async_hooks` 是内置模块，**零依赖**；视图签名不变 |

**选第二个**。理由不是"少改代码"，而是**失败方向**：
- 用参数：漏传 = 渲染出一个**没有 hidden input 的表单**，用户提交后拿到 403，而**原因在渲染侧**，
  排查要从"为什么这个表单少了一段 HTML"开始。
- 用 ALS：渲染入口统一注入，**每个表单拿到同一个 token**；ALS 没被初始化时（比如脚本/测试里直接调 `views`）
  渲染出的 token 是空串 → 提交必 403，**同样是显眼失败**，但**只有一处**要查。

落点：`src/server.ts` 在闸门算出 token 后 `als.run({ csrf }, () => handler())`；
`views.ts` 里一个 `csrfField()` 读 ALS 并输出 `<input type="hidden" name="csrf" value="…">`。

**必须设 `Cache-Control: no-store`**（带 token 的响应；`/login` 也一起设，虽然它没有 L3 token 但有 L2 判据）。
今天是动态 SSR，本来没有共享缓存，但「已登录页面不进共享缓存」本身就该是属性（研究 §3.6 末段），
一行头的事。

---

## 5. 授权判定：一个守卫 + 一处判定

### 5.1 两层，各回答一个问题

| 层 | 函数 | 回答 | 放哪 |
| --- | --- | --- | --- |
| **资格** | `requireAdmin(decision)` | 「这个请求**够不够格**碰写路径」——只读一律不够 | `src/auth.ts`（读 `decideRequest` 的结果） |
| **对象规则** | `assertCanChangeRole(...)` / `assertCanDisable(...)`（`users.ts` 的守卫，`roles-decision.md` §3） | 「这次**具体改动**能不能做」——最后管理员、不能改自己 | `src/users.ts`（纯库函数，网页与 CLI **共用**） |

**为什么必须是两层**：第一层是**路由级**的（每个写路由都要，形状一样），
第二层是**对象级**的（只有特定动作有，规则来自领域）。混成一层的后果是
「把 `roles-decision.md` §3 的守卫抄进路由」——而那份决定明确要求**网页与 CLI 共用一个函数**
（两条通道规则不一致时，CLI 就成了绕过守卫的后门）。

### 5.2 每个写路由的判定表

| 路由 | 资格 | 对象规则 | 备注 |
| --- | --- | --- | --- |
| `POST /password`（改**自己**的口令） | 已登录（**只读也行**，`roles-decision.md` §1） | 无（对象就是自己） | **已有**，本票只追加 L2+L3 |
| `POST /logout` | 已登录（**实际上未登录到不了这里**） | 无 | **已有**，只追加 L2（L3 对登出无意义：登出失败最多是"没登出"）。未登录时请求在 `onRequest` 就被 302 到登录页，**所以下发清 cookie 头的那段代码在无 cookie 时根本不会执行**——这对本路由无害（本来就没有 cookie 要清），但写"登出永远成功"这类断言时要按**已登录**的前置来写 |
| `POST /login` | **匿名**（在白名单里） | 无 | 只受 L2；见 §1 的残余风险 |
| `POST /admin/targets` | **管理员** | 目标校验（`config.ts` 的 `validateTargetUrl` / `normalizeTargets`） | 新增 |
| `POST /admin/accounts` | **管理员** | **最后管理员守卫**（降级/停用）· **不能改自己**（角色/停用） | 新增 |
| `POST /admin/settings` | **管理员** | 值域校验（间隔是正整数等） | 新增 |
| `POST /admin/backups` | **管理员** | 无（新增文件） | 新增；幂等见 §7 |

### 5.3 判定顺序（固定，写进验收）

```
1. onRequest: decideRequest → 未登录则 302/401（既有）
2. onRequest: L2 origin 校验 → 403（本票新增，只对非安全方法）
3. handler 内: requireAdmin → 只读则 403（本票新增）
4. 路由 preValidation: L3 token 校验 → 403（本票新增）
5. handler: parseFormBody → action 闭集判定（未知 action → 400）
6. handler: 字段校验 → 400 + 就地重渲染（#23 §4.2）
7. 对象守卫 → 400 + 就地重渲染（#23 §4.2；文案说明为什么）
8. 写入（成功 → 302 + `?notice=<key>`）
```

**顺序的理由**：
- **L2 在资格之前**：它不是"你不够格"，而是"这个请求不可能来自本站"，与身份无关。
  放后面会让攻击者从 403 文案里读出"这个路由存在且需要一个管理员会话"。
- **L2 在 L3 之前**：L2 只看头、零解析成本；L3 要读表单体。
- **L3 在字段校验之前**：CSRF 是**请求真实性**问题，字段错是**用户输错**问题。
  真实性问题先判，否则攻击者能用"字段校验的差异"探测后端行为。
- **`requireAdmin`（3）在 L3（4）之前**：第 3 步是同步的内存判断，第 4 步要解析表单体——
  只读用户的 POST 不该被解析。
- **5 → 6 → 7**：先确认"这是个什么动作"，再校验字段，再查对象规则（对象规则要在字段合法之后，
  否则"最后管理员"的提示会淹没在"URL 没填"里）。

### 5.4 拒绝的形态：`403`，不重定向

| 情形 | 状态码 | 正文 |
| --- | --- | --- |
| L2 来源不可信 | 403 | 站内页面：「请求来源不可信，已拒绝。」+ 回首页 |
| L3 token 缺失/错 | 403 | 站内页面：「页面已过期或提交来源异常，请刷新后重试。」+ **回本页的链接**（刷新即可拿到新 token） |
| 只读访问 `/admin*` | 403 | `#23` §3 已定 |
| 字段/对象规则失败 | **400** | 就地重渲染 + `notice-bad`（`#23` §4.2） |
| 未知 `action` | 400 | 就地重渲染 + 说明 |

**为什么 L3 失败给"回本页"的链接**：最常见的真实原因是**用户开着两个标签页，在另一个标签改了口令**
（`token_version` 变了 → 会话重签 → 这个页面的 token 失效）。给一条刷新路径，
比只给一句"403"少一次困惑。**但文案不解释这个内部原因**（会暴露实现细节且多数人看不懂）。

**为什么不用 `redirect`**：重定向会把 POST 变成 GET，用户会以为"提交成功了"（跳到同一页且没有错误）。
`#23` §4.2 已经为校验失败定了同一取向。

---

## 6. 输入校验与错误回显

**归属说明**：**呈现形式**（就地重渲染、`notice-bad`、保留输入、`?notice=<key>` 闭集）由
[#23](https://github.com/Lkyloveaw/lkyloveaw-home/issues/23) §4 定，本文**不重复**。本票只定**校验职责**：

| 校验对象 | 用哪个函数 | 谁负责 | 不许做什么 |
| --- | --- | --- | --- |
| 目标 URL / 协议 / 凭证 / 重复 id | **`config.ts` 的 `validateTargetUrl()` + `normalizeTargets()`** | 目标写路由 | **不许重写一份**（重写 = 文件里被拒的 URL 在网页上能存进去） |
| 口令长度 / 用户名归一化 / 重复 | **`users.ts` 的 `assertPassword()` / `normalizeUsername()`** | 账号写路由 | 不许在视图层做"看起来像校验"的事（`required` 只是体验，服务端必须再判） |
| 探测间隔 / 标题 / 描述 | 本票新增的小校验（正整数秒、非空、长度上限） | 设置写路由 | `.env` 与 DB 的优先级**归 [#22](https://github.com/Lkyloveaw/lkyloveaw-home/issues/22)**，本文不定 |
| `action` | **闭集枚举** | 各写路由 | 不许把 `action` 当自由字符串拼进 SQL / 文件名 |

**统一原则**（三条，给批次票的验收）：
1. **服务端是唯一权威**：HTML 的 `required` / `type=number` / `maxlength` 都只是体验；
   每一条都要在服务端再判一次（`#23` §3.2 对"空壳"给过同一条理由）。
2. **错误要说清哪一条**：`notice-bad` 的文案必须含**字段名 + 为什么**（「URL 含凭证，请改用其他方式授权」），
   不是「输入有误」。
3. **失败不静默**：任何写失败都要有 4xx/5xx + 屏幕上看得见的提示 + 日志；
   与 `status.js` 那条「静默 catch」的既往教训同源（`docs/login-gate-decision-table.md` §3）。

---

## 7. 破坏性操作的幂等

**归属**：二次确认的**呈现**由 [#23](https://github.com/Lkyloveaw/lkyloveaw-home/issues/23) §5 定
（三类动作加必勾复选框）。本票定**服务端这个动作本身幂等不幂等**——这是另一个问题：
用户点两次、或网络重试，会不会做出两次效果。

| 动作 | 幂等？ | 怎么做到 |
| --- | --- | --- |
| 停用 / 启用目标 | **是** | `enabled` 是**赋值**（设成 0/1），不是自增/追加。重复提交结果相同 |
| 停用 / 启用账号 | **是** | 同上 |
| 改角色 | **是** | `UPDATE users SET role = ?` 赋值 |
| 改设置 | **是** | 赋值 |
| **重置口令** | **否（也不该幂等）** | 每次都是"设成我这次给的新口令"，本身就是幂等的赋值；**但不做"重复提交检测"**——它递增 `token_version`，重复提交的后果只是"其他设备又被踢一次"，无害 |
| **手动触发备份** | **要防重复** | 产物是**新增文件**，重复提交会连出两份（`BACKUP_KEEP` 会滚动掉别的）。判据：**今天是否已有产物**，已有 → 不新增，返回 `?notice=backup-skipped`（`#23` §4.3 的 `notice-warn` 档） |
| **登出** | **要幂等，且必须永远返回成功** | 见 §5.4 与 #29 §6.1：重复登出、无 cookie 登出，都清 cookie + 302，**不给错误页** |

**为什么备份要防重复而其他不要**：判据是「重复提交会不会**留下第二个东西**」。
其余动作都是"把某个值设成某个值"，重复提交等于多按一次同一个开关；
备份是**追加**——这正是"重复提交"这个问题的经典形状（也是它值得一行判断的原因）。

**与 #29 的衔接**：`POST /logout` 现在会走 `revokeSession`，重复调用 `changes = 0`，
响应必须一样（`#29` §6.1 已定）。写路由的**幂等断言**因此可以放在 e2e 里一起测。

---

## 8. 实现落点

| 文件 | 改动 |
| --- | --- |
| `src/csrf.ts`（新） | `csrfToken(secret, sessionToken)` / `verifyCsrf(...)` / `checkOrigin(headers, allowed)`——**全是纯函数**，可不过 HTTP 直接断言 |
| `src/auth.ts` | 加 `requireAdmin(decision)`（只读 → 403）；`PUBLIC_PATHS` / `KNOWN_PAGES` **不动**（`/admin` 已在 `KNOWN_PAGES`，见 #23 §8.3） |
| `src/server.ts` | `onRequest` 里接上 L2；写路由声明自己的 `preValidation`（L3）；`als.run(...)` 传 token；`Cache-Control: no-store`；`trustProxy` 改读配置 |
| `src/views.ts` | `csrfField()`（读 ALS）+ 403 页面（L2/L3 用）+ 各表单插入 `csrfField()` |
| `src/config.ts` | 加 `siteOrigins: Set<string>`（解析 + 校验 + 缺失即拒绝启动）、`trustProxy`；`.env.example` 同步 |
| `src/users.ts` | **不动**（守卫已由 #24 定；本票只是调用方） |
| `scripts/unit-check.mjs` | §9 的纯函数断言（token 派生 / origin 判定 / 先比长度不抛） |
| `scripts/e2e-check.mjs` | §9 的 HTTP 断言 |
| `.env.example` / `README.md` | `SITE_ORIGIN`（示例 + "就是浏览器地址栏里的 origin"）**与** `TRUST_PROXY`（默认关 + **不许填 true** 的告警）· 两者都是**落地时新增的行**，本文只定它们的内容与判据（§3） |

> **为什么 `.env.example` 的改动属于本票的落点**：`SESSION_SECRET` 那几行的**实际写入**是由
> [会话维持](https://github.com/Lkyloveaw/lkyloveaw-home/issues/4) 的批次票做的，本文沿用同一分工——
> 本票定**该有什么行、语义是什么、配错会怎样**，批次票负责敲进去。

**为什么新开 `src/csrf.ts` 而不是塞进 `session.ts`**：`session.ts` 的职责是"会话的签发/校验/失效"
（`docs/session-decision.md` §13 划的边界），CSRF 是**另一个层**（它防的是"别人替你做请求"，
不是"你是谁"）。混进去会让 `session.ts` 同时回答两个问题——而这个仓库反复用"一个模块一个职责"
避免的正是这种混。**同一条理由**让 `verifySession` 当年从 `server.ts` 里被抽出来。

---

## 9. 验收（落地时的断言清单）

### 9.1 纯函数（`scripts/unit-check.mjs`）

| # | 输入 | 期望 |
| --- | --- | --- |
| 1 | 同一 `secret` + 同一会话 token | `csrfToken()` **确定性**：两次调用相等 |
| 2 | 同一 `secret` + **不同**会话 token（`exp` 不同） | 两个 token **不相等** |
| 3 | 不同 `secret` + 同一会话 token | token 不等 |
| 4 | 会话 token **没有 `.`** | `csrfToken()` 返回 `null`（不抛） |
| 5 | 提交值**长度不对**（截断/加长） | `verifyCsrf()` 返回 `false`，**不抛** |
| 6 | 提交值**等长但改一个字符** | `false` |
| 7 | 提交值为 `undefined` / `""` / 非字符串 | `false`，**不抛** |
| 8 | 正确 token | `true` |
| 9 | `Origin` 与允许值精确相等 | `checkOrigin()` 通过 |
| 10 | `Origin: null` | 拒绝 |
| 11 | `Origin` 缺失，`Referer` 的 origin 命中 | 通过 |
| 12 | `Origin` 缺失，`Referer` 也没有 | 拒绝 |
| 13 | `Origin = http://example.com.evil.com`（配置 `http://example.com`） | 拒绝（**验精确比较**） |
| 14 | `Origin = http://example.com:3000`（配置 `http://example.com`） | 拒绝（端口属于 origin） |
| 15 | `Origin` 带结尾 `/` 或大小写不同的 scheme | 按解析后比较（**要有断言定死行为**，别留给实现随手决定） |
| 16 | 配置解析：`a,b , c/` → 集合（去空白、去结尾 `/`） | 3 项；非法条目（无 scheme）**拒绝启动** |

### 9.2 HTTP（`scripts/e2e-check.mjs`）

| # | 前置 | 操作 | 期望 |
| --- | --- | --- | --- |
| 17 | 管理员已登录 | 正常同源 POST（带 `Origin`） | 2xx/3xx，**不是 403** |
| 18 | 同上 | 同源 POST 但**删掉** `Origin` 与 `Referer` | **403** + 日志有记录 |
| 19 | 同上 | `Origin: null` | 403 |
| 20 | 同上 | 直连请求加 `X-Forwarded-Host: evil.com` | 判定结果**不变**（证明没用派生 host） |
| 21 | 同上 | POST 去掉 `csrf` 字段 | 403 |
| 22 | 同上 | POST 带**另一个会话**算出的 token | 403 |
| 23 | 同上 | 改密成功后再用**旧页面**的 token | 403（旧 token 随改密失效） |
| 24 | **只读**已登录 | POST `/admin/accounts` | 403，且**该账号未发生任何变化**（先断言前置状态） |
| 25 | 管理员 | 连续两次触发备份 | 第二次**不新增产物**（先断言第一次真的产出了） |
| 26 | 管理员 | 停用一个目标，重复提交同一动作 | 结果与提交一次相同（幂等） |
| 27 | 带 token 的响应 | 检查响应头 | 有 `Cache-Control: no-store` |
| 28 | — | `grep` 全仓 | **没有代码读 `req.hostname` / `req.protocol`**（把"别踩"变成断言） |

**断言质量要求**（沿用既有原则）：每条**必须先证明前提成立**——
第 17 条必须先断言"不带任何来源头时是 403"（否则 17 在一个恒 403 的实现上也过）；
第 23 条必须先断言改密前该 token 是**通过**的；第 24/25 条必须写后读。

**⚠ 已在本机跑过的验证**：**没有**。本票产出时的会话里 `ops_bash`（缺 bash IPC 兼容收据）与
`pwsh`（执行策略禁止 `prepare-workspace.ps1`）都不可用，上面 28 条**一条都没跑**。
与 `docs/session-revoke-decision.md` §11、`docs/admin-console-ia-decision.md` §9 同一种性质：
**待验证的断言清单，不是已验证的结论**。落地时跑出与本文不一致的，**改本文**。

---

## 10. 对既有决定的显式修订

| 既有文件 | 原文 | 本票 |
| --- | --- | --- |
| `docs/research/csrf-minimal-protection.md` §5 | 「若只想先上最小集合，则 **L1+L2 是可用的最小集**」 | **取满配**：L1+L2+L3（§1 给了理由：已有真实破坏性动作，L3 增量只是一个 input） |
| 同上 §5 第 2 条 | 期望 origin「配置常量优先，缺省回退原始 `req.headers.host`」 | **不回退**：`SITE_ORIGIN` 缺失即拒绝启动（§3.2；少一个失败模式） |
| 同上 §3.3 备选 B（payload 内 nonce） | 备选形态之一 | **否掉**（研究已列出代价：需改载荷形状 ⇒ 旧 cookie 全失效），选 A 派生式 |
| `docs/session-decision.md` §6 | 「`SESSION_SECRET` 为空拒绝启动」的判据 | **复用到 `SITE_ORIGIN`**（同一判据的第二、第三个实例） |
| `src/server.ts:112` | `trustProxy: true` | **改默认 `false`**（§3.3）；今天零行为变化（无人读派生值） |
| `docs/login-gate-decision-table.md` §1 | 全局 `onRequest` + 显式白名单 | **复用**：L2 挂进同一个钩子；L3 因需要表单体**不能**放全局 |
| `docs/admin-console-ia-decision.md` §3 | 只读访问 `/admin*` → 403；写接口「不是 302」 | **落实为** `requireAdmin`（§5.1）+ §5.4 的状态码表 |
| `docs/session-revoke-decision.md` §5 | 判决值 `revoked` / `session-unknown` | **不动**；写路由的"未登录"仍走既有 302/401 分流 |

**不动的东西**：`SameSite=Lax`（L1 维持）· 闸门形状与白名单精确匹配 · `next` 校验 ·
`docs/session-decision.md` 与 `roles-decision.md` 的其余全部结论 · 视图层的既有表单样式约定。

---

## 11. 边界与未解项（不假装它们不存在）

- **登录 CSRF 的残余风险**（§1）：`POST /login` 不做 pre-session token。
  窄路径：能强制受害者登录攻击者账号的场景。L1+L2 已覆盖现代浏览器与带来源头的请求；
  **接受，不解决**，理由与代价都写在 §1。
- **`onRequest` 阶段看不到表单体**：L3 只能放 `preValidation`。所以"CSRF 失败"发生在
  **解析完表单体之后**——攻击者能让服务端白解析一个请求体。本仓自写解析器只处理
  `application/x-www-form-urlencoded`，且 Fastify 有默认 1MiB body 限制，这条**可接受**；
  要根治得在 `onRequest` 就读 token（需要 cookie 里带 token，而那正是 §4.1 否掉的形态）。
- **HTTPS / `Secure` 默认值**不在本票（map 迷雾，`docs/session-decision.md` §13 已登记）；
  `Sec-Fetch-*` 也因此仍不可用（研究 §2.4）。
- **`.env` 与 DB 的优先级、探测间隔是否立刻生效**归 [#22](https://github.com/Lkyloveaw/lkyloveaw-home/issues/22)。
- **目标真源、首次导入、`id` 不可变**归 [#26](https://github.com/Lkyloveaw/lkyloveaw-home/issues/26)。
- **登录失败次数限制 / 速率限制**不在本票，也不在它阻塞的任何票
  （`docs/session-decision.md` §13 已登记）——它管的是"猜口令"，与本票管的"请求是不是本人发的"不重叠。
- **不带 `Origin` 的写请求被一律拒绝**意味着：将来若有**非浏览器**的程序化写接口
  （脚本、另一个服务），它必须显式带上 `Origin` 或 `Referer`。这是一个**有意的**取舍：
  本仓今天没有这类调用方（运维动作走 `src/cli/`，不过 HTTP）。
- 本票产出决定与落点，**不写实现代码**。
