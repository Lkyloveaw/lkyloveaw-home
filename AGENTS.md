## Agent skills

### Issue tracker

Issues live in this repo's GitHub Issues, driven with the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage roles keep their default label strings (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`), plus the `wayfinder:*` set. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one root `CONTEXT.md` for the ubiquitous language, decisions in `docs/adr/`. See `docs/agents/domain.md`.

### Deployment

唯一部署方式是**裸机 + systemd**；`docs/deploy-environment.md` 是部署事实的唯一真源（机器、路径、unit、已知坑）。

仓库里**没有** Docker 制品：`Dockerfile`、`docker-compose.yml`、`.dockerignore`、`scripts/check-docker-context.mjs`
已于 2026-10-22 删除，`npm run verify` 也不再包含 `check:docker`。历史决定文档里残留的
`Dockerfile:23-25` / `docker-compose.yml` 行号引用是**存档**——不要照做，也不要重新引入 Docker 部署。
