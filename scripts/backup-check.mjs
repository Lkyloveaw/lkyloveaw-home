/**
 * 实现④的断言：入口校验 + checkpoint + 备份 + 媒体三件套与恢复。
 *
 * ⚠ 所有依赖配置的场景都在**子进程**里跑：config 在模块 import 时就把环境变量读成了常量，
 * 同一进程里后续改 process.env 是无效的（ESM 模块还会缓存）。第一版就是栽在这上面。
 *
 * 这一套里几条**防「静默降级」**的断言比功能断言更重要：
 * - checkpoint 的 busy 会骗人（实测 busy:0 却只搬了 2/33 页）；
 * - 「只拷 .sqlite」的副本**打得开、但没有 probes 表**——所以「文件非空」不足以判可用；
 * - 媒体快照用硬链接省空间，但**旧版只有 .sqlite 的单文件备份不许因缺媒体被删**。
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = process.cwd()
const sandbox = fs.mkdtempSync(path.join(ROOT, '.backup-sandbox-'))
const url = (rel) => pathToFileURL(path.join(ROOT, rel)).href

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + name + (detail ? '  ' + detail : ''))
}

/** 在子进程里跑一段脚本，脚本把结果写进 R 并打印 __R__<json>。 */
function child(name, body, env = {}) {
  const file = path.join(sandbox, name + '.mjs')
  fs.writeFileSync(file, 'const R = {};\n' + body + "\nconsole.log('__R__' + JSON.stringify(R));\n", 'utf8')
  const out = execFileSync(process.execPath, [file], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 1 << 24,
    env: { ...process.env, ...env },
  })
  const line = out.split('\n').filter((l) => l.startsWith('__R__')).pop()
  if (!line) throw new Error(name + ': 子进程没有输出 __R__\n' + out)
  return JSON.parse(line.slice(5))
}

const P = (p) => JSON.stringify(p)
const NL = '\n'
const j = (...parts) => parts.join(NL)
const SRC_DB = path.join(sandbox, 'src.sqlite')
/** 新的子进程场景各自带 fs/path（PRELUDE 场景已自带）。 */
const IMP = j('import fs from "node:fs";', 'import path from "node:path";')

const PRELUDE = [
  "import fs from 'node:fs';",
  "import path from 'node:path';",
  "import Database from 'better-sqlite3';",
  'const SRC_DB = ' + P(SRC_DB) + ';',
  '/** 造一个「数据还在 WAL 里」的库：必须**保持连接打开**，因为正常 close 会触发 checkpoint。 */',
  'function makeWalDb(file, rows) {',
  "  const db = new Database(file);",
  "  db.pragma('journal_mode = WAL');",
  "  db.pragma('wal_autocheckpoint = 0');",
  "  db.exec('CREATE TABLE IF NOT EXISTS probes (id INTEGER PRIMARY KEY AUTOINCREMENT, target_id TEXT, at INTEGER, status TEXT, latency_ms INTEGER, status_code INTEGER, error TEXT, round_at INTEGER)');",
  "  const st = db.prepare('INSERT INTO probes (target_id, at, round_at, status, latency_ms, status_code, error) VALUES (?,?,?,?,?,?,?)');",
  '  const tx = db.transaction(function () { for (let i = 0; i < rows; i++) st.run("t1", Date.now() - i * 1000, Date.now(), "up", 12, 200, null); });',
  '  tx();',
  '  return db;',
  '}',
  'function countRows(file) {',
  "  const d = new Database(file, { readonly: true });",
  "  const n = d.prepare('SELECT COUNT(*) AS n FROM probes').get().n;",
  '  d.close();',
  '  return n;',
  '}',
].join(NL)

/* 媒体夹具：文件名必须是 64 位十六进制 + 规范扩展名（媒体层只认这个形状）。 */
const M1 = 'a'.repeat(64) + '.png'
const M2 = 'b'.repeat(64) + '.jpg'
const M3 = 'c'.repeat(64) + '.png'
const H1 = 'a'.repeat(64)

/** 每个场景一套独立的临时目录，互不干扰。 */
function scenario(name) {
  const dir = path.join(sandbox, name)
  const media = path.join(dir, 'media')
  const bk = path.join(dir, 'bk')
  fs.mkdirSync(media, { recursive: true })
  fs.mkdirSync(bk, { recursive: true })
  return { dir, media, bk, db: path.join(dir, 'live.sqlite') }
}
function putMedia(media, name, byte, size) {
  fs.writeFileSync(path.join(media, name), Buffer.alloc(size, byte))
}
function listDir(dir) {
  try {
    return fs.readdirSync(dir)
  } catch {
    return []
  }
}

