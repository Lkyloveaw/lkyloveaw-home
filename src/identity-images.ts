/** 账户头像与站点徽标的当前媒体引用；文件仍由 media.ts 管理。 */
import { initStore } from './store.js'
import { isSafeMediaName } from './media.js'

export type IdentityImageKey = 'site-logo' | `avatar:${number}`
let ready = false
function db() {
  const handle = initStore()
  if (!ready) {
    handle.exec(`CREATE TABLE IF NOT EXISTS identity_images (
      owner TEXT PRIMARY KEY,
      media_name TEXT NOT NULL
    )`)
    ready = true
  }
  return handle
}

export function getIdentityImage(owner: IdentityImageKey): string | null {
  const row = db().prepare('SELECT media_name FROM identity_images WHERE owner = ?').get(owner) as
    { media_name: string } | undefined
  return row && isSafeMediaName(row.media_name) ? row.media_name : null
}

export function setIdentityImage(owner: IdentityImageKey, name: string | null): void {
  if (!/^(site-logo|avatar:[1-9]\d*)$/.test(owner)) throw new Error('图片所属对象不合法')
  if (name !== null && !isSafeMediaName(name)) throw new Error('图片名称不合法')
  if (name === null) {
    db().prepare('DELETE FROM identity_images WHERE owner = ?').run(owner)
  } else {
    db().prepare(`INSERT INTO identity_images (owner, media_name) VALUES (?, ?)
      ON CONFLICT(owner) DO UPDATE SET media_name = excluded.media_name`).run(owner, name)
  }
}

/** 供媒体清理保留所有仍被使用的身份图片（含停用账号）。 */
export function identityImageReferences(): string[] {
  return (db().prepare('SELECT media_name FROM identity_images').all() as Array<{ media_name: string }>)
    .map((row) => row.media_name).filter(isSafeMediaName)
}
