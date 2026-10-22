/**
 * 视图层：服务端渲染成 HTML 字符串。
 * 为什么不用前端框架：站点是内容型 + 一个面板，SSR 直接出完整 HTML，首屏快、SEO 友好、
 * 没有 hydration 成本，也不需要第二套构建。面板的自动刷新用一小段原生 JS 完成。
 */
import type { Post, PostMeta } from './content.js'
import type { ProbeTarget } from './config.js'
import type { TargetStats, TimelinePoint, OverviewPoint, ProbeResult, LatencyPoint } from './store.js'
import { latencyChart, uptimeChart } from './charts.js'
import { currentCsrfToken, currentIsAdmin, currentUserName } from './csrf.js'
import { MIN_PASSWORD_LENGTH } from './users.js'
import { icon, type IconName } from './icons.js'

/**
 * L3 的 hidden input（`docs/write-path-auth-decision.md` §4.3）。
 *
 * **读请求级上下文**（`csrf.ts` 的 ALS），所以**视图函数签名不变** —— 每个表单不需要多接一个参数。
 * 上下文没被初始化时（脚本或测试里直接调 `views`）拿到的是**空串**：
 * 渲染出的表单会提交失败（403），而不是悄悄放行。**显眼失败**，而且只有一处要查。
 */
export function csrfField(): string {
  return `<input type="hidden" name="csrf" value="${escapeHtml(currentCsrfToken())}">`
}

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

/**
 * 管理台的**六个模块**（`docs/admin-console-sidebar-decision.md` §1）。
 *
 * 它是**另一根轴**，不是把 `active` 拆成六个值：`active` 管「顶栏哪一项亮」与「属于哪个平面」，
 * 六页共用同一个 `active: 'admin'`；模块只回答「侧栏哪一项高亮」。拆开会让一个字段有两种读法。
 */
export type AdminSection = 'overview' | 'targets' | 'accounts' | 'backups' | 'settings' | 'articles'

export interface PublicSidebar {
  posts: Array<{ slug: string; title: string }>
  currentSlug?: string
}

export interface LayoutOptions {
  title: string
  description: string
  /** 高亮哪个公开导航项。管理台 / 403 这类页面不属于任何一个公开项。 */
  active?: 'home' | 'posts' | 'status' | 'about'
  /**
   * 管理台的哪个模块。**只有它存在时才长管理 rail**；公开页用 sidebar，403/404 两者都空。
   */
  adminSection?: AdminSection
  /**
   * 公开文章侧栏。公开六页传数据；管理台 / 403 / 404 显式传 null。
   * 必填是为了让 13 个调用点少传一个时直接编译失败，而不是悄悄渲染成没有侧栏。
   */
  sidebar: PublicSidebar | null
  body: string
  bodyClass?: string
}

/**
 * 主题三态（#67）：`color-scheme` 是**唯一**开关，三态只切它、不复制 token。
 * 这段控件在用户菜单与登录页各出现一次（`[data-theme-select]` 恰好 2 处）。
 */
function themePicker(): string {
  return `<label class="theme-picker"><span class="sr">主题</span><select data-theme-select aria-label="主题">
<option value="system">跟随系统</option>
<option value="light">浅色</option>
<option value="dark">深色</option>
</select></label>`
}

/** `<head>` 里的防闪脚本：**必须在 `<link rel="stylesheet">` 之前**求值，否则第一帧会白闪。 */
function themeBoot(): string {
  return `<script>try{var t=localStorage.getItem('theme');if(t==='light'||t==='dark'){document.documentElement.dataset.theme=t;document.documentElement.style.colorScheme=t}}catch(e){}</script>`
}

/** `</body>` 前的同步脚本：不监听 `matchMedia`（系统切换由 CSS 的 light-dark() 处理）、不写 cookie。 */
function themeScript(): string {
  return `<script>(()=>{const root=document.documentElement,KEY='theme',selects=document.querySelectorAll('[data-theme-select]');const read=()=>{try{return localStorage.getItem(KEY)||'system'}catch(e){return 'system'}};const apply=(value)=>{if(value==='light'||value==='dark'){root.dataset.theme=value;root.style.colorScheme=value}else{root.removeAttribute('data-theme');root.style.colorScheme=''}selects.forEach((s)=>{s.value=value})};apply(read());selects.forEach((s)=>s.addEventListener('change',()=>{const value=s.value==='light'||s.value==='dark'?s.value:'system';try{if(value==='system')localStorage.removeItem(KEY);else localStorage.setItem(KEY,value)}catch(e){}apply(value)}))})()</script>`
}

/**
 * 公开面导航的**唯一数据源**（#86）：桌面顶栏与手机抽屉都从这里渲染，
 * 所以「哪几项、什么顺序、当前项怎么标」只有一份。
 * 管理台的模块走 ADMIN_GROUPS，不走这里；管理入口只在用户菜单（T3）。
 */
interface NavItem {
  key: NonNullable<LayoutOptions['active']>
  href: string
  label: string
  icon: IconName
}

const NAV_ITEMS: ReadonlyArray<NavItem> = [
  { key: 'home', href: '/', label: '首页', icon: 'home' },
  { key: 'posts', href: '/posts', label: '分享', icon: 'doc' },
  { key: 'status', href: '/status', label: '系统可用性', icon: 'pulse' },
  { key: 'about', href: '/about', label: '关于', icon: 'info' },
]

/**
 * 管理台的模块分组（`docs/admin-console-sidebar-decision.md` §2）：分组与顺序写死在这里。
 * 它是**信息架构**，不是数据 —— 「运维 5 项 / 内容 1 项」是 #59 定下的决定；
 * 条目**不带计数 / 徽标**（#58 Notes 10）：计数会造出第二份真相。
 */
const ADMIN_GROUPS: ReadonlyArray<[string, ReadonlyArray<[AdminSection, string, string]>]> = [
  [
    '运维',
    [
      ['overview', '/admin', '概览'],
      ['targets', '/admin/targets', '目标'],
      ['accounts', '/admin/accounts', '账号'],
      ['backups', '/admin/backups', '备份'],
      ['settings', '/admin/settings', '设置'],
    ],
  ],
  ['内容', [['articles', '/admin/articles', '文章']]],
]

/** rail 的一行。管理模块没有图标（`sub`），用左内边距对齐到图标之后。 */
function railLink(href: string, label: string, iconName: IconName | null, current: boolean, sub = false): string {
  return `<a class="rail-link${sub ? ' rail-link--sub' : ''}" href="${href}"${
    current ? ' aria-current="page"' : ''
  }>${iconName ? icon(iconName) : ''}<span>${escapeHtml(label)}</span></a>`
}

/** 管理台 rail：只在 adminSection 存在时渲染；模块组来自 ADMIN_GROUPS。 */
function adminRail(section: AdminSection): string {
  return `<div class="rail-group"><span class="rail-group-label">管理</span>${ADMIN_GROUPS.map(
    ([label, items]) =>
      `<span class="rail-sub-label">${label}</span>${items
        .map(([key, href, text]) => railLink(href, text, null, key === section, true))
        .join('')}`,
  ).join('')}</div>`
}

/** 桌面顶栏：四项文字导航；当前项用 aria-current。 */
function topNav(active?: LayoutOptions['active']): string {
  return `<nav class="top-nav" aria-label="主导航">${NAV_ITEMS.map(
    (item) =>
      `<a href="${item.href}"${item.key === active ? ' aria-current="page"' : ''}>${escapeHtml(item.label)}</a>`,
  ).join('')}</nav>`
}

/** 公开文章侧栏：只列已发布文章；当前文章 aria-current；空态一句。 */
function docsSide(sidebar: PublicSidebar | null): string {
  if (!sidebar) return ''
  const list = sidebar.posts.length
    ? `<ul class="docs-side-list">${sidebar.posts
        .map(
          (p) =>
            `<li><a href="/posts/${encodeURIComponent(p.slug)}"${p.slug === sidebar.currentSlug ? ' aria-current="page"' : ''}>${escapeHtml(p.title)}</a></li>`,
        )
        .join('')}</ul>`
    : '<p class="docs-side-empty">还没有已发布的文章。</p>'
  return `<nav class="docs-side" aria-label="公开文章"><p class="docs-side-title">文章</p>${list}</nav>`
}

/** 手机抽屉：四项导航 +（公开页）文章索引；纯 <details>，无读面 JS。 */
function drawer(sidebar: PublicSidebar | null, active?: LayoutOptions['active']): string {
  const nav = `<nav class="drawer-nav" aria-label="主导航（手机）">${NAV_ITEMS.map(
    (item) =>
      `<a href="${item.href}"${item.key === active ? ' aria-current="page"' : ''}>${escapeHtml(item.label)}</a>`,
  ).join('')}</nav>`
  const articles = sidebar
    ? `<div class="drawer-articles"><p class="drawer-articles-title">文章</p>${
        sidebar.posts.length
          ? `<ul>${sidebar.posts
              .map(
                (p) =>
                  `<li><a href="/posts/${encodeURIComponent(p.slug)}"${p.slug === sidebar.currentSlug ? ' aria-current="page"' : ''}>${escapeHtml(p.title)}</a></li>`,
              )
              .join('')}</ul>`
          : '<p class="docs-side-empty">还没有已发布的文章。</p>'
      }</div>`
    : ''
  return `<details class="nav-drawer"><summary class="drawer-toggle" aria-label="菜单"><span class="hamburger" aria-hidden="true"></span></summary><div class="drawer-panel">${nav}${articles}</div></details>`
}

