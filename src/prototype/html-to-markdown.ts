/**
 * 富文本变体（C）的「存回 Markdown」这一步：HTML → Markdown。
 *
 * ⚠ 这是**原型级**实现，刻意不求通用：它存在的唯一意义，是把「富文本没有无损出口」
 * 这件事摆到屏幕上让用户亲眼看见。
 * 所以它同时交出两份东西：**能存回去的 Markdown**，和**这一步压平/丢掉的东西**。
 * 读这份文件的正确姿势：不是在评一个转换器，而是在看这类转换器的天花板在哪。
 */

interface El {
  tag: string
  attrs: string
  children: Node[]
}
interface Text {
  text: string
}
type Node = El | Text

const VOID_TAGS = new Set(['br', 'hr', 'img', 'input', 'meta', 'link', 'source'])
/** 认识的标签。不认识的不报错，直接拍平（并把标签名登记下来）。 */
const KNOWN_TAGS = new Set([
  'p', 'div', 'span', 'br', 'hr', 'b', 'strong', 'i', 'em', 'u', 's', 'code', 'pre',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'blockquote', 'a', 'img',
  'table', 'thead', 'tbody', 'tr', 'th', 'td', 'font', 'section', 'article',
])

function isEl(n: Node): n is El {
  return (n as El).tag !== undefined
}

/** 极简 HTML 解析：一个栈，够这个原型用。注释直接丢。 */
function parseHtml(html: string): { nodes: Node[]; unknownTags: string[]; styled: number; classed: number } {
  const root: Node[] = []
  const stack: El[] = []
  const unknown = new Set<string>()
  /** 属性级损失：HTML 能表达、Markdown 没有等价写法的东西。 */
  let styled = 0
  let classed = 0
  const push = (n: Node): void => {
    const top = stack[stack.length - 1]
    if (top) top.children.push(n)
    else root.push(n)
  }

  const re = /<!--[\s\S]*?-->|<\/?([a-zA-Z][a-zA-Z0-9]*)((?:"[^"]*"|'[^']*'|[^>])*?)(\/?)>/g
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null) {
    const between = html.slice(last, m.index)
    if (between) push({ text: between })
    last = re.lastIndex

    const raw = m[0]!
    if (raw.startsWith('<!--')) continue
    const tag = (m[1] ?? '').toLowerCase()
    const attrs = m[2] ?? ''
    if (!tag) continue
    if (!KNOWN_TAGS.has(tag)) unknown.add(tag)
    if (!raw.startsWith('</')) {
      if (/\bstyle\s*=/i.test(attrs)) styled += 1
      // `language-*` 是代码块的语言标注，它由 pre 那条分支专门处理，不算自定义类名。
      if (/\bclass\s*=/i.test(attrs) && !/language-/i.test(attrs)) classed += 1
    }

    if (raw.startsWith('</')) {
      const idx = stack.map((e) => e.tag).lastIndexOf(tag)
      if (idx < 0) continue
      const el = stack[idx]!
      const orphans = stack.splice(idx + 1)
      for (const o of orphans) el.children.push(...o.children) // 未闭合的兄弟：孩子往上并
      stack.pop()
      push(el)
      continue
    }
    const selfClose = m[3] === '/' || VOID_TAGS.has(tag)
    if (selfClose) push({ tag, attrs, children: [] })
    else stack.push({ tag, attrs, children: [] })
  }
  const tail = html.slice(last)
  if (tail) push({ text: tail })
  while (stack.length > 0) push(stack.pop()!) // 没闭合的也收下
  return { nodes: root, unknownTags: [...unknown], styled, classed }
}

