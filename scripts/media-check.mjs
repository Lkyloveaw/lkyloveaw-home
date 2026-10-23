/**
 * 媒体层的**纯函数断言**（规格 #41）：魔数嗅探 · 内容寻址 · 幂等 · 原子落盘 · 安全文件名。
 *
 * 为什么不并进 unit-check：它要写真实文件（临时目录），而 unit-check 是纯逻辑；
 * 也为什么不并进 e2e：这些**不需要 HTTP** —— 上传路由的断言在 e2e 里。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'

const root = path.resolve(import.meta.dirname, '..')
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-media-'))
process.env.MEDIA_DIR = sandbox
process.env.DATABASE_PATH = path.join(sandbox, 'identity.sqlite')

// ⚠ 必须在设好 MEDIA_DIR 之后 import：`config.ts` 在模块加载时读 env（本仓反复踩过的那个坑）。
const media = await import(pathToFileURL(path.join(root, 'dist/media.js')).href)

let passed = 0
const failures = []
const check = (name, ok, detail = '') => {
  if (ok) {
    passed++
    console.log(`  PASS  ${name}${detail ? '  ' + detail : ''}`)
  } else {
    failures.push(name)
    console.log(`  FAIL  ${name}${detail ? '  ' + detail : ''}`)
  }
}

// ── 魔数嗅探：只认内容，不认文件名 ──
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 7)])
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 7)])
const GIF = Buffer.concat([Buffer.from('GIF89a', 'latin1'), Buffer.alloc(64, 7)])
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(64, 7)])

console.log('\n[魔数嗅探（不看文件名）]')
check('PNG', media.sniffImage(PNG)?.ext === 'png' && media.sniffImage(PNG)?.mime === 'image/png')
check('JPEG', media.sniffImage(JPG)?.ext === 'jpg')
check('GIF89a', media.sniffImage(GIF)?.ext === 'gif')
check('WEBP（RIFF + WEBP 双标识）', media.sniffImage(WEBP)?.ext === 'webp')
check('**SVG → null**（能带脚本，一律拒绝）', media.sniffImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')) === null)
check('**HTML 改名成 .png → null**（只看内容）', media.sniffImage(Buffer.from('<html><body>hi</body></html>')) === null)
check('截断的 PNG（只有前 4 字节）→ null', media.sniffImage(Buffer.from([0x89, 0x50, 0x4e, 0x47])) === null)
check('空 buffer → null', media.sniffImage(Buffer.alloc(0)) === null)

// ── 落盘：内容寻址 · 幂等 · 原子 ──
console.log('\n[落盘]')
const first = media.saveMedia(PNG)
check('落盘成功且名字是 <64 位十六进制>.png', /^[0-9a-f]{64}\.png$/.test(first.name), first.name.slice(0, 20) + '…')
check('这次确实新建了文件', first.created === true)
check('文件真的在磁盘上', fs.existsSync(path.join(sandbox, first.name)))
check('落盘后**不留临时文件**（原子写清干净了）', fs.readdirSync(sandbox).every((f) => !f.startsWith('.tmp-')), fs.readdirSync(sandbox).join(','))

const again = media.saveMedia(PNG)
check('**同一张图再传一次：同一个名字、不新建**（幂等）', again.name === first.name && again.created === false)

const changed = media.saveMedia(Buffer.concat([PNG.subarray(0, 8), Buffer.from([9]), PNG.subarray(9)]))
check('**改一个字节就得到新名字**（浏览器缓存不会显示旧图）', changed.name !== first.name && changed.created === true)

check('超过 8 MiB → 抛', (() => {
  try { media.saveMedia(Buffer.concat([PNG, Buffer.alloc(8 * 1024 * 1024)])); return false } catch { return true }
})())
check('空文件 → 抛', (() => {
  try { media.saveMedia(Buffer.alloc(0)); return false } catch { return true }
})())
check('非图片（SVG 字节）→ 抛', (() => {
  try { media.saveMedia(Buffer.from('<svg/>')); return false } catch { return true }
})())

// ── 安全文件名：服务路由的第一道闸 ──
console.log('\n[安全文件名]')
const good = first.name
check('合法名 → true', media.isSafeMediaName(good) === true)
check('**`../` 穿越 → false**', media.isSafeMediaName('../' + good) === false)
check('**编码斜杠 → false**', media.isSafeMediaName('%2e%2e%2f' + good) === false)
check('非 64 位十六进制 → false', media.isSafeMediaName('abc.png') === false)
check('**`.svg` → false**（即使形状对）', media.isSafeMediaName('a'.repeat(64) + '.svg') === false)
check('别的扩展名（.html）→ false', media.isSafeMediaName('a'.repeat(64) + '.html') === false)
check('非字符串 → false', media.isSafeMediaName(null) === false && media.isSafeMediaName(42) === false)
check('`mediaPath` 对非法名**抛**（而不是拼出一个越界路径）', (() => {
  try { media.mediaPath('../etc/passwd'); return false } catch { return true }
})())

// ── 内容类型与目录列举 ──
console.log('\n[内容类型与列举]')
check('mediaMime：png/jpg/gif/webp 各自正确', [
  ['.png', 'image/png'], ['.jpg', 'image/jpeg'], ['.gif', 'image/gif'], ['.webp', 'image/webp'],
].every(([ext, mime]) => media.mediaMime('a'.repeat(64) + ext) === mime))
check('mediaMime：非法名 → null', media.mediaMime('x.svg') === null)
fs.writeFileSync(path.join(sandbox, '.tmp-orphan'), 'x')
fs.writeFileSync(path.join(sandbox, 'evil.txt'), 'x')
const listed = media.listMedia()
check('**列举只含合法媒体名**（临时文件与杂物不出现）', listed.length === 2 && listed.every((n) => media.isSafeMediaName(n)), listed.map((n) => n.slice(0, 8)).join(','))


// ── 引用提取与孤图判定（孤图清理 CLI 的纯逻辑） ──
console.log(String.fromCharCode(10)+"[引用提取与孤图判定]")
const doc = { type: "doc", content: [
  { type: "paragraph", content: [{ type: "text", text: "看这张" }] },
  { type: "image", attrs: { src: "/media/" + first.name, alt: "图" } },
  { type: "image", attrs: { src: "https://cdn.example.com/x.png", alt: "外链" } },
  { type: "image", attrs: { src: "data:image/png;base64,AAAA", alt: "内联" } },
  { type: "image", attrs: { src: "/media/not-a-hash.png", alt: "形状不合法" } },
] }
const refs = media.imageNamesInDoc(doc)
check("**嵌套的 image 节点被找到**", refs.length === 1 && refs[0] === first.name, refs.join(","))
check("外链与 data URI **不算引用**（只认站内 /media/）", !refs.some((r) => r.includes("cdn") || r.includes("data")))
check("形状不合法的 /media/ 名字**不算引用**", !refs.includes("not-a-hash.png"))
check("空文档 / 非对象 → 空数组（不抛）", media.imageNamesInDoc({}).length === 0 && media.imageNamesInDoc(null).length === 0)
const orphans = media.orphanMedia(refs)
check("**孤图 = 目录里有、引用里没有的那些**", orphans.length === 1 && orphans[0] === changed.name, orphans.map((o) => o.slice(0,8)).join(","))
check("被引用的那个**不是**孤图", !orphans.includes(first.name))
check("临时文件与杂物本来就不在 listMedia 里，所以也不会被当成孤图", !orphans.some((o) => o.startsWith(".tmp-") || o.endsWith(".txt")))

console.log('\n[身份图片：持久化、账号隔离与媒体清理]')
const identityUrl = pathToFileURL(path.join(root,'dist/identity-images.js')).href
const identities = await import(identityUrl)
check('未设置的头像默认无图片', identities.getIdentityImage('avatar:1') === null)
identities.setIdentityImage('avatar:1', first.name)
identities.setIdentityImage('avatar:2', changed.name)
identities.setIdentityImage('site-logo', first.name)
check('头像按用户隔离', identities.getIdentityImage('avatar:1') === first.name && identities.getIdentityImage('avatar:2') === changed.name)
check('网站徽标独立保存', identities.getIdentityImage('site-logo') === first.name)
const restart = execFileSync(process.execPath,['--input-type=module','-e',
  `import {getIdentityImage} from ${JSON.stringify(identityUrl)}; console.log(JSON.stringify([getIdentityImage('avatar:1'),getIdentityImage('site-logo')]));`
],{env:process.env,encoding:'utf8'})
check('重启后的进程仍能读取头像与徽标', restart.includes(JSON.stringify([first.name,first.name])))
check('非法媒体路径拒绝且不改旧值', (()=>{try{identities.setIdentityImage('avatar:1','../x.png');return false}catch{return identities.getIdentityImage('avatar:1')===first.name}})())
const unreferenced = media.saveMedia(Buffer.concat([PNG,Buffer.from('identity-orphan')]))
execFileSync(process.execPath,[path.join(root,'dist/cli/media.js'),'--yes','--force'],{env:process.env,stdio:'pipe'})
check('强制清理仍保留头像和徽标引用', fs.existsSync(path.join(sandbox,first.name)) && fs.existsSync(path.join(sandbox,changed.name)))
check('同次清理删掉未引用图片', !fs.existsSync(path.join(sandbox,unreferenced.name)))
identities.setIdentityImage('avatar:1',null)
check('恢复默认只解除当前用户引用', identities.getIdentityImage('avatar:1')===null && identities.getIdentityImage('avatar:2')===changed.name && identities.getIdentityImage('site-logo')===first.name)
identities.setIdentityImage('site-logo',null)
check('恢复默认徽标不会删除文件', identities.getIdentityImage('site-logo')===null && fs.existsSync(path.join(sandbox,first.name)))
const { closeStore } = await import(pathToFileURL(path.join(root,'dist/store.js')).href)
closeStore()
fs.rmSync(sandbox, { recursive: true, force: true })
console.log(`\n${passed}/${passed + failures.length} 通过`)
if (failures.length) {
  for (const f of failures) console.log('  - ' + f)
  process.exit(1)
}
