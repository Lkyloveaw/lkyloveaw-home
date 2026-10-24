/**
 * 图表：服务端直接产出内联 SVG。
 * 为什么不用图表库：一个折线图不值得引入几十 KB 的 JS 依赖，内联 SVG 还能在禁用 JS 时照常显示。
 * 所有数值在进入 SVG 前都经过范围收敛，避免脏数据生成畸形路径。
 */
import type { LatencyPoint, OverviewPoint } from './store.js'

import { escapeHtml as esc } from '../public/html.js'

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
  domain?: { min: number; max: number },
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
    const ratio = domain ? Math.max(0, Math.min(1, (v - domain.min) / (domain.max - domain.min || 1))) : (v - min) / span
    const y = pad + (h - pad * 2) * (1 - ratio)
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

/** 空态与正常态共用同一套 DOM：客户端靠 `chart-empty` 类切换覆盖层，不需要重建结构。 */
let idleSeq = 0

interface ChartShellOptions {
  kind: 'latency' | 'uptime'
  w: number
  h: number
  pad: number
  color: string
  stopOpacity: string
  gid: string
  d: string | null
  domain?: { min: number; max: number }
  caption: { avg: string; max: string }
  aria: string
  idleNote: string
  xRange?: { min: number; max: number }
}

/**
 * 曲线的统一骨架。**空态也渲染 figure + svg + 两个 path**（`d` 为空串），
 * 只多一个 `chart-empty` 类让覆盖层显示 —— 客户端每 30 秒可以**原地**补图，
 * 双向切换（空 → 有数据 → 又空）只切类名，不重建 DOM，也就没有「空态永远变不成曲线」。
 */
function chartShell(o: ChartShellOptions): string {
  const area = o.d ? areaPath(o.d, o.w, o.h, o.pad) : ''
  // 值域保持原精度，避免客户端首次重画因截断而跳动。
  const domainText = (n: number): string => String(n)
  const domain = o.domain
    ? ' data-y-min="' + domainText(o.domain.min) + '" data-y-max="' + domainText(o.domain.max) + '"'
    : ''
  const wide = o.kind === 'uptime' ? ' chart-wide' : ''
  const empty = o.d ? '' : ' chart-empty'
  return (
    '<figure class="chart' + wide + empty + '" data-chart data-chart-kind="' + o.kind + '"' + domain +
    ' data-fill-id="' + o.gid + '" data-stroke="' + o.color + '">\n' +
    '  <svg viewBox="0 0 ' + o.w + ' ' + o.h + '" preserveAspectRatio="none" role="img" aria-label="' + esc(o.aria) + '">\n' +
    '    <defs><linearGradient id="' + o.gid + '" x1="0" y1="0" x2="0" y2="1">\n' +
    '      <stop offset="0%" stop-color="' + o.color + '" stop-opacity="' + o.stopOpacity + '"/>\n' +
    '      <stop offset="100%" stop-color="' + o.color + '" stop-opacity="0"/>\n' +
    '    </linearGradient></defs>\n' +
    '    <path d="' + area + '" fill="url(#' + o.gid + ')"/>\n' +
    '    <path d="' + (o.d || '') + '" fill="none" stroke="' + o.color + '" stroke-width="1.5"\n' +
    '          stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>\n' +
    '  </svg>\n' +
    '  <figcaption><span class="chart-avg">' + o.caption.avg + '</span><span class="chart-max">' + o.caption.max + '</span></figcaption>\n' +
    '  <div class="chart-idle-note"><span>' + esc(o.idleNote) + '</span></div>\n' +
    '</figure>\n' +
    axisLabel(o.xRange)
  )
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
  const nums = values.filter((v): v is number => v != null && Number.isFinite(v) && v >= 0)
  const domain = nums.length >= 2 ? initialDomain(values) : undefined
  const d = linePath(values, w, h, pad, points.map((p) => p.at), xRange, domain)
  const max = nums.length ? Math.max(...nums) : 0
  const failed = values.length - nums.length
  const note = '延迟数据不足（至少 2 次有效探测后显示曲线）'
  return chartShell({
    kind: 'latency',
    w,
    h,
    pad,
    color: 'var(--accent)',
    stopOpacity: '0.30',
    gid: d ? 'lg' + Math.abs(hash(d)) : 'lgidle' + idleSeq++,
    d,
    domain,
    caption: d
      ? {
          avg: '探测响应时间',
          max: '峰值 ' + max + ' ms' + (failed ? ' · 失败或缺测已断开' : ''),
        }
      : { avg: '', max: '' },
    aria: d ? '探测响应时间曲线，峰值 ' + max + ' 毫秒' : note,
    idleNote: note,
    xRange,
  })
}

