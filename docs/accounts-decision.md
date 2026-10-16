# 账号存储与口令校验：实现决定

本文件是「账号存储与口令校验」这张票的产出。
回答四个问题：**口令哈希选谁**、**`users` 表长什么样**、**改密码走哪条路**、**零账号时怎么办**。

票：<https://github.com/Lkyloveaw/personal-wiki/issues/2>

---

## 1. 口令哈希：选 `bcryptjs`，不选 `bcrypt`

**结论：`bcryptjs@3.0.3`。**

已实测（本机真实安装 + 运行验证）：

| 判据 | `bcrypt@6.0.0` | `bcryptjs@3.0.3` |
| --- | --- | --- |
| `install` 脚本 | **有** `node-gyp-build`（可能触发原生编译） | **无**（只有 `build`/`test`，npm 装包不执行） |
| 原生产物（`.node`/`binding.gyp`） | 有（N-API 预编译，平台不匹配就回退编译） | **0 个，纯 JS** |
| 依赖 | 有 | **0 个依赖** |
| 体积 | 较大 | **80KB** |
| 自带 TS 类型 | 需 `@types/bcrypt` | **自带**，NodeNext + strict 直接通过 |
| 哈希格式 | `$2b$` | **`$2b$10$…`，60 字符，真 bcrypt**（实测 `compare` 正确/错误口令分别 true/false） |

**决定性理由不是「原生编译麻烦」，而是运行期镜像里没有编译器**：

`Dockerfile:23-25` 的运行期阶段是 `npm ci --omit=dev`，且注释明确写着「运行期镜像不需要保留编译器」——`python3/make/g++` 已被清掉。`bcrypt` 在 Linux 上通常命中 N-API 预编译产物，**但只要预编译缺失（新架构、libc 变体、Node 版本跃迁），`node-gyp-build` 就会回退去现场编译，而镜像里没有编译器，构建当场失败**。

这是一个**条件触发的地雷**：平时不响，环境一变就炸，且炸在构建期而不是运行期。`bcryptjs` 把这个失败模式整个删掉。

**性能代价可接受**。实测 `bcryptjs` 在本机的单次耗时：

| cost | hash | verify |
| --- | --- | --- |
| 8 | 26ms | 19ms |
| **10** | **74ms** | **70ms** |
| **12** | **263ms** | **258ms** |
| 14 | 1011ms | 1035ms |

**定 cost = 12**（约 260ms/次）。理由：内网个人站、账号数以个位计、登录是低频动作，260ms 在人类感知上等同于瞬时；而 cost 10 的 70ms 对离线爆破来说偏薄。cost 14 的 1 秒会让登录显得卡顿，收益不成比例。

> 与本仓库既有取舍一致：不引原生依赖、尽量不引新依赖。`bcryptjs` 是**零依赖**，只多一个包。

> ⚠ **追加一条新事实（2026-10-15，实测目标部署机 `10.0.0.226`）**：上面这条「运行期镜像没编译器」的
> **决定性论据，在裸机部署下不成立**——那台机器上 `gcc 13.3` / `g++` / `make` / `python3` **全都在**。
> 若本项目改为**裸机自建部署**（不用 Docker），`bcrypt` 的原生编译不会炸。
>
> **但本决定不推翻**，理由：
> 1. `bcryptjs` 仍然**零依赖、纯 JS、实测 cost=12 约 260ms/次**，对个位数账号的内网个人站完全够用；
> 2. 为一个**已经不痛的痛点**重开一张已关闭的票，是纯浪费；
> 3. 日后若真要换 `bcrypt`，理由应从「编译会炸」改为「**性能**」——那是另一个取舍，需重新评估，而不是顺带改掉。
>
> 另注：**「`scripts/` 不进生产镜像」这条约束（§3b）的措辞依赖 Docker，但结论不变**——
> 裸机部署时 `dist/` 由 `tsc` 从 `src/` 编译而来，所以「CLI 必须放 `src/cli/`」**依然成立**，
> 只是理由从「不进镜像」换成「`tsc` 只编译 `src/`」。见 `docs/deploy-environment.md` §5。

---

## 2. `users` 表

