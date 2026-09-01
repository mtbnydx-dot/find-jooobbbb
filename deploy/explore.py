"""探查服务器环境（只读，不修改任何东西）"""
import os, sys, paramiko

HOST = os.environ["DEPLOY_HOST"]
USER = os.environ["DEPLOY_USER"]
PWD = os.environ["DEPLOY_PASSWORD"]

cli = paramiko.SSHClient()
cli.set_missing_host_key_policy(paramiko.AutoAddPolicy())
cli.connect(HOST, port=22, username=USER, password=PWD, timeout=15)

cmds = [
    ("hostname", "hostname && whoami && pwd"),
    ("node/npm", "node -v 2>&1; npm -v 2>&1"),
    ("docker", "docker --version 2>&1 | head -1"),
    ("systemd", "systemctl is-system-running 2>&1 | head -1"),
    ("sudo免密", "sudo -n true 2>&1 && echo SUDO_NOPASS || echo SUDO_NEED_PASS"),
    ("端口占用", "ss -tlnp 2>/dev/null | grep -E ':(3000|80|443)\\b' || echo NO_PORT_USE"),
    ("目录", "ls -ld /opt ~ 2>&1 | head -5"),
    ("磁盘", "df -h / | tail -1"),
]
for name, cmd in cmds:
    _, out, err = cli.exec_command(cmd, timeout=20)
    o = out.read().decode(errors="replace").strip()
    e = err.read().decode(errors="replace").strip()
    print(f"### {name}")
    if o: print(o)
    if e: print("ERR:", e)
cli.close()
print("DONE")
