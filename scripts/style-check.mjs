/**
 * 样式断言（`#45` 整站视觉）。**不过 HTTP、不起服务**：它读 `public/style.css`、`src/views.ts`
 * 与 `public/status.js` 三个文件，把它们之间的一致性钉住。
 *
 * 为什么要有这个脚本（`docs/visual-prototype-decision.md` §6 自己登记的欠账）：
 * 那份定稿写着「**对比度是估的，不是算的**」。这一条就是来还债的 ——
 * 下面 `PAIRS` 里的每一对前景/背景都**算出 WCAG 比值并断言 ≥ 4.5:1**，
 * 输出里逐对打印比值，所以「估」这件事从此没有藏身处。
 *
 * 另外钉住四条跨文件事实（都是"改了这边、忘了那边"就会静默坏掉的形状）：
 *  1. **只有一份 token 表**：`:root` 恰好两个（暗色定义 + light 覆盖），且每个颜色 token 都被覆盖；
 *  2. **服务端渲染的类名都有 CSS 定义**（沿用 #21 §5 的跨文件断言思路）；
 *  3. **两套平面**（数据面 / 正文面）真的落在 `<body>` 上，且 CSS 真的按平面换排版；
 *  4. **窄屏断点与打印样式存在且内容对**；打印块不在 `:root` 上改 token（那条纪律连打印也不破）。
 *
 * ⚠ 它证明不了的事（诚实登记，归票⑩）：窄屏的**目视观感**、打印出来的**实际效果**、
 * 真机上字体回退长什么样。这些只能靠眼睛，脚本只能保证规则存在、数值达标。
 */
import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const css = fs.readFileSync(path.join(root, 'public/style.css'), 'utf8')
const views = fs.readFileSync(path.join(root, 'src/views.ts'), 'utf8')
const statusJs = fs.readFileSync(path.join(root, 'public/status.js'), 'utf8')

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

// ── 小工具：按平衡花括号取出一段块 ──
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
const mediaBlock = (query) => {
  const i = css.indexOf(`@media ${query}`)
  return i < 0 ? '' : blockAfter(css, i)
}
const parseTokens = (text) => {
  const out = {}
  for (const m of text.matchAll(/--([\w-]+)\s*:\s*([^;]+);/g)) out[m[1]] = m[2].trim()
  return out
}
// WCAG 相对亮度 / 对比度
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

