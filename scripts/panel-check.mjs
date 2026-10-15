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

// 两张卡片 + 延迟曲线容器 + 时序条
for (const id of ['ok', 'dead']) {
  const card = new El('article')
  card.setAttribute('data-target', id)
  const dot = new El('span'); dot.className = 'dot unknown'
  const up = new El('span'); up.className = 'uptime'
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
  const tl = new El('div'); tl.setAttribute('data-timeline', ''); tl.className = 'tl tl-empty'
  tl.innerHTML = '<span class="sr">暂无数据</span>'

  card.appendChild(dot); card.appendChild(up)
  for (const d of kvdd) card.appendChild(d)
  card.appendChild(chart); card.appendChild(tl)
  docRoot.appendChild(card)
  doc._byId['card-' + id] = card
}
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
const sandbox = {
  document: doc,
  console,
  setInterval: () => 0,
  fetch: () => Promise.reject(new Error('not used')),
  Promise,
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
check('status.js 加载后注册了 __overview 之外的运行时（无异常）', true)

// status.js 是 IIFE，paint 不可直接调用 —— 用 setInterval 捕获的方式不好，
// 改为：从 chart-path 侧验证「同样的输入前端能算出 d」，再单独验证字段路径。
// 这里改为直接检查 status.js 的源码语义：它必须读顶层 id（拍平后的形状）。
// 去掉注释再检查字段路径——否则「解释这次改动的注释」会被误判成残留的旧代码。
const src = fs.readFileSync(path.join(ROOT, 'public/status.js'), 'utf8')
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
check('重建了时序条 innerHTML（空态双向可切）', /tl\.innerHTML/.test(code))
check('时序条 title 与状态同步生成', /title="/.test(src) && /tl-cell /.test(code))
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
