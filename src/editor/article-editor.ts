/**
 * 写作区的富文本编辑器（TipTap / ProseMirror）—— **只服务编辑面**（ADR 0006）。
 *
 * ⚠ 本文件**不参与服务端 \`tsc\` 构建**（见 tsconfig.editor.json），由 esbuild 打包成
 * \`public/article-editor.js\`。读面一行都不受影响：它仍是服务端渲染，禁 JS 也能读。
 *
 * ⚠ **与 \`src/article-doc.ts\` 的 schema 必须同节点名、同属性名**。这里做了两件事来保证：
 * 1. StarterKit 里 schema 表达不了的标记（\`strike\` / \`underline\`）关掉；
 * 2. \`link\` 用自己的扩展（StarterKit 里那个带 \`target\`/\`rel\`/\`class\` 等 schema 没有的属性）。
 * 工具栏**只暴露 schema 里存在的节点/标记** —— UI 不许长出存不下去的东西。
 *
 * 接口形状不变：文档 JSON 同步进 hidden 字段（\`name="body_json"\`），照旧表单 POST + PRP。
 */
import { Editor, type JSONContent } from '@tiptap/core'
import { editorExtensions } from './editor-extensions'

const HIDDEN_ID = 'article-body-json'
const MOUNT_ID = 'article-editor'
const EMPTY_DOC = { type: 'doc', content: [{ type: 'paragraph' }] }

function byId<T extends HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null
}

function main(): void {
  const hidden = byId<HTMLInputElement>(HIDDEN_ID)
  const mount = byId<HTMLDivElement>(MOUNT_ID)
  if (!hidden || !mount) return

  // 初次内容来自 hidden 字段（失败重渲染时回填的就是它）——所以「正文不会因为 400 变空」。
  let initial: JSONContent = EMPTY_DOC
  try {
    const parsed = JSON.parse(hidden.value || '') as unknown
    if (parsed && typeof parsed === 'object') initial = parsed as JSONContent
  } catch {
    initial = EMPTY_DOC
  }

  const editor = new Editor({
    element: mount,
    extensions: editorExtensions,
    content: initial,
    onUpdate: () => {
      hidden.value = JSON.stringify(editor.getJSON())
    },
  })
  hidden.value = JSON.stringify(editor.getJSON())

  const bar = document.createElement('div')
  bar.className = 'editor-toolbar'
  bar.setAttribute('role', 'toolbar')
  bar.setAttribute('aria-label', '正文工具栏')

  const button = (label: string, title: string, run: () => void): void => {
    const b = document.createElement('button')
    // ⚠ 必须显式 type=button：工具栏在 <form> 里，默认的 submit 会让每次点按钮都提交一次。
    b.type = 'button'
    b.textContent = label
    b.title = title
    b.addEventListener('click', run)
    bar.appendChild(b)
  }
  const chain = () => editor.chain().focus()

  button('H2', '二级标题', () => chain().toggleHeading({ level: 2 }).run())
  button('H3', '三级标题', () => chain().toggleHeading({ level: 3 }).run())
  button('B', '加粗', () => chain().toggleBold().run())
  button('I', '斜体', () => chain().toggleItalic().run())
  button('<>', '行内代码', () => chain().toggleCode().run())
  button('链接', '插入 / 去掉链接', () => {
    const prev = (editor.getAttributes('link').href as string | undefined) ?? ''
    const href = window.prompt('链接地址（http/https/mailto 或站内相对地址）', prev || 'https://')
    if (href === null) return
    if (!href) {
      chain().extendMarkRange('link').unsetLink().run()
      return
    }
    chain().extendMarkRange('link').setLink({ href }).run()
  })
  button('• 列表', '无序列表', () => chain().toggleBulletList().run())
  button('1. 列表', '有序列表', () => chain().toggleOrderedList().run())
  button('引用', '引用块', () => chain().toggleBlockquote().run())
  button('代码块', '代码块', () => chain().toggleCodeBlock().run())
  button('分隔线', '水平分隔线', () => chain().setHorizontalRule().run())
  button('图片', '插入图片（地址形如 /media/<hash>.<ext>）', () => {
    const src = window.prompt('图片地址（/media/<hash>.<ext>，或 http(s) 外链）', '/media/')
    if (src) chain().setImage({ src, alt: '图片' }).run()
  })
  button('表格', '插入 3×3 表格（带表头行）', () =>
    chain().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(),
  )
  button('合并', '把选中的单元格合并成一个', () => chain().mergeCells().run())
  button('拆分', '把合并过的单元格拆开', () => chain().splitCell().run())
  button('列宽', '设置当前单元格所在列的宽度（像素）', () => {
    const raw = window.prompt('列宽（像素，例如 120）', '120')
    if (!raw) return
    const px = Number.parseInt(raw, 10)
    if (!Number.isFinite(px) || px <= 0) return
    chain().setCellAttribute('colwidth', [px]).run()
  })
  button('+行', '在下方加一行', () => chain().addRowAfter().run())
  button('−行', '删除当前行', () => chain().deleteRow().run())
  button('+列', '在右侧加一列', () => chain().addColumnAfter().run())
  button('−列', '删除当前列', () => chain().deleteColumn().run())
  button('撤销', '撤销', () => chain().undo().run())
  button('重做', '重做', () => chain().redo().run())

  mount.parentNode?.insertBefore(bar, mount)

  // 上传成功回跳（#52 的上传流程）：把刚传的图**插进正文**，而不是让人去粘 Markdown。
  const uploaded = mount.dataset.uploadedName
  if (uploaded) {
    editor.chain().focus('end').setImage({ src: '/media/' + uploaded, alt: '图片' }).run()
    hidden.value = JSON.stringify(editor.getJSON())
  }

  // 提交前再同步一次：防「刚敲完就点保存」这一瞬的竞态（onUpdate 覆盖绝大多数情况）。
  const form = mount.closest('form')
  form?.addEventListener('submit', () => {
    hidden.value = JSON.stringify(editor.getJSON())
  })
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', main)
else main()
