/**
 * 编辑器的扩展集 —— **唯一一份**。
 *
 * 它同时被两个消费者使用：
 * 1. \`article-editor.ts\`（浏览器里挂编辑器）；
 * 2. \`scripts/editor-check.mjs\`（Node 里用 \`getSchema()\` 拿它的 schema，
 *    与 \`src/article-doc.ts\` 的服务端 schema **逐节点/逐属性对比** —— 两边对不上就是 400）。
 *
 * ⚠ 关掉 StarterKit 里 schema 表达不了的标记（strike / underline），link 用自己的扩展
 * （StarterKit 那个带 target/rel/class 等 schema 没有的属性）。
 */
import StarterKit from '@tiptap/starter-kit'
import { Table, TableRow, TableHeader, TableCell } from '@tiptap/extension-table'
import Image from '@tiptap/extension-image'
import Link from '@tiptap/extension-link'

export const editorExtensions = [
  StarterKit.configure({
    // schema 允许 1–6；工具栏只摆 2/3，但 schema 不夹 —— 别静默降级。
    heading: { levels: [1, 2, 3, 4, 5, 6] },
    strike: false,
    underline: false,
    link: false,
  }),
  Table,
  TableRow,
  TableHeader,
  TableCell,
  // schema 里 image 是 **inline** 节点，这里必须跟着设。
  Image.configure({ inline: true }),
  Link.configure({ openOnClick: false, autolink: false }),
]