/** 右上角用户胶囊 + disclosure 面板；只有已登录时渲染。 */
function userMenu(): string {
  const name = currentUserName()
  if (!name) return ''
  const initial = [...name][0]?.toUpperCase() ?? '?'
  const admin = currentIsAdmin()
  const adminItem = admin ? '<a class="menu-item" href="/admin">管理后台</a>' : ''
  return `<div class="user-menu" data-user-menu>
  <button class="user-pill" type="button" aria-expanded="false" aria-controls="user-panel" aria-label="账户菜单：${escapeHtml(name)}" data-user-trigger>
    <span class="avatar" aria-hidden="true">${escapeHtml(initial)}</span>
    <span class="user-name">${escapeHtml(name)}</span>
    <span class="chev" aria-hidden="true">${icon('chev')}</span>
  </button>
  <div class="user-panel" id="user-panel" data-user-panel>
    <div class="user-identity">
      <span class="avatar avatar-lg" aria-hidden="true">${escapeHtml(initial)}</span>
      <span class="identity-main"><strong>${escapeHtml(name)}</strong><span class="role-tag">${admin ? '管理员' : '只读'}</span></span>
    </div>
    <a class="menu-item" href="/account">修改口令</a>
    ${adminItem}
    <div class="menu-theme"><span>主题</span>${themePicker()}</div>
    <form class="logout-form" method="post" action="/logout">${csrfField()}<button class="menu-item" type="submit">登出</button></form>
  </div>
</div>`
}

/** 用户菜单的键盘增强：点击 / Escape / 点外 / focusout；无 focus trap，无 ARIA menu。 */
function userMenuScript(): string {
  return `<script>(()=>{const root=document.querySelector('[data-user-menu]');if(!root)return;const trigger=root.querySelector('[data-user-trigger]');const panel=root.querySelector('[data-user-panel]');if(!trigger||!panel)return;const close=()=>{root.classList.remove('is-open');trigger.setAttribute('aria-expanded','false');root.dataset.suppress=''};trigger.addEventListener('click',()=>{const open=!root.classList.contains('is-open');if(open){delete root.dataset.suppress;const drawer=document.querySelector('.nav-drawer[open]');if(drawer)drawer.removeAttribute('open');root.classList.add('is-open');trigger.setAttribute('aria-expanded','true')}else close()});document.addEventListener('click',(e)=>{if(!root.contains(e.target))close()});document.addEventListener('keydown',(e)=>{if(e.key==='Escape'&&root.contains(document.activeElement)){close();trigger.focus()}});root.addEventListener('focusout',(e)=>{if(!root.contains(e.relatedTarget)){close();setTimeout(()=>{if(!root.contains(document.activeElement))delete root.dataset.suppress},0)}});root.addEventListener('pointerleave',()=>{if(!root.contains(document.activeElement))delete root.dataset.suppress})})()</script>`
}

/** 手机：管理台的模块条（桌面由 rail 的管理组承担同一组条目）。 */
function adminTabs(section: AdminSection): string {
  return `<nav class="admin-tabs" aria-label="管理台模块">${ADMIN_GROUPS.map(
    ([label, items]) =>
      `<div class="admin-tabs-group"><span class="admin-tabs-label">${label}</span>${items
        .map(([key, href, text]) => `<a href="${href}"${key === section ? ' aria-current="page"' : ''}>${text}</a>`)
        .join('')}</div>`,
  ).join('')}</nav>`
}

