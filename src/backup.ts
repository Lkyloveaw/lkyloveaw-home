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
 *
 * 2026-10-18 扩展（规格 [#41](https://github.com/Lkyloveaw/lkyloveaw-home/issues/41) · 票 [#52]）：
 * 一天一份备份现在是**三件套**——`<date>.sqlite` + `<date>.media/`（媒体快照）+ `<date>.manifest.json`（清单）。
 * 媒体文件**只增不改**（内容哈希命名），所以快照用**硬链接**指向媒体目录里的原文件：
 * 未变化的图不会在 7 份日备份里重复占空间。跨文件系统时退化为复制并**显眼警告**。
 * **旧版只有 `.sqlite` 的单文件备份继续按保留数滚动，绝不因缺媒体被新逻辑删掉**（user story 29）——
 * 那是升级前唯一的恢复物。
 */
import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import { config } from './config.js'
import { isSafeMediaName } from './media.js'
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
  /** 这份备份的媒体快照里有多少张图。 */
  mediaFiles?: number
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
/** 日期本身的形状。 */
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/** 三件套里除了数据库以外的两个部分。 */
function piecesOf(date: string): { dbFile: string; mediaDir: string; manifestFile: string } {
  const dbFile = path.join(config.backupDir, `${date}.sqlite`)
  return {
    dbFile,
    mediaDir: path.join(config.backupDir, `${date}.media`),
    manifestFile: path.join(config.backupDir, `${date}.manifest.json`),
  }
}

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile()
  } catch {
    return false
  }
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory()
  } catch {
    return false
  }
}

/** 文件名里的内容哈希（文件名**就是** `<hash>.<ext>`，不必重算字节）。 */
function hashOf(name: string): string {
  const i = name.lastIndexOf('.')
  return i > 0 ? name.slice(0, i) : name
}

/** 某个目录里的媒体文件名（升序）。目录不存在 → 空数组（「还没有图」不是错误）。 */
function listMediaIn(dir: string): string[] {
  if (!fs.existsSync(dir)) return []
  try {
    return fs.readdirSync(dir).filter((f) => isSafeMediaName(f)).sort()
  } catch (err) {
    // 读不到媒体目录不能当成「没有媒体」——那会在校验时把一个故障说成「一致」。
    throw new Error(`媒体目录读不到：${(err as Error).message}`)
  }
}

/** 清单里的一项：文件名 · 字节数 · 内容哈希。 */
export interface BackupManifestFile {
  name: string
  bytes: number
  hash: string
}

/** `<date>.manifest.json` 的形状。 */
export interface BackupManifest {
  version: 1
  date: string
  createdAt: number
  sqlite: { name: string; bytes: number }
  media: { count: number; bytes: number }
  files: BackupManifestFile[]
}

/** 一天那份备份的形态。`incomplete` 是要显眼报出来的故障，`orphan-media` 要移走留证。 */
export type BackupKind = 'none' | 'legacy' | 'complete' | 'incomplete' | 'orphan-media'

export interface BackupPieces {
  date: string
  kind: BackupKind
  dbFile: string
  mediaDir: string
  manifestFile: string
  hasDb: boolean
  hasMedia: boolean
  hasManifest: boolean
  /** 不完整时的原因（人话）。 */
  note?: string
}

function readManifest(file: string): BackupManifest | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as BackupManifest
    if (!parsed || !Array.isArray(parsed.files)) return null
    return parsed
  } catch {
    return null
  }
}

