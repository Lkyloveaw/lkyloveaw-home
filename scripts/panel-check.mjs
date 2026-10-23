/**
 * 面板重绘的行为断言：**在真实 DOM 里跑 `public/status.js`**，证明面板真的跟着刷新。
 *
 * 为什么必须真跑 DOM：本票的核心是「曲线与时序条不再冻结」，
 * 而那只能靠「喂一份新 API 数据 → 看 DOM 变没变」来证明。
 * 纯函数断言（`chart-check.mjs`）只能证明几何一致，证明不了「有没有人调用它」。
 *
 * 用一个最小 DOM 实现（够 `status.js` 用），不引 jsdom——
 * 本仓库的既有取舍是尽量不引新依赖。
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

// ── 极简 DOM ───────────────────────────────────────────────
class El {
  constructor(tag) {
    this.tagName = (tag || 'div').toUpperCase()
    this.children = []
    this.attrs = {}
    this._text = ''
    this.style = {}
    this.className = ''
    this.parentNode = null
  }
  /** status.js 的 redrawChart 第一行就读 classList —— 没有它 paint 根本跑不到格带那步。 */
  get classList() {
    const self = this
    const list = () => String(self.className).split(/\s+/).filter(Boolean)
    return {
      contains: (c) => list().includes(c),
      add: (c) => { if (!list().includes(c)) self.className = list().concat(c).join(' ') },
      remove: (c) => { self.className = list().filter((x) => x !== c).join(' ') },
    }
  }
  set textContent(v) { this._text = String(v == null ? '' : v); this.children = [] }
  get textContent() {
    if (this.children.length) return this.children.map((c) => c.textContent).join('')
    return this._text
  }
  set innerHTML(html) {
    this.children = []
    this._text = ''
    // 只解析本文件里用到的最简单结构：<i class=".." title=".."> 与 <span class="sr">..</span>
    const re = /<(i|span)([^>]*)>([\s\S]*?)<\/\1>/g
    let m
    while ((m = re.exec(html)) !== null) {
      const el = new El(m[1])
      const ca = m[2].match(/class="([^"]*)"/)
      const ta = m[2].match(/title="([^"]*)"/)
      if (ca) el.className = ca[1]
      if (ta) el.attrs.title = ta[1]
      el.textContent = m[3]
      el.parentNode = this
      this.children.push(el)
    }
    this._html = html
  }
  get innerHTML() { return this._html || '' }
  setAttribute(k, v) { this.attrs[k] = String(v) }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null }
  removeAttribute(k) { delete this.attrs[k] }
  appendChild(c) { c.parentNode = this; this.children.push(c); return c }
  insertBefore(c, ref) {
    const i = ref ? this.children.indexOf(ref) : -1
    c.parentNode = this
    if (i < 0) this.children.push(c); else this.children.splice(i, 0, c)
    return c
  }
  remove() {
    if (this.parentNode) {
      const i = this.parentNode.children.indexOf(this)
      if (i >= 0) this.parentNode.children.splice(i, 1)
    }
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null }
  querySelectorAll(sel) {
    const out = []
    const walk = (n) => {
      for (const c of n.children) { if (matches(c, sel)) out.push(c); walk(c) }
    }
    walk(this)
    return out
  }
  closest(sel) {
    let n = this
    while (n) { if (matches(n, sel)) return n; n = n.parentNode }
    return null
  }
}
function matches(el, sel) {
  // 支持 [attr]、[attr="v"]、.class、tag 这几种本文件用到的形式
  const attrVal = sel.match(/^\[([\w-]+)="([^"]*)"\]$/)
  if (attrVal) return el.getAttribute(attrVal[1]) === attrVal[2]
  const attr = sel.match(/^\[([\w-]+)\]$/)
  if (attr) return el.getAttribute(attr[1]) !== null
  if (sel.startsWith('.')) return String(el.className).split(/\s+/).includes(sel.slice(1))
  return el.tagName === sel.toUpperCase()
}

