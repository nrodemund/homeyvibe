# Security policy

HomeyVibe controls real devices in people's homes, so security reports are very welcome.

## Reporting a vulnerability

Please do not open a public issue. Use GitHub's private reporting instead: **Security → Report a vulnerability** on this repository. Include what you found, how to reproduce it, and the version or commit you tested.

You will get an answer as soon as possible, and credit in the release notes if you like.

## Supported versions

Only the latest `main` (`latest` image) and the latest release (`stable` image) receive fixes. Installs using the default Docker setup update automatically.

## Hardening tips

- Keep HomeyVibe on your home network. Use a VPN for remote access and do not forward its port on your router.
- Give people the least access they need: use the member and guest roles and per-device limits.
- Give the AI user only the devices and value ranges it should touch.
- Create a separate access token for each AI connector and revoke tokens you no longer use.
