#!/usr/bin/env bash
# Warehouse IMS: server installer.
# For a new cloud server (VPS) with Ubuntu 22.04/24.04 or Debian 12/13, x86_64 or arm64.
#
# On the server, as root (SSH):
#   curl -fsSL https://github.com/ventixg/barcode-scanner/releases/latest/download/install.sh | sudo bash
#
# Without questions, e.g. as "user data" (cloud-init) when the server is created:
#   #!/bin/bash
#   curl -fsSL https://github.com/ventixg/barcode-scanner/releases/latest/download/install.sh | DOMAIN=apothiki.example.gr ADMIN_PASSWORD='a long password' bash -s -- --yes
#
# Settings (environment variables):
#   DOMAIN            address of the app; its DNS A record must point to this server
#   ADMIN_PASSWORD    password of the first administrator "admin" (12+ characters); generated when empty
#   TZ                time zone (default Europe/Athens)
#   IMS_UPDATE_TIME   time of the nightly automatic update (default 03:30)
#   IMS_VERSION       install this version instead of the newest
# Options:
#   --yes             no questions
#   --lan             no domain: plain HTTP on port 80, only for a closed office network
#
# What it does: installs Docker, the app and HTTPS (Caddy + Let's Encrypt); daily backups;
# nightly automatic updates with backup and rollback; a check every 5 minutes that restarts
# the app if needed; automatic security updates of the operating system.
# Running it again repairs the installation and updates it. Data and settings are kept.
set -Eeuo pipefail
umask 022

