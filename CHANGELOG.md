# Changelog

All notable changes to this project are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.4.0] - 2026-07-28

Tracks the daemon's API 3.1.0 (openccu-loom 0.49.2).

### Changed (breaking)
- **Alarm: the armable unit is a "zone", not an "area"** — following the
  daemon's deliberate API 3.0.0 rename. The `alarm` node now sends the
  `zone_id` argument (was `area_id`) for `arm`, `disarm`, `silence`,
  `acknowledge`, `readiness`, `journal` and `walktest_status`. The node's
  configured **Panel/zone id** field and `msg.panel` are unchanged, so
  existing flows keep working; `msg.zone_id` is the new explicit override
  and `msg.area_id` still feeds `zone_id` as a deprecated alias. Flows that
  set the argument through `msg.args` must switch the key from `area_id`
  to `zone_id` themselves — `msg.args` is merged verbatim.
- **Supported API major is now `3`** (`SUPPORTED_API_MAJOR`). Against a
  daemon still reporting API `2.x` the server node logs its one-time
  mismatch warning; calls are not blocked, but the alarm node's per-zone
  arguments are rejected by such a daemon.

### Added
- New node **`alarm admin`** (`openccu-loom-alarm-admin`) covering the
  alarm engine's REST surface — the configuration side the WebSocket
  never exposed, plus the operating verbs without a WS connection:
  zone CRUD, sensor / output enrolment (`sensors-set`, `outputs-set`
  replace the whole set), output and remote-key candidate lists, output
  test, code CRUD, walk-test start/stop/status (REST-only — the
  WebSocket has the status alone), `state` / `panels` / `journal` /
  `readiness`, and `arm` / `disarm` / `silence` / `acknowledge` /
  `silence-all`. Gated on the same `alarm.v1` capability as the
  WebSocket `alarm` node.
- Five new nodes for the REST surfaces the daemon gained since API 2.27:
  - **`groups`** — heating-group administration (`/groups`): `list`,
    `types`, `suitable-members`, `create`, `update`, `delete`.
  - **`diagrams`** — CRUD for the Config UI's saved diagram definitions
    (`/diagrams`).
  - **`links`** — the global direct-link overview (`GET /links`) and the
    per-device link test (`POST /devices/{addr}/links/test`).
  - **`recording`** — per-data-point history recording state
    (`GET/PUT /history/recording`).
- **`device admin`** gained `rename` (`PATCH /devices/{addr}` incl.
  `rooms`/`functions`/`include_channels`), `test`, `restore-config`,
  `replace-candidates`, `replace`, `firmware-download`, `channel-update`,
  `channel-flags` / `channel-flags-set` and `team-candidates` /
  `team-set`. `accept` now carries optional first-time configuration in
  the same call, and `delete` forwards the `reset` / `force` flags.
