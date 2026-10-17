/**
 * 文章的文档格式：**schema 的唯一定义**。
 *
 * 为什么单独一个文件：它是「什么能出现在文章里」这句话的**可执行版本**。
 * 读面的 HTML 发射器（`article-html.ts`）按它遍历，导入（`article-import.ts`）按它构造，
 * #50 的编辑器必须按它对齐（**同节点名、同属性名、同内容模型**）。
 *
 * ⚠ **这里不定义 `html` 节点 —— 这不是遗漏，是设计。**
 * 读面渲染出的 HTML 由这个**闭集 schema** 决定，而不是由库里的一段字符串决定。
 * 这是 `docs/editor-shape-decision.md` §5 与 ADR 0006 里那条
 * 「不可信输入不直接进页面」属性的**全部依据**。加一个 html 节点，那条属性当场消失。
 *
 * ⚠ **闭集管住的是「标签」，管不住「属性值」。** `link.href` 与 `image.src` 都要过 `isSafeUrl()`：
 * `<a href="javascript:...">` 是**转义挡不住**的一类注入。
 */
import { Schema, type Node as PMNode } from 'prosemirror-model'

/**
 * 允许出现在 `href` / `src` 里的协议。没有协议的（相对地址、`/media/...`）一律安全。
 *
 * **为什么要先剥控制字符**：浏览器解析 URL 时会忽略制表符与换行，
 * 所以 `java\nscript:alert(1)` 会被当成 `javascript:alert(1)`。
 * 直接拿原串去匹配协议前缀，就会被这一个换行绕过去。先剥再判，就没有这条路。
 */
const SAFE_SCHEMES = new Set(['http:', 'https:', 'mailto:'])

export function isSafeUrl(raw: unknown): boolean {
  if (typeof raw !== 'string') return false
  // 剥掉所有 C0 控制字符与空格：URL 解析器会忽略它们，我们必须在判断前也忽略。
  const url = raw.replace(/[\u0000-\u0020\u007f]/g, '')
  if (!url) return false
  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(url)
  if (!scheme) return true // 无协议 = 相对地址
  return SAFE_SCHEMES.has(`${scheme[1]!.toLowerCase()}:`)
}

export const articleSchema = new Schema({
  nodes: {
    doc: { content: 'block+' },

    paragraph: { content: 'inline*', group: 'block' },

    /**
     * 标题级别允许 1–6：**与源文件的保真**优先于「页面只摆得下三级」。
     * 夹到 1–3 会让 `##### 小节` 静默变成三级标题 —— 静默降级是本仓库明确不接受的那类损失。
     * （编辑器工具栏只暴露 2–3 级是 #50 的取舍，不是 schema 的。）
     */
    heading: {
      attrs: { level: { default: 2 } },
      content: 'inline*',
      group: 'block',
      defining: true,
    },

    blockquote: { content: 'block+', group: 'block', defining: true },

    bulletList: { content: 'listItem+', group: 'block' },

    orderedList: {
      attrs: { start: { default: 1 } },
      content: 'listItem+',
      group: 'block',
    },

    /** 首子必须是 `paragraph`（ProseMirror 的约束，也是 TipTap 列表的形状）。 */
    listItem: { content: 'paragraph block*' },

    /**
     * 代码块带 `language` 属性 —— 这是「存文档 JSON」比原型那条「存 HTML」多拿到的一样东西：
     * `contenteditable` 里没有承载语言标注的地方（原型实测它必丢），而节点属性可以带上它。
     */
    codeBlock: {
      attrs: { language: { default: null } },
      content: 'text*',
      marks: '',
      group: 'block',
      code: true,
      defining: true,
    },

    horizontalRule: { group: 'block' },

    /*
     * 表格：单元格**从一开始就带** `colspan` / `rowspan` / `colwidth`。
     * 用户要的**合并单元格与列宽**正是「正文不存 Markdown」的理由（GFM 表格表达不了它们），
     * 所以这些属性是本期需求的一部分，不是给未来预留的。
     * 属性名跟 `prosemirror-tables` / TipTap 的表格扩展对齐，别自己改名 ——
     * 否则 #50 的编辑器接上来时两边对不上，库里的内容就成了孤儿。
     */
    table: { content: 'tableRow+', group: 'block', tableRole: 'table' },

    tableRow: { content: '(tableCell | tableHeader)+', tableRole: 'row' },

    tableHeader: {
      content: 'block+',
      attrs: {
        colspan: { default: 1 },
        rowspan: { default: 1 },
        colwidth: { default: null },
      },
      tableRole: 'header_cell',
    },

    tableCell: {
      content: 'block+',
      attrs: {
        colspan: { default: 1 },
        rowspan: { default: 1 },
        colwidth: { default: null },
      },
      tableRole: 'cell',
    },

    image: {
      inline: true,
      group: 'inline',
      draggable: true,
      attrs: { src: {}, alt: { default: null }, title: { default: null } },
    },

    hardBreak: { inline: true, group: 'inline', selectable: false },

    text: { group: 'inline' },
  },

  /**
   * 标记的**定义顺序即包裹顺序的外层到内层**（`article-html.ts` 按它嵌套）。
   * `code` 排斥其它标记：代码里的字符不该再被加粗或链接化。
   */
  marks: {
    link: {
      attrs: { href: {}, title: { default: null } },
      inclusive: false,
    },
    bold: {},
    italic: {},
    code: { code: true, excludes: 'link bold italic' },
  },
})

/** 文档 → 可存库的纯 JSON。 */
export function docToJson(doc: PMNode): unknown {
  return doc.toJSON()
}

/**
 * 纯 JSON → 文档。**畸形输入在这里抛错**（不存在的节点类型、内容模型不合法等）。
 * 这是「坏内容不 500」的第一道：调用方（①b 的读路径）必须接住它并**显眼地跳过该篇**，
 * 而不是让它冒到 HTTP 层。
 *
 * ⚠ **`nodeFromJSON` 自己只查「节点类型名认不认识」，不查内容模型** —— 实测：
 * `{type:'doc',content:[]}` 与「段落里塞块节点」都能从它手里过去，然后在渲染时才出问题。
 * 所以必须显式 `check()`：它按 schema 逐层校验并抛错。
 * （这个坑是 `scripts/article-pipeline-check.mjs` 里那两条断言抓出来的，不是推想。）
 */
export function docFromJson(json: unknown): PMNode {
  const doc = articleSchema.nodeFromJSON(json)
  doc.check()
  return doc
}

/** 一个空段落。用于「列表项首子必须是段落」这类内容模型约束的兜底。 */
export function emptyParagraph(): PMNode {
  return articleSchema.nodes.paragraph!.create()
}
