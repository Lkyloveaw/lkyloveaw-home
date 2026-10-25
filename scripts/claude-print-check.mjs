/** 已授权的 Edge 打印验收：从本地合成数据预览取真实 SSR，禁用页面脚本后打印实际 print CSS。 */
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { preparePrintHtml } from './lib/print-html.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const port = Number(process.env.CLAUDE_PREVIEW_PORT || 4387)
if (!Number.isInteger(port) || port < 1024 || port > 65534) throw new Error('CLAUDE_PREVIEW_PORT 必须在 1024–65534 之间')
const base = `http://127.0.0.1:${port}`
const edge = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe'].find((file) => fs.existsSync(file))
if (!edge) throw new Error('此脚本需要本机已安装 Microsoft Edge')
const output = path.join(root, 'output/pdf')
const temp = path.join(root, '.dsh-progress/claude-print')
fs.mkdirSync(output, { recursive: true })
fs.mkdirSync(temp, { recursive: true })

const login = await fetch(base + '/login', {
  method: 'POST', redirect: 'manual',
  headers: { 'content-type': 'application/x-www-form-urlencoded', origin: base },
  body: new URLSearchParams({ username: 'preview-admin', password: 'preview-only-pass-123', next: '/' }),
})
if (login.status !== 302) throw new Error('请先运行 node scripts/claude-preview.mjs；仅支持它创建的合成账号')
const cookie = login.headers.get('set-cookie')?.split(';')[0]
if (!cookie) throw new Error('预览没有签发会话')
const cssResponse = await fetch(base + '/style.css')
if (!cssResponse.ok) throw new Error(`CSS 请求失败：${cssResponse.status}`)
const css = await cssResponse.text()
for (const [name, route, title] of [
  ['claude-article-print', '/posts/visual-table', '长表格与中文阅读验收'],
  ['claude-status-print', '/status', '内网业务系统可用性'],
]) {
  const response = await fetch(base + route, { headers: { cookie }, redirect: 'manual' })
  if (!response.ok) throw new Error(`${route} 请求失败：${response.status}`)
  let html = await response.text()
  if (!html.includes(title)) throw new Error(`${route} 未返回预期的合成数据页面`)
  html = preparePrintHtml(html, css)
  const input = path.join(temp, name + '.html')
  const pdf = path.join(output, name + '.pdf')
  fs.writeFileSync(input, html)
  const profile = fs.mkdtempSync(path.join(temp, 'edge-profile-'))
  const result = spawnSync(edge, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-background-networking', '--disable-component-update', '--disable-sync',
    '--no-pdf-header-footer', `--user-data-dir=${profile}`, `--print-to-pdf=${pdf}`,
    pathToFileURL(input).href,
  ], { timeout: 60000, windowsHide: true, encoding: 'utf8' })
  if (result.status !== 0 || !fs.existsSync(pdf) || fs.statSync(pdf).size < 10000) {
    throw new Error(result.error?.message || result.stderr?.slice(-2000) || `${name} 未生成完整 PDF`)
  }
  console.log(`PASS ${name}: ${fs.statSync(pdf).size} bytes`)
}
