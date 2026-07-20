# Vendored API spec

Verbatim snapshots of `openapi.yaml` and `wsapi.json` from the [openccu-loom](https://github.com/SukramJ/openccu-loom) daemon repo (`assets/openapi.yaml`, `assets/wsapi.json`).
Refresh by copying the two files again from the daemon repo whenever the daemon's API version bumps.
Consumed by `test/api-surface.test.js`, which pins the REST paths and WebSocket commands this package uses against these snapshots.
