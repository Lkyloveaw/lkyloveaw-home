/** 测试中解析浏览器的真实 ESM 依赖图；生产页面仍由浏览器原生加载。 */
import { buildSync } from 'esbuild'
export function buildBrowserModule(entry) {
  return buildSync({ entryPoints: [entry], bundle: true, write: false, format: 'iife', platform: 'browser', target: ['es2020'], logLevel: 'silent' }).outputFiles[0].text
}