export function layout(opts: LayoutOptions, site: { title: string; description: string }): string {
  // 页面自带的 bodyClass（403/404 用 `page-error`；其余页面没有额外类）。
  const bodyClass = opts.bodyClass ?? ''
  const shellClass = opts.sidebar
    ? 'app-shell app-shell--docs'
    : opts.adminSection
      ? 'app-shell app-shell--admin'
      : 'app-shell app-shell--plain'
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${escapeHtml(opts.title)} · ${escapeHtml(site.title)}</title>
<meta name="description" content="${escapeHtml(opts.description)}">
${themeBoot()}
<link rel="stylesheet" href="/style.css">
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><text y='26' font-size='26'>📓</text></svg>">
<noscript><style>[data-theme-select] { display: none }</style></noscript>
</head>
<body class="${escapeHtml(bodyClass)}">
<header class="site-header">
  <div class="header-inner">
    <a class="brand" href="/"><span class="brand-mark" aria-hidden="true">${icon('doc', 'brand-icon')}</span><span class="brand-name">${escapeHtml(site.title)}</span></a>
    ${topNav(opts.active)}
    <div class="header-actions">${drawer(opts.sidebar, opts.active)}${userMenu()}</div>
  </div>
</header>
<div class="${shellClass}">
  ${opts.adminSection ? `<nav class="site-rail" aria-label="管理台导航">${adminRail(opts.adminSection)}</nav>` : ''}
  ${docsSide(opts.sidebar)}
  <main class="app-main">${opts.adminSection ? adminTabs(opts.adminSection) : ''}${opts.body}</main>
</div>
<footer class="site-footer">
  <div class="wrap">
    <span>${escapeHtml(site.description)}</span>
  </div>
</footer>
${themeScript()}
${userMenuScript()}
</body>
</html>`
}

export type ForbiddenKind = 'origin' | 'csrf' | 'admin'

/**
 * 写路径与管理台的 403 页（`docs/write-path-auth-decision.md` §5.4 · `docs/admin-console-ia-decision.md` §3）。
 *
 * **不重定向**：重定向会把 POST 变成 GET，用户会以为「提交成功了」（跳到同一页、也没有错误提示）。
 *
 * `csrf` 那条给**回本页**的链接：最常见的真实原因是「开着两个标签页，在另一个标签改了口令」
 * （`token_version` 变了 → 会话重签 → 这个页面的 token 就失效了），刷新即可拿到新 token。
 * 但**文案不解释这个内部原因** —— 那既暴露实现细节，多数人也看不懂。
 *
 * `admin` 那条是**只读用户撞上管理台**：明说「需要管理员权限 · 当前账号是只读」。
 * 是 403 不是 404 —— 用户该知道这是**权限**问题，不是地址敲错了（§3.1）。
 */
export function forbiddenPage(
  kind: ForbiddenKind,
  site: { title: string; description: string },
  backPath = '/',
): string {
  const page = {
    origin: {
      title: '请求来源不可信',
      body: `<h1>请求来源不可信</h1>
<p>这个请求不是从本站发起的，已拒绝。</p>
<p><a href="/">回首页</a></p>`,
    },
    csrf: {
      title: '页面已过期',
      body: `<h1>页面已过期</h1>
<p>提交来源异常或页面已过期，请刷新后重试。</p>
<p><a href="${escapeHtml(backPath)}">回上一页</a></p>`,
    },
    admin: {
      title: '需要管理员权限',
      body: `<h1>需要管理员权限</h1>
<p>这个页面需要管理员权限。当前账号是只读。</p>
<p><a href="/">回首页</a></p>`,
    },
  }[kind]
  return layout({ title: page.title, description: site.description, sidebar: null, body: page.body, bodyClass: 'page-error' }, site)
}

/**
 * `?notice=<key>` 的**闭集**（`docs/admin-console-ia-decision.md` §4.1）。
 *
 * 提示文本**不来自 URL**：未知 key → 不渲染任何东西。
 * 为什么不做「自由文本 + 转义」：转义挡得住 XSS，挡不住**社工** ——
 * 一条 URL 就能让页面显示「已停用账号 alice」，而这个页面的可信度正来自「它说的就是真的」。
 * 代价只是新增动作时多写一行文本。
 */
export const NOTICE_TEXT: Record<string, string> = {
  'target-saved': '已保存目标。',
  'target-enabled': '已启用目标。',
  'target-disabled': '已停用目标。它不再被探测，历史一行没删。',
  // 「删除」有历史时其实走的是停用（`docs/targets-source-decision.md` §4），
  // 所以这个 key 只在**真的物理删掉**时才会出现。
  'target-deleted': '已删除目标（它没有任何历史记录）。这个 id 现在可以重新使用。',
  'account-created': '已创建账号。',
  'role-changed': '已修改角色。',
  'account-disabled': '已停用账号。',
  'account-enabled': '已启用账号。',
  'password-reset': '已重置口令。',
  'backup-started': '已备份：产物出现在下面的列表里。',
  // 「今天已备份过就跳过」在代码里是 `ok:true` + note（`backup.ts`）——
  // 所以它不是失败，但**必须说清楚「没有新增文件」**，否则用户会以为白点了一次。
  'backup-skipped': '今天已经有一份可用的备份，本次跳过（没有新增文件）。',
  // 进程内的重入守卫说的那句话（第二次点击不该再跑一遍）。
  'backup-running': '上一次备份还在跑，本次没有重复执行。',
  // 失败的原因每次都不一样，所以文案只指路；原文由页面上的 `notice-bad` 显示。
  'backup-failed': '备份失败 —— 原因显示在下面（服务日志里也有同一行）。',
  'settings-saved': '已保存设置。',
  'article-created': '已新建文章（草稿）。',
  'article-saved': '已保存。',
  'article-published': '已发布，读者现在能看到它。',
  'article-unpublished': '已撤下，改回草稿。',
  'article-trashed': '已移进回收站。它不再出现在任何读者看得到的地方。',
  'article-restored': '已还原。',
  'article-purged': '已彻底删除（连同它的全部修订）。',
  'article-reverted': '已退回那一版（退回本身也留了一条修订）。',
  'media-uploaded': '图片已上传 —— 编辑器加载时会把它插进正文末尾。',
  'media-duplicate': '这张图之前传过，用的是同一个 URL（没有产生第二个文件）。',
  'media-rejected': '这个文件不是支持的图片（只收 png / jpeg / webp / gif；SVG 一律拒绝）。',
  'media-too-big': '图片超过 8 MiB，先压缩再传。',
  'media-no-file': '没有收到文件，请重新选择。',
}

/**
 * 渲染一条提示。`tone`：`ok`（成功/中性）· `bad`（校验失败与守卫拒绝）· `warn`（不致命但要知道）。
 * **未知 key 返回空串** —— 这里是闭集的落点，不是「顺手给个默认」。
 */
export function renderNotice(key: unknown, tone: 'ok' | 'bad' | 'warn' = 'ok'): string {
  const text = typeof key === 'string' ? NOTICE_TEXT[key] : undefined
  if (!text) return ''
  // ⚠ 基类 `.notice` **必须一起输出**：`.notice-bad` 只覆盖左边框颜色，
  // 单用它就丢了背景、内边距与圆角（`status-banner` 那种独立类不适用这里）。
  const cls = tone === 'ok' ? 'notice' : `notice notice-${tone}`
  return `<p class="${cls}">${escapeHtml(text)}</p>`
}

/** 概览页要的四块摘要（**一律现算**：不落库、不缓存 —— 计数是「一眼的状态」，不是账本）。 */
export interface AdminOverview {
  targets: { enabled: number; total: number; groups: number }
  accounts: { total: number; admins: number; disabled: number }
  backup: { latest: string | null; latestAt: number | null; doneToday: boolean }
  settings: { title: string; description: string; intervalSeconds: number }
  /** 零管理员：**每次渲染现算** —— 启动日志只在重启时看得到，这里才是常驻位置（roles §5）。 */
  zeroAdmins: boolean
}

/**
 * `/admin`（概览，`docs/admin-console-ia-decision.md` §6.1）。
 *
 * **刻意不渲染目标列表**：那会造出第二份真相（与 `/admin/targets` 各说各话）。
 * 概览只给「一眼的状态」与进子页的入口。
 */
export function adminOverviewPage(
  d: AdminOverview,
  site: { title: string; description: string },
  notice?: unknown,
): string {
  const card = (title: string, value: string, detail: string, href: string): string =>
    `<a class="stat stat-link" href="${href}"><span class="stat-label">${escapeHtml(title)}</span>` +
    `<span class="stat-num">${escapeHtml(value)}</span>` +
    `<span class="stat-sub">${escapeHtml(detail)}</span>` +
    `<span class="stat-go" aria-hidden="true">${icon('chev')}</span></a>`

  const backupValue = d.backup.latest ? (d.backup.doneToday ? '今天已备份' : '今天还没备份') : '还没有备份'
  const backupDetail = d.backup.latest
    ? `${d.backup.latest}${d.backup.latestAt ? ` · ${formatAgo(d.backup.latestAt)}` : ''}`
    : '（备份目录为空）'

  const body =
    // `?notice=<key>`：**闭集**，未知 key 什么都不渲染（`renderNotice` 的契约）。
    renderNotice(notice) +
    // 零管理员告警：一条 warn 档提示 + 修复命令。它是**常驻**的，不靠启动时算好的一次性状态。
    (d.zeroAdmins
      ? `<p class="notice notice-warn">库里没有「启用中的管理员」：管理台没人能进（读面不受影响）。
修复：<code>node dist/cli/passwd.js --user &lt;名字&gt; --role admin</code></p>`
      : '') +
    `<h1>管理台</h1>
<p class="admin-hint"><strong>这里每一页都能写</strong>（面板是只读的，这里不是）——
目标与设置的真源是数据库，账号与备份动的是库里的行与磁盘上的产物，文章改的是内容库。</p>
<div class="stat-strip">
${card('目标', `${d.targets.enabled} / ${d.targets.total}`, `启用 / 共 · ${d.targets.groups} 个分组`, '/admin/targets')}
${card('账号', String(d.accounts.total), `管理员 ${d.accounts.admins} · 停用 ${d.accounts.disabled}`, '/admin/accounts')}
${card('备份', backupValue, backupDetail, '/admin/backups')}
${card('站点设置', d.settings.title, `${d.settings.description} · 每 ${d.settings.intervalSeconds}s 探测`, '/admin/settings')}
</div>`

  return layout({ title: '管理台', description: site.description, adminSection: 'overview', sidebar: null, body }, site)
}

/** 管理台目标页的一行（`docs/admin-console-ia-decision.md` §6.2）。 */
export interface AdminTargetRow {
  id: string
  name: string
  url: string
  group?: string
  expectStatus?: number[]
  timeoutMs?: number
  enabled: boolean
  /** 有历史 ⇒ 「删除」按钮其实是**停用**（`docs/targets-source-decision.md` §4）。 */
  hasHistory: boolean
}

export interface AdminTargetsOptions {
  notice?: unknown
  /** 400 的失败说明（**就地重渲染**时显示）。 */
  bad?: string | null
  /**
   * 失败时**用户刚提交的那份表单**（§4.2：保留已填输入）。
   * 只有 `action` 与某一行的 `id` 对得上时，这一行才用它回填 —— 其余行照旧显示库里的值。
   */
  submitted?: Record<string, string> | null
  /** 每个目标最近一次探测的状态（状态点）。停用中的目标不画点：它的「最近一次」是陈的。 */
  statuses?: Map<string, ProbeResult['status']>
}

/**
 * `/admin/targets`（`docs/admin-console-ia-decision.md` §6.2 · `docs/targets-source-decision.md`）。
 *
 * 一页两态：**列表**（按 `group` 分标题，同一手法见 `statusPage`）+ 每行的**行内编辑表单**。
 * 顶部的「新增」表单与每一行自己的表单**都是原生表单** —— 禁用 JS 也能读写（本仓的既有约束）。
 *
 * `id` 在编辑表单里**只读**（用 `readonly` 文本，不是 `disabled`：禁用控件提交时没有值，
 * 而我们正需要它当 `WHERE id = ?`）—— `id` 是历史库主键，改它等于丢掉这个目标的全部历史。
 * 要换 id 就是「新增一个 + 停用旧的」两步显式动作。
 *
 * 「删除」**不是一个按钮两种命运**：按钮文案由服务端按同一判据（有没有历史）渲染，
 * 用户看到的就是会发生的那件事。
 */
export function adminTargetsPage(
  rows: AdminTargetRow[],
  opts: AdminTargetsOptions,
  site: { title: string; description: string },
): string {
  const sub = opts.submitted ?? null
  const forCreate = sub && sub.action === 'target-create' ? sub : null
  const val = (s: Record<string, string> | null, key: string, fallback = ''): string =>
    escapeHtml(s && s[key] !== undefined ? s[key] : fallback)

  const statusDotFor = (row: AdminTargetRow): string => {
    if (!row.enabled) return ''
    const status = opts.statuses?.get(row.id) ?? null
    return statusDot(status)
  }

  const newForm = `<details class="create-card"${forCreate ? ' open' : ''}>
<summary>新增目标</summary>
<form method="post" action="/admin/targets" class="target-new">${csrfField()}
<input type="hidden" name="action" value="target-create">
<div class="form-row">
<label>id <input name="id" value="${val(forCreate, 'id')}" placeholder="wiki" required></label>
<label>名称 <input name="name" value="${val(forCreate, 'name')}" placeholder="知识库" required></label>
</div>
<div class="form-row">
<label>URL <input name="url" value="${val(forCreate, 'url')}" placeholder="http://10.0.0.10/" required></label>
<label>分组 <input name="group" value="${val(forCreate, 'group')}" placeholder="办公（可留空）"></label>
</div>
<div class="form-row">
<label>状态码 <input name="expectStatus" value="${val(forCreate, 'expectStatus')}" placeholder="200,301（留空 = 200-399 都算可用）"></label>
<label>超时 ms <input name="timeoutMs" value="${val(forCreate, 'timeoutMs')}" placeholder="留空 = 用全局值"></label>
<label class="confirm"><input type="checkbox" name="enabled" value="yes"${!forCreate || forCreate.enabled ? ' checked' : ''}> 立即启用</label>
<button type="submit">新增</button>
</div>
</form>
</details>`

  const renderRow = (row: AdminTargetRow): string => {
    const s = sub && sub.action === 'target-update' && sub.id === row.id ? sub : null
    const state = row.enabled
      ? '<span class="tag tag-active">启用中</span>'
      : '<span class="tag">已停用</span>'
    // 「删除」的两岔（§4）：有历史 → 停用；没历史 → 真的删掉。
    const removeForm = row.hasHistory
      ? `<form method="post" action="/admin/targets" class="form-actions">${csrfField()}
<input type="hidden" name="action" value="target-delete">
<input type="hidden" name="id" value="${escapeHtml(row.id)}">
<button type="submit">停用</button>
<span class="stat-sub">它有历史记录，删了会留下指向不存在目标的记录 —— 所以这里只停用，历史一行不删。</span>
</form>`
      : `<form method="post" action="/admin/targets" class="form-actions">${csrfField()}
<input type="hidden" name="action" value="target-delete">
<input type="hidden" name="id" value="${escapeHtml(row.id)}">
<button type="submit" class="btn-danger">删除</button>
<span class="stat-sub">它<strong>没有任何历史记录</strong>，删了就真没了（删掉之后可以用同一个 id 重新建）。</span>
</form>`

    return `<div class="cell-stack">
<div class="cell target-row-head">
${statusDotFor(row)}<span class="cell-title">${escapeHtml(row.name)}</span>
<code class="target-id cell-sub">${escapeHtml(row.id)}</code>${state}
</div>
<details class="cell-detail"${s ? ' open' : ''}>
<summary>编辑「${escapeHtml(row.name)}」</summary>
<form method="post" action="/admin/targets" class="target-edit">${csrfField()}
<input type="hidden" name="action" value="target-update">
<input type="hidden" name="id" value="${escapeHtml(row.id)}">
<div class="form-row">
<label>id <input value="${escapeHtml(row.id)}" readonly></label>
<label>名称 <input name="name" value="${val(s, 'name', row.name)}" required></label>
<label>URL <input name="url" value="${val(s, 'url', row.url)}" required></label>
</div>
<div class="form-row">
<label>分组 <input name="group" value="${val(s, 'group', row.group ?? '')}"></label>
<label>状态码 <input name="expectStatus" value="${val(s, 'expectStatus', (row.expectStatus ?? []).join(','))}" placeholder="留空 = 200-399"></label>
<label>超时 ms <input name="timeoutMs" value="${val(s, 'timeoutMs', row.timeoutMs == null ? '' : String(row.timeoutMs))}"></label>
<button type="submit">保存</button>
</div>
</form>
${
  row.enabled
    ? `<form method="post" action="/admin/targets" class="form-actions">${csrfField()}
<input type="hidden" name="action" value="target-disable">
<input type="hidden" name="id" value="${escapeHtml(row.id)}">
<button type="submit">停用</button>
<span class="stat-sub">停用后不再探测它，历史留着；随时可以再启用（连续可用的计时会从重新启用那一刻重算）。</span>
</form>`
    : `<form method="post" action="/admin/targets" class="form-actions">${csrfField()}
<input type="hidden" name="action" value="target-enable">
<input type="hidden" name="id" value="${escapeHtml(row.id)}">
<button type="submit">启用</button>
<span class="stat-sub">启用后下一轮探测开始重新记录它。</span>
</form>`
}
${removeForm}
</details>
</div>`
  }

  // 按 `group` 分标题（与 `statusPage` 同一手法），**分组不进 URL**（§1.2）。
  // 顺序由 SQL 给定（未分组排最后），这里只负责「分组一变就开一个新标题」。
  const byGroup: Array<{ name: string; rows: AdminTargetRow[] }> = []
  for (const row of rows) {
    const g = row.group?.trim() || '未分组'
    const last = byGroup[byGroup.length - 1]
    if (last && last.name === g) last.rows.push(row)
    else byGroup.push({ name: g, rows: [row] })
  }
  const list = byGroup
    .map(
      (g) =>
        `<h2 class="group-title">${escapeHtml(g.name)}</h2><div class="inset-list">${g.rows.map(renderRow).join('')}</div>`,
    )
    .join('')

  const body =
    renderNotice(opts.notice) +
    (opts.bad ? '<p class="notice notice-bad">' + escapeHtml(opts.bad) + '</p>' : '') +
    `<h1>目标</h1>
<p class="admin-hint">真源是<strong>数据库</strong>（SQLite）：<code>targets.json</code> / <code>TARGETS_JSON</code>
只在<strong>第一次启动、表还是空的时候</strong>导入一次，之后完全忽略 —— 改文件不再有任何效果。
改完<strong>下一轮探测生效</strong>（≤ 1 个探测间隔），不用重启。</p>
<p class="admin-hint"><code>id</code> 不可改：它是历史库的关联键，改它等于丢掉这个目标的全部历史。
要换 id 就「新增一个 + 停用旧的」。状态码填逗号分隔的数字（如 <code>200,301</code>），
留空表示 200-399 都算可用；超时填毫秒数（1–60000），留空用全局值。</p>
${rows.length ? '' : '<p class="empty">库里还没有目标。用下面的表单新增一个。</p>'}
${newForm}
${list}`

  return layout({ title: '目标 · 管理台', description: site.description, adminSection: 'targets', sidebar: null, body }, site)
}

/** 管理台设置页的一行（`docs/admin-console-ia-decision.md` §6.5）。 */
export interface AdminSettingRow {
  key: string
  label: string
  /** 当前生效值（**不是** `.env` 里的值 —— 真源是数据库）。 */
  value: string
  hint: string
  kind: 'string' | 'int'
  min?: number
  max?: number
  /** 库里的值坏掉了（空标题 / 不是正整数）：读的时候已经回退默认，页面上要标出来。 */
  bad: boolean
  /**
   * 值**能用但超出表单区间**（`.env` 首次落值来的 3 秒那种）。
   * 仍按它探测，但要提醒「想改就得守区间」—— 否则用户对着 `3` 拿到 400 会一头雾水。
   */
  outOfFormRange: boolean
}

export interface AdminSettingsOptions {
  notice?: unknown
  /** 400 的失败说明（**就地重渲染**时显示）。 */
  bad?: string | null
  /** 失败时**用户刚提交的那份表单**（§4.2：保留已填输入）。 */
  submitted?: Record<string, string> | null
}

/**
 * `/admin/settings`（`docs/admin-console-ia-decision.md` §6.5 · `docs/settings-source-decision.md`）。
 *
 * 只有三个字段 + 一个保存（map Notes 第 4 条点名的三项）。**没有「恢复默认值」按钮**（§9）：
 * 设置一旦落库，「恢复默认」在语义上就是「把值设回代码默认」—— 一次普通保存就能做到。
 *
 * 页面必须写清两件事，否则用户会以为保存没生效：
 * 真源已经是数据库（`.env` 只作首次初始值）、改间隔**下一轮生效且不打断正在等的那一轮**。
 */
export function adminSettingsPage(
  rows: AdminSettingRow[],
  envOnly: Array<{ label: string; value: string; note: string }>,
  opts: AdminSettingsOptions,
  site: { title: string; description: string },
): string {
  const sub = opts.submitted ?? null
  // 失败时用**用户刚提交的**值回填（`submitted` 里没有这个键时才用库里的值）。
  const valueOf = (row: AdminSettingRow): string =>
    escapeHtml(sub && sub[row.key] !== undefined ? sub[row.key] : row.value)

  const fields = rows
    .map(
      (row) => `<div class="cell cell-field">
<label>${escapeHtml(row.label)}
<input name="${escapeHtml(row.key)}" value="${valueOf(row)}"${row.kind === 'int' ? ' inputmode="numeric"' : ''}>
</label>
<p class="cell-sub">${escapeHtml(row.hint)}${
        row.bad
          ? '<br><span class="bad-text">库里的值不可用，上面显示的是回退后的默认值。</span>'
          : row.outOfFormRange
            ? '<br><span class="bad-text">当前值超出上面的区间（它来自 <code>.env</code> 的首次落值，仍按它探测）—— 想改就必须落回区间内。</span>'
            : ''
      }</p></div>`,
    )
    .join('\n')

  const envRows = envOnly
    .map(
      (e) =>
        `<div class="cell"><dt>${escapeHtml(e.label)}</dt><dd>${escapeHtml(e.value)}` +
        `<span class="cell-sub">${escapeHtml(e.note)}</span></dd></div>`,
    )
    .join('\n')

  const body =
    renderNotice(opts.notice) +
    (opts.bad ? '<p class="notice notice-bad">' + escapeHtml(opts.bad) + '</p>' : '') +
    `<h1>站点设置</h1>
<p class="admin-hint">真源是<strong>数据库</strong>：<code>.env</code> 里的 <code>SITE_TITLE</code> /
<code>SITE_DESCRIPTION</code> / <code>PROBE_INTERVAL_SECONDS</code> <strong>只作为首次启动的初始值</strong>，
之后改它们不再有任何效果（值不同时启动日志里会有一行警告）。</p>
<form method="post" action="/admin/settings">${csrfField()}
<input type="hidden" name="action" value="settings-save">
<div class="inset-list">${fields}</div>
<div class="form-actions"><button type="submit">保存</button>
<span class="stat-sub">标题与描述<strong>下一次请求</strong>就生效；探测间隔
<strong>从下一轮开始</strong>生效，正在等的那一轮不会被打断。</span></div>
</form>
<h2>留在 .env 里的（只读）</h2>
<p class="admin-hint">这些改错了会删数据、或把人锁在外面 —— 所以它们不放进网页表单，只在这里让你一眼看到。</p>
<dl class="inset-list kv">${envRows}</dl>`

  return layout({ title: '站点设置 · 管理台', description: site.description, adminSection: 'settings', sidebar: null, body }, site)
}

/** 备份页的一行（`docs/admin-console-ia-decision.md` §6.4 · `docs/settings-source-decision.md` §5）。 */
export interface AdminBackupRow {
  name: string
  bytes: number
  mtimeMs: number
}

export interface AdminBackupsOptions {
  notice?: unknown
  /** 动作失败的就地说明（400 或操作失败时显示）。 */
  bad?: string | null
  /** 备份目录的三种状态（见 `backup.ts` 的 `BackupListing`）。 */
  missing: boolean
  unreadable: boolean
  /** `unreadable` 时的原因。 */
  listingNote?: string
  /** 最近一次手动备份的失败原因（进程内记忆，重启即清空）。 */
  lastError?: string | null
  /** 只读展示的两个运维参数。 */
  backupDir: string
  backupKeep: number
}

/** 字节数给人看。产物的量级是 KB–MB，所以三档就够。 */
function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(2)} MB`
}

