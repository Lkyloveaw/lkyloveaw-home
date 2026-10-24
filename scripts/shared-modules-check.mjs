// 上传行为回归：真实 Fastify 路由、临时数据库和媒体目录。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'website-shared-'));
Object.assign(process.env, {
  DATABASE_PATH:path.join(sandbox,'check.sqlite'), MEDIA_DIR:path.join(sandbox,'media'),
  BACKUP_DIR:path.join(sandbox,'backups'), CONTENT_DIR:path.join(sandbox,'content'), TARGETS_JSON:'[]',
  SESSION_SECRET:'shared-modules-test-secret-only-32-characters', SITE_ORIGIN:'http://localhost:3996',
  ADMIN_USERNAME:'shared-admin', ADMIN_PASSWORD:'shared-test-password', SESSION_COOKIE_SECURE:'0',
});
let app, store;
const results=[];
const check=async(name,run)=>{try{await run();results.push(true);console.log('PASS '+name)}catch(error){results.push(false);console.error('FAIL '+name+': '+error.message)}};
try {
  store=await import('../dist/store.js');
  app=await (await import('../dist/server.js')).buildServer();
  const links=await import('../dist/friend-links.js');
  const friend=links.saveFriendLink({name:'共享模块测试',url:'https://example.com'});
  let deleteDuringRead=false;
  app.addHook('preValidation',async(req)=>{
    if(deleteDuringRead && req.url===`/admin/settings/friends/${friend.id}/icon`){
      const file=req.body?.file;
      if(file && typeof file.toBuffer==='function'){
        const read=file.toBuffer.bind(file);
        file.toBuffer=async()=>{const bytes=await read();links.deleteFriendLink(friend.id);return bytes};
      }
    }
  });
  const login=await app.inject({method:'POST',url:'/login',headers:{origin:process.env.SITE_ORIGIN,'content-type':'application/x-www-form-urlencoded'},payload:new URLSearchParams({username:'shared-admin',password:'shared-test-password'}).toString()});
  assert.equal(login.statusCode,302);
  const header=login.headers['set-cookie'];
  const cookie=(Array.isArray(header)?header[0]:header).split(';')[0];
  const page=await app.inject({method:'GET',url:'/admin/settings',headers:{cookie}});
  const csrf=page.body.match(/name="csrf" value="([^"]+)"/)[1];
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==','base64');
  const endpoints=['/admin/articles/media','/account/avatar','/admin/settings/logo',`/admin/settings/friends/${friend.id}/icon`];
  const upload=async(url,bytes,token=csrf)=>{
    const boundary='shared-modules-boundary';
    const prefix=`--${boundary}\r\nContent-Disposition: form-data; name="csrf"\r\n\r\n${token}\r\n--${boundary}\r\nContent-Disposition: form-data; name="action"\r\n\r\nupload\r\n`;
    const parts=[Buffer.from(prefix)];
    if(bytes!==null)parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="fixture.png"\r\nContent-Type: image/png\r\n\r\n`),bytes,Buffer.from('\r\n'));
    parts.push(Buffer.from(`--${boundary}--\r\n`));
    return app.inject({method:'POST',url,headers:{cookie,origin:process.env.SITE_ORIGIN,'content-type':`multipart/form-data; boundary=${boundary}`},payload:Buffer.concat(parts)});
  };
  fs.writeFileSync(process.env.MEDIA_DIR,'blocked directory fixture');
  for(const url of endpoints){
    await check(`${url} 写盘失败显示保存失败`,async()=>{
      const response=await upload(url,png);assert.equal(response.statusCode,302);assert.match(response.headers.location,/notice=image-save-failed/);
    });
    await check(`${url} 非法图片与缺少文件分类正确`,async()=>{
      assert.match((await upload(url,Buffer.from('<svg/>'))).headers.location,/notice=media-rejected/);
      assert.match((await upload(url,null)).headers.location,/notice=media-no-file/);
    });
    await check(`${url} CSRF 失败在写入前拒绝`,async()=>{assert.equal((await upload(url,png,'wrong-token')).statusCode,403)});
  }
  fs.rmSync(process.env.MEDIA_DIR);
  for(const url of endpoints){await check(`${url} 正常上传与重复上传可用`,async()=>{
    assert.equal((await upload(url,png)).statusCode,302);assert.equal((await upload(url,png)).statusCode,302);
    assert.equal(fs.readdirSync(process.env.MEDIA_DIR).filter(name=>/\.png$/.test(name)).length,1);
  })}
  await check('文章重复上传保留媒体复用提示',async()=>{assert.match((await upload(endpoints[0],png)).headers.location,/media-duplicate/)});
  await check('超限上传统一返回过大提示',async()=>{for(const url of endpoints)assert.match((await upload(url,Buffer.alloc(8*1024*1024+1))).headers.location,/notice=media-too-big/)});
  await check('上传过程中被删除的友联返回 404 且不重建',async()=>{deleteDuringRead=true;assert.equal((await upload(endpoints[3],png)).statusCode,404);assert.equal(links.listFriendLinks().length,0)});
} finally {
  await app?.close();store?.closeStore();fs.rmSync(sandbox,{recursive:true,force:true});
}
console.log(`${results.filter(Boolean).length}/${results.length} shared upload checks passed`);
if(results.some(ok=>!ok))process.exitCode=1;
