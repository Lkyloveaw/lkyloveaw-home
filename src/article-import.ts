/**
 * Markdown → 文档。
 *
 * 走的是**已有的 markdown-it 的 token 流**（不是正则拼凑），并且**沿用读面同一套选项**
 * （`html: false` / `linkify` / `typographer`）—— 同一份源码不该因为换了个消费者就解析出不同结果。
 *
 * `html: false` **保持不变**：它保证 markdown-it 不会把源里的 `<div>` 当成标签吐出来。
 * 这里的映射表therefore只认它自己的 token；万一出现 html token，也**只当纯文本**（见 `html_block` / `html_inline` 分支）。
 *
 * 这个函数**只吃正文**（front-matter 归 ①b 的导入路径用 gray-matter 处理）。
 */
import MarkdownIt from 'markdown-it'
import type { Node as PMNode } from 'prosemirror-model'
import { articleSchema, emptyParagraph, isSafeUrl } from './article-doc.js'

const md = new MarkdownIt({
  html: false, // 与 src/content.ts 的读面一致：少一个 XSS 面
  linkify: true,
  typographer: true,
})

type MdToken = ReturnType<InstanceType<typeof MarkdownIt>['parse']>[number]

export interface ImportResult {
  doc: PMNode
  /**
   * 转换过程中的**显眼损失**（不安全的地址、认不出的构造……）。
   * 存在的理由：「失败要显眼不要静默降级」—— 导入把一篇能读的文章变成了少东西的文章，
   * 调用方必须有机会把这件事说出来。现有两篇的期望值是**空数组**。
   */
  warnings: string[]
}

interface Frame {
  type: string
  attrs: Record<string, unknown>
  blocks: PMNode[]
  inline: PMNode[] | null
}

const clip = (text: string, max = 60): string => (text.length > max ? `${text.slice(0, max)}…` : text)

/** 打开中的标记（`link` / `bold` / `italic`）—— 成对 push / pop。 */
interface OpenMark {
  name: string
  attrs?: Record<string, unknown>
}

function buildInline(tokens: MdToken[], warnings: string[]): PMNode[] {
  const schema = articleSchema
  const out: PMNode[] = []
  const open: OpenMark[] = []

  const pushText = (text: string): void => {
    if (!text) return
    const marks = open.map((m) => schema.marks[m.name]!.create(m.attrs ?? null))
    out.push(schema.text(text, marks))
  }

  const pop = (name: string): void => {
    for (let i = open.length - 1; i >= 0; i -= 1) {
      if (open[i]!.name === name) {
        open.splice(i, 1)
        return
      }
    }
  }

  for (const t of tokens) {
    switch (t.type) {
      case 'text':
        pushText(t.content)
        break

      case 'code_inline':
        if (t.content) out.push(schema.text(t.content, [schema.marks.code!.create()]))
        break

      case 'strong_open':
        open.push({ name: 'bold' })
        break
      case 'strong_close':
        pop('bold')
        break

      case 'em_open':
        open.push({ name: 'italic' })
        break
      case 'em_close':
        pop('italic')
        break

      case 'link_open': {
        const href = String(t.attrGet('href') ?? '')
        if (!isSafeUrl(href)) {
          // 不推标记 = 只丢链接壳、**保留文本**。安全地址判定见 article-doc.ts 的 isSafeUrl。
          warnings.push(`链接地址的协议不安全，已丢链接壳（文本保留）：${clip(href)}`)
          break
        }
        open.push({ name: 'link', attrs: { href, title: t.attrGet('title') ?? null } })
        break
      }
      case 'link_close':
        pop('link')
        break

      case 'image': {
        const src = String(t.attrGet('src') ?? '')
        // ⚠ markdown-it 把图片 alt 放在 token.content 里，**不在 attr 里** ——
        //    写成 attrGet('alt') 的话 alt 永远是空串（#52 落地时实测到并修掉）。
        const alt = String(t.content || t.attrGet('alt') || '')
        if (!isSafeUrl(src)) {
          warnings.push(`图片地址的协议不安全，已丢图片（保留 alt 文本）：${clip(src)}`)
          pushText(alt)
          break
        }
        out.push(
          schema.nodes.image!.create({ src, alt: alt || null, title: t.attrGet('title') ?? null }),
        )
        break
      }

      /** markdown 的软换行在 HTML 里等价于空白 —— 收敛成一个空格，别在文档里留无意义的换行节点。 */
      case 'softbreak':
        pushText(' ')
        break
      case 'hardbreak':
        out.push(schema.nodes.hardBreak!.create())
        break

      /**
       * `html: false` 下这两个**不该出现**。真出现了就是有人把选项改了 ——
       * 那就把它当**纯文本**吞下去，绝不在这里变成标签（这是本文件唯一的安全底线）。
       */
      case 'html_inline':
      case 'html_block':
        warnings.push('源里出现了 HTML 片段，已按纯文本处理（不会变成标签）')
        pushText(t.content)
        break

      default:
        break
    }
  }

  return out
}

