#!/usr/bin/env bash
set -euo pipefail

archive=${1:?release archive path is required}
expected_sha256=${2:?release archive SHA-256 is required}
release_id=${3:?release id is required}
unit_candidate=${4:?systemd unit candidate is required}
caddy_candidate=${5:?Caddy candidate is required}
snapshot_helper=${6:?snapshot helper is required}

if [[ ! "$release_id" =~ ^[A-Za-z0-9._-]+$ ]]; then
  echo "invalid release id" >&2
  exit 2
fi

preview_root=/opt/job-tracker-preview
release_dir="$preview_root/releases/$release_id"
data_dir="$preview_root/data"
backup_dir="$preview_root/backups/$release_id"
environment_file=/etc/job-tracker-preview.env
service_unit=/etc/systemd/system/job-tracker-preview.service
caddy_file=/etc/caddy/Caddyfile
admin_email=admin@zlkjob.com

actual_sha256=$(sha256sum "$archive" | awk '{print $1}')
if [[ "$actual_sha256" != "$expected_sha256" ]]; then
  echo "release checksum mismatch" >&2
  exit 3
fi
if [[ -e "$release_dir" ]]; then
  echo "release already exists: $release_dir" >&2
  exit 4
fi

curl --fail --silent --show-error http://127.0.0.1:3000/api/health >/dev/null
caddy validate --config "$caddy_candidate"

install -d -m 0755 "$preview_root/releases" "$preview_root/backups" "$backup_dir"
install -d -o job-tracker -g job-tracker -m 0700 "$data_dir" "$data_dir/browser-home" "$preview_root/.playwright-browsers"
install -d -m 0755 "$release_dir"
tar -xzf "$archive" -C "$release_dir"
test -f "$release_dir/server.js"
test -f "$release_dir/package-lock.json"
test -f "$release_dir/public/app/index.html"

chown -R job-tracker:job-tracker "$release_dir"
sudo -u job-tracker npm ci --omit=dev --prefix "$release_dir"
sudo -u job-tracker env PRODUCT_PUBLIC_BASE=/usertest node "$release_dir/scripts/verify_product_build.js"
sudo -u job-tracker env \
  HOME="$data_dir/browser-home" \
  PLAYWRIGHT_BROWSERS_PATH="$preview_root/.playwright-browsers" \
  "$release_dir/node_modules/.bin/playwright" install chromium
sudo -u job-tracker env \
  HOME="$data_dir/browser-home" \
  PLAYWRIGHT_BROWSERS_PATH="$preview_root/.playwright-browsers" \
  node -e "require('$release_dir/node_modules/playwright').chromium.launch({headless:true}).then(async b=>{await b.close()})"
chown -R root:root "$release_dir"

first_data=0
if [[ ! -e "$data_dir/jobs.json" && ! -e "$data_dir/cloud.db" ]]; then
  first_data=1
  node "$snapshot_helper" /opt/job-tracker/data "$data_dir"
elif [[ ! -e "$data_dir/jobs.json" || ! -e "$data_dir/cloud.db" ]]; then
  echo "preview data is incomplete; refusing to guess recovery" >&2
  exit 5
fi
chown -R job-tracker:job-tracker "$data_dir"
chmod 0700 "$data_dir" "$data_dir/browser-home"

generated_ai_password=""
if [[ -e "$environment_file" ]]; then cp -a "$environment_file" "$backup_dir/job-tracker-preview.env"; fi
if [[ ! -e "$environment_file" ]]; then
  sync_token=$(openssl rand -hex 32)
  bootstrap_token=$(openssl rand -hex 32)
  ai_edit_password=${AI_EDIT_PASSWORD:-}
  if [[ -z "$ai_edit_password" ]]; then
    ai_edit_password=$(openssl rand -hex 24)
    generated_ai_password=$ai_edit_password
  fi
  umask 077
  printf '%s\n' \
    "SYNC_TOKEN=$sync_token" \
    "EDIT_PASSWORD=" \
    "AI_EDIT_PASSWORD=$ai_edit_password" \
    "PRODUCT_ADMIN_EMAILS=$admin_email" \
    "PRODUCT_CONTENT_EDITOR_EMAILS=" \
    "PRODUCT_BOOTSTRAP_TOKEN=$bootstrap_token" \
    >"$environment_file"
