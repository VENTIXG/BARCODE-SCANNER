#!/usr/bin/env bash
# The whole life of a server, for real, on this machine (Docker):
#   install.sh -> update -> a broken update rolled back automatically -> "check now" from the
#   app -> watchdog -> backup / restore -> password reset -> manual rollback -> repair install.
# A local web server plays GitHub Releases; three versions are built from this checkout.
#
#   sudo -E deploy/test/lifecycle.sh
#
# Needs root, Docker with buildx and compose, python3, curl, node.
# IMS_TEST_CA=<file>: extra CA certificate for npm inside the image build (proxies that re-sign TLS).
# KEEP=1 leaves everything running for inspection.
set -Eeuo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
WORK="$(mktemp -d /tmp/ims-lifecycle.XXXX)"
WWW="$WORK/www"
REL="$WWW/releases"
export IMS_HOME="$WORK/opt"
export COMPOSE_PROJECT_NAME=ims-lifecycle-test
WEB_PORT=18099
HTTP_PORT=18080
HTTPS_PORT=18443
DOMAIN=ims.test.local
ADMIN_PASSWORD='Lifecycle-admin-pass-1'
ARCH="$(uname -m | sed -e 's/x86_64/amd64/' -e 's/aarch64/arm64/')"
V1="$(node -p "require('$ROOT/package.json').version")"
IFS=. read -r MAJ MIN PAT <<<"$V1"
V2="$MAJ.$MIN.$((PAT + 1))"
V3="$MAJ.$MIN.$((PAT + 2))"
COOKIES="$WORK/cookies"
PASSED=0

step() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
ok() {
  PASSED=$((PASSED + 1))
  printf '\033[32m  ✔ %s\033[0m\n' "$*"
}
fail() {
  printf '\033[31m  ✘ %s\033[0m\n' "$*" >&2
  exit 1
}
check() { # DESCRIPTION COMMAND...
  local d="$1"
  shift
  if "$@"; then ok "$d"; else fail "$d"; fi
}
env_val() { grep -E "^$1=" "$IMS_HOME/.env" | tail -n1 | cut -d= -f2- | tr -d "'"; }
api() { # PATH [curl args]
  curl -sk --noproxy '*' --max-time 20 -b "$COOKIES" -c "$COOKIES" --resolve "$DOMAIN:$HTTPS_PORT:127.0.0.1" "https://$DOMAIN:$HTTPS_PORT/api$1" "${@:2}"
}
health_version() { api /health | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).version)}catch{console.log("down")}})'; }
login() { # USER PASSWORD -> HTTP status
  api /auth/login -o /dev/null -w '%{http_code}' -H 'Content-Type: application/json' -d "{\"username\":\"$1\",\"password\":\"$2\"}"
}
stock_of_test_product() {
  api "/products?q=LIFE-1" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const p=JSON.parse(s).data.find(x=>x.sku==="LIFE-1");console.log(p?p.quantity:"missing")}catch{console.log("error")}})'
}
update_json() { node -e "console.log(require('$IMS_HOME/state/update.json')['$1'])"; }
schema_now() {
  docker compose --project-directory "$IMS_HOME" --env-file "$IMS_HOME/.env" run --rm --no-deps -T --entrypoint node app -e \
    "const D=require('better-sqlite3');const db=new D('/data/inventory.db',{readonly:true});console.log(db.prepare('SELECT MAX(version) v FROM schema_migrations').get().v)" | tail -n1
}

cleanup() {
  local code=$?
  if [[ "${KEEP:-0}" == 1 ]]; then
    echo "KEEP=1: left running. IMS_HOME=$IMS_HOME"
  else
    (cd "$IMS_HOME" 2>/dev/null && docker compose --env-file .env down -v >/dev/null 2>&1) || true
    docker rmi "warehouse-ims:$V2" "warehouse-ims:$V3" >/dev/null 2>&1 || true
    [[ -n "${WEB_PID:-}" ]] && kill "$WEB_PID" 2>/dev/null || true
    if [[ -L /usr/local/bin/ims && "$(readlink /usr/local/bin/ims)" == "$IMS_HOME/ims" ]]; then rm -f /usr/local/bin/ims; fi
    if [[ -d /run/systemd/system ]]; then
      for u in ims-update.timer ims-watchdog.timer ims-request.path; do systemctl disable --now "$u" >/dev/null 2>&1 || true; done
      rm -f /etc/systemd/system/ims-*.{service,timer,path}
      systemctl daemon-reload || true
    fi
    rm -rf "$WORK"
  fi
  if ((code == 0)); then printf '\n\033[32mAll %d checks passed.\033[0m\n' "$PASSED"; else printf '\n\033[31mFailed (exit %d) after %d checks.\033[0m\n' "$code" "$PASSED"; fi
}
trap cleanup EXIT

[[ $EUID -eq 0 ]] || fail "run as root (sudo -E)"

publish_latest() { # VERSION
  mkdir -p "$REL/latest/download"
  cp "$REL/download/v$1/VERSION" "$REL/download/v$1/install.sh" "$REL/latest/download/"
}

