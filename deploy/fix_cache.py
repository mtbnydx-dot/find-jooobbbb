"""Caddy 加 no-cache 头防 Cloudflare 缓存旧前端"""
import os, paramiko

HOST = "43.156.59.177"
PWD = os.environ["DEPLOY_PASSWORD"]

caddyfile = """zlkjob.com www.zlkjob.com {
    reverse_proxy 127.0.0.1:3000
    encode gzip
    header {
        X-Content-Type-Options nosniff
        X-Frame-Options DENY
        Referrer-Policy no-referrer
        Cache-Control "no-cache, must-revalidate"
    }
    log {
        output file /var/log/caddy/job-tracker.log
    }
}
"""

TMPDIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".deploy-tmp")
os.makedirs(TMPDIR, exist_ok=True)
local = os.path.join(TMPDIR, "Caddyfile")
with open(local, "w", newline="\n") as f:
    f.write(caddyfile)

cli = paramiko.SSHClient()
cli.set_missing_host_key_policy(paramiko.AutoAddPolicy())
cli.connect(HOST, port=22, username="ubuntu", password=PWD, timeout=15)
sftp = cli.open_sftp()
sftp.put(local, "/tmp/Caddyfile")
sftp.close()

def run(cmd, timeout=30):
    _, out, err = cli.exec_command(f"echo '{PWD}' | sudo -S bash -c '{cmd}'", timeout=timeout)
    o = out.read().decode(errors="replace").strip()
    print(o[:400] if o else "(empty)")

run("cp /tmp/Caddyfile /etc/caddy/Caddyfile")
run("systemctl reload caddy")
import time
time.sleep(1)
run("systemctl is-active caddy")
print("=== 验证 no-cache 头 ===")
run("curl -sI http://127.0.0.1:3000/app.js | grep -i cache")
cli.close()
print("DONE")
