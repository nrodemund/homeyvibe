#!/bin/sh
set -eu

cd "$(dirname "$0")/../.."
fixture=$(mktemp -d)
project="hv-relay-test-$$"
network="$project-link"

cloud() {
  docker compose -p "$project-cloud" -f "$fixture/cloud/compose.yml" -f "$fixture/cloud/test-network.yml" "$@"
}

pi() {
  docker compose -p "$project-pi" --env-file "$fixture/pi/.env" -f "$fixture/pi/docker-compose.yml" \
    -f "$fixture/pi/relay/pi.compose.yml" -f "$fixture/pi/relay/test-network.yml" "$@"
}

cleanup() {
  result=$?
  if [ "$result" -ne 0 ]; then
    cloud logs || true
    pi logs || true
  fi
  pi down --volumes || true
  cloud down || true
  docker network rm "$network" || true
  rm -rf "$fixture"
}

trap cleanup EXIT
mkdir -p "$fixture/cloud" "$fixture/pi/relay/connector-credentials"
cp docker/relay/compose.yml docker/relay/frps.toml docker/relay/create-cloud-credentials.sh "$fixture/cloud/"
cp docker/relay/pi.compose.yml docker/relay/frpc.toml docker/relay/Caddyfile \
  docker/relay/install-web-certificate.sh "$fixture/pi/relay/"
cp docker-compose.yml "$fixture/pi/"
cat > "$fixture/pi/.env" <<'EOF'
HOMEYVIBE_PUBLIC_HOST=homeyvibe.test
HOMEYVIBE_PORT=127.0.0.1:8080
MQTT_URL=
EOF

# Put both stacks on a test-only link and expose the browser port on loopback.
cat > "$fixture/cloud/test-network.yml" <<EOF
services:
  relay:
    ports: !override ["127.0.0.1:443:8443"]
    networks:
      link:
        aliases: [homeyvibe.test]
networks:
  link:
    external: true
    name: $network
EOF
cat > "$fixture/pi/relay/test-network.yml" <<EOF
services:
  remote-connector:
    networks: [default, link]
networks:
  link:
    external: true
    name: $network
EOF

docker network create "$network"
sh "$fixture/cloud/create-cloud-credentials.sh"
cp "$fixture/cloud/cloud-credentials/control.crt" "$fixture/cloud/cloud-credentials/token" \
  "$fixture/pi/relay/connector-credentials/"
mkdir "$fixture/browser-cert"

issue_browser_cert() {
  openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj '/CN=homeyvibe.test' \
    -addext 'subjectAltName=DNS:homeyvibe.test' -keyout "$fixture/browser-cert/privkey.pem" \
    -out "$fixture/browser-cert/fullchain.pem"
  # The certificate hook targets the real deployment files in this project.
  COMPOSE_PROJECT_NAME="$project-pi" sh "$fixture/pi/relay/install-web-certificate.sh" "$fixture/browser-cert"
}

issue_browser_cert

cloud up -d
pi up -d server web remote-tls remote-connector

phone() {
  curl --noproxy '*' --resolve homeyvibe.test:443:127.0.0.1 \
    --cacert "$fixture/browser-cert/fullchain.pem" "$@"
}

url=https://homeyvibe.test
attempt=0
until phone -fsS --max-time 2 "$url/api/health" >/dev/null 2>&1; do
  attempt=$((attempt + 1))
  [ "$attempt" -lt 30 ]
  sleep 2
done
phone -fsS "$url/manifest.webmanifest" | jq -e '.name | contains("HomeyVibe")'

# Set up locally, then sign in through the tunnel and exercise cookie auth and SSE.
credentials='{"username":"relay-test","password":"local-test-password"}'
[ "$(phone -sS -o /dev/null -w '%{http_code}' -H 'Content-Type: application/json' -d "$credentials" \
  "$url/api/auth/setup")" -eq 403 ]
curl -fsS -H 'Content-Type: application/json' -d "$credentials" \
  http://127.0.0.1:8080/api/auth/setup | jq -e '.user.role == "admin"'
phone -fsS -c "$fixture/cookies" -D "$fixture/headers" -H 'Content-Type: application/json' -d "$credentials" \
  "$url/api/auth/login" | jq -e '.user.username == "relay-test"'
grep -qi '^set-cookie: hv_session=.*; Secure' "$fixture/headers"
phone -fsS -b "$fixture/cookies" "$url/api/auth/me" | jq -e '.username == "relay-test"'
phone -fsSN -b "$fixture/cookies" --max-time 3 -o "$fixture/events" "$url/api/events" || [ "$?" -eq 28 ]
grep -q '^event: snapshot' "$fixture/events"
phone -fsS -b "$fixture/cookies" -H "Origin: $url" -H 'Content-Type: application/json' -d '{}' \
  "$url/api/auth/logout" >/dev/null
[ "$(phone -sS -o /dev/null -w '%{http_code}' -b "$fixture/cookies" "$url/api/auth/me")" -eq 401 ]

# A new browser certificate is served through the same tunnel after reloading Caddy.
issue_browser_cert
phone -fsS "$url/api/health" | jq -e '.ok'
