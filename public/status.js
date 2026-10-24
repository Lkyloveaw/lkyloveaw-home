/**
 * 面板自动刷新：定期拉 /api/status，更新数值、曲线与时序条。
 *
 * 为什么不用整页刷新：整页刷新会打断阅读（滚动位置丢失），也会让每次刷新都重渲染全部 HTML。
 *
 * 曲线重绘的几何核心在 `/chart-path.js`（与服务端 `src/charts.ts` 共用同一份映射，
 * 由 e2e 的交叉断言防漂移）。本文件只负责「取数 → 更新 DOM」。
 */
;(function () {
  'use strict'

  var root = document.getElementById('status-root')
  if (!root) return

  var INTERVAL = 30000
  var receivedAt = Date.now()
  var generatedAt = Number(root.getAttribute('data-generated')) || receivedAt
  var currentItems = JSON.parse(root.getAttribute('data-current') || '[]')
  var currentEvents = JSON.parse(root.getAttribute('data-events') || '[]')
  var initialKeys = root.getAttribute('data-current') !== null ? targetKeys(currentItems) : null
  var inFlight = false

  function targetKeys(items) {
    return JSON.stringify(items.map(function (t) { return [t.id, t.name, t.group] }))
  }

  function observedDuration(ms) {
    if (ms < 60000) return '不足 1 分钟'
    var minutes = Math.floor(ms / 60000)
    if (minutes < 60) return minutes + ' 分钟'
    var hours = Math.floor(minutes / 60)
    return hours < 48 ? hours + ' 小时' : Math.floor(hours / 24) + ' 天'
  }

  function visibleState(item, now) {
    if (item.lastCheckedAt == null) return 'unknown'
    return now - item.lastCheckedAt > item.staleAfterMs ? 'stale' : (item.lastStatus || 'unknown')
  }

  /** 共享横轴：整页所有曲线用同一个时间范围，否则各卡片的曲线会各自铺满宽度，时长看起来一样长。 */
  var xRange = null

  /**
   * 状态 → 样式类名 / 中文标签。
   *
   * ⚠ **必须与 `src/views.ts` 的 `STATUS_CLASS` / `STATUS_TEXT` 保持一致。**
   * 领域状态是 `up/degraded/down`，而样式类是 `ok/warn/bad`——两套词对不上就会**静默**丢掉颜色
   * （真发生过：徽标输出 `badge up`，而 CSS 只认 `.badge.ok`，徽标一个颜色都没上，
   * 肉眼看只像「素了点」）。这里是客户端那一半，改服务端时必须一起改。
   */
  var STATE_CLASS = { up: 'ok', degraded: 'warn', down: 'bad' }
  var STATE_TEXT = { up: '可用', degraded: '异常', down: '故障' }

  /** 没有数据时的兜底：状态可能为 null/未知，类名与文字都要能落下来。 */
  function stateClass(status) {
    return STATE_CLASS[status] || 'unknown'
  }
  function stateText(status) {
    return STATE_TEXT[status] || '无数据'
  }

  // ── 失败态 ─────────────────────────────────────────────
  // 判据（来自 #10）：面板是「一眼扫过」的界面，提示**不能喧宾夺主，但绝不能看不见**。
  // 401（会话过期）与瞬时抖动必须分开——把「需要重新登录」和「刚好抖了一下」混成
  // 同一个提示会误导用户去重登，而问题其实只是网络。

  var banner = null
  function bannerEl() {
    if (banner) return banner
    banner = document.getElementById('status-banner')
    if (!banner) {
      banner = document.createElement('p')
      banner.id = 'status-banner'
      banner.className = 'notice status-banner'
      banner.style.display = 'none'
      root.parentNode.insertBefore(banner, root)
    }
    return banner
  }

  var bannerKind = null
  function showBanner(kind, text, withLoginLink) {
    if (bannerKind === kind) return // 同一类失败不重绘，避免每 30 秒闪一次
    bannerKind = kind
    var el = bannerEl()
    el.textContent = text + ' '
    if (withLoginLink) {
      var a = document.createElement('a')
      a.href = '/login'
      a.textContent = '重新登录'
      el.appendChild(a)
    }
    el.style.display = ''
  }

  function clearBanner() {
    if (bannerKind === null) return
    bannerKind = null
    if (banner) banner.style.display = 'none'
  }

  // ── 数值 ───────────────────────────────────────────────

  function text(el, value) {
    if (el && el.textContent !== value) el.textContent = value
  }

  function paintNumbers(byId) {
    Object.keys(byId).forEach(function (id) {
      var item = byId[id]
      var card = document.querySelector('[data-target="' + id + '"]')
      if (!card) return

      text(card.querySelector('.uptime'), item.uptime == null ? '暂无数据' : (item.uptime * 100).toFixed(2) + '%')

      var dds = card.querySelectorAll('.kv dd')
      if (dds.length >= 4) {
        text(dds[0], item.avgLatencyMs == null ? '—' : item.avgLatencyMs + ' ms')
        text(dds[1], item.p95LatencyMs == null ? '—' : item.p95LatencyMs + ' ms')
        text(dds[2], item.lastStatus === 'up' && item.upStreakMs != null ? observedDuration(item.upStreakMs) : '—')
        text(dds[3], item.lastCheckedAt == null ? '—' : formatTime(item.lastCheckedAt))
      }

      var err = card.querySelector('.target-error')
      var msg = item.lastStatus && item.lastStatus !== 'up' ? item.lastError : null
      if (msg) {
        if (!err) {
          err = document.createElement('p')
          err.className = 'target-error'
          card.appendChild(err)
        }
        text(err, msg)
      } else if (err) {
        err.remove()
      }
    })
  }

  function paintFreshness() {
    // 用服务端取数时间加本地经过时长，避免两台机器时钟偏差造成误报。
    var now = generatedAt + Math.max(0, Date.now() - receivedAt)
    var up = 0, faults = 0, stale = 0, unknown = 0
    currentItems.forEach(function (item) {
      var state = visibleState(item, now)
      if (state === 'up') up++
      else if (state === 'down' || state === 'degraded') faults++
      else if (state === 'stale') stale++
      else unknown++
      var card = document.querySelector('[data-target="' + item.id + '"]')
      if (!card) return
      card.setAttribute('data-state', state)
      var dot = card.querySelector('.dot'), badge = card.querySelector('.badge')
      var label = state === 'stale' ? '数据过期' : stateText(state)
      if (dot) {
        dot.className = 'dot ' + stateClass(state)
        dot.setAttribute('title', label)
        text(dot.querySelector('.sr'), label)
      }
      if (badge) { badge.className = 'badge ' + stateClass(state); text(badge, label) }
    })
    text(document.querySelector('[data-metric="up"]'), up + '/' + currentItems.length)
    var faultEl = document.querySelector('[data-metric="faults"]')
    text(faultEl, String(faults))
    if (faultEl) faultEl.className = 'stat-num' + (faults ? ' has-fault' : '')
    text(document.querySelector('[data-metric="freshness"]'), stale || unknown
      ? stale + ' 个系统数据过期 · ' + unknown + ' 个系统待探测'
      : currentItems.length ? '探测数据正常' : '暂无监控系统')
    paintIncidents(now)
  }

  function paintSummary() {
    var uptimes = currentItems.filter(function (t) { return t.uptime != null })
    var latencies = currentItems.filter(function (t) { return t.avgLatencyMs != null })
    text(document.querySelector('[data-metric="uptime"]'), uptimes.length
      ? (uptimes.reduce(function (n, t) { return n + t.uptime }, 0) / uptimes.length * 100).toFixed(2) + '%' : '暂无数据')
    text(document.querySelector('[data-metric="latency"]'), latencies.length
      ? Math.round(latencies.reduce(function (n, t) { return n + t.avgLatencyMs }, 0) / latencies.length) + ' ms' : '—')
  }

  function paintIncidents(now) {
    var container = document.querySelector('[data-incidents]')
    if (!container) return
    container.textContent = ''
    if (!currentEvents.length) {
      var empty = document.createElement('p'); empty.className = 'empty'
      empty.textContent = '最近 24 小时没有记录到异常事件。'; container.appendChild(empty); return
    }
    var list = document.createElement('ul'); list.className = 'inset-list incident-list'
    currentEvents.forEach(function (event) {
      var item = currentItems.find(function (t) { return t.id === event.targetId })
      var outcome = event.outcome
      if (outcome === 'ongoing' && item && now - event.lastSeenAt > item.staleAfterMs) outcome = 'unknown'
      var row = document.createElement('li')
      function cell(cls, value) { var el = document.createElement('span'); el.className = cls; el.textContent = value; row.appendChild(el) }
      cell('incident-time', '首次记录 ' + formatTime(event.at))
      cell('incident-name', item ? item.name : event.targetId)
      cell('incident-outcome', outcome === 'recovered' ? '已恢复' : outcome === 'unknown' ? '缺测，待确认' : '持续中')
      cell('incident-details', '已确认 ' + observedDuration(event.durationMs) + ' · ' + (event.endedAt == null ? '最后异常' : '恢复记录') + ' ' + formatTime(event.endedAt == null ? event.lastSeenAt : event.endedAt))
      cell('incident-err', event.error || stateText(event.status))
      list.appendChild(row)
    })
    container.appendChild(list)
  }

  // ── 曲线 ───────────────────────────────────────────────

  var CP = window.ChartPath

  /**
   * 重画一个曲线容器。
   *
   * 结构由**服务端固定**（figure + svg + 两个 path 永远都在），空态只是多一个
   * `chart-empty` 类让覆盖层显示。所以「空 → 有数据 → 又空」只需要切类名：
   * 不会再有「页面打开时还没数据，之后曲线永远不出现」。
   *
   * 值域策略仍是「**只扩不缩**」：读容器上的 `data-y-min/max` 作为当前域，
   * 用新数据算是否需要扩张，扩张了就写回 DOM。**老点在域不变时纹丝不动**——
   * 朴素重算 min/max 会让尖峰进窗口时老点位移到图高的 87%（实测），看起来像曲线自己在跳。
   */
  function redrawChart(container, values, ats) {
    if (!CP) return
    var wide = container.classList.contains('chart-wide')
    var w = wide ? 760 : 520
    var h = wide ? 130 : 110
    var pad = wide ? 8 : 6
    var svg = container.querySelector('svg')
    var box = svg ? (svg.getAttribute('viewBox') || '').trim().split(/\s+/).map(Number) : []
    if (box.length === 4 && isFinite(box[2]) && box[2] > 0 && isFinite(box[3]) && box[3] > 0) {
      w = box[2]; h = box[3]
    }
    var kind = container.getAttribute('data-chart-kind') || 'latency'

    var cur = {
      min: parseFloat(container.getAttribute('data-y-min')),
      max: parseFloat(container.getAttribute('data-y-max')),
    }
    if (!isFinite(cur.min) || !isFinite(cur.max)) cur = null

    // 可用率天然 0-100，不扩域；延迟才需要只扩不缩。
    var domain = kind === 'uptime' ? { min: 0, max: 100 } : CP.expandDomain(cur, values, 10)
    var d = CP.linePath(values, w, h, pad, ats, xRange, domain)

    var paths = svg ? svg.querySelectorAll('path') : []

    // 数据不足 → 覆盖层；足够 → 原地补图。两个方向都走这里，空态不会「粘住」。
    if (!d || !domain || paths.length < 2) {
      container.classList.add('chart-empty')
      if (paths.length >= 2) {
        paths[0].setAttribute('d', '')
        paths[1].setAttribute('d', '')
      }
      text(container.querySelector('.chart-avg'), '')
      text(container.querySelector('.chart-max'), '')
      if (svg) svg.setAttribute('aria-label', kind === 'uptime' ? '可用率曲线需要至少两轮探测数据' : '延迟数据不足（至少 2 次有效探测后显示曲线）')
      return
    }
    container.classList.remove('chart-empty')

    // 值域变了才写回（避免每 tick 都改 DOM）
    if (kind !== 'uptime') {
      container.setAttribute('data-y-min', String(domain.min))
      container.setAttribute('data-y-max', String(domain.max))
    }

    paths[0].setAttribute('d', CP.areaPath(d, w, h, pad))
    paths[1].setAttribute('d', d)
    if (svg) svg.setAttribute('aria-label', kind === 'uptime' ? '可用率曲线' : '延迟曲线')

    // 渐变 id 跟着 d 走，否则同页多图会串色（与服务端同名规则一致）
    var newGid = (kind === 'uptime' ? 'ug' : 'lg') + Math.abs(CP.hash(d))
    if (container.getAttribute('data-fill-id') !== newGid) {
      var grad = svg.querySelector('linearGradient')
      if (grad) grad.id = newGid
      paths[0].setAttribute('fill', 'url(#' + newGid + ')')
      container.setAttribute('data-fill-id', newGid)
    }

    // 同步 figcaption：不更新的话，数值在变、图上的「平均/峰值」却是旧的。
    var nums = []
    for (var i = 0; i < values.length; i++) {
      if (values[i] != null && isFinite(values[i]) && values[i] >= 0) nums.push(values[i])
    }
    if (!nums.length) return
    var sum = 0
    for (var j = 0; j < nums.length; j++) sum += nums[j]
    var avgEl = container.querySelector('.chart-avg')
    var maxEl = container.querySelector('.chart-max')
    var failed = values.length - nums.length
    if (kind === 'uptime') {
      text(avgEl, '各轮可用系统占比')
      text(maxEl, '范围 ' + Math.min.apply(null, nums).toFixed(2) + '% – ' + Math.max.apply(null, nums).toFixed(2) + '%')
    } else {
      text(avgEl, '探测响应时间')
      text(maxEl, '峰值 ' + Math.max.apply(null, nums) + ' ms' + (failed ? ' · 失败或缺测已断开' : ''))
    }
  }
  /** 从 items 里抽出某个 `[data-chart]` 容器的数据。 */
  function chartValues(container, byId) {
    var card = container.closest ? container.closest('[data-target]') : null
    var kind = container.getAttribute('data-chart-kind') || 'latency'
    if (kind === 'uptime') {
      var pts = window.__overview || []
      return { values: pts.map(function (p) { return p.total > 0 ? (p.up / p.total) * 100 : null }), ats: pts.map(function (p) { return p.at }) }
    }
    if (!card) return null
    var item = byId[card.getAttribute('data-target')]
    if (!item || !item.latency) return null
    return { values: item.latency.map(function (p) { return p.avgLatencyMs }), ats: item.latency.map(function (p) { return p.at }) }
  }

  /** 横轴：每次 tick 全页重算一次，保证所有曲线横向可比。 */
  function recomputeXRange(api) {
    if (api.windowStartAt != null) { xRange = { min: api.windowStartAt, max: api.generatedAt }; return }
    var all = []
    ;(api.targets || []).forEach(function (t) {
      ;(t.latency || []).forEach(function (p) { all.push(p.at) })
    })
    ;(api.overview || []).forEach(function (p) { all.push(p.at) })
    if (!all.length) return
    xRange = { min: Math.min.apply(null, all), max: Math.max.apply(null, all) }
  }

  /** 横轴标注：每次 tick 跟着共享 xRange 更新（否则曲线在动、时间轴停在首屏）。 */
  function clock(ts) {
    var d = new Date(ts)
    var pad = function (n) { return String(n).padStart(2, '0') }
    return pad(d.getHours()) + ':' + pad(d.getMinutes())
  }

  function paintAxis() {
    if (!xRange || !(xRange.max > xRange.min)) return
    var mins = Math.round((xRange.max - xRange.min) / 60000)
    var span = mins < 60 ? mins + ' 分钟' : (mins / 60).toFixed(1) + ' 小时'
    var els = document.querySelectorAll('[data-axis]')
    for (var i = 0; i < els.length; i++) {
      var spans = els[i].querySelectorAll('span')
      if (spans.length >= 3) {
        text(spans[0], clock(xRange.min))
        text(spans[1], '覆盖 ' + span)
        text(spans[2], clock(xRange.max))
      }
    }
  }

  function paintCharts(api, byId) {
    var containers = document.querySelectorAll('[data-chart]')
    for (var i = 0; i < containers.length; i++) {
      var data = chartValues(containers[i], byId)
      if (data) redrawChart(containers[i], data.values, data.ats)
    }
  }

  // ── 时序条 ─────────────────────────────────────────────

  /**
   * 重建状态格带（`.cell-strip`）。
   *
   * ⚠ 三条硬约束，都是踩过坑才写在这里的：
   *
   * 1. **绝不写 `className`**。旧版把容器改成 `tl tl-empty` / `tl`，等于把 `cell-strip`
   *    整个抹掉 → 容器失去 `display:flex`，格带**塌成一条看不见的东西**。
   *    格带只需要换 `innerHTML`，容器类名由服务端说了算。
   * 2. **格数取自服务端的 `data-cells`**（不是按实际点数铺）。定宽是刻意的：
   *    各卡格数不一致就没法横向比，而「横向比」是卡片墙的全部意义。缺的补空心格。
   * 3. **空态与非空态结构相同**（都是 N 个格），所以**不需要**在两种结构间切换——
   *    旧版为此专门做了一个 `tl-empty` 类，正是那个类名切换把容器样式搞坏的。
   */
  function paintTimeline(byId) {
    Object.keys(byId).forEach(function (id) {
      var item = byId[id]
      var card = document.querySelector('[data-target="' + id + '"]')
      if (!card) return
      var strip = card.querySelector('[data-timeline]')
      if (!strip) return

      var want = parseInt(strip.getAttribute('data-cells'), 10)
      if (!(want > 0)) want = 56 // 兜底：老页面没有该属性时也不至于渲染成 0 格

      var pts = (item.timeline || []).slice(-want)
      var html = ''
      var i
      for (i = 0; i < want - pts.length; i++) html += '<i class="cell-missing"></i>'
      for (i = 0; i < pts.length; i++) {
        var p = pts[i]
        // title 必须与格子状态**同步更新**，否则悬停看到的是旧数据
        var t = formatTime(p.at) + ' · ' + stateText(p.status) + (p.latencyMs != null ? ' · ' + p.latencyMs + 'ms' : '')
        html += '<i class="' + p.status + '" title="' + esc(t) + '"></i>'
      }
      strip.innerHTML = html

      // 说明行里的「最近 N 次」也得跟着走，否则刷新后数字会一直停在首屏那个值。
      text(card.querySelector('.js-cells'), String(pts.length))
      strip.setAttribute('aria-label', item.name + '：最近 ' + pts.length + ' 次探测（旧 → 新），最近 24 小时可用率 ' + (item.uptime == null ? '暂无数据' : (item.uptime * 100).toFixed(2) + '%'))
    })
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;')
  }

  function formatTime(ts) {
    var d = new Date(ts)
    var pad = function (n) { return String(n).padStart(2, '0') }
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
      ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes())
  }

  // ── 主流程 ─────────────────────────────────────────────

  function paint(api) {
    if (initialKeys !== null && targetKeys(api.targets || []) !== initialKeys) {
      showBanner('targets', '系统清单已变更，请刷新页面查看。', false)
      return
    }
    currentItems = api.targets || []
    currentEvents = api.incidents || []
    generatedAt = api.generatedAt
    receivedAt = Date.now()
    var byId = {}
    ;(api.targets || []).forEach(function (item) {
      // ⚠ 契约已拍平：id 在顶层（原先是 item.target.id），stats 也压平了。
      byId[item.id] = item
    })

    window.__overview = api.overview || []
    recomputeXRange(api)
    paintAxis()

    paintNumbers(byId)
    paintCharts(api, byId)
    paintTimeline(byId)
    paintSummary()
    paintFreshness()
    text(document.querySelector('.js-probe-interval'), String(api.probeIntervalSeconds))

    // 真实时间戳：原来恒显示「刚刚」，导致「数据是旧的」无从判断——
    // 对可用性面板来说这是最要紧的一眼。
    var stamp = document.querySelector('.js-generated')
    if (stamp) {
      var when = api.generatedAt ? new Date(api.generatedAt) : new Date()
      text(stamp, formatTime(when.getTime()))
    }
  }

  function tick() {
    paintFreshness()
    if (inFlight) return
    inFlight = true
    var controller = new AbortController()
    var timeout = setTimeout(function () { controller.abort() }, 10000)
    fetch('/api/status', { headers: { accept: 'application/json' }, signal: controller.signal })
      .then(function (r) {
        if (r.status === 401) {
          showBanner('auth', '登录已过期，下面显示的可能不是最新数据。', true)
          return Promise.reject(new Error('unauthorized'))
        }
        if (!r.ok) return Promise.reject(new Error('HTTP ' + r.status))
        return r.json()
      })
      .then(function (api) { clearBanner(); paint(api) })
      .catch(function () {
        // 区分「需要重新登录」与「刚好抖了一下」：前者已在上面的 401 分支给出登录链接。
        // 面板保留上一次数据没错，错的是**不告诉用户数据是旧的**。
        // 失败就如实报出来（有限重试归后续，不在本轮静默吞掉）。
        if (bannerKind !== 'auth') {
          showBanner('network', '暂时拿不到最新数据，下面显示的是上一次的结果。', false)
        }
      })
      .finally(function () { clearTimeout(timeout); inFlight = false })
  }

  setInterval(tick, INTERVAL)
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) tick()
  })
})()
