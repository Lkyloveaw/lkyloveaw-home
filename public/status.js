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

  /** 共享横轴：整页所有曲线用同一个时间范围，否则各卡片的曲线会各自铺满宽度，时长看起来一样长。 */
  var xRange = null

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

      var dot = card.querySelector('.dot')
      if (dot) {
        var state = item.lastStatus || 'unknown'
        var cls =
          'dot ' +
          (state === 'up' ? 'ok' : state === 'degraded' ? 'warn' : state === 'down' ? 'bad' : 'unknown')
        if (dot.className !== cls) dot.className = cls
      }

      text(card.querySelector('.uptime'), item.uptime == null ? '暂无数据' : (item.uptime * 100).toFixed(2) + '%')

      var dds = card.querySelectorAll('.kv dd')
      if (dds.length >= 4) {
        text(dds[0], item.avgLatencyMs == null ? '—' : item.avgLatencyMs + ' ms')
        text(dds[1], item.p95LatencyMs == null ? '—' : item.p95LatencyMs + ' ms')
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

  // ── 曲线 ───────────────────────────────────────────────

  var CP = window.ChartPath

  /**
   * 重画一个曲线容器。
   *
   * 值域策略是「**只扩不缩**」：读容器上的 `data-y-min/max` 作为当前域，
   * 用新数据算是否需要扩张，扩张了就写回 DOM。**老点在域不变时纹丝不动**——
   * 朴素重算 min/max 会让尖峰进窗口时老点位移到图高的 87%（实测），看起来像曲线自己在跳。
   */
  function redrawChart(container, values, ats) {
    if (!CP) return
    var w = container.classList.contains('chart-wide') ? 760 : 520
    var h = container.classList.contains('chart-wide') ? 130 : 110
    var pad = container.classList.contains('chart-wide') ? 8 : 6
    var kind = container.getAttribute('data-chart-kind') || 'latency'

    var cur = {
      min: parseFloat(container.getAttribute('data-y-min')),
      max: parseFloat(container.getAttribute('data-y-max')),
    }
    if (!isFinite(cur.min) || !isFinite(cur.max)) cur = null

    // 可用率天然 0-100，不扩域；延迟才需要只扩不缩。
    var domain = kind === 'uptime' ? { min: 0, max: 100 } : CP.expandDomain(cur, values, 10)
    if (!domain) return

    var d = CP.linePath(values, w, h, pad, ats, xRange)
    if (!d) return // 点不足：保持原样，等下一轮

    // 值域变了才写回（避免每 tick 都改 DOM）
    if (kind !== 'uptime') {
      container.setAttribute('data-y-min', domain.min.toFixed(2))
      container.setAttribute('data-y-max', domain.max.toFixed(2))
    }

    var svg = container.querySelector('svg')
    if (!svg) return
    var paths = svg.querySelectorAll('path')
    if (paths.length < 2) return
    var gid = container.getAttribute('data-fill-id')
    paths[0].setAttribute('d', CP.areaPath(d, w, h, pad))
    paths[1].setAttribute('d', d)

    // 渐变 id 跟着 d 走，否则同页多图会串色（与服务端同名规则一致）
    var newGid = (kind === 'uptime' ? 'ug' : 'lg') + Math.abs(CP.hash(d))
    if (gid && newGid !== gid) {
      var grad = svg.querySelector('linearGradient')
      if (grad) grad.id = newGid
      paths[0].setAttribute('fill', 'url(#' + newGid + ')')
      container.setAttribute('data-fill-id', newGid)
    }

    // 同步 figcaption：不更新的话，数值在变、图上的「平均/峰值」却是旧的。
    var caption = container.querySelector('.chart-avg')
    if (caption) {
      var nums = []
      for (var i = 0; i < values.length; i++) {
        if (values[i] != null && isFinite(values[i]) && values[i] >= 0) nums.push(values[i])
      }
      if (nums.length) {
        if (kind === 'uptime') {
          var sum = 0
          for (var j = 0; j < nums.length; j++) sum += nums[j]
          text(caption, '窗口内平均可用率 ' + (sum / nums.length).toFixed(1) + '%')
        } else {
          var s = 0
          for (var k = 0; k < nums.length; k++) s += nums[k]
          text(caption, '延迟（平均 ' + Math.round(s / nums.length) + ' ms）')
        }
      }
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
    var all = []
    ;(api.targets || []).forEach(function (t) {
      ;(t.latency || []).forEach(function (p) { all.push(p.at) })
    })
    if (xRange) all.push(xRange.min, xRange.max)
    ;(api.overview || []).forEach(function (p) { all.push(p.at) })
    if (!all.length) return
    xRange = { min: Math.min.apply(null, all), max: Math.max.apply(null, all) }
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
   * 重建 `.tl-cell` 状态条。
   * 用**整块重建 innerHTML**（与曲线空态同一手法）：空态 `.tl-empty` 与非空结构不同，
   * 只改 class 的话两种状态没法互相切换。
   */
  function paintTimeline(byId) {
    Object.keys(byId).forEach(function (id) {
      var item = byId[id]
      var card = document.querySelector('[data-target="' + id + '"]')
      if (!card) return
      var tl = card.querySelector('[data-timeline]')
      if (!tl) return
      var pts = item.timeline || []
      if (!pts.length) {
        if (!tl.classList.contains('tl-empty')) {
          tl.className = 'tl tl-empty'
          tl.innerHTML = '<span class="sr">暂无数据</span>'
        }
        return
      }
      var html = ''
      for (var i = 0; i < pts.length; i++) {
        var p = pts[i]
        // title 必须与格子状态**同步更新**，否则悬停看到的是旧数据
        var label = p.status === 'up' ? '可用' : p.status === 'degraded' ? '异常' : '故障'
        var t = formatTime(p.at) + ' · ' + label + (p.latencyMs != null ? ' · ' + p.latencyMs + 'ms' : '')
        html += '<i class="tl-cell ' + p.status + '" title="' + esc(t) + '"></i>'
      }
      if (tl.classList.contains('tl-empty')) {
        // 从空态切回有数据：结构不同，整块换
        tl.className = 'tl'
      }
      tl.innerHTML = html
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
    var byId = {}
    ;(api.targets || []).forEach(function (item) {
      // ⚠ 契约已拍平：id 在顶层（原先是 item.target.id），stats 也压平了。
      byId[item.id] = item
    })

    window.__overview = api.overview || []
    recomputeXRange(api)

    paintNumbers(byId)
    paintCharts(api, byId)
    paintTimeline(byId)

    // 真实时间戳：原来恒显示「刚刚」，导致「数据是旧的」无从判断——
    // 对可用性面板来说这是最要紧的一眼。
    var stamp = document.querySelector('.js-generated')
    if (stamp) {
      var when = api.generatedAt ? new Date(api.generatedAt) : new Date()
      text(stamp, formatTime(when.getTime()))
    }
  }

  function tick() {
    fetch('/api/status', { headers: { accept: 'application/json' } })
      .then(function (r) {
        if (r.status === 401) {
          showBanner('auth', '登录已过期，下面显示的可能不是最新数据。', true)
          return Promise.reject(new Error('unauthorized'))
        }
        if (!r.ok) return Promise.reject(new Error('HTTP ' + r.status))
        clearBanner()
        return r.json()
      })
      .then(paint)
      .catch(function () {
        // 区分「需要重新登录」与「刚好抖了一下」：前者已在上面的 401 分支给出登录链接。
        // 面板保留上一次数据没错，错的是**不告诉用户数据是旧的**。
        // 失败就如实报出来（有限重试归后续，不在本轮静默吞掉）。
        if (bannerKind !== 'auth') {
          showBanner('network', '暂时拿不到最新数据，下面显示的是上一次的结果。', false)
        }
      })
  }

  setInterval(tick, INTERVAL)
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) tick()
  })
})()
