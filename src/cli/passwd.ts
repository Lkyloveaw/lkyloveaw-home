#!/usr/bin/env node
/**
 * 账号运维 CLI：建号 / 重置口令 / 启停 / 踢会话。
 *
 * ⚠ **必须在 `src/cli/` 下**（编译到 `dist/cli/passwd.js`）。
 * 放在 `scripts/` 下不会被 `tsc` 编译（`tsconfig` 是 `rootDir: src`），
 * 部署后容器/裸机里都不存在这个文件——「本地能跑、线上没有」的经典陷阱。
 * 见 `docs/accounts-decision.md` §3b 与 `docs/deploy-environment.md` §5。
 *
 * 用法：
 *   node dist/cli/passwd.js --user alice --password 'xxx'      # 建号或重置口令
 *   node dist/cli/passwd.js --user alice --revoke-sessions     # 只踢会话，不改口令
 *   node dist/cli/passwd.js --user alice --disable             # 停用
 *   node dist/cli/passwd.js --user alice --enable              # 启用
 *   node dist/cli/passwd.js --list                             # 列账号
 *
 * 为什么这是**唯一的救援通道**：内网个人站没有邮件找回、没有运维后台。
 * 若只有网页自助改密，忘记口令的用户就永久锁死。
 *
 * WAL 模式下服务进程持连接时，本 CLI 作为独立进程可以正常写入，
 * 服务进程随后能读到 → **不需要停服**。
 */
import { config } from '../config.js'
import {
  bumpTokenVersion,
  countUsers,
  createUser,
  findByUsername,
  initUsers,
  listUsers,
  setEnabled,
  setPassword,
  setRole,
  type Role,
} from '../users.js'
import { revokeUserSessions } from '../sessions-store.js'

interface Args {
  user?: string
  password?: string
  role?: Role
  revokeSessions: boolean
  disable: boolean
  enable: boolean
  list: boolean
  help: boolean
}

function parseArgs(argv: string[]): Args {
  const out: Args = {
    revokeSessions: false,
    disable: false,
    enable: false,
    list: false,
    help: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    const next = (): string => {
      const v = argv[++i]
      if (v === undefined) throw new Error(`${a} 缺少取值`)
      return v
    }
    switch (a) {
      case '--user':
      case '-u':
        out.user = next()
        break
      case '--password':
      case '-p':
        out.password = next()
        break
      case '--revoke-sessions':
        out.revokeSessions = true
        break
      case '--role': {
        const v = next()
        // 取值就是领域词，非法值在这里就挡住（库里的 CHECK 是第二道）。
        if (v !== 'admin' && v !== 'readonly') {
          throw new Error(`--role 只能是 admin 或 readonly（收到「${v}」）`)
        }
        out.role = v
        break
      }
      case '--disable':
        out.disable = true
        break
      case '--enable':
        out.enable = true
        break
      case '--list':
        out.list = true
        break
      case '--help':
      case '-h':
        out.help = true
        break
      default:
        throw new Error(`未知参数：${a}`)
    }
  }
  return out
}

const USAGE = `
账号运维 CLI

  node dist/cli/passwd.js --list
  node dist/cli/passwd.js --user <名字> --password <口令>     # 表里没有就建号，有就重置口令
  node dist/cli/passwd.js --user <名字> --revoke-sessions      # 只踢掉全部会话，不改口令
  node dist/cli/passwd.js --user <名字> --disable | --enable
  node dist/cli/passwd.js --user <名字> --role admin | readonly # 提权 / 降级

口令至少 8 位。改口令会递增 token_version **并级联吊销该账号的全部会话**（双保险）；
--revoke-sessions 只做后者。网页上的「登出」现在也**真吊销**那一条会话（不再只清本机 cookie）。

角色：新建账号默认 **readonly**（最小权限）；**提权与启用永不设卡** —— CLI 是恢复通道，
管理台进不去时总能从这里出来。但「把最后一个启用中的管理员降级/停用」会被拒绝。
`.trim()