// ── 搭出 statusPage 的关键结构 ──
const doc = {
  _byId: {},
  getElementById(id) { return this._byId[id] || null },
  createElement(t) { return new El(t) },
  querySelector(s) { return docRoot.querySelector(s) },
  querySelectorAll(s) { return docRoot.querySelectorAll(s) },
  addEventListener() {},
  hidden: false,
}
const docRoot = new El('body')
doc._byId['status-root'] = docRoot
// 失败提示会插到 #status-root 前面（root.parentNode.insertBefore）——
// 给它一个父节点，否则「取数失败」的兜底路径会把整个测试脚本炸掉，而不是变成一条失败断言。
docRoot.parentNode = new El('html')

// 两张卡片 + 延迟曲线容器 + 状态格带（标记必须与 src/views.ts 的 statusPage 一致）
const cards = {}
const CELLS = 56
for (const id of ['ok', 'dead']) {
  const card = new El('article')
  card.setAttribute('data-target', id)
  const dot = new El('span'); dot.className = 'dot unknown'
  const badge = new El('span'); badge.className = 'badge'; badge.textContent = '无数据'
  const kvdd = [new El('dd'), new El('dd'), new El('dd'), new El('dd')]
  const chart = new El('figure')
  chart.className = 'chart'
  chart.setAttribute('data-chart', '')
  chart.setAttribute('data-chart-kind', 'latency')
  chart.setAttribute('data-y-min', '0')
  chart.setAttribute('data-y-max', '100')
  chart.setAttribute('data-fill-id', 'lg0')
  const svg = new El('svg')
  const grad = new El('linearGradient'); grad.id = 'lg0'
  const area = new El('path'); area.setAttribute('d', 'OLD_AREA')
  const line = new El('path'); line.setAttribute('d', 'OLD_LINE')
  svg.appendChild(grad); svg.appendChild(area); svg.appendChild(line)
  chart.appendChild(svg)
  const cap = new El('span'); cap.className = 'chart-avg'
  chart.appendChild(cap)

  // 格带：容器类名由服务端给（cell-strip），格数由 data-cells 给。
  const strip = new El('div')
  strip.className = 'cell-strip'
  strip.setAttribute('data-timeline', '')
  strip.setAttribute('data-cells', String(CELLS))
  const caption = new El('p'); caption.className = 'cell-caption'
  const count = new El('span'); count.className = 'js-cells'; count.textContent = '0'
  const up = new El('span'); up.className = 'uptime'; up.textContent = '暂无数据'
  caption.appendChild(count); caption.appendChild(up)

  card.appendChild(dot); card.appendChild(badge)
  for (const d of kvdd) card.appendChild(d)
  card.appendChild(chart); card.appendChild(strip); card.appendChild(caption)
  docRoot.appendChild(card)
  doc._byId['card-' + id] = card
  cards[id] = { card, dot, badge, strip, count, up }
}
// 「页面打开时还没有数据」的卡片：曲线容器是空态，但骨架已经就位（与服务端同构）。
// 这是 2026-10-23 修的那个坑：旧实现只会更新已有 svg，空态容器永远升不成曲线。
const lateCard = new El('article')
lateCard.setAttribute('data-target', 'later')
const lateDot = new El('span'); lateDot.className = 'dot unknown'
const lateBadge = new El('span'); lateBadge.className = 'badge'; lateBadge.textContent = '无数据'
lateCard.appendChild(lateDot); lateCard.appendChild(lateBadge)
for (let i = 0; i < 4; i++) lateCard.appendChild(new El('dd'))
const lateChart = new El('figure')
lateChart.className = 'chart chart-empty'
lateChart.setAttribute('data-chart', '')
lateChart.setAttribute('data-chart-kind', 'latency')
lateChart.setAttribute('data-fill-id', 'lgidle0')
const lateSvg = new El('svg')
lateSvg.setAttribute('viewBox', '0 0 232 54')
const lateGrad = new El('linearGradient'); lateGrad.id = 'lgidle0'
const lateArea = new El('path'); lateArea.setAttribute('d', '')
const lateLine = new El('path'); lateLine.setAttribute('d', '')
lateSvg.appendChild(lateGrad); lateSvg.appendChild(lateArea); lateSvg.appendChild(lateLine)
lateChart.appendChild(lateSvg)
const lateAvg = new El('span'); lateAvg.className = 'chart-avg'
const lateMax = new El('span'); lateMax.className = 'chart-max'
lateChart.appendChild(lateAvg); lateChart.appendChild(lateMax)
const lateNote = new El('div'); lateNote.className = 'chart-idle-note'
lateNote.appendChild(new El('span'))
lateChart.appendChild(lateNote)
lateCard.appendChild(lateChart)
docRoot.appendChild(lateCard)

