# 职路 · 多用户求职平台

部署地址：[zlkjob.com](https://zlkjob.com)

这是一个完全运行在服务器上的多用户求职产品和岗位内容运营系统。服务器自己打开飞书、腾讯文档等查看链接，定时读取整表、合并去重并更新岗位目录；用户在 PC、Android 浏览器、iPhone/iPad Safari 和可安装 PWA 中管理自己的画像、求职进度、薪资偏好和备考记录。

系统不需要常驻 CLI AI 助手。采集、去重和规则初筛采用确定性的 Node.js 任务；可选的 DeepSeek API 只复评新岗位、内容变化或画像变化的岗位，`jobctl` 仍只是可选的运维命令行入口。

## 产品入口与边界

- `/app/`：注册、登录、画像、岗位推荐、进度、备考、薪资和套餐。
- `/app/admin/users`：管理员维护用户角色与人工套餐授权。
- `/ops`：仅管理员可进入的旧运营面，维护信息源、浏览器授权、运行记录和 DeepSeek。
- `/api/v1`：用户产品 API；旧 `/api/jobs`、`/api/cloud/*` 和导出接口在产品模式下只允许管理员访问。

当前 Free/Pro/Coach 权益、每日用量和到期回退由服务端执行；价格仍是产品假设。没有配置真实支付 provider 时，前端显示“暂未开放支付”，接口也不会伪造订单或成功状态。当前移动交付是响应式 Web/PWA，不代表已经发布 App Store 或 Google Play 原生应用。

## 当前能力

- 多信息源：飞书多维表格、腾讯文档、HTML 表格、JSON、Excel 下载链接。
- 无 API 查看链接：Playwright 浏览器直接读取页面；需要登录时，前端显示服务器浏览器截图，可扫码后复用会话。
- 云端调度：每个来源可配置多个布里斯班时间，例如 `10:00,22:00`。
- 单并发队列：避免多个浏览器任务同时抢内存；重复点击同一来源不会生成重复任务。
- 完整加载：飞书会等待 `recordsNum` 全部加载，避免只同步首批 200 条。
- 稳定身份：腾讯文档按整行内容指纹识别记录，不再把会随插行、排序变化的物理行号当作岗位身份。
- 合并去重：以公司、岗位和地点生成稳定 canonical key，同一岗位跨来源只显示一次，同时保留全部来源、个人状态和原始记录 ID；“信息源 → 整理去重”支持先预演再收敛历史重复项。
- AI 匹配：网页配置 DeepSeek Base URL、模型、API Key 和求职画像，输出 0-100 分、推荐等级、理由和风险；同一岗位内容、画像、模型未变化时直接命中 SQLite 缓存。
- 混合筛选：规则“符合条件”和“AI 推荐”是并列入口；AI 可仅处理候选岗位，也可评估全部活跃岗位。非强制任务会按每轮上限自动续跑，直到待处理数量归零。
- 独立状态：来源刷新不会覆盖投递状态、投递日期和个人备注。
- 生命周期：来源消失的岗位转为失效历史；移除来源时，仅由该来源提供的岗位不再出现在活跃看板。
- 定时提醒：每天 08:00 生成 7/3/1 天 DDL 和 14 天投递停滞摘要。
- 面经搜集：每天 21:30 为已投递公司搜索牛客/看准结果并保存到运行中心。
- Excel 导出：网页一键导出“岗位 / 信息源 / 运行记录”三个工作表。
- 重启恢复：中断的任务会标记失败，不会永远停在“运行中”；SQLite 使用 WAL，岗位 JSON 使用原子替换和备份恢复。
- PC/手机：岗位看板、信息源、运行中心均有响应式布局。
- 多用户产品：散列密码、Cookie/Bearer 会话、用户/内容编辑/管理员角色和私有数据隔离。
- 多元画像：多专业、岗位、行业、地点、技能、工作方式、限制条件和多币种薪资偏好。
- 用户匹配：按岗位方向、专业、技能、地点、行业、工作方式和薪资生成可解释分数与缺口；旧全局 AI 结果不会冒充用户个人结果。
- 求职闭环：收藏、阶段、下一步、提醒、私人备注、逾期排序和下线岗位历史。
- 备考闭环：8 条路径、24 道原创题、单选/多选/简答、逐题解析、真实进度和服务端配额。
- 薪酬洞察：只使用岗位库中有明确币种和周期的公开薪资样本；未知值不按 0 或默认币种参与比较。
- PWA：桌面/移动响应式布局、iOS 安全区、Android/iOS 图标、深链回退和构建资产离线壳。

## 架构

```text
飞书 / 腾讯文档 / 网页表格 / JSON / Excel 查看链接
                         |
                 Playwright 适配器
                         |
             单并发任务队列 + 定时调度
                         |
          原始快照 SQLite -> 规则分类器 -> 合并去重
                         |
         DeepSeek API（可选、分批、缓存、单队列）
                         |
      jobs.json（目录） + cloud.db（来源、运行、AI 结果）
                         |
          product.db（用户、画像、私有状态、权益、答题）
                         |
               Express API + React PWA
                         |
                 Caddy / zlkjob.com
```

## 目录

```text
server/
  server.js                 Express、岗位合并与 API
  jobctl.js                 可选运维 CLI
  cloud/
    adapters.js             飞书/腾讯/HTML/JSON/XLSX/面经适配器
    classifier.js           三分类、评分和 canonical 去重
    ai.js                   DeepSeek JSON 评分、校验、重试和内容哈希
    runtime.js              队列、调度、提醒、面经任务
    store.js                SQLite 来源与运行存储
    export.js               三工作表 Excel 导出
  public/                    网页前端
  product/                   多用户、权限、画像、匹配、权益与题库 API
  scripts/                   旧用户数据迁移与管理员恢复命令
  jobtracker.service        systemd 单元
  Dockerfile                包含 Chromium 的容器构建
local/                      旧 Excel 双向同步工具；服务端入口默认关闭
test/                       服务、云端和旧同步回归测试
web/                        React/Vite 响应式 PWA 用户端
docs/product/               产品蓝图、收费边界与发布路线图
```

## 本机验证

需要 Node.js 22.13 或更高版本。

```bash
npm ci
cd web
npm ci
npm run build
cd ..
cd server
npm ci
npx playwright install chromium
cd ..
npm test
```

旧状态、备注和自选岗位迁入指定产品账号前，先按 `server/scripts/README.md` 执行默认只读预演；确认账号、来源哈希和数量后才增加 `--apply`。迁移会先创建 SQLite 一致性备份，自选岗位只会合并到该归属用户的岗位列表、详情和进度中。

启动临时服务：

```bash
cd server
PORT=3300 \
DATA_DIR=/tmp/job-tracker-dev \
SYNC_TOKEN=local-sync-token-123456 \
EDIT_PASSWORD=local-edit-password \
PRODUCT_ADMIN_EMAILS=admin@example.com \
PRODUCT_BOOTSTRAP_TOKEN=local-bootstrap-token-123456 \
CLOUD_SCHEDULER=0 \
node server.js
```

打开 `http://127.0.0.1:3300/app/` 使用产品端。管理员先通过带 `bootstrapToken` 的注册 API 建立，再从 `/app/admin/users` 管理角色与套餐；运营面位于 `/ops`。

## 生产部署（systemd）

服务器需要 Node.js 22，并为 Chromium 安装系统依赖：

```bash
cd /opt/job-tracker
npm ci --omit=dev
sudo npx playwright install-deps chromium
sudo install -d -o job-tracker -g job-tracker /opt/job-tracker/.playwright-browsers
sudo -u job-tracker env \
  PLAYWRIGHT_BROWSERS_PATH=/opt/job-tracker/.playwright-browsers \
  npx playwright install chromium
```

`/etc/job-tracker.env`：

```dotenv
PORT=3000
NODE_ENV=production
SYNC_TOKEN=替换为现有同步令牌
# 默认关闭旧 /api/sync；仅迁移期确有需要时临时设为 1
LEGACY_SYNC_ENABLED=0
# 可选：留空或删除即允许直接编辑
EDIT_PASSWORD=可选网页操作密码
PRODUCT_ADMIN_EMAILS=admin@example.com
PRODUCT_CONTENT_EDITOR_EMAILS=editor@example.com
# 只在首次建立配置邮箱对应角色时使用；完成后应轮换
PRODUCT_BOOTSTRAP_TOKEN=替换为一次性随机令牌
LEGACY_ADMIN_ONLY=1
# 可选；也可以在网页“AI 匹配”中保存
DEEPSEEK_API_KEY=sk-...
```

可选邮件配置：

```dotenv
SMTP_HOST=smtp.example.com
SMTP_PORT=465
SMTP_SECURE=true
SMTP_USER=sender@example.com
SMTP_PASS=应用密码
EMAIL_TO=receiver@example.com
```

安装服务：

```bash
sudo install -m 644 jobtracker.service /etc/systemd/system/job-tracker.service
sudo systemctl daemon-reload
sudo systemctl enable --now job-tracker
curl http://127.0.0.1:3000/api/health
```

服务以 `job-tracker` 用户运行，浏览器会话放在 `data/browser-profiles/`，Chromium 放在 `.playwright-browsers/`。`jobtracker.service` 必须允许外网访问，否则服务器无法读取文档或搜索面经。

## 信息源配置

前端“信息源 → 添加信息源”支持：

| 类型 | 用途 | 常用附加配置 |
|---|---|---|
| 飞书 | 多维表格查看链接 | `tableId`，登录配置名 |
| 腾讯文档 | 在线表格查看链接 | 登录配置名；页面需允许复制 |
| 网页表格 | 普通 HTML `<table>` | `tableSelector`、`tableIndex` |
| JSON | 返回数组或 records/rows/jobs/data/items/list | 字段映射 |
| Excel | 可直接下载的 `.xlsx` 链接 | 工作表名称 |

字段名与默认飞书列不一致时，在“字段映射”中填写，例如：

```json
{
  "company": "企业名称",
  "position": "岗位名称",
  "location": "城市",
  "deadline": "截止日期",
  "url": "申请链接"
}
```

高级配置示例：

```json
{
  "settleMs": 5000,
  "dataTimeoutMs": 120000,
  "navigationTimeoutMs": 90000
}
```

## 运维 CLI

CLI 通过 HTTP API 工作，不是 AI 助手：

```bash
cd /opt/job-tracker
node jobctl.js doctor
node jobctl.js sources
node jobctl.js runs 20

export JOBTRACKER_URL=http://127.0.0.1:3000
# 仅当服务器配置了 EDIT_PASSWORD 时需要
export JOBTRACKER_PASSWORD='网页操作密码'
node jobctl.js run-all
node jobctl.js daily-check
node jobctl.js research
```

服务器未配置 `EDIT_PASSWORD` 时可直接运行写命令；配置后密码只从环境变量读取，不放到命令参数中。

## 主要 API

- `GET /api/health`：服务健康和活跃岗位数。
- `GET /api/jobs`、`GET /api/jobs/stats`：岗位和统计。
- `POST /api/jobs/:id/status`：状态与个人备注。
- `POST /api/jobs/:id/mark-custom`、`DELETE /api/jobs/:id`：自选管理。
- `GET/POST/PUT/DELETE /api/cloud/sources`：信息源管理。
- `POST /api/cloud/sources/:id/run`、`POST /api/cloud/run-all`：采集任务。
- `POST /api/cloud/reconcile`：历史重复和无有效来源岗位的预演/整理。
- `POST /api/cloud/sources/:id/login`：打开服务器浏览器登录会话。
- `GET /api/cloud/runs`：运行记录。
- `GET /api/cloud/ai`、`GET/PUT /api/cloud/ai/settings`：AI 状态与配置（读取接口不返回 Key 原文）。
- `POST /api/cloud/ai/test`、`POST /api/cloud/ai/run`：测试 DeepSeek 和排队运行 AI 评估。
- `GET /api/cloud/ai/runs`、`GET /api/cloud/ai/assessments`：AI 运行与评分结果。
- `POST /api/cloud/daily-check`、`POST /api/cloud/research`：提醒与面经。
- `POST /api/cloud/export.xlsx`：完整 Excel 导出。
- `POST /api/sync`：旧本地 Excel 同步；默认返回 `410`，仅 `LEGACY_SYNC_ENABLED=1` 时启用。

`EDIT_PASSWORD` 是可选开关：未配置时网页和 `jobctl` 写操作无需密码，配置后才校验。旧同步即使配置了 Bearer `SYNC_TOKEN` 也仍需显式开启 `LEGACY_SYNC_ENABLED=1`。

## 数据与回滚

- `data/jobs.json`：岗位、投递状态和个人备注。
- `data/jobs.json.bak`：上一个完整岗位版本。
- `data/cloud.db`：来源、原始快照、运行、通知、面经、AI 配置与评分缓存。
- `data/product.db`：用户、会话、画像、私有岗位状态、套餐、用量、题库与答题进度。
- `data/browser-profiles/`：飞书/腾讯登录会话。
- `data/log.jsonl`：不含密码的操作摘要。

升级前至少备份 `data/`、应用文件、systemd 单元和环境文件。SQLite 在线备份可使用 `VACUUM INTO`；恢复时先停止服务，再恢复同一时间点的 `jobs.json` 和 `cloud.db`。

## 已知边界

- 单进程写入，不要让多个服务副本同时使用同一 `data/`。
- 腾讯文档等页面结构变化时可能需要调整浏览器适配器；运行中心会保存明确失败原因。
- 邮件未配置时，提醒仍会保存在网页运行中心。
- DeepSeek 未配置或暂时不可用时，采集、去重、规则初筛和投递状态仍可独立运行。
- 来源提供的“备注/提示”与个人备注分开保存，后续同步不会覆盖个人内容。