// ════════════════════════════════════════════════════
console.log('\n[入口校验：三条规则 + 不误伤]')
// ════════════════════════════════════════════════════
const REJECT = [
  ['无 scheme（实测会被解析成奇怪的 protocol）', 'ledger.internal.example:8080'],
  ['带用户名与口令', 'http://ops:hunter2@10.0.0.1/'],
  ['只带用户名也算凭证', 'http://ops@10.0.0.1/'],
  ['file: 协议', 'file:///etc/passwd'],
  ['ftp: 协议', 'ftp://10.0.0.1/'],
  ['javascript: 协议', 'javascript:alert(1)'],
  ['data: 协议', 'data:text/html,<h1>x'],
  ['gopher: 协议', 'gopher://10.0.0.1/'],
  ['空字符串', ''],
  ['纯文本不是 URL', 'not a url at all'],
  ['https 带 userinfo 也拒', 'https://u:p@example.com/'],
]
const ALLOW = [
  ['普通 http', 'http://10.0.0.10/'],
  ['普通 https', 'https://example.com/'],
  ['本机地址不误伤', 'http://127.0.0.1:8080/health'],
  ['内网地址不误伤', 'http://192.168.1.1/'],
  ['10.x 不误伤', 'http://10.255.255.1/'],
  ['带端口与路径', 'https://example.com:8443/a/b?c=1'],
]
{
  const list = [
    ...REJECT.map(([, u], i) => ({ id: 'r' + i, name: 'x', url: u })),
    ...ALLOW.map(([, u], i) => ({ id: 'a' + i, name: 'x', url: u })),
  ]
  const r = child('validate', j(
    'process.env.TARGETS_JSON = ' + P(JSON.stringify(list)) + ';',
    'process.env.DATABASE_PATH = ' + P(path.join(sandbox, 'cfg.sqlite')) + ';',
    'const m = await import(' + P(url('dist/config.js')) + ');',
    'R.kept = m.config.targets.map(function (t) { return t.id; });',
  ))
  REJECT.forEach(([label], i) => check('拒绝：' + label, !r.kept.includes('r' + i)))
  ALLOW.forEach(([label], i) => check('放行：' + label, r.kept.includes('a' + i)))
  check('校验器 ' + (REJECT.length + ALLOW.length) + ' 用例（拒 ' + REJECT.length + ' / 放行 ' + ALLOW.length + '）', true)
}

// ════════════════════════════════════════════════════
console.log('\n[空库陷阱：只拷 .sqlite 的副本不能用]')
// ════════════════════════════════════════════════════
{
  const r = child('naive', j(PRELUDE,
    '// 连接**保持打开**——正常 close 会 checkpoint，那样就模拟不出真实场景了。',
    'const db = makeWalDb(SRC_DB, 3000);',
    "R.walBytes = fs.statSync(SRC_DB + '-wal').size;",
    'const copy = ' + P(path.join(sandbox, 'naive.sqlite')) + ';',
    'fs.copyFileSync(SRC_DB, copy);',
    'try {',
    '  R.copyRows = countRows(copy);',
    '  R.copyOpened = true;',
    '} catch (e) {',
    '  R.copyOpened = false;',
    '  R.copyErr = e.message;',
    '}',
    'db.close();',
  ))
  check('探测前 WAL 里确实有内容（前提成立）', r.walBytes > 0, 'wal=' + r.walBytes + 'B')
  check('只拷 .sqlite 的副本打不开 probes 表（这就是那个陷阱）', r.copyOpened === false, r.copyOpened ? '竟然打开且有 ' + r.copyRows + ' 行' : r.copyErr)
}

// ════════════════════════════════════════════════════
console.log('\n[checkpoint：TRUNCATE 真搬且截断]')
// ════════════════════════════════════════════════════
{
  const r = child('cp', j(PRELUDE,
    'const db = makeWalDb(SRC_DB, 3000);',
    "R.walBefore = fs.statSync(SRC_DB + '-wal').size;",
    "R.mainBefore = fs.statSync(SRC_DB).size;",
    'db.close();',
    '// 重新造 WAL 内容（close 会 checkpoint，所以再写一轮并保持打开）',
    'const db2 = new Database(SRC_DB);',
    "db2.pragma('journal_mode = WAL');",
    "db2.pragma('wal_autocheckpoint = 0');",
    "const st = db2.prepare('INSERT INTO probes (target_id, at, round_at, status, latency_ms, status_code, error) VALUES (?,?,?,?,?,?,?)');",
    'for (let i = 0; i < 2000; i++) st.run("t2", Date.now(), Date.now(), "up", 9, 200, null);',
    "R.walMid = fs.statSync(SRC_DB + '-wal').size;",
  ), { DATABASE_PATH: SRC_DB })
  check('checkpoint 前 WAL 有内容（前提成立）', r.walMid > 0, 'wal=' + r.walMid + 'B')
}
{
  const r = child('cp2', j(PRELUDE,
    'const db = makeWalDb(SRC_DB, 2000);',
    "R.walBefore = fs.statSync(SRC_DB + '-wal').size;",
    "R.mainBefore = fs.statSync(SRC_DB).size;",
    'const s = await import(' + P(url('dist/store.js')) + ');',
    's.initStore();',
    "const cp = s.checkpoint('TRUNCATE');",
    'R.busy = cp.busy;',
    'R.pages = cp.pages;',
    "R.walAfter = fs.existsSync(SRC_DB + '-wal') ? fs.statSync(SRC_DB + '-wal').size : 0;",
    "R.mainAfter = fs.statSync(SRC_DB).size;",
    's.closeStore();',
    'db.close();',
  ), { DATABASE_PATH: SRC_DB, BACKUP_DIR: path.join(sandbox, 'bk0') })
  check('checkpoint 返回 busy === 0（无并发干扰）', r.busy === 0, 'busy=' + r.busy)
  check('TRUNCATE 后 WAL 归 0（截断才是「只拷 .sqlite」能成功的前提）', r.walAfter === 0, 'wal=' + r.walAfter + 'B')
  check('主库变大（内容真的搬回来了）', r.mainAfter > r.mainBefore, r.mainBefore + ' → ' + r.mainAfter)
}

