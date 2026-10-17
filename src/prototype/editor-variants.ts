/**
 * 编辑器形态原型（抛弃式）：三个变体 + 底部悬浮切换条 + 状态面板。
 *
 * 三个变体只换「编辑区那一块」的结构，页头 / 页脚 / 样式 / markdown-it 管线全是真的。
 * 变体本身写成纯字符串函数：不碰文件、不碰网络、不碰 DOM。
 */
import { escapeHtml } from '../views.js'
import { EDITOR_CLIENT_JS } from './prototype-js.js'

export type VariantKey = 'A' | 'B' | 'C'

export interface VariantMeta {
  key: VariantKey
  name: string
  /** 这一版在赌什么（一句话）。 */
  bet: string
  /** 主操作是什么。 */
  primary: string
  needsJs: boolean
  previewFrom: string
  /** 实现代价：从我写这份原型的实际开销里数出来的。 */
  cost: string[]
  /** 手感代价：这一版换来的东西要付什么。 */
  price: string[]
}

export const VARIANT_ORDER: readonly VariantKey[] = ['A', 'B', 'C']

export const VARIANTS: Record<VariantKey, VariantMeta> = {
  A: {
    key: 'A',
    name: '纯文本域 + 服务端预览',
    bet: '把「提交再看」当成本，换零 JS 与零新依赖',
    primary: '写完点一次「预览」',
    needsJs: false,
    previewFrom: '服务端 markdown-it（点按钮那一次）',
    cost: [
      '一个 <code>&lt;form&gt;</code> + 一次 <code>md.render()</code>：复用既有管线，**0 行 JS、0 新依赖**',
      '预览渲染与产品文章页逐项同参（<code>html:false</code> / <code>linkify</code> / <code>typographer</code>），也走真的 gray-matter',
    ],
    price: [
      '预览永远是**上一次提交**的结果：改了字它不会跟着变，你得记得自己还没按按钮',
      '每次预览都是一次整页刷新：**光标与滚动位置都不在原处**，长文里这个代价被放大（两千字重排一遍）',
      '禁用 JS 的浏览器里它是**唯一**还能用的形态——这条是它的护城河',
    ],
  },
  B: {
    key: 'B',
    name: '分栏实时预览',
    bet: '把「每敲一次一次往返」当成本，换边写边看',
    primary: '打字（停 350ms 自动同步）',
    needsJs: true,
    previewFrom: '服务端 markdown-it（防抖后 POST，回填右栏）',
    cost: [
      '一次防抖 + 一个返回 JSON 的端点；**没有第二个渲染器**（预览仍走服务端 markdown-it），也没有新依赖',
      '没走的那条路更贵：把渲染搬进浏览器 → 要么 vendored 一份 markdown-it 的浏览器包（两份渲染器 = 两处会漂移的真源），要么上构建步骤',
    ],
    price: [
      '必须 JS；关掉 JS 就退化成 A（右栏只剩上次提交的结果）',
      '打字即请求：这一段是手感的全部来源，也是它唯一的新开销',
      '本页 <code>--wrap</code> 只有 900px → 两栏各约 420px，中文长段落与宽表格都会被挤（右栏有实测栏宽）',
    ],
  },
  C: {
    key: 'C',
    name: '富文本（所见即所得）',
    bet: '把「Markdown 是唯一真源」换掉，换不用学语法',
    primary: '直接看着写',
    needsJs: true,
    previewFrom: '不适用：屏幕上就是你最终要的样子',
    cost: [
      '<code>contenteditable</code> + <code>execCommand</code>（**已被标准废弃**）就能出第一版手感；贵的是反向那一步',
      '真正的大头是 **HTML → Markdown 的降级转换**：这一版我手写了约 200 行原型级转换器；成品要用 ProseMirror / TipTap 这类库 → 依赖 + 构建步骤',
    ],
    price: [
      '**必须 JS**：与仓库既有约束「禁用 JS 也要能读能写」正面冲突（关掉脚本这一版等于不可用）',
      '真源从 Markdown 变成 HTML：diff、回溯、迁移这几件事的性质都变了',
      'front-matter 六键（slug / title / date / tags / summary / draft）在富文本里**没有落点**，必须另做一套表单；「标签数组」尤其没有对应控件',
      '最贵的一条：**存回 Markdown 是有损的** —— 点「存回 Markdown」看实测丢了哪几项',
    ],
  },
}

