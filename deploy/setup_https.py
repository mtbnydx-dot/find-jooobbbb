"""配置 Caddy 反向代理 + HTTPS（Caddy 自动签 Let's Encrypt 证书）"""
import os, paramiko

HOST = "43.156.59.177"
PWD = os.environ["DEPLOY_PASSWORD"]

cli = paramiko.SSHClient()
cli.set_missing_host_key_policy(paramiko.AutoAddPolicy())
cli.connect(HOST, port=22, username="ubuntu", password=PWD, timeout=15)

def run(cmd, timeout=120):
    _, out, err = cli.exec_command(f"echo '{PWD}' | sudo -S bash -c \"{cmd}\"", timeout=timeout)
    o = out.read().decode(errors="replace").strip()
    e = err.read().decode(errors="replace").strip()
    if o: print("[OUT]", o[:500])
    if e and "password" not in e.lower(): print("[ERR]", e[:300])
    return o

print("=== 1/4 安装 Caddy ===")
run("command -v caddy && caddy version || (apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl 2>/dev/null; curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg; curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list; apt-get update -qq; apt-get install -y caddy)", timeout=300)

print("=== 2/4 写 Caddyfile ===")
caddyfile = """zlkjob.com www.zlkjob.com {
    reverse_proxy 127.0.0.1:3000
    encode gzip
    header {
        X-Content-Type-Options nosniff
        X-Frame-Options DENY
        Referrer-Policy no-referrer
    }
    log {
        output file /var/log/caddy/job-tracker.log
    }
}
"""
TMPDIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".deploy-tmp")
os.makedirs(TMPDIR, exist_ok=True)
local_caddy = os.path.join(TMPDIR, "Caddyfile")
with open(local_caddy, "w", newline="\n") as f:
    f.write(caddyfile)
sftp = cli.open_sftp()
sftp.put(local_caddy, "/tmp/Caddyfile")
sftp.close()
run("cp /tmp/Caddyfile /etc/caddy/Caddyfile && mkdir -p /var/log/caddy")

print("=== 3/4 放行 80/443（若安全组未放）===")
run("ss -tln | grep -E ':(80|443)\\b' || echo NO_80_443")

print("=== 4/4 启动 Caddy ===")
run("systemctl reload caddy 2>/dev/null || systemctl enable --now caddy", timeout=30)
import time
time.sleep(2)
run("systemctl is-active caddy")
run("caddy validate --config /etc/caddy/Caddyfile 2>&1 | tail -3", timeout=15)
cli.close()
print("CADDY_READY")