function main(): void {
  let args: Args
  try {
    args = parseArgs(process.argv.slice(2))
  } catch (err) {
    console.error(`[passwd] ${(err as Error).message}\n\n${USAGE}`)
    process.exit(1)
  }

  if (args.help || (!args.list && !args.user)) {
    console.log(USAGE)
    process.exit(args.help ? 0 : 1)
  }

  // CLI 只碰数据库，不需要会话密钥；但 config 模块会在 import 时读环境变量，
  // 这里不调 assertSessionSecret()，避免运维在没有密钥的机器上无法救援账号。
  console.log(`[passwd] 数据库：${config.databasePath}`)
  initUsers()

  if (args.list) {
    const users = listUsers()
    if (!users.length) {
      console.log('[passwd] 目前**没有任何账号**（服务仍会启动，但闸门只放登录页）')
      return
    }
    console.log(`[passwd] 共 ${users.length} 个账号：`)
    for (const u of users) {
      const state = u.enabled === 1 ? '启用' : '**已停用**'
      const role = u.role === 'admin' ? '管理员' : '只读  '
      console.log(
        `  ${u.username.padEnd(20)} id=${String(u.id).padEnd(4)} ${role}  ${state}  凭据代次=${u.token_version}`,
      )
    }
    return
  }

  const name = args.user!
  const existing = findByUsername(name)

  if (args.disable || args.enable) {
    if (!existing) {
      console.error(`[passwd] 找不到账号：${name}`)
      process.exit(1)
    }
    try {
      // 守卫在 setEnabled() **内部**（与网页写路径共用同一个函数）—— CLI 不是绕过后门的通道。
      setEnabled(existing.id, args.enable)
    } catch (err) {
      console.error(`[passwd] 拒绝：${(err as Error).message}`)
      process.exit(1)
    }
    console.log(`[passwd] 已${args.enable ? '启用' : '停用'}「${existing.username}」（立即生效，无需重启）`)
    return
  }

  if (args.role) {
    if (!existing) {
      console.error(`[passwd] 找不到账号：${name}`)
      process.exit(1)
    }
    try {
      // 同样走 setRole() 内部的守卫：**提权永不设卡**（CLI 是恢复通道），
      // 但降级「最后一个启用中的管理员」会被拒。
      setRole(existing.id, args.role)
    } catch (err) {
      console.error(`[passwd] 拒绝：${(err as Error).message}`)
      process.exit(1)
    }
    console.log(`[passwd] 已把「${existing.username}」的角色改为 ${args.role}（下一个请求即生效，不用踢会话）`)
    return
  }

  if (args.revokeSessions) {
    if (!existing) {
      console.error(`[passwd] 找不到账号：${name}`)
      process.exit(1)
    }
    const pv = bumpTokenVersion(existing.id)
    // 除了换凭据代次，**还要真吊销会话行**：代次是签名那一层的门，会话行是库里的门。
    // 只做前者时，被清理/迁移弄丢过的会话行仍有被复用的余地（`docs/session-revoke-decision.md` §6.4 的双保险）。
    const rows = revokeUserSessions(existing.id)
    console.log(
      `[passwd] 已踢掉「${existing.username}」的全部会话（凭据代次 → ${pv}，吊销 ${rows} 条会话记录）`,
    )
    console.log('[passwd] 口令**未改动**，该账号可用原口令重新登录。')
    return
  }

  if (args.password === undefined) {
    console.error(`[passwd] 缺少 --password（或改用 --revoke-sessions / --disable / --enable / --role）\n\n${USAGE}`)
    process.exit(1)
  }

  if (args.password.length < 8) {
    console.error('[passwd] 口令至少 8 位')
    process.exit(1)
  }

  if (existing) {
    setPassword(existing.id, args.password)
    console.log(`[passwd] 已重置「${existing.username}」的口令，并使其全部旧会话失效。`)
  } else {
    const before = countUsers()
    const created = createUser(name, args.password)
    console.log(`[passwd] 已创建账号「${created.username}」（id=${created.id}，角色 readonly）。`)
    if (before === 0) {
      console.log('[passwd] 这是本库的第一个账号——现在可以登录了。')
      // ⚠ 新建默认 readonly（最小权限），**首启的例外只给环境变量那条路**（roles §4）。
      //    所以这里必须把下一步说出来，否则运维会以为「建好了却进不去管理台」是个 bug。
      console.log('[passwd] 要用管理台请再跑一次：--user ' + created.username + ' --role admin')
    }
  }
}

main()
