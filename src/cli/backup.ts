#!/usr/bin/env node
/**
 * 备份 CLI：手动跑一次备份、校验、或按日期整站恢复。
 *
 * ⚠ **必须在 `src/cli/` 下**（编译到 `dist/cli/backup.js`）。
 * `scripts/` 不参与 `tsc` 编译（`tsconfig` 是 `rootDir: src`），部署后不存在这个文件。
 *
 * 用法：
 *   node dist/cli/backup.js                   # 手动跑一次备份
 *   node dist/cli/backup.js --list            # 列出已有备份（数据库判决 + 媒体判决）
 *   node dist/cli/backup.js --verify <date>   # 按日期校验：数据库判决 / 媒体判决分开给
 *   node dist/cli/backup.js --verify <file>   # 校验一份 .sqlite（兼容旧用法）
 *   node dist/cli/backup.js --restore <date>  # 按日期整站恢复（数据库 + 媒体）
 *
 * ⚠ **恢复只能从这里发起**（规格 user story 33）：被盗的会话不该能一键覆盖数据。
 * 恢复前**先停服**、**先 `--verify`**；旧现场会被移到 `BACKUP_DIR/.restore-<时间戳>/` 留证。
 *
 * ⚠ 目标机上 `/usr/bin/node` 可能是 18，而项目要 >=22；systemd 不加载 `.bashrc`，
 * 所以运维时请用绝对路径或在 PATH 里显式给出 Node 24（见 `docs/deploy-environment.md`）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { config } from '../config.js'
import { listBackups, restoreBackup, runBackup, verifyBackupAt, verifyBackupPath } from '../backup.js'

/** 打印一对判决（✅/❌ 各一行），返回是否全部通过。 */
function printVerdicts(label: string, db: { ok: boolean; note: string }, media: { ok: boolean; note: string }): boolean {
  console.log(`[backup] ${label}`)
  console.log(`  ${db.ok ? '✅' : '❌'} 数据库判决：${db.note}`)
  console.log(`  ${media.ok ? '✅' : '❌'} 媒体判决：${media.note}`)
  return db.ok && media.ok
}

function main(): void {
  const args = process.argv.slice(2)

  console.log(`[backup] 数据库：${config.databasePath}`)
  console.log(`[backup] 媒体目录：${config.mediaDir}`)
  console.log(`[backup] 备份目录：${config.backupDir}（保留最近 ${config.backupKeep} 份）`)

  if (args.includes('--help') || args.includes('-h')) {
    console.log('\n用法：node dist/cli/backup.js [--list | --verify <date|file> | --restore <date>]')
    return
  }

  if (args.includes('--list')) {
    const files = listBackups()
    if (!files.length) {
      console.log('[backup] 还没有任何备份。')
      return
    }
    console.log(`[backup] 共 ${files.length} 份（一天一份，三件套算一份）：`)
    for (const f of files) {
      const date = f.replace(/\.sqlite$/, '')
      const v = verifyBackupAt(date)
      const full = path.join(config.backupDir, f)
      const size = fs.existsSync(full) ? fs.statSync(full).size : 0
      const shape = v.kind === 'complete' ? '三件套' : v.kind === 'legacy' ? '旧格式单库' : `${v.kind}`
      console.log(
        `  ${f.padEnd(24)} ${String(size).padStart(9)} B  [${shape}]  ` +
          `${v.db.ok ? `✅ ${v.db.rows ?? '?'} 行` : `❌ ${v.db.note}`}  ·  ` +
          `${v.media.ok ? `✅ 媒体 ${v.media.files ?? 0} 张` : `❌ ${v.media.note}`}`,
      )
    }
    return
  }

  const vi = args.indexOf('--verify')
  if (vi >= 0) {
    const arg = args[vi + 1]
    if (!arg) {
      console.error('[backup] --verify 需要一个日期（YYYY-MM-DD）或一个 .sqlite 文件路径')
      process.exit(1)
    }
    if (/^\d{4}-\d{2}-\d{2}$/.test(arg)) {
      const v = verifyBackupAt(arg)
      const ok = printVerdicts(`校验 ${arg}（${v.kind}）`, v.db, v.media)
      if (!ok) {
        console.error('[backup] ⚠ 不要拿这份备份去恢复（尤其别把它盖到现有库上）。')
        process.exit(1)
      }
      console.log('[backup] 恢复前请再看一眼 README 的步骤——尤其是「先停服」那条。')
      return
    }
    const v = verifyBackupPath(arg)
    const ok = printVerdicts(`校验 ${arg}（${v.kind}）`, v.db, v.media)
    if (!ok) {
      console.error('[backup] ⚠ 不要拿这份备份去恢复（尤其别把它盖到现有库上）。')
      process.exit(1)
    }
    console.log('[backup] 恢复前请再看一眼 README 的步骤——尤其是「先停服」那条。')
    return
  }

  const ri = args.indexOf('--restore')
  if (ri >= 0) {
    const date = args[ri + 1]
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      console.error('[backup] --restore 需要一个日期（YYYY-MM-DD）')
      process.exit(1)
    }
    console.log('[backup] ⚠ 恢复会覆盖当前数据库' + (fs.existsSync(config.mediaDir) ? '与媒体目录' : '') + '。')
    console.log('[backup] ⚠ 请确认服务已停；旧现场会被移到 .restore-<时间戳>/ 留证。')
    const r = restoreBackup(date)
    if (!r.ok) {
      console.error(`[backup] ❌ 恢复失败：${r.note}`)
      process.exit(1)
    }
    console.log(`[backup] ✅ 已从 ${date} 恢复（probes ${r.rows ?? '?'} 行，图片 ${r.files ?? 0} 张）`)
    if (r.movedTo) console.log(`[backup] 旧现场留在：${r.movedTo}`)
    console.log(`[backup] ${r.note}`)
    return
  }

  // 默认：跑一次备份
  runBackup()
    .then((r) => {
      if (r.ok) {
        console.log(
          `[backup] ✅ 已备份 ${r.file}（${r.bytes} B，probes ${r.rows} 行，媒体 ${r.mediaFiles ?? 0} 张）` +
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