// ════════════════════════════════════════════════════
console.log('\n[并发时 checkpoint 不谎报成功]')
// ════════════════════════════════════════════════════
{
  const r = child('cp3', j(PRELUDE,
    '// 连接甲：持有读事务不放',
    'const a = new Database(SRC_DB);',
    "a.pragma('journal_mode = WAL');",
    "a.pragma('wal_autocheckpoint = 0');",
    "const st = a.prepare('INSERT INTO probes (target_id, at, round_at, status, latency_ms, status_code, error) VALUES (?,?,?,?,?,?,?)');",
    'for (let i = 0; i < 2000; i++) st.run("t3", Date.now(), Date.now(), "up", 9, 200, null);',
    "a.exec('BEGIN');",
    "a.prepare('SELECT COUNT(*) AS n FROM probes').get();",
    'const b = new Database(SRC_DB);',
    "const row = b.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();",
    'R.busy = row.busy;',
    'R.pages = row.checkpointed;',
    "R.walSize = fs.existsSync(SRC_DB + '-wal') ? fs.statSync(SRC_DB + '-wal').size : 0;",
    "R.mainRows = (function () { try { return countRows(SRC_DB) } catch (e) { return null } })();",
    "a.exec('ROLLBACK');",
    'a.close(); b.close();',
  ), { DATABASE_PATH: SRC_DB })
  check('并发下 checkpoint 报 busy !== 0（不谎报成功）', r.busy !== 0, 'busy=' + r.busy + ' pages=' + r.pages + ' wal=' + r.walSize + 'B')
  check('并发下 WAL 未被截断（busy 非 0 的后果可观测）', r.walSize > 0, 'wal=' + r.walSize + 'B')
}

// ════════════════════════════════════════════════════
console.log('\n[备份：三件套齐全，产物可用]')
// ════════════════════════════════════════════════════
const triplet = scenario('triplet')
putMedia(triplet.media, M1, 1, 1234)
putMedia(triplet.media, M2, 2, 77)
{
  const noProbes = path.join(triplet.dir, 'no-probes.sqlite')
  const r = child('backup1', j(IMP,
    'const b = await import(' + P(url('dist/backup.js')) + ');',
    'const st = await import(' + P(url('dist/store.js')) + ');',
    'st.initStore();',
    'const r1 = await b.runBackup(new Date("2026-01-01T10:00:00"));',
    'R.first = { ok: r1.ok, bytes: r1.bytes, rows: r1.rows, mediaFiles: r1.mediaFiles, note: r1.note };',
    'R.files = fs.readdirSync(' + P(triplet.bk) + ');',
    'const man = JSON.parse(fs.readFileSync(path.join(' + P(triplet.bk) + ', "2026-01-01.manifest.json"), "utf8"));',
    'R.manifestFiles = man.files.map(function (f) { return f.name; });',
    'R.manifestCount = man.media.count;',
    'R.manifestBytesOk = man.files.every(function (f) { return fs.statSync(path.join(' + P(triplet.bk) + ', "2026-01-01.media", f.name)).size === f.bytes; });',
    'R.inspect = b.inspectBackup("2026-01-01").kind;',
    'R.verifyAt = b.verifyBackupAt("2026-01-01");',
    'R.second = await b.runBackup(new Date("2026-01-01T11:00:00"));',
    'R.emptyVerify = b.verifyBackup(' + P(noProbes) + ');',
    'R.missingVerify = b.verifyBackup(' + P(path.join(triplet.dir, 'nope.sqlite')) + ');',
    'st.closeStore();',
  ), { DATABASE_PATH: triplet.db, MEDIA_DIR: triplet.media, BACKUP_DIR: triplet.bk, BACKUP_KEEP: '7' })
  check('备份成功', r.first.ok, r.first.note || '')
  check('产物有实际大小', r.first.bytes > 0, r.first.bytes + 'B')
  check('三件套齐全（.sqlite + .media/ + .manifest.json）', ['2026-01-01.sqlite', '2026-01-01.media', '2026-01-01.manifest.json'].every((f) => r.files.includes(f)), r.files.join(','))
  check('清单的文件集合与快照目录一致且字节数对得上', r.manifestCount === 2 && r.manifestBytesOk, JSON.stringify(r.manifestFiles))
  check('runBackup 报出媒体张数', r.first.mediaFiles === 2, String(r.first.mediaFiles))
  check('inspectBackup 判为 complete', r.inspect === 'complete', r.inspect)
  check('verifyBackupAt：数据库判决与媒体判决都通过', r.verifyAt.db.ok && r.verifyAt.media.ok, JSON.stringify(r.verifyAt))
  check('同一天重复跑会跳过（不覆盖、不堆积）', r.second.ok && /跳过/.test(r.second.note || ''), r.second.note || '')
  check('verifyBackup 拒绝没有 probes 表的库', !r.emptyVerify.ok, r.emptyVerify.note || '')
  check('verifyBackup 拒绝不存在的文件', !r.missingVerify.ok)
}

// ════════════════════════════════════════════════════
console.log('\n[媒体快照：硬链接省空间，源删后快照仍在]')
// ════════════════════════════════════════════════════
{
  const s = scenario('hardlink')
  putMedia(s.media, M1, 1, 1234)
  const r = child('hardlink', j(IMP,
    'const b = await import(' + P(url('dist/backup.js')) + ');',
    'const st = await import(' + P(url('dist/store.js')) + ');',
    'st.initStore();',
    'await b.runBackup(new Date("2026-02-01T10:00:00"));',
    'const src = fs.statSync(path.join(' + P(s.media) + ', ' + P(M1) + '));',
    'const snap = fs.statSync(path.join(' + P(s.bk) + ', "2026-02-01.media", ' + P(M1) + '));',
    'R.sameInode = src.ino !== 0 && src.ino === snap.ino;',
    'R.nlink = snap.nlink;',
    'fs.rmSync(path.join(' + P(s.media) + ', ' + P(M1) + '));',
    'R.snapStillThere = fs.existsSync(path.join(' + P(s.bk) + ', "2026-02-01.media", ' + P(M1) + '));',
    'R.snapBytes = fs.readFileSync(path.join(' + P(s.bk) + ', "2026-02-01.media", ' + P(M1) + ')).length;',
    'st.closeStore();',
  ), { DATABASE_PATH: s.db, MEDIA_DIR: s.media, BACKUP_DIR: s.bk })
  check('快照与原文件是同一个 inode（硬链接，不占第二份空间）', r.sameInode === true, 'nlink=' + r.nlink)
  check('链接数 >= 2（老图不会在 7 份日备份里重复占空间）', r.nlink >= 2, 'nlink=' + r.nlink)
  check('源文件删掉后，旧快照仍可读且字节数不变', r.snapStillThere === true && r.snapBytes === 1234, r.snapBytes + 'B')
}