// ════════════════════════════════════════════════════
section('token 表：只有一份，light 覆盖完整')
// ════════════════════════════════════════════════════
{
  const rootCount = (css.match(/:root\s*\{/g) ?? []).length
  check('全站 `:root` 恰好两个（暗色定义 + light 覆盖），没有第三处', rootCount === 2, `实际 ${rootCount}`)

  const darkIdx = css.indexOf(':root {')
  const darkBody = blockAfter(css, darkIdx)
  const lightBody = blockAfter(css, css.indexOf('@media (prefers-color-scheme: light)'))
  const dark = parseTokens(darkBody)
  const light = parseTokens(lightBody)

  // 非颜色 token（排版与形状）：两种配色下都一样，所以**不该**出现在 light 覆盖里
  const NON_COLOR = new Set([
    'radius', 'wrap', 'font', 'mono',
    'font-data', 'font-prose', 'fs-data', 'lh-data', 'fs-prose', 'lh-prose', 'measure-prose',
  ])
  const colorKeys = Object.keys(dark).filter((k) => !NON_COLOR.has(k))
  const missing = colorKeys.filter((k) => !(k in light))
  check(
    `每个颜色 token 都在 light 里被覆盖（${colorKeys.length} 个）`,
    missing.length === 0,
    missing.length ? '缺：' + missing.join(', ') : colorKeys.join(', '),
  )
  const drifted = Object.keys(light).filter((k) => NON_COLOR.has(k))
  check('light 覆盖里**没有**混进排版/形状 token（它们与配色无关）', drifted.length === 0, drifted.join(', '))

  const printBody = mediaBlock('print')
  check('打印块**不在 `:root` 上**改 token（改在 `body` 上，全站仍只有一份 `:root`）', /body\s*\{/.test(printBody) && !/:root/.test(printBody))

  globalThis.__tokens = { dark, light }
  globalThis.__printBody = printBody
}

// ════════════════════════════════════════════════════
section('对比度：逐对算出 WCAG 比值（AA 正文线 4.5:1）')
// ════════════════════════════════════════════════════
{
  const { dark, light } = globalThis.__tokens
  const NW = 4.5 // 正文（normal text）的门槛

  /** 实际用到的对。`use` 是"谁在用"，写不清用途的对不该进这张表。 */
  const PAIRS = [
    ['fg', 'bg', '正文 on 页面底'],
    ['fg', 'bg-card', '卡片里的正文'],
    ['fg', 'bg-soft', 'code / notice 文本'],
    ['fg-dim', 'bg', '次要文字（页面）'],
    ['fg-dim', 'bg-card', '次要文字（卡片）'],
    ['fg-dim', 'bg-soft', '次要文字（浅底块）'],
    ['fg-faint', 'bg', '最弱文字（页面）'],
    ['fg-faint', 'bg-card', '最弱文字（卡片）'],
    ['fg-faint', 'bg-soft', '最弱文字（浅底块）'],
    ['accent', 'bg', '链接（页面）'],
    ['accent', 'bg-card', '链接（卡片）'],
    ['accent', 'bg-soft', '链接（浅底块）'],
    ['ok', 'bg-card', '状态文字 ok'],
    ['warn', 'bg-card', '状态文字 warn'],
    ['bad', 'bg-card', '状态文字 bad'],
    ['ok', 'bg-soft', '状态文字 ok（浅底）'],
    ['warn', 'bg-soft', '状态文字 warn（浅底）'],
    ['bad', 'bg-soft', '状态文字 bad（浅底）'],
    // `--fg-faint` 也当边框/分隔符用（那不需要 4.5），这里只覆盖它当**文字**的三种底。
    ['on-accent', 'accent', '主按钮文字'],
  ]
  /**
   * 不达标但**有意保留**的对：键是 `前景/背景`，值是取舍理由。
   * 这张表是空的 —— 全部达标。日后要是有人想放一对进来，理由必须写在这里（票面要求：
   * 「对不达标的对，要么改色，要么把取舍写下来」）。
   */
  const ALLOWED = {}

  for (const mode of ['dark', 'light']) {
    const tokens = mode === 'dark' ? dark : { ...dark, ...light }
    console.log(`\n  ── ${mode === 'dark' ? '暗色（默认）' : '浅色（prefers-color-scheme: light）'} ──`)
    for (const [fgKey, bgKey, use] of PAIRS) {
      const fg = tokens[fgKey]
      const bg = tokens[bgKey]
      if (!fg || !bg || !fg.startsWith('#') || !bg.startsWith('#')) {
        check(`${mode}: ${fgKey} on ${bgKey} 能算（token 是纯色）`, false, `${fg} / ${bg}`)
        continue
      }
      const r = contrast(fg, bg)
      const key = `${fgKey}/${bgKey}`
      const allowed = ALLOWED[key]
      const ok = r >= NW || Boolean(allowed)
      check(
        `${mode}: ${fgKey} on ${bgKey} = ${r.toFixed(2)}:1${ok ? '' : ' （不达标）'}`,
        ok,
        `${use} · ${fg} on ${bg}${allowed ? ' · 已登记的取舍：' + allowed : ''}`,
      )
    }
  }
  console.log(
    '\n  （注：`--unknown` 是**填充色**不是文字色 —— 它画的是"无数据"的点/格，不进上面这张表。）',
  )
}

// ════════════════════════════════════════════════════
section('服务端渲染的类名，CSS 里都有定义')
// ════════════════════════════════════════════════════
{
  /**
   * 从 `class="…"` 里抠出静态类名。
   *
   * 只认 **class 属性**，不扫全文件的引号串 —— 后者会把 `'target-saved'`（notice 键）、
   * `'id'`（表单字段名）也当成类名，等于把断言变成噪声。条件类名（`class="tag${cond ? ' tag-active' : ''}"`）
   * 在 `${…}` 里，所以先把插值表达式里的字面量捞出来，再把插值本身抹掉取静态部分。
   */
  const classesFrom = (text) => {
    const found = new Set()
    const add = (raw) => {
      for (const c of raw.split(/\s+/)) if (/^[a-z][\w-]*$/.test(c)) found.add(c)
    }
    for (const m of text.matchAll(/class=(?:"([^"]*)"|'([^']*)')/g)) {
      const attr = m[1] ?? m[2] ?? ''
      // 条件类名：`${cond ? ' tag-active' : ''}`。**只取三元的结果那一半** ——
      // 条件里也会有字符串字面量（`u.role === 'admin'`），那是比较，不是类名。
      for (const expr of attr.matchAll(/\$\{([^}]*)\}/g)) {
        const e = expr[1]
        const resultPart = e.includes('?') ? e.slice(e.indexOf('?') + 1) : ''
        for (const lit of resultPart.matchAll(/'([^']*)'|"([^"]*)"/g)) add(lit[1] ?? lit[2] ?? '')
      }
      // 静态部分：把插值整段抹成空白再按空白切
      add(attr.replace(/\$\{[^}]*\}/g, ' '))
    }
    return found
  }
  const hasRule = (name) => new RegExp(`\\.${name.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}(?![\\w-])`).test(css)

  /**
   * 明确的例外：这些是**行为钩子/状态值**，本来就不该有自己的样式规则。
   * 加一条就要写清为什么 —— 否则这张表会变成"把没定义的类名都塞进来"的垃圾桶。
   */
  const NO_RULE_NEEDED = new Set([
    'js-cells', // 客户端更新「最近 N 次」那个数字；样式来自父级 `.cell-caption`
    'js-generated', // 同上：时间戳由 status.js 每 30 秒刷新，样式来自父级 `.lede`
    'plane-data', 'plane-prose', // 由 `body.plane-data` / `body.plane-prose` 命中（不是 `.plane-data`）
  ])
  // `class="..."` 里的多类名会被拆开，但个别地方写成整串（如 `class="notice notice-bad"`）——
  // 下面的收集已经按空白拆过，所以这里只需处理"状态值"这一类：
  const STATE_VALUES = new Set(['up', 'degraded', 'down', 'ok', 'warn', 'bad', 'unknown', 'missing'])

  const fromViews = classesFrom(views)
  const fromJs = classesFrom(statusJs)
  const all = [...new Set([...fromViews, ...fromJs])].filter((c) => !STATE_VALUES.has(c))
  const missing = all.filter((c) => !hasRule(c) && !NO_RULE_NEEDED.has(c))
  check(
    `views.ts / status.js 里出现的 ${all.length} 个类名都有 CSS 定义`,
    missing.length === 0,
    missing.length ? '缺：' + missing.join(', ') : '（含例外：' + [...NO_RULE_NEEDED].join(', ') + '）',
  )

  // 状态值：以"位置类"的形式出现在 CSS 里（`.cell-strip i.up` / `.dot.ok`）——单独断言
  for (const s of ['up', 'degraded', 'down']) {
    check(`状态值 \`${s}\` 在 CSS 里有对应规则（格带/点）`, new RegExp(`\\.cell-strip i\\.${s}\\b`).test(css))
  }
  for (const s of ['ok', 'warn', 'bad']) {
    check(`样式类 \`${s}\` 在 CSS 里有对应规则（徽标/点）`, new RegExp(`\\.(badge|dot)\\.${s}\\b`).test(css))
  }
}

