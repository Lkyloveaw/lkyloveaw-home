/**
 * 实现④的断言：入口校验 + checkpoint + 备份。
 *
 * ⚠ 所有依赖配置的场景都在**子进程**里跑：`config` 在模块 import 时就把环境变量读成了常量，
 * 同一进程里后续改 `process.env` 是无效的（ESM 模块还会缓存）。第一版就是栽在这上面。
 *
 * 这一套里几条**防「静默降级」**的断言比功能断言更重要：
 * - checkpoint 的 `busy` 会骗人（实测 `busy:0` 却只搬了 2/33 页）；
 * - 「只拷 .sqlite」的副本**打得开、但没有 probes 表**——所以「文件非空」不足以判可用。
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
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`)
}

/** 在子进程里跑一段脚本，脚本把结果写进 `R` 并打印 `__R__<json>`。 */
function child(name, body, env = {}) {
  const file = path.join(sandbox, `${name}.mjs`)
  fs.writeFileSync(file, `const R = {};\n${body}\nconsole.log('__R__' + JSON.stringify(R));\n`, 'utf8')
  const out = execFileSync(process.execPath, [file], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 1 << 24,
    env: { ...process.env, ...env },
  })
  const line = out.split('\n').filter((l) => l.startsWith('__R__')).pop()
  if (!line) throw new Error(`${name}: 子进程没有输出 __R__\n${out}`)
  return JSON.parse(line.slice(5))
}

const P = (p) => JSON.stringify(p)
const SRC_DB = path.join(sandbox, 'src.sqlite')
const PRELUDE = `
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
const SRC_DB = ${P(SRC_DB)};
/** 造一个「数据还在 WAL 里」的库：必须**保持连接打开**，因为正常 close 会触发 checkpoint。 */
function makeWalDb(file, rows) {
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('wal_autocheckpoint = 0');
  db.exec('CREATE TABLE IF NOT EXISTS probes (id INTEGER PRIMARY KEY AUTOINCREMENT, target_id TEXT, at INTEGER, status TEXT, latency_ms INTEGER, status_code INTEGER, error TEXT, round_at INTEGER)');
  const st = db.prepare('INSERT INTO probes (target_id, at, round_at, status, latency_ms, status_code, error) VALUES (?,?,?,?,?,?,?)');
  const tx = db.transaction(function () { for (let i = 0; i < rows; i++) st.run('t1', Date.now() - i * 1000, Date.now(), 'up', 12, 200, null); });
  tx();
  return db;
}
function countRows(file) {
  const d = new Database(file, { readonly: true });
  const n = d.prepare('SELECT COUNT(*) AS n FROM probes').get().n;
  d.close();
  return n;
}
`

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
  const r = child('validate', `
process.env.TARGETS_JSON = ${P(JSON.stringify(list))};
process.env.DATABASE_PATH = ${P(path.join(sandbox, 'cfg.sqlite'))};
const m = await import(${P(url('dist/config.js'))});
R.kept = m.config.targets.map(function (t) { return t.id; });
`)
  REJECT.forEach(([label], i) => check(`拒绝：${label}`, !r.kept.includes('r' + i)))
  ALLOW.forEach(([label], i) => check(`放行：${label}`, r.kept.includes('a' + i)))
  check(`校验器 ${REJECT.length + ALLOW.length} 用例（拒 ${REJECT.length} / 放行 ${ALLOW.length}）`, true)
}

// ════════════════════════════════════════════════════
console.log('\n[空库陷阱：只拷 .sqlite 的副本不能用]')
// ════════════════════════════════════════════════════
{
  const r = child('naive', `${PRELUDE}
  // 连接**保持打开**——正常 close 会 checkpoint，那样就模拟不出真实场景了。
  const db = makeWalDb(SRC_DB, 3000);
  R.walBytes = fs.statSync(SRC_DB + '-wal').size;
  const copy = ${P(path.join(sandbox, 'naive.sqlite'))};
  fs.copyFileSync(SRC_DB, copy);
  try {
    R.copyRows = countRows(copy);
    R.copyOpened = true;
  } catch (e) {
    R.copyOpened = false;
    R.copyErr = e.message;
  }
  db.close();
  `)
  check('探测前 WAL 里确实有内容（前提成立）', r.walBytes > 0, `wal=${r.walBytes}B`)
  check(
    '只拷 .sqlite 的副本**打不开 probes 表**（这就是那个陷阱）',
    r.copyOpened === false,
    r.copyOpened ? `竟然打开且有 ${r.copyRows} 行` : r.copyErr,
  )
}