// ════════════════════════════════════════════════════
console.log('\n[跨文件系统：EXDEV 退化为复制且只警告一次；非 EXDEV 失败不留半成品]')
// ════════════════════════════════════════════════════
{
  const s = scenario('exdev')
  putMedia(s.media, M1, 1, 500)
  const r = child('exdev', j(IMP,
    'const warns = []; const ow = console.warn;',
    'console.warn = function () { warns.push(Array.prototype.join.call(arguments, " ")); };',
    'const b = await import(' + P(url('dist/backup.js')) + ');',
    'const st = await import(' + P(url('dist/store.js')) + ');',
    'st.initStore();',
    'b.mediaLinker.link = function () { const e = new Error("cross-device"); e.code = "EXDEV"; throw e; };',
    'const r = await b.runBackup(new Date("2026-03-01T10:00:00"));',
    'console.warn = ow;',
    'R.ok = r.ok; R.note = r.note;',
    'R.warns = warns.filter(function (w) { return w.indexOf("跨文件系统") >= 0; }).length;',
    'R.copied = fs.existsSync(path.join(' + P(s.bk) + ', "2026-03-01.media", ' + P(M1) + ')) && fs.statSync(path.join(' + P(s.bk) + ', "2026-03-01.media", ' + P(M1) + ')).nlink === 1;',
    'st.closeStore();',
  ), { DATABASE_PATH: s.db, MEDIA_DIR: s.media, BACKUP_DIR: s.bk })
  check('EXDEV 时仍然备份成功', r.ok === true, r.note || '')
  check('跨文件系统警告只出现一次', r.warns === 1, String(r.warns))
  check('回退成复制（链接数为 1，不再共享 inode）', r.copied === true)
}
{
  const s = scenario('nonexdev')
  putMedia(s.media, M1, 1, 500)
  const r = child('nonexdev', j(IMP,
    'const b = await import(' + P(url('dist/backup.js')) + ');',
    'const st = await import(' + P(url('dist/store.js')) + ');',
    'st.initStore();',
    'b.mediaLinker.link = function () { throw new Error("boom"); };',
    'const r = await b.runBackup(new Date("2026-04-01T10:00:00"));',
    'R.ok = r.ok; R.note = r.note;',
    'R.entries = fs.existsSync(' + P(s.bk) + ') ? fs.readdirSync(' + P(s.bk) + ').filter(function (f) { return f.indexOf("2026-04-01") === 0; }) : [];',
    'st.closeStore();',
  ), { DATABASE_PATH: s.db, MEDIA_DIR: s.media, BACKUP_DIR: s.bk })
  check('非 EXDEV 的链接失败 → ok:false', r.ok === false, r.note || '')
  check('失败不留半成品（没有 2026-04-01 的任何文件/目录）', r.entries.length === 0, r.entries.join(','))
}

// ════════════════════════════════════════════════════
console.log('\n[残缺 staging：清理并重建]')
// ════════════════════════════════════════════════════
{
  const s = scenario('staging')
  putMedia(s.media, M1, 1, 300)
  const r = child('staging', j(IMP,
    'const b = await import(' + P(url('dist/backup.js')) + ');',
    'const st = await import(' + P(url('dist/store.js')) + ');',
    'st.initStore();',
    'fs.writeFileSync(path.join(' + P(s.bk) + ', "2026-05-01.sqlite.tmp"), "half");',
    'fs.mkdirSync(path.join(' + P(s.bk) + ', "2026-05-01.media.tmp"), { recursive: true });',
    'fs.writeFileSync(path.join(' + P(s.bk) + ', "2026-05-01.media.tmp", "junk.png"), "x");',
    'fs.writeFileSync(path.join(' + P(s.bk) + ', "2026-05-01.manifest.json.tmp"), "{}");',
    'const r = await b.runBackup(new Date("2026-05-01T10:00:00"));',
    'R.ok = r.ok; R.note = r.note;',
    'R.tmpGone = !fs.existsSync(path.join(' + P(s.bk) + ', "2026-05-01.media.tmp"));',
    'R.sqliteTmpGone = !fs.existsSync(path.join(' + P(s.bk) + ', "2026-05-01.sqlite.tmp"));',
    'R.kind = b.inspectBackup("2026-05-01").kind;',
    'st.closeStore();',
  ), { DATABASE_PATH: s.db, MEDIA_DIR: s.media, BACKUP_DIR: s.bk })
  check('半天三件套被清理并重建成功', r.ok === true && /已重建/.test(r.note || ''), r.note || '')
  check('临时媒体目录被递归删掉（非递归删不掉）', r.tmpGone === true)
  check('临时数据库文件也被清掉', r.sqliteTmpGone === true)
  check('重建后是完整三件套', r.kind === 'complete', r.kind)
}

