# Vendored API spec

Verbatim snapshots of `openapi.yaml` and `wsapi.json` from the [openccu-loom](https://github.com/SukramJ/openccu-loom) daemon repo (`assets/openapi.yaml`, `assets/wsapi.json`).

Refresh by copying the two files again from the daemon repo whenever the daemon's API version bumps — from the daemon's latest **release tag**, not from its default branch. `main` carries an API version this package will never see in the wild, and pinning to it turns an unrelated daemon merge into drift here that nobody can act on.

```sh
git -C ../openccu-loom show v0.71.0:assets/openapi.yaml > spec/openapi.yaml
git -C ../openccu-loom show v0.71.0:assets/wsapi.json   > spec/wsapi.json
```

Then raise `SUPPORTED_API_MAJOR` in `lib/client.js` to the new `info.version` major.

Consumed by `test/api-surface.test.js`, which pins the REST paths and WebSocket commands this package uses against these snapshots.