/**
 * `/admin/backups`（`docs/admin-console-ia-decision.md` §6.4 · `docs/settings-source-decision.md` §5）。
 *
 * 这一页只做三件事：**列出现有产物**（名 / 大小 / 时间，最新在前）、**立即要一份**、
 * 把两个**只读**的运维参数与那条**会话后果**写在明面上。
 *
 * 刻意没有的按钮（§5 的表里给了各自理由）：下载 / 恢复 / 删除单份。
 * 整库含 `password_hash`，站点还是 HTTP；而「恢复」是最危险的动作，属 SSH。
 */
export function adminBackupsPage(
  files: AdminBackupRow[],
  opts: AdminBackupsOptions,
  site: { title: string; description: string },
): string {
  const rows = files
    .map(
      (f) => `<div class="cell backup-row">
<code class="cell-sub backup-name">${escapeHtml(f.name)}</code>
<span class="cell-meta">${escapeHtml(formatBytes(f.bytes))}</span>
<span class="cell-meta">${escapeHtml(formatTime(f.mtimeMs))}<span class="cell-sub">${escapeHtml(formatAgo(f.mtimeMs))}</span></span>
</div>`,
    )
    .join('')

  const listing = opts.unreadable
    ? `<p class="notice notice-bad">备份目录<strong>读不了</strong>：${escapeHtml(opts.listingNote ?? '未知原因')}
<br>这一页仍然打得开（不然你连坏在哪都看不到），但下面的列表不可能是准的 —— 先去主机上看一眼这个路径。</p>`
    : opts.missing
      ? `<p class="empty">备份目录还不存在（第一次备份时会创建）。</p>`
      : files.length
        ? `<div class="inset-list">${rows}</div>
<p class="cell-sub">只保留最近 <strong>${opts.backupKeep}</strong> 份，更旧的会被自动删掉。一天一份 = 数据库 + 媒体快照 + 清单，同一天只留一份。</p>`
        : `<p class="empty">备份目录还是空的 —— 点上面的按钮要一份，或者等探测轮次里的自动备份。</p>`

  const body =
    renderNotice(opts.notice) +
    (opts.bad ? '<p class="notice notice-bad">' + escapeHtml(opts.bad) + '</p>' : '') +
    (opts.lastError
      ? `<p class="notice notice-bad">最近一次手动备份<strong>失败</strong>：${escapeHtml(opts.lastError)}
<br>服务日志里有同一行；改完（常见是目录不可写 / 磁盘满）再点一次即可。</p>`
      : '') +
    `<h1>备份</h1>
<p class="admin-hint">服务在探测轮次里<strong>降频自动备份</strong>（默认每 <code>CHECKPOINT_EVERY_ROUNDS</code> 轮 ≈ 1 小时一次；
今天已有一份可用的就跳过）。这里可以<strong>手动多要一份</strong>：先做一次 checkpoint、再复制整库、给媒体做一份硬链接快照、写清单、校验产物、滚动清理。</p>
<form method="post" action="/admin/backups" class="form-actions">${csrfField()}
<input type="hidden" name="action" value="backup-now">
<button type="submit">立即备份一次</button>
<span class="stat-sub">产物是一个<strong>新增文件</strong>，不会覆盖已有的任何一份；
今天已经备份过时这一次会<strong>跳过</strong>（不新增文件），页面会告诉你它跳过了。</span>
</form>
<h2>现有产物</h2>
${listing}
<h2>参数（只读）</h2>
<dl class="inset-list kv">
<div class="cell"><dt>备份目录</dt><dd><code>${escapeHtml(opts.backupDir)}</code></div>
<div class="cell"><dt>保留份数</dt><dd>${opts.backupKeep}</dd></div>
</dl>
<p class="admin-hint">这两项决定<strong>文件写在哪、删几份</strong>，改错会丢东西 —— 所以留在 <code>.env</code> 里，页面上只读。</p>
<h2>恢复与下载不在这个页面上</h2>
<p class="admin-hint">产物里是<strong>整库</strong>（含账号口令散列与全部历史），而站点还是 HTTP —— 所以这里不提供下载。
恢复更危险（覆盖线上库、且流程要停服），属 SSH 上的操作。</p>
<p class="notice notice-warn">⚠ <strong>恢复一份旧备份会让那份备份里「当时还活着」的会话重新有效</strong>：
<code>sessions</code> 表跟着库一起被搬回去了。恢复属于 SSH 操作，做之前想清楚这一点。</p>`

  return layout({ title: '备份 · 管理台', description: site.description, adminSection: 'backups', sidebar: null, body }, site)
}

