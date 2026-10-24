/** 友联记录与输入校验；与站点其余数据共用 SQLite。 */
import { initStore } from './store.js'
import { isSafeMediaName } from './media.js'

export interface FriendLink {
  id: number
  name: string
  url: string
  description: string
  icon: string | null
  sortOrder: number
}

export interface FriendLinkInput {
  name: string
  url: string
  description?: string
  sortOrder?: string | number
}

let initialized: ReturnType<typeof initStore> | undefined
function db() {
  const handle = initStore()
  if (initialized !== handle) {
    handle.exec(`CREATE TABLE IF NOT EXISTS friend_links (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      url TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      icon TEXT,
      sort_order INTEGER NOT NULL
    )`)
    initialized = handle
  }
  return handle
}

export function isFriendLinkUrl(value: string): boolean {
  if (value.length > 2048 || /[\u0000-\u0020\u007f]/.test(value)) return false
  try {
    const url = new URL(value)
    return /^https?:\/\//i.test(value) && ['http:', 'https:'].includes(url.protocol) &&
      Boolean(url.hostname) && !url.username && !url.password
  } catch { return false }
}

export function listFriendLinks(): FriendLink[] {
  return db().prepare('SELECT id, name, url, description, icon, sort_order AS sortOrder FROM friend_links ORDER BY sort_order, id')
    .all() as FriendLink[]
}

export function saveFriendLink(input: FriendLinkInput, id?: number): FriendLink {
  const name = input.name.trim()
  const url = input.url.trim()
  const description = (input.description ?? '').trim()
  if (!name || [...name].length > 60) throw new Error('网站名称须为 1–60 字。')
  if (!isFriendLinkUrl(url)) throw new Error('网址须为有效的 HTTP/HTTPS 地址，最长 2048 字符，且不能包含登录凭据。')
  if ([...description].length > 200) throw new Error('简介最多 200 字。')
  const handle = db()
  const rawOrder = input.sortOrder === undefined || input.sortOrder === ''
    ? (handle.prepare('SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM friend_links').get() as { n: number }).n
    : input.sortOrder
  const sortOrder = Number(rawOrder)
  if (!/^\d+$/.test(String(rawOrder)) || !Number.isSafeInteger(sortOrder) || sortOrder < 0 || sortOrder > 2147483647) {
    throw new Error('顺序须为 0–2147483647 的整数，数字越小越靠前。')
  }
  if (id !== undefined) {
    const updated = handle.prepare('UPDATE friend_links SET name = ?, url = ?, description = ?, sort_order = ? WHERE id = ?')
      .run(name, url, description, sortOrder, id)
    if (!updated.changes) throw new Error('找不到这条友联，请刷新页面。')
  } else {
    id = Number(handle.prepare('INSERT INTO friend_links (name, url, description, sort_order) VALUES (?, ?, ?, ?)')
      .run(name, url, description, sortOrder).lastInsertRowid)
  }
  return handle.prepare('SELECT id, name, url, description, icon, sort_order AS sortOrder FROM friend_links WHERE id = ?')
    .get(id) as FriendLink
}

export function deleteFriendLink(id: number): boolean {
  return db().prepare('DELETE FROM friend_links WHERE id = ?').run(id).changes > 0
}

export function setFriendLinkIcon(id: number, name: string | null): void {
  if (name !== null && !isSafeMediaName(name)) throw new Error('图片名称不合法。')
  if (!db().prepare('UPDATE friend_links SET icon = ? WHERE id = ?').run(name, id).changes) {
    throw new Error('找不到这条友联，请刷新页面。')
  }
}

export function friendLinkImageReferences(): string[] {
  return listFriendLinks().map(link => link.icon).filter((name): name is string => name !== null && isSafeMediaName(name))
}
