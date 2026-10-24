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
console.log(`${results.filter(Boolean).length}/${results.length} shared presentation checks passed`);
if(results.some(ok=>!ok))process.exitCode=1;
