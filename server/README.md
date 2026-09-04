# Job Tracker 云服务

这是 `zlkjob.com` 的服务端目录。服务使用 Node.js 22、Express、SQLite 和 Playwright，负责岗位 API、无 API 文档采集、定时任务、提醒、面经搜索和静态前端。它不需要常驻 AI CLI。

## 运行要求

- Node.js 22.13 或更高版本。
- Chromium 及 Playwright 所需系统依赖。
- 一个可写且持久化的 `data/` 目录。
- 服务器能访问需要同步的文档和搜索网站。

## 本机启动

```bash
npm ci
npx playwright install chromium

PORT=3000 \
DATA_DIR=/tmp/job-tracker-dev \
SYNC_TOKEN=replace-me \
EDIT_PASSWORD= \
AI_EDIT_PASSWORD=replace-ai-password \
CLOUD_SCHEDULER=0 \
npm start
```

打开 `http://127.0.0.1:3000/app/`。产品模式下根路径会跳转到用户端，旧运营面位于 `/ops` 且只允许管理员。开发时关闭调度器，可以避免本机和生产环境重复执行定时任务。

同域隔离预览可以在构建前与启动时同时设置 `PRODUCT_PUBLIC_BASE=/usertest`、`OPS_PUBLIC_BASE=/test`、`PRODUCT_COOKIE_NAME=job_usertest_session`。此时用户端 API 为 `/usertest/api/v1`，运营端只调用 `/test/api`；`BIND_HOST=127.0.0.1` 可限制服务仅监听本机反向代理。未设置这些变量时仍保持 `/app`、`/ops`、`/api/v1` 和 `job_session` 的原有行为。

## 环境变量

| 变量 | 必需 | 说明 |
|---|---|---|
| `PORT` | 否 | HTTP 端口，默认 `3000` |
| `DATA_DIR` | 否 | 数据目录，默认 `server/data` |
| `SYNC_TOKEN` | 旧同步需要 | `/api/sync` Bearer token |
| `LEGACY_SYNC_ENABLED` | 否 | 默认关闭；仅设为 `1` 时开放旧 `/api/sync`，否则返回 `410` |
| `EDIT_PASSWORD` | 否 | 留空时写操作无需密码；设置后才要求校验 |
| `PRODUCT_ADMIN_EMAILS` | 生产必需 | 逗号分隔的管理员引导邮箱 |
| `PRODUCT_CONTENT_EDITOR_EMAILS` | 否 | 逗号分隔的内容编辑引导邮箱 |
| `PRODUCT_BOOTSTRAP_TOKEN` | 生产必需 | 配置邮箱首次注册并取得角色时必须同时提交的一次性令牌 |
| `LEGACY_ADMIN_ONLY` | 否 | 产品模式默认开启；保护 `/ops` 和旧岗位/来源/导出接口 |
| `AI_EDIT_PASSWORD` | 是 | 独立保护 AI 画像、连接测试、评估，以及会触发自动评估的手动采集；未配置时这些写操作关闭 |
| `CLOUD_SCHEDULER` | 否 | 设为 `0` 关闭调度，其他值开启 |
| `PLAYWRIGHT_BROWSERS_PATH` | Linux 推荐 | Chromium 安装目录 |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_SECURE` | 否 | 邮件服务器配置 |
| `SMTP_USER` / `SMTP_PASS` / `EMAIL_TO` | 否 | 邮件发送与接收配置 |

未配置邮件时，提醒仍会写入 `cloud.db` 并显示在运行中心。

首次管理员不能只从普通注册表单取得管理员角色，需要显式提交引导令牌：

```bash
curl -X POST http://127.0.0.1:3000/api/v1/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@example.com","displayName":"Admin","password":"replace-with-strong-password","bootstrapToken":"replace-with-bootstrap-token"}'
```

返回用户的 `role` 应为 `admin`。完成首个管理员引导后轮换 `PRODUCT_BOOTSTRAP_TOKEN`；之后可以在 `/app/admin/users` 人工授权其他用户。

## systemd 部署

```bash
sudo npx playwright install-deps chromium
sudo install -d -o job-tracker -g job-tracker /opt/job-tracker/.playwright-browsers
sudo -u job-tracker env \
  PLAYWRIGHT_BROWSERS_PATH=/opt/job-tracker/.playwright-browsers \
  npx playwright install chromium

sudo install -m 644 jobtracker.service /etc/systemd/system/job-tracker.service
sudo systemctl daemon-reload
sudo systemctl enable --now job-tracker
curl http://127.0.0.1:3000/api/health
```

把 `PORT`、`SYNC_TOKEN` 和 `AI_EDIT_PASSWORD` 放入 `/etc/job-tracker.env`；普通岗位需要密码门禁时再设置 `EDIT_PASSWORD`。旧同步默认关闭，迁移期确需使用时才临时配置 `LEGACY_SYNC_ENABLED=1`。服务单元以 `job-tracker` 用户运行，只允许写入 `/opt/job-tracker/data`。

升级时先备份应用、`data/`、环境文件和 systemd 单元，再替换代码并执行：

```bash
npm ci --omit=dev
sudo systemctl restart job-tracker
curl http://127.0.0.1:3000/api/health
```

前端资源经过 CDN 时，每次修改 `public/app.js` 都要同步更新 `public/index.html` 中的脚本版本参数，避免客户端继续使用旧缓存。

## Docker Compose

```bash
cp /dev/null .env
# 按 .env.example 设置 SYNC_TOKEN、AI_EDIT_PASSWORD、PRODUCT_ADMIN_EMAILS 和 PRODUCT_BOOTSTRAP_TOKEN；EDIT_PASSWORD 可选
docker compose up -d --build
docker compose exec job-tracker node jobctl.js doctor
```

Compose 仅把服务绑定到 `127.0.0.1:3000`，公网入口应由 Caddy、Nginx 或 Cloudflare 代理。`./data` 必须持久化。

## 定时任务

- 每个来源按照自己配置的布里斯班时间运行。
- 每天 08:00：DDL 与长期未更新投递提醒。
- 每天 21:30：已投递公司面经搜索。
- 所有浏览器任务走单并发队列，避免小内存服务器并发启动多个 Chromium。

## 运维 CLI

`jobctl.js` 通过 HTTP API 操作现有服务，不是后台常驻进程：

```bash
export JOBTRACKER_URL=http://127.0.0.1:3000
# 仅当服务器启用了编辑密码时需要
export JOBTRACKER_PASSWORD='网页操作密码'
node jobctl.js doctor
node jobctl.js sources
node jobctl.js runs 20
node jobctl.js run-all
node jobctl.js daily-check
node jobctl.js research
```

## 数据与恢复

- `data/jobs.json`：岗位和用户状态。
- `data/jobs.json.bak`：上一次岗位快照。
- `data/cloud.db`：来源、原始记录、运行、通知和面经。
- `data/product.db`：用户、会话、画像、私有岗位状态、套餐、用量和答题进度。
- `data/browser-profiles/`：飞书/腾讯登录会话。
- `data/log.jsonl`：操作摘要。

恢复时先停止服务，并恢复同一时间点的 `jobs.json` 与 `cloud.db`。SQLite 在线备份建议使用 `VACUUM INTO`，不要直接复制正在写入的 WAL 数据库。

## 验证

```bash
npm test
node --check server.js
node --check jobctl.js
curl http://127.0.0.1:3000/api/health
```

完整的架构、信息源配置和 API 清单见项目根目录 `README.md`。
