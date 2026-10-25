// Real routes and a disposable database: catches false login success, unsafe return paths and broken fallback.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
const sandbox=fs.mkdtempSync(path.join(os.tmpdir(),'website-motion-'))
Object.assign(process.env,{
  DATABASE_PATH:path.join(sandbox,'db.sqlite'),MEDIA_DIR:path.join(sandbox,'media'),BACKUP_DIR:path.join(sandbox,'backups'),
  CONTENT_DIR:path.join(sandbox,'content'),TARGETS_JSON:'[]',SESSION_SECRET:'motion-test-only-secret-32-characters',
  SITE_ORIGIN:'http://localhost:3994',ADMIN_USERNAME:'motion-admin',ADMIN_PASSWORD:'motion-test-password',SESSION_COOKIE_SECURE:'0',
})
let app,store,failed=0,total=0
const check=async(name,fn)=>{total++;try{await fn();console.log('PASS '+name)}catch(error){failed++;console.error('FAIL '+name+': '+error.message)}}
try{
  store=await import('../dist/store.js')
  app=await(await import('../dist/server.js')).buildServer()
  const post=(form={},headers={})=>app.inject({method:'POST',url:'/login',headers:{origin:process.env.SITE_ORIGIN,'content-type':'application/x-www-form-urlencoded',accept:'application/json',...headers},payload:new URLSearchParams({username:'motion-admin',password:'motion-test-password',next:'/admin/settings',...form}).toString()})
  const cookieOf=response=>String(response.headers['set-cookie']??'').split(';')[0]
  await check('JSON 登录签发可用会话并返回原目标',async()=>{
    const result=await post();assert.equal(result.statusCode,200);assert.deepEqual(result.json(),{ok:true,next:'/admin/settings'})
    assert.match(cookieOf(result),/^session=/)
    assert.equal((await app.inject({url:'/admin/settings',headers:{cookie:cookieOf(result)}})).statusCode,200)
  })
  await check('错误账号和错误口令返回相同的可重试结果',async()=>{
    for(const form of [{password:'wrong-password'},{username:'missing-user'}]){
      const result=await post(form);assert.equal(result.statusCode,401);assert.deepEqual(result.json(),{ok:false,error:'用户名或口令不正确'});assert.equal(result.headers['set-cookie'],undefined)
    }
  })
  await check('JSON 登录仍拒绝不可信和缺失来源',async()=>{
    for(const origin of ['https://untrusted.example','']){const result=await post({},{origin});assert.equal(result.statusCode,403);assert.equal(result.headers['set-cookie'],undefined)}
  })
  await check('JSON 登录无法绕过安全回跳校验',async()=>{
    for(const next of ['//untrusted.example','https://untrusted.example','/\\untrusted.example','/not-a-real-page']){
      const result=await post({next});assert.equal(result.statusCode,200);assert.equal(result.json().next,'/')
    }
    const result=await post({next:'/admin/settings?notice=settings-saved'});assert.equal(result.json().next,'/admin/settings?notice=settings-saved')
  })
  await check('无 JavaScript 的 HTML 登录仍为 302 和 401',async()=>{
    const success=await post({},{accept:'text/html'});assert.equal(success.statusCode,302);assert.equal(success.headers.location,'/admin/settings')
    const failure=await post({password:'wrong-password'},{accept:'text/html'});assert.equal(failure.statusCode,401);assert.match(String(failure.headers['content-type']),/text\/html/);assert.match(failure.body,/用户名或口令不正确/)
  })
  await check('登录表单仍可原生提交且脚本是匿名可读的增强',async()=>{
    const page=await app.inject({url:'/login?next=%2Fadmin%2Fsettings'})
    assert.match(page.body,/<form[^>]*method="post"[^>]*action="\/login"/)
    assert.match(page.body,/name="next" value="\/admin\/settings"/)
    assert.match(page.body,/<script type="module" src="\/motion\.js"/)
    assert.match(page.body,/data-login-error[^>]*role="alert"/)
    const script=await app.inject({url:'/motion.js'});assert.equal(script.statusCode,200);assert.match(String(script.headers['content-type']),/javascript/);assert.match(String(script.headers['cache-control']),/no-cache|no-store/)
    const css=page.body.match(/<link rel="stylesheet" href="([^"]+)"/)[1]
    assert.ok(new URL(css,process.env.SITE_ORIGIN).searchParams.has('v'),'new markup must bypass the previously cached CSS')
    assert.match(String((await app.inject({url:css})).headers['cache-control']),/no-cache|no-store/)
  })
  await check('公共保存和上传提示提供可感知的状态结果',async()=>{
    const {renderNotice,accountPage}=await import('../dist/views.js')
    assert.match(renderNotice('settings-saved'),/data-feedback[^>]*role="status"/)
    assert.match(renderNotice('image-save-failed','bad'),/data-feedback[^>]*role="alert"/)
    assert.equal(renderNotice('untrusted-user-text'),'')
    assert.match(accountPage({notice:'口令已修改。'},{title:'test',description:'test'}),/data-feedback[^>]*role="status"/)
  })
  await check('打印仍内联带版本参数的真实样式并移除页面脚本',async()=>{
    const {preparePrintHtml}=await import('./lib/print-html.mjs')
    const page=await app.inject({url:'/login'})
    const printed=preparePrintHtml(page.body,'.print-proof { color: black }')
    assert.ok(printed.includes('<style>.print-proof { color: black }</style>'))
    assert.match(printed,/@page\s*\{\s*size: A4/)
    assert.doesNotMatch(printed,/<script\b|<link rel="stylesheet"/)
    assert.ok(preparePrintHtml('<link rel="stylesheet" href="/style.css">','legacy').includes('<style>legacy</style>'))
    assert.throws(()=>preparePrintHtml('<html>missing stylesheet</html>','css'),/样式/)
  })
}finally{await app?.close();store?.closeStore();fs.rmSync(sandbox,{recursive:true,force:true})}
console.log(`${total-failed}/${total} motion route checks passed`)
process.exitCode=failed?1:0
