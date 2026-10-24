// 共享模块公开接口的行为检查；数值预期独立于 SVG 包装与客户端 DOM。
import assert from 'node:assert/strict';
import * as CP from '../public/chart-path.js';
import { escapeHtml } from '../public/html.js';
const results=[];
export async function check(name,run){try{await run();results.push(true);console.log('PASS '+name)}catch(error){results.push(false);console.error('FAIL '+name+': '+error.message)}}
await check('HTML 文本和属性载荷完整转义且空值安全',()=>{
  assert.equal(escapeHtml(`<img a="x" b='y'>&`),'&lt;img a=&quot;x&quot; b=&#39;y&#39;&gt;&amp;');
  assert.equal(escapeHtml(null),'');assert.equal(escapeHtml(undefined),'');assert.equal(escapeHtml(0),'0');
});
await check('共享几何支持 Node 原生导入并生成固定坐标',()=>{
  assert.equal(typeof CP.linePath,'function');
  assert.equal(CP.linePath([0,100],100,100,10),'M10.0,90.0 L90.0,10.0');
  assert.equal(CP.linePath([0,100],100,100,10,[1000,3000],{min:0,max:4000}),'M30.0,90.0 L70.0,10.0');
});
await check('几何中的缺失与非法值确实断线',()=>{
  assert.equal(CP.linePath([0,null,100],100,100,10),'M10.0,90.0 M90.0,10.0');
  assert.equal(CP.linePath([0,NaN,100],100,100,10),'M10.0,90.0 M90.0,10.0');
  assert.equal(CP.linePath([0,-1,100],100,100,10),'M10.0,90.0 M90.0,10.0');
  assert.equal(CP.linePath([42],100,100,10),'');
});
await check('填充闭合与越界夹紧保持固定预期',()=>{
  assert.equal(CP.areaPath('M10.0,90.0 L90.0,10.0',100,100,10),'M10.0,90.0 L90.0,10.0 L90.0,90.0 L10.0,90.0 Z');
  assert.equal(CP.clampY(200,{min:0,max:100},100,10),10);
  assert.equal(CP.clampY(-1,{min:0,max:100},100,10),90);
});
await check('初始值域和只扩不缩的后续值域保持',()=>{
  assert.deepEqual(CP.expandDomain(null,[5,5],10),{min:0,max:10});
  assert.deepEqual(CP.expandDomain({min:0,max:20},[5,15],10),{min:0,max:20});
  assert.deepEqual(CP.expandDomain({min:0,max:20},[90],10),{min:0,max:90});
  assert.equal(CP.expandDomain(null,[null,NaN,-1],10),null);
});

const model = () => import('../public/status-model.js');
await check('共享状态规则区分当前、过期和未探测，并保留阈值边界',async()=>{
  const m=await model();const item={lastStatus:'up',lastCheckedAt:1000,staleAfterMs:185000};
  assert.equal(m.visibleState(item,186000),'up');assert.equal(m.visibleState(item,186001),'stale');
  assert.equal(m.visibleState({...item,lastCheckedAt:null},186001),'unknown');
  assert.equal(m.stateClass('degraded'),'warn');assert.equal(m.stateText('down'),'故障');
  assert.equal(m.stateClass('stale'),'unknown');assert.equal(m.stateText('stale'),'数据过期');
  assert.equal(m.stateText('__proto__'),'无数据');
});
await check('共享汇总保留历史均值并排除过期目标的当前计数',async()=>{
  const m=await model(),now=1000000;
  const base={lastCheckedAt:now,staleAfterMs:185000,uptime:null,avgLatencyMs:null};
  const summary=m.summarizeStatus([
    {...base,lastStatus:'up',uptime:1,avgLatencyMs:10},
    {...base,lastStatus:'degraded',uptime:0.5,avgLatencyMs:30},
    {...base,lastStatus:'down',lastCheckedAt:now-200000,uptime:0},
    {...base,lastStatus:null,lastCheckedAt:null},
    {...base,lastStatus:'down',uptime:0},
  ],now);
  assert.deepEqual(summary,{total:5,up:1,faults:2,stale:1,unknown:1,avgUptime:0.375,avgLatencyMs:20,freshnessText:'1 个系统数据过期 · 1 个系统待探测'});
});
await check('零目标和没有样本保持空值而非 100%',async()=>{
  const m=await model();const none=m.summarizeStatus([],1000);
  assert.equal(none.total,0);assert.equal(none.avgUptime,null);assert.equal(none.avgLatencyMs,null);assert.equal(none.freshnessText,'暂无监控系统');
  const unknown=m.summarizeStatus([{lastStatus:null,lastCheckedAt:null,staleAfterMs:1000,uptime:null,avgLatencyMs:null}],1000);
  assert.equal(unknown.unknown,1);assert.equal(unknown.avgUptime,null);assert.equal(m.formatUptime(null),'暂无数据');
});
await check('持续时长和时间文字由同一规则格式化',async()=>{
  const m=await model();assert.equal(m.observedDuration(0),'不足 1 分钟');assert.equal(m.observedDuration(60000),'1 分钟');
  assert.equal(m.observedDuration(3600000),'1 小时');assert.equal(m.observedDuration(172800000),'2 天');
  assert.equal(m.formatUptime(1/3),'33.33%');assert.equal(m.formatTime(null),'—');
  assert.equal(m.formatTime(new Date(2026,0,2,3,4).getTime()),'2026-01-02 03:04');
});
await check('事件缺测转为待确认，已恢复事件不被时间推翻',async()=>{
  const m=await model(),event={outcome:'ongoing',lastSeenAt:1000};
  assert.equal(m.incidentOutcome(event,185000,186000),'ongoing');assert.equal(m.incidentOutcome(event,185000,186001),'unknown');
  assert.equal(m.incidentOutcome({...event,outcome:'recovered'},185000,999999),'recovered');
  assert.equal(m.incidentOutcomeText('unknown'),'缺测，待确认');
});
await check('事件明细明确区分最后异常和恢复记录',async()=>{
  const m=await model(),event={durationMs:60000,lastSeenAt:new Date(2026,0,2,3,4).getTime(),endedAt:null};
  assert.equal(m.incidentDetails(event),'已确认 1 分钟 · 最后异常 2026-01-02 03:04');
  assert.equal(m.incidentDetails({...event,endedAt:new Date(2026,0,2,3,5).getTime()}),'已确认 1 分钟 · 恢复记录 2026-01-02 03:05');
});

console.log(`${results.filter(Boolean).length}/${results.length} shared presentation checks passed`);
if(results.some(ok=>!ok))process.exitCode=1;
