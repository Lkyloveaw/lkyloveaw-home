/**
 * 编辑器形态原型的入口（**抛弃式**）。
 *
 * 为什么是独立进程而不是挂进 `src/server.ts`：
 * 这条分支上**产品文件零改动** —— 不走闸门、不读数据库、不启动探测、不需要 `SESSION_SECRET`，
 * 于是「原型路由误合并进产品」这件事在结构上就不可能发生（不存在可合并的产品改动）。
 * 代价：它跑在另一个端口、没有登录闸门。原型要的是随手点开就比。
 *
 * 跑：`npm run prototype:editor`（等价于 tsx src/prototype/editor-prototype.ts）
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Fastify from 'fastify'
import fastifyStatic from '@fastify/static'
import matter from 'gray-matter'
import MarkdownIt from 'markdown-it'
import { config } from '../config.js'
import { layout } from '../views.js'
import {
  editorBody,
  isVariantKey,
  VARIANTS,
  VARIANT_ORDER,
  type FrontMatterView,
  type Landmark,
  type VariantKey,
} from './editor-variants.js'
import { compareToOriginal, htmlToMarkdown } from './html-to-markdown.js'
import { PROTOTYPE_CSS } from './prototype-css.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SAMPLE_FILE = path.join(HERE, 'editor-sample.md')
const ASSET_FILE = path.join(HERE, 'assets', 'sample-chart.svg')
const ROUTE = '/prototype/editor'

/**
 * 与 `src/content.ts:26-30` 逐项同参。
 * 这里刻意复制一份而不是 import：`content.ts` 没有导出它的实例，
 * 而「预览与产品文章页同参」正是这个原型要保证的事（预览不能比产品页更宽松）。
 */
const md = new MarkdownIt({ html: false, linkify: true, typographer: true })

/** front-matter 只认这 6 个键，未知键真的会被丢弃（`src/content.ts:85-102`）。 */
const KNOWN_KEYS = ['slug', 'title', 'date', 'summary', 'tags', 'draft'] as const

const site = { title: config.siteTitle, description: config.siteDescription }

function readSample(): string {
  try {
    return fs.readFileSync(SAMPLE_FILE, 'utf8')
  } catch (err) {
    throw new Error(`读不到样本文章 ${SAMPLE_FILE}：${(err as Error).message}`)
  }
}

function toTagsText(value: unknown): string {
  if (Array.isArray(value)) return value.map((v) => String(v)).join(' / ') || '无'
  if (typeof value === 'string' && value.trim()) return value
  return '无'
}