// ════════════════════════════════════════════════════
console.log('\n[未分类状态：缺件零删除；孤儿移走留证]')
// ════════════════════════════════════════════════════
{
  const s = scenario('states')
  putMedia(s.media, M1, 1, 300)
  const fakeManifest = JSON.stringify({
    version: 1,
    date: '2026-06-02',
    createdAt: 1,
    sqlite: { name: '2026-06-02.sqlite', bytes: 1 },
    media: { count: 2, bytes: 0 },
    files: [{ name: M1, bytes: 999, hash: H1 }],
  })
  const r = child('states', j(IMP,
    'const b = await import(' + P(url('dist/backup.js')) + ');',
    'const st = await import(' + P(url('dist/store.js')) + ');',
    'st.initStore();',
    'await b.runBackup(new Date("2026-06-01T10:00:00"));',
    'const seed = fs.readFileSync(path.join(' + P(s.bk) + ', "2026-06-01.sqlite"));',
    '// ① 缺清单：数据库 + 媒体目录，没有 manifest',
    'fs.writeFileSync(path.join(' + P(s.bk) + ', "2026-06-02.sqlite"), seed);',
    'fs.mkdirSync(path.join(' + P(s.bk) + ', "2026-06-02.media"), { recursive: true });',
    'fs.writeFileSync(path.join(' + P(s.bk) + ', "2026-06-02.media", ' + P(M1) + '), "x");',
    'const inc = await b.runBackup(new Date("2026-06-02T10:00:00"));',
    'R.incOk = inc.ok; R.incKind = b.inspectBackup("2026-06-02").kind;',
    'R.incDbStill = fs.existsSync(path.join(' + P(s.bk) + ', "2026-06-02.sqlite"));',
    'R.incMediaStill = fs.existsSync(path.join(' + P(s.bk) + ', "2026-06-02.media", ' + P(M1) + '));',
    '// ② 清单与目录不一致（清单说 999 字节，实际 5 字节）',
    'fs.writeFileSync(path.join(' + P(s.bk) + ', "2026-06-03.sqlite"), seed);',
    'fs.mkdirSync(path.join(' + P(s.bk) + ', "2026-06-03.media"), { recursive: true });',
    'fs.writeFileSync(path.join(' + P(s.bk) + ', "2026-06-03.media", ' + P(M1) + '), "12345");',
    'fs.writeFileSync(path.join(' + P(s.bk) + ', "2026-06-03.manifest.json"), ' + P(fakeManifest) + ');',
    'const bad = await b.runBackup(new Date("2026-06-03T10:00:00"));',
    'R.badOk = bad.ok; R.badKind = b.inspectBackup("2026-06-03").kind;',
    'R.badDbStill = fs.existsSync(path.join(' + P(s.bk) + ', "2026-06-03.sqlite"));',
    'R.badMediaStill = fs.existsSync(path.join(' + P(s.bk) + ', "2026-06-03.media", ' + P(M1) + '));',
    '// ③ 有媒体/清单但无数据库 → 移到 .orphan-<date> 保留',
    'fs.mkdirSync(path.join(' + P(s.bk) + ', "2026-06-04.media"), { recursive: true });',
    'fs.writeFileSync(path.join(' + P(s.bk) + ', "2026-06-04.media", ' + P(M1) + '), "x");',
    'fs.writeFileSync(path.join(' + P(s.bk) + ', "2026-06-04.manifest.json"), "{}");',
    'const orp = await b.runBackup(new Date("2026-06-04T10:00:00"));',
    'R.orpOk = orp.ok;',
    'R.orpMoved = fs.existsSync(path.join(' + P(s.bk) + ', ".orphan-2026-06-04", "2026-06-04.media", ' + P(M1) + '));',
    'R.orpGone = !fs.existsSync(path.join(' + P(s.bk) + ', "2026-06-04.media"));',
    'st.closeStore();',
  ), { DATABASE_PATH: s.db, MEDIA_DIR: s.media, BACKUP_DIR: s.bk })
  check('缺清单 → 判为 incomplete 且 ok:false', r.incOk === false && r.incKind === 'incomplete', r.incKind)
  check('缺清单时数据库与媒体一个都没删', r.incDbStill === true && r.incMediaStill === true)
  check('清单与目录不一致 → 判为 incomplete 且 ok:false', r.badOk === false && r.badKind === 'incomplete', r.badKind)
  check('清单不一致时数据库与媒体一个都没删', r.badDbStill === true && r.badMediaStill === true)
  check('有媒体无数据库 → ok:false 且媒体被移到 .orphan-<date> 保留', r.orpOk === false && r.orpMoved === true && r.orpGone === true)
}

// ════════════════════════════════════════════════════
console.log('\n[旧格式单库：补媒体与清单，且旧数据库不被覆盖]')
// ════════════════════════════════════════════════════
{
  const s = scenario('legacy')
  putMedia(s.media, M1, 1, 300)
  const r = child('legacy', j(IMP,
    'const b = await import(' + P(url('dist/backup.js')) + ');',
    'const st = await import(' + P(url('dist/store.js')) + ');',
    'st.initStore();',
    'await b.runBackup(new Date("2026-07-01T10:00:00"));',
    '// 删掉媒体与清单，只留单库 → 模拟旧版格式',
    'fs.rmSync(path.join(' + P(s.bk) + ', "2026-07-01.media"), { recursive: true, force: true });',
    'fs.rmSync(path.join(' + P(s.bk) + ', "2026-07-01.manifest.json"), { force: true });',
    'const before = fs.statSync(path.join(' + P(s.bk) + ', "2026-07-01.sqlite"));',
    'R.kindBefore = b.inspectBackup("2026-07-01").kind;',
    'const r = await b.runBackup(new Date("2026-07-01T11:00:00"));',
    'const after = fs.statSync(path.join(' + P(s.bk) + ', "2026-07-01.sqlite"));',
    'R.ok = r.ok; R.note = r.note;',
    'R.media = fs.existsSync(path.join(' + P(s.bk) + ', "2026-07-01.media", ' + P(M1) + '));',
    'R.manifest = fs.existsSync(path.join(' + P(s.bk) + ', "2026-07-01.manifest.json"));',
    'R.dbUnchanged = before.mtimeMs === after.mtimeMs && before.size === after.size;',
    'R.kind = b.inspectBackup("2026-07-01").kind;',
    'st.closeStore();',
  ), { DATABASE_PATH: s.db, MEDIA_DIR: s.media, BACKUP_DIR: s.bk })
  check('旧格式单库被认出来是 legacy（不是 incomplete）', r.kindBefore === 'legacy', r.kindBefore)
  check('补媒体与清单成功', r.ok === true && /补上媒体快照与清单/.test(r.note || ''), r.note || '')
  check('旧数据库文件一字未动（不被覆盖）', r.dbUnchanged === true)
  check('补完后是完整三件套', r.media === true && r.manifest === true && r.kind === 'complete', r.kind)
}