export function isVariantKey(value: unknown): value is VariantKey {
  return value === 'A' || value === 'B' || value === 'C'
}

/** 循环取相邻变体（切换条左右箭头）。 */
export function stepVariant(key: VariantKey, delta: 1 | -1): VariantKey {
  const i = VARIANT_ORDER.indexOf(key)
  const next = (i + delta + VARIANT_ORDER.length) % VARIANT_ORDER.length
  return VARIANT_ORDER[next]!
}

export interface Landmark {
  label: string
  /** 这一格要看的是什么。 */
  hint: string
  /** 在样本里的起始行号（跳转用，近似定位）。 */
  line: number
}

export interface FrontMatterView {
  title: string
  date: string
  tags: string
  draft: string
  summary: string
  /** 解析时被丢弃的未知键（真的 gray-matter 行为：只认 6 键）。 */
  unknown: string[]
  error: string
}

export interface PreviewRender {
  html: string
  /** 服务端渲染耗时（A 用它），毫秒。 */
  ms: number
  htmlBytes: number
  sourceBytes: number
}

export interface EditorBodyInput {
  variant: VariantKey
  /** 当前正文（含 front-matter），就是编辑区里那一份。 */
  source: string
  sourceFrom: 'sample' | 'carried' | 'posted'
  preview: PreviewRender
  front: FrontMatterView
  landmarks: Landmark[]
  totalLines: number
  variantUrl: (v: VariantKey) => string
  sampleFile: string
  formAction: string
}

function yesNo(value: boolean): string {
  return value ? '<span class="pv-bad">是</span>' : '<span class="pv-ok">否</span>'
}

function statePanel(input: EditorBodyInput): string {
  const meta = VARIANTS[input.variant]
  const from =
    input.sourceFrom === 'posted'
      ? '你刚提交的这一份（服务端回显）'
      : '<span id="pv-carried">样本原文（切变体会把当前正文带过去；关掉 JS 就带不过去）</span>'
  const unknown = input.front.unknown.length
    ? `<span class="pv-bad">${escapeHtml(input.front.unknown.join(' / '))}</span>（真解析器只认 6 键，未知键直接丢）`
    : '无'
  const fmError = input.front.error ? `<span class="pv-bad">${escapeHtml(input.front.error)}</span>` : ''

  return `<section class="pv-panel">
  <h2>状态 · 每次切换或提交后重算</h2>
  <dl>
    <dt>当前变体</dt><dd><b>${meta.key}</b>（${escapeHtml(meta.name)}）</dd>
    <dt>它赌的是</dt><dd>${escapeHtml(meta.bet)}</dd>
    <dt>主操作</dt><dd>${escapeHtml(meta.primary)}</dd>
    <dt>需要 JS</dt><dd>${yesNo(meta.needsJs)}</dd>
    <dt>预览来自</dt><dd>${escapeHtml(meta.previewFrom)}</dd>
    <dt>正文真源</dt><dd><span class="pv-num">${input.totalLines}</span> 行 · <span class="pv-num">${input.source.length}</span> 字（含 front-matter）</dd>
    <dt>编辑区实时</dt><dd id="pv-stat-live">…（JS 实测）</dd>
    <dt>编辑区实测宽</dt><dd id="pv-stat-col">…（JS 实测）</dd>
    <dt>上次往返</dt><dd id="pv-stat-rt">${input.preview.ms} ms（服务端渲染耗时，页面加载时测的）</dd>
    <dt>预览大小</dt><dd id="pv-stat-bytes">${input.preview.htmlBytes} 字节 HTML（源 ${input.preview.sourceBytes} 字节）</dd>
    <dt>正文来自</dt><dd>${from}</dd>
    <dt>front-matter 解析</dt><dd>标题：${escapeHtml(input.front.title)} · 日期：${escapeHtml(input.front.date)} · 标签：${escapeHtml(input.front.tags)} · 草稿：${escapeHtml(input.front.draft)} ${fmError}</dd>
    <dt>未知键</dt><dd>${unknown}</dd>
  </dl>
</section>`
}

