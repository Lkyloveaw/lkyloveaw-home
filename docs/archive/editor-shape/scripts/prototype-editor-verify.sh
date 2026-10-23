#!/usr/bin/env bash
# 抛弃式原型的冒烟验证（不属于产品，用完即删）：起原型服务 → HTTP 层逐条断言 → 关掉。
#
# ⚠ 一条踩过的坑：**中文不能走 argv**。Windows 上的 curl.exe 是原生程序，
# MSYS bash 传给它的参数会被转成系统代码页，中文直接烂掉（第一版 10 条红有 8 条是这个原因）。
# 所以凡是带中文的请求体一律**写文件**，用 curl 的 `name@file` 形式发；命令只出现在管道与文件里。
set -u
cd "$(dirname "$0")/.."

PORT=3199
BASE="http://127.0.0.1:$PORT"
ROUTE="$BASE/prototype/editor"
TMP="$(mktemp -d)"
PASS=0
FAIL=0

ok() { # ok <说明> <1|0>
  if [ "$2" = "1" ]; then echo "  PASS  $1"; PASS=$((PASS + 1)); else echo "  FAIL  $1"; FAIL=$((FAIL + 1)); fi
}
has() { case "$2" in *"$3"*) echo 1 ;; *) echo 0 ;; esac }
code_of() { curl -s -o "$TMP/body" -w '%{http_code}' "$1"; }

# 上一轮死不干净的话，这一轮会「跑的是旧代码」而看不出来 —— 先清端口，再起服务。
LEFT="$(netstat -ano | grep LISTENING | grep ":$PORT" | awk '{print $5}' | head -1)"
if [ -n "${LEFT:-}" ]; then
  echo "  端口 $PORT 被 pid=$LEFT 占着，先清掉（否则断言会打在旧进程上）"
  taskkill //F //PID "$LEFT" >/dev/null 2>&1
  sleep 1
fi

PROTOTYPE_PORT=$PORT node --import tsx src/prototype/editor-prototype.ts >"$TMP/server.log" 2>&1 &
PID=$!
trap 'kill $PID 2>/dev/null' EXIT

code=""
for _ in $(seq 1 60); do
  sleep 0.5
  code="$(code_of "$ROUTE" || true)"
  [ "$code" = "200" ] && break
done
echo "== 启动 =="
echo "  pid=$PID  首屏 HTTP $code  端口 $PORT"
if [ "$code" != "200" ]; then
  echo "  ---- 服务日志 ----"
  cat "$TMP/server.log"
  exit 1
fi

echo "== 变体 A：纯文本域 + 服务端预览 =="
code="$(code_of "$ROUTE?variant=A")"
cp "$TMP/body" "$TMP/a.html"
ok 'HTTP 200' "$([ "$code" = 200 ] && echo 1 || echo 0)"
ok 'data-variant=A' "$(has x "$(cat "$TMP/a.html")" 'data-variant="A"')"
ok '有 textarea（表单提交，无 JS 可用）' "$(has x "$(cat "$TMP/a.html")" 'id="pv-source" name="source"')"
ok '表单 POST 回同一路径' "$(has x "$(cat "$TMP/a.html")" 'method="post" action="/prototype/editor"')"
ok '服务端渲染出表格 <table>' "$(has x "$(cat "$TMP/a.html")" '<table>')"
ok '服务端渲染出 json 代码块（语言类名）' "$(has x "$(cat "$TMP/a.html")" 'class="language-json"')"
ok '图片引用被渲染成 <img>' "$(has x "$(cat "$TMP/a.html")" '<img src="/prototype/assets/sample-chart.svg"')"
ok '中文长文（加料段）真的在页面上' "$(has x "$(cat "$TMP/a.html")" '中文长段落')"
ok '底部悬浮切换条在' "$(has x "$(cat "$TMP/a.html")" 'class="pv-bar"')"
ok '状态面板在' "$(has x "$(cat "$TMP/a.html")" 'id="pv-stat-live"')"
ok 'front-matter 真解析：标签' "$(has x "$(cat "$TMP/a.html")" '运维 / 监控')"
ok '切换条左右是链接（无 JS 也能切）' "$(has x "$(cat "$TMP/a.html")" 'data-nav="prev"')"

