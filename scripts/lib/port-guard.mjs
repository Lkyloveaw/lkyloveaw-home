/**
 * 端口的「先确认没被占」守卫（`#46` 收口时加的）。
 *
 * 为什么需要它：几个验收脚本都用**固定端口**起一个临时服务，然后只等 `/healthz` 回 ok。
 * 只要那个端口上已经有**别的实例**（上一次跑崩了没退、或者上一条命令的进程还活着），
 * 等待就会立刻"成功"，脚本随即对着**另一个库**登录 → 症状是
 * 「登录 401 / timeline=0」这种看着像产品 bug、其实是环境挡路的东西。
 * （`#45` 的第一次 `verify` 就撞上过一次，之后三轮都没复现 —— 典型的"环境挡路"。）
 *
 * 所以：起服务**之前**先探一下端口。被占就**立刻失败并说清怎么办**，
 * 绝不让脚本"凑到一个服务上"就开始断言。
 *
 * ⚠ 这只能把竞态窗口缩小到毫秒级（探完到起进程之间），不能消灭它；
 * 因此各脚本还应断言"我连到的确实是我起的那个实例"（例如 `/healthz` 里的目标数）。
 * 两层一起才够。
 */
import net from 'node:net'

/** 端口是否有人在听（本机回环）。 */
export function portIsFree(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host })
    const done = (free) => {
      sock.removeAllListeners()
      sock.destroy()
      resolve(free)
    }
    sock.setTimeout(800, () => done(true)) // 超时当作"没人听"
    sock.once('connect', () => done(false))
    sock.once('error', () => done(true))
  })
}

/**
 * 断言端口空闲；被占则抛出**带处置办法**的错误。
 *
 * @param {number} port
 * @param {string} who 哪个脚本（报错里要说清是哪一条 check 被挡了）
 */
export async function assertPortFree(port, who) {
  if (await portIsFree(port)) return
  throw new Error(
    `端口 ${port} 已被占用：${who} 会对着**别人起的服务**断言，结果不可信。\n` +
      `  处置：找出占用者并关掉（Windows: netstat -ano | findstr :${port} → taskkill /PID <pid> /F；\n` +
      `        Linux/macOS: lsof -i :${port}），然后重跑；若是上一次的残留进程，先 kill 再跑。`,
  )
}
