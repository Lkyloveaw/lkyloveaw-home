// 临时库中的友联行为检查；设好环境后再加载任何应用模块。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'website-friends-'))
Object.assign(process.env, {
  DATABASE_PATH: path.join(sandbox, 'check.sqlite'), MEDIA_DIR: path.join(sandbox, 'media'),
  BACKUP_DIR: path.join(sandbox, 'backups'), TARGETS_JSON: '[]',
  SESSION_SECRET: 'friend-links-test-secret-only-32-characters', SITE_ORIGIN: 'http://localhost:3996',
  ADMIN_USERNAME: 'friends-admin', ADMIN_PASSWORD: 'friend-links-test-password', SESSION_COOKIE_SECURE: '0',
})

let store
let app
try {
  const links = await import('../dist/friend-links.js')
  store = await import('../dist/store.js')
  assert.deepEqual(links.listFriendLinks(), [])
  const first = links.saveFriendLink({ name: '朋友甲', url: 'https://example.com', description: '一个朋友的网站' })
  const second = links.saveFriendLink({ name: '朋友乙', url: 'http://example.org', description: '', sortOrder: '0' })
  assert.deepEqual(links.listFriendLinks().map(x => x.id), [second.id, first.id])
  links.saveFriendLink({ name: '朋友甲更新', url: 'https://example.com/new', description: '新简介', sortOrder: '0' }, first.id)
  assert.deepEqual(links.listFriendLinks().map(x => x.id), [first.id, second.id])
  for (const url of ['javascript:alert(1)', '//example.com', 'file:///tmp/x', 'https://', 'https://u:p@example.com']) {
    assert.throws(() => links.saveFriendLink({ name: '无效', url, description: '' }))
  }
  for (const fields of [{ name: '' }, { name: '字'.repeat(61) }, { description: '字'.repeat(201) }, { sortOrder: '1.5' }, { sortOrder: '-1' }, { sortOrder: 'NaN' }]) {
    assert.throws(() => links.saveFriendLink({ name: '朋友', url: 'https://example.net', description: '', ...fields }))
  }
  assert.throws(() => links.saveFriendLink({ name: '不存在', url: 'https://example.net' }, 99999))
  const icon = 'a'.repeat(64) + '.png'
  links.setFriendLinkIcon(first.id, icon)
  assert.deepEqual(links.friendLinkImageReferences(), [icon])
  assert.throws(() => links.setFriendLinkIcon(first.id, '../bad.png'))
  const persisted = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e',
    "const m = await import('./dist/friend-links.js'); console.log(JSON.stringify(m.listFriendLinks()))"], { encoding: 'utf8', env: process.env }))
  assert.equal(persisted[0].name, '朋友甲更新')
  assert.equal(persisted[0].icon, icon)
  links.setFriendLinkIcon(first.id, null)
  assert.deepEqual(links.friendLinkImageReferences(), [])
  assert.equal(links.deleteFriendLink(first.id), true)
  assert.equal(links.deleteFriendLink(first.id), false)
  links.deleteFriendLink(second.id)
  assert.deepEqual(links.listFriendLinks(), [])
  console.log('PASS 友联存储：校验、CRUD、排序、图标引用与跨进程持久化')

  app = await (await import('../dist/server.js')).buildServer()
  const users = await import('../dist/users.js')
  users.createUser('friends-reader', 'friend-links-test-password', { role: 'readonly' })
  const request = (url, cookie = '') => app.inject({ method: 'GET', url, headers: { cookie } })
  const post = (url, form, cookie = '', origin = process.env.SITE_ORIGIN) => app.inject({
    method: 'POST', url, headers: { cookie, origin, 'content-type': 'application/x-www-form-urlencoded' },
    payload: new URLSearchParams(form).toString(),
  })
  const login = async username => {
    const res = await post('/login', { username, password: 'friend-links-test-password' })
    assert.equal(res.statusCode, 302)
    const cookie = res.headers['set-cookie']
    return (Array.isArray(cookie) ? cookie[0] : cookie).split(';')[0]
  }
  const admin = await login('friends-admin')
  const reader = await login('friends-reader')
  const csrf = (await request('/admin/settings', admin)).body.match(/name="csrf" value="([^"]+)"/)[1]
  const endpoint = '/admin/settings/friends'
  const save = (fields = {}, cookie = admin) => post(endpoint, {
    action: 'save', name: 'HTTP朋友', url: 'https://example.com/friend', description: '网站简介', csrf, ...fields,
  }, cookie)
  assert.equal((await request('/', reader)).body.includes('class="friend-links"'), false)
  assert.equal((await save()).statusCode, 302)
  const created = links.listFriendLinks()[0]
  assert.equal(created.name, 'HTTP朋友')
  const contentPaths = ['/', '/posts', '/tags/运维', '/posts/why-single-process', '/status', '/about']
  for (const url of contentPaths) {
    const res = await request(url, reader)
    assert.equal(res.statusCode, 200, url)
    assert.equal((res.body.match(/class="friend-links"/g) ?? []).length, 1, url)
    assert.ok(res.body.indexOf('class="friend-links"') < res.body.indexOf('<footer'), url)
    assert.match(res.body, /href="https:\/\/example.com\/friend" target="_blank" rel="noopener noreferrer"/)
    assert.match(res.body, /class="friend-icon"[^>]*>H<\/span>/)
    assert.ok(res.body.includes('网站简介'))
  }
  for (const url of ['/admin', '/admin/settings', '/account', '/login', '/not-a-page']) {
    assert.equal((await request(url, admin)).body.includes('class="friend-links"'), false, url)
  }
  assert.equal((await request('/admin', reader)).statusCode, 403)
  assert.equal((await request('/admin', reader)).body.includes('class="friend-links"'), false)
  assert.equal((await save({}, reader)).statusCode, 403)
  assert.equal((await save({ csrf: '' })).statusCode, 403)
  assert.equal((await post(endpoint, { action: 'delete', id: created.id, csrf }, admin, 'https://evil.example')).statusCode, 403)
  assert.equal((await save({}, '')).statusCode, 302)
  assert.equal(links.listFriendLinks().length, 1)
  const rejected = await save({ name: '<坏名字>', url: 'javascript:alert(1)', description: '保留简介' })
  assert.equal(rejected.statusCode, 400)
  assert.match(rejected.body, /value="&lt;坏名字&gt;"/)
  assert.match(rejected.body, /value="保留简介"/)
  assert.equal(links.listFriendLinks().length, 1)
  for (const fields of [{ action: 'unknown' }, { id: '1oops' }, { id: '999999' }, { sortOrder: 'Infinity' }, { description: '字'.repeat(201) }]) {
    assert.equal((await save(fields)).statusCode, 400)
  }
  const missingEdit = await save({ id: '999999', name: '未保存的朋友', url: 'https://example.com/unsaved', description: '应保留的简介', sortOrder: '7' })
  assert.equal(missingEdit.statusCode, 400)
  for (const value of ['未保存的朋友', 'https://example.com/unsaved', '应保留的简介', '7']) {
    assert.ok(missingEdit.body.includes(`value="${value}"`), `丢失回填：${value}`)
  }
  assert.equal((await save({ id: created.id, name: '<朋友 & 好>', description: '<script>hello</script>' })).statusCode, 302)
  const escaped = (await request('/', reader)).body
  assert.ok(escaped.includes('&lt;朋友 &amp; 好&gt;'))
  assert.ok(escaped.includes('&lt;script&gt;hello&lt;/script&gt;'))
  assert.equal(escaped.includes('<script>hello</script>'), false)

  const upload = async (bytes, cookie = admin, token = csrf, id = created.id) => {
    const boundary = 'friend-links-check-boundary'
    const payload = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="csrf"\r\n\r\n${token}\r\n--${boundary}\r\nContent-Disposition: form-data; name="action"\r\n\r\nupload\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="icon.png"\r\nContent-Type: image/png\r\n\r\n`),
      bytes, Buffer.from(`\r\n--${boundary}--\r\n`),
    ])
    return app.inject({ method: 'POST', url: `${endpoint}/${id}/icon`,
      headers: { cookie, origin: process.env.SITE_ORIGIN, 'content-type': `multipart/form-data; boundary=${boundary}` }, payload })
  }
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64')
  assert.equal((await upload(png)).statusCode, 302)
  const uploaded = links.listFriendLinks()[0].icon
  assert.ok(uploaded)
  assert.ok((await request('/', reader)).body.includes(`/media/${uploaded}`))
  assert.equal((await request(`/media/${uploaded}`, reader)).statusCode, 200)
  assert.equal((await upload(Buffer.from('<svg/>'))).headers.location, '/admin/settings?notice=media-rejected#friend-links-admin')
  assert.equal(links.listFriendLinks()[0].icon, uploaded)
  assert.equal((await upload(png, reader)).statusCode, 403)
  assert.equal((await upload(png, admin, '')).statusCode, 403)
  assert.equal((await upload(png, admin, csrf, '999999')).statusCode, 404)
  assert.equal((await upload(Buffer.alloc(8 * 1024 * 1024 + 1))).statusCode, 302)
  assert.equal(links.listFriendLinks()[0].icon, uploaded)
  const orphan = (await import('../dist/media.js')).saveMedia(Buffer.concat([png, Buffer.from('orphan')])).name
  execFileSync(process.execPath, ['dist/cli/media.js', '--yes'], { env: process.env, stdio: 'pipe' })
  assert.ok(fs.existsSync(path.join(process.env.MEDIA_DIR, uploaded)))
  assert.equal(fs.existsSync(path.join(process.env.MEDIA_DIR, orphan)), false)
  assert.equal((await upload(Buffer.concat([png, Buffer.from('replacement')]))).statusCode, 302)
  assert.notEqual(links.listFriendLinks()[0].icon, uploaded)
  assert.ok(fs.existsSync(path.join(process.env.MEDIA_DIR, uploaded)))
  assert.equal((await post(`${endpoint}/${created.id}/icon`, { action: 'clear', csrf }, admin)).statusCode, 302)
  assert.equal(links.listFriendLinks()[0].icon, null)
  assert.equal((await post(endpoint, { action: 'delete', id: created.id, csrf }, admin)).statusCode, 302)
  assert.deepEqual(links.listFriendLinks(), [])
  for (const url of contentPaths) assert.equal((await request(url, reader)).body.includes('class="friend-links"'), false)
  console.log('PASS 友联 HTTP：六类页面共享、后台 CRUD、空态、转义、权限、来源、CSRF、图标上传与清理')
} finally {
  await app?.close()
  store?.closeStore()
  fs.rmSync(sandbox, { recursive: true, force: true })
}
