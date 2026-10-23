/**
 * ⚠ 原型 —— 抛掷物，不要当成生产代码。
 *
 * 票：整站视觉原型 https://github.com/Lkyloveaw/lkyloveaw-home/issues/21
 * 计划：**三个 `/status` 的「结构」变体**，`?variant=A|B|C` 切换，挂在已存在的 `/status`
 *       路由上（技能里的 sub-shape A：数据获取、params、鉴权全保留，只换渲染子树）。
 *
 * 要回答的设计问题（map [#20](https://github.com/Lkyloveaw/lkyloveaw-home/issues/20) Notes 第 6 条：
 * 「数据面终端化 + 正文面纸感化」）——面板属于**数据面**，所以要判的是：
 * **一个「一眼看出什么坏了」的运维面板，哪种信息层级和主操作最省心。**
 *
 * 三个变体**必须结构不同**（技能 §2 的反模式：只改颜色/文案 = 墙纸，不是原型）：
 *   A 值守台    —— 主操作「扫」：故障占满版面，健康折叠成一行
 *   B 卡片墙    —— 主操作「比」：每目标一张自洽的小报告，网格对齐
 *   C 时间轴优先 —— 主操作「定位」：一条共享时间轴，行连成一片，先看「什么时候」
 *
 * 每个变体用**自己的一套 class**（`.va-` / `.vb-` / `.vc-`），不共享布局类。
 * 共享的只有：站点头栏、状态点形状、图表函数、切换条。这是技能允许的边界
 * （共享 `<Header>` 可以，共享 `<Layout>` 就毁掉了原型）。
 */

import type { StatusSummary } from '../views.js'
import { escapeHtml, formatUptime } from '../views.js'
import { uptimeChart, latencyChart } from '../charts.js'
import { PROTOTYPE_CSS } from './prototype-css.js'

/* ────────────────────────────────────────────── 切换条（三变体共用） */

export const VARIANTS = ['A', 'B', 'C'] as const
export type VariantKey = (typeof VARIANTS)[number]

const VARIANT_NAMES: Record<VariantKey, string> = {
  A: '值守台',
  B: '卡片墙 · 时间格',
  C: '时间轴优先',
}

/** 面板是数据面，没有「正文面」变体；名字写在这里是为了标签上显示得清楚。 */
export function isVariant(v: unknown): v is VariantKey {
  return typeof v === 'string' && (VARIANTS as readonly string[]).includes(v)
}

/**
 * 底部悬浮切换条。**不是设计的一部分** —— 高对比药丸、固定底部居中、
 * 在原型里永远可见，但生产环境根本不渲染（路由只在 `?variant=` 存在时走原型分支）。
 */
function switcher(current: VariantKey, basePath: string): string {
  const i = VARIANTS.indexOf(current)
  const prev = VARIANTS[(i - 1 + VARIANTS.length) % VARIANTS.length]!
  const next = VARIANTS[(i + 1) % VARIANTS.length]!
  const link = (v: VariantKey, label: string): string =>
    `<a href="${escapeHtml(basePath)}?variant=${v}" rel="nofollow">${label}</a>`
  return `<div class="pv-bar" role="group" aria-label="原型变体切换">
  ${link(prev, '←')}
  <span class="mid">变体 <b>${current}（${VARIANT_NAMES[current]}）</b>
    <span class="kbd">· ←/→ 键也可切</span></span>
  ${link(next, '→')}
</div>
<script>
/* 只为键盘切换与「保持滚动位置」存在——变体本身禁用 JS 也能用（服务端按 ?variant= 渲染）。 */
(function () {
  document.addEventListener('keydown', function (e) {
    var t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    var as = document.querySelectorAll('.pv-bar a');
    if (as.length < 2) return;
    e.preventDefault();
    (e.key === 'ArrowLeft' ? as[0] : as[1]).click();
  });
})();
</script>`
}

/* ────────────────────────────────────────────── 小工具 */

const STATUS_LABEL: Record<string, string> = { up: '可用', degraded: '异常', down: '故障' }
const STATE_CLASS: Record<string, string> = { up: 'ok', degraded: 'warn', down: 'bad' }

function dot(status: string | null): string {
  const cls = status ? (STATE_CLASS[status] ?? 'unknown') : 'unknown'
  const label = status ? (STATUS_LABEL[status] ?? '无数据') : '无数据'
  return `<span class="dot ${cls}" title="${escapeHtml(label)}"><span class="sr">${escapeHtml(label)}</span></span>`
}

/** 把时间线切成固定格数（缺少的历史格留 unknown，不假装连续采样）。 */
function timelineCells(points: Array<{ status: string }>, want = 56): string {
  const cells: string[] = []
  const pad = Math.max(0, want - points.length)
  for (let i = 0; i < pad; i++) cells.push('<i></i>')
  for (const p of points) cells.push(`<i class="${p.status}"></i>`)
  return cells.join('')
}

