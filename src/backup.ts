/**
 * 备份：checkpoint → `db.backup()` → 校验产物 → 滚动清理。
 *
 * 刻意**部署方式无关**：只依赖 `DATABASE_PATH` 与 `BACKUP_DIR` 两个路径，
 * 不写死 `/app/data`。这样 Docker 与裸机自建都能用（见 `docs/deploy-environment.md`）。
 *
 * 三条硬规矩（`docs/backup-checkpoint-decision.md`）：
 * 1. **先 checkpoint 再备份**——实测 `db.backup()` 不改动源库 WAL，
 *    所以「让备份顺带把 WAL 落盘」是不成立的；
 * 2. **checkpoint 必须校验 `busy`**——非 0 时它其实没搬干净，而返回值会骗人；
 * 3. **备份只用 `db.backup()`，绝不用 `cp`**——只拷 `.sqlite` 得到的是空库（实测）。
 */
import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import { config } from './config.js'
import { backupTo, checkpoint } from './store.js'

export interface BackupResult {
  ok: boolean
  /** 产物路径（成功时）。 */
  file?: string
  /** 失败或降级的原因，用于显眼日志。 */
  note?: string
  /** 备份产物的字节数。 */
  bytes?: number
  /** 产物里的 probes 行数（校验用）。 */
  rows?: number
}

/** 今天的日期串，用作滚动备份的文件名（同一天只留一份）。 */
function dayStamp(d = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** 列出已有的滚动备份，按文件名（即日期）升序。 */
export function listBackups(): string[] {
  if (!fs.existsSync(config.backupDir)) return []
  return fs
    .readdirSync(config.backupDir)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.sqlite$/.test(f))
    .sort()
}

/**
 * 删掉超期备份，只留最近 `backupKeep` 份。
 * 返回被删掉的文件名。
 */
export function pruneBackups(keep = config.backupKeep): string[] {
  const all = listBackups()
  const excess = all.slice(0, Math.max(0, all.length - keep))
  for (const f of excess) {
    try {
      fs.rmSync(path.join(config.backupDir, f), { force: true })
    } catch (err) {
      console.error(`[backup] 删除旧备份失败 ${f}：`, (err as Error).message)
    }
  }
  return excess
}

/**
 * 校验一份备份是不是**真的能用**。
 *
 * 为什么必须有这一步：恢复时最容易犯的错是「把一份空库盖到好库上」。
 * 实测「只拷 .sqlite」得到的副本**打得开、但里面没有 probes 表**——
 * 所以「文件存在且非空」不足以判断可用性，必须真的查一次表。
 */
export function verifyBackup(file: string): { ok: boolean; rows?: number; note?: string } {
  if (!fs.existsSync(file)) return { ok: false, note: '文件不存在' }
  const size = fs.statSync(file).size
  if (size === 0) return { ok: false, note: '文件为空' }

  // 用只读方式打开，避免校验动作本身改动备份。
  let rows: number
  try {
    const db = new Database(file, { readonly: true })
    try {
      const r = db.prepare('SELECT COUNT(*) AS n FROM probes').get() as { n: number }
      rows = r.n
    } finally {
      db.close()
    }
  } catch (err) {
    return { ok: false, note: `打不开或缺少 probes 表：${(err as Error).message}` }
  }
  return { ok: true, rows }
}

/**
 * 跑一次备份。**任何失败都返回 ok:false，绝不抛**——
 * 调用方在探测循环里，备份坏掉不该拖垮探测。
 */
