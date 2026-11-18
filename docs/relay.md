# Access HomeyVibe from your phone

Run the relay in Docker on a public server. The Raspberry Pi opens an outbound tunnel to the relay, and your phone opens `https://home.example.com` in its browser. HomeyVibe handles sign-in on the Pi. The relay passes browser TLS through to the Pi, where the HTTPS private key stays. Your Pi needs no router port forwarding.

```text
Phone ── HTTPS (TCP 443) ──> Public Docker relay <── Outbound tunnel (TCP 7000) ── Pi
      └───────────────── Browser TLS terminates on the Pi ────────────────────────┘
```

## 1. Set up DNS

Choose a hostname such as `home.example.com`. Point its A record to your public server. Add an AAAA record if your server and firewall accept traffic on IPv6. Use DNS-only mode if your provider offers a proxy option.

Issue the certificate on the Pi using DNS validation. To prevent a server that controls the public IP from obtaining its own trusted certificate using port 443 or 80, set the following CAA records on the hostname and remove any other issuer records there. Keep the DNS credentials on the Pi.

| Name | Flag | Tag | Value |
|---|---|---|---|
| `home.example.com` | 0 | `issue` | `letsencrypt.org;validationmethods=dns-01` |
| `home.example.com` | 0 | `issuewild` | `;` |

See [Let's Encrypt DNS-01 validation](https://letsencrypt.org/docs/challenge-types/#dns-01-challenge) and [CAA record options](https://letsencrypt.org/docs/caa/).

## 2. Start the Docker relay on your public server

Allow inbound TCP **443** for phones and TCP **7000** for the Pi's connector. The relay Compose stack needs both ports available on the public server.

```sh
mkdir -p ~/homeyvibe-relay && cd ~/homeyvibe-relay
base=https://raw.githubusercontent.com/nrodemund/homeyvibe/main/docker/relay
for file in compose.yml frps.toml create-cloud-credentials.sh; do
  curl -fsSLO "$base/$file" || exit 1
done
sh create-cloud-credentials.sh
docker compose up -d
```

The script generates a unique tunnel token and a TLS certificate for the tunnel. Keep `cloud-credentials/control.key` on the public server. The Pi uses `control.crt` to verify the relay before presenting its token.

## 3. Connect the Raspberry Pi

Create your first HomeyVibe admin account over your home network. The remote address requires an existing account. Run these commands on the Pi from the folder containing your current `docker-compose.yml`. Replace `you@your-relay` with the public server's SSH login.

```sh
install -d -m 0700 relay/connector-credentials
base=https://raw.githubusercontent.com/nrodemund/homeyvibe/main/docker/relay
for file in pi.compose.yml frpc.toml Caddyfile install-web-certificate.sh; do
  curl -fsSL -o "relay/$file" "$base/$file" || exit 1
done
scp -p you@your-relay:homeyvibe-relay/cloud-credentials/control.crt relay/connector-credentials/
scp -p you@your-relay:homeyvibe-relay/cloud-credentials/token relay/connector-credentials/
```

Set `HOMEYVIBE_PUBLIC_HOST=home.example.com` in the Pi's existing `.env` file. Use the hostname alone.

Obtain a browser-trusted certificate with a DNS-01 client on the Pi. For example, with Certbot's Cloudflare plugin installed on the Pi and a DNS API token scoped to the relevant zone in `/root/.secrets/homeyvibe-dns.ini`, run this from your HomeyVibe folder:

```sh
sudo certbot certonly --dns-cloudflare \
  --dns-cloudflare-credentials /root/.secrets/homeyvibe-dns.ini \
  --cert-name home.example.com -d home.example.com \
  --deploy-hook "sh '$PWD/relay/install-web-certificate.sh'"
```

Use your provider's [DNS plugin](https://eff-certbot.readthedocs.io/en/stable/using.html#dns-plugins). Enable the client's automatic renewal. The Certbot hook installs renewed certificates and reloads the HTTPS container on the Pi. To use a certificate obtained another way, run `sh relay/install-web-certificate.sh /path/to/certificate-directory` on issuance and renewal. The directory must contain `fullchain.pem` and `privkey.pem`.

Start the optional services next to the already-running HomeyVibe app.

```sh
docker compose -f docker-compose.yml -f relay/pi.compose.yml up -d remote-tls remote-connector
docker compose -f docker-compose.yml -f relay/pi.compose.yml logs --tail=50 remote-connector
```

## 4. Open and install the PWA

On your phone, open `https://home.example.com` and sign in to HomeyVibe. Use your browser's **Install app** or **Add to Home Screen** option. Test over mobile data to verify the public route. Sign in and register passkeys on this hostname so they are available when you open the installed app.

## Maintenance

- When the Pi is offline, the relay cannot serve the app. The connector reconnects automatically when the Pi or the relay comes back.
- Update the relay on the public server with `docker compose pull && docker compose up -d`. On the Pi, run `docker compose -f docker-compose.yml -f relay/pi.compose.yml pull remote-tls remote-connector` and repeat the startup command. Check for new versions of the relay files when updating. The tunnel certificate generated by the script lasts for two years. Generate a fresh credential set in a separate folder and replace the files at both ends before restarting the relay and connector.
- To pause remote access from the Pi, run `docker compose -f docker-compose.yml -f relay/pi.compose.yml stop remote-connector`. Local access still works.
