/**
 * 内容层：文章的**读面出口**与**导入路径**。
 *
 * 真源是 SQLite 的 `articles` 表（票 #32 定下的）。`content/*.md` 只在**首次导入**时读一次
 * ——此后改文件对站点**没有任何影响**（启动时只打一行警告）。这不是「暂时」的状态：
 * 编辑入口归网页（#50），在它落地之前，改文章靠 `src/cli/articles.js --reimport` 这个**逃生口**。
 *
 * 本文件里有两类东西，别混：
 *
 * - **读面出口**（`listPublishedPosts` / `getPublishedPost`）：**读者视角**，滤草稿 + 滤已删除，
 *   **零布尔参数**。`listTags()` 只是它的派生视图，不是第 6 个出口。
 *   **零布尔参数**（见 `src/store.ts` 里 `listArticlesForReaders()` 的注释）。
 * - **导入路径**（`importArticlesIfEmpty` / `reimportArticlesFromDisk`）：写库，只有启动与 CLI 调它。
 *
 * 渲染**不在这里**：文档 → HTML 是 `src/article-html.ts` 的闭集发射器。
 * 本文件只做「取行 → 校验文档 → 渲染 → 组装 Post」这层编排，以及导入时的 front-matter 规则。
 */
import fs from 'node:fs'
import path from 'node:path'
import matter from 'gray-matter'
import type { Node as PMNode } from 'prosemirror-model'
import { config } from './config.js'
import { docFromJson, docToJson } from './article-doc.js'
import { docToHtml } from './article-html.js'
import { markdownToDoc } from './article-import.js'
import {
  getArticleForReaders,
  hasAnyArticle,
  listArticlesForReaders,
  upsertArticleWithRevision,
  type ArticleRow,
} from './store.js'

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

// ── 组装 ──────────────────────────────────────────────────────

/** 文档里的纯文本（块之间补空格，否则相邻段落会粘成一个词）。 */
function plainText(node: PMNode): string {
  let out = ''
  node.forEach((child) => {
    if (child.isText) {
      out += child.text ?? ''
      return
    }
    if (child.type.name === 'hardBreak') {
      out += ' '
      return
    }
    const inner = plainText(child)
    out += child.isBlock ? ` ${inner} ` : inner
  })
  return out
}

/** 没写 summary 时从正文里摘一句。入参已经是纯文本，所以不必再去标记。 */
function deriveSummary(plain: string): string {
  const text = plain.replace(/\s+/g, ' ').trim()
  return text.length > 120 ? `${text.slice(0, 120)}…` : text
}

function parseTags(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (Array.isArray(parsed)) return parsed.map((t) => String(t)).filter(Boolean)
  } catch {
    /* 落到下面：当成空标签，并已经在下面登记过日志 */
  }
  return []
}

/**
 * 一行 → 一篇可渲染的文章。
 * 坏内容在这里被**接住**：跳过该篇并留下日志，而不是让它冒到 HTTP 层变成 500
 * （沿用旧 `content.ts` 对「一篇坏文章不该让整站 500」的取舍；「显眼」由这行 `console.error` 负责）。
 */
function toPost(row: ArticleRow): Post | null {
  try {
    const doc = docFromJson(JSON.parse(row.body))
    const plain = plainText(doc)
    const summary = row.summary?.trim() ? row.summary.trim() : deriveSummary(plain)
    const dense = plain.replace(/\s+/g, '').length
    return {
      slug: row.slug,
      title: row.title,
      date: row.date,
      summary,
      tags: parseTags(row.tags),
      draft: row.draft === 1,
      html: docToHtml(doc),
      readingMinutes: Math.max(1, Math.round(dense / 400)),
    }
  } catch (err) {
    console.error(`[content] 跳过无法渲染的文章 ${row.slug}：${(err as Error).message}`)
    return null
  }
}

// ── 读面出口（读者视角；滤草稿 + 滤已删除）──────────────────────

/**
 * **读面出口 1**：读者能看到的文章，按日期倒序。
 *
 * ⚠ 名字里的「Published」是**纪律的一部分**，不是啰嗦：过滤维度有两个（草稿 / 已删除），
 * 布尔参数会有四种组合、漏传一个就是泄漏。所以出口按**读者**命名 ——
 * 「名字本身在说我是给谁看的，diff 时能一眼审出泄漏」（规格 #48 的出口表）。
 * 管理台的出口叫 `listArticlesForAdmin()`，回收站的那个叫 `listTrashedArticles()`（都还没实现，归 #50/#51）。
 */
export function listPublishedPosts(): Post[] {
  const posts: Post[] = []
  for (const row of listArticlesForReaders()) {
    const post = toPost(row)
    if (post) posts.push(post)
  }
  return posts
}

/** **读面出口 2**：按 slug 取一篇读者能看到的。找不到 / 是草稿 / 在回收站 → `undefined`（→ 404）。 */
export function getPublishedPost(slug: string): Post | undefined {
  const row = getArticleForReaders(slug)
  if (!row) return undefined
  return toPost(row) ?? undefined
}

/**
 * 全部标签及文章数，按出现次数倒序。
 *
 * **它不是第 6 个出口**：它只从**出口 1** 派生，自己没有取数语句 —— 所以草稿漏不进标签页，
 * 而「泄漏面只有那 5 个具名出口」这句话依然成立（规格 #48）。
 */
export function listTags(): Array<{ tag: string; count: number }> {
  const counts = new Map<string, number>()
  for (const post of listPublishedPosts()) {
    for (const tag of post.tags) {
      counts.set(tag, (counts.get(tag) ?? 0) + 1)
    }
  }
  return [...counts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag))
}

