/**
 * 视图层：服务端渲染成 HTML 字符串。
 * 为什么不用前端框架：站点是内容型 + 一个面板，SSR 直接出完整 HTML，首屏快、SEO 友好、
 * 没有 hydration 成本，也不需要第二套构建。面板的自动刷新用一小段原生 JS 完成。
 */
import type { Post, PostMeta } from './content.js'
import type { ProbeTarget } from './config.js'
import type { TargetStats, TimelinePoint, OverviewPoint, ProbeResult, LatencyPoint } from './store.js'
import { latencyChart, uptimeChart } from './charts.js'

/** 所有动态文本都必须过这里。内容 Markdown 已由 markdown-it 处理（html:false），此处覆盖标题/名称/错误等。 */
export function escapeHtml(input: unknown): string {
  return String(input ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function formatDuration(ms: number): string {
  if (ms <= 0) return '—'
  const mins = Math.floor(ms / 60000)
  if (mins < 60) return `${mins} 分钟`
  const hours = Math.floor(mins / 60)
  if (hours < 48) return `${hours} 小时`
  return `${Math.floor(hours / 24)} 天`
}

function formatTime(ts: number | null): string {
  if (!ts) return '—'
  const d = new Date(ts)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function formatAgo(ts: number | null): string {
  if (!ts) return '从未'
  const diff = Date.now() - ts
  if (diff < 60000) return '刚刚'
  if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`
  if (diff < 86400000) return `${Math.floor(diff / 3600000)} 小时前`
  return `${Math.floor(diff / 86400000)} 天前`
}

export function formatUptime(uptime: number | null): string {
  return uptime == null ? '暂无数据' : `${(uptime * 100).toFixed(2)}%`
}

export interface LayoutOptions {
  title: string
  description: string
  active: 'home' | 'posts' | 'status' | 'about'
  body: string
  bodyClass?: string
}

function nav(active: LayoutOptions['active']): string {
  const items: Array<[LayoutOptions['active'], string, string]> = [
    ['home', '/', '首页'],
    ['posts', '/posts', '分享'],
    ['status', '/status', '系统可用性'],
    ['about', '/about', '关于'],
  ]
  return items
    .map(
      ([key, href, label]) =>
        `<a href="${href}"${key === active ? ' aria-current="page"' : ''}>${label}</a>`,
    )
    .join('')
}

export function layout(opts: LayoutOptions, site: { title: string; description: string }): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(opts.title)} · ${escapeHtml(site.title)}</title>
<meta name="description" content="${escapeHtml(opts.description)}">
<link rel="stylesheet" href="/style.css">
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><text y='26' font-size='26'>📓</text></svg>">
</head>
<body${opts.bodyClass ? ` class="${escapeHtml(opts.bodyClass)}"` : ''}>
<header class="site-header">
  <div class="wrap header-inner">
    <a class="brand" href="/">${escapeHtml(site.title)}</a>
    <nav class="site-nav">${nav(opts.active)}</nav>
  </div>
</header>
<main class="wrap">${opts.body}</main>
<footer class="site-footer">
  <div class="wrap">
    <span>${escapeHtml(site.description)}</span>
  </div>
</footer>
</body>
</html>`
}

export interface LoginPageOptions {
  /** 校验失败时显示的错误（已由调用方决定文案，此处只负责转义与渲染）。 */
  error?: string
  /** 登录成功后的回跳目标（只接受站内路径，调用方已校验）。 */
  next: string
  /** 库里一个账号都没有时，登录页要明说「请先用 CLI 建号」，否则用户会以为口令错。 */
  noAccounts?: boolean
}

/**
 * 登录页。刻意**不用 `layout()`**：登录页不该出现站点导航——
 * 那些链接指向受保护页面，未登录点过去只会被弹回登录页，徒增困惑。
 */
export function loginPage(opts: LoginPageOptions, site: { title: string; description: string }): string {
  const banner = opts.noAccounts
    ? `<p class="login-hint">尚未创建任何账号。请先在服务器上执行：<br><code>node dist/cli/passwd.js --user &lt;名字&gt; --password &lt;口令&gt;</code></p>`
    : ''
  const error = opts.error ? `<p class="login-error">${escapeHtml(opts.error)}</p>` : ''
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>登录 · ${escapeHtml(site.title)}</title>
<link rel="stylesheet" href="/style.css">
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><text y='26' font-size='26'>📓</text></svg>">
</head>
<body class="login-body">
<main class="login-wrap">
  <h1>${escapeHtml(site.title)}</h1>
  <p class="login-lede">${escapeHtml(site.description)}</p>
  ${error}
  ${banner}
  <form method="post" action="/login" class="login-form">
    <input type="hidden" name="next" value="${escapeHtml(opts.next)}">
    <label>用户名
      <input type="text" name="username" autocomplete="username" required autofocus>
    </label>
    <label>口令
      <input type="password" name="password" autocomplete="current-password" required>
    </label>
    <button type="submit">登录</button>
  </form>
</main>
</body>
</html>`
}

function postCard(post: PostMeta): string {
  const tags = post.tags
    .map((t) => `<a class="tag" href="/tags/${encodeURIComponent(t)}">${escapeHtml(t)}</a>`)
    .join('')
  return `<article class="card post-card">
  <h2><a href="/posts/${encodeURIComponent(post.slug)}">${escapeHtml(post.title)}</a></h2>
  <p class="meta"><time datetime="${escapeHtml(post.date)}">${escapeHtml(post.date)}</time></p>
  <p class="summary">${escapeHtml(post.summary)}</p>
  ${tags ? `<p class="tags">${tags}</p>` : ''}
</article>`
}

export function homePage(posts: PostMeta[], status: StatusSummary, site: { title: string; description: string }): string {
  const body = `
<section class="hero">
  <h1>${escapeHtml(site.title)}</h1>
  <p class="lede">${escapeHtml(site.description)}</p>
</section>

${statusBlock(status)}

<section class="section">
  <div class="section-head">
    <h2>最近分享</h2>
    <a class="more" href="/posts">全部 →</a>
  </div>
  ${posts.length ? posts.slice(0, 4).map(postCard).join('\n') : '<p class="empty">还没有文章。在 <code>content/</code> 下放一个 <code>.md</code> 就会出现。</p>'}
</section>`
  return layout(
    { title: '首页', description: site.description, active: 'home', body },
    site,
  )
}

export interface StatusSummary {
  targets: Array<{
    target: ProbeTarget
    stats: TargetStats
    timeline: TimelinePoint[]
    latency: LatencyPoint[]
  }>
  overview: OverviewPoint[]
  incidents: ProbeResult[]
  generatedAt: number
  windowLabel: string
  /** 探测间隔（秒），面板上「每 N 秒自动刷新」用的就是它。 */
  probeIntervalSeconds: number
}

function statusDot(status: string | null): string {
  const map: Record<string, [string, string]> = {
    up: ['ok', '可用'],
    degraded: ['warn', '异常'],
    down: ['bad', '故障'],
  }
  const [cls, label] = (status && map[status]) || ['unknown', '无数据']
  return `<span class="dot ${cls}" title="${escapeHtml(label)}"><span class="sr">${escapeHtml(label)}</span></span>`
}

function statOf(summary: StatusSummary, id: string): { target: ProbeTarget; stats: TargetStats } | undefined {
  return summary.targets.find((t) => t.target.id === id)
}

/** 首页上的紧凑状态条：只有数字和一行说明，详情指向 /status。 */
function statusBlock(summary: StatusSummary): string {
  if (!summary.targets.length) {
    return `<section class="section"><div class="section-head"><h2>内网业务系统</h2><a class="more" href="/status">详情 →</a></div>
    <p class="empty">还没有配置要监控的系统。编辑 <code>targets.json</code> 即可。</p></section>`
  }
  const stats = summary.targets.map((t) => t.stats)
  const withData = stats.filter((s) => s.samples > 0)
  const upNow = stats.filter((s) => s.lastStatus === 'up').length
  const avgUptime =
    withData.length > 0
      ? withData.reduce((sum, s) => sum + (s.uptime ?? 0), 0) / withData.length
      : null

  const rows = summary.targets
    .map(
      ({ target, stats: s }) => `<div class="mini-row">
      ${statusDot(s.lastStatus)}
      <span class="mini-name">${escapeHtml(target.name)}</span>
      <span class="mini-lat">${s.avgLatencyMs != null ? `${s.avgLatencyMs} ms` : '—'}</span>
      <span class="mini-up">${formatUptime(s.uptime)}</span>
    </div>`,
    )
    .join('')

  return `<section class="section">
  <div class="section-head">
    <h2>内网业务系统</h2>
    <a class="more" href="/status">完整面板 →</a>
  </div>
  <div class="stat-strip">
    <div class="stat"><span class="stat-num">${upNow}/${summary.targets.length}</span><span class="stat-label">当前可用</span></div>
    <div class="stat"><span class="stat-num">${formatUptime(avgUptime)}</span><span class="stat-label">平均可用率（${escapeHtml(summary.windowLabel)}）</span></div>
    <div class="stat"><span class="stat-num">${summary.incidents.length}</span><span class="stat-label">近期异常</span></div>
  </div>
  <div class="mini-list">${rows}</div>
</section>`
}

export function postsPage(posts: PostMeta[], tags: Array<{ tag: string; count: number }>, site: { title: string; description: string }, heading = '分享', activeTag?: string): string {
  const tagBar = tags.length
    ? `<div class="tag-bar">${
        activeTag
          ? `<a class="tag" href="/posts">← 全部</a>`
          : ''
      }${tags.map((t) => `<a class="tag${t.tag === activeTag ? ' tag-active' : ''}" href="/tags/${encodeURIComponent(t.tag)}">${escapeHtml(t.tag)} <span class="tag-count">${t.count}</span></a>`).join('')}</div>`
    : ''

  const body = `
<section class="section">
  <h1>${escapeHtml(heading)}</h1>
  ${tagBar}
  ${posts.length ? posts.map(postCard).join('\n') : '<p class="empty">这里还没有内容。</p>'}
</section>`
  return layout({ title: heading, description: site.description, active: 'posts', body }, site)
}

export function postPage(post: Post, site: { title: string; description: string }): string {
  const tags = post.tags
    .map((t) => `<a class="tag" href="/tags/${encodeURIComponent(t)}">${escapeHtml(t)}</a>`)
    .join('')
  const body = `
<article class="post">
  <header class="post-header">
    <h1>${escapeHtml(post.title)}</h1>
    <p class="meta"><time datetime="${escapeHtml(post.date)}">${escapeHtml(post.date)}</time> · 约 ${post.readingMinutes} 分钟</p>
    ${tags ? `<p class="tags">${tags}</p>` : ''}
  </header>
  <div class="prose">${post.html}</div>
</article>
<p class="back"><a href="/posts">← 返回分享列表</a></p>`
  return layout({ title: post.title, description: post.summary, active: 'posts', body }, site)
}

export function aboutPage(site: { title: string; description: string }): string {
  const body = `
<section class="section prose">
  <h1>关于</h1>
  <p>这里记录我自己折腾过的事情，以及内网各业务系统的可用性。</p>
  <h2>怎么加一篇文章</h2>
  <p>在 <code>content/</code> 下新建一个 <code>.md</code> 文件，开头写几行元信息即可：</p>
  <pre><code>---
title: 标题
date: 2026-01-01
tags: [运维, 网络]
summary: 可选的一句话摘要
---

正文用 Markdown 写。</code></pre>
  <h2>怎么加一个被监控的系统</h2>
  <p>编辑 <code>targets.json</code>，加一条记录，服务会在下一个探测周期自动开始记录历史：</p>
  <pre><code>{
  "id": "wiki",
  "name": "知识库",
  "url": "http://10.0.0.10/",
  "group": "办公"
}</code></pre>
  <p>状态数据存在 SQLite 里，不用手工维护。</p>
</section>`
  return layout({ title: '关于', description: site.description, active: 'about', body }, site)
}

function timelineBar(points: TimelinePoint[]): string {
  // ⚠ 必须带 `data-timeline` 钩子：卡片只有 `data-target`，`.tl` 容器原本**无标识**，
  // 前端没法定位它做重绘。空态与非空态结构不同，所以要整块重建。
  if (!points.length) return '<div class="tl tl-empty" data-timeline><span class="sr">暂无数据</span></div>'
  const cells = points
    .map(
      (p) =>
        `<i class="tl-cell ${p.status}" title="${escapeHtml(`${formatTime(p.at)} · ${p.status === 'up' ? '可用' : p.status === 'degraded' ? '异常' : '故障'}${p.latencyMs != null ? ` · ${p.latencyMs}ms` : ''}`)}"></i>`,
    )
    .join('')
  return `<div class="tl" data-timeline>${cells}</div>`
}

export function statusPage(
  summary: StatusSummary,
  site: { title: string; description: string },
  /** 一次性提示（改密成功/失败）。属「更显眼」而非核心内容，故只在需要时出现。 */
  notice?: string,
): string {
  const groups = new Map<string, Array<{ target: ProbeTarget; stats: TargetStats; timeline: TimelinePoint[]; latency: LatencyPoint[] }>>()
  for (const item of summary.targets) {
    const key = item.target.group || '未分组'
    const list = groups.get(key) ?? []
    list.push(item)
    groups.set(key, list)
  }

  const stats = summary.targets.map((t) => t.stats)
  const upNow = stats.filter((s) => s.lastStatus === 'up').length
  const withData = stats.filter((s) => s.samples > 0)
  const avgUptime =
    withData.length > 0 ? withData.reduce((sum, s) => sum + (s.uptime ?? 0), 0) / withData.length : null
  const latencies = stats.map((s) => s.avgLatencyMs).filter((n): n is number => n != null)
  const avgLatency = latencies.length ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : null

  const hasFault = stats.some((s) => s.lastStatus && s.lastStatus !== 'up')

  // 同一页所有曲线共用一个横轴范围，否则各卡片的曲线会各自铺满宽度，时长看起来一样长。
  const allTimes: number[] = []
  for (const t of summary.targets) {
    for (const p of t.latency) allTimes.push(p.at)
  }
  for (const p of summary.overview) allTimes.push(p.at)
  const xRange = allTimes.length
    ? { min: Math.min(...allTimes), max: Math.max(...allTimes) }
    : undefined

  const cards = [...groups.entries()]
    .map(
      ([group, items]) => `<h2 class="group-title">${escapeHtml(group)}</h2>
    <div class="target-grid">
      ${items
        .map(({ target, stats: s, timeline, latency }) => {
          const state = s.lastStatus ?? 'unknown'
          return `<article class="card target-card" data-target="${escapeHtml(target.id)}" data-state="${escapeHtml(state)}">
        <div class="target-head">
          ${statusDot(s.lastStatus)}
          <h3>${escapeHtml(target.name)}</h3>
          <span class="uptime">${formatUptime(s.uptime)}</span>
        </div>
        <p class="target-url"><a href="${escapeHtml(target.url)}" rel="noreferrer noopener" target="_blank">${escapeHtml(target.url)}</a></p>
        ${timelineBar(timeline)}
        ${latencyChart(latency, 520, 110, xRange)}
        <dl class="kv">
          <div><dt>延迟</dt><dd>${s.avgLatencyMs != null ? `${s.avgLatencyMs} ms` : '—'}</dd></div>
          <div><dt>P95</dt><dd>${s.p95LatencyMs != null ? `${s.p95LatencyMs} ms` : '—'}</dd></div>
          <div><dt>连续可用</dt><dd>${s.upStreakMs != null ? escapeHtml(formatDuration(s.upStreakMs)) : '—'}</dd></div>
          <div><dt>最后检查</dt><dd>${escapeHtml(formatAgo(s.lastCheckedAt))}</dd></div>
        </dl>
        ${s.lastStatus && s.lastStatus !== 'up' && s.lastError ? `<p class="target-error">${escapeHtml(s.lastError)}</p>` : ''}
      </article>`
        })
        .join('\n')}
    </div>`,
    )
    .join('\n')

  const incidents = summary.incidents.length
    ? `<ul class="incident-list">${summary.incidents
        .map((i) => {
          const known = summary.targets.find((t) => t.target.id === i.targetId)?.target.name
          return `<li><span class="incident-time">${escapeHtml(formatTime(i.at))}</span>
          <span class="incident-name">${escapeHtml(known ?? i.targetId)}</span>
          <span class="incident-err">${escapeHtml(i.error ?? i.status)}</span></li>`
        })
        .join('')}</ul>`
    : '<p class="empty">窗口内没有记录到异常。</p>'

  const body = `
<section class="section" id="status-root" data-generated="${summary.generatedAt}">
  <div class="section-head">
    <h1>内网业务系统可用性</h1>
    <span class="live-tag"><span class="live-dot"></span>每 ${summary.probeIntervalSeconds} 秒探测 · 每 30 秒刷新数值（曲线随页面刷新）</span>
  </div>
  <p class="lede">统计窗口：${escapeHtml(summary.windowLabel)} · 最后更新 <span class="js-generated">${escapeHtml(formatAgo(summary.generatedAt))}</span></p>
${notice ? `  <p class="notice">${escapeHtml(notice)}</p>\n` : ''}
  <div class="stat-strip">
    <div class="stat"><span class="stat-num">${upNow}/${summary.targets.length}</span><span class="stat-label">当前可用</span></div>
    <div class="stat"><span class="stat-num">${formatUptime(avgUptime)}</span><span class="stat-label">平均可用率</span></div>
    <div class="stat"><span class="stat-num">${avgLatency != null ? `${avgLatency} ms` : '—'}</span><span class="stat-label">平均延迟</span></div>
    <div class="stat"><span class="stat-num ${hasFault ? 'has-fault' : ''}">${summary.incidents.length}</span><span class="stat-label">近期异常</span></div>
  </div>

  ${summary.targets.length ? `<h2 class="group-title">整体可用率走势</h2>
  ${uptimeChart(summary.overview, 760, 130, xRange)}
  <h2 class="group-title">各系统明细</h2>` : ''}
  ${summary.targets.length ? cards : '<p class="empty">还没有配置被监控的系统。编辑 <code>targets.json</code> 后服务会自动开始探测。</p>'}

  <h2 class="group-title">近期异常</h2>
  ${incidents}
</section>
<script src="/chart-path.js" defer></script>
<script src="/status.js" defer></script>`
  return layout({ title: '系统可用性', description: site.description, active: 'status', body }, site)
}

export function notFoundPage(site: { title: string; description: string }): string {
  const body = `<section class="section"><h1>404</h1><p class="empty">这个页面不存在。</p><p class="back"><a href="/">← 回首页</a></p></section>`
  return layout({ title: '404', description: site.description, active: 'home', body }, site)
}