function testBar(input: EditorBodyInput): string {
  const buttons = input.landmarks
    .map(
      (l) =>
        `<button type="button" data-line="${l.line}" data-total="${input.totalLines}" title="${escapeHtml(l.hint)}">${escapeHtml(l.label)}</button>`,
    )
    .join('')
  return `<section class="pv-testbar">
  <span class="pv-hint">跳到测试点（近似定位，脚手架）：</span>${buttons}
</section>`
}

function previewSection(input: EditorBodyInput, heading: string, note: string, bodyId: string, wrapInScroll: boolean): string {
  const inner = `<div class="prose" id="${bodyId}">${input.preview.html}</div>`
  return `<div class="pv-preview">
  <h2>${heading} <span class="pv-hint">${note}</span></h2>
  ${wrapInScroll ? `<div class="pv-scroll">${inner}</div>` : inner}
</div>`
}

function variantA(input: EditorBodyInput): string {
  return `<section>
  <form id="pv-form" method="post" action="${escapeHtml(input.formAction)}">
    <input type="hidden" name="variant" value="A">
    <div class="pv-pane-head">
      <span>正文（Markdown 源，含 front-matter）</span>
      <span class="pv-hint">A 的全部机制就是这一个表单</span>
    </div>
    <textarea id="pv-source" name="source" class="pv-textarea" rows="24" spellcheck="false">${escapeHtml(input.source)}</textarea>
    <div class="pv-actions">
      <button type="submit" class="pv-btn">预览（整页往返）</button>
      <span class="pv-hint">按下去是一次完整的服务端渲染；光标与滚动位置不会回来。</span>
    </div>
  </form>
  ${previewSection(
    input,
    '预览',
    `服务端 markdown-it · 本次渲染 ${input.preview.ms} ms · ${input.preview.htmlBytes} 字节`,
    'pv-preview-body',
    false,
  )}
</section>`
}

function variantB(input: EditorBodyInput): string {
  return `<section class="pv-grid">
  <div class="pv-col">
    <div class="pv-pane-head">
      <span>正文（Markdown 源）</span>
      <span class="pv-hint" id="pv-sync">进页面即同步一次</span>
    </div>
    <form id="pv-form" method="post" action="${escapeHtml(input.formAction)}">
      <input type="hidden" name="variant" value="B">
      <textarea id="pv-source" name="source" class="pv-textarea" rows="30" spellcheck="false">${escapeHtml(input.source)}</textarea>
      <div class="pv-actions">
        <button type="submit" class="pv-btn-2">用服务端预览一次</button>
        <span class="pv-hint">这条是关掉 JS 时的退路 —— 那一版的 B 就是 A。</span>
      </div>
    </form>
  </div>
  <div class="pv-col" id="pv-col-right">
    <div class="pv-pane-head">
      <span>预览（右栏）</span>
      <span class="pv-hint" id="pv-colw">栏宽实测中…</span>
    </div>
    <div class="pv-scroll"><div class="prose" id="pv-preview-body">${input.preview.html}</div></div>
  </div>
</section>`
}

function variantC(input: EditorBodyInput): string {
  const front = input.front
  return `<section>
  <div class="pv-warn"><b>这一版必须 JS。</b>脚本关掉时它连写都写不了 —— 仓库既有约束是「禁用 JS 也要能读能写」，
  这一版与它正面冲突。这条是代价，不是缺陷。</div>
  <div class="pv-toolbar" id="pv-toolbar">
    <button type="button" data-cmd="bold">粗体</button>
    <button type="button" data-cmd="formatBlock" data-arg="h2">小标题</button>
    <button type="button" data-cmd="insertUnorderedList">列表</button>
    <button type="button" data-cmd="insertTable">插一张表</button>
    <button type="button" data-cmd="insertCode">插一个代码块</button>
    <span class="pv-hint">工具栏是脚手架：<code>execCommand</code>，已被标准废弃</span>
  </div>
  <div id="pv-wysiwyg" class="prose pv-wysiwyg" contenteditable="true" spellcheck="false">${input.preview.html}</div>
  <div class="pv-actions">
    <button type="button" class="pv-btn" id="pv-tomd">存回 Markdown</button>
    <span class="pv-hint">这一步是 HTML → Markdown 的降级转换；结果与「丢了什么」出现在下面。</span>
  </div>
  <div class="pv-md-out" id="pv-md-out" hidden></div>
  <div class="pv-fm">
    <strong>front-matter 六键在这一版里没有落点。</strong>
    <p>它们不是正文，必须另做一套表单字段。其中「标签数组」尤其没有对应控件 —— 下面是这一份样本真实的解析结果：</p>
    <dl>
      <dt>slug</dt><dd>（文件名派生：2026-02-20-uptime-metrics → uptime-metrics）</dd>
      <dt>title</dt><dd>${escapeHtml(front.title)}</dd>
      <dt>date</dt><dd>${escapeHtml(front.date)}</dd>
      <dt>tags</dt><dd>${escapeHtml(front.tags)}</dd>
      <dt>summary</dt><dd>${escapeHtml(front.summary.slice(0, 60))}${front.summary.length > 60 ? '…' : ''}</dd>
      <dt>draft</dt><dd>${escapeHtml(front.draft)}</dd>
    </dl>
  </div>
</section>`
}

