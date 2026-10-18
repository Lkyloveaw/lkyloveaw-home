/**
 * 探测引擎：服务端周期性地去打内网各业务系统，记录可用性与延迟。
 * 为什么必须在服务端：浏览器既跑不了「每 60 秒、24 小时」的定时记录，也拿不到跨域探测结果，
 * 更无法在内网机器之外访问内网地址。探测位置就是这台部署机器。
 */
import { config, type ProbeTarget } from './config.js'
import { recordResults, pruneOldProbes, checkpoint, type ProbeResult } from './store.js'
import { listEnabledTargets } from './targets-store.js'
import { getProbeIntervalMs } from './settings-store.js'
import { sweepSessions } from './sessions-store.js'
import { classifyRuntimeError } from './sanitize.js'
import { runBackup } from './backup.js'

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
      // ⚠ `manual` 而不是 `follow`：跟随跳转会让探测去请求**跳转目标**——
      // 实测 `follow` 让目标被请求 1 次、`manual` 后为 0 次。
      // 这条从根上关掉「被探测的系统 302 到一个它不该访问的地址（如元数据服务）」这条路。
      //
      // 注意语义变化：`manual` 之后 3xx 会**原样返回**，而默认判定区间是 200-399，
      // 所以 302 仍会被判为 `up`。这是**有意的**——改默认会静默变更所有既有部署的语义。
      // 想让 302 算失败，请在管理台 → 目标里把该目标的状态码填成 `200`（旧写法是 targets.json 的 `expectStatus`）。
      redirect: 'manual',
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
  /*
   * **每一轮开头读一次库**（`docs/targets-source-decision.md` §6）：不缓存、不设版本号。
   *
   * 为什么不做缓存：探测间隔默认 60 秒，一天 1440 次单表 SELECT，而 SQLite 这类查询是微秒级。
   * 缓存要引入一个版本号、一个失效路径、以及「版本号没更新 → 网页上刚加的目标不生效」
   * 这个**新的静默失败**。用一次微秒级查询换掉一整套失效逻辑，这笔账不需要犹豫。
   *
   * 读在**循环外**：所以一轮之内不会出现「前半轮有它、后半轮没有它」。
   * 生效时机：网页上改完 → **下一轮**开始生效（≤ 1 个间隔），不打断正在等的那一轮。
   */
  const targets = listEnabledTargets()
  if (!targets.length) return []
  // 一轮共用一个 roundAt：并发发起的各目标 at 会相差几毫秒，
  // 整体可用率必须按轮聚合，否则一个点只有 1 个目标，曲线在 0%/100% 之间乱跳。
  const roundAt = Date.now()
  const results = await Promise.all(targets.map((t) => probeOne(t, roundAt)))
  recordResults(results)
  return results
}

let timer: NodeJS.Timeout | null = null

/** 探测轮次计数：用作 checkpoint / 备份的降频基准。 */
let roundCount = 0

/**
 * 按轮次降频做「checkpoint + 备份」。
 *
 * 为什么绑探测轮次而不是另开定时器：探测轮次**已经是这个进程唯一的心跳**
 * （`docs/backup-checkpoint-decision.md` §2.2）。再开一个定时器只多一处可能停摆的东西。
 *
 * **任何失败都只记日志，绝不中断探测**：备份坏掉不该让可用性面板跟着瞎。
 */
async function maybeCheckpointAndBackup(): Promise<void> {
  roundCount++

  if (config.checkpointEveryRounds > 0 && roundCount % config.checkpointEveryRounds === 0) {
    try {
      const cp = checkpoint('TRUNCATE')
      if (cp.busy !== 0) {
        // 实测：`busy:0` 都可能是骗人的（只搬了 2/33 页），非 0 就更不能当成功。
        console.warn(`[probe] checkpoint 未完成：busy=${cp.busy}，已搬 ${cp.pages} 页（WAL 未截断）`)
      }
    } catch (err) {
      console.error('[probe] checkpoint 失败：', (err as Error).message)
    }

    /*
     * 顺手清掉**已死**的会话行（过期的 + 已吊销的），与 checkpoint 并列、共用这个心跳。
     * 为什么不放进 `onRequest`：那是每个请求都要付的代价，而清理是每日级的活。
     * 只删死行 —— 活着的会话一行不动（`docs/session-revoke-decision.md` §7）。
     */
    try {
      const removed = sweepSessions()
      if (removed > 0) console.log(`[probe] 已清理 ${removed} 条已死会话行`)
    } catch (err) {
      console.error('[probe] 会话清理失败：', (err as Error).message)
    }
  }

  if (config.backupEveryRounds > 0 && roundCount % config.backupEveryRounds === 0) {
    try {
      const r = await runBackup()
      if (r.ok) {
        console.log(`[probe] 备份完成 ${r.file}（${r.bytes} B，${r.rows} 行）${r.note ? ' · ' + r.note : ''}`)
      } else {
        console.error(`[probe] 备份失败（探测继续）：${r.note}`)
      }
    } catch (err) {
      console.error('[probe] 备份异常（探测继续）：', (err as Error).message)
    }
  }
}

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
      await maybeCheckpointAndBackup()
    } catch (err) {
      // 探测循环是长期驻留的，一次失败绝不能让它退出。
      console.error('[probe] 本轮探测异常：', (err as Error).message)
    } finally {
      /*
       * 间隔**每一轮重读一次**（`docs/settings-source-decision.md` §4）：网页上把间隔改成 10 秒，
       * 不用重启、也不用碰这里的 `timer` —— 下一轮就按新值排。
       *
       * ⚠ 语义要说准：**改完不打断正在等的那一轮**。若这一轮刚结束、定时器已经在等 60 秒，
       * 此刻把间隔改成 10 秒，**下一次探测仍会等满这 60 秒**，之后每次才是 10 秒。
       * 这是**对**的行为（打断一个已排好的定时器只会让「下次什么时候探」变得不可预测），
       * 所以设置页上把那句话写在明面上。
       *
       * 为什么每轮重读而不是缓存：与目标清单同一条判断（#26 §6）—— 一次单表主键 SELECT 是微秒级，
       * 而缓存要引入失效逻辑与「改了不生效」这个新的静默失败。
       */
      timer = setTimeout(() => void tick(), getProbeIntervalMs())
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