/** 账号页的一行（`docs/admin-console-ia-decision.md` §6.3）。 */
export interface AdminAccountRow {
  id: number
  username: string
  role: 'admin' | 'readonly'
  enabled: boolean
  /** 凭据代次：排查「为什么掉线」时唯一有用的数字（§6.3 点名要显示它）。 */
  tokenVersion: number
  /** 是不是当前登录者自己 —— 自己的行**不渲染**改角色 / 停用按钮（服务端同样拒绝）。 */
  isSelf: boolean
}

export interface AdminAccountsOptions {
  notice?: unknown
  bad?: string | null
  /**
   * 失败时保留的输入。⚠ **口令字段永不回填**（§6.3）——
   * 把口令写回 HTML 等于把它留在页面、浏览器缓存与日志里。
   */
  submitted?: Record<string, string> | null
}

/**
 * `/admin/accounts`（`docs/admin-console-ia-decision.md` §6.3 · `docs/roles-decision.md`）。
 *
 * 四个动作：新增 · 改角色 · 停用/启用 · 重置口令。三处**必勾确认框**（§5.1：
 * 重置口令 · 停用账号 · 降级角色）—— 用 HTML 原生 `required`，**不用 JS `confirm()`**：
 * 本仓的约束是「禁用 JS 也要能读能写」，而禁用 JS 时 `confirm()` 根本不执行。
 * 提权与启用**不设卡**：它们是恢复通道（`roles-decision.md` §3）。
 *
 * 角色用**领域词**渲染（管理员 / 只读），不显示 `admin` / `readonly`（§6.3）。
 * 「不能改自己」在 UI 上是**不给按钮**，服务端那一份在 `users.ts` 的守卫里（双保险）。
 */
export function adminAccountsPage(
  rows: AdminAccountRow[],
  opts: AdminAccountsOptions,
  site: { title: string; description: string },
): string {
  const sub = opts.submitted ?? null
  const roleWord = (r: 'admin' | 'readonly'): string => (r === 'admin' ? '管理员' : '只读')
  /** 新增表单的回填：只回填用户名（口令永不回填）。 */
  const newUsername = escapeHtml(sub?.action === 'account-create' ? (sub.username ?? '') : '')

  const newForm = `<details class="create-card"${sub?.action === 'account-create' ? ' open' : ''}>
<summary>新增账号</summary>
<form method="post" action="/admin/accounts">${csrfField()}
<input type="hidden" name="action" value="account-create">
<div class="form-row">
<label>用户名 <input name="username" value="${newUsername}" required></label>
<label>新口令 <input type="password" name="password" autocomplete="new-password" required></label>
<label>再输一次 <input type="password" name="password2" autocomplete="new-password" required></label>
<button type="submit">新增（只读）</button>
</div>
<p class="stat-sub">新账号<strong>默认只读</strong>（最小权限）：要给他管理权，创建后点那一行的「升为管理员」——
那是一次显式的提权动作。口令至少 ${MIN_PASSWORD_LENGTH} 位，不会被回填、也不会写进页面。</p>
</form>
</details>`

  const row = (u: AdminAccountRow): string => {
    const roleCell = `<span class="tag${u.role === 'admin' ? ' tag-active' : ''}">${roleWord(u.role)}</span>`
    const stateCell = u.enabled ? '<span class="tag tag-active">启用中</span>' : '<span class="tag">已停用</span>'

    if (u.isSelf) {
      return `<div class="cell-stack">
<div class="cell">
<div class="cell-main"><span class="cell-title">${escapeHtml(u.username)}</span><span class="cell-sub">id ${u.id} · 这是你自己</span></div>
${roleCell}${stateCell}<span class="cell-meta">代次 ${u.tokenVersion}</span>
</div>
<div class="cell"><span class="cell-sub">自己的角色 / 启停不在这里改（服务端也会拒）—— 这是防自锁的第一道。
改自己的口令请用右上角用户菜单 → 修改口令（/account）。</span></div>
</div>`
    }

    const roleForm =
      u.role === 'admin'
        ? `<form method="post" action="/admin/accounts" class="form-actions">${csrfField()}
<input type="hidden" name="action" value="account-role">
<input type="hidden" name="id" value="${u.id}">
<input type="hidden" name="role" value="readonly">
<label class="confirm"><input type="checkbox" name="confirm" value="yes" required>
我确认：降级后对方<strong>下一个请求</strong>就进不了管理台（不会踢掉他的登录）。</label>
<button type="submit" class="btn-danger">降为只读</button>
</form>`
        : `<form method="post" action="/admin/accounts" class="form-actions">${csrfField()}
<input type="hidden" name="action" value="account-role">
<input type="hidden" name="id" value="${u.id}">
<input type="hidden" name="role" value="admin">
<button type="submit">升为管理员</button>
<span class="stat-sub">提权立刻生效（下一个请求就能进管理台），<strong>不</strong>需要确认框。</span>
</form>`

    const stateForm = u.enabled
      ? `<form method="post" action="/admin/accounts" class="form-actions">${csrfField()}
<input type="hidden" name="action" value="account-disable">
<input type="hidden" name="id" value="${u.id}">
<label class="confirm"><input type="checkbox" name="confirm" value="yes" required>
我确认：停用后对方<strong>下一个请求</strong>就会被挡在登录页外（不删他任何数据，随时能再启用）。</label>
<button type="submit" class="btn-danger">停用</button>
</form>`
      : `<form method="post" action="/admin/accounts" class="form-actions">${csrfField()}
<input type="hidden" name="action" value="account-enable">
<input type="hidden" name="id" value="${u.id}">
<button type="submit">启用</button>
<span class="stat-sub">启用是<strong>恢复通道</strong>，永不设卡。</span>
</form>`

    const pwForm = `<form method="post" action="/admin/accounts" class="form-actions">${csrfField()}
<input type="hidden" name="action" value="account-reset-password">
<input type="hidden" name="id" value="${u.id}">
<input type="password" name="password" placeholder="新口令" autocomplete="new-password" required>
<input type="password" name="password2" placeholder="再输一次" autocomplete="new-password" required>
<label class="confirm"><input type="checkbox" name="confirm" value="yes" required>
我确认：这会立刻让 <strong>${escapeHtml(u.username)}</strong> 所有设备上的登录失效；新口令由我告知对方。</label>
<button type="submit">重置口令</button>
</form>`

    return `<div class="cell-stack">
<div class="cell">
<div class="cell-main"><span class="cell-title">${escapeHtml(u.username)}</span><span class="cell-sub">id ${u.id}</span></div>
${roleCell}${stateCell}<span class="cell-meta">代次 ${u.tokenVersion}</span>
</div>
<details class="cell-detail">
<summary>管理「${escapeHtml(u.username)}」</summary>
${roleForm}${stateForm}${pwForm}
</details>
</div>`
  }

  const table = rows.length
    ? `<div class="inset-list">${rows.map(row).join('\n')}</div>`
    : '<p class="empty">库里还没有账号（这不该发生：零账号时用环境变量或 CLI 建第一个）。</p>'

  const body =
    renderNotice(opts.notice) +
    (opts.bad ? '<p class="notice notice-bad">' + escapeHtml(opts.bad) + '</p>' : '') +
    `<h1>账号</h1>
<p class="admin-hint">两个角色：<strong>管理员</strong>能进管理台并做全部写操作；<strong>只读</strong>能看全部只读面、能改自己的口令，但管理台整块进不来。
角色的真源是 <code>users.role</code> 一列，<strong>不进 cookie</strong> —— 所以降级 / 提权在下一个请求就生效，不需要踢会话。</p>
<p class="admin-hint">守卫只数<strong>启用中的</strong>管理员：最后一名启用中的管理员不能被降级或停用（否则管理台没人能进）。
「改自己」被两道挡住：这里不给按钮，服务端也拒。</p>
${newForm}
<h2>现有账号（${rows.length}）</h2>
${table}`

  return layout({ title: '账号 · 管理台', description: site.description, adminSection: 'accounts', sidebar: null, body }, site)
}

