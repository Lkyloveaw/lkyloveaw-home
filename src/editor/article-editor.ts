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

/** 工具栏的一个按钮：显式标签 + 提示 + 点击行为（#79 起按功能组排列）。 */
interface ToolButton {
  label: string
  title: string
  run: () => void
}

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

  const chain = () => editor.chain().focus()

  /**
   * 工具栏的一个功能组（#79）：可见组标签 + 组内按钮。
   *
   * 分组的意义是**同类操作在同一个盒子里**：表格的插入与七种单元格操作必须同组，
   * 否则「表格操作散落」只是从一个平铺换成了两个平铺。组本身是 flex 项，
   * 窄屏时整组换行；组内按钮只在「整组都放不下」时才在组内折行（CSS 负责）。
   */
  const group = (label: string, buttons: ReadonlyArray<ToolButton>): void => {
    const box = document.createElement('div')
    box.className = 'editor-toolbar-group'
    box.setAttribute('role', 'group')
    box.setAttribute('aria-label', label)
    const caption = document.createElement('span')
    caption.className = 'editor-toolbar-label'
    caption.textContent = label
    box.appendChild(caption)
    for (const spec of buttons) {
      const b = document.createElement('button')
      // ⚠ 必须显式 type=button：工具栏在 <form> 里，默认的 submit 会让每次点按钮都提交一次。
      b.type = 'button'
      b.textContent = spec.label
      b.title = spec.title
      b.addEventListener('click', spec.run)
      box.appendChild(b)
    }
    bar.appendChild(box)
  }

  group('文本', [
    { label: 'B', title: '加粗', run: () => chain().toggleBold().run() },
    { label: 'I', title: '斜体', run: () => chain().toggleItalic().run() },
    { label: '<>', title: '行内代码', run: () => chain().toggleCode().run() },
    {
      label: '链接',
      title: '插入 / 去掉链接',
      run: () => {
        const prev = (editor.getAttributes('link').href as string | undefined) ?? ''
        const href = window.prompt('链接地址（http/https/mailto 或站内相对地址）', prev || 'https://')
        if (href === null) return
        if (!href) {
          chain().extendMarkRange('link').unsetLink().run()
          return
        }
        chain().extendMarkRange('link').setLink({ href }).run()
      },
    },
  ])

  group('块', [
    { label: 'H2', title: '二级标题', run: () => chain().toggleHeading({ level: 2 }).run() },
    { label: 'H3', title: '三级标题', run: () => chain().toggleHeading({ level: 3 }).run() },
    { label: '引用', title: '引用块', run: () => chain().toggleBlockquote().run() },
    { label: '代码块', title: '代码块', run: () => chain().toggleCodeBlock().run() },
    { label: '分隔线', title: '水平分隔线', run: () => chain().setHorizontalRule().run() },
  ])

  group('列表', [
    { label: '• 列表', title: '无序列表', run: () => chain().toggleBulletList().run() },
    { label: '1. 列表', title: '有序列表', run: () => chain().toggleOrderedList().run() },
  ])

  group('插入', [
    {
      label: '图片',
      title: '插入图片（地址形如 /media/<hash>.<ext>）',
      run: () => {
        const src = window.prompt('图片地址（/media/<hash>.<ext>，或 http(s) 外链）', '/media/')
        if (src) chain().setImage({ src, alt: '图片' }).run()
      },
    },
  ])

  // 表格组：插入 + 七种表格操作，顺序就是「插入 → 合并/拆分 → 列宽 → 行/列增删」。
  group('表格', [
    {
      label: '表格',
      title: '插入 3×3 表格（带表头行）',
      run: () => chain().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(),
    },
    { label: '合并', title: '把选中的单元格合并成一个', run: () => chain().mergeCells().run() },
    { label: '拆分', title: '把合并过的单元格拆开', run: () => chain().splitCell().run() },
    {
      label: '列宽',
      title: '设置当前单元格所在列的宽度（像素）',
      run: () => {
        const raw = window.prompt('列宽（像素，例如 120）', '120')
        if (!raw) return
        const px = Number.parseInt(raw, 10)
        if (!Number.isFinite(px) || px <= 0) return
        chain().setCellAttribute('colwidth', [px]).run()
      },
    },
    { label: '+行', title: '在下方加一行', run: () => chain().addRowAfter().run() },
    { label: '−行', title: '删除当前行', run: () => chain().deleteRow().run() },
    { label: '+列', title: '在右侧加一列', run: () => chain().addColumnAfter().run() },
    { label: '−列', title: '删除当前列', run: () => chain().deleteColumn().run() },
  ])

  group('历史', [
    { label: '撤销', title: '撤销', run: () => chain().undo().run() },
    { label: '重做', title: '重做', run: () => chain().redo().run() },
  ])

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
