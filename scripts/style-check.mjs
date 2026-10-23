/**
 * 样式断言。**不过 HTTP、不起服务**：它读 `public/style.css`、`src/views.ts` 与 `public/status.js`，
 * 把三者之间的一致性钉住。
 *
 * 这一版对应「Claude 支持中心换装 · T1 基座」（#85 / #89）：
 *  - token：**17 色 `light-dark()` + 29 个非颜色**；三态只切 `color-scheme`；
 *  - 对比度：**16 对文字 ×2 + 10 对非文字 ×2**（#85 §2.3）；
 *  - 排版：**一套 Claude 字阶**（10 字号 + 4 行高；`--font-display` 只给 ≥ `--fs-title3`）；
 *  - 打印：**17 个灰阶 token + 状态格带图案**（#85 §5）。
 *
 * ⚠ 它证明不了的事：窄屏/深色的**目视观感**、打印出来的**实际效果**、真机字体回退。
 *   这些只能靠眼睛，脚本只能保证规则存在、数值达标。
 */
import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const css = fs.readFileSync(path.join(root, 'public/style.css'), 'utf8')
const views = fs.readFileSync(path.join(root, 'src/views.ts'), 'utf8')
const statusJs = fs.readFileSync(path.join(root, 'public/status.js'), 'utf8')
const iconsTs = fs.readFileSync(path.join(root, 'src/icons.ts'), 'utf8')
const chartsTs = fs.readFileSync(path.join(root, 'src/charts.ts'), 'utf8')

let passed = 0
let failed = 0
const failures = []
const check = (label, cond, detail = '') => {
  if (cond) {
    passed++
    console.log(`  ✅ ${label}${detail ? '  → ' + detail : ''}`)
  } else {
    failed++
    failures.push(label)
    console.log(`  ❌ ${label}${detail ? '  → ' + detail : ''}`)
  }
}
const section = (name) => console.log(`\n[${name}]`)

