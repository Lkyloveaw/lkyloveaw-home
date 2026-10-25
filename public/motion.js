// Login enhancement only: ordinary POST/redirect remains available without JavaScript.
const form = document.querySelector('.login-form')
if (form && window.fetch && window.AbortController) {
  const button = form.querySelector('button[type="submit"]')
  const label = form.querySelector('[data-login-label]')
  const error = document.querySelector('[data-login-error]')
  const status = document.querySelector('[data-login-status]')
  const card = form.closest('.login-wrap')
  const initialLabel = label.textContent
  let busy = false
  let generation = 0
  let controller

  const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
  function reset() {
    generation++
    controller?.abort()
    busy = false
    button.disabled = false
    label.textContent = initialLabel
    status.textContent = ''
    form.dataset.state = 'idle'
    form.removeAttribute('aria-busy')
    card.classList.remove('is-leaving')
  }
  function showError(message) {
    reset()
    error.textContent = message
    error.hidden = false
  }
  window.addEventListener('pageshow', reset)
  window.addEventListener('pagehide', reset)

  form.addEventListener('submit', async event => {
    event.preventDefault()
    if (busy) return
    // Read before disabling the button; leave the user's inputs intact for retry.
    const body = new URLSearchParams(new FormData(form))
    const token = ++generation
    const request = new AbortController()
    controller = request
    busy = true
    button.disabled = true
    error.hidden = true
    label.textContent = status.textContent = '正在验证…'
    form.dataset.state = 'pending'
    form.setAttribute('aria-busy', 'true')
    const timeout = setTimeout(() => request.abort(), 15000)
    try {
      const response = await fetch('/login', {
        method: 'POST', credentials: 'same-origin', signal: request.signal,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8', Accept: 'application/json' },
        body,
      })
      const result = await response.json()
      if (token !== generation) return
      if (!response.ok || result?.ok !== true) {
        showError(response.status === 401 ? '用户名或口令不正确' : '暂时无法登录，请稍后重试。')
        return
      }
      if (typeof result.next !== 'string' || !result.next.startsWith('/') || result.next.startsWith('//')) throw new Error('Invalid destination')
      const next = new URL(result.next, window.location.origin)
      if (next.origin !== window.location.origin) throw new Error('Invalid destination')
      clearTimeout(timeout)
      label.textContent = status.textContent = '登录成功'
      form.dataset.state = 'success'
      if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        await pause(520)
        if (token !== generation) return
        card.classList.add('is-leaving')
        await pause(220)
        if (token !== generation) return
      }
      window.location.assign(next.pathname + next.search + next.hash)
    } catch {
      if (token === generation) showError('暂时无法登录，请稍后重试。')
    } finally {
      clearTimeout(timeout)
    }
  })
}