/** 全局可用率曲线：可用目标占比（0-100%）。xRange 与各卡片共用，保证同一页横轴可比。 */
export function uptimeChart(
  points: OverviewPoint[],
  w = 760,
  h = 130,
  xRange?: { min: number; max: number },
): string {
  const pad = 8
  const values = points.map((p) => (p.total > 0 ? (p.up / p.total) * 100 : null))
  const d = linePath(values, w, h, pad, points.map((p) => p.at), xRange, { min: 0, max: 100 })
  const nums = values.filter((v): v is number => v != null && Number.isFinite(v) && v >= 0)
  const note = '可用率曲线需要至少两轮探测数据'
  return chartShell({
    kind: 'uptime',
    w,
    h,
    pad,
    color: 'var(--ok)',
    stopOpacity: '0.28',
    gid: d ? 'ug' + Math.abs(hash(d)) : 'ugidle' + idleSeq++,
    d,
    domain: { min: 0, max: 100 },
    caption: d
      ? {
          avg: '各轮可用系统占比',
          max: '范围 ' + Math.min(...nums).toFixed(2) + '% – ' + Math.max(...nums).toFixed(2) + '%',
        }
      : { avg: '', max: '' },
    aria: d ? '各轮可用系统占比曲线，范围 ' + Math.min(...nums).toFixed(2) + '% 至 ' + Math.max(...nums).toFixed(2) + '%' : note,
    idleNote: note,
    xRange,
  })
}

/**
 * 首屏值域：必须与 `public/chart-path.js` 的 `expandDomain` **完全一致**，
 * 否则客户端首次重绘就会让老点跳一下。交叉断言会钉住这一点。
 *
 * ⚠ 只统计**有效点**（排除 null / 非有限 / 负数）——负数在 `linePath` 里被当作断点，
 * 若把它算进值域，服务端的域会比前端的小，交叉断言立刻变红（实测抓到过一次）。
 * ⚠ 最小跨度用 10（与 chart-path.js 的默认一致）。两侧都必须同步改。
 */
function initialDomain(values: Array<number | null>): { min: number; max: number } {
  const MIN_SPAN = 10
  const nums = values.filter((v): v is number => v != null && Number.isFinite(v) && v >= 0)
  let lo = Math.min(...nums)
  let hi = Math.max(...nums)
  if (hi - lo < MIN_SPAN) {
    const mid = (lo + hi) / 2
    lo = mid - MIN_SPAN / 2
    hi = mid + MIN_SPAN / 2
  }
  if (lo < 0) lo = 0
  return { min: lo, max: hi }
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
  if (!range || range.max <= range.min) return '<div class="chart-axis" data-axis><span></span><span></span><span></span></div>'
  const mins = Math.round((range.max - range.min) / 60000)
  const span = mins < 60 ? `${mins} 分钟` : `${(mins / 60).toFixed(1)} 小时`
  return `<div class="chart-axis" data-axis><span>${esc(clock(range.min))}</span><span>覆盖 ${esc(span)}</span><span>${esc(clock(range.max))}</span></div>`
}
