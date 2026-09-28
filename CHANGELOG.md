# Changelog

All notable changes to this project are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.7.0] - 2026-09-28

Tracks the daemon's API 12.0.0 (openccu-loom 0.79.0), up from 10.1.0.

### Changed

- **`SUPPORTED_API_MAJOR` raised 10 -> 12 and the vendored spec refreshed to
  the v0.79.0 tag.** Every REST path and WebSocket command this package uses
  is still in the spec (`test/api-surface.test.js`). The two breaking changes
  in between reach no node: API 12.0.0 changed the answer of `POST /rooms` and
  `POST /functions`, which no node calls, and API 11.0.0 changed
  `POST /system/firmware/download` (below).

- **`device admin` `firmware-download` no longer needs `msg.url`.** Since API
  11.0.0 the CCU downloads the firmware for its own version and board serial,
  and the daemon accepts a URL only to ignore it. The node refused to run
  without one, and forwarded it when given; it now sends only the optional
  `central`.

## [0.6.0] - 2026-09-01

Tracks the daemon's API 10.1.0 (openccu-loom 0.71.0), up from 7.12.0.

### Changed

- **`SUPPORTED_API_MAJOR` raised 7 -> 10 and the vendored spec refreshed to
  the v0.71.0 tag.** Three daemon majors landed between 0.64.2 and 0.71.0, so
  this package had been reporting every current daemon as unsupported. The
  server node now logs "unsupported" against a daemon on API 7.x-9.x instead,
  which is the correct direction: those releases are the ones this build no
  longer matches.

- **Tag-triggered release and npm-publish workflows added.** The package had
  no release automation, which is how the drift went three majors deep without
  anything saying so.

## [0.5.0] - 2026-08-24

Tracks the daemon's API 7.12.0 (openccu-loom 0.64.2).

### Changed (breaking)
- **Supported API major is now `7`** (`SUPPORTED_API_MAJOR`), up from `3`.
  Against a daemon still reporting API `3.x`–`6.x` the server node logs its
  one-time mismatch warning; calls are not blocked.
- **`alarm admin` `zone-create` no longer requires `id` in `msg.payload`.**
  The daemon mints the zone id itself (`AlarmZoneCreate` requires only
  `name`) and ignores one sent in the body, so the node rejected valid
  REST-conventional payloads. `msg.payload` now needs at least `{name}`;
  a payload that still carries `id` is accepted, but the id is never
  honoured. `zone-update` is unchanged and still needs `{id, name}`.

### Added
- Five new nodes for the REST surfaces the daemon gained since API 3.1:
  - **`security`** — the Security & Safety domain (`/security/…`): domain
    `state`, one hazard `class`, the standing `faults` ledger,
    `fault-acknowledge`, the classified `sources` inventory (filtered by
    class / central / zone and the `relevant` / `active` flags) and
    `source-override`, which overrides the classifier for one data point.
  - **`matter`** — the Matter bridge (`/matter/…`), covering the whole
    family rather than only the new members: `status`, `compatibility`,
    `endpoints`, `mdns`, `sessions`, `events`, `force-sync`; fabric
    listing, unpairing and `factory-reset`; the `exposable` allowlist
    (single and bulk); and the commissioning verbs incl. `share` and the
    setup payload.
  - **`areas`** — operator-defined room groupings above the CCU's own
    rooms (`/areas`): `list`, `create`, `update`, `delete` and
    `rooms-set` (a replace — the full `{central, room}` array).
  - **`backups`** — CCU backup archives (`/backups`), again the whole
    family: `list`, `storage`, `trigger`, `upload`, `download`, `restore`
    and `delete`.
  - **`surfaces`** — the config-UI surface registry (`/ui/surfaces`):
    `get` and `set` (the `embedded` master toggle, its scope, and the
    per-profile visibility overrides).
- **`alarm admin`** gained `incidents` and `incident` (the per-zone
  incident history and one incident with its full source ledger),
  `sensor-candidates` (`msg.unenrolled` narrows to the data points no
  zone has taken), and the latched-motion verbs `triggered-motion`,
  `reset-motion` (all zones) and `zone-reset-motion` (one zone).
- **`centrals`** gained the CCU host verbs `poweroff`, `safe-mode` and
  `recovery-mode` alongside the existing `reboot`, the astro-position
  write `position` (`msg.longitude` / `msg.latitude`, a `msg.payload`
  object, or the node's own fields), and the daemon's add-on self-update
  trio `addon-update`, `addon-update-check` and `addon-update-install`.
- **`health`** gained the read-only scopes `wiring`
  (`/diagnostics/wiring`), `schedules` (`/schedules`) and `i18n`
  (`/i18n/entities`, with an optional `msg.locale`).
- Contract test `test/api7-surface.test.js` pinning the exact request
  (method, URL incl. query string, body) of every action above, its
  argument validation, and the two binary backup transfers.
- Six example flows for the new surface: `06-security-faults.json`,
  `07-matter-commissioning.json`, `08-areas-rooms.json`,
  `09-backup-download.json`, `10-alarm-incidents.json` and
  `11-system-maintenance.json`.
- Packaging test `test/examples.test.js` checking every shipped flow:
  valid JSON, unique ids, wires and tab references that resolve, a server
  config node in the same flow, the documented default port, and — the
  two that catch a silent typo — that each openccu-loom node sets only
  properties its editor declares in `defaults` and only `action` / `scope`
  values its editor actually offers.

### Fixed
- **Four example flows still used the pre-0.3.0 default port 8080.**
  `01`–`04` were never updated when the daemon moved to the single port
  8119, so importing them produced a server node that could not connect.
  The new packaging test pins the port so they cannot drift again.
- **The HTTP client corrupted binary responses.** Every reply went
  through `res.text()`, which decodes bytes as UTF-8 — fine for JSON,
  destructive for a backup `.sbk`. A `responseType: "buffer"` request
  now returns the untouched bytes as a `Buffer`; error replies still go
  through the JSON path so their problem+json body survives. Used by
  `backups` `download`.

### Changed
- The HTTP client can send `multipart/form-data`: a `FormData` body is
  passed to undici untouched and keeps the `Content-Type` undici mints,
  because only it knows the boundary. `lib/client.js` re-exports undici's
  `FormData` — undici's `fetch` recognises only its own class, and a
  global one would silently be stringified into a `text/plain` body.
  Used by `backups` `upload`.
- Vendored spec snapshots in `spec/` refreshed from the daemon repo
  (`openapi.yaml` 3.1.0 → 7.12.0, `wsapi.json` 168 → 181 commands).
  Despite four major bumps the refresh was additive for paths and WS
  commands alike: 36 REST paths and 13 broadcasts were added and none
  removed. Three response/request bodies this package touches did change
  — `POST /alarm/zones` dropped `id` (see above), and `GET
  /alarm-messages` and `GET /service-messages` reshaped their rows. The
  `messages` node passes those payloads through untouched, so only flows
  reading the dropped fields (`address`, `device_name`, `last_trigger`,
  `rooms`, `state_value` on alarm messages; `description`, `priority` on
  service messages) need adjusting.

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
