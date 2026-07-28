# node-red-contrib-openccu-loom

Node-RED nodes for the [openccu-loom](https://github.com/SukramJ/openccu-loom)
daemon — the bridge to Homematic / HomematicIP CCUs (CCU2, CCU3, RaspberryMatic)
via the daemon's REST API (`/api/v1`) and its bidirectional WebSocket
(`/api/v1/events`).

> Compatible with **Node-RED ≥ 4.1.9** and **Node.js ≥ 22.9**.

## Installation

In your Node-RED user directory (typically `~/.node-red`):

```sh
npm install node-red-contrib-openccu-loom
```

Restart Node-RED. The nodes appear under the **openccu-loom** palette category.

## Configuration

All nodes reference an `openccu-loom-server` config node:

| Field | Meaning |
|---|---|
| Host | Hostname / IP of the openccu-loom daemon |
| Port | Defaults to 8119 (REST + WebSocket + Config UI SPA). Adjust for TLS. |
| TLS | Use HTTPS + WSS instead of HTTP + WS |
| Skip certificate check | Accept self-signed certificates (test setups only) |
| Auth | `HTTP Basic`, `Bearer Token`, `Session cookie + CSRF`, or `None` |
| User / Password | For HTTP Basic and Session auth |
| Token | For Bearer (issued via `POST /auth/tokens` or `/auth/tokens/v2`; OIDC tokens can be passed through) |
| Timeout | Request timeout in ms (default 10000) |

The dialog includes a **Test connection** button that performs a `GET /info`
against the entered host.

> The daemon binds REST + WebSocket + the Config UI SPA on a single port,
> `:8119`, by default — the old `:8080`/`:8081` split is gone. This contrib
> talks to that one port. If you reverse-proxy through TLS, set the port
> accordingly.
>
> HTTP calls go through Node's built-in `fetch` (via `undici`); the previous
> `axios` dependency has been removed. Every response is normalised to
> `{status, statusText, data, headers}`.

### API version handshake

At deploy (and on demand, cached for 60 s), the server config node performs
`GET /info` and records the daemon's `api_version` and `capabilities`. This
package supports API major `3`; a daemon reporting a different major gets a
one-time `node.warn`, but calls still go through — a major mismatch is
advisory, not a hard stop. Command nodes that depend on an optional daemon
feature call the config node's async `hasCapability("token")` (e.g.
`alarm.v1` for the `alarm` node) to show a yellow advisory status at deploy
without blocking the flow; an older daemon still receives the call and
surfaces its own error at call time. The **Test connection** button reports
the same `apiVersion` / `capabilities` / `supported` fields directly in the
editor.

### OIDC

OIDC requires a browser-driven login flow that is not practical from a
headless backend. The recommended pattern is:

1. Log in to openccu-loom via OIDC interactively (browser).
2. Issue a long-lived API token at `POST /auth/tokens` (admin role required).
3. Use that token in the **Bearer Token** auth field.

## Nodes

### `events` (input, WebSocket)

Subscribes to the bidirectional WebSocket event stream. Every received frame
becomes `msg.payload`; `msg.topic`, `msg.eventType`, `msg.kind`
(`initial|change|refresh`) and `msg.seq` are populated from the envelope.

* Topic filter: comma-separated patterns, e.g. `device.*,hub.*,central.*,matter.*`.
* Live changes via `msg.op = "subscribe"|"unsubscribe"` and `msg.topics`.
* `msg.op = "reauth"` with `msg.token` rotates the bearer credential on the open connection.
* **Resume**: the node tracks the last seen `seq` and asks the daemon to replay
  buffered events on reconnect. If the buffer ceiling (1024 frames) is exceeded
  the daemon answers with `replay_lost`; the node emits a control message
  `{control: "replay_lost", oldest_seq: M}` — pipe it into the `snapshot` node to resync.
* Subscribe/unsubscribe round-trips are acknowledged by the daemon
  (`{op:"subscribed"|"unsubscribed"}`); the node surfaces the ack as its
  status text (e.g. `subscribed (3)`) rather than emitting it as a message.
* Reconnects with exponential backoff (1 s … 30 s); on HTTP 401/403 during
  the handshake, reconnects continue at a slower fixed floor (60 s) instead
  of halting, so a rotated token or renewed session recovers without a
  redeploy.

### `ws call` (WebSocket RPC)

Dispatches a WebSocket command (`assets/wsapi.json`, currently 168 commands) over
the shared connection of the configured server. The frame is
`{op:"call", id:<auto>, command, args}` and the matching `result` is correlated
by id. Common targets: `ccu.get_signal_quality`, `paramset.form_schema`,
`config.session.open/save/discard/undo/redo`, `backup.trigger`,
`matter.commissioning_window_opened`.

### `alarm` (WebSocket RPC)

