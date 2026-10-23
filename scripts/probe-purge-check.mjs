/** 真实 HTTP 门闩：删除发生在探测发出后、响应到达前，旧轮次不能复活历史。 */
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'

const temp = fs.mkdtempSync(path.join(process.cwd(), '.dsh-progress/probe-purge-'))
Object.assign(process.env, {
  DATABASE_PATH: path.join(temp, 'test.sqlite'), TARGETS_JSON: '[]',
  SESSION_SECRET: 'probe-purge-test-only-secret', SITE_ORIGIN: 'http://127.0.0.1',
  PROBE_TIMEOUT_MS: '10000', MEDIA_DIR: path.join(temp, 'media'), BACKUP_DIR: path.join(temp, 'backups'),
})
const { initStore, closeStore, recordResults } = await import('../dist/store.js')
const { createTarget, purgeTarget, removeOrDisableTarget } = await import('../dist/targets-store.js')
const { probeAll } = await import('../dist/probe.js')
const db = initStore()
let arrived
const server = http.createServer((req, res) => {
  if (req.url === '/hold') { arrived.resolve(() => { res.writeHead(200); res.end('ok') }); return }
  res.writeHead(200); res.end('control')
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}`
createTarget({ id: 'control', name: '不应丢失的同轮目标', url: base, enabled: true })
let failures = 0
try {
  for (const mode of ['purge', 'purge-recreate', 'delete']) {
    arrived = Promise.withResolvers()
    createTarget({ id: mode, name: mode, url: base + '/hold', enabled: true })
    if (mode !== 'delete') {
      const at = Date.now() - 1000
      recordResults([{ targetId: mode, at, roundAt: at, status: 'up', latencyMs: 1, statusCode: 200, error: null }])
    }
    const deadline = setTimeout(() => arrived.reject(new Error('探测未到达本机门闩')), 15000)
    const round = probeAll()
    let release
    try { release = await arrived.promise } finally { clearTimeout(deadline) }
    if (mode === 'delete') removeOrDisableTarget(mode)
    else purgeTarget(mode)
    if (mode === 'purge-recreate') createTarget({ id: mode, name: '重建后的新目标', url: base, enabled: false })
    release()
    const results = await round
    const rows = db.prepare('SELECT COUNT(*) AS n FROM probes WHERE target_id = ?').get(mode).n
    const ok = rows === 0 && results.some((r) => r.targetId === 'control') && !results.some((r) => r.targetId === mode)
    console.log(`${ok ? 'PASS' : 'FAIL'} ${mode}: old rows=${rows}, returned=${results.map((r) => r.targetId).join(',')}`)
    if (!ok) failures++
  }
} finally {
  server.closeAllConnections()
  await new Promise((resolve) => server.close(resolve))
  closeStore()
}
console.log(`${3 - failures}/3 通过`)
process.exitCode = failures ? 1 : 0
