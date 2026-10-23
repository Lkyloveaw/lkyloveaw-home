/**
 * 编辑面的断言（#57 / ADR 0006）。
 *
 * 它回答三件事，三件都属于「不做就会静默坏掉」的形状：
 * 1. 打包产物在、且没过期 —— ADR 0006 点名的「产物没构建」类问题（跑 npm run build 修）；
 * 2. 闸门放行了它 —— 精确路径白名单漏加的现象是「编辑器不出来」而不是报错；
 * 3. 编辑器的 schema 与读面 schema 对齐 —— 两边对不上时保存会 400（或更糟：存进库的东西读面不认识）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { editorBuildOptions, EDITOR_OUT, EDITOR_ENTRY } from './build-editor.mjs'

const ROOT = process.cwd()
let passed = 0
const failures = []
const check = (name, ok, detail = '') => {
  if (ok) {
    passed++
    console.log('  PASS  ' + name + (detail ? '  ' + detail : ''))
  } else {
    failures.push(name + (detail ? '  ' + detail : ''))
    console.log('  FAIL  ' + name + (detail ? '  ' + detail : ''))
  }
}
const url = (rel) => pathToFileURL(path.join(ROOT, rel)).href

console.log('\n[打包产物：在、非空、没过期]')
const outAbs = path.join(ROOT, EDITOR_OUT)
const exists = fs.existsSync(outAbs)
check('产物存在（' + EDITOR_OUT + '）', exists)
const shipped = exists ? fs.readFileSync(outAbs) : Buffer.alloc(0)
check('产物非空（> 100 KiB）', shipped.length > 100 * 1024, String(shipped.length) + ' B')
const text = shipped.toString('utf8')
check('产物里有 ProseMirror 标记（真的是编辑器，不是空壳）', text.includes('ProseMirror'))

if (exists) {
  const tmpDir = fs.mkdtempSync(path.join(ROOT, '.editor-check-'))
  const tmpOut = path.join(tmpDir, 'article-editor.js')
  try {
    await build({ ...editorBuildOptions, outfile: tmpOut })
    const fresh = fs.readFileSync(tmpOut)
    check('产物与源码同步（重打一份逐字节相同）', fresh.equals(shipped), 'npm run build 可以修复')
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
}

console.log('\n[闸门：精确路径白名单]')
const auth = await import(url('dist/auth.js'))
check('/article-editor.js 在 PUBLIC_PATHS 里', auth.PUBLIC_PATHS.has('/article-editor.js'))

console.log('\n[views ↔ 客户端的契约]')
const views = fs.readFileSync(path.join(ROOT, 'src/views.ts'), 'utf8')
check('编辑页有 hidden 的 body_json（文档 JSON 的载体）', views.includes('name="body_json"'))
check('编辑页有编辑器挂载点 #article-editor', views.includes('id="article-editor"'))
check('编辑页引用了打包产物', views.includes('src="/article-editor.js"'))
check('禁 JS 时给说明而不是空表单（noscript）', views.includes('<noscript>'))

console.log('\n[schema 对齐：编辑器扩展集 ↔ 服务端 articleSchema]')
const bundled = await build({
  entryPoints: [path.join(ROOT, 'src/editor/editor-extensions.ts')],
  bundle: true,
  format: 'esm',
  platform: 'node',
  write: false,
  logLevel: 'silent',
})
const code = bundled.outputFiles[0].text
const mod = await import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'))
const { getSchema } = await import('@tiptap/core')
const client = getSchema(mod.editorExtensions)
const { articleSchema } = await import(url('dist/article-doc.js'))

const names = (o) => Object.keys(o).sort()
check(
  '节点集合一致',
  JSON.stringify(names(client.nodes)) === JSON.stringify(names(articleSchema.nodes)),
  'client=' + names(client.nodes).join(',') + ' server=' + names(articleSchema.nodes).join(','),
)
check(
  '标记集合一致',
  JSON.stringify(names(client.marks)) === JSON.stringify(names(articleSchema.marks)),
  'client=' + names(client.marks).join(',') + ' server=' + names(articleSchema.marks).join(','),
)

for (const n of Object.keys(articleSchema.nodes)) {
  const want = Object.keys(articleSchema.nodes[n].spec.attrs ?? {})
  const have = new Set(Object.keys(client.nodes[n]?.spec.attrs ?? {}))
  const missing = want.filter((a) => !have.has(a))
  check('节点 ' + n + ' 的属性编辑器都能产出' + (want.length ? '（' + want.join(',') + '）' : ''), missing.length === 0, '缺：' + missing.join(','))
}
for (const m of Object.keys(articleSchema.marks)) {
  const want = Object.keys(articleSchema.marks[m].spec.attrs ?? {})
  const have = new Set(Object.keys(client.marks[m]?.spec.attrs ?? {}))
  const missing = want.filter((a) => !have.has(a))
  check('标记 ' + m + ' 的属性编辑器都能产出' + (want.length ? '（' + want.join(',') + '）' : ''), missing.length === 0, '缺：' + missing.join(','))
}
check('编辑器没有 HTML 节点（schema 闭集的安全属性）', client.nodes.html === undefined && client.nodes.raw === undefined)

console.log('\n[服务端归一化：客户端多出来的属性会被丢掉，不会进库]')
const { docFromJson } = await import(url('dist/article-doc.js'))
const noisy = {
  type: 'doc',
  content: [
    {
      type: 'paragraph',
      content: [
        { type: 'text', marks: [{ type: 'link', attrs: { href: 'https://x.test', target: '_blank', rel: 'noopener', class: 'x' } }], text: 'x' },
      ],
    },
    { type: 'paragraph', content: [{ type: 'image', attrs: { src: '/media/' + 'a'.repeat(64) + '.png', alt: '图', width: 100, height: 50 } }] },
  ],
}
try {
  const normalized = docFromJson(noisy)
  const out = JSON.stringify(normalized.toJSON())
  check('link 的 target/rel/class 被丢掉', !out.includes('target') && !out.includes('noopener') && !out.includes('class'))
  check('image 的 width/height 被丢掉', !out.includes('width') && !out.includes('height'))
  check('href 与 src 保留', out.includes('https://x.test') && out.includes('/media/' + 'a'.repeat(64) + '.png'))
} catch (err) {
  check('服务端接受 TipTap 形状的文档（多出的属性不该让它 400）', false, err.message)
}

console.log('\n[工具栏：六个功能组（#79）]')
const editorSrc = fs.readFileSync(path.join(ROOT, 'src/editor/article-editor.ts'), 'utf8')
const GROUP_LABELS = ['文本', '块', '列表', '插入', '表格', '历史']
const BUTTON_LABELS = ['B', 'I', '<>', '链接', 'H2', 'H3', '引用', '代码块', '分隔线', '• 列表', '1. 列表', '图片', '表格', '合并', '拆分', '列宽', '+行', '−行', '+列', '−列', '撤销', '重做']
const groupBody = (label) => {
  const start = editorSrc.indexOf(`group('${label}'`)
  if (start < 0) return ''
  const next = editorSrc.indexOf("group('", start + 1)
  return editorSrc.slice(start, next < 0 ? undefined : next)
}
// 产物带 `charset: ascii` 的 esbuild 会把中文写成 \uXXXX，先解回来再比对。
const decoded = text.replace(/\\u([0-9a-f]{4})/gi, (_m, h) => String.fromCharCode(parseInt(h, 16)))
check('源码按 6 个功能组生成工具栏', GROUP_LABELS.every((g) => groupBody(g).length > 0))
check(
  '组容器带 role="group" 与可见组标签（组标签不是只在 CSS 里）',
  editorSrc.includes("className = 'editor-toolbar-group'") &&
    editorSrc.includes("setAttribute('role', 'group')") &&
    editorSrc.includes("className = 'editor-toolbar-label'"),
)
const sourceButtons = (editorSrc.match(/title: '/g) ?? []).length
check('22 个按钮一个不少（源码按 title 计数）', sourceButtons === 22, String(sourceButtons) + ' 个')
check(
  '表格组把「插入」与七种单元格操作收在一处（不再散落）',
  ['表格', '合并', '拆分', '列宽', '+行', '−行', '+列', '−列'].every((l) => groupBody('表格').includes(`label: '${l}'`)),
)
check(
  '历史组只有撤销 / 重做',
  ['撤销', '重做'].every((l) => groupBody('历史').includes(`label: '${l}'`)) && (groupBody('历史').match(/label: '/g) ?? []).length === 2,
)
check('产物里 6 个组标签都在（含转义写法）', GROUP_LABELS.every((g) => decoded.includes(g)))
check('产物里 22 个按钮标签都在', BUTTON_LABELS.every((l) => decoded.includes(l)))
check(
  '产物里组容器带 role="group" 与两个新类名',
  decoded.includes('editor-toolbar-group') && decoded.includes('editor-toolbar-label') && /setAttribute\("role","group"\)/.test(decoded),
)

console.log('\n' + '-'.repeat(60))
if (failures.length) {
  console.log('❌ ' + failures.length + ' 项失败 / 共 ' + (passed + failures.length) + ' 项')
  for (const f of failures) console.log('   - ' + f)
  process.exit(1)
}
console.log('✅ 全部通过：' + passed + ' 项')
