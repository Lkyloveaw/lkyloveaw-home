/**
 * 原型专用样式（抛弃式）。
 *
 * 两条纪律：
 * 1. **只加不覆盖**：产品 `public/style.css` 一行不改，原型要改的全在这里。
 * 2. **类名一律 `pv-` 前缀**，与产品样式零冲突；配色全部取产品 token（`var(--bg)` 等），
 *    所以它看起来就是本站，而不是一个外来的演示页。
 */
export const PROTOTYPE_CSS = `
/* ---------- 原型的头部与面板 ---------- */
.pv-head h1 { font-size: 1.5rem; margin: 0 0 8px; }
.pv-lede { color: var(--fg-dim); margin: 0 0 10px; }
.pv-scaffold {
  color: var(--fg-faint); font-size: 0.8rem; line-height: 1.6;
  border-left: 3px solid var(--border); padding-left: 10px; margin: 0 0 22px;
}
.pv-panel {
  background: var(--bg-card); border: 1px solid var(--border);
  border-radius: var(--radius); padding: 14px 18px; margin: 0 0 18px;
}
.pv-panel h2 {
  font-size: 0.86rem; margin: 0 0 10px; color: var(--fg-dim);
  text-transform: none; letter-spacing: 0.02em;
}
.pv-panel dl {
  display: grid; grid-template-columns: max-content 1fr;
  gap: 5px 16px; margin: 0;
}
.pv-panel dt { color: var(--fg-faint); font-size: 0.79rem; }
.pv-panel dd { margin: 0; font-size: 0.85rem; }
.pv-panel dd b { font-weight: 600; }
.pv-num { font-family: var(--mono); font-variant-numeric: tabular-nums; }
.pv-ok { color: var(--ok); }
.pv-warn-t { color: var(--warn); }
.pv-bad { color: var(--bad); }
.pv-cost { margin: 0; padding-left: 20px; font-size: 0.85rem; color: var(--fg-dim); }
.pv-cost li { margin-bottom: 5px; }
.pv-cost code { font-size: 0.8rem; }

/* ---------- 变体本体 ---------- */
.pv-textarea {
  width: 100%; display: block; box-sizing: border-box;
  background: var(--bg-soft); color: var(--fg);
  border: 1px solid var(--border); border-radius: var(--radius);
  padding: 14px 16px; font-family: var(--mono);
  font-size: 0.875rem; line-height: 1.75; resize: vertical;
}
.pv-textarea:focus { outline: 2px solid var(--accent); outline-offset: 1px; border-color: var(--accent); }
.pv-actions { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin: 12px 0 0; }
.pv-btn {
  background: var(--accent); color: #fff; border: 0; border-radius: 6px;
  padding: 9px 14px; font-size: 0.92rem; font-family: inherit; cursor: pointer;
}
.pv-btn:hover { filter: brightness(1.08); }
.pv-btn-2 {
  background: var(--bg-soft); color: var(--fg); border: 1px solid var(--border);
  border-radius: 6px; padding: 8px 12px; font-size: 0.88rem; font-family: inherit; cursor: pointer;
}
.pv-btn-2:hover { border-color: var(--accent); color: var(--accent); }
.pv-hint { color: var(--fg-faint); font-size: 0.8rem; }
.pv-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; align-items: start; }
.pv-col { min-width: 0; }
.pv-pane-head {
  display: flex; align-items: baseline; justify-content: space-between;
  gap: 10px; font-size: 0.84rem; color: var(--fg-dim); margin: 0 0 8px;
}
.pv-scroll { max-height: 56vh; overflow: auto; padding-right: 4px; }
.pv-preview { margin: 24px 0 0; }
.pv-preview > h2 { font-size: 0.95rem; margin: 0 0 10px; }
.pv-toolbar { display: flex; gap: 6px; flex-wrap: wrap; margin: 0 0 8px; }
.pv-toolbar button {
  background: var(--bg-soft); color: var(--fg); border: 1px solid var(--border);
  border-radius: 6px; padding: 5px 10px; font-family: inherit; font-size: 0.84rem; cursor: pointer;
}
.pv-toolbar button:hover { border-color: var(--accent); color: var(--accent); }
.pv-wysiwyg {
  background: var(--bg-soft); border: 1px solid var(--border); border-radius: var(--radius);
  padding: 18px 20px; min-height: 46vh; max-height: 62vh; overflow: auto;
}
.pv-wysiwyg:focus { outline: 2px solid var(--accent); outline-offset: 1px; }
.pv-wysiwyg img { max-width: 100%; height: auto; border-radius: var(--radius); }
.pv-wysiwyg table { width: 100%; border-collapse: collapse; margin: 0 0 16px; font-size: 0.92rem; }
.pv-wysiwyg th, .pv-wysiwyg td { border: 1px solid var(--border); padding: 8px 10px; text-align: left; }
.pv-wysiwyg th { background: var(--bg); font-weight: 600; }
.pv-wysiwyg pre { background: var(--bg); }
.pv-md-out { margin: 20px 0 0; }
.pv-md-out > h2 { font-size: 0.95rem; margin: 0 0 8px; }
.pv-md-out pre { max-height: 34vh; overflow: auto; }
.pv-loss { width: 100%; border-collapse: collapse; font-size: 0.84rem; margin: 10px 0 0; }
.pv-loss th, .pv-loss td { border: 1px solid var(--border); padding: 6px 9px; text-align: left; }
.pv-loss th { background: var(--bg-soft); font-weight: 600; }
.pv-loss td:first-child { color: var(--fg-dim); }
.pv-fm { margin: 16px 0 0; font-size: 0.84rem; color: var(--fg-dim); }
.pv-fm dl { display: grid; grid-template-columns: max-content 1fr; gap: 4px 14px; margin: 8px 0 0; }
.pv-fm dt { color: var(--fg-faint); font-size: 0.79rem; }
.pv-fm dd { margin: 0; font-family: var(--mono); font-size: 0.8rem; }
.pv-warn {
  background: var(--bg-soft); border: 1px solid var(--border); border-left: 3px solid var(--warn);
  border-radius: 6px; padding: 9px 12px; margin: 0 0 14px; font-size: 0.85rem; color: var(--fg);
}
.pv-note { border-left-color: var(--accent); }

/* ---------- 原型脚手架：测试点跳转 + 底部切换条 ---------- */
.pv-testbar { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin: 0 0 14px; }
.pv-testbar button {
  background: var(--bg-soft); color: var(--fg-dim); border: 1px dashed var(--border);
  border-radius: 999px; padding: 4px 12px; font-family: inherit; font-size: 0.82rem; cursor: pointer;
}
.pv-testbar button:hover { color: var(--accent); border-color: var(--accent); }
.pv-bar {
  position: fixed; bottom: 18px; left: 50%; transform: translateX(-50%);
  display: flex; align-items: center; gap: 10px;
  background: #0b0d11; color: #fff; border: 1px solid #2b3240;
  border-radius: 999px; padding: 6px 10px;
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.45);
  z-index: 50; font-size: 0.86rem; white-space: nowrap;
}
.pv-bar a {
  color: #fff; text-decoration: none; width: 30px; height: 30px;
  display: flex; align-items: center; justify-content: center;
  border-radius: 999px; background: rgba(255, 255, 255, 0.13);
}
.pv-bar a:hover { background: rgba(255, 255, 255, 0.26); text-decoration: none; }
.pv-bar-label { padding: 0 4px; }
.pv-bar-label b { font-weight: 650; }
.pv-bar-key { color: #9aa4b2; font-family: var(--mono); font-size: 0.76rem; }
body { padding-bottom: 96px; }

@media (max-width: 820px) {
  .pv-grid { grid-template-columns: 1fr; }
  .pv-bar { font-size: 0.78rem; gap: 6px; }
  .pv-bar-key { display: none; }
}
`