// ── 导入路径 ──────────────────────────────────────────────────

export interface ImportSummary {
  inserted: number
  updated: number
  unchanged: number
  /** slug 与本次已导入的重复，被跳过（先到者胜）。 */
  skipped: number
  /** **解析失败**的文件数。它与 `skipped` 分开：CLI 靠它决定退出码，别把「重名跳过」也算成失败。 */
  failed: number
  /** 值得说出来但不阻断导入的事（认不出的构造、不安全地址、重复 slug……）。 */
  warnings: string[]
}

/** 从文件名得到 slug：允许 `content/2026-01-01-hello.md` 这种带日期的写法。 */
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

/**
 * 读 `content/` 下的 Markdown 并写库。
 *
 * **`date` 的回落**：这里保留「解析失败 → 文件 mtime」，这是**导入路径的显式例外** ——
 * 网页新建的文章没有文件、没有 mtime，那边回落的是创建时间（#32 的日期决定）。
 * 两边的回落值不同，是因为两边的输入本来就不同，不是为了省事。
 */
function importFromDisk(): ImportSummary {
  const summary: ImportSummary = {
    inserted: 0,
    updated: 0,
    unchanged: 0,
    skipped: 0,
    failed: 0,
    warnings: [],
  }

  if (!fs.existsSync(config.contentDir)) {
    summary.warnings.push(`内容目录不存在，没有可导入的文件：${config.contentDir}`)
    return summary
  }

  const files = fs
    .readdirSync(config.contentDir)
    .filter((f) => /\.(md|markdown)$/i.test(f))
    .sort()

  /** 同一次导入里 slug 撞车时**保留第一个**（与旧的 `getPost()` 用 `find()` 的语义一致），并把这件事说出来。 */
  const seen = new Map<string, string>()

  for (const file of files) {
    const full = path.join(config.contentDir, file)
    try {
      const stat = fs.statSync(full)
      const parsed = matter(fs.readFileSync(full, 'utf8'))
      const data = parsed.data as Record<string, unknown>

      const slug = typeof data.slug === 'string' && data.slug.trim() ? data.slug.trim() : slugFromFile(full)

      const previous = seen.get(slug)
      if (previous) {
        summary.skipped += 1
        summary.warnings.push(`slug「${slug}」在 ${previous} 已经用过，${file} 被跳过（先到者胜）`)
        continue
      }
      seen.set(slug, file)

      const body = parsed.content.trim()
      const { doc, warnings } = markdownToDoc(body)
      for (const w of warnings) summary.warnings.push(`${file}：${w}`)

      const result = upsertArticleWithRevision({
        slug,
        title:
          typeof data.title === 'string' && data.title.trim()
            ? data.title.trim()
            : slug.replace(/[-_]/g, ' '),
        body: JSON.stringify(docToJson(doc)),
        summary:
          typeof data.summary === 'string' && data.summary.trim() ? data.summary.trim() : null,
        date: toIsoDate(data.date, stat.mtimeMs),
        tags: JSON.stringify(toTags(data.tags)),
        draft: data.draft === true ? 1 : 0,
        now: Date.now(),
      })
      if (result === 'inserted') summary.inserted += 1
      else if (result === 'updated') summary.updated += 1
      else summary.unchanged += 1
    } catch (err) {
      // 一个坏文件不该让整段导入停摆 —— 但必须**留下名字**，不许静默。
      summary.failed += 1
      summary.warnings.push(`${file} 解析失败，已跳过：${(err as Error).message}`)
    }
  }

  return summary
}

function reportSummary(summary: ImportSummary): void {
  console.log(
    `[content] 导入完成：新增 ${summary.inserted} · 更新 ${summary.updated} · 未变 ${summary.unchanged} · 重名跳过 ${summary.skipped} · 解析失败 ${summary.failed}`,
  )
  for (const w of summary.warnings) console.warn(`[content] 注意：${w}`)
}

/**
 * **首次导入**：库里一篇文章都没有时才从 `content/*.md` 读（与 `targets.json`、`.env` 同一条规则）。
 * 返回 `null` = 库非空，什么都没做。
 */
export function importArticlesIfEmpty(): ImportSummary | null {
  if (hasAnyArticle()) return null
  const summary = importFromDisk()
  reportSummary(summary)
  return summary
}

/**
 * **逃生口**：忽略「库为空」这个前提，按文件重导。
 *
 * 它是 #50 落地之前**唯一的编辑通道**：改 `content/*.md` → 跑 `node dist/cli/articles.js --reimport`。
 * 只 upsert，**不删**库里多出来的行（删是回收站的语义，归 #51）；
 * 没改动的文章不会写库、也不会堆一条重复修订（见 `upsertArticleWithRevision`）。
 */
export function reimportArticlesFromDisk(): ImportSummary {
  const summary = importFromDisk()
  reportSummary(summary)
  return summary
}

/** 启动时的那行警告：文件不再是输入了。只在真的存在文件时打，免得凭空吓人。 */
export function warnContentDirIsNoLongerInput(): void {
  try {
    if (!fs.existsSync(config.contentDir)) return
    const files = fs.readdirSync(config.contentDir).filter((f) => /\.(md|markdown)$/i.test(f))
    if (!files.length) return
    console.warn(
      `[content] ${config.contentDir} 下的 ${files.length} 个文件不再是输入（真源已搬到 SQLite）；` +
        `要按文件重导请跑 node dist/cli/articles.js --reimport`,
    )
  } catch {
    /* 这里只是提醒，读不到目录不值得让启动失败 */
  }
}

/** 给 CLI 的 `--list` 用：库里那一行的原始状态（**不过读者过滤**）。 */
