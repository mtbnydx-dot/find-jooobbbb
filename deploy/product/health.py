#!/usr/bin/env python3
"""Record actionable operational changes as persistent workbench notifications."""
import hashlib,json,shutil,sqlite3,subprocess,time,urllib.request
from datetime import datetime,timezone
from pathlib import Path

def check():
    problems=[]
    for name,port,endpoint in [('collector',3000,'/api/health'),('preview',3101,'/api/v1/health'),('product',3201,'/api/v1/health')]:
        try:
            with urllib.request.urlopen(f'http://127.0.0.1:{port}{endpoint}',timeout=8) as r:
                if not json.load(r).get('ok'):problems.append(name+' health failed')
        except Exception:problems.append(name+' unavailable')
    free=shutil.disk_usage('/').free
    if free<3*1024**3:problems.append('Disk free space below 3 GiB')
    # A deliberately disabled backup schedule is a policy state, not a failed job.
    backup_enabled=subprocess.run(['systemctl','is-enabled','--quiet','job-tracker-backup.timer'],capture_output=True).returncode==0
    latest=Path('/var/backups/job-tracker/latest.json')
    if backup_enabled and (not latest.exists() or time.time()-latest.stat().st_mtime>36*3600):problems.append('No verified backup in 36 hours')
    with sqlite3.connect('/opt/job-tracker/data/cloud.db',timeout=10) as db:
        now=datetime.now(timezone.utc)
        for name,last in db.execute("SELECT name,last_run_at FROM sources WHERE enabled=1 AND deleted_at IS NULL"):
            if not last or (now-datetime.fromisoformat(last.replace('Z','+00:00'))).total_seconds()>26*3600:problems.append(name+' has no completed collection in 26 hours')
        paused=db.execute("SELECT value FROM kv WHERE key='ai:paused'").fetchone()
        if paused and paused[0]:problems.append('AI paused: '+paused[0])
        key='ops:health-state';state=json.dumps(sorted(problems),ensure_ascii=False)
        previous=db.execute('SELECT value FROM kv WHERE key=?',(key,)).fetchone()
        if (previous[0] if previous else '[]')!=state:
            title='运行异常需要处理' if problems else '运行状态已恢复'
            body='\n'.join(problems) if problems else ('采集、产品服务和磁盘检查通过。' + ('备份检查通过。' if backup_enabled else '定时备份按设置保持停用。'))
            db.execute('INSERT INTO notifications(kind,title,body,created_at) VALUES(?,?,?,?)',('operations-health',title,body,now.isoformat()))
            db.execute('INSERT INTO kv(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at',(key,state,now.isoformat()))
    print(json.dumps({'ok':not problems,'problems':problems,'backupScheduled':backup_enabled,'freeGiB':round(free/1024**3,1)},ensure_ascii=False))
if __name__=='__main__':check()