function ago(ts: number | null): string {
  if (!ts) return '从未'
  const d = Date.now() - ts
  if (d < 60_000) return '刚刚'
  if (d < 3_600_000) return `${Math.floor(d / 60_000)} 分钟前`
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)} 小时前`
  return `${Math.floor(d / 86_400_000)} 天前`
}

function clock(ts: number): string {
  const d = new Date(ts)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/**
 * ⚠ `views.ts` 的 `formatDuration` **没有导出**（它是模块内私有函数），所以这里自己写一份。
 * 走原型路线时**不去改生产模块的导出面**——抛掷物不该为了让生产代码配合它而改动。
 */
function fmtDuration(ms: number | null): string {
  if (ms == null || ms <= 0) return '—'
  const mins = Math.floor(ms / 60000)
  if (mins < 60) return `${mins} 分钟`
  const hours = Math.floor(mins / 60)
  if (hours < 48) return `${hours} 小时`
  return `${Math.floor(hours / 24)} 天`
}

/** 变体 A 的裁决行：整体一句话。 */
function verdict(summary: StatusSummary): { text: string; cls: string; detail: string } {
  const bad = summary.targets.filter((t) => t.stats.lastStatus === 'down')
  const warn = summary.targets.filter((t) => t.stats.lastStatus === 'degraded')
  if (bad.length) {
    return {
      text: `${bad.length} 个系统故障`,
      cls: 'is-bad',
      detail: bad.map((t) => t.target.name).join('、'),
    }
  }
  if (warn.length) {
    return {
      text: `${warn.length} 个系统异常`,
      cls: 'is-warn',
      detail: warn.map((t) => t.target.name).join('、'),
    }
  }
  return { text: '全部可用', cls: 'is-ok', detail: `${summary.targets.length} 个系统都在线` }
}

/* ────────────────────────────────────────────── 变体 A · 值守台 */

/**
 * 立意：**一眼回答「现在什么坏了」**。健康的目标不占版面。
 * 信息层级：故障（大字）→ 摘要（一行）→ 健康（折叠成一行数字）
 * 主操作：扫过。适合挂在大屏或常驻标签页。
 */
export function variantA(summary: StatusSummary): string {
  const v = verdict(summary)
  const faults = summary.targets.filter((t) => t.stats.lastStatus && t.stats.lastStatus !== 'up')
  const healthy = summary.targets.filter((t) => !t.stats.lastStatus || t.stats.lastStatus === 'up')

  const faultRows = faults.length
    ? faults
        .map(
          ({ target, stats: s }) => `<div class="va-fault">
      ${dot(s.lastStatus)}
      <div>
        <div class="va-fault-name">${escapeHtml(target.name)}</div>
        <div class="va-fault-why">${escapeHtml(s.lastError ?? '状态不符合预期')}</div>
      </div>
      <div class="va-fault-when">${escapeHtml(ago(s.lastCheckedAt))}</div>
    </div>`,
        )
        .join('')
    : '<p class="va-sub">窗口内没有正在故障的系统。</p>'

  const healthyLine = healthy.length
    ? `<p class="va-healthy">其余 <b>${healthy.length}</b> 个正常：
        ${healthy
          .map(
            (t) =>
              `${dot(t.stats.lastStatus)} ${escapeHtml(t.target.name)}${
                t.stats.avgLatencyMs != null ? ` <span class="tnum">${t.stats.avgLatencyMs}ms</span>` : ''
              }`,
          )
          .join('　')}</p>`
    : ''

  // 「连续稳定」取所有目标里最长的那条，并把它属于谁写出来——
  // 只说一个孤零零的时长，读者不知道它说的是哪个系统。
  const streaks = summary.targets
    .map((t) => ({ name: t.target.name, ms: t.stats.upStreakMs }))
    .filter((s): s is { name: string; ms: number } => s.ms != null && s.ms > 0)
    .sort((a, b) => b.ms - a.ms)
  const longest = streaks[0]
  const streakText = longest
    ? `<span class="tnum">${escapeHtml(fmtDuration(longest.ms))}</span>（${escapeHtml(longest.name)} 最长）`
    : '—'

  const avgUptime = summary.targets.length
    ? summary.targets.reduce((a, t) => a + (t.stats.uptime ?? 0), 0) / summary.targets.length
    : null

  return `<main class="wrap va">
  <div class="va-banner">
    <p class="va-verdict ${v.cls}">${dot(faults[0]?.stats.lastStatus ?? 'up')}${escapeHtml(v.text)}</p>
    <p class="va-sub">${escapeHtml(v.detail)} · ${escapeHtml(summary.windowLabel)} · 每 ${summary.probeIntervalSeconds} 秒探测</p>
  </div>
  <div class="va-faults">${faultRows}</div>
  ${healthyLine}
  <p class="va-foot">
    最近更新 ${escapeHtml(clock(summary.generatedAt))} ·
    连续稳定 ${streakText} ·
    平均可用率 ${formatUptime(avgUptime)}
  </p>