export interface LoginPageOptions {  /** 校验失败时显示的错误（已由调用方决定文案，此处只负责转义与渲染）。 */
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
<meta name="color-scheme" content="light dark">
<title>登录 · ${escapeHtml(site.title)}</title>
${themeBoot()}
<link rel="stylesheet" href="/style.css">
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><text y='26' font-size='26'>📓</text></svg>">
<noscript><style>[data-theme-select] { display: none }</style></noscript>
</head>
<body class="login-body">
<div class="login-theme">${themePicker()}</div>
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
${themeScript()}
</body>
</html>`
}

function postCard(post: PostMeta): string {
  const tags = post.tags
    .map((t) => `<a class="tag" href="/tags/${encodeURIComponent(t)}">${escapeHtml(t)}</a>`)
    .join('')
  return `<article class="cell post-card">
  <div class="cell-main">
    <h2 class="cell-title"><a href="/posts/${encodeURIComponent(post.slug)}">${escapeHtml(post.title)}</a></h2>
    <p class="meta"><time datetime="${escapeHtml(post.date)}">${escapeHtml(post.date)}</time></p>
    <p class="summary">${escapeHtml(post.summary)}</p>
    ${tags ? `<p class="tags">${tags}</p>` : ''}
  </div>
  <span class="chev" aria-hidden="true">${icon('chev')}</span>
</article>`
}

export function homePage(posts: PostMeta[], status: StatusSummary, site: { title: string; description: string }, sidebar: PublicSidebar): string {
  const body = `
<section class="hero">
  <h1 class="large-title">${escapeHtml(site.title)}</h1>
  <p class="lede">${escapeHtml(site.description)}</p>
</section>

${statusBlock(status)}

<section class="section">
  <div class="section-head">
    <h2>最近分享</h2>
    <a class="more" href="/posts">全部 →</a>
  </div>
  ${
    posts.length
      ? `<div class="inset-list post-list">${posts.slice(0, 4).map(postCard).join('\n')}</div>`
      : '<p class="empty">还没有文章。登录后在 <strong>管理台 → 文章</strong> 里写一篇就会出现。</p>'
  }
</section>`
  return layout(
    { title: '首页', description: site.description, active: 'home', sidebar, body },
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
    <p class="empty">还没有配置要监控的系统。登录后在 <strong>管理台 → 目标</strong> 里新增一个即可。</p></section>`
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
      ({ target, stats: s }) => `<div class="cell">
      ${statusDot(s.lastStatus)}
      <span class="cell-title">${escapeHtml(target.name)}</span>
      <span class="cell-meta">${s.avgLatencyMs != null ? `${s.avgLatencyMs} ms` : '—'}</span>
      <span class="cell-meta">${formatUptime(s.uptime)}</span>
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
  <div class="inset-list">${rows}</div>
</section>`
}

export function postsPage(posts: PostMeta[], tags: Array<{ tag: string; count: number }>, site: { title: string; description: string }, sidebar: PublicSidebar, heading = '分享', activeTag?: string): string {
  const tagBar = tags.length
    ? `<div class="chip-row">${
        activeTag
          ? `<a class="tag" href="/posts">← 全部</a>`
          : ''
      }${tags.map((t) => `<a class="tag${t.tag === activeTag ? ' tag-active' : ''}" href="/tags/${encodeURIComponent(t.tag)}">${escapeHtml(t.tag)} <span class="tag-count">${t.count}</span></a>`).join('')}</div>`
    : ''

  const body = `
<section class="section">
  <h1 class="large-title">${escapeHtml(heading)}</h1>
  ${tagBar}
  ${
    posts.length
      ? `<div class="inset-list post-list">${posts.map(postCard).join('\n')}</div>`
      : '<p class="empty">这里还没有内容。</p>'
  }
</section>`
  return layout({ title: heading, description: site.description, active: 'posts', sidebar, body }, site)
}

export function postPage(post: Post, site: { title: string; description: string }, sidebar: PublicSidebar): string {
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
  return layout({ title: post.title, description: post.summary, active: 'posts', sidebar, body }, site)
}

export function aboutPage(site: { title: string; description: string }, sidebar: PublicSidebar): string {
  const body = `
<section class="section prose">
  <h1 class="large-title">关于</h1>
  <p>这里记录我自己折腾过的事情，以及内网各业务系统的可用性。</p>
  <h2>怎么加一篇文章</h2>
  <p>登录后在 <strong>管理台 → 文章</strong> 里新建即可 —— 写、改、发布、撤下都在网页上，改完立刻生效，不用登服务器。</p>
  <p>只有在<strong>首次导入</strong>（或跑 <code>node dist/cli/articles.js --reimport</code>）时才会读 <code>content/</code> 下的 <code>.md</code>。它的格式是：</p>
  <pre><code>---
title: 标题
date: 2026-01-01
tags: [运维, 网络]
summary: 可选的一句话摘要
---

正文用 Markdown 写。</code></pre>
  <h2>怎么加一个被监控的系统</h2>
  <p>登录后在 <strong>管理台 → 目标</strong> 里新增一条即可，服务会在下一个探测周期自动开始记录历史
  （不用改文件、也不用重启）。</p>
  <pre><code>id:   wiki
名称: 知识库
URL:  http://10.0.0.10/
分组: 办公</code></pre>
  <p>目标清单的真源是 SQLite。<code>targets.json</code> 只在<strong>第一次启动、清单还是空的时候</strong>
  导入一次，之后改它不再有任何效果 —— 那行警告会在每次启动时提醒你。</p>
  <p>状态数据也存在同一个 SQLite 里，不用手工维护。</p>
</section>`
  return layout({ title: '关于', description: site.description, active: 'about', sidebar, body }, site)
}

/**
 * 把探测历史渲染成一条**定宽**的状态格带。
 *
 * 为什么固定格数（而不是按实际点数铺）：刚部署时只有两三次探测，按实际点数渲染会缩成一根小条，
 * 看起来像布局坏了；更关键的是**各卡格数不一致就没法横向比**——而「横向比」正是卡片墙的全部意义。
 *
 * ⚠ 缺少的历史画成**空心格**（`cell-missing`），不是留白、更不是假装 up。
 * 库里确实没有那段时间的记录，画成任何状态都是撒谎。窗口填满后就不再出现空心格。
 */
const CELL_STRIP_LEN = 56

function cellStrip(points: TimelinePoint[], want = CELL_STRIP_LEN): string {
  const recent = points.slice(-want)
  const cells: string[] = []
  for (let i = 0; i < want - recent.length; i++) cells.push('<i class="cell-missing"></i>')
  for (const p of recent) {
    cells.push(
      `<i class="${p.status}" title="${escapeHtml(`${formatTime(p.at)} · ${STATUS_TEXT[p.status] ?? p.status}${p.latencyMs != null ? ` · ${p.latencyMs}ms` : ''}`)}"></i>`,
    )
  }
  return cells.join('')
}

