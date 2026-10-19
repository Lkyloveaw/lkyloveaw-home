# 多阶段构建：编译期装全量依赖，运行期只留生产依赖。
#
# 关于原生模块：better-sqlite3 v13 自带 N-API 预编译产物（prebuilds/linux-x64.node），
# 且 lockfile 中不含 install script，所以在 Linux 上 npm ci 不触发 node-gyp，
# 运行期镜像不需要保留编译器。这里显式验证预编译产物存在，缺失时构建即失败，
# 而不是等到容器启动才发现连不上数据库。
FROM node:22-bookworm-slim AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

# public/ 与 scripts/ 在 build 阶段就要在：
#   编辑器产物（public/article-editor.js）由 `npm run build` 生成，而构建脚本在 scripts/ 下。
COPY tsconfig.json ./
COPY src ./src
COPY public ./public
COPY scripts ./scripts
RUN npm run build

# ---------- 运行期 ----------
FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund \
 && node -e "require('better-sqlite3')(':memory:').prepare('select 1').get()" \
 && rm -rf /root/.npm

COPY --from=build /app/dist ./dist
# ⚠ 从 build 阶段取 public：编辑器产物是在那里生成的，宿主机上不一定有。
COPY --from=build /app/public ./public

# 挂载点：SQLite 历史库
RUN mkdir -p /app/data
VOLUME ["/app/data"]

ENV PORT=3000 \
    HOST=0.0.0.0 \
    DATABASE_PATH=/app/data/availability.sqlite \
    TARGETS_PATH=/app/targets.json

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/server.js"]
