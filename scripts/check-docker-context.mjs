// 静态校验 Dockerfile 的构建上下文：模拟 .dockerignore 后再看 COPY 是否能拿到必需文件。
import fs from 'node:fs'
import path from 'node:path'

const ig = fs
  .readFileSync('.dockerignore', 'utf8')
  .split(/\r?\n/)
  .map((s) => s.trim())
  .filter((s) => s && !s.startsWith('#'))

const ignored = (p) =>
  ig.some((pat) => {
    if (pat.includes('*')) {
      const esc = pat.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
      return new RegExp('^' + esc + '$').test(p)
    }
    return p === pat || p.startsWith(pat + '/')
  })

const ctx = []
;(function walk(dir, base) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? base + '/' + e.name : e.name
    if (ignored(rel)) continue
    if (e.isDirectory()) walk(path.join(dir, e.name), rel)
    else ctx.push(rel)
  }
})('.', '')

console.log('  构建上下文文件数:', ctx.length)
console.log('  顶层条目:', [...new Set(ctx.map((c) => c.split('/')[0]))].sort().join('  '))

const need = ['package.json', 'package-lock.json', 'tsconfig.json', 'src/server.ts', 'public/style.css']
let bad = 0
for (const n of need) {
  const ok = ctx.includes(n)
  if (!ok) bad++
  console.log(`  必需 ${n.padEnd(20)} ${ok ? 'OK' : 'MISSING'}`)
}
const leak = ctx.some((c) => /^(node_modules|data|dist)\//.test(c) || c.startsWith('.git/'))
console.log('  未泄漏 node_modules/data/dist/.git:', leak ? 'FAIL' : 'OK')
process.exit(bad || leak ? 1 : 0)
