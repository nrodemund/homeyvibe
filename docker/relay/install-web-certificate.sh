#!/bin/sh
set -eu

# Run as the certificate owner. Certbot sets RENEWED_LINEAGE for deploy hooks.
lineage=${1:-${RENEWED_LINEAGE:-}}
if [ -z "$lineage" ]; then
  printf '%s\n' 'Pass the directory containing fullchain.pem and privkey.pem.' >&2
  exit 1
fi

cd "$(dirname "$0")/.."
umask 077
mkdir -p relay/web-certificate
staging=$(mktemp -d relay/web-certificate/.renewal.XXXXXX)
trap 'rm -f "$staging/fullchain.pem" "$staging/privkey.pem"; rmdir "$staging"' EXIT
install -m 0644 "$lineage/fullchain.pem" "$staging/fullchain.pem"
install -m 0600 "$lineage/privkey.pem" "$staging/privkey.pem"
mv -f "$staging/fullchain.pem" "$staging/privkey.pem" relay/web-certificate/

compose() {
  docker compose -f docker-compose.yml -f relay/pi.compose.yml "$@"
}

running=$(compose ps --status running --services remote-tls)
if [ "$running" = remote-tls ]; then
  compose exec -T remote-tls caddy reload --force --config /etc/caddy/Caddyfile
fi
