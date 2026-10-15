#!/usr/bin/env node
/**
 * 备份 CLI：手动跑一次备份，或校验一份已有备份。
 *
 * ⚠ **必须在 `src/cli/` 下**（编译到 `dist/cli/backup.js`）。
 * `scripts/` 不参与 `tsc` 编译（`tsconfig` 是 `rootDir: src`），部署后不存在这个文件。
 *
 * 用法：
 *   node dist/cli/backup.js                  # 手动跑一次备份
 *   node dist/cli/backup.js --list           # 列出已有备份
 *   node dist/cli/backup.js --verify <file>  # 校验一份备份能不能用（恢复前必做）
 *
 * 恢复步骤见 README。**最关键的两条**：拷回去之前先 `--verify`，
 * 以及**必须同时移走残留的 `-wal` / `-shm`**（旧 WAL 配新主库是恢复失败最常见的原因）。
 *
 * ⚠ 目标机上 `/usr/bin/node` 可能是 18，而项目要 >=22；systemd 不加载 `.bashrc`，
 * 所以运维时请用绝对路径或在 PATH 里显式给出 Node 24（见 `docs/deploy-environment.md`）。
 */
import fs from 'node:fs'
import { config } from '../config.js'
import { listBackups, runBackup, verifyBackup } from '../backup.js'

function main(): void {
  const args = process.argv.slice(2)

  console.log(`[backup] 数据库：${config.databasePath}`)
  console.log(`[backup] 备份目录：${config.backupDir}（保留最近 ${config.backupKeep} 份）`)

  if (args.includes('--help') || args.includes('-h')) {
    console.log('\n用法：node dist/cli/backup.js [--list | --verify <file>]')
    return
  }

  if (args.includes('--list')) {
    const files = listBackups()
    if (!files.length) {
      console.log('[backup] 还没有任何备份。')
      return
    }
    console.log(`[backup] 共 ${files.length} 份：`)
    for (const f of files) {
      const full = `${config.backupDir}/${f}`
      const v = verifyBackup(full)
      const size = fs.existsSync(full) ? fs.statSync(full).size : 0
      console.log(
        `  ${f.padEnd(24)} ${String(size).padStart(9)} B  ` +
          (v.ok ? `✅ ${v.rows} 行` : `❌ ${v.note}`),
      )
    }
    return
  }

  const vi = args.indexOf('--verify')
  if (vi >= 0) {
    const file = args[vi + 1]
    if (!file) {
      console.error('[backup] --verify 需要一个文件路径')
      process.exit(1)
    }
    const v = verifyBackup(file)
    if (v.ok) {
      console.log(`[backup] ✅ 备份可用：${file}（probes ${v.rows} 行）`)
      console.log('[backup] 恢复前请再看一眼 README 的步骤——尤其是「同时移走 -wal/-shm」那条。')
    } else {
      console.error(`[backup] ❌ 备份不可用：${v.note}`)
      console.error('[backup] ⚠ 千万不要把它拷回去覆盖现有库。')
      process.exit(1)
    }
    return
  }

  // 默认：跑一次备份
  runBackup()
    .then((r) => {
      if (r.ok) {
        console.log(
          `[backup] ✅ 已备份 ${r.file}（${r.bytes} B，probes ${r.rows} 行）` +
            (r.note ? `\n[backup] ${r.note}` : ''),
        )
      } else {
        console.error(`[backup] ❌ 备份失败：${r.note}`)
        process.exit(1)
      }
    })
    .catch((err) => {
      console.error('[backup] ❌ 备份异常：', (err as Error).message)
      process.exit(1)
    })
}

main()
