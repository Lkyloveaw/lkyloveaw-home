/**
 * 媒体层：原图的**落盘与寻址**（规格 [#41](https://github.com/Lkyloveaw/lkyloveaw-home/issues/41)）。
 *
 * 本模块**不碰 HTTP** —— multipart 解析在上传适配器里（`server.ts`），本模块只管
 * 「字节 → 文件」与「文件名 → 路径」这两件事。所以它可以**不过 HTTP 直接被断言**。
 *
 * 三条硬规矩，都来自规格：
 * 1. **按内容哈希寻址**（`<sha256>.<ext>`）：同一张图重复上传得到同一个 URL，天然幂等；
 *    改过的图自然得到新 URL（浏览器缓存不会继续显示旧图）。
 * 2. **类型按魔数判定，不看上传者给的文件名** —— 「HTML 改名成 .png」必须被拒（user story 10）。
 *    **SVG 一律拒绝**（它能带脚本，等于把可执行内容传进站内）。
 * 3. **原子落盘**：先写临时文件再 `rename` —— 要么完整落盘，要么什么都没留下（user story 11/25）。
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { config } from './config.js'

/** 单张上限 8 MiB（规格定的）。**上传适配器也要设一层**，这里是第二道。 */
export const MEDIA_MAX_BYTES = 8 * 1024 * 1024

export type MediaInputErrorKind = 'empty' | 'too-large' | 'unsupported'
/** 输入拒绝与文件系统故障分开，上传适配器不依赖错误文案。 */
export class MediaInputError extends Error {
  constructor(readonly kind: MediaInputErrorKind, message: string) {
    super(message)
    this.name = 'MediaInputError'
  }
}

/**
 * 允许的图片类型。**只看魔数**，`ext` 由我们自己定 —— 上传者给的文件名一律不参与。
 *
 * 为什么不收 SVG：它是 XML，能带 `<script>`。收进来就等于在站内放了一个可执行文件
 * （规格把它列为明确拒绝项）。别的类型（bmp/tiff/avif）不收是因为「格式可预期」比「尽量都收」值钱。
 */