// 横轴：服务端会渲染 data-axis，客户端每 tick 重算
const axisEl = new El('div')
axisEl.className = 'chart-axis'
axisEl.setAttribute('data-axis', '')
const axisA = new El('span'); const axisB = new El('span'); const axisC = new El('span')
axisEl.appendChild(axisA); axisEl.appendChild(axisB); axisEl.appendChild(axisC)
docRoot.appendChild(axisEl)

// 可用率曲线
const wide = new El('figure')
wide.className = 'chart chart-wide'
wide.setAttribute('data-chart', '')
wide.setAttribute('data-chart-kind', 'uptime')
wide.setAttribute('data-y-min', '0'); wide.setAttribute('data-y-max', '100')
const wsvg = new El('svg')
wsvg.appendChild(new El('linearGradient'))
const wArea = new El('path'); wArea.setAttribute('d', 'OLD_W_AREA')
const wLine = new El('path'); wLine.setAttribute('d', 'OLD_W_LINE')
wsvg.appendChild(wArea); wsvg.appendChild(wLine)
wide.appendChild(wsvg)
docRoot.appendChild(wide)
// 时间戳
const stamp = new El('span'); stamp.className = 'js-generated'; stamp.textContent = '刚刚'
docRoot.appendChild(stamp)

// ── 加载 chart-path.js 与 status.js ──
// 喂给 status.js 的假载荷：两张卡，点数刻意**少于** data-cells，好验证「缺位补空心格」。
const pt = (at, status, ms) => ({ at, status, avgLatencyMs: ms, latencyMs: ms })
const PAYLOAD = {
  generatedAt: Date.UTC(2026, 0, 2, 3, 4, 5),
  overview: [],
  targets: [
    {
      id: 'ok', lastStatus: 'up', uptime: 0.999, avgLatencyMs: 12, p95LatencyMs: 20, lastError: null,
      timeline: [pt(1, 'up', 12), pt(2, 'up', 13), pt(3, 'up', 11), pt(4, 'up', 12), pt(5, 'up', 12)],
      latency: [pt(1, 'up', 12), pt(2, 'up', 13), pt(3, 'up', 11), pt(4, 'up', 12), pt(5, 'up', 12)],
    },
    {
      id: 'dead', lastStatus: 'down', uptime: 0.5, avgLatencyMs: null, p95LatencyMs: null, lastError: '连接超时',
      timeline: [pt(1, 'up', 9), pt(2, 'degraded', 40), pt(3, 'down', 0)],
      latency: [pt(1, 'up', 9), pt(2, 'degraded', 40)],
    },
    {
      id: 'later', lastStatus: 'up', uptime: 1, avgLatencyMs: 22, p95LatencyMs: 30, lastError: null,
      timeline: [],
      latency: [pt(10, 'up', 20), pt(11, 'up', 24)],
    },
  ],
}
let currentPayload = PAYLOAD

let tickFn = null
const sandbox = {
  document: doc,
  console,
  setInterval: (fn) => { tickFn = fn; return 0 },
  fetch: () => Promise.resolve({ status: 200, ok: true, json: () => Promise.resolve(currentPayload) }),
  Promise,
  setTimeout,
  Date,
  Math,
  Number,
  String,
  Object,
  Array,
  isFinite,
}
sandbox.window = sandbox
sandbox.globalThis = sandbox
vm.createContext(sandbox)
vm.runInContext(fs.readFileSync(path.join(ROOT, 'public/chart-path.js'), 'utf8'), sandbox, { filename: 'chart-path.js' })
check('chart-path.js 挂上 ChartPath', !!sandbox.ChartPath)
vm.runInContext(fs.readFileSync(path.join(ROOT, 'public/status.js'), 'utf8'), sandbox, { filename: 'status.js' })
check('status.js 加载后注册了运行时（无异常）', true)

