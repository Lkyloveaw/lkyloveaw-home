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

  function tick() {
    fetch('/api/status', { headers: { accept: 'application/json' } })
      .then(function (r) {
        return r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status))
      })
      .then(paint)
      .catch(function () {
        /* 静默失败：面板保留上一次数据，比显示错误更不打扰 */
      })
  }

  setInterval(tick, INTERVAL)
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) tick()
  })
})()
