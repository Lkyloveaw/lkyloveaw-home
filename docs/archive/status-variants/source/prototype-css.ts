/**
 * ⚠ 原型专用样式 —— 抛掷物，不要当成生产代码。
 *
 * 票：整站视觉原型 https://github.com/Lkyloveaw/lkyloveaw-home/issues/21
 * 计划：三个 `/status` 的**结构**变体，`?variant=` 切换，挂在已存在的路由上（sub-shape A）。
 *
 * 为什么**不**复用 `public/style.css`：那份样式正是这次要判定去留的东西，
 * 拿它渲染候选等于用旧答案给新问题投票。这里是一份干净的「项目样式系统」替身，
 * 只提供 token（颜色/字号/间距/字体），**不提供任何布局类** ——
 * 布局由每个变体自己决定，这样变体之间不会被共享的 Layout 拉平。
 *
 * 渲染：`src/prototype/status-variants.ts` 内联这段 CSS（原型阶段不引静态资源白名单）。
 * 生产环境永不加载：路由只在 `?variant=` 存在时走原型分支。
 */

export const PROTOTYPE_CSS = `
/* ── token：数据面终端化 + 正文面纸感化（B+C 混合） ─────────────── */
:root {
  color-scheme: light dark;
  --bg: #f6f6f3; --bg-soft: #fdfdfb; --bg-card: #ffffff;
  --border: #e2e2dc; --border-strong: #b3b3a8;
  --fg: #1d1f1c; --fg-dim: #5c605a; --fg-faint: #767b74;
  --accent: #1f6feb; --accent-fg: #ffffff;
  --ok: #1a7f45; --warn: #6b4600; --bad: #b3261e; --unknown: #767b74;
  --ok-bg: #e6f3ea; --warn-bg: #f7efdc; --bad-bg: #fbeae8;

  --fs-xs: 0.75rem; --fs-sm: 0.82rem; --fs-md: 0.9rem;
  --fs-lg: 1rem; --fs-xl: 1.2rem; --fs-2xl: 1.45rem; --fs-3xl: 1.9rem;

  --sp-1: 4px; --sp-2: 8px; --sp-3: 12px; --sp-4: 16px;
  --sp-5: 24px; --sp-6: 32px; --sp-7: 48px;

  --radius: 8px; --radius-sm: 5px; --wrap: 900px;

  --font-sans: -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans SC",
    "Microsoft YaHei", "PingFang SC", "Hiragino Sans GB", sans-serif;
  --font-mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas,
    "Liberation Mono", "Noto Sans Mono CJK SC", monospace;
  --font-serif: Georgia, "Times New Roman", "Songti SC", "Noto Serif SC",
    "Source Han Serif SC", "Source Han Serif CN", serif;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0e1013; --bg-soft: #14171b; --bg-card: #181c21;
    --border: #262b32; --border-strong: #384049;
    --fg: #e8eaed; --fg-dim: #a4abb5; --fg-faint: #878f98;
    --accent: #5b9dff; --accent-fg: #0b1016;
    --ok: #46d07d; --warn: #edc257; --bad: #ff6b5e; --unknown: #7d8794;
    --ok-bg: #12301f; --warn-bg: #33290f; --bad-bg: #3a1a17;
  }
}

/* ── 只有最薄的基底：盒模型、颜色、字体栈。没有 layout 类。 ───── */
*, *::before, *::after { box-sizing: border-box; }
body {
  margin: 0; background: var(--bg); color: var(--fg);
  font-family: var(--font-sans); font-size: var(--fs-lg); line-height: 1.6;
  padding-bottom: 84px; /* 给底部切换条留位置 */
}
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }
code, .mono { font-family: var(--font-mono); }
.tnum { font-variant-numeric: tabular-nums; }
.sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); }
.wrap { max-width: var(--wrap); margin: 0 auto; padding: 0 var(--sp-5); }

/* 站点头栏：三个变体共用（技能允许共享 Header，禁止共享 Layout） */
.site-header { border-bottom: 1px solid var(--border); background: var(--bg-soft); }
.site-header .wrap { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-4); min-height: 56px; flex-wrap: wrap; }
.brand { font-weight: 650; color: var(--fg); font-size: var(--fs-lg); }
.site-nav { display: flex; gap: 2px; flex-wrap: wrap; font-family: var(--font-mono); font-size: var(--fs-sm); }
.site-nav a { color: var(--fg-dim); padding: 5px 10px; border-radius: var(--radius-sm); }
.site-nav a[aria-current="page"] { color: var(--fg); background: var(--bg-card); }

/* 状态形状：**形状不同**，不是只有颜色不同（三档不许退化） */
.dot { display: inline-block; width: .72em; height: .72em; background: var(--unknown); flex: none; }
.dot.ok { background: var(--ok); border-radius: 50%; }
.dot.warn { background: var(--warn); border-radius: 1px; }
.dot.bad { background: var(--bad); clip-path: polygon(50% 0, 100% 100%, 0 100%); }
.dot.unknown { background: transparent; border: 1.5px solid var(--unknown); border-radius: 50%; }

/* ══════════════════════════════════════════════════════════════════
   变体 A · 值守台（wallboard）
   立意：一眼回答「现在什么坏了」。健康的目标不占版面。
   信息层级：故障 → 摘要 → 健康（折叠成一行）
   主操作：扫过
   ═════════════════════════════════════════════════════════════════ */
.va { font-family: var(--font-mono); }
.va-banner { padding: var(--sp-6) 0 var(--sp-5); border-bottom: 1px solid var(--border); }
.va-verdict {
  font-size: var(--fs-3xl); line-height: 1.15; font-weight: 650;
  letter-spacing: -0.01em; margin: 0 0 var(--sp-2);
  display: flex; align-items: center; gap: var(--sp-3);
}
.va-verdict.is-bad { color: var(--bad); }
.va-verdict.is-warn { color: var(--warn); }
.va-verdict.is-ok { color: var(--ok); }
.va-sub { color: var(--fg-dim); font-size: var(--fs-sm); margin: 0; }
.va-faults { padding: var(--sp-5) 0 0; }
.va-fault {
  display: grid; grid-template-columns: auto 1fr auto; gap: var(--sp-3);
  align-items: baseline; padding: var(--sp-3) 0; border-bottom: 1px solid var(--border);
}
.va-fault:last-child { border-bottom: 0; }
.va-fault-name { font-size: var(--fs-xl); font-weight: 600; }
.va-fault-why { color: var(--fg-dim); font-size: var(--fs-sm); margin-top: 2px; }
.va-fault-when { color: var(--fg-faint); font-size: var(--fs-xs); white-space: nowrap; }
.va-healthy {
  margin-top: var(--sp-5); padding: var(--sp-3) 0;
  border-top: 1px solid var(--border); color: var(--fg-dim); font-size: var(--fs-sm);
}
.va-healthy b { color: var(--fg); font-weight: 600; }
.va-foot { color: var(--fg-faint); font-size: var(--fs-xs); padding: var(--sp-4) 0 var(--sp-6); }

/* ══════════════════════════════════════════════════════════════════
   变体 B · 卡片墙（tiles）
   立意：每个系统是一份独立的小体检报告，可**横向比较**。
   信息层级：每卡自成一体 → 网格对齐
   主操作：扫 + 对比
   ═════════════════════════════════════════════════════════════════ */
.vb { font-family: var(--font-mono); }
.vb-strip {
  display: flex; gap: var(--sp-5); flex-wrap: wrap;
  padding: var(--sp-4) 0; margin-bottom: var(--sp-5);
  border-top: 1px solid var(--border); border-bottom: 1px solid var(--border);
}
.vb-strip div { display: flex; flex-direction: column; }
.vb-strip .k { color: var(--fg-faint); font-size: var(--fs-xs); }
.vb-strip .v { font-size: var(--fs-xl); font-variant-numeric: tabular-nums; }
.vb-strip .v.has-fault { color: var(--bad); }
.vb-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(268px, 1fr)); gap: var(--sp-4); }
.vb-card {
  background: var(--bg-card); border: 1px solid var(--border);
  border-radius: var(--radius); padding: var(--sp-4);
  display: flex; flex-direction: column; gap: var(--sp-2);
}
.vb-card.is-bad { border-left: 3px solid var(--bad); }
.vb-card.is-warn { border-left: 3px solid var(--warn); }
.vb-head { display: flex; align-items: baseline; gap: var(--sp-2); }
.vb-name { font-size: var(--fs-lg); font-weight: 600; margin: 0; font-family: var(--font-sans); flex: 1; min-width: 0; }
.vb-url { font-size: var(--fs-xs); color: var(--fg-faint); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* 状态徽标：形状（圆/方/三角）+ 文字，不只靠颜色。卡片头部用，变体 C 的标题栏也用。 */
.vb-badge {
  font-size: var(--fs-xs); padding: 1px 7px; border-radius: 999px; white-space: nowrap;
  border: 1px solid var(--border-strong); color: var(--fg-dim); font-family: var(--font-mono);
}
.vb-badge.ok { color: var(--ok); border-color: var(--ok); background: var(--ok-bg); }
.vb-badge.warn { color: var(--warn); border-color: var(--warn); background: var(--warn-bg); }
.vb-badge.bad { color: var(--bad); border-color: var(--bad); background: var(--bad-bg); }

/* 格带（从变体 C 搬进卡片）：**铺满卡宽**、格数固定，卡片之间可以横向比。
   ⚠ width 要扣掉 1px：卡片有 1px 边框，不算进去最后一格会换行。 */
.vb-cells { display: flex; gap: 1px; width: calc(100% - 1px); margin-top: var(--sp-1); }
.vb-cells i { flex: 1 1 0; min-width: 0; height: 18px; border-radius: 1px; background: var(--unknown); }
.vb-cells i.up { background: var(--ok); }
.vb-cells i.degraded { background: var(--warn); }
.vb-cells i.down { background: var(--bad); }
/* 缺数据：空心格。不是留白、也不是假装 up —— 那段时间库里就是没有记录。 */
.vb-cells i.is-none { background: transparent; box-shadow: inset 0 0 0 1px var(--border-strong); }
.vb-caption { margin: 0; font-size: var(--fs-xs); color: var(--fg-faint); font-variant-numeric: tabular-nums; }

.vb-chart { border-top: 1px solid var(--border); padding-top: var(--sp-2); margin-top: var(--sp-1); }
.vb-kv { display: grid; grid-template-columns: 1fr 1fr; gap: 2px var(--sp-3); margin: 0; font-size: var(--fs-xs); }
.vb-kv div { display: flex; justify-content: space-between; gap: var(--sp-2); }
.vb-kv dt { color: var(--fg-faint); }
.vb-kv dd { margin: 0; font-variant-numeric: tabular-nums; }

/* ══════════════════════════════════════════════════════════════════
   变体 C · 时间轴优先（timeline-first）
   立意：先看「什么时候出过事」，再看「是谁」。
   信息层级：一条共享时间轴（所有目标的行连成一片）→ 行内详情
   主操作：按时间定位
   ═════════════════════════════════════════════════════════════════ */
.vc { font-family: var(--font-mono); }
.vc-lede { display: flex; align-items: baseline; justify-content: space-between; gap: var(--sp-4); flex-wrap: wrap; padding: var(--sp-4) 0; }
.vc-lede h1 { font-size: var(--fs-xl); margin: 0; font-family: var(--font-sans); }
.vc-axis { display: grid; grid-template-columns: 132px 1fr; gap: var(--sp-3); align-items: center; padding: var(--sp-2) 0; }
.vc-axis .lbl { font-size: var(--fs-xs); color: var(--fg-faint); }
.vc-ticks { display: flex; justify-content: space-between; font-size: var(--fs-xs); color: var(--fg-faint); border-bottom: 1px solid var(--border); padding-bottom: 2px; }
.vc-rows { margin-top: var(--sp-3); }
.vc-row {
  display: grid; grid-template-columns: 132px 1fr 96px; gap: var(--sp-3);
  align-items: center; padding: var(--sp-2) 0; border-bottom: 1px solid var(--border);
}
.vc-row:last-child { border-bottom: 0; }
.vc-row-name { display: flex; align-items: center; gap: var(--sp-2); font-size: var(--fs-sm); font-family: var(--font-sans); }
.vc-row-meta { text-align: right; font-size: var(--fs-xs); color: var(--fg-dim); font-variant-numeric: tabular-nums; }
.vc-cells { display: flex; gap: 1px; height: 18px; }
.vc-cells i { flex: 1; background: var(--unknown); border-radius: 1px; }
.vc-cells i.up { background: var(--ok); }
.vc-cells i.degraded { background: var(--warn); }
.vc-cells i.down { background: var(--bad); }
.vc-incidents { margin-top: var(--sp-6); padding-top: var(--sp-4); border-top: 1px solid var(--border); }
.vc-incidents h2 { font-size: var(--fs-md); margin: 0 0 var(--sp-3); font-family: var(--font-sans); }
.vc-inc {
  display: grid; grid-template-columns: 132px 1fr auto; gap: var(--sp-3);
  padding: var(--sp-2) 0; border-bottom: 1px solid var(--border); font-size: var(--fs-sm);
}
.vc-inc:last-child { border-bottom: 0; }
.vc-inc .t { color: var(--fg-faint); font-size: var(--fs-xs); font-variant-numeric: tabular-nums; }

/* ══════════════════════════════════════════════════════════════════
   图表 —— src/charts.ts 的输出样式
   ⚠ 这些**必须**有：charts.ts 给 svg 加了 preserveAspectRatio="none"，
     意思是「按容器把 760×130 的 viewBox 拉伸铺满」。**没有固定高度它会被垂直拉爆。**
     --chart-h 让每个变体按自己的密度给高度（宽由容器决定）。
   ⚠ ⚠ 这段 CSS 整个是一个 TS 模板字符串：**注释里绝对不要出现反引号**，
     否则字符串被提前闭合，报的是一堆 TS1005/TS1127 语法错，而错误行号会指向注释后面。
     我第一版就在这里踩了（真踩了，服务根本起不来）。要强调就用「」或 '。
   ═════════════════════════════════════════════════════════════════ */
figure.chart { margin: 0; --chart-h: 110px; }
figure.chart svg { display: block; width: 100%; height: var(--chart-h); }
figure.chart figcaption {
  display: flex; justify-content: space-between; gap: var(--sp-3);
  font-family: var(--font-mono); font-size: var(--fs-xs); color: var(--fg-faint);
  margin-top: 2px;
}
.chart-axis {
  display: flex; justify-content: space-between;
  font-family: var(--font-mono); font-size: var(--fs-xs); color: var(--fg-faint);
}
.chart-empty {
  display: flex; align-items: center; justify-content: center;
  height: var(--chart-h); border: 1px dashed var(--border-strong); border-radius: var(--radius-sm);
  color: var(--fg-faint); font-size: var(--fs-xs); font-family: var(--font-mono);
}

/* 变体 B 的卡内小图压扁：卡要高密度，曲线只是趋势示意 */
.vb-chart figure.chart { --chart-h: 54px; }
.vb-chart .chart-axis { display: none; }
/* 变体 C 的共享时间轴给足高度：它是这个变体的主角 */
.vc-axis figure.chart { --chart-h: 92px; }

/* ══════════════════════════════════════════════════════════════════
   底部悬浮切换条（三个变体共用）—— 它**不是设计的一部分**
   ═════════════════════════════════════════════════════════════════ */
.pv-bar {
  position: fixed; left: 50%; bottom: 18px; transform: translateX(-50%);
  z-index: 9999; display: flex; align-items: center; gap: 2px;
  background: #111; color: #fff; border-radius: 999px;
  padding: 4px; box-shadow: 0 6px 24px rgb(0 0 0 / 35%);
  font-family: var(--font-mono); font-size: 13px;
  border: 1px solid rgb(255 255 255 / 18%);
}
.pv-bar a {
  color: #fff; text-decoration: none; padding: 5px 11px; border-radius: 999px;
  display: inline-flex; align-items: center; gap: 6px;
}
.pv-bar a:hover { background: rgb(255 255 255 / 14%); text-decoration: none; }
.pv-bar .mid { padding: 5px 12px; color: #fff; white-space: nowrap; }
.pv-bar .mid b { color: #ffd479; }
.pv-bar .kbd { color: rgb(255 255 255 / 45%); font-size: 11px; }
.pv-bar .off { color: rgb(255 255 255 / 40%); }
`
