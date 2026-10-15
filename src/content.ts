/**
 * 内容层：把 content/ 下的 Markdown 读成文章对象。
 * 设计取舍：进程内做缓存 + 按 mtime 失效。文章数量在个人站这个量级（几百篇以内），
 * 全量重解析的成本远低于维护一套索引文件的成本。
 */
import fs from 'node:fs'
import path from 'node:path'
import matter from 'gray-matter'
import MarkdownIt from 'markdown-it'
import { config } from './config.js'

export interface PostMeta {
  slug: string
  title: string
  date: string
  summary: string
  tags: string[]
  draft: boolean
}

export interface Post extends PostMeta {
  html: string
  readingMinutes: number
}

const md = new MarkdownIt({
  html: false, // 内容是自己写的，但关掉内联 HTML 可以少一个 XSS 面
  linkify: true,
  typographer: true,
})

interface CacheEntry {
  mtimeMs: number
  post: Post
}

const cache = new Map<string, CacheEntry>()

/** 从文件名得到 slug：允许 content/2026-01-01-hello.md 这种带日期的写法。 */
function slugFromFile(file: string): string {
  return path
    .basename(file, path.extname(file))
    .replace(/^\d{4}-\d{2}-\d{2}[-_]/, '')
}

function toIsoDate(value: unknown, fallbackMs: number): string {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString().slice(0, 10)
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = new Date(value.trim())
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString().slice(0, 10)
  }
  return new Date(fallbackMs).toISOString().slice(0, 10)
}

function toTags(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((v) => String(v).trim()).filter(Boolean)
  }
  if (typeof value === 'string') {
    return value.split(/[,，]/).map((v) => v.trim()).filter(Boolean)
  }
  return []
}

/** 没写 summary 时从正文里摘一句，避免列表页出现空描述。 */
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

function parseFile(file: string): Post {
  const stat = fs.statSync(file)
  const raw = fs.readFileSync(file, 'utf8')
  const parsed = matter(raw)
  const data = parsed.data as Record<string, unknown>

  const slug = typeof data.slug === 'string' && data.slug.trim() ? data.slug.trim() : slugFromFile(file)
  const body = parsed.content.trim()
  const words = body.replace(/\s+/g, '').length

  return {
    slug,
    title:
      typeof data.title === 'string' && data.title.trim()
        ? data.title.trim()
        : slug.replace(/[-_]/g, ' '),
    date: toIsoDate(data.date, stat.mtimeMs),
    summary:
      typeof data.summary === 'string' && data.summary.trim() ? data.summary.trim() : deriveSummary(body),
    tags: toTags(data.tags),
    draft: data.draft === true,
    html: md.render(body),
    readingMinutes: Math.max(1, Math.round(words / 400)),
  }
}

/** 列出全部已发布文章，按日期倒序。draft: true 的不出现在列表里。 */
export function listPosts(): Post[] {
  if (!fs.existsSync(config.contentDir)) return []
  const files = fs
    .readdirSync(config.contentDir)
    .filter((f) => /\.(md|markdown)$/i.test(f))
    .map((f) => path.join(config.contentDir, f))

  const posts: Post[] = []
  for (const file of files) {
    try {
      const stat = fs.statSync(file)
      const cached = cache.get(file)
      if (cached && cached.mtimeMs === stat.mtimeMs) {
        posts.push(cached.post)
        continue
      }
      const post = parseFile(file)
      cache.set(file, { mtimeMs: stat.mtimeMs, post })
      posts.push(post)
    } catch (err) {
      // 一篇坏文章不该让整站 500：跳过并留下日志。
      console.error(`[content] 跳过无法解析的文章 ${file}：`, (err as Error).message)
    }
  }

  return posts.filter((p) => !p.draft).sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
}

export function getPost(slug: string): Post | undefined {
  return listPosts().find((p) => p.slug === slug)
}

/** 全部标签及文章数，按出现次数倒序。 */
export function listTags(): Array<{ tag: string; count: number }> {
  const counts = new Map<string, number>()
  for (const post of listPosts()) {
    for (const tag of post.tags) {
      counts.set(tag, (counts.get(tag) ?? 0) + 1)
    }
  }
  return [...counts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag))
}
