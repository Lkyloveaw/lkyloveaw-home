// Executes the actual browser script; only browser I/O and the clock are controlled.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import {buildBrowserModule} from './lib/browser-module.mjs'
let failed=0,total=0
const check=async(name,fn)=>{total++;try{await fn();console.log('PASS '+name)}catch(error){failed++;console.error('FAIL '+name+': '+error.message)}}
const flush=()=>new Promise(resolve=>setImmediate(resolve))
class Element{
  dataset={};hidden=false;disabled=false;textContent='';attributes=new Map();events=new Map()
  classList={values:new Set(),add(name){this.values.add(name)},remove(name){this.values.delete(name)},contains(name){return this.values.has(name)}}
  addEventListener(name,fn){this.events.set(name,fn)}
  setAttribute(name,value){this.attributes.set(name,String(value))}
  removeAttribute(name){this.attributes.delete(name)}
  focus(){this.focused=true}
}
function setup({fetcher=async()=>new Response(JSON.stringify({ok:true,next:'/admin/settings?from=login'})),reduced=false,noForm=false}={}){
  assert.ok(fs.existsSync('public/motion.js'),'product motion script must exist')
  const form=new Element(),button=new Element(),label=new Element(),error=new Element(),status=new Element(),card=new Element()
  error.hidden=true;label.textContent='登录';const timers=[],requests=[],navigation=[],events=new Map()
  const parts={'button[type="submit"]':button,'[data-login-label]':label,'[data-login-error]':error,'[data-login-status]':status}
  form.querySelector=selector=>parts[selector];form.closest=()=>card
  // location.assign parses its argument again, as the real browser does.
  const location={origin:'http://localhost:3994',assign:target=>navigation.push(new URL(target,'http://localhost:3994').href)}
  const fetch=async(url,options)=>{requests.push({url,options});return fetcher(url,options)}
  const window={fetch,AbortController,location,matchMedia:()=>({matches:reduced}),addEventListener:(name,fn)=>events.set(name,fn)}
  const document={querySelector:selector=>selector==='.login-form'?(noForm?null:form):parts[selector]}
  vm.runInNewContext(buildBrowserModule('public/motion.js'),{window,document,fetch,location,URL,URLSearchParams,AbortController,FormData:class extends Map{constructor(){super([['username','demo'],['password','demo-password'],['next','/admin/settings?from=login']])}},setTimeout:(fn,ms)=>{const timer={fn,ms};timers.push(timer);return timer},clearTimeout:timer=>{if(timer)timer.cancelled=true},console})
  return{form,button,label,error,status,card,timers,requests,navigation,events,submit:()=>form.events.get('submit')({preventDefault(){}}),run(ms){const timer=timers.find(item=>!item.cancelled&&item.ms===ms);assert.ok(timer,'expected timer '+ms);timer.cancelled=true;timer.fn()}}
}
await check('等待真实响应时显示忙碌并拒绝重复提交',async()=>{
  const deferred=Promise.withResolvers();const x=setup({fetcher:()=>deferred.promise});const pending=x.submit();await x.submit()
  assert.equal(x.requests.length,1);assert.equal(x.button.disabled,true);assert.equal(x.label.textContent,'正在验证…');assert.equal(x.form.attributes.get('aria-busy'),'true')
  assert.equal(x.requests[0].options.headers.Accept,'application/json');assert.equal(x.requests[0].options.body.get('password'),'demo-password')
  deferred.resolve(new Response(JSON.stringify({ok:false,error:'用户名或口令不正确'}),{status:401}));await pending;assert.equal(x.button.disabled,false)
})
await check('只有成功响应才播放确认，520ms 后淡出，220ms 后访问原目标',async()=>{
  const x=setup();const pending=x.submit();await flush();assert.equal(x.label.textContent,'登录成功');assert.deepEqual(x.navigation,[])
  x.run(520);await flush();assert.ok(x.card.classList.contains('is-leaving'));assert.deepEqual(x.navigation,[])
  x.run(220);await pending;assert.deepEqual(x.navigation,['http://localhost:3994/admin/settings?from=login'])
})
await check('凭据错误保留错误反馈并恢复重试',async()=>{
  const x=setup({fetcher:async()=>new Response(JSON.stringify({ok:false,error:'用户名或口令不正确'}),{status:401})});await x.submit();assert.equal(x.error.hidden,false);assert.equal(x.error.textContent,'用户名或口令不正确');assert.equal(x.button.disabled,false);assert.deepEqual(x.navigation,[])
})
await check('断网和意外 HTML 均恢复按钮，不自动重复提交',async()=>{
  for(const fetcher of [async()=>{throw new Error('offline')},async()=>new Response('<html>upstream error</html>',{status:502})]){
    const x=setup({fetcher});await x.submit();assert.equal(x.requests.length,1);assert.equal(x.error.hidden,false);assert.equal(x.button.disabled,false);assert.deepEqual(x.navigation,[])
  }
})
await check('15 秒请求超时能取消等待并恢复重试',async()=>{
  const x=setup({fetcher:(_url,{signal})=>new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(new Error('aborted'))))});const pending=x.submit();x.run(15000);await pending;assert.equal(x.button.disabled,false);assert.equal(x.error.hidden,false);assert.deepEqual(x.navigation,[])
})
await check('成功形状不完整和站外目标不能触发跳转',async()=>{
  for(const body of [{ok:true},{ok:false,next:'/'},{ok:true,next:'https://untrusted.example'},{ok:true,next:'//untrusted.example'},{ok:true,next:'/\\untrusted.example'}]){
    const x=setup({fetcher:async()=>new Response(JSON.stringify(body))});await x.submit();assert.equal(x.button.disabled,false);assert.equal(x.error.hidden,false);assert.deepEqual(x.navigation,[])
  }
})
await check('减少动态效果时成功后直接进入原目标',async()=>{
  const x=setup({reduced:true});await x.submit();assert.deepEqual(x.navigation,['http://localhost:3994/admin/settings?from=login']);assert.equal(x.timers.filter(timer=>!timer.cancelled).length,0)
})
await check('规范化后以双斜线开头的本站路径不会被重新解释为站外地址',async()=>{
  const x=setup({reduced:true,fetcher:async()=>new Response(JSON.stringify({ok:true,next:'/posts/..//untrusted.example'}))});
  await x.submit();assert.deepEqual(x.navigation,['http://localhost:3994//untrusted.example'])
})
await check('离开或缓存返回时取消旧成功回调并清理忙碌状态',async()=>{
  for(const event of ['pagehide','pageshow']){
    const x=setup();const pending=x.submit();await flush();x.events.get(event)();x.run(520);await pending;assert.deepEqual(x.navigation,[]);assert.equal(x.button.disabled,false);assert.equal(x.card.classList.contains('is-leaving'),false)
  }
})
await check('缓存返回后旧的网络响应不能再次触发成功',async()=>{
  const deferred=Promise.withResolvers();const x=setup({fetcher:()=>deferred.promise});const pending=x.submit();x.events.get('pageshow')();deferred.resolve(new Response(JSON.stringify({ok:true,next:'/'})));await pending;assert.deepEqual(x.navigation,[]);assert.equal(x.button.disabled,false)
})
await check('内容页不存在登录表单时不做额外请求',()=>{const x=setup({noForm:true});assert.equal(x.requests.length,0)})
console.log(`${total-failed}/${total} motion browser checks passed`)
process.exitCode=failed?1:0
