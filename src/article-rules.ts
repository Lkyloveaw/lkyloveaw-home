/**
 * 文章的**对象规则**：一篇「合法的文章」该长什么样 —— slug 的形状与唯一性、标签名、正文上限。
 *
 * 为什么单独一个文件：这些规则不属于「页面」，也不属于「SQL」，而属于文章这个概念本身。
 * `docs/article-write-api-decision.md` §8 把边界划过：**机制归 #25（鉴权面 / CSRF / 失败呈现），
 * 对象规则归文章模块**。放这里还有一个实际好处：它们是**纯函数 + 一个查询**，
 * 不需要管理台外壳、不需要 JS，所以能在写路径（#50）之前就写完并验完。
 *
 * ⚠ **唯一性不能靠主键报错。** 写路径用的是 upsert（`upsertArticleWithRevision()`），
 * 主键冲突会**静默覆盖**那一篇 —— 而规格 #48 明确要求「撞名 → 400，且原文章仍在列表（没被静默覆盖）」。
 * 所以调用方**必须先问 `checkSlugAvailable()`**，冲突就 400，而不是把脏活留给主键。
 */
import { getAnyArticleRow } from './store.js'

/** 规格 #48：slug 长度 ≤ 64。 */
export const SLUG_MAX_LENGTH = 64
/** 标签名同样进 URL，长度上限与 slug 取齐（不是为了严格，是为了别让一行标签把页面撑爆）。 */
export const TAG_MAX_LENGTH = 64
/** 规格 §5.3 的【默认】正文上限：256 KiB。按 **UTF-8 字节**算，不是字符数。 */
export const BODY_MAX_BYTES = 256 * 1024
export const TITLE_MAX_LENGTH = 200

/**
 * 合法 slug：**中文 + `[A-Za-z0-9_-]`**（规格 #48）。
 * 用 `\p{Script=Han}` 而不是 `\u4e00-\u9fff`：后者漏掉扩展区的汉字，会把合法的中文 slug 判成非法。
 */
const SLUG_ALLOWED = /^[\p{Script=Han}A-Za-z0-9_-]+$/u

export type CheckResult = { ok: true } | { ok: false; reason: string }

/** slug 的形状规则。**不做大小写折叠**（规格明确），也**不动**已发布文章的 slug（那由调用方守）。 */
export function validateSlug(raw: unknown): CheckResult {
  if (typeof raw !== 'string') return { ok: false, reason: 'slug 必须是字符串' }
  const slug = raw.trim()
  if (!slug) return { ok: false, reason: 'slug 不能为空' }
  // 按**码位**数长度，不是 UTF-16 单元数 —— 否则一个中文字符会被算成两个。
  if ([...slug].length > SLUG_MAX_LENGTH) {
    return { ok: false, reason: `slug 太长：最多 ${SLUG_MAX_LENGTH} 个字符` }
  }
  if (!SLUG_ALLOWED.test(slug)) {
    return { ok: false, reason: 'slug 只能用中文、字母、数字、连字符（-）与下划线（_）' }
  }
  return { ok: true }
}

export type SlugAvailability =
  | { available: true }
  | { available: false; title: string; inTrash: boolean }

/**
 * 唯一性**跨所有文章**：草稿、已发布、**回收站里的也算占位**（规格 #48）。
 *
 * 回收站里的也占位，这一点与 WordPress 一致（它的唯一性检查也不看状态），
 * 而还原之所以不需要旁路，是因为 `deleted_at` **正交于** `draft`、不覆盖它。
 */
export function checkSlugAvailable(rawSlug: string): SlugAvailability {
  const row = getAnyArticleRow(rawSlug.trim())
  if (!row) return { available: true }
  return { available: false, title: row.title, inTrash: row.deletedAt !== null }
}

/**
 * 冲突时的 400 文案。规格要求两件事：**给出占用者的标题**，
 * 且占用者**在回收站里时要明说**（否则用户会以为 slug 被谁抢了，实际只是自己删过的那篇还占着）。
 */
export function slugConflictMessage(slug: string, occupied: { title: string; inTrash: boolean }): string {
  const where = occupied.inTrash ? '它现在在**回收站**里 —— 先还原它，或者换一个 slug' : '换一个 slug 吧'
  return `slug「${slug}」已经被《${occupied.title}》占用了。${where}`
}

/**
 * 归一化标签：去首尾空白、去空项、去重（保序），并把**不合法的挑出来**给调用方。
 *
 * 为什么必须校验名字：标签名**直接进 `/tags/<tag>`**。WordPress / Ghost 之所以要一套独立的
 * tag slug，就是为了绕开这件事；我们选了不做第二套 slug（规格 #48），代价就是校验名字。
 * 最要紧的一条是**禁 `/`** —— 它会把 URL 打断成两段。
 */
export function normalizeTags(raw: unknown): { tags: string[]; rejected: string[] } {
  const list: unknown[] = Array.isArray(raw)
    ? raw
    : typeof raw === 'string'
      ? raw.split(/[,，]/)
      : []

  const tags: string[] = []
  const rejected: string[] = []
  for (const item of list) {
    const tag = String(item ?? '').trim()
    if (!tag) continue
    const bad =
      tag.includes('/') ||
      [...tag].length > TAG_MAX_LENGTH ||
      /[\u0000-\u001f\u007f]/.test(tag) ||
      tag === '.' ||
      tag === '..'
    if (bad) {
      rejected.push(tag)
      continue
    }
    if (!tags.includes(tag)) tags.push(tag)
  }
  return { tags, rejected }
}

/** 正文字节数（上限按字节算，因为落库与传输都是字节）。 */
export function bodySizeBytes(body: string): number {
  return Buffer.byteLength(body, 'utf8')
}

export function validateBodySize(body: string): CheckResult {
  const size = bodySizeBytes(body)
  if (size > BODY_MAX_BYTES) {
    const kb = (n: number): string => `${Math.round(n / 1024)} KiB`
    return { ok: false, reason: `正文太长：${kb(size)}，上限 ${kb(BODY_MAX_BYTES)}` }
  }
  return { ok: true }
}

export function validateTitle(raw: unknown): CheckResult {
  if (typeof raw !== 'string' || !raw.trim()) return { ok: false, reason: '标题不能为空' }
  if ([...raw.trim()].length > TITLE_MAX_LENGTH) {
    return { ok: false, reason: `标题太长：最多 ${TITLE_MAX_LENGTH} 个字符` }
  }
  return { ok: true }
}

/**
 * 发布后不可改 slug（规格 #48）。
 * 返回 `true` = 这次改动**违反**了规则，调用方该拒绝。
 */
export function violatesSlugImmutability(
  existing: { slug: string; draft: number } | undefined,
  nextSlug: string,
): boolean {
  if (!existing) return false
  if (existing.draft === 1) return false // 草稿随便改
  return existing.slug !== nextSlug.trim()
}
