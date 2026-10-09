#!/usr/bin/env bash
# Update the Warehouse IMS server to a version, or roll back to the previous one.
#
#   deploy/update.sh v1.1.0          # deploy tag v1.1.0 (or any branch/commit)
#   deploy/update.sh --rollback      # return to the version that was running before
#
# Steps for an update:
#   1. copy the database (VACUUM INTO) into the data volume's backups folder
#   2. check out the version, build the image
#   3. restart the app; the app copies the database again before it upgrades the schema
#   4. wait until /api/health answers with the new version
# If any step fails, the previous version is started again and, when the schema was
# upgraded, the database copy from step 1 is restored. Data entered after step 1 is lost
# in that case, so run updates when nobody is working.
set -euo pipefail

cd "$(dirname "$0")/.."
STATE_DIR=".deploy"
mkdir -p "$STATE_DIR"
LAST_GOOD="$STATE_DIR/last-good-ref"
BACKUP_NAME_FILE="$STATE_DIR/last-backup"

dc() { docker compose "$@"; }
in_app() { dc exec -T app node -e "$1"; }
log() { printf '\n== %s\n' "$*"; }

wait_healthy() {
  local tries=60
  for _ in $(seq 1 "$tries"); do
    if in_app "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/api/health').then(r=>r.ok?process.exit(0):process.exit(1)).catch(()=>process.exit(1))" 2>/dev/null; then
      return 0
    fi
    sleep 2
  done
  return 1
}

backup_database() {
  if ! dc ps --status running --services 2>/dev/null | grep -qx app; then
    echo "The app is not running. Start it first (docker compose up -d) so the database can be copied." >&2
    return 1
  fi
  local name="inventory_$(date -u +%Y-%m-%d_%H%M%S)_before-update.db"
  in_app "
    const fs=require('fs'),D=require('better-sqlite3');
    fs.mkdirSync('/data/backups',{recursive:true});
    const db=new D('/data/inventory.db',{readonly:true,fileMustExist:true});
    db.exec(\"VACUUM INTO '/data/backups/$name'\");
    db.close();
    console.log('/data/backups/$name');" >/dev/null || return 1
  echo "$name" > "$BACKUP_NAME_FILE"
  echo "$name"
}

schema_version_in() { # $1 = path inside the container
  in_app "const D=require('better-sqlite3');const db=new D('$1',{readonly:true});console.log(db.prepare('SELECT MAX(version) v FROM schema_migrations').pluck().get());db.close();"
}

restore_database() { # $1 = backup file name
  log "Restoring the database copy $1"
  dc stop app >/dev/null
  dc run --rm --no-deps --entrypoint sh app -c "cp '/data/backups/$1' /data/inventory.db && rm -f /data/inventory.db-wal /data/inventory.db-shm"
}

start_ref() { # $1 = git ref to build and start
  git checkout --quiet "$1"
  # IMS_NO_BUILD=1 starts an image that was already built (e.g. by CI and loaded on this host).
  if [[ "${IMS_NO_BUILD:-}" != "1" ]]; then dc build app; fi
  dc up -d app
}

rollback() {
  local previous; previous="$(cat "$LAST_GOOD" 2>/dev/null || true)"
  if [[ -z "$previous" ]]; then echo "No previous version recorded: nothing to roll back to." >&2; exit 1; fi
  log "Rolling back to $previous"
  if [[ -f "$BACKUP_NAME_FILE" ]]; then
    local backup; backup="$(cat "$BACKUP_NAME_FILE")"
    # An older program cannot read a database upgraded by a newer one, so restore the copy
    # only when the schema version differs from the copy's.
    local now before
    now="$(schema_version_in /data/inventory.db 2>/dev/null || echo 0)"
    before="$(schema_version_in "/data/backups/$backup" 2>/dev/null || echo 0)"
    if [[ "$now" != "$before" ]]; then
      restore_database "$backup"
    fi
  fi
  dc stop app >/dev/null 2>&1 || true
  start_ref "$previous"
  wait_healthy && echo "Rolled back and healthy." || { echo "Rollback started but the health check failed: see 'docker compose logs app'." >&2; exit 1; }
}

if [[ "${1:-}" == "--rollback" ]]; then
  rollback
  exit 0
fi

TARGET="${1:?usage: deploy/update.sh <tag|branch|commit> | --rollback}"
CURRENT="$(git rev-parse HEAD)"
echo "$CURRENT" > "$LAST_GOOD"

log "1/4 Fetching $TARGET"
git fetch --quiet --tags origin || true
git rev-parse --verify --quiet "$TARGET" >/dev/null || git rev-parse --verify --quiet "origin/$TARGET" >/dev/null || { echo "Unknown version: $TARGET" >&2; exit 1; }

log "2/4 Backing up the database"
BACKUP="$(backup_database)" || { echo "Backup failed. The update was not started." >&2; exit 1; }
echo "Copy saved as $BACKUP (in the ims-data volume, backups folder)."

log "3/4 Building and starting $TARGET"
set +e
start_ref "$TARGET"
start_status=$?
set -e
if [[ $start_status -eq 0 ]] && wait_healthy; then
  NEW_VERSION="$(in_app "fetch('http://127.0.0.1:4000/api/health').then(r=>r.json()).then(j=>console.log(j.version))")"
  log "4/4 Healthy: now running version $NEW_VERSION"
  echo "$TARGET" > "$STATE_DIR/current-ref"
  exit 0
fi

echo "The update failed. Returning to the previous version." >&2
rollback || true
exit 1
