/**
 * 文章内容管线的断言：**Markdown → 文档 → HTML**，不过 HTTP、不碰库。
 *
 * 为什么单独一个脚本：本票（文章实现①a）交付的是三个纯模块（schema / 导入 / 发射器），
 * 它们的验收面是**结构等价**与**闭集**——这两件事在 HTTP e2e 层很难稳定复现
 * （e2e 得先有库和路由，而那是 ①b 的活）。
 *
 * 判据不许含糊，所以这里的写法是：
 * - **结构等价**不靠肉眼，靠**逐标签计数对比**：同一份源码分别过 markdown-it 与本文档管线，
 *   十类结构标签的出现次数必须**逐个相等**（`<p>` 除外 —— 表格单元格里的段落是文档模型的必然要求，见下）。
 * - **闭集**不靠「没看到 `<script>`」，靠 [ADR 0004] 的纪律：**先证明载荷以转义形态出现，再断言它不可执行**。
 *   （少了前一半，后一半是恒真的 —— 这正是本仓库吃过的那次亏。）
 *
 * 需要先构建：`npm run build && node scripts/article-pipeline-check.mjs`
 */
import fs from 'node:fs'
import path from 'node:path'
import matter from 'gray-matter'
import MarkdownIt from 'markdown-it'
import { articleSchema, docFromJson, docToJson, isSafeUrl } from '../dist/article-doc.js'
import { docToHtml } from '../dist/article-html.js'
import { markdownToDoc } from '../dist/article-import.js'

const root = path.resolve(import.meta.dirname, '..')

/** 与读面同参 —— 对比必须建立在同一套解析选项上。 */
const md = new MarkdownIt({ html: false, linkify: true, typographer: true })

let passed = 0
let failed = 0
const failures = []

function check(label, cond, detail = '') {
  if (cond) {
    passed += 1
    console.log(`  PASS  ${label}`)
  } else {
    failed += 1
    failures.push(label + (detail ? ` —— ${detail}` : ''))
    console.log(`  FAIL  ${label}${detail ? ` —— ${detail}` : ''}`)
  }
}

const count = (haystack, needle) => haystack.split(needle).length - 1

/** 结构标签：这些是「读者看到的东西还在不在」的可数证据。 */
const STRUCTURAL_TAGS = ['<table', '<thead', '<tbody', '<tr', '<th', '<td', '<pre', '<blockquote', '<ul', '<ol', '<li', '<h2', '<strong', '<em', '<hr']

const stripTags = (html) =>
  html
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()

// ─────────────────────────────────────────────────────────────
console.log('== 一、两篇真文章：结构等价 ==')

const contentDir = path.join(root, 'content')
const files = fs.readdirSync(contentDir).filter((f) => /\.(md|markdown)$/i.test(f)).sort()

check('content/ 下能找到真文章（否则下面的断言全是空的）', files.length > 0, `找到 ${files.length} 篇`)

for (const file of files) {
  const raw = fs.readFileSync(path.join(contentDir, file), 'utf8')
  const body = matter(raw).content.trim()
  const { doc, warnings } = markdownToDoc(body)
  const mine = docToHtml(doc)
  const theirs = md.render(body)

  console.log(`  --- ${file}`)
  check(`${file}：导入零警告`, warnings.length === 0, warnings.join(' | '))

  for (const tag of STRUCTURAL_TAGS) {
    const a = count(theirs, tag)
    const b = count(mine, tag)
    check(`${file}：${tag} 计数一致（${a}）`, a === b, `markdown-it=${a} 文档管线=${b}`)
  }

  const textA = stripTags(theirs)
  const textB = stripTags(mine)
  check(
    `${file}：纯文本内容一字不差`,
    textA === textB,
    textA === textB ? '' : `首处不同：…${textB.slice(Math.max(0, textB.indexOf(textA.slice(0, 20)) + 20), 60)}…`,
  )

  // JSON 往返必须稳定：存下去的与读出来的要是同一个东西
  const json1 = docToJson(doc)
  const json2 = docToJson(docFromJson(json1))
  check(`${file}：JSON 往返稳定`, JSON.stringify(json1) === JSON.stringify(json2))
}

// ─────────────────────────────────────────────────────────────
console.log('\n== 二、代码块语言标注（「存 JSON」比「存 HTML」多拿到的那样东西） ==')

const langDoc = markdownToDoc('```json\n{"a":1}\n```').doc
const langHtml = docToHtml(langDoc)
check('导入路径：语言标注进了文档', JSON.stringify(docToJson(langDoc)).includes('"language":"json"'))
check('渲染路径：语言标注出现在 class 上', langHtml.includes('class="language-json"'), langHtml)
check('渲染路径：代码内容被转义', langHtml.includes('{&quot;a&quot;:1}'), langHtml)

// ─────────────────────────────────────────────────────────────
console.log('\n== 三、闭集与转义（ADR 0004：先证明载荷出现，再断言不可执行） ==')

const PAYLOAD = '<script>alert(1)</script>'