// ════════════════════════════════════════════════════
console.log('\n[checkpoint：TRUNCATE 真搬且截断]')
// ════════════════════════════════════════════════════
{
  const r = child('cp', `${PRELUDE}
  const db = makeWalDb(SRC_DB, 3000);
  R.walBefore = fs.statSync(SRC_DB + '-wal').size;
  R.mainBefore = fs.statSync(SRC_DB).size;
  db.close();

  // 重新造 WAL 内容（close 会 checkpoint，所以再写一轮并保持打开）
  const db2 = new Database(SRC_DB);
  db2.pragma('journal_mode = WAL');
  db2.pragma('wal_autocheckpoint = 0');
  const st = db2.prepare('INSERT INTO probes (target_id, at, round_at, status, latency_ms, status_code, error) VALUES (?,?,?,?,?,?,?)');
  for (let i = 0; i < 2000; i++) st.run('t2', Date.now(), Date.now(), 'up', 9, 200, null);
  R.walMid = fs.statSync(SRC_DB + '-wal').size;
  // 另开一个连接做 checkpoint（与服务运行时的形态一致：库被别的连接持有）
  const s = await import(${P(url('dist/store.js'))});
  process.env.DATABASE_PATH = SRC_DB;
  `, { DATABASE_PATH: SRC_DB })
  check('checkpoint 前 WAL 有内容（前提成立）', r.walMid > 0, `wal=${r.walMid}B`)
}
{
  // checkpoint 单独一个子进程，避免上面的连接干扰
  const r = child('cp2', `${PRELUDE}
  const db = makeWalDb(SRC_DB, 2000);
  R.walBefore = fs.statSync(SRC_DB + '-wal').size;
  R.mainBefore = fs.statSync(SRC_DB).size;
  const s = await import(${P(url('dist/store.js'))});
  s.initStore();
  const cp = s.checkpoint('TRUNCATE');
  R.busy = cp.busy;
  R.pages = cp.pages;
  R.walAfter = fs.existsSync(SRC_DB + '-wal') ? fs.statSync(SRC_DB + '-wal').size : 0;
  R.mainAfter = fs.statSync(SRC_DB).size;
  s.closeStore();
  db.close();
  `, { DATABASE_PATH: SRC_DB, BACKUP_DIR: path.join(sandbox, 'bk0') })
  check('checkpoint 返回 busy === 0（无并发干扰）', r.busy === 0, `busy=${r.busy}`)
  check('TRUNCATE 后 WAL 归 0（截断才是「只拷 .sqlite」能成功的前提）', r.walAfter === 0, `wal=${r.walAfter}B`)
  check('主库变大（内容真的搬回来了）', r.mainAfter > r.mainBefore, `${r.mainBefore} → ${r.mainAfter}`)
}

// ════════════════════════════════════════════════════
console.log('\n[并发时 checkpoint 不谎报成功]')
// ════════════════════════════════════════════════════
{
  const r = child('cp3', `${PRELUDE}
  // 连接甲：持有读事务不放
  const a = new Database(SRC_DB);
  a.pragma('journal_mode = WAL');
  a.pragma('wal_autocheckpoint = 0');
  const st = a.prepare('INSERT INTO probes (target_id, at, round_at, status, latency_ms, status_code, error) VALUES (?,?,?,?,?,?,?)');
  for (let i = 0; i < 2000; i++) st.run('t3', Date.now(), Date.now(), 'up', 9, 200, null);
  a.exec('BEGIN');
  a.prepare('SELECT COUNT(*) AS n FROM probes').get();   // 建立读事务，卡片住 WAL

  // 连接乙：跑 checkpoint
  const b = new Database(SRC_DB);
  const row = b.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
  R.busy = row.busy;
  R.pages = row.checkpointed;
  R.walSize = fs.existsSync(SRC_DB + '-wal') ? fs.statSync(SRC_DB + '-wal').size : 0;
  R.mainRows = (function () { try { return countRows(SRC_DB) } catch (e) { return null } })();
  a.exec('ROLLBACK');
  a.close(); b.close();
  `, { DATABASE_PATH: SRC_DB })
  check(
    '并发下 checkpoint 报 busy !== 0（**不谎报成功**）',
    r.busy !== 0,
    `busy=${r.busy} pages=${r.pages} wal=${r.walSize}B`,
  )
  check('并发下 WAL 未被截断（busy 非 0 的后果可观测）', r.walSize > 0, `wal=${r.walSize}B`)
}

