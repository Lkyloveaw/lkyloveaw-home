/** HTML 文本和属性的统一转义；Node 与浏览器共用。 */
const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
export function escapeHtml(input) {
  return String(input ?? '').replace(/[&<>"']/g, ch => ESCAPES[ch])
}
