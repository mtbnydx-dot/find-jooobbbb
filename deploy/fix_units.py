"""修复 env 与 systemd 单元文件（SFTP 直传，避免 shell 转义问题）"""
import os, paramiko

HOST = os.environ["DEPLOY_HOST"]
USER = os.environ["DEPLOY_USER"]
PWD = os.environ["DEPLOY_PASSWORD"]
EDIT_PASSWORD = os.environ["EDIT_PASSWORD"]
SYNC_TOKEN = os.environ["SYNC_TOKEN"]

env = f"SYNC_TOKEN={SYNC_TOKEN}\nEDIT_PASSWORD={EDIT_PASSWORD}\nPORT=3000\nNODE_ENV=production\n"
unit = """[Unit]
Description=Job Tracker Sync Server
After=network-online.target

[Service]
Type=simple
User=job-tracker
Group=job-tracker
WorkingDirectory=/opt/job-tracker
EnvironmentFile=/etc/job-tracker.env
ExecStart=/usr/bin/node server.js
Restart=on-failure
RestartSec=5
UMask=0077
NoNewPrivileges=true
PrivateDevices=true
PrivateTmp=true
ProtectHome=true
ProtectSystem=strict
ProtectKernelModules=true
ProtectControlGroups=true
RestrictSUIDSGID=true
ReadWritePaths=/opt/job-tracker/data

[Install]
WantedBy=multi-user.target
"""
TMPDIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".deploy-tmp")
os.makedirs(TMPDIR, exist_ok=True)
with open(os.path.join(TMPDIR, "job-tracker.env"), "w", newline="\n") as f: f.write(env)
with open(os.path.join(TMPDIR, "job-tracker.service"), "w", newline="\n") as f: f.write(unit)

cli = paramiko.SSHClient()
cli.set_missing_host_key_policy(paramiko.AutoAddPolicy())
cli.connect(HOST, port=22, username=USER, password=PWD, timeout=15)

def run(cmd, timeout=60):
    _, out, err = cli.exec_command(f"echo '{PWD}' | sudo -S bash -c \"{cmd}\"", timeout=timeout)
    o = out.read().decode(errors="replace").strip()
    e = err.read().decode(errors="replace").strip()
    if o: print("[OUT]", o[:400])
    if e and "password" not in e.lower() and "sudo" not in e.lower()[:20]: print("[ERR]", e[:300])
    return o, e

sftp = cli.open_sftp()
sftp.put(os.path.join(TMPDIR, "job-tracker.env"), "/tmp/job-tracker.env")
sftp.put(os.path.join(TMPDIR, "job-tracker.service"), "/tmp/job-tracker.service")
sftp.close()

run("cp /tmp/job-tracker.env /etc/job-tracker.env && chmod 600 /etc/job-tracker.env")
run("cp /tmp/job-tracker.service /etc/systemd/system/job-tracker.service")
run("systemctl daemon-reload")
run("systemctl enable --now job-tracker")

import time
ok = False
for i in range(8):
    time.sleep(1.5)
    o, _ = run("curl -s -m 3 http://127.0.0.1:3000/api/health || echo FAIL")
    if '"ok":true' in o:
        print("健康检查通过:", o); ok = True; break
if not ok:
    run("systemctl status job-tracker --no-pager -l | head -25")
print("ACTIVE:", run("systemctl is-active job-tracker")[0])
cli.close()
print("FIX_DONE" if ok else "FIX_FAILED")