export async function runBackup(now = new Date()): Promise<BackupResult> {
  const file = path.join(config.backupDir, `${dayStamp(now)}.sqlite`)

  // 今天已经有一份且它能用 → 跳过（探测每分钟一轮，不能每轮都备份）
  if (fs.existsSync(file)) {
    const v = verifyBackup(file)
    if (v.ok) return { ok: true, file, note: '今天已备份过，跳过', rows: v.rows }
  }

  try {
    fs.mkdirSync(config.backupDir, { recursive: true })
  } catch (err) {
    return { ok: false, note: `备份目录不可写：${(err as Error).message}` }
  }

  // 1) 先 checkpoint（顺序硬约束，见文件头）
  let cpNote = ''
  try {
    const cp = checkpoint('TRUNCATE')
    if (cp.busy !== 0) {
      // ⚠ 关键：不能当成功。实测此时它可能只搬了 2/33 页。
      cpNote = `checkpoint 未完成（busy=${cp.busy}，已搬 ${cp.pages} 页）`
      console.warn(`[backup] ${cpNote}——继续备份，但产物一致性未经 WAL 归并保证`)
    }
  } catch (err) {
    cpNote = `checkpoint 抛错：${(err as Error).message}`
    console.error(`[backup] ${cpNote}`)
  }

  // 2) 再备份（SQLite 在线备份 API，不需要停服）
  // 写临时名再改名：避免中途失败留下一个「看起来像今天的备份」的半成品。
  const tmpFile = `${file}.tmp`
  try {
    fs.rmSync(tmpFile, { force: true })
    await backupTo(tmpFile)
  } catch (err) {
    fs.rmSync(tmpFile, { force: true })
    return { ok: false, note: `备份失败：${(err as Error).message}` }
  }

  // 3) 校验产物（防「把空库盖到好库上」）
  const v = verifyBackup(tmpFile)
  if (!v.ok) {
    fs.rmSync(tmpFile, { force: true })
    return { ok: false, note: `备份产物校验失败：${v.note}` }
  }

  // 校验通过才落到正式文件名（临时名避免留下「看起来像今天的备份」的半成品）
  fs.renameSync(tmpFile, file)

  // 收成自包含单文件（切掉 WAL 形态），并清掉旁文件。
  // 顺序要紧：先 finalize 再 clean，否则 clean 掉 shm 后下次打开又会长回来。
  try {
    finalizeBackupFile(file)
  } catch (err) {
    console.warn(`[backup] 产物未能收成单文件（不影响可用性）：${(err as Error).message}`)
  }
  cleanBackupDir()

  // 4) 滚动清理
  const removed = pruneBackups()

  return {
    ok: true,
    file,
    bytes: fs.statSync(file).size,
    rows: v.rows,
    note: [cpNote, removed.length ? `清理 ${removed.length} 份旧备份` : ''].filter(Boolean).join('；') || undefined,
  }
}

/**
 * 把备份产物收成**自包含的单文件**。
 *
 * 为什么需要：`db.backup()` 产出的是 **WAL 形态**的库，于是旁边会有 `-wal`/`-shm`。
 * 更麻烦的是——**只读打开它也会创建这两个旁文件**（SQLite 需要 shm 才能读 WAL），
 * 所以光在备份后删一次是不够的，`--verify` 一跑它们又回来了。
 *
 * 处置：把产物的 journal_mode 切到 `DELETE`。这样它就是一个真正的单文件——
 * 拷贝它永远完整，也就不可能再踩「只拷 `.sqlite` 得到空库」那个坑。
 * 备份产物本来就该是这个形态：它的用途是被拷走、被归档。
 */
function finalizeBackupFile(file: string): void {
  const db = new Database(file)
  try {
    db.pragma('wal_checkpoint(TRUNCATE)')
    db.pragma('journal_mode = DELETE')
  } finally {
    db.close()
  }
}

/**
 * 清掉备份目录里所有 `-wal` / `-shm` 旁文件与 `.tmp` 残留。
 *
 * 它们不影响正确性，但会让目录变脏、误导运维「这里有好几个库」。
 */
export function cleanBackupDir(): number {
  if (!fs.existsSync(config.backupDir)) return 0
  let n = 0
  for (const f of fs.readdirSync(config.backupDir)) {
    if (/\.tmp(-wal|-shm)?$/.test(f) || /\.sqlite(-wal|-shm)$/.test(f)) {
      try {
        fs.rmSync(path.join(config.backupDir, f), { force: true })
        n++
      } catch {
        /* 清不掉不影响正确性 */
      }
    }
  }
  return n
}
