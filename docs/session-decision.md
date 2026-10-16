# 会话维持判定表：签名 cookie 的载荷、密钥、过期与登出

本文件是「会话维持」这张票的产出：**会话怎么签发、怎么校验、什么时候失效**的可落地判定表。
它决定 `src/session.ts` 导出什么、`src/server.ts` 的闸门拿它怎么用。

票：<https://github.com/Lkyloveaw/personal-wiki/issues/4>

> ⚠ **本票是 planning 票。** 产出是判定表 + 落点，不写实现代码。与已关闭的
> [`账号存储与口令校验`](https://github.com/Lkyloveaw/personal-wiki/issues/2)、
> [`给整个站点加登录闸门`](https://github.com/Lkyloveaw/personal-wiki/issues/3)、
> [`/api/status 字段收敛`](https://github.com/Lkyloveaw/personal-wiki/issues/5) 同一性质。
> 关掉本票**不等于**会话已经能用了——代码一行没落地（见 map Notes「本 map 的性质」）。

---

## 0. 本票的六个决定（一句话版）

| # | 问题 | 结论 |
| --- | --- | --- |
| 1 | 密钥没配 | **拒绝启动**，报错里给生成命令 |
| 2 | 过期方式 | **7 天绝对过期**，不做滑动续期 |
| 3 | 改密/停用后旧 cookie | **立刻作废**，靠 `token_version` 比对；**新增该列** |
| 4 | 登出 | **只清 cookie**，不建服务端吊销名单；真吊销走 CLI —— **⚠ 已修订**，见下 |
| 5 | 载荷 | 只放 `uid` + `exp` + `pv`，**不放用户名** |
| 6 | `Secure` 开关 | `SESSION_COOKIE_SECURE=0\|1`，**默认 0（关）** |

---

## 1. 签名算法与 token 形状

**结论：`base64url(JSON payload)` + `.` + `HMAC-SHA256(payload, SESSION_SECRET)`，全部用 Node 内置 `crypto`。**

**不引 `@fastify/cookie`**——实测手写 `Cookie` 头解析足够（见 §2），引它只为省 10 行。

载荷是**签名的、不是加密的**：任何人拿到 cookie 都能 `base64url` 解出明文。签名只保护**完整性**（改不了），不保护**机密性**（看得见）。这条约束直接决定了 §5。

实测 token 形状：

```
eyJ1aWQiOjEsImV4cCI6MTc5MjY2MTI1NzI4MiwicHYiOjN9.<43 字符签名>
```

- 实测长度 **99 字符**（`uid=123456` 时），整行 `Set-Cookie`（含 `Path/HttpOnly/SameSite/Max-Age`）约 **155 字符**，距浏览器 4096B 上限极远 → **不担心体积**。
- 分隔符用**最后一个** `.` 切分（`lastIndexOf`），而不是第一个：这样即使将来载荷里出现 `.` 也不会解析错位。

---

## 2. `Cookie` 头解析：手写，不引依赖

实测 7 组边界输入（本机 `node` 直接跑）：

| 输入 | 解析结果 | 判断 |
| --- | --- | --- |
| `a=1; b=2` | `{a:1, b:2}` | 正常 |
| `  a = 1 ;; b=2 ` | `{a:1, b:2}` | 空格、空段要容忍 |
| `session=abc%3D%3D` | `{session:'abc%3D%3D'}` | **不解码**（`base64url` 无 `%`，解了反而坏） |
| `a=` | `{a:''}` | 空值保留为 `''` |
| `novalue` | `{}` | 无等号整段丢弃 |
| `a=1; a=2` | `{a:'2'}` | 重复取**后者** |
| `__Host-s=x; weird="quoted"` | 保留引号原样 | 本方案的值不含引号，无需去引号 |

规则：按 `;` 切 → 每个片段找**第一个** `=` → 左边 `trim()` 作键、右边 `trim()` 作值 → 无 `=` 或键为空的片段丢弃 → 同名后者覆盖。

---

## 3. 签名校验：先比长度，否则畸形 cookie 打成 500

**这是一个真实的地雷。** 实测：

```
crypto.timingSafeEqual(Buffer.from('abc'), Buffer.from('abcd'))
→ 抛 ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH: Input buffers must have the same byte length
```

直接用 `timingSafeEqual` 比对签名，任何**长度不对**的 cookie（手改的、截断的、扫描器的）都会让请求变 **500** 并在日志里刷异常。所以校验顺序必须是：

1. 取签名与期望签名；
2. **先比 byte length，不等直接判 `bad-signature`**；
3. 等长才 `timingSafeEqual`。

→ 畸形输入是**廉价的拒绝**，不是 500。这与本仓库「失败要显眼不要静默降级」不矛盾：显眼指的是**真故障**要看得见，而不是让无效输入制造噪音。

---

## 4. 校验判定表（可执行版，实测 14/14 通过）

`verify()` 的返回值就是拒绝原因，闸门只需判断 `=== 'ok'`。

| 输入情形 | 结果 | 说明 |
| --- | --- | --- |
| 签名正确、未过期、`pv` 与库一致、`enabled=1` | `ok` | 放行 |
| `now >= exp` | `expired` | **边界：`now == exp` 判过期**（用 `now < exp`） |
| 改了载荷但签名没换 | `bad-signature` | 完整性保护生效 |
| 换了 `SESSION_SECRET`（容器重启自动生成的情形） | `bad-signature` | 这正是 §6 拒绝自动生成的原因 |
| `pv` 与库不一致（改密/被踢之后） | `stale-version` | §7 |
| `enabled = 0` | `disabled` | **让「停用」第一次真正生效** |
| 库里查不到该 `uid`（用户被删） | `unknown-user` | |
| 空 / 缺失 cookie | `no-token` | 未登录的正常路径 |
| 无 `.` 分隔符、`.` 在开头 | `malformed` | |
| 签名长度不对 | `bad-signature` | **不抛 500**（§3） |
| 载荷不是合法 JSON / 缺 `exp` / `exp` 非数字 | `malformed` | 载荷形状先行校验 |
| `now == exp - 1` | `ok` | 边界另一侧 |

**载荷形状校验不能省**：`exp` 缺失或非数字会让 `now < undefined` 变成 `false`（看起来像"过期"）或 `NaN` 比较永远为 `false`（**看起来像"永久有效"**）。后者是一个静默的安全洞，所以 `typeof payload.exp !== 'number'` 必须显式拒绝。

---

## 5. 载荷：只放 `uid` + `exp` + `pv`

| 字段 | 放不放 | 理由 |
| --- | --- | --- |
| `uid`（`users.id`） | **放** | 可改的 `username` 不能当身份；`id` 不可改（#2 已定「cookie 里存 id 而不是 username」） |
| `exp` | **放** | 绝对过期的判定依据 |
| `pv`（`token_version`） | **放** | §7 的吊销机制 |
| `username` | **不放** | ①载荷未鉴权可读，内网也不该白送账号名；②它会变成**两份真相**——用户改名后 cookie 里的名字就旧了，要么每请求再查库（那还不如不放），要么显示旧名字（那是缺陷） |
| `role` | **不放** | **⚠ 已修订（[权限模型](roles-decision.md) §6）**：`role` 列现在**存在**了，但仍**不放**——理由换成「库是唯一真源」：放进去等于降级/提权后旧 cookie 在过期前仍自称管理员（第二份真相，与 `username` 同理） |

**注意**：`pv` 是**服务端当前版本号**，不是机密（可读无妨），但它必须与库比对才有意义——见 §7。

---

## 6. 密钥：`SESSION_SECRET`，没配就**拒绝启动**

**结论：`config.sessionSecret` 为空时 `process.exit(1)`，报错信息里直接给出生成命令。**

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

**为什么不自动生成**：自动生成 = 容器每次重启**所有人掉线**。而 `docker-compose.yml:6` 是 `restart: unless-stopped`，用户看到的现象是「刚登录又退出去」，**且没有任何地方告诉他原因**——日志外无从得知。这与本仓库的既有取舍「**失败要显眼不要静默降级**」直接冲突，也与 map Notes 的既定原则一致。

**为什么不与「零账号允许启动」冲突**（#2 §4 已定允许启动）：两者防的是**不同的失败**。

| 情形 | 处理 | 理由 |
| --- | --- | --- |
| `users` 表为空 | **允许启动** | 拒绝会进 `restart: unless-stopped` 的**崩溃重启循环**，日志被刷屏、`docker ps` 一直重启，排查者看不出真正原因；而服务本身是健康的 |
| `SESSION_SECRET` 为空 | **拒绝启动** | 这是**配置错误**，不是运行状态。它**不会**在重启后自行好转，反复重启只会掩盖原因。一次说清比刷屏好 |

→ 判据是「**重启能不能自愈**」：能自愈的（还没建账号）放行 + 告警；不能自愈的（缺密钥）直接停。

> **同一判据的后续实例（2026-10-16）**：[写路径的鉴权面](https://github.com/Lkyloveaw/lkyloveaw-home/issues/25)
> 用同一条判据给 `SITE_ORIGIN`（写路径的期望 origin）定了「缺失即拒绝启动」，
> 见 [`docs/write-path-auth-decision.md`](write-path-auth-decision.md) §3.2。
> 本文的结论一条未改。

**密钥要求**：≥32 字节随机。不强制编码格式（接受任意字符串，但 `README` 推荐上面那条命令）。长度不足时 `console.warn` 但不阻止——**不设硬门槛**，因为拦截一个「能用但偏弱」的密钥，代价是用户把密钥写短以绕过检查，反而更糟。

---

## 7. `token_version`：让改密与停用**立刻**生效

**结论：`users` 表新增 `token_version INTEGER NOT NULL DEFAULT 1`；闸门每请求查一次 `users`，`pv` 失配或 `enabled=0` 即视为未登录。**

### 7.1 不做的话会怎样（实测确认，不是推断）

构造实测：cookie 只放 `uid` + `exp`，用户改密后——

```
改密后 user 行: {"id":1,"enabled":1,"updated_at":1792056468782}
旧 token 仍在 7 天窗口内 → 是否还能换出新会话: 是（服务端没有任何东西比对）
```

即：**改密之后旧 cookie 在剩余窗口内一直有效**。用户改密的心理预期恰恰是「把别人踢出去」，所以这是**在最该生效的场景上不生效**。同理，`enabled=0` 若闸门只验签名不查库，**停用形同虚设**。

### 7.2 为什么要新列，而不是复用 `updated_at`

`updated_at` 的语义是「**最后一次改是什么时候**」（#2 §2 定义），不是「凭据代次」。复用它的后果：日后任何一次无关的账号更新（改显示名、启停、补数据）都会**顺手踢掉该用户全部会话**——把两个概念挤进一列，症状是随机掉线且极难定位。

加一列的代价是**一次 `ALTER TABLE`**（§7.4 实测幂等），远小于上面那个症状的排查成本。

### 7.3 递增时机（谁 `+1`）

| 动作 | 递增 `token_version` | 结果 |
| --- | --- | --- |
| 网页自助改密 | **是** | 其他设备立刻掉线（§8 处理"自己"） |
| CLI 重置口令 | **是** | 救援动作顺带踢掉旧会话 |
| CLI `--revoke-sessions` | **是** | 见 §9 |
| 建号 | 初始 `1` | — |
| 启停 `enabled` | **否**（`enabled` 本身每请求被查，立刻生效） | 无需动版本 |
| 改 `updated_at` 的无关写 | **否** | 这正是新列存在的意义 |

### 7.4 迁移与并发（实测）

| 验证项 | 结果 |
| --- | --- |
| 旧库（无该列）补列 | `PRAGMA table_info` 检出缺失 → `ALTER TABLE users ADD COLUMN token_version INTEGER NOT NULL DEFAULT 1` → 列出现 |
| 既有行的默认值 | `{"id":1,"username":"alice","token_version":1}` —— **全部既有账号落到 1**，与新建号一致，不会因迁移把所有人踢下线 |
| 二次执行 | 检出列已存在 → 跳过，**幂等** |
| 服务持连接时 CLI 轮换 | 服务侧读 `1` → CLI 子进程 `+1` → 服务侧再读 `2`，**立即可见、无需停服**（WAL 多进程，与 #2 §3b 实测一致） |

落点沿用 `store.ts:74-84` 现有的「`PRAGMA table_info` 检出 → `ALTER TABLE` 补列 → 补完再建索引」写法，与 `probes.round_at` 的迁移风格保持一致。**必须第一次 `initUsers()` 就跑通**，否则旧库升级时闸门会在 `no such column: token_version` 上直接 500。

### 7.5 成本

每个受保护请求一次**主键 `SELECT`**（`WHERE id = ?`）。个人站数据量毫秒级，**不加缓存层**——缓存 `enabled`/`token_version` 会让「停用立刻生效」这个本票的核心保证重新失效（缓存 TTL 内停用的人照样进得来），得不偿失。

### 7.6 查库失败时：当未登录处理 + 记日志，**不清 cookie**

| 情形 | 行为 |
| --- | --- |
| DB 抛错 / 锁住 | 按 `verify` 失败处理 → 页面 302 到 `/login`、API 401；`console.error` 记明原因；**不**下发清 cookie 的响应头 |
| 为什么不清 cookie | DB 抖动是瞬时故障，用户的会话其实有效。清了 cookie 等于**把一次抖动升级成一次登出**，恢复后还得重新输密码 |
| 为什么不放行（fail-open） | DB 一挂整站就变成无鉴权，**与 Destination 直接冲突**。宁可 302 到登录页（用户看到"要重新登录"），也不能静默敞开 |

→ 判定顺序上，**「DB 查不到」与「DB 说不行」都落到"未登录"**，区分只体现在日志里。

---

## 8. 过期、登出与"改密后我自己"

### 8.1 7 天绝对过期，不做滑动续期

`exp` 在**签发时**写死，每次请求**不重算、不重写 cookie**。

**为什么不滑动续期**：实测确认滚动会让 `exp` 每次都变 → **整串 token 每次都变** → 每个响应都要带 `Set-Cookie`，且 token 无法靠相等做任何去重/缓存/排查（日志里两行 token 永远不同，看不出"这是同一个会话"）。换来的只是"7 天不重登"。

对个人站，绝对过期的唯一实际代价是**第 7 天要重登一次**——可接受。

**`Max-Age` 与 `exp` 必须一致**（都是 7 天）。两者不一致的后果是：cookie 被浏览器留着但服务端判过期，或反之——用户看到"看上去还登着但一点就跳登录"。

### 8.2 登出 = 清 cookie，**不建服务端吊销名单**

> ⚠ **本节的结论已被推翻（2026-10-16）。** 新决定见
> [`docs/session-revoke-decision.md`](session-revoke-decision.md)（票
> [会话吊销的落地设计](https://github.com/Lkyloveaw/lkyloveaw-home/issues/29)，map
> [个人站自管化](https://github.com/Lkyloveaw/lkyloveaw-home/issues/20)）：
> **登出 = 服务端真吊销**——建 `sessions` 表，cookie 载荷追加 `sid`，登出把该行标记 `revoked_at`。
> 本节**保留**是为了留下推理链：其中「不建名单可以，但**必须留一个真吊销的出口**」这条论证仍然成立，
> 出口从「只有 CLI」变成「登出 + CLI」。下面这段文字描述的是**修订前**的行为，不是当前行为。

**必须写进 README 和这个判定表的局限**：签名 cookie 是**无状态**的，`Set-Cookie: session=; Max-Age=0` 只能让**当前这个浏览器**忘掉它。**已经泄漏或被复制走的那份 token，在 `exp` 之前依然有效**，服务端无从知道它存在。

所以：**登出不是「吊销」，只是「本机遗忘」。** 这是一个语义边界，不是实现缺陷——写清楚它，用户才不会把登出当安全动作。

**真正的吊销通道**（必须一起提供，否则"怀疑 cookie 泄漏"时无路可走）：

1. `CLI --revoke-sessions`（§9，不改密码就踢掉全部会话）；
2. 改密码（自动递增版本）。

→ **这条是 §8.2 选"不建名单"的前提**：不建名单可以，但**必须留一个真吊销的出口**。

### 8.3 自己改密码时：重新签发当前浏览器

改密会 `token_version + 1`，于是**包括自己在内**的所有 cookie 立刻失配。处理方式：

**流程**：校验旧口令通过 → 写新哈希 → `token_version + 1` → **用新版本给当前响应重新签发一份 cookie** → 跳回面板。

实测确认语义：

```
当前浏览器（新 cookie）: ok
其他设备的旧 cookie:      stale-version
```

| 对象 | 结果 |
| --- | --- |
| 当前浏览器 | 继续登录，**不掉线** |
| 其他已登录设备 | 立刻掉线（下次请求跳 `/login`） |

**为什么不用"连自己一起登出"**：那样用户改完密码会被弹到登录页，主观感受是"我被踢了"——而这是**他自己**刚做的操作。体验上说不通，且会让用户以为改密失败了。

**这同时定死了 #2 文档里的一处歧义**：`docs/accounts-decision.md` §3c 写「改完**轮换当前会话**（或强制重新登录）」——本票选**前者**，不留"或"。

---

## 9. CLI：`--revoke-sessions`（不改密码，只踢会话）

**结论：`src/cli/passwd.ts` 增加一个动作——推进 `token_version`，不动 `password_hash`。**

实测确认语义：

```
口令哈希是否变化: 否（不要求改密）
旧 cookie: stale-version
```

**为什么必须有它**：§8.2 里登出不能吊销，所以当用户怀疑「cookie 被别人看到了」时，唯一手段不能是"必须改密码"。改密码会改掉一个**用户记得住、且正在用**的东西——为了踢一个人而换密码，代价过高，实际结果是用户干脆不处理。

| CLI 动作 | 改 `password_hash` | 递增 `token_version` |
| --- | --- | --- |
| `--user <name>`（重置口令） | 是 | 是 |
| `--revoke-sessions --user <name>` | **否** | **是** |
| `--disable` / `--enable` | 否 | 否（`enabled` 每请求被查，立刻生效） |

**落点约束沿用 #2 §3b**：CLI **必须在 `src/cli/passwd.ts`**（编译进 `dist/`），因为 `scripts/` 不进生产镜像。

---

## 10. cookie 属性

| 属性 | 取值 | 理由 |
| --- | --- | --- |
| `HttpOnly` | **恒开** | cookie 只该被 HTTP 层看见，前端 JS 不需要读它（`status.js` 靠浏览器自动带 cookie，不读值） |
| `SameSite` | **`Lax`** | 内网个人站，跨站请求不该带会话；`Lax` 同时保住「从别处点链接进来仍是登录态」这个正常路径（`Strict` 会让从聊天工具点链接进来时显示未登录） |
| `Path` | **`/`** | 全站一个会话，不做分路径会话 |
| `Max-Age` | **604800**（7 天） | 与 `exp` 一致（§8.1） |
| `Secure` | **`SESSION_COOKIE_SECURE`，默认 `0`（关）** | 见下 |

**`Secure` 的开关**：`SESSION_COOKIE_SECURE=0|1`，**默认关**（map Notes 第 9 条：HTTPS 是后续需求，`Secure` 必须能关、默认关）。

- 命名直接映射属性名，**不做间接映射**（如 `HTTPS=true`）：运维看着变量名就知道自己在开什么。
- 开着的后果要写进 `README`：**若站点还是 HTTP，开了 `Secure` 浏览器不会存 cookie → 登录永远失败**，表现为"输对密码又跳回登录页"。这是默认必须为关的实际理由，不只是"还没上 HTTPS"。
- `SameSite` 与 `Secure` 相互独立，不做联动（`Lax` 在 HTTP 下可用）。

---

## 11. 实现落点

| 文件 | 改动 |
| --- | --- |
| `src/session.ts`（新） | `signSession(payload)`、`verifySession(token, user)`、`parseCookies(header)`、`sessionCookieHeader(token, opts)`、`clearCookieHeader(opts)`。**纯函数 + 只依赖 `node:crypto`**，可不过 HTTP 直接断言 |
| `src/users.ts`（新，属 #2 范围） | 建表时带 `token_version`；**本票追加**：`getAuthState(id)`（返回 `enabled`/`token_version`）、`bumpTokenVersion(id)` |
| `src/cli/passwd.ts`（新，属 #2 范围） | **本票追加** `--revoke-sessions` 动作（§9） |
| `src/config.ts` | 加 `sessionSecret`（**为空即拒绝启动**，§6）、`sessionCookieSecure`（默认 `false`）、`sessionTtlMs`（默认 7 天） |
| `src/server.ts` | 闸门钩子里调用 `verifySession()`；每请求查一次 `getAuthState()`（§7.5）；登录成功 / 改密后下发 cookie（§8.3） |
| `.env.example` | 记录 `SESSION_SECRET`（含生成命令）、`SESSION_COOKIE_SECURE`（含"HTTP 下开了会登录失败"的告警） |
| `README.md` | 密钥生成步骤；**登出不是吊销**的语义声明（§8.2）；真吊销走 CLI（§9）；`Secure` 与 HTTPS 的关系 |
| `scripts/e2e-check.mjs` | 见 §12 |
| `.env.example` / `README.md` | **由 [写路径的鉴权面](https://github.com/Lkyloveaw/lkyloveaw-home/issues/25) 追加**：`SITE_ORIGIN`（示例 + 「就是浏览器地址栏里那个 origin」，缺失即拒绝启动）、`TRUST_PROXY`（默认 `false`，**不许填 `true`**）。见 [`docs/write-path-auth-decision.md`](write-path-auth-decision.md) §3 |

**`verifySession` 抽成不依赖 Fastify 的纯函数**（与 #5 把 `toPublicSummary()` 抽出来的理由相同）：判定表 §4 的 14 个用例可以**不过 HTTP 直接断言**，包括"签名长度不对不抛 500"这种 HTTP 层很难稳定复现的情形。

---

## 12. 验收（回归用例清单）

判定表 §4 的 14 个用例已在本机跑通（**14/14**）。落地时转成脚本断言，另加：

| 前置 | 操作 | 预期 |
| --- | --- | --- |
| 无 cookie | `GET /status` | `302 → /login?next=/status`（闸门票 §3） |
| 无 cookie | `GET /api/status`（`Accept: application/json`） | `401 {"error":"unauthorized"}`，**不是 302** |
| 有效 cookie | `GET /status` | `200` |
| 有效 cookie | `GET /api/status` | `200`，且响应里**不含**签名密钥/`pv` |
| 有效 cookie | 把 cookie 值改一个字符 | 401/302（**且不是 500**，§3） |
| 有效 cookie | 截断 cookie 值（签名长度不足） | 401/302（**回归：`timingSafeEqual` 不抛出**） |
| 有效 cookie | 手工构造 `exp` 已过的 token | 401/302 |
| 有效 cookie | 改密后**用旧 cookie** | 401/302（`stale-version`） |
| 有效 cookie | CLI `--revoke-sessions` 后用旧 cookie | 401/302，且**口令未变**仍能用新登录 |
| 有效 cookie | 账号 `enabled=0` 后用旧 cookie | 401/302（**回归：停用不是摆设**） |
| 改密中 | 提交改密表单 | 当前浏览器**仍是登录态**（§8.3），其他浏览器掉线 |
| 缺 `SESSION_SECRET` | 启动 | **进程退出**，日志含生成命令（§6） |
| 旧库（无 `token_version`） | 启动 | 补列成功，既有账号**不掉线**（§7.4） |
| 旧库 | 连续启动两次 | 幂等，无报错（§7.4） |

**断言质量要求**（沿用 #9「验收补强」的原则）：每一条**必须先证明前提成立**——例如"改密后旧 cookie 失效"必须**先证明改密前该 cookie 是 200**，否则又写成一条恒真断言。

---

## 13. 边界

- 本票只定**会话的签发/校验/失效**。闸门挂在哪、白名单、302/401 分流由 [`给整个站点加登录闸门`](https://github.com/Lkyloveaw/personal-wiki/issues/3) 定（已关闭，见 `docs/login-gate-decision-table.md`）。
- `users` 表结构与口令哈希由 [`账号存储与口令校验`](https://github.com/Lkyloveaw/personal-wiki/issues/2) 定（已关闭，见 `docs/accounts-decision.md`）；**本票对它的唯一追加是 `token_version` 一列**，并定死其文档里「轮换当前会话（或强制重新登录）」的歧义（§8.3）。
- 登录页 POST 路径沿用闸门票定的 `/login`。
- **登录失败次数限制 / 速率限制不在本票**（map 的 Not yet specified 有登记）——它拦的是**登录尝试**，本票管的是**已签发会话**，两者不重叠。
- **HTTPS 不在本票**：本票只保证 `Secure` 能关、默认关（§10）。
- 日志是否记录"谁在什么时候登录过"不在本票（map 的 Not yet specified 有登记）。
- 本票产出判定表，**不写实现代码**。