function deriveSummary(body: string): string {
  const plain = body
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[#>*_`~-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return plain.length > 120 ? `${plain.slice(0, 120)}…` : plain
}

interface RenderResult {
  html: string
  ms: number
  sourceBytes: number
  htmlBytes: number
  front: FrontMatterView
}

/**
 * 走真的 gray-matter + 真的 markdown-it。坏 front-matter **不炸**：
 * 渲染成一条错误横幅（`#31` 的契约第 7 条：坏内容不能让页面 500）。
 */
function renderSource(source: string): RenderResult {
  const t0 = performance.now()
  const sourceBytes = Buffer.byteLength(source, 'utf8')
  let body = ''
  let front: FrontMatterView = {
    title: '（无 front-matter）',
    date: '（缺省回落文件 mtime —— 网页里没有 mtime，这条得另定）',
    tags: '无',
    draft: '否',
    summary: '（由正文派生，截 120 字）',
    unknown: [],
    error: '',
  }

  try {
    const parsed = matter(source)
    const data = parsed.data as Record<string, unknown>
    body = parsed.content.trim()
    const slug = path
      .basename(SAMPLE_FILE, '.md')
      .replace(/^\d{4}-\d{2}-\d{2}[-_]/, '')
    const rawDraft = data.draft
    front = {
      title: typeof data.title === 'string' && data.title.trim() ? data.title.trim() : slug.replace(/[-_]/g, ' '),
      date: typeof data.date === 'string' && data.date.trim() ? data.date.trim() : '（缺省回落文件 mtime）',
      tags: toTagsText(data.tags),
      draft:
        rawDraft === true
          ? '是（真草稿：不出现在列表里，直链 404）'
          : rawDraft === undefined
            ? '否'
            : `否 —— 值是 ${JSON.stringify(rawDraft)}，不是布尔 true（字符串 "true" 不算草稿）`,
      summary:
        typeof data.summary === 'string' && data.summary.trim() ? data.summary.trim() : deriveSummary(body),
      unknown: Object.keys(data).filter((k) => !(KNOWN_KEYS as readonly string[]).includes(k)),
      error: '',
    }
  } catch (err) {
    front = { ...front, error: `front-matter 解析失败：${(err as Error).message}` }
    body = source
  }

  const html = md.render(body)
  const ms = Math.round((performance.now() - t0) * 100) / 100
  return { html, ms, sourceBytes, htmlBytes: Buffer.byteLength(html, 'utf8'), front }
}

/** 四个测试点跳转用的行号（在**当前样本**里现算，换样本也成立）。 */
function findLandmarks(source: string): Landmark[] {
  const lines = source.split(/\r?\n/)
  const find = (label: string, hint: string, test: (line: string) => boolean): Landmark | null => {
    const i = lines.findIndex(test)
    return i < 0 ? null : { label, hint, line: i + 1 }
  }
  const found = [
    find('表格', '看表格在编辑区与预览里的宽度是否够用', (l) => /^\|.*\|\s*$/.test(l)),
    find('代码块', '看代码块的语言标注与横向滚动', (l) => /^```/.test(l)),
    find('图片', '看图片引用在你手上的写法与预览里的样子', (l) => /^!\[/.test(l)),
    find('长段落', '中文长文：光标、滚动位置、段落感', (l) => /^## .*加料 ①/.test(l)),
  ]
  return found.filter((l): l is Landmark => l !== null)
}

const SAMPLE_LINE_TOKEN = '/prototype/assets/sample-chart.svg'

export async function buildPrototypeServer(): Promise<ReturnType<typeof Fastify>> {
  const app = Fastify({ logger: false })

  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string' },
    (_req, body: string, done) => {
      try {
        const out: Record<string, string> = {}
        for (const [k, v] of new URLSearchParams(body)) out[k] = v
        done(null, out)
      } catch (err) {
        done(err as Error, undefined)
      }
    },
  )

  // 只为了 /style.css：页头页脚必须是真的，原型才能贴在真实排版密度上。
  await app.register(fastifyStatic, { root: config.publicDir, prefix: '/' })

  const page = (variant: VariantKey, source: string, sourceFrom: 'sample' | 'carried' | 'posted'): string => {
    const rendered = renderSource(source)
    const sample = readSample()
    return layout(
      {
        title: `原型：编辑器形态 · ${variant}`,
        description: '抛弃式原型：三个编辑器形态变体',
        active: 'posts',
        bodyClass: 'pv-body',
        body: `<style>${PROTOTYPE_CSS}</style>${editorBody({
          variant,
          source,
          sourceFrom,
          preview: rendered,
          front: rendered.front,
          landmarks: findLandmarks(source),
          totalLines: source.split(/\r?\n/).length,
          variantUrl: (v) => `${ROUTE}?variant=${v}`,
          sampleFile: 'src/prototype/editor-sample.md',
          formAction: ROUTE,
        })}`,
      },
      site,
    )
  }

  app.get('/', async (_req, reply) => reply.redirect(ROUTE, 302))

  app.get(ROUTE, async (req, reply) => {
    const query = req.query as { variant?: string }
    const variant: VariantKey = isVariantKey(query.variant) ? query.variant : 'A'
    reply.type('text/html; charset=utf-8')
    return page(variant, readSample(), 'sample')
  })

  /** A 的服务端预览：整页往返，表单直接 POST 回同一路径（无 JS 也能用）。 */
  app.post(ROUTE, async (req, reply) => {
    const form = req.body as Record<string, string> | undefined
    const variant: VariantKey = isVariantKey(form?.variant) ? form.variant : 'A'
    const source = typeof form?.source === 'string' ? form.source : readSample()
    reply.type('text/html; charset=utf-8')
    return page(variant, source, 'posted')
  })

  /** B 的实时预览：返回 JSON，客户端回填右栏。渲染仍在服务端（没有第二个渲染器）。 */
  app.post(`${ROUTE}/preview`, async (req, reply) => {
    const form = req.body as Record<string, string> | undefined
    const source = typeof form?.source === 'string' ? form.source : readSample()
    const rendered = renderSource(source)
    return reply.send({
      html: rendered.html,
      ms: rendered.ms,
      htmlBytes: rendered.htmlBytes,
      sourceBytes: rendered.sourceBytes,
      front: rendered.front,
    })
  })

  /** C 的「存回 Markdown」：HTML → Markdown，并把「丢了什么」一起交出来。 */
  app.post(`${ROUTE}/md`, async (req, reply) => {
    const form = req.body as Record<string, string> | undefined
    const html = typeof form?.html === 'string' ? form.html : ''
    const t0 = performance.now()
    const conv = htmlToMarkdown(html)
    const ms = Math.round((performance.now() - t0) * 100) / 100
    return reply.send({
      markdown: conv.markdown,
      notes: conv.notes,
      losses: compareToOriginal(conv.markdown, readSample()),
      ms,
    })
  })

  app.get('/prototype/assets/sample-chart.svg', async (_req, reply) => {
    reply.type('image/svg+xml; charset=utf-8')
    return fs.readFileSync(ASSET_FILE, 'utf8')
  })

  app.setNotFoundHandler(async (_req, reply) => {
    reply.code(404).type('text/plain; charset=utf-8')
    return '原型只有 /prototype/editor 这一条路径（另加 /prototype/editor/preview、/prototype/editor/md、/prototype/assets/sample-chart.svg）。'
  })

  return app
}

async function main(): Promise<void> {
  const sample = readSample()
  if (!sample.includes(SAMPLE_LINE_TOKEN)) {
    console.warn(`[prototype] 样本里没有 ${SAMPLE_LINE_TOKEN}：图片那一格可能没有内容可看。`)
  }
  const app = await buildPrototypeServer()
  const port = Number(process.env.PROTOTYPE_PORT ?? 3100)
  const host = process.env.PROTOTYPE_HOST ?? '127.0.0.1'
  await app.listen({ port, host })

  console.log('')
  console.log('  编辑器形态原型（抛弃式）已启动')
  console.log(`    http://${host}:${port}${ROUTE}`)
  console.log('')
  for (const key of VARIANT_ORDER) {
    console.log(`    ?variant=${key}  ${VARIANTS[key].name}`)
  }
  console.log('')
  console.log('  底部切换条 ← → 也能切（键盘 ← → 需焦点不在输入框）')
  console.log('  样本文章   src/prototype/editor-sample.md（直接改它，刷新就换样本）')
  console.log('  这一进程不连数据库、不探测、无登录闸门 —— 它是原型，别拿它当产品。')
  console.log('')
}

const entry = process.argv[1] ? path.resolve(process.argv[1]) : ''
if (/[/\\]editor-prototype\.(ts|js)$/.test(entry)) {
  main().catch((err) => {
    console.error('[prototype] 启动失败：', err)
    process.exit(1)
  })
}