release_from_image() { # VERSION: release files around an already built image
  local dir="$REL/download/v$1"
  mkdir -p "$dir"
  echo "$1" >"$dir/VERSION"
  cp "$REL/download/v$V1/install.sh" "$REL/download/v$V1/ims-server.tar.gz" "$dir/"
  docker save "warehouse-ims:$1" | gzip -1 >"$dir/ims-image-$ARCH.tar.gz"
  (cd "$dir" && sha256sum VERSION install.sh ims-server.tar.gz "ims-image-$ARCH.tar.gz" >SHA256SUMS)
}

step "Build release $V1 (this checkout) and test versions $V2 (good) and $V3 (broken)"
build_env=()
if [[ -n "${IMS_TEST_CA:-}" ]]; then
  mkdir -p "$WORK/ca"
  cp "$IMS_TEST_CA" "$WORK/ca/ca.crt"
  sed -E '/^FROM --platform=\$BUILDPLATFORM .* AS (build|deps)$/a COPY --from=ca ca.crt /tmp/extra-ca.crt\nENV NODE_EXTRA_CA_CERTS=/tmp/extra-ca.crt' \
    "$ROOT/Dockerfile" >"$WORK/Dockerfile"
  build_env=(IMS_DOCKERFILE="$WORK/Dockerfile" IMS_BUILD_ARGS="--build-context ca=$WORK/ca")
fi
env "${build_env[@]}" "$ROOT/deploy/build-release.sh" "$REL/download/v$V1" "linux/$ARCH" >/dev/null
check "release $V1 built" test -s "$REL/download/v$V1/ims-image-$ARCH.tar.gz"

docker build -q -t "warehouse-ims:$V2" - >/dev/null <<EOF
FROM warehouse-ims:$V1
USER root
RUN sed -i 's/"version": *"$V1"/"version": "$V2"/' /app/server/package.json
USER node
EOF
release_from_image "$V2"
cat >"$WORK/broken.js" <<'EOF'
// A release that upgrades the database and then crashes on every start.
const Database = require('better-sqlite3');
const db = new Database('/data/inventory.db');
db.prepare("INSERT OR IGNORE INTO schema_migrations (version, name) VALUES (99, 'broken_release')").run();
db.close();
console.error('simulated failure after upgrading the database');
process.exit(1);
EOF
docker build -q -t "warehouse-ims:$V3" -f - "$WORK" >/dev/null <<EOF
FROM warehouse-ims:$V1
USER root
RUN sed -i 's/"version": *"$V1"/"version": "$V3"/' /app/server/package.json
COPY broken.js /app/broken.js
USER node
CMD ["node", "/app/broken.js"]
EOF
release_from_image "$V3"
# The installer must download versions $V2/$V3, not find them already loaded.
docker rmi "warehouse-ims:$V2" "warehouse-ims:$V3" >/dev/null
python3 -m http.server "$WEB_PORT" --bind 127.0.0.1 --directory "$WWW" >/dev/null 2>&1 &
WEB_PID=$!
sleep 1

step "Install $V1 with install.sh (no questions)"
publish_latest "$V1"
curl -fsS "http://127.0.0.1:$WEB_PORT/releases/latest/download/install.sh" |
  DOMAIN="$DOMAIN" ADMIN_PASSWORD="$ADMIN_PASSWORD" IMS_RELEASES_URL="http://127.0.0.1:$WEB_PORT/releases" \
    HTTP_PORT="$HTTP_PORT" HTTPS_PORT="$HTTPS_PORT" IMS_TLS='tls internal' IMS_NO_OS_SETUP=1 bash -s -- --yes
check "HTTPS answers with version $V1" test "$(health_version)" == "$V1"
check "the web app loads over HTTPS" bash -c "curl -sk --noproxy '*' --resolve $DOMAIN:$HTTPS_PORT:127.0.0.1 https://$DOMAIN:$HTTPS_PORT/ | grep -q 'id=\"root\"'"
check "admin signs in with the password given to the installer" test "$(login admin "$ADMIN_PASSWORD")" == 200
check "the initial password is no longer kept in .env" test -z "$(env_val ADMIN_PASSWORD)"
check ".env is readable by root only" test "$(stat -c %a "$IMS_HOME/.env")" == 600
code="$(api /products -o /dev/null -w '%{http_code}' -H 'Content-Type: application/json' -d '{"sku":"LIFE-1","name":"Lifecycle product","initialQuantity":42}')"
check "a product with stock 42 is created" test "$code" == 201
check "live updates (server-sent events) pass through HTTPS" bash -c "curl -sk --noproxy '*' -N --max-time 3 -b $COOKIES --resolve $DOMAIN:$HTTPS_PORT:127.0.0.1 https://$DOMAIN:$HTTPS_PORT/api/events | grep -q 'retry: 2000'"
check "update status is shown to the admin (managed install)" bash -c "curl -sk --noproxy '*' -b $COOKIES --resolve $DOMAIN:$HTTPS_PORT:127.0.0.1 https://$DOMAIN:$HTTPS_PORT/api/system/update | grep -q '\"managed\":true'"

