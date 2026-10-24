import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'status-reliability-'))
Object.assign(process.env, {
  DATABASE_PATH: path.join(dir, 'test.sqlite'), TARGETS_JSON: '[]',
  SITE_ORIGIN: 'http://localhost:43963', SESSION_SECRET: 'isolated-status-regression-secret',
  MEDIA_DIR: path.join(dir, 'media'), BACKUP_DIR: path.join(dir, 'backup'),
  ADMIN_USERNAME: 'status-admin', ADMIN_PASSWORD: 'status-test-password', SESSION_COOKIE_SECURE: '0',
})
const S = await import('../dist/store.js')
const now = Date.now(), minute = 60_000, hour = 60 * minute, day = 24 * hour
const gap = 3 * minute + 5000
let failures = 0, checks = 0
let app
function check(name, fn) {
  checks++
  try { fn(); console.log('PASS', name) }
  catch (e) { failures++; console.error('FAIL', name, e.message) }
}
function record(id, ago, status = 'up', latency = 100) {
  S.recordResults([{targetId:id, at:now-ago, roundAt:now-ago, status,
    latencyMs:status === 'down' ? null : latency, statusCode:status === 'down' ? null : status === 'up' ? 200 : 503,
    error:status === 'up' ? null : '状态码 503 不在预期范围内'}])
}
try {
  S.initStore()
  for (let i = 1440; i >= 1; i--) record('chart', i * minute, i <= 10 || i === 700 ? 'down' : 'up', i === 800 ? 9000 : 100)
  check('24 小时曲线包含最新失败、最早数据和单点尖峰', () => {
    const p = S.getLatencyRaw('chart', day, 120, gap, now)
    assert.equal(p.at(-1).at, now-minute)
    assert.ok(p[0].at <= now-23*hour)
    assert.ok(p.some(x => x.at === now-700*minute && x.avgLatencyMs === null))
    assert.ok(p.some(x => x.avgLatencyMs === 9000))
    assert.ok(p.length <= 120*6)
  })
  check('整体走势保留最近故障和短暂故障', () => {
    const p = S.getUptimeRaw(day, 1, 120, gap, now)
    assert.equal(p.at(-1).at, now-minute)
    assert.ok(p.some(x => x.at === now-700*minute && x.up === 0))
    assert.ok(p.length <= 120*6)
  })
  for (const [ago,status,ms] of [[10,'up',100],[9,'down',null],[8,'up',200],[7,'down',null],[6,'up',100]]) record('flapping',ago*minute,status,ms)
  check('同一桶内多次失败均断开，不跨第二次故障连线', () => {
    const p=S.getLatencyRaw('flapping',day,120,gap,now)
    assert.ok(p.some(x=>x.at===now-7*minute&&x.avgLatencyMs===null))
    assert.ok(p.some(x=>x.at===now-9*minute&&x.avgLatencyMs===null))
    assert.ok(p.some(x=>x.at===now-8*minute&&x.avgLatencyMs===200))
  })
  record('stale', 3*hour); record('stale', 2*hour)
  check('连续可用不累加缺测时间', () => {
    assert.equal(S.getStats('stale',day,undefined,gap,now).upStreakMs, 0)
  })
  record('streak', 5*minute); record('streak',4*minute); record('streak',minute)
  check('连续时长截止最后确认，不外推到当前时间', () => {
    assert.equal(S.getStats('streak',day,undefined,gap,now).upStreakMs,4*minute)
  })
  record('stale', minute)
  check('缺测后重新起算连续可用', () => assert.equal(S.getStats('stale',day,undefined,gap,now).upStreakMs,0))
  record('outside', 48*hour, 'down')
  record('events', 12*minute,'down'); record('events',11*minute,'degraded'); record('events',10*minute)
  record('events',2*minute,'down'); record('events',minute,'down')
  check('失败合并为事件，恢复与持续状态独立', () => {
    const events=S.getIncidentEvents(day,[{id:'events',maxGapMs:gap}],now)
    assert.equal(events.length,2)
    assert.equal(events[0].outcome,'ongoing'); assert.equal(events[0].durationMs,minute)
    assert.equal(events[1].outcome,'recovered'); assert.equal(events[1].endedAt,now-10*minute)
    assert.equal(events[1].at,now-12*minute)
  })
  check('不显示窗口外已结束的记录或其他目标', () => assert.equal(S.getIncidentEvents(day,[{id:'outside',maxGapMs:gap}],now).length,0))
  record('cross',day+minute,'down'); record('cross',day-minute,'down'); record('cross',day-2*minute)
  check('跨窗口事件保留真实开始时间', () => {
    const e=S.getIncidentEvents(day,[{id:'cross',maxGapMs:gap}],now)[0]
    assert.equal(e.at,now-day-minute); assert.equal(e.outcome,'recovered')
  })
  record('missing',hour,'down'); record('missing',minute,'down')
  check('缺测断开事件，不宣称一小时连续故障', () => {
    const e=S.getIncidentEvents(day,[{id:'missing',maxGapMs:gap}],now)
    assert.equal(e.length,2); assert.equal(e[1].outcome,'unknown'); assert.equal(e[1].durationMs,0)
  })
  check('重新启用不继承旧故障事件', () => assert.equal(S.getIncidentEvents(day,[{id:'events',maxGapMs:gap,enabledAt:now-30_000}],now).length,0))
  record('frozen',2*hour)
  const T=await import('../dist/targets-store.js')
  for(const id of ['chart','frozen','new']) T.createTarget({id,name:id,url:'http://example.invalid',group:'测试'},now-2*day)
  app=await (await import('../dist/server.js')).buildServer()
  const login=await app.inject({method:'POST',url:'/login',headers:{origin:process.env.SITE_ORIGIN,'content-type':'application/x-www-form-urlencoded'},payload:'username=status-admin&password=status-test-password'})
  assert.equal(login.statusCode,302)
  const cookies=login.headers['set-cookie']
  const cookie=(Array.isArray(cookies)?cookies[0]:cookies).split(';')[0]
  const api=(await app.inject({url:'/api/status',headers:{cookie}})).json()
  const html=(await app.inject({url:'/status',headers:{cookie}})).body
  check('真实 HTTP API 提供刷新时间且不泄漏配置',()=>{
    const item=api.targets.find(t=>t.id==='frozen')
    assert.equal(item.lastCheckedAt,now-2*hour); assert.equal(typeof item.staleAfterMs,'number')
    assert.equal(api.generatedAt-api.windowStartAt,day)
    assert.equal(item.url,undefined); assert.equal(item.samples,undefined)
  })
  check('SSR 过期、待探测和当前异常计数一致',()=>{
    assert.match(html,/data-metric="up">0\/3/)
    assert.match(html,/data-metric="faults">1</)
    assert.match(html,/1 个系统数据过期 · 1 个系统待探测/)
    assert.match(html,/data-target="frozen" data-state="stale"/)
    assert.match(html,/最近 24 小时可用率/)
    assert.doesNotMatch(html,/\d\.\d{3,}%/)
  })
  const home=(await app.inject({url:'/',headers:{cookie}})).body
  check('首页 SSR 使用相同新鲜度',()=>{
    assert.match(home,/0\/3/); assert.match(home,/1 个系统数据过期/)
  })
  check('API 事件由当前目标过滤且保留持续状态',()=>{
    assert.ok(api.incidents.length>0)
    assert.ok(api.incidents.every(e=>e.targetId==='chart'))
    assert.ok(api.incidents.some(e=>e.outcome==='ongoing'))
  })
} finally {
  if(app)await app.close()
  S.closeStore()
  fs.rmSync(dir,{recursive:true,force:true})
}
console.log(`${checks-failures}/${checks} status reliability checks passed`)
if(failures)process.exitCode=1