function attrOf(attrs: string, name: string): string {
  const re = new RegExp(`${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i')
  const m = re.exec(attrs)
  return m ? (m[2] ?? m[3] ?? m[4] ?? '') : ''
}

function textOf(nodes: Node[]): string {
  return nodes
    .map((n) => (isEl(n) ? textOf(n.children) : n.text))
    .join('')
    .replace(/\s+/g, ' ')
}

/** 行内渲染：块级标签在这里被拍平（表格单元格、列表项里会用到）。 */
function renderInline(nodes: Node[]): string {
  return nodes
    .map((n) => {
      if (!isEl(n)) return n.text.replace(/\s+/g, ' ')
      const inner = renderInline(n.children)
      switch (n.tag) {
        case 'br':
          return ' '
        case 'hr':
          return ''
        case 'strong':
        case 'b':
          return inner.trim() ? `**${inner.trim()}**` : ''
        case 'em':
        case 'i':
          return inner.trim() ? `*${inner.trim()}*` : ''
        case 'code':
          return n.children.some((c) => !isEl(c)) ? '`' + textOf(n.children).trim() + '`' : inner
        case 'a': {
          const href = attrOf(n.attrs, 'href')
          const label = inner.trim() || href
          return href ? `[${label}](${href})` : label
        }
        case 'img': {
          const src = attrOf(n.attrs, 'src')
          return src ? `![${attrOf(n.attrs, 'alt')}](${src})` : ''
        }
        default:
          return inner
      }
    })
    .join('')
}

/** 会另起一块的标签：容器里有它就得走块级渲染，否则行内内容（图片、链接）会被吞掉。 */
const BLOCK_KIDS = new Set([
  'p', 'div', 'table', 'ul', 'ol', 'pre', 'blockquote', 'hr',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'section', 'article',
])

/**
 * 容器渲染：连续的行内孩子攒成一个行内块，块级孩子单独走 `renderBlocks`。
 *
 * ⚠ 这一段是被**真机跑出来的 bug 修出来的**：第一版对 `p` 直接调 `renderBlocks`，
 * 于是 `<p><img src="…"></p>` 里的图片被静默吞掉（`default:` 分支只递归孩子，而 img 没有孩子）。
 * 富文本里插一张图、存回 Markdown 就消失——这正是这一版最该暴露的那类代价。
 */
function renderContainer(nodes: Node[], notes: string[], depth = 0): string {
  let out = ''
  let buf: Node[] = []
  const flush = (): void => {
    if (buf.length === 0) return
    const text = renderInline(buf).replace(/\s+/g, ' ').trim()
    if (text) out += `${text}\n\n`
    buf = []
  }
  for (const n of nodes) {
    if (isEl(n) && BLOCK_KIDS.has(n.tag)) {
      flush()
      out += renderBlocks([n], notes, depth)
    } else {
      buf.push(n)
    }
  }
  flush()
  return out
}

/** 块级渲染。`notes` 记下这一步「靠猜」或「压平」的地方。 */
function renderBlocks(nodes: Node[], notes: string[], depth = 0): string {
  let out = ''
  for (const n of nodes) {
    if (!isEl(n)) {
      const t = n.text.replace(/\s+/g, ' ').trim()
      if (t) out += `${t}\n\n`
      continue
    }
    const kid = (): string => renderBlocks(n.children, notes, depth)
    switch (n.tag) {
      case 'h1':
      case 'h2':
      case 'h3':
      case 'h4':
      case 'h5':
      case 'h6': {
        const level = Number(n.tag.slice(1))
        out += `${'#'.repeat(level)} ${renderInline(n.children).trim()}\n\n`
        break
      }
      case 'p':
      case 'div':
      case 'section':
      case 'article':
      case 'font':
      case 'span':
      case 'u':
      case 's':
        out += renderContainer(n.children, notes, depth)
        break
      case 'br':
        out += '\n'
        break
      case 'hr':
        out += '---\n\n'
        break
      case 'pre': {
        const code = textOf(n.children).replace(/^\s+|\s+$/g, '')
        const lang = /language-([a-z0-9+#-]+)/i.exec(n.attrs)?.[1]
        if (!lang) notes.push('代码块没有语言标注（富文本里没有地方存它）')
        out += '```' + (lang ?? '') + '\n' + code + '\n```\n\n'
        break
      }
      case 'blockquote': {
        const inner = kid().trim().split('\n').map((l) => (l ? `> ${l}` : '>')).join('\n')
        out += inner + '\n\n'
        break
      }
      case 'ul':
      case 'ol': {
        if (depth > 0) notes.push('嵌套列表被拍平成一级：缩进语义在 Markdown 里靠空格数，转换时最容易糊')
        let i = 1
        for (const li of n.children) {
          if (!isEl(li) || li.tag !== 'li') continue
          const marker = n.tag === 'ol' ? `${i++}. ` : '- '
          const inner = renderContainer(li.children, notes, depth + 1).trim().split('\n')
          const first = inner[0] ?? ''
          out += marker + first + '\n'
          for (const rest of inner.slice(1)) out += (rest ? `  ${rest}` : '') + '\n'
        }
        out += '\n'
        break
      }
      case 'table': {
        const rows: Array<{ cells: string[]; header: boolean }> = []
        const walk = (list: Node[]): void => {
          for (const r of list) {
            if (!isEl(r)) continue
            if (r.tag === 'tr') {
              const cells: string[] = []
              let header = false
              for (const c of r.children) {
                if (!isEl(c) || (c.tag !== 'td' && c.tag !== 'th')) continue
                if (c.tag === 'th') header = true
                cells.push(renderInline(c.children).trim().replace(/\|/g, '\\|'))
              }
              rows.push({ cells, header })
            } else walk(r.children)
          }
        }
        walk(n.children)
        if (rows.length === 0) break
        const hasTh = rows.some((r) => r.header)
        if (!hasTh) notes.push('表格没有表头单元格（th）：第一行被当成表头，这是猜的')
        const width = Math.max(...rows.map((r) => r.cells.length))
        const line = (cells: string[]): string => `| ${[...cells, ...Array(width - cells.length).fill('')].join(' | ')} |`
        out += line(rows[0]!.cells) + '\n'
        out += `| ${Array(width).fill('---').join(' | ')} |\n`
        for (const r of rows.slice(1)) out += line(r.cells) + '\n'
        out += '\n'
        break
      }
      case 'li': {
        const lines = renderContainer(n.children, notes, depth + 1).trim().split('\n')
        out += `- ${lines[0] ?? ''}\n`
        for (const rest of lines.slice(1)) out += (rest ? `  ${rest}` : '') + '\n'
        break
      }
      default:
        // 不认识的标签：标签名丢掉（上面已登记），但**内容必须活下来** ——
        // 第一版这里是 `kid()` 递归孩子，于是 `<p><img></p>` 里的图片被静默吞掉。
        // 那是这一类转换器最容易出的错：损失不在明面上，在于你根本不知道它没了。
        out += renderContainer(n.children, notes, depth)
    }
  }
  return out
}

export interface Conversion {
  markdown: string
  /** 靠猜或压平的地方（转换器自己知道的那部分）。 */
  notes: string[]
  /** 不认识的标签：内容留下了，标签没了。 */
  unknownTags: string[]
}

export function htmlToMarkdown(html: string): Conversion {
  const { nodes, unknownTags, styled, classed } = parseHtml(html)
  const notes: string[] = []
  const markdown = renderBlocks(nodes, notes)
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  if (unknownTags.length > 0) notes.push(`不认识的标签被拍平：${unknownTags.join(' / ')}`)
  if (styled > 0) notes.push(`内联样式（style="…"）被丢弃 ${styled} 处 —— Markdown 没有等价写法`)
  if (classed > 0) notes.push(`自定义类名（class="…"）被丢弃 ${classed} 处`)
  return { markdown, notes: [...new Set(notes)], unknownTags }
}

export interface LossRow {
  item: string
  before: string
  after: string
  verdict: 'loss' | 'kept'
}

function count(text: string, re: RegExp): number {
  return (text.match(re) ?? []).length
}

/**
 * 「存回 Markdown」到底丢了什么：拿转换结果与**样本原文**逐项比。
 * 这一张表就是 C 这一版最贵的地方——它不含观点，全是数出来的。
 */
export function compareToOriginal(markdown: string, original: string): LossRow[] {
  const row = (item: string, a: string, b: string, loss: boolean): LossRow => ({
    item,
    before: a,
    after: b,
    verdict: loss ? 'loss' : 'kept',
  })

  const fmBefore = /^---\r?\n/.test(original)
  const fmAfter = /^---\r?\n/.test(markdown)
  const tableBefore = count(original, /^\|.*\|\s*$/gm)
  const tableAfter = count(markdown, /^\|.*\|\s*$/gm)
  const fenceBefore = count(original, /^```/gm)
  const fenceAfter = count(markdown, /^```/gm)
  const langBefore = /^```\s*[a-zA-Z0-9+#-]+\s*$/m.test(original)
  const langAfter = /^```\s*[a-zA-Z0-9+#-]+\s*$/m.test(markdown)
  const imgBefore = count(original, /!\[[^\]]*\]\([^)]*\)/g)
  const imgAfter = count(markdown, /!\[[^\]]*\]\([^)]*\)/g)
  const quoteBefore = count(original, /^>\s?/gm)
  const quoteAfter = count(markdown, /^>\s?/gm)

  return [
    row('front-matter（6 键元信息）', fmBefore ? '有' : '无', fmAfter ? '有' : '无', fmBefore && !fmAfter),
    row('表格行', `${tableBefore} 行`, `${tableAfter} 行`, tableBefore !== tableAfter),
    row('代码块围栏', `${fenceBefore} 个`, `${fenceAfter} 个`, fenceBefore !== fenceAfter),
    row('代码块语言标注', langBefore ? '有' : '无', langAfter ? '有' : '无', langBefore && !langAfter),
    row('图片引用', `${imgBefore} 个`, `${imgAfter} 个`, imgBefore !== imgAfter),
    row('引用块行', `${quoteBefore} 行`, `${quoteAfter} 行`, quoteBefore !== quoteAfter),
  ]
}