/** 清单与媒体目录是否**对得上**：文件集合、每个文件的大小、哈希都对。 */
function manifestConsistent(m: BackupManifest, mediaDir: string): { ok: boolean; note?: string } {
  const names = listMediaIn(mediaDir)
  const listed = m.files.map((f) => f.name).sort()
  if (names.length !== listed.length || names.some((n, i) => n !== listed[i])) {
    return { ok: false, note: `清单列了 ${listed.length} 个文件，目录里有 ${names.length} 个，对不上` }
  }
  for (const f of m.files) {
    if (hashOf(f.name) !== f.hash) return { ok: false, note: `${f.name} 的哈希与清单不一致` }
    try {
      const st = fs.statSync(path.join(mediaDir, f.name))
      if (st.size !== f.bytes) return { ok: false, note: `${f.name} 的字节数与清单不一致` }
    } catch {
      return { ok: false, note: `${f.name} 在媒体快照里不存在` }
    }
  }
  return { ok: true }
}

/**
 * 认出某一天那份备份的形态。
 *
 * 判据刻意收得紧：**只有「数据库 + 媒体目录 + 清单」三样俱全且清单与目录一致**才算 `complete`；
 * 只有数据库算 `legacy`（旧版格式，**照旧可用**）；其余组合一律 `incomplete` / `orphan-media`，
 * 由调用方显眼报出，**绝不当成「没有备份」而悄悄覆盖**。
 */
export function inspectBackup(date: string): BackupPieces {
  const { dbFile, mediaDir, manifestFile } = piecesOf(date)
  const hasDb = isFile(dbFile)
  const hasMedia = fs.existsSync(mediaDir)
  const hasManifest = isFile(manifestFile)
  const base = { date, dbFile, mediaDir, manifestFile, hasDb, hasMedia, hasManifest }

  if (!hasDb && !hasMedia && !hasManifest) return { ...base, kind: 'none' }
  if (hasDb && !hasMedia && !hasManifest) return { ...base, kind: 'legacy' }
  if (!hasDb && (hasMedia || hasManifest)) {
    return { ...base, kind: 'orphan-media', note: '只有媒体/清单，没有数据库' }
  }
  if (hasDb && hasMedia && hasManifest) {
    if (!isDir(mediaDir)) return { ...base, kind: 'incomplete', note: '媒体快照不是一个目录' }
    const m = readManifest(manifestFile)
    if (!m) return { ...base, kind: 'incomplete', note: '清单读不出来或格式不对' }
    if (m.sqlite?.name && m.sqlite.name !== path.basename(dbFile)) {
      return { ...base, kind: 'incomplete', note: '清单指向的是另一个数据库文件' }
    }
    const c = manifestConsistent(m, mediaDir)
    return c.ok ? { ...base, kind: 'complete' } : { ...base, kind: 'incomplete', note: c.note }
  }
  const missing = [!hasDb ? '数据库' : '', !hasMedia ? '媒体快照' : '', !hasManifest ? '清单' : '']
    .filter(Boolean)
    .join(' / ')
  return { ...base, kind: 'incomplete', note: `缺 ${missing}` }
}

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
 *
 * 一天只列一行（`.sqlite` 就是一天的锚点）：三件套是**同一天**的三个部分，不是三份备份。
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
 *
 * ⚠ 一天只出现一次（`.sqlite` 是那一天的锚点）——三件套属于**同一份**备份，
 * 滚动清理必须按「一天」这个单元来（见 `pruneBackups()`）。
 */
export function listBackups(): string[] {
  return listBackupFiles()
    .files.map((f) => f.name)
    .reverse()
}

/**
 * 删掉超期备份，只留最近 `backupKeep` 份。
 *
 * 「一份」= 一天：删 `<date>.sqlite` 时**连它的媒体快照与清单一起删**（否则会留下孤儿目录）。
 * **旧版只有 `.sqlite` 的单文件**照旧滚动 —— 它没有媒体/清单可删，也**不许**因为缺媒体被当成残缺而提前删掉
 * （规格 user story 29：升级不能毁掉唯一的恢复物）。
 *
 * 返回被删掉的日期（`.sqlite` 文件名），供日志与页面对账。
 */
