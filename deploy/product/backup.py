#!/usr/bin/env python3
"""Consistent SQLite backups plus application/configuration files; never deletes a backup."""
import hashlib,json,os,shutil,sqlite3,subprocess,tarfile,time,urllib.request
from pathlib import Path

def collector_state():
    with urllib.request.urlopen('http://127.0.0.1:3000/api/cloud/overview',timeout=10) as response:return json.load(response)

def backup():
    os.umask(0o077)
    base=Path('/var/backups/job-tracker');base.mkdir(mode=0o700,parents=True,exist_ok=True)
    if shutil.disk_usage(base).free<2*1024**3:raise RuntimeError('Backup refused: less than 2 GiB free')
    if collector_state().get('current',{}):
        current=collector_state().get('current') or {}
        if current.get('type')=='source':raise RuntimeError('Source publication active; retry backup later')
    stamp=time.strftime('%Y%m%dT%H%M%S');target=base/stamp;target.mkdir(mode=0o700)
    manifest={'createdAt':stamp,'databases':{},'files':{}}
    jobs=Path('/opt/job-tracker/data/jobs.json');before=jobs.read_bytes()
    def copy_db(source,destination):
        with sqlite3.connect(source) as src,sqlite3.connect(destination) as dst:
            src.backup(dst)
            assert dst.execute('PRAGMA quick_check').fetchone()[0]=='ok'
        manifest['databases'][str(source)]={'backup':str(destination.relative_to(target)),'sha256':hashlib.sha256(destination.read_bytes()).hexdigest()}
    for name,data in [('collector',Path('/opt/job-tracker/data')),('preview',Path('/opt/job-tracker-preview/data')),('product',Path('/var/lib/job-product'))]:
        dest=target/name;dest.mkdir()
        for item in data.iterdir():
            if item.is_file() and item.suffix=='.db':copy_db(item,dest/item.name)
            elif item.is_file() and not item.name.endswith(('-wal','-shm')):shutil.copy2(item,dest/item.name)
            elif item.is_dir():shutil.copytree(item,dest/item.name,symlinks=True)
    if jobs.read_bytes()!=before or (collector_state().get('current') or {}).get('type')=='source':raise RuntimeError('Catalog changed during backup; snapshot retained for diagnosis but not marked complete')
    json.loads((target/'collector/jobs.json').read_text())
    configs=target/'configuration';configs.mkdir()
    for item in [Path('/etc/job-tracker.env'),Path('/etc/job-tracker-preview.env'),Path('/etc/job-tracker-product.env'),Path('/etc/caddy/Caddyfile')]:shutil.copy2(item,configs/item.name)
    units=configs/'units';units.mkdir()
    for item in Path('/etc/systemd/system').glob('job-*.service'):shutil.copy2(item,units/item.name)
    for item in Path('/etc/systemd/system').glob('job-*.timer'):shutil.copy2(item,units/item.name)
    shutil.copytree('/var/www/exam',target/'exam')
    shutil.copy2('/var/lib/job-public/catalog.json',target/'catalog.json')
    for file in target.rglob('*'):
        if file.is_file() and not file.is_symlink():manifest['files'][str(file.relative_to(target))]=hashlib.sha256(file.read_bytes()).hexdigest()
    (target/'manifest.json').write_text(json.dumps(manifest,indent=2))
    archive=base/(stamp+'.tar.gz')
    with tarfile.open(archive,'w:gz') as stream:stream.add(target,arcname=stamp)
    certificate=Path('/etc/job-backup-public.pem')
    encrypted=None
    if certificate.exists():
        encrypted=base/(stamp+'.p7m')
        subprocess.run(['openssl','cms','-encrypt','-aes256','-binary','-outform','DER','-in',str(archive),'-out',str(encrypted),str(certificate)],check=True)
    result={'status':'complete','directory':str(target),'archive':str(archive),'encrypted':str(encrypted) if encrypted else '', 'sha256':hashlib.sha256((encrypted or archive).read_bytes()).hexdigest(),'databasesChecked':len(manifest['databases'])}
    (base/'latest.json').write_text(json.dumps(result))
    print(json.dumps(result))
if __name__=='__main__':backup()