echo "== 变体 B：分栏实时预览 =="
code="$(code_of "$ROUTE?variant=B")"
cp "$TMP/body" "$TMP/b.html"
ok 'data-variant=B' "$(has x "$(cat "$TMP/b.html")" 'data-variant="B"')"
ok '两栏网格 .pv-grid' "$(has x "$(cat "$TMP/b.html")" 'class="pv-grid"')"
ok '右栏有独立滚动容器' "$(has x "$(cat "$TMP/b.html")" 'id="pv-col-right"')"
ok '左栏 textarea 在' "$(has x "$(cat "$TMP/b.html")" 'id="pv-source"')"

echo "== 变体 C：富文本 =="
code="$(code_of "$ROUTE?variant=C")"
cp "$TMP/body" "$TMP/c.html"
ok 'data-variant=C' "$(has x "$(cat "$TMP/c.html")" 'data-variant="C"')"
ok 'contenteditable 编辑区' "$(has x "$(cat "$TMP/c.html")" 'contenteditable="true"')"
ok '工具栏（脚手架）在' "$(has x "$(cat "$TMP/c.html")" 'id="pv-toolbar"')"
ok '「存回 Markdown」按钮在' "$(has x "$(cat "$TMP/c.html")" 'id="pv-tomd"')"
ok '明说这一版必须 JS' "$(has x "$(cat "$TMP/c.html")" '这一版必须 JS')"
ok 'front-matter 六键无落点那条在' "$(has x "$(cat "$TMP/c.html")" '没有落点')"
ok '富文本区里没有 front-matter 的 --- 头' "$([ "$(has x "$(cat "$TMP/c.html")" 'title: 内网系统可用性看什么指标')" = 0 ] && echo 1 || echo 0)"

echo "== ?variant= 兜底 =="
code="$(code_of "$ROUTE?variant=Z")"
ok '未知 variant 回落 A' "$(has x "$(cat "$TMP/body")" 'data-variant="A"')"

echo "== A 的服务端往返（表单 POST，整页重渲染）=="
# 标记用 ASCII：argv 里只放文件名，正文走文件。
cp src/prototype/editor-sample.md "$TMP/src-a.md"
printf '\n%s\n' 'PROTO-MARK-ABC' >>"$TMP/src-a.md"
code="$(curl -s -o "$TMP/posted.html" -w '%{http_code}' -X POST "$ROUTE" \
  --data-urlencode 'variant=A' --data-urlencode "source@$(cygpath -w "$TMP/src-a.md")")"
ok 'POST 回同一路径得到 200' "$([ "$code" = 200 ] && echo 1 || echo 0)"
ok '提交的正文进了预览（服务端真的重渲染了）' "$(has x "$(cat "$TMP/posted.html")" 'PROTO-MARK-ABC')"
ok '回显带 data-source-from=posted' "$(has x "$(cat "$TMP/posted.html")" 'data-source-from="posted"')"

echo "== B 的实时预览端点（JSON）=="
code="$(curl -s -o "$TMP/preview.json" -w '%{http_code}' -X POST "$ROUTE/preview" \
  --data-urlencode "source@$(cygpath -w "$TMP/src-a.md")")"
PV="$(cat "$TMP/preview.json")"
ok 'HTTP 200' "$([ "$code" = 200 ] && echo 1 || echo 0)"
ok 'JSON 里有 html' "$(has x "$PV" '"html"')"
ok 'JSON 里有往返毫秒 ms' "$(has x "$PV" '"ms"')"
ok '渲染的是本次正文（含标记）' "$(has x "$PV" 'PROTO-MARK-ABC')"
ok '表格进了预览' "$(has x "$PV" '<table>')"
echo "  ---- 实测：/preview 的头部 ----"
echo "  $(echo "$PV" | head -c 200)…"

echo "== C 的「存回 Markdown」：拿真实渲染结果当富文本内容 =="
# 把 B 那个端点渲染出来的正文当成「用户在富文本里看到的 HTML」，原样存回去。
node -e 'const fs=require("fs");const j=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));fs.writeFileSync(process.argv[2],j.html)' \
  "$TMP/preview.json" "$TMP/wysiwyg.html"
