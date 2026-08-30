"""上传新版 server.js / index.html / app.js 到生产服务器并重启服务"""
import os, paramiko

HOST = "43.156.59.177"
PWD = os.environ["DEPLOY_PASSWORD"]
ROOT = "C:/Users/zlk/WorkBuddy/2026-08-06-22-26-21/job-sync/server"

cli = paramiko.SSHClient()
cli.set_missing_host_key_policy(paramiko.AutoAddPolicy())
cli.connect(HOST, port=22, username="ubuntu", password=PWD, timeout=15)

sftp = cli.open_sftp()
for rel in ["server.js", "public/index.html", "public/app.js"]:
    lp = os.path.join(ROOT, rel.replace("/", os.sep))
    rp = "/tmp/" + rel.replace("/", "_")
    sftp.put(lp, rp)
    print("上传:", rel, "->", rp)
sftp.close()

def run(cmd, timeout=60):
    _, out, err = cli.exec_command(f"echo '{PWD}' | sudo -S bash -c \"{cmd}\"", timeout=timeout)
    o = out.read().decode(errors="replace").strip()
    e = err.read().decode(errors="replace").strip()
    if o: print("[OUT]", o[:300])
    if e and "password" not in e.lower(): print("[ERR]", e[:300])
    return o

run("cp /tmp/server.js /opt/job-tracker/server.js")
run("cp /tmp/public_index.html /opt/job-tracker/public/index.html")
run("cp /tmp/public_app.js /opt/job-tracker/public/app.js")
run("chown job-tracker:job-tracker /opt/job-tracker/server.js /opt/job-tracker/public/index.html /opt/job-tracker/public/app.js")
run("systemctl restart job-tracker")
import time
for i in range(8):
    time.sleep(1.5)
    o = run("curl -s -m 3 http://127.0.0.1:3000/api/health || echo FAIL")
    if '"ok":true' in o:
        print("健康检查:", o); break
else:
    run("systemctl status job-tracker --no-pager -l | head -20")
print("ACTIVE:", run("systemctl is-active job-tracker"))
print("自定义 API 引用数:", run("grep -c applyCustomAdd /opt/job-tracker/server.js"))

# 清 Cloudflare 缓存（前端文件更新后必须，否则域名版看到旧版）
print("=== 清 Cloudflare 缓存 ===")
CF_ZONE = os.environ.get("CF_ZONE_ID", "")
CF_TOKEN = os.environ.get("CF_API_TOKEN", "")
if CF_ZONE and CF_TOKEN:
    import urllib.request, json as _json
    req = urllib.request.Request(
        f"https://api.cloudflare.com/client/v4/zones/{CF_ZONE}/purge_cache",
        data=_json.dumps({"purge_everything": True}).encode(),
        headers={"Authorization": f"Bearer {CF_TOKEN}", "Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            print("CF 缓存已清:", resp.status)
    except Exception as e:
        print("CF 清缓存失败:", e)
else:
    print("提示：未配置 CF_ZONE_ID/CF_API_TOKEN，跳过缓存清理（域名版可能延迟更新）")

cli.close()
print("DEPLOY_DONE")