// ── 小工具 ──
function blockAfter(text, startIdx) {
  const open = text.indexOf('{', startIdx)
  if (open < 0) return ''
  let depth = 0
  for (let i = open; i < text.length; i++) {
    if (text[i] === '{') depth++
    else if (text[i] === '}') {
      depth--
      if (depth === 0) return text.slice(open + 1, i)
    }
  }
  return ''
}
function blockWithBraces(text, startIdx) {
  const open = text.indexOf('{', startIdx)
  if (open < 0) return ''
  let depth = 0
  for (let i = open; i < text.length; i++) {
    if (text[i] === '{') depth++
    else if (text[i] === '}') {
      depth--
      if (depth === 0) return text.slice(startIdx, i + 1)
    }
  }
  return ''
}
const stripComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '')
const parseTokens = (text) => {
  const out = {}
  for (const m of text.matchAll(/--([\w-]+)\s*:\s*([^;]+);/g)) out[m[1]] = m[2].trim()
  return out
}
const parseLightDark = (value) => {
  const m = /^light-dark\(\s*(#[0-9a-f]{3,8})\s*,\s*(#[0-9a-f]{3,8})\s*\)$/i.exec(value ?? '')
  return m ? [m[1], m[2]] : null
}
const channel = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
const luminance = (hex) => {
  const h = hex.replace('#', '')
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h
  const [r, g, b] = [0, 2, 4].map((i) => channel(parseInt(full.slice(i, i + 2), 16) / 255))
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
const contrast = (fg, bg) => {
  const [hi, lo] = [luminance(fg), luminance(bg)].sort((a, b) => b - a)
  return (hi + 0.05) / (lo + 0.05)
}
const isGrayscale = (hex) => {
  const h = hex.replace('#', '')
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16))
  return r === g && g === b
}

const COLOR_TOKENS = new Set([
  'bg', 'bg-card', 'bg-elev', 'fill', 'fill-strong',
  'label', 'label-2', 'label-3', 'separator', 'border-strong',
  'accent', 'on-accent', 'ok', 'warn', 'bad', 'unknown', 'scrim',
])
const NON_COLOR = new Set([
  // 形状 / 栏宽 / 字体
  'radius', 'radius-sm', 'radius-lg', 'tap', 'wrap', 'wrap-admin', 'rail-w', 'font', 'mono',
  'font-display', 'wrap-docs', 'side-w', 'gap-docs', 'header-h',
  // Claude 字阶（10 字号 + 4 行高）
  'fs-large', 'fs-title1', 'fs-title2', 'fs-title3', 'fs-headline',
  'fs-body', 'fs-callout', 'fs-subhead', 'fs-footnote', 'fs-caption',
  'lh-tight', 'lh-title', 'lh-ui', 'lh-prose',
  // 阅读栏宽
  'measure-prose',
])

const cssNoComments = stripComments(css)
const rootStart = css.indexOf(':root {')
const rootBody = blockAfter(css, rootStart)
const rootWhole = blockWithBraces(cssNoComments, cssNoComments.indexOf(':root {'))
const printStart = css.lastIndexOf('@media print')
const printBody = blockAfter(css, printStart)
const printWhole = blockWithBraces(cssNoComments, cssNoComments.lastIndexOf('@media print'))
const cssOutsideTokens = cssNoComments.replace(rootWhole, '').replace(printWhole, '')

// ════════════════════════════════════════════════════
section('token 表：17 色 light-dark + 29 非色，三态只切 color-scheme（#85）')
// ════════════════════════════════════════════════════
{
  const rootCount = (css.match(/:root\s*\{/g) ?? []).length
  check('全站 `:root` 恰好一个（浅深并排写在一份表里）', rootCount === 1, `实际 ${rootCount}`)

  check('CSS 里没有 `@media (prefers-color-scheme …)` 块（三态不走媒体查询）', !/@media[^{]*prefers-color-scheme/.test(css))

  const tokens = parseTokens(rootBody)
  const colorKeys = Object.keys(tokens).filter((k) => !NON_COLOR.has(k))
  const missingNonColor = [...NON_COLOR].filter((k) => !(k in tokens))
  check('颜色 token 恰好 17 个（精确集合）', colorKeys.length === 17 && colorKeys.every((k) => COLOR_TOKENS.has(k)) && [...COLOR_TOKENS].every((k) => colorKeys.includes(k)), colorKeys.join(', '))
  check('29 个非颜色 token 全在同一个 `:root` 里', missingNonColor.length === 0, missingNonColor.join(', '))

  const defs = (text) => {
    let n = 0
    for (const t of COLOR_TOKENS) n += (text.match(new RegExp(`--${t}\\s*:`, 'g')) ?? []).length
    return n
  }
  const inRoot = defs(rootWhole)
  const inPrint = defs(printWhole)
  const all = defs(cssNoComments)
  check('颜色 token 只定义在唯一的 `:root` 与打印块两处', all === inRoot + inPrint && inRoot === 17 && inPrint === 17, `全站 ${all} · :root ${inRoot} · 打印 ${inPrint}`)

  const literals = (cssOutsideTokens.match(/#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(/gi) ?? []).length
  check('颜色字面量（#hex / rgb() / hsl()）只出现在 `:root` 与打印块', literals === 0, `别处 ${literals} 处`)

  check('打印块**不在 `:root` 上**改 token（改在 `body` 上）', /\bbody\s*\{/.test(printWhole) && !/:root/.test(printWhole))

  check('`:root` 里有 `color-scheme: light dark`（跟随系统）', /color-scheme:\s*light\s+dark/.test(rootBody))
  const themeBlock = (name) => {
    const i = css.indexOf(`:root[data-theme="${name}"]`)
    return i < 0 ? null : blockAfter(css, i).trim()
  }
  check('`[data-theme="light"]` 只写 `color-scheme: light`', themeBlock('light') === 'color-scheme: light;')
  check('`[data-theme="dark"]` 只写 `color-scheme: dark`', themeBlock('dark') === 'color-scheme: dark;')
  globalThis.__rootTokens = tokens
  globalThis.__printTokens = parseTokens(printBody)
}

// ════════════════════════════════════════════════════
section('对比度：16 对文字 ×2 模式 ≥4.5、10 对非文字 ×2 模式 ≥3（#85 §2.3）')
// ════════════════════════════════════════════════════
{
  const tokens = globalThis.__rootTokens
  const colorValue = (name, mode) => {
    if (name === 'scrim') return null
    const pair = parseLightDark(tokens[name] ?? '')
    return pair ? pair[mode === 'light' ? 0 : 1] : null
  }
  const TEXT_PAIRS = [
    ['label', 'bg'], ['label', 'bg-card'], ['label', 'bg-elev'], ['label', 'fill'],
    ['label-2', 'bg'], ['label-2', 'bg-card'], ['label-2', 'bg-elev'], ['label-2', 'fill'],
    ['on-accent', 'accent'],
    ['ok', 'bg-card'], ['ok', 'bg-elev'],
    ['warn', 'bg-card'], ['warn', 'bg-elev'],
    ['bad', 'bg-card'], ['bad', 'bg-elev'], ['bad', 'fill'],
  ]
  const NON_TEXT_PAIRS = [
    ['label-3', 'bg'], ['label-3', 'bg-card'], ['label-3', 'bg-elev'], ['label-3', 'fill'],
    ['border-strong', 'bg'], ['border-strong', 'bg-card'], ['border-strong', 'bg-elev'], ['border-strong', 'fill'],
    ['accent', 'bg'], ['accent', 'bg-card'],
  ]
  const FORBIDDEN_ACCENT_PAIRS = [['accent', 'bg-elev'], ['accent', 'fill']]
  check(
    'accent 的失败对已禁用（不在 NON_TEXT_PAIRS）',
    FORBIDDEN_ACCENT_PAIRS.every(([fg, bg]) => !NON_TEXT_PAIRS.some(([f, b]) => f === fg && b === bg)),
  )
  const ALLOWED = {} // 空表：全部达标，不为任何一对登记例外
  for (const mode of ['light', 'dark']) {
    for (const [fgKey, bgKey] of TEXT_PAIRS) {
      const fg = colorValue(fgKey, mode)
      const bg = colorValue(bgKey, mode)
      if (!fg || !bg) {
        check(`${mode}：${fgKey} on ${bgKey} 能算（token 是 light-dark 纯色）`, false, `${fg} / ${bg}`)
        continue
      }
      const r = contrast(fg, bg)
      const ok = r >= 4.5 || Boolean(ALLOWED[`${fgKey}/${bgKey}`])
      check(`${mode}：${fgKey} on ${bgKey} = ${r.toFixed(2)}:1`, ok, `${fg} on ${bg}`)
    }
    for (const [fgKey, bgKey] of NON_TEXT_PAIRS) {
      const fg = colorValue(fgKey, mode)
      const bg = colorValue(bgKey, mode)
      if (!fg || !bg) {
        check(`${mode}：${fgKey} on ${bgKey} 能算（非文字）`, false, `${fg} / ${bg}`)
        continue
      }
      const r = contrast(fg, bg)
      check(`${mode}：${fgKey} on ${bgKey} = ${r.toFixed(2)}:1（非文字 ≥3）`, r >= 3, `${fg} on ${bg}`)
    }
  }
}

// ════════════════════════════════════════════════════
section('服务端渲染的类名，CSS 里都有定义')
// ════════════════════════════════════════════════════
{
  const classesFrom = (text) => {
    const found = new Set()
    const add = (raw) => {
      for (const c of raw.split(/\s+/)) if (/^[a-z][\w-]*$/.test(c)) found.add(c)
    }
    for (const m of text.matchAll(/class=(?:"([^"]*)"|'([^']*)')/g)) {
      const attr = m[1] ?? m[2] ?? ''
      for (const expr of attr.matchAll(/\$\{([^}]*)\}/g)) {
        const e = expr[1]
        const resultPart = e.includes('?') ? e.slice(e.indexOf('?') + 1) : ''
        for (const lit of resultPart.matchAll(/'([^']*)'|"([^"]*)"/g)) add(lit[1] ?? lit[2] ?? '')
      }
      add(attr.replace(/\$\{[^}]*\}/g, ' '))
    }
    return found
  }
  const hasRule = (name) => new RegExp(`\\.${name.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}(?![\\w-])`).test(css)
  const NO_RULE_NEEDED = new Set(['js-cells', 'js-generated'])
  const STATE_VALUES = new Set(['up', 'degraded', 'down', 'ok', 'warn', 'bad', 'unknown', 'missing'])

  const all = [...new Set([...classesFrom(views), ...classesFrom(statusJs)])].filter((c) => !STATE_VALUES.has(c))
  const missing = all.filter((c) => !hasRule(c) && !NO_RULE_NEEDED.has(c))
  check(
    `views.ts / status.js 里出现的 ${all.length} 个类名都有 CSS 定义`,
    missing.length === 0,
    missing.length ? '缺：' + missing.join(', ') : '（含例外：' + [...NO_RULE_NEEDED].join(', ') + '）',
  )

  for (const s of ['up', 'degraded', 'down']) {
    check(`状态值 \`${s}\` 在 CSS 里有对应规则（格带）`, new RegExp(`\\.cell-strip i\\.${s}\\b`).test(css))
  }
  for (const s of ['ok', 'warn', 'bad']) {
    check(`样式类 \`${s}\` 在 CSS 里有对应规则（徽标/点）`, new RegExp(`\\.(badge|dot)\\.${s}\\b`).test(css))
  }
  check('退场类名清零（plane / site-nav / nav-sep / admin-side / admin-table / mini / admin-shell / admin-main）', ![/(?:plane-(?:data|prose)|site-nav|nav-sep|admin-side|admin-table|mini-|admin-shell|admin-main)/].some((re) => re.test(cssNoComments) || re.test(views)))
  check('图标全部来自 `icon()`（没有图标字体 / 外部图标库）', views.includes("from './icons.js'") && views.includes('icon(') && !views.includes('@font-face'))
  check('`icons.ts` 里没有颜色字面量（只有 currentColor）', !/#[0-9a-f]{3,8}\b/i.test(iconsTs))
}

// ════════════════════════════════════════════════════
section('排版：一套 Claude 字阶（#85 §3）')
// ════════════════════════════════════════════════════
{
  check('CSS 代码里没有 `plane-`（平面已退役，只许出现在注释里）', !cssNoComments.includes('plane-'))
  check('`views.ts` 里没有 `plane-`（`<body>` 不再带平面类）', !views.includes('plane-'))
  check('排版 token 已退役（font-data/prose、fs-data/prose、lh-data 全不在）', ['--font-data:', '--font-prose:', '--fs-data:', '--lh-data:', '--fs-prose:'].every((t) => !cssNoComments.includes(t)))

  check('`body` 用 `var(--font)` 与 `--fs-callout`（不再按平面换字体）', /body\s*\{[^}]*font-family:\s*var\(--font\)/s.test(css) && /body\s*\{[^}]*font-size:\s*var\(--fs-callout\)/s.test(css))
  check('10 个字号 token 与 4 个行高 token 都在 `:root`', ['fs-large', 'fs-title1', 'fs-title2', 'fs-title3', 'fs-headline', 'fs-body', 'fs-callout', 'fs-subhead', 'fs-footnote', 'fs-caption', 'lh-tight', 'lh-title', 'lh-ui', 'lh-prose'].every((k) => new RegExp(`--${k}\\s*:`).test(css)))

  check('Large Title 落在页面主标题（`.hero h1` / `h1.large-title` → `--fs-large`）', /\.hero h1\s*\{[^}]*font-size:\s*var\(--fs-large\)/s.test(css) && /h1\.large-title\s*\{[^}]*font-size:\s*var\(--fs-large\)/s.test(css))
  check('Title 1 落在文章标题（`.post-header h1` → `--fs-title1`）', /\.post-header h1\s*\{[^}]*font-size:\s*var\(--fs-title1\)/s.test(css))
  check('Title 2 落在区块标题与统计数字（`.prose h2` / `.stat-num` → `--fs-title2`）', /\.prose h2\s*\{[^}]*font-size:\s*var\(--fs-title2\)/s.test(css) && /\.stat-num\s*\{[^}]*font-size:\s*var\(--fs-title2\)/s.test(css))
  check('Title 3 落在状态页分组标题（`.group-title` → `--fs-title3`）', /\.group-title\s*\{[^}]*font-size:\s*var\(--fs-title3\)/s.test(css))
  check('Headline 落在 `.prose h3`（18 sans，不再回到衬线 20）', /\.prose h3\s*\{[^}]*font-size:\s*var\(--fs-headline\)/s.test(css))
  check('Body 落在长文（`.prose` → `--fs-body` + `--lh-prose`）', /\.prose\s*\{[^}]*font-size:\s*var\(--fs-body\)[^}]*line-height:\s*var\(--lh-prose\)/s.test(css))
  check('Caption 落在徽标 / 标签 / 格带说明 / 图表轴（`--fs-caption`）', ['.badge', '.tag', '.cell-caption', '.chart-axis'].every((sel) => new RegExp(`${sel.replace('.', '\\.')}\\s*\\{[^}]*font-size:\\s*var\\(--fs-caption\\)`, 's').test(css)))
  check('Footnote 落在 meta / stat-sub / kv（`--fs-footnote`）', ['.post-card .meta, .post-header .meta', '.stat-sub', '.kv dd'].every((sel) => new RegExp(`${sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{[^}]*font-size:\\s*var\\(--fs-footnote\\)`, 's').test(css)))

  // --label-3 只有非文字对比度（3.27–4.15），任何带 font-size 的规则里都不许出现它
  const blocks = cssNoComments.split('}')
  const label3WithFont = blocks.filter((b) => b.includes('font-size') && b.includes('var(--label-3)')).length
  check('`--label-3` 只做非文字（不出现在任何带 `font-size` 的规则里）', label3WithFont === 0, `实际 ${label3WithFont} 处`)

  check('正文栏宽 68ch（`.prose` 用 `var(--measure-prose)`）', /\.prose\s*\{[^}]*max-width:\s*var\(--measure-prose\)/s.test(css))
  const serifRules = cssNoComments.split('}').filter((b) => b.includes('font-family: var(--font-display)') && b.includes('font-size: var(--fs-'))
  // 头像首字母是装饰性字形，不是标题；它是唯一允许 <21px 的衬线例外（#87 §3.1）。
  const smallSerif = serifRules.filter((b) => !/\.avatar\b/.test(b) && /font-size:\s*var\(--fs-(headline|subhead|footnote|caption|body|callout)\)/.test(b))
  check('--font-display 只给标题（--fs-title3 及以上；头像首字母例外）', smallSerif.length === 0, smallSerif.map((b) => b.slice(0, 60)).join(' | '))
  check('`--font-display` 是系统衬线栈（无 @font-face / 外部字体）', /--font-display:\s*ui-serif/.test(rootBody) && !/@font-face/.test(css))
  check('`--measure-prose` 的值是 68ch', /--measure-prose:\s*68ch/.test(rootBody))
  check('`--radius-lg` 已收到 12px', /--radius-lg:\s*12px/.test(rootBody))
  check('B 外壳 token：--header-h:56 / --side-w:224 / --gap-docs:28 / --wrap-docs:1360', ['header-h: 56px', 'side-w: 224px', 'gap-docs: 28px', 'wrap-docs: 1360px'].every((t) => rootBody.includes(t)))
  check('`.dot.unknown` 有 `--label-3` 描边（不只靠 --unknown 填充）', /\.dot\.unknown\s*\{[^}]*var\(--label-3\)/s.test(css))
  check('窄栏在画布里居中（`.prose` 与 `.post` 都有 `margin-inline: auto`）', /\.prose\s*\{[^}]*margin-inline:\s*auto/s.test(css) && /\.post\s*\{[^}]*margin-inline:\s*auto/s.test(css))
  check('页脚贴底：body 是撑满一屏的 flex 列，`.app-shell` 吃掉剩余高度', /body:not\(\.login-body\)\s*\{[^}]*display:\s*flex[^}]*min-height:\s*100vh/s.test(css) && /body:not\(\.login-body\)\s*>\s*\.app-shell\s*\{[^}]*flex:\s*1 0 auto/s.test(css))
  check('登录页被排除在贴底布局之外（它自己是 100vh 居中块）', /body:not\(\.login-body\)/.test(css))
  check('打印时不留「撑满一屏」', /@media print[\s\S]*?body\s*\{[^}]*display:\s*block/s.test(css))
  check(
    '单元格里的段落不带下边距（表格行不被撑高，读面 + 编辑面）',
    /\.prose th p,\s*\.prose td p,[\s\S]{0,160}\.ProseMirror th p,\s*\.article-editor \.ProseMirror td p\s*\{\s*margin:\s*0/.test(css),
  )
  check('宽表有横向滚动容器（`.prose .table-wrap` → `overflow-x: auto`）', /\.prose \.table-wrap\s*\{[^}]*overflow-x:\s*auto/s.test(css))
  check('滚动容器的下边距挂在容器上（表格自己不带）', /\.prose \.table-wrap table\s*\{[^}]*margin:\s*0/s.test(css))
  check('单元格有最小列宽（否则中文会让滚动永不触发）', /\.prose \.table-wrap th,\s*\.prose \.table-wrap td\s*\{[^}]*min-width:\s*[\d.]+em/s.test(css))
  check('打印时滚动容器放开（纸上滚不了，宽表不能被裁）', /@media print[\s\S]*\.prose \.table-wrap\s*\{\s*overflow:\s*visible/s.test(css))
}

// ════════════════════════════════════════════════════
section('主题三态：boot 在 stylesheet 前，picker 两处，无 JS 时降级（#67）')
// ════════════════════════════════════════════════════
{
  check('`<meta name="color-scheme" content="light dark">` 出现 2 次（layout + login）', (views.match(/<meta name="color-scheme" content="light dark">/g) ?? []).length === 2)
  const bootSplits = views.split('${themeBoot()}')
  check('boot 脚本在 `<link rel="stylesheet">` 之前（两个外壳各一处）', bootSplits.length === 3 && bootSplits.slice(1).every((part) => part.slice(0, 200).includes('<link rel="stylesheet" href="/style.css">')))
  check('boot 只读 `theme` 键、用 `dataset.theme`、有 try/catch', /localStorage\.getItem\('theme'\)/.test(views) && /dataset\.theme\s*=/.test(views) && /try\{[\s\S]*?catch\(e\)\{\}/.test(views))
  check('picker 是原生 `<select data-theme-select>`，三项 + `aria-label="主题"`，两个外壳各调用一次', /<select data-theme-select aria-label="主题">/.test(views) && ['system', 'light', 'dark'].every((v) => new RegExp(`<option value="${v}">`).test(views)) && (views.match(/\$\{themePicker\(\)\}/g) ?? []).length === 2)
  check('无 JS 时 picker 隐藏（`<noscript>` 里的 `[data-theme-select]` 规则出现 2 次）', (views.match(/<noscript><style>\[data-theme-select\] \{ display: none \}<\/style><\/noscript>/g) ?? []).length === 2)
  check('不监听 matchMedia、不写 cookie', !views.includes('matchMedia(') && !views.includes('document.cookie'))
}

// ════════════════════════════════════════════════════
section('打印：17 个灰阶 token + 格带图案（#85 §5）')
// ════════════════════════════════════════════════════
{
  const printTokens = globalThis.__printTokens
  const missing = [...COLOR_TOKENS].filter((t) => !(t in printTokens))
  check('17 个颜色 token 全部在打印块里重定义', missing.length === 0, missing.join(', '))
  const bad = [...COLOR_TOKENS].filter((t) => t in printTokens && !/^#[0-9a-f]{3,8}$/i.test(printTokens[t])).map((t) => `${t}=${printTokens[t]}`)
  check('打印 token 的值全是纯色 hex（不写 `light-dark()`）', bad.length === 0, bad.join(', '))
  const notGray = [...COLOR_TOKENS].filter((t) => t in printTokens && /^#[0-9a-f]{3,8}$/i.test(printTokens[t]) && !isGrayscale(printTokens[t]))
  check('打印 token 的值全是灰阶', notGray.length === 0, notGray.join(', '))
  check('打印块有 `color-scheme: light`（UA 层也回浅色）', /color-scheme:\s*light/.test(printBody))
  check('打印块里没有 `light-dark()`', !printBody.includes('light-dark('))
  check('格带 `up` 打印为实心', /\.cell-strip i\.up\s*\{\s*background:\s*#000/s.test(printBody))
  check('格带 `degraded` 打印为 45° 斜线', /\.cell-strip i\.degraded\s*\{[^}]*repeating-linear-gradient\(45deg/s.test(printBody))
  check('格带 `down` 打印为斜网格（两个方向叠加）', /\.cell-strip i\.down\s*\{[^}]*repeating-linear-gradient\(45deg[^}]*repeating-linear-gradient\(-45deg/s.test(printBody))
  check('格带 `cell-missing` 打印为空心', /\.cell-strip i\.cell-missing\s*\{[^}]*background:\s*#fff/s.test(printBody))
  check('`print-color-adjust: exact` 只给状态格带', /\.cell-strip i\s*\{[^}]*print-color-adjust:\s*exact/s.test(printBody) && (printBody.match(/print-color-adjust:\s*exact/g) ?? []).length === 2)
}

/// ════════════════════════════════════════════════════
section('外壳与导航：公开顶栏 / docs-side / 管理 rail + admin-tabs（#86）')
// ════════════════════════════════════════════════════
{
  const narrow = (css.match(/@media \(max-width: 720px\)\s*\{([\s\S]*?)\n\}/) ?? [, ''])[1]
  check('`layout()` 三态外壳：docs / admin / plain', views.includes('class="${shellClass}"') && views.includes('opts.sidebar') && views.includes("'app-shell app-shell--docs'") && views.includes("'app-shell app-shell--admin'") && views.includes("'app-shell app-shell--plain'"))
  check('公开顶栏是 `<nav class="top-nav" aria-label="主导航">`，四项来自 NAV_ITEMS', views.includes('<nav class="top-nav" aria-label="主导航">') && views.includes('const NAV_ITEMS: ReadonlyArray<NavItem> = ['))
  check('公开文章侧栏是 `<nav class="docs-side" aria-label="公开文章">`', views.includes('<nav class="docs-side" aria-label="公开文章">'))
  check('管理台 rail 是唯一 `<nav class="site-rail" aria-label="管理台导航">`', views.includes('<nav class="site-rail" aria-label="管理台导航">'))
  check('管理 rail 六模块 + 运维 / 内容两段', ['overview', 'targets', 'accounts', 'backups', 'settings', 'articles'].every((k) => views.includes(`['${k}', '/admin`)) && views.includes("'运维',") && views.includes("['内容', [['articles'"))
  check('管理 rail 只在 adminSection 存在时渲染', views.includes('opts.adminSection ? `<nav class="site-rail"'))
  check('当前项：顶栏 key === active；管理 rail key === section', views.includes("item.key === active ? ' aria-current=\"page\"' : ''") && views.includes("key === section ? ' aria-current=\"page\"' : ''"))
  check('文章侧栏当前项：p.slug === sidebar.currentSlug', views.includes("p.slug === sidebar.currentSlug ? ' aria-current=\"page\"' : ''"))
  check('tab bar / ADMIN_ITEM / tabBar 已退役', !views.includes('tabBar') && !views.includes('ADMIN_ITEM') && !views.includes('class="tab-bar"') && !css.includes('.tab-bar'))
  check('`.admin-tabs` 只在 adminSection 存在时渲染', views.includes("${opts.adminSection ? adminTabs(opts.adminSection) : ''}"))
  check('页头**不透明**：`background: var(--bg)`，全站无 `backdrop-filter`', /\.site-header\s*\{[^}]*background:\s*var\(--bg\)/s.test(css) && !/backdrop-filter:/.test(css))
  check('外壳：docs 224 + 1fr；admin 248 + 1fr', /\.app-shell--docs\s*\{[^}]*grid-template-columns:\s*var\(--side-w\)\s+minmax\(0,\s*1fr\)/s.test(css) && /\.app-shell--admin\s*\{[^}]*grid-template-columns:\s*var\(--rail-w\)\s+minmax\(0,\s*1fr\)/s.test(css))
  check('栏宽 token：wrap-admin / rail-w / wrap-docs / side-w / gap-docs / header-h', ['--wrap-admin', '--rail-w', '--wrap-docs', '--side-w', '--gap-docs', '--header-h'].every((k) => new RegExp(`${k}\\s*:`).test(css)))
  check('720px：top-nav / docs-side / site-rail 隐藏，nav-drawer 出现，无 tab-bar', /\.top-nav\s*\{\s*display:\s*none/.test(narrow) && /\.docs-side[^{]*\{[^}]*display:\s*none/s.test(narrow) && /\.site-rail[^{]*\{[^}]*display:\s*none/s.test(narrow) && /\.nav-drawer\s*\{\s*display:\s*block/.test(narrow) && !/\.tab-bar/.test(narrow))
  check('720px 断点：管理台模块条出现（横向可滚）', /\.admin-tabs\s*\{[^}]*overflow-x:\s*auto/s.test(narrow))
  check('打印：site-rail / docs-side / nav-drawer / admin-tabs / header-actions 隐藏，外壳单列', printBody.includes('.site-rail') && printBody.includes('.docs-side') && printBody.includes('.nav-drawer') && printBody.includes('.admin-tabs') && printBody.includes('.header-actions') && /display:\s*none/.test(printBody) && /\.app-shell[^{]*\{[^}]*display:\s*block/s.test(printBody))
}

// ════════════════════════════════════════════════════
section('公开面：inset 列表 / 大标题 / 整行可点（#68 §6）')
// ════════════════════════════════════════════════════
{
  check('文章卡是 inset 列表里的一行（`class="cell post-card"` + `.inset-list.post-list`）', views.includes('class="cell post-card"') && views.includes('class="inset-list post-list"'))
  check('文章卡带 chevron（装饰性 `aria-hidden`）', views.includes('<span class="chev" aria-hidden="true">'))
  check('整行可点：标题链接的 `::after` 铺满行（不嵌套交互元素）', /\.post-card \.cell-title a::after\s*\{[^}]*position:\s*absolute[^}]*inset:\s*0/s.test(css))
  check('标签仍可点：`.post-card .tags a` 抬到覆盖层之上', /\.post-card \.tags a\s*\{[^}]*position:\s*relative[^}]*z-index:\s*1/s.test(css))
  check('标签条是 `.chip-row`（旧的 `.tag-bar` 已退役）', views.includes('class="chip-row"') && !views.includes('tag-bar') && !/\.tag-bar/.test(css))
  check('大标题落在三类页上（首页 hero / 分享 / 关于），且 CSS 是 38/600', (views.match(/class="large-title"/g) ?? []).length >= 3 && /h1\.large-title\s*\{[^}]*font-size:\s*var\(--fs-large\)/s.test(css) && /h1\.large-title\s*\{[^}]*font-weight:\s*600/s.test(css))
  check('空态是实色块（没有虚线占位框）', /\.empty\s*\{[^}]*background:\s*var\(--fill\)/s.test(css) && !/\.empty\s*\{[^}]*dashed/s.test(css))
  check('状态摘要行也用同一套 `.cell`（旧的 `.mini-*` 已退役）', views.includes('<div class="inset-list">${rows}</div>') && !views.includes('mini-') && !/\.mini-[a-z]/.test(css))
}

// ════════════════════════════════════════════════════
section('管理台：六页列表化与 details 折叠（#68 §8）')
// ════════════════════════════════════════════════════
{
  check('六个模块各自的 `adminSection` 都在（概览 / 目标 / 账号 / 备份 / 设置 / 文章）', ['overview', 'targets', 'accounts', 'backups', 'settings', 'articles'].every((k) => views.includes(`adminSection: '${k}'`)))
  check('目标列表：每行是 `cell-stack`，编辑表单收进 `<details class="cell-detail">`', views.includes('<div class="cell-stack">') && views.includes('<details class="cell-detail"') && views.includes('<summary>编辑「'))
  check('新增表单收进 `<details class="create-card">`（账号页同款）', (views.match(/class="create-card"/g) ?? []).length >= 2)
  check('破坏性动作仍是原生 `required` 复选框（不用 JS confirm）', (views.match(/name="confirm" value="yes" required/g) ?? []).length >= 3)
  check('`.admin-table` 已从视图与样式表里彻底退役', !views.includes('admin-table') && !css.includes('admin-table'))
  check('账号页三个动作表单仍在（改角色 / 停用或启用 / 重置口令）', ['account-role', 'account-disable', 'account-enable', 'account-reset-password'].every((a) => views.includes(`value="${a}"`)))
  check('目标行仍保留 `target-id`（e2e 按它数行）', (views.match(/class="target-id/g) ?? []).length === 1)
  check('打印时列表行留下、表单与折叠块隐藏', printBody.includes('details') && printBody.includes('input, select, textarea') && /display:\s*none/.test(printBody) && printBody.includes('.cell') && /break-inside:\s*avoid/.test(printBody))
}

// ════════════════════════════════════════════════════
section('编辑器工具栏：六组的分隔与换行（#79）')
// ════════════════════════════════════════════════════
{
  const editorTs = fs.readFileSync(path.join(root, 'src/editor/article-editor.ts'), 'utf8')
  const groupRule = (css.match(/\.editor-toolbar-group\s*\{[^}]*\}/) ?? [''])[0]
  check('工具栏容器仍允许换行（组才排得下一行一个）', /\.editor-toolbar\s*\{[^}]*flex-wrap:\s*wrap/s.test(css))
  check('组是一个 flex 项、整组换行（`flex: 0 1 auto` + `min-width: 0`：放不下也不横向溢出）', /flex:\s*0 1 auto/.test(groupRule) && /min-width:\s*0/.test(groupRule))
  const firstGroupRule = (css.match(/\.editor-toolbar-group:first-child\s*\{[^}]*\}/) ?? [''])[0]
  check(
    '组间用 `border-inline-start` 分隔，首组豁免',
    /border-inline-start:\s*1px solid var\(--separator\)/.test(groupRule) && /border-inline-start:\s*0/.test(firstGroupRule) && /padding-inline-start:\s*0/.test(firstGroupRule),
  )
  check('组标签用 `--fs-caption` + `--label-2`', /\.editor-toolbar-label\s*\{[^}]*font-size:\s*var\(--fs-caption\)[^}]*color:\s*var\(--label-2\)/s.test(css))
  check('组内按钮仍吃 `.editor-toolbar button` 的外观（选择器没被组切断）', /\.editor-toolbar button\s*\{[^}]*font-size:\s*var\(--fs-footnote\)/s.test(css))
  check('编辑器源码里的三个工具栏类名在 CSS 里都有定义', ['editor-toolbar', 'editor-toolbar-group', 'editor-toolbar-label'].every((c) => editorTs.includes(`'${c}'`) && new RegExp(`\\.${c}(?![\\w-])`).test(css)))
}

// ════════════════════════════════════════════════════
section('窄屏断点与打印其余')
// ════════════════════════════════════════════════════
{
  const narrow = (css.match(/@media \(max-width: 720px\)\s*\{([\s\S]*?)\n\}/) ?? [, ''])[1]
  const tight = (css.match(/@media \(max-width: 560px\)\s*\{([\s\S]*?)\n\}/) ?? [, ''])[1]
  check('存在 720px 断点（版面从多栏退成一栏）', narrow.length > 0)
  check('720px 断点里：目标卡与参数表退回一栏', /\.target-grid\s*\{\s*grid-template-columns:\s*1fr/.test(narrow) && /\.kv\s*\{\s*grid-template-columns:\s*1fr/.test(narrow))
  check('560px 断点存在，且表单行改成竖排', tight.length > 0 && /\.form-row\s*\{\s*flex-direction:\s*column/.test(tight))
  check('存在 `@media print`', printBody.length > 0)
  check('打印时把配色就地改成纸面（黑字白底）', /--bg:\s*#ffffff/.test(printBody) && /--label:\s*#000000/.test(printBody))
  check('打印时藏掉只在屏幕上成立的东西（页头 / docs-side / rail / 抽屉 / 模块条 / 登出 / 按钮 / picker）', /\.site-header[^{]*\{[^}]*display:\s*none/s.test(printBody) && /\.docs-side/.test(printBody) && /\.site-rail/.test(printBody) && /\.nav-drawer/.test(printBody) && /\.admin-tabs/.test(printBody) && /\bbutton\b[^{]*\{[^}]*display:\s*none/s.test(printBody) && /\.theme-picker/.test(printBody))
  check('打印时卡片不许被切成两页（`break-inside: avoid`）', /break-inside:\s*avoid/.test(printBody))
  check('打印隐藏站内框架（页头 / 页脚 / rail / docs-side / 抽屉 / 模块条 / 工具区 / picker / 登出）', ['.site-header', '.site-footer', '.site-rail', '.docs-side', '.nav-drawer', '.header-actions', '.admin-tabs', '.theme-picker', '.logout-form'].every((sel) => printBody.includes(sel)))
  check('打印隐藏公开侧栏 / 抽屉 / 顶栏工具区（#85 / #86 预留）', ['.docs-side', '.nav-drawer', '.header-actions'].every((sel) => printBody.includes(sel)))
  check('打印隐藏表单与提示（button / form-actions / form-row / confirm / admin-hint / notice）', ['button', '.form-actions', '.form-row', '.confirm', '.admin-hint', '.notice'].every((sel) => printBody.includes(sel)))
  check('打印隐藏输入控件与折叠内容（input/select/textarea + details + 编辑器）', printBody.includes('input, select, textarea') && printBody.includes('details') && printBody.includes('.article-editor'))
  check('打印放开滚动与限宽（table-wrap 可见 / app-shell 单列 / app-main 不限宽）', /\.table-wrap\s*\{[^}]*overflow:\s*visible/s.test(printBody) && /\.app-shell[^{]*\{[^}]*display:\s*block/s.test(printBody) && /\.app-main\s*\{[^}]*max-width:\s*none/s.test(printBody))
  check('打印保留可读结构（行 / 卡片不被切开 + 站内链接地址）', /\.cell[^{]*\{[^}]*break-inside:\s*avoid/s.test(printBody) && printBody.includes('a[href^="/"]::after'))
  check('打印里没有 `light-dark()`（灰阶是字面量）', !printBody.includes('light-dark('))
  check('打印时正文里的站内链接把地址写出来', /\.prose a\[href\^="\/"\]::after/.test(printBody))
}

// ════════════════════════════════════════════════════
section('面板那两条实现要点没被抽变形')
// ════════════════════════════════════════════════════
{
  check('定宽格数仍是 56（`CELL_STRIP_LEN`）', /CELL_STRIP_LEN = 56/.test(views))
  check('缺失历史仍画空心格（`.cell-missing` 在 CSS 里）', /\.cell-strip i\.cell-missing\b/.test(css))
  check('跨文件契约类名没被顺手改掉（`.cell-strip` / `.badge` / `.dot` 都在）', ['cell-strip', 'badge', 'dot'].every((c) => new RegExp(`\\.${c}\\b`).test(css)))
  check('客户端状态映射仍在一处（`status.js` 的 `STATE_CLASS`）', /STATE_CLASS/.test(statusJs))
  check('曲线网格用 CSS 纸纹（`repeating-linear-gradient` + `--separator`），不往 SVG 里塞网格', /\.chart\s*\{[^}]*repeating-linear-gradient/s.test(css) && /--separator/.test(css) && !/<line\s/.test(chartsTs))
  check('`charts.ts` 里没有颜色字面量（颜色只来自 CSS / currentColor）', !/#[0-9a-f]{3,8}/i.test(chartsTs))
}

// ════════════════════════════════════════════════════
if (failed === 0) {
  console.log(`\n✅ 全部通过：${passed} 项`)
} else {
  console.log(`\n❌ ${failed} 项失败 / 共 ${passed + failed} 项`)
  for (const f of failures) console.log('   - ' + f)
  process.exit(1)
}
