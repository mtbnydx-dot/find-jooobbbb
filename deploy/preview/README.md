# 隔离预览部署

公网路径映射：

- `/test/`：旧运营与信息源界面。
- `/usertest/`：多用户产品/PWA。
- `/test/api/*` 与 `/usertest/api/v1/*`：只进入预览服务。
- 其他路径继续进入正式服务 `127.0.0.1:3000`。

预览服务监听 `127.0.0.1:3101`，使用 `/opt/job-tracker-preview/data`，并强制关闭云端调度器。它不能直接打开正式 `jobs.json`、`cloud.db`、`product.db` 或浏览器 profile。

首次部署先用 `create_preview_snapshot.js` 从正式数据目录生成一致性快照。脚本使用 SQLite `VACUUM INTO`，拒绝覆盖已有目标，并在副本中清空 DeepSeek API Key、关闭自动 AI、终止快照里的运行中任务。浏览器登录目录不会被复制。

安装 Caddy 配置前，先对候选文件执行 `caddy validate`。备份 `/etc/caddy/Caddyfile` 和 systemd 单元后再原子替换；部署失败时恢复这两个文件即可，正式应用目录与 3000 端口不需要回滚。

预览环境文件 `/etc/job-tracker-preview.env` 至少包含随机 `SYNC_TOKEN`、`PRODUCT_BOOTSTRAP_TOKEN` 和准确的 `PRODUCT_ADMIN_EMAILS`。文件权限应为 `0600`，不得提交到仓库。

`install_preview.sh` 只接受显式的发布包、SHA-256、release ID、systemd/Caddy 候选文件和快照工具路径。它先验证正式 3000 健康与 Caddy 配置，再安装新 release；首次初始化时生成独立管理员账号并只输出一次初始密码。它不会覆盖正式应用或正式数据。