</main>`
}

/* ────────────────────────────────────────────── 变体 B · 卡片墙 */

/**
 * 变体 B · 卡片墙（**A/B 融合后的形态**）
 *
 * 立意：**每个系统是一份独立的小体检报告，可横向比较**。
 * 信息层级：每卡自成一体 → 网格对齐
 * 主操作：扫 + 对比。适合需要「看趋势和 P95」的场景。
 *
 * 与第一版的差别（用户反馈「B 的可用率换成 C 的格子连成一片」）：
 * **可用率环 → 一条铺满卡宽的时间格带**。
 * 理由：环只给一个百分比，看不出「什么时候坏的」；时间格带把 60 次探测的
 * 断续直接摆出来，而且**每张卡的格带长度/密度一致**，卡片之间可以横向比。
 */
export function variantB(summary: StatusSummary): string {
  const stats = summary.targets.map((t) => t.stats)
  const upNow = stats.filter((s) => s.lastStatus === 'up').length
  const withData = stats.filter((s) => s.samples > 0)
  const avg = withData.length ? withData.reduce((a, s) => a + (s.uptime ?? 0), 0) / withData.length : null
  const lats = stats.map((s) => s.avgLatencyMs).filter((n): n is number => n != null)
  const avgLat = lats.length ? Math.round(lats.reduce((a, b) => a + b, 0) / lats.length) : null
  const hasFault = stats.some((s) => s.lastStatus && s.lastStatus !== 'up')

  const allTimes: number[] = []
  for (const t of summary.targets) for (const p of t.latency) allTimes.push(p.at)
  const xRange = allTimes.length ? { min: Math.min(...allTimes), max: Math.max(...allTimes) } : undefined

  const cards = summary.targets
    .map(({ target, stats: s, timeline, latency }) => {
      const cls = s.lastStatus === 'down' ? 'is-bad' : s.lastStatus === 'degraded' ? 'is-warn' : ''
      const badge = s.lastStatus
        ? `<span class="vb-badge ${STATE_CLASS[s.lastStatus]}">${STATUS_LABEL[s.lastStatus]}</span>`
        : '<span class="vb-badge">无数据</span>'
      return `<article class="vb-card ${cls}">
    <div class="vb-head">
      <h2 class="vb-name">${escapeHtml(target.name)}</h2>
      ${badge}
    </div>
    <div class="vb-url" title="${escapeHtml(target.url)}">${escapeHtml(target.url)}</div>
    <div class="vb-cells" role="img"
      aria-label="${escapeHtml(target.name)} 最近 ${timeline.length} 次探测的状态（旧 → 新）">${cellStrip(timeline)}</div>
    <p class="vb-caption">最近 ${timeline.length} 次探测 · 旧 → 新 · 可用率 ${formatUptime(s.uptime)}</p>
    ${latency !== undefined ? `<div class="vb-chart">${latencyChart(latency, 232, 54, xRange)}</div>` : ''}
    <dl class="vb-kv">
      <div><dt>延迟</dt><dd>${s.avgLatencyMs != null ? `${s.avgLatencyMs} ms` : '—'}</dd></div>
      <div><dt>P95</dt><dd>${s.p95LatencyMs != null ? `${s.p95LatencyMs} ms` : '—'}</dd></div>
      <div><dt>连续可用</dt><dd>${escapeHtml(fmtDuration(s.upStreakMs))}</dd></div>
      <div><dt>最后检查</dt><dd>${escapeHtml(ago(s.lastCheckedAt))}</dd></div>
    </dl>
  </article>`
    })
    .join('')

  return `<main class="wrap vb">
  <div class="vc-lede">
    <h1>内网业务系统可用性</h1>
    <span class="vb-badge">${escapeHtml(summary.windowLabel)}</span>
  </div>
  <div class="vb-strip">
    <div><span class="k">当前可用</span><span class="v">${upNow}/${summary.targets.length}</span></div>
    <div><span class="k">平均可用率</span><span class="v">${formatUptime(avg)}</span></div>
    <div><span class="k">平均延迟</span><span class="v">${avgLat != null ? `${avgLat} ms` : '—'}</span></div>
    <div><span class="k">近期异常</span><span class="v ${hasFault ? 'has-fault' : ''}">${summary.incidents.length}</span></div>
    <div><span class="k">探测间隔</span><span class="v">${summary.probeIntervalSeconds}s</span></div>
  </div>
  <div class="vb-grid">${cards || '<p class="va-sub">还没有配置被监控的系统。</p>'}</div>
