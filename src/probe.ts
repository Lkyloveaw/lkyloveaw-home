/**
 * 探测引擎：服务端周期性地去打内网各业务系统，记录可用性与延迟。
 * 为什么必须在服务端：浏览器既跑不了「每 60 秒、24 小时」的定时记录，也拿不到跨域探测结果，
 * 更无法在内网机器之外访问内网地址。探测位置就是这台部署机器。
 */
import { config, type ProbeTarget } from './config.js'
import { recordResults, pruneOldProbes, type ProbeResult } from './store.js'
import { classifyRuntimeError } from './sanitize.js'

const DEFAULT_OK_STATUS = (code: number): boolean => code >= 200 && code < 400

/** 探测单个目标。任何异常都被收敛成一条 down 记录，绝不向上抛。 */
async function probeOne(target: ProbeTarget, roundAt: number): Promise<ProbeResult> {
  const at = Date.now()
  const timeout = target.timeoutMs ?? config.probeTimeoutMs
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeout)

  try {
    const started = Date.now()
    const res = await fetch(target.url, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'user-agent': 'personal-wiki-uptime/0.1' },
    })
    const latencyMs = Date.now() - started

    // 关键：只读 headers 就够判断可用性，主动取消 body，
    // 避免某些内网系统返回大文件时把探测进程的带宽和内存吃掉。
    await res.body?.cancel().catch(() => {})

    const ok = target.expectStatus?.length
      ? target.expectStatus.includes(res.status)
      : DEFAULT_OK_STATUS(res.status)

    return {
      targetId: target.id,
      at,
      roundAt,
      status: ok ? 'up' : 'degraded',
      latencyMs,
      statusCode: res.status,
      error: ok ? null : `状态码 ${res.status} 不在预期范围内`,
    }
  } catch (err) {
    const e = err as Error & { cause?: { code?: string } }
    const aborted = e.name === 'AbortError'
    return {
      targetId: target.id,
      at,
      roundAt,
      status: 'down',
      latencyMs: null,
      statusCode: null,
      // 两类错误在这里分流（`docs/api-status-fields-decision.md` §4.3）：
      // - 超时是**我们自己**判定的，文案只含超时值，天然安全且信息量最大 → 原样保留；
      // - 其余是运行时异常，原文可能含完整 URL 与凭证 → **只留类别码，兜底不回原文**。
      //
      // ⚠ 原来这里是 `e.cause?.code ?? e.message ?? '未知错误'`。那个 `?? e.message`
      // 就是泄漏命门：喂 `http://ops:hunter2@ledger.internal.example/` 进去，
      // 落库的会是含内网主机名与口令的完整长句。**删掉它，不要以任何形式加回来。**
      error: aborted ? `超时（>${timeout}ms）` : classifyRuntimeError(e.cause?.code),
    }
  } finally {
    clearTimeout(timer)
  }
}

/** 探测一轮全部目标。并发执行，整体耗时约等于最慢的那个目标。 */
export async function probeAll(): Promise<ProbeResult[]> {
  const targets = config.targets.filter((t) => t.enabled !== false)
  if (!targets.length) return []
  // 一轮共用一个 roundAt：并发发起的各目标 at 会相差几毫秒，
  // 整体可用率必须按轮聚合，否则一个点只有 1 个目标，曲线在 0%/100% 之间乱跳。
  const roundAt = Date.now()
  const results = await Promise.all(targets.map((t) => probeOne(t, roundAt)))
  recordResults(results)
  return results
}

let timer: NodeJS.Timeout | null = null

/** 启动周期探测。间隔内跑完就等，跑不完也不重叠（用递归 setTimeout 而非 setInterval）。 */
export function startProbing(): void {
  if (timer) return
  const tick = async (): Promise<void> => {
    try {
      const results = await probeAll()
      if (results.length) {
        const up = results.filter((r) => r.status === 'up').length
        console.log(`[probe] ${new Date().toISOString()} ${up}/${results.length} 可用`)
      }
      pruneOldProbes()
    } catch (err) {
      // 探测循环是长期驻留的，一次失败绝不能让它退出。
      console.error('[probe] 本轮探测异常：', (err as Error).message)
    } finally {
      timer = setTimeout(() => void tick(), config.probeIntervalMs)
      timer.unref?.()
    }
  }
  // 启动后立刻探一轮：否则重启后要等一个完整间隔才有数据，面板会空一分钟。
  void tick()
}

export function stopProbing(): void {
  if (timer) {
    clearTimeout(timer)
    timer = null
  }
}
