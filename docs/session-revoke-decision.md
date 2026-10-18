# 会话吊销的落地设计：`sessions` 表、`sid` 载荷、登出与失效判定表

本文件是「会话吊销的落地设计」这张票的产出（map：[个人站自管化](https://github.com/Lkyloveaw/lkyloveaw-home/issues/20)）。

票：<https://github.com/Lkyloveaw/lkyloveaw-home/issues/29>

它把 map Notes 里那条已敲定的决定——**「登出 = 服务端吊销该 cookie（`sessions` 表 + cookie 带 `sid`）」**——
落到可实施的形状：表结构、cookie 载荷、每请求的查询、四种失效情形的路径、清理策略，以及一张**能不过 HTTP 直接断言**的判定表。

> ⚠ **本票只产决定**（map 目的地：本图只产决定）。本文**不含实现代码**。
> 落地由 [实现批次怎么切](https://github.com/Lkyloveaw/lkyloveaw-home/issues/27) 切出的批次票执行；
> 本文的「落点」与「验收」是那些票的输入。

---

## 0. 七个决定（一句话版）

| # | 问题 | 结论 |
| --- | --- | --- |
| 1 | cookie 载荷 | `uid + exp + pv + sid`，**新增 `sid`，其余三个字段一个不动** |
| 2 | `sid` 怎么生成、怎么存 | 128 位随机（`randomBytes(16).toString('base64url')`，22 字符），**明文存主键**（要能在会话管理 UI 里直接删） |
| 3 | `sessions.pv` 是什么 | 签发那一刻该账号 `token_version` 的**快照**，不参与判定；判定用「快照 ≠ 当前值」表示**其他设备轮换过凭据** |
| 4 | 表结构与索引 | `sid`(PK) / `uid` / `pv` / `created_at` / `expires_at` / `revoked_at`，索引只建 `(uid)`；时间全是 epoch ms |
| 5 | 每请求几次库查询 | **一次**（`sessions ⋈ users` 一条 JOIN），替换今天的 `getAuthState`；查库失败 fail-closed 且**不下发清 cookie 头** |
| 6 | 四种失效情形 | 登出=`revoked_at`；过期=`exp` 与 `expires_at` 各判一次；停用=`enabled`；改密=`token_version` 与 `revokeUserSessions` 双保险（§6） |
| 7 | 清理与「登出全部设备」 | 清理挂在**已有探测轮次**上（`checkpointEveryRounds`），只删「已过期或已吊销」的行；「登出全部设备」仍是 CLI `--revoke-sessions`，第一版不做会话管理 UI |

---

## 1. `sessions` 表

```sql
CREATE TABLE IF NOT EXISTS sessions (
  sid        TEXT    PRIMARY KEY,
  uid        INTEGER NOT NULL,
  pv         INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_sessions_uid ON sessions (uid);
```

**为什么 `sid` 用明文主键、不做哈希**：本仓库的当面威胁是「内网里有人拿到了 cookie」或「要踢掉一台设备」，
不是「攻击者已经能读你的 SQLite 文件」。真到了那一步，`password_hash`、目标 URL、历史库**全都在同一个文件里**，
把 `sid` 哈希掉属于**挑一处上锁**，防守的是已经失守的边界，代价是运维再也无法按 `sid` 删除一行。
个人站单进程单文件（ADR 0001），这个取舍是明确的。

**为什么 `uid` 没有外键**：`users` 表没有开外键约束，删号又不在任何 UI 里，
INNER JOIN 已经能让「用户不存在」正确地落到 `unknown-user`；加一半的外键只会让迁移路径多一个失败模式。

**为什么索引只建 `(uid)`**：它同时服务两个真实查询——「登出全部设备」（`WHERE uid = ?`）与
「账号级联吊销」（同上）。定期清理的扫描面是**整张表**，索引帮不上忙，
而这张表的行数上限是「账号数 × 设备数」（个位 × 个位），**不值得为清理再建一个索引**。

**为什么 `revoked_at` 不用布尔**：时间戳免费带来「什么时候被吊销的」，
排查「忽然掉线」时这是第一个要看的字段；而 `revoked_at IS NOT NULL` 与布尔一样好写。

**「会话记录」的时间单位一律 epoch ms**，与 `users.created_at`、`probes.at`、`session.exp` 一致——
混入秒级是这类代码里最容易埋的一颗雷。

---

## 2. cookie 载荷：新增 `sid`，`uid/exp/pv` 一个不动

```json
{"uid":1,"exp":1792661257282,"pv":3,"sid":"K7fQ2mZx1pR4tVb9nLcEwA"}
```

载荷仍是**签名的、不是加密的**（`docs/session-decision.md` §1 的既有结论），所以这四样都不是机密：
`uid` 是主键、`exp` 是时间、`pv` 是版本号、`sid` 是**不透明随机串**。

**不放的东西一个都不新增**：`username`、`role` 仍然不放（第二份真相，见 `roles-decision.md` §2）。

| 字段 | 放不放 | 理由 |
| --- | --- | --- |
| `uid` | **放** | 判「查哪一行」前先解出来；`id` 不可改（#2 已定） |
| `exp` | **放** | 不查库就能拒绝过期 cookie，也保住「无状态判定」这条可测性 |
| `pv` | **放** | §6 改密情形的第二道保险（且 `docs/session-decision.md` §4 判定表原样保留） |
| `sid` | **放** | 本次新增：**吊销的把手** |
| `username` / `role` | **不放** | 维持既有决定 |

**`exp` 与 `sessions.expires_at` 必须写同一个 `ttlMs`**（`config.sessionTtlMs`），
与「`Max-Age` 必须与 `exp` 一致」是同一条纪律（`docs/session-decision.md` §8.1）：
两者不一致 = 一个地方说活着、另一个地方说死了。

### 迁移影响：**上线那一刻，所有既有 cookie 立刻失效**

旧 cookie 没有 `sid` → 判定表第 7 条 → `malformed` → 302 到登录页。

**这是不可绕过的**：要让一份既有 token 继续可用，就得为它补造一行 `sessions`——
可那正是「先信任、后补票」，等于给一个**无法验证的**凭据发一张合法的会话记录。
一次性重新登录是正确方向的代价，不是缺陷。已登记在 §10。

---

## 3. 判定函数：`decideSession()`

沿用 `verifySession()` 已经验证过的形状（`src/session.ts:81`）：**纯函数、不做任何 I/O**。

```ts
/** 判定所需的最小状态：一次查询的结果（会话行 + 账号行）。 */
export interface SessionState {
  session: { sid: string; uid: number; pv: number; expiresAt: number; revokedAt: number | null }
  /** 账号不存在时为 null。 */
  user: { id: number; enabled: number; tokenVersion: number } | null
}

export type SessionVerdict =
  | 'ok'
  | 'no-token'
  | 'malformed'
  | 'bad-signature'
  | 'expired'
  | 'session-unknown'   // 表里没有这一行：已清理、手改 cookie、或库里被删
  | 'revoked'           // 这一行被显式吊销（登出 / 登出全部设备 / 改密级联）
  | 'unknown-user'      // 会话行在，账号行不在
  | 'disabled'
  | 'stale-version'     // 本会话签发后，其他设备轮换过凭据

export function decideSession(
  secret: string,
  token: string | undefined | null,
  state: SessionState | null | undefined,
  now: number = Date.now(),
): SessionVerdict
```

**为什么把 `session` 与 `user` 放在一个 `state` 里传进来**：闸门每请求只需要**一次**库查询（§4），
所以判定函数的输入就是那次查询的全部结果。副作用是它比 `verifySession()` 更好断言——
`state` 是一个纯数据字面量，判定表可以直接构造，不需要造库、造 HTTP。

**为什么保留 `pv` 那道判定**（第 14 条）：吊销的主通道已经是 `sessions` 行，
`pv` 是**冗余的**——但它防的是「被清理/迁移弄丢的会话行被复用」这类异常，
且它的存在让 `docs/session-decision.md` §4 的判定表**原样继续成立**，回归面不缩小。
冗余在这里是防御纵深，不是第二份真相：`sessions.pv` 是**快照**，`users.token_version` 是**当前值**，
唯一有意义的语义是「两者是否相等」。

> ⚠ **一个措辞纪律**（写进 `docs/session-decision.md` 的修订注记）：
> 今天 `stale-version` 的语义是「凭据代次失配」；本票之后它窄化为
> 「**本会话签发后，该账号的凭据被轮换过**」——单设备登出**不会**再落到它，落 `revoked`。

---

## 4. 闸门每请求：一次查询

```sql
SELECT s.sid AS sid, s.uid AS uid, s.pv AS pv,
       s.expires_at AS expiresAt, s.revoked_at AS revokedAt,
       u.enabled AS enabled, u.token_version AS tokenVersion
  FROM sessions s
  LEFT JOIN users u ON u.id = s.uid
 WHERE s.sid = ?
```

流程（`src/auth.ts` 的 `decideRequest` 内）：

1. 白名单命中 → 放行（**不动**，`docs/login-gate-decision-table.md` §2 原样）；
2. 解 cookie → 无 token 即 `no-token`（不查库）；
3. `decodePayload(token)` 取 `sid`；取不到（含旧 cookie）→ `malformed`（不查库）；
4. **一次** SQL 拿 `state`；查库抛错 → 记 `console.error`、按未登录处理、**不下发清 cookie 头**；
5. `decideSession(config.sessionSecret, token, state, now)`；
6. `!== 'ok'` → 按今天的形状分流（页面 302 / API 401），并 `console.warn` 记判决值。

**为什么用 `LEFT JOIN` 而不是 `INNER JOIN`**：要能区分「会话行不存在」（`session-unknown`）与
「会话行在、账号行没了」（`unknown-user`）。`INNER JOIN` 会把两者压成同一个结果，
而它们的排查方向完全不同（一个是清理/伪造，一个是删号/迁移）。

**为什么是一次查询而不是两次**：`roles-decision.md` §2 已经定下「角色并进闸门那次 `getAuthState`，不新增查询次数」——
本票把那次查询从「单表 `users`」升级成「`sessions ⋈ users`」，查询次数**不变**。
`pv`/`role`/`enabled` 都在同一行里拿到，所以判定、显示、授权三件事共享同一次读，不会出现「三处各查一次、彼此不一致」。

**查库失败仍旧 fail-closed，且不清 cookie**（沿用 `docs/session-decision.md` §7.6）：
DB 抖动是瞬时的，用户的会话其实有效；清 cookie 等于把一次抖动升级成一次登出。
「查不到」与「查到了但判决不是 ok」都落到未登录，**区分只体现在日志里**。

**`/healthz` 与静态白名单不受影响**；`/admin` 这类新写接口由下游票（#25）定，
本票只保证 `decideRequest` 交出去的判决值比今天更细。

---

## 5. 判定表（可执行版）

`decideSession` 的返回值就是拒绝原因，闸门只判断 `=== 'ok'`。
下面 24 行是**落地时的断言清单**（编号即用例名，落点见 §11）。
`secret = 'k'.repeat(32)`；`exp = now + 60_000`，除注明外。

| # | 输入情形 | 结果 |
| --- | --- | --- |
| 1 | 签名正确、未过期、`sid` 有行、账号 `enabled=1`、`pv` 一致 | `ok` |
| 2 | 空 / 缺失 cookie | `no-token` |
| 3 | 无 `.` 分隔符 | `malformed` |
| 4 | `.` 在开头 | `malformed` |
| 5 | `.` 在结尾 | `malformed` |
| 6 | 签名被截断（byte 长度不等） | `bad-signature`，**不抛异常** |
| 7 | 签名改一个字符（等长） | `bad-signature` |
| 8 | 换了 `SESSION_SECRET` 后验旧 token | `bad-signature` |
| 9 | 改了载荷但签名没跟着换 | `bad-signature` |
| 10 | 载荷不是合法 JSON | `malformed` |
| 11 | 载荷缺 `exp` | `malformed` |
| 12 | `exp` 是字符串 `"1792…"`（非数字） | `malformed` |
| 13 | 载荷缺 `sid`（**这正是上线那一刻的既有 cookie**） | `malformed` |
| 14 | `sid` 是空字符串 | `malformed` |
| 15 | `now === exp` | `expired` |
| 16 | `now === exp - 1` | `ok` |
| 17 | `state === null`（会话行与账号行都查不到） | `session-unknown` |
| 18 | 会话行不存在（已清理 / 手改 `sid`） | `session-unknown` |
| 19 | 会话行 `revoked_at` 非空 | `revoked` |
| 20 | 会话行 `expires_at <= now`（载荷窗口内，但记录已过期） | `expired` |
| 21 | 会话行在，账号行不在 | `unknown-user` |
| 22 | `enabled = 0` | `disabled` |
| 23 | `user.tokenVersion !== session.pv`（其他设备轮换过凭据） | `stale-version` |
| 24 | 单设备登出后（同账号另一台设备的 cookie） | `ok` —— **只吊销这一个 cookie**（§6.1） |

**第 24 行是本票存在的理由**：它是「登出 = 真吊销」与「登出 ≠ 踢掉所有设备」的**同时**证明。
只断言「登出后原 cookie 失效」是不够的——那样把「登出」实现成 `bumpTokenVersion` 也能过，
而用户要的恰恰是**不要**那样（map Notes 第 2 条）。

**第 13 行是迁移的回归护栏**：它同时是「旧 cookie 不被接受」的断言，
也是「实现时不小心放宽 `sid` 校验」的报警器。

**形状校验不能省**（沿用 `docs/session-decision.md` §4 的教训）：
`exp` 缺失或非数字会让 `now < exp` 恒为 `false`（看起来像「过期」，无害）
或恒为 `NaN 比较`（**看起来像「永久有效」，是个静默的安全洞**）。
`sid` 缺失若不显式拒绝，就会变成「查 `WHERE sid = undefined` → 查不到 → `session-unknown`」，
虽然也拦住了，但把「旧 cookie / 手改载荷」与「记录被清理」混成一类，日志里再难分辨。

**判定顺序是有意的**（与 §3 的编号一一对应）：
签名与形状先于**任何**库查询（廉价拒绝，且不把未鉴权输入变成查询压力），
载荷 `exp` 先于会话行（不查库就能挡掉过期 cookie），
会话行先于账号行（`session-unknown` 与 `unknown-user` 的区分，见 §3 的措辞纪律）。

---

## 6. 四种失效情形：各自的路径

map Notes 第 2 条只点了「登出」；`roles-decision.md` §7 明确点名本票要覆盖
**登出 / 过期 / 账号停用 / 改密**四格。

| 情形 | 触发 | 数据面动作 | 被判成 | 其他设备受影响？ |
| --- | --- | --- | --- | --- |
| **登出** | `POST /logout`（本机） | `UPDATE sessions SET revoked_at = now WHERE sid = ?` | `revoked` | **否**（§6.1） |
| **过期** | 时间到了 | 无（惰性判定 + 定期清理） | `expired` | 否（各自独立到期） |
| **账号停用** | 管理台 / CLI `--disable` | 无（`enabled` 每请求查） | `disabled` | **是**（该账号全部设备） |
| **改密** | 网页自助改密 / CLI 重置口令 | `revokeUserSessions(uid)` **与** `token_version + 1` 一起 | `revoked` | **是**（该账号全部设备） |

### 6.1 登出：只吊销这一行，**不**碰 `token_version`

```
POST /logout
  → sid = decodePayload(readSessionCookie(...))
  → sid 存在则 UPDATE sessions SET revoked_at = ? WHERE sid = ?
  → 下发清 cookie 头（clearCookieHeader，不变）
  → 302 /login
```

- **幂等**：同一 cookie 重复 POST，第二次 `changes = 0`，响应相同（不报错、不 500）。
- **没有 cookie / 没有 `sid`**：跳过 UPDATE，仍旧清 cookie + 302。登出永远「成功」——
  这是登出该有的语义，不能因为库里没有那行而给用户一个错误页。
- **为什么不 `DELETE`**：留着 `revoked_at` 才能分辨「被吊销」与「被清理」，
  而这正是排查「我明明登出了，日志里为什么是 `session-unknown`」的唯一线索。
  清理靠 §7，行不会长期堆积。
- **为什么不顺手 `bumpTokenVersion`**：那就是「单设备登出 = 踢掉全部设备」，
  与 map Notes 第 2 条（用户原话：**服务端就认为这个 cookie 报销**，单数）直接冲突。
  要「一次踢掉全部设备」的语义由 §8 的 CLI 提供，两个动作不能混。

### 6.2 过期：两处各判一次，**不是** redundancy

- 载荷 `exp`（第 15 行）：不查库就能拒绝，保住无状态判定的可测性；
- `sessions.expires_at`（第 20 行）：**会话记录自己也有寿命**，这样清理可以按表扫描，
  不必解每一个 cookie；也防住「cookie 载荷被伪造出一个超长 `exp`」——签名挡住伪造，
  但「签发时的 TTL 被误配成一年」这类错误只有落在表里才看得见。

**7 天绝对过期、不滑动续期**不变（`docs/session-decision.md` §8.1）：
每请求重算 `exp` 就要每响应发 `Set-Cookie`，token 再也无法靠相等做去重/排查。

### 6.3 账号停用：不动作，判定即可

`enabled` 今天就是每请求查的（`docs/session-decision.md` §7.3），现在它跟着那条 JOIN 一起回来，
**不新增查询**。停用**不必**吊销会话行：判定第 22 条先于任何会话状态，
停用的人立刻进不来；恢复启用后旧 cookie 会不会复活？

> **会复活，且这是有意的**：`--enable` 是 `roles-decision.md` §3 点名的**恢复通道**（「永不设卡」）。
> 若停用即级联吊销，一次误停用 + 启用就会把用户的全部设备踢掉，
> 而「停用」这个动作的语义是**暂时不许进**，不是「销毁凭据」。要销毁凭据是改密。

### 6.4 改密：级联吊销 + `token_version + 1`，**双保险**

```
setPassword(uid, next)           // 既有函数：写哈希 + token_version + 1
  + revokeUserSessions(uid)      // 本次新增：UPDATE sessions SET revoked_at WHERE uid = ? AND revoked_at IS NULL
```

两条一起做，且**放在同一个事务里**（`better-sqlite3` 的 `db.transaction`）：

| 只做其中一条 | 后果 |
| --- | --- |
| 只吊销会话行 | 若会话行因清理/迁移丢失，旧 token 靠原 `pv` 仍能通过 → 改密**可能悄悄不生效** |
| 只 `token_version + 1` | 今天就是这个状态：能生效，但「为什么掉线」的答案在 `users` 表里，不在会话面上；且单设备登出**没有**这条通道 |
| 两条都做 | 改密 = 该账号全部凭据一起换代，与用户的心理预期一致 |

**顺序**：先吊销会话行、后写新哈希（同一事务内，崩溃则整体回滚，不存在中间态）。
理由：若必须二选一先后，先 `revoke` 后 `setPassword` 的「半途失败」是**更安全的一半**——
用户仍能用旧口令登录（没有被锁在外面），而先写哈希后吊销的半途失败会让旧会话在旧口令已作废后仍活着。

**自己不掉线**：改密响应里**重新签发**一份新 cookie（新 `pv` + 新 `sid` + 新行），
沿用 `docs/session-decision.md` §8.3 的既有结论，只是签发多了一个 `sid`。

**其他设备**：落到 `revoked`（会话行先命中）——这就是 §3 那条措辞纪律的由来。

### 6.5 四种情形的判定优先级（一张图）

```
无 token                       → no-token
签名/形状不对（含旧 cookie）     → malformed / bad-signature     ← 不查库
载荷 exp 到了                   → expired                        ← 不查库
会话行不存在                    → session-unknown                ← 查库后
会话行 revoked_at 非空          → revoked        （登出 / 改密级联）
会话行 expires_at 到了          → expired
账号行不存在                    → unknown-user
账号 enabled=0                 → disabled       （停用）
账号 token_version ≠ 会话 pv    → stale-version  （其他设备轮换过凭据）
否则                            → ok
```

---

## 7. 过期行的清理：挂在已有的探测轮次上，**只删已死行**

```ts
/** 返回删除行数。now 由调用方注入，便于断言。 */
export function sweepSessions(now = Date.now()): number
// DELETE FROM sessions WHERE expires_at <= ? OR revoked_at IS NOT NULL
```

- **什么时候跑**：进程启动时一次，之后**每 `config.checkpointEveryRounds` 轮探测**一次
  （默认 60 轮 ≈ 1 小时）。探测轮次是本进程**唯一的心跳**——
  既有取舍是「不为清理再开一个定时器」（`docs/session-decision.md` §9 的同一原则，
  `config.ts:199` 的注释也写着这句）。所以在 `probe.ts` 已有的按轮副作用里多挂一个调用。
- **清理不是安全机制**：四种失效**全部**靠每请求判定生效（§6）。
  `sweepSessions` 只负责「别让死行堆积」——把它写到 `onRequest` 里是**错的**，
  那会让每个请求都可能触发一次全表写。
- **删行不区分「过期」与「已吊销」**：第一版**没有**会话管理 UI，历史没有读者；
  而「不留废弃数据自动增长」是单文件 SQLite 的运维底线（`store.ts` 的
  `pruneOldProbes()` 是同一形状的先例）。
  ⚠ **若将来要做「会话管理 UI」（map 迷雾里那条），这一条要回来改**：那时需要一个保留窗口
  （如「已吊销的行留 30 天供查看」），落点记在 map 迷雾，不升票。
- **不做按行懒清理**（判定命中的那一次顺手删）：它把一次读变成一次写，
  在 `onRequest` 路径上引入写锁竞争，且「读请求会写库」会让排查时的因果链变脏。

---

## 8. 「登出全部设备」放哪：**CLI 保留，第一版不做会话 UI**

map Notes 第 4 条已定：**会话管理 UI 第一版不做**，但 `sessions` 表必建。

| 通道 | 覆盖范围 | 本次动作 |
| --- | --- | --- |
| `POST /logout` | **单个** cookie | 改为真吊销（§6.1） |
| CLI `--revoke-sessions --user X` | 该账号**全部** cookie | **保留**，仍是「一次踢掉全部设备」的通道 |
| CLI `--user X --password …`（重置口令） | 该账号全部 cookie | 顺带级联吊销（§6.4） |
| 管理台里的「登出全部设备」按钮 | 该账号全部 cookie | **不做**（要等会话管理 UI，属 map 迷雾） |
| 管理台里「看谁在线 / 踢单台」 | — | **不做**（map Notes 第 4 条） |

**CLI 今天走的是 `bumpTokenVersion`**（`src/cli/passwd.ts:155`），本票之后**追加** `revokeUserSessions`，
两条一起做。CLI 是**救援通道**：怀疑凭据泄漏时，它必须能在没有网页、没有会话密钥的机器上生效
（`passwd.ts:118-119` 已定 CLI 不调 `assertSessionSecret`），这一点不因新增会话表而改变。

**CLI 输出要跟着改**：今天打印「凭据代次 → N」；之后要额外打印**吊销了几行会话**
（`revokeUserSessions` 的 `changes`），否则运维看不出「到底有没有踢到人」。

---

## 9. 接口与落点

### 9.1 模块边界

| 文件 | 改动 | 归属 |
| --- | --- | --- |
| `src/session.ts` | 载荷加 `sid`；`issueSession` 变成接收 `sid`；新增 `decideSession()`（纯函数）；`SessionUser` 换成 `SessionState` | 本票 |
| `src/sessions-store.ts`（新） | `createSession` / `findSessionState` / `revokeSession` / `revokeUserSessions` / `sweepSessions`。**纯 SQLite，不碰 HTTP** | 本票 |
| `src/users.ts` | `initUsers()` 里建 `sessions` 表（新库直接建，旧库 `CREATE TABLE IF NOT EXISTS` 即可，**无需补列**）；`setPassword` 与本票的级联吊销放进同一事务 | 本票 |
| `src/auth.ts` | `decideRequest` 改走 `decodePayload → sid → findSessionState → decideSession`；`verifySession` 的导入换掉 | 本票 |
| `src/server.ts` | 登录成功时先 `createSession` 再签发（`sid` 进载荷）；`/logout` 改真吊销 + 幂等；改密后重签新 `sid` | 本票 |
| `src/probe.ts` | 每 `checkpointEveryRounds` 轮调用一次 `sweepSessions()`（与 checkpoint 并列） | 本票 |
| `src/cli/passwd.ts` | `--revoke-sessions` 追加 `revokeUserSessions` 并打印行数 | 本票 |
| `docs/session-decision.md` | §0 第 4 条、§8.2 就地留下修订指针（§10 的登记） | 本票 |
| `CONTEXT.md` | 新增词条 **吊销（revoke）** / **登出（logout）** / **会话记录（session record）** | 本票 |

**为什么单独开 `src/sessions-store.ts` 而不是塞进 `store.ts` 或 `users.ts`**：
`store.ts` 是**探测历史**，`users.ts` 是**账号**，会话记录是第三件事。
`docs/login-gate-decision-table.md` §1 的分层理由（「判定」与「路由」分开）在这里同样适用：
会话存储是纯库函数，判定是纯函数，两者都可以不过 HTTP 直接断言。
`verifySession` 当年抽出 `src/session.ts` 就是为了这个（`docs/session-decision.md` §11），本票沿用。

**为什么 `sessions` 表建在 `initUsers()` 里而不是 `initStore()` 里**：
建表顺序上 `sessions` 引用 `users.id`，跟着 `users` 走最不容易出现「先建表后建用户表」的半成品；
且 `initUsers()` 已经是「账号域的迁移入口」（`token_version`、`role` 都在这里补）。

### 9.2 新增/变更的签名

```ts
// src/sessions-store.ts
export function createSession(uid: number, pv: number, ttlMs: number, now?: number): { sid: string; expiresAt: number }
export function findSessionState(sid: string): SessionState | null        // §4 的那条 JOIN
export function revokeSession(sid: string, now?: number): number          // changes
export function revokeUserSessions(uid: number, now?: number): number     // changes
export function sweepSessions(now?: number): number                       // changes

// src/session.ts
export function issueSession(secret: string, uid: number, pv: number, sid: string, ttlMs?: number): string
export function decodeSid(token: string): string | undefined              // 不验签；等价于今天的 decodePayload
```

`now` 一律可注入：判定表 §5 的第 15/16/19/20 行都要求**在固定时钟上断言**，
用 `Date.now()` 直接写的判定函数没法稳定测「`now === exp` 这一毫秒」。

---

## 10. 对既有决定的显式修订（不偷偷改）

按 map Notes「对本仓库既有决定的显式修订（不要偷偷改）」的要求登记：

| 既有文件 | 原文 | 本票 |
| --- | --- | --- |
| `docs/session-decision.md` §0 第 4 条 | 「登出：**只清 cookie**，不建服务端吊销名单；真吊销走 CLI」 | **推翻**：建 `sessions` 表，登出即吊销该行。CLI `--revoke-sessions` **保留**（一次踢全部设备仍是它的活） |
| `docs/session-decision.md` §8.2 | 「登出不是吊销，只是本机遗忘」整节 | **推翻**：登出**是**吊销（§6.1）。该节的「必须留一个真吊销出口」这条推理仍然成立，出口从 CLI 变成「登出 + CLI」 |
| `docs/session-decision.md` §5 载荷表 | 「只放 `uid + exp + pv`」 | **追加 `sid`**；`username` / `role` 仍不放 |
| `docs/session-decision.md` §4 判定表 | 12 行，无会话记录概念 | **原样保留并新增**：本票 §5 是它的超集，第 1–16 行与它一一对应，第 17–24 行是新增 |
| `docs/session-decision.md` §11 落点表 | `verifySession(token, user)` | 闸门改调 `decideSession(token, state)`；`verifySession` 的职责被它取代 |
| `docs/roles-decision.md` §3 | 「重置口令：递增 `token_version`，踢掉该账号全部会话」 | **结论不变，实现加一条**：同时 `revokeUserSessions`（§6.4），会话行是「为什么掉线」的可读答案 |
| `CONTEXT.md` | 无「吊销」「会话记录」词条 | 新增（§9.1） |

> ⚠ **与 map Notes 第 2 条的一处措辞偏差，登记在此**：map 写的是「登出**删**该行，
> 只吊销这一个 cookie」。本票改成 **`revoked_at` 标记**（§6.1），语义**完全一致**
> （服务端就此认为这个 cookie 报销，其余 cookie 不受影响），差别只在**行留到清理为止**。
> 理由是保留「被吊销 / 被清理」的可分辨性；不这样做的代价是排查时两种情形混成 `session-unknown`。
> 若用户要的就是「物理删行」，改动只有一行 SQL，且 §5 的判定表**不需要任何变动**。

**不动的东西**：7 天绝对过期、`Secure` 默认关、`SESSION_SECRET` 缺了就拒绝启动、
白名单精确匹配、fail-closed 且不清 cookie、`token_version` 仍是会话域的一列。

### 10.1 已知后果（写在这里，不藏在代码里）

1. **上线那一刻全部既有 cookie 失效**（§2），用户要重新登录一次。
2. **`sessions` 表是新的运维面**：备份/恢复数据库会连同会话记录一起搬走，
   所以「恢复一份旧备份」会让当时的会话**继续有效**——这是 `db.backup()` 语义的自然外延，
   与目标清单搬进 DB 后的同类风险一起，归 [站点设置与备份的真源边界](https://github.com/Lkyloveaw/lkyloveaw-home/issues/22) 与批次票考虑。
   ✅ **落点已补**（2026-10-18，[实现⑥备份页与手动备份一次](https://github.com/Lkyloveaw/lkyloveaw-home/issues/43)）：
   这句话现在**写在管理台的备份页上**（`/admin/backups` 的 warn 段，与「下载 / 恢复不在网页上、属 SSH」并列），
   不再只留在文档里。
3. **`sessions` 表不区分设备**（没有 UA/IP 列）：第一版只按 `sid` 认行。
   要「看设备」就得加列，属会话管理 UI 的迷雾，不在本票。
4. **`sid` 明文入库**（§1）已写明取舍。

---

## 11. 验收（落地时的断言清单）

判定表 §5 的 24 行**全部**要落成断言，落点：

| 文件 | 内容 |
| --- | --- |
| `scripts/unit-check.mjs`（追加） | §5 第 1–24 行的纯函数断言 + `sweepSessions` 的删除行数 |
| `scripts/schema-check.mjs`（新增或并入 unit-check） | 旧库（无 `sessions` 表）与空库两种情形下建表幂等；一次查询 JOIN 的返回形状；`revokeSession` 的 `changes`（重复吊销 → 0） |
| `scripts/e2e-check.mjs`（追加） | ①登录 → 200；②登出后**同一** cookie → 302/401；③**同账号第二台设备的 cookie 登出后仍 200**（§5 第 24 行，本票的核心）；④改密后旧 cookie 失效且当前浏览器仍登录；⑤`--revoke-sessions` 后旧 cookie 失效而口令未变；⑥停用后旧 cookie 失效；⑦旧格式 cookie（无 `sid`）→ 302 而非 500 |

**断言质量要求**（沿用既有「验收补强」原则）：
每条**必须先证明前提成立**——「登出后失效」必须先断言登出前该 cookie 是 `200`；
「第二台设备仍有效」必须先断言它此前也是 `200`。否则又是一条恒真断言。

> ⚠ **本票产出时，判定表与表结构没有在本机跑过。** 产出这张票的会话里
> `ops_bash`（缺 bash IPC 兼容收据）与 `pwsh`（执行策略禁止 `prepare-workspace.ps1`）都不可用，
> 没有可用的命令通道，所以 §5 的 24 行与 §1 的建表**一行都没实测**。
>
> 这**不像** `docs/session-decision.md` §4 那 14 行——那张判定表是实测过的，本文不是。
> 所以：**§5 是待验证的断言清单，不是已验证的结论**；落地时第一件事就是把它们跑成绿，
> 跑出与本文不一致的行，**改本文**，不要改断言去迁就实现（第 13、24 行尤其容易被"顺手放宽"）。
> 需要更强证据的读者，请在有 shell 的会话里按 §11 的落点补跑。

---

## 12. 边界

- **本票不定**写路径的鉴权与 CSRF（[写路径的鉴权面](https://github.com/Lkyloveaw/lkyloveaw-home/issues/25)）、
  管理台的信息架构（[管理台的信息架构与入口](https://github.com/Lkyloveaw/lkyloveaw-home/issues/23)）。
  本票只保证 `decideRequest` 交出的判决值**更细**（新增 `revoked` / `session-unknown`），
  下游票可以用它做更精确的错误呈现。
- **登录失败次数限制 / 速率限制**不在本票，也不在它阻塞的任何票（`docs/session-decision.md` §13 已登记）。
- **HTTPS / `Secure` 默认值**不在本票。
- **审计**（谁在何时登录、谁吊销了谁）仍是 map 迷雾：本票让「会话」第一次成为可查询的行，
  但「在哪看、留多久」还不够锐利，不升票（`roles-decision.md` §7 对角色日志给了同一条判断）。
- **会话管理 UI**（看设备、踢单台）仍是 map 迷雾，第一版不做（map Notes 第 4 条）。
- 本票产出判定表 + 落点，**不写实现代码**。
