/**
 * 公开契约：`/api/status` 的**唯一**形状决定处。
 *
 * 为什么单独一个模块：内部结构（`ProbeTarget` / `TargetStats` / `ProbeResult`）会随实现演进，
 * 而对外契约不能跟着晃。显式白名单投影把两者隔开——**新增内部字段默认不出网**，
 * 要出网必须有人在这里加一行。见 `docs/adr/0003-public-contract-is-not-internal-structure.md`。
 *
 * 设计判据：**每个字段都必须能回答「前端哪个 DOM 更新在用它」**，答不上来的就是内部细节。
 * 见 `docs/api-status-fields-decision.md` §2。
 */
import { forOutput } from './sanitize.js'

/** 投影的输入：`server.ts` 里 `buildSummary()` 的产物（内部结构，含 url 等敏感字段）。 */
export interface SummaryLike {
  targets: Array<{
    target: {
      id: string
      name: string
      group?: string
      url: string
      expectStatus?: number[]
      enabled?: boolean
    }
    stats: {
      lastStatus: string | null
      uptime: number | null
      avgLatencyMs: number | null
      p95LatencyMs: number | null
      lastError: string | null
    }
    timeline: Array<{ at: number; status: string; latencyMs: number | null }>
    latency: Array<{ at: number; avgLatencyMs: number | null; samples?: number }>
  }>
  overview: Array<{ at: number; up: number; total: number }>
  incidents: Array<{
    targetId: string
    at: number
    status: string
    statusCode: number | null
    latencyMs: number | null
    error: string | null
  }>
  generatedAt: number
  windowLabel: string
  probeIntervalSeconds: number
}

/** 单个目标的公开形状。**恰好 10 个键**，有断言钉住。 */
export interface PublicTarget {
  id: string
  name: string
  group: string
  lastStatus: string | null
  uptime: number | null
  avgLatencyMs: number | null
  p95LatencyMs: number | null
  lastError: string | null
  timeline: Array<{ at: number; status: string; latencyMs: number | null }>
  latency: Array<{ at: number; avgLatencyMs: number | null }>
}

export interface PublicIncident {
  targetId: string
  at: number
  status: string
  statusCode: number | null
  latencyMs: number | null
  error: string | null
}

export interface PublicSummary {
  targets: PublicTarget[]
  overview: Array<{ at: number; up: number; total: number }>
  incidents: PublicIncident[]
  generatedAt: number
  windowLabel: string
  probeIntervalSeconds: number
}

/**
 * 把内部汇总投影成公开契约。
 *
 * 每条曲线点**也要逐字段挑**：否则日后 `store.ts` 改一句 SELECT，
 * 公开契约就会**悄悄**多出字段——那正是本模块要防的事。
 */
export function toPublicSummary(summary: SummaryLike): PublicSummary {
  return {
    targets: summary.targets.map((item) => ({
      id: item.target.id,
      name: item.target.name,
      group: item.target.group || '未分组',
      lastStatus: item.stats.lastStatus,
      uptime: item.stats.uptime,
      avgLatencyMs: item.stats.avgLatencyMs,
      p95LatencyMs: item.stats.p95LatencyMs,
      // 出网前最后一道闸：历史行万一绕过迁移，这里仍拦得住（纵深防御）。
      lastError: forOutput(item.stats.lastError),
      timeline: item.timeline.map((p) => ({ at: p.at, status: p.status, latencyMs: p.latencyMs })),
      latency: item.latency.map((p) => ({ at: p.at, avgLatencyMs: p.avgLatencyMs })),
    })),
    overview: summary.overview.map((p) => ({ at: p.at, up: p.up, total: p.total })),
    incidents: summary.incidents.map((inc) => ({
      targetId: inc.targetId,
      at: inc.at,
      status: inc.status,
      statusCode: inc.statusCode,
      latencyMs: inc.latencyMs,
      // ⚠ 与 lastError 走**完全相同**的规则。实测正是靠这一点才发现
      // 「修了 lastError 却漏了 incidents」这条旁路。
      error: forOutput(inc.error),
    })),
    generatedAt: summary.generatedAt,
    windowLabel: summary.windowLabel,
    probeIntervalSeconds: summary.probeIntervalSeconds,
  }
}