// ════════════════════════════════════════════════════
console.log('\n[滚动保留：一天一份；三件套同进同退；旧格式照旧滚动]')
// ════════════════════════════════════════════════════
{
  const rollDir = path.join(sandbox, 'roll')
  fs.mkdirSync(rollDir, { recursive: true })
  const template = fs.readFileSync(path.join(triplet.bk, '2026-01-01.sqlite'))
  const mkTriplet = (date) => {
    fs.writeFileSync(path.join(rollDir, date + '.sqlite'), template)
    fs.mkdirSync(path.join(rollDir, date + '.media'), { recursive: true })
    fs.writeFileSync(path.join(rollDir, date + '.media', M1), 'x')
    fs.writeFileSync(path.join(rollDir, date + '.manifest.json'), '{}')
  }
  const mkLegacy = (date) => fs.writeFileSync(path.join(rollDir, date + '.sqlite'), template)
  // 1-4 三件套，5-8 旧格式，9-10 三件套；保留 5 份 → 只剩 06..10
  for (let i = 1; i <= 4; i++) mkTriplet('2026-01-0' + i)
  for (let i = 5; i <= 8; i++) mkLegacy('2026-01-0' + i)
  for (let i = 9; i <= 10; i++) mkTriplet('2026-01-' + String(i).padStart(2, '0'))
  const r = child('roll', j(IMP,
    'const b = await import(' + P(url('dist/backup.js')) + ');',
    'R.before = b.listBackups();',
    'R.removed = b.pruneBackups(5);',
    'R.after = b.listBackups();',
    'R.entries = fs.readdirSync(' + P(rollDir) + ');',
  ), { DATABASE_PATH: SRC_DB, BACKUP_DIR: rollDir, BACKUP_KEEP: '5' })
  check('造了 10 天（4 天三件套 + 4 天旧格式 + 2 天三件套）', r.before.length === 10, String(r.before.length))
  check('清理后只剩最近 5 天', r.after.length === 5, r.after.join(','))
  check('留下的是最新的 5 天（含 3 天旧格式单库）', JSON.stringify(r.after) === JSON.stringify(['2026-01-06.sqlite', '2026-01-07.sqlite', '2026-01-08.sqlite', '2026-01-09.sqlite', '2026-01-10.sqlite']), r.after.join(','))
  check('删掉的是最旧的 5 天', r.removed.length === 5 && r.removed[0] === '2026-01-01.sqlite', r.removed.join(','))
  check('被删那几天的媒体快照与清单一起消失了（同进同退）', !r.entries.includes('2026-01-01.media') && !r.entries.includes('2026-01-04.media') && !r.entries.includes('2026-01-01.manifest.json'), r.entries.join(','))
  check('保留的三件套仍是完整的三件（媒体目录还在）', r.entries.includes('2026-01-09.media') && r.entries.includes('2026-01-10.manifest.json'))
  check('旧格式单库留在保留窗口内就不会被当残缺删掉', ['2026-01-06.sqlite', '2026-01-07.sqlite', '2026-01-08.sqlite'].every((f) => r.entries.includes(f)) && !r.entries.some((f) => f.indexOf('2026-01-06.') === 0 && f !== '2026-01-06.sqlite'))
}

// ════════════════════════════════════════════════════
console.log('\n[恢复：残留 WAL 会坏事（证明「必须一起移走」不多余）]')
// ════════════════════════════════════════════════════
{
  const r = child('walcase', j(PRELUDE,
    'const dir = ' + P(path.join(sandbox, 'walcase')) + ';',
    'fs.mkdirSync(dir, { recursive: true });',
    'const good = path.join(dir, "good.sqlite");',
    'const g = makeWalDb(good, 1);',
    "g.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();",
    'g.close();',
    'R.goodRows = countRows(good);',
    'const other = path.join(dir, "other.sqlite");',
    'const o = makeWalDb(other, 80);',
    "R.otherWalSize = fs.existsSync(other + '-wal') ? fs.statSync(other + '-wal').size : 0;",
    'const victim = path.join(dir, "victim.sqlite");',
    'fs.copyFileSync(good, victim);',
    "fs.copyFileSync(other + '-wal', victim + '-wal');",
    'try {',
    '  R.victimRows = countRows(victim);',
    '  R.victimOpened = true;',
    '} catch (e) {',
    '  R.victimOpened = false;',
    '  R.victimErr = e.message;',
    '}',
    'o.close();',
  ))
  check('干净主库只有 1 行（前提成立）', r.goodRows === 1, r.goodRows + ' 行')
  check('造出了有内容的 WAL（前提成立）', r.otherWalSize > 0, r.otherWalSize + 'B')
  const broken = r.victimOpened === false || r.victimRows !== 1
  check('残留 WAL 让恢复结果错乱或打不开（所以必须一起移走）', broken, r.victimOpened === false ? '打不开：' + r.victimErr : '读到 ' + r.victimRows + ' 行（另一库的数据被应用）')
}

