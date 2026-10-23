/**
 * ⚠ 原型用的开发启动器（纯 .js，所以它能直接 import dist/ 里编译好的产物）。
 *
 * 票：整站视觉原型 https://github.com/Lkyloveaw/lkyloveaw-home/issues/21
 *
 * 为什么是 .js 而不是 .ts：`tsconfig.json` 的 `rootDir` 是 `src`，
 * 所以 `scripts/*.ts` **不会**被 `tsc` 编译进 `dist/`。而这个启动器要 import `dist/server.js`，
 * 放在 `scripts/` 下必须是普通 JS。
 *
 * 它只做一件生产入口不做的事：**没有 .env 时生成临时会话密钥**，
 * 让「一条命令就能看原型」成立。生产入口不会这样，`assertSessionSecret()` 的既有决定一行未动。
 *
 * 用法：npm run build && node scripts/prototype-dev.js
 */
import crypto from 'node:crypto'

if (!process.env.SESSION_SECRET) {
  // 64 个十六进制字符 = 32 字节，与 config.ts 对密钥强度的口径一致
  process.env.SESSION_SECRET = crypto.randomBytes(32).toString('hex')
  console.log('[prototype] 无 SESSION_SECRET —— 本次用临时密钥（每次重启都会变，会掉登录态）')
}
process.env.TARGETS_PATH ??= './targets.json'

const { buildServer } = await import('../dist/server.js')
const { config } = await import('../dist/config.js')
const { startProbing } = await import('../dist/probe.js')

// ⚠ 原型要的是「现在这批目标的真实画像」。库里如果压着几十小时前的旧数据，
// 24 小时窗口里一个样本都没有 → 每个目标都渲染成「无数据」，三个变体的差异全被抹平。
// 所以要一个**空的、一次性**的库。用 `--fresh` 显式索取，默认不删任何东西。
if (process.argv.includes('--fresh')) {
  const fs = await import('node:fs')
  const path = await import('node:path')
  const base = config.databasePath
  let removed = 0
  for (const suffix of ['', '-wal', '-shm']) {
    const f = `${base}${suffix}`
    if (fs.existsSync(f)) {
      fs.rmSync(f, { force: true })
      removed++
    }
  }
  console.log(
    `[prototype] --fresh：已删除 ${removed} 个库文件，将重建一个空库并从 targets.json 重新导入目标。\n` +
      `            ⚠ 这**不是**生产入口会做的事（生产的数据是不能随便删的）。`,
  )
}

const app = await buildServer()

// ⚠ 必须调这个。生产入口 main() 里有它，我第一版启动器漏了 ——
// 症状极具迷惑性：HTTP 全部正常（200/302 都对），但探测循环从未启动，
// 于是面板上每个目标都是「无数据」。真正的 bug 在启动器，不在面板。
startProbing()

await app.listen({ port: config.port, host: config.host })

const shown = config.host === '0.0.0.0' ? 'localhost' : config.host
console.log('')
console.log(`  原型已启动          http://${shown}:${config.port}/status?variant=A`)
console.log(`  其余变体            ?variant=B（卡片墙） · ?variant=C（时间轴优先）`)
console.log(`  不带 ?variant=      = 现有生产 UI（对照）`)
console.log(`  被监控目标 ${config.targets.length} 个`)
console.log('')

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log(`\n[prototype] 收到 ${sig}，退出中…`)
    void app.close().then(() => process.exit(0))
  })
}