**结论：沿用 `store.ts` 现有的「`CREATE TABLE IF NOT EXISTS` + `PRAGMA table_info` 就地补列」写法**，与 `probes` 表的迁移风格保持一致（`store.ts:57-84`）。

```sql
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT    NOT NULL UNIQUE,
  password_hash TEXT    NOT NULL,
  created_at    INTEGER NOT NULL,
  enabled       INTEGER NOT NULL DEFAULT 1,
  updated_at    INTEGER
);
```

| 字段 | 为什么 |
| --- | --- |
| `id` | 会话 cookie 里存它，而不是存 `username`——用户名可改，id 不可改 |
| `username` | `UNIQUE`。**必须显式做大小写归一化**，见下 |
| `password_hash` | 存完整 bcrypt 串（含 salt 与 cost），不要拆 salt 列 |
| `created_at` | 审计与排查需要 |
| `enabled` | 停用账号而不删历史。**必须有**：多账号场景下要能「先停掉某人」而不销毁记录 |
| `updated_at` | 改密码时更新；用于日后排查「什么时候改的」 |

### ⚠ 实测发现：SQLite 的 `UNIQUE` 对 TEXT 是**大小写敏感**的

实测：`alice` 与 `Alice` **可以共存**。

这对登录是个真实的地雷——用户注册了 `Alice`，之后用 `alice` 登录会「查无此人」；更糟的是两个近似账号并存，管理员分不清哪个是哪个。

**决定：`username` 以 `COLLATE NOCASE` 存储与比对**，即建表写 `username TEXT NOT NULL UNIQUE COLLATE NOCASE`；同时**登录查询与建号都先 `trim()` 并转小写存**，双保险（`NOCASE` 只管 ASCII `A-Z`，非 ASCII 不受影响，对个人站足够）。

---

## 3. 改密码走哪条路

**结论：三条都要，但职责分开——环境变量只管「首个账号」，CLI 管运维救援，网页自助改密管日常。**

候选方案单独看都有洞，实测后结论如下：

### (a) 环境变量引导首个账号 —— 要，但**只在零账号时生效**

`ADMIN_USERNAME` / `ADMIN_PASSWORD`：启动时若 `users` 表**为空**，用它们建第一个账号（`enabled=1`），并**在日志里显眼提示「已用环境变量创建首个账号，请立即改密」**。

关键约束：**一旦表里已有任何账号，这两个变量被完全忽略**。否则一个残留的环境变量就成了隐藏的后门账号——环境变量会长期留在 `docker-compose.yml` 与 shell 历史里，这是最容易被忘记的泄漏面。

### (b) CLI 脚本 —— 要，且**必须放在 `src/` 而不是 `scripts/`**

这是本票的一个**硬性实现约束**，实测得出：

- `tsconfig.json` 的 `rootDir: src`、`include: src/**/*.ts` → `dist/`；`Dockerfile:27` 只 `COPY --from=build /app/dist ./dist`。
- **`scripts/` 目录根本不进镜像**（`Dockerfile` 的 COPY 清单里没有它；`.dockerignore` 还排除了 `docs`）。

所以：**把重置密码的 CLI 写成 `scripts/reset-password.mjs` 会导致它在生产容器里不存在**，运维时 `docker exec` 找不到文件——一个「本地能跑、线上没有」的经典陷阱。

**决定：CLI 放 `src/cli/passwd.ts`，编译进 `dist/cli/passwd.js`**，用 `node dist/cli/passwd.js --user <name>` 执行（容器内 `docker exec personal-wiki node dist/cli/passwd.js …`）。它负责：重置任意账号口令、创建账号、启停账号（`enabled`）。

**实测可行性**：服务进程持有 SQLite 连接时，**独立 CLI 进程可以正常写入**（WAL 模式允许多进程读写），CLI 写完后服务进程立刻能读到。所以不需要停服。

### (c) 网页自助改密 —— 要，且是**日常路径**

登录后提供「修改密码」：要求**输入旧口令** + 新口令（≥8 位）+ 确认。改完**轮换当前会话**（或强制重新登录），避免旧 cookie 继续有效。

### (d) 为什么 CLI 不能省

若只有自助改密，忘记口令的用户就永久锁死——而这是个内网个人站，没有邮件找回、没有运维后台。CLI 是**唯一的救援通道**，必须存在。