function codeBlockFromToken(t: MdToken): PMNode {
  const info = (t.info ?? '').trim()
  const language = info ? (info.split(/\s+/)[0] ?? null) : null
  // markdown-it 的 fence 内容末尾带一个换行，那是围栏语法的一部分，不是内容的一部分。
  const content = t.content.replace(/\n$/, '')
  const text = content ? [articleSchema.text(content)] : []
  return articleSchema.nodes.codeBlock!.create({ language: language || null }, text)
}

function cellContent(frame: Frame): PMNode[] {
  const out: PMNode[] = []
  if (frame.inline && frame.inline.length) {
    out.push(articleSchema.nodes.paragraph!.create(null, frame.inline))
  }
  out.push(...frame.blocks)
  if (!out.length) out.push(emptyParagraph())
  return out
}

/**
 * 收一个容器。返回 `null` = **这个容器被丢掉了**（内容不足以构成合法节点），并且已经登记警告。
 * 丢而不是硬造：`bulletList` / `table` 的内容模型都是「至少一个子项」，硬造会产出一个空壳。
 */
function closeFrame(frame: Frame, warnings: string[]): PMNode | null {
  const schema = articleSchema
  switch (frame.type) {
    case 'paragraph':
      return schema.nodes.paragraph!.create(null, frame.inline ?? [])

    case 'heading':
      return schema.nodes.heading!.create({ level: frame.attrs.level ?? 2 }, frame.inline ?? [])

    case 'blockquote':
      return schema.nodes.blockquote!.create(null, frame.blocks.length ? frame.blocks : [emptyParagraph()])

    case 'bulletList':
      if (!frame.blocks.length) {
        warnings.push('空的无序列表被丢掉（列表至少要有一项）')
        return null
      }
      return schema.nodes.bulletList!.create(null, frame.blocks)

    case 'orderedList':
      if (!frame.blocks.length) {
        warnings.push('空的有序列表被丢掉（列表至少要有一项）')
        return null
      }
      return schema.nodes.orderedList!.create({ start: frame.attrs.start ?? 1 }, frame.blocks)

    case 'listItem': {
      let blocks = frame.blocks
      if (!blocks.length) blocks = [emptyParagraph()]
      // 内容模型是 `paragraph block*`：首子不是段落就补一个空的（否则 create 会抛）
      else if (blocks[0]!.type.name !== 'paragraph') blocks = [emptyParagraph(), ...blocks]
      return schema.nodes.listItem!.create(null, blocks)
    }

    case 'tableHeader':
      return schema.nodes.tableHeader!.create(null, cellContent(frame))
    case 'tableCell':
      return schema.nodes.tableCell!.create(null, cellContent(frame))

    case 'tableRow':
      if (!frame.blocks.length) {
        warnings.push('空的表格行被丢掉')
        return null
      }
      return schema.nodes.tableRow!.create(null, frame.blocks)

    case 'table':
      if (!frame.blocks.length) {
        warnings.push('空的表格被丢掉（表格至少要有一行）')
        return null
      }
      return schema.nodes.table!.create(null, frame.blocks)

    default:
      throw new Error(`article-import：认不出的块容器「${frame.type}」`)
  }
}