</main>`
}

/**
 * B 的格带：把探测历史铺成一条**定宽**的格子带。
 *
 * ⚠ 两个刻意的决定：
 * 1. **格数固定**（默认 56）。若按实际点数渲染，刚建库时只有 2 次探测 → 格带缩成一个小条，
 *    看起来像布局坏了，而且**各卡长度不一就没法横向比**。
 * 2. **缺的格用空心格补齐**（`.is-none`），不是留白也不是假装 up ——
 *    库里确实没有那段时间的数据，画成任何状态都是撒谎。缺数据就画成缺数据。
 */
function cellStrip(points: Array<{ status: string }>, want = 56): string {
  const recent = points.slice(-want)
  const cells: string[] = []
  for (let i = 0; i < want - recent.length; i++) cells.push('<i class="is-none"></i>')
  for (const p of recent) cells.push(`<i class="${escapeHtml(p.status)}"></i>`)
  return cells.join('')
}

/* ────────────────────────────────────────────── 变体 C · 时间轴优先 */

/**
 * 立意：**先看「什么时候出过事」，再看「是谁」**。
 * 信息层级：一条共享时间轴（所有目标的行连成一片）→ 行内详情 → 异常列表
 * 主操作：按时间定位。适合排查「昨晚那段时间到底怎么了」。
 */
export function variantC(summary: StatusSummary): string {
  const rows = summary.targets
    .map(({ target, stats: s, timeline }) => {
      const cells = timelineCells(timeline, 56)
      return `<div class="vc-row">
    <div class="vc-row-name">${dot(s.lastStatus)}${escapeHtml(target.name)}</div>
    <div class="vc-cells" role="img"
      aria-label="${escapeHtml(target.name)} 最近 ${timeline.length} 次探测的状态">${cells}</div>
    <div class="vc-row-meta">${formatUptime(s.uptime)}<br>${s.avgLatencyMs != null ? `${s.avgLatencyMs} ms` : '—'}</div>
  </div>`
    })
    .join('')

  const incidents = summary.incidents.length
    ? summary.incidents
        .slice(0, 10)
        .map(
          (i) => `<div class="vc-inc">
      <span class="t">${escapeHtml(clock(i.at))}</span>
      <span>${escapeHtml(
        summary.targets.find((t) => t.target.id === i.targetId)?.target.name ?? i.targetId,
      )} · ${escapeHtml(i.error ?? i.status)}</span>
      <span class="t">${escapeHtml(i.status)}</span>
    </div>`,
        )
        .join('')
    : '<p class="va-sub">窗口内没有记录到异常。</p>'

  return `<main class="wrap vc">
  <div class="vc-lede">
    <h1>可用性时间轴</h1>
    <span class="vb-badge">${escapeHtml(summary.windowLabel)} · 每 ${summary.probeIntervalSeconds} 秒</span>
  </div>

  <div class="vc-axis">
    <span class="lbl">整体走势</span>
    ${uptimeChart(summary.overview, 720, 92)}
  </div>

  <div class="vc-axis">
    <span class="lbl">各系统</span>
    <div class="vc-ticks"><span>一天前</span><span>12 小时前</span><span>6 小时前</span><span>现在</span></div>
  </div>

  <div class="vc-rows">${rows || '<p class="va-sub">还没有配置被监控的系统。</p>'}</div>

  <div class="vc-incidents">
    <h2>异常时间线（最近 ${Math.min(10, summary.incidents.length)} 条）</h2>
    ${incidents}
  </div>
</main>`
}

/* ────────────────────────────────────────────── 组装整页 */

const RENDERERS: Record<VariantKey, (s: StatusSummary) => string> = {
  A: variantA,
  B: variantB,
  C: variantC,
}

/**
 * 渲染一个变体的完整页面。
 *
 * 站点头栏与切换条三个变体共用（技能允许共享 Header）；
 * **主内容区完全不共享** —— 每个变体自己决定信息层级与主操作。
 */
export function renderPrototypePage(
  variant: VariantKey,
  summary: StatusSummary,
  site: { title: string; description: string },
  basePath = '/status',
): string {
  const body = RENDERERS[variant](summary)
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(site.title)} · 原型变体 ${variant}</title>
<meta name="robots" content="noindex">
<style>${PROTOTYPE_CSS}</style>
</head>
<body>
<!-- ⚠ 原型：本页由 ?variant= 驱动渲染，非生产 UI。见 src/prototype/status-variants.ts 头部注释。 -->
<header class="site-header"><div class="wrap">
  <a class="brand" href="/">${escapeHtml(site.title)}</a>
  <nav class="site-nav">
    <a href="/">首页</a><a href="/posts">分享</a>
    <a href="/status" aria-current="page">系统可用性</a><a href="/about">关于</a>
  </nav>
</div></header>
${body}
${switcher(variant, basePath)}
</body>
</html>`
}