// ════════════════════════════════════════════════════
console.log('\n[备份：产物可用，而不只是文件存在]')
// ════════════════════════════════════════════════════
const BK = path.join(sandbox, 'bk')
{
  const r = child('backup1', `${PRELUDE}
  const b = await import(${P(url('dist/backup.js'))});
  const s = await import(${P(url('dist/store.js'))});
  s.initStore();
  const res = await b.runBackup();
  R.first = { ok: res.ok, rows: res.rows, bytes: res.bytes, note: res.note, file: res.file };
  R.verify = b.verifyBackup(res.file);
  R.second = await b.runBackup();
  // 没有 probes 表的库必须被拒（防「把空库盖到好库上」）
  const empty = ${P(path.join(sandbox, 'no-probes.sqlite'))};
  const d = new (await import('better-sqlite3')).default(empty);
  d.exec('CREATE TABLE other (x INTEGER)'); d.close();
  R.emptyVerify = b.verifyBackup(empty);
  R.missingVerify = b.verifyBackup(${P(path.join(sandbox, 'nope.sqlite'))});
  s.closeStore();
  `, { DATABASE_PATH: SRC_DB, BACKUP_DIR: BK, BACKUP_KEEP: '7' })
  check('备份成功', r.first.ok, r.first.note || '')
  check('产物有实际大小', r.first.bytes > 0, `${r.first.bytes}B`)
  check('verifyBackup 认可该产物', r.verify.ok && r.verify.rows > 0, `${r.verify.rows} 行`)
  check('同一天重复跑会跳过（不覆盖、不堆积）', r.second.ok && /跳过/.test(r.second.note || ''), r.second.note || '')
  check('verifyBackup **拒绝**没有 probes 表的库', !r.emptyVerify.ok, r.emptyVerify.note || '')
  check('verifyBackup 拒绝不存在的文件', !r.missingVerify.ok)
}

console.log('\n[备份目录不留孤儿文件，且产物是自包含单文件]')
{
  const r = child('orphan', `${PRELUDE}
  const fs2 = await import('node:fs');
  const b = await import(${P(url('dist/backup.js'))});
  R.files = fs2.readdirSync(${P(BK)});
  // 关键：产物切到 journal_mode=DELETE 后，**只读打开它也不该再长出 -wal/-shm**
  const target = ${P(BK)} + '/' + R.files.filter(function (f) { return /^\\d{4}-\\d{2}-\\d{2}\\.sqlite$/.test(f) })[0];
  b.verifyBackup(target);
  R.afterVerify = fs2.readdirSync(${P(BK)});
  // 而且单独拷走它就该能用（这正是「cp 备份」这个习惯动作的安全性）
  const naive = ${P(path.join(sandbox, 'naive-backup-copy.sqlite'))};
  fs2.copyFileSync(target, naive);
  R.naiveCopyRows = countRows(naive);
  R.naiveCopyOk = true;
  `, { DATABASE_PATH: SRC_DB, BACKUP_DIR: BK })
  const orphans = r.files.filter((f) => /\.tmp(-wal|-shm)?$/.test(f))
  check('没有 .tmp / .tmp-wal / .tmp-shm 孤儿', orphans.length === 0, `剩 ${orphans.join(',')}`)
  check('备份目录只有按日期命名的 .sqlite', r.files.every((f) => /^\d{4}-\d{2}-\d{2}\.sqlite$/.test(f)), r.files.join(','))
  check(
    '**只读校验也不会再长出 -wal/-shm**（产物是自包含单文件）',
    r.afterVerify.every((f) => /^\d{4}-\d{2}-\d{2}\.sqlite$/.test(f)),
    r.afterVerify.join(','),
  )
  check(
    '**单独 cp 备份产物就能用**（不踩空库陷阱）——这是给运维习惯动作的护栏',
    r.naiveCopyOk === true && r.naiveCopyRows > 0,
    `${r.naiveCopyRows} 行`,
  )
}

// ════════════════════════════════════════════════════
console.log('\n[滚动保留：只留最近 N 份且是最新的]')
// ════════════════════════════════════════════════════
{
  const rollDir = path.join(sandbox, 'roll')
  fs.mkdirSync(rollDir, { recursive: true })
  // 用一份真实可用的备份当模板，复制成 10 个不同日期
  const template = fs.readdirSync(BK).find((f) => f.endsWith('.sqlite'))
  for (let i = 1; i <= 10; i++) {
    fs.copyFileSync(path.join(BK, template), path.join(rollDir, `2026-01-${String(i).padStart(2, '0')}.sqlite`))
  }
  const r = child('roll', `
  const b = await import(${P(url('dist/backup.js'))});
  R.before = b.listBackups();
  R.removed = b.pruneBackups(3);
  R.after = b.listBackups();
  `, { DATABASE_PATH: SRC_DB, BACKUP_DIR: rollDir, BACKUP_KEEP: '3' })
  check('造了 10 份备份', r.before.length === 10, String(r.before.length))
  check('清理后只剩 3 份', r.after.length === 3, r.after.join(','))
  check(
    '留下的是**最新**的 3 份',
    JSON.stringify(r.after) === JSON.stringify(['2026-01-08.sqlite', '2026-01-09.sqlite', '2026-01-10.sqlite']),
    r.after.join(','),
  )
  check('删掉的是最旧的 7 份', r.removed.length === 7 && r.removed[0] === '2026-01-01.sqlite', r.removed.join(','))
}