function costPanel(variant: VariantKey): string {
  const meta = VARIANTS[variant]
  const li = (items: string[]): string => items.map((t) => `<li>${t}</li>`).join('')
  return `<section class="pv-panel">
  <h2>这一版的代价 · 事实，不是评价</h2>
  <p class="pv-hint" style="margin:0 0 8px">实现代价</p>
  <ul class="pv-cost">${li(meta.cost)}</ul>
  <p class="pv-hint" style="margin:12px 0 8px">手感代价</p>
  <ul class="pv-cost">${li(meta.price)}</ul>
</section>`
}

function switcherBar(input: EditorBodyInput): string {
  const prev = stepVariant(input.variant, -1)
  const next = stepVariant(input.variant, 1)
  const meta = VARIANTS[input.variant]
  return `<div class="pv-bar">
  <a href="${escapeHtml(input.variantUrl(prev))}" data-nav="prev" data-next="${prev}" data-label="${escapeHtml(VARIANTS[prev].key + ' ' + VARIANTS[prev].name)}" title="上一个变体（←）">‹</a>
  <span class="pv-bar-label"><b>${meta.key}</b>（${escapeHtml(meta.name)}）</span>
  <a href="${escapeHtml(input.variantUrl(next))}" data-nav="next" data-next="${next}" data-label="${escapeHtml(VARIANTS[next].key + ' ' + VARIANTS[next].name)}" title="下一个变体（→）">›</a>
  <span class="pv-bar-key">← → 键切（焦点不在输入框时才生效）</span>
</div>`
}

export function editorBody(input: EditorBodyInput): string {
  const variantBlock =
    input.variant === 'A' ? variantA(input) : input.variant === 'B' ? variantB(input) : variantC(input)

  return `<div id="pv-root" data-variant="${input.variant}" data-source-from="${input.sourceFrom}">
<section class="pv-head">
  <h1>原型：编辑器形态（抛弃式）</h1>
  <p class="pv-lede">要回答的问题：<b>这个站的文章编辑器该是哪种形态</b> —— 纯 Markdown 文本域 + 服务端预览、分栏实时预览，还是富文本？
  同一个页面上三个变体，用一篇真实文章比「中文长文 / 表格 / 代码块 / 图片」四件事上的手感，以及**无构建步骤下的实现代价**。</p>
  <p class="pv-scaffold">这不是产品页面：底部切换条、「跳到」按钮、状态面板都是<b>原型脚手架</b>，不是被评的形态。
  被评的只有「编辑区那一块」。页头页脚与样式是真的（复用 <code>layout()</code> 与 <code>public/style.css</code>），
  预览用的是真的 markdown-it（与 <code>src/content.ts</code> 同一套参数）与真的 gray-matter。
  样本：<code>${escapeHtml(input.sampleFile)}</code>（前五节逐字取自 <code>content/2026-02-20-uptime-metrics.md</code>，末尾两节是<b>标注过的加料</b>，
  补的是原文缺的「中文长段落」与「一张真图片」）。</p>
</section>
${testBar(input)}
${statePanel(input)}
${variantBlock}
${costPanel(input.variant)}
</div>
${switcherBar(input)}
<script>${EDITOR_CLIENT_JS}</script>`
}
