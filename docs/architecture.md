# Architecture (draft)

- **Providers** plug into the server and expose devices plus capabilities. zigbee2mqtt (via MQTT) is the first.
- **Configuration agent** uses an LLM (Claude, Codex, or an uploaded context file) to discover devices, create pages and define actions.
- **Gateway** relays between cloud and mobile with end-to-end encryption.
- **Auth** covers users and roles.