- **`program`** gained modes `delete` and `set-active`
  (`PATCH /programs/{id}` — the CCU's own "program active" flag), the
  `include_internal` list filter and `check_conditions` on `execute`
  (the reply reports `executed`).
- **`messages`** gained `ack-all`, plus `suppressed` and `unsuppress`
  for the service-message suppressions.
- **`paramset`** gained mode `determine` (reads one parameter's live
  value from the device, channel-scoped), **`sysvar`** mode `usage` (the
  programs referencing a variable), **`install mode`** action `search`
  (wired-bus scan) and **`centrals`** action `reboot`.
- Contract test `test/api3-surface.test.js` pinning the exact request
  (method, URL incl. query string, body) of every action above, and a
  packaging test asserting each `nodes/*.js` is registered in
  `package.json` and ships its `.html` plus both locale files.

### Fixed
- **Test suite: an occasional `setTypeOfService EINVAL` failure charged
  to a random `after each` hook.** The server node's deploy-time
  `GET /info` (and the capability probe riding on it) could still be
  queued in undici's connection pool when a test tore its backend down,
  and undici then wrote to a socket whose listener was gone. The
  API 3.x suite now waits for the handshake to settle before asserting.
  Node behaviour is unchanged; only the tests were racing.

### Changed
- Vendored spec snapshots in `spec/` refreshed from the daemon repo
  (`openapi.yaml` 2.27.0 → 3.1.0, `wsapi.json` 95 → 168 commands). Every
  REST endpoint this package already called survived the refresh
  unchanged — apart from the alarm rename above, the daemon-side changes
  to them were additive.

## [0.3.0] - 2026-07-20

### Changed (breaking)
- **Default REST port** changed from 8080 to **8119** (openccu-loom now
  serves REST + WebSocket + the Config UI SPA from a single port; the old
  8080/8081 split is gone).
- **`install mode` node** endpoints changed: the daemon's bare
  `/install-mode` route no longer exists. `status`/`start`/`stop` now target
  `GET`/`POST /install-mode/interfaces` (per-interface state and
  activation); passing `msg.address` on `start` instead opens a serial,
  device-targeted pairing window via `POST /devices/{addr}/install-mode`.
- **Client response shape**: `lib/client.js` dropped `axios` for `undici`'s
  native `fetch`. The public response/error shape
  (`{status, statusText, data, headers}`, thrown errors carrying
  `err.response`) is unchanged, but nothing axios-specific (`isAxiosError`,
  `err.config`, the axios instance) is exposed anymore — anything that
  reached past `err.response` into axios internals breaks.

### Added
- New node **`alarm`** (`openccu-loom-alarm`): dispatches `alarm_panel.*`
  WebSocket commands (`state`, `panels`, `readiness`, `journal`,
  `walktest_status`, `arm`, `disarm`, `silence`, `silence_all`,
  `acknowledge`) over the shared WS hub, with `msg.args` overriding assembled
  arguments key-by-key. Example flow `05-alarm-panel.json`.
- **API handshake + capability gating**: the server config node performs a
  deploy-time `GET /info`, caches `api_version` + `capabilities` (60 s TTL),
  warns once when the daemon's API major differs from the supported major
  (`SUPPORTED_API_MAJOR = 2`), and exposes an async `hasCapability(token)` so
  nodes can show an advisory status for daemon features that are not
  compiled in yet (e.g. `alarm.v1` for the new `alarm` node).
- Contract test pinning the `alarm` node's action → `alarm_panel.*` command
  map and per-command argument names against the vendored copy of the
  daemon's `assets/wsapi.json` shape, so drift between the two is caught at
  test time.
- `health` node gained scope `ccu` → `GET /system/ccu` (per-central
  readiness/metadata).
- `events` node surfaces subscription/unsubscription acknowledgements
  (`{op:"subscribed"|"unsubscribed"}`) as node status instead of silently
  dropping them.

### Changed
- HTTP client rewritten on `undici`'s native `fetch` instead of `axios` —
  one fewer dependency layer; a self-signed-TLS setup now gets a per-client
  `Agent` instead of a process-wide relaxed TLS default.
- WS hub: HTTP 401/403 during the WebSocket handshake no longer halts the
  reconnect loop permanently — it retries on a slower fixed floor (60 s) so
  a rotated token or renewed session recovers without a redeploy.

## [0.2.0] - 2026-05-27

### Changed (breaking)
- **Renamed package** from `node-red-contrib-gohomematic` to
  `node-red-contrib-openccu-loom`. All node types now use the
  `openccu-loom-*` prefix; the palette category is `openccu-loom`.
  Existing flows must be re-pointed.
- **Default REST port** changed from 8081 to **8080** (openccu-loom binds
  REST + WebSocket on `:8080` and the bootstrap UI on `:8081`).
- **Session cookie names** updated to `openccu_loom_session` /
  `openccu_loom_csrf` to match the daemon (`internal/auth/session.go`,
  `internal/auth/csrf.go`). Without this fix, Session-Cookie auth fails
  silently against the current daemon.
- Admin-endpoint moved to `/openccu-loom/test-connection`.

### Added
- `Idempotency-Key` header support: `set value`, `paramset`,
  `device admin batch` and `api` accept `msg.idempotencyKey`; daemon-side
  replays set `msg.idempotentReplay = true`.
- WebSocket **resume**: events node tracks the last `seq` and asks for
  `since:N` on reconnect. `replay_done`/`replay_lost` control frames are
  surfaced as `msg.control` so flows can pull a fresh `GET /snapshot`.
- WebSocket **reauth**: events node accepts `msg.op = "reauth"` with
  `msg.token`.
- WebSocket **kind discriminator** (`initial|change|refresh`) is exposed
  as `msg.kind`.
- New node **`ws call`** (`openccu-loom-ws-call`): generic
  `{op:"call", command, args}` RPC over the shared WS connection, with
  per-call timeout and result correlation.
- New REST nodes:
  - `paramset` — `GET/PUT /devices/{addr}/paramsets/{VALUES|MASTER|LINK}`
  - `messages` — list / ack alarm + service messages
  - `interfaces` — list / get / reconnect interfaces
  - `snapshot` — `GET /snapshot`
  - `health` — `/info`, `/health`, `/config`, `/config/effective`,
    `/config/schema`
  - `centrals` — multi-CCU registry CRUD
  - `device admin` — batch write, refresh, accept, firmware update, delete
- `sysvar` node gained `create`, `patch` and `delete` modes.
- `program` node gained `get` (details) in addition to `execute` / `list`.
- Fourth example flow `04-ws-call.json` demonstrating WS-RPC.

### Removed
- All `gohomematic-*` node-type identifiers, file names and locale keys.

## [0.1.0] - 2026-05-07

### Added
- Initial release.
- Config node `gohomematic-server` with HTTP Basic, Bearer Token, and
  Session cookie + CSRF authentication, optional TLS.
- Admin endpoint `POST /gohomematic/test-connection` and a Test button
  in the editor.
- Input node `gohomematic-events`: WebSocket subscriber for
  `/api/v1/events` with topic filter, exponential-backoff reconnect, and
  halt-on-auth-failure during the handshake.
- Command nodes:
  - `gohomematic-set-value` (write a data point)
  - `gohomematic-sysvar` (read / write / list system variables)
  - `gohomematic-program` (execute / list CCU programs)
  - `gohomematic-device` (read devices / channels / data points)
  - `gohomematic-install-mode` (control pairing mode)
  - `gohomematic-api` (generic REST call)
- i18n resources for `en-US` and `de`.
- Example flows under `examples/`.
- Smoke tests with `node-red-node-test-helper` plus HTTP-client
  integration tests against an in-process server.

[0.3.0]: https://github.com/SukramJ/node-red-contrib-openccu-loom/releases/tag/v0.3.0
[0.2.0]: https://github.com/SukramJ/node-red-contrib-openccu-loom/releases/tag/v0.2.0
[0.1.0]: https://github.com/SukramJ/node-red-contrib-openccu-loom/releases/tag/v0.1.0