/** 三档状态的文字。`degraded` 与 `down` 必须分开——处置方式完全不同（CONTEXT.md 的「状态」词条）。 */
const STATUS_TEXT: Record<string, string> = { up: '可用', degraded: '异常', down: '故障' }

/**
 * 状态 → CSS 类名。**状态值与类名不是一套词**：
 * 领域状态是 `up/degraded/down`，而 `.dot` / `.badge` 的样式类一直是 `ok/warn/bad`
 * （`statusDot()` 早就在做这个映射）。
 * ⚠ 这里必须复用同一张表。第一版直接输出 `badge ${state}` 写出 `badge degraded`，
 * 而 CSS 只认 `.badge.warn` —— 徽标一个颜色都没上，且**肉眼看不出是 bug**（只是"看起来素了点"）。
 */
const STATUS_CLASS: Record<string, string> = { up: 'ok', degraded: 'warn', down: 'bad' }

/**
 * 可用性面板 = **卡片墙 · 时间格**（票 #21 三变体原型定稿，见 `docs/visual-prototype-decision.md`）。
 *
 * 每个目标一张自洽的卡：状态徽标 + **定宽时间格带** + 延迟曲线 + 键值。
 * 这里只做**数据驱动重绘能对上**的改动：卡上保留 `data-target`/`data-state`（`status.js` 的钩子），
 * 格带与曲线**整块重建**（空态与非空态结构不同，只改 class 换不回来）。
 */
