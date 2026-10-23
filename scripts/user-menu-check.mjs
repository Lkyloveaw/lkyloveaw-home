/** 执行产品内联脚本，验证输入事件与可访问状态；CSS 布局仍由真实浏览器验收。 */
import fs from 'node:fs'
import vm from 'node:vm'
import assert from 'node:assert/strict'

const source = fs.readFileSync(new URL('../src/views.ts', import.meta.url), 'utf8')
const script = source.match(/function userMenuScript\(\): string \{\s*return `<script>([\s\S]*?)<\/script>`\s*\}/)?.[1]
assert.ok(script, '必须执行实际 userMenuScript，不复制一份实现')

function setup({ canHover = true } = {}) {
  const timers = []
  class Element {
    attrs = new Map()
    dataset = {}
    events = new Map()
    classes = new Set()
    hover = false
    classList = {
      add: (name) => this.classes.add(name),
      remove: (name) => this.classes.delete(name),
      contains: (name) => this.classes.has(name),
    }
    addEventListener(name, fn) { this.events.set(name, [...(this.events.get(name) ?? []), fn]) }
    emit(name, event = {}) { for (const fn of this.events.get(name) ?? []) fn({ target: this, ...event }) }
    setAttribute(name, value) { this.attrs.set(name, String(value)) }
    getAttribute(name) { return this.attrs.get(name) ?? null }
    removeAttribute(name) { this.attrs.delete(name) }
    contains(target) { return this === target || (this === root && [trigger, panel, item].includes(target)) }
    matches(selector) {
      if (selector === ':hover') return this.hover
      if (selector === ':focus-within') return this.contains(document.activeElement)
      throw new Error(`未建模的选择器：${selector}`)
    }
    focus() {
      const previous = document.activeElement
      document.activeElement = this
      if (root.contains(previous)) root.emit('focusout', { relatedTarget: this })
      if (root.contains(this)) root.emit('focusin', { relatedTarget: previous })
      while (timers.length) timers.shift()()
    }
    querySelector(selector) {
      return ({ '[data-user-menu]': root, '[data-user-trigger]': trigger, '[data-user-panel]': panel,
        '.nav-drawer': drawer, '.nav-drawer[open]': drawer.getAttribute('open') !== null ? drawer : null })[selector] ?? null
    }
  }
  const root = new Element()
  const trigger = new Element()
  const panel = new Element()
  const item = new Element()
  const outside = new Element()
  const drawer = new Element()
  const document = new Element()
  document.activeElement = outside
  trigger.setAttribute('aria-expanded', 'false')
  const matchMedia = () => ({ matches: canHover })
  vm.runInNewContext(script, { document, matchMedia, window: { matchMedia }, setTimeout: (fn) => timers.push(fn) })
  return { root, trigger, panel, item, outside, drawer, document,
    expanded: () => trigger.getAttribute('aria-expanded') === 'true' }
}

function setupTheme(storage, unavailable = false) {
  const script = source.match(/function themeScript\(\): string \{\s*return `<script>([\s\S]*?)<\/script>`\s*\}/)?.[1]
  assert.ok(script, '执行产品中的实际主题脚本')
  const root = { dataset: {}, style: {}, removeAttribute: () => { delete root.dataset.theme } }
  const selects = Array.from({ length: 2 }, () => ({
    value: 'system', listener: null,
    addEventListener(event, listener) { assert.equal(event, 'change'); this.listener = listener },
    change(value) { this.value = value; this.listener() },
  }))
  const access = (fn) => { if (unavailable) throw new Error('Storage unavailable'); return fn() }
  const localStorage = {
    getItem: (key) => access(() => storage.get(key) ?? null),
    setItem: (key, value) => access(() => storage.set(key, value)),
    removeItem: (key) => access(() => storage.delete(key)),
  }
  vm.runInNewContext(script, { document: { documentElement: root, querySelectorAll: () => selects }, localStorage })
  return { root, selects }
}

