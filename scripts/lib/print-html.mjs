/** Make the real SSR page self-contained before printing it from a local file. */
export function preparePrintHtml(html, css) {
  const stylesheet=/<link rel="stylesheet" href="\/style\.css(?:\?[^"]*)?">/i
  if(!stylesheet.test(html)) throw new Error('打印页面缺少站点样式，拒绝生成无样式的 PDF')
  return html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'')
    .replace(stylesheet,()=>`<style>${css}</style><style>@page { size: A4; margin: 12mm; }</style>`)
}