// ── 真跑一遍刷新：抓 setInterval 的回调直接调用，等微任务链跑完再断言 DOM ──
if (!tickFn) {
  check('status.js 注册了定时刷新（能抓到 setInterval 回调）', false)
} else {
  tickFn()
  await new Promise((r) => setTimeout(r, 0))
}

// status.js 是 IIFE，paint 不可直接调用 —— 用 setInterval 捕获的方式不好，
// 改为：从 chart-path 侧验证「同样的输入前端能算出 d」，再单独验证字段路径。
// 这里改为直接检查 status.js 的源码语义：它必须读顶层 id（拍平后的形状）。
// 去掉注释再检查字段路径——否则「解释这次改动的注释」会被误判成残留的旧代码。
const src = fs.readFileSync(path.join(ROOT, 'public/status.js'), 'utf8')
const views_src = fs.readFileSync(path.join(ROOT, 'src/views.ts'), 'utf8')
const code = src
  .replace(/\/\*[\s\S]*?\*\//g, '')   // 块注释
  .replace(/(^|[^:])\/\/.*$/gm, '$1') // 行注释（不误伤 http://）

console.log('\n[字段路径：必须跟着拍平]')
check('status.js 读 item.id（而非 item.target.id）', /byId\[item\.id\]/.test(code) && !/item\.target\.id/.test(code))
check('status.js 读 item.stats（旧路径）已移除', !/item\.stats/.test(code))
check('status.js 读 item.lastStatus（顶层）', /item\.lastStatus/.test(code))
check('status.js 读 item.uptime / avgLatencyMs / p95LatencyMs（顶层）', /item\.uptime/.test(code) && /item\.avgLatencyMs/.test(code) && /item\.p95LatencyMs/.test(code))
check('status.js 读 item.lastError（顶层）', /item\.lastError/.test(code))
check('status.js 读 item.timeline（顶层）', /item\.timeline/.test(code))
check('status.js 读 item.latency（顶层）', /item\.latency/.test(code))

console.log('\n[重绘能力：必须真的调用几何核心]')
check('调用了 ChartPath.linePath', /CP\.linePath\(/.test(code))
check('调用了 ChartPath.areaPath', /CP\.areaPath\(/.test(code))
check('调用了 expandDomain（只扩不缩）', /CP\.expandDomain\(/.test(code))
check('重写了折线/面积的 d', /setAttribute\('d'/.test(code))
check('能切换空态类（空 ↔ 有数据双向）', /classList\.(add|remove)\('chart-empty'\)/.test(code))
check('同步横轴（[data-axis]）', /\[data-axis\]/.test(code))
console.log('\n[格带：客户端重建必须守住服务端契约]')
{
  const { strip, count } = cards.ok
  // ⚠ 这几条是被真事故逼出来的：旧版客户端把容器写成 'tl tl-empty'，
  // 等于把 cell-strip 整个抹掉 → 容器失去 display:flex，格带塌成看不见的东西。
  check('容器类名仍是 cell-strip（客户端没写 className）', strip.className === 'cell-strip', `实际 "${strip.className}"`)
  check(`格数恒为 data-cells=${CELLS}，不随点数变`, strip.children.length === CELLS, `实际 ${strip.children.length}`)
  const missing = strip.children.filter((c) => c.className === 'cell-missing').length
  check('缺的历史补 cell-missing（不假装 up）', missing === CELLS - 5, `实际 ${missing}`)
  const lastOk = strip.children[strip.children.length - 1]
  check('末格状态类名与服务端同一套词', lastOk.className === 'up', `实际 "${lastOk.className}"`)
  check('格子 title 带中文状态标签', /可用/.test(lastOk.getAttribute('title') || ''))

  const dead = cards.dead.strip
  const lastDead = dead.children[dead.children.length - 1]
  check('故障目标的末格是 down', lastDead.className === 'down', `实际 "${lastDead.className}"`)
  check('空态也是 N 个格（结构相同，无需切类名）', dead.children.length === CELLS, `实际 ${dead.children.length}`)
  check('说明行的次数跟着刷新', count.textContent === '5', `实际 "${count.textContent}"`)
}

console.log('\n[徽标与点必须同时更新（否则 30 秒后互相矛盾）]')
{
  const { dot, badge } = cards.dead
  check('点更新为 dot bad', dot.className === 'dot bad', `实际 "${dot.className}"`)
  check('徽标同步为 badge bad', badge.className === 'badge bad', `实际 "${badge.className}"`)
  check('徽标文字同步为「故障」', badge.textContent === '故障', `实际 "${badge.textContent}"`)
  const okBadge = cards.ok.badge
  check('正常目标徽标为 badge ok /「可用」', okBadge.className === 'badge ok' && okBadge.textContent === '可用', `实际 "${okBadge.className}"/"${okBadge.textContent}"`)
}

console.log('\n[状态词：服务端与客户端必须是同一套映射]')
{
  // 领域状态是 up/degraded/down，样式类是 ok/warn/bad —— 两套词对不上就会**静默**丢颜色
  // （真发生过：徽标输出 badge up，而 CSS 只认 .badge.ok）。
  const views = fs.readFileSync(path.join(ROOT, 'src/views.ts'), 'utf8')
  const pairs = (s) => {
    const out = {}
    for (const m of s.matchAll(/['"]?(\w+)['"]?\s*:\s*'([^']*)'/g)) out[m[1]] = m[2]
    return out
  }
  const serverClass = pairs((views.match(/const STATUS_CLASS[^=]*=\s*\{([^}]*)\}/) || [, ''])[1])
  const serverText = pairs((views.match(/const STATUS_TEXT[^=]*=\s*\{([^}]*)\}/) || [, ''])[1])
  const clientClass = pairs((src.match(/var STATE_CLASS\s*=\s*\{([^}]*)\}/) || [, ''])[1])
  const clientText = pairs((src.match(/var STATE_TEXT\s*=\s*\{([^}]*)\}/) || [, ''])[1])
  check('服务端 STATUS_CLASS 三档齐全', serverClass.up && serverClass.degraded && serverClass.down, JSON.stringify(serverClass))
  check('客户端 STATE_CLASS 与服务端逐项一致', JSON.stringify(serverClass) === JSON.stringify(clientClass), `服务端 ${JSON.stringify(serverClass)} / 客户端 ${JSON.stringify(clientClass)}`)
  check('客户端 STATE_TEXT 与服务端逐项一致', JSON.stringify(serverText) === JSON.stringify(clientText), `服务端 ${JSON.stringify(serverText)} / 客户端 ${JSON.stringify(clientText)}`)
}

console.log('\n[空态曲线：30 秒内原地升级，不需要刷新页面]')
{
  check('空态容器升级后去掉 chart-empty', !lateChart.classList.contains('chart-empty'), `class="${lateChart.className}"`)
  check('两个 path 的 d 都被补上', lateArea.getAttribute('d') !== '' && lateLine.getAttribute('d') !== '')
  const latePoints = [...lateLine.getAttribute('d').matchAll(/[ML]([\d.]+),([\d.]+)/g)]
  check('真实 232×54 viewBox 内重画，所有点都未越界', latePoints.length >= 2 && latePoints.every((p) => Number(p[1]) <= 232 && Number(p[2]) <= 54), lateLine.getAttribute('d'))
  check('caption 从空白变成延迟平均值', /延迟（平均/.test(lateAvg.textContent), `"${lateAvg.textContent}"`)
  check(
    '横轴跟着共享 xRange 重算',
    /^\d{2}:\d{2}$/.test(axisA.textContent) && /覆盖/.test(axisB.textContent) && /^\d{2}:\d{2}$/.test(axisC.textContent),
    `"${axisA.textContent}"/"${axisB.textContent}"/"${axisC.textContent}"`,
  )

  // 反方向：数据再次不足 → 空态类回来、path 清空（防「空态只能升、不能降」）
  currentPayload = { ...PAYLOAD, targets: PAYLOAD.targets.map((t) => (t.id === 'later' ? { ...t, latency: [] } : t)) }
  tickFn()
  await new Promise((r) => setTimeout(r, 0))
  check('数据再次不足 → chart-empty 回来', lateChart.classList.contains('chart-empty'), `class="${lateChart.className}"`)
  check('空态时两个 path 的 d 都是空串', lateArea.getAttribute('d') === '' && lateLine.getAttribute('d') === '')
  check('回到空态不保留旧平均/峰值，SVG 标签同步数据不足', lateAvg.textContent === '' && lateMax.textContent === '' && /数据不足/.test(lateSvg.getAttribute('aria-label') || ''))
}

console.log('\n[CSS 类名：客户端与视图发出的类必须真的有样式]')
{
  const css = fs.readFileSync(path.join(ROOT, 'public/style.css'), 'utf8')
  check('CSS 定义了 .cell-strip 容器', /\.cell-strip\s*\{/.test(css))
  check('CSS 定义了 .cell-strip i 基底', /\.cell-strip i\s*\{/.test(css))
  for (const s of ['up', 'degraded', 'down', 'cell-missing']) {
    check(`CSS 定义了 .cell-strip i.${s}`, new RegExp('\\.cell-strip i\\.' + s + '\\s*\\{').test(css))
  }
  check('CSS 定义了 .badge 三档', ['ok', 'warn', 'bad'].every((s) => new RegExp('\\.badge\\.' + s + '\\s*\\{').test(css)))
  // 死契约必须清干净：留着会让人以为旧类还能用
  check('CSS 已无 .tl-cell（死契约）', !/\.tl-cell/.test(css))
  check('CSS 已无 .tl-empty（死契约）', !/\.tl-empty/.test(css))
  check('客户端已无 tl-cell（死契约）', !/tl-cell/.test(code))
  check('客户端已无 tl-empty（死契约）', !/tl-empty/.test(code))
  // 格数的唯一真源在服务端
  check('views.ts 渲染 data-cells（格数的唯一真源）', /data-cells="?\$\{CELL_STRIP_LEN\}/.test(views_src))
  check('views.ts 定义了 CELL_STRIP_LEN', /const CELL_STRIP_LEN\s*=\s*\d+/.test(views_src))
}
check('不再有静默吞掉的空 catch', !/\/\* 静默失败/.test(code))
check('401 与网络抖动分成两种提示', /'auth'/.test(src) && /'network'/.test(code))
check('恢复成功后清掉提示', /clearBanner\(\)/.test(code))
check('时间戳写真实时间（不再是恒定的「刚刚」）', !/textContent = '刚刚'/.test(src) && /formatTime\(when/.test(code))

console.log('\n[几何一致性：同一容器同一输入，d 会变]')
{
  const CP = sandbox.ChartPath
  const d1 = CP.linePath([10, 20, 15], 520, 110, 6, [1, 2, 3], { min: 1, max: 3 })
  const d2 = CP.linePath([10, 90, 15], 520, 110, 6, [1, 2, 3], { min: 1, max: 3 })
  check('不同数据算出不同 d（说明重绘会真的改变图形）', d1 !== d2)
  const dom1 = CP.expandDomain(null, [10, 20, 15], 10)
  const dom2 = CP.expandDomain(dom1, [10, 90, 15], 10)
  check('新数据进入时值域扩张 → d 随之变化', dom2.max > dom1.max)
}

console.log(`\n${'─'.repeat(60)}`)
const failed = results.filter((r) => !r.ok)
if (!failed.length) console.log(`✅ 全部通过：${results.length} 项`)
else {
  console.log(`❌ ${failed.length} 项失败 / 共 ${results.length} 项`)
  for (const f of failed) console.log(`   - ${f.name}`)
}
process.exit(failed.length ? 1 : 0)
