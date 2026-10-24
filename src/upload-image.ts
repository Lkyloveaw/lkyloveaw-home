/** multipart 图片读取适配器；权限、业务引用和回跳由调用路由负责。 */
import { MediaInputError, saveMedia } from './media.js'

export function readFormField(body: unknown, name: string): string | undefined {
  if (!body || typeof body !== 'object') return undefined
  const raw = (body as Record<string, unknown>)[name]
  if (typeof raw === 'string') return raw
  if (raw && typeof raw === 'object' && typeof (raw as { value?: unknown }).value === 'string') {
    return (raw as { value: string }).value
  }
  return undefined
}

type UploadNotice = 'media-no-file' | 'media-too-big' | 'media-rejected' | 'image-save-failed'
export type ImageUploadResult =
  | { ok: true; name: string; created: boolean }
  | { ok: false; notice: UploadNotice }

export async function receiveImageUpload(body: unknown): Promise<ImageUploadResult> {
  const file = body && typeof body === 'object'
    ? (body as Record<string, unknown>).file as { toBuffer?: () => Promise<Buffer> } | undefined
    : undefined
  if (!file || typeof file.toBuffer !== 'function') return { ok: false, notice: 'media-no-file' }
  let bytes: Buffer
  try { bytes = await file.toBuffer() }
  catch { return { ok: false, notice: 'media-too-big' } }
  try {
    const saved = saveMedia(bytes)
    return { ok: true, name: saved.name, created: saved.created }
  } catch (error) {
    if (error instanceof MediaInputError) {
      return { ok: false, notice: error.kind === 'too-large' ? 'media-too-big' : 'media-rejected' }
    }
    console.warn('[media] 图片保存失败：' + (error as Error).message)
    return { ok: false, notice: 'image-save-failed' }
  }
}