/** Markdown **正文**（不含 front-matter）→ 文档。 */
export function markdownToDoc(markdown: string): ImportResult {
  const warnings: string[] = []
  const tokens = md.parse(markdown, {})

  const root: Frame = { type: 'doc', attrs: {}, blocks: [], inline: null }
  const stack: Frame[] = [root]
  const top = (): Frame => stack[stack.length - 1]!

  const openFrame = (type: string, attrs: Record<string, unknown> = {}): void => {
    stack.push({ type, attrs, blocks: [], inline: null })
  }

  for (const t of tokens) {
    switch (t.type) {
      case 'paragraph_open':
        openFrame('paragraph')
        break
      case 'heading_open': {
        const level = Number(t.tag.slice(1))
        openFrame('heading', { level: Number.isFinite(level) && level >= 1 && level <= 6 ? level : 2 })
        break
      }
      case 'blockquote_open':
        openFrame('blockquote')
        break
      case 'bullet_list_open':
        openFrame('bulletList')
        break
      case 'ordered_list_open': {
        const start = Number(t.attrGet('start') ?? 1)
        openFrame('orderedList', { start: Number.isFinite(start) && start > 0 ? start : 1 })
        break
      }
      case 'list_item_open':
        openFrame('listItem')
        break
      case 'table_open':
        openFrame('table')
        break
      case 'tr_open':
        openFrame('tableRow')
        break

      /**
       * `th` / `td` 的 GFM 对齐信息（`style="text-align:…"`）**故意不建模**：
       * schema 里没有对齐属性，而揉进来一个编辑器（#50）保不住的属性，
       * 就等于给「编辑一次就静默变形」埋雷。要加就等 #50 的表格扩展能往返它的时候再加。
       */
      case 'th_open':
        openFrame('tableHeader')
        break
      case 'td_open':
        openFrame('tableCell')
        break

      /** thead / tbody 是渲染时的分组，不是内容结构；发射器按「首行是不是全表头」自己分组。 */
      case 'thead_open':
      case 'thead_close':
      case 'tbody_open':
      case 'tbody_close':
        break

      case 'inline':
        top().inline = buildInline(t.children ?? [], warnings)
        break

      case 'fence':
      case 'code_block':
        top().blocks.push(codeBlockFromToken(t))
        break

      case 'hr':
        top().blocks.push(articleSchema.nodes.horizontalRule!.create())
        break

      case 'html_block':
        warnings.push('源里出现了 HTML 块，已按纯文本处理（不会变成标签）')
        top().blocks.push(articleSchema.nodes.paragraph!.create(null, [articleSchema.text(t.content.trim())]))
        break

      case 'paragraph_close':
      case 'heading_close':
      case 'blockquote_close':
      case 'bullet_list_close':
      case 'ordered_list_close':
      case 'list_item_close':
      case 'table_close':
      case 'tr_close':
      case 'th_close':
      case 'td_close': {
        const frame = stack.pop()
        if (!frame || frame === root) {
          warnings.push(`出现了没有对应开标签的闭合 token：${t.type}`)
          break
        }
        const node = closeFrame(frame, warnings)
        if (node) top().blocks.push(node)
        break
      }

      default:
        break
    }
  }

  if (stack.length !== 1) warnings.push(`有 ${stack.length - 1} 个块容器没有闭合`)

  const blocks = root.blocks.length ? root.blocks : [emptyParagraph()]
  // doc 的内容模型是 `block+`，所以上面那一行不是「兜底」，是必需的。
  return { doc: articleSchema.nodes.doc!.create(null, blocks), warnings }
}

/**
 * 文档 JSON → Markdown。**`markdownToDoc()` 的逆**。
 *
 * 为什么需要它：写路径的编辑区是**一个 Markdown 文本框**（#50 选定的过渡形态），
 * 打开一篇已存在的文章时，要把库里的**文档 JSON** 还原成 Markdown 填进文本框。
 *
 * ⚠ **往返必须稳定**：`doc → md → doc` 要回到同一个文档。否则「打开、保存、什么都没改」
 * 看起来就变了 → `upsertArticleWithRevision()` 会**每次都堆一条修订**。
 * 这条由 `scripts/article-pipeline-check.mjs` 的断言钉住，不靠「应该没问题」。
 *
 * ⚠ **已知损失（写在明面上）**：Markdown 表达不了**合并单元格与列宽**（`colspan` / `rowspan` / `colwidth`）。
 * 用文本框编辑一篇含这两者的文章会**丢掉它们**。今天库里的两篇都是导入的普通 GFM 表格
 * （无合并、无列宽），所以实际风险为零；富文本编辑器（#57）落地后这条路就没了。
 * 表格对齐（`:---:`）同样不表达 —— 导入侧本来也不建模它。
 */

