# 秋招助手 · GitHub 上传包
# 包含完整项目文件，可直接上传

## 包含内容

- **README.md** — 完整项目文档（系统架构/功能/部署/使用/FAQ）
- **package.json / package-lock.json** — 根依赖（xlsx 0.20.3）
- **local/** — 本地同步脚本（sync.js）+ 配置模板
- **server/** — 服务器端完整代码（Express + 前端 + Docker + systemd）
- **scripts/** — 岗位导入/每日检查脚本
- **test/** — 服务端、云端采集和旧同步的自动化回归测试
- **deploy/** — 部署脚本（探索/安装/修复/HTTPS/缓存清理）

## 不包含（安全原因）

- `local/config.json` — 真实 token 和服务器 IP
- `server/data/` — 运行时数据
- `node_modules/` — 依赖目录
- `deploy/.deploy-tmp/` — 部署临时文件

## 上传方式

```bash
# 1. 在 GitHub 创建新仓库（如 job-hunting-assistant）
# 2. 本地打包
git clone https://github.com/你的用户名/job-hunting-assistant.git
cd job-hunting-assistant

# 3. 复制本目录所有文件（排除上述敏感文件）
# 4. 提交
git add .
git commit -m "Initial commit: 秋招助手全流程自动化系统"
git push
```

## 快速部署

见 README.md「本机验证」和「生产部署」章节。
