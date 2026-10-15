/**
 * 图表：服务端直接产出内联 SVG。
 * 为什么不用图表库：一个折线图不值得引入几十 KB 的 JS 依赖，内联 SVG 还能在禁用 JS 时照常显示。
 * 所有数值在进入 SVG 前都经过范围收敛，避免脏数据生成畸形路径。
 */
import type { LatencyPoint, OverviewPoint } from './store.js'

function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * 把一串数值映射成折线路径。返回 null 表示点太少，调用处应显示「数据不足」。
 * 传入 xAt 时用真实时间做横轴：这样同一页里多条曲线、以及"探测停了一段时间"的断档，
 * 在视觉上才是可比的（等距排布会把断档伪装成连续采样）。
 */
function linePath(
  values: Array<number | null>,
  w: number,
  h: number,
  pad: number,
  xAt?: number[],
  xRange?: { min: number; max: number },
): string | null {
  const nums = values.filter((v): v is number => v != null && Number.isFinite(v) && v >= 0)
  if (nums.length < 2) return null

  const max = Math.max(...nums)
  const min = Math.min(...nums)
  // 所有点一样高时给一个假的高度差，否则线会贴在边缘上看起来像 0。
  const span = max - min < 1 ? Math.max(max, 1) : max - min
  const stepX = values.length > 1 ? (w - pad * 2) / (values.length - 1) : 0
  const useTime = !!xAt && !!xRange && xRange.max > xRange.min

  let d = ''
  let open = false
  values.forEach((v, i) => {
    if (v == null || !Number.isFinite(v) || v < 0) {
      open = false // 断点：失败不连线，避免把断档画成"很快就好了"
      return
    }
    const x = useTime
      ? pad + (w - pad * 2) * ((xAt![i]! - xRange!.min) / (xRange!.max - xRange!.min))
      : pad + i * stepX
    const y = pad + (h - pad * 2) * (1 - (v - min) / span)
    d += `${open ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)} `
    open = true
  })
  return d.trim() || null
}

function areaPath(d: string, w: number, h: number, pad: number): string {
  // 用折线路径拼一个闭合区域做渐变填充；起点/终点的 x 直接从路径里取。
  const xs = [...d.matchAll(/[ML]([\d.]+),/g)].map((m) => Number(m[1]))
  if (!xs.length) return ''
  const first = xs[0]!
  const last = xs[xs.length - 1]!
  return `${d} L${last.toFixed(1)},${(h - pad).toFixed(1)} L${first.toFixed(1)},${(h - pad).toFixed(1)} Z`
}

/** 延迟曲线。横轴是真实时间，纵轴是毫秒。 */
export function latencyChart(
  points: LatencyPoint[],
  w = 520,
  h = 110,
  xRange?: { min: number; max: number },
): string {
  const pad = 6
  const values = points.map((p) => p.avgLatencyMs)
  const d = linePath(
    values,
    w,
    h,
    pad,
    points.map((p) => p.at),
    xRange,
  )

  if (!d) {
    return `<div class="chart chart-empty"><span>延迟数据不足（至少 2 次有效探测后显示曲线）</span></div>`
  }

  const nums = values.filter((v): v is number => v != null)
  const max = Math.max(...nums)
  const avg = Math.round(nums.reduce((a, b) => a + b, 0) / nums.length)
  const gid = `lg${Math.abs(hash(d))}`
  const failed = values.filter((v) => v == null).length

  return `<figure class="chart">
  <svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img"
       aria-label="延迟曲线，平均 ${avg} 毫秒，峰值 ${max} 毫秒">
    <defs><linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="var(--accent)" stop-opacity="0.30"/>
      <stop offset="100%" stop-color="var(--accent)" stop-opacity="0"/>
    </linearGradient></defs>
    <path d="${areaPath(d, w, h, pad)}" fill="url(#${gid})"/>
    <path d="${d}" fill="none" stroke="var(--accent)" stroke-width="1.5"
          stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>
  </svg>
  <figcaption><span>延迟（平均 ${esc(avg)} ms）</span><span class="chart-max">峰值 ${esc(max)} ms${failed ? ` · ${esc(failed)} 次失败已断开` : ''}</span></figcaption>
</figure>
${axisLabel(xRange)}`
}

/** 全局可用率曲线：可用目标占比（0-100%）。xRange 与各卡片共用，保证同一页横轴可比。 */
export function uptimeChart(points: OverviewPoint[], w = 760, h = 130, xRange?: { min: number; max: number }): string {
  const pad = 8
  const values = points.map((p) => (p.total > 0 ? (p.up / p.total) * 100 : null))
  const d = linePath(
    values,
    w,
    h,
    pad,
    points.map((p) => p.at),
    xRange,
  )

  if (!d) {
    return `<div class="chart chart-empty"><span>可用率曲线需要至少两轮探测数据</span></div>`
  }

  const nums = values.filter((v): v is number => v != null)
  const avg = nums.reduce((a, b) => a + b, 0) / nums.length
  const gid = `ug${Math.abs(hash(d))}`

  return `<figure class="chart chart-wide">
  <svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img"
       aria-label="可用率曲线，窗口内平均 ${avg.toFixed(1)}%">
    <defs><linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="var(--ok)" stop-opacity="0.28"/>
      <stop offset="100%" stop-color="var(--ok)" stop-opacity="0"/>
    </linearGradient></defs>
    <path d="${areaPath(d, w, h, pad)}" fill="url(#${gid})"/>
    <path d="${d}" fill="none" stroke="var(--ok)" stroke-width="1.5"
          stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>
  </svg>
  <figcaption><span>窗口内平均可用率 ${avg.toFixed(1)}%</span><span class="chart-max">范围 ${Math.min(...nums)}% – ${Math.max(...nums)}%</span></figcaption>
</figure>
${axisLabel(xRange)}`
}

/** 给渐变 id 用的小哈希，避免同页多个图共用 id 导致填充串色。 */
function hash(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) {
    h = (h << 5) - h + s.charCodeAt(i)
    h |= 0
  }
  return h
}

/** 曲线的横轴标注：让人知道这条线覆盖的是哪一段时间，否则「窗口内」是句空话。 */
function clock(ts: number): string {
  const d = new Date(ts)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function axisLabel(range?: { min: number; max: number }): string {
  if (!range || range.max <= range.min) return ''
  const mins = Math.round((range.max - range.min) / 60000)
  const span = mins < 60 ? `${mins} 分钟` : `${(mins / 60).toFixed(1)} 小时`
  return `<div class="chart-axis"><span>${esc(clock(range.min))}</span><span>覆盖 ${esc(span)}</span><span>${esc(clock(range.max))}</span></div>`
}