export function pruneBackups(keep = config.backupKeep): string[] {
  const all = listBackups()
  const excess = all.slice(0, Math.max(0, all.length - keep))
  for (const f of excess) {
    const date = f.replace(/\.sqlite$/, '')
    const { dbFile, mediaDir, manifestFile } = piecesOf(date)
    for (const p of [dbFile, mediaDir, manifestFile]) {
      try {
        fs.rmSync(p, { recursive: true, force: true })
      } catch (err) {
        console.error(`[backup] 删除旧备份失败 ${p}：`, (err as Error).message)
      }
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

/** 一个判决（数据库 / 媒体各一条）。 */
export interface BackupVerdict {
  ok: boolean
  note: string
  rows?: number
  files?: number
}

/**
 * 校验某个媒体快照与它的清单。
 *
 * 没有媒体快照也没有清单 → 那是**旧格式**备份，数据库判决说了算，
 * 媒体这一格标为通过但写明「恢复后媒体目录保持现状」（不能把「没有」说成「坏了」）。
 */
function verifyMediaSnapshot(mediaDir: string, manifestFile: string, dbOk: boolean): BackupVerdict {
  if (!fs.existsSync(mediaDir) && !fs.existsSync(manifestFile)) {
    return { ok: dbOk, note: '旧格式：没有媒体快照（恢复后媒体目录保持现状）' }
  }
  if (!isDir(mediaDir)) return { ok: false, note: '媒体快照不是一个目录' }
  const m = readManifest(manifestFile)
  if (!m) return { ok: false, note: '清单读不出来或格式不对' }
  const c = manifestConsistent(m, mediaDir)
  if (!c.ok) return { ok: false, note: c.note ?? '清单与媒体目录对不上' }
  return { ok: true, files: m.files.length, note: `媒体快照一致（${m.files.length} 个文件，${m.media?.bytes ?? 0} 字节）` }
}

/** 按日期校验：**两个判决分开**（规格 user story 34）。 */
export function verifyBackupAt(date: string): {
  date: string
  kind: BackupKind
  db: BackupVerdict
  media: BackupVerdict
} {
  const p = inspectBackup(date)
  if (!p.hasDb) {
    const miss: BackupVerdict = { ok: false, note: `没有 ${date}.sqlite` }
    if (!p.hasMedia && !p.hasManifest) return { date, kind: p.kind, db: miss, media: { ok: false, note: '没有媒体快照' } }
    return { date, kind: p.kind, db: miss, media: verifyMediaSnapshot(p.mediaDir, p.manifestFile, false) }
  }
  const v = verifyBackup(p.dbFile)
  const db: BackupVerdict = { ok: v.ok, rows: v.rows, note: v.ok ? `备份可用（probes ${v.rows} 行）` : (v.note ?? '不可用') }
  return { date, kind: p.kind, db, media: verifyMediaSnapshot(p.mediaDir, p.manifestFile, v.ok) }
}

/** 按文件路径校验（`--verify <file>`）：数据库判决 + 同目录下的媒体判决（若有）。 */
export function verifyBackupPath(file: string): {
  file: string
  kind: BackupKind
  db: BackupVerdict
  media: BackupVerdict
} {
  const dir = path.dirname(file)
  const date = path.basename(file).replace(/\.sqlite$/, '')
  const v = verifyBackup(file)
  const db: BackupVerdict = { ok: v.ok, rows: v.rows, note: v.ok ? `备份可用（probes ${v.rows} 行）` : (v.note ?? '不可用') }
  let kind: BackupKind = v.ok ? 'legacy' : 'incomplete'
  let media: BackupVerdict
  if (DATE_RE.test(date)) {
    const insp = { mediaDir: path.join(dir, `${date}.media`), manifestFile: path.join(dir, `${date}.manifest.json`) }
    if (fs.existsSync(insp.mediaDir) || fs.existsSync(insp.manifestFile)) {
      media = verifyMediaSnapshot(insp.mediaDir, insp.manifestFile, v.ok)
      kind = media.ok && v.ok ? 'complete' : 'incomplete'
    } else {
      media = verifyMediaSnapshot(insp.mediaDir, insp.manifestFile, v.ok)
    }
  } else {
    media = { ok: v.ok, note: '不是按日期命名的备份，只看数据库' }
  }
  return { file, kind, db, media }
}

/**
 * **可注入的链接器**：正常就是 `fs.linkSync`。
 * 断言要把「跨文件系统（EXDEV）」这条回退路径跑出来，就必须能注入一个会抛的链接器。
 */
export const mediaLinker = {
  link: (src: string, dst: string): void => {
    fs.linkSync(src, dst)
  },
}

let linkWarned = false

/**
 * 把媒体目录快照到 `destDir`：**硬链接**到原文件（内容哈希命名 ⇒ 文件只增不改 ⇒ 链接安全）。
 *
 * 跨文件系统时 `linkSync` 抛 `EXDEV`，回退成复制并**只警告一次**；
 * **其它错误一律抛**——「复制一份但不知道对不对」比明确失败更危险（规格：非 EXDEV → ok:false、不复制、不留半成品）。
 */
function snapshotMedia(destDir: string): { count: number; bytes: number; warn: string } {
  fs.mkdirSync(destDir, { recursive: true })
  const names = listMediaIn(config.mediaDir)
  let bytes = 0
  let warn = ''
  for (const name of names) {
    const src = path.join(config.mediaDir, name)
    const dst = path.join(destDir, name)
    try {
      mediaLinker.link(src, dst)
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code !== 'EXDEV') throw err
      fs.copyFileSync(src, dst)
      if (!linkWarned) {
        linkWarned = true
        warn = '备份目录与媒体目录跨文件系统，媒体快照已退化为复制'
        console.warn(`[backup] ${warn}`)
      }
    }
    bytes += fs.statSync(dst).size
  }
  return { count: names.length, bytes, warn }
}

/** 写清单（`writeFileSync` 到调用方给的临时名，提交时再改名）。 */
function writeManifestFile(file: string, date: string, dbFile: string, snapshotDir: string): BackupManifest {
  const names = listMediaIn(snapshotDir)
  const files: BackupManifestFile[] = names.map((name) => ({
    name,
    bytes: fs.statSync(path.join(snapshotDir, name)).size,
    hash: hashOf(name),
  }))
  const manifest: BackupManifest = {
    version: 1,
    date,
    createdAt: Date.now(),
    sqlite: { name: path.basename(dbFile), bytes: isFile(dbFile) ? fs.statSync(dbFile).size : 0 },
    media: { count: files.length, bytes: files.reduce((n, f) => n + f.bytes, 0) },
    files,
  }
  fs.writeFileSync(file, JSON.stringify(manifest, null, 2), 'utf8')
  return manifest
}

/**
 * 「有媒体/清单但没有数据库」：把它**移到 `.orphan-<date>/` 保留**（不删），并返回落点。
 * 这通常是上一次备份写到一半崩了留下的现场，也可能是人工挪过文件。
 */
function quarantineOrphan(date: string): string {
  const { mediaDir, manifestFile } = piecesOf(date)
  let dest = path.join(config.backupDir, `.orphan-${date}`)
  let n = 1
  while (fs.existsSync(dest)) dest = path.join(config.backupDir, `.orphan-${date}-${n++}`)
  fs.mkdirSync(dest, { recursive: true })
  for (const p of [mediaDir, manifestFile]) {
    if (!fs.existsSync(p)) continue
    const target = path.join(dest, path.basename(p))
    try {
      fs.renameSync(p, target)
    } catch {
      // 跨卷时 rename 会失败：退化为复制 + 删源，语义仍是「移走留证」。
      fs.cpSync(p, target, { recursive: true })
      fs.rmSync(p, { recursive: true, force: true })
    }
  }
  console.warn(`[backup] 备份目录里有 ${date} 的媒体/清单但没有数据库，已移到 ${dest} 保留`)
  return dest
}

/**
 * 跑一次备份。**任何失败都返回 ok:false，绝不抛**——
 * 调用方在探测循环里，备份坏掉不该拖垮探测。
 *
 * 一天一份三件套：`<date>.sqlite` + `<date>.media/` + `<date>.manifest.json`。
 * 提交顺序是 **数据库 → 媒体 → 清单**：中途崩了最坏留下一个**旧格式单库备份**（可用、下次会补媒体），
 * 而不是一个「看着像三件套、实则缺件」的东西。
 */
export async function runBackup(now = new Date()): Promise<BackupResult> {
  const date = dayStamp(now)
  const { dbFile: file, mediaDir, manifestFile } = piecesOf(date)
  linkWarned = false

  // ── 今天已经有数据库了：分型处理，绝不悄悄覆盖 ──
  if (isFile(file)) {
    const v = verifyBackup(file)
    if (!v.ok) {
      return { ok: false, file, note: `今天的备份产物校验失败（${v.note}）：未改动任何文件` }
    }
    const kind = inspectBackup(date).kind
    if (kind === 'complete') {
      return { ok: true, file, note: '今天已备份过，跳过', rows: v.rows, bytes: fs.statSync(file).size }
    }
    if (kind === 'legacy') {
      // 旧版单文件：**不覆盖它**，只补上媒体快照与清单。
      try {
        cleanBackupDir()
        const tmpMedia = `${mediaDir}.tmp`
        fs.rmSync(tmpMedia, { recursive: true, force: true })
        const snap = snapshotMedia(tmpMedia)
        fs.rmSync(mediaDir, { recursive: true, force: true })
        fs.renameSync(tmpMedia, mediaDir)
        const tmpManifest = `${manifestFile}.tmp`
        writeManifestFile(tmpManifest, date, file, mediaDir)
        fs.renameSync(tmpManifest, manifestFile)
        cleanBackupDir()
        const removed = pruneBackups()
        return {
          ok: true,
          file,
          bytes: fs.statSync(file).size,
          rows: v.rows,
          mediaFiles: snap.count,
          note: ['今天已有旧版单库备份，已补上媒体快照与清单', snap.warn, removed.length ? `清理 ${removed.length} 份旧备份` : '']
            .filter(Boolean)
            .join('；'),
        }
      } catch (err) {
        // 旧 DB 仍在、一个字节没动；半成品由下次 cleanBackupDir() 收掉。
        return { ok: false, file, note: `给旧版备份补媒体快照失败：${(err as Error).message}（旧备份保持原样）` }
      }
    }
    // incomplete / orphan-media（有 DB 但缺件）
    return {
      ok: false,
      file,
      note: `今天的备份不完整：${inspectBackup(date).note ?? '未知'}；未改动任何文件，请人工确认后再备份`,
    }
  }

  // ── 没有数据库，却有媒体/清单：移走留证，不生成新备份 ──
  const before = inspectBackup(date)
  if (before.kind === 'orphan-media') {
    try {
      const moved = quarantineOrphan(date)
      return { ok: false, note: `备份目录里有这一天的媒体/清单但没有数据库：已移到 ${moved} 保留，未生成新备份` }
    } catch (err) {
      return { ok: false, note: `清理这一天的残缺媒体快照失败：${(err as Error).message}` }
    }
  }

  try {
    fs.mkdirSync(config.backupDir, { recursive: true })
  } catch (err) {
    return { ok: false, note: `备份目录不可写：${(err as Error).message}` }
  }

  // 0) 先收掉上次崩溃留下的 staging（含递归删临时媒体目录），记日志。
  const cleaned = cleanBackupDir()

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

  // 2) 媒体快照先进 staging（还没有数据库落盘；出错就整体失败，什么都不提交）
  const tmpMedia = `${mediaDir}.tmp`
  let snap: { count: number; bytes: number; warn: string }
  try {
    fs.rmSync(tmpMedia, { recursive: true, force: true })
    snap = snapshotMedia(tmpMedia)
  } catch (err) {
    fs.rmSync(tmpMedia, { recursive: true, force: true })
    return { ok: false, note: `媒体快照失败：${(err as Error).message}（未改动任何已有产物）` }
  }

  // 3) 再备份数据库（SQLite 在线备份 API，不需要停服）
  // 写临时名再改名：避免中途失败留下一个「看起来像今天的备份」的半成品。
  const tmpFile = `${file}.tmp`
  try {
    fs.rmSync(tmpFile, { force: true })
    await backupTo(tmpFile)
  } catch (err) {
    fs.rmSync(tmpFile, { force: true })
    fs.rmSync(tmpMedia, { recursive: true, force: true })
    return { ok: false, note: `备份失败：${(err as Error).message}` }
  }

  // 4) 校验产物（防「把空库盖到好库上」）
  const v = verifyBackup(tmpFile)
  if (!v.ok) {
    fs.rmSync(tmpFile, { force: true })
    fs.rmSync(tmpMedia, { recursive: true, force: true })
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

  // 5) 媒体快照与清单落位（数据库已提交 → 最坏是「旧格式单库」，下次会补）
  try {
    fs.rmSync(mediaDir, { recursive: true, force: true })
    fs.renameSync(tmpMedia, mediaDir)
    const tmpManifest = `${manifestFile}.tmp`
    writeManifestFile(tmpManifest, date, file, mediaDir)
    fs.renameSync(tmpManifest, manifestFile)
  } catch (err) {
    fs.rmSync(tmpMedia, { recursive: true, force: true })
    cleanBackupDir()
    return { ok: false, file, note: `媒体快照/清单落位失败：${(err as Error).message}（数据库已备份，下次运行会补上媒体）` }
  }

  cleanBackupDir()

  // 6) 滚动清理
  const removed = pruneBackups()

  return {
    ok: true,
    file,
    bytes: fs.statSync(file).size,
    rows: v.rows,
    mediaFiles: snap.count,
    note: [
      cpNote,
      cleaned ? `已清理 ${cleaned} 个未完成的临时产物，已重建` : '',
      snap.warn,
      removed.length ? `清理 ${removed.length} 份旧备份` : '',
    ]
      .filter(Boolean)
      .join('；') || undefined,
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
 * 清掉备份目录里所有 `-wal` / `-shm` 旁文件与 `.tmp` 残留（**staging 包括媒体临时目录**）。
 *
 * 它们不影响正确性，但会让目录变脏、误导运维「这里有好几个库」。
 * ⚠ 必须是**递归**删除：staging 里的媒体快照是一个目录，非递归删不掉 ——
 * 而删不掉还静默会留下一个永远清不掉的半成品，正好是这里要防的。
 */
export function cleanBackupDir(): number {
  if (!fs.existsSync(config.backupDir)) return 0
  let n = 0
  for (const f of fs.readdirSync(config.backupDir)) {
    if (/\.tmp(-wal|-shm)?$/.test(f) || /\.sqlite(-wal|-shm)$/.test(f)) {
      try {
        fs.rmSync(path.join(config.backupDir, f), { recursive: true, force: true })
        n++
      } catch (err) {
        // 失败不静默：清不掉的东西要有人知道。
        console.error(`[backup] 清理临时残留失败 ${f}：${(err as Error).message}`)
      }
    }
  }
  return n
}

export interface RestoreResult {
  ok: boolean
  note: string
  /** 旧现场被移到了哪里（留证）。 */
  movedTo?: string
  /** 恢复回来的图片数。 */
  files?: number
  rows?: number
}

/** 移走一个文件/目录（跨卷时退化为复制 + 删源）。 */
function moveAway(src: string, dst: string): void {
  fs.mkdirSync(path.dirname(dst), { recursive: true })
  try {
    fs.renameSync(src, dst)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err
    const st = fs.statSync(src)
    if (st.isDirectory()) {
      fs.cpSync(src, dst, { recursive: true })
      fs.rmSync(src, { recursive: true, force: true })
    } else {
      fs.copyFileSync(src, dst)
      fs.rmSync(src, { force: true })
    }
  }
}

/**
 * 按日期整站恢复（数据库 + 媒体）。**只给命令行用**（规格 user story 33：
 * 被盗会话不能一键覆盖数据 —— 所以它没有、也不会有 HTTP 入口）。
 *
 * 三条安全性质：
 * 1. **先校验后动手**：数据库判决不过、或三件套不完整 → 直接拒绝；
 * 2. **旧现场移走留证**，不是删掉 —— 恢复错了还能从 `.restore-<时间戳>/` 捞回来；
 * 3. **备份快照仍在**：恢复是复制，不是搬走。
 *
 * 旧格式（只有 `.sqlite`）允许恢复，但**只恢复数据库**，当前媒体目录一个文件都不动（带警告）。
 */
export function restoreBackup(date: string): RestoreResult {
  const p = inspectBackup(date)
  if (!p.hasDb) return { ok: false, note: `没有 ${date} 这一天的备份` }

  const dbV = verifyBackup(p.dbFile)
  if (!dbV.ok) return { ok: false, note: `数据库判决不通过：${dbV.note}` }

  const hasSnapshot = p.hasMedia || p.hasManifest
  if (hasSnapshot) {
    const mediaV = verifyMediaSnapshot(p.mediaDir, p.manifestFile, true)
    if (!mediaV.ok) return { ok: false, note: `媒体判决不通过（${mediaV.note}）：拒绝按日期恢复` }
  }

  // 时间戳目录：同一天恢复两次也不会互相覆盖。
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  let movedTo = path.join(config.backupDir, `.restore-${stamp}`)
  let n = 1
  while (fs.existsSync(movedTo)) movedTo = path.join(config.backupDir, `.restore-${stamp}-${n++}`)

  try {
    fs.mkdirSync(movedTo, { recursive: true })

    // 旧现场：主库 + 可能残留的 -wal/-shm 一起移走（旧 WAL 配新主库会静默给错数据）。
    for (const f of [config.databasePath, `${config.databasePath}-wal`, `${config.databasePath}-shm`]) {
      if (fs.existsSync(f)) moveAway(f, path.join(movedTo, path.basename(f)))
    }

    let files = 0
    if (hasSnapshot) {
      if (fs.existsSync(config.mediaDir)) {
        moveAway(config.mediaDir, path.join(movedTo, path.basename(config.mediaDir)))
      }
      fs.mkdirSync(config.mediaDir, { recursive: true })
      const m = readManifest(p.manifestFile)
      for (const f of m?.files ?? []) {
        fs.copyFileSync(path.join(p.mediaDir, f.name), path.join(config.mediaDir, f.name))
        files++
      }
    }

    fs.mkdirSync(path.dirname(config.databasePath), { recursive: true })
    fs.copyFileSync(p.dbFile, config.databasePath)

    const notes: string[] = []
    if (!hasSnapshot) notes.push('旧格式备份：只恢复了数据库，当前媒体目录未改动')
    notes.push('备份快照仍在原处（恢复是复制，不是搬走）')
    notes.push('恢复会把当时的会话一起带回来——必要时在管理台踢掉全部设备')
    console.log(`[backup] 恢复完成：${date} → ${config.databasePath}（旧现场在 ${movedTo}）`)
    return { ok: true, note: notes.join('；'), movedTo, files, rows: dbV.rows }
  } catch (err) {
    return { ok: false, note: `恢复失败：${(err as Error).message}（旧现场在 ${movedTo}）`, movedTo }
  }
}
