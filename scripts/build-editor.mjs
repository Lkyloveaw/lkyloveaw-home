/**
 * 打包编辑面的客户端脚本（ADR 0006 里那条「唯一为编辑器破例的构建步骤」）。
 *
 * 为什么单独一个脚本而不是 package.json 里一条 esbuild 命令行：**配置只有一份**，
 * 且 \`scripts/editor-check.mjs\` 要拿同一份配置重新打一遍来断言「提交的产物没过期」。
 *
 * 产物 \`public/article-editor.js\` 是**构建产物、不进 git**（.gitignore），
 * 由 `npm run build` 生成；部署时同步工作树后在服务器上跑同一条命令。
 */
import { build } from 'esbuild'

export const EDITOR_ENTRY = 'src/editor/article-editor.ts'
export const EDITOR_OUT = 'public/article-editor.js'

export const editorBuildOptions = {
  entryPoints: [EDITOR_ENTRY],
  outfile: EDITOR_OUT,
  bundle: true,
  format: 'iife',
  target: ['es2020'],
  minify: true,
  sourcemap: false,
  legalComments: 'none',
  logLevel: 'warning',
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'))
if (isMain || process.argv.includes('--build')) {
  const r = await build(editorBuildOptions)
  if (r.errors.length) process.exit(1)
  console.log('[editor] 已打包 ' + EDITOR_OUT)
}