Dispatches an alarm-panel command (`alarm_panel.*` in `assets/wsapi.json`)
over the same shared WS connection as `events` and `ws call`. `msg.action`
selects the command (`state` default, `panels`, `readiness`, `journal`,
`walktest_status`, `arm`, `disarm`, `silence`, `silence_all`,
`acknowledge`); `msg.zone_id`/`msg.panel` (or the node's configured panel)
feed the `zone_id` argument — `msg.area_id`, the pre-API-3.0.0 spelling, is
still accepted as a deprecated alias — and `msg.mode`, `msg.code`, `msg.force`,
`msg.skip_delay`, `msg.bypass`, `msg.class`, `msg.from`, `msg.to`,
`msg.limit` fill the remaining per-command arguments; `msg.args` wins
key-by-key over all of that. Distinct from the `messages` node, which reads
the CCU's own alarm/service message queue over REST.

At deploy the node checks the `alarm.v1` capability against the server's
`GET /info` response and shows a yellow advisory status if it is missing —
calls still go through against an older daemon, which rejects them at call
time instead. Alarm state changes (`alarm.state_changed`, `alarm.triggered`,
`alarm.countdown`, `alarm.notification`, `alarm.walktest_progress`, …)
arrive as WebSocket broadcasts, not as replies to this node — subscribe to
topic `alarm.panel` with an `events` node instead.

### `alarm admin` (REST)

The alarm engine's REST surface (`/alarm/…`) — the configuration side the
WebSocket does not expose, plus the operating verbs without a WS connection.
Companion to the `alarm` node above; both are gated on the `alarm.v1`
capability.

* **Live status** — `state`, `panels`, `journal` (filters: `msg.zone`,
  `msg.class`, `msg.from`, `msg.to`, `msg.limit`), `readiness`.
* **Zones** — `zones`, `zone`, `zone-create`, `zone-update` (a replace: send
  the complete object), `zone-delete`.
* **Sensors, outputs, codes** — `sensors` / `sensors-set` and `outputs` /
  `outputs-set` (the PUT replaces the whole enrolment set, so `msg.payload`
  must be the full array; an empty one unenrols everything),
  `output-candidates` (`msg.class` narrows by output class),
  `remote-key-candidates`, `output-test` (`msg.opticalOnly`), and the code CRUD
  `codes` / `code` / `code-create` / `code-update` / `code-delete`.
* **Walk test** — `walktest-start`, `walktest-stop`, `walktest` (status). Only
  reachable over REST; the WebSocket exposes the status alone.
* **Operating** — `arm` (`msg.mode`, plus `msg.force`, `msg.skipDelay`,
  `msg.bypass`, `msg.code`), `disarm`, `silence`, `acknowledge`, `silence-all`.

### `set value`

Writes a data-point value. `PUT /devices/{addr}/channels/{no}/data-points/{param}/value`.

`msg.payload` carries the value. Address, channel, parameter, priority and
`Idempotency-Key` are configurable on the node or per message
(`msg.address`, `msg.channel`, `msg.parameter`, `msg.priority`, `msg.idempotencyKey`).
The daemon caches the response for 5 minutes when a key is supplied; replays
set `msg.idempotentReplay = true`.

### `paramset`

Reads or writes a paramset atomically. `GET/PUT /devices/{addr}/paramsets/{VALUES|MASTER|LINK}`.
Honours `msg.idempotencyKey`. Mode `determine`
(`POST /devices/{addr}/channels/{no}/paramsets/{key}/determine`) reads a single
parameter's live value straight from the device instead of the cached paramset
and is channel-scoped (`msg.channel`, `msg.parameter`).

### `sysvar`

Read, write, list, create, patch (metadata) or delete CCU system variables.
`GET/PUT/POST/PATCH/DELETE /sysvars[/{name}]`. `patch` now also accepts `name`
(renames in place), `is_logged`, `is_visible`, `value_name_0`, `value_name_1`
and `channel_address`. Mode `usage`
(`GET /sysvars/{name}/usage`) lists the programs referencing a variable — worth
checking before a rename or delete.

### `program`

Execute, fetch details, list, activate/deactivate (`set-active` →
`PATCH /programs/{id}`, `msg.active`) or delete CCU programs. `msg.includeInternal`
overrides the central's `include_internal_programs` default when listing;
`msg.checkConditions` makes `execute` evaluate the program's "if" condition
first and report `executed: true|false`.

### `device`

Reads device, channel, and data-point information. Scope choices:
`list`, `device`, `channels`, `channel`, `data-points`, `data-point`.

### `device admin`

Administrative device operations, selected via `msg.action`:

* **Registry / values** — `batch` (`POST /devices/values:batch`), `refresh`.
* **Pairing lifecycle** — `accept` (with optional first-time configuration:
  `msg.name`, `msg.includeChannels`, `msg.rooms`, `msg.functions`), `rename`
  (`PATCH /devices/{addr}` with the same fields), `delete` (`msg.reset`
  factory-resets during removal, `msg.force` removes an unreachable device),
  `replace-candidates`, `replace` (`msg.oldAddress`).
* **Firmware / diagnostics** — `firmware`, `firmware-download`
  (`POST /system/firmware/download` from `msg.url`), `test`
  (`POST /devices/{addr}/test`), `restore-config`.
* **Channels** — `channel-update` (rename, rooms, functions), `channel-flags` /
  `channel-flags-set` (the operator overrides `hidden` and `locked`),
  `team-candidates` / `team-set`.

### `install mode`

Per-interface install (pairing) mode: `status` reads
`GET /install-mode/interfaces` (optionally narrowed to `msg.interface`/the
configured interface); `start`/`stop` post `{interface, active, seconds?}`
to the same path. Passing `msg.address` on `start` instead opens a serial,
device-targeted pairing window via `POST /devices/{addr}/install-mode`
(`msg.seconds` sets the duration). `search` (`POST /install-mode/search`) scans
a wired bus (BidCos-Wired) for new devices instead of opening a pairing window
and reports how many were `found`.

### `interfaces`

List, get or reconnect southbound interfaces.

### `messages`

List or acknowledge the CCU's own alarm / service messages. Beyond `list` and
`ack` (single message): `ack-all` acknowledges the whole queue and reports how
many were `acknowledged`; on the service side `suppressed` lists the
permanently suppressed messages and `unsuppress` clears one
(`msg.channel` required, `msg.interface` / `msg.parameter` narrow it).

### `groups`

Administers the CCU's heating groups (`/groups`). Actions: `list`, `types`
(assignable group types), `suitable-members` (the channels a group of
`msg.typeId` may take), `create`, `update`, `delete`. `msg.members` supplies
the member list; mutating calls require admin.

### `diagrams`

CRUD for the Config UI's saved diagram definitions (`/diagrams`). `list`
returns the caller's own plus the shared ones; `msg.config` carries the
definition, `msg.visibility` is `private|shared`.

### `links`

`list` — the global direct-link overview (`GET /links`, `msg.locale` steers the
label language). `test` — `POST /devices/{addr}/links/test` activates the link
paramset at the device so the actuator reacts once. Creating and removing links
stays on the WebSocket (`central.create_links` / `central.remove_links` via the
`ws call` node).

### `recording`

Reads and sets the per-data-point history recording state
(`GET/PUT /history/recording`). Both actions address one data point via
`msg.central`, `msg.interfaceId`, `msg.channel` and `msg.parameter`; `get`
reports `{record, source}`, and `set` without `msg.record` clears the override
and hands the data point back to the configured default.

### `snapshot`

`GET /snapshot` — full daemon state (devices, programs, sysvars …). Use this
after a `replay_lost` control frame from the events node.

### `health`

Diagnostics: `/info`, `/health`, `/config`, `/config/effective`, `/config/schema`,
`/system/ccu` (`msg.scope = "ccu"` — per-central readiness/metadata).

### `centrals`

Multi-CCU registry CRUD (`/centrals`, `/centrals/{name}`). Mutating calls
require admin role. Action `reboot` (`POST /system/ccu/{central}/reboot`)
reboots the CCU itself, not the daemon.

### `api`

Generic REST call against the openccu-loom API. Path is relative to
`/api/v1`. Honours `msg.method`, `msg.path`, `msg.payload`, `msg.query`,
`msg.headers`, `msg.idempotencyKey`.

## Examples

Five importable example flows ship under `examples/`:

- `01-event-stream.json` — subscribe to the event stream, auto-resync on `replay_lost`.
- `02-set-value.json` — periodically write a thermostat set point with Idempotency-Key.
- `03-sysvar-and-program.json` — set a sysvar, then trigger a program.
- `04-ws-call.json` — dispatch a WS-RPC (`ccu.get_signal_quality`).
- `05-alarm-panel.json` — poll every alarm zone's state on a schedule.

## Localisation

UI strings and inline labels ship in `en-US` and `de`. Inline help texts are
English; the editor picks the matching label set automatically.

## Development

```sh
npm install
npm test            # mocha smoke tests + HTTP-client integration tests
```

To try the package against a local Node-RED:

```sh
npm link
cd ~/.node-red
npm link node-red-contrib-openccu-loom
```

AI-assisted contributions are welcome within the bounds of the
[AI contribution policy](./AI_POLICY.md).

## Licence

MIT — see [LICENSE](./LICENSE).

## Known limitations

- The HTTP client uses the WHATWG `fetch` implementation (undici). Its
  standard bad-port blocklist refuses a handful of ports historically
  claimed by other protocols (e.g. 6667, 6000). Run the daemon on a
  normal port — the default `8119` is unaffected.