step "Automatic update to $V2"
publish_latest "$V2"
ims update --auto
check "now running $V2" test "$(health_version)" == "$V2"
check "the product and its stock are kept" test "$(stock_of_test_product)" == 42
check "a database copy was taken before the update" bash -c "ls '$IMS_HOME/data/backups/' | grep -q 'before-update-v${V2//./-}.db'"
check "status: updated" test "$(update_json lastResult)" == updated
check "previous version recorded" test "$(env_val IMS_PREVIOUS_VERSION)" == "$V1"
check "admin is still signed in after the update" test "$(api /auth/me -o /dev/null -w '%{http_code}')" == 200

step "\"Check for updates now\" from the app"
before="$(update_json lastCheckAt)"
sleep 1
code="$(api /system/update/check -o /dev/null -w '%{http_code}' -X POST)"
check "the app accepts the request" test "$code" == 202
if [[ -d /run/systemd/system ]]; then
  # systemd (ims-request.path) picks the request up by itself.
  for _ in $(seq 1 90); do
    [[ ! -f "$IMS_HOME/requests/update-now" && "$(update_json lastCheckAt)" != "$before" && "$(update_json state)" == idle ]] && break
    sleep 1
  done
else
  ims handle-request
fi
check "the request was handled" test ! -f "$IMS_HOME/requests/update-now"
check "a new check happened" test "$(update_json lastCheckAt)" != "$before"
check "result: up to date" test "$(update_json lastResult)" == up-to-date

step "Watchdog brings a stopped app back"
docker stop "$(docker compose --project-directory "$IMS_HOME" --env-file "$IMS_HOME/.env" ps -q app)" >/dev/null
ims watchdog >/dev/null
for _ in $(seq 1 60); do [[ "$(health_version)" == "$V2" ]] && break; sleep 2; done
check "the app runs again" test "$(health_version)" == "$V2"

step "Run install.sh again (repair): data and settings are kept"
jwt_before="$(env_val JWT_SECRET)"
curl -fsS "http://127.0.0.1:$WEB_PORT/releases/latest/download/install.sh" | IMS_NO_OS_SETUP=1 bash -s -- --yes >/dev/null
check "same JWT secret (nobody signed out)" test "$(env_val JWT_SECRET)" == "$jwt_before"
check "still $V2 and the data is there" test "$(health_version)/$(stock_of_test_product)" == "$V2/42"

step "Broken release $V3: upgrades the database, then never starts"
publish_latest "$V3"
if ims update --auto; then fail "the broken update should report failure"; fi
check "back on $V2 automatically" test "$(health_version)" == "$V2"
check "the database copy from before the update was restored (schema back to normal)" test "$(schema_now)" != 99
check "the product and its stock are intact" test "$(stock_of_test_product)" == 42
check "the upgraded database was kept as a copy too" bash -c "ls '$IMS_HOME/data/backups/' | grep -q 'before-rollback'"
check "status: rolled back" test "$(update_json lastResult)" == rolled-back
check "$V3 is skipped by automatic updates" test "$(env_val IMS_SKIP_VERSION)" == "$V3"
check "'ims rollback' would still go to $V1" test "$(env_val IMS_PREVIOUS_VERSION)" == "$V1"
ims update --auto
check "the next automatic check leaves $V3 alone" test "$(health_version)" == "$V2"

step "Backups: backup, restore, password reset"
out="$(ims backup)"
check "manual backup" bash -c "[[ '$out' == *_manual.db ]]"
copy="$(basename "$(compgen -G "$IMS_HOME/data/backups/*before-update-v${V2//./-}.db" | head -n1)")"
api /products -o /dev/null -H 'Content-Type: application/json' -d '{"sku":"LIFE-2","name":"Made after the copy","initialQuantity":1}'
ims restore "$copy" >/dev/null
check "the app is back after the restore" test "$(health_version)" == "$V2"
check "restore signed everyone out" test "$(api /auth/me -o /dev/null -w '%{http_code}')" == 401
check "admin signs in again" test "$(login admin "$ADMIN_PASSWORD")" == 200
check "the data from the copy is back (LIFE-1 = 42)" test "$(stock_of_test_product)" == 42
count="$(api '/products?q=LIFE-2' | grep -c 'LIFE-2' || true)"
check "LIFE-2 no longer exists" test "$count" == 0
temp="$(ims reset-password admin | sed -n 's/^Temporary password for admin: //p')"
check "reset-password prints a temporary password" test -n "$temp"
check "the old password no longer works" test "$(login admin "$ADMIN_PASSWORD")" == 401
check "the temporary password works" test "$(login admin "$temp")" == 200
check "and must be changed" bash -c "curl -sk --noproxy '*' -b $COOKIES --resolve $DOMAIN:$HTTPS_PORT:127.0.0.1 https://$DOMAIN:$HTTPS_PORT/api/auth/me | grep -q '\"mustChangePassword\":true'"

step "Manual rollback to $V1"
IMS_FORCE=1 ims rollback
check "running $V1" test "$(health_version)" == "$V1"
check "data intact after rollback" test "$(stock_of_test_product)" == 42
check "status: rolled back" test "$(update_json lastResult)" == rolled-back
