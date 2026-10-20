/**
 * 样式断言。**不过 HTTP、不起服务**：它读 `public/style.css`、`src/views.ts` 与 `public/status.js`，
 * 把三者之间的一致性钉住。
 *
 * 这一版对应「iOS 化 · 批次①：基座」（map #64 / 票 #70）：
 *  - token 从 13 色浅色单套 → **17 色 `light-dark()` + 21 个非颜色**；三态只切 `color-scheme`；
 *  - 对比度从 19 对单模式 → **19 对文字 ×2 + 12 对非文字 ×2**（#67 §7 的表）；
 *  - 排版从两套平面 → **一套 iOS 字阶**（平面与 `--font-data|prose` 全部退役）；
 *  - 打印从「保留状态色」→ **17 个灰阶 token + 状态格带图案**（#68 §11）。
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
  // iOS 字阶（10 字号 + 4 行高）
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
section('token 表：17 色 light-dark + 21 非色，三态只切 color-scheme（#67）')
// ════════════════════════════════════════════════════
{
  const rootCount = (css.match(/:root\s*\{/g) ?? []).length
  check('全站 `:root` 恰好一个（浅深并排写在一份表里）', rootCount === 1, `实际 ${rootCount}`)

  check('CSS 里没有 `@media (prefers-color-scheme …)` 块（三态不走媒体查询）', !/@media[^{]*prefers-color-scheme/.test(css))

  const tokens = parseTokens(rootBody)
  const colorKeys = Object.keys(tokens).filter((k) => !NON_COLOR.has(k))
  const missingNonColor = [...NON_COLOR].filter((k) => !(k in tokens))
  check('颜色 token 恰好 17 个（精确集合）', colorKeys.length === 17 && colorKeys.every((k) => COLOR_TOKENS.has(k)) && [...COLOR_TOKENS].every((k) => colorKeys.includes(k)), colorKeys.join(', '))
  check('21 个非颜色 token 全在同一个 `:root` 里', missingNonColor.length === 0, missingNonColor.join(', '))

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
section('对比度：19 对文字 ×2 模式 ≥4.5、12 对非文字 ×2 模式 ≥3（#67 §7）')
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
    ['accent', 'bg'], ['accent', 'bg-card'], ['accent', 'bg-elev'],
    ['on-accent', 'accent'],
    ['ok', 'bg-card'], ['ok', 'bg-elev'],
    ['warn', 'bg-card'], ['warn', 'bg-elev'],
    ['bad', 'bg-card'], ['bad', 'bg-elev'], ['bad', 'fill'],
  ]
  const NON_TEXT_PAIRS = [
    ['label-3', 'bg'], ['label-3', 'bg-card'], ['label-3', 'bg-elev'], ['label-3', 'fill'],
    ['border-strong', 'bg'], ['border-strong', 'bg-card'], ['border-strong', 'bg-elev'], ['border-strong', 'fill'],
    ['accent', 'bg'], ['accent', 'bg-card'], ['accent', 'bg-elev'], ['accent', 'fill'],
  ]
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
  check('图标全部来自 `icon()`（没有图标字体 / 外部图标库）', views.includes("from './icons.js'") && views.includes('icon(') && !views.includes('@font-face'))
  check('`icons.ts` 里没有颜色字面量（只有 currentColor）', !/#[0-9a-f]{3,8}\b/i.test(iconsTs))
}

// ════════════════════════════════════════════════════
section('排版：一套 iOS 字阶（平面与两套字体已退役，#68）')
// ════════════════════════════════════════════════════
{
  check('CSS 代码里没有 `plane-`（平面已退役，只许出现在注释里）', !cssNoComments.includes('plane-'))
  check('`views.ts` 里没有 `plane-`（`<body>` 不再带平面类）', !views.includes('plane-'))
  check('排版 token 已退役（font-data/prose、fs-data/prose、lh-data 全不在）', ['--font-data:', '--font-prose:', '--fs-data:', '--lh-data:', '--fs-prose:'].every((t) => !cssNoComments.includes(t)))

  check('`body` 用 `var(--font)` 与 `--fs-callout`（不再按平面换字体）', /body\s*\{[^}]*font-family:\s*var\(--font\)/s.test(css) && /body\s*\{[^}]*font-size:\s*var\(--fs-callout\)/s.test(css))
  check('10 个字号 token 与 4 个行高 token 都在 `:root`', ['fs-large', 'fs-title1', 'fs-title2', 'fs-title3', 'fs-headline', 'fs-body', 'fs-callout', 'fs-subhead', 'fs-footnote', 'fs-caption', 'lh-tight', 'lh-title', 'lh-ui', 'lh-prose'].every((k) => new RegExp(`--${k}\\s*:`).test(css)))

  check('Large Title 落在 `.hero h1`（`--fs-large`）', /\.hero h1\s*\{[^}]*font-size:\s*var\(--fs-large\)/s.test(css))
  check('Title 1 落在文章标题（`.post-header h1` → `--fs-title1`）', /\.post-header h1\s*\{[^}]*font-size:\s*var\(--fs-title1\)/s.test(css))
  check('Title 2 落在区块标题（`.prose h2` → `--fs-title2`）', /\.prose h2\s*\{[^}]*font-size:\s*var\(--fs-title2\)/s.test(css))
  check('Title 3 落在小标题与指标数字（`.prose h3` / `.stat-num` → `--fs-title3`）', /\.prose h3\s*\{[^}]*font-size:\s*var\(--fs-title3\)/s.test(css) && /\.stat-num\s*\{[^}]*font-size:\s*var\(--fs-title3\)/s.test(css))
  check('Body 落在长文（`.prose` → `--fs-body` + `--lh-prose`）', /\.prose\s*\{[^}]*font-size:\s*var\(--fs-body\)[^}]*line-height:\s*var\(--lh-prose\)/s.test(css))
  check('Caption 落在徽标 / 标签 / 格带说明 / 图表轴（`--fs-caption`）', ['.badge', '.tag', '.cell-caption', '.chart-axis'].every((sel) => new RegExp(`${sel.replace('.', '\\.')}\\s*\\{[^}]*font-size:\\s*var\\(--fs-caption\\)`, 's').test(css)))
  check('Footnote 落在 meta / stat-sub / kv（`--fs-footnote`）', ['.post-card .meta, .post-header .meta', '.stat-sub', '.kv dd'].every((sel) => new RegExp(`${sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{[^}]*font-size:\\s*var\\(--fs-footnote\\)`, 's').test(css)))

  // --label-3 只有非文字对比度（3.27–4.15），任何带 font-size 的规则里都不许出现它
  const blocks = cssNoComments.split('}')
  const label3WithFont = blocks.filter((b) => b.includes('font-size') && b.includes('var(--label-3)')).length
  check('`--label-3` 只做非文字（不出现在任何带 `font-size` 的规则里）', label3WithFont === 0, `实际 ${label3WithFont} 处`)

  check('正文栏宽 68ch（`.prose` 用 `var(--measure-prose)`）', /\.prose\s*\{[^}]*max-width:\s*var\(--measure-prose\)/s.test(css))
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
section('打印：17 个灰阶 token + 格带图案（#68 §11）')
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

// ════════════════════════════════════════════════════
section('外壳与导航：全站 rail / 手机 tab bar / 管理模块条（#68 §5）')
// ════════════════════════════════════════════════════
{
  const narrow = (css.match(/@media \(max-width: 720px\)\s*\{([\s\S]*?)\n\}/) ?? [, ''])[1]
  check('`layout()` 输出 `.app-shell`，管理台页加 `--admin` 修饰', views.includes('class="${shellClass}"') && views.includes("const shellClass = opts.adminSection ? 'app-shell app-shell--admin' : 'app-shell'"))
  check('桌面 rail 是唯一的 `<nav class="site-rail" aria-label="站内导航">`', views.includes('<nav class="site-rail" aria-label="站内导航">'))
  check('导航只有一张数据源：`NAV_ITEMS` 4 项（首页 / 分享 / 系统可用性 / 关于）', views.includes('const NAV_ITEMS: ReadonlyArray<NavItem> = [') && ['首页', '分享', '系统可用性', '关于'].every((label) => views.includes(`label: '${label}'`)))
  check('管理组只在 `currentIsAdmin()` 时渲染，六模块顺序写死（#59 §2）', views.includes('currentIsAdmin()') && views.includes('? `<div class="rail-group"><span class="rail-group-label">管理</span>') && ['overview', 'targets', 'accounts', 'backups', 'settings', 'articles'].every((k) => views.includes(`['${k}', '/admin`)))
  check('管理组里有「运维」「内容」两个 sub-label', views.includes('<span class="rail-sub-label">') && views.includes("'运维',") && views.includes("['内容', [['articles'"))
  check('当前项判据唯一：`key === active`（站点）/ `key === section`（模块）', views.includes("item.key === active ? ' aria-current=\"page\"' : ''") && views.includes("key === section ? ' aria-current=\"page\"' : ''"))
  check('tab bar 与 rail 同源（同一张 `NAV_ITEMS` + `ADMIN_ITEM`），只读 4 / 管理员 5', views.includes('const items = currentIsAdmin() ? [...NAV_ITEMS, ADMIN_ITEM] : NAV_ITEMS'))
  check('`.admin-tabs` 只在 `adminSection` 存在时渲染', views.includes("${opts.adminSection ? adminTabs(opts.adminSection) : ''}"))
  check('页头**不透明**：`background: var(--bg)`，全站无 `backdrop-filter`', /\.site-header\s*\{[^}]*background:\s*var\(--bg\)/s.test(css) && !/backdrop-filter:/.test(css))
  check('外壳两列：`var(--rail-w) minmax(0, 1fr)`', /grid-template-columns:\s*var\(--rail-w\)\s+minmax\(0,\s*1fr\)/.test(css))
  check('栏宽 token：`--wrap-admin` 与 `--rail-w` 都在且是 px', /--wrap-admin\s*:\s*\d+px/.test(css) && /--rail-w\s*:\s*\d+px/.test(css))
  check('720px 断点：rail 隐藏、tab bar 出现、外壳单列', /\.site-rail\s*\{\s*display:\s*none/.test(narrow) && /\.tab-bar\s*\{\s*display:\s*flex/.test(narrow) && /\.app-shell\s*\{\s*grid-template-columns:\s*minmax\(0,\s*1fr\)/.test(narrow))
  check('720px 断点：管理台模块条出现（横向可滚）', /\.admin-tabs\s*\{[^}]*overflow-x:\s*auto/s.test(narrow))
  check('打印时导航整块隐藏、外壳退回单列', printBody.includes('.site-rail') && printBody.includes('.tab-bar') && printBody.includes('.admin-tabs') && /display:\s*none/.test(printBody) && /\.app-shell\s*\{\s*display:\s*block/.test(printBody))
}

// ════════════════════════════════════════════════════
section('窄屏断点与打印其余')
// ════════════════════════════════════════════════════
{
  const narrow = (css.match(/@media \(max-width: 720px\)\s*\{([\s\S]*?)\n\}/) ?? [, ''])[1]
  const tight = (css.match(/@media \(max-width: 560px\)\s*\{([\s\S]*?)\n\}/) ?? [, ''])[1]
  check('存在 720px 断点（版面从多栏退成一栏）', narrow.length > 0)
  check('720px 断点里：目标卡与参数表退回一栏', /\.target-grid\s*\{\s*grid-template-columns:\s*1fr/.test(narrow) && /\.kv\s*\{\s*grid-template-columns:\s*1fr/.test(narrow))
  check('720px 断点里：管理台宽表可横向滚动', /\.admin-table\s*\{[^}]*overflow-x:\s*auto/s.test(narrow))
  check('560px 断点存在，且表单行改成竖排', tight.length > 0 && /\.form-row\s*\{\s*flex-direction:\s*column/.test(tight))
  check('存在 `@media print`', printBody.length > 0)
  check('打印时把配色就地改成纸面（黑字白底）', /--bg:\s*#ffffff/.test(printBody) && /--label:\s*#000000/.test(printBody))
  check('打印时藏掉只在屏幕上成立的东西（页头 / rail / tab bar / 模块条 / 登出 / 按钮 / picker）', /\.site-header[^{]*\{[^}]*display:\s*none/s.test(printBody) && /\.site-rail/.test(printBody) && /\.tab-bar/.test(printBody) && /\.admin-tabs/.test(printBody) && /\bbutton\b[^{]*\{[^}]*display:\s*none/s.test(printBody) && /\.theme-picker/.test(printBody))
  check('打印时卡片不许被切成两页（`break-inside: avoid`）', /break-inside:\s*avoid/.test(printBody))
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
}

// ════════════════════════════════════════════════════
if (failed === 0) {
  console.log(`\n✅ 全部通过：${passed} 项`)
} else {
  console.log(`\n❌ ${failed} 项失败 / 共 ${passed + failed} 项`)
  for (const f of failures) console.log('   - ' + f)
  process.exit(1)
}