export function statusPage(
  summary: StatusSummary,
  site: { title: string; description: string },
  sidebar: PublicSidebar | null,
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
          const badge = s.lastStatus
            ? `<span class="badge ${STATUS_CLASS[s.lastStatus] ?? 'unknown'}">${escapeHtml(STATUS_TEXT[s.lastStatus] ?? s.lastStatus)}</span>`
            : '<span class="badge">无数据</span>'
          return `<article class="card target-card" data-target="${escapeHtml(target.id)}" data-state="${escapeHtml(state)}">
        <div class="target-head">
          ${statusDot(s.lastStatus)}
          <h3>${escapeHtml(target.name)}</h3>
          ${badge}
        </div>
        <p class="target-url"><a href="${escapeHtml(target.url)}" rel="noreferrer noopener" target="_blank">${escapeHtml(target.url)}</a></p>
        <div class="cell-strip" data-timeline data-cells="${CELL_STRIP_LEN}" role="img"
          aria-label="${escapeHtml(target.name)}：最近 ${timeline.length} 次探测（旧 → 新），可用率 ${formatUptime(s.uptime)}"
        >${cellStrip(timeline)}</div>
        <p class="cell-caption">最近 <span class="js-cells">${timeline.length}</span> 次探测 · 旧 → 新 · 可用率 <span class="uptime">${formatUptime(s.uptime)}</span></p>
        ${latencyChart(latency, 232, 54, xRange)}
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
    ? `<ul class="inset-list incident-list">${summary.incidents
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
    <h1 class="large-title">内网业务系统可用性</h1>
    <span class="live-tag"><span class="live-dot"></span>每 ${summary.probeIntervalSeconds} 秒探测 · 每 30 秒刷新数值（曲线随页面刷新）</span>
  </div>
  <p class="lede">统计窗口：${escapeHtml(summary.windowLabel)} · 最后更新 <span class="js-generated">${escapeHtml(formatAgo(summary.generatedAt))}</span></p>
  <div class="stat-strip">
    <div class="stat"><span class="stat-num">${upNow}/${summary.targets.length}</span><span class="stat-label">当前可用</span></div>
    <div class="stat"><span class="stat-num">${formatUptime(avgUptime)}</span><span class="stat-label">平均可用率</span></div>
    <div class="stat"><span class="stat-num">${avgLatency != null ? `${avgLatency} ms` : '—'}</span><span class="stat-label">平均延迟</span></div>
    <div class="stat"><span class="stat-num ${hasFault ? 'has-fault' : ''}">${summary.incidents.length}</span><span class="stat-label">近期异常</span></div>
  </div>

  ${summary.targets.length ? `<h2 class="group-title">整体可用率走势</h2>
  ${uptimeChart(summary.overview, 760, 130, xRange)}
  <h2 class="group-title">各系统明细</h2>` : ''}
  ${summary.targets.length ? cards : '<p class="empty">还没有配置被监控的系统。在管理台的「目标」里新增，或首次启动时写 <code>targets.json</code> 导入。</p>'}

  <h2 class="group-title">近期异常</h2>
  ${incidents}
</section>
<script src="/chart-path.js" defer></script>
<script src="/status.js" defer></script>`
  return layout({ title: '系统可用性', description: site.description, active: 'status', sidebar, body }, site)
}

/** 我的账户：只顶栏、无侧栏；改自己口令的成功 / 失败都回这张页。 */
export function accountPage(
  opts: { notice?: string; error?: string },
  site: { title: string; description: string },
): string {
  const name = currentUserName()
  const role = currentIsAdmin() ? '管理员' : '只读'
  const notice = opts.notice ? `<p class="notice">${escapeHtml(opts.notice)}</p>` : ''
  const error = opts.error ? `<p class="notice notice-bad">${escapeHtml(opts.error)}</p>` : ''
  const body = `<section class="account-page">
  <h1 class="large-title">我的账户</h1>
  <p class="lede">${escapeHtml(name)} · ${role}</p>
  ${notice}${error}
  <div class="account-card">
    <h2>修改口令</h2>
    <p class="stat-sub">改完后其他设备会立即掉线；当前浏览器会重新签发，保持登录。</p>
    <form class="account-form" method="post" action="/password">
      ${csrfField()}
      <label>当前口令 <input type="password" name="current" autocomplete="current-password" required></label>
      <label>新口令 <input type="password" name="next" autocomplete="new-password" minlength="${MIN_PASSWORD_LENGTH}" required></label>
      <label>再输一次 <input type="password" name="confirm" autocomplete="new-password" minlength="${MIN_PASSWORD_LENGTH}" required></label>
      <button type="submit">更新口令</button>
    </form>
  </div>
</section>`
  return layout({ title: '我的账户', description: site.description, sidebar: null, bodyClass: 'page-account', body }, site)
}

export function notFoundPage(site: { title: string; description: string }): string {
  const body = `<section class="section"><h1>404</h1><p class="empty">这个页面不存在。</p><p class="back"><a href="/">← 回首页</a></p></section>`
  return layout({ title: '404', description: site.description, sidebar: null, body, bodyClass: 'page-error' }, site)
}

/** 管理台文章列表里的一行。 */
export interface AdminArticleListItem {
  slug: string
  title: string
  date: string
  draft: boolean
  /** 在回收站里（`deleted_at` 非空）。列表里**标出来**，但不在这里做还原/彻底删除（归 #51）。 */
  trashed: boolean
  tags: string[]
}

/** 编辑面要的一份表单数据。**`bodyJson` 是库里的文档 JSON 原文**（编辑器直接吃它）。 */
export interface AdminArticleForm {
  slug: string
  title: string
  date: string
  /** 逗号分隔的原始串（照用户上次输入的样子回填）。 */
  tags: string
  summary: string
  /**
   * 正文的**文档 JSON 原文**（字符串）。它同时是「初次内容」与「400 回填」的载体 ——
   * 编辑器读它、写回它，所以失败重渲染时正文一个字都不会丢。
   */
  bodyJson: string
  draft: boolean
  /** 新建时 slug 可填；已有文章**只读**（发布后不可改，`article-rules.ts` 的规矩）。 */
  isNew: boolean
  /** 在回收站里。此时**不给编辑表单**，只给「还原」—— 想改就先还原，别在看不见影响的地方编辑。 */
  trashed: boolean
}

export interface AdminArticlesOptions {
  notice?: unknown
  /** 400 的失败说明（**就地重渲染**时显示）。 */
  bad?: string | null
  /** 草稿的渲染预览（HTML，已由 `docToHtml` 产出）。**只在管理台内**。 */
  preview?: string | null
  /** 修订历史（最近的在最上面）。**只在编辑已有文章时给**。 */
  revisions?: AdminRevisionItem[]
  /**
   * 刚上传成功的图片：`name` 已由调用方用 `isSafeMediaName` 校验过（**不是 URL 里的自由文本**）。
   * 片段里的 alt 用通用的「图片」—— 原文件名不在回跳里传（那会变成「URL 让页面显示任意文本」）。
   */
  uploaded?: { name: string; snippet: string } | null
}

/** 修订列表里的一条。`markdown` 是那一版正文还原出来的 Markdown（给人看全文用）。 */
export interface AdminRevisionItem {
  id: number
  savedAt: number
  title: string
  markdown: string
  /** 那一版**当时**是草稿还是已发布 —— 只是给人看的信息，**退回时不用它**。 */
  draft: boolean
}

/**
 * `/admin/articles`（`docs/article-write-api-decision.md` §3.4）。
 *
 * 一页两态：**列表**，或列表 + 展开的编辑面（`?edit=<slug>`）。
 *
 * ⚠ **失败时正文必须回填** —— 调用方把用户刚提交的**文档 JSON** 放回 `edit.bodyJson`，
 * 这一页只负责原样渲染（编辑器从 hidden 字段读它）。票面原话：一篇三千字因为 slug 重名被打回、
 * 正文却空了，是这个页面能犯的**最贵**的一次错。
 *
 * 草稿预览**在同一页面、同一鉴权**下渲染 —— **不在 `/posts/*` 下开任何预览入口**。
 */
export function adminArticlesPage(
  list: AdminArticleListItem[],
  trash: AdminArticleListItem[],
  edit: AdminArticleForm | null,
  opts: AdminArticlesOptions,
  site: { title: string; description: string },
): string {
  const rows = list.length
    ? list
        .map((a) => {
          const badge = a.trashed
            ? '<span class="tag tag-active">回收站</span>'
            : a.draft
              ? '<span class="tag">草稿</span>'
              : ''
          const tags = a.tags.map((t) => '<span class="tag">' + escapeHtml(t) + '</span>').join('')
          return (
            '<div class="cell article-row">' +
            '<div class="cell-main">' +
            '<span class="cell-title"><a href="/admin/articles?edit=' + encodeURIComponent(a.slug) + '">' + escapeHtml(a.title) + '</a></span>' +
            '<span class="cell-sub">' + escapeHtml(a.slug) + ' · ' + escapeHtml(a.date) + '</span>' +
            (tags ? '<span class="tags">' + tags + '</span>' : '') +
            '</div>' + badge +
            '<span class="chev" aria-hidden="true">' + icon('chev') + '</span>' +
            '</div>'
          )
        })
        .join('')
    : '<p class="empty">还没有文章。</p>'

  const editForm = edit
    ? edit.trashed
      ? `<h2>${escapeHtml(edit.title)}</h2>
<p class="notice notice-warn">这篇在<strong>回收站</strong>里。回收站里只做「还原 / 彻底删除」两件事 ——
想改就先还原，这样你不会在看不见影响的地方编辑。</p>
<form method="post" action="/admin/articles" class="form-actions">${csrfField()}
<input type="hidden" name="action" value="article-restore">
<input type="hidden" name="orig_slug" value="${escapeHtml(edit.slug)}">
<button type="submit">还原到「${edit.draft ? '草稿' : '已发布'}」</button>
<span class="stat-sub">还原后它回到<strong>删除前那个状态</strong>（不需要你重新判断一遍）。</span>
</form>`
      : `<h2>${edit.isNew ? '新建文章' : '编辑：' + escapeHtml(edit.title)}</h2>
<form method="post" action="/admin/articles" class="article-form">${csrfField()}
<input type="hidden" name="action" value="${edit.isNew ? 'article-create' : 'article-save'}">
<input type="hidden" name="orig_slug" value="${escapeHtml(edit.slug)}">
<div class="form-row">
<label>标题 <input name="title" value="${escapeHtml(edit.title)}" required></label>
<label>slug <input name="slug" value="${escapeHtml(edit.slug)}"${edit.isNew ? '' : ' readonly'}></label>
</div>
<div class="form-row">
<label>日期 <input type="date" name="date" value="${escapeHtml(edit.date)}"></label>
<label>标签 <input name="tags" value="${escapeHtml(edit.tags)}" placeholder="逗号分隔"></label>
</div>
<div class="form-row">
<label>摘要 <input name="summary" value="${escapeHtml(edit.summary)}" placeholder="留空则从正文派生"></label>
</div>
<input type="hidden" name="body_json" id="article-body-json" value="${escapeHtml(edit.bodyJson)}">
<noscript><p class="notice notice-bad">写作区需要 JavaScript：富文本编辑器不会加载。
请在浏览器里开启 JS 后再写（<strong>读文章一直不需要 JS</strong>）。</p></noscript>
<div id="article-editor" class="article-editor"${opts.uploaded ? ' data-uploaded-name="' + escapeHtml(opts.uploaded.name) + '"' : ''}></div>
<script src="/article-editor.js" defer></script>
<div class="form-actions"><button type="submit">保存</button>
<span class="stat-sub">保存后刷新不重复提交。（写作区需要 JS；读面不需要。）</span></div>
</form>
${
  edit.isNew
    ? ''
    : `<form method="post" action="/admin/articles" class="form-actions">${csrfField()}
<input type="hidden" name="action" value="${edit.draft ? 'article-publish' : 'article-unpublish'}">
<input type="hidden" name="orig_slug" value="${escapeHtml(edit.slug)}">
<button type="submit"${edit.draft ? '' : ' class="btn-danger"'}>${edit.draft ? '发布' : '撤下（改回草稿）'}</button>
<span class="stat-sub">${edit.draft ? '发布后它会出现在「分享」里，slug 从此不可改。' : '撤下后读者看不到它，但它还在，随时可以再发。'}</span>
</form>
<form method="post" action="/admin/articles" class="form-actions">${csrfField()}
<input type="hidden" name="action" value="article-trash">
<input type="hidden" name="orig_slug" value="${escapeHtml(edit.slug)}">
<button type="submit">移进回收站</button>
<span class="stat-sub">它不再出现在任何读者看得到的地方，但<strong>随时能还原</strong> —— 回收站不自动清空。</span>
</form>`
}
${
  opts.preview
    ? `<h2>预览（草稿在管理台内渲染，读者看不到）</h2><div class="card article-preview">${opts.preview}</div>`
    : ''
}`
    : ''

  const revisions = opts.revisions?.length
    ? `<h2>修订历史（${opts.revisions.length}）</h2>
<p class="admin-hint">每次保存留一版<strong>全文快照</strong>，永久保留（不自动清理）。
退回<strong>不会删掉任何版本</strong> —— 退回本身也是一次保存。</p>
<ol class="inset-list revision-list">
${opts.revisions
  .map(
    (r) => `<li class="cell-stack">
<div class="cell revision-row">
<strong>${escapeHtml(formatTime(r.savedAt))}</strong>
<span class="tag">${r.draft ? '当时是草稿' : '当时是已发布'}</span>
<span class="stat-sub">${escapeHtml(r.title)}</span>
<form method="post" action="/admin/articles" class="form-actions">${csrfField()}
<input type="hidden" name="action" value="article-revert">
<input type="hidden" name="orig_slug" value="${escapeHtml(edit?.slug ?? '')}">
<input type="hidden" name="revision" value="${r.id}">
<button type="submit">退回这一版</button></form>
</div>
<details class="cell-detail"><summary>看这一版的正文</summary><pre class="revision-body">${escapeHtml(r.markdown)}</pre></details>
</li>`,
  )
  .join('')}
</ol>`
    : ''

  const trashSection = trash.length
    ? `<h2>回收站（${trash.length}）</h2>
<p class="admin-hint">这里的文章<strong>读者看不到</strong>，但它们的 slug 仍然被占着 —— 免得旧链接被别人捡去用。</p>
<div class="inset-list">
${trash
  .map(
    (a) => `<div class="cell-stack">
<div class="cell article-row">
<div class="cell-main">
<span class="cell-title"><a href="/admin/articles?edit=${encodeURIComponent(a.slug)}">${escapeHtml(a.title)}</a></span>
<span class="cell-sub">${escapeHtml(a.slug)} · ${escapeHtml(a.date)}</span>
</div>
<span class="tag">${a.draft ? '草稿' : '已发布'}</span>
<span class="chev" aria-hidden="true">${icon('chev')}</span>
</div>
<div class="cell cell-actions">
<form method="post" action="/admin/articles" class="form-actions">${csrfField()}
<input type="hidden" name="action" value="article-restore">
<input type="hidden" name="orig_slug" value="${escapeHtml(a.slug)}">
<button type="submit">还原</button></form>
<form method="post" action="/admin/articles" class="form-actions">${csrfField()}
<input type="hidden" name="action" value="article-purge">
<input type="hidden" name="orig_slug" value="${escapeHtml(a.slug)}">
<label class="confirm"><input type="checkbox" name="confirm" value="yes" required> 我确认彻底删除，<strong>不可恢复</strong></label>
<button type="submit" class="btn-danger">彻底删除</button></form>
</div></div>`,
  )
  .join('')}
</div>`
    : ''

  const uploadBox =
    // 上传后立刻能拿到可粘贴的片段（规格 user story 2/12）—— **alt 用通用的「图片」**，
    // 提示用户自己改；原文件名不进 URL（见 `AdminArticlesOptions.uploaded` 的注释）。
    (opts.uploaded
      ? `<div class="card">
<p><img src="/media/${escapeHtml(opts.uploaded.name)}" alt="" class="upload-preview"></p>
<p class="stat-sub">编辑器加载时会把它<strong>插进正文末尾</strong>；下面这行是 Markdown 逃生口（<code>--reimport</code>）用的片段。</p>
<pre class="media-snippet">${escapeHtml(opts.uploaded.snippet)}</pre>
</div>`
      : '') +
    // 上传表单：**原生表单**，所以禁用 JS 也能传（规格 user story 3）。
    `<form method="post" action="/admin/articles/media" enctype="multipart/form-data" class="form-actions">${csrfField()}
<input type="hidden" name="edit_slug" value="${escapeHtml(edit?.slug ?? '')}">
<input type="file" name="file" accept="image/png,image/jpeg,image/webp,image/gif" required>
<button type="submit">上传图片</button>
<span class="stat-sub">一次一张 · png/jpeg/webp/gif · 最大 8 MiB · 同一张图重复上传不会产生第二个文件</span>
</form>`

  const body =
    renderNotice(opts.notice) +
    (opts.bad ? '<p class="notice notice-bad">' + escapeHtml(opts.bad) + '</p>' : '') +
    `<h1>文章</h1>
<p class="admin-hint">这一版能写、能改、能发。回收站与修订历史在下一票。</p>
${uploadBox}
<p class="form-actions"><a class="btn btn-primary" href="/admin/articles?edit=">＋ 新建一篇</a></p>
<div class="inset-list">${rows}</div>
${trashSection}
${editForm}
${revisions}`

  return layout({ title: '文章 · 管理台', description: site.description, adminSection: 'articles', sidebar: null, body }, site)
}