/** Markdown 里有语法含义的字符，逐字转义（CommonMark 的反斜杠转义，`markdownToDoc` 认得）。 */
function escapeMd(text: string): string {
  return text.replace(/([\\`*_[\]<>])/g, '\\$1')
}

/** 一个节点的全部行内内容。 */
function inlineAll(node: PMNode): string {
  let out = ''
  node.forEach((child) => {
    out += inlineOne(child)
  })
  return out
}

/**
 * 单个行内节点。
 * marks **由内到外**包裹：`code` → `italic` → `bold` → `link` —— 与 `article-html.ts` 的发射顺序一致。
 */
function inlineOne(node: PMNode): string {
  const name = node.type.name
  if (name === 'text') {
    let out = escapeMd(node.text ?? '')
    const has = (m: string): boolean => node.marks.some((x) => x.type.name === m)
    if (has('code')) out = '`' + out + '`'
    if (has('italic')) out = '*' + out + '*'
    if (has('bold')) out = '**' + out + '**'
    const link = node.marks.find((x) => x.type.name === 'link')
    if (link) out = '[' + out + '](' + String(link.attrs.href) + ')'
    return out
  }
  if (name === 'hardBreak') return '  \n'
  if (name === 'image') {
    const a = node.attrs as { src: string; alt?: string | null; title?: string | null }
    const title = a.title ? ' "' + String(a.title) + '"' : ''
    return '![' + String(a.alt ?? '') + '](' + String(a.src) + title + ')'
  }
  // schema 是闭集，走到这里说明有新节点没被照顾到 —— 退回纯文本，**不静默丢内容**。
  return node.textContent
}

/** 块级节点 → Markdown（带缩进，供嵌套列表用）。 */
function blockOne(node: PMNode, indent: string): string {
  const name = node.type.name
  switch (name) {
    case 'paragraph':
      return indent + inlineAll(node) + '\n\n'
    case 'heading': {
      const level = Math.min(Math.max(Number(node.attrs.level) || 1, 1), 6)
      return indent + '#'.repeat(level) + ' ' + inlineAll(node) + '\n\n'
    }
    case 'blockquote':
      return (
        children(node)
          .split('\n')
          .filter((l) => l.trim() !== '')
          .map((l) => indent + '> ' + l)
          .join('\n') + '\n\n'
      )
    case 'bulletList':
      return listItems(node, indent, () => '- ')
    case 'orderedList':
      return listItems(node, indent, (i) => String(i + 1) + '. ')
    case 'codeBlock': {
      const lang = node.attrs.language ? String(node.attrs.language) : ''
      // ⚠ 代码块内容**不转义**（它就是原文），这也是往返最容易坏的地方 —— 断言里专门覆盖。
      return indent + '```' + lang + '\n' + node.textContent + '\n```\n\n'
    }
    case 'horizontalRule':
      return indent + '---\n\n'
    case 'table':
      return tableMd(node) + '\n\n'
    default:
      return indent + node.textContent + '\n\n'
  }
}

/** 容器的子节点依次转块。 */
function children(node: PMNode): string {
  let out = ''
  node.forEach((child) => {
    out += blockOne(child, '')
  })
  return out
}

/** 列表项：`listItem` 里通常是若干 `paragraph`（第二段起要缩进对齐）。 */
function listItems(list: PMNode, indent: string, marker: (i: number) => string): string {
  let out = ''
  let i = 0
  list.forEach((item) => {
    const m = marker(i++)
    const inner = children(item).trimEnd()
    const lines = inner.split('\n')
    const pad = ' '.repeat(m.length)
    out += indent + m + (lines[0] ?? '') + '\n'
    for (const line of lines.slice(1)) out += indent + pad + line + '\n'
    if (i === 1) out += ''
  })
  return out + '\n'
}

/**
 * 表格 → GFM 表格（第一行当表头）。
 * 合并单元格与列宽在这里**表达不出来**（见文件头的「已知损失」）。
 */
function tableMd(table: PMNode): string {
  const rows: string[] = []
  const widths: number[] = []
  table.forEach((row) => {
    const cells: string[] = []
    row.forEach((cell) => {
      cells.push(inlineAll(cell).replace(/\n/g, ' ').replace(/\|/g, '\\|'))
    })
    rows.push('| ' + cells.join(' | ') + ' |')
    cells.forEach((c, idx) => {
      widths[idx] = Math.max(widths[idx] ?? 3, c.length)
    })
  })
  if (rows.length === 0) return ''
  const sep = '| ' + widths.map((w) => '-'.repeat(Math.max(w, 3))).join(' | ') + ' |'
  return [rows[0]!, sep, ...rows.slice(1)].join('\n')
}

/** 入口：文档 JSON → Markdown。 */
export function docToMarkdown(doc: PMNode): string {
  return children(doc).replace(/\n{3,}/g, '\n\n').trim() + '\n'
}
