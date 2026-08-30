"""部署服务器端 Excel 备份：装 xlsx 依赖 + 传 export_excel.js + server.js + 配 crontab 每日导出"""
import os, paramiko

HOST = "43.156.59.177"
PWD = os.environ["DEPLOY_PASSWORD"]
ROOT = "C:/Users/zlk/WorkBuddy/2026-08-06-22-26-21/job-sync/server"

cli = paramiko.SSHClient()
cli.set_missing_host_key_policy(paramiko.AutoAddPolicy())
cli.connect(HOST, port=22, username="ubuntu", password=PWD, timeout=15)

sftp = cli.open_sftp()
for lp, rp in [
    (os.path.join(ROOT, "server.js"), "/tmp/server.js"),
    (os.path.join(ROOT, "scripts", "export_excel.js"), "/tmp/export_excel.js"),
]:
    sftp.put(lp, rp); print("上传:", os.path.basename(lp))
sftp.close()

def run(cmd, timeout=120):
    _, out, err = cli.exec_command(f"echo '{PWD}' | sudo -S bash -c \"{cmd}\"", timeout=timeout)
    o = out.read().decode(errors="replace").strip()
    e = err.read().decode(errors="replace").strip()
    if o: print("[OUT]", o[:400])
    if e and "password" not in e.lower(): print("[ERR]", e[:300])
    return o

print("=== 传文件 + 装 xlsx ===")
run("cp /tmp/server.js /opt/job-tracker/server.js")
run("mkdir -p /opt/job-tracker/scripts && cp /tmp/export_excel.js /opt/job-tracker/scripts/export_excel.js")
run("cd /opt/job-tracker && npm install xlsx@https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz --omit=dev --no-audit --no-fund", timeout=300)
run("chown -R job-tracker:job-tracker /opt/job-tracker")

print("=== 配 crontab 每日 02:00 导出 Excel 备份 ===")
cron_line = "0 2 * * * cd /opt/job-tracker && /usr/bin/node scripts/export_excel.js >> /var/log/job-tracker-export.log 2>&1"
run(f"(crontab -l 2>/dev/null | grep -v 'export_excel'; echo '{cron_line}') | crontab -")
run("crontab -l | grep export_excel")

print("=== 立即跑一次导出 ===")
run("cd /opt/job-tracker && sudo -u job-tracker /usr/bin/node scripts/export_excel.js /opt/job-tracker/data/jobs-backup.xlsx")
run("ls -la /opt/job-tracker/data/jobs-backup.xlsx")

print("=== 重启服务 ===")
run("systemctl restart job-tracker")
import time
for i in range(8):
    time.sleep(1.5)
    o = run("curl -s -m 3 http://127.0.0.1:3000/api/health || echo FAIL")
    if '"ok":true' in o:
        print("健康:", o); break
print("ACTIVE:", run("systemctl is-active job-tracker"))
cli.close()
print("DONE")
