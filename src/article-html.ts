/**
 * 文档 → HTML 的**闭集发射器**。它取代 markdown-it 在**读面**的位置。
 *
 * 两条纪律，缺一不可：
 *
 * 1. **每一个文本与属性都转义**（`escapeHtml`）。不转义就等于把库里的字符串直接倒进页面。
 * 2. **只发射 schema 里有的节点**；遇到不认识的节点类型**抛错**，不猜、不跳过。
 *    这就是「可渲染的标签集是闭集」——`markdown-it` 当年靠 `html: false` 拿到的那条属性，
 *    换成文档 JSON 之后由这里接管（`docs/editor-shape-decision.md` §5）。
 *
 * 抛错是**故意**的：schema 保证了闭集，一个不认识的节点说明有 bug，要响。
 * 「坏内容不 500」在调用方解决（①b 的读路径逐篇接住并显眼跳过），不在这里降级。
 */
import type { Node as PMNode } from 'prosemirror-model'
import { isSafeUrl } from './article-doc.js'

import { escapeHtml } from '../public/html.js'
export { escapeHtml } from '../public/html.js'

const MARK_TAGS: Record<string, string> = { bold: 'strong', italic: 'em', code: 'code' }

/** 由**内到外**的包裹顺序（与 schema 里 marks 的定义顺序一致）。 */
const MARK_INNER_TO_OUTER = ['code', 'italic', 'bold', 'link'] as const

function renderText(node: PMNode): string {
  let html = escapeHtml(node.text ?? '')
  for (const name of MARK_INNER_TO_OUTER) {
    const mark = node.marks.find((m) => m.type.name === name)
    if (!mark) continue

    if (name === 'link') {
      const href = mark.attrs.href
      // 不安全的 href 不是「转义一下就好」——`javascript:` 转义之后照样可执行。
      // 处理方式：**不加链接壳，保留文本**。宁可少一个链接，不可多一个注入面。
      if (!isSafeUrl(href)) continue
      const title = mark.attrs.title
      const titleAttr = typeof title === 'string' && title ? ` title="${escapeHtml(title)}"` : ''
      html = `<a href="${escapeHtml(String(href))}"${titleAttr} rel="noopener noreferrer">${html}</a>`
      continue
    }

    const tag = MARK_TAGS[name]!
    html = `<${tag}>${html}</${tag}>`
  }
  return html
}

function renderInlineChildren(node: PMNode): string {
  let html = ''
  node.forEach((child) => {
    html += renderInlineNode(child)
  })
  return html
}

function renderInlineNode(node: PMNode): string {
  switch (node.type.name) {
    case 'text':
      return renderText(node)
    case 'hardBreak':
      return '<br>'
    case 'image': {
      const { src, alt, title } = node.attrs as { src: unknown; alt: unknown; title: unknown }
      if (!isSafeUrl(src)) return '' // 同上：不安全就不发射
      const altAttr = typeof alt === 'string' && alt ? ` alt="${escapeHtml(alt)}"` : ' alt=""'
      const titleAttr = typeof title === 'string' && title ? ` title="${escapeHtml(title)}"` : ''
      return `<img src="${escapeHtml(String(src))}"${altAttr}${titleAttr}>`
    }
    default:
      // inline 位置出现了块节点，或者 schema 之外的东西 —— 都该响。
      throw new Error(`article-html：inline 位置出现意外的节点类型「${node.type.name}」`)
  }
}

function numericAttr(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback
}

function renderCell(node: PMNode, tag: 'th' | 'td'): string {
  let attrs = ''
  const colspan = numericAttr(node.attrs.colspan, 1)
  const rowspan = numericAttr(node.attrs.rowspan, 1)
  if (colspan > 1) attrs += ` colspan="${colspan}"`
  if (rowspan > 1) attrs += ` rowspan="${rowspan}"`
  return `<${tag}${attrs}>${renderBlocks(node)}</${tag}>\n`
}

function isHeaderRow(row: PMNode): boolean {
  let allHeader = row.childCount > 0
  row.forEach((cell) => {
    if (cell.type.name !== 'tableHeader') allHeader = false
  })
  return allHeader
}

/**
 * 列宽用 `<colgroup><col style="width: Npx">` 表达 —— 这是 HTML 里唯一正确的位置。
 * 挂在单元格上（`<td style="width:…">`）在多行之间会互相打架。
 */
