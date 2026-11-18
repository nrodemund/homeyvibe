# Remote access through your own relay

Run a Tailscale peer relay in Docker on your public server. Install Tailscale on the Pi and the phones or computers that need access, and join them to the same tailnet. HomeyVibe still handles its own login and device permissions. WireGuard encrypts traffic between the endpoints, and Tailscale Serve on the Pi provides the HTTPS address for the browser. [Tailscale peer relays](https://tailscale.com/docs/features/peer-relay)

## Public server

Use a Linux host that can accept UDP 40000. Add the tags in the policy below first, then create a one-time Tailscale auth key for `tag:homeyvibe-relay`. Copy [the relay Compose file](../docker/relay/compose.yml) to a folder on that host and set `TS_AUTHKEY` in a private `.env` file next to it. Run these commands in that folder.

```sh
docker compose up -d
docker compose exec relay tailscale status
docker compose exec relay tailscale set --relay-server-port=40000
```

The volume preserves the relay's node identity after enrollment. Remove the spent auth key from `.env` after `tailscale status` lists the relay. If the cloud provider uses a separate public IP, add `--relay-server-static-endpoints=<public-ip>:40000` to the `tailscale set` command.

## Raspberry Pi

Install and sign in to Tailscale on the Pi. Tag the Pi `tag:homeyvibe-pi` and enable HTTPS certificates for your tailnet. With HomeyVibe's usual port 80, run:

```sh
sudo tailscale serve --bg http://127.0.0.1:80
tailscale serve status
```

If your HomeyVibe Compose folder uses a different `HOMEYVIBE_PORT`, use that port in the Serve command. Open the HTTPS address printed by Serve on your connected phone or computer, then sign in to HomeyVibe. Use that address to install the web app or register passkeys.

## Tailnet permissions

Add these entries to the existing policy. Replace `group:homeyvibe` with your own group or member identities and use your regular tag owners. [Tailnet grants](https://tailscale.com/docs/features/peer-relay#step-2-create-a-peer-relay-policy)

```json
{
  "tagOwners": {
    "tag:homeyvibe-pi": ["autogroup:admin"],
    "tag:homeyvibe-relay": ["autogroup:admin"]
  },
  "grants": [
    {"src": ["tag:homeyvibe-pi"], "dst": ["tag:homeyvibe-relay"], "app": {"tailscale.com/cap/relay": []}},
    {"src": ["group:homeyvibe"], "dst": ["tag:homeyvibe-pi"], "ip": ["tcp:443"]}
  ]
}
```

Use `tailscale ping <pi-hostname>` to see the path. Tailscale uses a direct connection when available and selects the peer relay when needed. The relay Compose stack publishes no HomeyVibe or MQTT service and the Pi needs no router port forwarding.