const tests = [
  ['主题在菜单与个人设置之间双向同步，恢复系统后跨页保留默认', () => {
    const storage = new Map([['theme', 'dark']])
    const x = setupTheme(storage)
    assert.equal(x.root.dataset.theme, 'dark')
    assert.deepEqual(x.selects.map((s) => s.value), ['dark', 'dark'])
    x.selects[1].change('light')
    assert.deepEqual(x.selects.map((s) => s.value), ['light', 'light'])
    assert.equal(x.root.style.colorScheme, 'light')
    assert.equal(storage.get('theme'), 'light')
    assert.deepEqual(setupTheme(storage).selects.map((s) => s.value), ['light', 'light'])
    x.selects[0].change('system')
    assert.deepEqual(x.selects.map((s) => s.value), ['system', 'system'])
    assert.equal(x.root.dataset.theme, undefined)
    assert.equal(x.root.style.colorScheme, '')
    assert.equal(storage.has('theme'), false)
    assert.deepEqual(setupTheme(storage).selects.map((s) => s.value), ['system', 'system'])
  }],
  ['浏览器存储拒绝读写时，两处主题控件仍可同步切换', () => {
    const x = setupTheme(new Map(), true)
    x.selects[1].change('dark')
    assert.equal(x.root.style.colorScheme, 'dark')
    assert.deepEqual(x.selects.map((s) => s.value), ['dark', 'dark'])
  }],
  ['点击打开与再次点击关闭', () => {
    const x = setup()
    x.trigger.focus(); x.trigger.emit('click')
    assert.equal(x.expanded(), true)
    x.trigger.emit('click')
    assert.equal(x.expanded(), false)
  }],
  ['Tab 聚焦胶囊即正确声明展开', () => {
    const x = setup(); x.trigger.focus()
    assert.equal(x.expanded(), true)
  }],
  ['焦点在胶囊和菜单内部移动时保持展开，离开后关闭', () => {
    const x = setup(); x.trigger.focus(); x.item.focus()
    assert.equal(x.expanded(), true)
    x.trigger.focus(); assert.equal(x.expanded(), true)
    x.outside.focus(); assert.equal(x.expanded(), false)
  }],
  ['桌面悬停打开并在离开后关闭，无须先点击', () => {
    const x = setup(); x.root.hover = true; x.root.emit('pointerenter', { pointerType: 'mouse' })
    assert.equal(x.expanded(), true)
    x.root.hover = false; x.root.emit('pointerleave', { pointerType: 'mouse' })
    assert.equal(x.expanded(), false)
  }],
  ['仅悬停打开时 Escape 也关闭并把焦点还给胶囊', () => {
    const x = setup(); x.root.hover = true; x.root.emit('pointerenter', { pointerType: 'mouse' })
    x.document.emit('keydown', { key: 'Escape' })
    assert.equal(x.expanded(), false)
    assert.equal(x.document.activeElement, x.trigger)
    assert.ok('suppress' in x.root.dataset)
  }],
  ['键盘 Escape 关闭后，再次从外部 Tab 进入可重新展开', () => {
    const x = setup(); x.trigger.focus(); x.trigger.emit('click'); x.item.focus()
    x.document.emit('keydown', { key: 'Escape' })
    assert.equal(x.expanded(), false)
    assert.equal(x.document.activeElement, x.trigger)
    x.outside.focus(); x.trigger.focus()
    assert.equal(x.expanded(), true)
  }],
  ['触屏 pointerenter 不模拟桌面 hover', () => {
    const x = setup({ canHover: false }); x.root.hover = true
    x.root.emit('pointerenter', { pointerType: 'touch' })
    assert.equal(x.expanded(), false)
    x.trigger.focus(); x.trigger.emit('click'); assert.equal(x.expanded(), true)
  }],
  ['点外关闭，打开用户菜单时关闭原生抽屉', () => {
    const x = setup(); x.drawer.setAttribute('open', '')
    x.trigger.focus(); x.trigger.emit('click')
    assert.equal(x.drawer.getAttribute('open'), null)
    x.document.emit('click', { target: x.outside })
    assert.equal(x.expanded(), false)
  }],
  ['从抽屉 Tab 进入胶囊时也关闭抽屉', () => {
    const x = setup(); x.drawer.setAttribute('open', '')
    x.trigger.focus()
    assert.equal(x.expanded(), true)
    assert.equal(x.drawer.getAttribute('open'), null)
  }],
  ['窄窗口通过鼠标悬停打开菜单时也关闭抽屉', () => {
    const x = setup(); x.drawer.setAttribute('open', ''); x.root.hover = true
    x.root.emit('pointerenter', { pointerType: 'mouse' })
    assert.equal(x.expanded(), true)
    assert.equal(x.drawer.getAttribute('open'), null)
  }],
]
let failures = 0
for (const [name, run] of tests) {
  try { run(); console.log(`PASS ${name}`) }
  catch (error) { failures++; console.error(`FAIL ${name}: ${error.message}`) }
}
console.log(`${tests.length - failures}/${tests.length} 通过`)
process.exitCode = failures ? 1 : 0