// 3a. 走**导入路径**：源里的 HTML 必须变成文本
const fromMd = markdownToDoc(`正文里的 ${PAYLOAD} 长这样`).doc
const mdHtml = docToHtml(fromMd)
check('[导入] 载荷确实出现在输出里（转义形态）', mdHtml.includes('&lt;script&gt;alert(1)&lt;/script&gt;'), mdHtml.slice(0, 160))
check('[导入] 输出里没有可执行的 script 标签', !mdHtml.includes('<script'))

// 3b. 走**渲染路径**：直接构造一个带载荷的文档（模拟「编辑器交上来的 JSON」）
const para = articleSchema.nodes.paragraph.create(null, [articleSchema.text(PAYLOAD)])
const directDoc = articleSchema.nodes.doc.create(null, [para])
const directHtml = docToHtml(directDoc)
check('[渲染] 载荷确实出现在输出里（转义形态）', directHtml.includes('&lt;script&gt;'), directHtml)
check('[渲染] 输出里没有可执行的 script 标签', !directHtml.includes('<script'))

// 3c. `javascript:` 链接 —— **这是转义挡不住的一类**，必须由 isSafeUrl 拦
const linkCases = ['javascript:alert(1)', 'JAVASCRIPT:alert(1)', 'java\nscript:alert(1)', ' javascript:alert(1)']
for (const href of linkCases) {
  const linkPara = articleSchema.nodes.paragraph.create(null, [
    articleSchema.text('点我', [articleSchema.marks.link.create({ href })]),
  ])
  const html = docToHtml(articleSchema.nodes.doc.create(null, [linkPara]))
  check(`[渲染] 危险 href 被拦：${JSON.stringify(href)}`, !html.includes('<a ') && html.includes('点我'), html)
}
check('[工具] isSafeUrl 认正常地址', isSafeUrl('https://example.com/a?b=1') && isSafeUrl('/media/x.png') && isSafeUrl('mailto:a@b.c'))
check('[工具] isSafeUrl 挡危险协议', !isSafeUrl('javascript:x') && !isSafeUrl('data:text/html,x') && !isSafeUrl('vbscript:x') && !isSafeUrl(''))

// 3d. 图片 src
const imgPara = articleSchema.nodes.paragraph.create(null, [
  articleSchema.nodes.image.create({ src: 'javascript:alert(1)', alt: '图' }),
])
check('[渲染] 危险 src 的图片不被发射', !docToHtml(articleSchema.nodes.doc.create(null, [imgPara])).includes('<img'))

// ─────────────────────────────────────────────────────────────
console.log('\n== 四、坏输入必须响（不静默、不 500 —— 接住它是 ①b 的事） ==')

const throws = (fn) => {
  try {
    fn()
    return false
  } catch {
    return true
  }
}
check('不存在的节点类型 → 抛错', throws(() => docFromJson({ type: 'doc', content: [{ type: '不存在的节点' }] })))
check('不是对象 → 抛错', throws(() => docFromJson(123)))
check('空的 doc（内容模型要求 block+）→ 抛错', throws(() => docFromJson({ type: 'doc', content: [] })))
check('内容模型不合法（段落里塞块节点）→ 抛错', throws(() => docFromJson({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'paragraph' }] }] })))

// ─────────────────────────────────────────────────────────────
console.log('\n== 五、用户要的合并单元格与列宽：schema 真的能表达，渲染真的能出来 ==')

const cell = (type, attrs, text) =>
  articleSchema.nodes[type].create(attrs, [
    articleSchema.nodes.paragraph.create(null, [articleSchema.text(text)]),
  ])
const mergedTable = articleSchema.nodes.table.create(null, [
  articleSchema.nodes.tableRow.create(null, [
    cell('tableHeader', { colwidth: [120] }, 'A'),
    cell('tableHeader', {}, 'B'),
  ]),
  articleSchema.nodes.tableRow.create(null, [
    cell('tableCell', { colspan: 2, rowspan: 1 }, '合并两列'),
  ]),
])
const mergedHtml = docToHtml(articleSchema.nodes.doc.create(null, [mergedTable]))
check('合并单元格：colspan 出现', mergedHtml.includes('colspan="2"'), mergedHtml)
check('列宽：用 colgroup/col 表达（HTML 里唯一正确的位置）', mergedHtml.includes('<colgroup>') && mergedHtml.includes('<col style="width: 120px">'), mergedHtml)
check('列宽：没有退化成单元格上的 width', !mergedHtml.includes('<th style="width'), mergedHtml)

const rowspanHtml = docToHtml(
  articleSchema.nodes.doc.create(null, [
    articleSchema.nodes.table.create(null, [
      articleSchema.nodes.tableRow.create(null, [cell('tableHeader', { rowspan: 2 }, '竖向合并'), cell('tableHeader', {}, 'x')]),
      articleSchema.nodes.tableRow.create(null, [cell('tableCell', {}, 'y')]),
    ]),
  ]),
)
check('合并单元格：rowspan 出现', rowspanHtml.includes('rowspan="2"'), rowspanHtml)

// ─────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(60)}`)
if (failed === 0) {
  console.log(`✅ 全部通过：${passed} 项`)
} else {
  console.log(`❌ ${failed} 项失败 / 共 ${passed + failed} 项`)
  for (const f of failures) console.log(`   - ${f}`)
}
process.exit(failed === 0 ? 0 : 1)