// ════════════════════════════════════════════════════
console.log('\n[恢复：按日期整站恢复（数据库 + 媒体），旧现场留证，快照仍在]')
// ════════════════════════════════════════════════════
{
  const s = scenario('restore')
  putMedia(s.media, M1, 1, 500)
  const r = child('restore', j(IMP,
    'const b = await import(' + P(url('dist/backup.js')) + ');',
    'const st = await import(' + P(url('dist/store.js')) + ');',
    'st.initStore();',
    'await b.runBackup(new Date("2026-08-01T10:00:00"));',
    'st.closeStore();',
    '// 内容寻址的规矩：改图 = 新文件（删掉旧的 + 另写一张新名字的）',
    'fs.rmSync(path.join(' + P(s.media) + ', ' + P(M1) + '));',
    'fs.writeFileSync(path.join(' + P(s.media) + ', ' + P(M3) + '), Buffer.alloc(42, 7));',
    'const res = b.restoreBackup("2026-08-01");',
    'R.ok = res.ok; R.files = res.files; R.note = res.note;',
    'R.liveBytes = fs.readFileSync(path.join(' + P(s.media) + ', ' + P(M1) + ')).length;',
    'R.liveByte0 = fs.readFileSync(path.join(' + P(s.media) + ', ' + P(M1) + '))[0];',
    'R.newGone = !fs.existsSync(path.join(' + P(s.media) + ', ' + P(M3) + '));',
    'R.snapStill = fs.existsSync(path.join(' + P(s.bk) + ', "2026-08-01.sqlite"));',
    'R.movedTo = res.movedTo !== undefined && fs.existsSync(res.movedTo);',
    'R.movedMedia = fs.existsSync(path.join(res.movedTo, "media", ' + P(M3) + '));',
    '// 旧格式：只恢复数据库，媒体目录一个不动',
    'fs.copyFileSync(path.join(' + P(s.bk) + ', "2026-08-01.sqlite"), path.join(' + P(s.bk) + ', "2026-08-02.sqlite"));',
    'fs.writeFileSync(path.join(' + P(s.media) + ', ' + P(M3) + '), Buffer.alloc(42, 7));',
    'const res2 = b.restoreBackup("2026-08-02");',
    'R.legacyOk = res2.ok; R.legacyNote = res2.note;',
    'R.legacyMediaStill = fs.existsSync(path.join(' + P(s.media) + ', ' + P(M3) + '));',
    'R.legacyLiveBytes = fs.readFileSync(path.join(' + P(s.media) + ', ' + P(M1) + ')).length;',
    'R.legacyFiles = res2.files;',
  ), { DATABASE_PATH: s.db, MEDIA_DIR: s.media, BACKUP_DIR: s.bk })
  check('按日期恢复成功', r.ok === true, r.note || '')
  check('恢复回来的图片字节与快照一致（500 字节，首字节 1）', r.liveBytes === 500 && r.liveByte0 === 1, r.liveBytes + 'B/' + r.liveByte0)
  check('恢复时新加的图被移走（当前媒体目录回到快照状态）', r.newGone === true)
  check('恢复后备份快照仍在原处（恢复是复制，不是搬走）', r.snapStill === true)
  check('旧现场被移到 .restore-<时间戳>/ 留证（含恢复前的媒体目录）', r.movedTo === true && r.movedMedia === true)
  check('旧格式也允许恢复，但只恢复数据库', r.legacyOk === true && /旧格式/.test(r.legacyNote || ''), r.legacyNote || '')
  check('旧格式恢复后当前媒体目录一个文件都没动', r.legacyMediaStill === true && r.legacyLiveBytes === 500 && r.legacyFiles === 0, 'files=' + r.legacyFiles)
}

// ════════════════════════════════════════════════════
console.log('\n[备份失败不拖垮探测]')
// ════════════════════════════════════════════════════
{
  const blocker = path.join(sandbox, 'blocker')
  fs.writeFileSync(blocker, 'not a dir')
  const r = child('failbackup', j(PRELUDE,
    'const b = await import(' + P(url('dist/backup.js')) + ');',
    'const s = await import(' + P(url('dist/store.js')) + ');',
    's.initStore();',
    'const res = await b.runBackup();',
    'R.ok = res.ok; R.note = res.note;',
    's.closeStore();',
  ), { DATABASE_PATH: SRC_DB, BACKUP_DIR: path.join(blocker, 'sub') })
  check('不可写的备份目录 → ok:false 且不抛（探测循环能继续）', r.ok === false, r.note || '')
}