---

## 4. 首次启动没有任何账号时怎么办

**结论：允许启动，但进入「无账号」状态——闸门全关，只放登录页，并在日志显眼告警。**

不选「拒绝启动」，理由：拒绝启动会让容器进入 `restart: unless-stopped` 的**崩溃重启循环**（`docker-compose.yml:6`），日志被刷屏、`docker ps` 显示不断重启，排查者很难一眼看出真正原因是「还没建账号」。而服务本身其实是健康的。

具体行为：

| 情况 | 行为 |
| --- | --- |
| `users` 表为空 + **无**环境变量 | 正常启动；所有受保护路径照常 302 到 `/login`；登录页显示「尚未创建任何账号，请用 CLI 创建」；日志 `console.warn` 显眼提示 |
| `users` 表为空 + **有** `ADMIN_USERNAME`/`ADMIN_PASSWORD` | 启动时创建首个账号，日志提示「请立即改密」 |
| `users` 表非空 | 环境变量**完全忽略**（见 §3a） |

**口令校验的安全细节**（必须做，否则等于泄漏账号是否存在）：

- 用户不存在时，**仍然执行一次 bcrypt 比对**（对固定的假哈希），让响应耗时与「用户存在但口令错」相当——否则可以通过响应时间枚举出哪些用户名有效。
- 登录失败**不区分**「用户不存在」与「口令错误」，统一回同一句提示。
- **不做登录失败次数限制**？本票不定：这属于速率限制，map 的「Not yet specified」里已列为待定项，留待那张票。此处只记录这个缺口，避免误以为已覆盖。

---

## 5. 实现落点

| 文件 | 改动 |
| --- | --- |
| `src/users.ts`（新） | `initUsers()` 建表+就地迁移、`createUser`、`findByUsername`（大小写归一）、`verifyPassword`、`setPassword`、`setEnabled`、`countUsers` |
| `src/cli/passwd.ts`（新） | CLI：建号 / 重置口令 / 启停账号。**必须在 `src/` 下**（§3b） |
| `src/config.ts` | 加 `adminUsername` / `adminPassword`（读环境变量，可为空） |
| `src/server.ts` | 启动时 `initUsers()` + 零账号引导逻辑（§4） |
| `package.json` | 加依赖 `bcryptjs`；加脚本 `"passwd": "node dist/cli/passwd.js"` |
| `.env.example` | 记录 `ADMIN_USERNAME` / `ADMIN_PASSWORD` 及其「仅零账号时生效」语义 |
| `README.md` | 首次部署与忘记密码的操作步骤 |
| `scripts/e2e-check.mjs` | 加账号相关断言（见下） |

## 6. 验收

- `initUsers()` 在旧库（无 `users` 表）上可重复执行，不报错。
- 同一 `username` 二次插入被拒（实测 `SQLITE_CONSTRAINT_UNIQUE`）。
- `Alice` 与 `alice` **不能**共存（`COLLATE NOCASE`，§2）。
- 正确口令通过、错误口令拒绝。
- 零账号启动：服务起得来、受保护路径仍 302、日志有告警。
- 环境变量在表非空时**不创建**账号（回归：防止后门账号）。
- **CLI 在 `dist/` 下可执行**（回归：防止放进 `scripts/` 导致镜像里没有）。

## 7. 边界

- 本票只定存储与口令校验。**cookie 的载荷/签名/过期**由「会话维持」票定；**闸门的白名单与 302/401 分流**由「给整个站点加登录闸门」票定（已关闭，见 `docs/login-gate-decision-table.md`）。
- 登录页 POST 路径沿用闸门票定的 `/login`。
- 登录失败次数限制 / 速率限制**不在本票**（map 的 Not yet specified 里有记录）。
- ~~本轮不做角色/权限差异：`users` 表**不加 `role` 列**，等真有需要区分的能力再说。~~
  **⚠ 已修订（[权限模型](roles-decision.md) §6）**：那条「真实需要区分的能力」出现了——**管理台**
  （只读的人不该能改目标、账号、备份、站点设置）。`users` 表**加 `role` 列**（`admin` / `readonly`）。
  本文件其余各条不受影响。
