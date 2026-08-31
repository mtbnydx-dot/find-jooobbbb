# 产品数据迁移与管理员恢复

本目录的两个工具用于产品化上线前的一次性迁移和账号恢复。它们都采用相同的保护边界：

- 默认是只读 `dry-run`，只有显式提供 `--apply` 才写库。
- 必须显式指定 `--data-dir`；不会猜测本机、容器或生产数据目录。
- 写入前使用 SQLite `VACUUM INTO` 生成一致性备份，成功后才开始事务。
- 没有实际变化时不重复生成备份；因此命令可以重复执行。
- 建议在 `--apply` 前停止产品服务，并保留 dry-run 的来源 SHA-256 和数量统计。
- 这些命令不会连接 SSH、HTTP API 或公网地址；只操作命令中明确给出的本地路径。

## 把旧 jobs.json 迁到指定用户

旧版本把所有人的投递状态放在同一个 `jobs.json`。多用户版本不能推断这些数据属于谁，因此迁移命令强制要求一个已经存在的精确邮箱：

```bash
node server/scripts/migrate_legacy_user.js \
  --data-dir /opt/job-tracker/data \
  --jobs-file /opt/job-tracker/data/jobs.json \
  --email owner@example.com \
  --expect-user-id usr_xxx
```

检查输出中的目标账号、来源哈希、旧岗位数、自选数、备注数、迁移前状态数和计划变更数。确认无误后，在服务停止期间增加 `--apply`：

```bash
node server/scripts/migrate_legacy_user.js \
  --data-dir /opt/job-tracker/data \
  --jobs-file /opt/job-tracker/data/jobs.json \
  --email owner@example.com \
  --expect-user-id usr_xxx \
  --apply
```

状态映射如下：

| 旧状态 | 产品状态 |
|---|---|
| 未投递 | `not_applied`；有备注或属于自选时为 `saved` |
| 已投递 | `applied` |
| 笔试 | `assessment` |
| 一面、二面 | `interview` |
| offer | `offer` |
| 挂 | `rejected` |

只迁移以下岗位：自选岗位、非“未投递”状态、存在个人备注或存在投递日期。普通的“未投递且无备注”目录岗位不会为用户创建无意义状态。

迁移内容包括：

- `job_states` 中该用户的收藏、状态、投递日期和备注。
- 自选岗位会标记 `saved=1`、`favorite=1`。
- 自选岗位完整快照会写入用户隔离的 `user_custom_jobs` 表，避免只保留 ID 后丢失公司、岗位、链接等详情。
- 产品岗位列表、详情和求职进度会只为该归属用户合并这些自选岗位；其他用户和公共岗位目录不会看到。
- 已存在的产品状态不会被旧状态强行降级；工具只补收藏/自选标记、缺失投递日期和尚未出现的旧备注。完全空白的产品状态可以由旧状态填充。
- 旧 `YYYY/MM/DD` 日期会转换成产品端使用的 `YYYY-MM-DD`。

执行成功会输出类似以下备份路径：

```text
/opt/job-tracker/data/backups/product.db.before-legacy-user-migration-20260831T....sqlite
```

如需回滚，停止服务，把当前 `product.db` 另行保留后，用该 SQLite 备份替换 `product.db`，再启动并核对目标用户的状态数。不要在服务运行且存在 WAL 写入时直接复制数据库文件。

`--json` 可输出机器可读的前后统计。重复执行同一来源时，计划应全部变成 `unchanged`，且不会产生新的备份。

## 管理员引导和角色恢复

角色不能从命令参数任意指定。目标邮箱必须出现在：

- `PRODUCT_ADMIN_EMAILS`（恢复为 `admin`），或
- `PRODUCT_CONTENT_EDITOR_EMAILS`（恢复为 `content_editor`）。

同时要求服务配置的 `PRODUCT_BOOTSTRAP_TOKEN` 与另一个确认环境变量中的值一致。这样只拿到数据库路径、或只改命令参数，都不能把任意邮箱提升为管理员。

现有账号先 dry-run：

```bash
export PRODUCT_ADMIN_EMAILS='admin@example.com'
export PRODUCT_BOOTSTRAP_TOKEN='replace-with-configured-token'
export PRODUCT_BOOTSTRAP_TOKEN_CONFIRM='replace-with-configured-token'

node server/scripts/product_admin.js \
  --data-dir /opt/job-tracker/data \
  --email admin@example.com
```

确认计划为 `restore-role` 后增加 `--apply`。若已经是目标角色，结果为 `unchanged`，不会写库或新建备份。

首次引导一个尚不存在的已配置邮箱，需要额外显式允许创建，并从环境变量读取初始密码：

```bash
export PRODUCT_ADMIN_PASSWORD='replace-with-initial-password'

node server/scripts/product_admin.js \
  --data-dir /opt/job-tracker/data \
  --email admin@example.com \
  --create \
  --password-env PRODUCT_ADMIN_PASSWORD \
  --display-name Admin \
  --apply
```

新账号会同时得到默认画像行和免费套餐。工具不会恢复已删除账号，也不会自动解除 suspended 状态；这两类操作需要单独审计后处理。

如不想使用默认的确认环境变量名，可通过 `--token-env SOME_OTHER_ENV` 指定。令牌和密码不会打印到输出中。

## 本机验证

```bash
node --check server/scripts/product_maintenance.js
node --check server/scripts/migrate_legacy_user.js
node --check server/scripts/product_admin.js
node --test test/product_maintenance.test.js
```