// ════════════════════════════════════════════════════
console.log('\n[恢复：残留 WAL 会坏事（证明「必须一起移走」不多余）]')
// ════════════════════════════════════════════════════
{
  const r = child('walcase', `${PRELUDE}
  const dir = ${P(path.join(sandbox, 'walcase'))};
  fs.mkdirSync(dir, { recursive: true });
  const good = path.join(dir, 'good.sqlite');
  // 干净的主库：只有 1 行，WAL 已归并
  const g = makeWalDb(good, 1);
  g.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
  g.close();
  R.goodRows = countRows(good);

  // 另一个库留下一个有内容的 WAL
  const other = path.join(dir, 'other.sqlite');
  const o = makeWalDb(other, 80);
  R.otherWalSize = fs.existsSync(other + '-wal') ? fs.statSync(other + '-wal').size : 0;
  // 保持打开，WAL 才有内容
  const victim = path.join(dir, 'victim.sqlite');
  fs.copyFileSync(good, victim);
  fs.copyFileSync(other + '-wal', victim + '-wal');
  try {
    R.victimRows = countRows(victim);
    R.victimOpened = true;
  } catch (e) {
    R.victimOpened = false;
    R.victimErr = e.message;
  }
  o.close();
  `)
  check('干净主库只有 1 行（前提成立）', r.goodRows === 1, `${r.goodRows} 行`)
  check('造出了有内容的 WAL（前提成立）', r.otherWalSize > 0, `${r.otherWalSize}B`)
  const broken = r.victimOpened === false || r.victimRows !== 1
  check(
    '残留 WAL 让恢复结果错乱或打不开（所以必须一起移走）',
    broken,
    r.victimOpened === false ? `打不开：${r.victimErr}` : `读到 ${r.victimRows} 行（另一库的数据被应用）`,
  )
}

// ════════════════════════════════════════════════════
console.log('\n[备份失败不拖垮探测]')
// ════════════════════════════════════════════════════
{
  const blocker = path.join(sandbox, 'blocker')
  fs.writeFileSync(blocker, 'not a dir')
  const r = child('failbackup', `${PRELUDE}
  const b = await import(${P(url('dist/backup.js'))});
  const s = await import(${P(url('dist/store.js'))});
  s.initStore();
  const res = await b.runBackup();
  R.ok = res.ok; R.note = res.note;
  s.closeStore();
  `, { DATABASE_PATH: SRC_DB, BACKUP_DIR: path.join(blocker, 'sub') })
  check('不可写的备份目录 → ok:false 且**不抛**（探测循环能继续）', r.ok === false, r.note || '')
}

// ════════════════════════════════════════════════════
console.log('\n[CLI：dist 下存在且可执行]')
// ════════════════════════════════════════════════════
{
  const cli = path.join(ROOT, 'dist/cli/backup.js')
  const cliEnv = { ...process.env, DATABASE_PATH: SRC_DB, BACKUP_DIR: path.join(sandbox, 'cli-bk') }
  check('dist/cli/backup.js 存在（不在 scripts/ 下）', fs.existsSync(cli), cli)
  const out = execFileSync(process.execPath, [cli], { cwd: ROOT, encoding: 'utf8', env: cliEnv })
  check('CLI 能跑一次备份', /已备份/.test(out), out.split('\n').filter(Boolean).pop() || '')
  const listOut = execFileSync(process.execPath, [cli, '--list'], { cwd: ROOT, encoding: 'utf8', env: cliEnv })
  check('CLI --list 列出备份并标出可用性', /✅/.test(listOut), listOut.split('\n').filter(Boolean).pop() || '')
  const today = new Date().toISOString().slice(0, 10) + '.sqlite'
  const vOut = execFileSync(process.execPath, [cli, '--verify', path.join(sandbox, 'cli-bk', today)], { cwd: ROOT, encoding: 'utf8', env: cliEnv })
  check('CLI --verify 认可可用备份', /✅ 备份可用/.test(vOut), vOut.split('\n')[0])

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
}

// ════════════════════════════════════════════════════
try { fs.rmSync(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }) } catch {}

console.log(`\n${'─'.repeat(60)}`)
const failed = results.filter((r) => !r.ok)
if (!failed.length) console.log(`✅ 全部通过：${results.length} 项`)
else {
  console.log(`❌ ${failed.length} 项失败 / 共 ${results.length} 项`)
  for (const f of failed) console.log(`   - ${f.name}  ${f.detail}`)
}
process.exit(failed.length ? 1 : 0)
