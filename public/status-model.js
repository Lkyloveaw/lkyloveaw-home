/** 状态呈现纯规则；首屏、首页及浏览器刷新共用，now 由调用者提供。 */
const STATUS_META = {
  up: ['ok', '可用'], degraded: ['warn', '异常'], down: ['bad', '故障'],
  stale: ['unknown', '数据过期'], unknown: ['unknown', '无数据'],
}
function statusMeta(status) {
  return Object.prototype.hasOwnProperty.call(STATUS_META, status) ? STATUS_META[status] : STATUS_META.unknown
}
export function stateClass(status) { return statusMeta(status)[0] }
export function stateText(status) { return statusMeta(status)[1] }

export function visibleState(item, now) {
  if (item.lastCheckedAt == null) return 'unknown'
  return now - item.lastCheckedAt > item.staleAfterMs ? 'stale' : (item.lastStatus || 'unknown')
}
export function summarizeStatus(items, now) {
  const counts = { total: items.length, up: 0, faults: 0, stale: 0, unknown: 0 }
  let uptimeSum = 0, uptimeCount = 0, latencySum = 0, latencyCount = 0
  for (const item of items) {
    const state = visibleState(item, now)
    if (state === 'up') counts.up++
    else if (state === 'down' || state === 'degraded') counts.faults++
    else if (state === 'stale') counts.stale++
    else counts.unknown++
    if (item.uptime != null) { uptimeSum += item.uptime; uptimeCount++ }
    if (item.avgLatencyMs != null) { latencySum += item.avgLatencyMs; latencyCount++ }
  }
  return {
    ...counts,
    avgUptime: uptimeCount ? uptimeSum / uptimeCount : null,
    avgLatencyMs: latencyCount ? Math.round(latencySum / latencyCount) : null,
    freshnessText: counts.stale || counts.unknown
      ? counts.stale + ' 个系统数据过期 · ' + counts.unknown + ' 个系统待探测'
      : items.length ? '探测数据正常' : '暂无监控系统',
  }
}
export function observedDuration(ms) {
  if (ms < 60000) return '不足 1 分钟'
  const minutes = Math.floor(ms / 60000)
  if (minutes < 60) return minutes + ' 分钟'
  const hours = Math.floor(minutes / 60)
  return hours < 48 ? hours + ' 小时' : Math.floor(hours / 24) + ' 天'
}
export function formatTime(ts) {
  if (ts == null || !Number.isFinite(ts)) return '—'
  const date = new Date(ts)
  const pad = n => String(n).padStart(2, '0')
  return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()) + ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes())
}
export function formatUptime(uptime) { return uptime == null ? '暂无数据' : (uptime * 100).toFixed(2) + '%' }
export function incidentOutcome(event, staleAfterMs = Infinity, now) {
  return event.outcome === 'ongoing' && now - event.lastSeenAt > staleAfterMs ? 'unknown' : event.outcome
}
export function incidentOutcomeText(outcome) {
  return outcome === 'recovered' ? '已恢复' : outcome === 'unknown' ? '缺测，待确认' : '持续中'
}
export function incidentDetails(event) {
  return '已确认 ' + observedDuration(event.durationMs) + ' · ' + (event.endedAt == null ? '最后异常' : '恢复记录') + ' ' + formatTime(event.endedAt ?? event.lastSeenAt)
}
