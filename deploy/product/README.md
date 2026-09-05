# 独立产品服务运维

正式产品读取经过字段白名单过滤的公共岗位目录，以自己的 `product.db` 保存账号、画像、投递与考试记录。原工作台仍是采集和全局 AI 的唯一执行者。不要让两个采集进程写同一份 `jobs.json`。

## 服务与数据

| 用途 | 服务 | 默认地址 | 数据 |
|---|---|---|---|
| 原工作台、采集、全局 AI | `job-tracker` | `127.0.0.1:3000` | `/opt/job-tracker/data` |
| 隔离预览 | `job-tracker-preview` | `127.0.0.1:3101` | `/opt/job-tracker-preview/data` |
| 正式产品 | `job-tracker-product` | `127.0.0.1:3201` | `/var/lib/job-product` |
| 公共目录 | `job-catalog-publish.service` | 无监听 | `/var/lib/job-public/catalog.json` |

产品账号使用独立 Linux 用户 `job-product`。正式服务不需要来源登录会话或 AI 密钥。公共目录不能包含个人备注、状态、收藏标记、全局画像、AI 解释或凭据。来源岗位被某人收藏后仍是公共岗位，只有真正私人新增的岗位不发布。

产品入口为 `/app/`、API 为 `/api/v1`；预览保留 `/usertest/` 和 `/test/`。Caddy 转发规则须保留原根工作台与独立 `/exam/`。后端端口只监听回环地址。

## 构建和发布

在仓库根目录运行：

```powershell
npm test
$env:OPS_PUBLIC_BASE='/app-ops'
npm run web:build
Remove-Item Env:OPS_PUBLIC_BASE
node server/scripts/verify_product_build.js
```

测试先在默认环境运行；路由测试中的默认运维入口为 `/ops`。预览构建需要 `PRODUCT_PUBLIC_BASE=/usertest`、`OPS_PUBLIC_BASE=/test`，应保存为单独发布物。构建完成后清除这些临时变量，避免预览产物覆盖正式产物。记录提交、构建参数、资源文件名和哈希。

后端依赖使用 `npm ci --omit=dev` 与服务器锁文件。发布包只携带代码和对应静态产物；不要包含数据目录、`.env`、密钥、浏览器 profile 或会话文件。若复用上一版本的 `node_modules`，先确认包清单与锁文件未变化。

1. 创建新 release 目录并部署代码；保留当前 release。
2. 通过 SQLite 在线备份保存正式 `product.db`，不能只复制运行中的 `.db` 而遗漏 WAL。
3. 使用独立数据副本、回环临时端口运行 canary；核对健康、公共目录和变更功能。
4. 先切预览，再切正式 `current` 符号链接，仅重启对应产品服务。
5. 核对公网 HTML、资源和 API；API 应 `no-store`，带内容哈希的资产应一年 `immutable`。Caddy 的默认缓存头不要覆盖应用已设置的缓存头。
6. 用临时测试账号验证隔离，并只清理此次创建且 ID 已记录的测试账号。不得使用真实账号做注销验收。

产品代码更新无需重启采集服务。AI 执行器代码更新需要让当前批次持久化后退出；重启后从持久任务恢复，不要手工清空任务表。

## 检查与恢复

```bash
systemctl status job-tracker job-tracker-preview job-tracker-product --no-pager
systemctl list-timers 'job-*' --all --no-pager
curl --fail http://127.0.0.1:3201/api/v1/health
python3 /opt/job-tracker-operations/health.py
```

健康检查覆盖服务可达性、磁盘余量、备份年龄、来源更新时间和 AI 暂停状态；仅在异常集合变化或恢复时写原工作台通知。它不代表公网端到端可用性，也不提供未配置的外部推送。

回退时将对应 `current` 链接切回记录中的上一 release，然后重启该产品服务并验证。保留当前数据库；不要用旧备份覆盖上线后的真实用户操作。本批数据库改动为新增结构，旧代码可以忽略；后续涉及破坏性 schema 变化时需重新评估回退。

若需撤回产品入口，只移除此次新增的 Caddy 产品匹配规则，先 `caddy validate` 再 reload。保留原工作台、预览和 `/exam/` 的规则。

## 备份

`job-tracker-backup.timer` 每天服务器时间 03:15 启动，随机延迟最多 5 分钟；`Persistent=true` 会补执行遗漏任务。当前部署服务器时区为 Asia/Shanghai。每次变更前另外备份。

备份使用 SQLite 在线备份与完整性检查，包含岗位、账号数据库、配置、浏览器会话、公共目录和独立考试文件，并保存逐文件 SHA-256 清单。采集正在发布或岗位文件在备份期间变化时，不标记为成功。

结果位于 `/var/backups/job-tracker`。存在 `/etc/job-backup-public.pem` 时，使用 OpenSSL CMS AES-256 生成 `.p7m` 加密副本。私钥必须独立保存且限制访问，不能上传到服务器或 Git。该目录仍含用于恢复的原始文件与归档，仅允许管理员访问。

```bash
systemctl start job-tracker-backup.service
cat /var/backups/job-tracker/latest.json
```

当前方案不自动删除备份，也不自动传输异地副本。磁盘检查会报告空间不足；保留周期和异地目标确定后再配置轮换、传输及其验收。每日备份不能宣称达到一小时 RPO。

恢复演练应在独立目录解密，校验 manifest 的全部哈希和数据库 `integrity_check`，核对岗位、个人记录和考试文件。验证后再安排服务切换，不能直接覆盖运行中的生产数据。

## 数据归属与外部能力

旧工作台的个人记录迁移工具默认 dry-run。必须明确正式账号邮箱并核对输出，再按指定归属执行；不要默认归给管理员。本轮用户明确要求继续保留在原工作台，迁移未执行。

站内提醒、邮件 outbox 和重试机制已具备；真实邮件需要配置发送渠道并完成真实送达验收。邮箱验证、找回密码、真实支付、外部告警、自动异地备份与完整移动设备测试仍需单独接入或验证。正式产品当前为画像规则匹配；原工作台全局 AI 结果不能作为正式账号的个人 AI 解释。