function renderColgroup(rows: PMNode[]): string {
  const first = rows[0]
  if (!first) return ''
  const widths: Array<number | null> = []
  first.forEach((cell) => {
    const cw = cell.attrs.colwidth
    const first_ = Array.isArray(cw) ? cw[0] : null
    const n = typeof first_ === 'number' && first_ > 0 ? Math.floor(first_) : null
    widths.push(n)
  })
  if (!widths.some((w) => w !== null)) return ''
  const cols = widths.map((w) => (w === null ? '<col>' : `<col style="width: ${w}px">`)).join('')
  return `<colgroup>${cols}</colgroup>\n`
}

function renderTable(node: PMNode): string {
  const rows: PMNode[] = []
  node.forEach((row) => rows.push(row))

  let headCount = 0
  while (headCount < rows.length && isHeaderRow(rows[headCount]!)) headCount += 1

  const head = rows.slice(0, headCount)
  const body = rows.slice(headCount)

  const renderRows = (list: PMNode[]): string => {
    let html = ''
    for (const row of list) {
      html += '<tr>\n'
      row.forEach((cell) => {
        html += cell.type.name === 'tableHeader' ? renderCell(cell, 'th') : renderCell(cell, 'td')
      })
      html += '</tr>\n'
    }
    return html
  }

  // 表格套一层横向滚动容器（选项 C，用户 2026-10-20 定）：正文收窄到 68ch 之后，宽表
  // （列多、单元格内容长）会把栏撑得难看或挤成一行两个字符。读面在 `.table-wrap` 里原地横滚；
  // 编辑面 TipTap 自己就有 `.tableWrapper` —— 两面结构就此对齐。
  let html = '<div class="table-wrap">\n<table>\n'
  html += renderColgroup(rows)
  if (head.length) html += `<thead>\n${renderRows(head)}</thead>\n`
  if (body.length || !head.length) html += `<tbody>\n${renderRows(body)}</tbody>\n`
  html += '</table>\n</div>\n'
  return html
}

function renderBlock(node: PMNode): string {
  switch (node.type.name) {
    case 'paragraph':
      return `<p>${renderInlineChildren(node)}</p>\n`

    case 'heading': {
      const level = Math.min(6, Math.max(1, numericAttr(node.attrs.level, 2)))
      return `<h${level}>${renderInlineChildren(node)}</h${level}>\n`
    }

    case 'blockquote':
      return `<blockquote>\n${renderBlocks(node)}</blockquote>\n`

    case 'bulletList':
      return `<ul>\n${renderBlocks(node)}</ul>\n`

    case 'orderedList': {
      const start = numericAttr(node.attrs.start, 1)
      return `<ol${start !== 1 ? ` start="${start}"` : ''}>\n${renderBlocks(node)}</ol>\n`
    }

    case 'listItem':
      return `<li>${renderBlocks(node)}</li>\n`

    case 'codeBlock': {
      const language = node.attrs.language
      const cls = typeof language === 'string' && language ? ` class="language-${escapeHtml(language)}"` : ''
      // 代码块内容整段转义 —— 它是**唯一**允许原样（转义后）出现在页面上的「看起来像标签」的东西。
      return `<pre><code${cls}>${escapeHtml(node.textContent)}</code></pre>\n`
    }

    case 'horizontalRule':
      return '<hr>\n'

    case 'table':
      return renderTable(node)

    case 'tableRow':
      // 只可能从 renderTable 内部走到这里；单独出现说明调用路径错了。
      throw new Error('article-html：tableRow 不该被直接渲染')

    case 'tableHeader':
      return renderCell(node, 'th')

    case 'tableCell':
      return renderCell(node, 'td')

    default:
      throw new Error(`article-html：schema 里不该出现的节点类型「${node.type.name}」`)
  }
}

function renderBlocks(node: PMNode): string {
  let html = ''
  node.forEach((child) => {
    html += renderBlock(child)
  })
  return html
}

/** 文档 → HTML。`doc` 必须是 `articleSchema` 的 `doc` 节点（或它的子树）。 */
export function docToHtml(doc: PMNode): string {
  const name = doc.type.name
  if (name === 'doc') return renderBlocks(doc)
  if (name === 'paragraph' || name === 'heading' || name === 'tableCell' || name === 'tableHeader') {
    return renderBlocks(doc)
  }
  return renderBlock(doc)
}
