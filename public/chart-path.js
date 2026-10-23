/**
 * 曲线几何核心（**浏览器与测试共用**，无构建步骤的 classic script）。
 *
 * 为什么有这个文件：曲线每 30 秒要跟着刷新，而首屏是服务端渲染的同一张图——
 * 不引图表库（ADR 0001）就得把映射搬到前端自己重算。两份实现由交叉断言钉住。
 * 但服务端也要画同一张图的**首屏版本**，于是同一份几何存在两份实现——
 * **两份实现迟早漂移**。所以把它抽成这个纯函数文件，并用交叉断言钉住：
 * 同一份输入，服务端渲染出的 `d` 必须与这里算出的 `d` **逐字符相等**。
 *
 * ⚠ 服务端 `src/charts.ts` 里的同名函数必须与本文件**保持等价**。改这里就要改那里，
 * 否则 `check:e2e` 的交叉断言会红。
 *
 * 为什么是 classic script 而不是 ES module：站点没有构建步骤（ADR 0001），
 * `public/status.js` 是 classic script，用 `<script src>` 引入本文件即可，挂 `globalThis`。
 */
;(function (global) {
  'use strict'

  /**
   * 折线路径。返回空串表示点不足，调用处应显示「数据不足」。
   *
   * 断点（null / 非有限 / 负数）会让路径**重新起段**（`M` 而不是 `L`）——
   * 把失败连成一条线会把「断档」伪装成「很快就好了」，是那种一眼看不出却会误导的错。
   */
  function linePath(values, w, h, pad, xAt, xRange, domain) {
    var nums = []
    for (var i = 0; i < values.length; i++) {
      var v = values[i]
      if (v != null && isFinite(v) && v >= 0) nums.push(v)
    }
    if (nums.length < 2) return ''

    var max = Math.max.apply(null, nums)
    var min = Math.min.apply(null, nums)
    // 所有点一样高时给一个假的高度差，否则线会贴在边缘上看起来像 0。
    var span = max - min < 1 ? Math.max(max, 1) : max - min
    var stepX = values.length > 1 ? (w - pad * 2) / (values.length - 1) : 0
    var useTime = !!xAt && !!xRange && xRange.max > xRange.min

    var d = ''
    var open = false
    for (var j = 0; j < values.length; j++) {
      var val = values[j]
      if (val == null || !isFinite(val) || val < 0) {
        open = false
        continue
      }
      var x = useTime
        ? pad + (w - pad * 2) * ((xAt[j] - xRange.min) / (xRange.max - xRange.min))
        : pad + j * stepX
      var y = domain ? clampY(val, domain, h, pad) : pad + (h - pad * 2) * (1 - (val - min) / span)
      d += (open ? 'L' : 'M') + x.toFixed(1) + ',' + y.toFixed(1) + ' '
      open = true
    }
    return d.replace(/\s+$/, '')
  }

  /** 把折线路径闭合成区域（渐变填充）。起止 x 直接从路径里取。 */
  function areaPath(d, w, h, pad) {
    var re = /[ML]([\d.]+),/g
    var xs = []
    var m
    while ((m = re.exec(d)) !== null) xs.push(Number(m[1]))
    if (!xs.length) return ''
    var first = xs[0]
    var last = xs[xs.length - 1]
    return d + ' L' + last.toFixed(1) + ',' + (h - pad).toFixed(1) +
      ' L' + first.toFixed(1) + ',' + (h - pad).toFixed(1) + ' Z'
  }

  /** 给渐变 id 用的小哈希，避免同页多个图共用 id 导致填充串色。 */
  function hash(s) {
    var h = 0
    for (var i = 0; i < s.length; i++) {
      h = ((h << 5) - h + s.charCodeAt(i)) | 0
    }
    return h
  }

  /**
   * 值域策略：**只扩不缩**，且有最小跨度下界。
   *
   * 为什么不能每次 tick 都重算 min/max（已实测）：尖峰进入窗口时，朴素重算会让
   * **已有老点整体位移 95.4px（图高的 87%）**——曲线看起来在「自己跳动」，
   * 用户无法对比前后。只扩不缩保证老点在值域不变时**纹丝不动**。
   *
   * 第一版「nice 阶梯」草案实测**比不修更差**（43.6px → 94.1px），且向下取整会把
   * 数据挤出值域，已作废——不要重走。
   */
  function expandDomain(current, values, minSpan) {
    minSpan = minSpan == null ? 10 : minSpan
    var lo = current ? current.min : Infinity
    var hi = current ? current.max : -Infinity
    for (var i = 0; i < values.length; i++) {
      var v = values[i]
      if (v == null || !isFinite(v) || v < 0) continue
      if (!current) {
        if (v < lo) lo = v
        if (v > hi) hi = v
      } else {
        // 只扩不缩
        if (v < lo) lo = v
        if (v > hi) hi = v
      }
    }
    if (!isFinite(lo) || !isFinite(hi)) return null
    if (hi - lo < minSpan) {
      // 以中点为轴撑到最小跨度，避免一条平线贴在图上沿
      var mid = (lo + hi) / 2
      lo = mid - minSpan / 2
      hi = mid + minSpan / 2
    }
    if (lo < 0) lo = 0
    return { min: lo, max: hi }
  }

  /** 越界夹紧：数据偶尔超出已记录的值域时，画到边缘而不是跑出画面。 */
  function clampY(value, domain, h, pad) {
    var lo = domain ? domain.min : 0
    var hi = domain ? domain.max : 1
    var span = hi - lo || 1
    var t = (value - lo) / span
    if (t < 0) t = 0
    if (t > 1) t = 1
    return pad + (h - pad * 2) * (1 - t)
  }

  global.ChartPath = {
    linePath: linePath,
    areaPath: areaPath,
    hash: hash,
    expandDomain: expandDomain,
    clampY: clampY,
  }
})(typeof globalThis !== 'undefined' ? globalThis : this)