elif ! grep -Eq '^AI_EDIT_PASSWORD=.+' "$environment_file"; then
  ai_edit_password=${AI_EDIT_PASSWORD:-}
  if [[ -z "$ai_edit_password" ]]; then
    ai_edit_password=$(openssl rand -hex 24)
    generated_ai_password=$ai_edit_password
  fi
  sed -i '/^AI_EDIT_PASSWORD=/d' "$environment_file"
  printf 'AI_EDIT_PASSWORD=%s\n' "$ai_edit_password" >>"$environment_file"
fi
chown root:root "$environment_file"
chmod 0600 "$environment_file"

systemd-analyze verify "$unit_candidate"
if [[ -e "$service_unit" ]]; then cp -a "$service_unit" "$backup_dir/job-tracker-preview.service"; fi
cp -a "$caddy_file" "$backup_dir/Caddyfile"
previous_release=$(readlink -f "$preview_root/current" 2>/dev/null || true)
if [[ -n "$previous_release" ]]; then printf '%s\n' "$previous_release" >"$backup_dir/previous-release"; fi
if systemctl is-active --quiet job-tracker-preview.service; then systemctl stop job-tracker-preview.service; fi
tar --exclude='./browser-home' -czf "$backup_dir/data-before.tar.gz" -C "$data_dir" .
ln -sfn "$release_dir" "$preview_root/current"
install -m 0644 "$unit_candidate" "$service_unit"
systemctl daemon-reload
systemctl enable job-tracker-preview.service
systemctl restart job-tracker-preview.service

for _ in $(seq 1 30); do
  if curl --fail --silent http://127.0.0.1:3101/api/health >/dev/null; then break; fi
  sleep 1
done
curl --fail --silent --show-error http://127.0.0.1:3101/api/health >/dev/null

if [[ "$first_data" == 1 ]]; then
  admin_password="ZlK!$(openssl rand -hex 12)"
  bootstrap_token=$(sed -n 's/^PRODUCT_BOOTSTRAP_TOKEN=//p' "$environment_file")
  systemctl stop job-tracker-preview.service
  sudo -u job-tracker env \
    PRODUCT_ADMIN_EMAILS="$admin_email" \
    PRODUCT_BOOTSTRAP_TOKEN="$bootstrap_token" \
    PRODUCT_BOOTSTRAP_TOKEN_CONFIRM="$bootstrap_token" \
    PRODUCT_ADMIN_PASSWORD="$admin_password" \
    node "$release_dir/scripts/product_admin.js" \
      --data-dir "$data_dir" \
      --email "$admin_email" \
      --create \
      --password-env PRODUCT_ADMIN_PASSWORD \
      --display-name PreviewAdmin \
      --apply
  systemctl start job-tracker-preview.service
  printf 'PREVIEW_ADMIN_EMAIL=%s\n' "$admin_email"
  printf 'PREVIEW_ADMIN_PASSWORD=%s\n' "$admin_password"
fi
if [[ -n "$generated_ai_password" ]]; then printf 'PREVIEW_AI_EDIT_PASSWORD=%s\n' "$generated_ai_password"; fi

for _ in $(seq 1 30); do
  if curl --fail --silent http://127.0.0.1:3101/usertest/api/v1/plans >/dev/null; then break; fi
  sleep 1
done
curl --fail --silent --show-error http://127.0.0.1:3101/usertest/api/v1/plans >/dev/null
curl --fail --silent --show-error -H 'Accept: text/html' http://127.0.0.1:3101/usertest/jobs >/dev/null

install -m 0644 "$caddy_candidate" "$caddy_file"
if ! systemctl reload caddy; then
  install -m 0644 "$backup_dir/Caddyfile" "$caddy_file"
  systemctl reload caddy
  echo "Caddy reload failed; previous configuration restored" >&2
  exit 6
fi

curl --fail --silent --show-error http://127.0.0.1:3000/api/health >/dev/null
systemctl is-active --quiet job-tracker.service
systemctl is-active --quiet job-tracker-preview.service
systemctl is-active --quiet caddy
printf 'PREVIEW_RELEASE=%s\n' "$release_id"
printf 'PREVIEW_BACKUP=%s\n' "$backup_dir"
