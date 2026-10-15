/**
 * HTTP 层：路由 + 组装页面数据。
 * 一台进程同时负责页面渲染和周期探测，Docker 里就只有一个容器、一个 volume。
 */
import path from 'node:path'
import Fastify from 'fastify'
import fastifyStatic from '@fastify/static'
import { config } from './config.js'
import { getPost, listPosts, listTags } from './content.js'
import { getRecentIncidents, getUptimeRaw, getStats, getTimeline, getLatencyRaw, initStore, closeStore } from './store.js'
import { startProbing, stopProbing } from './probe.js'
import {
  aboutPage,
  homePage,
  notFoundPage,
  postPage,
  postsPage,
  statusPage,
  type StatusSummary,
} from './views.js'

const WINDOW_MS = 24 * 60 * 60 * 1000
const WINDOW_LABEL = '最近 24 小时'

const site = { title: config.siteTitle, description: config.siteDescription }

/** 汇总面板需要的数据。每次请求现算：SQLite 聚合在这个数据量下是毫秒级，不值得再加缓存层。 */
function buildSummary(): StatusSummary {
  const targets = config.targets
    .filter((t) => t.enabled !== false)
    .map((target) => ({
      target,
      stats: getStats(target.id, WINDOW_MS),
      timeline: getTimeline(target.id, WINDOW_MS, 60),
      latency: getLatencyRaw(target.id, WINDOW_MS, 120),
    }))
  return {
    targets,
    overview: getUptimeRaw(WINDOW_MS, 120),
    incidents: getRecentIncidents(8),
    generatedAt: Date.now(),
    windowLabel: WINDOW_LABEL,
    probeIntervalSeconds: Math.round(config.probeIntervalMs / 1000),
  }
}

export async function buildServer(): Promise<ReturnType<typeof Fastify>> {
  initStore()

  const app = Fastify({
    logger: false,
    trustProxy: true,
  })

  await app.register(fastifyStatic, {
    root: config.publicDir,
    prefix: '/',
    // 静态资源不带 hash，交给浏览器短缓存即可。
    maxAge: '1h',
  })

  app.get('/', async (_req, reply) => {
    reply.type('text/html; charset=utf-8')
    return homePage(listPosts(), buildSummary(), site)
  })

  app.get('/posts', async (_req, reply) => {
    reply.type('text/html; charset=utf-8')
    return postsPage(listPosts(), listTags(), site)
  })

  app.get('/tags/:tag', async (req, reply) => {
    const tag = decodeURIComponent((req.params as { tag: string }).tag)
    const posts = listPosts().filter((p) => p.tags.includes(tag))
    reply.type('text/html; charset=utf-8')
    return postsPage(posts, listTags(), site, `标签：${tag}`, tag)
  })

  app.get('/posts/:slug', async (req, reply) => {
    const post = getPost((req.params as { slug: string }).slug)
    if (!post) {
      reply.code(404).type('text/html; charset=utf-8')
      return notFoundPage(site)
    }
    reply.type('text/html; charset=utf-8')
    return postPage(post, site)
  })

  app.get('/status', async (_req, reply) => {
    reply.type('text/html; charset=utf-8')
    return statusPage(buildSummary(), site)
  })

  /** 给前端自动刷新用的 JSON：只回渲染必需的字段，不回整页 HTML。 */
  app.get('/api/status', async (_req, reply) => {
    return reply.send(buildSummary())
  })

  app.get('/about', async (_req, reply) => {
    reply.type('text/html; charset=utf-8')
    return aboutPage(site)
  })

  app.get('/healthz', async () => ({ ok: true, targets: config.targets.length }))

  app.setNotFoundHandler(async (_req, reply) => {
    reply.code(404).type('text/html; charset=utf-8')
    return notFoundPage(site)
  })

  return app
}

async function main(): Promise<void> {
  const app = await buildServer()
  await app.listen({ port: config.port, host: config.host })

  const shown = config.host === '0.0.0.0' ? 'localhost' : config.host
  console.log(`\n  站点已启动  http://${shown}:${config.port}`)
  console.log(`  监控目标    ${config.targets.length} 个（清单：${process.env.TARGETS_PATH ?? 'targets.json'}）`)
  if (!config.targets.length) {
    console.warn('  提示：还没有配置被监控的系统，编辑 targets.json 后重启即可。')
  }
  console.log('')

  startProbing()

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`\n[server] 收到 ${signal}，正在退出…`)
    stopProbing()
    await app.close()
    closeStore()
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
}

// 只有作为入口直接运行时才启动监听：被 import（测试、脚本）时不该自己起服务。
// 同时兼容 dev（src/server.ts，走 tsx）与 prod（dist/server.js）两种入口。
const entry = process.argv[1] ? path.resolve(process.argv[1]) : ''
const invokedDirectly = /[/\\]server\.(ts|js)$/.test(entry)

if (invokedDirectly) {
  main().catch((err) => {
    console.error('[server] 启动失败：', err)
    process.exit(1)
  })
}
