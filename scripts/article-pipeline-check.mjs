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

// ⚠ **沙箱必须在任何「会加载 `config.ts`」的 import 之前设好。**
// `config.ts` 在**模块加载时**就把 env 读成常量，而 ESM 的模块缓存意味着**第一次加载之后就改不动了**：
// 一旦某个 import 先把 config 拉进来，之后再设 `DATABASE_PATH` 是无效的。
//
// 这个坑我在这份文件里**真的踩过一次**：第六节的 `import('../dist/content.js')` 先把 config 定在了真库上，
// 第七节才设沙箱 —— 于是对象规则的夹具**写进了 `data/availability.sqlite`**（还留了一条修订行，事后手工清掉）。
// 所以：沙箱在这里就建，而且**整份脚本自始至终不碰真库**。
const sandbox = fs.mkdtempSync(path.join(root, '.article-check-sandbox-'))
process.env.DATABASE_PATH = path.join(sandbox, 'check.sqlite')

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
console.log('\n== 六、出口纪律（规格 #48 的出口表） ==')

// 规格把出口**按读者命名**，理由写得很直白：「名字本身在说我是给谁看的，diff 时能一眼审出泄漏」。
// 断言能钉住的只有名字这一半（行为那一半在 e2e 的草稿断言里，那里带对照组）；
// 但名字这一半恰好是最容易在重构里悄悄退回去的 —— 所以值得钉。
const contentModule = await import('../dist/content.js')
check('读面出口用的是规格里的名字（listPublishedPosts）', typeof contentModule.listPublishedPosts === 'function')
check('读面出口用的是规格里的名字（getPublishedPost）', typeof contentModule.getPublishedPost === 'function')
check('含糊的旧名字没有回来（listPosts / getPost）', !('listPosts' in contentModule) && !('getPost' in contentModule), Object.keys(contentModule).join(','))
check(
  '内容层没有导出「不过滤」的读取口（那会绕开出口纪律）',
  !Object.keys(contentModule).some((k) => /^(peek|listAll|getAny)/.test(k)),
  Object.keys(contentModule).join(','),
)

// ─────────────────────────────────────────────────────────────
console.log('\n== 七、对象规则（规格 #48 的 slug / 标签 / 上限） ==')

// ⚠ 这里**不再**建沙箱：沙箱与 `DATABASE_PATH` 已经在文件顶部设好，
// 因为必须早于任何会加载 `config.ts` 的 import（详见那里的注释 —— 这是踩过的坑，不是理论）。
const rules = await import('../dist/article-rules.js')
const store = await import('../dist/store.js')

// slug 形状
check('slug：中文可以', rules.validateSlug('运维笔记').ok)
check('slug：字母数字连字符下划线可以', rules.validateSlug('a-B_9').ok)
check('slug：空 → 拒', !rules.validateSlug('   ').ok)
check('slug：带空格 → 拒', !rules.validateSlug('有 空格').ok)
check('slug：带斜杠 → 拒', !rules.validateSlug('a/b').ok)
check('slug：正好 64 个 → 过', rules.validateSlug('啊'.repeat(64)).ok)
check('slug：65 个 → 拒（按**码位**算，不是 UTF-16 单元）', !rules.validateSlug('啊'.repeat(65)).ok)

// 唯一性：跨草稿与回收站（规格的 unit 接缝里点名的一条）
// ⚠ 用 `initStore()` **返回的那个连接**改行，不要再开第二个连接：
// 实测第二个连接看不到这里刚建的表（同名文件、同一路径，但看到的是空库）——
// 与其猜是 WAL 还是路径的问题，不如就用同一个连接，顺便少一个可能出错的环节。
const db = store.initStore()
const baseArticle = (slug, draft) => ({
  slug,
  title: `标题-${slug}`,
  body: JSON.stringify({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '正文' }] }] }),
  summary: null,
  date: '2026-01-01',
  tags: '[]',
  draft,
  now: Date.now(),
})
store.upsertArticleWithRevision(baseArticle('occupied', 1))
const asDraft = rules.checkSlugAvailable('occupied')
check('唯一性：草稿占位（不可用）', asDraft.available === false && asDraft.inTrash === false, JSON.stringify(asDraft))

// 把它挪进回收站（回收站的**动作**归 #51，这里只是摆出那个状态）
db.prepare(`UPDATE articles SET deleted_at = ? WHERE slug = ?`).run(Date.now(), 'occupied')
const asTrashed = rules.checkSlugAvailable('occupied')
check('唯一性：**回收站里也占位**（规格 #48）', asTrashed.available === false, JSON.stringify(asTrashed))
check('唯一性：能告诉调用方「它在回收站里」（400 文案要用）', asTrashed.inTrash === true, JSON.stringify(asTrashed))
check('冲突文案含占用者的标题', rules.slugConflictMessage('occupied', asTrashed).includes('标题-occupied'))
check('冲突文案明说它在回收站里', rules.slugConflictMessage('occupied', asTrashed).includes('回收站'))
check('唯一性：没被占用的 slug 可用', rules.checkSlugAvailable('free-one').available === true)

// 标签
const tagCase = rules.normalizeTags(['运维', ' a/b ', '运维', '', '网络'])
check('标签：去重且保序', JSON.stringify(tagCase.tags) === JSON.stringify(['运维', '网络']), JSON.stringify(tagCase.tags))
check('标签：含斜杠的被挑出来（名字即 URL，斜杠会打断它）', tagCase.rejected.includes('a/b'), JSON.stringify(tagCase.rejected))
check('标签：逗号分隔的字符串也认', JSON.stringify(rules.normalizeTags('运维，网络').tags) === JSON.stringify(['运维', '网络']))
check('标签：超长被挑出来', rules.normalizeTags(['x'.repeat(65)]).rejected.length === 1)

// 正文上限（按字节）
check('正文：正好 256 KiB → 过', rules.validateBodySize('a'.repeat(256 * 1024)).ok)
check('正文：256 KiB + 1 字节 → 拒', !rules.validateBodySize('a'.repeat(256 * 1024 + 1)).ok)
check('正文：中文按 UTF-8 字节算（一个汉字 3 字节）', rules.bodySizeBytes('中') === 3)

// 发布后不可改 slug
check('slug 不可改：草稿可以改', !rules.violatesSlugImmutability({ slug: 'a', draft: 1 }, 'b'))
check('slug 不可改：**已发布不能改**', rules.violatesSlugImmutability({ slug: 'a', draft: 0 }, 'b'))
check('slug 不可改：已发布但 slug 没变（保存别的字段）不算违规', !rules.violatesSlugImmutability({ slug: 'a', draft: 0 }, 'a'))
check('slug 不可改：新文章不算违规', !rules.violatesSlugImmutability(undefined, 'a'))

store.closeStore()
fs.rmSync(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })

// ─────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(60)}`)
if (failed === 0) {
  console.log(`✅ 全部通过：${passed} 项`)
} else {
  console.log(`❌ ${failed} 项失败 / 共 ${passed + failed} 项`)
  for (const f of failures) console.log(`   - ${f}`)
}
process.exit(failed === 0 ? 0 : 1)
