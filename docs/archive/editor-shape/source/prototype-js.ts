/**
 * 原型的客户端脚本（抛弃式）。
 *
 * 刻意写成**不含模板字符串**的老式 JS：它整段要进 `<script>`，用单引号 + 拼接
 * 才不会被外层模板字符串的反引号咬到。
 *
 * 它负责三件事（都不是「被评的形态」，是脚手架）：
 * 1. 变体切换时把正文带过去（关掉 JS 就带不过去，那是 A 的诚实降级）；
 * 2. B 的防抖实时预览；C 的「存回 Markdown」与离开 C 的损失报告；
 * 3. 把实测数字写回状态面板（往返毫秒、栏宽）。
 */
export const EDITOR_CLIENT_JS = `
(function () {
  var root = document.getElementById('pv-root') || document.body;
  var variant = root.getAttribute('data-variant') || 'A';
  var KEY = 'prototype-editor:source';
  var sourceEl = document.getElementById('pv-source');
  var wysiwyg = document.getElementById('pv-wysiwyg');
  var pane = document.getElementById('pv-preview-body');
  var mdOut = document.getElementById('pv-md-out');
  var from = root.getAttribute('data-source-from') || 'sample';

  function setText(id, text) {
    var el = document.getElementById(id);
    if (el) el.textContent = text;
  }
  function sourceNow() {
    return sourceEl ? sourceEl.value : null;
  }
  function post(path, params) {
    var parts = [];
    for (var k in params) {
      if (Object.prototype.hasOwnProperty.call(params, k)) {
        parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(params[k]));
      }
    }
    return fetch(path, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded;charset=UTF-8',
        accept: 'application/json',
      },
      body: parts.join('&'),
    }).then(function (r) {
      return r.json();
    });
  }

  /* ---------- 实测数字 ---------- */
  function measureWidth() {
    var ref = document.querySelector('.pv-textarea') || wysiwyg;
    if (!ref) return;
    var w = Math.round(ref.getBoundingClientRect().width);
    setText('pv-stat-col', w + ' px（本页 wrap = 900px）');
  }
  measureWidth();
  window.addEventListener('resize', measureWidth);
  var colw = document.getElementById('pv-colw');
  if (colw) {
    var right = document.getElementById('pv-col-right');
    if (right) setText('pv-colw', '栏宽实测 ' + Math.round(right.getBoundingClientRect().width) + ' px');
  }

  if (sourceEl) {
    setText('pv-stat-live', sourceEl.value.length + ' 字');
    sourceEl.addEventListener('input', function () {
      setText('pv-stat-live', sourceEl.value.length + ' 字');
    });
  }
  if (wysiwyg) {
    setText('pv-stat-live', '这段 HTML ' + wysiwyg.innerHTML.length + ' 字符');
  }

  /* ---------- B：防抖实时预览 ---------- */
  var timer = null;
  function livePreview() {
    var src = sourceNow();
    if (src === null) return;
    var t0 = (window.performance && performance.now) ? performance.now() : Date.now();
    setText('pv-sync', '同步中…');
    post('/prototype/editor/preview', { source: src })
      .then(function (data) {
        if (pane) pane.innerHTML = data.html;
        var ms = Math.round(((window.performance && performance.now) ? performance.now() : Date.now()) - t0);
        setText('pv-sync', '刚刚 · 往返 ' + ms + ' ms');
        setText('pv-stat-rt', ms + ' ms（浏览器实测，含服务端渲染与回填）');
        setText('pv-stat-bytes', data.htmlBytes + ' 字节');
      })
      .catch(function (err) {
        setText('pv-sync', '同步失败：' + err.message);
      });
  }
  if (variant === 'B' && sourceEl) {
    sourceEl.addEventListener('input', function () {
      if (timer) clearTimeout(timer);
      timer = setTimeout(livePreview, 350);
    });
    livePreview();
  }

  /* ---------- 跳到测试点（近似定位，脚手架） ---------- */
  var jumps = document.querySelectorAll('[data-line]');
  for (var i = 0; i < jumps.length; i++) {
    jumps[i].addEventListener('click', function () {
      var line = parseInt(this.getAttribute('data-line'), 10) || 1;
      var total = parseInt(this.getAttribute('data-total'), 10) || 1;
      var ratio = Math.min(1, Math.max(0, (line - 1) / total));
      if (sourceEl) sourceEl.scrollTop = ratio * (sourceEl.scrollHeight - sourceEl.clientHeight);
      if (wysiwyg) wysiwyg.scrollTop = ratio * (wysiwyg.scrollHeight - wysiwyg.clientHeight);
    });
  }

  /* ---------- C：工具栏 + 存回 Markdown ---------- */
  var toolbar = document.getElementById('pv-toolbar');
  if (toolbar && wysiwyg) {
    toolbar.addEventListener('click', function (ev) {
      var btn = ev.target && ev.target.closest ? ev.target.closest('button') : null;
      if (!btn) return;
      var cmd = btn.getAttribute('data-cmd');
      var arg = btn.getAttribute('data-arg');
      wysiwyg.focus();
      if (cmd === 'insertTable') {
        document.execCommand('insertHTML', false,
          '<table><thead><tr><th>指标</th><th>回答的问题</th></tr></thead>' +
          '<tbody><tr><td>可用率</td><td>它坏过吗</td></tr></tbody></table><p><br></p>');
        return;
      }
      if (cmd === 'insertCode') {
        document.execCommand('insertHTML', false,
          '<pre><code>const res = await fetch(url)</code></pre><p><br></p>');
        return;
      }
      document.execCommand(cmd, false, arg || null);
    });
  }

  function lossTable(rows) {
    var html = '<table class="pv-loss"><thead><tr><th>项目</th><th>样本原文</th><th>存回的 Markdown</th></tr></thead><tbody>';
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      var cls = r.verdict === 'loss' ? 'pv-bad' : 'pv-ok';
      html += '<tr><td>' + r.item + '</td><td>' + r.before + '</td><td class="' + cls + '">' + r.after +
        (r.verdict === 'loss' ? ' ← 丢了' : '') + '</td></tr>';
    }
    return html + '</tbody></table>';
  }

  function showResult(data, nextLabel, nextHref) {
    if (!mdOut) return;
    var html = '';
    if (nextLabel) {
      html += '<div class="pv-warn"><b>离开富文本要先过一次「存回 Markdown」。</b> ' +
        '这一版没有无损出口：你写的东西必须先降级成 Markdown 才能被别的变体接住。下面是这次降级的结果。' +
        (nextHref ? ' <a href="' + nextHref + '">带着这份 Markdown 切到 ' + nextLabel + ' →</a>' : '') +
        '</div>';
    }
    html += '<h2>' + (nextLabel ? '这次存回的 Markdown（会被带过去的就是它）' : '存回的 Markdown 结果') +
      ' <span class="pv-hint">转换耗时 ' + data.ms + ' ms · ' + data.markdown.length + ' 字符</span></h2>';
    html += '<pre><code>' + data.markdown.replace(/&/g, '&amp;').replace(/</g, '&lt;') + '</code></pre>';
    html += '<h2>丢了什么 <span class="pv-hint">（与样本原文逐项比，全是数出来的）</span></h2>';
    html += lossTable(data.losses);
    if (data.notes && data.notes.length) {
      html += '<h2>转换器自己承认「靠猜/压平」的地方</h2><ul class="pv-cost">';
      for (var i = 0; i < data.notes.length; i++) html += '<li>' + data.notes[i] + '</li>';
      html += '</ul>';
    }
    mdOut.innerHTML = html;
    mdOut.hidden = false;
    mdOut.scrollIntoView({ block: 'start' });
  }

  function save() {
    if (!wysiwyg) return Promise.resolve(null);
    return post('/prototype/editor/md', { html: wysiwyg.innerHTML });
  }
  var toMdBtn = document.getElementById('pv-tomd');
  if (toMdBtn) {
    toMdBtn.addEventListener('click', function () {
      toMdBtn.disabled = true;
      save().then(function (data) {
        toMdBtn.disabled = false;
        if (data) showResult(data);
      });
    });
  }

  /* ---------- 变体切换：带正文过去 ---------- */
  function goTo(link, ev) {
    var next = link.getAttribute('data-next');
    var label = link.getAttribute('data-label') || next;
    if (variant === 'C' && wysiwyg) {
      if (ev) ev.preventDefault();
      save().then(function (data) {
        if (!data) return;
        try { sessionStorage.setItem(KEY, data.markdown); } catch (e) {}
        showResult(data, label, link.getAttribute('href'));
      });
      return;
    }
    var src = sourceNow();
    if (src !== null) {
      try { sessionStorage.setItem(KEY, src); } catch (e) {}
    }
  }
  var navs = document.querySelectorAll('[data-next]');
  for (var j = 0; j < navs.length; j++) {
    navs[j].addEventListener('click', function (ev) { goTo(this, ev); });
  }

  /* ---------- 键盘 ← → ---------- */
  document.addEventListener('keydown', function (ev) {
    var t = ev.target;
    var tag = t && t.tagName ? t.tagName.toLowerCase() : '';
    if (tag === 'input' || tag === 'textarea' || tag === 'select' || (t && t.isContentEditable)) return;
    if (ev.key === 'ArrowLeft') {
      var a = document.querySelector('[data-nav="prev"]');
      if (a) a.click();
    } else if (ev.key === 'ArrowRight') {
      var b = document.querySelector('[data-nav="next"]');
      if (b) b.click();
    }
  });

  /* ---------- 接住上一个变体带过来的正文 ---------- */
  var carried = null;
  try { carried = sessionStorage.getItem(KEY); } catch (e) { carried = null; }
  if (carried !== null && carried !== '' && from !== 'posted') {
    setText('pv-carried', '正文是从上一个变体带过来的（' + carried.length + ' 字）');
    if (sourceEl) {
      sourceEl.value = carried;
      setText('pv-stat-live', carried.length + ' 字');
      if (variant === 'B') livePreview();
    }
    if (wysiwyg) {
      setText('pv-stat-live', '这段 HTML 来自带过来的 Markdown（已经过渲染）');
      post('/prototype/editor/preview', { source: carried }).then(function (data) {
        wysiwyg.innerHTML = data.html;
      });
    }
  }
})();
`