// ════════════════════════════════════════════════════
section('两套平面：数据面终端化 / 正文面纸感化')
// ════════════════════════════════════════════════════
{
  check('CSS 有 `body.plane-data` 且字体走 `var(--font-data)`', /body\.plane-data\s*\{[^}]*font-family:\s*var\(--font-data\)/s.test(css))
  check('CSS 有 `body.plane-prose` 且字体走 `var(--font-prose)`', /body\.plane-prose\s*\{[^}]*font-family:\s*var\(--font-prose\)/s.test(css))
  check('两份排版 token 都在 `:root` 里定义过（字体 / 字号 / 行高 / 窄栏）', ['font-data', 'font-prose', 'fs-data', 'lh-data', 'fs-prose', 'lh-prose', 'measure-prose'].every((k) => new RegExp(`--${k}\\s*:`).test(css)))
  check('正文面收窄栏宽（`.prose` 用 `var(--measure-prose)`）', /\.prose\s*\{[^}]*max-width:\s*var\(--measure-prose\)/s.test(css))

  check('views.ts 里数据面 = 面板 + 管理台（`status` / `admin` → data）', /active === 'status' \|\| active === 'admin' \? 'data' : 'prose'/.test(views))
  check('`layout()` 把平面写进 `<body class="plane-…">`', /plane-\$\{planeOf\(opts\.active\)\}/.test(views))
  check('登录页自带 `plane-data`（它不走 `layout()`）', /<body class="login-body plane-data">/.test(views))
  check('导航分隔符是**服务端输出**的 `nav-sep`（不是伪元素 —— 分隔符不该可点）', /class="nav-sep" aria-hidden="true"/.test(views) && /\.nav-sep\s*\{/.test(css))
}

// ════════════════════════════════════════════════════
section('窄屏断点与打印样式')
// ════════════════════════════════════════════════════
{
  const narrow = mediaBlock('(max-width: 720px)')
  const tight = mediaBlock('(max-width: 560px)')
  check('存在 720px 断点（版面从多栏退成一栏）', narrow.length > 0)
  check('720px 断点里：目标卡与参数表退回一栏', /\.target-grid\s*\{\s*grid-template-columns:\s*1fr/.test(narrow) && /\.kv\s*\{\s*grid-template-columns:\s*1fr/.test(narrow))
  check('720px 断点里：管理台宽表**可横向滚动**（不是被裁掉）', /\.admin-table\s*\{[^}]*overflow-x:\s*auto/s.test(narrow))
  check('560px 断点存在，且表单行改成竖排（窄屏下标签与输入框不挤一行）', tight.length > 0 && /\.form-row\s*\{\s*flex-direction:\s*column/.test(tight))

  const print = globalThis.__printBody
  check('存在 `@media print`', print.length > 0)
  check('打印时把配色就地改成纸面（黑字白底）', /--bg:\s*#ffffff/.test(print) && /--fg:\s*#000000/.test(print))
  check('打印时藏掉只在屏幕上成立的东西（页头 / 导航 / 登出 / 按钮 / 提示语）', /\.site-header[^{]*\{[^}]*display:\s*none/s.test(print) && /\.site-nav/.test(print) && /\bbutton\b[^{]*\{[^}]*display:\s*none/s.test(print))
  check('打印时卡片不许被切成两页（`break-inside: avoid`）', /break-inside:\s*avoid/.test(print))
  check('打印时正文里的站内链接把地址写出来（纸上点不开）', /\.prose a\[href\^="\/"\]::after/.test(print))
  check('打印时状态格带保留颜色（`print-color-adjust`）', /print-color-adjust:\s*exact/.test(print))
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
  for (const f of failures) console.log(`   - ${f}`)
  process.exit(1)
}
