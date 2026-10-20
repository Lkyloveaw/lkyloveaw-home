// iOS 图标：内联 SVG，零依赖、零图标字体（#68 §9.4）。服务端专用。
export type IconName = 'home' | 'doc' | 'pulse' | 'info' | 'sliders' | 'chev' | 'plus'

const PATHS: Record<IconName, string> = {
  home: '<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/>',
  doc: '<path d="M6 3h9l3 3v15H6z"/><path d="M15 3v4h4"/><path d="M9 12h6M9 16h6"/>',
  pulse: '<path d="M3 12h3l2-6 4 12 3-8 2 2h4"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
  sliders: '<path d="M4 7h16M4 12h16M4 17h16"/><circle cx="8" cy="7" r="2"/><circle cx="16" cy="12" r="2"/><circle cx="10" cy="17" r="2"/>',
  chev: '<path d="m9 5 7 7-7 7"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
}

/**
 * 返回一个 24×24 的内联 SVG。装饰性图标一律 `aria-hidden`：
 * rail / tab bar 的图标旁边都有可见文字，图标本身不承担语义。
 */
export function icon(name: IconName, cls = 'icon'): string {
  return `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">${PATHS[name]}</svg>`
}
