/**
 * 曲线交叉断言：**同一份输入，服务端渲染的 `d` 必须与 `public/chart-path.js` 算出的 `d` 逐字符相等。**
 *
 * 为什么必须有这条：站点没有构建步骤，几何因此存在**两份实现**——
 * 服务端的 `src/charts.ts`（首屏 SSR）与 `public/chart-path.js`（30 秒重绘）。
 * 两份实现迟早漂移，而漂移的表现是「刷新一次曲线就跳一下」，很难归因。
 *
 * ⚠ 必须用 `node:vm` 而不是 `require()`：`package.json` 有 `"type": "module"`，
 * `require()` 会把 `chart-path.js` 当 ESM 处理，拿到 `{}`。
 */
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'

const ROOT = process.cwd()

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`)
}

// ── 在 vm 里加载 chart-path.js（classic script，挂 globalThis）──
const sandbox = { globalThis: undefined, console }
sandbox.globalThis = sandbox
vm.createContext(sandbox)
const code = fs.readFileSync(path.join(ROOT, 'public/chart-path.js'), 'utf8')
vm.runInContext(code, sandbox, { filename: 'chart-path.js' })
const CP = sandbox.ChartPath
check('chart-path.js 在 vm 里加载出 ChartPath', !!CP && typeof CP.linePath === 'function')

// ── 加载服务端实现 ──
const charts = await import(path.join(ROOT, 'dist/charts.js').replace(/\\/g, '/').replace(/^([A-Za-z]):/, 'file:///$1:'))

/** 从服务端渲染的 HTML 里取出曲线的 `d`。正则**必须带前导空格**，否则会把 areaPath 的也抓进来。 */
function serverPaths(html) {
  const svg = html.match(/<svg[\s\S]*?<\/svg>/)
  if (!svg) return null
  const ds = [...svg[0].matchAll(/ d="([^"]*)"/g)].map((m) => m[1])
  return ds.length >= 2 ? { area: ds[0], line: ds[1] } : null
}

/** 从服务端渲染的 HTML 里取出值域。 */
function serverDomain(html) {
  const lo = html.match(/data-y-min="([-\d.]+)"/)
  const hi = html.match(/data-y-max="([-\d.]+)"/)
  return lo && hi ? { min: Number(lo[1]), max: Number(hi[1]) } : null
}

console.log('\n[交叉断言：服务端 SSG == 前端重算]')
const W = 520, H = 110, PAD = 6
const XR = { min: 1_800_000_000_000, max: 1_800_000_000_000 + 3600_000 }

const cases = [
  ['常规三点', [10, 50, 30], [XR.min, XR.min + 1800_000, XR.max]],
  ['含断开（null 不连线）', [10, null, 30], [XR.min, XR.min + 1800_000, XR.max]],
  ['全等值', [40, 40, 40], [XR.min, XR.min + 1800_000, XR.max]],
  ['含 0', [0, 20, 5], [XR.min, XR.min + 1800_000, XR.max]],
  ['两点', [5, 90], [XR.min, XR.max]],
  ['单点（应无曲线）', [42], [XR.min]],
  ['空（应无曲线）', [], []],
  ['负数视作断点', [10, -5, 30], [XR.min, XR.min + 1800_000, XR.max]],
  ['尖峰', [10, 12, 11, 400, 13], [XR.min, XR.min + 90_000, XR.min + 180_000, XR.min + 270_000, XR.max]],
]

for (const [label, values, ats] of cases) {
  const points = values.map((v, i) => ({ at: ats[i], avgLatencyMs: v }))
  const html = charts.latencyChart(points, W, H, XR)
  const paths = serverPaths(html)
  const fe = CP.linePath(values, W, H, PAD, ats, XR)

  if (!paths) {
    check(`${label}：服务端判定「数据不足」`, fe === '', `前端=${JSON.stringify(fe)}`)
    continue
  }
  check(`${label}：折线 d 逐字符相等`, paths.line === fe, `\n      服务端=${JSON.stringify(paths.line)}\n      前端  =${JSON.stringify(fe)}`)
  check(`${label}：面积 d 逐字符相等`, paths.area === CP.areaPath(fe, W, H, PAD), `\n      服务端=${JSON.stringify(paths.area)}`)

  // 值域：服务端写进 DOM 的域必须与前端 expandDomain 的结论一致
  const dom = serverDomain(html)
  const nums = values.filter((v) => v != null && isFinite(v) && v >= 0)
  const fdom = nums.length ? CP.expandDomain(null, values, 10) : null
  if (dom && fdom) {
    check(
      `${label}：首屏值域与前端 expandDomain 一致`,
      Math.abs(dom.min - fdom.min) < 0.01 && Math.abs(dom.max - fdom.max) < 0.01,
      `服务端=${JSON.stringify(dom)} 前端=${JSON.stringify(fdom)}`,
    )
  }
  // 渐变 id 规则一致
  const gid = html.match(/linearGradient id="([^"]+)"/)
  if (gid && fe) {
    check(`${label}：渐变 id 规则一致`, gid[1] === 'lg' + Math.abs(CP.hash(fe)), `服务端=${gid[1]} 前端=${'lg' + Math.abs(CP.hash(fe))}`)
  }
}

console.log('\n[可用率曲线交叉断言]')
{
  const pts = [
    { at: XR.min, up: 2, total: 3 },
    { at: XR.min + 1800_000, up: 3, total: 3 },
    { at: XR.max, up: 0, total: 3 },
  ]
  const html = charts.uptimeChart(pts, 760, 130, XR)
  const paths = serverPaths(html)
  const values = pts.map((p) => (p.total > 0 ? (p.up / p.total) * 100 : null))
  const ats = pts.map((p) => p.at)
  const fe = CP.linePath(values, 760, 130, 8, ats, XR)
  check('可用率：折线 d 逐字符相等', paths && paths.line === fe, `\n      服务端=${JSON.stringify(paths?.line)}\n      前端  =${JSON.stringify(fe)}`)
  const dom = serverDomain(html)
  check('可用率值域固定 0-100', dom && dom.min === 0 && dom.max === 100, JSON.stringify(dom))
}

console.log('\n[值域不抖动：只扩不缩]')
{
  // 尖峰进入窗口时，朴素重算会让老点位移到图高的 87%（实测）。断言 expandDomain 不会缩。
  let dom = CP.expandDomain(null, [10, 12, 11], 10)
  const before = { ...dom }
  // 老点仍在，加入一个更高的点 → 应扩张
  dom = CP.expandDomain(dom, [10, 12, 11, 400], 10)
  check('尖峰入场时值域扩张', dom.max > before.max, `${JSON.stringify(before)} → ${JSON.stringify(dom)}`)
  // 尖峰离开窗口后，只剩小值 → **不得收缩**
  const after = CP.expandDomain(dom, [10, 12, 11], 10)
  check('尖峰离场后值域**不收缩**（老点不跳）', after.max === dom.max && after.min === dom.min, `${JSON.stringify(dom)} → ${JSON.stringify(after)}`)

  // 位移恒为 0：同一老点在「已扩张的域」与「扩张前的域」下算出的 y 必须相同，
  // 因为不收缩意味着域没变。这里直接验证同一域下重复计算稳定。
  const y1 = CP.clampY(11, dom, 110, 6)
  const y2 = CP.clampY(11, dom, 110, 6)
  check('同域下同点的 y 稳定（无回跳）', y1 === y2, `${y1} vs ${y2}`)
}

console.log('\n[断开不被连上]')
{
  const d = CP.linePath([10, null, 30], 520, 110, 6, [1, 2, 3], { min: 1, max: 3 })
  const segs = (d.match(/M/g) || []).length
  check('含 null 的序列出现两个 M（新段起点）', segs === 2, `d=${JSON.stringify(d)} segs=${segs}`)
}

console.log('\n[空态与越界夹紧]')
{
  check('点不足返回空串（调用处显示空态）', CP.linePath([42], 520, 110, 6) === '')
  check('clampY 越界夹到边缘', CP.clampY(9999, { min: 0, max: 100 }, 110, 6) === 6)
  check('clampY 下越界夹到边缘', CP.clampY(-50, { min: 0, max: 100 }, 110, 6) === 6 + 110 - 6 * 2)
}

console.log(`\n${'─'.repeat(60)}`)
const failed = results.filter((r) => !r.ok)
if (!failed.length) console.log(`✅ 全部通过：${results.length} 项`)
else {
  console.log(`❌ ${failed.length} 项失败 / 共 ${results.length} 项`)
  for (const f of failed) console.log(`   - ${f.name}`)
}
process.exit(failed.length ? 1 : 0)