const MAGIC: Array<{ ext: string; mime: string; test: (b: Buffer) => boolean }> = [
  {
    ext: 'png',
    mime: 'image/png',
    test: (b) =>
      b.length >= 8 &&
      b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  },
  {
    ext: 'jpg',
    mime: 'image/jpeg',
    // JPEG 的魔数是 SOI + 第一个段标记（`FF D8 FF`）。
    test: (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  },
  {
    ext: 'gif',
    mime: 'image/gif',
    test: (b) => b.length >= 6 && ['GIF87a', 'GIF89a'].includes(b.subarray(0, 6).toString('latin1')),
  },
  {
    ext: 'webp',
    mime: 'image/webp',
    // RIFF 容器 + `WEBP` 四字节标识。
    test: (b) =>
      b.length >= 12 &&
      b.subarray(0, 4).toString('latin1') === 'RIFF' &&
      b.subarray(8, 12).toString('latin1') === 'WEBP',
  },
]

/** 认出这是哪种图。认不出（含 SVG、HTML、截断的文件）→ `null`，调用方据此拒绝。 */
export function sniffImage(buf: Buffer): { ext: string; mime: string } | null {
  for (const m of MAGIC) {
    if (m.test(buf)) return { ext: m.ext, mime: m.mime }
  }
  return null
}

/** 内容哈希 → 文件名。**小写十六进制**（大小写混用会让同一张图产生两个 URL）。 */
export function mediaName(hash: string, ext: string): string {
  return `${hash}.${ext}`
}

/**
 * 文件名是否是我们自己生成的那种形状（`<64 位十六进制>.<png|jpg|gif|webp>`）。
 *
 * ⚠ 这是**服务路由的第一道闸**：拒绝 `../`、拒绝编码斜杠、拒绝任何别的扩展名。
 * 只靠 `path.join` 是不够的 —— 它会把 `..` 老老实实拼上去。
 */
export function isSafeMediaName(name: unknown): boolean {
  return typeof name === 'string' && /^[0-9a-f]{64}\.(png|jpg|gif|webp)$/.test(name)
}

/** 文件名 → 绝对路径。**先过 `isSafeMediaName`**，不合法直接抛（调用方应在此之前就拒掉）。 */
export function mediaPath(name: string): string {
  if (!isSafeMediaName(name)) throw new Error(`不是合法的媒体文件名：${name}`)
  return path.join(config.mediaDir, name)
}

/** 目录里现有的媒体文件名（升序）。目录不存在时返回空数组 —— 「还没有图」不是错误。 */
export function listMedia(): string[] {
  if (!fs.existsSync(config.mediaDir)) return []
  return fs
    .readdirSync(config.mediaDir)
    .filter((f) => isSafeMediaName(f))
    .sort()
}

/**
 * 落盘一张图。**返回文件名与内容哈希**，以及这次是不是真的新建了文件。
 *
 * - 大小与类型在这里**再判一次**（上传适配器已经判过，但这一层是纯函数式的最后一道）。
 * - 已经存在同名文件 → 直接返回 `created: false`（重复上传幂等，规格 user story 5）。
 * - 落盘是**原子的**：写 `<name>.tmp-<随机>` 再 `rename`。
 */
export function saveMedia(buf: Buffer): { name: string; hash: string; ext: string; mime: string; created: boolean } {
  if (buf.length === 0) throw new MediaInputError('empty', '空文件')
  if (buf.length > MEDIA_MAX_BYTES) throw new MediaInputError('too-large', `超过 ${Math.round(MEDIA_MAX_BYTES / 1024 / 1024)} MiB`)
  const kind = sniffImage(buf)
  if (!kind) throw new MediaInputError('unsupported', '不是支持的图片类型（只收 png / jpeg / webp / gif；SVG 一律拒绝）')

  const hash = crypto.createHash('sha256').update(buf).digest('hex')
  const name = mediaName(hash, kind.ext)
  const target = path.join(config.mediaDir, name)

  if (fs.existsSync(target)) {
    return { name, hash, ext: kind.ext, mime: kind.mime, created: false }
  }

  fs.mkdirSync(config.mediaDir, { recursive: true })
  const tmp = path.join(config.mediaDir, `.tmp-${crypto.randomBytes(8).toString('hex')}`)
  try {
    fs.writeFileSync(tmp, buf)
    // 同一目录内的 rename 是原子的：读者要么看到旧状态，要么看到完整的新文件。
    fs.renameSync(tmp, target)
  } catch (err) {
    // 失败要**不留痕**：临时文件必须清掉，否则它会变成一个永远没人认领的孤儿。
    try {
      fs.rmSync(tmp, { force: true })
    } catch {
      /* 清理失败不再掩盖原始错误 */
    }
    throw err
  }
  return { name, hash, ext: kind.ext, mime: kind.mime, created: true }
}

/** 文件名 → 内容类型（服务路由要拿它做 `Content-Type`）。不合法返回 `null`。 */
export function mediaMime(name: string): string | null {
  if (!isSafeMediaName(name)) return null
  const ext = name.slice(name.lastIndexOf('.') + 1)
  return MAGIC.find((m) => m.ext === ext)?.mime ?? null
}

/** 可直接粘贴进正文的 Markdown 片段（规格 user story 2）。 */
export function mediaSnippet(name: string, alt: string): string {
  return `![${alt}](/media/${name})`
}
/**
 * 一份文档 JSON 里引用的媒体文件名（规格 #41 的「引用」定义：**当前正文 + 历史修订**都算）。
 *
 * 只认 `isSafeMediaName` 过得去的名字 —— 形状不合法的引用**不算引用**，
 * 因为媒体目录里根本不可能存在那种文件（`listMedia()` 也只列合法名）。
 */
export function imageNamesInDoc(doc: unknown): string[] {
  const out = new Set<string>()
  const walk = (n: unknown): void => {
    if (!n || typeof n !== 'object') return
    const node = n as { type?: string; attrs?: Record<string, unknown>; content?: unknown[] }
    if (node.type === 'image') {
      const src = typeof node.attrs?.src === 'string' ? node.attrs.src : ''
      const m = src.match(/^\/media\/([^/?#]+)/)
      const name = m?.[1]
      if (name && isSafeMediaName(name)) out.add(name)
    }
    if (Array.isArray(node.content)) for (const c of node.content) walk(c)
  }
  walk(doc)
  return [...out]
}

/**
 * 孤图 = 媒体目录里有、但没有文章、修订、头像、网站徽标或友联图标引用的文件。
 *
 * ⚠ 调用方必须**先成功读到全部引用**再调这里。规格 user story 50 说得很明白：
 * 「**「读取失败」和「真的没有文章」必须被区分开**，以便清空全部图片这种灾难不会因为一次读库失败发生」——
 * 所以「读到 0 条引用」和「读失败了」在 CLI 里走**两条完全不同的路**。
 */
export function orphanMedia(referenced: Iterable<string>): string[] {
  const ref = new Set(referenced)
  return listMedia().filter((n) => !ref.has(n))
}
