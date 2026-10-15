/**
 * 面板自动刷新：定期拉 /api/status，只更新状态相关的那几个字段。
 * 为什么不用整页刷新：整页刷新会打断阅读（滚动位置丢失），也会让每次刷新都重渲染全部 HTML。
 */
(function () {
  'use strict'

  var root = document.getElementById('status-root')
  if (!root) return

  var INTERVAL = 30000

  function paint(data) {
    var byId = {}
    ;(data.targets || []).forEach(function (item) {
      byId[item.target.id] = item
    })

    Object.keys(byId).forEach(function (id) {
      var item = byId[id]
      var card = document.querySelector('[data-target="' + id + '"]')
      if (!card) return
      var s = item.stats || {}

      var dot = card.querySelector('.dot')
      if (dot) {
        var state = s.lastStatus || 'unknown'
        dot.className = 'dot ' + (state === 'up' ? 'ok' : state === 'degraded' ? 'warn' : state === 'down' ? 'bad' : 'unknown')
      }

      var up = card.querySelector('.uptime')
      if (up) up.textContent = s.uptime == null ? '暂无数据' : (s.uptime * 100).toFixed(2) + '%'

      var dds = card.querySelectorAll('.kv dd')
      if (dds.length >= 4) {
        dds[0].textContent = s.avgLatencyMs == null ? '—' : s.avgLatencyMs + ' ms'
        dds[1].textContent = s.p95LatencyMs == null ? '—' : s.p95LatencyMs + ' ms'
      }

      var err = card.querySelector('.target-error')
      var msg = s.lastStatus && s.lastStatus !== 'up' ? s.lastError : null
      if (msg) {
        if (!err) {
          err = document.createElement('p')
          err.className = 'target-error'
          card.appendChild(err)
        }
        err.textContent = msg
      } else if (err) {
        err.remove()
      }
    })

    var stamp = document.querySelector('.js-generated')
    if (stamp) stamp.textContent = '刚刚'
  }

  /**
   * 失败提示条。为什么不把逻辑做全：完整的失败态呈现（区分 401 与网络抖动、
   * 恢复后自动消失、真实时间戳、有限次重试）归「面板」票统一处理，
   * 本票只负责「**不再静默**」这一条——那是闸门落地后的必要连带改动。
   */
  function bannerEl() {
    var el = document.getElementById('status-banner')
    if (el) return el
    el = document.createElement('p')
    el.id = 'status-banner'
    el.className = 'notice status-banner'
    var root = document.getElementById('status-root')
    if (root && root.parentNode) root.parentNode.insertBefore(el, root)
    return el
  }

  function showBanner(text, withLoginLink) {
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
    var el = document.getElementById('status-banner')
    if (el) el.style.display = 'none'
  }

  function tick() {
    fetch('/api/status', { headers: { accept: 'application/json' } })
      .then(function (r) {
        if (r.status === 401) {
          // 会话过期：必须显眼，并给出回登录页的出口。
          showBanner('登录已过期，下面显示的可能不是最新数据。', true)
          return Promise.reject(new Error('unauthorized'))
        }
        if (!r.ok) return Promise.reject(new Error('HTTP ' + r.status))
        clearBanner()
        return r.json()
      })
      .then(paint)
      .catch(function () {
        // 面板保留上一次数据本身没错，错的是**不告诉用户数据是旧的**。
        // 本仓库的取舍是「失败要显眼不要静默降级」。
        if (!document.getElementById('status-banner') ||
            document.getElementById('status-banner').style.display === 'none') {
          showBanner('暂时拿不到最新数据，显示的是上一次的结果。', false)
        }
      })
  }

  setInterval(tick, INTERVAL)
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) tick()
  })
})()
