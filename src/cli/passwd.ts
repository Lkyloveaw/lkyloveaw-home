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
} from '../users.js'

interface Args {
  user?: string
  password?: string
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

口令至少 8 位。改口令与 --revoke-sessions 都会递增 token_version，
使该账号**已签发的全部 cookie 立即失效**（这是签名 cookie 唯一的真吊销通道）。
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
      console.log(`  ${u.username.padEnd(20)} id=${String(u.id).padEnd(4)} ${state}  凭据代次=${u.token_version}`)
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
    setEnabled(existing.id, args.enable)
    console.log(`[passwd] 已${args.enable ? '启用' : '停用'}「${existing.username}」（立即生效，无需重启）`)
    return
  }

  if (args.revokeSessions) {
    if (!existing) {
      console.error(`[passwd] 找不到账号：${name}`)
      process.exit(1)
    }
    const pv = bumpTokenVersion(existing.id)
    console.log(`[passwd] 已踢掉「${existing.username}」的全部会话（凭据代次 → ${pv}）`)
    console.log('[passwd] 口令**未改动**，该账号可用原口令重新登录。')
    return
  }

  if (args.password === undefined) {
    console.error(`[passwd] 缺少 --password（或改用 --revoke-sessions / --disable / --enable）\n\n${USAGE}`)
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
    console.log(`[passwd] 已创建账号「${created.username}」（id=${created.id}）。`)
    if (before === 0) {
      console.log('[passwd] 这是本库的第一个账号——现在可以登录了。')
    }
  }
}

main()