// ════════════════════════════════════════════════════
console.log('\n[孤图清理 CLI：零引用保护与 --force，两条「不删」的路]')
// ════════════════════════════════════════════════════
const runMediaCli = (args, env) => {
  try {
    const out = execFileSync(process.execPath, [path.join(ROOT, 'dist/cli/media.js'), ...args], {
      cwd: ROOT, encoding: 'utf8', env: { ...process.env, ...env },
    })
    return { code: 0, out }
  } catch (e) {
    return { code: e.status ?? 1, out: String(e.stdout ?? '') + String(e.stderr ?? '') }
  }
}
{
  const s = scenario('orphancli')
  putMedia(s.media, M1, 1, 100)
  putMedia(s.media, M2, 2, 200)
  // 库读得动、却一篇文章都没有 → 引用集为空；而媒体目录里有 2 个文件。
  const env = { DATABASE_PATH: triplet.db, MEDIA_DIR: s.media }
  const bare = runMediaCli([], env)
  check('前提：CLI 真的读出「引用 0 / 孤图 2」（否则下面两条是恒真的）', /引用的媒体：\*\*0\*\* 个/.test(bare.out) && /孤图：\*\*2\*\* 个/.test(bare.out), bare.out.split('\n').filter(Boolean).slice(0, 2).join(' | '))
  check('零引用 + 媒体非空 → **拒绝清理**（退出码非 0）', bare.code !== 0 && /拒绝清理/.test(bare.out))
  check('拒绝时**一个文件都没删**', listDir(s.media).length === 2, listDir(s.media).join(','))
  const forced = runMediaCli(['--force'], env)
  check('加 --force 后是**预演**（没加 --yes 仍不删）', forced.code === 0 && /预演/.test(forced.out), forced.out.split('\n').filter(Boolean).slice(-1)[0])
  check('预演时文件仍在', listDir(s.media).length === 2)
  const done = runMediaCli(['--force', '--yes'], env)
  check('--force --yes 才真删孤图', done.code === 0 && listDir(s.media).length === 0, listDir(s.media).join(','))
}
{
  // 第二条「不删」的路：读库失败时，**即使敲了 --force** 也不得进入删除分支。
  const s = scenario('orphanfail')
  putMedia(s.media, M1, 1, 100)
  const bogusDb = path.join(s.dir, 'not-a-db')
  fs.mkdirSync(bogusDb, { recursive: true })
  const r = runMediaCli(['--force', '--yes'], { DATABASE_PATH: bogusDb, MEDIA_DIR: s.media })
  check('读库失败 → 退出码非 0 且明说「一个文件都没删」', r.code !== 0 && /一个文件都没删/.test(r.out), r.out.split('\n').filter(Boolean).slice(-1)[0])
  check('读库失败时**即使带 --force** 也没删任何文件', listDir(s.media).length === 1, listDir(s.media).join(','))
}

// ════════════════════════════════════════════════════
console.log('\n[CLI：dist 下存在且可执行（校验 / 按日期恢复）]')
// ════════════════════════════════════════════════════
{
  const cli = path.join(ROOT, 'dist/cli/backup.js')
  const cliMedia = path.join(sandbox, 'cli-media')
  fs.mkdirSync(cliMedia, { recursive: true })
  putMedia(cliMedia, M1, 1, 321)
  const cliEnv = { ...process.env, DATABASE_PATH: SRC_DB, MEDIA_DIR: cliMedia, BACKUP_DIR: path.join(sandbox, 'cli-bk') }
  check('dist/cli/backup.js 存在（不在 scripts/ 下）', fs.existsSync(cli), cli)
  const out = execFileSync(process.execPath, [cli], { cwd: ROOT, encoding: 'utf8', env: cliEnv })
  check('CLI 能跑一次备份（并报出媒体张数）', /已备份/.test(out) && /媒体 1 张/.test(out), out.split('\n').filter(Boolean).pop() || '')
  const listOut = execFileSync(process.execPath, [cli, '--list'], { cwd: ROOT, encoding: 'utf8', env: cliEnv })
  check('CLI --list 列出备份并标出可用性与媒体张数', /✅/.test(listOut) && /媒体/.test(listOut), listOut.split('\n').filter(Boolean).pop() || '')
  const today = new Date().toISOString().slice(0, 10)
  const dateOut = execFileSync(process.execPath, [cli, '--verify', today], { cwd: ROOT, encoding: 'utf8', env: cliEnv })
  check('CLI --verify <date> 分开输出数据库判决与媒体判决', /数据库判决/.test(dateOut) && /媒体判决/.test(dateOut), dateOut.split('\n')[1] || '')
  const vOut = execFileSync(process.execPath, [cli, '--verify', path.join(sandbox, 'cli-bk', today + '.sqlite')], { cwd: ROOT, encoding: 'utf8', env: cliEnv })
  check('CLI --verify <file> 保留（仍给数据库判决）', /数据库判决/.test(vOut), vOut.split('\n')[1] || '')

  let rejected = false
  try {
    execFileSync(process.execPath, [cli, '--verify', path.join(sandbox, 'nope.sqlite')], { cwd: ROOT, encoding: 'utf8', env: cliEnv, stdio: 'pipe' })
  } catch { rejected = true }
  check('CLI --verify 拒绝不可用备份（退出码非 0）', rejected)

  let emptyRejected = false
  try {
    execFileSync(process.execPath, [cli, '--verify', path.join(sandbox, 'no-probes.sqlite')], { cwd: ROOT, encoding: 'utf8', env: cliEnv, stdio: 'pipe' })
  } catch { emptyRejected = true }
  check('CLI --verify 拒绝「没有 probes 表」的库（空库陷阱的护栏）', emptyRejected)

  const restoreOut = execFileSync(process.execPath, [cli, '--restore', today], { cwd: ROOT, encoding: 'utf8', env: cliEnv })
  check('CLI --restore <date> 能按日期整站恢复', /已从/.test(restoreOut), restoreOut.split('\n').filter(Boolean).slice(-2).join(' | '))

  let badRestore = false
  try {
    execFileSync(process.execPath, [cli, '--restore', '1999-01-01'], { cwd: ROOT, encoding: 'utf8', env: cliEnv, stdio: 'pipe' })
  } catch { badRestore = true }
  check('CLI --restore 拒绝没有那一天的备份', badRestore)
}

// ════════════════════════════════════════════════════
try { fs.rmSync(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }) } catch {}

console.log('\n' + '-'.repeat(60))
const failed = results.filter((r) => !r.ok)
if (!failed.length) console.log('✅ 全部通过：' + results.length + ' 项')
else {
  console.log('❌ ' + failed.length + ' 项失败 / 共 ' + results.length + ' 项')
  for (const f of failed) console.log('   - ' + f.name + '  ' + f.detail)
}
process.exit(failed.length ? 1 : 0)
