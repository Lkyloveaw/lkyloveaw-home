/** 可重复的产品视觉验收：仅使用 .dsh-progress 下的合成数据，不读写真实 data/。 */
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import { randomBytes } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { assertPortFree } from './lib/port-guard.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const port = Number(process.env.CLAUDE_PREVIEW_PORT || 4387)
if (!Number.isInteger(port) || port < 1024 || port > 65534) throw new Error('CLAUDE_PREVIEW_PORT 必须在 1024–65534 之间')
const probePort = port + 1
await assertPortFree(port, 'Claude 产品预览')
await assertPortFree(probePort, 'Claude 合成探测目标')
if (!fs.existsSync(path.join(root, 'dist/server.js'))) throw new Error('请先运行 npm run build')
const progress = path.join(root, '.dsh-progress')
fs.mkdirSync(progress, { recursive: true })
const dir = fs.mkdtempSync(path.join(progress, 'claude-preview-'))
const content = path.join(dir, 'content')
fs.mkdirSync(content)
for (const name of fs.readdirSync(path.join(root, 'content'))) {
  if (name.endsWith('.md')) fs.copyFileSync(path.join(root, 'content', name), path.join(content, name))
}
fs.writeFileSync(path.join(content, 'visual-table.md'), `---
title: 长表格与中文阅读验收
slug: visual-table
date: 2026-10-23
tags: [验收, 运维]
---
## 阅读与交互

这是一篇仅存在于预览库的文章，用于检查中文标题、正文、链接与宽表格。正文应保持居中，公开侧栏始终列出全部已发布文章。

| 业务系统 | 环境与部署方式 | 当前探测结果 | 最近一次维护说明 | 后续处理计划 |
| --- | --- | --- | --- | --- |
| 内网知识库 | 裸机与 systemd 服务 | 可用，响应稳定 | 验证历史数据与登录会话在重启后保留 | 保持当前部署方式并按需查看日志 |
| 团队资料索引 | 仅本地合成的验收数据 | 异常，连通但返回非预期状态码 | 该行用于验证窄屏宽表原地横向滚动 | 页面本身不得出现横向溢出 |

### 下一步

返回[系统可用性](/status)，或查看[关于](/about)。
`)
fs.writeFileSync(path.join(content, 'visual-draft.md'), '---\ntitle: 不应出现在公开侧栏的草稿\nslug: visual-draft\ndate: 2026-10-23\ndraft: true\n---\n草稿只在管理台可见。\n')

const env = {
  ...process.env, NODE_ENV: 'test', HOST: '127.0.0.1', PORT: String(port),
  DATABASE_PATH: path.join(dir, 'preview.sqlite'), CONTENT_DIR: content,
  MEDIA_DIR: path.join(dir, 'media'), BACKUP_DIR: path.join(dir, 'backups'),
  SESSION_SECRET: randomBytes(32).toString('hex'), SESSION_COOKIE_SECURE: '0',
  SITE_ORIGIN: `http://127.0.0.1:${port}`, TRUST_PROXY: '',
  SITE_TITLE: '个人站', SITE_DESCRIPTION: '分享实践、记录系统，也把日常想法留在这里。',
  ADMIN_USERNAME: '', ADMIN_PASSWORD: '', PROBE_INTERVAL_SECONDS: '5',
  PROBE_TIMEOUT_MS: '1000', BACKUP_EVERY_ROUNDS: '0', CHECKPOINT_EVERY_ROUNDS: '0',
  TARGETS_JSON: JSON.stringify([
    { id: 'preview-up', name: '知识库', group: '工作台', url: `http://127.0.0.1:${probePort}/up` },
    { id: 'preview-degraded', name: '资料索引', group: '工作台', url: `http://127.0.0.1:${probePort}/degraded`, expectStatus: [200] },
    { id: 'preview-down', name: '实验服务', group: '工作台', url: `http://127.0.0.1:${probePort}/down` },
  ]),
}
const password = 'preview-only-pass-123'
for (const args of [
  ['dist/cli/passwd.js', '--user', 'preview-admin', '--password', password],
  ['dist/cli/passwd.js', '--user', 'preview-admin', '--role', 'admin'],
  ['dist/cli/passwd.js', '--user', 'preview-reader', '--password', password],
  ['dist/cli/passwd.js', '--user', 'preview-user-with-a-very-long-display-name', '--password', password],
  ['dist/cli/articles.js', '--reimport'],
]) {
  const result = spawnSync(process.execPath, args, { cwd: root, env, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(result.stderr || result.stdout)
}
const probes = http.createServer((req, res) => {
  if (req.url === '/down') { req.socket.destroy(); return }
  res.writeHead(req.url === '/degraded' ? 503 : 200)
  res.end('Synthetic preview target')
})
await new Promise((resolve, reject) => { probes.once('error', reject); probes.listen(probePort, '127.0.0.1', resolve) })
const server = spawn(process.execPath, ['dist/server.js'], { cwd: root, env, stdio: 'inherit' })
server.on('exit', (code) => { probes.close(); process.exitCode = code ?? 0 })
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { server.kill(); probes.close() })
console.log(`\n预览：http://127.0.0.1:${port}\n管理员：preview-admin / ${password}\n只读：preview-reader / ${password}\n长用户名：preview-user-with-a-very-long-display-name / ${password}\n合成数据：${dir}\n停止：Ctrl+C\n`)