export IMS_HOME="${IMS_HOME:-/opt/warehouse-ims}"
RELEASES_URL="${IMS_RELEASES_URL:-https://github.com/ventixg/barcode-scanner/releases}"
ENV_FILE="$IMS_HOME/.env"
YES=0
LAN=0

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
say() { printf '%s\n' "$*"; }
warn() { printf '\033[33mΠΡΟΣΟΧΗ:\033[0m %s\n' "$*" >&2; }
die() {
  printf '\033[31mΣΦΑΛΜΑ:\033[0m %s\n' "$*" >&2
  exit 1
}
has_tty() { [[ $YES -eq 0 ]] && (exec </dev/tty) 2>/dev/null; }
ask() { # PROMPT [default] -> REPLY
  REPLY=""
  if has_tty; then read -r -p "$1${2:+ [$2]}: " REPLY </dev/tty || true; fi
  REPLY="${REPLY:-${2:-}}"
}
env_get() {
  local v
  v="$(grep -E "^$1=" "$ENV_FILE" 2>/dev/null | tail -n1 | cut -d= -f2-)" || true
  [[ "$v" == \'*\' || "$v" == \"*\" ]] && v="${v:1:${#v}-2}"
  printf '%s' "$v"
}
random_hex() { od -An -N"$1" -tx1 /dev/urandom | tr -d ' \n'; }
random_password() {
  local alphabet='abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789' out='' i
  for i in $(seq 1 16); do
    out+="${alphabet:$(($(od -An -N2 -tu2 /dev/urandom | tr -d ' ') % ${#alphabet})):1}"
    ((i % 4 == 0 && i < 16)) && out+='-'
  done
  printf '%s' "$out"
}

# Everything runs inside main(): bash reads the whole file before running it, so nothing
# (docker, apt) can swallow the rest of the script from stdin when it is piped from curl.
main() {
  local arg
  for arg in "$@"; do
    case "$arg" in
      --yes | -y) YES=1 ;;
      --lan) LAN=1 ;;
      *)
        echo "Άγνωστη επιλογή: $arg" >&2
        exit 2
        ;;
    esac
  done

  [[ $EUID -eq 0 ]] || die "Τρέξτε τον εγκαταστάτη ως root: ... | sudo bash"

  bold "Warehouse IMS: εγκατάσταση server"

  # ---- Operating system and Docker -----------------------------------------------------------

  if [[ -r /etc/os-release ]]; then
    # shellcheck disable=SC1091
    . /etc/os-release
    case "${ID:-}" in
      ubuntu | debian) ;;
      *) warn "Δοκιμασμένο σε Ubuntu και Debian. Συνεχίζω σε ${PRETTY_NAME:-άγνωστο σύστημα}." ;;
    esac
  fi
  case "$(uname -m)" in x86_64 | amd64 | aarch64 | arm64) ;; *) die "Υποστηρίζονται μόνο x86_64 και arm64 servers." ;; esac

  if command -v apt-get >/dev/null; then
    export DEBIAN_FRONTEND=noninteractive
    missing=()
    for cmd in curl tar gzip flock sha256sum; do command -v "$cmd" >/dev/null || missing+=("$cmd"); done
    if ((${#missing[@]})); then
      say "Εγκατάσταση βασικών εργαλείων…"
      apt-get update -qq
      apt-get install -y -qq curl ca-certificates tar gzip util-linux coreutils >/dev/null
    fi
  fi

  if ! command -v docker >/dev/null; then
    say "Εγκατάσταση Docker…"
    curl -fsSL https://get.docker.com | sh >/dev/null || die "Η εγκατάσταση του Docker απέτυχε."
  fi
  if command -v systemctl >/dev/null && [[ -d /run/systemd/system ]]; then
    systemctl enable --now docker >/dev/null 2>&1 || true
  fi
  docker info >/dev/null 2>&1 || die "Το Docker δεν τρέχει."
  docker compose version >/dev/null 2>&1 || die "Λείπει το Docker Compose (docker compose). Εγκαταστήστε το docker-compose-plugin."

  # ---- Settings -----------------------------------------------------------------------------

  mkdir -p "$IMS_HOME"
  FRESH=1
  [[ -f "$ENV_FILE" ]] && FRESH=0

  if ((FRESH)); then
    if ((LAN)); then
      DOMAIN=":80"
    fi
    if [[ -z "${DOMAIN:-}" ]]; then
      say ""
      say "Η εφαρμογή χρειάζεται μια διεύθυνση (domain), π.χ. apothiki.etaireia.gr."
      say "Στον πάροχο του domain φτιάξτε μια εγγραφή DNS τύπου A που δείχνει στη διεύθυνση IP αυτού του server."
      ask "Διεύθυνση (domain)"
      DOMAIN="$REPLY"
    fi
    DOMAIN="${DOMAIN#http://}"
    DOMAIN="${DOMAIN#https://}"
    DOMAIN="${DOMAIN%%/*}"
    [[ -n "$DOMAIN" ]] || die "Χρειάζεται DOMAIN (ή --lan για τοπικό δίκτυο χωρίς domain)."
    if [[ "$DOMAIN" != ":80" && ! "$DOMAIN" =~ ^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)+$ ]]; then
      die "Μη έγκυρο domain: $DOMAIN"
    fi
    GENERATED_PASSWORD=0
    if [[ -z "${ADMIN_PASSWORD:-}" ]]; then
      ADMIN_PASSWORD="$(random_password)"
      GENERATED_PASSWORD=1
    fi
    ((${#ADMIN_PASSWORD} >= 12)) || die "Το ADMIN_PASSWORD πρέπει να έχει τουλάχιστον 12 χαρακτήρες."
    [[ "$ADMIN_PASSWORD" != *"'"* ]] || die "Το ADMIN_PASSWORD δεν μπορεί να περιέχει το σύμβολο '"
    COOKIE_SECURE=true
    [[ "$DOMAIN" == ":80" ]] && COOKIE_SECURE=false
    {
      echo "# Warehouse IMS settings. Change with care; apply with: sudo ims restart"
      echo "DOMAIN='$DOMAIN'"
      echo "COOKIE_SECURE='$COOKIE_SECURE'"
      echo "JWT_SECRET='$(random_hex 48)'"
      echo "ADMIN_PASSWORD='$ADMIN_PASSWORD'"
      echo "TZ='${TZ:-Europe/Athens}'"
      echo "SESSION_HOURS='12'"
      echo "IMS_AUTO_UPDATE='true'"
      echo "IMS_UPDATE_TIME='${IMS_UPDATE_TIME:-03:30}'"
      # Optional settings (tests, or ports already taken by another program).
      for key in IMS_RELEASES_URL HTTP_PORT HTTPS_PORT IMS_TLS; do
        if [[ -n "${!key:-}" ]]; then echo "$key='${!key}'"; fi
      done
    } >"$ENV_FILE"
    chmod 600 "$ENV_FILE"
  else
    say "Βρέθηκε υπάρχουσα εγκατάσταση στο $IMS_HOME: τα δεδομένα και οι ρυθμίσεις διατηρούνται."
    DOMAIN="$(env_get DOMAIN)"
    if [[ -z "${IMS_RELEASES_URL:-}" && -n "$(env_get IMS_RELEASES_URL)" ]]; then
      RELEASES_URL="$(env_get IMS_RELEASES_URL)"
    fi
  fi

  # ---- DNS check ----------------------------------------------------------------------------

  if [[ "$DOMAIN" != ":80" ]]; then
    public_ip="$(curl -fsS4 --max-time 10 https://api.ipify.org 2>/dev/null || curl -fsS4 --max-time 10 https://ifconfig.me 2>/dev/null || true)"
    dns_ip="$(getent ahostsv4 "$DOMAIN" 2>/dev/null | awk 'NR==1 {print $1}' || true)"
    if [[ -z "$dns_ip" ]]; then
      warn "Το $DOMAIN δεν έχει ακόμα εγγραφή DNS. Φτιάξτε εγγραφή A → ${public_ip:-IP του server}. Το HTTPS θα ενεργοποιηθεί μόλις ισχύσει (συνήθως σε λίγα λεπτά)."
    elif [[ -n "$public_ip" && "$dns_ip" != "$public_ip" ]]; then
      warn "Το $DOMAIN δείχνει στο $dns_ip, ενώ αυτός ο server είναι $public_ip. Διορθώστε την εγγραφή A. Το HTTPS θα ενεργοποιηθεί μόλις ισχύσει."
    else
      say "DNS: το $DOMAIN δείχνει σε αυτόν τον server ($dns_ip)."
    fi
  fi

  # ---- Download and start -------------------------------------------------------------------

  version="${IMS_VERSION:-}"
  if ((!FRESH)) && [[ -z "$version" ]]; then
    version="$(env_get IMS_VERSION)"
  fi
  if [[ -z "$version" ]]; then
    version="$(curl -fsSL --retry 3 --max-time 30 "$RELEASES_URL/latest/download/VERSION" | tr -d '[:space:]')" ||
      die "Δεν βρέθηκε η τελευταία έκδοση στο $RELEASES_URL"
  fi
  [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "Μη έγκυρη έκδοση: $version"
  bold "Έκδοση $version"

  dir="$IMS_HOME/releases/$version"
  mkdir -p "$dir"
  base="$RELEASES_URL/download/v$version"
  curl -fsSL --retry 3 --max-time 60 -o "$dir/SHA256SUMS" "$base/SHA256SUMS" || die "Η λήψη από $base απέτυχε."
  curl -fsSL --retry 3 --max-time 300 -o "$dir/ims-server.tar.gz" "$base/ims-server.tar.gz" || die "Η λήψη από $base απέτυχε."
  (cd "$dir" && grep -E ' \*?ims-server\.tar\.gz$' SHA256SUMS | sha256sum -c --status) || die "Ο έλεγχος SHA-256 του ims-server.tar.gz απέτυχε."
  tmp="$(mktemp -d)"
  tar -xzf "$dir/ims-server.tar.gz" -C "$tmp" ims
  install -m 755 "$tmp/ims" "$IMS_HOME/ims"
  rm -rf "$tmp"
  ln -sf "$IMS_HOME/ims" /usr/local/bin/ims
  grep -q '^IMS_VERSION=' "$ENV_FILE" || echo "IMS_VERSION='$version'" >>"$ENV_FILE"

  "$IMS_HOME/ims" bootstrap "$version"

  if ((FRESH)); then
    # The password is needed only to create the first administrator; it now lives (hashed) in the database.
    sed -i "s/^ADMIN_PASSWORD=.*/ADMIN_PASSWORD=''/" "$ENV_FILE"
  else
    # An existing installation also moves to the newest version.
    "$IMS_HOME/ims" update || warn "Η ενημέρωση στη νεότερη έκδοση δεν έγινε (δείτε παραπάνω)."
  fi

  # ---- Operating system: security updates, swap, firewall ------------------------------------

  if [[ "${IMS_NO_OS_SETUP:-0}" != 1 ]] && command -v apt-get >/dev/null; then
    say "Αυτόματες ενημερώσεις ασφαλείας του λειτουργικού…"
    apt-get install -y -qq unattended-upgrades >/dev/null 2>&1 || true
    cat >/etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
EOF
    cat >/etc/apt/apt.conf.d/52warehouse-ims <<'EOF'
// Warehouse IMS: restart at night when a security update needs it (the app starts by itself).
Unattended-Upgrade::Automatic-Reboot "true";
Unattended-Upgrade::Automatic-Reboot-Time "04:30";
EOF
    # Small servers: 2 GB swap so updates never run out of memory.
    mem_mb="$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)"
    if ((mem_mb < 2000)) && ! swapon --show | grep -q . && [[ ! -e /swapfile ]]; then
      say "Δημιουργία swap 2 GB (λίγη μνήμη RAM: ${mem_mb} MB)…"
      (fallocate -l 2G /swapfile || dd if=/dev/zero of=/swapfile bs=1M count=2048 status=none) &&
        chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile &&
        echo '/swapfile none swap sw 0 0' >>/etc/fstab || warn "Το swap δεν δημιουργήθηκε."
    fi
    if command -v ufw >/dev/null && ufw status 2>/dev/null | grep -q 'Status: active'; then
      ufw allow 80/tcp >/dev/null && ufw allow 443/tcp >/dev/null && ufw allow 443/udp >/dev/null
      say "Firewall (ufw): άνοιξαν οι θύρες 80 και 443."
    fi
  fi

  # ---- HTTPS check ---------------------------------------------------------------------------

  url="http://$(hostname -I 2>/dev/null | awk '{print $1}' || true)"
  if [[ "$DOMAIN" != ":80" ]]; then
    url="https://$DOMAIN"
    port="$(env_get HTTPS_PORT)"
    [[ -n "$port" && "$port" != 443 ]] && url="$url:$port"
    say "Έλεγχος HTTPS (έκδοση πιστοποιητικού, έως 1 λεπτό)…"
    ok=0
    for _ in $(seq 1 20); do
      if curl -fsS -o /dev/null --max-time 5 --noproxy "*" ${IMS_TLS:+-k} --resolve "$DOMAIN:${port:-443}:127.0.0.1" "$url/api/health" 2>/dev/null; then
        ok=1
        break
      fi
      sleep 3
    done
    if ((ok)); then
      say "HTTPS: λειτουργεί."
    else
      warn "Το HTTPS δεν απάντησε ακόμα. Συνήθως σημαίνει ότι το DNS δεν δείχνει ακόμα εδώ ή ότι ο πάροχος κλείνει τις θύρες 80/443 (firewall στον πίνακα ελέγχου του παρόχου). Η εφαρμογή ξαναδοκιμάζει μόνη της."
    fi
  fi

  if ((FRESH)) && has_tty; then
    ask "Ρύθμιση αντιγράφων ασφαλείας σε cloud storage τώρα; (ν/ο)" "ο"
    if [[ "$REPLY" =~ ^[νΝyY] ]]; then
      "$IMS_HOME/ims" offsite || warn "Μπορείτε να το ξαναδοκιμάσετε με: sudo ims offsite"
    fi
  fi

  say ""
  bold "Η εγκατάσταση ολοκληρώθηκε."
  say "  Διεύθυνση:  $url"
  if ((FRESH)); then
    say "  Χρήστης:    admin"
    if ((GENERATED_PASSWORD)); then
      bold "  Κωδικός:    $ADMIN_PASSWORD"
      say "  Σημειώστε τον κωδικό τώρα: δεν εμφανίζεται ξανά (νέος κωδικός: sudo ims reset-password admin)."
    else
      say "  Κωδικός:    αυτός που δώσατε στο ADMIN_PASSWORD"
    fi
  fi
  say ""
  say "  Κάθε υπολογιστής ανοίγει τη διεύθυνση σε Chrome ή Edge (ή στην εφαρμογή Windows: «Σύνδεση σε server»)."
  say "  Αυτόματα: backup κάθε μέρα, ενημέρωση κάθε βράδυ στις $(env_get IMS_UPDATE_TIME) με backup και επιστροφή αν κάτι πάει στραβά."
  say "  Εντολές:    sudo ims status | update | rollback | backup | restore | reset-password | offsite | logs"
}

main "$@"