echo "  富文本内容（就取渲染结果）：$(wc -c <"$TMP/wysiwyg.html") 字节"
code="$(curl -s -o "$TMP/md.json" -w '%{http_code}' -X POST "$ROUTE/md" \
  --data-urlencode "html@$(cygpath -w "$TMP/wysiwyg.html")")"
MD="$(cat "$TMP/md.json")"
ok 'HTTP 200' "$([ "$code" = 200 ] && echo 1 || echo 0)"
ok '转出了 ## 小标题' "$(has x "$MD" '## 状态不能只有两档')"
ok '转出了 GFM 表格' "$(has x "$MD" '| 指标 | 回答的问题 |')"
ok '转出了围栏代码块' "$(has x "$MD" '```')"
ok '转出了引用块' "$(has x "$MD" '> 如果只能留一个延迟指标')"
ok '转出了图片引用（第一版这里被吞掉了）' "$(has x "$MD" '![可用率曲线（样本图，不是真实数据）]')"
ok '转出了列表' "$(has x "$MD" '- **可用**' )"
ok '损失报告：front-matter 记为丢' "$(has x "$MD" 'front-matter（6 键元信息）')"
ok '损失报告：代码块语言标注记为丢' "$(has x "$MD" '代码块语言标注')"
ok '转换器自认「没有语言标注」' "$(has x "$MD" '没有语言标注')"
echo "  ---- 实测：损失报告（原样） ----"
echo "$MD" | tr ',' '\n' | grep -E '"(item|before|after|verdict|notes)"'
echo "  ---- 实测：存回的 Markdown 前 6 行 ----"
echo "$MD" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);console.log(j.markdown.split("\n").slice(0,6).map(l=>"  "+l).join("\n"))})'

echo "== C 的硬骨头：样本里没有、但真文章会有的东西 =="
cat >"$TMP/hard.html" <<'HTML'
<p>带样式的句子：<span style="color:#f2564d">这段是红的</span>，还有一个 <font color="red">font 标签</font>。</p>
<ul><li>一级<ul><li>二级</li></ul></li></ul>
<figure><img src="/x.png" alt="图"></figure>
HTML
code="$(curl -s -o "$TMP/hard.json" -w '%{http_code}' -X POST "$ROUTE/md" \
  --data-urlencode "html@$(cygpath -w "$TMP/hard.html")")"
HD="$(cat "$TMP/hard.json")"
ok 'HTTP 200' "$([ "$code" = 200 ] && echo 1 || echo 0)"
ok '内联样式被登记为丢（Markdown 没有等价写法）' "$(has x "$HD" '内联样式')"
ok '嵌套列表被登记为拍平' "$(has x "$HD" '嵌套列表被拍平')"
ok '不认识的标签被登记（figure）' "$(has x "$HD" 'figure')"
ok '但 figure 里的图片内容活下来了' "$(has x "$HD" '![图](/x.png)')"
echo "  ---- 实测：硬骨头的损失与自认 ----"
echo "$HD" | tr ',' '\n' | grep -E '"(notes|item|before|after|verdict)"'

echo "== 静态与边界 =="
code="$(code_of "$BASE/style.css")"
ok '产品样式表真的被伺服（页头页脚是真的）' "$([ "$code" = 200 ] && echo 1 || echo 0)"
code="$(code_of "$BASE/prototype/assets/sample-chart.svg")"
ok '样本图 200' "$([ "$code" = 200 ] && echo 1 || echo 0)"
ok '样本图是 svg' "$(has x "$(cat "$TMP/body")" '<svg')"
code="$(code_of "$BASE/")"
ok '/ 302 到原型路由' "$([ "$code" = 302 ] && echo 1 || echo 0)"
code="$(code_of "$BASE/nope")"
ok '未知路径 404' "$([ "$code" = 404 ] && echo 1 || echo 0)"

echo "== 服务器日志（应无异常）=="
cat "$TMP/server.log"

echo ""
echo "== 结果：$PASS 通过 / $FAIL 失败 =="
rm -rf "$TMP"
[ "$FAIL" = "0" ]
