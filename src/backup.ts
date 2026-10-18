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

/** 备份目录里的一份产物（管理台要显示名 / 大小 / 时间）。 */
export interface BackupFile {
  name: string
  bytes: number
  mtimeMs: number
}

/**
 * 备份目录的**三种状态**，页面必须分开说（`docs/settings-source-decision.md` §5）：
 * - `missing`：目录还不存在 —— **不是错误**，第一次备份时会创建；
 * - `unreadable`：路径不是目录 / 没权限 / 父级是个文件 —— 这是**要显眼说出来的故障**；
 * - 两者都 false：目录在，`files` 可能是空的（那就是「还没有备份」）。
 *
 * 为什么不用一个「空数组」把三种情形糊在一起：它们对用户的意义完全不同 ——
 * 一个「空列表」既可能是「还没备份过」，也可能是「备份目录配错了」，
 * 而后者正是这个页面最该帮人看出来的事。
 */
export interface BackupListing {
  dir: string
  missing: boolean
  unreadable: boolean
  /** `unreadable` 时的原因（人话 + 原始 message）。 */
  note?: string
  /** 按文件名（即日期）**倒序**：最新在前 —— 页面就按这个顺序渲染。 */
  files: BackupFile[]
}

/** 产物文件名的形状：`YYYY-MM-DD.sqlite`。 */
const BACKUP_NAME_RE = /^\d{4}-\d{2}-\d{2}\.sqlite$/

/**
 * 祖先链里有没有「已存在但不是目录」的那一级。
 *
 * 用来把「目录还没建」（ENOENT，正常）与「上一级是个文件」（也是 ENOENT，配置坏了）分开。
 * 读不到某一级（本身 ENOENT）就继续往上；出现别的错误（EACCES 等）算坏 —— 它同样会让 mkdir 失败。
 */
function ancestorIsNotDirectory(dir: string): boolean {
  let p = path.dirname(path.resolve(dir))
  for (;;) {
    try {
      if (!fs.statSync(p).isDirectory()) return true
      return false // 最近的一个存在的祖先就是目录 → 这条链没问题
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return true
    }
    const up = path.dirname(p)
    if (up === p) return false // 到了根，整条链都不存在 → 正常
    p = up
  }
}

/**
 * 列出备份产物，带大小与时间，**最新在前**。
 *
 * ⚠ 与 `listBackups()` 的**顺序相反**，两者各有各的用途，别互相当替身：
 * 本函数给页面用（人先看最新的），`listBackups()` 给 `pruneBackups()` 用（**旧的在前**，
 * 它靠 `slice(0, len - keep)` 删最旧的）。
 */
export function listBackupFiles(): BackupListing {
  const dir = config.backupDir
  let names: string[]
  try {
    const st = fs.statSync(dir)
    if (!st.isDirectory()) {
      return { dir, missing: false, unreadable: true, note: '这个路径不是一个目录', files: [] }
    }
    names = fs.readdirSync(dir)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? ''
    /*
     * 目录不存在是**正常**的初始状态（`runBackup()` 会 mkdir），其余都不是。
     *
     * ⚠ 但「ENOENT」有两种：**目录还没建**（正常）与**上一级根本不是目录**（配置写错了）。
     * 实测 Windows 上后者也报 ENOENT（不是 ENOTDIR），于是页面会把一个真故障
     * 说成「第一次备份时会创建」—— 先点备份、再看到失败，等于白绕一圈。
     * 所以这里往上走一遍祖先链：途中任何一个已存在的祖先不是目录，就是配置坏了。
     */
    if (code === 'ENOENT' && !ancestorIsNotDirectory(dir)) {
      return { dir, missing: true, unreadable: false, files: [] }
    }
    return {
      dir,
      missing: false,
      unreadable: true,
      note: code === 'ENOENT' ? '路径的上一级不是一个目录（配置写错了）' : (err as Error).message,
      files: [],
    }
  }

  const files: BackupFile[] = []
  for (const name of names) {
    if (!BACKUP_NAME_RE.test(name)) continue
    try {
      const st = fs.statSync(path.join(dir, name))
      files.push({ name, bytes: st.size, mtimeMs: st.mtimeMs })
    } catch {
      /* 刚被删掉 / 读不到 stat 的那一份就不列它 —— 一个文件不该让整页渲染失败 */
    }
  }
  files.sort((a, b) => (a.name < b.name ? 1 : a.name > b.name ? -1 : 0))
  return { dir, missing: false, unreadable: false, files }
}

/**
 * 列出已有的滚动备份，按文件名（即日期）**升序**。
 * ⚠ 顺序是**契约**：`pruneBackups()` 依赖「旧的在前」来删最旧的几份。
 * 页面要的是倒序，用 `listBackupFiles()`。
 */
export function listBackups(): string[] {
  return listBackupFiles()
    .files.map((f) => f.name)
    .reverse()
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
